import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyAnchorSplice, extractJsonObject, findAnchor, stripCodeFences } from "./anchor";
import type { AnchorResult } from "./anchor";
import { formatSource } from "./editor";
import { LexError } from "./lexer";
import { ParseError, Parser } from "./parser";
import { buildIndexTolerant } from "./utility";
import { buildSignatureViewFromEntry } from "./scroll";
import { checkTool, testTool } from "./tools";
import { usageFromRaw } from "./replay-format";
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ReasoningEffort,
  ToolDefinition,
} from "./openai";
import type { Expression, Node, Program, Statement } from "./parser";
import type { CheckDiagnostic, CommandResult } from "./tools";
import type {
  IndexEntry,
  Locator,
  SkippedFile,
  SourceFile,
  SymbolIndex,
  TolerantIndex,
} from "./utility";

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "tmp"]);
const CONTEXT_SYMBOL_LIMIT = 500;
const SIGNATURE_LIMIT = 200;
const SPEC_FILE_LIMIT = 8000;
const TEST_FILE_SUFFIX = ".test.ts";
// Path-like tokens in the issue text, e.g. `src/lisp.ts` inside backticks.
const ISSUE_PATH_PATTERN = /[\w./-]+\.ts\b/g;

function comparePaths(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function collectSourcePaths(directory: string, paths: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      collectSourcePaths(join(directory, entry.name), paths);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      paths.push(join(directory, entry.name));
    }
  }
}

export function discoverSourceFiles(cwd: string): SourceFile[] {
  const paths: string[] = [];
  collectSourcePaths(cwd, paths);
  return paths
    .map((path) => relative(cwd, path).split(sep).join("/"))
    .sort(comparePaths)
    .map((path) => ({ path, source: readFileSync(join(cwd, path), "utf8") }));
}

export function selectSpecFiles(issue: string, files: readonly SourceFile[]): SourceFile[] {
  const mentioned = new Set<string>();
  for (const token of issue.match(ISSUE_PATH_PATTERN) ?? []) {
    mentioned.add(token.startsWith("./") ? token.slice(2) : token);
  }
  const selected = new Map<string, SourceFile>();
  for (const file of files) {
    if (basename(file.path).endsWith(TEST_FILE_SUFFIX) || mentioned.has(file.path)) {
      selected.set(file.path, file);
    }
  }
  return [...selected.values()].sort((left, right) => comparePaths(left.path, right.path));
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlSignature(signature: string): string {
  const collapsed = signature.replace(/\s*\n\s*/g, " ").trim();
  const shown =
    collapsed.length > SIGNATURE_LIMIT ? `${collapsed.slice(0, SIGNATURE_LIMIT)}...` : collapsed;
  return yamlString(shown);
}

export function buildContextYaml(files: SourceFile[], build?: TolerantIndex): string {
  const { index, skipped } = build ?? buildIndexTolerant(files);
  const groups = new Map<string, IndexEntry[]>();
  for (const entry of index.entries) {
    const group = groups.get(entry.locator.path);
    if (group === undefined) {
      groups.set(entry.locator.path, [entry]);
    } else {
      group.push(entry);
    }
  }
  const sourceByPath = new Map(files.map((file) => [file.path, file.source]));
  const ordered = [...files].sort((left, right) => comparePaths(left.path, right.path));
  const lines = ["files:"];
  let emitted = 0;
  let truncated = false;
  for (const file of ordered) {
    if (truncated) {
      break;
    }
    const entries = groups.get(file.path) ?? [];
    if (entries.length > 0 && emitted >= CONTEXT_SYMBOL_LIMIT) {
      truncated = true;
      break;
    }
    lines.push(`  - path: ${yamlString(file.path)}`);
    if (entries.length === 0) {
      lines.push("    symbols: []");
      continue;
    }
    lines.push("    symbols:");
    for (const entry of entries) {
      if (emitted >= CONTEXT_SYMBOL_LIMIT) {
        truncated = true;
        break;
      }
      const source = sourceByPath.get(file.path) ?? "";
      const signature = buildSignatureViewFromEntry(source, entry);
      lines.push(`      - name: ${yamlString(entry.locator.name)}`);
      lines.push(`        kind: ${yamlString(entry.locator.kind)}`);
      lines.push(`        signature: ${yamlSignature(signature)}`);
      emitted += 1;
    }
  }
  if (skipped.length > 0) {
    lines.push("skipped:");
    for (const file of skipped) {
      lines.push(`  - path: ${yamlString(file.path)}`);
      lines.push(`    message: ${yamlString(file.message)}`);
    }
  }
  if (truncated) {
    lines.push("truncated: true");
  }
  return `${lines.join("\n")}\n`;
}

// Opt-in multi-payload protocol (#69): appended to the system prompt when the
// variant is enabled, so the default prompt stays byte-identical.
const MULTI_PAYLOAD_SYSTEM_PARAGRAPH =
  'The multi-payload protocol is enabled: one edit reply may instead carry several path-independent edits as {"payloads": [{"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}, ...]}. Each entry targets a different file; the first entry echoes the pinned selection exactly, and every other entry names its own declaration in its own file (it must resolve uniquely there). The exchange applies atomically: if any entry fails its own guard, nothing is written and the exchange is rejected naming every failing entry\'s cause. A single edit may still be sent as one flat object, and "create"/"delete" selections never batch.';

export function buildSystemPrompt(multiPayload = false): string {
  const lines = [
    "You are a TypeScript coding agent.",
    "",
    'First you will be asked to select the target. Reply with ONLY a JSON object {"mode": "modify", "path": ..., "symbol": ..., "kind": ...}: "mode" is "modify" (default), "create", or "delete"; the composite address {path, symbol, kind} must all match the symbol index exactly and "kind" is required.',
    "",
    'Then you will be asked to edit the selected symbol. Reply with ONLY one flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}: the address {path, symbol, kind} must echo the pinned selection (a verification-repair round may re-pin to another declaration in the same file), and the optional "matcher" is a complete snippet copied from the current source that is structurally matched inside the symbol (omit it for a whole-symbol rewrite). The replacement is a drop-in for the matched range: keep leading keywords and modifiers consistent (do not re-add `export` the declaration omitted). Keep the same declaration kind and name unless the task requires otherwise. At most one matcher per response; multiple changes happen across edit rounds. No markdown fences and no explanations.',
    "",
    'A "create" selection asks for the COMPLETE declaration in "replacement"; the harness appends it to the target file, creating the file and any parent directories when needed. A "delete" selection carries no edit payload: the harness removes the declaration. To remove only part of a declaration, use "modify" with an empty "replacement". The syntax gate discards any edit that leaves the file unparseable and writes nothing.',
    "",
    "A round allows at most 3 exchanges: picking the target, writing the edit, and re-asking after a rejected edit share that budget. When an edit verifies, the run is done; when verification fails, the next round shows the current source and the failing diagnostics, and it may either revise the pinned declaration or re-pin to a different declaration in the same file by returning that declaration's own {path, symbol, kind} (the new address must resolve uniquely in the current source). A round that exhausts its 3 exchanges without a valid edit continues through a continuation prompt: reply `STOP` to end the run, or return a corrected edit (or, when no target is pinned, a corrected selection) to open a fresh round with a new 3-exchange budget; the run is capped at 32 rounds, after which it ends with the failure summary.",
    "",
  ];
  if (multiPayload) {
    lines.splice(lines.length - 1, 0, MULTI_PAYLOAD_SYSTEM_PARAGRAPH, "");
  }
  return lines.join("\n");
}

// Keep the head (declarations and early cases) and the tail (final assertions,
// or the current source of the edited region) of an oversized source with an
// explicit marker in between.
function truncateSource(source: string): string {
  if (source.length <= SPEC_FILE_LIMIT) {
    return source;
  }
  const half = SPEC_FILE_LIMIT / 2;
  const head = source.slice(0, half);
  const tail = source.slice(source.length - half);
  const truncated = source.length - SPEC_FILE_LIMIT;
  return `${head}\n// ... [truncated ${truncated} characters] ...\n${tail}`;
}

function buildSpecSection(specFiles: readonly SourceFile[]): string {
  const lines = [
    "# Spec files",
    "",
    "These files are part of the specification; do not modify them.",
  ];
  for (const file of specFiles) {
    const source = truncateSource(file.source);
    const sourceLines = source.split("\n");
    const fence = sourceLines.some((line) => line.startsWith("```")) ? "````" : "```";
    lines.push("", `## ${file.path}`, "", `${fence}ts`, ...sourceLines, fence);
  }
  return lines.join("\n");
}

export function buildUserPrompt(
  issue: string,
  contextYaml: string,
  specFiles: readonly SourceFile[] = [],
): string {
  const body = contextYaml === "" || contextYaml.endsWith("\n") ? contextYaml : `${contextYaml}\n`;
  const prompt = `# Issue\n\n${issue}\n\n# Project context\n\n\`\`\`yaml\n${body}\`\`\`\n`;
  if (specFiles.length === 0) {
    return prompt;
  }
  return `${prompt}\n${buildSpecSection(specFiles)}\n`;
}

export function buildEditPrompt(
  addressJson: string,
  symbolSource: string,
  multiPayload = false,
): string {
  const body = symbolSource.endsWith("\n") ? symbolSource : `${symbolSource}\n`;
  if (multiPayload) {
    return `Output ONE flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...} for the pinned symbol, or a multi-payload object {"payloads": [ ... ]} that batches path-independent edits — one entry per file — with no markdown fences and no explanations.

The first payload echoes the pinned address {path, symbol, kind}; every further payload names a different file and its own declaration address, which must resolve to exactly one declaration in that file's current source. "matcher" is optional per payload: a complete snippet copied from the current source below; "replacement" replaces exactly the matched range. Omit "matcher" for a whole-symbol rewrite: "replacement" then replaces the whole declaration. Keep leading keywords and modifiers consistent (do not re-add \`export\` the declaration omitted). Every replacement must keep its file parseable. The exchange applies atomically: if any payload fails its own guard, nothing is written and the exchange is rejected naming every failing payload.

Pinned selection:

\`\`\`json
${addressJson}
\`\`\`

Current source:

\`\`\`ts
${body}\`\`\`
`;
  }
  return `Output ONE flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...} for the pinned symbol, with no markdown fences and no explanations.

Echo the pinned address {path, symbol, kind}. "matcher" is optional: a complete snippet copied from the current source below; "replacement" replaces exactly the matched range. Omit "matcher" for a whole-symbol rewrite: "replacement" then replaces the whole declaration. Keep leading keywords and modifiers consistent (do not re-add \`export\` the declaration omitted). The replacement must keep the file parseable.

Pinned selection:

\`\`\`json
${addressJson}
\`\`\`

Current source:

\`\`\`ts
${body}\`\`\`
`;
}

export function buildCreatePrompt(addressJson: string, path: string): string {
  return `The pinned selection uses mode "create". Output ONE flat JSON object {"path": ..., "symbol": ..., "kind": ..., "replacement": ...} with no markdown fences and no explanations: echo the pinned address {path, symbol, kind}, put the COMPLETE declaration in "replacement", and omit "matcher". The target file may not exist yet; the declaration is appended to it. The replacement must keep the file parseable.

Target file:

\`\`\`
${path}
\`\`\`

Pinned selection:

\`\`\`json
${addressJson}
\`\`\`
`;
}

export interface RetryPromptInput {
  /** 1-based exchange number the prompt requests inside the current Run iteration. */
  exchangeNumber: number;
  maxExchanges: number;
  /** `create` asks for the complete declaration; `modify` for the flat edit payload. */
  mode: "modify" | "create";
  /** Canonical pinned selection, `{mode, path, symbol, kind}`. */
  locatorJson: string;
  /** Current on-disk source of the selected region (whole file in create mode). */
  currentSource: string;
  diagnostics: string;
  /** Verification retries say "failed verification"; edit retries say "failed". */
  failure: "edit" | "verification";
  /** True in a verification-repair iteration, where the pin may move to another declaration. */
  repin: boolean;
  /**
   * Round-level continuation (#52): replaces the exchange header with the
   * round-exhausted / STOP framing; this prompt and the no-progress ask (#54)
   * are the only ones that offer `STOP`.
   */
  continuation?: { round: number; maxRounds: number };
  /**
   * No-progress ask (#54): replaces the exchange header (and the corrective
   * action sentence) with the consecutive-failed-rounds framing; only the
   * first exchange of a stalled round sets it.
   */
  stalled?: { failedRounds: number; round: number; maxRounds: number };
  /**
   * Per-cause rejection correction (#56): replaces the default corrective lead
   * sentence with the class-specific action (or its escalation); `stalled`
   * takes precedence when both are present.
   */
  correction?: string;
  /**
   * Prior-attempts digest (#57): the bounded checkpoint appended after the
   * Diagnostics block. Only the #52 round-continuation prompts and the #54
   * no-progress ask carry it; ordinary retries stay unchanged.
   */
  digest?: string;
  /**
   * Failure history (#71): the bounded non-convergence note (unchanged failing
   * set or a two-state cycle), appended after the Diagnostics block and before
   * the digest; ordinary retries carry it too.
   */
  failureHistory?: string;
  /**
   * Opt-in multi-payload variant (#69): modify retries offer the
   * `{"payloads": [...]}` batch shape alongside the flat payload; off (the
   * default) keeps the exact single-payload instructions.
   */
  multiPayload?: boolean;
}

/** Multi-payload modify instruction (#69): one flat payload or a path-independent batch. */
function multiModifyInstruction(
  lead: string,
  status: string,
  repin: boolean,
  modifierNote: string,
): string {
  const address = repin
    ? 'return the full address of the declaration you are fixing — either the pinned selection or a different declaration in the same file to re-pin and edit it (it must resolve uniquely in the current source) — or a {"payloads": [...]} object batching path-independent edits whose first entry carries that pinned-or-re-pinned address and each further entry names a different file and its own declaration'
    : 'echo the pinned selection in the first payload\'s address — or, to batch path-independent edits, return a {"payloads": [...]} object whose first entry echoes the pinned selection and each further entry names a different file and its own declaration';
  return `${lead} ${status}Output either ONE flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...} (${address}), or exactly that {"payloads": [ ... ]} batch shape. "matcher" is optional per payload: a snippet copied from the current source, or omit it for a whole-symbol rewrite; "replacement" replaces the matched range (empty removes it). The exchange applies atomically: if any payload fails its own guard, nothing is written and the rejection names every failing payload. ${modifierNote} No markdown fences and no explanations.`;
}

export function buildRetryPrompt(input: RetryPromptInput): string {
  const {
    exchangeNumber,
    maxExchanges,
    mode,
    locatorJson,
    currentSource,
    diagnostics,
    failure,
    repin,
  } = input;
  const remaining = Math.max(0, maxExchanges - exchangeNumber);
  const label = failure === "verification" ? "failed verification" : "failed";
  const body = currentSource.endsWith("\n") ? currentSource : `${currentSource}\n`;
  // The splice tolerates a leading `export` that repeats the declaration's
  // existing modifier, so no re-add warning is needed (#48).
  const modifierNote =
    "A leading `export` matching the declaration's existing modifier is accepted.";
  const stalled = input.stalled;
  // No-progress ask (#54): the corrective lead is replaced by concrete
  // alternatives when the model has failed the same verification repeatedly.
  const stalledLead =
    mode === "modify"
      ? "Concretely: change the matcher shape, re-pin to a declaration the diagnostics name, or restructure the declaration."
      : "Concretely: restructure the declaration rather than repeating a minimal correction.";
  // Per-cause rejection correction (#56): replaces the default lead sentence;
  // the no-progress ask still wins when both are present.
  const modifyLead =
    stalled !== undefined
      ? stalledLead
      : (input.correction ?? "Make minimal corrective changes to the current source below.");
  const createLead =
    stalled !== undefined
      ? stalledLead
      : (input.correction ?? "Make minimal corrective changes to the complete declaration.");
  // Only an ordinary retry states where it sits in the exchange budget; the
  // #52 continuation and #54 stalled headers already frame the round.
  const status =
    stalled !== undefined || input.continuation !== undefined
      ? ""
      : `Edit exchange ${exchangeNumber} of ${maxExchanges} ${label}. ${remaining} exchange(s) remain in this iteration. `;
  const modifyInstruction =
    input.multiPayload === true
      ? multiModifyInstruction(modifyLead, status, repin, modifierNote)
      : repin
        ? `${modifyLead} ${status}Output ONLY one flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}: return the full address of the declaration you are fixing — either the pinned selection or a different declaration in the same file to re-pin and edit it (it must resolve uniquely in the current source). "matcher" is optional: a snippet copied from the current source, or omit it for a whole-symbol rewrite; "replacement" replaces the matched range (empty removes it). ${modifierNote} No markdown fences and no explanations.`
        : `${modifyLead} ${status}Output ONLY one flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}: echo the pinned selection in the address. "matcher" is optional: a snippet copied from the current source, or omit it for a whole-symbol rewrite; "replacement" replaces the matched range (empty removes it). ${modifierNote} No markdown fences and no explanations.`;
  const instruction =
    mode === "modify"
      ? modifyInstruction
      : `${createLead} ${status}Output ONLY one flat JSON object {"path": ..., "symbol": ..., "kind": ..., "replacement": ...}: echo the pinned selection in the address, put the COMPLETE corrected declaration in "replacement", and omit "matcher". No markdown fences and no explanations.`;
  const header =
    stalled !== undefined
      ? `No progress: ${stalled.failedRounds} consecutive failed rounds. This is round ${stalled.round} of ${stalled.maxRounds}. Reply exactly \`STOP\` to end the run now, but only if the failures cannot be resolved; otherwise take a materially different approach rather than another minimal attempt.`
      : input.continuation === undefined
        ? ""
        : `Round ${input.continuation.round} of ${input.continuation.maxRounds} exhausted its ${maxExchanges}-exchange edit budget without a valid edit. Reply STOP to end the run, or return a corrected edit to continue with a fresh round.`;
  const digestSection =
    input.digest === undefined || input.digest.trim() === "" ? "" : `\n${input.digest}\n`;
  const failureHistorySection =
    input.failureHistory === undefined || input.failureHistory.trim() === ""
      ? ""
      : `\n${input.failureHistory}\n`;
  return `${header === "" ? "" : `${header}\n\n`}${instruction}

Pinned selection:

\`\`\`json
${locatorJson}
\`\`\`

Current source:

\`\`\`ts
${body}\`\`\`

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`
${failureHistorySection}${digestSection}`;
}

export interface ContinuationPromptInput {
  /** Round that exhausted its exchange budget (1-based). */
  round: number;
  maxRounds: number;
  /** `create` asks for the complete declaration; `modify` for the flat edit payload. */
  mode: "modify" | "create";
  /** Canonical pinned selection, `{mode, path, symbol, kind}`. */
  locatorJson: string;
  /** Current on-disk source of the selected region (whole file in create mode). */
  currentSource: string;
  /** The diagnostics that opened the round plus the latest rejection. */
  diagnostics: string;
  /** True when the continued round may still re-pin to another declaration. */
  repin: boolean;
  /** Prior-attempts digest (#57), appended after the Diagnostics block. */
  digest?: string;
  /** Failure history (#71), appended after the Diagnostics block before the digest. */
  failureHistory?: string;
  /**
   * No-progress ask (#60): a continuation that directly follows a milestone
   * no-progress round carries the stalled decision framing (and its STOP
   * semantics) instead of the round-exhausted header; the retry shape is kept.
   */
  stalled?: { failedRounds: number; round: number; maxRounds: number };
  /** Opt-in multi-payload variant (#69); forwarded to the retry prompt. */
  multiPayload?: boolean;
}

/**
 * Round-level continuation (#52): shown as the first message of the round that
 * follows an exhausted one. It keeps the retry shape (instruction, pinned
 * selection, current source, diagnostics) and adds the STOP framing; this
 * prompt and the no-progress ask (#54/#60) are the only ones that offer `STOP`.
 */
export function buildContinuationPrompt(input: ContinuationPromptInput): string {
  return buildRetryPrompt({
    exchangeNumber: 1,
    maxExchanges: MAX_EDIT_EXCHANGES,
    mode: input.mode,
    locatorJson: input.locatorJson,
    currentSource: input.currentSource,
    diagnostics: input.diagnostics,
    failure: "edit",
    repin: input.repin,
    continuation: { round: input.round, maxRounds: input.maxRounds },
    stalled: input.stalled,
    digest: input.digest,
    failureHistory: input.failureHistory,
    multiPayload: input.multiPayload,
  });
}

const TERMINATION_SUMMARY: Record<TerminationReason | "provider-error", string> = {
  "token-budget": "the token budget was exceeded",
  "edit-exhausted": "the edit budget was exhausted without a valid edit",
  "delete-verification-failed": "the deletion could not be verified",
  "prev-broken": "the current source of the target no longer parses",
  "provider-error": "the provider call failed",
  "harness-fault": "the harness produced an invalid edit candidate at the format gate",
};

/**
 * Termination step (#43): the summary prompt is the final user message of a
 * failed run, not an Edit exchange — it does not count against the ≤3 budget.
 */
export function buildSummaryPrompt(
  reason: TerminationReason | "provider-error",
  diagnostics: string | null,
): string {
  const lines = [`The run is over: ${TERMINATION_SUMMARY[reason]}.`];
  if (diagnostics !== null && diagnostics.trim() !== "") {
    lines.push("", "Diagnostics:", "", "```", diagnostics, "```");
  }
  lines.push(
    "",
    "Reply with exactly these four labeled lines, in this order and nothing else:",
    "- Accomplished: what was completed before the stop.",
    "- Failed and why: what could not be completed and the reason.",
    "- Remaining: what is still to do.",
    "- Next step: one concrete recommendation for the planner.",
    "Do not output code.",
  );
  return lines.join("\n");
}

function selectionRetryBody(diagnostics: string): string {
  return `Output ONLY a corrected selection JSON object {"mode": ..., "path": ..., "symbol": ..., "kind": ...}, with no markdown fences and no prose.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`
`;
}

export function buildSelectionRetryPrompt(diagnostics: string): string {
  return `The previous selection was rejected. ${selectionRetryBody(diagnostics)}`;
}

/**
 * Selection-side round continuation (#52): the exhausted round never pinned a
 * target, so the fresh round re-asks for the selection (or `STOP`); the
 * prior-attempts digest (#57) is appended after the diagnostics.
 */
export function buildSelectionContinuationPrompt(input: {
  round: number;
  maxRounds: number;
  diagnostics: string;
  digest?: string;
  /** Failure history (#71), appended after the diagnostics before the digest. */
  failureHistory?: string;
}): string {
  const digestSection =
    input.digest === undefined || input.digest.trim() === "" ? "" : `\n${input.digest}\n`;
  const failureHistorySection =
    input.failureHistory === undefined || input.failureHistory.trim() === ""
      ? ""
      : `\n${input.failureHistory}\n`;
  return `Round ${input.round} of ${input.maxRounds} exhausted its ${MAX_EDIT_EXCHANGES}-exchange selection budget without a valid pick. Reply STOP to end the run, or return a corrected selection to continue with a fresh round.

${selectionRetryBody(input.diagnostics)}${failureHistorySection}${digestSection}`;
}

export { stripCodeFences };

export type SelectionMode = "modify" | "create" | "delete";

export interface SelectionResponse {
  mode: SelectionMode;
  locator: Locator;
}

export interface EditPayload {
  locator: Locator;
  /** Structural snippet copied from the current source; null = whole-symbol rewrite. */
  matcher: string | null;
  replacement: string;
}

const SELECTION_EXPECTED =
  'expected {"mode":"modify"|"create"|"delete","path": ..., "symbol": ..., "kind": ...}';
const EDIT_EXPECTED =
  'expected {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}';
const SELECTION_MODES: ReadonlySet<string> = new Set(["modify", "create", "delete"]);
const SELECTION_KEYS: ReadonlySet<string> = new Set(["mode", "path", "symbol", "kind"]);
const EDIT_KEYS: ReadonlySet<string> = new Set([
  "path",
  "symbol",
  "kind",
  "matcher",
  "replacement",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tolerant object reader: whole-text fences and surrounding prose are tolerated. */
function readJsonObject(content: string, expected: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(content);
  } catch (error) {
    throw new Error(`${expected}; ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${expected}; got a JSON value that is not an object`);
  }
  return parsed;
}

// v2 protocol errors name the unexpected keys the model actually sent; `name`
// and `edits` get targeted hints because they are the v1 shapes.
function parseAddressFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  expected: string,
): Locator {
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    const hints: string[] = [];
    if (extra.includes("name") && !("symbol" in record)) {
      hints.push('the address field is "symbol" (renamed from "name")');
    }
    if (extra.includes("edits")) {
      hints.push('v2 carries one flat edit object, not an "edits" array');
    }
    const hint = hints.length === 0 ? "" : ` (${hints.join("; ")})`;
    throw new Error(
      `${expected}; unexpected key(s) ${extra.map((key) => JSON.stringify(key)).join(", ")}${hint}`,
    );
  }
  const path = record["path"];
  const symbol = record["symbol"];
  const kind = record["kind"];
  if (typeof path !== "string" || path === "") {
    throw new Error(`${expected}; "path" must be a non-empty string`);
  }
  if (typeof symbol !== "string" || symbol === "") {
    throw new Error(`${expected}; "symbol" must be a non-empty string`);
  }
  if (typeof kind !== "string" || kind === "") {
    throw new Error(`${expected}; "kind" must be a non-empty string`);
  }
  return { path, name: symbol, kind };
}

function selectionFromValue(parsed: unknown): SelectionResponse {
  if (!isRecord(parsed)) {
    throw new Error(`${SELECTION_EXPECTED}; got a JSON value that is not an object`);
  }
  const locator = parseAddressFields(parsed, SELECTION_KEYS, SELECTION_EXPECTED);
  const mode = parsed["mode"];
  if (mode === undefined) {
    return { mode: "modify", locator };
  }
  if (typeof mode !== "string" || !SELECTION_MODES.has(mode)) {
    throw new Error(
      `${SELECTION_EXPECTED}; "mode" must be one of "modify", "create", "delete" (got ${JSON.stringify(mode)})`,
    );
  }
  return { mode: mode as SelectionMode, locator };
}

export function parseSelectionResponse(content: string): SelectionResponse {
  return selectionFromValue(readJsonObject(content, SELECTION_EXPECTED));
}

// One flat edit payload from an already-parsed record; shared by the classic
// single-payload reply and each entry of an opt-in `{"payloads": [...]}` batch
// (#69).
function payloadFromRecord(record: Record<string, unknown>, expected: string): EditPayload {
  const locator = parseAddressFields(record, EDIT_KEYS, expected);
  const matcher = record["matcher"];
  if (matcher !== undefined && (typeof matcher !== "string" || matcher === "")) {
    throw new Error(
      `${expected}; "matcher" must be a non-empty string when present (omit it for a whole-symbol rewrite)`,
    );
  }
  const replacement = record["replacement"];
  if (typeof replacement !== "string") {
    throw new Error(`${expected}; "replacement" must be a string`);
  }
  return { locator, matcher: matcher === undefined ? null : matcher, replacement };
}

export function parseEditResponse(content: string): EditPayload {
  return payloadFromRecord(readJsonObject(content, EDIT_EXPECTED), EDIT_EXPECTED);
}

/** Batch wrapper key of the opt-in multi-payload protocol (#69). */
export const MULTI_PAYLOAD_KEY = "payloads";

/**
 * Result of parsing a reply under the opt-in multi-payload protocol (#69): a
 * classic flat payload (`batch: false`) or a `{"payloads": [...]}` batch, or a
 * rejection carrying the payloads that did parse plus the batch-level cause
 * (`multi-protocol` for a malformed wrapper/entry, `multi-duplicate` when two
 * payloads target the same file, null for a classic protocol failure).
 */
export type EditPayloadList =
  | { ok: true; batch: boolean; payloads: EditPayload[] }
  | {
      ok: false;
      cause: "multi-protocol" | "multi-duplicate" | null;
      diagnostics: string;
      payloads: EditPayload[];
    };

// `stage: multi` header for every batch-level rejection (#69); the payloads'
// own diagnostics follow, so a retry can name each failing payload's cause.
export function multiDiagnostics(message: string): string {
  return `stage: multi\nthe multi-payload exchange was rejected: ${message}; nothing is written`;
}

/**
 * Parse one edit reply under the opt-in multi-payload protocol (#69): a flat
 * object stays the classic single payload; an object carrying `payloads` is a
 * batch whose entries are flat payloads, one per file. Batch-level errors are
 * typed (`multi-protocol`, `multi-duplicate`) and never silently repaired.
 */
export function parseEditResponseList(content: string): EditPayloadList {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(content);
  } catch (error) {
    return {
      ok: false,
      cause: null,
      diagnostics: `stage: protocol\n${EDIT_EXPECTED}; ${errorMessage(error)}`,
      payloads: [],
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      cause: null,
      diagnostics: `stage: protocol\n${EDIT_EXPECTED}; got a JSON value that is not an object`,
      payloads: [],
    };
  }
  if (!(MULTI_PAYLOAD_KEY in parsed)) {
    try {
      return { ok: true, batch: false, payloads: [parseEditResponse(content)] };
    } catch (error) {
      return {
        ok: false,
        cause: null,
        diagnostics: `stage: protocol\n${errorMessage(error)}`,
        payloads: [],
      };
    }
  }
  const extra = Object.keys(parsed).filter((key) => key !== MULTI_PAYLOAD_KEY);
  if (extra.length > 0) {
    return {
      ok: false,
      cause: "multi-protocol",
      diagnostics: multiDiagnostics(
        `the batch object carries unexpected key(s) ${extra.map((key) => JSON.stringify(key)).join(", ")}; send only "payloads"`,
      ),
      payloads: [],
    };
  }
  const entries = parsed[MULTI_PAYLOAD_KEY];
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      ok: false,
      cause: "multi-protocol",
      diagnostics: multiDiagnostics('"payloads" must be a non-empty array of flat edit objects'),
      payloads: [],
    };
  }
  const payloads: EditPayload[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry)) {
      return {
        ok: false,
        cause: "multi-protocol",
        diagnostics: multiDiagnostics(`payload ${index + 1} is not a flat edit object`),
        payloads,
      };
    }
    try {
      payloads.push(payloadFromRecord(entry, EDIT_EXPECTED));
    } catch (error) {
      return {
        ok: false,
        cause: "multi-protocol",
        diagnostics: multiDiagnostics(`payload ${index + 1}: ${errorMessage(error)}`),
        payloads,
      };
    }
  }
  // Path independence (#69): one payload per file; #72 reserves same-symbol
  // multi-range batching for later.
  const seen = new Map<string, number>();
  for (let index = 0; index < payloads.length; index += 1) {
    const path = payloads[index]?.locator.path ?? "";
    const previous = seen.get(path);
    if (previous !== undefined) {
      return {
        ok: false,
        cause: "multi-duplicate",
        diagnostics: multiDiagnostics(
          `payload ${previous + 1} and payload ${index + 1} both target ${JSON.stringify(path)}; a multi-payload exchange carries at most one payload per file`,
        ),
        payloads,
      };
    }
    seen.set(path, index);
  }
  return { ok: true, batch: true, payloads };
}

function addressJson(locator: Locator): string {
  return JSON.stringify({ path: locator.path, symbol: locator.name, kind: locator.kind });
}

function addressEquals(left: Locator, right: Locator): boolean {
  return left.path === right.path && left.name === right.name && left.kind === right.kind;
}

// Canonical pinned-selection label, `{mode, path, symbol, kind}`; rebuilt
// whenever the pin moves or its mode changes (#48).
function pinJson(pinned: { mode: SelectionMode; locator: Locator }): string {
  return JSON.stringify({
    mode: pinned.mode,
    path: pinned.locator.path,
    symbol: pinned.locator.name,
    kind: pinned.locator.kind,
  });
}

function echoDiagnostics(pinned: Locator, payload: Locator): string {
  return [
    "stage: echo",
    'the payload address does not match the pinned selection; echo the selection exactly in {path, symbol, kind} and do not echo "mode"',
    `pinned: ${addressJson(pinned)}`,
    `payload: ${addressJson(payload)}`,
  ].join("\n");
}

function selectionFromResponse(response: ChatResponse): SelectionResponse {
  const toolCall = response.toolCalls[0];
  if (toolCall === undefined) {
    return parseSelectionResponse(response.content ?? "");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new Error(SELECTION_EXPECTED);
  }
  return selectionFromValue(parsed);
}

export interface ProviderLike {
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatResponse>;
}

export const DEFAULT_TOKEN_BUDGET = 120_000;
/** Model exchanges per Run iteration, shared by target picking and content revision (#43). */
export const MAX_EDIT_EXCHANGES = 3;
/**
 * Hard cap on Run iterations (#52): a round that exhausts its ≤3 exchanges
 * below the cap continues through a continuation prompt; entering an iteration
 * beyond the cap terminates as `edit-exhausted` naming the cap.
 */
export const MAX_RUN_ITERATIONS = 32;
/**
 * No-progress decision point (#54): after this many consecutive
 * verification-failed rounds, the first content prompt of the next round asks
 * the model to decide (reply `STOP` or take a materially different approach);
 * the ask recurs at every further multiple.
 */
export const MAX_STALLED_ROUNDS = 8;

// Shown on the retry after the same rejection repeats verbatim (#48).
const IDENTICAL_RETRY_NOTE =
  'the previous attempt failed identically; change the shape of the edit (omit "matcher" for a whole-symbol rewrite, adjust the replacement, or re-pin to a different declaration)';

export interface LoopOptions {
  cwd: string;
  issue: string;
  model: string;
  provider: ProviderLike;
  /** Abort the run once accumulated provider tokens exceed this (#36). */
  tokenBudget?: number;
  temperature?: number;
  checkCommand?: string[];
  testCommand?: string[];
  /** Check/test command timeout in ms; defaults to 120_000 (#45). */
  commandTimeoutMs?: number;
  /** Benchmark override: forces this effort on every Edit-loop call, bypassing the default policy (#35). */
  effortOverride?: ReasoningEffort;
  /**
   * Opt-in multi-payload exchanges (#69): a modify reply may carry
   * `{"payloads": [...]}`, one path-independent payload per file, applied
   * atomically. Default off keeps the exact single-payload behavior.
   */
  multiPayload?: boolean;
}

/** Outcome of one model exchange inside Edit. */
export type ExchangeOutcome =
  | "selected"
  | "applied"
  | "stopped"
  | "protocol"
  | "address"
  | "echo"
  | "matcher"
  | "no-op"
  | "repeat"
  | "duplicate"
  | "gate"
  | "format"
  | "truncated"
  | "prev-broken";

/** Outcome of one harness-side application/verification step. */
export type VerificationOutcome = "ok" | "tsc" | "tests" | "gate" | "format" | "prev-broken";

export type AttemptOutcome = ExchangeOutcome | VerificationOutcome;

/** Matcher-check failures, produced by `spliceEntryEdit` (#56). */
type MatcherCause = "matcher-unparseable" | "matcher-not-found" | "matcher-ambiguous";

/**
 * Typed edit-rejection cause (#56): every exchange rejection maps to exactly
 * one class so the retry policy and the record rows never string-sniff the
 * diagnostics text.
 */
export type RejectionCause =
  | "protocol"
  | "echo"
  | "address"
  | MatcherCause
  | "no-op"
  | "repeat"
  | "duplicate"
  | "gate"
  | "format"
  | "format-export-duplication"
  | "truncated"
  | "multi-protocol"
  | "multi-duplicate";

/** Stage of one rejected content exchange, as recorded and classified (#43/#69). */
type EditFailureStage =
  | "protocol"
  | "echo"
  | "address"
  | "matcher"
  | "no-op"
  | "repeat"
  | "duplicate"
  | "gate"
  | "format";

/** oxfmt's duplicate-modifier parse error (e.g. `'export' modifier already seen`). */
const FORMAT_DUPLICATE_MODIFIER_SIGNATURE = "modifier already seen";

/**
 * Classify one rejection from its structured origin: the stage the loop set
 * while rejecting, the splice's matcher sub-cause, and the caught formatter
 * message. The diagnostics text is never parsed here.
 */
export function classifyRejection(input: {
  stage:
    | "protocol"
    | "echo"
    | "address"
    | "matcher"
    | "no-op"
    | "repeat"
    | "duplicate"
    | "gate"
    | "format"
    | "truncated";
  matcherCause?: MatcherCause;
  formatMessage?: string;
}): RejectionCause {
  switch (input.stage) {
    case "matcher":
      if (input.matcherCause === undefined) {
        // Unreachable: every matcher rejection site passes the splice cause.
        throw new Error('classifyRejection: stage "matcher" requires a matcherCause');
      }
      return input.matcherCause;
    case "format":
      // The splice duplicated a modifier the declaration already carried:
      // harness-side, not a model mistake (#56, defense-in-depth behind #48).
      return input.formatMessage?.includes(FORMAT_DUPLICATE_MODIFIER_SIGNATURE) === true
        ? "format-export-duplication"
        : "format";
    default:
      return input.stage;
  }
}

/**
 * Per-cause retry policy (#56): the correction sentence the next edit retry
 * carries, its escalation once the same cause repeats, or the terminal
 * harness-fault verdict. `repeat`/`duplicate` state that the resend cannot
 * change the file; `rejectionLead` renders the sentence and adds the #65
 * context (a no-op's pending failures, an undeclared address name).
 */
export type RejectionPolicy =
  | { action: "retry"; correction: string | null; escalation: string | null }
  | { action: "terminate"; reason: "harness-fault" };

const MATCHER_ESCALATION =
  'This attempt MUST omit "matcher" and return the complete declaration in "replacement".';

// #65 resend classes: `repeat` means the byte-identical payload was already
// submitted (applied and still failing, or rejected), `duplicate` means the
// candidate would add a second top-level copy of a declaration the file
// already carries. Either way the file already reflects the outcome, so the
// lead states that and forces the next attempt to differ — the rejected
// replacements themselves are never re-echoed into the prompt.
const REPEAT_CORRECTION =
  "That exact submission was already sent, and the file already reflects its outcome — the change is in place or nothing was written — so resending it cannot change anything. Change the target, the matcher, or the replacement so the next attempt actually differs and addresses the diagnostics below.";
const REPEAT_ESCALATION =
  "That exact submission has now been rejected repeatedly, and resending it cannot change the file. This attempt MUST differ from the previous attempts — a different target, matcher, or replacement form — and must address the diagnostics below.";
const DUPLICATE_CORRECTION =
  "The file already declares that symbol, so adding a second top-level copy cannot succeed. Change the replacement so it edits the existing declaration instead of adding another copy, and address the diagnostics below.";
const DUPLICATE_ESCALATION =
  "This edit keeps adding another top-level copy of a symbol the file already declares. This attempt MUST return a replacement that differs from the current source and edits the existing declaration instead of re-declaring it.";

// #65 no-op: the replacement equals the text it replaces, i.e. the intended
// change is already in the file. The sharpened lead says so and directs the
// next change at the pending failures; `rejectionLead` appends where they
// point when the round was opened by a failed verification.
const NOOP_CORRECTION =
  "The change you intend is already in the file: the replacement is identical to the text it replaces, so resending it would change nothing. Change a different part of the declaration — or a different declaration the diagnostics name — so the next edit actually differs from the current source.";
const NOOP_ESCALATION =
  "This attempt MUST stop re-proposing that change: it is already in the file, so nothing would change. Return a replacement that differs from the current source and directly addresses the diagnostics below.";
const NOOP_PENDING_POINTER = "The remaining failures still point at ";

// #65 address: a re-pin to a name the current source does not declare can never
// resolve. The wording keeps the add path open — the declaration must ride
// inside the replacement of an address that resolves, while mode "create"
// applies only while the run is still choosing a target — and never weakens the
// address guard.
function addressUndeclaredCorrection(name: string): string {
  const quoted = JSON.stringify(name);
  return `The current source declares no symbol named ${quoted}, so a re-pin to it can never resolve. Echo the pinned selection, or re-pin to a declaration the diagnostics name; to add that declaration, carry it inside the replacement of an address that resolves — mode "create" applies only while the run is still choosing a target.`;
}

function addressUndeclaredEscalation(name: string): string {
  const quoted = JSON.stringify(name);
  return `This attempt MUST return an address the current source resolves: echo the pinned address exactly as shown, or re-pin to a declaration the diagnostics name — ${quoted} is not declared, so re-pinning to it cannot succeed. To add that declaration, carry it inside the replacement of an address that resolves; mode "create" applies only while the run is still choosing a target.`;
}

/**
 * Context the dynamic #65 lead needs beyond the cause and its streak: the
 * verification diagnostics that opened the round (the no-op pointer) and the
 * name of an `address` rejection the current source does not declare.
 */
export interface RejectionLeadContext {
  /** Diagnostics that opened the round when a failed verification did (#65). */
  pendingDiagnostics?: string | null;
  /** The rejected address names a declaration the current source lacks (#65). */
  undeclaredName?: string;
}

/**
 * The lead sentence the next edit retry carries after a rejection (#56): the
 * cause's correction, or its escalation from the second consecutive rejection
 * of the same cause. `repeat`/`duplicate` stop resends (#65); a `no-op` names
 * the already-present effect and points at the pending failures; an undeclared
 * `address` keeps the add path open (#65). Null keeps the generic lead.
 */
export function rejectionLead(
  cause: RejectionCause,
  streak: number,
  context: RejectionLeadContext = {},
): string | null {
  const escalated = streak >= 2;
  if (cause === "no-op") {
    const policy = rejectionPolicy(cause);
    if (policy.action !== "retry") {
      return null;
    }
    const base = escalated ? policy.escalation : policy.correction;
    if (base === null) {
      return null;
    }
    const pending = context.pendingDiagnostics ?? null;
    return pending === null ? base : `${base} ${NOOP_PENDING_POINTER}${digestDetail(pending)}.`;
  }
  if (cause === "address" && context.undeclaredName !== undefined) {
    return escalated
      ? addressUndeclaredEscalation(context.undeclaredName)
      : addressUndeclaredCorrection(context.undeclaredName);
  }
  const policy = rejectionPolicy(cause);
  if (policy.action !== "retry" || policy.correction === null) {
    return null;
  }
  return escalated && policy.escalation !== null ? policy.escalation : policy.correction;
}

export function rejectionPolicy(cause: RejectionCause): RejectionPolicy {
  switch (cause) {
    case "format-export-duplication":
      return { action: "terminate", reason: "harness-fault" };
    case "repeat":
      return { action: "retry", correction: REPEAT_CORRECTION, escalation: REPEAT_ESCALATION };
    case "duplicate":
      return {
        action: "retry",
        correction: DUPLICATE_CORRECTION,
        escalation: DUPLICATE_ESCALATION,
      };
    case "protocol":
      return {
        action: "retry",
        correction:
          'Return exactly one flat JSON object with the five keys "path", "symbol", "kind", "matcher", "replacement", and no fences.',
        escalation:
          'This attempt MUST reply with exactly one flat JSON object carrying "path", "symbol", "kind", "matcher", and "replacement" as the entire response: no prose, no markdown fences, no nesting.',
      };
    case "echo":
      return {
        action: "retry",
        correction:
          "Echo the pinned address exactly as shown; re-pin only when the diagnostics name another declaration.",
        escalation:
          'This attempt MUST echo the pinned address exactly as shown — the same "path", "symbol", and "kind" values.',
      };
    case "address":
      return {
        action: "retry",
        correction:
          "Use an address that resolves to exactly one declaration: echo the pinned selection, or re-pin only to a declaration the diagnostics name.",
        escalation:
          "This attempt MUST echo the pinned address exactly as shown; the diagnostics name no other declaration to re-pin to.",
      };
    case "matcher-unparseable":
      return {
        action: "retry",
        correction:
          'Copy "matcher" verbatim from the current source as one complete statement, expression, or contiguous run of statements, or omit "matcher" for a whole-symbol rewrite.',
        escalation: MATCHER_ESCALATION,
      };
    case "matcher-not-found":
      return {
        action: "retry",
        correction:
          'Copy "matcher" verbatim from the current source, or omit "matcher" for a whole-symbol rewrite.',
        escalation: MATCHER_ESCALATION,
      };
    case "matcher-ambiguous":
      return {
        action: "retry",
        correction:
          'Extend "matcher" with more surrounding context copied from the current source, or omit "matcher" for a whole-symbol rewrite.',
        escalation: MATCHER_ESCALATION,
      };
    case "no-op":
      return {
        action: "retry",
        correction: NOOP_CORRECTION,
        escalation: NOOP_ESCALATION,
      };
    case "gate":
      return {
        action: "retry",
        correction:
          "Return a syntactically complete declaration so the file still parses after the splice.",
        escalation:
          "This attempt MUST return one syntactically complete declaration: no truncated bodies, no unbalanced delimiters, no stray fragments.",
      };
    case "format":
      return {
        action: "retry",
        correction:
          "Keep the declaration shape of the current source, including its existing leading modifiers.",
        escalation:
          "This attempt MUST reuse the current source's declaration shape exactly (the same leading modifiers) and change only the needed declaration text.",
      };
    case "truncated":
      return {
        action: "retry",
        correction: "Emit a shorter, more compact replacement that fits the output limit.",
        escalation:
          "This attempt MUST emit the smallest complete replacement: drop comments, collapse bodies, and keep it short.",
      };
    case "multi-protocol":
      return {
        action: "retry",
        correction:
          'Return either one flat edit object, or a {"payloads": [...]} object whose entries are flat edit objects, one per file.',
        escalation:
          'This attempt MUST return either exactly one flat {"path", "symbol", "kind", "matcher", "replacement"} object or a well-formed {"payloads": [ ... ]} batch: no other keys, no nesting beyond one array level.',
      };
    case "multi-duplicate":
      return {
        action: "retry",
        correction:
          "A multi-payload exchange carries at most one payload per file; target different files or split the edits across exchanges.",
        escalation:
          "This attempt MUST carry at most one payload per file: batch edits to different files only, and edit the same file again in a later exchange.",
      };
  }
}

/**
 * One v2 record row: a model exchange (pick, applied edit, or soft failure) or
 * a harness verification step (#43). Replaces the v1 `LoopAttempt`.
 */
export interface LoopRecord {
  /** 1-based row number in run order. */
  row: number;
  /** 1-based Run iteration this row belongs to. */
  iteration: number;
  kind: "exchange" | "verification";
  /** Exchange index inside the Run iteration (shared ≤3 budget); null for verification rows. */
  exchange: number | null;
  outcome: AttemptOutcome;
  locator: Locator;
  replacement: string | null;
  diagnostics: string | null;
  diagnosticsHead: string | null;
  replacementChars: number | null;
  finishReason: string | null;
  /** Payload objects the exchange carried (#69): 1 for a classic edit, N for a batch, 0 when none. */
  payloads?: number;
  /** Provider tool calls in the reply that produced this row (#69); 0 on verification rows. */
  toolCalls?: number;
  /** Verification rows: failure signature (tsc diagnostics + failing tests) observation (#36). */
  signature: number | null;
  /** Typed edit-rejection cause (#56); absent on success and verification rows. */
  cause?: RejectionCause;
}

/**
 * Per-run exchange diagnostics (#69): how many exchanges were rejected versus
 * applied, and how many payloads/tool calls the run's exchanges carried.
 */
export interface ExchangeStats {
  /** Exchange rows in the run. */
  turns: number;
  /** Payload objects carried across all exchange rows. */
  payloads: number;
  /** Provider tool calls across all exchange rows. */
  toolCalls: number;
  /** Exchange rows that applied an edit (`applied`). */
  applied: number;
  /** Exchange rows rejected before an apply, including `prev-broken`. */
  rejected: number;
  /** Exchange rows that pinned a target (`selected`). */
  selected: number;
  /** Exchange rows that ended the run with a `STOP` reply (`stopped`). */
  stopped: number;
}

/**
 * Fold a run's record rows into the rejected-vs-applied exchange counts (#69):
 * only exchange rows count; verification rows are harness steps.
 */
export function exchangeStats(records: readonly LoopRecord[]): ExchangeStats {
  const stats: ExchangeStats = {
    turns: 0,
    payloads: 0,
    toolCalls: 0,
    applied: 0,
    rejected: 0,
    selected: 0,
    stopped: 0,
  };
  for (const record of records) {
    if (record.kind !== "exchange") {
      continue;
    }
    stats.turns += 1;
    stats.payloads += record.payloads ?? 0;
    stats.toolCalls += record.toolCalls ?? 0;
    if (record.outcome === "applied") {
      stats.applied += 1;
    } else if (record.outcome === "selected") {
      stats.selected += 1;
    } else if (record.outcome === "stopped") {
      stats.stopped += 1;
    } else {
      stats.rejected += 1;
    }
  }
  return stats;
}

/**
 * v2 termination matrix (#43): a run ends through one of these, and each ends
 * with exactly one LLM-written summary as its final action.
 */
export type TerminationReason =
  | "token-budget"
  | "edit-exhausted"
  | "delete-verification-failed"
  | "prev-broken"
  | "harness-fault";

export interface LoopResult {
  ok: boolean;
  mode?: SelectionMode;
  locator: Locator | null;
  filePath: string | null;
  editedSource: string | null;
  records: LoopRecord[];
  diagnostics: string | null;
  explanation: string | null;
  messages: ChatMessage[];
  skipped?: SkippedFile[];
  /** Set when the run ended through the termination matrix; absent on success and provider errors. */
  terminationReason?: TerminationReason;
}

type Selection =
  | { mode: "modify"; locator: Locator; entry: IndexEntry }
  | { mode: "create"; locator: Locator; path: string }
  | { mode: "delete"; locator: Locator; entry: IndexEntry };

const EMPTY_LOCATOR: Locator = { path: "", name: "", kind: "" };
const DIAGNOSTICS_LIMIT = 4000;
const DIAGNOSTICS_HEAD_LIMIT = 200;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Tolerant provider usage reader (#36): prefer the reported total, fall back to
// prompt + completion when both are reported; unknown shapes count as zero.
function tokensFromResponse(response: ChatResponse): number {
  const usage = usageFromRaw(response.raw);
  if (typeof usage !== "object" || usage === null) {
    return 0;
  }
  const record = usage as Record<string, unknown>;
  const total = record["total_tokens"];
  if (typeof total === "number" && Number.isFinite(total)) {
    return total;
  }
  const prompt = record["prompt_tokens"];
  const completion = record["completion_tokens"];
  if (
    typeof prompt !== "number" ||
    !Number.isFinite(prompt) ||
    typeof completion !== "number" ||
    !Number.isFinite(completion)
  ) {
    return 0;
  }
  return prompt + completion;
}

function tokenBudgetDiagnostics(consumedTokens: number, tokenBudget: number): string {
  return `token-budget: accumulated ${consumedTokens} tokens exceeded the ${tokenBudget} token budget`;
}

function diagnosticsHeadOf(diagnostics: string | null): string | null {
  if (diagnostics === null) {
    return null;
  }
  const collapsed = diagnostics.replace(/\s+/g, " ").trim();
  return collapsed.length > DIAGNOSTICS_HEAD_LIMIT
    ? collapsed.slice(0, DIAGNOSTICS_HEAD_LIMIT)
    : collapsed;
}

function recordRow(input: {
  row: number;
  iteration: number;
  kind: "exchange" | "verification";
  exchange: number | null;
  locator: Locator;
  replacement: string | null;
  diagnostics: string | null;
  outcome: AttemptOutcome;
  finishReason: string | null;
  signature?: number | null;
  cause?: RejectionCause;
  /** Payload objects the exchange carried (#69); defaults 0. */
  payloads?: number;
  /** Provider tool calls in the reply (#69); defaults 0. */
  toolCalls?: number;
  /** Exact replacement size when it differs from `replacement.length` (batch sum, #69). */
  replacementChars?: number;
}): LoopRecord {
  return {
    row: input.row,
    iteration: input.iteration,
    kind: input.kind,
    exchange: input.exchange,
    outcome: input.outcome,
    locator: input.locator,
    replacement: input.replacement,
    diagnostics: input.diagnostics,
    diagnosticsHead: diagnosticsHeadOf(input.diagnostics),
    replacementChars:
      input.replacementChars ?? (input.replacement === null ? null : input.replacement.length),
    finishReason: input.finishReason,
    payloads: input.payloads ?? 0,
    toolCalls: input.toolCalls ?? 0,
    signature: input.signature ?? null,
    cause: input.cause,
  };
}

/**
 * Bounded, incrementally-updated prior-attempts digest (#57): the repair
 * chain's checkpoint. `updateAttemptDigest` reads only the records beyond the
 * cursor, and the rendered text goes to the #52 round-continuation prompts
 * and the #54 no-progress ask only — never to ordinary retries.
 */
export interface AttemptDigestState {
  /** Rendered entry lines retained under the bound, oldest first. */
  entries: string[];
  /** Per-class attempt counts; evicted attempts still count. */
  counts: Map<string, number>;
  /** Index into `records` of the next unprocessed row. */
  cursor: number;
  /** Failure attempts processed so far (attempt numbers are 1-based). */
  attempts: number;
  /** Entry lines evicted by the character bound. */
  dropped: number;
}

export function createAttemptDigestState(): AttemptDigestState {
  return { entries: [], counts: new Map(), cursor: 0, attempts: 0, dropped: 0 };
}

/** One digest detail line is truncated to this many characters, `…` included. */
const DIGEST_DETAIL_LIMIT = 90;
/** A class repeated this often earns a `Ruled out` line (#57). */
export const DIGEST_RULED_OUT_REPEATS = 3;
/** Hard cap on the rendered digest text (#57). */
export const DIGEST_MAX_CHARS = 1_200;
/** Concrete alternative for the tsc/tests verification classes (#57). */
const DIGEST_VERIFICATION_ALTERNATIVE =
  "change the declaration structure instead of re-editing the same spot";
/** Alternative for a class whose #56 policy offers no escalation text (#57). */
const DIGEST_FALLBACK_ALTERNATIVE =
  "take a materially different approach instead of repeating the same attempt";

/** Every typed rejection cause, for the runtime escalation lookup (#57). */
const REJECTION_CAUSES: ReadonlySet<string> = new Set<RejectionCause>([
  "protocol",
  "echo",
  "address",
  "matcher-unparseable",
  "matcher-not-found",
  "matcher-ambiguous",
  "no-op",
  "repeat",
  "duplicate",
  "gate",
  "format",
  "format-export-duplication",
  "truncated",
  "multi-protocol",
  "multi-duplicate",
]);

/**
 * Outcomes that are not failed attempts: successes and the terminating
 * `stopped` row never enter the digest (#57).
 */
const DIGEST_NON_FAILURES: ReadonlySet<AttemptOutcome> = new Set<AttemptOutcome>([
  "selected",
  "applied",
  "ok",
  "stopped",
]);

/**
 * Section labels name a bucket (or the position of a mapped diagnostic)
 * rather than a failure, so they are skipped when choosing the digest detail
 * (#57 follow-up). `codeFrame()` emits `  N | source` lines that quote the
 * replacement, so they must never win either.
 */
const DIGEST_SECTION_LABELS: ReadonlySet<string> = new Set([
  "elsewhere in file:",
  "typecheck failed:",
  "tests failed:",
  "failing tests:",
  "test output:",
]);
const DIGEST_REPLACEMENT_LABEL = /^replacement line \d+(?:, column \d+)?:$/;
const DIGEST_CODE_FRAME = /^\d+ \| /;

/** Collapse whitespace, trim, and truncate to `limit` characters (`…` included). */
function clampText(line: string, limit: number): string {
  const collapsed = line.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

function clampDigestDetail(line: string): string {
  return clampText(line, DIGEST_DETAIL_LIMIT);
}

// The digest keeps the most informative diagnostics line: the `stage: X`
// header names the rejection stage, section labels and code frames carry no
// failure text, and quoted replacement source must never leak into the
// checkpoint (#57; detail selection refined in the follow-up).
function digestDetail(diagnostics: string): string {
  const lines = diagnostics.split("\n").map((line) => line.trim());
  // (a) A tsc error line is always the most informative: raw
  // `file(line,column): error TSxxxx:` lines and mapped diagnostics whose
  // message spells out `error TS`. Code frames stay excluded so a source
  // line that happens to quote an error never wins.
  for (const line of lines) {
    if (line.includes("error TS") && !DIGEST_CODE_FRAME.test(line)) {
      return clampDigestDetail(line);
    }
  }
  // (b) Otherwise the first line that is neither a label nor a code frame.
  for (const line of lines) {
    if (line === "" || line.startsWith("stage: ") || DIGEST_CODE_FRAME.test(line)) {
      continue;
    }
    if (DIGEST_SECTION_LABELS.has(line) || DIGEST_REPLACEMENT_LABEL.test(line)) {
      continue;
    }
    return clampDigestDetail(line);
  }
  // (c) Diagnostics made only of labels and code frames keep the previous
  // behavior: the first non-`stage: ` line, else the raw first line.
  for (const line of lines) {
    if (line !== "" && !line.startsWith("stage: ")) {
      return clampDigestDetail(line);
    }
  }
  return clampDigestDetail(lines[0] ?? "");
}

// Reuse the #56 escalation text for rejection causes; tsc/tests get a fixed
// concrete sentence (#57).
function digestAlternative(className: string): string {
  if (className === "tsc" || className === "tests") {
    return DIGEST_VERIFICATION_ALTERNATIVE;
  }
  if (REJECTION_CAUSES.has(className)) {
    const policy = rejectionPolicy(className as RejectionCause);
    if (policy.action === "retry" && policy.escalation !== null) {
      return policy.escalation;
    }
  }
  return DIGEST_FALLBACK_ALTERNATIVE;
}

// One `Ruled out` line per class repeated at least DIGEST_RULED_OUT_REPEATS
// times (#57): most-repeated first, then by class name, so the block is
// deterministic.
function digestRuledOutLines(counts: ReadonlyMap<string, number>): string[] {
  return [...counts.entries()]
    .filter(([, count]) => count >= DIGEST_RULED_OUT_REPEATS)
    .sort((left, right) => right[1] - left[1] || comparePaths(left[0], right[0]))
    .map(
      ([className, count]) =>
        `Ruled out after ${count} repeats: ${className} — ${digestAlternative(className)}`,
    );
}

/**
 * Advance the digest over the records beyond its cursor (#57): each failure
 * row appends `- #<attempt> <class>: <detail>` and bumps its class count.
 * Success rows and the terminating `stopped` row are skipped.
 */
export function updateAttemptDigest(
  state: AttemptDigestState,
  records: readonly LoopRecord[],
): void {
  while (state.cursor < records.length) {
    const record = records[state.cursor];
    state.cursor += 1;
    if (
      record === undefined ||
      record.diagnostics === null ||
      DIGEST_NON_FAILURES.has(record.outcome)
    ) {
      continue;
    }
    state.attempts += 1;
    const className = record.cause ?? record.outcome;
    state.entries.push(`- #${state.attempts} ${className}: ${digestDetail(record.diagnostics)}`);
    state.counts.set(className, (state.counts.get(className) ?? 0) + 1);
  }
}

/**
 * Render the bounded digest (#57). The header, the omitted-entries line, and
 * the ruled-out block are reserved first; the oldest retained entries are then
 * evicted (bumping `dropped` and keeping the omitted line accurate) until the
 * text fits `DIGEST_MAX_CHARS`. Class counts keep every processed attempt,
 * including evicted ones.
 */
export function renderAttemptDigest(state: AttemptDigestState): string {
  const header = `Prior attempts (${state.attempts}):`;
  const ruledOut = digestRuledOutLines(state.counts);
  for (;;) {
    const omitted = state.dropped === 0 ? [] : [`- (${state.dropped} earlier attempts omitted)`];
    const text = [header, ...omitted, ...state.entries, ...ruledOut].join("\n");
    if (text.length <= DIGEST_MAX_CHARS) {
      return text;
    }
    if (state.entries.length > 0) {
      state.entries.shift();
      state.dropped += 1;
      continue;
    }
    // Defensive: a pathological chain can make the reserved ruled-out block
    // alone exceed the bound; drop the least-repeated classes until it fits.
    if (ruledOut.length > 0) {
      ruledOut.pop();
      continue;
    }
    return text;
  }
}

/** Failed verifications the failure-history walk looks back over (#71). */
export const FAILURE_HISTORY_LOOKBACK = 8;
/** One named state in the alternating note is clamped to this many characters. */
export const FAILURE_STATE_LIMIT = 110;

/** One `TSxxxx` error sentence, kept to the first `[^.]*` sentence (#71). */
const TS_ERROR_SENTENCE = /TS\d+:\s*[^.]*\./g;

/** Non-convergence of the trailing failed verifications (#71). */
export type FailurePattern =
  | { kind: "unchanged"; rounds: number }
  | { kind: "alternating"; rounds: number; a: string; b: string };

/**
 * The normalized identity of one failed verification (#71): every `TSxxxx`
 * error code with its first message sentence, whitespace collapsed, position
 * fragments (`(12,5)`) and `line 12` fragments stripped, de-duplicated and
 * sorted so the fingerprint is order-insensitive. Diagnostics without a
 * `TSxxxx` match fall back to the digest's detail selection (clamped); `""`
 * means nothing informative. Never throws.
 */
export function verificationFingerprint(diagnostics: string): string {
  try {
    const matches = diagnostics.match(TS_ERROR_SENTENCE);
    if (matches === null || matches.length === 0) {
      return clampDigestDetail(digestDetail(diagnostics));
    }
    const sentences = new Set<string>();
    for (const match of matches) {
      sentences.add(
        match
          .replace(/\(\d+,\d+\)/g, "")
          .replace(/line \d+/g, "line")
          .replace(/\s+/g, " ")
          .trim(),
      );
    }
    return [...sentences].sort().join(" | ");
  } catch {
    return "";
  }
}

/**
 * Detect a non-converging failing set in the trailing failed verifications
 * (#71): `unchanged` when the newest fingerprint repeats across >= 3
 * consecutive rounds, `alternating` when the newest fingerprints form a strict
 * ABAB cycle of >= 4 rounds (counted maximally back). The walk stops at the
 * first passed verification (chain reset) and looks back at most
 * `FAILURE_HISTORY_LOOKBACK` fingerprints; empty fingerprints never match and
 * are skipped. Returns null while failures still change.
 */
export function detectFailurePattern(records: readonly LoopRecord[]): FailurePattern | null {
  const fingerprints: string[] = [];
  for (
    let index = records.length - 1;
    index >= 0 && fingerprints.length < FAILURE_HISTORY_LOOKBACK;
    index -= 1
  ) {
    const record = records[index];
    if (record === undefined || record.kind !== "verification") {
      continue;
    }
    if (record.outcome === "ok") {
      break;
    }
    if (record.diagnostics === null) {
      continue;
    }
    const fingerprint = verificationFingerprint(record.diagnostics);
    if (fingerprint === "") {
      continue;
    }
    fingerprints.push(fingerprint);
  }
  const newest = fingerprints[0];
  if (newest === undefined) {
    return null;
  }
  let unchangedRounds = 0;
  while (unchangedRounds < fingerprints.length && fingerprints[unchangedRounds] === newest) {
    unchangedRounds += 1;
  }
  if (unchangedRounds >= 3) {
    return { kind: "unchanged", rounds: unchangedRounds };
  }
  const previous = fingerprints[1];
  if (previous === undefined || previous === newest) {
    return null;
  }
  let alternatingRounds = 0;
  while (
    alternatingRounds < fingerprints.length &&
    fingerprints[alternatingRounds] === (alternatingRounds % 2 === 0 ? newest : previous)
  ) {
    alternatingRounds += 1;
  }
  return alternatingRounds >= 4
    ? { kind: "alternating", rounds: alternatingRounds, a: newest, b: previous }
    : null;
}

/**
 * Render the bounded `Failure history` note (#71) for a detected pattern: one
 * line when the failing set is unchanged, or the two alternating states
 * (clamped to `FAILURE_STATE_LIMIT`) when the chain is cycling. Null renders
 * nothing. The states derive from `verificationFingerprint` (diagnostics
 * only), so no replacement source can leak into the note.
 */
export function renderFailureHistoryNote(pattern: FailurePattern | null): string {
  if (pattern === null) {
    return "";
  }
  if (pattern.kind === "unchanged") {
    return `Failure history: the failing set is unchanged across the last ${pattern.rounds} verification rounds.`;
  }
  return [
    `Failure history: the failing set has cycled between two states across the last ${pattern.rounds} verification rounds; local edits have flipped between them instead of converging:`,
    `- ${clampText(pattern.a, FAILURE_STATE_LIMIT)}`,
    `- ${clampText(pattern.b, FAILURE_STATE_LIMIT)}`,
  ].join("\n");
}

function sourceFileFor(files: SourceFile[], path: string): SourceFile {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`no source file ${path}`);
  }
  return file;
}

function safeAppendPath(cwd: string, path: string): string | null {
  if (path === "" || isAbsolute(path)) {
    return null;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "..")) {
    return null;
  }
  const directories = segments.slice(0, -1).filter((segment) => segment !== ".");
  if (directories.some((segment) => segment.startsWith(".") || SKIPPED_DIRECTORIES.has(segment))) {
    return null;
  }
  const root = resolve(cwd);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return null;
  }
  const stats = statSync(target, { throwIfNoEntry: false });
  if (stats !== undefined && !stats.isFile()) {
    return null;
  }
  return path;
}

function readFileIfExists(path: string): string | null {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile()) {
    return null;
  }
  return readFileSync(path, "utf8");
}

function appendText(existing: string, replacement: string): string {
  const body = replacement.trim();
  if (existing.trim() === "") {
    return `${body}\n`;
  }
  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${base}\n${body}\n`;
}

function writeTarget(cwd: string, path: string, source: string): void {
  const target = join(cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

const ADDRESS_CANDIDATE_LIMIT = 5;

function lineColumnAt(source: string, offset: number): { line: number; column: number } {
  const limit = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < limit; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: limit - lineStart + 1 };
}

function describeEntry(entry: IndexEntry, sourceByPath: ReadonlyMap<string, string>): string {
  const source = sourceByPath.get(entry.locator.path) ?? "";
  const { line, column } = lineColumnAt(source, entry.node.start);
  return `${entry.locator.path}: ${entry.locator.kind} ${JSON.stringify(entry.locator.name)} (line ${line}, column ${column})`;
}

function candidateLines(
  entries: readonly IndexEntry[],
  sourceByPath: ReadonlyMap<string, string>,
): string[] {
  const lines = entries
    .slice(0, ADDRESS_CANDIDATE_LIMIT)
    .map((entry) => `  - ${describeEntry(entry, sourceByPath)}`);
  if (entries.length > ADDRESS_CANDIDATE_LIMIT) {
    lines.push(`  ... ${entries.length - ADDRESS_CANDIDATE_LIMIT} more`);
  }
  return lines;
}

// Address diagnostics name where the symbol actually exists (path + kind +
// position) and, for a same-path kind mismatch, say which kind to use.
function addressMissDiagnostics(
  locator: Locator,
  byName: readonly IndexEntry[],
  sourceByPath: ReadonlyMap<string, string>,
): string {
  const lines = [
    "stage: address",
    `no symbol with kind ${JSON.stringify(locator.kind)} named ${JSON.stringify(locator.name)} in ${JSON.stringify(locator.path)}`,
  ];
  if (byName.length === 0) {
    lines.push(
      `the name ${JSON.stringify(locator.name)} is not declared in the indexed source; correct the address or use mode "create" to add it`,
    );
    return lines.join("\n");
  }
  lines.push(`the name ${JSON.stringify(locator.name)} exists at:`);
  lines.push(...candidateLines(byName, sourceByPath));
  const kinds = [
    ...new Set(
      byName
        .filter((entry) => entry.locator.path === locator.path)
        .map((entry) => entry.locator.kind),
    ),
  ];
  if (kinds.length > 0) {
    lines.push(
      `in ${JSON.stringify(locator.path)} the name exists as ${kinds.map((kind) => JSON.stringify(kind)).join(", ")}; change "kind" to match`,
    );
  }
  return lines.join("\n");
}

function addressAmbiguousDiagnostics(
  locator: Locator,
  matches: readonly IndexEntry[],
  sourceByPath: ReadonlyMap<string, string>,
): string {
  return [
    "stage: address",
    `the address ${addressJson(locator)} matches ${matches.length} declarations; the harness never picks one silently`,
    ...candidateLines(matches, sourceByPath),
    "correct the address (path/symbol/kind) so it matches exactly one declaration",
  ].join("\n");
}

type CurrentEntryResolution =
  | { ok: true; entry: IndexEntry }
  | { ok: false; diagnostics: string; undeclared: boolean };

// Strict-AND resolution of one locator against the current source that would be
// spliced: no silent first-match pick, no kind coercion, no auto-append.
function resolveCurrentEntry(
  sourceBefore: string,
  target: string,
  locator: Locator,
): CurrentEntryResolution {
  const currentBuild = buildIndexTolerant([{ path: target, source: sourceBefore }]);
  const matches = currentBuild.index.lookup(locator);
  const sources = new Map([[target, sourceBefore]]);
  if (matches.length === 0) {
    // `undeclared` (#65): the name is absent under every kind, so the
    // diagnostics suggest mode "create" — the retry lead keeps that add path
    // open instead of demanding an impossible re-pin.
    const byName = currentBuild.index.byName(locator.name);
    return {
      ok: false,
      diagnostics: addressMissDiagnostics(locator, byName, sources),
      undeclared: byName.length === 0,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      diagnostics: addressAmbiguousDiagnostics(locator, matches, sources),
      undeclared: false,
    };
  }
  const entry = matches[0];
  if (entry === undefined) {
    // Unreachable: matches.length is exactly one here.
    return {
      ok: false,
      diagnostics: addressMissDiagnostics(locator, [], sources),
      undeclared: true,
    };
  }
  return { ok: true, entry };
}

type EntrySpliceCause = MatcherCause | "no-op";

type EntrySplice =
  | { ok: true; candidate: string; gateStart: number }
  | { ok: false; cause: EntrySpliceCause; diagnostics: string };

// #59: an edit whose final spliced candidate is byte-identical to the current
// source cannot change anything; it is rejected before the syntax/format gate
// and verification instead of consuming a verification round-trip.
const NOOP_DIAGNOSTICS =
  "stage: no-op\nthe edit does not change the file: the replacement is identical to the text it replaces; change the code so the diagnostics are actually addressed";

// Formatter-normalized no-op (#59 follow-up): the byte comparison in
// `spliceEntryEdit` cannot see a replacement that re-includes the matched
// span's copied leading indentation, which the format gate normalizes away.
// `formattedCandidate` is the format gate's output; the on-disk source is not
// assumed canonical (a run can start from an unformatted file), so a
// non-byte-equal candidate formats the source once and compares canonical
// forms. Only a provable match rejects; an unformattable baseline applies.
async function sameAfterFormatting(
  target: string,
  sourceBefore: string,
  formattedCandidate: string,
): Promise<boolean> {
  if (formattedCandidate === sourceBefore) {
    return true;
  }
  try {
    return (await formatSource(target, sourceBefore)) === formattedCandidate;
  } catch {
    return false;
  }
}

// The indexed node range excludes a wrapping `export`; a matcher or a
// whole-symbol replacement that still carries the declaration's existing
// modifier is tolerated, with any whitespace after `export`, and keeps exactly
// one copy (#48, #50). Comment text between `export` and the declaration is
// deliberately not recognized: that shape still duplicates the modifier, is
// classified as a harness-side format fault, and exits through the fast path.
const EXPORT_PATTERN = /^export\s+/;
const EXPORT_DEFAULT_PATTERN = /^export\s+default\s+/;
const EXPORT_DEFAULT_MODIFIER_PATTERN = /^export\s+default\s+$/;
const RELOCATION_CANDIDATE_LIMIT = 2;

function precedingExportModifier(sourceBefore: string, entry: IndexEntry): string | null {
  return (
    /(export\s+default\s+|export\s+)$/.exec(sourceBefore.slice(0, entry.node.start))?.[0] ?? null
  );
}

function stripLeadingExport(replacement: string, modifier: string | null): string {
  if (modifier === null) {
    return replacement;
  }
  if (EXPORT_DEFAULT_MODIFIER_PATTERN.test(modifier)) {
    const stripped = replacement.replace(EXPORT_DEFAULT_PATTERN, "");
    if (stripped !== replacement) {
      return stripped;
    }
  }
  return replacement.replace(EXPORT_PATTERN, "");
}

// One anchor attempt with the leading-`export` tolerance: strip once, only at
// the very start, and only when the declaration already has a modifier.
function findAnchorWithModifier(
  sourceBefore: string,
  node: Node,
  matcher: string,
  modifier: string | null,
): AnchorResult {
  const anchored = findAnchor(sourceBefore, node, matcher);
  if ((anchored.kind === "not-found" || anchored.kind === "unparseable") && modifier !== null) {
    if (EXPORT_DEFAULT_MODIFIER_PATTERN.test(modifier) && EXPORT_DEFAULT_PATTERN.test(matcher)) {
      return findAnchor(sourceBefore, node, matcher.replace(EXPORT_DEFAULT_PATTERN, ""));
    }
    if (EXPORT_PATTERN.test(matcher)) {
      return findAnchor(sourceBefore, node, matcher.replace(EXPORT_PATTERN, ""));
    }
  }
  return anchored;
}

// A not-found matcher may actually belong to a different declaration of the
// same file; when a candidate matches (up to two are named), the diagnostic
// says which address would re-pin to it (#48).
function relocationNote(
  sourceBefore: string,
  target: string,
  entry: IndexEntry,
  matcher: string,
): string | null {
  const index = buildIndexTolerant([{ path: target, source: sourceBefore }]).index;
  const matches: IndexEntry[] = [];
  for (const candidate of index.entries) {
    const overlaps = candidate.node.start < entry.node.end && entry.node.start < candidate.node.end;
    if (overlaps) {
      continue;
    }
    // Each candidate carries its own preceding modifier, not the pinned one.
    const anchored = findAnchorWithModifier(
      sourceBefore,
      candidate.node,
      matcher,
      precedingExportModifier(sourceBefore, candidate),
    );
    if (anchored.kind !== "match") {
      continue;
    }
    matches.push(candidate);
    if (matches.length >= RELOCATION_CANDIDATE_LIMIT) {
      break;
    }
  }
  if (matches.length === 0) {
    return null;
  }
  if (matches.length === 1) {
    const candidate = matches[0];
    if (candidate === undefined) {
      return null; // Unreachable: matches.length is exactly one here.
    }
    return `note: the same snippet matches inside ${candidate.locator.kind} ${JSON.stringify(candidate.locator.name)} in ${candidate.locator.path} — if that is the intended target, return ${addressJson(candidate.locator)} to re-pin`;
  }
  const described = matches.map(
    (candidate) =>
      `${candidate.locator.kind} ${JSON.stringify(candidate.locator.name)} in ${candidate.locator.path}`,
  );
  return `note: the same snippet matches inside ${described.join(" and ")} — return the intended declaration's own {path, symbol, kind} to re-pin`;
}

// Apply one edit to an already-resolved entry: omitted matcher = whole-symbol
// rewrite, otherwise the single structural match inside the entry. Shared by
// the pinned modify branch and verification-repair re-pins (#48).
function spliceEntryEdit(
  sourceBefore: string,
  target: string,
  locator: Locator,
  entry: IndexEntry,
  matcher: string | null,
  replacement: string,
): EntrySplice {
  const modifier = precedingExportModifier(sourceBefore, entry);
  if (matcher === null) {
    const candidate = applyAnchorSplice(
      sourceBefore,
      entry.node.start,
      entry.node.end,
      stripLeadingExport(replacement, modifier),
    );
    if (candidate === sourceBefore) {
      return { ok: false, cause: "no-op", diagnostics: NOOP_DIAGNOSTICS };
    }
    return { ok: true, candidate, gateStart: entry.node.start };
  }
  const anchored = findAnchorWithModifier(sourceBefore, entry.node, matcher, modifier);
  if (anchored.kind === "unparseable") {
    return {
      ok: false,
      cause: "matcher-unparseable",
      diagnostics: `stage: matcher\nthe matcher could not be parsed as TypeScript: ${anchored.message}; a matcher must be a single copied statement or expression, or a contiguous run of statements copied from one block; omitting "matcher" gives a whole-symbol rewrite`,
    };
  }
  if (anchored.kind === "not-found") {
    const { line, column } = lineColumnAt(sourceBefore, entry.node.start);
    const base = `stage: matcher\nthe matcher was not found inside ${locator.kind} ${JSON.stringify(locator.name)} in ${target} (line ${line}, column ${column}); copy a complete snippet from the current source, or omit "matcher" for a whole-symbol rewrite`;
    const note = relocationNote(sourceBefore, target, entry, matcher);
    return {
      ok: false,
      cause: "matcher-not-found",
      diagnostics: note === null ? base : `${base}\n${note}`,
    };
  }
  if (anchored.kind === "ambiguous") {
    const { line, column } = lineColumnAt(sourceBefore, entry.node.start);
    return {
      ok: false,
      cause: "matcher-ambiguous",
      diagnostics: `stage: matcher\nthe matcher matches ${anchored.matches} places inside ${locator.kind} ${JSON.stringify(locator.name)} in ${target} (line ${line}, column ${column}); extend it with more surrounding context`,
    };
  }
  // A match over the whole declaration gets the same modifier tolerance as a
  // whole-symbol rewrite; a body-level match must not strip (#48).
  const spliced =
    modifier !== null && anchored.start === entry.node.start
      ? stripLeadingExport(replacement, modifier)
      : replacement;
  const candidate = applyAnchorSplice(sourceBefore, anchored.start, anchored.end, spliced);
  if (candidate === sourceBefore) {
    return { ok: false, cause: "no-op", diagnostics: NOOP_DIAGNOSTICS };
  }
  return {
    ok: true,
    candidate,
    gateStart: anchored.start,
  };
}

/** Splice outcome of one modify payload against its own file source (#69). */
type PayloadSplice =
  | { ok: true; entry: IndexEntry; candidate: string; gateStart: number }
  | {
      ok: false;
      stage: "address" | "matcher" | "no-op";
      diagnostics: string;
      matcherCause?: MatcherCause;
      undeclaredName?: string | null;
    };

// Resolve one modify payload against the source that would be spliced and
// splice it: strict-AND address resolution, then the matcher/no-op rules.
// Shared by the pinned first payload and each self-addressed batch payload
// (#69); the caller owns the echo/re-pin policy.
function splicePayloadAtSource(
  sourceBefore: string,
  target: string,
  payload: EditPayload,
): PayloadSplice {
  const resolved = resolveCurrentEntry(sourceBefore, target, payload.locator);
  if (!resolved.ok) {
    return {
      ok: false,
      stage: "address",
      diagnostics: resolved.diagnostics,
      undeclaredName: resolved.undeclared ? payload.locator.name : null,
    };
  }
  const spliced = spliceEntryEdit(
    sourceBefore,
    target,
    payload.locator,
    resolved.entry,
    payload.matcher,
    payload.replacement,
  );
  if (spliced.ok) {
    return {
      ok: true,
      entry: resolved.entry,
      candidate: spliced.candidate,
      gateStart: spliced.gateStart,
    };
  }
  if (spliced.cause === "no-op") {
    return { ok: false, stage: "no-op", diagnostics: spliced.diagnostics };
  }
  return {
    ok: false,
    stage: "matcher",
    diagnostics: spliced.diagnostics,
    matcherCause: spliced.cause,
  };
}

// One failing payload block inside a rejected batch (#69): names its position,
// own address, and its own staged diagnostics; the whole exchange is atomic.
function multiPayloadDiagnostics(
  index: number,
  total: number,
  path: string,
  locator: Locator,
  diagnostics: string,
): string {
  return [
    "stage: multi",
    `payload ${index} of ${total} (${addressJson(locator)} in ${JSON.stringify(path)}) failed; the whole exchange is discarded and nothing is written`,
    diagnostics,
  ].join("\n");
}

function createExistsDiagnostics(
  locator: Locator,
  existing: readonly IndexEntry[],
  sourceByPath: ReadonlyMap<string, string>,
): string {
  const kinds = [...new Set(existing.map((entry) => entry.locator.kind))];
  return [
    "stage: address",
    `the name ${JSON.stringify(locator.name)} already exists in ${JSON.stringify(locator.path)} as ${kinds
      .map((kind) => JSON.stringify(kind))
      .join(", ")}; use mode "modify" to change it instead of "create"`,
    ...candidateLines(existing, sourceByPath),
  ].join("\n");
}

interface ParseFailure {
  message: string;
  offset: number;
  line: number;
  column: number;
}

type ParseCheck = { ok: true; program: Program } | { ok: false; failure: ParseFailure };

function parseCheck(source: string): ParseCheck {
  try {
    return { ok: true, program: new Parser(source).parseProgram() };
  } catch (error) {
    if (error instanceof ParseError || error instanceof LexError) {
      return {
        ok: false,
        failure: {
          message: error.message,
          offset: error.offset,
          line: error.line,
          column: error.column,
        },
      };
    }
    throw error;
  }
}

function prevBrokenDiagnostics(path: string, failure: ParseFailure): string {
  return [
    "stage: prev-broken",
    `the current source of ${JSON.stringify(path)} does not parse; this is external modification or a harness bug, so the run stops instead of repairing silently`,
    `${failure.message} (line ${failure.line}, column ${failure.column})`,
  ].join("\n");
}

/** Top-level declaration kinds TypeScript rejects when duplicated (#48). */
type DuplicateKind = "function" | "class" | "type";

interface TopLevelDeclaration {
  kind: DuplicateKind;
  name: string;
  offset: number;
}

// Counts the top-level declarations TypeScript rejects on duplicates: bodyful
// functions, classes, and type aliases. Overload signatures (bodyless) and
// interfaces/namespaces are deliberately not counted (#48).
function topLevelDeclarations(program: Program): TopLevelDeclaration[] {
  const declarations: TopLevelDeclaration[] = [];
  const collect = (statement: Statement | Expression): void => {
    switch (statement.kind) {
      case "FunctionDeclaration":
        if (statement.name !== null && statement.body !== null) {
          declarations.push({
            kind: "function",
            name: statement.name.name,
            offset: statement.start,
          });
        }
        return;
      case "ClassDeclaration":
        if (statement.name !== null) {
          declarations.push({ kind: "class", name: statement.name.name, offset: statement.start });
        }
        return;
      case "TypeAliasDeclaration":
        declarations.push({ kind: "type", name: statement.name.name, offset: statement.start });
        return;
      case "ExportNamedDeclaration":
        if (statement.declaration !== null) {
          collect(statement.declaration);
        }
        return;
      case "ExportDefaultDeclaration":
        collect(statement.declaration);
        return;
      default:
        return;
    }
  };
  for (const statement of program.body) {
    collect(statement);
  }
  return declarations;
}

// Duplicate-declaration guard (#48): reject a candidate that raises the
// top-level count of a (kind, name) TypeScript rejects on duplicates, naming
// the existing declaration.
function duplicateDeclarationDiagnostics(
  sourceBefore: string,
  target: string,
  before: Program,
  after: Program,
): string | null {
  const existing = topLevelDeclarations(before);
  const counts = new Map<string, number>();
  for (const declaration of existing) {
    const key = `${declaration.kind}:${declaration.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const declaration of topLevelDeclarations(after)) {
    const key = `${declaration.kind}:${declaration.name}`;
    const occurrences = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrences);
    const beforeCount = counts.get(key) ?? 0;
    // A name the file did not declare is a new declaration, not a duplicate.
    if (beforeCount === 0 || occurrences <= beforeCount) {
      continue;
    }
    const first = existing.find(
      (candidate) => candidate.kind === declaration.kind && candidate.name === declaration.name,
    );
    const offset = first === undefined ? declaration.offset : first.offset;
    const line = lineColumnAt(sourceBefore, offset).line;
    return [
      "stage: duplicate",
      `the edit was discarded: it would add a second top-level ${declaration.kind} ${JSON.stringify(declaration.name)} (${target} already declares it at line ${line}); replace the existing declaration instead of adding another copy`,
    ].join("\n");
  }
  return null;
}

// Map a gate parse error into the replacement when it falls inside the spliced
// range, so the model can see which part of its own text broke the file.
function gateDiagnostics(spliceStart: number, replacement: string, failure: ParseFailure): string {
  const lines = [
    "stage: gate",
    "the edit was discarded because the resulting source does not parse; nothing was written",
    `${failure.message} (line ${failure.line}, column ${failure.column})`,
  ];
  if (failure.offset >= spliceStart && failure.offset <= spliceStart + replacement.length) {
    const { line, column } = lineColumnAt(replacement, failure.offset - spliceStart);
    lines.push(`replacement line ${line}, column ${column}:`);
    lines.push(...codeFrame(toLines(replacement), line));
  }
  return lines.join("\n");
}

// The index node excludes a wrapping `export`; deleting an exported
// declaration should not leave a dangling `export` keyword behind.
function deleteRange(program: Program, node: Node): { start: number; end: number } {
  for (const statement of program.body) {
    if (
      statement.kind !== "ExportNamedDeclaration" &&
      statement.kind !== "ExportDefaultDeclaration"
    ) {
      continue;
    }
    const declaration = statement.declaration;
    if (declaration !== null && declaration.start === node.start && declaration.end === node.end) {
      return { start: statement.start, end: statement.end };
    }
  }
  return { start: node.start, end: node.end };
}

interface DeletionInput {
  options: LoopOptions;
  provider: ProviderLike;
  temperature: number | undefined;
  targetPath: string;
  locator: Locator;
  node: Node;
  /** Run-start source of the target file. */
  baseSource: string;
  messages: ChatMessage[];
  records: LoopRecord[];
  skipped?: SkippedFile[];
  iteration: number;
}

// `delete` carries no edit payload: Edit only picks the target (one exchange),
// the harness splices the resolved declaration out (range expanded to a
// wrapping `export`) and runs the syntax gate, format, write, and verification
// once. Any failure ends the run through the termination matrix (#43): a broken
// `prev` is `prev-broken`, a gate/format/tsc/test failure is
// `delete-verification-failed` — each with exactly one summary call.
async function executeDeletion(input: DeletionInput): Promise<LoopResult> {
  const { cwd } = input.options;
  const { targetPath, locator, node, baseSource } = input;
  const fail = async (
    reason: TerminationReason,
    diagnostics: string,
    outcome: VerificationOutcome,
    signature: number | null = null,
  ): Promise<LoopResult> => {
    input.records.push(
      recordRow({
        row: input.records.length + 1,
        iteration: input.iteration,
        kind: "verification",
        exchange: null,
        locator,
        replacement: "",
        diagnostics,
        outcome,
        finishReason: null,
        signature,
      }),
    );
    return {
      ok: false,
      mode: "delete",
      locator,
      filePath: targetPath,
      editedSource: null,
      records: input.records,
      diagnostics,
      explanation: await explain(
        input.provider,
        input.messages,
        input.temperature,
        reason,
        diagnostics,
      ),
      messages: input.messages,
      skipped: input.skipped,
      terminationReason: reason,
    };
  };
  const prevCheck = parseCheck(baseSource);
  if (!prevCheck.ok) {
    return await fail(
      "prev-broken",
      prevBrokenDiagnostics(targetPath, prevCheck.failure),
      "prev-broken",
    );
  }
  const range = deleteRange(prevCheck.program, node);
  const spliced = applyAnchorSplice(baseSource, range.start, range.end, "");
  const gate = parseCheck(spliced);
  if (!gate.ok) {
    return await fail(
      "delete-verification-failed",
      gateDiagnostics(range.start, "", gate.failure),
      "gate",
    );
  }
  let newSource: string;
  try {
    newSource = await formatSource(targetPath, spliced);
  } catch (error) {
    return await fail(
      "delete-verification-failed",
      `stage: format\n${errorMessage(error)}`,
      "format",
    );
  }
  writeTarget(cwd, targetPath, newSource);
  const check = await checkTool(cwd, input.options.checkCommand, input.options.commandTimeoutMs);
  const test = await runVerificationTests(cwd, targetPath, input.options);
  if (check.ok && test.ok) {
    input.records.push(
      recordRow({
        row: input.records.length + 1,
        iteration: input.iteration,
        kind: "verification",
        exchange: null,
        locator,
        replacement: "",
        diagnostics: null,
        outcome: "ok",
        finishReason: null,
      }),
    );
    return {
      ok: true,
      mode: "delete",
      locator,
      filePath: targetPath,
      editedSource: newSource,
      records: input.records,
      diagnostics: null,
      explanation: null,
      messages: input.messages,
      skipped: input.skipped,
    };
  }
  const diagnostics = formatDiagnostics({
    check,
    test,
    targetPath,
    baseSource,
    newSource,
  });
  const signature = check.diagnostics.length + failingTestNames(test.output).length;
  return await fail(
    "delete-verification-failed",
    diagnostics,
    check.ok ? "tests" : "tsc",
    signature,
  );
}

// Re-resolve the address against the current on-disk source so retry prompts
// show what is actually there; fall back to the whole file when it no longer
// resolves to exactly one entry (for example after a corrupting attempt).
function currentSourceForPrompt(
  mode: "modify" | "create",
  targetPath: string,
  locator: Locator,
  currentSource: string,
): string {
  if (mode === "modify") {
    const build = buildIndexTolerant([{ path: targetPath, source: currentSource }]);
    const matches = build.index.lookup(locator);
    const entry = matches.length === 1 ? matches[0] : undefined;
    if (entry !== undefined) {
      return currentSource.slice(entry.node.start, entry.node.end);
    }
  }
  return currentSource;
}

// Run the sibling test file first for fast feedback; a targeted failure is the
// test verdict, otherwise the full suite still gates it.
async function runVerificationTests(
  cwd: string,
  targetPath: string,
  options: LoopOptions,
): Promise<CommandResult> {
  const command = options.testCommand ?? ["bun", "test"];
  if (targetPath.endsWith(".ts") && !targetPath.endsWith(TEST_FILE_SUFFIX)) {
    const sibling = `${targetPath.slice(0, -".ts".length)}${TEST_FILE_SUFFIX}`;
    if (existsSync(join(cwd, sibling))) {
      const targeted = await testTool(cwd, [...command, sibling], options.commandTimeoutMs);
      if (!targeted.ok) {
        return targeted;
      }
    }
  }
  return testTool(cwd, command, options.commandTimeoutMs);
}

export interface DiagnosticsInput {
  check: CommandResult & { diagnostics: CheckDiagnostic[] };
  test: CommandResult;
  /** Repo-relative path of the edited file. */
  targetPath: string;
  /** Content before the edit ("" when the file was created). */
  baseSource: string;
  /** Formatted content that was written. */
  newSource: string;
}

export interface LineRange {
  /** 1-based inclusive; start === 0 when nothing changed. */
  start: number;
  end: number;
}

function toLines(source: string): string[] {
  const lines = source.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

// Line-based applied range, found by comparing both ends so it is agnostic to
// whole-symbol replacements and to lines inserted or removed around the edit.
export function editedRange(baseSource: string, newSource: string): LineRange {
  const newLines = toLines(newSource);
  if (baseSource === "") {
    return newLines.length === 0 ? { start: 0, end: 0 } : { start: 1, end: newLines.length };
  }
  const baseLines = toLines(baseSource);
  let start = 0;
  while (
    start < baseLines.length &&
    start < newLines.length &&
    baseLines[start] === newLines[start]
  ) {
    start += 1;
  }
  let endFromTail = 0;
  while (
    endFromTail < baseLines.length - start &&
    endFromTail < newLines.length - start &&
    baseLines[baseLines.length - 1 - endFromTail] === newLines[newLines.length - 1 - endFromTail]
  ) {
    endFromTail += 1;
  }
  const end = newLines.length - endFromTail;
  if (start >= end) {
    return { start: 0, end: 0 };
  }
  return { start: start + 1, end };
}

function inEditedRange(range: LineRange, line: number): boolean {
  return range.start > 0 && line >= range.start && line <= range.end;
}

function codeFrame(lines: readonly string[], line: number): string[] {
  const first = Math.max(1, line - 1);
  const last = Math.min(lines.length, line + 1);
  const frame: string[] = [];
  for (let current = first; current <= last; current += 1) {
    frame.push(`  ${current} | ${lines[current - 1] ?? ""}`);
  }
  return frame;
}

function messageWithCode(diagnostic: CheckDiagnostic): string {
  return diagnostic.code === undefined
    ? diagnostic.message
    : `${diagnostic.code}: ${diagnostic.message}`;
}

function renderElsewhere(diagnostic: CheckDiagnostic): string {
  if (diagnostic.file === "") {
    return messageWithCode(diagnostic);
  }
  const location = `${diagnostic.file}(${diagnostic.line},${diagnostic.column})`;
  return diagnostic.code === undefined
    ? `${location}: ${diagnostic.message}`
    : `${location}: error ${diagnostic.code}: ${diagnostic.message}`;
}

const FAILING_TEST_LIMIT = 10;
const MAPPED_DIAGNOSTIC_LIMIT = 10;
const TEST_OUTPUT_TAIL_LIMIT = Math.floor(DIAGNOSTICS_LIMIT / 2);
const TEST_TIMING_SUFFIX = /\s+\[\d+(?:\.\d+)?m?s\]$/;

export function failingTestNames(output: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    const marker = line.startsWith("(fail) ") ? "(fail) " : line.startsWith("✗ ") ? "✗ " : null;
    if (marker === null) {
      continue;
    }
    const name = line.slice(marker.length).trim().replace(TEST_TIMING_SUFFIX, "");
    if (name === "" || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
    if (names.length >= FAILING_TEST_LIMIT) {
      break;
    }
  }
  return names;
}

function testOutputTail(output: string): string {
  const text = output.trim();
  if (text.length <= TEST_OUTPUT_TAIL_LIMIT) {
    return text;
  }
  const omitted = text.length - TEST_OUTPUT_TAIL_LIMIT;
  return `[${omitted} earlier characters omitted]\n${text.slice(omitted)}`;
}

export function formatDiagnostics(input: DiagnosticsInput): string {
  const { check, test, targetPath, baseSource, newSource } = input;
  const lines: string[] = [];
  if (!check.ok) {
    lines.push("stage: tsc");
    const range = editedRange(baseSource, newSource);
    const replacementLines = toLines(newSource);
    const mapped: CheckDiagnostic[] = [];
    const elsewhere: CheckDiagnostic[] = [];
    for (const diagnostic of check.diagnostics) {
      if (diagnostic.file === targetPath && inEditedRange(range, diagnostic.line)) {
        mapped.push(diagnostic);
      } else {
        elsewhere.push(diagnostic);
      }
    }
    for (const diagnostic of mapped.slice(0, MAPPED_DIAGNOSTIC_LIMIT)) {
      lines.push(
        `replacement line ${diagnostic.line - range.start + 1}: ${messageWithCode(diagnostic)}`,
      );
      lines.push(...codeFrame(replacementLines, diagnostic.line));
    }
    if (mapped.length > MAPPED_DIAGNOSTIC_LIMIT) {
      lines.push(`... ${mapped.length - MAPPED_DIAGNOSTIC_LIMIT} more in the replacement`);
    }
    if (elsewhere.length > 0) {
      lines.push("elsewhere in file:");
      for (const diagnostic of elsewhere) {
        lines.push(renderElsewhere(diagnostic));
      }
    }
    if (check.diagnostics.length === 0 && check.output.trim() !== "") {
      lines.push(check.output.trim());
    }
  }
  if (!test.ok) {
    lines.push("stage: tests");
    lines.push("tests failed:");
    const names = failingTestNames(test.output);
    if (names.length > 0) {
      lines.push("failing tests:");
      for (const name of names) {
        lines.push(`  - ${name}`);
      }
    }
    const tail = testOutputTail(test.output);
    if (tail !== "") {
      lines.push("test output:");
      lines.push(tail);
    }
  }
  const text = lines.filter((line) => line !== "").join("\n");
  if (text.length <= DIAGNOSTICS_LIMIT) {
    return text;
  }
  // Keep the head (earliest tsc errors, i.e. the root causes) and the tail
  // (bun-test summary) with an explicit marker in between.
  const headLength = Math.floor(DIAGNOSTICS_LIMIT / 2);
  const tailLength = DIAGNOSTICS_LIMIT - headLength;
  const head = text.slice(0, headLength);
  const tail = text.slice(text.length - tailLength);
  const truncated = text.length - headLength - tailLength;
  return `${head}... [${truncated} characters truncated] ...${tail}`;
}

/**
 * One termination-step summary call (#43): the summary prompt is appended to
 * the bounded history and the provider is called exactly once. Provider errors
 * keep their own path and fall back to a readable string.
 */
async function explain(
  provider: ProviderLike,
  messages: ChatMessage[],
  temperature: number | undefined,
  reason: TerminationReason | "provider-error",
  diagnostics: string | null,
): Promise<string> {
  messages.push({ role: "user", content: buildSummaryPrompt(reason, diagnostics) });
  const options = temperature === undefined ? undefined : { temperature };
  try {
    const response = await provider.chat(messages, undefined, options);
    const text = stripCodeFences(response.content ?? "");
    return text === "" ? "the model did not provide an explanation" : text;
  } catch (error) {
    return `no explanation available: ${errorMessage(error)}`;
  }
}

function withEffort(base: ChatOptions | undefined, effort: ReasoningEffort): ChatOptions {
  return { ...base, reasoningEffort: effort };
}

type SelectionResolution = { ok: true; selection: Selection } | { ok: false; diagnostic: string };

// One strict-AND resolution for every mode: no silent first-match pick, no kind
// coercion, no auto-append. `create` additionally guards the target: a safe path
// whose name is absent under any kind.
function resolveSelection(
  cwd: string,
  index: SymbolIndex,
  files: readonly SourceFile[],
  skipped: readonly SkippedFile[],
  response: SelectionResponse,
): SelectionResolution {
  const locator = response.locator;
  const sourceByPath = new Map(files.map((file) => [file.path, file.source]));
  if (response.mode === "create") {
    const path = safeAppendPath(cwd, locator.path);
    if (path === null) {
      return {
        ok: false,
        diagnostic: `stage: address\nthe path ${JSON.stringify(locator.path)} is not a safe repo-relative target; use a relative path inside the repository without "..", hidden, or build segments`,
      };
    }
    const skippedFile = skipped.find((file) => file.path === locator.path);
    if (skippedFile !== undefined) {
      return {
        ok: false,
        diagnostic: `stage: address\nthe file ${JSON.stringify(locator.path)} could not be parsed and indexed (${skippedFile.message}); the harness does not append to a file it cannot parse`,
      };
    }
    const existing = index
      .byName(locator.name)
      .filter((entry) => entry.locator.path === locator.path);
    if (existing.length > 0) {
      return { ok: false, diagnostic: createExistsDiagnostics(locator, existing, sourceByPath) };
    }
    return { ok: true, selection: { mode: "create", locator, path } };
  }
  const matches = index.lookup(locator);
  if (matches.length === 0) {
    const skippedFile = skipped.find((file) => file.path === locator.path);
    if (skippedFile !== undefined) {
      return {
        ok: false,
        diagnostic: `stage: address\nthe file ${JSON.stringify(locator.path)} could not be parsed and indexed (${skippedFile.message})`,
      };
    }
    return {
      ok: false,
      diagnostic: addressMissDiagnostics(locator, index.byName(locator.name), sourceByPath),
    };
  }
  if (matches.length > 1) {
    return { ok: false, diagnostic: addressAmbiguousDiagnostics(locator, matches, sourceByPath) };
  }
  const entry = matches[0];
  if (entry === undefined) {
    return { ok: false, diagnostic: addressMissDiagnostics(locator, [], sourceByPath) };
  }
  return { ok: true, selection: { mode: response.mode, locator, entry } };
}

function exhaustedDiagnostics(openedBy: string | null, last: string | null): string {
  const reason = `edit-exhausted: the ${MAX_EDIT_EXCHANGES}-exchange Edit budget was exhausted without a valid edit`;
  const parts = [reason];
  if (openedBy !== null) {
    parts.push(openedBy);
  }
  if (last !== null) {
    parts.push(last);
  }
  return parts.join("\n\n");
}

// Retry/continuation diagnostics (#48/#52): the failure that opened the round
// plus the latest rejection, deduplicated when they are the same text.
function combinedDiagnostics(openedBy: string | null, last: string | null): string {
  if (openedBy !== null && last !== null && last !== openedBy) {
    return `${openedBy}\n\n${last}`;
  }
  return last ?? "the previous exchange was rejected";
}

// Cap diagnostic (#52): entering a Run iteration beyond MAX_RUN_ITERATIONS.
function capDiagnostics(openedBy: string | null): string {
  const reason = `edit-exhausted: the ${MAX_RUN_ITERATIONS}-round cap was reached without a verified edit`;
  return openedBy === null ? reason : `${reason}\n\n${openedBy}`;
}

// STOP diagnostic (#52): the model ended a continuation round itself.
function stoppedDiagnostics(rounds: number, context: string | null): string {
  const reason = `edit-exhausted: the model replied STOP after ${rounds} rounds`;
  return context === null ? reason : `${reason}\n\n${context}`;
}

// Stalled-stop diagnostic (#54): the model ended the run at the no-progress ask.
function stalledStopDiagnostics(failedRounds: number, context: string | null): string {
  const reason = `edit-exhausted: the model replied STOP after ${failedRounds} consecutive failed rounds`;
  return context === null ? reason : `${reason}\n\n${context}`;
}

// `STOP` is only special as the reply to a continuation prompt (#52) or to the
// no-progress ask (#54).
function isStopReply(response: ChatResponse): boolean {
  return (response.content ?? "").trim().toUpperCase() === "STOP";
}

/** One submitted modify payload, for the resubmission guard (#48/#69). */
interface ModifySubmissionEntry {
  /** Canonical as-sent `{path, symbol, kind}`. */
  locatorJson: string;
  matcher: string | null;
  replacement: string;
}

/**
 * Previous modify-mode submission, for the resubmission guard (#48): one entry
 * for a classic payload, N entries for a multi-payload batch (#69); the guard
 * compares the whole submission, so a byte-identical resend of either shape is
 * rejected before any resolution or splice.
 */
interface ModifySubmission {
  entries: ModifySubmissionEntry[];
  /** True when the submission was written; false when it was rejected. */
  applied: boolean;
  /** First line of the rejection diagnostic when `applied` is false. */
  rejectionFirstLine: string | null;
}

function firstDiagnosticLine(diagnostics: string): string {
  const newline = diagnostics.indexOf("\n");
  return newline === -1 ? diagnostics : diagnostics.slice(0, newline);
}

function submissionOf(
  payloads: readonly EditPayload[],
  applied: boolean,
  rejectionFirstLine: string | null,
): ModifySubmission {
  return {
    entries: payloads.map((payload) => ({
      locatorJson: addressJson(payload.locator),
      matcher: payload.matcher,
      replacement: payload.replacement,
    })),
    applied,
    rejectionFirstLine,
  };
}

function sameModifySubmission(
  submission: ModifySubmission,
  payloads: readonly EditPayload[],
): boolean {
  if (submission.entries.length !== payloads.length) {
    return false;
  }
  return payloads.every((payload, index) => {
    const entry = submission.entries[index];
    return (
      entry !== undefined &&
      entry.locatorJson === addressJson(payload.locator) &&
      entry.matcher === payload.matcher &&
      entry.replacement === payload.replacement
    );
  });
}

// `stage: repeat` (#48): byte-identical resubmission cannot change anything,
// and the wording distinguishes an already-applied edit from a rejected one.
function repeatDiagnostics(submission: ModifySubmission): string {
  if (submission.applied) {
    return 'stage: repeat\nthis exact edit was already applied and the file already contains its effect; verification still fails, so resending it cannot change the outcome — adjust the replacement, omit "matcher" for a whole-symbol rewrite, or re-pin to a declaration the diagnostics name';
  }
  const rejected = submission.rejectionFirstLine ?? "the previous rejection";
  return `stage: repeat\nthis exact edit was just rejected (${rejected}); resending it verbatim cannot succeed — change the payload`;
}

export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const temperature = options.temperature;
  const chatOptions: ChatOptions | undefined =
    temperature === undefined ? undefined : { temperature };
  const cwd = options.cwd;
  const files = discoverSourceFiles(cwd);
  const build = buildIndexTolerant(files);
  const contextYaml = buildContextYaml(files, build);
  const index = build.index;
  const skipped = build.skipped;
  const specFiles = selectSpecFiles(options.issue, files);
  const systemMessage: ChatMessage = {
    role: "system",
    content: buildSystemPrompt(options.multiPayload === true),
  };
  const issueMessage: ChatMessage = {
    role: "user",
    content: buildUserPrompt(options.issue, contextYaml, specFiles),
  };
  // Lean issue message (#49): same issue text and project-context YAML without
  // the spec-file section. Rounds opened by a `tsc`-stage verification failure
  // send it on every content exchange — their repair is driven by the
  // diagnostics and the current source; all other rounds keep the full message.
  const leanIssueMessage: ChatMessage = {
    role: "user",
    content: buildUserPrompt(options.issue, contextYaml, []),
  };
  // Round 1 (and selection-continuation rounds, which carry no verification
  // stage) always starts from the full message; the per-round variant is chosen
  // at the top of the Run loop and applied on the content-exchange rebuild.
  const initialMessages: ChatMessage[] = [systemMessage, issueMessage];
  let messages: ChatMessage[] = initialMessages;
  const records: LoopRecord[] = [];
  let consumedTokens = 0;

  // Pinning (#43): the first successful pick fixes {mode, path, symbol, kind}
  // for the run; later exchanges revise content only and must echo the address.
  let pinned: { mode: SelectionMode; locator: Locator } | null = null;
  let pinnedAddressJson = "";
  // Run-start source of the target file ("" when the file did not exist).
  let baseSource = "";
  // First content prompt after a pick; null once a retry prompt takes over.
  let initialContentPrompt: string | null = null;
  // Create→repair (#41): once a failed create keeps a parseable file, content
  // exchanges are modify rounds against the kept file and prompts show it whole.
  let repair = false;
  // Verification diagnostics that opened the current Run iteration.
  let pendingDiagnostics: string | null = null;
  // Stage of the verification failure that opened the current Run iteration
  // (#49): `tsc` makes the round's content prompts lean.
  let pendingVerificationStage: "tsc" | "tests" | null = null;
  // Consecutive no-progress rounds (#54/#60): incremented once at every failed
  // verification and once at every round that ends with no applied edit
  // (rejection-exhausted, truncated, or spent picking). It survives rounds and
  // #52 continuations and is never reset (a passing verification ends the run).
  let stalledRounds = 0;
  // Per-cause retry policy (#56): the last rejection cause and the length of
  // the consecutive-same-cause streak, plus the correction sentence the next
  // edit retry must carry (the escalation once the streak reaches 2, and the
  // #65 context: the round's opening diagnostics and an undeclared address
  // name). An applied edit resets all three; verification failures and #52
  // continuations deliberately do not.
  let lastRejectionCause: RejectionCause | null = null;
  let lastRejectionStreak = 0;
  let lastCorrection: string | null = null;
  const registerRejection = (cause: RejectionCause, context: RejectionLeadContext = {}): void => {
    if (cause === lastRejectionCause) {
      lastRejectionStreak += 1;
    } else {
      lastRejectionCause = cause;
      lastRejectionStreak = 1;
    }
    lastCorrection = rejectionLead(cause, lastRejectionStreak, context);
  };
  const clearRejectionPolicy = (): void => {
    lastRejectionCause = null;
    lastRejectionStreak = 0;
    lastCorrection = null;
  };
  // Prior-attempts digest (#57): a bounded, incrementally-updated checkpoint of
  // the failing chain. It is rendered into the #52 round-continuation prompts
  // and the #54 no-progress ask only; `digestText` advances it over the records
  // the previous prompt has not seen yet, immediately before rendering.
  const attemptDigest = createAttemptDigestState();
  const digestText = (): string => {
    updateAttemptDigest(attemptDigest, records);
    return renderAttemptDigest(attemptDigest);
  };
  // Resubmission guard (#48): the last modify-mode payload, kept across
  // iterations; a byte-identical resend is rejected as `stage: repeat`.
  let lastModifySubmission: ModifySubmission | null = null;
  // Round-level continuation (#52): a round that exhausts its ≤3 exchanges
  // below the cap does not end the run; the next iteration opens with this
  // continuation prompt and its reply is the first exchange of the fresh round.
  let continuation: {
    /** Round that exhausted its budget (the prompt names it). */
    round: number;
    /** True when the new round must re-pick the target. */
    pick: boolean;
    /** Opening + latest rejection diagnostics carried into the prompt. */
    diagnostics: string;
  } | null = null;

  const success = (editedSource: string | null): LoopResult => ({
    ok: true,
    mode: pinned?.mode,
    locator: pinned?.locator ?? null,
    filePath: pinned?.locator.path ?? null,
    editedSource,
    records,
    diagnostics: null,
    explanation: null,
    messages,
    skipped,
  });

  // Termination step (#43): record rows are already pushed; the only remaining
  // action is exactly one summary call, then the run stops.
  const terminate = async (
    reason: TerminationReason,
    diagnostics: string | null,
  ): Promise<LoopResult> => ({
    ok: false,
    mode: pinned?.mode,
    locator: pinned?.locator ?? null,
    filePath: pinned?.locator.path ?? null,
    editedSource: null,
    records,
    diagnostics,
    explanation: await explain(options.provider, messages, temperature, reason, diagnostics),
    messages,
    skipped,
    terminationReason: reason,
  });

  let iteration = 0;
  // STOP (#52/#54): the reply to a continuation prompt or to the no-progress
  // ask may end the run; it is recorded as an exchange row with the dedicated
  // `stopped` outcome, carrying the diagnostics builder's text.
  const stopRun = async (
    exchange: number,
    response: ChatResponse,
    diagnostics: string,
  ): Promise<LoopResult> => {
    records.push(
      recordRow({
        row: records.length + 1,
        iteration,
        kind: "exchange",
        exchange,
        locator: pinned?.locator ?? EMPTY_LOCATOR,
        replacement: response.content ?? null,
        diagnostics,
        outcome: "stopped",
        finishReason: response.finishReason,
        toolCalls: response.toolCalls.length,
      }),
    );
    return await terminate("edit-exhausted", diagnostics);
  };
  for (;;) {
    iteration += 1;
    // Hard cap (#52): rounds 1..MAX_RUN_ITERATIONS run; entering the next one
    // terminates through the existing chain naming the cap.
    if (iteration > MAX_RUN_ITERATIONS) {
      return await terminate("edit-exhausted", capDiagnostics(pendingDiagnostics));
    }
    initialContentPrompt = null;
    let verificationFailed = false;
    // True once this round writes an edit; a round that ends without one is a
    // no-progress round (#60).
    let appliedEdit = false;
    let lastDiagnostics: string | null = pendingDiagnostics;
    let lastFailure: "edit" | "verification" =
      pendingDiagnostics === null ? "edit" : "verification";
    // Verification diagnostics that opened this iteration, kept for the
    // edit-exhausted summary even after edit soft failures overwrite `last`.
    const iterationOpenedBy: string | null = lastDiagnostics;
    // Stage that opened this iteration (#49), carried with the diagnostics so a
    // #52 continuation keeps its chain's prompt variant.
    const iterationOpenedByStage: "tsc" | "tests" | null = pendingVerificationStage;
    pendingDiagnostics = null;
    pendingVerificationStage = null;
    // Content prompts of a tsc-stage repair round omit the spec-file section
    // (#49); every other round keeps the full issue message.
    const roundIssueMessage = iterationOpenedByStage === "tsc" ? leanIssueMessage : issueMessage;
    // Previous content rejection within this iteration, for the identical-
    // retry note (#48); resets every iteration.
    let lastRejection: string | null = null;
    const retryDiagnostics = (diagnostics: string): string => {
      const identical = lastRejection === diagnostics;
      lastRejection = diagnostics;
      return identical ? `${IDENTICAL_RETRY_NOTE}\n${diagnostics}` : diagnostics;
    };
    // Create→repair transition (#41) at the start of an iteration after a failed
    // create verification: a kept file that parses becomes a modify repair; an
    // absent or unparseable kept file is removed and create re-runs.
    if (pinned !== null && pinned.mode === "create" && lastFailure === "verification") {
      const keptPath = join(cwd, pinned.locator.path);
      const kept = readFileIfExists(keptPath);
      const keptCheck = kept === null ? null : parseCheck(kept);
      if (kept !== null && keptCheck !== null && keptCheck.ok) {
        repair = true;
        pinned.mode = "modify";
        pinnedAddressJson = pinJson(pinned);
        baseSource = kept;
      } else {
        rmSync(keptPath, { force: true });
      }
    }

    // Round-level continuation (#52): the prompt built when the previous round
    // exhausted its exchanges below the cap; the reply to it is the first
    // exchange of this round.
    const pendingContinuation = continuation;
    continuation = null;

    // No-progress ask (#54/#60): a round that opens on a stalled streak (a
    // positive multiple of MAX_STALLED_ROUNDS) asks the model to decide in its
    // first content prompt. A verification-failure cycle opens the round
    // directly; a rejection-exhausted cycle (#60) opens through the #52
    // continuation prompt, which then carries the ask framing instead of the
    // round-exhausted header. Every continuation-producing round advanced the
    // counter in the same iteration, so a milestone here is the one the
    // previous round just crossed. A selection continuation has no pinned
    // target and keeps its own STOP framing.
    const stalledAsk =
      pinned !== null &&
      stalledRounds > 0 &&
      stalledRounds % MAX_STALLED_ROUNDS === 0 &&
      (pendingContinuation !== null || iterationOpenedBy !== null);

    let continuationPrompt: string | null = null;
    let continuationDiagnostics: string | null = null;
    if (pendingContinuation !== null) {
      continuationDiagnostics = pendingContinuation.diagnostics;
      // Failure history (#71): the trailing verification failures as the
      // prompts see them (chain reset included); computed once per
      // continuation and threaded into both variants.
      const failureHistory = renderFailureHistoryNote(detectFailurePattern(records));
      if (pendingContinuation.pick) {
        continuationPrompt = buildSelectionContinuationPrompt({
          round: pendingContinuation.round,
          maxRounds: MAX_RUN_ITERATIONS,
          diagnostics: pendingContinuation.diagnostics,
          digest: digestText(),
          failureHistory,
        });
        messages = [systemMessage, issueMessage, { role: "user", content: continuationPrompt }];
      } else {
        const continuedTarget = pinned;
        if (continuedTarget === null) {
          // Unreachable: an edit continuation is only set after a pick.
          throw new Error("edit continuation without a pinned target");
        }
        const target = continuedTarget.locator.path;
        const diskSource = readFileIfExists(join(cwd, target)) ?? "";
        const wholeFile = repair || continuedTarget.mode === "create";
        const currentSource = wholeFile
          ? diskSource
          : currentSourceForPrompt("modify", target, continuedTarget.locator, diskSource);
        continuationPrompt = buildContinuationPrompt({
          round: pendingContinuation.round,
          maxRounds: MAX_RUN_ITERATIONS,
          mode: continuedTarget.mode === "create" ? "create" : "modify",
          locatorJson: pinnedAddressJson,
          currentSource: truncateSource(currentSource),
          diagnostics: pendingContinuation.diagnostics,
          // The ask names re-pinning as a concrete alternative, so its round
          // may move the pin exactly like a verification-opened ask round.
          repin: (iterationOpenedBy !== null || stalledAsk) && continuedTarget.mode === "modify",
          digest: digestText(),
          failureHistory,
          stalled: stalledAsk
            ? { failedRounds: stalledRounds, round: iteration, maxRounds: MAX_RUN_ITERATIONS }
            : undefined,
          multiPayload: options.multiPayload === true,
        });
      }
    }

    for (let exchange = 1; exchange <= MAX_EDIT_EXCHANGES; exchange += 1) {
      const pick = pinned === null;
      // Reasoning policy (#35; revised 2026-10-18 after the effort sweep and
      // the none/none/max canonical run): every Edit-loop call runs at "none". The
      // sweep showed reasoning only added cost on the happy path (json/sexp)
      // and that escalation on verification-repair rounds converted nothing on
      // minilisp (max rewrites even broke tsc). Retries stay flat until
      // repair-round convergence improves. An effortOverride forces one effort
      // on every call for benchmark sweeps.
      const exchangeOptions =
        options.effortOverride !== undefined
          ? withEffort(chatOptions, options.effortOverride)
          : withEffort(chatOptions, "none");

      if (pick) {
        let response: ChatResponse;
        try {
          response = await options.provider.chat(messages, undefined, exchangeOptions);
        } catch (error) {
          const diagnostics = `provider error: ${errorMessage(error)}`;
          return {
            ok: false,
            mode: pinned?.mode,
            locator: null,
            filePath: null,
            editedSource: null,
            records,
            diagnostics,
            explanation: await explain(
              options.provider,
              messages,
              temperature,
              "provider-error",
              diagnostics,
            ),
            messages,
            skipped,
          };
        }
        consumedTokens += tokensFromResponse(response);
        if (consumedTokens > tokenBudget) {
          return await terminate(
            "token-budget",
            tokenBudgetDiagnostics(consumedTokens, tokenBudget),
          );
        }
        // Only the continuation prompt offers STOP (#52).
        if (exchange === 1 && continuationPrompt !== null && isStopReply(response)) {
          return await stopRun(
            exchange,
            response,
            stoppedDiagnostics(iteration, continuationDiagnostics),
          );
        }
        let candidate: Locator = EMPTY_LOCATOR;
        let resolution: SelectionResolution | null = null;
        let diagnostic: string | null = null;
        let selectionStage: "protocol" | "address" = "protocol";
        try {
          const parsed = selectionFromResponse(response);
          candidate = parsed.locator;
          resolution = resolveSelection(cwd, index, files, skipped, parsed);
        } catch (error) {
          diagnostic = `stage: protocol\n${errorMessage(error)}`;
        }
        if (resolution !== null && !resolution.ok) {
          diagnostic = resolution.diagnostic;
          selectionStage = "address";
        }
        if (diagnostic !== null) {
          const cause = classifyRejection({ stage: selectionStage });
          records.push(
            recordRow({
              row: records.length + 1,
              iteration,
              kind: "exchange",
              exchange,
              locator: candidate,
              replacement: null,
              diagnostics: diagnostic,
              outcome: selectionStage,
              finishReason: response.finishReason,
              cause,
              toolCalls: response.toolCalls.length,
            }),
          );
          registerRejection(cause);
          lastDiagnostics = diagnostic;
          lastFailure = "edit";
          if (exchange === MAX_EDIT_EXCHANGES) {
            if (iteration >= MAX_RUN_ITERATIONS) {
              return await terminate("edit-exhausted", capDiagnostics(iterationOpenedBy));
            }
            // Selection exhaustion (#52): the next round re-asks for the
            // target (or STOP) instead of ending the run.
            continuation = {
              round: iteration,
              pick: true,
              diagnostics: combinedDiagnostics(iterationOpenedBy, diagnostic),
            };
            break;
          }
          messages.push({ role: "assistant", content: response.content ?? "" });
          messages.push({ role: "user", content: buildSelectionRetryPrompt(diagnostic) });
          continue;
        }
        const selection = resolution !== null && resolution.ok ? resolution.selection : null;
        if (selection === null) {
          // Unreachable: a non-null resolution with an ok=true branch was set.
          return await terminate(
            "edit-exhausted",
            exhaustedDiagnostics(iterationOpenedBy, diagnostic),
          );
        }
        pinned = { mode: selection.mode, locator: selection.locator };
        pinnedAddressJson = pinJson(pinned);
        records.push(
          recordRow({
            row: records.length + 1,
            iteration,
            kind: "exchange",
            exchange,
            locator: selection.locator,
            replacement: null,
            diagnostics: null,
            outcome: "selected",
            finishReason: response.finishReason,
            toolCalls: response.toolCalls.length,
          }),
        );
        messages.push({ role: "assistant", content: pinnedAddressJson });
        if (selection.mode === "delete") {
          // delete carries no edit payload: the pick exchange is the whole
          // model exchange and the harness executes the deletion directly.
          const fileEntry = sourceFileFor(files, selection.locator.path);
          return await executeDeletion({
            options,
            provider: options.provider,
            temperature,
            targetPath: selection.locator.path,
            locator: selection.locator,
            node: selection.entry.node,
            baseSource: fileEntry.source,
            messages,
            records,
            skipped,
            iteration,
          });
        }
        baseSource =
          selection.mode === "create"
            ? (readFileIfExists(join(cwd, selection.path)) ?? "")
            : sourceFileFor(files, selection.locator.path).source;
        if (selection.mode === "modify") {
          const symbolSource = baseSource.slice(
            selection.entry.node.start,
            selection.entry.node.end,
          );
          initialContentPrompt = buildEditPrompt(
            addressJson(selection.locator),
            symbolSource,
            options.multiPayload === true,
          );
        } else {
          initialContentPrompt = buildCreatePrompt(addressJson(selection.locator), selection.path);
        }
        continue;
      }

      // Content exchange: revise the pinned target. A fresh iteration has a
      // fresh ≤3 budget; soft failures re-ask with diagnostics and consume the
      // same budget.
      let pinnedTarget: { mode: SelectionMode; locator: Locator } | null = pinned;
      if (pinnedTarget === null) {
        // Unreachable: the pick branch either pins a target or returns.
        throw new Error("content exchange without a pinned target");
      }
      const target = pinnedTarget.locator.path;
      const diskSource = readFileIfExists(join(cwd, target)) ?? "";
      let contentPrompt: string;
      if (exchange === 1 && continuationPrompt !== null) {
        // Round-level continuation (#52): the first exchange of a continued
        // round shows the continuation prompt instead of the echo of a pick.
        contentPrompt = continuationPrompt;
      } else if (lastDiagnostics === null && initialContentPrompt !== null) {
        contentPrompt = initialContentPrompt;
      } else {
        const wholeFile = repair || pinnedTarget.mode === "create";
        const currentSource = wholeFile
          ? diskSource
          : currentSourceForPrompt("modify", target, pinnedTarget.locator, diskSource);
        // No-progress ask (#54): only the first content prompt of a stalled
        // round carries the decision framing and the digest (#57); every other
        // retry is unchanged.
        const stalled =
          exchange === 1 && stalledAsk
            ? {
                failedRounds: stalledRounds,
                round: iteration,
                maxRounds: MAX_RUN_ITERATIONS,
              }
            : undefined;
        // Failure history (#71): unlike the digest, the note is computed for
        // every content retry — ordinary retries and the #54 ask alike.
        const failureHistory = renderFailureHistoryNote(detectFailurePattern(records));
        contentPrompt = buildRetryPrompt({
          exchangeNumber: exchange,
          maxExchanges: MAX_EDIT_EXCHANGES,
          mode: pinnedTarget.mode === "create" ? "create" : "modify",
          locatorJson: pinnedAddressJson,
          currentSource: truncateSource(currentSource),
          // A soft edit failure overwrites `lastDiagnostics`; in a repair
          // iteration keep the verification failure visible too (#48).
          diagnostics: combinedDiagnostics(iterationOpenedBy, lastDiagnostics),
          failure: lastFailure,
          repin: iterationOpenedBy !== null && pinnedTarget.mode === "modify",
          stalled,
          digest: stalled === undefined ? undefined : digestText(),
          failureHistory,
          // Per-cause rejection correction (#56): only edit retries carry the
          // class-specific lead; verification-repair prompts keep the default.
          correction: lastFailure === "edit" ? (lastCorrection ?? undefined) : undefined,
          multiPayload: options.multiPayload === true,
        });
      }
      messages = [
        systemMessage,
        roundIssueMessage,
        { role: "assistant", content: pinnedAddressJson },
        { role: "user", content: contentPrompt },
      ];
      let response: ChatResponse;
      try {
        response = await options.provider.chat(messages, undefined, exchangeOptions);
      } catch (error) {
        const diagnostics = `provider error: ${errorMessage(error)}`;
        return {
          ok: false,
          mode: pinnedTarget.mode,
          locator: pinnedTarget.locator,
          filePath: target,
          editedSource: null,
          records,
          diagnostics,
          explanation: await explain(
            options.provider,
            messages,
            temperature,
            "provider-error",
            diagnostics,
          ),
          messages,
          skipped,
        };
      }
      consumedTokens += tokensFromResponse(response);
      if (consumedTokens > tokenBudget) {
        return await terminate("token-budget", tokenBudgetDiagnostics(consumedTokens, tokenBudget));
      }
      // The no-progress ask's STOP (#54), only at its first exchange; the
      // stalled diagnostics stay distinct from #52's exhausted-round text. A
      // milestone continuation (#60) carries the ask framing, so its STOP
      // takes precedence over the continuation's and keeps the chain context.
      if (exchange === 1 && stalledAsk && isStopReply(response)) {
        return await stopRun(
          exchange,
          response,
          stalledStopDiagnostics(
            stalledRounds,
            continuationDiagnostics ?? combinedDiagnostics(iterationOpenedBy, lastDiagnostics),
          ),
        );
      }
      // Only the continuation prompt (#52) and the no-progress ask (#54) offer
      // STOP, each at its own exchange-1 prompt.
      if (exchange === 1 && continuationPrompt !== null && isStopReply(response)) {
        return await stopRun(
          exchange,
          response,
          stoppedDiagnostics(iteration, continuationDiagnostics),
        );
      }
      const sourceBefore = readFileIfExists(join(cwd, target)) ?? baseSource;
      const prevCheck = parseCheck(sourceBefore);
      if (!prevCheck.ok) {
        const broken = prevBrokenDiagnostics(target, prevCheck.failure);
        records.push(
          recordRow({
            row: records.length + 1,
            iteration,
            kind: "exchange",
            exchange,
            locator: pinnedTarget.locator,
            replacement: null,
            diagnostics: broken,
            outcome: "prev-broken",
            finishReason: response.finishReason,
            toolCalls: response.toolCalls.length,
          }),
        );
        return await terminate("prev-broken", broken);
      }
      if (response.finishReason === "length") {
        const diagnostics =
          "stage: truncated\nthe completion was cut off at the output limit; emit a shorter, more compact replacement";
        const cause = classifyRejection({ stage: "truncated" });
        records.push(
          recordRow({
            row: records.length + 1,
            iteration,
            kind: "exchange",
            exchange,
            locator: pinnedTarget.locator,
            replacement: response.content ?? null,
            diagnostics,
            outcome: "truncated",
            finishReason: response.finishReason,
            cause,
            toolCalls: response.toolCalls.length,
          }),
        );
        registerRejection(cause);
        lastDiagnostics = retryDiagnostics(diagnostics);
        lastFailure = "edit";
        if (exchange === MAX_EDIT_EXCHANGES) {
          if (iteration >= MAX_RUN_ITERATIONS) {
            return await terminate("edit-exhausted", capDiagnostics(iterationOpenedBy));
          }
          // Round exhaustion below the cap (#52): continue with a fresh round.
          continuation = {
            round: iteration,
            pick: false,
            diagnostics: combinedDiagnostics(iterationOpenedBy, lastDiagnostics),
          };
          break;
        }
        continue;
      }
      const content = response.content ?? "";
      let payload: EditPayload | null = null;
      // Opt-in multi-payload variant (#69): the reply may carry a
      // `{"payloads": [...]}` batch. `batchCarried` keeps every payload that
      // parsed, even when the batch was rejected at parse time (duplicate
      // paths, bad entry), so the record still counts what the reply carried.
      let batch: EditPayload[] | null = null;
      let batchCarried: EditPayload[] = [];
      let batchPayloadCount = 0;
      let batchReplacementChars: number | null = null;
      // Batch-level rejection cause (#69): `multi-protocol`/`multi-duplicate`
      // override the stage-derived classification; per-payload failures keep
      // the failing payload's own stage/cause.
      let failureCause: RejectionCause | null = null;
      let candidate: string | null = null;
      let newSource: string | null = null;
      let replacement: string | null = null;
      let gateStart = 0;
      let gateReplacement = "";
      let failure: string | null = null;
      let failureStage: EditFailureStage = "protocol";
      // Structured rejection origin (#56): the splice's matcher sub-cause and
      // the formatter message; never reconstructed from the diagnostics text.
      let matcherCause: MatcherCause | undefined;
      let formatMessage: string | undefined;
      // #65: set when an `address` rejection resolved against a name the
      // current source does not declare, so the retry lead keeps the add path
      // open instead of demanding a re-pin that cannot resolve.
      let addressUndeclaredName: string | null = null;
      if (options.multiPayload === true) {
        const parsed = parseEditResponseList(content);
        if (parsed.ok) {
          if (parsed.batch && pinnedTarget.mode !== "modify") {
            // Batch replies are modify-only (#69); a create round keeps its
            // flat shape and the rejection says so.
            failureCause = "multi-protocol";
            batchCarried = parsed.payloads;
            failure = multiDiagnostics(
              `mode "${pinnedTarget.mode}" carries no edit payload batch; reply with one flat ${pinnedTarget.mode} payload`,
            );
          } else if (parsed.batch) {
            batch = parsed.payloads;
          } else {
            payload = parsed.payloads[0] ?? null;
          }
        } else {
          failure = parsed.diagnostics;
          failureCause = parsed.cause;
          batchCarried = parsed.payloads;
        }
      } else {
        try {
          payload = parseEditResponse(content);
        } catch (error) {
          failure = `stage: protocol\n${errorMessage(error)}`;
        }
      }
      if (batch !== null) {
        batchCarried = batch;
      }
      if (batchCarried.length > 0) {
        batchPayloadCount = batchCarried.length;
        batchReplacementChars = batchCarried.reduce(
          (sum, entry) => sum + entry.replacement.length,
          0,
        );
        replacement = batchCarried[0]?.replacement ?? null;
      }
      if (payload !== null) {
        replacement = payload.replacement;
        gateReplacement = payload.replacement;
        if (
          pinnedTarget.mode === "modify" &&
          lastModifySubmission !== null &&
          sameModifySubmission(lastModifySubmission, [payload])
        ) {
          // Byte-identical resubmission (#48): reject before any resolution or
          // splice; the file is not touched.
          failure = repeatDiagnostics(lastModifySubmission);
          failureStage = "repeat";
        } else if (pinnedTarget.mode === "create" && payload.matcher !== null) {
          failure =
            'stage: protocol\nmode "create" does not take a "matcher"; omit it and return the complete declaration';
        } else if (!addressEquals(pinnedTarget.locator, payload.locator)) {
          if ((iterationOpenedBy !== null || stalledAsk) && pinnedTarget.mode === "modify") {
            // Verification-repair re-pin (#48): a round opened by failing
            // verification may move the pin to another declaration in the same
            // file; the new address resolves strictly against the current source.
            if (payload.locator.path !== pinnedTarget.locator.path) {
              failure = `stage: address\nthe payload may re-pin only to another declaration in the pinned file ${JSON.stringify(target)}; received path ${JSON.stringify(payload.locator.path)}`;
              failureStage = "address";
            } else {
              const resolved = resolveCurrentEntry(sourceBefore, target, payload.locator);
              if (!resolved.ok) {
                failure = resolved.diagnostics;
                failureStage = "address";
                addressUndeclaredName = resolved.undeclared ? payload.locator.name : null;
              } else {
                pinnedTarget = { mode: "modify", locator: payload.locator };
                pinned = pinnedTarget;
                pinnedAddressJson = pinJson(pinnedTarget);
                const spliced = spliceEntryEdit(
                  sourceBefore,
                  target,
                  pinnedTarget.locator,
                  resolved.entry,
                  payload.matcher,
                  payload.replacement,
                );
                if (spliced.ok) {
                  candidate = spliced.candidate;
                  gateStart = spliced.gateStart;
                } else if (spliced.cause === "no-op") {
                  failure = spliced.diagnostics;
                  failureStage = "no-op";
                } else {
                  failure = spliced.diagnostics;
                  failureStage = "matcher";
                  matcherCause = spliced.cause;
                }
              }
            }
          } else {
            failure = echoDiagnostics(pinnedTarget.locator, payload.locator);
            failureStage = "echo";
          }
        } else if (pinnedTarget.mode === "create") {
          const body = payload.replacement.trim();
          candidate = appendText(sourceBefore, payload.replacement);
          gateStart = candidate.indexOf(body);
          gateReplacement = body;
        } else {
          // Strict-AND resolution against the source that would be spliced: no
          // silent first-match pick, no kind coercion, no auto-append.
          const resolved = resolveCurrentEntry(sourceBefore, target, pinnedTarget.locator);
          if (!resolved.ok) {
            failure = resolved.diagnostics;
            failureStage = "address";
            addressUndeclaredName = resolved.undeclared ? pinnedTarget.locator.name : null;
          } else {
            const spliced = spliceEntryEdit(
              sourceBefore,
              target,
              pinnedTarget.locator,
              resolved.entry,
              payload.matcher,
              payload.replacement,
            );
            if (spliced.ok) {
              candidate = spliced.candidate;
              gateStart = spliced.gateStart;
            } else if (spliced.cause === "no-op") {
              failure = spliced.diagnostics;
              failureStage = "no-op";
            } else {
              failure = spliced.diagnostics;
              failureStage = "matcher";
              matcherCause = spliced.cause;
            }
          }
        }
      }
      // Opt-in multi-payload exchanges (#69): every payload runs its own
      // resolve → splice → gate → duplicate → format chain against its own
      // file's current source. Any failure rejects the whole exchange naming
      // each failing payload's cause, and nothing is written; the record's
      // outcome and cause stay those of the first failing payload.
      const batchWrites: { path: string; source: string }[] = [];
      if (batch !== null) {
        const first = batch[0];
        if (first === undefined) {
          // Unreachable: the parser guarantees a non-empty payload list.
          failure = multiDiagnostics("the payloads array carries no payload");
          failureCause = "multi-protocol";
        } else if (
          lastModifySubmission !== null &&
          sameModifySubmission(lastModifySubmission, batch)
        ) {
          // Byte-identical resubmission (#48): the whole batch, rejected before
          // any resolution or splice; no file is touched.
          failure = repeatDiagnostics(lastModifySubmission);
          failureStage = "repeat";
        } else {
          const blocks: string[] = [];
          let firstStage: EditFailureStage | null = null;
          let firstMatcherCause: MatcherCause | undefined;
          let firstFormatMessage: string | undefined;
          let firstUndeclared: string | null = null;
          const noteFailure = (
            index: number,
            path: string,
            locator: Locator,
            stage: EditFailureStage,
            diagnostics: string,
            origin: {
              matcherCause?: MatcherCause;
              formatMessage?: string;
              undeclaredName?: string | null;
            } = {},
          ): void => {
            if (firstStage === null) {
              firstStage = stage;
              firstMatcherCause = origin.matcherCause;
              firstFormatMessage = origin.formatMessage;
              firstUndeclared = origin.undeclaredName ?? null;
            }
            blocks.push(
              multiPayloadDiagnostics(index + 1, batch.length, path, locator, diagnostics),
            );
          };
          for (let index = 0; index < batch.length; index += 1) {
            const entryPayload = batch[index];
            if (entryPayload === undefined) {
              continue;
            }
            const path = entryPayload.locator.path;
            const payloadSource =
              index === 0 ? sourceBefore : (readFileIfExists(join(cwd, path)) ?? "");
            let splice: PayloadSplice | null = null;
            if (index === 0) {
              // The first payload keeps the classic pin semantics: it echoes
              // the pinned address, and only a verification-repair round may
              // move the pin to another declaration in the pinned file.
              const locator = entryPayload.locator;
              if (addressEquals(pinnedTarget.locator, locator)) {
                splice = splicePayloadAtSource(sourceBefore, target, entryPayload);
              } else if (iterationOpenedBy !== null || stalledAsk) {
                if (locator.path !== target) {
                  noteFailure(
                    index,
                    path,
                    locator,
                    "address",
                    `stage: address\nthe payload may re-pin only to another declaration in the pinned file ${JSON.stringify(target)}; received path ${JSON.stringify(locator.path)}`,
                  );
                } else {
                  splice = splicePayloadAtSource(sourceBefore, target, entryPayload);
                  if (splice.ok) {
                    pinnedTarget = { mode: "modify", locator };
                    pinned = pinnedTarget;
                    pinnedAddressJson = pinJson(pinnedTarget);
                  }
                }
              } else {
                noteFailure(
                  index,
                  path,
                  locator,
                  "echo",
                  echoDiagnostics(pinnedTarget.locator, locator),
                );
              }
            } else {
              // Path-independent payloads (#69): each names its own
              // declaration, which resolves strictly in its own file.
              splice = splicePayloadAtSource(payloadSource, path, entryPayload);
            }
            if (splice === null) {
              continue;
            }
            if (!splice.ok) {
              noteFailure(index, path, entryPayload.locator, splice.stage, splice.diagnostics, {
                matcherCause: splice.matcherCause,
                undeclaredName: splice.undeclaredName,
              });
              continue;
            }
            const payloadCheck = index === 0 ? prevCheck : parseCheck(payloadSource);
            if (!payloadCheck.ok) {
              // Unreachable for extra payloads: a strict resolution succeeded,
              // so the file parses.
              noteFailure(
                index,
                path,
                entryPayload.locator,
                "address",
                prevBrokenDiagnostics(path, payloadCheck.failure),
              );
              continue;
            }
            const gate = parseCheck(splice.candidate);
            if (!gate.ok) {
              noteFailure(
                index,
                path,
                entryPayload.locator,
                "gate",
                gateDiagnostics(splice.gateStart, entryPayload.replacement, gate.failure),
              );
              continue;
            }
            const duplicate = duplicateDeclarationDiagnostics(
              payloadSource,
              path,
              payloadCheck.program,
              gate.program,
            );
            if (duplicate !== null) {
              noteFailure(index, path, entryPayload.locator, "duplicate", duplicate);
              continue;
            }
            let formatted: string | null = null;
            try {
              formatted = await formatSource(path, splice.candidate);
            } catch (error) {
              noteFailure(
                index,
                path,
                entryPayload.locator,
                "format",
                `stage: format\n${errorMessage(error)}`,
                { formatMessage: errorMessage(error) },
              );
              continue;
            }
            if (await sameAfterFormatting(path, payloadSource, formatted)) {
              noteFailure(index, path, entryPayload.locator, "no-op", NOOP_DIAGNOSTICS);
              continue;
            }
            batchWrites.push({ path, source: formatted });
          }
          if (blocks.length > 0) {
            failure = blocks.join("\n\n");
            if (firstStage !== null) {
              failureStage = firstStage;
            }
            matcherCause = firstMatcherCause;
            formatMessage = firstFormatMessage;
            addressUndeclaredName = firstUndeclared;
          } else {
            newSource = batchWrites[0]?.source ?? null;
          }
        }
      }
      // Syntax gate (highest-priority invariant): prev parses ⇒ after must parse.
      if (failure === null && candidate !== null) {
        const gate = parseCheck(candidate);
        if (!gate.ok) {
          failure = gateDiagnostics(gateStart, gateReplacement, gate.failure);
          failureStage = "gate";
        } else {
          // Duplicate-declaration guard (#48): adding another top-level copy
          // of a (kind, name) TypeScript rejects on duplicates is discarded.
          const duplicate = duplicateDeclarationDiagnostics(
            sourceBefore,
            target,
            prevCheck.program,
            gate.program,
          );
          if (duplicate !== null) {
            failure = duplicate;
            failureStage = "duplicate";
          }
        }
      }
      if (failure === null && candidate !== null) {
        try {
          newSource = await formatSource(target, candidate);
        } catch (error) {
          failure = `stage: format\n${errorMessage(error)}`;
          failureStage = "format";
          formatMessage = errorMessage(error);
        }
      }
      // Formatter-normalized no-op (#59 follow-up): a candidate that differs
      // only by formatting (e.g. the replacement re-included the matched
      // span's copied leading indentation) formats back to the current source.
      // Rejected with the byte-exact no-op's stage and diagnostics: no write,
      // no verification, same cause and retry policy.
      if (batch === null && failure === null && newSource !== null) {
        if (await sameAfterFormatting(target, sourceBefore, newSource)) {
          failure = NOOP_DIAGNOSTICS;
          failureStage = "no-op";
        }
      }
      if (failure !== null || newSource === null) {
        const diagnostics = failure ?? "stage: protocol\nmodel did not return replacement text";
        const cause =
          failureCause ?? classifyRejection({ stage: failureStage, matcherCause, formatMessage });
        records.push(
          recordRow({
            row: records.length + 1,
            iteration,
            kind: "exchange",
            exchange,
            locator: pinnedTarget.locator,
            replacement,
            diagnostics,
            outcome: failureStage,
            finishReason: response.finishReason,
            cause,
            payloads: batch !== null ? batch.length : payload !== null ? 1 : batchPayloadCount,
            toolCalls: response.toolCalls.length,
            replacementChars: batchReplacementChars ?? undefined,
          }),
        );
        // Resubmission guard (#48): remember every modify-mode payload with its
        // outcome so a byte-identical resend is rejected before any splice. A
        // batch is remembered whole, so only an identical batch repeats (#69).
        if (batch !== null) {
          lastModifySubmission = submissionOf(batch, false, firstDiagnosticLine(diagnostics));
        } else if (payload !== null && pinnedTarget.mode === "modify") {
          lastModifySubmission = submissionOf([payload], false, firstDiagnosticLine(diagnostics));
        }
        // Harness-fault fast-exit (#56): a formatter failure whose signature is
        // the splice duplicating a modifier is not a model mistake; replying
        // with corrected instructions cannot help, so the run ends through the
        // termination matrix with the full diagnostics and one summary call.
        if (cause === "format-export-duplication") {
          return await terminate("harness-fault", diagnostics);
        }
        registerRejection(cause, {
          pendingDiagnostics: iterationOpenedBy,
          undeclaredName: addressUndeclaredName ?? undefined,
        });
        lastDiagnostics = retryDiagnostics(diagnostics);
        lastFailure = "edit";
        if (exchange === MAX_EDIT_EXCHANGES) {
          if (iteration >= MAX_RUN_ITERATIONS) {
            return await terminate("edit-exhausted", capDiagnostics(iterationOpenedBy));
          }
          // Round exhaustion below the cap (#52): continue with a fresh round.
          continuation = {
            round: iteration,
            pick: false,
            diagnostics: combinedDiagnostics(iterationOpenedBy, lastDiagnostics),
          };
          break;
        }
        continue;
      }
      if (batch !== null) {
        // Atomic apply (#69): every payload passed its own guard above, so the
        // prepared sources are written together; a single failure wrote nothing.
        for (const write of batchWrites) {
          writeTarget(cwd, write.path, write.source);
        }
      } else {
        writeTarget(cwd, target, newSource);
      }
      appliedEdit = true;
      // An applied edit ends the rejection chain (#56): the next rejection
      // starts a fresh streak regardless of the verification outcome below.
      clearRejectionPolicy();
      // Resubmission guard (#48): an applied modify submission is remembered
      // so the next iteration cannot re-apply the identical payload/batch.
      if (batch !== null) {
        lastModifySubmission = submissionOf(batch, true, null);
      } else if (payload !== null && pinnedTarget.mode === "modify") {
        lastModifySubmission = submissionOf([payload], true, null);
      }
      records.push(
        recordRow({
          row: records.length + 1,
          iteration,
          kind: "exchange",
          exchange,
          locator: pinnedTarget.locator,
          replacement,
          diagnostics: null,
          outcome: "applied",
          finishReason: response.finishReason,
          payloads: batch !== null ? batch.length : payload !== null ? 1 : 0,
          toolCalls: response.toolCalls.length,
          replacementChars: batchReplacementChars ?? undefined,
        }),
      );
      // Verification: tsc + test once per iteration, no model exchange.
      const check = await checkTool(cwd, options.checkCommand, options.commandTimeoutMs);
      const test = await runVerificationTests(cwd, target, options);
      if (check.ok && test.ok) {
        records.push(
          recordRow({
            row: records.length + 1,
            iteration,
            kind: "verification",
            exchange: null,
            locator: pinnedTarget.locator,
            replacement,
            diagnostics: null,
            outcome: "ok",
            finishReason: response.finishReason,
          }),
        );
        return success(newSource);
      }
      // No rollback (#30): the attempted state stays on disk for the next
      // iteration to refine. A failure just starts the next iteration, which
      // gets a fresh ≤3 exchange budget.
      const diagnostics = formatDiagnostics({
        check,
        test,
        targetPath: target,
        baseSource: sourceBefore,
        newSource,
      });
      const signature = check.diagnostics.length + failingTestNames(test.output).length;
      records.push(
        recordRow({
          row: records.length + 1,
          iteration,
          kind: "verification",
          exchange: null,
          locator: pinnedTarget.locator,
          replacement,
          diagnostics,
          outcome: check.ok ? "tests" : "tsc",
          finishReason: response.finishReason,
          signature,
        }),
      );
      pendingDiagnostics = diagnostics;
      pendingVerificationStage = check.ok ? "tests" : "tsc";
      // One more consecutive verification-failed round (#54): the count spans
      // rounds and #52 continuations; only a pass (which ends the run) resets it.
      stalledRounds += 1;
      verificationFailed = true;
      break;
    }

    // No-progress counting (#60): a round that ends with no applied edit (all
    // exchanges rejected, truncated, or spent picking) counts exactly like a
    // failed verification; only a pass (which ends the run) stops the chain.
    // The #54 decision point then fires in rejection cycles at the same
    // multiples of MAX_STALLED_ROUNDS.
    if (!verificationFailed && !appliedEdit) {
      stalledRounds += 1;
    }
    if (verificationFailed) {
      continue;
    }
    // Round-level continuation (#52): a successful pick may have consumed the
    // last exchange (no content exchange is left); below the cap the round
    // continues through a continuation prompt instead of ending the run.
    if (continuation === null && pinned !== null && iteration < MAX_RUN_ITERATIONS) {
      continuation = {
        round: iteration,
        pick: false,
        diagnostics: combinedDiagnostics(iterationOpenedBy, lastDiagnostics),
      };
    }
    if (continuation !== null) {
      // A continued verification-repair chain keeps its opening diagnostics, so
      // the continuation (and its retries) may still re-pin (#52).
      if (iterationOpenedBy !== null) {
        pendingDiagnostics = iterationOpenedBy;
      }
      // ...and its prompt variant (#49): a tsc-repair chain stays lean.
      if (iterationOpenedByStage !== null) {
        pendingVerificationStage = iterationOpenedByStage;
      }
      continue;
    }
    if (iteration >= MAX_RUN_ITERATIONS) {
      return await terminate("edit-exhausted", capDiagnostics(iterationOpenedBy));
    }
    // Unreachable: the exchange loop only falls through after a pick or with a
    // continuation set.
    return await terminate(
      "edit-exhausted",
      exhaustedDiagnostics(iterationOpenedBy, lastDiagnostics),
    );
  }
}
