import { resolveEditDslReply } from "./edit-dsl";
import type { EditDslDeps, EditDslFailure, EditDslRegion, EditDslViewer } from "./edit-dsl";
import type { EditRange } from "./loop";
import { resolveLocalRename } from "./rename";
import { END_OF_LINE_COLUMN } from "./selection";
import type { EditStatement, FileStatement, RenameSpec, Selection } from "./selection";
import type { Locator } from "./utility";

/** One line of a `read` result, numbered exactly like the other prompt blocks. */
export interface MultiEditorLine {
  line: number;
  text: string;
}

/** One resolved `read` command. */
export interface MultiEditorRead {
  index: number;
  path: string;
  ranges: EditRange[] | null;
  lines: MultiEditorLine[];
}

/** A queued `create`/`delete` mutation (applied by the loop after all guards). */
export interface MultiEditorFileMutation {
  index: number;
  path: string;
}

export interface MultiEditorResolution {
  regions: EditDslRegion[];
  viewers: EditDslViewer[];
  failures: EditDslFailure[];
  creates: MultiEditorFileMutation[];
  deletes: MultiEditorFileMutation[];
  reads: MultiEditorRead[];
}

/** Render `read` results for the next prompt; read commands never write. */
export function renderReadFeedback(reads: readonly MultiEditorRead[]): string {
  const lines = ["Read results (read commands write nothing):"];
  for (const read of reads) {
    const label = read.ranges === null ? "whole file" : "selected lines";
    lines.push("", `${read.path} (${label}):`, "```text");
    if (read.lines.length === 0) {
      lines.push("(empty file)");
    } else {
      const width = String(read.lines.at(-1)?.line ?? 0).length;
      for (const line of read.lines) {
        lines.push(`${String(line.line).padStart(width)} | ${line.text}`);
      }
    }
    lines.push("```");
  }
  return lines.join("\n");
}

export interface MultiEditorDeps extends EditDslDeps {
  /** Whether the path is a regular file (or, for a create, absent). */
  fileExists: (path: string) => boolean;
  /** Whether the path is inside the workspace and safe to touch. */
  isSafePath: (path: string) => boolean;
}

function syntheticLocator(path: string): Locator {
  return { path, name: "", kind: "" };
}

function fsFailure(
  index: number,
  path: string,
  stage: "address" | "range",
  detail: string,
): EditDslFailure {
  return {
    index,
    path,
    locator: syntheticLocator(path),
    stage,
    cause: null,
    diagnostics: `stage: ${stage}\n${detail}`,
    undeclaredName: null,
  };
}

function renameFailure(
  index: number,
  path: string,
  locator: Locator,
  detail: string,
): EditDslFailure {
  return {
    index,
    path,
    locator,
    stage: "address",
    cause: null,
    diagnostics: detail.startsWith("stage:") ? detail : `stage: address\n${detail}`,
    undeclaredName: null,
  };
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n" && index + 1 < source.length) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineEnd(source: string, starts: readonly number[], line: number): number {
  const start = starts[line - 1];
  if (start === undefined) {
    return source.length;
  }
  const newline = source.indexOf("\n", start);
  return newline === -1 ? source.length : newline;
}

function lineLength(source: string, starts: readonly number[], line: number): number {
  return lineEnd(source, starts, line) - (starts[line - 1] ?? 0);
}

interface ResolvedRange {
  start: number;
  end: number;
}

function resolveRange(
  source: string,
  starts: readonly number[],
  range: EditRange,
): ResolvedRange | string {
  const lineCount = starts.length;
  if (range.line < 1 || range.line > lineCount) {
    return `line ${range.line} is outside the file's ${lineCount} line(s)`;
  }
  if (range.endLine < 1 || range.endLine > lineCount) {
    return `end line ${range.endLine} is outside the file's ${lineCount} line(s)`;
  }
  const startLineStart = starts[range.line - 1] ?? 0;
  const startLength = lineLength(source, starts, range.line);
  if (range.column < 1 || range.column > startLength + 1) {
    return `column ${range.column} is outside line ${range.line}`;
  }
  const start = startLineStart + range.column - 1;

  const endLineStart = starts[range.endLine - 1] ?? 0;
  let end: number;
  if (range.endColumn === END_OF_LINE_COLUMN) {
    end = lineEnd(source, starts, range.endLine);
  } else {
    const endLength = lineLength(source, starts, range.endLine);
    if (range.endColumn < 1 || range.endColumn > endLength + 1) {
      return `end column ${range.endColumn} is outside line ${range.endLine}`;
    }
    end = endLineStart + range.endColumn;
  }
  if (end < start) {
    return `the range ends before it starts (${range.line}:${range.column}-${range.endLine}:${range.endColumn})`;
  }
  return { start, end };
}

function resolveRanges(source: string, ranges: readonly EditRange[]): ResolvedRange[] | string {
  const starts = lineStarts(source);
  const resolved: ResolvedRange[] = [];
  for (const range of ranges) {
    const part = resolveRange(source, starts, range);
    if (typeof part === "string") {
      return part;
    }
    resolved.push(part);
  }
  const ordered = [...resolved].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      return "the selected ranges overlap";
    }
  }
  return ordered;
}

function readLines(
  source: string,
  ranges: readonly EditRange[] | null,
): MultiEditorLine[] | string {
  const starts = lineStarts(source);
  const lineCount = starts.length;
  const wanted = new Set<number>();
  if (ranges === null) {
    for (let line = 1; line <= lineCount; line += 1) {
      wanted.add(line);
    }
  } else {
    for (const range of ranges) {
      if (
        range.line < 1 ||
        range.line > lineCount ||
        range.endLine < 1 ||
        range.endLine > lineCount
      ) {
        return `the read range ${range.line}-${range.endLine} is outside the file's ${lineCount} line(s)`;
      }
      for (let line = range.line; line <= range.endLine; line += 1) {
        wanted.add(line);
      }
    }
  }
  const lines: MultiEditorLine[] = [];
  for (const line of [...wanted].sort((left, right) => left - right)) {
    const start = starts[line - 1] ?? 0;
    const end = lineEnd(source, starts, line);
    lines.push({ line, text: source.slice(start, end).replace(/\r$/, "") });
  }
  if (source === "") {
    return [];
  }
  return lines;
}

function conflictFailure(index: number, path: string, detail: string): EditDslFailure {
  return {
    index,
    path,
    locator: syntheticLocator(path),
    stage: "duplicate",
    cause: null,
    diagnostics: `stage: duplicate\n${detail}`,
    undeclaredName: null,
  };
}

/**
 * Resolve a `multiEditor` reply. Editors go through the existing cascade; file
 * commands are validated against the pre-reply snapshot (a `read` always sees
 * the source as it was before this reply). The loop applies all returned
 * regions and mutations atomically.
 */
export function resolveMultiEditor(
  statements: readonly EditStatement[],
  deps: MultiEditorDeps,
): MultiEditorResolution {
  const editors: Selection[] = [];
  const editorIndices: number[] = [];
  const renames: { selection: Selection & { rename: RenameSpec }; index: number }[] = [];
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (statement?.type === "editor") {
      const selection = statement.selection;
      if (selection.rename !== undefined && selection.rename !== null) {
        renames.push({ selection: { ...selection, rename: selection.rename }, index });
      } else {
        editors.push(selection);
        editorIndices.push(index);
      }
    }
  }
  const editorResolution = resolveEditDslReply(editors, deps, editorIndices);

  const regions = [...editorResolution.regions];
  const viewers = [...editorResolution.viewers];
  const failures = [...editorResolution.failures];
  const creates: MultiEditorFileMutation[] = [];
  const deletes: MultiEditorFileMutation[] = [];
  const reads: MultiEditorRead[] = [];

  // Renames are semantic, not matcher edits: resolve each against its file's
  // current source with the local-scope engine. A rename never produces a
  // viewer; either its whole edit list becomes regions or it fails at address.
  for (const { selection, index } of renames) {
    const path = selection.locator.path;
    if (!deps.isSafePath(path)) {
      failures.push(
        renameFailure(
          index,
          path,
          selection.locator,
          `the path ${JSON.stringify(path)} is outside the editable workspace`,
        ),
      );
      continue;
    }
    if (!deps.fileExists(path)) {
      failures.push(
        renameFailure(
          index,
          path,
          selection.locator,
          `cannot rename ${JSON.stringify(selection.locator.name)} in ${JSON.stringify(path)}: the file does not exist`,
        ),
      );
      continue;
    }
    let source: string;
    try {
      source = deps.sourceFor(path);
    } catch (error) {
      failures.push(
        renameFailure(
          index,
          path,
          selection.locator,
          `cannot read ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      continue;
    }
    const renamed = resolveLocalRename(source, path, selection.locator, selection.rename, {
      space: selection.space,
    });
    if (!renamed.ok) {
      failures.push(renameFailure(index, path, selection.locator, renamed.diagnostics));
      continue;
    }
    for (const edit of renamed.edits) {
      regions.push({
        index,
        path,
        locator: selection.locator,
        start: edit.start,
        end: edit.end,
        text: edit.text,
        stage: "whole-symbol",
        matcherKind: null,
        create: false,
      });
    }
  }

  // A delete cannot coexist with any other operation on the same path in one
  // reply; a create and a write/editor on one path are likewise ambiguous.
  const destructive = new Map<string, number>();
  const created = new Map<string, number>();
  const touched = new Map<string, number>();
  for (const region of regions) {
    touched.set(region.path, region.index);
  }

  const checkMutation = (index: number, path: string, op: "create" | "delete"): string | null => {
    if (!deps.isSafePath(path)) {
      return `the path ${JSON.stringify(path)} is outside the editable workspace`;
    }
    if (op === "create" && deps.fileExists(path)) {
      return `cannot create ${JSON.stringify(path)}: the file already exists`;
    }
    if (op === "delete" && !deps.fileExists(path)) {
      return `cannot delete ${JSON.stringify(path)}: the file does not exist`;
    }
    return null;
  };

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (statement?.type !== "fs") {
      continue;
    }
    const fs: FileStatement = statement.statement;
    switch (fs.op) {
      case "create": {
        const problem = checkMutation(index, fs.path, "create");
        if (problem !== null) {
          failures.push(fsFailure(index, fs.path, "address", problem));
          continue;
        }
        const earlier = created.get(fs.path);
        if (earlier !== undefined) {
          failures.push(
            conflictFailure(
              index,
              fs.path,
              `statements ${earlier + 1} and ${index + 1} both create ${JSON.stringify(fs.path)}; create a file once per reply`,
            ),
          );
          continue;
        }
        if (touched.has(fs.path)) {
          failures.push(
            conflictFailure(
              index,
              fs.path,
              `create ${JSON.stringify(fs.path)} conflicts with another statement that writes the same path in this reply`,
            ),
          );
          continue;
        }
        created.set(fs.path, index);
        creates.push({ index, path: fs.path });
        continue;
      }
      case "delete": {
        const problem = checkMutation(index, fs.path, "delete");
        if (problem !== null) {
          failures.push(fsFailure(index, fs.path, "address", problem));
          continue;
        }
        const earlier = destructive.get(fs.path);
        if (earlier !== undefined) {
          failures.push(
            conflictFailure(
              index,
              fs.path,
              `statements ${earlier + 1} and ${index + 1} both delete ${JSON.stringify(fs.path)}; delete a file once per reply`,
            ),
          );
          continue;
        }
        if (touched.has(fs.path)) {
          failures.push(
            conflictFailure(
              index,
              fs.path,
              `delete ${JSON.stringify(fs.path)} conflicts with another statement that writes the same path in this reply`,
            ),
          );
          continue;
        }
        destructive.set(fs.path, index);
        deletes.push({ index, path: fs.path });
        continue;
      }
      case "read": {
        if (!deps.isSafePath(fs.path)) {
          failures.push(
            fsFailure(
              index,
              fs.path,
              "address",
              `the path ${JSON.stringify(fs.path)} is outside the workspace`,
            ),
          );
          continue;
        }
        if (!deps.fileExists(fs.path)) {
          failures.push(
            fsFailure(
              index,
              fs.path,
              "address",
              `cannot read ${JSON.stringify(fs.path)}: the file does not exist`,
            ),
          );
          continue;
        }
        const source = deps.sourceFor(fs.path);
        const lines = readLines(source, fs.ranges);
        if (typeof lines === "string") {
          failures.push(fsFailure(index, fs.path, "range", lines));
          continue;
        }
        reads.push({ index, path: fs.path, ranges: fs.ranges, lines });
        continue;
      }
      case "write": {
        if (!deps.isSafePath(fs.path)) {
          failures.push(
            fsFailure(
              index,
              fs.path,
              "address",
              `the path ${JSON.stringify(fs.path)} is outside the editable workspace`,
            ),
          );
          continue;
        }
        if (destructive.has(fs.path) || created.has(fs.path)) {
          failures.push(
            conflictFailure(
              index,
              fs.path,
              `write ${JSON.stringify(fs.path)} conflicts with a create/delete of the same path in this reply`,
            ),
          );
          continue;
        }
        const source = deps.sourceFor(fs.path);
        const targetRanges =
          fs.ranges === null
            ? [{ line: 1, column: 1, endLine: 1, endColumn: END_OF_LINE_COLUMN }]
            : fs.ranges;
        // Whole-file writes use the entire source, including a missing file.
        const resolved =
          fs.ranges === null
            ? [{ start: 0, end: source.length }]
            : resolveRanges(source, targetRanges);
        if (typeof resolved === "string") {
          failures.push(fsFailure(index, fs.path, "range", resolved));
          continue;
        }
        for (const part of resolved) {
          regions.push({
            index,
            path: fs.path,
            locator: syntheticLocator(fs.path),
            start: part.start,
            end: part.end,
            text: fs.replacement,
            stage: "whole-symbol",
            matcherKind: null,
            create: false,
          });
        }
        touched.set(fs.path, index);
        continue;
      }
    }
  }

  return { regions, viewers, failures, creates, deletes, reads };
}
