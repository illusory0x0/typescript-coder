import { createHash } from "node:crypto";
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
import { stripCodeFences } from "./matcher";
import { parseMultiEditor, parseSelection, SelectionSyntaxError } from "./selection";
import type { EditStatement, FileStatement, Selection as EditDslSelection } from "./selection";
import { isFileSelection } from "./selection";
import { renderReadFailureFeedback, renderReadFeedback, resolveMultiEditor } from "./multi-editor";
import type { MultiEditorDeps, MultiEditorResolution } from "./multi-editor";
import {
  duplicateDeclarationNote,
  ignoredInertClausesWarning,
  markedViewerLines,
  partitionEditDslFailures,
  renderViewerFeedback,
  resolveEditDslReply,
} from "./edit-dsl";
import type { EditDslRegion } from "./edit-dsl";
import { formatSource } from "./editor";
import {
  applyResolvedRegions,
  codeFrame,
  duplicateDeclarationDiagnostics,
  gateDiagnostics,
  lineColumnAt,
  NOOP_DIAGNOSTICS,
  parseCheck,
  prevBrokenDiagnostics,
  sameAfterFormatting,
  toLines,
} from "./commit";
import { LexError } from "./lexer";
import { sourceLineAt } from "./dsl-diagnostics";
import { ParseError, Parser } from "./parser";
import {
  buildIndexTolerant,
  declarationSpaces,
  grammarKindsForEntryKind,
  memberDeletionRange,
  wholeSymbolRestrictionDiagnostics,
} from "./utility";
import { buildSignatureViewFromEntry } from "./scroll";
import { checkTool, testTool } from "./tools";
import { billableCostForLoopTokens } from "./pricing";
import { usageFromRaw } from "./replay-format";
import { ChatContextOverflowError, ChatPayloadTooLargeError } from "./openai";
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ReasoningEffort,
  ToolDefinition,
} from "./openai";
import type { Expression, Node, Program, Statement } from "./parser";
import type { SelectionStage } from "./cascade";
import type { CheckDiagnostic, CommandResult } from "./tools";
import type {
  IndexEntry,
  Locator,
  SkippedFile,
  SourceFile,
  SymbolIndex,
  SymbolSpace,
  TolerantIndex,
} from "./utility";
import type { NodeSummary } from "./tasks";
import {
  APPROACH_LIMIT,
  CONTEXT_SYMBOL_LIMIT,
  numberedSourceBlock,
  SPEC_FILE_LIMIT,
  splitSourceLines,
  TEST_FILE_SUFFIX,
  truncateSource,
} from "./prompts/shared";
import {
  buildEditDslCommandPrompt,
  buildEditDslCommandRetryPrompt,
  buildEditDslCreatePrompt,
  buildEditDslDetailsPrompt,
  buildEditDslEditPrompt,
  buildEditDslModifiedPrompt,
  buildEditDslPinnedCreatePrompt,
  buildEditDslReadPrompt,
  buildEditDslSelectionContinuationPrompt,
  buildEditDslSelectionRetryPrompt,
  buildEditDslSymbolIndex,
  buildEditDslSystemPrompt,
  buildEditDslUserPrompt,
  editDslContextBlock,
  editDslCreateInstruction,
  editDslInstruction,
} from "./prompts/edit-dsl";

export {
  APPROACH_LIMIT,
  numberedSourceBlock,
  numberedSourceRange,
  SPEC_FILE_LIMIT,
} from "./prompts/shared";
export {
  buildEditDslCreatePrompt,
  buildEditDslDetailsPrompt,
  buildEditDslModifiedPrompt,
  buildEditDslSelectionContinuationPrompt,
  buildEditDslSelectionRetryPrompt,
  buildEditDslSymbolIndex,
  buildEditDslUserPrompt,
} from "./prompts/edit-dsl";

/** The loop's only model reply protocol. */
export type ProtocolFormat = "edit-dsl";

// Prompt entry points kept for callers that build the model-facing messages.
export function buildSystemPrompt(): string {
  return buildEditDslSystemPrompt();
}

export function buildEditPrompt(addressJson: string, symbolSource: string): string {
  return buildEditDslEditPrompt(addressJson, symbolSource);
}

export function buildCreatePrompt(addressJson: string, path: string): string {
  return buildEditDslPinnedCreatePrompt(addressJson, path);
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "tmp"]);
const SIGNATURE_LIMIT = 200;
// Path-like tokens in the issue text, e.g. `src/lisp.ts` inside backticks.
const ISSUE_PATH_PATTERN = /[\w./-]+\.ts\b/g;

// The protocol failure an edit-dsl round returns when the reply is not a
// `select … end` clause. A JSON edit payload never matches the grammar, so it is
// rejected here too.
export const EDIT_DSL_FORCE_DIAGNOSTICS =
  "stage: protocol\nthe reply must be one or more `select … end` clauses; a JSON edit payload is not accepted in this mode";

// A JSON edit payload is a protocol rejection; any other unparseable reply names
// its actual syntax error. `SelectionSyntaxError` already carries the shared
// renderer's line/column excerpt (#33), so this only keeps that classification.
function editDslParseDiagnostics(content: string, error: SelectionSyntaxError): string {
  const text = stripCodeFences(content);
  if (text.trimStart().startsWith("{")) {
    return EDIT_DSL_FORCE_DIAGNOSTICS;
  }
  return error.diagnostics;
}

// A `protocol` rejection means the reply was not `select … end` (usually a
// JSON edit payload). The retry must re-teach the edit-dsl form rather than the
// old payload correction that would drive the model back to it.
const EDIT_DSL_PROTOCOL_CORRECTION =
  "Reply with one or more `select` clauses or a file command (`create`, `delete`, `read`, `write`) as the entire response; a replacement ends at its fence close, while a viewer or rename ends with `end` (`select <symbol> in <path> [ resolve <value|type|namespace> ] [ match <snippet> | match /<regex>/ ] [ [ pick <range> ] replace with <fence> | rename <old> to <new> end | end ]`, where a create/replace fence opens with `TC_EDIT_BEGIN` on its own line and closes with `TC_EDIT_END` on its own line; the fence close terminates a replacement, while a viewer or rename ends with `end`; a `pick` requires `replace`, and `rename` cannot be combined with either; every clause in one reply must target a different resolved declaration `(path, symbol, kind)`, so address one declaration at most once and split its edits across exchanges); a matcher has no parentheses; a path-only create is only `create <path> end`; use `write` for file content. A JSON edit payload is not accepted in this mode.";
const EDIT_DSL_PROTOCOL_ESCALATION =
  "This attempt MUST reply with only `select … end` clauses or file commands — with no prose, no markdown fences, and no JSON edit payload.";

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

/**
 * The no-progress ask (#54/#60) facts the retry header renders. The first ask
 * is byte-identical to the original wording; from the second decision point on
 * the header is sharpened (#65) with the `history` fact.
 *
 * #57: this is a cadence, not a cap. `failedAttempts` counts consecutive
 * rejected exchanges and failed verifications; the run still ends through the
 * USD cost budget or a repeated no-progress fingerprint, never because this count
 * reached a fixed exchange/round limit.
 */
export interface StalledAsk {
  failedAttempts: number;
  /**
   * 1-based decision-point number (`failedAttempts / MAX_STALLED_ROUNDS`): 1 is
   * the first ask; 2+ fold in the unchanged/cycling fact and demand
   * address-or-STOP. Absent is treated as the first ask.
   */
  askNumber?: number;
  /** The `#71` failure pattern the sharpened ask names; null while still changing. */
  history?: FailurePattern | null;
}

export interface RetryPromptInput {
  /**
   * 1-based exchange number the prompt requests. It is informational only: #57
   * removed the fixed exchange budget, so no "N of M" remainder is rendered.
   */
  exchangeNumber: number;
  /** `create` asks for the complete declaration; `modify` for an edit clause. */
  mode: "modify" | "create";
  /** Current on-disk source of the selected region (whole file in create mode). */
  currentSource: string;
  /**
   * Optional pre-rendered details block that replaces the numbered source. The
   * repair-context shrink supplies a partial, original-line-numbered view here.
   */
  preRenderedSource?: string;
  diagnostics: string;
  /** Verification retries say "failed verification"; edit retries say "failed". */
  failure: "edit" | "verification";
  /**
   * No-progress ask (#54): replaces the exchange header (and the corrective
   * action sentence) with the consecutive-failed-attempts framing. From the
   * second ask (#65) the header names the unchanged/cycling failing set. This
   * prompt (and the selection no-progress ask) is the only one that offers
   * `STOP`; there is no fixed exchange or round cap behind it.
   */
  stalled?: StalledAsk;
  /**
   * Per-cause rejection correction (#56): replaces the default corrective lead
   * sentence with the class-specific action (or its escalation); `stalled`
   * takes precedence when both are present.
   */
  correction?: string;
  /**
   * Prior-attempts digest (#57): the bounded checkpoint appended after the
   * Diagnostics block. Only the #54/#57 no-progress asks carry it; ordinary
   * retries stay unchanged.
   */
  digest?: string;
  /**
   * Failure history (#71): the bounded non-convergence note (unchanged failing
   * set or a two-state cycle), appended after the Diagnostics block and before
   * the digest; ordinary retries carry it too.
   */
  failureHistory?: string;
  /**
   * Stated re-approach (#75): the reply the model gave to the preceding
   * decision-only turn, rendered as an `Approach to apply:` block after the
   * Diagnostics block so the edit must follow it. Undefined/empty renders
   * nothing; the next exchange after a decision turn sets it.
   */
  approach?: string;
  /** Goal + symbol index for the edit-dsl prompt shape, plus the start line. */
  editDslContext?: { issue: string; indexText: string; startLine?: number };
  /**
   * Bounded self-verification result (#73), appended after the Diagnostics
   * block as a `Self-check result:` section. Rendered only on the prompt that
   * immediately follows the executed request; ordinary retries set nothing.
   */
  selfCheck?: string;
}

/**
 * The no-progress ask header (#54/#57). The first decision point keeps the
 * original first sentence and offers STOP; from the second on (#65) it names the
 * unchanged/cycling failing set the `#71 Failure history` note carries and
 * requires the reply to address it or `STOP`. There is no round maximum: the
 * cadence only schedules the ask, and the run still ends on the USD cost budget or
 * a repeated no-progress fingerprint.
 */
function stalledAskHeader(stalled: StalledAsk): string {
  const base = `No progress: ${stalled.failedAttempts} consecutive failed attempts.`;
  const askNumber = stalled.askNumber ?? 1;
  if (askNumber <= 1) {
    return `${base} Reply exactly \`STOP\` to end the run now, but only if the failures cannot be resolved; otherwise take a materially different approach rather than another minimal attempt.`;
  }
  const history =
    stalled.history?.kind === "unchanged"
      ? `the failing set is unchanged across the last ${stalled.history.rounds} verification rounds`
      : stalled.history?.kind === "alternating"
        ? `the failing set has cycled between two states across the last ${stalled.history.rounds} verification rounds`
        : "the failing set has not converged";
  return `${base} This is repeated ask ${askNumber} and the previous ask did not resolve it: ${history}, so another minimal edit at the same spot cannot help. This reply MUST either directly address that unchanged failing set — change the cause the diagnostics below name — or, only if it cannot be resolved, reply exactly \`STOP\` to end the run now.`;
}

/**
 * Decision-only turn instruction (#75): shown in place of the edit template on a
 * repeated no-progress ask whose `#71` pattern is non-converging. It keeps the
 * sharpened ask header, the failing diagnostics, and the failure history, and
 * offers only two replies: `STOP`, or a re-approach statement the next exchange
 * carries. No cap or auto-stop: a real edit reply is still a valid attempt.
 */
const DECISION_INSTRUCTION =
  "This is a decision turn: reply with a short re-approach statement — name what you will change (the cause) and where — instead of another edit clause. Reply exactly `STOP` to end the run now, but only if the failing set cannot be resolved. Do not send an edit clause on this turn.";

/**
 * True when a decision-turn reply still carries a structurally valid edit-dsl
 * reply (#75): such a reply is a real attempt and flows through the unchanged
 * guards; any other reply is the stated re-approach.
 */
function isEditDslReply(content: string): boolean {
  try {
    return parseSelection(content).length > 0;
  } catch {
    return false;
  }
}

export function buildRetryPrompt(input: RetryPromptInput): string {
  const { exchangeNumber, mode, currentSource, diagnostics, failure } = input;
  const label = failure === "verification" ? "failed verification" : "failed";
  const stalled = input.stalled;
  const editDslContext = input.editDslContext ?? { issue: "", indexText: "" };
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
  // Only an ordinary retry names its attempt; the #54 stalled header already
  // frames the no-progress ask. #57 removed the fixed exchange budget, so no
  // "N of M" or remaining count is rendered.
  const status = stalled !== undefined ? "" : `Edit exchange ${exchangeNumber} ${label}. `;
  const instruction =
    mode === "modify"
      ? `${modifyLead} ${status}${editDslInstruction()}`
      : `${createLead} ${status}${editDslCreateInstruction()}`;
  const header = stalled === undefined ? "" : stalledAskHeader(stalled);
  const digestSection =
    input.digest === undefined || input.digest.trim() === "" ? "" : `\n${input.digest}\n`;
  const failureHistorySection =
    input.failureHistory === undefined || input.failureHistory.trim() === ""
      ? ""
      : `\n${input.failureHistory}\n`;
  const selfCheckSection =
    input.selfCheck === undefined || input.selfCheck.trim() === ""
      ? ""
      : `\nSelf-check result:\n\n\`\`\`\n${input.selfCheck}\n\`\`\`\n`;
  const approachSection =
    input.approach === undefined || input.approach.trim() === ""
      ? ""
      : `\nApproach to apply:\n\n${input.approach}\n`;
  // Decision-only turn (#75): a repeated non-converging ask drops the edit
  // template and keeps the sharpened header plus the failing diagnostics and
  // history.
  if (stalled !== undefined && isDecisionAsk(stalled)) {
    return `${header}

${editDslContextBlock(editDslContext, currentSource, input.preRenderedSource)}

${DECISION_INSTRUCTION}

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`
${failureHistorySection}${digestSection}`;
  }
  return `${header === "" ? "" : `${header}\n\n`}${editDslContextBlock(editDslContext, currentSource, input.preRenderedSource)}

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`
${selfCheckSection}${approachSection}${failureHistorySection}${digestSection}
${instruction}`;
}

const TERMINATION_SUMMARY: Record<TerminationReason | "provider-error", string> = {
  "cost-budget": "the USD cost budget was exceeded",
  "edit-exhausted": "the run ended without a verified edit",
  "delete-verification-failed": "the deletion could not be verified",
  "prev-broken": "the current source of the target no longer parses",
  "provider-error": "the provider call failed",
  "harness-fault": "the harness produced an invalid edit candidate at the format gate",
  "output-limit": "the completion hit the output limit three times in a row without a usable edit",
  "task-exhausted":
    "the planned edit tree could not be carried out (planning or execution exhausted its budget)",
};

/**
 * Termination step (#43): the summary prompt is the final user message of a
 * failed run, not an Edit attempt — it is never counted against the token
 * budget or the no-progress cadence.
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

export { stripCodeFences };

export type SelectionMode = "modify" | "create" | "delete";

/**
 * Optional `(line, column)` selector (#72): a 1-based, inclusive-end position
 * range relative to the current source block shown in the prompt (the pinned
 * declaration for a modify round). It is an alternative to `matcher` for the
 * ambiguity class the structural matcher cannot resolve, and when both are sent
 * `range` takes precedence.
 */
export interface EditRange {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** Which selector an applied edit used (#101): range, matcher, or whole-symbol. */
export type EditSelector = "range" | "matcher" | "whole-symbol";

/**
 * The form of matcher a `match`-stage edit used (#110): a structural snippet
 * copied from the source, or a `/regex/` locator.
 */
export type MatcherKind = "snippet" | "regex";

/**
 * The #101 selector vocabulary for a resolved cascade stage (#111):
 * `pick`→`range`, `match`→`matcher`, `whole-symbol`→`whole-symbol`.
 */
export function selectorFromStage(stage: SelectionStage): EditSelector {
  if (stage === "pick") {
    return "range";
  }
  return stage === "match" ? "matcher" : "whole-symbol";
}

// ---------------------------------------------------------------------------
// Bounded self-verification request (#73)

/** Result of parsing a standalone edit-dsl self-check command. */
export type EditDslSelfCheckParse =
  | { kind: "none" }
  | { kind: "ok"; request: "check" | "test" }
  | { kind: "error"; diagnostics: string };

const EDIT_DSL_SELF_CHECK_PREFIX = /^(check|test)(?:\s|$)/i;
const EDIT_DSL_SELF_CHECK_EXACT = /^(check|test)\s+end$/i;

/**
 * Parse the edit-dsl self-check turn: exactly `check end` or `test end`.
 * It is a standalone control reply, not a file command or an edit; anything
 * that only starts with one of the words is a protocol error, and anything
 * else falls through to the ordinary edit-dsl parser.
 */
export function parseEditDslSelfCheck(content: string): EditDslSelfCheckParse {
  const trimmed = content.trim();
  if (!EDIT_DSL_SELF_CHECK_PREFIX.test(trimmed)) {
    return { kind: "none" };
  }
  const match = EDIT_DSL_SELF_CHECK_EXACT.exec(trimmed);
  if (match === null) {
    return {
      kind: "error",
      diagnostics:
        "stage: protocol\nself-check commands are standalone; reply with exactly `check end` or `test end`, with no arguments, edits, reads, selects, JSON, or prose",
    };
  }
  const request = match[1]?.toLowerCase();
  if (request !== "check" && request !== "test") {
    return { kind: "none" };
  }
  return { kind: "ok", request };
}

/** Shared stdout+stderr budget for one self-check command result (#73). */
export const SELF_CHECK_OUTPUT_LIMIT = 4_000;

// Clamp command output to the self-check bound, naming how much was dropped; an
// empty result stays explicit so the model can tell "no output" from "failed".
function clampSelfCheckOutput(output: string): string {
  const trimmed = output.trimEnd();
  if (trimmed === "") {
    return "(no output)";
  }
  return trimmed.length > SELF_CHECK_OUTPUT_LIMIT
    ? `${trimmed.slice(0, SELF_CHECK_OUTPUT_LIMIT)}\n… [truncated ${trimmed.length - SELF_CHECK_OUTPUT_LIMIT} characters]`
    : trimmed;
}

/** Bounded command-result rendering for a `check`/`test` request (#73). */
export function renderSelfCheckCommand(
  kind: "check" | "test",
  label: string,
  result: CommandResult,
): string {
  const status = result.ok ? "passed" : "failed";
  return `Self-check (${kind}): ${label} ${status} (exit ${result.exitCode}).\n\n\`\`\`\n${clampSelfCheckOutput(result.output)}\n\`\`\``;
}

function addressJson(locator: Locator): string {
  return JSON.stringify({ path: locator.path, symbol: locator.name, kind: locator.kind });
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

export interface ProviderLike {
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatResponse>;
}

/**
 * The loop shape: `pinned-repair` repairs one pinned selection through
 * Edit -> Verify; `plan-exec` plans, executes, and reviews a
 * task-level WorkNode graph.
 */
export type AgentMode = "pinned-repair" | "plan-exec";

/** Canonical loop modes, in display/iteration order. */
export const AGENT_MODES: readonly AgentMode[] = ["pinned-repair", "plan-exec"];
/** The single-target loop remains the default. */
export const DEFAULT_AGENT_MODE: AgentMode = "pinned-repair";

// Deprecated input alias: `edit` remains readable (old reports, replay bundles,
// and CLI invocations), but new output always names the canonical mode.
const AGENT_MODE_ALIASES: Readonly<Record<string, AgentMode>> = {
  "pinned-repair": "pinned-repair",
  edit: "pinned-repair",
  "plan-exec": "plan-exec",
};

/** Canonicalize a loop-mode value, accepting the deprecated alias. */
export function canonicalAgentMode(value: unknown): AgentMode | null {
  if (typeof value !== "string") {
    return null;
  }
  return AGENT_MODE_ALIASES[value] ?? null;
}

/** The hard per-run cache-excluded USD budget (#36). */
export const DEFAULT_COST_BUDGET_USD = 0.1;
/**
 * No-progress ask cadence (#54/#57), not an exchange or round cap: after this
 * many consecutive failed attempts (rejected exchanges plus failed verification
 * rounds), the next prompt asks the model to decide (reply `STOP` or take a
 * materially different approach). The run itself is bounded by the USD cost
 * budget and the repeated no-progress fingerprint; no fixed exchange or round
 * count terminates it.
 */
export const MAX_STALLED_ROUNDS = 8;
/**
 * Output-limit strike guard (#98), not an exchange or round cap: consecutive
 * `finish_reason == "length"` replies are counted from `records`; the third in a
 * row ends the run through the summary/stop path instead of continuing to burn
 * budget. It bounds output truncation, not the number of model attempts.
 */
export const MAX_CONSECUTIVE_LENGTH = 3;

/**
 * No-progress ask cadence after the first decision point (#65): the first ask
 * stays at `MAX_STALLED_ROUNDS`; later asks recur this many failed attempts
 * apart (4), so a fast-burning storm reaches the sharpened repeated ask before
 * the USD cost budget can end the run.
 */
export const STALLED_ASK_INTERVAL = Math.max(1, Math.floor(MAX_STALLED_ROUNDS / 2));

/**
 * True when `failedAttempts` is a no-progress decision point (#54/#60/#65): the
 * first at `MAX_STALLED_ROUNDS` (8), then every `STALLED_ASK_INTERVAL` (4) —
 * 8, 12, 16, 20, … The count schedules an ask; it never terminates a run.
 */
export function isStalledAskMilestone(failedAttempts: number): boolean {
  return (
    failedAttempts >= MAX_STALLED_ROUNDS &&
    (failedAttempts - MAX_STALLED_ROUNDS) % STALLED_ASK_INTERVAL === 0
  );
}

/** 1-based decision-point index for a milestone failed-attempt count (#65). */
export function stalledAskNumber(failedAttempts: number): number {
  return 1 + Math.floor((failedAttempts - MAX_STALLED_ROUNDS) / STALLED_ASK_INTERVAL);
}

/**
 * True when a no-progress ask escalates to a decision-only turn (#75): either
 * signal says another minimal same-spot edit cannot help. A repeat ask
 * (`askNumber >= 2`) escalates even while the `#71` pattern is still changing
 * (`history` null), because a still-changing set at a repeat ask can still be a
 * non-converging oscillation. A first ask escalates too once the failing set is
 * already non-converging (`history` `unchanged`/`alternating`), because that
 * already means another minimal edit cannot help. Only a first ask with a
 * still-changing pattern (`history` null) keeps the exact edit prompt, so
 * json/sexp and a recovering cycle are untouched at the first decision point.
 */
export function isDecisionAsk(stalled: StalledAsk): boolean {
  const askNumber = stalled.askNumber ?? 1;
  return askNumber >= 2 || (stalled.history !== undefined && stalled.history !== null);
}

// Shown on the retry after the same rejection repeats verbatim (#48).
const IDENTICAL_RETRY_NOTE =
  'the previous attempt failed identically; change the shape of the edit (omit "matcher" for a whole-symbol rewrite, adjust the replacement, or re-pin to a different declaration)';

export interface LoopOptions {
  cwd: string;
  issue: string;
  provider: ProviderLike;
  /**
   * Abort the run once accumulated cache-excluded USD cost exceeds this
   * (#36). Defaults to `DEFAULT_COST_BUDGET_USD`; pinned-repair's final
   * termination-summary call is not budgeted, and plan-exec terminates without
   * a summary call.
   */
  costBudgetUsd?: number;
  temperature?: number;
  checkCommand?: string[];
  testCommand?: string[];
  /** Check/test command timeout in ms; defaults to 120_000 (#45). */
  commandTimeoutMs?: number;
  /** Benchmark override: forces this effort on every Edit-loop call, bypassing the default policy (#35). */
  effortOverride?: ReasoningEffort;
  /**
   * Plan-exec only: approve a node without a review model call when its gate
   * passed, every changed path is hinted, and the diff is untruncated. Defaults
   * to `true`; set `false` to review every passing node.
   */
  autoApprove?: boolean;
  /**
   * Loop shape (`--mode`): `pinned-repair` (default) is the single-target
   * Edit → Verify loop; `plan-exec` runs the planning/execution/review
   * loop of `docs/plan-exec.md`, where a planner emits a
   * task-level WorkNode DAG and the harness schedules one node at a time. The
   * deprecated `edit` spelling is accepted only at input boundaries
   * and maps to pinned-repair.
   */
  agentMode?: AgentMode;
}

/** Outcome of one model exchange inside Edit. */
export type ExchangeOutcome =
  | "selected"
  | "applied"
  | "stopped"
  // A repair exchange that carried one bounded self-verification request (#73).
  | "self-check"
  // An edit-dsl viewer clause that located candidates and wrote nothing (#111).
  | "viewer"
  // An edit-dsl `# modified text` confirmation reply (#B3): the verified edit
  // stands; the row is neither an apply nor a rejection.
  | "confirmed"
  | "protocol"
  | "address"
  | "echo"
  | "matcher"
  | "range"
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

/** Matcher-check failures, produced by `spliceEntryEdit` (#56), plus the edit-dsl cascade's `regex-invalid` (#109/#111). */
type MatcherCause =
  | "matcher-unparseable"
  | "matcher-not-found"
  | "matcher-ambiguous"
  | "regex-invalid";

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
  | "range-invalid"
  | "no-op"
  | "repeat"
  | "duplicate"
  | "gate"
  | "format"
  | "format-export-duplication"
  | "truncated"
  | "multi-duplicate";

/** Stage of one rejected content exchange, as recorded and classified (#43/#69). */
type EditFailureStage =
  | "protocol"
  | "echo"
  | "address"
  | "matcher"
  | "range"
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
    | "range"
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
    case "range":
      // A single `range-invalid` class for out-of-bounds, outside-declaration,
      // and empty/end-before-start ranges (#72); the diagnostic names which.
      return "range-invalid";
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
  "This attempt MUST omit `match` and return the complete declaration in a `select … replace with` clause.";

// Repair-context shrink is opt-in: after a create fails verification the loop
// enters create→repair mode and re-sends the whole target file on every repair
// exchange, which can exhaust the USD cost budget on a large file. With
// TC_REPAIR_CONTEXT_SHRINK=on the repair prompt instead renders only the
// declarations that matter. Off by default keeps every prompt byte-identical.
// Read once per call so tests can flip it in-process; only on/1/true enable.
export function repairContextShrinkEnabled(): boolean {
  const setting = (process.env.TC_REPAIR_CONTEXT_SHRINK ?? "").trim().toLowerCase();
  return setting === "on" || setting === "1" || setting === "true";
}

// Declarations whose presence the shrink always keeps: type-level declarations
// cross-reference one another, and a type error can name a value declaration
// while the fix lives in a type alias the diagnostics never mention (e.g.
// minilisp's `LispValue`).
const SHRINK_TYPE_LEVEL_KINDS = new Set(["type", "interface", "enum", "namespace"]);
// The diagnostics render each failure as `… — in declaration \`name\` (kind)`.
const DIAGNOSTIC_DECLARATION = /in declaration `([^`]+)`/g;

/**
 * Build a partial, original-line-numbered view of a repaired file (#create→repair).
 * Keeps the pinned declaration, every declaration named in the diagnostics, and
 * every type-level declaration; drops the rest behind an omission marker. Returns
 * `null` to mean "show the whole file" when the file does not parse, is small, or
 * the shrunk view would not actually be shorter.
 */
export function shrinkRepairSource(
  path: string,
  source: string,
  locator: Locator,
  diagnostics: string,
): string | null {
  if (source.length <= SPEC_FILE_LIMIT / 2) {
    return null;
  }
  const build = buildIndexTolerant([{ path, source }]);
  if (build.skipped.length > 0) {
    return null;
  }
  const kept: IndexEntry[] = [];
  const keptStarts = new Set<number>();
  const keep = (entry: IndexEntry): void => {
    if (keptStarts.has(entry.node.start)) {
      return;
    }
    keptStarts.add(entry.node.start);
    kept.push(entry);
  };
  const pinned = build.index.lookup(locator);
  if (pinned.length === 1 && pinned[0] !== undefined) {
    keep(pinned[0]);
  }
  for (const match of diagnostics.matchAll(DIAGNOSTIC_DECLARATION)) {
    const name = match[1];
    if (name === undefined) {
      continue;
    }
    for (const entry of build.index.byName(name)) {
      keep(entry);
    }
  }
  for (const entry of build.index.entries) {
    if (SHRINK_TYPE_LEVEL_KINDS.has(entry.locator.kind)) {
      keep(entry);
    }
  }
  // Nothing to keep (no resolvable pin, no named declaration, no type) means the
  // partial view would hide the whole file: fall back to the whole file.
  if (kept.length === 0) {
    return null;
  }
  kept.sort((left, right) => left.node.start - right.node.start);
  const sourceLines = splitSourceLines(source);
  const width = String(sourceLines.length).length;
  const rendered: string[] = [];
  // Line number just past the previously rendered declaration, so the next
  // declaration's first line reveals how many lines were skipped.
  let previousEndLine: number | null = null;
  let previousNodeEnd = 0;
  for (const entry of kept) {
    const firstLine = source.slice(0, entry.node.start).split("\n").length;
    if (previousEndLine !== null && firstLine > previousEndLine) {
      rendered.push(
        omissionMarker(
          build.index.entries,
          previousNodeEnd,
          entry.node.start,
          firstLine - previousEndLine,
        ),
      );
    }
    const raw = source.slice(entry.node.start, entry.node.end);
    const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    const lines = body.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      rendered.push(`${String(firstLine + index).padStart(width, " ")} | ${lines[index]}`);
    }
    previousEndLine = firstLine + lines.length;
    previousNodeEnd = entry.node.end;
  }
  const text = rendered.join("\n");
  return text.length < source.length ? text : null;
}

// One marker line for the declarations skipped between two kept declarations.
function omissionMarker(
  entries: readonly IndexEntry[],
  gapStart: number,
  gapEnd: number,
  gapLines: number,
): string {
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.node.start <= gapStart || entry.node.start >= gapEnd) {
      continue;
    }
    if (!names.includes(entry.locator.name)) {
      names.push(entry.locator.name);
    }
  }
  return names.length > 0
    ? `// … [omitted: ${names.join(", ")}] …`
    : `// … [${gapLines} lines omitted] …`;
}

// #65 resend classes: `repeat` means the byte-identical payload was already
// submitted (applied and still failing, or rejected), `duplicate` means a
// candidate would add a second top-level copy of a declaration the file
// already carries or (#40/#41) a reply addresses one resolved declaration more
// than once. Either way the file already reflects the outcome, so the lead
// states that and forces the next attempt to differ — the rejected
// replacements themselves are never re-echoed into the prompt.
const REPEAT_CORRECTION =
  "That exact submission was already sent, and the file already reflects its outcome — the change is in place or nothing was written — so resending it cannot change anything. Change the target, the matcher, or the replacement so the next attempt actually differs and addresses the diagnostics below.";
const REPEAT_ESCALATION =
  "That exact submission has now been rejected repeatedly, and resending it cannot change the file. This attempt MUST differ from the previous attempts — a different target, matcher, or replacement form — and must address the diagnostics below.";
const DUPLICATE_CORRECTION =
  "The reply either adds a second top-level copy of a symbol the file already declares, or two clauses target the same resolved declaration `(path, symbol, kind)`; neither can succeed. Address one declaration once per reply and split its edits across exchanges; change the replacement so it is not a second copy, and address the diagnostics below.";
const DUPLICATE_ESCALATION =
  "This edit keeps adding another top-level copy of a symbol the file already declares or keeps targeting one declaration with more than one clause. This attempt MUST return a replacement that differs from the current source, address one declaration once, and edit the existing declaration instead of re-declaring it.";

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

// #24: after repeated address failures the ordinary "re-pin" advice has not
// worked (wrong kind, local/unindexable target). Offer two concrete escapes
// derived from the live target: the bare select that omits the kind, and the
// raw whole-file write that bypasses address resolution entirely.
function repeatedAddressFallback(path: string, name: string): string {
  const write = `write ${path} with TC_EDIT_BEGIN … TC_EDIT_END`;
  if (name === "") {
    return `The address keeps failing, so stop trying to select it. Repair the whole file with a raw \`${write}\` (open the body with \`TC_EDIT_BEGIN\` and close it with \`TC_EDIT_END\`).`;
  }
  return `The address keeps failing, so stop guessing at its kind. Select the live target with a bare \`select ${name} in ${path}\` (omit the kind), or repair the whole file with a raw \`${write}\` (open the body with \`TC_EDIT_BEGIN\` and close it with \`TC_EDIT_END\`).`;
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
  /**
   * Total address rejections since the last applied edit (#24). Unlike the
   * same-cause streak this survives intervening protocol/matcher failures.
   */
  addressFailures?: number;
  /** The live path/name of the address that kept failing (#24). */
  address?: { path: string; name: string };
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
  // #24: a repeated address failure gets a concrete escape before the generic
  // policy repeats advice the model has already failed to apply.
  if (
    cause === "address" &&
    (context.addressFailures ?? 0) >= 2 &&
    context.address !== undefined &&
    context.address.path !== ""
  ) {
    return repeatedAddressFallback(context.address.path, context.address.name);
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
        correction: EDIT_DSL_PROTOCOL_CORRECTION,
        escalation: EDIT_DSL_PROTOCOL_ESCALATION,
      };
    case "echo":
      return {
        action: "retry",
        correction:
          "Echo the pinned address exactly as shown; re-pin only when the diagnostics name another declaration.",
        escalation:
          "This attempt MUST echo the pinned address exactly as shown — the same path, symbol, and kind values.",
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
          "Copy the `match` snippet verbatim from the current source as one complete statement, expression, or contiguous run of statements, or omit `match` for a whole-symbol rewrite.",
        escalation: MATCHER_ESCALATION,
      };
    case "matcher-not-found":
      return {
        action: "retry",
        correction:
          "Copy the `match` snippet verbatim from the current source, or omit `match` for a whole-symbol rewrite.",
        escalation: MATCHER_ESCALATION,
      };
    case "matcher-ambiguous":
      return {
        action: "retry",
        correction:
          "Extend the `match` snippet with more surrounding context copied from the current source, or omit `match` for a whole-symbol rewrite.",
        escalation: MATCHER_ESCALATION,
      };
    case "regex-invalid":
      return {
        action: "retry",
        correction:
          "Write a valid ECMA-262 `/regex/` matcher with no flags — escape any literal slash — or copy a verbatim backtick snippet from the current source.",
        escalation: MATCHER_ESCALATION,
      };
    case "range-invalid":
      return {
        action: "retry",
        correction:
          "The `pick` range is invalid for the current source: copy the 1-based file-absolute line and column positions from the numbered source block, keep the end inclusive, and keep the range inside the pinned declaration — or omit `pick`.",
        escalation:
          "This attempt MUST address the current source: omit `pick` and return the complete declaration (or a verbatim `match`) rather than repeating invalid coordinates.",
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
    case "multi-duplicate":
      return {
        action: "retry",
        correction:
          "Two clauses of the edit-dsl reply addressed overlapping regions of the same file, so none of them was written. Make every same-file clause address a distinct, non-overlapping declaration or span, or split the edits across replies.",
        escalation:
          "This attempt MUST give the same file's clauses non-overlapping regions: address distinct declarations or disjoint spans.",
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
  /**
   * 1-based exchange index inside the Run iteration; null for verification
   * rows. #57 removed the fixed exchange budget, so this is informational only.
   */
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
  /** Addresses this applied exchange covered, so the result can name every file. */
  appliedLocators?: Locator[];
  /**
   * Selectors used by the exchange's parsed payloads (#101): one entry per
   * payload in order (a batch contributes one per entry); omitted when the
   * exchange carried no payload.
   */
  selectors?: EditSelector[];
  /**
   * Resolved cascade stages used by the exchange's parsed payloads (#110): one
   * entry per payload in order, mirroring `selectors`; omitted when the exchange
   * carried no payload.
   */
  stages?: SelectionStage[];
  /**
   * Matcher kinds used by the exchange's parsed payloads (#110), parallel to
   * `stages`: one entry per payload, `null` when no matcher resolved it.
   */
  matcherKinds?: (MatcherKind | null)[];
  /**
   * EditDsl implicit-create clauses the reply carried (#111): create clauses
   * resolve at the `whole-symbol` stage, so this is a subset of `stages`.
   * Omitted when the exchange was not an edit-dsl reply.
   */
  creates?: number;
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
  /** Exchange rows that executed a self-verification request (`self-check`, #73). */
  selfChecks: number;
  /** Applied/parsed payloads that used the `range` selector (#101). */
  range: number;
  /** Applied/parsed payloads that used the `matcher` selector (#101). */
  matcher: number;
  /** Applied/parsed payloads that rewrote the whole symbol (#101). */
  wholeSymbol: number;
  /** Applied/parsed payloads resolved by the cascade's `whole-symbol` stage (#110). */
  stageWholeSymbol: number;
  /** Applied/parsed payloads resolved by the cascade's `match` stage (#110). */
  stageMatch: number;
  /** Applied/parsed payloads resolved by the cascade's `pick` stage (#110). */
  stagePick: number;
  /** Applied/parsed payloads whose matcher was a structural snippet (#110). */
  snippet: number;
  /** Applied/parsed payloads whose matcher was a `/regex/` (#110). */
  regex: number;
  /** EditDsl implicit-create clauses carried per reply (#111). */
  creates: number;
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
    selfChecks: 0,
    range: 0,
    matcher: 0,
    wholeSymbol: 0,
    stageWholeSymbol: 0,
    stageMatch: 0,
    stagePick: 0,
    snippet: 0,
    regex: 0,
    creates: 0,
  };
  for (const record of records) {
    if (record.kind !== "exchange") {
      continue;
    }
    stats.turns += 1;
    stats.payloads += record.payloads ?? 0;
    stats.toolCalls += record.toolCalls ?? 0;
    stats.creates += record.creates ?? 0;
    for (const selector of record.selectors ?? []) {
      if (selector === "range") {
        stats.range += 1;
      } else if (selector === "matcher") {
        stats.matcher += 1;
      } else {
        stats.wholeSymbol += 1;
      }
    }
    for (const stage of record.stages ?? []) {
      if (stage === "whole-symbol") {
        stats.stageWholeSymbol += 1;
      } else if (stage === "match") {
        stats.stageMatch += 1;
      } else {
        stats.stagePick += 1;
      }
    }
    for (const kind of record.matcherKinds ?? []) {
      if (kind === "snippet") {
        stats.snippet += 1;
      } else if (kind === "regex") {
        stats.regex += 1;
      }
    }
    if (record.outcome === "applied") {
      stats.applied += 1;
    } else if (record.outcome === "selected") {
      stats.selected += 1;
    } else if (record.outcome === "stopped") {
      stats.stopped += 1;
    } else if (record.outcome === "self-check") {
      stats.selfChecks += 1;
    } else if (record.outcome === "viewer") {
      // An edit-dsl viewer locate turn (#111): neither applied nor a rejection.
    } else if (record.outcome === "confirmed") {
      // An edit-dsl `# modified text` confirmation (#B3): the verified apply
      // stands, so this row is neither applied nor rejected.
    } else {
      stats.rejected += 1;
    }
  }
  return stats;
}

/**
 * Output-limit strike counter (#98): walk `records` from the end while the row's
 * `finishReason` is `"length"` and return that trailing run's length. Returns 0
 * when the most recent row is not a length finish, which resets the strike.
 */
export function consecutiveLengthFinishes(records: readonly LoopRecord[]): number {
  let count = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.finishReason !== "length") {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * v2 termination matrix (#43): a run ends through one of these, and each ends
 * with exactly one LLM-written summary as its final action.
 */
export type TerminationReason =
  | "cost-budget"
  | "edit-exhausted"
  | "delete-verification-failed"
  | "prev-broken"
  | "harness-fault"
  | "output-limit"
  | "task-exhausted";

/**
 * Token spend of one run (#80): the component breakdown of every provider
 * response's raw usage, threaded onto the result so a sub-agent caller can
 * account for the call. The raw `total` is retained for reporting; the hard
 * budget is charged from the cache-excluded USD cost instead.
 */
export interface LoopTokens {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  /**
   * Reasoning tokens when reported (#47), otherwise 0. Read from
   * `completion_tokens_details.reasoning_tokens` or a top-level
   * `reasoning_tokens`; the cache-excluded USD basis adds it to output.
   */
  reasoning: number;
}

/** A fresh all-zero token tally (#80); safe to return and never mutate. */
export function zeroLoopTokens(): LoopTokens {
  return { input: 0, output: 0, total: 0, cacheRead: 0, reasoning: 0 };
}

/**
 * Plan/execute provider spend by conversation bucket (#32): the planner's
 * initial/replan turns, the post-execution review turns, and the executor's
 * edit/self-check turns. The three totals sum to `LoopResult.tokens`.
 */
export interface LoopUsage {
  planning: LoopTokens;
  review: LoopTokens;
  execution: LoopTokens;
}

/** A fresh all-zero usage snapshot. */
export function zeroLoopUsage(): LoopUsage {
  return {
    planning: zeroLoopTokens(),
    review: zeroLoopTokens(),
    execution: zeroLoopTokens(),
  };
}

/** Add one response's token components into a bucket in place. */
export function addLoopTokens(target: LoopTokens, delta: LoopTokens): void {
  target.input += delta.input;
  target.output += delta.output;
  target.total += delta.total;
  target.cacheRead += delta.cacheRead;
  target.reasoning += delta.reasoning;
}

/** Sum the three buckets; this is the raw token total reported on the result. */
export function totalLoopTokens(usage: LoopUsage): LoopTokens {
  const total = zeroLoopTokens();
  addLoopTokens(total, usage.planning);
  addLoopTokens(total, usage.review);
  addLoopTokens(total, usage.execution);
  return total;
}

/** A detached copy, safe to return on a `LoopResult`. */
export function cloneLoopUsage(usage: LoopUsage): LoopUsage {
  return {
    planning: { ...usage.planning },
    review: { ...usage.review },
    execution: { ...usage.execution },
  };
}

/** Model calls by plan/execute phase; additive telemetry, not a record count. */
export interface LoopTurnCounts {
  readonly planning: number;
  readonly execution: number;
  readonly review: number;
  readonly total: number;
}

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
  /** Provider token spend of the run (#80); zeros when no provider usage was seen. */
  tokens: LoopTokens;
  /**
   * Plan/execute mode (#32): the same spend split across the planning, review,
   * and execution conversations. Absent on the single-target drivers.
   */
  usage?: LoopUsage;
  /**
   * Plan/execute mode: one entry per WorkNode of the final graph, in record
   * order (`typescript-coder-result@3`). Absent on the single-target drivers.
   */
  nodes?: NodeSummary[];
  /**
   * Plan/execute model-call telemetry: calls by conversation bucket. Additive;
   * `records` and `steps` keep their historical execution-row semantics.
   */
  turns?: LoopTurnCounts;
  /**
   * Plan/execute executor transcripts, one per execution attempt. Optional
   * (additive); the benchmark report does not embed these messages.
   */
  executionMessages?: ChatMessage[][];
  /** Recovered parser warnings (#33); absent when the reply was clean. */
  warnings?: string[];
}

type Selection =
  | { mode: "modify"; locator: Locator; entry: IndexEntry }
  | { mode: "create"; locator: Locator; path: string }
  | { mode: "delete"; locator: Locator; entry: IndexEntry };

const EMPTY_LOCATOR: Locator = { path: "", name: "", kind: "" };
const DIAGNOSTICS_LIMIT = 4000;
const DIAGNOSTICS_HEAD_LIMIT = 200;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Render a provider failure for diagnostics (#97): a context-overflow or
// payload-too-large classification gets its own label so the run's defined
// summary path names the cause; everything else keeps the generic text.
export function providerErrorDiagnostics(error: unknown): string {
  if (error instanceof ChatContextOverflowError) {
    return `provider context-overflow: ${errorMessage(error)}`;
  }
  if (error instanceof ChatPayloadTooLargeError) {
    return `provider payload-too-large: ${errorMessage(error)}`;
  }
  return `provider error: ${errorMessage(error)}`;
}

/** Tolerant component reader (#80): a finite number or 0. */
function finiteTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Component breakdown of one provider response's raw usage (#80): `input`/`output`
 * prefer `prompt_tokens`/`completion_tokens` and fall back to
 * `input_tokens`/`output_tokens`; `cacheRead` reads
 * `prompt_tokens_details.cached_tokens` or `cache_read_input_tokens`;
 * `reasoning` reads `completion_tokens_details.reasoning_tokens` or a top-level
 * `reasoning_tokens` (#47); `total` prefers `total_tokens` and falls back to
 * input+output. Unknown shapes count as zero.
 */
export function loopTokensFromResponse(response: ChatResponse): LoopTokens {
  const usage = usageFromRaw(response.raw);
  if (typeof usage !== "object" || usage === null) {
    return zeroLoopTokens();
  }
  const record = usage as Record<string, unknown>;
  const input = finiteTokenCount(record["prompt_tokens"] ?? record["input_tokens"]);
  const output = finiteTokenCount(record["completion_tokens"] ?? record["output_tokens"]);
  let cacheRead = 0;
  const details = record["prompt_tokens_details"];
  if (typeof details === "object" && details !== null) {
    cacheRead = finiteTokenCount((details as Record<string, unknown>)["cached_tokens"]);
  }
  if (cacheRead === 0) {
    cacheRead = finiteTokenCount(record["cache_read_input_tokens"]);
  }
  let reasoning = 0;
  const completionDetails = record["completion_tokens_details"];
  if (typeof completionDetails === "object" && completionDetails !== null) {
    reasoning = finiteTokenCount(
      (completionDetails as Record<string, unknown>)["reasoning_tokens"],
    );
  }
  if (reasoning === 0) {
    reasoning = finiteTokenCount(record["reasoning_tokens"]);
  }
  const reportedTotal = finiteTokenCount(record["total_tokens"]);
  return {
    input,
    output,
    total: reportedTotal !== 0 ? reportedTotal : input + output,
    cacheRead,
    reasoning,
  };
}

/**
 * Cache-excluded USD charged against the hard budget for one provider response
 * (#47): cache-miss input plus output/reasoning at the official peak rate.
 * Cache-hit input is excluded, so the budget measures work rather than cache
 * luck; the benchmark report uses the same formula for its billable columns.
 */
export function costBudgetFromResponse(response: ChatResponse): number {
  return billableCostForLoopTokens(loopTokensFromResponse(response));
}

function formatUsdBudget(value: number): string {
  const fixed = value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return `$${fixed === "" ? "0" : fixed}`;
}

/** Human-readable stop reason for a cache-excluded USD budget overrun. */
export function costBudgetDiagnostics(consumedUsd: number, budgetUsd: number): string {
  return `cost-budget: accumulated ${formatUsdBudget(consumedUsd)} exceeded the ${formatUsdBudget(
    budgetUsd,
  )} USD budget`;
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

export function recordRow(input: {
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
  /** Explicit addresses covered by an applied exchange (#81); omitted by default. */
  appliedLocators?: Locator[];
  /** Selectors used by the exchange's parsed payloads (#101); omitted when none. */
  selectors?: EditSelector[];
  /** Resolved cascade stages (#110); parallel to `selectors`; omitted when none. */
  stages?: SelectionStage[];
  /** Matcher kinds (#110); parallel to `stages`; omitted when none. */
  matcherKinds?: (MatcherKind | null)[];
  /** EditDsl implicit-create clauses the reply carried (#111); omitted when none. */
  creates?: number;
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
    appliedLocators: input.appliedLocators,
    selectors: input.selectors,
    stages: input.stages,
    matcherKinds: input.matcherKinds,
    creates: input.creates,
  };
}

/**
 * Bounded, incrementally-updated prior-attempts digest (#57): the repair
 * chain's checkpoint. `updateAttemptDigest` reads only the records beyond the
 * cursor, and the rendered text goes to the no-progress asks only — never to
 * ordinary retries.
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
  "regex-invalid",
  "range-invalid",
  "no-op",
  "repeat",
  "duplicate",
  "gate",
  "format",
  "format-export-duplication",
  "truncated",
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
  "self-check",
  "viewer",
  "confirmed",
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

export function safeMutablePath(cwd: string, path: string): string | null {
  const safe = safeAppendPath(cwd, path);
  if (safe === null) {
    return null;
  }
  // human/ is human-authored and read-only for agents; raw file commands must
  // not bypass that boundary.
  if (safe === "human" || safe.startsWith("human/")) {
    return null;
  }
  return safe;
}

export function readFileIfExists(path: string): string | null {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile()) {
    return null;
  }
  return readFileSync(path, "utf8");
}

export function writeTarget(cwd: string, path: string, source: string): void {
  const target = join(cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

const ADDRESS_CANDIDATE_LIMIT = 5;

// Map a 1-based (line, column) to an absolute offset inside `source`, walking
// from `base` (the first character of the coordinate space) up to `limit` (one
// past its last character). Returns null when the position does not exist in
// that space; a position exactly at `limit` (one past the last character) is
// returned as `limit`.
function positionOffset(
  source: string,
  base: number,
  limit: number,
  line: number,
  column: number,
): number | null {
  let currentLine = 1;
  let currentColumn = 1;
  for (let index = base; index < limit; index += 1) {
    if (currentLine === line && currentColumn === column) {
      return index;
    }
    if (source[index] === "\n") {
      currentLine += 1;
      currentColumn = 1;
    } else {
      currentColumn += 1;
    }
  }
  if (currentLine === line && currentColumn === column) {
    return limit;
  }
  return null;
}

/** Why a `range` selector did not resolve to a spliceable span (#72). */
export type RangeResolutionFailure =
  | "out-of-bounds"
  | "outside-declaration"
  | "empty"
  | "truncated";

export type RangeResolution =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: RangeResolutionFailure; detail: string };

// Resolve one 1-based inclusive `(line,column)` range (#72) against the current
// source block shown in the prompt: `base`/`limit` bound that block and
// `declaration` is the absolute span the range must sit inside. The reported
// span is half-open (`[start, end)`) for the splice.
export function resolveEditRange(
  source: string,
  range: EditRange,
  base: number,
  limit: number,
  declaration: { start: number; end: number },
): RangeResolution {
  // A block larger than the prompt limit is elided on the way to the model, so
  // its shown line numbers no longer map back to the source; refuse rather than
  // splice at a wrong offset.
  if (limit - base > SPEC_FILE_LIMIT) {
    return {
      ok: false,
      reason: "truncated",
      detail: `the shown current source was truncated (it exceeds ${SPEC_FILE_LIMIT} characters), so its numbered lines do not map back to the file`,
    };
  }
  const start = positionOffset(source, base, limit, range.line, range.column);
  if (start === null || start >= limit) {
    return {
      ok: false,
      reason: "out-of-bounds",
      detail: `the start position (line ${range.line}, column ${range.column}) is outside the shown current source`,
    };
  }
  const endOffset = positionOffset(source, base, limit, range.endLine, range.endColumn);
  if (endOffset === null) {
    return {
      ok: false,
      reason: "out-of-bounds",
      detail: `the end position (line ${range.endLine}, column ${range.endColumn}) is outside the shown current source`,
    };
  }
  const end = endOffset + 1; // inclusive end
  if (end > limit) {
    return {
      ok: false,
      reason: "out-of-bounds",
      detail: `the end position (line ${range.endLine}, column ${range.endColumn}) is the last character of the shown current source, so the inclusive range extends past it`,
    };
  }
  if (end <= start) {
    return {
      ok: false,
      reason: "empty",
      detail: `the range is empty or ends before it starts: (line ${range.line}, column ${range.column}) to (line ${range.endLine}, column ${range.endColumn})`,
    };
  }
  if (start < declaration.start || end > declaration.end) {
    return {
      ok: false,
      reason: "outside-declaration",
      detail: "the range does not sit inside the pinned declaration",
    };
  }
  return { ok: true, start, end };
}

function describeEntry(entry: IndexEntry, sourceByPath: ReadonlyMap<string, string>): string {
  const source = sourceByPath.get(entry.locator.path) ?? "";
  const { line, column } = lineColumnAt(source, entry.node.start);
  const kind = grammarKindsForEntryKind(entry.locator.kind).join("/");
  return `${entry.locator.path}: ${kind} ${JSON.stringify(entry.locator.name)} (line ${line}, column ${column})`;
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
// position) and, for a same-path kind mismatch, say which kind to use. A
// `resolve` space mismatch names the spaces the name is actually declared in
// and never suggests another path's candidate as a fallback.
function addressMissDiagnostics(
  locator: Locator,
  byName: readonly IndexEntry[],
  sourceByPath: ReadonlyMap<string, string>,
  space: SymbolSpace | null = null,
): string {
  const spaceSuffix = space === null ? "" : ` in the ${space} space`;
  const lines = [
    "stage: address",
    locator.kind === ""
      ? `no symbol named ${JSON.stringify(locator.name)} in ${JSON.stringify(locator.path)}${spaceSuffix}`
      : `no symbol with kind ${JSON.stringify(locator.kind)} named ${JSON.stringify(locator.name)} in ${JSON.stringify(locator.path)}${spaceSuffix}`,
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
    if (kinds.includes("variable")) {
      // The internal `"variable"` label is not a grammar kind: name the
      // const/let/var alternatives (plus the bare-select wildcard) instead.
      const grammarKinds = [...new Set(kinds.flatMap((kind) => grammarKindsForEntryKind(kind)))];
      lines.push(
        `in ${JSON.stringify(locator.path)} the name exists as ${grammarKinds.map((kind) => JSON.stringify(kind)).join(", ")}; change "kind" to one of those, or omit "kind" for a bare select`,
      );
    } else {
      lines.push(
        `in ${JSON.stringify(locator.path)} the name exists as ${kinds.map((kind) => JSON.stringify(kind)).join(", ")}; change "kind" to match`,
      );
    }
  }
  if (space !== null) {
    const samePath = byName.filter((entry) => entry.locator.path === locator.path);
    const samePathSpaces = [...new Set(samePath.flatMap((entry) => declarationSpaces(entry)))];
    if (samePathSpaces.length > 0 && !samePathSpaces.includes(space)) {
      lines.push(
        `in ${JSON.stringify(locator.path)} the name is declared in the ${samePathSpaces.map((candidate) => JSON.stringify(candidate)).join(", ")} space${samePathSpaces.length === 1 ? "" : "s"}; change "resolve" to match`,
      );
    } else if (samePathSpaces.length === 0) {
      const spaces = [...new Set(byName.flatMap((entry) => declarationSpaces(entry)))];
      lines.push(
        `the name ${JSON.stringify(locator.name)} is declared in the ${spaces.map((candidate) => JSON.stringify(candidate)).join(", ")} space${spaces.length === 1 ? "" : "s"}; the requested ${JSON.stringify(space)} space does not match this path`,
      );
    }
  }
  return lines.join("\n");
}

function addressAmbiguousDiagnostics(
  locator: Locator,
  matches: readonly IndexEntry[],
  sourceByPath: ReadonlyMap<string, string>,
  space: SymbolSpace | null = null,
): string {
  return [
    "stage: address",
    `the address ${addressJson(locator)}${space === null ? "" : ` in the ${space} space`} matches ${matches.length} declarations; the harness never picks one silently`,
    ...candidateLines(matches, sourceByPath),
    "correct the address (path/symbol/kind) so it matches exactly one declaration",
  ].join("\n");
}

export type CurrentEntryResolution =
  | { ok: true; entry: IndexEntry }
  | { ok: false; diagnostics: string; undeclared: boolean; spaceMiss: boolean };

// Strict-AND resolution of one locator against the current source that would be
// spliced: no silent first-match pick, no kind coercion, no auto-append. An
// empty locator kind is the edit-dsl wildcard (path + name only); `space` is the
// edit-dsl `resolve value|type|namespace` filter and is `null` when omitted.
export function resolveCurrentEntry(
  sourceBefore: string,
  target: string,
  locator: Locator,
  space: SymbolSpace | null = null,
): CurrentEntryResolution {
  const currentBuild = buildIndexTolerant([{ path: target, source: sourceBefore }]);
  const matches = currentBuild.index.lookup(locator, space);
  const sources = new Map([[target, sourceBefore]]);
  if (matches.length === 0) {
    // `undeclared` (#65): the name is absent under every kind, so the
    // diagnostics suggest mode "create" — the retry lead keeps that add path
    // open instead of demanding an impossible re-pin. A name declared only in
    // another symbol space is a `spaceMiss`: it is a creation candidate for the
    // requested space, but is not "undeclared" everywhere. A kind miss is
    // neither: the name occupies the requested space and must be re-addressed.
    const byName = currentBuild.index.byName(locator.name);
    const spaceMiss =
      space !== null &&
      byName.length > 0 &&
      byName.every((entry) => !declarationSpaces(entry).includes(space));
    return {
      ok: false,
      diagnostics: addressMissDiagnostics(locator, byName, sources, space),
      undeclared: byName.length === 0,
      spaceMiss,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      diagnostics: addressAmbiguousDiagnostics(locator, matches, sources, space),
      undeclared: false,
      spaceMiss: false,
    };
  }
  const entry = matches[0];
  if (entry === undefined) {
    // Unreachable: matches.length is exactly one here.
    return {
      ok: false,
      diagnostics: addressMissDiagnostics(locator, [], sources, space),
      undeclared: true,
      spaceMiss: false,
    };
  }
  return { ok: true, entry };
}

type EntrySpliceCause = MatcherCause | "no-op" | "range-invalid";

type EntrySplice =
  | { ok: true; candidate: string; gateStart: number }
  | { ok: false; cause: EntrySpliceCause; diagnostics: string };

// #59: an edit whose final spliced candidate is byte-identical to the current
// source cannot change anything; it is rejected before the syntax/format gate
// and verification instead of consuming a verification round-trip.

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

export function stripLeadingExport(replacement: string, modifier: string | null): string {
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

// One failing clause inside an edit-dsl reply (#111): names the clause position
// and its own staged diagnostics. EditDsl replies are atomic across the whole
// reply (§6), so the header says every clause is discarded and nothing is
// written.
function editDslClauseDiagnostics(
  index: number,
  total: number,
  path: string,
  locator: Locator,
  diagnostics: string,
): string {
  return [
    "stage: edit-dsl",
    `clause ${index} of ${total} (${addressJson(locator)} in ${JSON.stringify(path)}) failed; the whole edit-dsl reply is discarded and nothing is written`,
    diagnostics,
  ].join("\n");
}

// Overlap rejection on the edit-dsl path (#111): both clauses are named, and the
// whole reply is discarded because edit-dsl replies are atomic.
function editDslOverlapDiagnostics(
  total: number,
  path: string,
  earlier: ResolvedRegion,
  later: ResolvedRegion,
): string {
  const jointCreates =
    earlier.create &&
    later.create &&
    earlier.start === earlier.end &&
    later.start === later.end &&
    earlier.start === later.start;
  return [
    "stage: edit-dsl",
    `clause ${earlier.index + 1} and clause ${later.index + 1} of ${total} both edit ${JSON.stringify(path)} but their regions overlap (offsets ${earlier.start}..${earlier.end} and ${later.start}..${later.end}); the whole edit-dsl reply is discarded and nothing is written`,
    jointCreates
      ? "put every new declaration in ONE clause's `replace with` fence (the fence body may declare several top-level names), or send one create per reply"
      : `clause ${earlier.index + 1} (${addressJson(earlier.locator)}) and clause ${later.index + 1} (${addressJson(later.locator)}) must address non-overlapping regions, or be split across replies`,
  ].join("\n");
}

// Bridge a resolved edit-dsl editor clause into the shared `ResolvedRegion`
// shape; the edit-dsl path already carries the cascade stage and matcher kind
// (#110), so no reclassification is needed.
export function editDslRegionToResolved(region: EditDslRegion): ResolvedRegion {
  return {
    index: region.index,
    path: region.path,
    locator: region.locator,
    start: region.start,
    end: region.end,
    text: region.text,
    replacement: region.text,
    stage: region.stage,
    matcherKind: region.matcherKind,
    create: region.create,
  };
}

export interface ResolvedRegion {
  /** Clause/payload position in the reply (0-based), for diagnostics. */
  index: number;
  /** The file the region edits (a same-file batch shares it). */
  path: string;
  locator: Locator;
  /** Half-open offsets into the file's current source. */
  start: number;
  end: number;
  /** Text spliced over `[start, end)`. */
  text: string;
  /** The raw replacement, used by the gate diagnostic's code frame. */
  replacement: string;
  /** The cascade stage that resolved the region (#110). */
  stage: SelectionStage;
  /** The matcher form that resolved it (#110), or null. */
  matcherKind: MatcherKind | null;
  /** True for an edit-dsl implicit create (a new whole declaration). */
  create: boolean;
}

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

// File-absolute start line for an edit-dsl retry's `# details` block. Create
// mode and whole-file repair views start at line 1; a pinned declaration slice
// starts at its declaration's line.
function editDslPromptStartLine(
  mode: "modify" | "create",
  targetPath: string,
  locator: Locator,
  diskSource: string,
  wholeFile: boolean,
): number {
  if (mode === "create" || wholeFile) {
    return 1;
  }
  const resolved = resolveCurrentEntry(diskSource, targetPath, locator, null);
  if (!resolved.ok) {
    return 1;
  }
  return diskSource.slice(0, resolved.entry.node.start).split("\n").length;
}

// The source a retry/no-progress prompt shows. A repair iteration in modify
// mode shrinks the whole file to the declarations that matter when the toggle
// is on (returning the partial block as `preRendered`); otherwise this is the
// historic whole-file / re-resolved-declaration behavior, byte-identically.
function repairContextSource(opts: {
  mode: "modify" | "create";
  repair: boolean;
  target: string;
  locator: Locator;
  diskSource: string;
  diagnostics: string;
}): { source: string; preRendered?: string } {
  const wholeFile = opts.repair || opts.mode === "create";
  if (!wholeFile) {
    return { source: currentSourceForPrompt("modify", opts.target, opts.locator, opts.diskSource) };
  }
  if (opts.repair && opts.mode !== "create" && repairContextShrinkEnabled()) {
    const shrunk = shrinkRepairSource(opts.target, opts.diskSource, opts.locator, opts.diagnostics);
    if (shrunk !== null) {
      return { source: opts.diskSource, preRendered: shrunk };
    }
  }
  return { source: opts.diskSource };
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

// One whitelisted self-verification request (#73): `read` renders the pinned
// file's current source; `check`/`test` run the same commands Verification runs.
// The model names a kind, never a command string, so nothing else can run.
async function executeSelfCheck(
  kind: "check" | "test",
  context: {
    cwd: string;
    checkCommand?: string[];
    testCommand?: string[];
    commandTimeoutMs?: number;
  },
): Promise<string> {
  if (kind === "check") {
    const result = await checkTool(context.cwd, context.checkCommand, context.commandTimeoutMs);
    return renderSelfCheckCommand("check", "the check command", result);
  }
  const result = await testTool(context.cwd, context.testCommand, context.commandTimeoutMs);
  return renderSelfCheckCommand("test", "the test command", result);
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
  /**
   * Optional resolver for a diagnostic's file source, used to name the
   * declaration a diagnostic sits in (#87). When absent or returning null, a
   * diagnostic outside the target file renders as today.
   */
  sourceFor?: (file: string) => string | null;
}

export interface LineRange {
  /** 1-based inclusive; start === 0 when nothing changed. */
  start: number;
  end: number;
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

interface DeclarationSpan {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
}

function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  const limit = Math.min(Math.max(offset, 0), source.length);
  for (let index = 0; index < limit; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

// Parse `source` and return its top-level declaration spans in source order.
// A parse failure yields no spans: annotation is best-effort and must never
// throw out of the diagnostics renderer.
function declarationSpans(source: string): DeclarationSpan[] {
  let program: Program;
  try {
    program = new Parser(source).parseProgram();
  } catch (error) {
    if (error instanceof ParseError || error instanceof LexError) {
      return [];
    }
    throw error;
  }
  const spans: DeclarationSpan[] = [];
  const push = (node: Node, name: string, kind: string): void => {
    spans.push({
      name,
      kind,
      startLine: lineNumberAt(source, node.start),
      // `end` is exclusive, so the last included character is `end - 1`.
      endLine: lineNumberAt(source, Math.max(node.start, node.end - 1)),
    });
  };
  // `wrapper` is the enclosing `export` statement whose span the annotation
  // should cover, so a diagnostic on the modifier still maps to the name.
  const collect = (statement: Statement | Expression, wrapper?: Node): void => {
    const node = wrapper ?? statement;
    switch (statement.kind) {
      case "FunctionDeclaration":
        if (statement.name !== null) {
          push(node, statement.name.name, "function");
        }
        return;
      case "ClassDeclaration":
        if (statement.name !== null) {
          push(node, statement.name.name, "class");
        }
        return;
      case "InterfaceDeclaration":
        push(node, statement.name.name, "interface");
        return;
      case "TypeAliasDeclaration":
        push(node, statement.name.name, "type");
        return;
      case "EnumDeclaration":
        push(node, statement.name.name, "enum");
        return;
      case "NamespaceDeclaration":
        push(node, statement.name, "namespace");
        return;
      case "VariableStatement":
        for (const declarator of statement.declarations) {
          if (declarator.name.kind === "Identifier") {
            push(node, declarator.name.name, statement.declarationKind);
          }
        }
        return;
      case "ExportNamedDeclaration":
        if (statement.declaration !== null) {
          collect(statement.declaration, statement);
        }
        return;
      case "ExportDefaultDeclaration":
        collect(statement.declaration, statement);
        return;
      default:
        return;
    }
  };
  for (const statement of program.body) {
    collect(statement);
  }
  return spans;
}

// The first top-level span covering `line` (spans do not nest at top level, so
// the order is deterministic).
function enclosingDeclaration(
  spans: readonly DeclarationSpan[],
  line: number,
): DeclarationSpan | null {
  for (const span of spans) {
    if (line >= span.startLine && line <= span.endLine) {
      return span;
    }
  }
  return null;
}

export function formatDiagnostics(input: DiagnosticsInput): string {
  const { check, test, targetPath, baseSource, newSource, sourceFor } = input;
  // #87's declaration suffix can be toggled at runtime so a benchmark can run
  // byte-identical arms. Read once per call so tests can flip it in-process.
  // Disabled only for `off`, `0`, or `false` (trimmed, lowercased); anything
  // else, including unset, keeps today's behavior.
  const declNamingSetting = (process.env.TC_DIAG_DECL_NAMING ?? "").trim().toLowerCase();
  const declNamingEnabled =
    declNamingSetting !== "off" && declNamingSetting !== "0" && declNamingSetting !== "false";
  const lines: string[] = [];
  if (!check.ok) {
    lines.push("stage: tsc");
    const range = editedRange(baseSource, newSource);
    const replacementLines = toLines(newSource);
    // Lazily parse each diagnostic's file once so a located diagnostic can name
    // the declaration whose span contains it (#87). The target file uses the
    // content that was written; other files go through the optional resolver.
    const spanCache = new Map<string, DeclarationSpan[]>();
    const spansFor = (file: string): DeclarationSpan[] => {
      const cached = spanCache.get(file);
      if (cached !== undefined) {
        return cached;
      }
      const source = file === targetPath ? newSource : (sourceFor?.(file) ?? null);
      const spans = source === null ? [] : declarationSpans(source);
      spanCache.set(file, spans);
      return spans;
    };
    const declarationSuffix = (diagnostic: CheckDiagnostic): string => {
      if (!declNamingEnabled || diagnostic.file === "") {
        return "";
      }
      const span = enclosingDeclaration(spansFor(diagnostic.file), diagnostic.line);
      return span === null ? "" : ` — in declaration \`${span.name}\` (${span.kind})`;
    };
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
        `replacement line ${diagnostic.line - range.start + 1}: ${messageWithCode(diagnostic)}${declarationSuffix(diagnostic)}`,
      );
      lines.push(...codeFrame(replacementLines, diagnostic.line));
    }
    if (mapped.length > MAPPED_DIAGNOSTIC_LIMIT) {
      lines.push(`... ${mapped.length - MAPPED_DIAGNOSTIC_LIMIT} more in the replacement`);
    }
    if (elsewhere.length > 0) {
      lines.push("elsewhere in file:");
      for (const diagnostic of elsewhere) {
        lines.push(`${renderElsewhere(diagnostic)}${declarationSuffix(diagnostic)}`);
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
export async function explain(
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

export function withEffort(base: ChatOptions | undefined, effort: ReasoningEffort): ChatOptions {
  return { ...base, reasoningEffort: effort };
}

// Fallback diagnostic for a run that reaches the end of a driver without a
// valid edit and without a more specific termination reason. #57 removed the
// fixed exchange budget, so this names the end state, never a cap.
function editExhaustedDiagnostics(openedBy: string | null, last: string | null): string {
  const reason = "edit-exhausted: the run ended without a valid edit";
  const parts = [reason];
  if (openedBy !== null) {
    parts.push(openedBy);
  }
  if (last !== null) {
    parts.push(last);
  }
  return parts.join("\n\n");
}

/**
 * Repeated no-progress fingerprint (#57): the same reply, diagnostics, and
 * source state was already rejected. This is a no-progress termination path,
 * not a count cap: a run that keeps producing distinct attempts is bounded only
 * by the USD cost budget and the no-progress ask cadence.
 */
function repeatedNoProgressDiagnostics(context: string | null): string {
  const reason =
    "edit-exhausted: no progress: the same reply/source/diagnostics fingerprint repeated; no fixed exchange or round cap applies";
  return context === null ? reason : `${reason}\n\n${context}`;
}

// One fingerprint per rejected attempt. It includes the reply, the rejection
// diagnostics, and the source the reply was resolved against, so a legitimate
// retry after a state change is not mistaken for a repeat. Hash keeps the set's
// memory bounded by the USD cost budget rather than by reply size.
function noProgressFingerprint(reply: string, diagnostics: string, state: string): string {
  return createHash("sha256")
    .update(`${reply}\u0000${diagnostics}\u0000${state}`, "utf8")
    .digest("hex");
}

// Retry diagnostics (#48): the failure that opened the round plus the latest
// rejection, deduplicated when they are the same text.
function combinedDiagnostics(openedBy: string | null, last: string | null): string {
  if (openedBy !== null && last !== null && last !== openedBy) {
    return `${openedBy}\n\n${last}`;
  }
  return last ?? "the previous exchange was rejected";
}

// Stalled-stop diagnostic (#54): the model ended the run at the no-progress ask.
function stalledStopDiagnostics(failedAttempts: number, context: string | null): string {
  const reason = `edit-exhausted: the model replied STOP after ${failedAttempts} consecutive failed attempts`;
  return context === null ? reason : `${reason}\n\n${context}`;
}

// `STOP` is only special as the reply to a no-progress ask (#54/#57).
function isStopReply(response: ChatResponse): boolean {
  return (response.content ?? "").trim().toUpperCase() === "STOP";
}

async function runEditDslLoop(options: LoopOptions): Promise<LoopResult> {
  const costBudgetUsd = options.costBudgetUsd ?? DEFAULT_COST_BUDGET_USD;
  const temperature = options.temperature;
  const chatOptions: ChatOptions | undefined =
    temperature === undefined ? undefined : { temperature };
  const cwd = options.cwd;
  const files = discoverSourceFiles(cwd);
  const build = buildIndexTolerant(files);
  const index = build.index;
  const skipped = build.skipped;
  const specFiles = selectSpecFiles(options.issue, files);
  // B1: the edit-dsl symbol index is a select-line list, not YAML.
  const editDslIndexText = buildEditDslSymbolIndex(index);
  const makeMultiEditorDeps = (cache = new Map<string, string>()): MultiEditorDeps => ({
    sourceFor: (path) => {
      const cached = cache.get(path);
      if (cached !== undefined) {
        return cached;
      }
      const source = readFileIfExists(join(cwd, path)) ?? "";
      cache.set(path, source);
      return source;
    },
    fileExists: (path) => {
      const stats = statSync(join(cwd, path), { throwIfNoEntry: false });
      return stats !== undefined && stats.isFile();
    },
    isSafePath: (path) => safeMutablePath(cwd, path) !== null,
    resolveEntry: (source, path, locator, space) =>
      resolveCurrentEntry(source, path, locator, space),
  });
  const systemMessage: ChatMessage = {
    role: "system",
    content: buildSystemPrompt(),
  };
  const issueMessage: ChatMessage = {
    role: "user",
    content: buildEditDslUserPrompt(options.issue, editDslIndexText, specFiles),
  };
  // Lean issue message (#49): same issue text and project context without the
  // spec-file section. Rounds opened by a `tsc`-stage verification failure
  // send it on every content exchange — their repair is driven by the
  // diagnostics and the current source; all other rounds keep the full message.
  const leanIssueMessage: ChatMessage = {
    role: "user",
    content: buildEditDslUserPrompt(options.issue, editDslIndexText, []),
  };
  // Round 1 always starts from the full message; the per-round variant is chosen
  // at the top of the Run loop and applied on the content-exchange rebuild.
  const initialMessages: ChatMessage[] = [systemMessage, issueMessage];
  let messages: ChatMessage[] = initialMessages;
  const records: LoopRecord[] = [];
  let consumedCostUsd = 0;
  // Raw component token tally (#80), reported alongside the USD budget spend.
  const tokens: LoopTokens = zeroLoopTokens();
  const addTokens = (delta: LoopTokens): void => {
    addLoopTokens(tokens, delta);
  };

  // Pinning (#43): the first successful pick fixes {mode, path, symbol, kind}
  // for the run; later exchanges revise content only and must echo the address.
  let pinned: { mode: SelectionMode; locator: Locator } | null = null;
  let pinnedAddressJson = "";
  // EditDsl select-first: the model's own `select … end` reply is the
  // assistant turn shown in the content exchange.
  let pinnedAssistantContent: string | null = null;
  // A first-turn edit-dsl editor already carries its `replace`; its reply is
  // applied in the content branch without a second provider call.
  let prefetchedReply: ChatResponse | null = null;
  // Run-start source of the target file ("" when the file did not exist).
  let baseSource = "";
  // First content prompt after a pick; null once a retry prompt takes over.
  let initialContentPrompt: string | null = null;
  // Create→repair (#41): once a failed create keeps a parseable file, content
  // exchanges are modify rounds against the kept file and prompts show it whole.
  let repair = false;
  // Verification diagnostics that opened the current Run iteration.
  let pendingDiagnostics: string | null = null;
  // #111: a mixed edit-dsl reply's viewer occurrences, carried into the next
  // prompt's diagnostics when the editors applied but verification later fails.
  let carriedViewerFeedback: string | null = null;
  // Stage of the verification failure that opened the current Run iteration
  // (#49): `tsc` makes the round's content prompts lean.
  let pendingVerificationStage: "tsc" | "tests" | null = null;
  // Consecutive no-progress attempts (#54/#57): incremented at every rejected
  // exchange (including truncation, viewer-only replies, and failed apply
  // guards) and at every failed verification. It schedules the no-progress ask
  // at the #54/#65 milestones only; it is never a cap.
  let stalledAttempts = 0;
  // Edit-dsl self-check no-progress note: the same command, source, and result
  // repeated is surfaced to the model, but it never becomes a hard count. The
  // USD cost budget remains the stop.
  let lastEditDslSelfCheckFingerprint: string | null = null;
  // The failed-attempt count whose no-progress ask was already shown. A decision
  // turn or self-check reply does not increment the count, so without this guard
  // the same milestone would ask twice.
  let stalledAskShownAt = -1;
  // Per-cause retry policy (#56): the last rejection cause and the length of
  // the consecutive-same-cause streak, plus the correction sentence the next
  // edit retry must carry (the escalation once the streak reaches 2, and the
  // #65 context: the round's opening diagnostics and an undeclared address
  // name). An applied edit resets all three; verification failures deliberately
  // do not.
  let lastRejectionCause: RejectionCause | null = null;
  let lastRejectionStreak = 0;
  let lastCorrection: string | null = null;
  // #24: address rejections since the last applied edit, independent of the
  // same-cause streak because the motivating loop alternates address and
  // protocol failures. Cleared only when an edit applies.
  let addressFailures = 0;
  const registerRejection = (cause: RejectionCause, context: RejectionLeadContext = {}): void => {
    if (cause === lastRejectionCause) {
      lastRejectionStreak += 1;
    } else {
      lastRejectionCause = cause;
      lastRejectionStreak = 1;
    }
    if (cause === "address") {
      addressFailures += 1;
    }
    lastCorrection = rejectionLead(cause, lastRejectionStreak, {
      ...context,
      addressFailures,
    });
  };
  const clearRejectionPolicy = (): void => {
    lastRejectionCause = null;
    lastRejectionStreak = 0;
    lastCorrection = null;
    addressFailures = 0;
  };
  // Prior-attempts digest (#57): a bounded, incrementally-updated checkpoint of
  // the failing chain. It is rendered into the no-progress asks only;
  // `digestText` advances it over the records the previous prompt has not seen
  // yet, immediately before rendering.
  const attemptDigest = createAttemptDigestState();
  const digestText = (): string => {
    updateAttemptDigest(attemptDigest, records);
    return renderAttemptDigest(attemptDigest);
  };
  // Repeated-failure fingerprints (#57): a failed reply + diagnostics + source
  // state seen before is no progress and ends the run. This is the no-cap
  // termination path; distinct attempts remain bounded by the USD cost budget.
  const failedFingerprints = new Set<string>();
  const repeatFailure = (reply: string, diagnostics: string, state: string): boolean => {
    const key = noProgressFingerprint(reply, diagnostics, state);
    if (failedFingerprints.has(key)) {
      return true;
    }
    failedFingerprints.add(key);
    return false;
  };
  // The no-progress ask is due once per failed-attempt milestone. It is taken
  // only when a prompt actually renders it, so a successful pick or a decision
  // turn cannot consume it without the model seeing it.
  const takeStalledAsk = (history: FailurePattern | null): StalledAsk | undefined => {
    if (!isStalledAskMilestone(stalledAttempts) || stalledAskShownAt === stalledAttempts) {
      return undefined;
    }
    stalledAskShownAt = stalledAttempts;
    return {
      failedAttempts: stalledAttempts,
      askNumber: stalledAskNumber(stalledAttempts),
      history,
    };
  };

  /** Run-level warnings, e.g. ignored inert edit-dsl clauses (#44). */
  const warnings: string[] = [];

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
    ...(warnings.length === 0 ? {} : { warnings: [...warnings] }),
    tokens,
  });
  // Termination step (#43): record rows are already pushed; the only remaining
  // action is exactly one summary call, then the run stops.
  const terminate = async (
    reason: TerminationReason,
    diagnostics: string | null,
  ): Promise<LoopResult> => {
    const reported = diagnostics;
    return {
      ok: false,
      mode: pinned?.mode,
      locator: pinned?.locator ?? null,
      filePath: pinned?.locator.path ?? null,
      editedSource: null,
      records,
      diagnostics: reported,
      explanation: await explain(options.provider, messages, temperature, reason, reported),
      messages,
      skipped,
      terminationReason: reason,
      ...(warnings.length === 0 ? {} : { warnings: [...warnings] }),
      tokens,
    };
  };

  let iteration = 0;
  // STOP (#54/#57): the reply to a no-progress ask may end the run; it is
  // recorded as an exchange row with the dedicated `stopped` outcome, carrying
  // the diagnostics builder's text.
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
    initialContentPrompt = null;
    prefetchedReply = null;
    let verificationFailed = false;
    let lastDiagnostics: string | null = pendingDiagnostics;
    let lastFailure: "edit" | "verification" =
      pendingDiagnostics === null ? "edit" : "verification";
    // Verification diagnostics that opened this iteration, kept for the
    // edit-exhausted summary even after edit soft failures overwrite `last`.
    const iterationOpenedBy: string | null = lastDiagnostics;
    // Stage that opened this iteration (#49), carried with the diagnostics so a
    // verification-repair chain keeps its prompt variant.
    const iterationOpenedByStage: "tsc" | "tests" | null = pendingVerificationStage;
    pendingDiagnostics = null;
    pendingVerificationStage = null;
    // Content prompts of a tsc-stage repair round omit the spec-file section
    // (#49); every other round keeps the full issue message.
    const roundIssueMessage = iterationOpenedByStage === "tsc" ? leanIssueMessage : issueMessage;
    // Previous content rejection within this iteration, for the identical-
    // retry note (#48); resets every iteration.
    let lastRejection: string | null = null;
    // Edit-dsl self-check: `pendingSelfCheck` carries the one result into the
    // next prompt.
    let pendingSelfCheck: string | null = null;
    // Decision-only turn (#75), per round: a non-edit reply to a repeated
    // non-converging ask is clamped into `pendingApproach` and carried into the
    // next exchange's edit prompt instead of being applied.
    let pendingApproach: string | null = null;
    // True when the prompt built at the end of the previous exchange offered
    // `STOP` (a selection no-progress ask). Content prompts are built and
    // answered in one exchange, so they set the per-exchange flag directly.
    let stopOffered = false;
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

    // #57: one exchange loop, no fixed exchange budget. A rejection retries or
    // ends through the no-progress fingerprint/USD cost budget; the loop leaves
    // only on an applied edit (then verification), success, or termination.
    for (let exchange = 1; ; exchange += 1) {
      const pick = pinned === null;
      // Set when this exchange's prompt is a no-progress ask (the only prompts
      // that offer `STOP`).
      let promptOffersStop = stopOffered;
      stopOffered = false;
      let decisionTurn = false;
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
          const diagnostics = providerErrorDiagnostics(error);
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
            tokens,
          };
        }
        consumedCostUsd += costBudgetFromResponse(response);
        addTokens(loopTokensFromResponse(response));
        if (consumedCostUsd > costBudgetUsd) {
          return await terminate(
            "cost-budget",
            costBudgetDiagnostics(consumedCostUsd, costBudgetUsd),
          );
        }
        // Only the selection no-progress ask offers STOP (#57).
        if (promptOffersStop && isStopReply(response)) {
          return await stopRun(
            exchange,
            response,
            stalledStopDiagnostics(
              stalledAttempts,
              combinedDiagnostics(iterationOpenedBy, lastDiagnostics),
            ),
          );
        }
        let candidate: Locator = EMPTY_LOCATOR;
        let diagnostic: string | null = null;
        let selectionStage: "protocol" | "address" = "protocol";
        // EditDsl select-first (#B1): the pick reply is one `select … end`
        // clause. It pins modify when the address resolves, create when the name
        // or space is missing, and an editor clause prefetches its own reply for
        // the content exchange.
        let editDslPick: {
          selection: EditDslSelection;
          mode: "modify" | "create";
          entry: IndexEntry | null;
          source: string;
        } | null = null;
        let fsPick: { path: string; mode: "modify" | "create" } | null = null;
        let renamePick: EditDslSelection | null = null;
        let fsReadFeedback: string | null = null;
        let fsReply = false;
        try {
          const stripped = stripCodeFences(response.content ?? "");
          // Remember the reply's shape even when the parser rejects it, so the
          // retry prompt keeps the raw-file-command path open after a syntax
          // error rather than demanding a select clause.
          fsReply = /^\s*(?:create|delete|read|write)\b/.test(stripped);
          const statements = parseMultiEditor(stripped);
          let editorCount = 0;
          let fsCount = 0;
          let editorSelection: EditDslSelection | null = null;
          const fsStatements: FileStatement[] = [];
          for (const statement of statements) {
            if (statement.type === "editor") {
              editorCount += 1;
              editorSelection = statement.selection;
            } else {
              fsCount += 1;
              fsStatements.push(statement.statement);
            }
          }
          if (fsCount > 0 && editorCount === 0) {
            fsReply = true;
            const readsOnly = fsStatements.every((statement) => statement.op === "read");
            const resolution = resolveMultiEditor(statements, makeMultiEditorDeps());
            if (resolution.failures.length > 0) {
              const first = resolution.failures[0];
              diagnostic = first?.diagnostics ?? "stage: protocol\nthe file command was rejected";
              selectionStage = first?.stage === "address" ? "address" : "protocol";
            } else if (resolution.readFailures.length > 0 && resolution.reads.length === 0) {
              // A reply that only tried to read and failed has nothing to pin;
              // retry with the read error. In a mixed reply the mutation still
              // pins and the read error is dropped (#25).
              const first = resolution.readFailures[0];
              diagnostic = first?.diagnostics ?? "stage: protocol\nthe read command was rejected";
              selectionStage = first?.stage === "address" ? "address" : "protocol";
            } else if (readsOnly) {
              fsReadFeedback = [
                renderReadFeedback(resolution.reads),
                renderReadFailureFeedback(resolution.readFailures),
              ]
                .filter((block) => block !== "")
                .join("\n\n");
              candidate = {
                path: resolution.reads[0]?.path ?? "",
                name: "",
                kind: "",
              };
            } else {
              const mutation = fsStatements.find((statement) => statement.op !== "read");
              if (mutation === undefined) {
                diagnostic = "stage: protocol\nthe reply carried no file command";
              } else {
                const path = mutation.path;
                const exists =
                  statSync(join(cwd, path), { throwIfNoEntry: false })?.isFile() === true;
                fsPick = { path, mode: exists ? "modify" : "create" };
                candidate = { path, name: "", kind: "" };
              }
            }
          } else if (editorCount === 1 && fsCount === 0) {
            const selected = editorSelection;
            if (selected !== null) {
              candidate = selected.locator;
              if (isFileSelection(selected)) {
                const safePath = safeMutablePath(cwd, selected.locator.path);
                const exists =
                  safePath !== null &&
                  statSync(join(cwd, safePath), { throwIfNoEntry: false })?.isFile() === true;
                if (safePath === null) {
                  diagnostic = `stage: address\nthe path ${JSON.stringify(selected.locator.path)} is outside the editable workspace`;
                  selectionStage = "address";
                } else if (!exists) {
                  diagnostic = `stage: address\ncannot select file ${JSON.stringify(selected.locator.path)}: the file does not exist`;
                  selectionStage = "address";
                } else if (selected.replacement === null) {
                  diagnostic =
                    "stage: protocol\na file-level select is an editor and requires `replace with <fence>`; use `read <path> end` to view the file";
                } else {
                  fsPick = { path: selected.locator.path, mode: "modify" };
                }
              } else if (selected.rename !== undefined && selected.rename !== null) {
                // A first-turn rename has no index-resolvable declaration in
                // many cases (locals, dotted members); pin the path and let the
                // content exchange run the rename engine on the same reply.
                renamePick = selected;
              } else {
                const pickSource = readFileIfExists(join(cwd, selected.locator.path)) ?? "";
                const resolved = resolveCurrentEntry(
                  pickSource,
                  selected.locator.path,
                  selected.locator,
                  selected.space,
                );
                if (resolved.ok) {
                  editDslPick = {
                    selection: selected,
                    mode: "modify",
                    entry: resolved.entry,
                    source: pickSource,
                  };
                } else if (resolved.undeclared || resolved.spaceMiss) {
                  editDslPick = {
                    selection: selected,
                    mode: "create",
                    entry: null,
                    source: pickSource,
                  };
                } else {
                  diagnostic = resolved.diagnostics;
                  selectionStage = "address";
                }
              }
            }
          } else if (editorCount === 0 && fsCount === 0) {
            diagnostic =
              "stage: protocol\nthe reply was empty; expected a `select` clause or a file command";
          } else if (editorCount > 1) {
            diagnostic = `stage: protocol\nthe first edit-dsl reply must be exactly one \`select … end\` clause; found ${editorCount}`;
          } else {
            diagnostic =
              "stage: protocol\nthe first reply may contain one `select` clause or file commands, not both";
          }
        } catch (error) {
          if (!(error instanceof SelectionSyntaxError)) {
            throw error;
          }
          diagnostic = editDslParseDiagnostics(response.content ?? "", error);
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
          registerRejection(cause, {
            address:
              cause === "address" && candidate.path !== ""
                ? { path: candidate.path, name: candidate.name }
                : undefined,
          });
          // #24: the selection retry normally carries only diagnostics, so fold
          // the concrete repeated-address fallback into this prompt.
          const selectionDiagnostics =
            cause === "address" &&
            addressFailures >= 2 &&
            lastCorrection !== null &&
            candidate.path !== ""
              ? `${lastCorrection}\n\n${diagnostic}`
              : diagnostic;
          lastDiagnostics = selectionDiagnostics;
          lastFailure = "edit";
          stalledAttempts += 1;
          // #57: a repeated selection reply is no progress and ends the run;
          // distinct rejections are retried until the USD cost budget or the
          // no-progress ask cadence.
          // Only read the candidate's source when it is inside the editable
          // workspace; a path-escaping address contributes its raw path only.
          const selectionState =
            candidate.path === "" || safeMutablePath(cwd, candidate.path) === null
              ? candidate.path
              : (readFileIfExists(join(cwd, candidate.path)) ?? "");
          if (repeatFailure(response.content ?? "", diagnostic, selectionState)) {
            return await terminate(
              "edit-exhausted",
              repeatedNoProgressDiagnostics(
                combinedDiagnostics(iterationOpenedBy, selectionDiagnostics),
              ),
            );
          }
          messages.push({ role: "assistant", content: response.content ?? "" });
          const failurePattern = detectFailurePattern(records);
          const selectionAsk = takeStalledAsk(failurePattern);
          if (selectionAsk !== undefined) {
            stopOffered = true;
            messages.push({
              role: "user",
              content: buildEditDslSelectionContinuationPrompt({
                failedAttempts: stalledAttempts,
                issue: options.issue,
                indexText: editDslIndexText,
                diagnostics: combinedDiagnostics(iterationOpenedBy, selectionDiagnostics),
                digest: digestText(),
                failureHistory: renderFailureHistoryNote(failurePattern),
              }),
            });
          } else {
            messages.push({
              role: "user",
              content: fsReply
                ? buildEditDslCommandRetryPrompt(
                    options.issue,
                    editDslIndexText,
                    selectionDiagnostics,
                  )
                : buildEditDslSelectionRetryPrompt(
                    options.issue,
                    editDslIndexText,
                    selectionDiagnostics,
                  ),
            });
          }
          continue;
        }
        if (fsReadFeedback !== null) {
          records.push(
            recordRow({
              row: records.length + 1,
              iteration,
              kind: "exchange",
              exchange,
              locator: candidate,
              replacement: null,
              diagnostics: fsReadFeedback,
              outcome: "viewer",
              finishReason: response.finishReason,
              toolCalls: response.toolCalls.length,
            }),
          );
          lastDiagnostics = fsReadFeedback;
          lastFailure = "edit";
          // A read-only reply is inspection, not a failed attempt: it does not
          // advance the no-progress cadence and is bounded by the USD cost budget.
          messages.push({ role: "assistant", content: response.content ?? "" });
          messages.push({
            role: "user",
            content: buildEditDslReadPrompt(
              options.issue,
              editDslIndexText,
              fsReadFeedback,
              specFiles,
            ),
          });
          continue;
        }
        if (fsPick !== null) {
          const path = fsPick.path;
          const source = readFileIfExists(join(cwd, path)) ?? "";
          const locator: Locator = { path, name: "", kind: "" };
          pinned = { mode: fsPick.mode, locator };
          pinnedAddressJson = pinJson(pinned);
          pinnedAssistantContent = (response.content ?? "").trim();
          lastDiagnostics = null;
          lastFailure = "edit";
          records.push(
            recordRow({
              row: records.length + 1,
              iteration,
              kind: "exchange",
              exchange,
              locator,
              replacement: null,
              diagnostics: null,
              outcome: "selected",
              finishReason: response.finishReason,
              toolCalls: response.toolCalls.length,
            }),
          );
          messages.push({ role: "assistant", content: pinnedAssistantContent });
          baseSource = source;
          initialContentPrompt = buildEditDslCommandPrompt(
            options.issue,
            editDslIndexText,
            path,
            source,
            specFiles,
          );
          prefetchedReply = response;
          continue;
        }
        if (renamePick !== null) {
          const path = renamePick.locator.path;
          const source = readFileIfExists(join(cwd, path)) ?? "";
          pinned = { mode: "modify", locator: renamePick.locator };
          pinnedAddressJson = pinJson(pinned);
          pinnedAssistantContent = (response.content ?? "").trim();
          lastDiagnostics = null;
          lastFailure = "edit";
          records.push(
            recordRow({
              row: records.length + 1,
              iteration,
              kind: "exchange",
              exchange,
              locator: renamePick.locator,
              replacement: null,
              diagnostics: null,
              outcome: "selected",
              finishReason: response.finishReason,
              toolCalls: response.toolCalls.length,
            }),
          );
          messages.push({ role: "assistant", content: pinnedAssistantContent });
          baseSource = source;
          initialContentPrompt = buildEditDslCommandPrompt(
            options.issue,
            editDslIndexText,
            path,
            source,
            specFiles,
          );
          prefetchedReply = response;
          continue;
        }
        if (editDslPick === null) {
          // Unreachable: an edit-dsl success sets `editDslPick`.
          return await terminate(
            "edit-exhausted",
            editExhaustedDiagnostics(iterationOpenedBy, diagnostic),
          );
        }
        const { selection, mode, entry, source: pickSource } = editDslPick;
        pinned = { mode, locator: selection.locator };
        pinnedAddressJson = pinJson(pinned);
        pinnedAssistantContent = (response.content ?? "").trim();
        lastDiagnostics = null;
        lastFailure = "edit";
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
        messages.push({ role: "assistant", content: pinnedAssistantContent });
        baseSource = pickSource;
        if (mode === "modify" && entry !== null) {
          const modifier = precedingExportModifier(pickSource, entry);
          const declarationStart =
            modifier === null ? entry.node.start : entry.node.start - modifier.length;
          const startLine = pickSource.slice(0, declarationStart).split("\n").length;
          // A match viewer's spans are already resolved by the same edit-dsl
          // cascade the edit-phase feedback uses; mark their file-absolute
          // lines in `# details` (a bare viewer marks nothing).
          let markedLines: ReadonlySet<number> | null = null;
          if (selection.matcher !== null) {
            const viewerResolution = resolveEditDslReply([selection], {
              sourceFor: () => pickSource,
              resolveEntry: (source, path, locator, space) =>
                resolveCurrentEntry(source, path, locator, space),
            });
            const viewer = viewerResolution.viewers[0];
            if (viewer !== undefined) {
              const marked = markedViewerLines(viewer);
              if (marked.size > 0) {
                markedLines = marked;
              }
            }
          }
          initialContentPrompt = buildEditDslDetailsPrompt(
            options.issue,
            editDslIndexText,
            pickSource.slice(declarationStart, entry.node.end),
            specFiles,
            startLine,
            markedLines,
            duplicateDeclarationNote(selection.locator.path, pickSource, entry),
          );
        } else {
          initialContentPrompt = buildEditDslCreatePrompt(
            options.issue,
            editDslIndexText,
            selection.locator.path,
            specFiles,
          );
        }
        // A first-turn editor already carries its `replace`; apply it in the
        // content branch without asking the provider again.
        if (selection.replacement !== null) {
          prefetchedReply = response;
        }
        continue;
      }

      // Content exchange: revise the pinned target. Soft failures re-ask with
      // diagnostics; #57 removed the fixed exchange budget.
      let pinnedTarget: { mode: SelectionMode; locator: Locator } | null = pinned;
      if (pinnedTarget === null) {
        // Unreachable: the pick branch either pins a target or returns.
        throw new Error("content exchange without a pinned target");
      }
      const target = pinnedTarget.locator.path;
      const diskSource = readFileIfExists(join(cwd, target)) ?? "";
      let contentPrompt: string;
      // Failure history (#71): computed for every content retry; the same
      // pattern feeds the sharpened 2nd+ ask framing (#65). The no-progress ask
      // (#54/#57) is a cadence and can land on any exchange, including the first
      // content prompt after a late successful pick.
      const failurePattern = detectFailurePattern(records);
      // A prefetched first-turn editor or confirmation reply already answered a
      // prompt the model saw; do not consume a no-progress ask for it.
      const stalled = prefetchedReply === null ? takeStalledAsk(failurePattern) : undefined;
      const failureHistory = renderFailureHistoryNote(failurePattern);
      if (stalled !== undefined) {
        promptOffersStop = true;
        // Decision-only turn (#75): the same repeated-non-converging gating as
        // the earlier no-progress ask.
        decisionTurn = isDecisionAsk(stalled);
      }
      if (stalled === undefined && lastDiagnostics === null && initialContentPrompt !== null) {
        contentPrompt = initialContentPrompt;
      } else {
        const rawPromptDiagnostics = combinedDiagnostics(iterationOpenedBy, lastDiagnostics);
        const promptDiagnostics =
          stalled !== undefined && rawPromptDiagnostics === "the previous exchange was rejected"
            ? "the previous attempts made no progress"
            : rawPromptDiagnostics;
        const repairSource = repairContextSource({
          mode: pinnedTarget.mode === "create" ? "create" : "modify",
          repair,
          target,
          locator: pinnedTarget.locator,
          diskSource,
          diagnostics: promptDiagnostics,
        });
        const currentSource =
          repairSource.preRendered !== undefined
            ? repairSource.source
            : truncateSource(repairSource.source);
        // The self-check result is shown exactly once, in the prompt right after
        // the request was executed (#73).
        const selfCheck = pendingSelfCheck;
        pendingSelfCheck = null;
        contentPrompt = buildRetryPrompt({
          exchangeNumber: exchange,
          mode: pinnedTarget.mode === "create" ? "create" : "modify",
          currentSource,
          preRenderedSource: repairSource.preRendered,
          // A soft edit failure overwrites `lastDiagnostics`; in a repair
          // iteration keep the verification failure visible too (#48).
          diagnostics: promptDiagnostics,
          failure: lastFailure,
          // The ask names re-pinning as a concrete alternative, so it may move
          // the pin exactly like a verification-opened retry.
          stalled,
          digest: stalled === undefined ? undefined : digestText(),
          failureHistory,
          // The decision reply's stated re-approach (#75) rides the next
          // exchange's edit prompt so the attempt must follow it.
          approach: pendingApproach ?? undefined,
          // Per-cause rejection correction (#56): only edit retries carry the
          // class-specific lead; verification-repair prompts keep the default.
          correction: lastFailure === "edit" ? (lastCorrection ?? undefined) : undefined,
          selfCheck: selfCheck ?? undefined,
          editDslContext: {
            issue: options.issue,
            indexText: editDslIndexText,
            startLine: editDslPromptStartLine(
              pinnedTarget.mode === "create" ? "create" : "modify",
              target,
              pinnedTarget.locator,
              diskSource,
              repair,
            ),
          },
        });
      }
      messages = [
        systemMessage,
        roundIssueMessage,
        {
          role: "assistant",
          content: pinnedAssistantContent ?? pinnedAddressJson,
        },
        { role: "user", content: contentPrompt },
      ];
      let response: ChatResponse;
      if (prefetchedReply !== null) {
        // A first-turn edit-dsl editor: its select reply already carries the
        // replacement, so apply it here without a second provider call (its
        // tokens were counted on the pick exchange).
        response = prefetchedReply;
        prefetchedReply = null;
      } else {
        try {
          response = await options.provider.chat(messages, undefined, exchangeOptions);
        } catch (error) {
          const diagnostics = providerErrorDiagnostics(error);
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
            tokens,
          };
        }
        consumedCostUsd += costBudgetFromResponse(response);
        addTokens(loopTokensFromResponse(response));
        if (consumedCostUsd > costBudgetUsd) {
          return await terminate(
            "cost-budget",
            costBudgetDiagnostics(consumedCostUsd, costBudgetUsd),
          );
        }
      }
      // Only a no-progress ask offers STOP (#54/#57).
      if (promptOffersStop && isStopReply(response)) {
        return await stopRun(
          exchange,
          response,
          stalledStopDiagnostics(
            stalledAttempts,
            combinedDiagnostics(iterationOpenedBy, lastDiagnostics),
          ),
        );
      }
      // Decision-only turn (#75): STOP was handled above. A reply that still
      // carries a structurally valid edit payload is a real attempt and flows
      // through the unchanged guards below; any other reply is the stated
      // re-approach — clamped and carried into the next exchange's prompt
      // instead of being parsed as an edit (no cap, no auto-stop).
      if (decisionTurn && !isEditDslReply(response.content ?? "")) {
        pendingApproach = clampText(response.content ?? "", APPROACH_LIMIT);
        continue;
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
        stalledAttempts += 1;
        // Output-limit strike guard (#98), not an exchange/round cap: the
        // just-pushed row is counted, so the third consecutive length finish
        // terminates through the summary path rather than continuing to burn
        // budget. A non-consecutive truncation is an ordinary failed attempt.
        if (consecutiveLengthFinishes(records) >= MAX_CONSECUTIVE_LENGTH) {
          return await terminate(
            "output-limit",
            "stage: output-limit\nthe completion hit the output limit on 3 consecutive attempts; ending the run through the summary path",
          );
        }
        // Truncation has its own output-length guard above; do not also feed it
        // to the reply/source fingerprint before that guard can fire.
        continue;
      }
      const content = response.content ?? "";
      // Edit-dsl self-check turn: a standalone `check end` / `test end` runs
      // the configured command without writing. It has no fixed count; repeated
      // identical results are surfaced as no progress, while the USD cost budget is
      // the stop.
      const editDslSelfCheck = parseEditDslSelfCheck(content);
      if (editDslSelfCheck.kind !== "none") {
        if (editDslSelfCheck.kind === "error") {
          const cause = classifyRejection({ stage: "protocol" });
          records.push(
            recordRow({
              row: records.length + 1,
              iteration,
              kind: "exchange",
              exchange,
              locator: pinnedTarget.locator,
              replacement: response.content ?? null,
              diagnostics: editDslSelfCheck.diagnostics,
              outcome: "protocol",
              finishReason: response.finishReason,
              cause,
              payloads: 0,
              toolCalls: response.toolCalls.length,
            }),
          );
          registerRejection(cause);
          lastDiagnostics = editDslSelfCheck.diagnostics;
          lastFailure = "edit";
          stalledAttempts += 1;
          continue;
        }
        const result = await executeSelfCheck(editDslSelfCheck.request, {
          cwd,
          checkCommand: options.checkCommand,
          testCommand: options.testCommand,
          commandTimeoutMs: options.commandTimeoutMs,
        });
        const sourceState = readFileIfExists(join(cwd, target)) ?? baseSource;
        const fingerprint = `${editDslSelfCheck.request}\0${sourceState}\0${result}`;
        const repeated = fingerprint === lastEditDslSelfCheckFingerprint;
        lastEditDslSelfCheckFingerprint = fingerprint;
        const selfCheckResult = repeated
          ? `No progress: the same ${editDslSelfCheck.request} command returned the same result with no source change. Change the failing cause or use a different edit.\n\n${result}`
          : result;
        pendingSelfCheck = selfCheckResult;
        if (lastDiagnostics === null) {
          lastDiagnostics =
            "stage: self-check\nthe requested self-check ran; use the result below and continue with the edit";
        }
        lastFailure = "edit";
        records.push(
          recordRow({
            row: records.length + 1,
            iteration,
            kind: "exchange",
            exchange,
            locator: pinnedTarget.locator,
            replacement: null,
            diagnostics: selfCheckResult,
            outcome: "self-check",
            finishReason: response.finishReason,
            payloads: 0,
            toolCalls: response.toolCalls.length,
          }),
        );
        continue;
      }
      // Batch-level rejection cause (#69/#78): `multi-protocol`/`multi-duplicate`
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
      // #24: the live path/name of the first address failure in this reply,
      // used for the repeated-address fallback lead.
      let firstEditDslAddress: { path: string; name: string } | null = null;
      // #119: the edit-dsl reply state. Under the edit-dsl protocol it is parsed
      // first and is the required form.
      let editDslReply = false;
      let editDslStatements: EditStatement[] = [];
      let editDslSelections: EditDslSelection[] = [];
      let editDslResolution: MultiEditorResolution | null = null;
      // Parse a `multiEditor` reply and resolve editors/file commands against
      // each file's current source. Returns null when the reply is empty; a
      // `SelectionSyntaxError` propagates to the caller.
      const parseEditDsl = (): {
        statements: EditStatement[];
        selections: EditDslSelection[];
        resolution: MultiEditorResolution;
      } | null => {
        const statements = parseMultiEditor(stripCodeFences(content));
        if (statements.length === 0) {
          return null;
        }
        const cached = makeMultiEditorDeps();
        const resolution = resolveMultiEditor(statements, {
          ...cached,
          sourceFor: (path) => (path === target ? sourceBefore : cached.sourceFor(path)),
        });
        const selections = statements
          .filter(
            (statement): statement is Extract<EditStatement, { type: "editor" }> =>
              statement.type === "editor",
          )
          .map((statement) => statement.selection);
        return { statements, selections, resolution };
      };
      if (failure !== null) {
        // Refused self-check request: no payload to parse.
      } else {
        try {
          const parsed = parseEditDsl();
          if (parsed === null) {
            failure = EDIT_DSL_FORCE_DIAGNOSTICS;
          } else {
            editDslReply = true;
            editDslStatements = parsed.statements;
            editDslSelections = parsed.selections;
            editDslResolution = parsed.resolution;
            failure = null;
            failureCause = null;
            failureStage = "protocol";
          }
        } catch (error) {
          if (!(error instanceof SelectionSyntaxError)) {
            throw error;
          }
          failure = editDslParseDiagnostics(content, error);
        }
      }
      const batchWrites: { path: string; source: string }[] = [];
      // #111 edit-dsl application: resolve the parsed clauses into regions,
      // viewers, and typed failures, then apply the resolved editor clauses
      // atomically across the whole reply (§6): any resolution failure or
      // apply failure discards every region, including creates and files that
      // passed their own guards. Viewers surface their occurrences as the next
      // prompt's feedback and write nothing.
      let editDslApplied = false;
      let editDslAppliedRegions: ResolvedRegion[] = [];
      let editDslCreates = 0;
      let editDslDeletes: { index: number; path: string }[] = [];
      let editDslViewerFeedback: string | null = null;
      if (failure === null && editDslReply && editDslResolution !== null) {
        const totalClauses = editDslStatements.length;
        const blocks: string[] = [];
        const blockStages: EditFailureStage[] = [];
        const ignoredApplyIndices = new Set<number>();
        let firstEditDslStage: EditFailureStage | null = null;
        let firstEditDslCause: MatcherCause | undefined;
        let firstEditDslUndeclared: string | null = null;
        const noteEditDslFailure = (
          failureIndex: number,
          failurePath: string,
          locator: Locator,
          stage: EditFailureStage,
          diagnostics: string,
          origin: { matcherCause?: MatcherCause; undeclaredName?: string | null } = {},
        ): void => {
          if (firstEditDslStage === null) {
            firstEditDslStage = stage;
            firstEditDslCause = origin.matcherCause;
            firstEditDslUndeclared = origin.undeclaredName ?? null;
          }
          if (firstEditDslAddress === null && stage === "address" && failurePath !== "") {
            firstEditDslAddress = { path: failurePath, name: locator.name };
          }
          blocks.push(
            editDslClauseDiagnostics(
              failureIndex + 1,
              totalClauses,
              failurePath,
              locator,
              diagnostics,
            ),
          );
          blockStages.push(stage);
        };
        const regions = editDslResolution.regions.map(editDslRegionToResolved);
        const fsCreates = editDslResolution.creates;
        editDslDeletes = editDslResolution.deletes;
        // #111: count the create clauses the reply resolved, applied or not, so
        // the stage/metrics instrumentation records create-form adoption.
        editDslCreates =
          editDslResolution.regions.filter((region) => region.create).length + fsCreates.length;
        // Inert no-op clauses (#44) are per clause: ignore them only when
        // another resolved clause still changes the source. Every other
        // failure keeps the whole reply atomic.
        const resolutionPartition = partitionEditDslFailures(editDslResolution.failures);
        const canApplyOther =
          regions.length > 0 || fsCreates.length > 0 || editDslDeletes.length > 0;
        const ignoreInertFailures =
          resolutionPartition.fatal.length === 0 &&
          resolutionPartition.inert.length > 0 &&
          canApplyOther;
        for (const clauseFailure of editDslResolution.failures) {
          if (ignoreInertFailures && clauseFailure.stage === "no-op") {
            continue;
          }
          noteEditDslFailure(
            clauseFailure.index,
            clauseFailure.path,
            clauseFailure.locator,
            clauseFailure.stage,
            clauseFailure.diagnostics,
            {
              // `regex-invalid` is a matcher cause (#109/#111); the other
              // matcher failures carry theirs unchanged.
              matcherCause:
                clauseFailure.stage === "matcher"
                  ? (clauseFailure.cause as MatcherCause)
                  : undefined,
              undeclaredName: clauseFailure.undeclaredName,
            },
          );
        }
        // Whole-reply atomicity (§6): fatal resolution failures discard every
        // resolved region, and any fatal apply failure discards every returned
        // write (including files that passed). Nothing is written until both
        // sets are clean.
        let writes: { path: string; source: string }[] = [];
        if (resolutionPartition.fatal.length === 0) {
          writes = await applyResolvedRegions({
            regions,
            fileSourceOf: (path) =>
              path === target ? sourceBefore : (readFileIfExists(join(cwd, path)) ?? ""),
            target,
            prevCheck,
            // Multiple create clauses append at the same end offset. Treat
            // those zero-width inserts as ordered appends instead of an
            // overlap; real span overlaps still fail below.
            policy: { sameOffsetInserts: "append" },
            noteFailure: (note) => {
              if (note.stage === "no-op") {
                ignoredApplyIndices.add(note.region.index);
              }
              noteEditDslFailure(
                note.region.index,
                note.path,
                note.region.locator,
                note.stage,
                note.diagnostics,
                { matcherCause: note.matcherCause },
              );
            },
            noteOverlap: (path, earlier, later) => {
              failureCause = "multi-duplicate";
              if (firstEditDslStage === null) {
                firstEditDslStage = "protocol";
              }
              blocks.push(editDslOverlapDiagnostics(totalClauses, path, earlier, later));
              blockStages.push("protocol");
            },
          });
          for (const create of fsCreates) {
            writes.push({ path: create.path, source: "" });
          }
        }
        const fatalBlocks = blocks.filter((_block, index) => blockStages[index] !== "no-op");
        const inertBlocks = blocks.filter((_block, index) => blockStages[index] === "no-op");
        let ignoredInertClauses = ignoreInertFailures ? resolutionPartition.inert.length : 0;
        if (fatalBlocks.length > 0) {
          // A non-no-op failure still discards the whole reply; the diagnostic
          // keeps every failing clause, inert ones included.
          failure = blocks.join("\n\n");
          if (firstEditDslStage !== null) {
            failureStage = firstEditDslStage;
          }
          matcherCause = firstEditDslCause;
          addressUndeclaredName = firstEditDslUndeclared;
        } else if (inertBlocks.length > 0) {
          const hasOtherApply =
            writes.length > 0 || fsCreates.length > 0 || editDslDeletes.length > 0;
          if (hasOtherApply) {
            // The other clauses applied; the inert clauses are ignored rather
            // than rejecting the whole reply.
            ignoredInertClauses += ignoredApplyIndices.size;
          } else {
            // Every clause was inert: keep the existing no-op rejection.
            failure = inertBlocks.join("\n\n");
            if (firstEditDslStage !== null) {
              failureStage = firstEditDslStage;
            }
            matcherCause = firstEditDslCause;
            addressUndeclaredName = firstEditDslUndeclared;
          }
        }
        if (
          failure === null &&
          (regions.length > 0 || fsCreates.length > 0 || editDslDeletes.length > 0)
        ) {
          editDslApplied = true;
          editDslAppliedRegions = regions.filter(
            (region) => !ignoredApplyIndices.has(region.index),
          );
          batchWrites.push(...writes);
          newSource = writes.find((write) => write.path === target)?.source ?? sourceBefore;
        }
        if (failure === null && ignoredInertClauses > 0) {
          const warning = ignoredInertClausesWarning(ignoredInertClauses);
          warnings.push(warning);
          editDslViewerFeedback = [editDslViewerFeedback, warning]
            .filter((block): block is string => block !== null && block !== "")
            .join("\n\n");
        }
        const readFeedback =
          editDslResolution.reads.length === 0 ? null : renderReadFeedback(editDslResolution.reads);
        const readErrorFeedback = renderReadFailureFeedback(editDslResolution.readFailures);
        // A failed `read` writes nothing, so it is feedback rather than a
        // rejection. Only a reply whose sole content was failing reads has no
        // work to show; surface that as the retry-driving failure (#25).
        const onlyFailedReads =
          failure === null &&
          blocks.length === 0 &&
          editDslResolution.failures.length === 0 &&
          regions.length === 0 &&
          fsCreates.length === 0 &&
          editDslDeletes.length === 0 &&
          editDslResolution.reads.length === 0 &&
          editDslResolution.viewers.length === 0 &&
          readErrorFeedback !== "";
        if (onlyFailedReads) {
          failure = readErrorFeedback;
          failureStage = "range";
        }
        // Once the read error is the failure itself, do not also append it to the
        // viewer feedback (the retry would show it twice).
        const feedbackReadErrors = onlyFailedReads ? "" : readErrorFeedback;
        const viewerFeedback =
          editDslResolution.viewers.length === 0
            ? null
            : renderViewerFeedback(editDslResolution.viewers);
        if (viewerFeedback !== null || readFeedback !== null || feedbackReadErrors !== "") {
          editDslViewerFeedback = [
            editDslViewerFeedback,
            viewerFeedback,
            readFeedback,
            feedbackReadErrors || null,
          ]
            .filter((block): block is string => block !== null && block !== "")
            .join("\n\n");
        }
      }
      // A viewer locate turn (#111): a reply that carried only viewers writes
      // nothing and is not an edit failure; its occurrences ride the next
      // prompt. A mixed reply carries viewer results alongside the diagnostics;
      // its editors apply only when the whole reply is clean.
      if (editDslViewerFeedback !== null) {
        if (failure !== null) {
          failure = `${failure}\n\n${editDslViewerFeedback}`;
        } else if (!editDslApplied) {
          records.push(
            recordRow({
              row: records.length + 1,
              iteration,
              kind: "exchange",
              exchange,
              locator: pinnedTarget.locator,
              replacement: null,
              diagnostics: editDslViewerFeedback,
              outcome: "viewer",
              finishReason: response.finishReason,
              payloads: editDslStatements.length,
              toolCalls: response.toolCalls.length,
            }),
          );
          lastDiagnostics = editDslViewerFeedback;
          lastFailure = "edit";
          // A viewer is inspection, not a failed attempt: it does not advance
          // the no-progress cadence and is bounded by the USD cost budget only.
          continue;
        } else {
          carriedViewerFeedback = editDslViewerFeedback;
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
      if (!editDslApplied && failure === null && newSource !== null) {
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
            payloads: editDslSelections.length,
            toolCalls: response.toolCalls.length,
            // #111: an edit-dsl reply records the cascade's own stages/kinds for
            // the clauses that actually applied (#110), not the resolved set.
            selectors: editDslAppliedRegions.map((region) => selectorFromStage(region.stage)),
            stages: editDslAppliedRegions.map((region) => region.stage),
            matcherKinds: editDslAppliedRegions.map((region) => region.matcherKind),
            creates: editDslCreates,
          }),
        );
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
          address: firstEditDslAddress ?? undefined,
        });
        lastDiagnostics = retryDiagnostics(diagnostics);
        lastFailure = "edit";
        stalledAttempts += 1;
        // #57: distinct rejected edits retry without a fixed exchange cap; a
        // repeated reply/source/diagnostics fingerprint is no progress and ends
        // the run instead of looping until the budget.
        if (repeatFailure(response.content ?? "", diagnostics, sourceBefore)) {
          return await terminate(
            "edit-exhausted",
            repeatedNoProgressDiagnostics(combinedDiagnostics(iterationOpenedBy, lastDiagnostics)),
          );
        }
        continue;
      }
      if (editDslApplied) {
        // Atomic apply (#69/#111): every payload/clause passed its own guard
        // above, so the prepared sources are written together; a single failure
        // wrote nothing.
        for (const write of batchWrites) {
          writeTarget(cwd, write.path, write.source);
        }
        for (const deletion of editDslDeletes) {
          rmSync(join(cwd, deletion.path), { force: true });
        }
        replacement = editDslAppliedRegions.map((region) => region.text).join("\n\n");
      } else {
        writeTarget(cwd, target, newSource);
      }
      // An applied edit ends the rejection chain (#56): the next rejection
      // starts a fresh streak regardless of the verification outcome below.
      clearRejectionPolicy();
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
          payloads: editDslSelections.length,
          toolCalls: response.toolCalls.length,
          selectors: editDslAppliedRegions.map((region) => selectorFromStage(region.stage)),
          stages: editDslAppliedRegions.map((region) => region.stage),
          matcherKinds: editDslAppliedRegions.map((region) => region.matcherKind),
          creates: editDslCreates,
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
        // EditDsl confirmation (#B3): a verified edit gets one `# modified
        // text` turn. An editor clause continues the exchange loop; anything
        // else (including prose/malformed/viewer) confirms success.
        const modifiedLocator = editDslAppliedRegions[0]?.locator ?? pinnedTarget.locator;
        const modifiedPath = modifiedLocator.path;
        const modifiedSource = readFileIfExists(join(cwd, modifiedPath));
        let modifiedText = "";
        let modifiedStartLine = 1;
        if (modifiedSource !== null) {
          const modifiedEntry = resolveCurrentEntry(
            modifiedSource,
            modifiedPath,
            modifiedLocator,
            null,
          );
          if (modifiedEntry.ok) {
            const modifier = precedingExportModifier(modifiedSource, modifiedEntry.entry);
            const declarationStart =
              modifier === null
                ? modifiedEntry.entry.node.start
                : modifiedEntry.entry.node.start - modifier.length;
            modifiedText = modifiedSource.slice(declarationStart, modifiedEntry.entry.node.end);
            modifiedStartLine = modifiedSource.slice(0, declarationStart).split("\n").length;
          } else {
            modifiedText = truncateSource(modifiedSource);
          }
        }
        const modifiedPrompt = buildEditDslModifiedPrompt(
          options.issue,
          editDslIndexText,
          modifiedText,
          modifiedStartLine,
        );
        let confirmation: ChatResponse;
        try {
          confirmation = await options.provider.chat(
            [
              systemMessage,
              roundIssueMessage,
              { role: "assistant", content: response.content ?? "" },
              { role: "user", content: modifiedPrompt },
            ],
            undefined,
            exchangeOptions,
          );
        } catch {
          // The edit is already verified; a confirmation transport failure
          // must not turn the run into a failure.
          return success(newSource);
        }
        consumedCostUsd += costBudgetFromResponse(confirmation);
        addTokens(loopTokensFromResponse(confirmation));
        if (consumedCostUsd > costBudgetUsd) {
          // The confirmation is advisory and the verification already passed:
          // an over-budget confirmation still reports the verified success.
          return success(newSource);
        }
        records.push(
          recordRow({
            row: records.length + 1,
            iteration,
            kind: "exchange",
            exchange,
            locator: modifiedLocator,
            replacement: null,
            diagnostics: null,
            outcome: "confirmed",
            finishReason: confirmation.finishReason,
            toolCalls: confirmation.toolCalls.length,
          }),
        );
        let confirmationSelections: EditDslSelection[] = [];
        try {
          confirmationSelections = parseSelection(stripCodeFences(confirmation.content ?? ""));
        } catch (error) {
          if (!(error instanceof SelectionSyntaxError)) {
            throw error;
          }
          return success(newSource);
        }
        const continues = confirmationSelections.some(
          (selection) =>
            selection.replacement !== null ||
            (selection.rename !== undefined && selection.rename !== null),
        );
        if (continues) {
          // #8/#57: the exchange loop has no fixed slot limit, so a verified
          // confirmation editor always continues in the same round. Its reply
          // was already counted; the next exchange reuses it without another
          // provider call.
          prefetchedReply = confirmation;
          initialContentPrompt = modifiedPrompt;
          continue;
        }
        return success(newSource);
      }
      // No rollback (#30): the attempted state stays on disk for the next
      // iteration to refine. A failure just starts the next iteration; #57
      // removed the fixed exchange/round budget.
      const diagnostics = formatDiagnostics({
        check,
        test,
        targetPath: target,
        baseSource: sourceBefore,
        newSource,
        sourceFor: (file) => readFileIfExists(join(cwd, file)),
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
      // #111: a mixed edit-dsl reply's viewer occurrences ride into the next
      // round's prompt alongside the verification failure.
      pendingDiagnostics =
        carriedViewerFeedback !== null ? `${carriedViewerFeedback}\n\n${diagnostics}` : diagnostics;
      carriedViewerFeedback = null;
      pendingVerificationStage = check.ok ? "tests" : "tsc";
      stalledAttempts += 1;
      // #57: a failed verification is one more failed attempt; a repeated
      // reply/source/diagnostics state is no progress. The round still ends so
      // the next prompt opens with the verification failure, but nothing
      // terminates it for reaching a fixed round count.
      if (repeatFailure(response.content ?? "", diagnostics, newSource)) {
        return await terminate(
          "edit-exhausted",
          repeatedNoProgressDiagnostics(combinedDiagnostics(iterationOpenedBy, diagnostics)),
        );
      }
      verificationFailed = true;
      break;
    }

    // The exchange loop leaves only on a failed verification (the next round
    // opens with its diagnostics) or on success/termination. #57 has no fixed
    // exchange or round cap and no round-continuation budget: the USD cost budget,
    // the repeated no-progress fingerprint, and the no-progress ask are the
    // only termination paths for a failed loop.
    if (verificationFailed) {
      continue;
    }
    // Unreachable: every other exchange path returns, retries, or breaks after
    // a failed verification.
    return await terminate(
      "edit-exhausted",
      editExhaustedDiagnostics(iterationOpenedBy, lastDiagnostics),
    );
  }
}

export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  // Canonicalize here too so a legacy caller passing `edit` still routes to
  // pinned-repair; canonical values are the only ones written onward.
  if (canonicalAgentMode(options.agentMode) === "plan-exec") {
    // Lazy: the task driver imports from this module, so a static import here
    // would be a load-time cycle.
    const { runTaskLoop } = await import("./task-loop");
    return runTaskLoop(options);
  }
  return runEditDslLoop(options);
}
