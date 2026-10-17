import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyAnchorSplice, findAnchor, parseEditsResponse, stripCodeFences } from "./anchor";
import type { ParsedEdit } from "./anchor";
import { formatSource } from "./editor";
import { buildIndexTolerant, findDefinition } from "./utility";
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
import type { CheckDiagnostic, CommandResult } from "./tools";
import type { IndexEntry, Locator, SkippedFile, SourceFile, TolerantIndex } from "./utility";

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

export function buildSystemPrompt(): string {
  return [
    "You are a TypeScript coding agent.",
    "",
    'First you will be asked to select the symbol to modify. Reply with ONLY a JSON object { "path": ..., "name": ..., "kind": ... }: no markdown fences and no prose.',
    "",
    'Then you will be asked to replace part of the selected symbol. Reply with ONLY a JSON object {"edits":[{"anchor": ..., "replacement": ...}, ...]} holding 1 to 8 edits, e.g. {"edits":[{"anchor":"return 1;","replacement":"return 2;"},{"anchor":"return 3;","replacement":"return 4;"}]}: emit the fewest edits that cover the change, ordered top-to-bottom (earlier source text first). Each anchor is a complete snippet copied from the current source; anchors must be unique, and each is matched against the evolving source after the previous edits. The replacement is a drop-in for the anchor: keep leading keywords and modifiers consistent (do not re-add `export` the anchor omitted). Use the whole symbol as the anchor only for a full rewrite. Keep the same declaration kind and name unless the task requires otherwise. No markdown fences and no explanations.',
    "",
    "The selected symbol may not exist yet. When it is missing, the harness appends your complete output to the target file (creating the file and any parent directories when needed) instead of editing a symbol range.",
    "",
  ].join("\n");
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

export function buildReplacementPrompt(locatorJson: string, symbolSource: string): string {
  const body = symbolSource.endsWith("\n") ? symbolSource : `${symbolSource}\n`;
  return `Output a JSON object {"edits":[{"anchor": ..., "replacement": ...}, ...]} holding 1 to 8 edits for the symbol identified by this locator, with no markdown fences and no explanations.

Each anchor is a complete snippet copied from the current source below; emit the fewest edits that cover the change, ordered top-to-bottom (earlier source text first). Anchors must be unique, and each is matched against the evolving source after the previous edits. Each replacement is a drop-in for its anchor: keep leading keywords and modifiers consistent (do not re-add \`export\` the anchor omitted). Use the whole symbol as the anchor only for a full rewrite.

Locator:

\`\`\`json
${locatorJson}
\`\`\`

Current source of the symbol:

\`\`\`ts
${body}\`\`\`
`;
}

export function buildAppendPrompt(locatorJson: string, path: string): string {
  return `The symbol identified by this locator does not exist yet. Output the COMPLETE code that declares the symbol, with no markdown fences and no explanations.

The target file may not exist yet. The harness appends your output to it, creating the file and any parent directories when needed.

Target file:

\`\`\`
${path}
\`\`\`

Locator:

\`\`\`json
${locatorJson}
\`\`\`
`;
}

export interface RetryPromptInput {
  /** 1-based number of the retry this prompt requests. */
  attemptNumber: number;
  maxAttempts: number;
  /** Replace mode requests a 1..N edit JSON object; append mode plain text. */
  mode: "replace" | "append";
  locatorJson: string;
  /** Current on-disk source of the selected region (whole file in append mode). */
  currentSource: string;
  diagnostics: string;
}

export function buildRetryPrompt(input: RetryPromptInput): string {
  const { attemptNumber, maxAttempts, mode, locatorJson, currentSource, diagnostics } = input;
  const remaining = maxAttempts - attemptNumber;
  const body = currentSource.endsWith("\n") ? currentSource : `${currentSource}\n`;
  const instruction =
    mode === "replace"
      ? 'Make minimal corrective changes to the current source below. Output ONLY a JSON object {"edits":[{"anchor": ..., "replacement": ...}, ...]} holding 1 to 8 edits, e.g. {"edits":[{"anchor":"return 1;","replacement":"return 2;"},{"anchor":"return 3;","replacement":"return 4;"}]}: emit the fewest edits that cover the change, ordered top-to-bottom (earlier source text first); anchors must be unique, and each is matched against the evolving source after the previous edits; each replacement is a drop-in for its anchor (do not re-add `export` the anchor omitted). Use the whole symbol as the anchor only for a full rewrite. No markdown fences and no explanations.'
      : "Make minimal corrective changes to the current source of the selected region. Output the COMPLETE corrected text for the selected region, with no markdown fences and no explanations.";
  return `Attempt ${attemptNumber} of ${maxAttempts} failed verification. ${remaining} attempt(s) remain.

${instruction}

Locator:

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
`;
}

export function buildSelectionRetryPrompt(diagnostics: string): string {
  return `The previous locator was rejected.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`

Output ONLY a corrected locator JSON object { "path": ..., "name": ..., "kind": ... }, with no markdown fences and no prose.
`;
}

export { stripCodeFences };

function validateLocator(parsed: unknown): Locator {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("model did not return a valid locator JSON");
  }
  const record = parsed as Record<string, unknown>;
  const path = record["path"];
  const name = record["name"];
  const kind = record["kind"];
  if (typeof path !== "string" || typeof name !== "string" || typeof kind !== "string") {
    throw new Error("model did not return a valid locator JSON");
  }
  return { path, name, kind };
}

export function parseLocatorResponse(content: string): Locator {
  const text = stripCodeFences(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("model did not return a valid locator JSON");
  }
  return validateLocator(parsed);
}

export function parseReplacementResponse(content: string): string {
  const text = stripCodeFences(content);
  if (text === "") {
    throw new Error("model did not return replacement text");
  }
  return text;
}

export interface ProviderLike {
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatResponse>;
}

export const DEFAULT_TOKEN_BUDGET = 120_000;
export const DEFAULT_RETRY_EXTENSIONS = 2;
/** Hard cap on anchored edits per replace response (#33). */
export const MAX_EDITS_PER_ATTEMPT = 8;
/** Absolute attempt ceiling, including progress extensions (#36). */
export const MAX_TOTAL_ATTEMPTS = 5;

export interface LoopOptions {
  cwd: string;
  issue: string;
  model: string;
  provider: ProviderLike;
  maxRetries?: number;
  /** Extra attempts granted after strictly improving failure signatures (#36). */
  retryExtensions?: number;
  /** Cap on anchored edits per replace response (#33); defaults to MAX_EDITS_PER_ATTEMPT. */
  maxEditsPerAttempt?: number;
  /** Abort the run once accumulated provider tokens exceed this (#36). */
  tokenBudget?: number;
  temperature?: number;
  checkCommand?: string[];
  testCommand?: string[];
  commandTimeoutMs?: number;
}

export type AttemptOutcome =
  | "ok"
  | "selection-invalid"
  | "empty-output"
  | "edits-invalid"
  | "anchor-not-found"
  | "anchor-ambiguous"
  | "format"
  | "tsc"
  | "tests"
  | "truncated";

export interface LoopAttempt {
  attempt: number;
  locator: Locator;
  replacement: string | null;
  diagnostics: string | null;
  outcome: AttemptOutcome;
  diagnosticsHead: string | null;
  replacementChars: number | null;
  finishReason: string | null;
  /** True on the failed attempt that earned the next one (#36). */
  extensionGranted?: boolean;
  /** Anchored edits parsed from the replace response (#33); absent in append mode. */
  edits?: number;
  /** Prefix of the response's edits applied before a failure (#33); equals edits on success. */
  appliedEdits?: number;
}

export interface LoopResult {
  ok: boolean;
  mode?: "replace" | "append";
  locator: Locator | null;
  filePath: string | null;
  editedSource: string | null;
  attempts: LoopAttempt[];
  diagnostics: string | null;
  explanation: string | null;
  messages: ChatMessage[];
  skipped?: SkippedFile[];
  /** Progress extensions granted over the retry budget (#36). */
  extensions: number;
  /** Set when the run aborted at the token budget (#36). */
  abortReason?: "token-budget";
}

type Selection =
  | { mode: "replace"; locator: Locator; entry: IndexEntry }
  | { mode: "append"; locator: Locator; path: string };

const EMPTY_LOCATOR: Locator = { path: "", name: "", kind: "" };
const DIAGNOSTICS_LIMIT = 4000;
const DIAGNOSTICS_HEAD_LIMIT = 200;
const EXPLANATION_PROMPT =
  "Explain in one short paragraph why the task could not be completed and what the next step for the planner is. Do not output code.";

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

function recordAttempt(input: {
  attempt: number;
  locator: Locator;
  replacement: string | null;
  diagnostics: string | null;
  outcome: AttemptOutcome;
  finishReason: string | null;
  extensionGranted?: boolean;
  edits?: number;
  appliedEdits?: number;
}): LoopAttempt {
  return {
    ...input,
    extensionGranted: input.extensionGranted === true,
    diagnosticsHead: diagnosticsHeadOf(input.diagnostics),
    replacementChars: input.replacement === null ? null : input.replacement.length,
  };
}

function locatorFromResponse(response: ChatResponse): Locator {
  const toolCall = response.toolCalls[0];
  if (toolCall !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolCall.function.arguments);
    } catch {
      throw new Error("model did not return a valid locator JSON");
    }
    return validateLocator(parsed);
  }
  return parseLocatorResponse(response.content ?? "");
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

// Re-resolve the locator against the current on-disk source so retry prompts
// show what is actually there; fall back to the whole file when it no longer
// resolves (for example after a corrupting attempt).
function currentSourceForPrompt(
  mode: "replace" | "append",
  targetPath: string,
  locator: Locator,
  currentSource: string,
): string {
  if (mode === "replace") {
    const build = buildIndexTolerant([{ path: targetPath, source: currentSource }]);
    const entry = findDefinition(build.index, locator);
    if (entry !== null) {
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

async function explain(
  provider: ProviderLike,
  messages: ChatMessage[],
  temperature: number | undefined,
): Promise<string> {
  messages.push({ role: "user", content: EXPLANATION_PROMPT });
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

export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const maxRetries = options.maxRetries ?? 3;
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const retryExtensions = options.retryExtensions ?? DEFAULT_RETRY_EXTENSIONS;
  const maxEditsPerAttempt = options.maxEditsPerAttempt ?? MAX_EDITS_PER_ATTEMPT;
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
  const systemMessage: ChatMessage = { role: "system", content: buildSystemPrompt() };
  const issueMessage: ChatMessage = {
    role: "user",
    content: buildUserPrompt(options.issue, contextYaml, specFiles),
  };
  let messages: ChatMessage[] = [systemMessage, issueMessage];
  const attempts: LoopAttempt[] = [];
  let consumedTokens = 0;
  let grantedExtensions = 0;

  let selection: Selection | null = null;
  let selectionFailures = 0;
  while (selectionFailures < maxRetries) {
    let response: ChatResponse;
    try {
      // Staged reasoning policy (#35): selection is a low-effort step.
      response = await options.provider.chat(messages, undefined, withEffort(chatOptions, "low"));
    } catch (error) {
      return {
        ok: false,
        locator: null,
        filePath: null,
        editedSource: null,
        attempts,
        diagnostics: `provider error: ${errorMessage(error)}`,
        explanation: await explain(options.provider, messages, temperature),
        messages,
        skipped,
        extensions: grantedExtensions,
      };
    }
    consumedTokens += tokensFromResponse(response);
    if (consumedTokens > tokenBudget) {
      return {
        ok: false,
        locator: null,
        filePath: null,
        editedSource: null,
        attempts,
        diagnostics: tokenBudgetDiagnostics(consumedTokens, tokenBudget),
        explanation: null,
        messages,
        skipped,
        extensions: grantedExtensions,
        abortReason: "token-budget",
      };
    }
    let candidate: Locator | null = null;
    let resolved: IndexEntry | null = null;
    let appendPath: string | null = null;
    let diagnostic: string | null = null;
    try {
      candidate = locatorFromResponse(response);
    } catch (error) {
      diagnostic = `invalid locator: ${errorMessage(error)}`;
    }
    if (candidate !== null && diagnostic === null) {
      resolved = findDefinition(index, candidate);
      if (resolved === null) {
        const skippedFile = skipped.find((file) => file.path === candidate.path);
        if (skippedFile !== undefined) {
          diagnostic = `invalid locator: no symbol ${candidate.kind} ${candidate.name} in ${candidate.path} (skipped file: ${skippedFile.message})`;
        } else {
          appendPath = safeAppendPath(cwd, candidate.path);
          if (appendPath === null) {
            diagnostic = `invalid locator: no symbol ${candidate.kind} ${candidate.name} in ${candidate.path}`;
          }
        }
      }
    }
    if (diagnostic !== null) {
      selectionFailures += 1;
      attempts.push(
        recordAttempt({
          attempt: attempts.length + 1,
          locator: candidate ?? EMPTY_LOCATOR,
          replacement: null,
          diagnostics: diagnostic,
          outcome: "selection-invalid",
          finishReason: response.finishReason,
        }),
      );
      if (selectionFailures >= maxRetries) {
        break;
      }
      messages.push({ role: "assistant", content: response.content ?? "" });
      messages.push({ role: "user", content: buildSelectionRetryPrompt(diagnostic) });
      continue;
    }
    if (candidate !== null) {
      if (resolved !== null) {
        selection = { mode: "replace", locator: candidate, entry: resolved };
      } else if (appendPath !== null) {
        selection = { mode: "append", locator: candidate, path: appendPath };
      }
    }
    break;
  }

  if (selection === null) {
    return {
      ok: false,
      locator: null,
      filePath: null,
      editedSource: null,
      attempts,
      diagnostics: "could not select a symbol",
      explanation: await explain(options.provider, messages, temperature),
      messages,
      skipped,
      extensions: grantedExtensions,
    };
  }

  const selected = selection.locator;
  const selectionMode = selection.mode;
  const locatorJson = JSON.stringify(selected);
  let targetPath: string;
  let original: string | null;
  messages.push({ role: "assistant", content: locatorJson });
  if (selectionMode === "replace") {
    const fileEntry = sourceFileFor(files, selected.path);
    const symbolSource = fileEntry.source.slice(
      selection.entry.node.start,
      selection.entry.node.end,
    );
    targetPath = selected.path;
    original = fileEntry.source;
    messages.push({ role: "user", content: buildReplacementPrompt(locatorJson, symbolSource) });
  } else {
    targetPath = selection.path;
    original = readFileIfExists(join(cwd, targetPath));
    messages.push({ role: "user", content: buildAppendPrompt(locatorJson, targetPath) });
  }
  const baseSource = original ?? "";
  // A retry rewrites the first appended region instead of appending again.
  const appendPrefix = selectionMode === "append" ? baseSource : "";

  // Retries rebuild a bounded history from the stable prefix: the previous
  // assistant replacement is not re-echoed and the prompt carries the current
  // on-disk source of the target.
  const buildRetryMessages = (
    mode: "replace" | "append",
    path: string,
    failedAttempt: number,
    promptDiagnostics: string,
  ): ChatMessage[] => {
    const diskSource = readFileIfExists(join(cwd, path)) ?? "";
    const currentSource = currentSourceForPrompt(mode, path, selected, diskSource);
    const prompt = buildRetryPrompt({
      // The prompt describes the retry it requests, clamped to the current
      // limit (which a progress extension may have just raised).
      attemptNumber: Math.min(failedAttempt + 1, attemptLimit),
      maxAttempts: attemptLimit,
      mode,
      locatorJson,
      currentSource: truncateSource(currentSource),
      diagnostics: promptDiagnostics,
    });
    return [
      systemMessage,
      issueMessage,
      { role: "assistant", content: locatorJson },
      { role: "user", content: prompt },
    ];
  };

  let diagnostics: string | null = null;
  // Extensions raise attemptLimit while the verification failure signature
  // strictly improves (#36); previousSignature tracks it across verification
  // failures and is reset by non-verification failures (the chain breaks).
  let attemptLimit = maxRetries;
  let previousSignature: number | null = null;
  for (let editAttempt = 0; editAttempt < attemptLimit; editAttempt += 1) {
    const failedAttempt = editAttempt + 1;
    let response: ChatResponse;
    try {
      // Staged reasoning policy (#35): generation starts at the provider default;
      // attempts after a failed verification step up to medium effort.
      const editOptions = editAttempt === 0 ? chatOptions : withEffort(chatOptions, "medium");
      response = await options.provider.chat(messages, undefined, editOptions);
    } catch (error) {
      // Failed attempts keep their applied state on disk (#30), so a provider
      // error after one leaves the attempted content in the target file.
      return {
        ok: false,
        mode: selectionMode,
        locator: selected,
        filePath: targetPath,
        editedSource: null,
        attempts,
        diagnostics: `provider error: ${errorMessage(error)}`,
        explanation: await explain(options.provider, messages, temperature),
        messages,
        skipped,
        extensions: grantedExtensions,
      };
    }
    consumedTokens += tokensFromResponse(response);
    if (consumedTokens > tokenBudget) {
      // Abort before parsing, applying, or verifying the in-flight response.
      return {
        ok: false,
        mode: selectionMode,
        locator: selected,
        filePath: targetPath,
        editedSource: null,
        attempts,
        diagnostics: tokenBudgetDiagnostics(consumedTokens, tokenBudget),
        explanation: null,
        messages,
        skipped,
        extensions: grantedExtensions,
        abortReason: "token-budget",
      };
    }
    if (response.finishReason === "length") {
      diagnostics =
        "stage: truncated\nthe completion was cut off at the output limit; emit a shorter, more compact replacement";
      attempts.push(
        recordAttempt({
          attempt: attempts.length + 1,
          locator: selected,
          replacement: response.content ?? null,
          diagnostics,
          outcome: "truncated",
          finishReason: response.finishReason,
        }),
      );
      previousSignature = null;
      messages = buildRetryMessages(selectionMode, targetPath, failedAttempt, diagnostics);
      continue;
    }
    // The first attempt edits the run-start source; later attempts edit what is
    // on disk now (the state left by the previous failed attempt).
    const sourceBefore =
      editAttempt === 0 ? baseSource : (readFileIfExists(join(cwd, targetPath)) ?? baseSource);
    const content = response.content ?? "";
    let replacement: string | null = null;
    let newSource: string | null = null;
    let failure: string | null = null;
    let failureStage: "format" | "edits-invalid" | "anchor-not-found" | "anchor-ambiguous" =
      "format";
    let failureOutcome: AttemptOutcome = "empty-output";
    let editCount = 0;
    let appliedEdits = 0;
    if (selectionMode === "append") {
      try {
        replacement = parseReplacementResponse(content);
      } catch (error) {
        failure = errorMessage(error);
      }
      if (replacement !== null) {
        failureOutcome = "format";
        try {
          newSource = await formatSource(targetPath, appendText(appendPrefix, replacement));
        } catch (error) {
          failure = errorMessage(error);
        }
      }
    } else if (content.trim() !== "") {
      let edits: ParsedEdit[] = [];
      try {
        edits = parseEditsResponse(content).edits;
      } catch (error) {
        failure = errorMessage(error);
        failureStage = "edits-invalid";
        failureOutcome = "edits-invalid";
      }
      if (edits.length > 0) {
        editCount = edits.length;
        replacement = edits.map((edit) => edit.replacement).join("\n");
        if (edits.length > maxEditsPerAttempt) {
          failure = `at most ${maxEditsPerAttempt} edits per response are supported (got ${edits.length})`;
          failureStage = "edits-invalid";
          failureOutcome = "edits-invalid";
        } else {
          let duplicate: [number, number] | null = null;
          const firstByAnchor = new Map<string, number>();
          for (const [index, edit] of edits.entries()) {
            const anchor = edit.anchor.trim();
            const first = firstByAnchor.get(anchor);
            if (first !== undefined) {
              duplicate = [first, index];
              break;
            }
            firstByAnchor.set(anchor, index);
          }
          if (duplicate !== null) {
            failure = `edit ${duplicate[1] + 1} duplicates the anchor of edit ${duplicate[0] + 1}; anchors must be unique and each apply to the evolving source`;
            failureStage = "edits-invalid";
            failureOutcome = "edits-invalid";
          } else {
            // Serial application (#33): each anchor is matched against the
            // source as evolved by the previous edits, so the symbol is
            // re-indexed before every edit.
            let working = sourceBefore;
            let failedEdit: {
              index: number;
              outcome: "edits-invalid" | "anchor-not-found" | "anchor-ambiguous";
              message: string;
            } | null = null;
            for (const [index, edit] of edits.entries()) {
              const resolved = findDefinition(
                buildIndexTolerant([{ path: targetPath, source: working }]).index,
                selected,
              );
              if (resolved === null) {
                failedEdit = {
                  index,
                  outcome: "edits-invalid",
                  message: "the selected symbol no longer resolves in the current source",
                };
                break;
              }
              const anchored = findAnchor(working, resolved.node, edit.anchor);
              if (anchored.kind === "unparseable") {
                failedEdit = {
                  index,
                  outcome: "edits-invalid",
                  message: `the anchor could not be parsed as TypeScript: ${anchored.message}`,
                };
                break;
              }
              if (anchored.kind === "not-found") {
                failedEdit = {
                  index,
                  outcome: "anchor-not-found",
                  message: `the anchor was not found inside ${selected.name}; extend the anchor to a complete snippet copied from the current source`,
                };
                break;
              }
              if (anchored.kind === "ambiguous") {
                failedEdit = {
                  index,
                  outcome: "anchor-ambiguous",
                  message: `the anchor matches ${anchored.matches} places inside ${selected.name}; extend the anchor with more surrounding context`,
                };
                break;
              }
              working = applyAnchorSplice(working, anchored.start, anchored.end, edit.replacement);
              appliedEdits += 1;
            }
            if (failedEdit === null) {
              failureOutcome = "format";
              try {
                newSource = await formatSource(targetPath, working);
              } catch (error) {
                failureStage = "format";
                failure = errorMessage(error);
              }
            } else {
              failureStage = failedEdit.outcome;
              failureOutcome = failedEdit.outcome;
              failure =
                edits.length > 1
                  ? `edit ${failedEdit.index + 1} of ${edits.length}: ${failedEdit.message}`
                  : failedEdit.message;
              if (appliedEdits > 0) {
                // Keep the applied prefix on disk so the retry builds on it (#30).
                try {
                  const formatted = await formatSource(targetPath, working);
                  writeTarget(cwd, targetPath, formatted);
                } catch (error) {
                  failure += ` (the applied prefix could not be formatted and was not kept: ${errorMessage(error)})`;
                }
              }
            }
          }
        }
      }
    }
    if (newSource === null || replacement === null) {
      diagnostics = `stage: ${failureStage}\n${failure ?? "model did not return replacement text"}`;
      attempts.push(
        recordAttempt({
          attempt: attempts.length + 1,
          locator: selected,
          replacement,
          diagnostics,
          outcome: failureOutcome,
          finishReason: response.finishReason,
          edits: selectionMode === "replace" ? editCount : undefined,
          appliedEdits: selectionMode === "replace" ? appliedEdits : undefined,
        }),
      );
      previousSignature = null;
      messages = buildRetryMessages(selectionMode, targetPath, failedAttempt, diagnostics);
      continue;
    }
    writeTarget(cwd, targetPath, newSource);
    const check = await checkTool(cwd, options.checkCommand, options.commandTimeoutMs);
    const test = await runVerificationTests(cwd, targetPath, options);
    if (check.ok && test.ok) {
      attempts.push(
        recordAttempt({
          attempt: attempts.length + 1,
          locator: selected,
          replacement,
          diagnostics: null,
          outcome: "ok",
          finishReason: response.finishReason,
          edits: selectionMode === "replace" ? editCount : undefined,
          appliedEdits: selectionMode === "replace" ? appliedEdits : undefined,
        }),
      );
      return {
        ok: true,
        mode: selectionMode,
        locator: selected,
        filePath: targetPath,
        editedSource: newSource,
        attempts,
        diagnostics: null,
        explanation: null,
        messages,
        skipped,
        extensions: grantedExtensions,
      };
    }
    // No rollback (#30): the attempted state stays on disk for the next attempt
    // to refine.
    diagnostics = formatDiagnostics({
      check,
      test,
      targetPath,
      baseSource: sourceBefore,
      newSource,
    });
    const signature = check.diagnostics.length + failingTestNames(test.output).length;
    // A strictly smaller signature earns one extra attempt, bounded by the
    // configured extension count and the absolute ceiling.
    const extensionGranted =
      previousSignature !== null &&
      signature < previousSignature &&
      grantedExtensions < retryExtensions &&
      attemptLimit < MAX_TOTAL_ATTEMPTS;
    if (extensionGranted) {
      grantedExtensions += 1;
      attemptLimit += 1;
    }
    previousSignature = signature;
    attempts.push(
      recordAttempt({
        attempt: attempts.length + 1,
        locator: selected,
        replacement,
        diagnostics,
        outcome: check.ok ? "tests" : "tsc",
        finishReason: response.finishReason,
        extensionGranted,
        edits: selectionMode === "replace" ? editCount : undefined,
        appliedEdits: selectionMode === "replace" ? appliedEdits : undefined,
      }),
    );
    messages = buildRetryMessages(selectionMode, targetPath, failedAttempt, diagnostics);
  }

  return {
    ok: false,
    mode: selectionMode,
    locator: selected,
    filePath: targetPath,
    editedSource: null,
    attempts,
    diagnostics,
    explanation: await explain(options.provider, messages, temperature),
    messages,
    skipped,
    extensions: grantedExtensions,
  };
}
