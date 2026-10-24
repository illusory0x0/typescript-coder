/**
 * The plan/execute driver (`docs/spec.md`): a planner turns the requirement
 * into a Plan -> Stage -> Task -> edit tree, and an executor carries out one
 * edit at a time with edit-dsl clauses. The harness owns status, scheduling,
 * and verification.
 *
 * This module orchestrates. It reuses the edit-dsl machinery rather than
 * re-implementing it: `parseMultiEditor`/`resolveMultiEditor` for the reply,
 * `applyResolvedRegions` for the gates and the write, and `formatDiagnostics`
 * for the type-check feedback. `src/tasks.ts` owns the contract, and
 * `src/prompts/task.ts` owns the prompt text.
 */
import { join } from "node:path";
import { buildIndexTolerant, Binder, declarationSpaces } from "./utility";
import type { IndexEntry, Locator, SourceFile, SymbolIndex } from "./utility";
import { Parser } from "./parser";
import type { Node, Program } from "./parser";
import { stripCodeFences } from "./matcher";
import { parseMultiEditor, SelectionSyntaxError } from "./selection";
import type { EditStatement, Selection as EditDslSelection } from "./selection";
import { renderReadFailureFeedback, renderReadFeedback, resolveMultiEditor } from "./multi-editor";
import { stripLeadingExport } from "./loop";
import type { MultiEditorDeps, MultiEditorResolution } from "./multi-editor";
import { renderViewerFeedback } from "./edit-dsl";
import type { EditDslRegion } from "./edit-dsl";
import { applyResolvedRegions, parseCheck, prevBrokenDiagnostics } from "./commit";
import { checkTool, testTool } from "./tools";
import { buildContextYaml } from "./loop";
import {
  DEFAULT_TOKEN_BUDGET,
  MAX_CONSECUTIVE_LENGTH,
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
  tokensFromResponse,
  withEffort,
  writeTarget,
  zeroLoopTokens,
} from "./loop";
import type {
  ExchangeOutcome,
  LoopOptions,
  LoopRecord,
  LoopResult,
  LoopTokens,
  ProviderLike,
  TerminationReason,
} from "./loop";
import type { ChatMessage, ChatResponse } from "./openai";
import {
  buildTaskExecutionSystemPrompt,
  buildTaskPlanRetryPrompt,
  buildTaskPlanningSystemPrompt,
  buildTaskPlanningUserPrompt,
  buildTaskReplanPrompt,
  buildTaskTurnPrompt,
  MAX_TASK_EXCHANGES,
  MAX_TASK_PLAN_ROUNDS,
  renderTaskContentView,
  replanDelta,
} from "./prompts/task";
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
  mergeReplan,
  nextEdit,
  parsePlan,
  readPlan,
  runComplete,
  summaryOf,
  taskEditsSettled,
  taskHasDoneEdit,
} from "./tasks";
import type { EditNode, NodeId, Stage, TaskNode, Plan, TaskRunState } from "./tasks";

/**
 * A planning turn's result, tagged so the caller never has to guess whether a
 * value is a run state or a terminated result.
 */
type PlanningOutcome =
  | { kind: "initial"; plan: Plan }
  | { kind: "replan"; state: TaskRunState }
  | { kind: "failed"; result: LoopResult };
/** Model attempts per planning turn (a rejected reply is retried with its diagnostics). */
const MAX_PLAN_ATTEMPTS = 3;

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

/** The token tally shared by the planning and execution conversations. */
interface ChatState {
  messages: ChatMessage[];
  tokens: LoopTokens;
  consumed: number;
}

function addTokens(state: ChatState, delta: LoopTokens): void {
  state.tokens.input += delta.input;
  state.tokens.output += delta.output;
  state.tokens.total += delta.total;
  state.tokens.cacheRead += delta.cacheRead;
}

async function callModel(
  state: ChatState,
  provider: ProviderLike,
  options: LoopOptions,
): Promise<ChatResponse> {
  const chatOptions =
    options.temperature === undefined ? undefined : { temperature: options.temperature };
  const response = await provider.chat(
    state.messages,
    undefined,
    withEffort(chatOptions, options.effortOverride ?? "none"),
  );
  state.consumed += tokensFromResponse(response);
  addTokens(state, loopTokensFromResponse(response));
  return response;
}

function overBudget(state: ChatState, budget: number): boolean {
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
 * The index address of a task. `kind` is the empty wildcard because the task's
 * `loc.kind` is a *symbol space*, which `resolveCurrentEntry`/`lookup` filter
 * separately; a declaration keyword here would exclude every entry.
 */
function locatorOf(task: EditNode): Locator {
  return { path: task.loc.path, name: task.loc.symbol, kind: "" };
}

function readTarget(cwd: string, path: string): string {
  return readFileIfExists(join(cwd, path)) ?? "";
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
  if (readFileIfExists(join(cwd, task.loc.path)) !== null) {
    const parsed = parseCheck(source);
    if (!parsed.ok) {
      return { ok: false, diagnostics: prevBrokenDiagnostics(task.loc.path, parsed.failure) };
    }
  }
  const visible = workspaceIndex(workspace);
  const entry = visible.lookup(locatorOf(task), task.loc.kind);
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
  const existing = resolveCurrentEntry(source, task.loc.path, locatorOf(task), task.loc.kind);
  if (!existing.ok) {
    return { ok: false, diagnostics: `${existing.diagnostics}\n${editLabel(task)}` };
  }
  const related: IndexEntry[] = [];
  for (const loc of task.related ?? []) {
    const resolved = resolveCurrentEntry(source, loc.path, locatorOfLoc(loc), loc.kind);
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
  return `stage: address\n${editLabel(task)}: the reply must edit only that declared target${related}; re-address the task's own symbols`;
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
    return `stage: address\na create fence must contain exactly one top-level declaration (the task target); it carried ${program.body.length}. Put helper declarations in their own create edits.`;
  }
  const binder = new Binder(program);
  const symbols = binder.rootScope.resolveLocal(task.loc.symbol);
  const declarations = new Set(symbols.flatMap((symbol) => symbol.declarations));
  if (declarations.size === 0) {
    return `stage: address\nthe create fence declares no top-level ${JSON.stringify(task.loc.symbol)}; declare exactly that name, or send only its body to wrap it as ${task.loc.kind}`;
  }
  if (declarations.size > 1) {
    return `stage: address\nthe create fence declares ${declarations.size} top-level declarations named ${JSON.stringify(task.loc.symbol)}; a create fence must contain exactly one`;
  }
  const node: Node | undefined = declarations.values().next().value;
  const symbol = symbols[0];
  if (node === undefined || symbol === undefined) {
    return null;
  }
  const spaces = declarationSpaces({ locator: locatorOf(task), node, symbol });
  if (!spaces.includes(task.loc.kind)) {
    return `stage: address\nthe created ${JSON.stringify(task.loc.symbol)} occupies the ${spaces.join(", ")} space, but the task asks for ${task.loc.kind}`;
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
}

interface ExecutionContext {
  cwd: string;
  workspace: Workspace;
  options: LoopOptions;
  records: LoopRecord[];
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

/**
 * Parse one execution reply and, if it carries editors, apply them atomically.
 * A read-only reply (viewers, `read`) writes nothing and its feedback becomes
 * the next turn's diagnostics. File commands that write are rejected: the plan
 * names declarations, not whole files.
 */
async function applyEditReply(
  context: ExecutionContext,
  task: EditNode,
  content: string,
): Promise<ReplyOutcome> {
  let statements;
  try {
    statements = parseMultiEditor(stripCodeFences(content));
  } catch (error) {
    if (error instanceof SelectionSyntaxError) {
      return { ok: false, diagnostics: error.diagnostics, viewerOnly: false, appliedLocators: [] };
    }
    throw error;
  }
  if (statements.length === 0) {
    return {
      ok: false,
      diagnostics:
        "stage: protocol\nthe reply carried no edit statement; reply with the edit clauses for this task",
      viewerOnly: false,
      appliedLocators: [],
    };
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
            ? `stage: address\n${editLabel(task)}: the clause resolves ${JSON.stringify(
                selection.space,
              )} but the task target is ${JSON.stringify(sameName[0]?.kind)}; use the matching symbol space or omit resolve`
            : `stage: address\n${editLabel(task)}: the clause resolves an address that is neither the target nor one of its related declarations`,
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
      withExportModifier({ ...selection, space: loc.kind }, sourceBefore, entry),
    );
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
  };
}

/** The declaration (or whole file for create) and its 1-based start line. */
function declarationView(cwd: string, task: EditNode): { view: string; startLine: number } {
  const source = readTarget(cwd, task.loc.path);
  if (task.related !== undefined && task.related.length > 0) {
    // A migration task needs the whole file because related declarations can be
    // far apart; the numbered view keeps their file-absolute line numbers.
    const lines = source.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return { view: lines.join("\n"), startLine: 1 };
  }
  const entry = resolveCurrentEntry(source, task.loc.path, locatorOf(task), task.loc.kind);
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
  stage: Stage,
  task: TaskNode,
  edit: EditNode,
  priorGateDiagnostics: string | undefined,
): Promise<EditExecution> {
  let diagnostics: string | undefined;
  let consecutiveLength = 0;
  let selfCheckUsed = false;
  let formatHelp = false;

  for (let exchange = 1; exchange <= MAX_TASK_EXCHANGES; exchange += 1) {
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
      context: contextText,
    });
    const last = chat.messages[chat.messages.length - 1];
    if (last?.role === "user" && (last.content ?? "").startsWith("# Stage")) {
      chat.messages[chat.messages.length - 1] = { role: "user", content: prompt };
    } else {
      chat.messages.push({ role: "user", content: prompt });
    }
    let response: ChatResponse;
    try {
      response = await callModel(chat, context.options.provider, context.options);
    } catch (error) {
      return { ok: false, diagnostics: providerErrorDiagnostics(error), messages: chat.messages };
    }
    const budget = context.options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    if (overBudget(chat, budget)) {
      return {
        ok: false,
        diagnostics: tokenBudgetDiagnostics(chat.consumed, budget),
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
      continue;
    }
    if (request.kind === "ok") {
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
      continue;
    }
    formatHelp = false;
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
    return { ok: true, diagnostics: null, messages: chat.messages };
  }
  return {
    ok: false,
    diagnostics: `stage: edit-failed\n${editLabel(edit)} did not land an edit within ${MAX_TASK_EXCHANGES} exchanges\n\n${diagnostics ?? "the edit ran out of exchanges without a write"}`,
    messages: chat.messages,
  };
}

// ---------------------------------------------------------------------------
// The driver

function fingerprintPlan(stages: readonly Stage[]): string {
  return JSON.stringify(stages);
}

/** Render the Plan tree for the execution system's first turn. */
function planWire(state: TaskRunState): string {
  return JSON.stringify({ stages: state.stages }, null, 2);
}

function firstEditOfState(state: TaskRunState | null): EditNode | undefined {
  return state === null ? undefined : allTasks(state.stages).flatMap((task) => task.edits)[0];
}

/**
 * Run the plan/execute loop. `runLoop` dispatches here only when
 * `agentMode === "plan-exec"`.
 */
export async function runTaskLoop(options: LoopOptions): Promise<LoopResult> {
  const cwd = options.cwd;
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
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
  const planningState: ChatState = {
    messages: planningMessages,
    tokens: zeroLoopTokens(),
    consumed: 0,
  };
  const records: LoopRecord[] = [];
  const editFailures = new Map<NodeId, string>();
  const taskFailures = new Map<NodeId, string>();
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
      tokens: planningState.tokens,
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
      tokens: planningState.tokens,
      tasks: summaryOf(state),
    };
  };

  const providerCall = async (): Promise<ChatResponse | LoopResult> => {
    let response: ChatResponse;
    try {
      response = await callModel(planningState, options.provider, options);
    } catch (error) {
      return terminated("provider-error", providerErrorDiagnostics(error));
    }
    if (overBudget(planningState, tokenBudget)) {
      return terminated(
        "token-budget",
        tokenBudgetDiagnostics(planningState.consumed, tokenBudget),
      );
    }
    return response;
  };

  /**
   * One planning turn: ask, parse, retry a rejection with its diagnostics. An
   * initial plan returns the parsed Plan; a re-plan returns the merged state.
   */
  const planningTurn = async (replan: boolean): Promise<PlanningOutcome> => {
    let lastDiagnostics: string | null = null;
    for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt += 1) {
      const response = await providerCall();
      if ("ok" in response) {
        return { kind: "failed", result: response };
      }
      const content = response.content ?? "";
      planningMessages.push({ role: "assistant", content });
      if (!replan) {
        const parsed = parsePlan(content);
        if (parsed.ok) {
          return { kind: "initial", plan: parsed.plan };
        }
        lastDiagnostics = parsed.diagnostics;
      } else {
        const read = readPlan(content);
        if (!read.ok) {
          lastDiagnostics = read.diagnostics;
        } else {
          const merged = mergeReplan(current as TaskRunState, read.plan);
          if (merged.ok) {
            return { kind: "replan", state: merged.state };
          }
          lastDiagnostics = merged.diagnostics;
        }
      }
      planningMessages.push({
        role: "user",
        content: buildTaskPlanRetryPrompt(lastDiagnostics ?? "the plan was rejected"),
      });
    }
    return {
      kind: "failed",
      result: await terminated(
        "task-exhausted",
        `task-exhausted: the planner produced no valid plan after ${MAX_PLAN_ATTEMPTS} attempts\n\n${lastDiagnostics ?? ""}`,
      ),
    };
  };

  const first = await planningTurn(false);
  if (first.kind === "failed") {
    return first.result;
  }
  if (first.kind !== "initial") {
    return terminated("task-exhausted", "task-exhausted: the first planning turn produced no plan");
  }
  current = initialState(first.plan);
  let previousFingerprint = fingerprintPlan(current.stages);
  let planningRounds = 1;

  const replan = async (
    gateDiagnostics: string | undefined,
    blocked: string | undefined,
  ): Promise<TaskRunState | LoopResult> => {
    const state = current as TaskRunState;
    if (planningRounds >= MAX_TASK_PLAN_ROUNDS) {
      return terminated(
        "task-exhausted",
        `task-exhausted: ${planningRounds} plan trees without a passing run\n\n${blocked ?? ""}`,
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
    const merged = await planningTurn(true);
    if (merged.kind === "failed") {
      return merged.result;
    }
    if (merged.kind !== "replan") {
      return terminated(
        "task-exhausted",
        "task-exhausted: a re-planning turn produced no merged tree",
      );
    }
    const next = merged.state;
    const fingerprint = fingerprintPlan(next.stages);
    if (fingerprint === previousFingerprint) {
      return terminated(
        "task-exhausted",
        "task-exhausted: the planner returned the same tree after a failure or a failing suite; no progress is possible",
      );
    }
    previousFingerprint = fingerprint;
    planningRounds += 1;
    current = next;
    return next;
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
        content: `# Plan tree\n\n\`\`\`json\n${planWire(state)}\n\`\`\`\n\nYou receive one micro edit at a time. Reply with its edit clauses only.`,
      },
    ];
    const chat: ChatState = {
      messages,
      // The token tally is shared across mode contexts; only the message list
      // is per-conversation.
      tokens: { input: 0, output: 0, total: 0, cacheRead: 0 },
      consumed: 0,
    };
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
    if (stage === undefined) {
      const last = finalTask(state.stages);
      const merged = await replan(
        undefined,
        `All stages are closed but the final task ${last === undefined ? "is missing" : `#${last.id}`} has not passed; add a repair stage or task.`,
      );
      if ("ok" in merged) {
        return merged;
      }
      continue;
    }
    const task = activeTask(state);
    if (task === undefined) {
      const merged = await replan(
        undefined,
        `Stage #${stage.id} has no pending task; repair the tree so the remaining work is runnable.`,
      );
      if ("ok" in merged) {
        return merged;
      }
      continue;
    }
    const anchor = firstEdit(task);
    const bases = baseSourcesFor(state, task);

    if (taskEditsSettled(state, task)) {
      if (!taskHasDoneEdit(state, task)) {
        const merged = await replan(
          undefined,
          `Task #${task.id} has no landed edit; add a repair edit rather than re-running the gate on an unchanged file.`,
        );
        if ("ok" in merged) {
          return merged;
        }
        continue;
      }
      iteration += 1;
      const context: ExecutionContext = {
        cwd,
        workspace,
        options,
        records,
        runState: state,
        iteration,
      };
      const gate = await verifyTask(
        context,
        task,
        bases.get(anchor.loc.path) ?? readTarget(cwd, anchor.loc.path),
      );
      if (gate.ok) {
        state.taskStatus.set(task.id, "passed");
        taskFailures.delete(task.id);
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
      const merged = await replan(gate.diagnostics ?? undefined, undefined);
      if ("ok" in merged) {
        return merged;
      }
      continue;
    }

    const edit = nextEdit(state, task);
    if (edit === undefined) {
      const merged = await replan(
        undefined,
        `Task #${task.id} has no runnable edit; repair the tree so its remaining work is runnable.`,
      );
      if ("ok" in merged) {
        return merged;
      }
      continue;
    }

    const chat = executionChat(state);
    iteration += 1;
    state.editStatus.set(edit.id, "in-progress");
    // Every edit starts from the stable system + Plan prefix; turns from the
    // previous edit must not leak into this one.
    chat.messages = [...executionBase];
    // Carry the run-wide token tally into the per-Plan conversation.
    chat.tokens = { ...planningState.tokens };
    chat.consumed = planningState.consumed;
    const context: ExecutionContext = {
      cwd,
      workspace,
      options,
      records,
      runState: state,
      iteration,
    };
    const outcome = await executeEdit(
      context,
      chat,
      stage,
      task,
      edit,
      priorGateDiagnostics(state, stage, task),
    );
    planningState.tokens = chat.tokens;
    planningState.consumed = chat.consumed;
    if (overBudget(chat, tokenBudget)) {
      return terminated("token-budget", tokenBudgetDiagnostics(chat.consumed, tokenBudget));
    }
    if (!outcome.ok) {
      state.editStatus.set(edit.id, "failed");
      state.taskStatus.set(task.id, "failed");
      editFailures.set(edit.id, outcome.diagnostics ?? "the edit failed");
      taskBases.delete(task.id);
      const merged = await replan(undefined, undefined);
      if ("ok" in merged) {
        return merged;
      }
      continue;
    }
    state.editStatus.set(edit.id, "done");
    editFailures.delete(edit.id);
  }
}

export { MAX_TASK_EXCHANGES, MAX_TASK_PLAN_ROUNDS };
