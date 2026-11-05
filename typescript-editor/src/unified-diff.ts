/**
 * A small, dependency-free unified diff renderer for the `tsed` dry-run
 * preview. It compares two in-memory sources line by line and never touches
 * the filesystem or spawns a child process.
 */

export interface UnifiedDiffOptions {
  /** Workspace-relative path used in the `a/` and `b/` headers. */
  path: string;
  /** The pre-reply source; pass "" when the file does not exist yet. */
  oldSource: string;
  /** The planned source; pass "" when the file is deleted. */
  newSource: string;
  /** The old side is absent (a create), so its header is `/dev/null`. */
  oldMissing?: boolean;
  /** The new side is absent (a delete), so its header is `/dev/null`. */
  newMissing?: boolean;
  /** Unchanged lines shown around each change. Defaults to 3. */
  context?: number;
}

interface SourceLine {
  text: string;
  noNewline: boolean;
}

type DiffKind = "equal" | "delete" | "insert";

interface DiffOp {
  kind: DiffKind;
  line: SourceLine;
}

function splitSource(source: string): SourceLine[] {
  if (source === "") {
    return [];
  }
  const lines: SourceLine[] = [];
  let start = 0;
  for (;;) {
    const newline = source.indexOf("\n", start);
    if (newline === -1) {
      lines.push({ text: source.slice(start), noNewline: true });
      break;
    }
    lines.push({ text: source.slice(start, newline), noNewline: false });
    start = newline + 1;
    if (start === source.length) {
      break;
    }
  }
  return lines;
}

function sameLine(left: SourceLine, right: SourceLine): boolean {
  return left.text === right.text && left.noNewline === right.noNewline;
}

/** Myers' O((N + M)D) line diff, returning one operation per old/new line. */
function diffLines(oldLines: readonly SourceLine[], newLines: readonly SourceLine[]): DiffOp[] {
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  if (oldCount === 0) {
    return newLines.map((line) => ({ kind: "insert", line }));
  }
  if (newCount === 0) {
    return oldLines.map((line) => ({ kind: "delete", line }));
  }

  const furthest = new Map<number, number>();
  furthest.set(1, 0);
  const trace: Map<number, number>[] = [];
  let depth = 0;
  let found = false;
  for (let d = 0; d <= oldCount + newCount && !found; d += 1) {
    trace.push(new Map(furthest));
    for (let k = -d; k <= d; k += 2) {
      const down = furthest.get(k + 1) ?? -Infinity;
      const right = furthest.get(k - 1) ?? -Infinity;
      let x: number;
      if (k === -d || (k !== d && right < down)) {
        x = furthest.get(k + 1) ?? 0;
      } else {
        x = (furthest.get(k - 1) ?? 0) + 1;
      }
      let y = x - k;
      while (x < oldCount && y < newCount) {
        const oldLine = oldLines[x];
        const newLine = newLines[y];
        if (oldLine === undefined || newLine === undefined || !sameLine(oldLine, newLine)) {
          break;
        }
        x += 1;
        y += 1;
      }
      furthest.set(k, x);
      if (x >= oldCount && y >= newCount) {
        depth = d;
        found = true;
        break;
      }
    }
  }

  const reversed: DiffOp[] = [];
  let x = oldCount;
  let y = newCount;
  for (let d = depth; d > 0; d -= 1) {
    const previous = trace[d];
    if (previous === undefined) {
      break;
    }
    const k = x - y;
    const down = previous.get(k + 1) ?? -Infinity;
    const right = previous.get(k - 1) ?? -Infinity;
    const previousK = k === -d || (k !== d && right < down) ? k + 1 : k - 1;
    const previousX = previous.get(previousK) ?? 0;
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      const oldLine = oldLines[x - 1];
      if (oldLine === undefined) {
        break;
      }
      reversed.push({ kind: "equal", line: oldLine });
      x -= 1;
      y -= 1;
    }
    if (x === previousX) {
      const newLine = newLines[y - 1];
      if (newLine !== undefined) {
        reversed.push({ kind: "insert", line: newLine });
      }
      y -= 1;
    } else {
      const oldLine = oldLines[x - 1];
      if (oldLine !== undefined) {
        reversed.push({ kind: "delete", line: oldLine });
      }
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    const oldLine = oldLines[x - 1];
    if (oldLine !== undefined) {
      reversed.push({ kind: "equal", line: oldLine });
    }
    x -= 1;
    y -= 1;
  }
  return reversed.reverse();
}

function formatRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function renderHunk(
  ops: readonly DiffOp[],
  start: number,
  end: number,
  oldBefore: readonly number[],
  newBefore: readonly number[],
): string {
  const oldBase = oldBefore[start] ?? 0;
  const newBase = newBefore[start] ?? 0;
  const oldCount = (oldBefore[end] ?? 0) - oldBase;
  const newCount = (newBefore[end] ?? 0) - newBase;
  const oldStart = oldCount === 0 ? oldBase : oldBase + 1;
  const newStart = newCount === 0 ? newBase : newBase + 1;
  let text = `@@ -${formatRange(oldStart, oldCount)} +${formatRange(newStart, newCount)} @@\n`;
  for (let index = start; index < end; index += 1) {
    const op = ops[index];
    if (op === undefined) {
      continue;
    }
    const prefix = op.kind === "equal" ? " " : op.kind === "delete" ? "-" : "+";
    text += `${prefix}${op.line.text}\n`;
    if (op.line.noNewline) {
      text += "\\ No newline at end of file\n";
    }
  }
  return text;
}

function renderHunks(ops: readonly DiffOp[], context: number): string {
  const changes: number[] = [];
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index]?.kind !== "equal") {
      changes.push(index);
    }
  }
  if (changes.length === 0) {
    return "";
  }

  const oldBefore: number[] = [0];
  const newBefore: number[] = [0];
  for (const op of ops) {
    oldBefore.push((oldBefore[oldBefore.length - 1] ?? 0) + (op.kind === "insert" ? 0 : 1));
    newBefore.push((newBefore[newBefore.length - 1] ?? 0) + (op.kind === "delete" ? 0 : 1));
  }

  const ranges: { start: number; end: number }[] = [];
  for (const index of changes) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  let text = "";
  for (const range of ranges) {
    text += renderHunk(ops, range.start, range.end, oldBefore, newBefore);
  }
  return text;
}

/**
 * Render a standard unified diff for one file. Returns `""` when the sources
 * are identical; a created or deleted file uses `/dev/null` for the missing
 * side. Hunk headers omit the `,1` shorthand the way GNU diff does.
 */
export function unifiedDiff(options: UnifiedDiffOptions): string {
  const ops = diffLines(splitSource(options.oldSource), splitSource(options.newSource));
  const hunks = renderHunks(ops, Math.max(0, options.context ?? 3));
  if (hunks === "") {
    return "";
  }
  const oldHeader = options.oldMissing === true ? "/dev/null" : `a/${options.path}`;
  const newHeader = options.newMissing === true ? "/dev/null" : `b/${options.path}`;
  return `--- ${oldHeader}\n+++ ${newHeader}\n${hunks}`;
}
