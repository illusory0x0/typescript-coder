export const SPEC_FILE_LIMIT = 8000;

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
export type RangeResolutionFailure = "out-of-bounds" | "outside-declaration" | "empty";

export type RangeResolution =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: RangeResolutionFailure; detail: string };

// Resolve one 1-based inclusive `(line,column)` range (#72) against the current
// source block shown in the prompt: `base`/`limit` bound that block and
// `declaration` is the absolute span the range must sit inside. Resolution
// depends on those bounds, not on the total size of the source file. The
// reported span is half-open (`[start, end)`) for the splice.
export function resolveEditRange(
  source: string,
  range: EditRange,
  base: number,
  limit: number,
  declaration: { start: number; end: number },
): RangeResolution {
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
