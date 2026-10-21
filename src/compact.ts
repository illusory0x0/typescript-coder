/**
 * The compact-reply resolver (#111) for the selection syntax
 * (`docs/edit-protocol.md`). It turns a parsed `Selection[]` into the edit
 * regions the loop applies, the candidate occurrences a **viewer** returns, and
 * the typed failures each clause produced — keeping the cascade's stage
 * vocabulary (#110) so both the JSON and compact paths record the same metric.
 *
 * This module is reached under the compact edit protocol
 * (`--protocol-format=compact`); the loop parses `select … end` clauses first
 * and a JSON edit payload is rejected. The address stage is delegated to the
 * loop's `resolveCurrentEntry` so the echo/kind rules stay identical on both
 * paths.
 */
import { resolveCascade, resolveCascadeViewer } from "./cascade";
import type { CascadeCause, SelectionStage } from "./cascade";
import type { Selection } from "./selection";
import type { IndexEntry, Locator } from "./utility";

/** #110 `MatcherKind`, mirrored to avoid a value-level import cycle with loop. */
export type CompactMatcherKind = "snippet" | "regex";

/** The stage a compact clause failed at, mapped to the loop's failure stages. */
export type CompactFailureStage = "address" | "matcher" | "range" | "no-op";

/** Callbacks the loop supplies: address resolution (echo/kind rules) and file reads. */
export interface CompactDeps {
  /** The current source of `path` (the pinned file's in-memory source, else disk). */
  sourceFor: (path: string) => string;
  /** Strict-AND address resolution, the loop's `resolveCurrentEntry`. */
  resolveEntry: (
    source: string,
    path: string,
    locator: Locator,
  ) => { ok: true; entry: IndexEntry } | { ok: false; diagnostics: string; undeclared: boolean };
}

/** One compact **editor** clause resolved to its half-open splice. */
export interface CompactRegion {
  /** Clause position in the reply (0-based), for diagnostics. */
  index: number;
  path: string;
  locator: Locator;
  /** Half-open offsets into the file's current source. */
  start: number;
  end: number;
  /** Text spliced over `[start, end)`. */
  text: string;
  /** The finest cascade stage that resolved the target (#110). */
  stage: SelectionStage;
  /** The matcher form that resolved it, or `null` for a whole-declaration edit. */
  matcherKind: CompactMatcherKind | null;
  /**
   * True when the clause is an implicit create: a whole-declaration editor
   * whose symbol is absent, so its fence body is appended as a new declaration
   * (`docs/edit-protocol.md` §9). Only the compact path ever sets this.
   */
  create: boolean;
}

/** One source line of an occurrence, for the numbered snippet in feedback. */
export interface OccurrenceLine {
  line: number;
  text: string;
}

/** One candidate occurrence a viewer returned (`docs/edit-protocol.md` §4). */
export interface CompactOccurrence {
  start: number;
  end: number;
  /** File-absolute 1-based position. */
  line: number;
  column: number;
  /** The occurrence's source lines, for the numbered snippet. */
  lines: OccurrenceLine[];
}

/** One **viewer** clause and the occurrences it resolved to. */
export interface CompactViewer {
  index: number;
  path: string;
  locator: Locator;
  stage: SelectionStage;
  occurrences: CompactOccurrence[];
}

/** One clause that could not resolve, carrying its typed cause. */
export interface CompactFailure {
  index: number;
  path: string;
  locator: Locator;
  stage: CompactFailureStage;
  /** The cascade cause (`null` for an address failure owned by `resolveCurrentEntry`). */
  cause: CascadeCause | null;
  diagnostics: string;
  undeclaredName: string | null;
}

export interface CompactResolution {
  regions: CompactRegion[];
  viewers: CompactViewer[];
  failures: CompactFailure[];
}

// One cascade cause maps to the loop's rejection stage. Everything matcher-like
// (including `regex-invalid`, #109) is the `matcher` stage; the loop's
// classifier reads the cause to pick the exact `RejectionCause`.
function stageForCause(cause: CascadeCause): CompactFailureStage {
  switch (cause) {
    case "range-invalid":
      return "range";
    case "no-op":
      return "no-op";
    default:
      return "matcher";
  }
}

function positionAt(
  source: string,
  offset: number,
): { line: number; column: number; lineStart: number } {
  const limit = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < limit; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: limit - lineStart + 1, lineStart };
}

// The occurrence's source lines: from the line containing `start` through the
// line containing the last character of `[start, end)`.
function occurrenceLines(source: string, start: number, end: number): OccurrenceLine[] {
  const first = positionAt(source, start);
  const lastOffset = end > start ? end - 1 : start;
  const last = positionAt(source, lastOffset);
  const lines: OccurrenceLine[] = [];
  let lineStart = first.lineStart;
  for (let line = first.line; line <= last.line; line += 1) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? source.length : newline;
    lines.push({ line, text: source.slice(lineStart, lineEnd).replace(/\r$/, "") });
    lineStart = lineEnd + 1;
  }
  return lines;
}

/**
 * Resolve a parsed compact reply (`docs/edit-protocol.md` §3) into editor
 * regions, viewer occurrences, and typed failures. Each clause is resolved
 * independently against its own file's current source; a failed clause never
 * aborts the others. The loop then applies the resolved regions non-atomically
 * (§6): successes stand, failures are skipped.
 */
export function resolveCompactReply(
  selections: readonly Selection[],
  deps: CompactDeps,
): CompactResolution {
  const regions: CompactRegion[] = [];
  const viewers: CompactViewer[] = [];
  const failures: CompactFailure[] = [];

  for (let index = 0; index < selections.length; index += 1) {
    const selection = selections[index];
    if (selection === undefined) {
      continue;
    }
    const path = selection.locator.path;
    const source = deps.sourceFor(path);
    const address = deps.resolveEntry(source, path, selection.locator);
    if (!address.ok) {
      // Implicit create (compact §9): an absent name edited by a
      // whole-declaration editor — `select … replace with <fence> end` with a
      // non-empty body and no `match`/`pick` — appends the fence body as a new
      // declaration, creating the file and its parent dirs if absent. Every
      // other miss (a matcher/pick, an empty body, or a viewer) keeps the
      // address failure.
      const replacement = selection.replacement;
      const createsDeclaration =
        address.undeclared &&
        replacement !== null &&
        selection.matcher === null &&
        selection.pick === null &&
        replacement.trim() !== "";
      if (createsDeclaration) {
        const body = replacement.trim();
        regions.push({
          index,
          path,
          locator: selection.locator,
          // A create appends at the evolving end of the file: its original
          // offset is the file's current length, and the body is spliced with
          // a leading newline (none for an empty file) and a trailing one.
          start: source.length,
          end: source.length,
          text: (source.trim() === "" ? "" : "\n") + body + "\n",
          stage: "whole-symbol",
          matcherKind: null,
          create: true,
        });
        continue;
      }
      failures.push({
        index,
        path,
        locator: selection.locator,
        stage: "address",
        cause: null,
        diagnostics: address.diagnostics,
        undeclaredName: address.undeclared ? selection.locator.name : null,
      });
      continue;
    }
    if (selection.replacement === null) {
      const viewed = resolveCascadeViewer(source, address.entry, selection);
      if (!viewed.ok) {
        failures.push({
          index,
          path,
          locator: selection.locator,
          stage: stageForCause(viewed.cause),
          cause: viewed.cause,
          diagnostics: viewed.diagnostics,
          undeclaredName: null,
        });
        continue;
      }
      viewers.push({
        index,
        path,
        locator: selection.locator,
        stage: viewed.stage,
        occurrences: viewed.spans.map((span) => {
          const { line, column } = positionAt(source, span.start);
          return {
            start: span.start,
            end: span.end,
            line,
            column,
            lines: occurrenceLines(source, span.start, span.end),
          };
        }),
      });
      continue;
    }
    const resolved = resolveCascade(source, address.entry, selection);
    if (!resolved.ok) {
      failures.push({
        index,
        path,
        locator: selection.locator,
        stage: stageForCause(resolved.cause),
        cause: resolved.cause,
        diagnostics: resolved.diagnostics,
        undeclaredName: null,
      });
      continue;
    }
    regions.push({
      index,
      path,
      locator: selection.locator,
      start: resolved.start,
      end: resolved.end,
      text: resolved.text,
      stage: resolved.stage,
      matcherKind: selection.matcher === null ? null : selection.matcher.kind,
      create: false,
    });
  }

  return { regions, viewers, failures };
}

/**
 * Render the viewer occurrences as the next prompt's feedback: each candidate's
 * file-absolute `line:col` plus its numbered source snippet. A locate turn that
 * resolved at least one viewer but wrote nothing carries this text so the model
 * can add `pick` or a `replace`.
 */
export function renderViewerFeedback(viewers: readonly CompactViewer[]): string {
  const lines = ["Located occurrences (viewer clauses write nothing):"];
  for (const viewer of viewers) {
    const { kind, name } = viewer.locator;
    const head =
      kind === "" ? `select ${name} in ${viewer.path}` : `select ${kind} ${name} in ${viewer.path}`;
    lines.push("", head);
    if (viewer.occurrences.length === 0) {
      lines.push("  (no occurrences)");
      continue;
    }
    for (const occurrence of viewer.occurrences) {
      lines.push(`  ${viewer.path}:${occurrence.line}:${occurrence.column}`);
      const width = String(occurrence.lines.at(-1)?.line ?? occurrence.line).length;
      for (const line of occurrence.lines) {
        lines.push(`    ${String(line.line).padStart(width)} | ${line.text}`);
      }
    }
  }
  lines.push("", "Reply with an edit clause (add `replace`) or narrow a viewer with `pick`.");
  return lines.join("\n");
}
