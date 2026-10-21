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
import { Parser } from "./parser";
import type { Program, Statement } from "./parser";
import type { Selection } from "./selection";
import { Binder } from "./utility";
import type { IndexEntry, Locator, SymbolSpace } from "./utility";

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
    space: SymbolSpace | null,
  ) =>
    | { ok: true; entry: IndexEntry }
    | { ok: false; diagnostics: string; undeclared: boolean; spaceMiss?: boolean };
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
  /** The clause's `resolve <value|type|namespace>` disambiguator, or `null`. */
  space: SymbolSpace | null;
  stage: SelectionStage;
  /** The whole resolved declaration's source lines, for the numbered block. */
  declaration: OccurrenceLine[];
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

// A create fence is appended verbatim when it already carries complete
// top-level declarations; any other body is wrapped by the clause's symbol
// space (`human/edit.md` creation defaults).
function isDeclarationStatement(statement: Statement): boolean {
  switch (statement.kind) {
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "VariableStatement":
    case "InterfaceDeclaration":
    case "TypeAliasDeclaration":
    case "EnumDeclaration":
    case "NamespaceDeclaration":
      return true;
    case "ExportNamedDeclaration":
      return statement.declaration !== null && isDeclarationStatement(statement.declaration);
    case "ExportDefaultDeclaration":
      return (
        statement.declaration.kind === "FunctionDeclaration" ||
        statement.declaration.kind === "ClassDeclaration"
      );
    default:
      return false;
  }
}

type CreateBody = { ok: true; text: string } | { ok: false; diagnostics: string };

function createAddressDiagnostics(selection: Selection, detail: string): string {
  const { locator } = selection;
  const label =
    locator.kind === ""
      ? JSON.stringify(locator.name)
      : `${locator.kind} ${JSON.stringify(locator.name)}`;
  const spaceNote =
    selection.space === null
      ? ""
      : `; the clause asks for the ${JSON.stringify(selection.space)} space, so the created declaration must occupy that space`;
  return [
    "stage: address",
    `cannot create ${label} in ${locator.path}: ${detail}${spaceNote}`,
    `a create fence must contain either one complete top-level declaration named ${JSON.stringify(locator.name)}, or a body that is not a declaration list (it is then wrapped by the requested space)`,
  ].join("\n");
}

function declaredNames(root: Binder["rootScope"]): string {
  const names = [...root.bindings.keys()];
  return names.length === 0 ? "no top-level declaration" : names.join(", ");
}

// The create fence is either a declaration list or a body to wrap. A
// declaration list must carry exactly one top-level declaration named after the
// clause's symbol (a declaration list is never wrapped), and a `resolve` space
// must match that declaration's spaces; anything else fails at the address
// stage. Count declaration nodes, not index entries or merged symbols: a
// TypeScript merge (overloads, class+interface, value+type) is still more than
// one declaration and is rejected. A parse failure is not a declaration list
// and is wrapped.
function createBodyText(selection: Selection, body: string): CreateBody {
  const name = selection.locator.name;
  let program: Program;
  try {
    program = new Parser(body).parseProgram();
  } catch {
    return { ok: true, text: wrapCreateBody(name, selection.space, body) };
  }
  if (!program.body.some(isDeclarationStatement)) {
    return { ok: true, text: wrapCreateBody(name, selection.space, body) };
  }
  const binder = new Binder(program);
  const symbols = binder.rootScope.resolveLocal(name);
  const declarations = new Set(symbols.flatMap((symbol) => symbol.declarations));
  if (declarations.size === 0) {
    return {
      ok: false,
      diagnostics: createAddressDiagnostics(
        selection,
        `the fence body is a declaration list (${declaredNames(binder.rootScope)}) but declares no top-level ${JSON.stringify(name)}; a declaration list is never wrapped`,
      ),
    };
  }
  if (declarations.size > 1) {
    return {
      ok: false,
      diagnostics: createAddressDiagnostics(
        selection,
        `the fence body declares ${declarations.size} top-level declarations named ${JSON.stringify(name)}; a create fence must contain exactly one, even when TypeScript would merge them`,
      ),
    };
  }
  const declaration = declarations.values().next().value;
  if (declaration === undefined) {
    // Unreachable: the set has exactly one node here.
    return {
      ok: false,
      diagnostics: createAddressDiagnostics(
        selection,
        `the fence body declares no top-level ${JSON.stringify(name)}`,
      ),
    };
  }
  if (selection.space !== null) {
    const spaces = [
      ...new Set(
        symbols
          .filter((symbol) => symbol.declarations.includes(declaration))
          .map((symbol) => symbol.space),
      ),
    ];
    if (!spaces.includes(selection.space)) {
      return {
        ok: false,
        diagnostics: createAddressDiagnostics(
          selection,
          `the fence body's declaration named ${JSON.stringify(name)} occupies the ${spaces
            .map((space) => JSON.stringify(space))
            .join(
              ", ",
            )} space${spaces.length === 1 ? "" : "s"}, not ${JSON.stringify(selection.space)}`,
        ),
      };
    }
  }
  return { ok: true, text: body };
}

function wrapCreateBody(name: string, space: SymbolSpace | null, body: string): string {
  switch (space) {
    case "type":
      return `type ${name} = ${body};`;
    case "namespace":
      return `namespace ${name} {\n${body}\n}`;
    default:
      // No `resolve` defaults to a `let` binding; `value` uses the same form.
      return `let ${name} = ${body};`;
  }
}

interface PickExpansion {
  start: number;
  end: number;
  text: string;
  stage: SelectionStage;
}

function pickOverlapDiagnostics(selection: Selection): string {
  const { kind, name, path } = selection.locator;
  const label = kind === "" ? JSON.stringify(name) : `${kind} ${JSON.stringify(name)}`;
  return [
    "stage: range",
    `the \`pick\` ranges for ${label} in ${path} resolve to overlapping text spans; one clause cannot apply the same fence to overlapping ranges`,
    "write disjoint selecters, or split the overlapping ranges across clauses",
  ].join("\n");
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
    const address = deps.resolveEntry(source, path, selection.locator, selection.space);
    if (!address.ok) {
      // Implicit create (compact §6): any editor clause (non-empty `replace`)
      // whose symbol is absent, or exists only in another symbol space, appends
      // its fence as a new declaration, creating the file and its parent dirs
      // if absent. `match`/`pick` do not change creation; viewers never create.
      const replacement = selection.replacement;
      const createsDeclaration =
        (address.undeclared || address.spaceMiss === true) &&
        replacement !== null &&
        replacement.trim() !== "";
      if (createsDeclaration) {
        const created = createBodyText(selection, replacement.trim());
        if (!created.ok) {
          failures.push({
            index,
            path,
            locator: selection.locator,
            stage: "address",
            cause: null,
            diagnostics: created.diagnostics,
            undeclaredName: null,
          });
          continue;
        }
        regions.push({
          index,
          path,
          locator: selection.locator,
          // A create appends at the evolving end of the file: its original
          // offset is the file's current length, and the body is spliced with
          // a leading newline (none for an empty file) and a trailing one.
          start: source.length,
          end: source.length,
          text: (source.trim() === "" ? "" : "\n") + created.text + "\n",
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
        undeclaredName:
          address.undeclared || address.spaceMiss === true ? selection.locator.name : null,
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
        space: selection.space,
        stage: viewed.stage,
        declaration: occurrenceLines(source, address.entry.node.start, address.entry.node.end),
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
    // A pick-only clause with several selecters applies the same fence to each
    // resolved text span (one region per range). Resolution is all-or-none:
    // any invalid/no-op range fails the clause before a region is queued.
    if (selection.matcher === null && selection.pick !== null && selection.pick.length > 1) {
      const expanded: PickExpansion[] = [];
      let firstFailure: { cause: CascadeCause; diagnostics: string } | null = null;
      for (const range of selection.pick) {
        const part = resolveCascade(source, address.entry, { ...selection, pick: [range] });
        if (!part.ok) {
          firstFailure = { cause: part.cause, diagnostics: part.diagnostics };
          break;
        }
        expanded.push({
          start: part.start,
          end: part.end,
          text: part.text,
          stage: part.stage,
        });
      }
      if (firstFailure !== null) {
        failures.push({
          index,
          path,
          locator: selection.locator,
          stage: stageForCause(firstFailure.cause),
          cause: firstFailure.cause,
          diagnostics: firstFailure.diagnostics,
          undeclaredName: null,
        });
        continue;
      }
      const ordered = [...expanded].sort((left, right) => left.start - right.start);
      let overlaps = false;
      for (let position = 1; position < ordered.length; position += 1) {
        const previous = ordered[position - 1];
        const current = ordered[position];
        if (previous !== undefined && current !== undefined && current.start < previous.end) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) {
        failures.push({
          index,
          path,
          locator: selection.locator,
          stage: "range",
          cause: "range-invalid",
          diagnostics: pickOverlapDiagnostics(selection),
          undeclaredName: null,
        });
        continue;
      }
      for (const part of ordered) {
        regions.push({
          index,
          path,
          locator: selection.locator,
          start: part.start,
          end: part.end,
          text: part.text,
          stage: part.stage,
          matcherKind: null,
          create: false,
        });
      }
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
 * Render the viewer results as the next prompt's feedback: one numbered block
 * of the whole resolved declaration per clause, with every line intersected by
 * a matched AST span marked `⁉️` in the gutter (a bare viewer marks nothing).
 * The exact candidate `path:line:col` positions precede each block. A locate
 * turn that resolved at least one viewer but wrote nothing carries this text so
 * the model can add `pick` or a `replace`.
 */
export function renderViewerFeedback(viewers: readonly CompactViewer[]): string {
  const lines = ["Located occurrences (viewer clauses write nothing):"];
  for (const viewer of viewers) {
    const { kind, name } = viewer.locator;
    let head =
      kind === "" ? `select ${name} in ${viewer.path}` : `select ${kind} ${name} in ${viewer.path}`;
    if (viewer.space !== null) {
      head += ` resolve ${viewer.space}`;
    }
    lines.push("", head);
    if (viewer.occurrences.length === 0) {
      lines.push("  (no occurrences)");
      continue;
    }
    for (const occurrence of viewer.occurrences) {
      lines.push(`  ${viewer.path}:${occurrence.line}:${occurrence.column}`);
    }
    // A bare viewer's only occurrence is the declaration itself; it is not a
    // match, so it marks nothing. Every matched span marks each display line it
    // intersects, and the declaration is rendered once regardless of candidates.
    const marked = new Set<number>();
    if (viewer.stage !== "whole-symbol") {
      for (const occurrence of viewer.occurrences) {
        for (const line of occurrence.lines) {
          marked.add(line.line);
        }
      }
    }
    const width = String(viewer.declaration.at(-1)?.line ?? 0).length;
    for (const line of viewer.declaration) {
      const gutter = marked.has(line.line) ? "⁉️  " : "    ";
      lines.push(`${gutter}${String(line.line).padStart(width)} | ${line.text}`);
    }
  }
  lines.push("", "Reply with an edit clause: add `replace` (use `pick` only with `replace`).");
  return lines.join("\n");
}
