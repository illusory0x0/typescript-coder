import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { buildIndex } from "./utility";
import { buildSignatureView } from "./scroll";
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

export function parseLocatorResponse(content: string): Locator {
  const text = stripCodeFences(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("model did not return a valid locator JSON");
  }
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

export function parseReplacementResponse(content: string): string {
  const text = stripCodeFences(content);
  if (text === "") {
    throw new Error("model did not return replacement text");
  }
  return text;
}
