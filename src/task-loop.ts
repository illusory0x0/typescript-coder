/**
 * The plan/execute driver (`docs/plan-exec.md`): a planner owns a task-level
 * WorkNode DAG, then executes ready nodes in record order. An executor carries
 * out one node at a time with edit-dsl clauses or file commands; the harness
 * owns scheduling, gates, review, and the final result.
 *
 * This module orchestrates. It reuses the edit-dsl machinery rather than
 * re-implementing it: `parseMultiEditorDetailed`/`resolveMultiEditor` for the
 * reply, `applyResolvedRegions` for the application gates, and
 * `formatDiagnostics` for the type-check feedback. `src/tasks.ts` owns the
 * contract, and `src/prompts/task.ts` owns the prompt text.
 *
 * There are no fixed exchange, viewer, review, or planning-round caps here.
 * The run is bounded by the token budget, repeated/no-progress fingerprints,
 * and the DSL safety validation.
 */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildIndexTolerant } from "./utility";
import type { IndexEntry, Locator, SourceFile, SymbolIndex, SymbolSpace } from "./utility";
import { Parser } from "./parser";
import type { Node, Program } from "./parser";
import { stripCodeFences } from "./matcher";
import { parseMultiEditorDetailed } from "./selection";
import type { EditStatement, Selection as EditDslSelection } from "./selection";
import { renderReadFailureFeedback, renderReadFeedback, resolveMultiEditor } from "./multi-editor";
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
  addLoopTokens,
  budgetTokensFromResponse,
  cloneLoopUsage,
  discoverSourceFiles,
  editDslRegionToResolved,
  explain,
  formatDiagnostics,
  loopTokensFromResponse,
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
  buildTaskReviewPrompt,
  buildTaskReviewRetryPrompt,
  buildTaskTurnPrompt,
  renderTaskContentView,
} from "./prompts/task";
import type { TaskSourceView } from "./prompts/task";
import {
  blockedNodes,
  finalNode,
  initialState,
  nextReadyNode,
  runComplete,
  summaryOf,
} from "./tasks";
import type { NodeId, PlanRunState, WorkNode } from "./tasks";
import {
  applyPlanPatch,
  parsePlanDslDetailed,
  parsePlanPatchDetailed,
  serializePlanDsl,
} from "./plan-dsl";
import type { PlanPatch } from "./plan-dsl";
import { renderDslIssues } from "./dsl-diagnostics";
import type { DslParseResult } from "./dsl-diagnostics";

/**
 * A planning turn's result, tagged so the caller never has to guess whether a
 * value is a run state or a terminated result.
 */
type PlanningOutcome =
  | { kind: "planned"; state: PlanRunState }
  | { kind: "failed"; result: LoopResult };
/** One review round: approve, a patched state, or a terminated run. */
type ReviewOutcome =
  | { kind: "approve" }
  | { kind: "patched"; state: PlanRunState }
  | { kind: "failed"; result: LoopResult };
/** One work-node execution: its gate passed, it stopped making progress, or the run ended. */
type ExecutionOutcome =
  | { kind: "passed"; gateDiagnostics: null }
  | { kind: "failed"; diagnostics: string }
  | { kind: "terminated"; result: LoopResult };

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

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The record locator for a node: its first hint, or an empty locator. */
function locatorOfNode(node: WorkNode): Locator {
  const hint = node.hints[0];
  if (hint === undefined) {
    return { path: "", name: "", kind: "" };
  }
  return { path: hint.path, name: hint.kind === "file" ? "" : hint.symbol, kind: "" };
}

function writeRecord(
  records: LoopRecord[],
  input: {
    iteration: number;
    kind: "exchange" | "verification";
    exchange: number | null;
    node: WorkNode;
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
      locator: locatorOfNode(input.node),
      replacement: input.replacement,
      diagnostics: input.diagnostics,
      outcome: input.outcome,
      finishReason: input.finishReason,
      payloads: input.payloads ?? 0,
      appliedLocators: input.appliedLocators,
    }),
  );
}

function readTarget(cwd: string, path: string): string {
  return readFileIfExists(join(cwd, path)) ?? "";
}

/** True when a planner turn is asking for a read-only edit-protocol viewer. */
function isPlannerViewerReply(content: string): boolean {
  const trimmed = stripCodeFences(content).trim();
  return /^(select|read|create|delete|write)\b/.test(trimmed);
}

/**
 * A planner viewer is one or more existing read-only viewer statements.
 * Editors, writes, creates, and deletes are rejected: the planner may inspect
 * code, never change it.
 */
function plannerViewerProblem(statements: readonly EditStatement[]): string | null {
  if (statements.length === 0) {
    return "the reply carried no viewer statement";
  }
  for (const statement of statements) {
    if (statement.type === "fs") {
      if (statement.statement.op !== "read") {
        return `a planner view is read-only; \`${statement.statement.op}\` is not allowed`;
      }
      continue;
    }
    const selection = statement.selection;
    if (selection.replacement !== null || selection.rename !== undefined) {
      return "a planner view is read-only; use a viewer (`select … end`) without `replace` or `rename`";
    }
  }
  return null;
}

/** The workspace files (paths and sources) for address resolution. */
function locatorOfHint(hint: WorkNode["hints"][number]): Locator {
  return { path: hint.path, name: hint.symbol, kind: "" };
}

// ---------------------------------------------------------------------------
// Applying one execution reply

interface ReplyOutcome {
  ok: boolean;
  /** A read-only reply wrote nothing; its feedback becomes the next prompt. */
  viewerOnly: boolean;
  diagnostics: string | null;
  feedback: string | null;
  appliedLocators: Locator[];
  /** Files the reply wrote, created, or deleted (repository-relative). */
  paths: string[];
}

interface ExecutionContext {
  cwd: string;
  workspace: Workspace;
  options: LoopOptions;
  records: LoopRecord[];
  /** Warnings recovered by a tolerant parser; recorded on the run result. */
  warnings: string[];
  node: WorkNode;
  iteration: number;
}

function editDslDeps(context: ExecutionContext): MultiEditorDeps {
  const cache = new Map<string, string>();
  const sourceFor = (path: string): string => {
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

function feedbackOf(resolution: MultiEditorResolution): string | null {
  const blocks = [
    resolution.viewers.length === 0 ? null : renderViewerFeedback(resolution.viewers),
    resolution.reads.length === 0 ? null : renderReadFeedback(resolution.reads),
    renderReadFailureFeedback(resolution.readFailures),
  ].filter((block): block is string => block !== null && block !== "");
  return blocks.length === 0 ? null : blocks.join("\n\n");
}

function rejectionText(resolution: MultiEditorResolution, totalClauses: number): string {
  return resolution.failures
    .map(
      (failure) =>
        `clause ${failure.index + 1} of ${totalClauses} (${failure.path}):\n${failure.diagnostics}`,
    )
    .join("\n\n");
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
        error: `stage: address\nthe reply targets ${JSON.stringify(entry.locator.name)} in a statement that declares several variables; replacing the whole statement would remove its siblings. Split the declaration first, or use a \`match\` on the one binding`,
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

/** Keep a whole-declaration rewrite's `export` modifier in step with the source. */
function withExportText(
  source: string,
  entry: IndexEntry,
  selection: EditDslSelection,
): EditDslSelection {
  const replacement = selection.replacement;
  if (
    replacement === null ||
    replacement.trim() === "" ||
    selection.rename !== undefined ||
    selection.matcher !== null ||
    selection.pick !== null
  ) {
    return selection;
  }
  const before = source.slice(0, entry.node.start);
  const exported = /(export\s+(?:default\s+)?)$/.test(before);
  const replierExported = /^\s*export\s+(?:default\s+)?/.test(replacement);
  if (exported && !replierExported) {
    return { ...selection, replacement: `export ${replacement}` };
  }
  if (!exported && replierExported) {
    return { ...selection, replacement: replacement.replace(/^\s*export\s+(?:default\s+)?/, "") };
  }
  return selection;
}

/**
 * Apply one execution reply. Every clause is resolved against the pre-reply
 * snapshot; a failure rejects the whole reply and writes nothing. The
 * one-declaration-per-reply claim set stays hard in `resolveMultiEditor`.
 */
async function applyEditReply(
  context: ExecutionContext,
  content: string,
  bases: Map<string, string>,
): Promise<ReplyOutcome> {
  const parsed = parseMultiEditorDetailed(content);
  if (!parsed.ok) {
    return {
      ok: false,
      viewerOnly: false,
      diagnostics: renderDslIssues(parsed.issues),
      feedback: null,
      appliedLocators: [],
      paths: [],
    };
  }
  for (const warning of parsed.issues.filter((issue) => issue.severity === "warning")) {
    context.warnings.push(`${warning.code}: ${warning.message}`);
  }
  const statements = parsed.value ?? [];
  if (statements.length === 0) {
    return {
      ok: false,
      viewerOnly: false,
      diagnostics:
        "stage: protocol\nthe reply carried no edit statement; reply with the edit clauses or file commands for this work node",
      feedback: null,
      appliedLocators: [],
      paths: [],
    };
  }

  const resolution = resolveMultiEditor(statements, editDslDeps(context));
  const feedback = feedbackOf(resolution);
  if (resolution.failures.length > 0) {
    return {
      ok: false,
      viewerOnly: false,
      diagnostics: rejectionText(resolution, statements.length),
      feedback,
      appliedLocators: [],
      paths: [],
    };
  }

  const commandWrites: { index: number; path: string; replacement: string }[] = [];
  const commandWriteIndices = new Set<number>();
  const commandWritePaths = new Set<string>();
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (statement?.type !== "fs" || statement.statement.op !== "write") {
      continue;
    }
    if (commandWritePaths.has(statement.statement.path)) {
      return {
        ok: false,
        viewerOnly: false,
        diagnostics: `stage: protocol\nthe reply writes ${JSON.stringify(statement.statement.path)} more than once; write a file once per reply`,
        feedback,
        appliedLocators: [],
        paths: [],
      };
    }
    commandWritePaths.add(statement.statement.path);
    commandWrites.push({
      index,
      path: statement.statement.path,
      replacement: statement.statement.replacement,
    });
    commandWriteIndices.add(index);
  }
  const renameIndices = new Set<number>();
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (
      statement?.type === "editor" &&
      statement.selection.rename !== undefined &&
      statement.selection.rename !== null
    ) {
      renameIndices.add(index);
    }
  }

  const editorRegions = resolution.regions.filter(
    (region) => !commandWriteIndices.has(region.index),
  );
  const sources = new Map<string, string>();
  const sourceOf = (path: string): string => {
    const cached = sources.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const source = readTarget(context.cwd, path);
    sources.set(path, source);
    return source;
  };

  const expandedRegions: EditDslRegion[] = [];
  for (const region of editorRegions) {
    const source = sourceOf(region.path);
    const isRename = renameIndices.has(region.index);
    if (region.create || isRename || region.matcherKind !== null) {
      expandedRegions.push(region);
      continue;
    }
    const existing = resolveCurrentEntry(
      source,
      region.path,
      locatorOfHint({ path: region.path, symbol: region.locator.name, kind: "value" }),
      null,
    );
    if (!existing.ok) {
      expandedRegions.push(region);
      continue;
    }
    if (region.stage === "whole-symbol" && region.text.trim() !== "") {
      const shape = declarationShapeProblem(source, existing.entry, region.text);
      if (shape !== null) {
        return {
          ok: false,
          viewerOnly: false,
          diagnostics: shape,
          feedback,
          appliedLocators: [],
          paths: [],
        };
      }
    }
    const expanded = expandVariableRegion(source, existing.entry, region);
    if ("error" in expanded) {
      return {
        ok: false,
        viewerOnly: false,
        diagnostics: expanded.error,
        feedback,
        appliedLocators: [],
        paths: [],
      };
    }
    if (expanded === region && region.stage === "whole-symbol" && region.text.trim() !== "") {
      const selection = withExportText(source, existing.entry, {
        locator: region.locator,
        space: null,
        matcher: null,
        pick: null,
        replacement: region.text,
        within: null,
        rename: null,
      });
      expandedRegions.push({ ...region, text: selection.replacement ?? region.text });
    } else {
      expandedRegions.push(expanded);
    }
  }

  if (editorRegions.length === 0 && commandWrites.length === 0) {
    const creates = resolution.creates.length;
    const deletes = resolution.deletes.length;
    if (creates === 0 && deletes === 0) {
      return {
        ok: false,
        viewerOnly: true,
        diagnostics:
          feedback === null
            ? "stage: protocol\nthe reply carried a viewer but resolved no occurrence; reply with an edit clause"
            : `stage: protocol\nthe reply only located source and wrote nothing; add the edit clauses or file commands for this work node.\n\n${feedback}`,
        feedback,
        appliedLocators: [],
        paths: [],
      };
    }
  }

  const commandPaths = new Set(commandWrites.map((write) => write.path));
  for (const region of expandedRegions) {
    if (commandPaths.has(region.path)) {
      return {
        ok: false,
        viewerOnly: false,
        diagnostics: `stage: protocol\nthe reply both edits and whole-file-writes ${JSON.stringify(region.path)}; split those actions across replies`,
        feedback,
        appliedLocators: [],
        paths: [],
      };
    }
  }

  let failure: string | null = null;
  const target = expandedRegions[0]?.path ?? "";
  const prevCheck = target === "" ? parseCheck("") : parseCheck(sourceOf(target));
  const writes =
    expandedRegions.length === 0
      ? []
      : await applyResolvedRegions({
          regions: expandedRegions.map(editDslRegionToResolved),
          fileSourceOf: (path) => sourceOf(path),
          target,
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
      viewerOnly: false,
      diagnostics: feedback === null ? failure : `${failure}\n\n${feedback}`,
      feedback,
      appliedLocators: [],
      paths: [],
    };
  }

  const preparedWrites: { path: string; source: string }[] = [...writes];
  for (const write of commandWrites) {
    const parsedWrite = parseCheck(write.replacement);
    if (!parsedWrite.ok) {
      return {
        ok: false,
        viewerOnly: false,
        diagnostics: gateDiagnostics(0, write.replacement, parsedWrite.failure),
        feedback,
        appliedLocators: [],
        paths: [],
      };
    }
    let formatted: string;
    try {
      formatted = await formatSource(write.path, write.replacement);
    } catch (error) {
      return {
        ok: false,
        viewerOnly: false,
        diagnostics: `stage: format\nthe whole-file write could not be formatted: ${error instanceof Error ? error.message : String(error)}`,
        feedback,
        appliedLocators: [],
        paths: [],
      };
    }
    const formattedCheck = parseCheck(formatted);
    if (!formattedCheck.ok) {
      return {
        ok: false,
        viewerOnly: false,
        diagnostics: gateDiagnostics(0, formatted, formattedCheck.failure),
        feedback,
        appliedLocators: [],
        paths: [],
      };
    }
    preparedWrites.push({ path: write.path, source: formatted });
  }

  const creates = resolution.creates.map((create) => ({ path: create.path, source: "" }));
  const uniqueWrites = new Map<string, string>();
  for (const write of [...preparedWrites, ...creates]) {
    uniqueWrites.set(write.path, write.source);
  }
  const changes = [...uniqueWrites].filter(
    ([path, source]) => source !== readTarget(context.cwd, path),
  );
  if (changes.length === 0 && resolution.deletes.length === 0 && resolution.creates.length === 0) {
    return {
      ok: false,
      viewerOnly: false,
      diagnostics: NOOP_DIAGNOSTICS,
      feedback,
      appliedLocators: [],
      paths: [],
    };
  }

  for (const [path, source] of uniqueWrites) {
    if (!bases.has(path)) {
      bases.set(path, readTarget(context.cwd, path));
    }
    writeTarget(context.cwd, path, source);
  }
  for (const deletion of resolution.deletes) {
    if (!bases.has(deletion.path)) {
      bases.set(deletion.path, readTarget(context.cwd, deletion.path));
    }
    rmSync(join(context.cwd, deletion.path), { force: true });
  }

  const appliedLocators: Locator[] = [];
  for (const region of expandedRegions) {
    appliedLocators.push(region.create ? locatorOfNode(context.node) : region.locator);
  }
  for (const write of commandWrites) {
    appliedLocators.push({ path: write.path, name: "", kind: "" });
  }
  for (const create of resolution.creates) {
    appliedLocators.push({ path: create.path, name: "", kind: "" });
  }
  for (const deletion of resolution.deletes) {
    appliedLocators.push({ path: deletion.path, name: "", kind: "" });
  }
  return {
    ok: true,
    viewerOnly: false,
    diagnostics: feedback,
    feedback,
    appliedLocators,
    paths: [
      ...new Set([...uniqueWrites.keys(), ...resolution.deletes.map((deletion) => deletion.path)]),
    ],
  };
}

// ---------------------------------------------------------------------------
// Node views, gates, and the applied diff

function declarationView(cwd: string, hint: WorkNode["hints"][number]): TaskSourceView {
  const source = readTarget(cwd, hint.path);
  if (hint.kind === "file") {
    return {
      label: `file ${JSON.stringify(hint.path)}`,
      source: renderTaskContentView(source, 1),
      startLine: 1,
    };
  }
  const entry = resolveCurrentEntry(
    source,
    hint.path,
    locatorOfHint(hint),
    hint.kind as SymbolSpace,
  );
  if (!entry.ok) {
    return {
      label: `${hint.kind} ${JSON.stringify(hint.symbol)} in ${JSON.stringify(hint.path)}`,
      source: renderTaskContentView(source, 1),
      startLine: 1,
      note: `The hint did not resolve (${entry.diagnostics.split("\n")[0] ?? "not found"}); showing the whole file.`,
    };
  }
  const startOffset = entry.entry.node.start;
  const endOffset = entry.entry.node.end;
  const body = source.slice(startOffset, endOffset);
  const startLine = source.slice(0, startOffset).split("\n").length;
  return {
    label: `${hint.kind} ${JSON.stringify(hint.symbol)} in ${JSON.stringify(hint.path)} (lines ${startLine}-${startLine + body.split("\n").length - 1})`,
    source: renderTaskContentView(body, startLine),
    startLine,
  };
}

function sourceViews(cwd: string, node: WorkNode): TaskSourceView[] {
  const views: TaskSourceView[] = [];
  const seen = new Set<string>();
  for (const hint of node.hints) {
    const key = `${hint.path}\u0000${hint.symbol}\u0000${hint.kind}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    views.push(declarationView(cwd, hint));
  }
  return views;
}

interface GateResult {
  ok: boolean;
  diagnostics: string | null;
}

/**
 * Run the node gate after one applied reply. `verify: "tsc"` runs the check;
 * `verify: "test"` runs the check and the test suite. A gate is the only place
 * a type/test failure becomes executor diagnostics.
 */
async function verifyNode(
  context: ExecutionContext,
  bases: ReadonlyMap<string, string>,
  paths: readonly string[],
): Promise<GateResult> {
  const anchor =
    paths[0] ??
    context.node.hints[0]?.path ??
    discoverSourceFiles(context.cwd)[0]?.path ??
    "src/unknown.ts";
  const baseSource = bases.get(anchor) ?? "";
  const check = await checkTool(
    context.cwd,
    context.options.checkCommand,
    context.options.commandTimeoutMs,
  );
  const test =
    check.ok && context.node.verify === "test"
      ? await testTool(context.cwd, context.options.testCommand, context.options.commandTimeoutMs)
      : { ok: true, exitCode: 0, output: "" };
  const diagnostics =
    check.ok && test.ok
      ? null
      : formatDiagnostics({
          check,
          test,
          targetPath: anchor,
          baseSource,
          newSource: readTarget(context.cwd, anchor),
          sourceFor: (path) => readTarget(context.cwd, path),
        });
  writeRecord(context.records, {
    iteration: context.iteration,
    kind: "verification",
    exchange: null,
    node: context.node,
    outcome: check.ok ? (test.ok ? "ok" : "tests") : "tsc",
    replacement: null,
    diagnostics,
    finishReason: null,
  });
  return { ok: check.ok && test.ok, diagnostics };
}

function snapshotSources(cwd: string): Map<string, string> {
  const bases = new Map<string, string>();
  for (const file of discoverSourceFiles(cwd)) {
    bases.set(file.path, file.source);
  }
  return bases;
}

/**
 * Fingerprint the files a node can have touched: the source snapshot plus every
 * path an applied reply wrote, created, or deleted. Non-TypeScript command
 * writes are included because `applyEditReply` adds their paths to `bases`.
 */
function workspaceFingerprint(cwd: string, bases: ReadonlyMap<string, string>): string {
  const entries = [...bases.keys()].sort().map((path) => `${path}\u0000${readTarget(cwd, path)}`);
  return hashText(entries.join("\u0001"));
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

/** The applied diff for a node: only changed files, only changed hunks. */
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

function changedPaths(cwd: string, bases: ReadonlyMap<string, string>): string[] {
  const changed: string[] = [];
  for (const [path, before] of bases) {
    if (readTarget(cwd, path) !== before) {
      changed.push(path);
    }
  }
  return changed.sort();
}

function outOfHintPaths(node: WorkNode, changed: readonly string[]): string[] {
  const hinted = new Set(node.hints.map((hint) => hint.path));
  return changed.filter((path) => !hinted.has(path));
}

// ---------------------------------------------------------------------------
// The driver

/** Compare the Plan wire form plus finish marker and harness statuses. */
function fingerprintState(state: PlanRunState): string {
  const statuses = state.nodes
    .map((node) => `${node.id}=${state.nodeStatus.get(node.id) ?? "pending"}`)
    .join(",");
  return `${serializePlanDsl(state.plan)}\nfinish: ${state.finalNodeId ?? ""}\nstatus: ${statuses}`;
}

/** Why no node is runnable, with the next graph action the planner can take. */
function blockedReason(state: PlanRunState): string {
  const blocked = blockedNodes(state);
  if (blocked.length > 0) {
    const failed = state.nodes
      .filter((node) => state.nodeStatus.get(node.id) === "failed")
      .map((node) => `#${node.id}`);
    return `Blocked node(s): ${blocked.map((node) => `#${node.id}`).join(", ")}.${
      failed.length === 0 ? "" : ` Failed dependency node(s): ${failed.join(", ")}.`
    } Repair the failed dependency, repoint the edge, remove the dependent, or add independent work.`;
  }
  const pending = state.nodes.filter((node) => state.nodeStatus.get(node.id) === "pending");
  if (pending.length > 0) {
    return `Pending node(s) ${pending.map((node) => `#${node.id}`).join(", ")} are waiting for dependencies that have not passed. Repair or repoint the dependency, or add ready work.`;
  }
  const last = finalNode(state);
  const finalId = state.finalNodeId;
  if (finalId === null) {
    if (
      last !== undefined &&
      last.verify === "test" &&
      state.nodeStatus.get(last.id) === "passed"
    ) {
      return `Every node is terminal and the last node #${last.id} is a passing test node, but no final node is marked. Emit "patch" + "finish" to mark it final, or add more work.`;
    }
    return `Every node is terminal but no final test node is marked. Add a final test node and emit finish, or repair the last test node and finish it.`;
  }
  if (last === undefined || last.id !== finalId) {
    return `The final node #${finalId} is no longer the last node; append a final test node and emit "finish" so finalNodeId moves.`;
  }
  if (state.nodeStatus.get(finalId) !== "passed") {
    return `The final node #${finalId} has not passed. Repair it in place and keep it last, or append a new final test node and emit "finish".`;
  }
  return `The final node #${finalId} passed, but the run still has open work; repair the remaining nodes before finishing.`;
}

/** The first record locator of the current graph, for failure/result anchors. */
function anchorLocator(state: PlanRunState | null): Locator | null {
  if (state === null) {
    return null;
  }
  const node = state.nodes.find((candidate) => candidate.hints.length > 0) ?? state.nodes[0];
  return node === undefined ? null : locatorOfNode(node);
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
  const nodeFailures = new Map<NodeId, string>();
  /** Review fingerprints per node, so a repeated patch/diff is detectable. */
  const reviewSeen = new Map<NodeId, Set<string>>();
  let iteration = 0;
  let current: PlanRunState | null = null;

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
    const anchor = anchorLocator(current);
    return {
      ok: false,
      mode: anchor === null ? undefined : "modify",
      locator: anchor,
      filePath: anchor?.path ?? null,
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
      nodes: current === null ? [] : summaryOf(current),
    };
  };

  const success = (state: PlanRunState): LoopResult => {
    const anchor = anchorLocator(state);
    return {
      ok: true,
      mode: anchor === null ? undefined : "modify",
      locator: anchor,
      filePath: anchor?.path ?? null,
      editedSource: null,
      records,
      diagnostics: null,
      explanation: null,
      messages: planningMessages,
      skipped: workspace.skipped,
      ...(runWarnings.length === 0 ? {} : { warnings: [...runWarnings] }),
      tokens: totalLoopTokens(usageState.usage),
      usage: cloneLoopUsage(usageState.usage),
      nodes: summaryOf(state),
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
   * Resolve one planner viewer reply with the edit-protocol resolver and return
   * source blocks, not a Plan/patch. The planner uses the same `select`/`read`
   * language as the executor; it just cannot write.
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
   * One planning turn: ask, parse, and retry a rejection with its diagnostics.
   * Viewer requests are unlimited except by the token budget and repeated-view
   * detection; a repeated view forces the Plan/patch reply. An initial plan
   * becomes the run state; a patch turn applies one patch and returns the merged
   * state.
   */
  const planningTurn = async (
    request: { mode: "initial" } | { mode: "patch"; state: PlanRunState },
  ): Promise<PlanningOutcome> => {
    const seen = new Set<string>();
    let forceReply = false;
    for (;;) {
      const response = await providerCall();
      if ("ok" in response) {
        return { kind: "failed", result: response };
      }
      const content = response.content ?? "";
      planningMessages.push({ role: "assistant", content });

      if (isPlannerViewerReply(content)) {
        const key = hashText(content.trim());
        if (forceReply || seen.has(key)) {
          seen.add(key);
          forceReply = true;
          planningMessages.push({
            role: "user",
            content:
              "# Source view\n\nThe same or repeated viewer makes no progress. Reply with the Plan/patch now; the viewer request writes nothing.",
          });
          continue;
        }
        seen.add(key);
        planningMessages.push({
          role: "user",
          content: plannerViewFeedback(
            content,
            "Reply with the initial Plan or the next patch. Each viewer consumes the token budget; repeated views force the Plan/patch.",
          ),
        });
        continue;
      }

      let diagnostics: string;
      if (request.mode === "initial") {
        const parsed = parsePlanDslDetailed(content);
        noteWarnings(parsed);
        if (parsed.ok && parsed.value !== undefined) {
          return {
            kind: "planned",
            state: initialState(parsed.value.plan, parsed.value.finalNodeId),
          };
        }
        diagnostics = renderDslIssues(parsed.issues);
      } else {
        const parsed = parsePlanPatchDetailed(content);
        noteWarnings(parsed);
        if (!parsed.ok || parsed.value === undefined) {
          diagnostics = renderDslIssues(parsed.issues);
        } else {
          const merged = applyPlanPatch(request.state, parsed.value);
          if (merged.ok) {
            return { kind: "planned", state: merged.state };
          }
          diagnostics = merged.diagnostics;
        }
      }

      const key = hashText(`${content}\n${diagnostics}`);
      if (seen.has(key)) {
        return {
          kind: "failed",
          result: await terminated(
            "task-exhausted",
            `task-exhausted: the planner repeated the same rejected ${request.mode === "initial" ? "plan" : "patch"} reply; no progress is possible\n\n${diagnostics}`,
          ),
        };
      }
      seen.add(key);
      planningMessages.push({
        role: "user",
        content:
          request.mode === "initial"
            ? buildTaskPlanRetryPrompt(diagnostics)
            : buildTaskPatchRetryPrompt(diagnostics),
      });
    }
  };

  const first = await planningTurn({ mode: "initial" });
  if (first.kind === "failed") {
    return first.result;
  }
  current = first.state;

  /** Ask for a patch after the graph settles; a patch that changes nothing is no progress. */
  const requestPatch = async (blocked: string | undefined): Promise<LoopResult | null> => {
    const state = current;
    if (state === null) {
      return terminated("task-exhausted", "task-exhausted: there is no current graph to patch");
    }
    const currentFiles = discoverSourceFiles(cwd);
    planningMessages.push({
      role: "user",
      content: buildTaskReplanPrompt({
        state,
        nodeFailures,
        blocked,
        symbolIndex: buildContextYaml(currentFiles),
      }),
    });
    const before = fingerprintState(state);
    const planned = await planningTurn({ mode: "patch", state });
    if (planned.kind === "failed") {
      return planned.result;
    }
    const next = planned.state;
    if (fingerprintState(next) === before) {
      return terminated(
        "task-exhausted",
        "task-exhausted: the planner patch left the work graph and statuses unchanged; no progress is possible",
      );
    }
    current = next;
    return null;
  };

  /** One post-gate review round in the planner conversation. */
  const reviewNode = async (
    state: PlanRunState,
    node: WorkNode,
    gate: GateResult,
    bases: ReadonlyMap<string, string>,
  ): Promise<ReviewOutcome> => {
    const diff = appliedDiff(cwd, bases);
    const changed = changedPaths(cwd, bases);
    const outOfHint = outOfHintPaths(node, changed);
    const seen = reviewSeen.get(node.id) ?? new Set<string>();
    reviewSeen.set(node.id, seen);
    for (;;) {
      planningMessages.push({
        role: "user",
        content: buildTaskReviewPrompt({
          node,
          gate: { verify: node.verify, ok: gate.ok, diagnostics: gate.diagnostics },
          diff,
          outOfHint,
        }),
      });
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
      if (content.trim().toLowerCase() === "approve") {
        return { kind: "approve" };
      }
      if (isPlannerViewerReply(content)) {
        const key = hashText(`view:${content.trim()}`);
        if (seen.has(key)) {
          return {
            kind: "failed",
            result: await terminated(
              "task-exhausted",
              "task-exhausted: the review repeated the same viewer; no progress is possible",
            ),
          };
        }
        seen.add(key);
        planningMessages.push({
          role: "user",
          content: plannerViewFeedback(
            content,
            "Reply with `approve` or one repair patch. The viewer request writes nothing.",
          ),
        });
        continue;
      }
      const parsed = parsePlanPatchDetailed(content);
      noteWarnings(parsed);
      let diagnostics: string;
      let next: PlanRunState | null = null;
      if (!parsed.ok || parsed.value === undefined) {
        diagnostics = renderDslIssues(parsed.issues);
      } else if (parsed.value.ops.length === 0 && !parsed.value.finish) {
        diagnostics =
          "stage: plan-graph\nthe review patch is empty; reply with `approve` or a repair patch that changes the graph";
      } else {
        const merged = applyPlanPatch(state, parsed.value);
        if (!merged.ok) {
          diagnostics = merged.diagnostics;
        } else {
          next = merged.state;
          diagnostics = "";
        }
      }
      const key = hashText(`${content}\n${diagnostics}\n${diff}`);
      if (diagnostics !== "" && seen.has(key)) {
        return {
          kind: "failed",
          result: await terminated(
            "task-exhausted",
            `task-exhausted: the review repeated the same rejected reply; no progress is possible\n\n${diagnostics}`,
          ),
        };
      }
      seen.add(key);
      if (diagnostics !== "" || next === null) {
        planningMessages.push({
          role: "user",
          content: buildTaskReviewRetryPrompt(diagnostics),
        });
        continue;
      }
      const stateKey = hashText(`${fingerprintState(next)}\n${diff}`);
      if (seen.has(stateKey)) {
        return {
          kind: "failed",
          result: await terminated(
            "task-exhausted",
            "task-exhausted: the review repeated the same patch and diff; no progress is possible",
          ),
        };
      }
      seen.add(stateKey);
      return { kind: "patched", state: next };
    }
  };

  /** Execute one work node until its gate passes or progress stops. */
  const executeNode = async (
    state: PlanRunState,
    node: WorkNode,
    bases: Map<string, string>,
  ): Promise<ExecutionOutcome> => {
    const chat: ChatState = {
      messages: [
        { role: "system", content: buildTaskExecutionSystemPrompt() },
        {
          role: "user",
          content: buildTaskTurnPrompt({ node, views: sourceViews(cwd, node) }),
        },
      ],
    };
    const seen = new Set<string>();
    let priorGate: string | undefined;
    let priorDiagnostics: string | undefined;
    let feedback: string | undefined;

    for (;;) {
      let response: ChatResponse;
      try {
        response = await callModel(
          chat.messages,
          usageState.usage.execution,
          usageState,
          options.provider,
          options,
        );
      } catch (error) {
        return {
          kind: "terminated",
          result: await terminated("provider-error", providerErrorDiagnostics(error)),
        };
      }
      if (overBudget(usageState, tokenBudget)) {
        return {
          kind: "terminated",
          result: await terminated(
            "token-budget",
            tokenBudgetDiagnostics(usageState.consumed, tokenBudget, tokenBudgetBasis),
          ),
        };
      }
      const content = response.content ?? "";
      chat.messages.push({ role: "assistant", content });

      const context: ExecutionContext = {
        cwd,
        workspace,
        options,
        records,
        warnings: runWarnings,
        node,
        iteration,
      };
      const outcome = await applyEditReply(context, content, bases);
      let diagnostics: string | null;
      if (outcome.ok) {
        writeRecord(records, {
          iteration,
          kind: "exchange",
          exchange: null,
          node,
          outcome: "applied",
          replacement: content,
          diagnostics: outcome.diagnostics,
          finishReason: response.finishReason,
          payloads: 1,
          appliedLocators: outcome.appliedLocators,
        });
        const gate = await verifyNode(context, bases, outcome.paths);
        if (gate.ok) {
          return { kind: "passed", gateDiagnostics: null };
        }
        diagnostics = gate.diagnostics ?? "stage: gate\nthe work node gate failed";
        priorGate = diagnostics;
        priorDiagnostics = undefined;
        feedback = outcome.feedback ?? undefined;
      } else {
        diagnostics = outcome.diagnostics ?? "stage: protocol\nthe reply was rejected";
        writeRecord(records, {
          iteration,
          kind: "exchange",
          exchange: null,
          node,
          outcome: outcome.viewerOnly ? "viewer" : outcomeOf(stageOf(diagnostics)),
          replacement: content,
          diagnostics,
          finishReason: response.finishReason,
          payloads: 0,
        });
        priorGate = undefined;
        priorDiagnostics = outcome.viewerOnly ? undefined : diagnostics;
        feedback = outcome.feedback ?? undefined;
      }

      const stateKey = hashText(`${workspaceFingerprint(cwd, bases)}\n${diagnostics ?? ""}`);
      const replyKey = hashText(`${content}\n${stateKey}`);
      // Read-only replies are an inspection tool, not progress: a `read` may be
      // repeated until the token budget runs out. Rejected or applied replies
      // participate in the repeated fingerprint/no-progress stop.
      if (!outcome.viewerOnly) {
        if (seen.has(replyKey) || seen.has(stateKey)) {
          return {
            kind: "failed",
            diagnostics: `stage: no-progress\nthe work node #${node.id} stopped making progress: the same reply/source/diagnostics fingerprint repeated; no fixed exchange cap applies\n\n${diagnostics ?? ""}`,
          };
        }
        seen.add(replyKey);
        seen.add(stateKey);
      }

      chat.messages.push({
        role: "user",
        content: buildTaskTurnPrompt({
          node,
          views: sourceViews(cwd, node),
          ...(priorDiagnostics === undefined ? {} : { diagnostics: priorDiagnostics }),
          ...(priorGate === undefined ? {} : { gateDiagnostics: priorGate }),
          ...(feedback === undefined ? {} : { feedback }),
        }),
      });
    }
  };

  for (;;) {
    const state = current as PlanRunState;
    if (runComplete(state)) {
      return success(state);
    }
    const node = nextReadyNode(state);
    if (node === undefined) {
      const patched = await requestPatch(blockedReason(state));
      if (patched !== null) {
        return patched;
      }
      continue;
    }

    iteration += 1;
    state.nodeStatus.set(node.id, "in-progress");
    const bases = snapshotSources(cwd);
    const executed = await executeNode(state, node, bases);
    if (executed.kind === "terminated") {
      return executed.result;
    }
    if (executed.kind === "failed") {
      state.nodeStatus.set(node.id, "failed");
      nodeFailures.set(node.id, executed.diagnostics);
      continue;
    }

    state.nodeStatus.set(node.id, "review");
    let reviewedState: PlanRunState = state;
    const gate: GateResult = { ok: true, diagnostics: null };
    for (;;) {
      const reviewed = await reviewNode(reviewedState, node, gate, bases);
      if (reviewed.kind === "failed") {
        return reviewed.result;
      }
      if (reviewed.kind === "approve") {
        reviewedState.nodeStatus.set(node.id, "passed");
        nodeFailures.delete(node.id);
        break;
      }
      reviewedState = reviewed.state;
      const status = reviewedState.nodeStatus.get(node.id);
      if (status === "pending") {
        // The review patch reopened the node; execute it again.
        break;
      }
      // The patch added or adjusted other work but left this node's definition
      // alone: the passing gate stands.
      reviewedState.nodeStatus.set(node.id, "passed");
      nodeFailures.delete(node.id);
      break;
    }
    current = reviewedState;
  }
}
