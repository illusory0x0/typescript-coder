import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyEdits, formatSource } from "./editor";
import { buildIndexTolerant, findDefinition } from "./utility";
import { buildSignatureView } from "./scroll";
import { checkTool, testTool } from "./tools";
import type { ChatMessage, ChatResponse, ToolDefinition } from "./openai";
import type { CheckDiagnostic, CommandResult } from "./tools";
import type { IndexEntry, Locator, SkippedFile, SourceFile, TolerantIndex } from "./utility";

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist"]);
const CONTEXT_SYMBOL_LIMIT = 500;
const SIGNATURE_LIMIT = 200;

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
      const signature = buildSignatureView(source, entry.locator, file.path);
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
    "Then you will be asked to output the COMPLETE replacement text for the selected symbol. Keep the same declaration kind and name unless the task requires otherwise. No markdown fences and no explanations.",
    "",
    "The selected symbol may not exist yet. When it is missing, the harness appends your complete output to the target file (creating the file and any parent directories when needed) instead of replacing a symbol range.",
    "",
  ].join("\n");
}

export function buildUserPrompt(issue: string, contextYaml: string): string {
  const body = contextYaml === "" || contextYaml.endsWith("\n") ? contextYaml : `${contextYaml}\n`;
  return `# Issue\n\n${issue}\n\n# Project context\n\n\`\`\`yaml\n${body}\`\`\`\n`;
}

export function buildReplacementPrompt(locatorJson: string, symbolSource: string): string {
  const body = symbolSource.endsWith("\n") ? symbolSource : `${symbolSource}\n`;
  return `Output the COMPLETE replacement text for the symbol identified by this locator, with no markdown fences and no explanations.

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

export function buildDiagnosticsPrompt(diagnostics: string): string {
  return `The previous replacement failed verification.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`

Output a corrected COMPLETE replacement for the selected symbol, with no markdown fences and no explanations.
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

export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 6 || !trimmed.startsWith("```") || !trimmed.endsWith("```")) {
    return trimmed;
  }
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) {
    return trimmed;
  }
  const inner = trimmed.slice(firstNewline + 1);
  if (!inner.endsWith("```")) {
    return trimmed;
  }
  return inner.slice(0, -3).trim();
}

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
    options?: { temperature?: number },
  ): Promise<ChatResponse>;
}

export interface LoopOptions {
  cwd: string;
  issue: string;
  model: string;
  provider: ProviderLike;
  maxRetries?: number;
  temperature?: number;
  checkCommand?: string[];
  testCommand?: string[];
  commandTimeoutMs?: number;
}

export interface LoopAttempt {
  attempt: number;
  locator: Locator;
  replacement: string | null;
  diagnostics: string | null;
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
}

type Selection =
  | { mode: "replace"; locator: Locator; entry: IndexEntry }
  | { mode: "append"; locator: Locator; path: string };

const EMPTY_LOCATOR: Locator = { path: "", name: "", kind: "" };
const DIAGNOSTICS_LIMIT = 4000;
const EXPLANATION_PROMPT =
  "Explain in one short paragraph why the task could not be completed and what the next step for the planner is. Do not output code.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  if (
    directories.some(
      (segment) => segment.startsWith(".") || SKIPPED_DIRECTORIES.has(segment),
    )
  ) {
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

function restoreTarget(cwd: string, path: string, original: string | null): void {
  const target = join(cwd, path);
  if (original === null) {
    rmSync(target, { force: true });
    return;
  }
  writeFileSync(target, original);
}

function formatDiagnostics(
  check: CommandResult & { diagnostics: CheckDiagnostic[] },
  test: CommandResult,
): string {
  const lines: string[] = [];
  for (const diagnostic of check.diagnostics) {
    if (diagnostic.file === "") {
      lines.push(diagnostic.message);
    } else {
      lines.push(
        `${diagnostic.file}(${diagnostic.line},${diagnostic.column}): ${diagnostic.message}`,
      );
    }
  }
  if (lines.length === 0 && !check.ok) {
    lines.push(check.output.trim());
  }
  if (!test.ok) {
    lines.push("tests failed:");
    lines.push(test.output.trim());
  }
  const text = lines.filter((line) => line !== "").join("\n");
  if (text.length <= DIAGNOSTICS_LIMIT) {
    return text;
  }
  return text.slice(text.length - DIAGNOSTICS_LIMIT);
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

export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const maxRetries = options.maxRetries ?? 3;
  const temperature = options.temperature;
  const chatOptions = temperature === undefined ? undefined : { temperature };
  const cwd = options.cwd;
  const files = discoverSourceFiles(cwd);
  const build = buildIndexTolerant(files);
  const contextYaml = buildContextYaml(files, build);
  const index = build.index;
  const skipped = build.skipped;
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserPrompt(options.issue, contextYaml) },
  ];
  const attempts: LoopAttempt[] = [];

  let selection: Selection | null = null;
  let selectionFailures = 0;
  while (selectionFailures < maxRetries) {
    let response: ChatResponse;
    try {
      response = await options.provider.chat(messages, undefined, chatOptions);
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
      attempts.push({
        attempt: attempts.length + 1,
        locator: candidate ?? EMPTY_LOCATOR,
        replacement: null,
        diagnostics: diagnostic,
      });
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
    };
  }

  const selected = selection.locator;
  const locatorJson = JSON.stringify(selected);
  let targetPath: string;
  let original: string | null;
  messages.push({ role: "assistant", content: locatorJson });
  if (selection.mode === "replace") {
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

  let diagnostics: string | null = null;
  for (let editAttempt = 0; editAttempt < maxRetries; editAttempt += 1) {
    let response: ChatResponse;
    try {
      response = await options.provider.chat(messages, undefined, chatOptions);
    } catch (error) {
      // A previous attempt that failed verification ran restoreTarget before this
      // chat call, so no uncommitted edit remains on disk at this point.
      return {
        ok: false,
        mode: selection.mode,
        locator: selected,
        filePath: targetPath,
        editedSource: null,
        attempts,
        diagnostics: `provider error: ${errorMessage(error)}`,
        explanation: await explain(options.provider, messages, temperature),
        messages,
        skipped,
      };
    }
    let replacement: string | null = null;
    let newSource: string | null = null;
    let failure: string | null = null;
    try {
      replacement = parseReplacementResponse(response.content ?? "");
    } catch (error) {
      failure = errorMessage(error);
    }
    if (replacement !== null) {
      try {
        if (selection.mode === "append") {
          newSource = await formatSource(targetPath, appendText(baseSource, replacement));
        } else {
          newSource = await applyEdits(
            baseSource,
            [{ locator: selected, llmOutput: replacement }],
            targetPath,
          );
        }
      } catch (error) {
        failure = errorMessage(error);
      }
    }
    if (newSource === null || replacement === null) {
      diagnostics = failure ?? "model did not return replacement text";
      attempts.push({
        attempt: attempts.length + 1,
        locator: selected,
        replacement,
        diagnostics,
      });
      messages.push({ role: "assistant", content: replacement ?? response.content ?? "" });
      messages.push({ role: "user", content: buildDiagnosticsPrompt(diagnostics) });
      continue;
    }
    writeTarget(cwd, targetPath, newSource);
    const check = await checkTool(cwd, options.checkCommand, options.commandTimeoutMs);
    const test = await testTool(cwd, options.testCommand, options.commandTimeoutMs);
    if (check.ok && test.ok) {
      attempts.push({
        attempt: attempts.length + 1,
        locator: selected,
        replacement,
        diagnostics: null,
      });
      return {
        ok: true,
        mode: selection.mode,
        locator: selected,
        filePath: targetPath,
        editedSource: newSource,
        attempts,
        diagnostics: null,
        explanation: null,
        messages,
        skipped,
      };
    }
    restoreTarget(cwd, targetPath, original);
    diagnostics = formatDiagnostics(check, test);
    attempts.push({
      attempt: attempts.length + 1,
      locator: selected,
      replacement,
      diagnostics,
    });
    messages.push({ role: "assistant", content: replacement });
    messages.push({ role: "user", content: buildDiagnosticsPrompt(diagnostics) });
  }

  return {
    ok: false,
    mode: selection.mode,
    locator: selected,
    filePath: targetPath,
    editedSource: null,
    attempts,
    diagnostics,
    explanation: await explain(options.provider, messages, temperature),
    messages,
    skipped,
  };
}
