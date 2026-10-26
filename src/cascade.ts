/**
 * The selection cascade resolver (#108) for the edit-dsl edit protocol
 * (`docs/edit-protocol.md` §3). `select` names the declaration (already
 * resolved into `entry`); `match` locates a candidate set inside it; `pick`
 * narrows that set (a point keeps containing candidates, a line/range keeps
 * contained ones) or, with no `match`, names the target text span; `replace`
 * rewrites the target. Each stage narrows the one before it, an omitted stage falls back to
 * the coarser result, and nothing is ever guessed: zero or several candidates
 * at the finest supplied stage fail with a typed cause.
 *
 * This module is additive: it is built alongside `resolveEntrySplice` and is not
 * wired into the JSON path, prompts, or the loop yet (#111 does that).
 */
import { findMatcherMatches, findRegexMatches } from "./matcher";
import { resolveEditRange } from "./loop";
import type { EditRange } from "./loop";
import { END_OF_LINE_COLUMN } from "./selection";
import type { Selection } from "./selection";
import type { IndexEntry } from "./utility";
import { memberDeletionRange } from "./utility";
import type { RangeResolutionFailure } from "./loop";

/** The finest stage that resolved a target. */
export type SelectionStage = "whole-symbol" | "match" | "pick";

/**
 * Typed rejection cause for a cascade clause. Mirrors `RejectionCause`'s
 * matcher/range/no-op members and adds `regex-invalid` for a malformed or
 * over-bounded `/regex/` matcher (`docs/edit-protocol.md` §3 and §5); the
 * address and syntax causes are owned by their own stages (`select` resolution
 * and parse).
 */
export type CascadeCause =
  | "matcher-unparseable"
  | "matcher-not-found"
  | "matcher-ambiguous"
  | "regex-invalid"
  | "range-invalid"
  | "no-op";

export type CascadeResolution =
  | {
      ok: true;
      /** Half-open offsets into `source`. */
      start: number;
      end: number;
      /** Replacement text; `""` for a viewer. */
      text: string;
      /** No `replace` clause: the clause reads and writes nothing. */
      viewer: boolean;
      /** The finest stage that resolved the target. */
      stage: SelectionStage;
      gateStart: number;
    }
  | { ok: false; cause: CascadeCause; diagnostics: string };

interface Span {
  start: number;
  end: number;
}

// #59: an edit whose replacement is byte-identical to the text it replaces
// cannot change anything. Mirrors `NOOP_DIAGNOSTICS` in `src/loop.ts`.
const NOOP_DIAGNOSTICS =
  "stage: no-op\nthe edit does not change the file: the replacement is identical to the text it replaces; change the code so the diagnostics are actually addressed";

// The leading-`export` tolerance (#48, #50), mirrored from `src/loop.ts`'s
// `precedingExportModifier`/`stripLeadingExport`: an indexed node range excludes
// a wrapping `export`, so a whole-declaration replacement that still carries it
// keeps exactly one copy; a body-level replacement is left untouched.
const EXPORT_PATTERN = /^export\s+/;
const EXPORT_DEFAULT_PATTERN = /^export\s+default\s+/;
const EXPORT_DEFAULT_MODIFIER_PATTERN = /^export\s+default\s+$/;

function precedingExportModifier(source: string, entry: IndexEntry): string | null {
  return /(export\s+default\s+|export\s+)$/.exec(source.slice(0, entry.node.start))?.[0] ?? null;
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

function declarationLabel(entry: IndexEntry): string {
  const { kind, name, path } = entry.locator;
  return `${kind} ${JSON.stringify(name)} in ${path}`;
}

function matcherUnparseableDiagnostics(message: string): string {
  return `stage: matcher\nthe matcher could not be parsed as TypeScript: ${message}; a matcher must be a single copied statement or expression, or a contiguous run of statements copied from one block; omit \`match\` for a whole-declaration rewrite`;
}

function regexInvalidDiagnostics(entry: IndexEntry, message: string): string {
  return `stage: matcher\nthe \`/regex/\` matcher is invalid: ${message}; write a valid ECMA-262 pattern with no flags, or use a backtick \`snippet\` copied verbatim from the current source in ${declarationLabel(entry)}`;
}

function matcherNotFoundDiagnostics(entry: IndexEntry): string {
  return `stage: matcher\nthe matcher was not found inside ${declarationLabel(entry)}; copy a complete snippet from the current source, or omit \`match\` for a whole-declaration rewrite`;
}

function matcherAmbiguousDiagnostics(entry: IndexEntry, count: number, picked: boolean): string {
  const pickedNote = picked
    ? "; the \`pick\` ranges still leave more than one occurrence"
    : "; add a \`pick\` range to disambiguate, or extend it with more surrounding context";
  return `stage: matcher\nthe matcher matches ${count} places inside ${declarationLabel(entry)}${pickedNote}`;
}

function regexNotFoundDiagnostics(entry: IndexEntry): string {
  return `stage: matcher\nthe \`/regex/\` matcher matched nothing inside ${declarationLabel(entry)}; anchor or lengthen the pattern, or use a backtick \`snippet\` copied verbatim from the current source`;
}

function regexAmbiguousDiagnostics(entry: IndexEntry, count: number, picked: boolean): string {
  const pickedNote = picked
    ? "; the \`pick\` ranges still leave more than one occurrence"
    : "; add a \`pick\` range to disambiguate, anchor or lengthen the pattern, or use a backtick \`snippet\` copied verbatim from the current source";
  return `stage: matcher\nthe \`/regex/\` matcher matches ${count} places inside ${declarationLabel(entry)}${pickedNote}`;
}

function pickInvalidDiagnostics(
  entry: IndexEntry,
  range: EditRange,
  reason: RangeResolutionFailure,
  detail: string,
): string {
  return [
    "stage: range",
    `the "pick" range (line ${range.line}, column ${range.column} to line ${range.endLine}, column ${range.endColumn}) is invalid (${reason}) for ${declarationLabel(entry)}: ${detail}`,
    "copy the 1-based line and column positions from the numbered current-source block, keep the end inclusive, and keep the range inside the declaration",
  ].join("\n");
}

// The `pick` grammar's `END_OF_LINE_COLUMN` sentinel (a bare `line`, or a
// `line:col-line` span with no end column) is not a real column; translate it to
// the end line's length before the shared range resolver sees it.
function lineLengthAt(source: string, line: number): number | null {
  let currentLine = 1;
  let index = 0;
  while (currentLine < line) {
    const newline = source.indexOf("\n", index);
    if (newline === -1) {
      return null;
    }
    index = newline + 1;
    currentLine += 1;
  }
  const newline = source.indexOf("\n", index);
  const end = newline === -1 ? source.length : newline;
  return end - index;
}

function normalizePickRange(source: string, range: EditRange): EditRange {
  if (range.endColumn !== END_OF_LINE_COLUMN) {
    return range;
  }
  const length = lineLengthAt(source, range.endLine);
  return { ...range, endColumn: length === null ? 1 : Math.max(1, length) };
}

type PickResolution = { ok: true; spans: Span[] } | { ok: false; diagnostics: string };

// Resolve each `pick` range to a file-absolute span via the shared range
// resolver, which enforces the declaration bounds and typed reasons.
function resolvePickSpans(
  source: string,
  entry: IndexEntry,
  pick: readonly EditRange[],
): PickResolution {
  const declaration = { start: entry.node.start, end: entry.node.end };
  const spans: Span[] = [];
  for (const range of pick) {
    const located = resolveEditRange(
      source,
      normalizePickRange(source, range),
      0,
      source.length,
      declaration,
    );
    if (!located.ok) {
      return {
        ok: false,
        diagnostics: pickInvalidDiagnostics(entry, range, located.reason, located.detail),
      };
    }
    spans.push({ start: located.start, end: located.end });
  }
  return { ok: true, spans };
}

function spanContained(span: Span, picks: readonly Span[]): boolean {
  return picks.some((pick) => span.start >= pick.start && span.end <= pick.end);
}

/** A point selecter is `line:column` with no end position (`human/edit.md` §2). */
function isPointRange(range: EditRange): boolean {
  return range.line === range.endLine && range.column === range.endColumn;
}

/**
 * With a `match`, a point selecter selects the candidate spans that contain the
 * point; every other selecter keeps the "candidate contained in the picked
 * range" rule. `ranges` and `pickSpans` are parallel: the original range decides
 * whether the selecter was a point, the resolved span supplies its offset.
 */
function pickMatchesSpan(
  span: Span,
  ranges: readonly EditRange[],
  pickSpans: readonly Span[],
): boolean {
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const pickSpan = pickSpans[index];
    if (range === undefined || pickSpan === undefined) {
      continue;
    }
    if (isPointRange(range)) {
      if (span.start <= pickSpan.start && pickSpan.start <= span.end) {
        return true;
      }
      continue;
    }
    if (spanContained(span, [pickSpan])) {
      return true;
    }
  }
  return false;
}

function pickOnlyMultipleDiagnostics(entry: IndexEntry, count: number): string {
  return [
    "stage: range",
    `the \`pick\` has ${count} selecters, but ${declarationLabel(entry)} has no \`match\`, so a single clause can target only one text span`,
    "write exactly one selecter (a line, a point, or a range), or add a `match` to filter candidates inside several picked ranges",
  ].join("\n");
}

/**
 * The one ambiguity/not-found policy both matcher kinds share: with no `pick`,
 * exactly one candidate span is the target; zero is `matcher-not-found` and
 * more than one is `matcher-ambiguous`. With `pick`, the candidate set is first
 * filtered (point selecters keep spans containing the point; line/range
 * selecters keep spans contained in a picked range), and the same rule applies
 * with stage `pick`. The caller supplies the diagnostic wording (a `snippet`
 * and a `/regex/` phrase differently).
 */
type NarrowResult =
  | { ok: true; start: number; end: number; stage: SelectionStage }
  | { ok: false; cause: CascadeCause; diagnostics: string };

function narrowByMatches(
  source: string,
  entry: IndexEntry,
  pick: readonly EditRange[] | null,
  spans: readonly Span[],
  notFound: () => string,
  ambiguous: (count: number, picked: boolean) => string,
): NarrowResult {
  if (pick === null) {
    if (spans.length === 0) {
      return { ok: false, cause: "matcher-not-found", diagnostics: notFound() };
    }
    if (spans.length > 1) {
      return { ok: false, cause: "matcher-ambiguous", diagnostics: ambiguous(spans.length, false) };
    }
    const only = spans[0];
    if (only === undefined) {
      // Unreachable: spans.length is exactly one here.
      return { ok: false, cause: "matcher-not-found", diagnostics: notFound() };
    }
    return { ok: true, start: only.start, end: only.end, stage: "match" };
  }
  const picks = resolvePickSpans(source, entry, pick);
  if (!picks.ok) {
    return { ok: false, cause: "range-invalid", diagnostics: picks.diagnostics };
  }
  const kept = spans.filter((span) => pickMatchesSpan(span, pick, picks.spans));
  if (kept.length === 0) {
    return { ok: false, cause: "matcher-not-found", diagnostics: notFound() };
  }
  if (kept.length > 1) {
    return { ok: false, cause: "matcher-ambiguous", diagnostics: ambiguous(kept.length, true) };
  }
  const only = kept[0];
  if (only === undefined) {
    // Unreachable: kept.length is exactly one here.
    return { ok: false, cause: "matcher-not-found", diagnostics: notFound() };
  }
  return { ok: true, start: only.start, end: only.end, stage: "pick" };
}

/**
 * The candidate occurrences a **viewer** clause enumerates (#111,
 * `docs/edit-protocol.md` §4): unlike `resolveCascade`, ambiguity is not a
 * failure here — a `match` viewer returns every occurrence, optionally filtered
 * to the `pick` ranges, so the model can see the candidates and then add `pick`
 * or lengthen the snippet. A bare viewer returns the whole declaration. A
 * malformed matcher or a `pick` that cannot resolve still fails with its typed
 * cause.
 */
export type CascadeViewerResolution =
  | { ok: true; stage: SelectionStage; spans: Span[] }
  | { ok: false; cause: CascadeCause; diagnostics: string };

export function resolveCascadeViewer(
  source: string,
  entry: IndexEntry,
  selection: Selection,
): CascadeViewerResolution {
  const declaration: Span = { start: entry.node.start, end: entry.node.end };
  if (selection.matcher === null) {
    return { ok: true, stage: "whole-symbol", spans: [declaration] };
  }
  let spans: Span[];
  if (selection.matcher.kind === "regex") {
    const found = findRegexMatches(source, entry.node, selection.matcher.value);
    if (found.kind === "invalid") {
      return {
        ok: false,
        cause: "regex-invalid",
        diagnostics: regexInvalidDiagnostics(entry, found.message),
      };
    }
    spans = found.spans;
  } else {
    const found = findMatcherMatches(source, entry.node, selection.matcher.value);
    if (found.kind === "unparseable") {
      return {
        ok: false,
        cause: "matcher-unparseable",
        diagnostics: matcherUnparseableDiagnostics(found.message),
      };
    }
    spans = found.spans;
  }
  if (selection.pick !== null) {
    const picks = resolvePickSpans(source, entry, selection.pick);
    if (!picks.ok) {
      return { ok: false, cause: "range-invalid", diagnostics: picks.diagnostics };
    }
    return {
      ok: true,
      stage: "pick",
      spans: spans.filter((span) => pickMatchesSpan(span, selection.pick ?? [], picks.spans)),
    };
  }
  return { ok: true, stage: "match", spans };
}

/**
 * Resolve one edit-dsl clause against the source that would be spliced. `entry`
 * is the **already-resolved** declaration (the address stage is owned
 * elsewhere); `source` is the file's current text. Returns the half-open splice
 * span, the replacement text, and the finest stage that resolved it — or a typed
 * failure. A clause with no `replace` is a viewer (`viewer: true`, `text: ""`).
 */
export function resolveCascade(
  source: string,
  entry: IndexEntry,
  selection: Selection,
): CascadeResolution {
  const declaration = { start: entry.node.start, end: entry.node.end };
  let start: number;
  let end: number;
  let stage: SelectionStage;

  if (selection.matcher === null) {
    if (selection.pick === null) {
      // `select` alone: the whole declaration.
      start = declaration.start;
      end = declaration.end;
      stage = "whole-symbol";
    } else {
      // Pick-only editor: the selecter *is* the target text span (no fuzzy
      // match runs). One clause targets one span, so a braced set fails.
      if (selection.pick.length !== 1) {
        return {
          ok: false,
          cause: "range-invalid",
          diagnostics: pickOnlyMultipleDiagnostics(entry, selection.pick.length),
        };
      }
      const picks = resolvePickSpans(source, entry, selection.pick);
      if (!picks.ok) {
        return { ok: false, cause: "range-invalid", diagnostics: picks.diagnostics };
      }
      const only = picks.spans[0];
      if (only === undefined) {
        // Unreachable: `resolvePickSpans` returns one span per selecter.
        return {
          ok: false,
          cause: "range-invalid",
          diagnostics: pickOnlyMultipleDiagnostics(entry, selection.pick.length),
        };
      }
      start = only.start;
      end = only.end;
      stage = "pick";
    }
  } else if (selection.matcher.kind === "regex") {
    const found = findRegexMatches(source, entry.node, selection.matcher.value);
    if (found.kind === "invalid") {
      return {
        ok: false,
        cause: "regex-invalid",
        diagnostics: regexInvalidDiagnostics(entry, found.message),
      };
    }
    const narrowed = narrowByMatches(
      source,
      entry,
      selection.pick,
      found.spans,
      () => regexNotFoundDiagnostics(entry),
      (count, picked) => regexAmbiguousDiagnostics(entry, count, picked),
    );
    if (!narrowed.ok) {
      return narrowed;
    }
    start = narrowed.start;
    end = narrowed.end;
    stage = narrowed.stage;
  } else {
    const found = findMatcherMatches(source, entry.node, selection.matcher.value);
    if (found.kind === "unparseable") {
      return {
        ok: false,
        cause: "matcher-unparseable",
        diagnostics: matcherUnparseableDiagnostics(found.message),
      };
    }
    const narrowed = narrowByMatches(
      source,
      entry,
      selection.pick,
      found.spans,
      () => matcherNotFoundDiagnostics(entry),
      (count, picked) => matcherAmbiguousDiagnostics(entry, count, picked),
    );
    if (!narrowed.ok) {
      return narrowed;
    }
    start = narrowed.start;
    end = narrowed.end;
    stage = narrowed.stage;
  }

  if (selection.replacement === null) {
    return { ok: true, start, end, text: "", viewer: true, stage, gateStart: start };
  }

  // A whole-member empty fence deletes the member and its separator. The
  // parser's member span excludes `,`/`;`, so a raw splice would leave a
  // dangling separator behind; the parse/format gate remains the final check.
  if (
    selection.matcher === null &&
    selection.pick === null &&
    selection.replacement.trim() === ""
  ) {
    const memberRange = memberDeletionRange(source, entry.node);
    if (memberRange !== null) {
      start = memberRange.start;
      end = memberRange.end;
    }
  }

  // A target that begins at the declaration gets the `export` tolerance; a
  // body-level target must not strip (#48).
  const modifier = precedingExportModifier(source, entry);
  const text =
    start === declaration.start
      ? stripLeadingExport(selection.replacement, modifier)
      : selection.replacement;
  // An empty fence on a whole-declaration target deletes it (#14); include the
  // leading `export`/`export default` modifier so the deletion does not leave a
  // dangling keyword behind.
  if (modifier !== null && start === declaration.start && selection.replacement.trim() === "") {
    start -= modifier.length;
  }
  // Per-region no-op guard (#59): the replacement equals the exact text it
  // replaces, so this region alone would change nothing.
  if (text === source.slice(start, end)) {
    return { ok: false, cause: "no-op", diagnostics: NOOP_DIAGNOSTICS };
  }
  return { ok: true, start, end, text, viewer: false, stage, gateStart: start };
}
