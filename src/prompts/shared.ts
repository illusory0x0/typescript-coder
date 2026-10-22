import { markerGutter } from "../edit-dsl";
import type { SourceFile } from "../utility";

export const SPEC_FILE_LIMIT = 8000;
/** Cap on the symbol lines emitted by the YAML context and edit-dsl index. */
export const CONTEXT_SYMBOL_LIMIT = 500;
export const TEST_FILE_SUFFIX = ".test.ts";
/** Bound on the carried re-approach statement (#75); clamped like the digest states. */
export const APPROACH_LIMIT = 600;
export const MAX_EDIT_EXCHANGES = 3;

// Opt-in multi-payload protocol (#69): appended to the system prompt when the
// variant is enabled, so the default prompt stays byte-identical.
export const MULTI_PAYLOAD_SYSTEM_PARAGRAPH =
  'The multi-payload protocol is enabled: one edit reply may instead carry several edits as {"payloads": [{"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}, ...]} — different files and/or several non-overlapping regions of one file. The first entry echoes the pinned selection exactly, and every other entry names its own declaration (it must resolve uniquely in its file). Same-file entries must address non-overlapping regions; overlapping regions reject the exchange. The exchange applies atomically: if any entry fails its own guard or two same-file entries overlap, nothing is written and the exchange is rejected naming every failing entry\'s cause. A single edit may still be sent as one flat object, and "create"/"delete" selections never batch.';

/** Assemble the system prompt from one protocol's four teaching paragraphs. */
export function assembleSystemPrompt(
  paragraphs: {
    select: string;
    edit: string;
    createDelete: string;
    rounds: string;
  },
  multiPayload: boolean,
): string {
  const lines = [
    "You are a TypeScript coding agent.",
    "",
    paragraphs.select,
    "",
    paragraphs.edit,
    "",
    paragraphs.createDelete,
    "",
    paragraphs.rounds,
    "",
  ];
  if (multiPayload) {
    lines.splice(lines.length - 1, 0, MULTI_PAYLOAD_SYSTEM_PARAGRAPH, "");
  }
  return lines.join("\n");
}

// The optional `(line,column)` selector offered alongside `matcher` (#72).
export const RANGE_SELECTOR_NOTE =
  'Optionally locate the span by its 1-based inclusive "range" ({line, column, endLine, endColumn}) copied from the numbered current-source lines; when both are sent "range" takes precedence over "matcher".';

// The bounded self-verification offer, added only to repair prompts (#73); the
// fresh post-pick edit prompt never carries it, so the no-repair path is
// byte-identical.
export const SELF_CHECK_OFFER =
  'Before editing, you may make at most one bounded self-verification request this round: reply with exactly {"request":"read"} (the pinned file\'s current source), {"request":"check"} (run the task\'s check command), or {"request":"test"} (run the task\'s test command); the harness runs it and returns a bounded result, then asks again.';

// Keep the head (declarations and early cases) and the tail (final assertions,
// or the current source of the edited region) of an oversized source with an
// explicit marker in between.
export function truncateSource(source: string): string {
  if (source.length <= SPEC_FILE_LIMIT) {
    return source;
  }
  const half = SPEC_FILE_LIMIT / 2;
  const head = source.slice(0, half);
  const tail = source.slice(source.length - half);
  const truncated = source.length - SPEC_FILE_LIMIT;
  return `${head}\n// ... [truncated ${truncated} characters] ...\n${tail}`;
}

export function buildSpecSection(specFiles: readonly SourceFile[]): string {
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

export function appendSpecSection(prompt: string, specFiles: readonly SourceFile[]): string {
  if (specFiles.length === 0) {
    return prompt;
  }
  return `${prompt}\n${buildSpecSection(specFiles)}\n`;
}

// Split a source into lines for rendering (a trailing newline does not add an
// empty final line, so an empty source has no lines).
export function splitSourceLines(source: string): string[] {
  const lines = source.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

// Render the current-source block with 1-based line numbers so the optional
// `range` selector (#72) can be derived from the prompt. Columns count the
// source text after the `N | ` prefix.
export function numberedSourceBlock(source: string): string {
  const lines = splitSourceLines(source);
  const width = String(lines.length).length;
  return lines
    .map((line, index) => `${String(index + 1).padStart(width, " ")} | ${line}`)
    .join("\n");
}

// Render `source` with its file-absolute line numbers. `marked` is the set of
// file-absolute lines intersected by a matched span; when it is null the output
// carries no gutter at all (the bare viewer path), otherwise every line gets the
// shared `⁉️  `/blank gutter.
export function numberLinesFrom(
  source: string,
  startLine: number,
  marked: ReadonlySet<number> | null = null,
): string {
  const lines = splitSourceLines(source);
  if (lines.length === 0) {
    return "";
  }
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, index) => {
      const lineNumber = startLine + index;
      const gutter = marked === null ? "" : markerGutter(marked.has(lineNumber));
      return `${gutter}${String(lineNumber).padStart(width, " ")} | ${line}`;
    })
    .join("\n");
}

// Render the declaration range with its FILE-absolute 1-based line numbers.
export function numberedSourceRange(source: string, start: number, end: number): string {
  const safeStart = Math.max(0, Math.min(start, source.length));
  const safeEnd = Math.max(safeStart, Math.min(end, source.length));
  const startLine = source.slice(0, safeStart).split("\n").length;
  return numberLinesFrom(source.slice(safeStart, safeEnd), startLine);
}
