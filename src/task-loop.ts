/**
 * The plan/execute driver (`docs/plan-exec.md`): a planner starts with one
 * current Stage and Task, then patches one new Task (or one new Stage with its
 * first Task) per planning turn. An executor carries out one Task's edits at a
 * time with edit-dsl clauses (or one whole-file write). The harness owns status,
 * scheduling, and verification.
 *
 * This module orchestrates. It reuses the edit-dsl machinery rather than
 * re-implementing it: `parseMultiEditor`/`resolveMultiEditor` for the reply,
 * `applyResolvedRegions` for the gates and the write, and `formatDiagnostics`
 * for the type-check feedback. `src/tasks.ts` owns the contract, and
 * `src/prompts/task.ts` owns the prompt text.
 */
import { join } from "node:path";
import { buildIndexTolerant, Binder, declarationSpaces } from "./utility";
import type { IndexEntry, Locator, SourceFile, SymbolIndex, SymbolSpace } from "./utility";
import { Parser } from "./parser";
import type { Node, Program } from "./parser";
import { stripCodeFences } from "./matcher";
import { parseMultiEditorDetailed } from "./selection";
import type { EditStatement, Selection as EditDslSelection, WriteFileStatement } from "./selection";
import { renderReadFailureFeedback, renderReadFeedback, resolveMultiEditor } from "./multi-editor";
import { stripLeadingExport } from "./loop";
import type { MultiEditorDeps, MultiEditorResolution } from "./multi-editor";
import { declarationKindOf, renderViewerFeedback } from "./edit-dsl";
import type { EditDslRegion } from "./edit-dsl";
import {
  applyResolvedRegions,
  gateDiagnostics,
  NOOP_DIAGNOSTICS,
  parseCheck,
  prevBrokenDiagnostics,
} from "./commit";
import { checkTool, testTool } from "./tools";
import { formatSource } from "./editor";
import { buildContextYaml } from "./loop";
import {
  DEFAULT_TOKEN_BUDGET,
  MAX_CONSECUTIVE_LENGTH,
  addLoopTokens,
  budgetTokensFromResponse,
  cloneLoopUsage,
  discoverSourceFiles,
  editDslRegionToResolved,
  explain,
  formatDiagnostics,
  loopTokensFromResponse,
  parseSelfCheckRequest,
  providerErrorDiagnostics,
  readFileIfExists,
  recordRow,
  resolveCurrentEntry,
  safeMutablePath,
  selectSpecFiles,
  tokenBudgetDiagnostics,
  totalLoopTokens,
  withEffort,
  writeTarget,
  zeroLoopUsage,
} from "./loop";
import type {
  ExchangeOutcome,
  LoopOptions,
  LoopRecord,
  LoopResult,
  LoopTokens,
  LoopUsage,
  ProviderLike,
  TerminationReason,
} from "./loop";
import type { ChatMessage, ChatResponse } from "./openai";
import {
  buildTaskExecutionSystemPrompt,
  buildTaskPatchRetryPrompt,
  buildTaskPlanRetryPrompt,
  buildTaskPlanningSystemPrompt,
  buildTaskPlanningUserPrompt,
  buildTaskReplanPrompt,
  buildTaskReviewDoneEditRetryPrompt,
  buildTaskReviewPrompt,
  buildTaskReviewRetryPrompt,
  buildTaskTurnPrompt,
  MAX_TASK_EXCHANGES,
  MAX_TASK_PLAN_ROUNDS,
  renderTaskContentView,
  replanDelta,
} from "./prompts/task";
import type { TaskMatcherFailure } from "./prompts/task";
import {
  activeStage,
  activeTask,
  allTasks,
  finalTask,
  firstEdit,
  formatTaskLoc,
  hasLaterPendingTaskInStage,
  initialState,
  isSafeTaskPath,
  nextEdit,
  runComplete,
  summaryOf,
  taskEditsSettled,
  taskHasDoneEdit,
} from "./tasks";
import {
  applyPlanPatch,
  parsePlanDslDetailed,
  parsePlanPatchDetailed,
  serializePlanDsl,
} from "./plan-dsl";
import type { PlanPatch } from "./plan-dsl";
import type { EditNode, NodeId, Stage, TaskNode, Plan, TaskRunState } from "./tasks";
import { renderDslIssues } from "./dsl-diagnostics";
import type { DslParseResult } from "./dsl-diagnostics";

/**
 * A planning turn's result, tagged so the caller never has to guess whether a
 * value is a run state or a terminated result.
 */
type PlanningOutcome =
  | { kind: "planned"; state: TaskRunState }
  | { kind: "failed"; result: LoopResult };
/** One post-execution review turn: approve, one repair patch, or terminate. */
type ReviewOutcome =
  | { kind: "approve" }
  | { kind: "patched"; state: TaskRunState }
  | { kind: "failed"; result: LoopResult };
/** Model attempts per planning turn (a rejected reply is retried with its diagnostics). */
const MAX_PLAN_ATTEMPTS = 3;
/** Review reply attempts: one initial reply plus one format-only retry. */
const MAX_REVIEW_ATTEMPTS = 2;

interface Workspace {
  cwd: string;
  files: SourceFile[];
  index: SymbolIndex;
  skipped: LoopResult["skipped"];
}

function workspaceOf(cwd: string): Workspace {
  const files = discoverSourceFiles(cwd);
  const build = buildIndexTolerant(files);
  return { cwd, files, index: build.index, skipped: build.skipped };
}

/** One model conversation; token usage is accounted at the run level. */
interface ChatState {
  messages: ChatMessage[];
}

/**
 * The run-level token tally (#32). Each provider call lands in exactly one
 * conversation bucket; `consumed` is the sum that drives the hard budget.
 */
interface UsageState {
  usage: LoopUsage;
  consumed: number;
}

async function callModel(
  messages: ChatMessage[],
  bucket: LoopTokens,
  usage: UsageState,
  provider: ProviderLike,
  options: LoopOptions,
): Promise<ChatResponse> {
  const chatOptions =
    options.temperature === undefined ? undefined : { temperature: options.temperature };
  const response = await provider.chat(
    messages,
    undefined,
    withEffort(chatOptions, options.effortOverride ?? "none"),
  );
  usage.consumed += budgetTokensFromResponse(response, options.tokenBudgetBasis ?? "raw");
  addLoopTokens(bucket, loopTokensFromResponse(response));
  return response;
}

function overBudget(state: UsageState, budget: number): boolean {
  return state.consumed > budget;
}

function outcomeOf(stage: string): ExchangeOutcome {
  switch (stage) {
    case "address":
      return "address";
    case "matcher":
      return "matcher";
    case "range":
      return "range";
    case "gate":
      return "gate";
    case "format":
      return "format";
    case "no-op":
      return "no-op";
    case "duplicate":
      return "duplicate";
    default:
      return "protocol";
  }
}

function stageOf(diagnostics: string): string {
  const match = /^stage:\s*(\S+)/m.exec(diagnostics);
  return match?.[1] ?? "protocol";
}

/**
 * Only the two malformed-matcher classes get the bounded correction (#45):
 * a missing matcher value and a snippet that does not parse. Matcher-not-found,
 * matcher-ambiguous, and invalid-regex replies keep the general matcher help;
 * they are selector problems, not malformed syntax.
 */
function isMalformedMatcher(diagnostics: string): boolean {
  if (diagnostics.includes("EDIT_MATCHER_MISSING")) {
    return true;
  }
  return (
    stageOf(diagnostics) === "matcher" &&
    diagnostics.includes("the matcher could not be parsed as TypeScript")
  );
}

/**
 * The index address of a task. `kind` is the empty wildcard because the task's
 * `loc.kind` is a *symbol space*, which `resolveCurrentEntry`/`lookup` filter
 * separately; a declaration keyword here would exclude every entry.
 */
function locatorOf(task: EditNode): Locator {
  return { path: task.loc.path, name: task.loc.symbol, kind: "" };
}

function symbolSpaceOf(loc: EditNode["loc"]): SymbolSpace {
  if (loc.kind === "file") {
    throw new Error(`the whole-file target ${loc.path} has no symbol space`);
  }
  return loc.kind;
}

function readTarget(cwd: string, path: string): string {
  return readFileIfExists(join(cwd, path)) ?? "";
}

/** True when a planner turn is asking for a read-only edit-protocol viewer. */
function isPlannerViewerReply(content: string): boolean {
  const trimmed = stripCodeFences(content).trim();
  return /^select\b/.test(trimmed) || /^read\b/.test(trimmed);
}

/**
 * A planner viewer is exactly one existing edit-protocol viewer statement.
 * Editors, writes, creates, deletes, and multi-statement replies are rejected:
 * the planner may inspect code, never change it.
 */
function plannerViewerProblem(statements: readonly EditStatement[]): string | null {
  if (statements.length !== 1) {
    return "a planner view must be exactly one read-only `select … end` or `read … end` statement";
  }
  const statement = statements[0];
  if (statement === undefined) {
    return "a planner view must be exactly one read-only `select … end` or `read … end` statement";
  }
  if (statement.type === "fs") {
    return statement.statement.op === "read"
      ? null
      : `a planner view is read-only; \`${statement.statement.op}\` is not allowed`;
  }
  const selection = statement.selection;
  if (selection.replacement !== null || selection.rename !== undefined) {
    return "a planner view is read-only; use a viewer (`select … end`) without `replace` or `rename`";
  }
  return null;
}

function writeRecord(
  records: LoopRecord[],
  input: {
    iteration: number;
    kind: "exchange" | "verification";
    exchange: number | null;
    edit: EditNode;
    outcome: ExchangeOutcome | "ok" | "tsc" | "tests";
    replacement: string | null;
    diagnostics: string | null;
    finishReason: string | null;
    payloads?: number;
    appliedLocators?: Locator[];
  },
): void {
  records.push(
    recordRow({
      row: records.length + 1,
      iteration: input.iteration,
      kind: input.kind,
      exchange: input.exchange,
      locator: locatorOf(input.edit),
      replacement: input.replacement,
      diagnostics: input.diagnostics,
      outcome: input.outcome,
      finishReason: input.finishReason,
      payloads: input.payloads ?? 0,
      appliedLocators: input.appliedLocators,
    }),
  );
}

// ---------------------------------------------------------------------------
// Target guards: the plan declares one action per task; the reply must carry it.

type TargetGuard =
  | { ok: true; entry: IndexEntry | null; related: IndexEntry[] }
  | { ok: false; diagnostics: string };

function editLabel(task: EditNode): string {
  return `task #${task.id} (${task.action}) targets ${formatTaskLoc(task.loc)}`;
}

/** The addresses a migration task may edit: its target plus related locs. */
function editLocs(
  task: EditNode,
): readonly { path: string; symbol: string; kind: EditNode["loc"]["kind"] }[] {
  return [task.loc, ...(task.related ?? [])];
}

function locatorOfLoc(loc: EditNode["loc"]): Locator {
  return { path: loc.path, name: loc.symbol, kind: "" };
}

/** The current workspace files (paths and sources) for address resolution. */
function workspaceIndex(workspace: Workspace): SymbolIndex {
  const files = discoverSourceFiles(workspace.cwd);
  return buildIndexTolerant(files).index;
}

function guardTarget(workspace: Workspace, task: EditNode): TargetGuard {
  const cwd = workspace.cwd;
  for (const loc of editLocs(task)) {
    if (!isSafeTaskPath(loc.path) || safeMutablePath(cwd, loc.path) === null) {
      return {
        ok: false,
        diagnostics: `stage: address\ntask #${task.id}: ${formatTaskLoc(loc)} is not a writable repo-relative path (no absolute path, "..", hidden/build segment, or human/)`,
      };
    }
  }
  const source = readTarget(cwd, task.loc.path);
  if (task.action === "write") {
    return { ok: true, entry: null, related: [] };
  }
  if (readFileIfExists(join(cwd, task.loc.path)) !== null) {
    const parsed = parseCheck(source);
    if (!parsed.ok) {
      return { ok: false, diagnostics: prevBrokenDiagnostics(task.loc.path, parsed.failure) };
    }
  }
  const visible = workspaceIndex(workspace);
  const entry = visible.lookup(locatorOf(task), symbolSpaceOf(task.loc));
  if (task.action === "create") {
    if (entry.length > 0) {
      return {
        ok: false,
        diagnostics: `stage: address\n${editLabel(task)}: the declaration already exists, so a create task cannot add it (use modify)`,
      };
    }
    // A name declared only in another symbol space is a legal create in this
    // one; only an entry in the requested space blocks the task.
    return { ok: true, entry: null, related: [] };
  }
  const existing = resolveCurrentEntry(
    source,
    task.loc.path,
    locatorOf(task),
    symbolSpaceOf(task.loc),
  );
  if (!existing.ok) {
    return { ok: false, diagnostics: `${existing.diagnostics}\n${editLabel(task)}` };
  }
  const related: IndexEntry[] = [];
  for (const loc of task.related ?? []) {
    const resolved = resolveCurrentEntry(source, loc.path, locatorOfLoc(loc), symbolSpaceOf(loc));
    if (!resolved.ok) {
      return {
        ok: false,
        diagnostics: `stage: address\ntask #${task.id} related target ${formatTaskLoc(loc)}: ${resolved.diagnostics}`,
      };
    }
    related.push(resolved.entry);
  }
  return { ok: true, entry: existing.entry, related };
}

/** Statement indices allowed for the task's target and its related locs. */
function ownStatementIndices(task: EditNode, statements: readonly EditStatement[]): Set<number> {
  const keys = new Set(editLocs(task).map((loc) => `${loc.path}\u0000${loc.symbol}`));
  const allowed = new Set<number>();
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (statement?.type !== "editor") {
      continue;
    }
    const locator = statement.selection.locator;
    if (keys.has(`${locator.path}\u0000${locator.name}`)) {
      allowed.add(index);
    }
  }
  return allowed;
}

function targetMismatch(task: EditNode): string {
  const related =
    task.related === undefined || task.related.length === 0
      ? ""
      : ` or one of its related targets (${task.related.map((loc) => formatTaskLoc(loc)).join(", ")})`;
  return `stage: address\ncode: EDIT_TARGET_MISMATCH\n${editLabel(task)}: the reply must edit only that declared target${related}; re-address the task's own symbols`;
}

/** True when the create fence declares exactly the task's symbol in its space. */
function createBodyCheck(task: EditNode, body: string): string | null {
  let program: Program;
  try {
    program = new Parser(body).parseProgram();
  } catch {
    // Not a declaration list: the harness wraps the body in the task's space.
    return null;
  }
  if (program.body.length !== 1) {
    return `stage: address\ncode: EDIT_TARGET_MISMATCH\na create fence must contain exactly one top-level declaration (the task target); it carried ${program.body.length}. Put helper declarations in their own create edits.`;
  }
  const binder = new Binder(program);
  const symbols = binder.rootScope.resolveLocal(task.loc.symbol);
  const declarations = new Set(symbols.flatMap((symbol) => symbol.declarations));
  if (declarations.size === 0) {
    return `stage: address\ncode: EDIT_TARGET_MISMATCH\nthe create fence declares no top-level ${JSON.stringify(task.loc.symbol)}; declare exactly that name, or send only its body to wrap it as ${task.loc.kind}`;
  }
  if (declarations.size > 1) {
    return `stage: address\ncode: EDIT_TARGET_MISMATCH\nthe create fence declares ${declarations.size} top-level declarations named ${JSON.stringify(task.loc.symbol)}; a create fence must contain exactly one`;
  }
  const node: Node | undefined = declarations.values().next().value;
  const symbol = symbols[0];
  if (node === undefined || symbol === undefined) {
    return null;
  }
  const spaces = declarationSpaces({ locator: locatorOf(task), node, symbol });
  if (!spaces.includes(symbolSpaceOf(task.loc))) {
    return `stage: address\ncode: EDIT_TARGET_MISMATCH\nthe created ${JSON.stringify(task.loc.symbol)} occupies the ${spaces.join(", ")} space, but the task asks for ${task.loc.kind}`;
  }
  return null;
}

interface DeclarationShape {
  name: string;
  kind: string;
}

/** Unwrap the export wrapper around a top-level declaration. */
function unwrapTopLevelDeclaration(statement: Node): Node | null {
  const kind = (statement as Node & { kind?: string }).kind;
  if (kind === "ExportNamedDeclaration" || kind === "ExportDefaultDeclaration") {
    return (statement as Node & { declaration?: Node | null }).declaration ?? null;
  }
  return statement;
}

function declarationNodeName(node: Node): string | null {
  switch ((node as Node & { kind?: string }).kind) {
    case "VariableStatement": {
      const declarations = (node as Node & { declarations?: readonly Node[] }).declarations ?? [];
      if (declarations.length !== 1) {
        return null;
      }
      const binding = (declarations[0] as Node & { name?: Node }).name;
      return binding !== undefined && (binding as Node & { kind?: string }).kind === "Identifier"
        ? ((binding as Node & { name?: string }).name ?? null)
        : null;
    }
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "TypeAliasDeclaration":
    case "InterfaceDeclaration":
    case "EnumDeclaration": {
      const name = (node as Node & { name?: Node }).name;
      return name !== undefined && (name as Node & { kind?: string }).kind === "Identifier"
        ? ((name as Node & { name?: string }).name ?? null)
        : null;
    }
    case "NamespaceDeclaration":
      return (node as Node & { name?: string }).name ?? null;
    default:
      return null;
  }
}

/** The exact target kind, including const/let/var for variable entries. */
function targetDeclarationShape(source: string, entry: IndexEntry): DeclarationShape | null {
  if (entry.locator.kind !== "variable") {
    return { name: entry.locator.name, kind: entry.locator.kind };
  }
  let program: Program;
  try {
    program = new Parser(source).parseProgram();
  } catch {
    return null;
  }
  for (const statement of program.body) {
    const declaration = unwrapTopLevelDeclaration(statement);
    if (
      declaration !== null &&
      (declaration as Node & { kind?: string }).kind === "VariableStatement" &&
      entry.node.start >= declaration.start &&
      entry.node.end <= declaration.end
    ) {
      return {
        name: entry.locator.name,
        kind: (declaration as Node & { declarationKind?: string }).declarationKind ?? "variable",
      };
    }
  }
  return null;
}

/**
 * A whole-declaration modify replaces the declaration span, not just a body.
 * It must still produce exactly the same top-level declaration kind and name;
 * otherwise `NAME_ERROR = ...` can pass the parse gate and fail only at tsc.
 */
function declarationShapeProblem(
  source: string,
  entry: IndexEntry,
  replacement: string,
): string | null {
  const target = targetDeclarationShape(source, entry);
  if (target === null) {
    return null;
  }
  let program: Program;
  try {
    program = new Parser(replacement).parseProgram();
  } catch (error) {
    return `stage: address\ncode: EDIT_DECLARATION_MISMATCH\nthe replacement for ${JSON.stringify(target.kind)} ${JSON.stringify(target.name)} does not parse as a declaration: ${error instanceof Error ? error.message : String(error)}`;
  }
  const declarations = program.body
    .map((statement) => unwrapTopLevelDeclaration(statement))
    .filter((declaration): declaration is Node => declaration !== null);
  if (declarations.length !== 1) {
    return `stage: address\ncode: EDIT_DECLARATION_MISMATCH\na whole-declaration modify must produce exactly one top-level declaration named ${JSON.stringify(target.name)}; got ${declarations.length}`;
  }
  const declaration = declarations[0];
  if (declaration === undefined) {
    return `stage: address\ncode: EDIT_DECLARATION_MISMATCH\nthe replacement declares no top-level ${JSON.stringify(target.name)}`;
  }
  const name = declarationNodeName(declaration);
  if (name !== target.name) {
    return `stage: address\ncode: EDIT_DECLARATION_MISMATCH\nthe replacement must declare ${JSON.stringify(target.name)}, not ${JSON.stringify(name ?? "<not a declaration>")}`;
  }
  const kind =
    (declaration as Node & { kind?: string }).kind === "VariableStatement"
      ? ((declaration as Node & { declarationKind?: string }).declarationKind ?? "variable")
      : declarationKindOf(declaration);
  if (kind !== target.kind) {
    return `stage: address\ncode: EDIT_DECLARATION_MISMATCH\nthe replacement for ${JSON.stringify(target.kind)} ${JSON.stringify(target.name)} must remain a ${target.kind} declaration; got ${kind}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Applying one execution reply

interface ReplyOutcome {
  ok: boolean;
  diagnostics: string | null;
  viewerOnly: boolean;
  appliedLocators: Locator[];
  /** A whole-file write or a whole-declaration modify; used for advisory tsc. */
  wholeDeclaration?: boolean;
}

interface ExecutionContext {
  cwd: string;
  workspace: Workspace;
  options: LoopOptions;
  records: LoopRecord[];
  /** Warnings recovered by a tolerant parser; recorded on the run result. */
  warnings: string[];
  runState: TaskRunState;
  iteration: number;
}

function editDslDeps(
  context: ExecutionContext,
  target: string,
  sourceOverride: string,
): MultiEditorDeps {
  const cache = new Map<string, string>();
  const sourceFor = (path: string): string => {
    if (path === target) {
      return sourceOverride;
    }
    const cached = cache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const source = readTarget(context.cwd, path);
    cache.set(path, source);
    return source;
  };
  return {
    sourceFor,
    fileExists: (path) => readFileIfExists(join(context.cwd, path)) !== null,
    isSafePath: (path) => safeMutablePath(context.cwd, path) !== null,
    resolveEntry: (source, path, locator, space) =>
      resolveCurrentEntry(source, path, locator, space),
  };
}

const EXPORT_MODIFIER = /^\s*(export\s+(?:default\s+)?)?/;

/**
 * The edit-dsl cascade strips a leading `export` from a whole-declaration
 * replacement when the declaration carries one (the #48 tolerance). A planner's
 * instruction names the declaration by its exported shape, so the task driver
 * passes the reply through unchanged when the source declares it exported and
 * only tolerates a repeated modifier otherwise: the splice keeps the modifier.
 */
function withExportModifier(
  selection: EditDslSelection,
  source: string,
  entry: IndexEntry | null,
): EditDslSelection {
  const replacement = selection.replacement;
  if (
    replacement === null ||
    replacement.trim() === "" ||
    selection.rename !== undefined ||
    entry === null ||
    selection.matcher !== null ||
    selection.pick !== null
  ) {
    return selection;
  }
  const before = source.slice(0, entry.node.start);
  const exported = /(export\s+(?:default\s+)?)$/.test(before);
  const replierExported = EXPORT_MODIFIER.exec(replacement)?.[1] !== undefined;
  if (exported && !replierExported) {
    // The source declared it exported; keep that modifier on the rewrite. Only
    // the declaration's own start inherits it.
    return { ...selection, replacement: `export ${replacement}` };
  }
  if (!exported && replierExported) {
    // The reply re-adds `export` the declaration omitted; tolerate it.
    return { ...selection, replacement: stripLeadingExport(replacement, "export") };
  }
  return selection;
}

/**
 * A variable index entry points at its `VariableDeclarator`, not the enclosing
 * statement, so a whole-symbol rewrite would leave `const`/`export` behind.
 * Expand a whole-symbol variable edit to its top-level statement (including the
 * `export` wrapper); a multi-declarator statement is rejected because replacing
 * it would remove sibling bindings. Matcher/pick edits stay untouched.
 */
function expandVariableRegion(
  source: string,
  entry: IndexEntry,
  region: EditDslRegion,
): EditDslRegion | { error: string } {
  if (region.create || region.matcherKind !== null || region.stage !== "whole-symbol") {
    return region;
  }
  let program: Program;
  try {
    program = new Parser(source).parseProgram();
  } catch {
    return region;
  }
  for (const statement of program.body) {
    if (entry.node.start < statement.start || entry.node.end > statement.end) {
      continue;
    }
    const exported = statement.kind === "ExportNamedDeclaration";
    const declaration =
      statement.kind === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration === null || declaration.kind !== "VariableStatement") {
      return region;
    }
    if (declaration.declarations.length !== 1) {
      return {
        error: `stage: address\nthe task targets ${JSON.stringify(entry.locator.name)} in a statement that declares several variables; replacing the whole statement would remove its siblings. Split the declaration first, or use a \`match\` on the one binding`,
      };
    }
    const text = region.text;
    if (text.trim() === "") {
      return { ...region, start: statement.start, end: statement.end, text: "" };
    }
    const lead = text.trimStart();
    const shaped =
      exported && !/^export\b/.test(lead)
        ? `export ${text}`
        : !exported && /^export\s+/.test(lead)
          ? text.replace(/^\s*export\s+/, "")
          : text;
    return { ...region, start: statement.start, end: statement.end, text: shaped };
  }
  return region;
}

function rejectionText(resolution: MultiEditorResolution, totalClauses: number): string {
  return resolution.failures
    .map(
      (failure) =>
        `clause ${failure.index + 1} of ${totalClauses} (${failure.path}):\n${failure.diagnostics}`,
    )
    .join("\n\n");
}

function writeTargetFromReply(
  task: EditNode,
  statements: readonly EditStatement[],
):
  | {
      ok: true;
      write: WriteFileStatement;
    }
  | { ok: false; diagnostics: string } {
  if (statements.length !== 1) {
    return {
      ok: false,
      diagnostics: `stage: protocol\n${editLabel(task)}: a whole-file write reply carries exactly one write statement`,
    };
  }
  const statement = statements[0];
  if (statement?.type !== "fs" || statement.statement.op !== "write") {
    return {
      ok: false,
      diagnostics: `stage: protocol\n${editLabel(task)}: reply with \`write ${task.loc.path} with <fence>\``,
    };
  }
  const write = statement.statement;
  if (write.path !== task.loc.path) {
    return {
      ok: false,
      diagnostics: `stage: address\n${editLabel(task)}: the reply writes ${JSON.stringify(write.path)}, not the declared path`,
    };
  }
  if (write.ranges !== null) {
    return {
      ok: false,
      diagnostics: `stage: address\n${editLabel(task)}: a whole-file write omits \`within\`; send the complete file`,
    };
  }
  return { ok: true, write };
}

/**
 * Apply one whole-file write. The previous parse is irrelevant because the
 * reply replaces the file; the new source still passes the parse gate and
 * formatter before it lands.
 */
async function applyWholeFileWrite(
  context: ExecutionContext,
  task: EditNode,
  write: WriteFileStatement,
): Promise<ReplyOutcome> {
  if (safeMutablePath(context.cwd, task.loc.path) === null) {
    return {
      ok: false,
      diagnostics: `stage: address\n${editLabel(task)}: the path is outside the editable workspace`,
      viewerOnly: false,
      appliedLocators: [],
    };
  }
  const parsed = parseCheck(write.replacement);
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostics: gateDiagnostics(0, write.replacement, parsed.failure),
      viewerOnly: false,
      appliedLocators: [],
    };
  }
  let formatted: string;
  try {
    formatted = await formatSource(task.loc.path, write.replacement);
  } catch (error) {
    return {
      ok: false,
      diagnostics: `stage: format\nthe whole-file write could not be formatted: ${error instanceof Error ? error.message : String(error)}`,
      viewerOnly: false,
      appliedLocators: [],
    };
  }
  const formattedCheck = parseCheck(formatted);
  if (!formattedCheck.ok) {
    return {
      ok: false,
      diagnostics: gateDiagnostics(0, formatted, formattedCheck.failure),
      viewerOnly: false,
      appliedLocators: [],
    };
  }
  if (formatted === readTarget(context.cwd, task.loc.path)) {
    return { ok: false, diagnostics: NOOP_DIAGNOSTICS, viewerOnly: false, appliedLocators: [] };
  }
  writeTarget(context.cwd, task.loc.path, formatted);
  return {
    ok: true,
    diagnostics: null,
    viewerOnly: false,
    appliedLocators: [locatorOf(task)],
    wholeDeclaration: true,
  };
}

/**
 * Parse one execution reply and, if it carries editors, apply them atomically.
 * A read-only reply (viewers, `read`) writes nothing and its feedback becomes
 * the next turn's diagnostics. A `write` task accepts exactly one whole-file
 * `write` command; other tasks reject file commands that write.
 */
async function applyEditReply(
  context: ExecutionContext,
  task: EditNode,
  content: string,
): Promise<ReplyOutcome> {
  const parsed = parseMultiEditorDetailed(content);
  if (!parsed.ok) {
    return {
      ok: false,
      diagnostics: renderDslIssues(parsed.issues),
      viewerOnly: false,
      appliedLocators: [],
    };
  }
  for (const warning of parsed.issues.filter((issue) => issue.severity === "warning")) {
    context.warnings.push(`${warning.code}: ${warning.message}`);
  }
  const statements = parsed.value ?? [];
  if (statements.length === 0) {
    return {
      ok: false,
      diagnostics:
        "stage: protocol\nthe reply carried no edit statement; reply with the edit clauses for this task",
      viewerOnly: false,
      appliedLocators: [],
    };
  }
  if (task.action === "write") {
    const replied = writeTargetFromReply(task, statements);
    if (!replied.ok) {
      return {
        ok: false,
        diagnostics: replied.diagnostics,
        viewerOnly: false,
        appliedLocators: [],
      };
    }
    return applyWholeFileWrite(context, task, replied.write);
  }
  for (const statement of statements) {
    if (statement.type === "editor") {
      continue;
    }
    if (statement.statement.op === "read") {
      continue;
    }
    return {
      ok: false,
      diagnostics: `stage: protocol\n${editLabel(task)}: the file command "${statement.statement.op}" is not accepted; one task edits one declared declaration`,
      viewerOnly: false,
      appliedLocators: [],
    };
  }
  const own = ownStatementIndices(task, statements);
  const guarded = guardTarget(context.workspace, task);
  if (!guarded.ok) {
    return { ok: false, diagnostics: guarded.diagnostics, viewerOnly: false, appliedLocators: [] };
  }
  const sourceBefore = readTarget(context.cwd, task.loc.path);
  const normalized = new Map<number, EditDslSelection>();
  const entryByIndex = new Map<number, IndexEntry | null>();
  const locs = editLocs(task);
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (statement?.type !== "editor") {
      continue;
    }
    const selection = statement.selection;
    if (!own.has(index)) {
      continue;
    }
    const matching = locs.filter(
      (loc) =>
        loc.path === selection.locator.path &&
        loc.symbol === selection.locator.name &&
        (selection.space === null || selection.space === loc.kind),
    );
    const loc = matching[0];
    if (loc === undefined || matching.length !== 1) {
      const sameName = locs.filter(
        (candidate) =>
          candidate.path === selection.locator.path && candidate.symbol === selection.locator.name,
      );
      return {
        ok: false,
        diagnostics:
          sameName.length > 0
            ? `stage: address\ncode: EDIT_TARGET_MISMATCH\n${editLabel(task)}: the clause resolves ${JSON.stringify(
                selection.space,
              )} but the task target is ${JSON.stringify(sameName[0]?.kind)}; use the matching symbol space or omit resolve`
            : `stage: address\ncode: EDIT_TARGET_MISMATCH\n${editLabel(task)}: the clause resolves an address that is neither the target nor one of its related declarations`,
        viewerOnly: false,
        appliedLocators: [],
      };
    }
    const entry =
      loc === task.loc
        ? guarded.entry
        : (guarded.related[task.related?.indexOf(loc) ?? -1] ?? null);
    entryByIndex.set(index, entry);
    normalized.set(
      index,
      withExportModifier({ ...selection, space: symbolSpaceOf(loc) }, sourceBefore, entry),
    );
  }
  if (task.action === "modify") {
    for (const [index, selection] of normalized) {
      if (
        selection.replacement === null ||
        selection.replacement.trim() === "" ||
        selection.matcher !== null ||
        selection.pick !== null
      ) {
        continue;
      }
      const entry = entryByIndex.get(index);
      if (entry === undefined || entry === null) {
        continue;
      }
      const problem = declarationShapeProblem(sourceBefore, entry, selection.replacement);
      if (problem !== null) {
        return {
          ok: false,
          diagnostics: problem,
          viewerOnly: false,
          appliedLocators: [],
        };
      }
    }
  }
  const resolution = resolveMultiEditor(
    statements.map((statement, index) => {
      const replacement = normalized.get(index);
      return replacement === undefined || statement.type !== "editor"
        ? statement
        : { ...statement, selection: replacement };
    }),
    editDslDeps(context, task.loc.path, sourceBefore),
  );
  if (resolution.regions.some((region) => !own.has(region.index))) {
    return { ok: false, diagnostics: targetMismatch(task), viewerOnly: false, appliedLocators: [] };
  }

  const ownSelections = statements.flatMap((statement, index) =>
    statement.type === "editor" && own.has(index) ? [statement.selection] : [],
  );
  const renames = ownSelections.filter(
    (selection) => selection.rename !== undefined && selection.rename !== null,
  );
  const replacements = ownSelections.filter((selection) => selection.replacement !== null);
  const actionFailure = (detail: string): ReplyOutcome => ({
    ok: false,
    diagnostics: `stage: address\n${editLabel(task)}: ${detail}`,
    viewerOnly: false,
    appliedLocators: [],
  });
  if (task.action === "rename") {
    if (renames.length === 0 || renames.length !== ownSelections.length) {
      return actionFailure(
        `a rename task replies with exactly the rename clause(s) to ${JSON.stringify(task.renameTo)}; every clause must be \`rename <current> to <new>\`, never \`replace\``,
      );
    }
    for (const selection of renames) {
      if (selection.rename?.to !== task.renameTo) {
        return actionFailure(
          `the rename target must be ${JSON.stringify(task.renameTo)} (got ${JSON.stringify(selection.rename?.to)})`,
        );
      }
    }
  } else if (task.action === "delete") {
    if (replacements.length === 0) {
      return actionFailure(
        "a delete task replies with a whole-declaration clause and an empty fence; a viewer writes nothing",
      );
    }
    for (const selection of replacements) {
      if (selection.replacement?.trim() !== "") {
        return actionFailure(
          "a delete task uses an empty fence; use modify to rewrite a declaration",
        );
      }
      if (selection.matcher !== null || selection.pick !== null) {
        return actionFailure(
          "a delete task removes the whole declaration: omit `match` and `pick`, and use an empty fence",
        );
      }
    }
  } else {
    if (renames.length > 0) {
      return actionFailure(
        `a ${task.action} task must not rename; a rename is its own task with action "rename"`,
      );
    }
    if (task.action === "modify" && replacements.length === 0) {
      return actionFailure(
        "a modify task must change the declaration; a viewer writes nothing, so add `replace with <fence>`",
      );
    }
    if (task.action === "modify") {
      for (const selection of ownSelections) {
        if (
          selection.rename === undefined &&
          selection.replacement?.trim() === "" &&
          selection.matcher === null &&
          selection.pick === null
        ) {
          return actionFailure(
            'a whole-declaration empty fence deletes the declaration; express that intent with action "delete"',
          );
        }
      }
    }
    if (task.action === "create") {
      const ownRegions = resolution.regions.filter((region) => own.has(region.index));
      const created = ownRegions.filter((region) => region.create);
      if (ownRegions.length > 0 && (created.length === 0 || created.length !== ownRegions.length)) {
        return actionFailure(
          "a create task adds the absent declaration with a whole-declaration clause (no `match`, no `pick`)",
        );
      }
      for (const region of created) {
        const problem = createBodyCheck(task, region.text.trim());
        if (problem !== null) {
          return { ok: false, diagnostics: problem, viewerOnly: false, appliedLocators: [] };
        }
      }
    }
  }

  if (resolution.failures.length > 0) {
    return {
      ok: false,
      diagnostics: rejectionText(resolution, statements.length),
      viewerOnly: false,
      appliedLocators: [],
    };
  }
  const expandedRegions: EditDslRegion[] = [];
  for (const region of resolution.regions) {
    // A rename region carries the new identifier, not a replacement statement;
    // expanding it to the whole variable statement would destroy the body.
    if (task.action === "rename") {
      expandedRegions.push(region);
      continue;
    }
    const entry = entryByIndex.get(region.index) ?? null;
    const expanded = entry === null ? region : expandVariableRegion(sourceBefore, entry, region);
    if ("error" in expanded) {
      return { ok: false, diagnostics: expanded.error, viewerOnly: false, appliedLocators: [] };
    }
    expandedRegions.push(expanded);
  }
  const feedback = [
    resolution.viewers.length === 0 ? null : renderViewerFeedback(resolution.viewers),
    resolution.reads.length === 0 ? null : renderReadFeedback(resolution.reads),
    renderReadFailureFeedback(resolution.readFailures),
  ]
    .filter((block): block is string => block !== null && block !== "")
    .join("\n\n");

  if (resolution.regions.length === 0) {
    if (resolution.creates.length > 0 || resolution.deletes.length > 0) {
      return actionFailure(
        "the reply only created or deleted files; edit the declared declaration instead",
      );
    }
    return {
      ok: false,
      diagnostics:
        feedback === ""
          ? "stage: protocol\nthe reply carried a viewer but resolved no occurrence; reply with an edit clause"
          : `stage: protocol\nthe reply only located source and wrote nothing; add the \`replace with\` or \`rename\` clause for this task.\n\n${feedback}`,
      viewerOnly: true,
      appliedLocators: [],
    };
  }

  const prevCheck = parseCheck(sourceBefore);
  if (!prevCheck.ok) {
    return {
      ok: false,
      diagnostics: prevBrokenDiagnostics(task.loc.path, prevCheck.failure),
      viewerOnly: false,
      appliedLocators: [],
    };
  }
  let failure: string | null = null;
  const writes = await applyResolvedRegions({
    regions: expandedRegions.map(editDslRegionToResolved),
    fileSourceOf: (path) => (path === task.loc.path ? sourceBefore : readTarget(context.cwd, path)),
    target: task.loc.path,
    prevCheck,
    policy: { sameOffsetInserts: "append" },
    noteFailure: (note) => {
      failure = failure ?? note.diagnostics;
    },
    noteOverlap: (path, earlier, later) => {
      failure =
        failure ??
        `stage: protocol\nthe reply's regions overlap in ${path} (clauses ${earlier.index + 1} and ${later.index + 1}); send non-overlapping clauses`;
    },
  });
  if (failure !== null) {
    return {
      ok: false,
      diagnostics: feedback === "" ? failure : `${failure}\n\n${feedback}`,
      viewerOnly: false,
      appliedLocators: [],
    };
  }
  for (const write of writes) {
    writeTarget(context.cwd, write.path, write.source);
  }
  const appliedLocators = expandedRegions.map((region) =>
    region.create ? locatorOf(task) : region.locator,
  );
  return {
    ok: true,
    diagnostics: feedback === "" ? null : feedback,
    viewerOnly: false,
    appliedLocators,
    wholeDeclaration:
      task.action === "modify" && expandedRegions.some((region) => region.stage === "whole-symbol"),
  };
}

/** The declaration (or whole file for create) and its 1-based start line. */
function declarationView(cwd: string, task: EditNode): { view: string; startLine: number } {
  const source = readTarget(cwd, task.loc.path);
  if (task.loc.kind === "file" || (task.related !== undefined && task.related.length > 0)) {
    // A whole-file write or a migration task needs the whole file because the
    // edit can span declarations; the numbered view keeps file-absolute lines.
    const lines = source.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return { view: lines.join("\n"), startLine: 1 };
  }
  const entry = resolveCurrentEntry(
    source,
    task.loc.path,
    locatorOf(task),
    symbolSpaceOf(task.loc),
  );
  const startOffset = entry.ok ? entry.entry.node.start : 0;
  const endOffset = entry.ok ? entry.entry.node.end : source.length;
  const body = source.slice(startOffset, endOffset);
  const startLine = source.slice(0, startOffset).split("\n").length;
  const lines = body.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return { view: "", startLine };
  }
  return { view: lines.join("\n"), startLine };
}

interface EditExecution {
  ok: boolean;
  diagnostics: string | null;
  messages: ChatMessage[];
  /** Raw advisory tsc diagnostics after a large edit; never a gate failure. */
  advisoryDiagnostics?: string | null;
}

/**
 * Run one task gate after every edit in that task has settled. A `tsc` gate
 * runs the type check; a `test` gate also runs the test suite. The gate is the
 * only place a type/test failure is turned into planner diagnostics.
 */
async function verifyTask(
  context: ExecutionContext,
  task: TaskNode,
  baseSource: string,
): Promise<{ ok: boolean; diagnostics: string | null }> {
  const anchor = firstEdit(task);
  const check = await checkTool(
    context.cwd,
    context.options.checkCommand,
    context.options.commandTimeoutMs,
  );
  const test =
    check.ok && task.verify === "test"
      ? await testTool(context.cwd, context.options.testCommand, context.options.commandTimeoutMs)
      : { ok: true, exitCode: 0, output: "" };
  const diagnostics =
    check.ok && test.ok
      ? null
      : formatDiagnostics({
          check,
          test,
          targetPath: anchor.loc.path,
          baseSource,
          newSource: readTarget(context.cwd, anchor.loc.path),
          sourceFor: (path) => readTarget(context.cwd, path),
        });
  writeRecord(context.records, {
    iteration: context.iteration,
    kind: "verification",
    exchange: null,
    edit: anchor,
    outcome: check.ok ? (test.ok ? "ok" : "tests") : "tsc",
    replacement: null,
    diagnostics,
    finishReason: null,
  });
  return { ok: check.ok && test.ok, diagnostics };
}

/**
 * Carry out one micro edit. The executor lands the edit and stops; the task
 * gate runs only after every edit in the task has settled. Protocol/address
 * failures still consume one of the bounded exchanges.
 */
async function executeEdit(
  context: ExecutionContext,
  chat: ChatState,
  usage: UsageState,
  stage: Stage,
  task: TaskNode,
  edit: EditNode,
  priorGateDiagnostics: string | undefined,
  postEditDiagnostics: string | undefined,
): Promise<EditExecution> {
  let diagnostics: string | undefined;
  let consecutiveLength = 0;
  let selfCheckUsed = false;
  let formatHelp = false;
  let addressMismatches = 0;
  let malformedMatchers = 0;

  for (let exchange = 1; exchange <= MAX_TASK_EXCHANGES; exchange += 1) {
    const matcherFailure: TaskMatcherFailure | undefined =
      malformedMatchers === 0 ? undefined : malformedMatchers === 1 ? "malformed" : "repeated";
    const view = declarationView(context.cwd, edit);
    const contextText = [
      `This is micro edit #${edit.id} in task #${task.id}, stage #${stage.id}. Do not change declarations outside this edit's target and related list.`,
      priorGateDiagnostics === undefined
        ? null
        : `A previous task gate in this stage failed; later edits may need to fix it:\n\n${priorGateDiagnostics}`,
    ]
      .filter((block): block is string => block !== null && block.trim() !== "")
      .join("\n\n");
    const prompt = buildTaskTurnPrompt({
      state: context.runState,
      stage,
      task,
      edit,
      contentView: renderTaskContentView(view.view, view.startLine),
      startLine: view.startLine,
      diagnostics,
      help: formatHelp,
      matcherFailure,
      context: contextText,
      postEditDiagnostics,
    });
    const last = chat.messages[chat.messages.length - 1];
    if (last?.role === "user" && (last.content ?? "").startsWith("# Stage")) {
      chat.messages[chat.messages.length - 1] = { role: "user", content: prompt };
    } else {
      chat.messages.push({ role: "user", content: prompt });
    }
    let response: ChatResponse;
    try {
      response = await callModel(
        chat.messages,
        usage.usage.execution,
        usage,
        context.options.provider,
        context.options,
      );
    } catch (error) {
      return { ok: false, diagnostics: providerErrorDiagnostics(error), messages: chat.messages };
    }
    const budget = context.options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    if (overBudget(usage, budget)) {
      return {
        ok: false,
        diagnostics: tokenBudgetDiagnostics(
          usage.consumed,
          budget,
          context.options.tokenBudgetBasis ?? "raw",
        ),
        messages: chat.messages,
      };
    }
    const content = response.content ?? "";
    chat.messages.push({ role: "assistant", content });
    if (response.finishReason === "length") {
      consecutiveLength += 1;
      if (consecutiveLength >= MAX_CONSECUTIVE_LENGTH) {
        return {
          ok: false,
          diagnostics: `output-limit: the completion hit the output limit ${MAX_CONSECUTIVE_LENGTH} times in a row`,
          messages: chat.messages,
        };
      }
    } else {
      consecutiveLength = 0;
    }
    const request = parseSelfCheckRequest(content);
    if (request.kind === "error") {
      diagnostics = request.diagnostics;
      formatHelp = true;
      malformedMatchers = 0;
      continue;
    }
    if (request.kind === "ok") {
      malformedMatchers = 0;
      if (selfCheckUsed) {
        diagnostics =
          "stage: protocol\nthe edit already used its one read; return the edit clauses now";
        formatHelp = true;
      } else {
        selfCheckUsed = true;
        diagnostics =
          request.request === "read"
            ? `Self-check (read): current source of ${formatTaskLoc(edit.loc)}.\n\n${renderTaskContentView(view.view, view.startLine)}`
            : `Self-check (${request.request}): an edit turn edits code; \`read\` is the only self-check accepted here.`;
        formatHelp = request.request !== "read";
      }
      continue;
    }
    const doneWord = /^TASK[ _-]?DONE\b/i.test(
      stripCodeFences(content)
        .replace(/[.!]+$/, "")
        .trim(),
    );
    if (doneWord) {
      diagnostics = `stage: protocol\nTASK_DONE ends an edit that applied a change; this edit has not changed ${formatTaskLoc(edit.loc)} yet, so reply with the edit clauses`;
      formatHelp = true;
      malformedMatchers = 0;
      writeRecord(context.records, {
        iteration: context.iteration,
        kind: "exchange",
        exchange,
        edit,
        outcome: "protocol",
        replacement: content,
        diagnostics,
        finishReason: response.finishReason,
      });
      continue;
    }
    const outcome = await applyEditReply(context, edit, content);
    if (!outcome.ok) {
      diagnostics = outcome.diagnostics ?? "stage: protocol\nthe edit was rejected";
      const addressMismatch =
        stageOf(diagnostics) === "address" && /EDIT_TARGET_MISMATCH/.test(diagnostics);
      addressMismatches = addressMismatch ? addressMismatches + 1 : 0;
      malformedMatchers = isMalformedMatcher(diagnostics) ? malformedMatchers + 1 : 0;
      formatHelp =
        outcome.viewerOnly ||
        /^stage: (protocol|syntax|address|matcher|range|no-op)/.test(diagnostics);
      writeRecord(context.records, {
        iteration: context.iteration,
        kind: "exchange",
        exchange,
        edit,
        outcome: outcome.viewerOnly ? "viewer" : outcomeOf(stageOf(diagnostics)),
        replacement: content,
        diagnostics,
        finishReason: response.finishReason,
      });
      if (addressMismatches >= 2) {
        return {
          ok: false,
          diagnostics: `${diagnostics}\n\nstage: address\ncode: ADDRESS_RETRY_LIMIT\n${editLabel(edit)}: the same target mismatch repeated ${addressMismatches} times; stop retrying this address. Replace this edit with a whole-file \`write\` or split it into smaller edits.`,
          messages: chat.messages,
        };
      }
      continue;
    }
    formatHelp = false;
    malformedMatchers = 0;
    writeRecord(context.records, {
      iteration: context.iteration,
      kind: "exchange",
      exchange,
      edit,
      outcome: "applied",
      replacement: content,
      diagnostics: outcome.diagnostics,
      finishReason: response.finishReason,
      payloads: 1,
      appliedLocators: outcome.appliedLocators,
    });
    const editIndex = task.edits.findIndex((candidate) => candidate.id === edit.id);
    const hasLaterEdit = editIndex >= 0 && editIndex < task.edits.length - 1;
    let advisoryDiagnostics: string | null = null;
    if (hasLaterEdit && (edit.action === "write" || outcome.wholeDeclaration === true)) {
      const check = await checkTool(
        context.cwd,
        context.options.checkCommand,
        context.options.commandTimeoutMs,
      );
      if (!check.ok) {
        const output = check.output.trim();
        advisoryDiagnostics = output === "" ? "(tsc produced no output)" : output.slice(0, 6000);
      }
    }
    return {
      ok: true,
      diagnostics: null,
      messages: chat.messages,
      advisoryDiagnostics,
    };
  }
  return {
    ok: false,
    diagnostics: `stage: edit-failed\n${editLabel(edit)} did not land an edit within ${MAX_TASK_EXCHANGES} exchanges\n\n${diagnostics ?? "the edit ran out of exchanges without a write"}`,
    messages: chat.messages,
  };
}

// ---------------------------------------------------------------------------
// Concise applied diff (#32)

/** One LCS diff entry: unchanged context, removed, or added. */
interface DiffEntry {
  kind: " " | "-" | "+";
  text: string;
}

const DIFF_CONTEXT_LINES = 3;
const MAX_DIFF_LINES = 120;
const MAX_DIFF_LINES_PER_FILE = 60;
const DIFF_CELL_LIMIT = 4_000_000;
const DIFF_TRUNCATED = "... diff truncated ...";

function splitDiffLines(source: string): string[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** Line diff via LCS; huge pairs fall back to a whole-file replacement. */
function diffLines(before: readonly string[], after: readonly string[]): DiffEntry[] {
  if (before.length * after.length > DIFF_CELL_LIMIT) {
    return [
      ...before.map((text) => ({ kind: "-" as const, text })),
      ...after.map((text) => ({ kind: "+" as const, text })),
    ];
  }
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const a = before[i];
      const b = after[j];
      const index = i * width + j;
      if (a !== undefined && a === b) {
        table[index] = (table[(i + 1) * width + (j + 1)] ?? 0) + 1;
      } else {
        table[index] = Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + (j + 1)] ?? 0);
      }
    }
  }
  const entries: DiffEntry[] = [];
  let i = 0;
  let j = 0;
  for (;;) {
    const a = before[i];
    const b = after[j];
    if (a === undefined && b === undefined) {
      break;
    }
    if (a !== undefined && b !== undefined && a === b) {
      entries.push({ kind: " ", text: a });
      i += 1;
      j += 1;
      continue;
    }
    const skipBefore = a === undefined ? -1 : (table[(i + 1) * width + j] ?? 0);
    const skipAfter = b === undefined ? -1 : (table[i * width + (j + 1)] ?? 0);
    if (a !== undefined && (b === undefined || skipBefore >= skipAfter)) {
      entries.push({ kind: "-", text: a });
      i += 1;
    } else if (b !== undefined) {
      entries.push({ kind: "+", text: b });
      j += 1;
    }
  }
  return entries;
}

/** Group changed lines into hunks with a few lines of shared context. */
function hunkRanges(entries: readonly DiffEntry[]): { start: number; end: number }[] {
  const changes: number[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind !== " ") {
      changes.push(index);
    }
  });
  if (changes.length === 0) {
    return [];
  }
  const ranges: { start: number; end: number }[] = [];
  let start = -1;
  let end = -1;
  for (const index of changes) {
    const from = Math.max(0, index - DIFF_CONTEXT_LINES);
    const to = Math.min(entries.length, index + DIFF_CONTEXT_LINES + 1);
    if (start === -1) {
      start = from;
      end = to;
      continue;
    }
    if (from <= end) {
      end = Math.max(end, to);
    } else {
      ranges.push({ start, end });
      start = from;
      end = to;
    }
  }
  ranges.push({ start, end });
  return ranges;
}

/** Render one changed file, capped so a large rewrite cannot flood the review. */
function diffFile(
  path: string,
  before: string,
  after: string,
): { lines: string[]; truncated: boolean } {
  const entries = diffLines(splitDiffLines(before), splitDiffLines(after));
  if (!entries.some((entry) => entry.kind !== " ")) {
    return { lines: [], truncated: false };
  }
  const beforeCounts = new Array<number>(entries.length + 1).fill(0);
  const afterCounts = new Array<number>(entries.length + 1).fill(0);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    beforeCounts[index + 1] =
      (beforeCounts[index] ?? 0) + (entry === undefined || entry.kind === "+" ? 0 : 1);
    afterCounts[index + 1] =
      (afterCounts[index] ?? 0) + (entry === undefined || entry.kind === "-" ? 0 : 1);
  }
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const range of hunkRanges(entries)) {
    const beforeStartCount = beforeCounts[range.start] ?? 0;
    const afterStartCount = afterCounts[range.start] ?? 0;
    const beforeCount = (beforeCounts[range.end] ?? 0) - beforeStartCount;
    const afterCount = (afterCounts[range.end] ?? 0) - afterStartCount;
    const beforeStart = beforeCount === 0 ? beforeStartCount : beforeStartCount + 1;
    const afterStart = afterCount === 0 ? afterStartCount : afterStartCount + 1;
    lines.push(`@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`);
    for (let index = range.start; index < range.end; index += 1) {
      const entry = entries[index];
      if (entry !== undefined) {
        lines.push(`${entry.kind}${entry.text}`);
      }
    }
  }
  return lines.length > MAX_DIFF_LINES_PER_FILE
    ? { lines: lines.slice(0, MAX_DIFF_LINES_PER_FILE), truncated: true }
    : { lines, truncated: false };
}

/** The applied diff for a Task: only changed files, only changed hunks. */
function appliedDiff(cwd: string, bases: ReadonlyMap<string, string>): string {
  const output: string[] = [];
  for (const [path, before] of bases) {
    const after = readTarget(cwd, path);
    if (after === before) {
      continue;
    }
    const diff = diffFile(path, before, after);
    if (diff.lines.length === 0) {
      continue;
    }
    const room = MAX_DIFF_LINES - output.length;
    if (room <= 0) {
      output.push(DIFF_TRUNCATED);
      break;
    }
    if (diff.lines.length > room) {
      output.push(...diff.lines.slice(0, room), DIFF_TRUNCATED);
      break;
    }
    output.push(...diff.lines);
    if (diff.truncated) {
      output.push(DIFF_TRUNCATED);
      break;
    }
  }
  return output.join("\n");
}

// ---------------------------------------------------------------------------
// Review patch scope (#32)

/** A review patch tried to mutate a done edit or a passed task. */
function immutableReviewError(diagnostics: string | null): boolean {
  return (
    diagnostics !== null &&
    /(done edit #\S+ is immutable|passed task #\S+ is immutable)/.test(diagnostics)
  );
}

/**
 * A review patch may repair only the current Task. Check the wire ops before
 * applying so a future Stage/Task or a foreign edit is rejected by name; the
 * post-apply structural check catches anything the merge would otherwise allow.
 */
function reviewPatchProblems(state: TaskRunState, task: TaskNode, patch: PlanPatch): string | null {
  const editIds = new Set(task.edits.map((edit) => edit.id));
  const problems: string[] = [];
  for (const op of patch.ops) {
    switch (op.kind) {
      case "plan-update":
        problems.push("plan~ is not allowed; a review may not change the Plan goal");
        break;
      case "stage-add":
        problems.push(`stage+ #${op.id} would add future work; a review may not add a Stage`);
        break;
      case "stage-update":
        problems.push(`stage~ #${op.id} is not allowed; a review may not change a Stage`);
        break;
      case "stage-remove":
        problems.push(`stage- #${op.id} is not allowed; a review may not remove a Stage`);
        break;
      case "task-add":
        problems.push(
          `task+ #${op.id} would add future work; a review may only repair the current task #${task.id}`,
        );
        break;
      case "task-remove":
        problems.push(`task- #${op.id} cannot repair the current task #${task.id}`);
        break;
      case "task-update":
        if (op.id !== task.id) {
          problems.push(
            `task~ #${op.id} targets another task; a review may only repair the current task #${task.id}`,
          );
        }
        break;
      case "edit-add":
        if (op.task !== task.id) {
          problems.push(
            `edit+ #${op.id} targets task #${op.task}, not the current task #${task.id}`,
          );
        }
        break;
      case "edit-update":
      case "edit-remove":
        if (!editIds.has(op.id)) {
          problems.push(
            `${op.kind === "edit-update" ? "edit~" : "edit-"} #${op.id} is not an edit of the current task #${task.id}`,
          );
        }
        break;
    }
  }
  if (patch.finish) {
    const last = finalTask(state.stages);
    if (last === undefined || last.id !== task.id || task.verify !== "test") {
      problems.push(
        "finish is allowed only when the current task is the last task and verifies test",
      );
    }
  }
  if (patch.ops.length === 0 && !patch.finish) {
    problems.push("the patch is empty; reply with approve or a repair patch");
  }
  return problems.length === 0
    ? null
    : `stage: task-scope\n- ${[...new Set(problems)].join("\n- ")}`;
}

/** Everything except the current Task definition: stages, goals, other Tasks. */
function structureFingerprint(state: TaskRunState, taskId: NodeId): string {
  const stages = state.stages.map((stage) => ({
    id: stage.id,
    goal: stage.goal,
    tasks: stage.tasks.filter((task) => task.id !== taskId),
  }));
  return serializePlanDsl({ id: state.plan.id, goal: state.plan.goal, stages });
}

/**
 * The post-apply half of review scope. The current Task must still exist,
 * reopen as pending, and be the only definition that changed; finish may only
 * stay on the current Task.
 */
function reviewMergeProblems(
  before: TaskRunState,
  after: TaskRunState,
  task: TaskNode,
): string | null {
  const problems: string[] = [];
  if (structureFingerprint(before, task.id) !== structureFingerprint(after, task.id)) {
    problems.push("a review patch must not change the Plan, a Stage, or another Task");
  }
  if (allTasks(after.stages).every((candidate) => candidate.id !== task.id)) {
    problems.push(`the review patch removed the current task #${task.id}`);
  }
  if (after.taskStatus.get(task.id) !== "pending") {
    problems.push(`the review patch did not reopen the current task #${task.id}`);
  }
  if (
    before.finalTaskId !== null &&
    after.finalTaskId !== before.finalTaskId &&
    after.finalTaskId !== task.id
  ) {
    problems.push("the review patch may not move finalTaskId to another task");
  }
  return problems.length === 0
    ? null
    : `stage: task-scope\n- ${[...new Set(problems)].join("\n- ")}`;
}

// ---------------------------------------------------------------------------
// The driver

/** Compare the Plan wire form plus the finish marker; status is harness state. */
function fingerprintState(state: TaskRunState): string {
  return `${serializePlanDsl(state.plan)}\nfinish: ${state.finalTaskId ?? ""}`;
}

/** The initial Plan is one current Stage and one current Task; later turns patch. */
function initialPlanProblems(plan: Plan): string | null {
  const problems: string[] = [];
  if (plan.stages.length !== 1) {
    problems.push(
      `the initial Plan must contain exactly one current Stage, not ${plan.stages.length}; plan later Stages with patches`,
    );
  }
  const stage = plan.stages[0];
  if (stage !== undefined && stage.tasks.length !== 1) {
    problems.push(
      `the initial Stage #${stage.id} must contain exactly one current Task, not ${stage.tasks.length}; add later Tasks with patches`,
    );
  }
  return problems.length === 0
    ? null
    : `stage: task-tree\n${problems.map((problem) => `- ${problem}`).join("\n")}`;
}

/**
 * Enforce the one-unit planning rule after a patch applies: one new Task and
 * one new Stage per turn, and a new Stage only after the current work settles.
 */
function oneUnitProblems(previous: TaskRunState, next: TaskRunState): string | null {
  const previousStageIds = new Set(previous.stages.map((stage) => stage.id));
  const previousTaskIds = new Set(allTasks(previous.stages).map((task) => task.id));
  const newStages = next.stages.filter((stage) => !previousStageIds.has(stage.id));
  const newTasks = allTasks(next.stages).filter((task) => !previousTaskIds.has(task.id));
  const problems: string[] = [];
  if (newStages.length > 1) {
    problems.push(
      `this patch adds ${newStages.length} new Stages; add at most one new Stage per planning turn`,
    );
  }
  if (newTasks.length > 1) {
    problems.push(
      `this patch adds ${newTasks.length} new Tasks; add at most one new Task per planning turn`,
    );
  }
  const newStage = newStages[0];
  if (newStage !== undefined) {
    const pending = allTasks(next.stages.filter((stage) => previousStageIds.has(stage.id))).find(
      (task) => next.taskStatus.get(task.id) === "pending",
    );
    if (pending !== undefined) {
      problems.push(
        `stage #${newStage.id} cannot start while task #${pending.id} is still pending; a new Stage is allowed only when the current Stage has no pending Task`,
      );
    }
    if (newTasks.length === 1) {
      const task = newTasks[0];
      if (task !== undefined && !newStage.tasks.some((candidate) => candidate.id === task.id)) {
        problems.push(
          `a new Stage must include its first Task in the same patch; task #${task.id} is not in stage #${newStage.id}`,
        );
      }
    } else {
      problems.push(
        `a new Stage must include its first Task in the same patch; stage #${newStage.id} arrived without one`,
      );
    }
  }
  return problems.length === 0
    ? null
    : `stage: task-tree\n${problems.map((problem) => `- ${problem}`).join("\n")}`;
}

/** Why no Task is runnable, with the next unit the planner should patch. */
function blockedReason(state: TaskRunState): string {
  const pending = allTasks(state.stages).find(
    (task) => state.taskStatus.get(task.id) === "pending",
  );
  if (pending !== undefined) {
    return `Task #${pending.id} is pending but has no runnable edit; repair it in place or add a repair edit.`;
  }
  const last = finalTask(state.stages);
  const finalId = state.finalTaskId;
  if (finalId === null) {
    if (
      last !== undefined &&
      last.verify === "test" &&
      state.taskStatus.get(last.id) === "passed"
    ) {
      return `Every Task is terminal and the last Task #${last.id} is a passing test Task, but no final Task is marked. Emit "patch" + "finish" to mark it final, plan one next Task, or plan one new Stage with its first Task.`;
    }
    return `Every Task is terminal but no final test Task is marked. Repair the last test Task in place and emit "finish", or plan one final test Task (or a new Stage with its first Task) and emit "finish".`;
  }
  if (last === undefined || last.id !== finalId) {
    return `The final task #${finalId} is no longer the last Task; append a final test Task and emit "finish" so finalTaskId moves.`;
  }
  if (state.taskStatus.get(finalId) !== "passed") {
    return `The final task #${finalId} has not passed. Repair it in place and keep it last (finalTaskId unchanged), or append a new final test Task/Stage and emit "finish".`;
  }
  return `The final task #${finalId} passed, but the run still has open work; repair it before finishing.`;
}

/** Render the Plan tree for the execution system's first turn. */
function planWire(state: TaskRunState): string {
  return serializePlanDsl(state.plan);
}

function firstEditOfState(state: TaskRunState | null): EditNode | undefined {
  return state === null ? undefined : allTasks(state.stages).flatMap((task) => task.edits)[0];
}

/**
 * Run the plan/execute/review loop. `runLoop` dispatches here only when
 * `agentMode === "plan-exec"`.
 */
export async function runTaskLoop(options: LoopOptions): Promise<LoopResult> {
  const cwd = options.cwd;
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const tokenBudgetBasis = options.tokenBudgetBasis ?? "raw";
  const workspace = workspaceOf(cwd);
  const specFiles = selectSpecFiles(options.issue, workspace.files);
  const indexText = buildContextYaml(workspace.files, {
    index: workspace.index,
    skipped: workspace.skipped ?? [],
  });

  const planningMessages: ChatMessage[] = [
    { role: "system", content: buildTaskPlanningSystemPrompt() },
    { role: "user", content: buildTaskPlanningUserPrompt(options.issue, indexText, specFiles) },
  ];
  const planningState: ChatState = { messages: planningMessages };
  const usageState: UsageState = { usage: zeroLoopUsage(), consumed: 0 };
  const records: LoopRecord[] = [];
  /** Recovered parser warnings, surfaced on the final result (#33). */
  const runWarnings: string[] = [];
  const noteWarnings = (result: DslParseResult<unknown>): void => {
    for (const issue of result.issues) {
      if (issue.severity === "warning") {
        runWarnings.push(`${issue.code}: ${issue.message}`);
      }
    }
  };
  const editFailures = new Map<NodeId, string>();
  const taskFailures = new Map<NodeId, string>();
  /** Advisory tsc output from a large edit, consumed by the next edit turn. */
  const editAdvisories = new Map<NodeId, string>();
  /** Tasks already reopened by a review patch; they get no second review. */
  const reviewPatched = new Set<NodeId>();
  let iteration = 0;
  let current: TaskRunState | null = null;

  const terminated = async (
    reason: TerminationReason | "provider-error",
    diagnostics: string | null,
  ): Promise<LoopResult> => {
    const explanation = await explain(
      options.provider,
      planningMessages,
      options.temperature,
      reason,
      diagnostics,
    );
    const anchor = firstEditOfState(current);
    return {
      ok: false,
      mode: current === null ? undefined : "modify",
      locator: anchor === undefined ? null : locatorOf(anchor),
      filePath: anchor?.loc.path ?? null,
      editedSource: null,
      records,
      diagnostics,
      explanation,
      messages: planningMessages,
      skipped: workspace.skipped,
      ...(reason === "provider-error" ? {} : { terminationReason: reason }),
      ...(runWarnings.length === 0 ? {} : { warnings: [...runWarnings] }),
      tokens: totalLoopTokens(usageState.usage),
      usage: cloneLoopUsage(usageState.usage),
      tasks: current === null ? [] : summaryOf(current),
    };
  };

  const success = (state: TaskRunState): LoopResult => {
    const anchor = firstEditOfState(state);
    return {
      ok: true,
      mode: "modify",
      locator: anchor === undefined ? null : locatorOf(anchor),
      filePath: anchor?.loc.path ?? null,
      editedSource: null,
      records,
      diagnostics: null,
      explanation: null,
      messages: planningMessages,
      skipped: workspace.skipped,
      ...(runWarnings.length === 0 ? {} : { warnings: [...runWarnings] }),
      tokens: totalLoopTokens(usageState.usage),
      usage: cloneLoopUsage(usageState.usage),
      tasks: summaryOf(state),
    };
  };

  const providerCall = async (): Promise<ChatResponse | LoopResult> => {
    let response: ChatResponse;
    try {
      response = await callModel(
        planningMessages,
        usageState.usage.planning,
        usageState,
        options.provider,
        options,
      );
    } catch (error) {
      return terminated("provider-error", providerErrorDiagnostics(error));
    }
    if (overBudget(usageState, tokenBudget)) {
      return terminated(
        "token-budget",
        tokenBudgetDiagnostics(usageState.consumed, tokenBudget, tokenBudgetBasis),
      );
    }
    return response;
  };

  const plannerViewerDeps: MultiEditorDeps = {
    sourceFor: (path) => readTarget(cwd, path),
    fileExists: (path) => readFileIfExists(join(cwd, path)) !== null,
    isSafePath: (path) => safeMutablePath(cwd, path) !== null,
    resolveEntry: (source, path, locator, space) =>
      resolveCurrentEntry(source, path, locator, space),
  };

  /**
   * Resolve one planner viewer statement with the edit-protocol resolver and
   * return a source block, not a Plan/patch. The planner uses the same
   * `select`/`read` language as the executor; it just cannot write.
   */
  const plannerViewFeedback = (content: string, next: string): string => {
    const parsed = parseMultiEditorDetailed(content);
    if (!parsed.ok || parsed.value === undefined) {
      return [
        "# Source view",
        "",
        "The viewer request was rejected.",
        "",
        renderDslIssues(parsed.issues),
        "",
        "# Next",
        "",
        next,
      ].join("\n");
    }
    const problem = plannerViewerProblem(parsed.value);
    if (problem !== null) {
      return ["# Source view", "", problem, "", "# Next", "", next].join("\n");
    }
    const resolved = resolveMultiEditor(parsed.value, plannerViewerDeps);
    const blocks: string[] = [];
    if (resolved.viewers.length > 0) {
      blocks.push(renderViewerFeedback(resolved.viewers, { footer: null }));
    }
    if (resolved.reads.length > 0) {
      blocks.push(renderReadFeedback(resolved.reads));
    }
    if (resolved.readFailures.length > 0) {
      blocks.push(renderReadFailureFeedback(resolved.readFailures));
    }
    if (resolved.failures.length > 0) {
      blocks.push(
        [
          "View request failed:",
          ...resolved.failures.map(
            (failure) =>
              `- clause ${failure.index + 1}: ${failure.diagnostics.split("\n").join("\n  ")}`,
          ),
        ].join("\n"),
      );
    }
    if (blocks.length === 0) {
      blocks.push("The viewer resolved no source; inspect the symbol index and try again.");
    }
    return ["# Source view", "", ...blocks, "", "# Next", "", next].join("\n");
  };

  /**
   * One planning turn: ask, parse, retry a rejection with its diagnostics. An
   * initial plan becomes the run state; a patch turn applies exactly one patch,
   * enforces the one-unit rule, and returns the merged state.
   */
  const planningTurn = async (
    request: { mode: "initial" } | { mode: "patch"; state: TaskRunState },
  ): Promise<PlanningOutcome> => {
    let lastDiagnostics: string | null = null;
    let viewerUsed = false;
    for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt += 1) {
      const response = await providerCall();
      if ("ok" in response) {
        return { kind: "failed", result: response };
      }
      const content = response.content ?? "";
      planningMessages.push({ role: "assistant", content });
      if (isPlannerViewerReply(content)) {
        if (viewerUsed) {
          planningMessages.push({
            role: "user",
            content:
              "# Source view\n\nOnly one viewer request is allowed per planning turn. Reply with the Plan/patch now.",
          });
          continue;
        }
        viewerUsed = true;
        planningMessages.push({
          role: "user",
          content: plannerViewFeedback(
            content,
            "Reply with the initial Plan or the next patch. The viewer request writes nothing.",
          ),
        });
        attempt -= 1;
        continue;
      }
      if (request.mode === "initial") {
        const parsed = parsePlanDslDetailed(content);
        noteWarnings(parsed);
        if (parsed.ok && parsed.value !== undefined) {
          const problems = initialPlanProblems(parsed.value.plan);
          if (problems === null) {
            return {
              kind: "planned",
              state: initialState(parsed.value.plan, parsed.value.finalTaskId),
            };
          }
          lastDiagnostics = problems;
        } else {
          lastDiagnostics = renderDslIssues(parsed.issues);
        }
      } else {
        const parsed = parsePlanPatchDetailed(content);
        noteWarnings(parsed);
        if (!parsed.ok || parsed.value === undefined) {
          lastDiagnostics = renderDslIssues(parsed.issues);
        } else {
          const merged = applyPlanPatch(request.state, parsed.value);
          if (!merged.ok) {
            lastDiagnostics = merged.diagnostics;
          } else {
            const problems = oneUnitProblems(request.state, merged.state);
            if (problems === null) {
              return { kind: "planned", state: merged.state };
            }
            lastDiagnostics = problems;
          }
        }
      }
      planningMessages.push({
        role: "user",
        content:
          request.mode === "initial"
            ? buildTaskPlanRetryPrompt(lastDiagnostics ?? "the plan was rejected")
            : buildTaskPatchRetryPrompt(lastDiagnostics ?? "the patch was rejected"),
      });
    }
    return {
      kind: "failed",
      result: await terminated(
        "task-exhausted",
        `task-exhausted: the planner produced no valid ${request.mode === "initial" ? "plan" : "patch"} after ${MAX_PLAN_ATTEMPTS} attempts\n\n${lastDiagnostics ?? ""}`,
      ),
    };
  };

  const first = await planningTurn({ mode: "initial" });
  if (first.kind === "failed") {
    return first.result;
  }
  current = first.state;
  let previousFingerprint = fingerprintState(current);
  let planningRounds = 1;

  /**
   * Ask for exactly one patch after the current work settles. The turn cap
   * counts planning replies, including the initial Plan; a patch that leaves
   * the Plan and finish marker unchanged is no progress.
   */
  const requestPatch = async (
    gateDiagnostics: string | undefined,
    blocked: string | undefined,
  ): Promise<TaskRunState | LoopResult> => {
    const state = current;
    if (state === null) {
      return terminated("task-exhausted", "task-exhausted: there is no current Plan to patch");
    }
    if (planningRounds >= MAX_TASK_PLAN_ROUNDS) {
      return terminated(
        "task-exhausted",
        `task-exhausted: ${planningRounds} planning turns without a passing run (cap ${MAX_TASK_PLAN_ROUNDS})\n\n${blocked ?? ""}`,
      );
    }
    const failedEditIds = state.stages
      .flatMap((stage) => stage.tasks)
      .flatMap((task) => task.edits)
      .filter((edit) => state.editStatus.get(edit.id) === "failed")
      .map((edit) => edit.id);
    const failedTaskIds = allTasks(state.stages)
      .filter((task) => state.taskStatus.get(task.id) === "failed")
      .map((task) => task.id);
    const currentFiles = discoverSourceFiles(cwd);
    planningMessages.push({
      role: "user",
      content: buildTaskReplanPrompt({
        state,
        editFailures,
        taskFailures,
        gateDiagnostics,
        blocked,
        symbolIndex: buildContextYaml(currentFiles),
        delta: replanDelta({
          failedEditIds,
          failedTaskIds,
          blocked: blocked !== undefined,
        }),
      }),
    });
    const planned = await planningTurn({ mode: "patch", state });
    if (planned.kind === "failed") {
      return planned.result;
    }
    const next = planned.state;
    const fingerprint = fingerprintState(next);
    if (fingerprint === previousFingerprint) {
      return terminated(
        "task-exhausted",
        "task-exhausted: the planner patch left the Plan and finalTaskId unchanged; no progress is possible",
      );
    }
    previousFingerprint = fingerprint;
    planningRounds += 1;
    current = next;
    return next;
  };

  /**
   * One post-execution review in the same planner conversation. It sees the
   * gate verdict and the concise diff, then either approves or returns one
   * repair patch for the current Task. A syntactically malformed reply gets
   * one bounded format retry; a scope or merge violation still terminates. A
   * patch that reopens the Task gets no second review.
   */
  const reviewTurn = async (
    state: TaskRunState,
    stage: Stage,
    task: TaskNode,
    gate: { ok: boolean; diagnostics: string | null },
    bases: ReadonlyMap<string, string>,
  ): Promise<ReviewOutcome> => {
    const rejected = async (diagnostics: string): Promise<ReviewOutcome> => ({
      kind: "failed",
      result: await terminated(
        "task-exhausted",
        `task-exhausted: the review turn produced neither approve nor one valid repair patch\n\n${diagnostics}`,
      ),
    });
    planningMessages.push({
      role: "user",
      content: buildTaskReviewPrompt({
        stage,
        task,
        gate: { verify: task.verify, ok: gate.ok, diagnostics: gate.diagnostics },
        diff: appliedDiff(cwd, bases),
      }),
    });
    let viewerUsed = false;
    let immutableRetryUsed = false;
    const retryImmutablePatch = (diagnostics: string | null): boolean => {
      if (immutableRetryUsed || !immutableReviewError(diagnostics)) {
        return false;
      }
      immutableRetryUsed = true;
      planningMessages.push({
        role: "user",
        content: buildTaskReviewDoneEditRetryPrompt(diagnostics ?? "a done edit is immutable"),
      });
      return true;
    };
    for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt += 1) {
      let response: ChatResponse;
      try {
        response = await callModel(
          planningMessages,
          usageState.usage.review,
          usageState,
          options.provider,
          options,
        );
      } catch (error) {
        return {
          kind: "failed",
          result: await terminated("provider-error", providerErrorDiagnostics(error)),
        };
      }
      if (overBudget(usageState, tokenBudget)) {
        return {
          kind: "failed",
          result: await terminated(
            "token-budget",
            tokenBudgetDiagnostics(usageState.consumed, tokenBudget, tokenBudgetBasis),
          ),
        };
      }
      const content = response.content ?? "";
      planningMessages.push({ role: "assistant", content });
      if (isPlannerViewerReply(content)) {
        if (viewerUsed) {
          planningMessages.push({
            role: "user",
            content:
              "# Source view\n\nOnly one viewer request is allowed per review turn. Reply with `approve` or one repair patch.",
          });
          continue;
        }
        viewerUsed = true;
        planningMessages.push({
          role: "user",
          content: plannerViewFeedback(
            content,
            "Reply with `approve` or one repair patch. The viewer request writes nothing.",
          ),
        });
        attempt -= 1;
        continue;
      }
      if (content.trim().toLowerCase() === "approve") {
        return { kind: "approve" };
      }
      const parsed = parsePlanPatchDetailed(content);
      noteWarnings(parsed);
      if (!parsed.ok || parsed.value === undefined) {
        const diagnostics = renderDslIssues(parsed.issues);
        if (attempt < MAX_REVIEW_ATTEMPTS) {
          planningMessages.push({
            role: "user",
            content: buildTaskReviewRetryPrompt(diagnostics),
          });
          continue;
        }
        return rejected(diagnostics);
      }
      const scope = reviewPatchProblems(state, task, parsed.value);
      if (scope !== null) {
        if (retryImmutablePatch(scope)) {
          attempt -= 1;
          continue;
        }
        return rejected(scope);
      }
      const merged = applyPlanPatch(state, parsed.value);
      if (!merged.ok) {
        if (retryImmutablePatch(merged.diagnostics)) {
          attempt -= 1;
          continue;
        }
        return rejected(merged.diagnostics);
      }
      const after = reviewMergeProblems(state, merged.state, task);
      if (after !== null) {
        if (retryImmutablePatch(after)) {
          attempt -= 1;
          continue;
        }
        return rejected(after);
      }
      if (fingerprintState(merged.state) === fingerprintState(state)) {
        return rejected(
          "the patch left the Plan and finalTaskId unchanged; a review patch must repair the current task or carry finish",
        );
      }
      return { kind: "patched", state: merged.state };
    }
    return rejected("the review turn produced no usable reply");
  };

  // Each Plan tree gets a fresh execution conversation: stable system prompt +
  // tree, then one edit turn at a time (stage/task/edit context stays volatile).
  let execution: ChatState | null = null;
  let executionState: TaskRunState | null = null;
  let executionBase: ChatMessage[] = [];

  const executionChat = (state: TaskRunState): ChatState => {
    if (execution !== null && executionState === state) {
      return execution;
    }
    const messages: ChatMessage[] = [
      { role: "system", content: buildTaskExecutionSystemPrompt() },
      {
        role: "user",
        content: `# Plan tree\n\n${planWire(state)}\n\nYou receive one micro edit at a time. Reply with its edit clauses only.`,
      },
    ];
    const chat: ChatState = { messages };
    execution = chat;
    executionState = state;
    executionBase = messages;
    return chat;
  };

  /** Sources when a task became active, for mapping gate diagnostics. */
  const taskBases = new Map<NodeId, Map<string, string>>();
  const baseSourcesFor = (state: TaskRunState, task: TaskNode): Map<string, string> => {
    const existing = taskBases.get(task.id);
    if (existing !== undefined) {
      return existing;
    }
    const bases = new Map<string, string>();
    for (const edit of task.edits) {
      if (!bases.has(edit.loc.path)) {
        bases.set(edit.loc.path, readTarget(cwd, edit.loc.path));
      }
    }
    taskBases.set(task.id, bases);
    return bases;
  };

  const priorGateDiagnostics = (
    state: TaskRunState,
    stage: Stage,
    task: TaskNode,
  ): string | undefined => {
    const index = stage.tasks.findIndex((candidate) => candidate.id === task.id);
    for (let position = index - 1; position >= 0; position -= 1) {
      const earlier = stage.tasks[position];
      if (earlier === undefined) {
        continue;
      }
      if (state.taskStatus.get(earlier.id) === "failed" && taskFailures.has(earlier.id)) {
        return `Task #${earlier.id} gate failed: ${taskFailures.get(earlier.id) ?? ""}`;
      }
    }
    return undefined;
  };

  for (;;) {
    const state = current as TaskRunState;
    if (runComplete(state)) {
      return success(state);
    }
    const stage = activeStage(state);
    const task = stage === undefined ? undefined : activeTask(state);
    if (stage === undefined || task === undefined) {
      const patched = await requestPatch(undefined, blockedReason(state));
      if ("ok" in patched) {
        return patched;
      }
      continue;
    }
    const anchor = firstEdit(task);
    const bases = baseSourcesFor(state, task);

    if (taskEditsSettled(state, task)) {
      if (!taskHasDoneEdit(state, task)) {
        const patched = await requestPatch(
          undefined,
          `Task #${task.id} has no landed edit; add a repair edit rather than re-running the gate on an unchanged file.`,
        );
        if ("ok" in patched) {
          return patched;
        }
        continue;
      }
      iteration += 1;
      const context: ExecutionContext = {
        cwd,
        workspace,
        options,
        records,
        warnings: runWarnings,
        runState: state,
        iteration,
      };
      const gate = await verifyTask(
        context,
        task,
        bases.get(anchor.loc.path) ?? readTarget(cwd, anchor.loc.path),
      );
      // The gate verdict is final only after the planner's one review turn.
      state.taskStatus.set(task.id, "review");
      if (!reviewPatched.has(task.id)) {
        const reviewed = await reviewTurn(state, stage, task, gate, bases);
        if (reviewed.kind === "failed") {
          return reviewed.result;
        }
        if (reviewed.kind === "patched") {
          // The Task reopens and runs again; its re-execution is not reviewed.
          reviewPatched.add(task.id);
          taskFailures.delete(task.id);
          taskBases.delete(task.id);
          current = reviewed.state;
          previousFingerprint = fingerprintState(reviewed.state);
          continue;
        }
      }
      if (gate.ok) {
        state.taskStatus.set(task.id, "passed");
        taskFailures.delete(task.id);
        taskBases.delete(task.id);
        continue;
      }
      state.taskStatus.set(task.id, "failed");
      taskFailures.set(task.id, gate.diagnostics ?? "stage: task-gate\nthe task gate failed");
      taskBases.delete(task.id);
      // Let later planned tasks in the same stage run first; they may repair
      // the gate failure without paying for a planning round.
      if (hasLaterPendingTaskInStage(state, task)) {
        continue;
      }
      const patched = await requestPatch(gate.diagnostics ?? undefined, undefined);
      if ("ok" in patched) {
        return patched;
      }
      continue;
    }

    const edit = nextEdit(state, task);
    if (edit === undefined) {
      const patched = await requestPatch(
        undefined,
        `Task #${task.id} has no runnable edit; repair it in place so its remaining work is runnable.`,
      );
      if ("ok" in patched) {
        return patched;
      }
      continue;
    }

    const chat = executionChat(state);
    iteration += 1;
    state.editStatus.set(edit.id, "in-progress");
    // Every edit starts from the stable system + Plan prefix; turns from the
    // previous edit must not leak into this one.
    chat.messages = [...executionBase];
    const context: ExecutionContext = {
      cwd,
      workspace,
      options,
      records,
      warnings: runWarnings,
      runState: state,
      iteration,
    };
    const postEditDiagnostics = editAdvisories.get(task.id);
    editAdvisories.delete(task.id);
    const outcome = await executeEdit(
      context,
      chat,
      usageState,
      stage,
      task,
      edit,
      priorGateDiagnostics(state, stage, task),
      postEditDiagnostics,
    );
    if (overBudget(usageState, tokenBudget)) {
      return terminated(
        "token-budget",
        tokenBudgetDiagnostics(usageState.consumed, tokenBudget, tokenBudgetBasis),
      );
    }
    if (!outcome.ok) {
      state.editStatus.set(edit.id, "failed");
      state.taskStatus.set(task.id, "failed");
      editFailures.set(edit.id, outcome.diagnostics ?? "the edit failed");
      taskBases.delete(task.id);
      const patched = await requestPatch(undefined, undefined);
      if ("ok" in patched) {
        return patched;
      }
      continue;
    }
    state.editStatus.set(edit.id, "done");
    editFailures.delete(edit.id);
    if (outcome.advisoryDiagnostics !== null && outcome.advisoryDiagnostics !== undefined) {
      editAdvisories.set(task.id, outcome.advisoryDiagnostics);
    }
  }
}

export { MAX_TASK_EXCHANGES, MAX_TASK_PLAN_ROUNDS };
