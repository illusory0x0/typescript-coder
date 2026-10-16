import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { applyEdits } from "./editor";
import { buildIndex, findDefinition } from "./utility";
import { buildSignatureView } from "./scroll";
import { checkTool, testTool } from "./tools";
import type { ChatMessage, ChatResponse, ToolDefinition } from "./openai";
import type { CheckDiagnostic, CommandResult } from "./tools";
import type { IndexEntry, Locator, SourceFile } from "./utility";

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

export function buildContextYaml(files: SourceFile[]): string {
  const index = buildIndex(files);
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

export function buildDiagnosticsPrompt(diagnostics: string): string {
  return `The previous replacement failed verification.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`

Output a corrected COMPLETE replacement for the selected symbol, with no markdown fences and no explanations.
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
  tools?: ToolDefinition[];
  checkCommand?: string[];
  testCommand?: string[];
}

export interface LoopAttempt {
  attempt: number;
  locator: Locator;
  replacement: string | null;
  diagnostics: string | null;
}

export interface LoopResult {
  ok: boolean;
  locator: Locator | null;
  filePath: string | null;
  editedSource: string | null;
  attempts: LoopAttempt[];
  diagnostics: string | null;
  explanation: string | null;
  messages: ChatMessage[];
}

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
  tools: ToolDefinition[] | undefined,
  temperature: number | undefined,
): Promise<string> {
  messages.push({ role: "user", content: EXPLANATION_PROMPT });
  const options = temperature === undefined ? undefined : { temperature };
  const response = await provider.chat(messages, tools, options);
  const text = stripCodeFences(response.content ?? "");
  return text === "" ? "the model did not provide an explanation" : text;
}

export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const maxRetries = options.maxRetries ?? 3;
  const temperature = options.temperature;
  const chatOptions = temperature === undefined ? undefined : { temperature };
  const cwd = options.cwd;
  const files = discoverSourceFiles(cwd);
  const contextYaml = buildContextYaml(files);
  const index = buildIndex(files);
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserPrompt(options.issue, contextYaml) },
  ];
  const attempts: LoopAttempt[] = [];

  let locator: Locator | null = null;
  let entry: IndexEntry | null = null;
  let selectionFailures = 0;
  while (selectionFailures < maxRetries) {
    const response = await options.provider.chat(messages, options.tools, chatOptions);
    let candidate: Locator | null = null;
    let resolved: IndexEntry | null = null;
    let diagnostic: string | null = null;
    try {
      candidate = locatorFromResponse(response);
    } catch (error) {
      diagnostic = `invalid locator: ${errorMessage(error)}`;
    }
    if (candidate !== null && diagnostic === null) {
      resolved = findDefinition(index, candidate);
      if (resolved === null) {
        diagnostic = `invalid locator: no symbol ${candidate.kind} ${candidate.name} in ${candidate.path}`;
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
      messages.push({ role: "user", content: buildDiagnosticsPrompt(diagnostic) });
      continue;
    }
    if (candidate !== null) {
      locator = candidate;
      entry = resolved;
    }
    break;
  }

  if (locator === null || entry === null) {
    return {
      ok: false,
      locator: null,
      filePath: null,
      editedSource: null,
      attempts,
      diagnostics: "could not select a symbol",
      explanation: await explain(options.provider, messages, options.tools, temperature),
      messages,
    };
  }

  const selected = locator;
  const selectedEntry = entry;
  const fileEntry = sourceFileFor(files, selected.path);
  const locatorJson = JSON.stringify(selected);
  const symbolSource = fileEntry.source.slice(selectedEntry.node.start, selectedEntry.node.end);
  messages.push({ role: "assistant", content: locatorJson });
  messages.push({ role: "user", content: buildReplacementPrompt(locatorJson, symbolSource) });

  let diagnostics: string | null = null;
  for (let editAttempt = 0; editAttempt < maxRetries; editAttempt += 1) {
    const response = await options.provider.chat(messages, options.tools, chatOptions);
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
        newSource = await applyEdits(
          fileEntry.source,
          [{ locator: selected, llmOutput: replacement }],
          selected.path,
        );
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
    writeFileSync(join(cwd, selected.path), newSource);
    const check = await checkTool(cwd, options.checkCommand);
    const test = await testTool(cwd, options.testCommand);
    if (check.ok && test.ok) {
      attempts.push({
        attempt: attempts.length + 1,
        locator: selected,
        replacement,
        diagnostics: null,
      });
      return {
        ok: true,
        locator: selected,
        filePath: selected.path,
        editedSource: newSource,
        attempts,
        diagnostics: null,
        explanation: null,
        messages,
      };
    }
    writeFileSync(join(cwd, selected.path), fileEntry.source);
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
    locator: selected,
    filePath: selected.path,
    editedSource: null,
    attempts,
    diagnostics,
    explanation: await explain(options.provider, messages, options.tools, temperature),
    messages,
  };
}
