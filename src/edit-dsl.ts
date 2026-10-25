/**
 * The edit-dsl-reply resolver (#111) for the selection syntax
 * (`docs/edit-protocol.md`). It turns a parsed `Selection[]` into the edit
 * regions the loop applies, the candidate occurrences a **viewer** returns, and
 * the typed failures each clause produced — keeping the cascade's stage
 * vocabulary (#110) so both the JSON and edit-dsl paths record the same metric.
 *
 * This module is reached under the edit-dsl edit protocol
 * (`--protocol-format=edit-dsl`); the loop parses `select … end` clauses first
 * and a JSON edit payload is rejected. The address stage is delegated to the
 * loop's `resolveCurrentEntry` so the echo/kind rules stay identical on both
 * paths.
 */
import { resolveCascade, resolveCascadeViewer } from "./cascade";
import type { CascadeCause, SelectionStage } from "./cascade";
import { Parser } from "./parser";
import type { Node, Program, Statement } from "./parser";
import type { Selection } from "./selection";
import { Binder } from "./utility";
import type { IndexEntry, Locator, SymbolSpace } from "./utility";
import { duplicateDeclarations } from "./utility";

/** #110 `MatcherKind`, mirrored to avoid a value-level import cycle with loop. */
export type EditDslMatcherKind = "snippet" | "regex";

/** The stage an edit-dsl clause failed at, mapped to the loop's failure stages. */
export type EditDslFailureStage = "address" | "matcher" | "range" | "no-op" | "duplicate";

/** Callbacks the loop supplies: address resolution (echo/kind rules) and file reads. */
export interface EditDslDeps {
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

/** One edit-dsl **editor** clause resolved to its half-open splice. */
export interface EditDslRegion {
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
  matcherKind: EditDslMatcherKind | null;
  /**
   * True when the clause is an implicit create: a whole-declaration editor
   * whose symbol is absent, so its fence body is appended as a new declaration
   * (`docs/edit-protocol.md` §9). Only the edit-dsl path ever sets this.
   */
  create: boolean;
}

/** One source line of an occurrence, for the numbered snippet in feedback. */
export interface OccurrenceLine {
  line: number;
  text: string;
}

/** One candidate occurrence a viewer returned (`docs/edit-protocol.md` §4). */
export interface EditDslOccurrence {
  start: number;
  end: number;
  /** File-absolute 1-based position. */
  line: number;
  column: number;
  /** The occurrence's source lines, for the numbered snippet. */
  lines: OccurrenceLine[];
}

/** One **viewer** clause and the occurrences it resolved to. */
export interface EditDslViewer {
  index: number;
  path: string;
  locator: Locator;
  /** The clause's `resolve <value|type|namespace>` disambiguator, or `null`. */
  space: SymbolSpace | null;
  stage: SelectionStage;
  /** The whole resolved declaration's source lines, for the numbered block. */
  declaration: OccurrenceLine[];
  /**
   * Every declaration of a duplicate top-level symbol (#14), in source order.
   * Empty for a single declaration or a legal TypeScript merge; when present,
   * `declaration` is the indexed (editable) first copy and these blocks name
   * the copies the index merged out of view.
   */
  duplicates: OccurrenceLine[][];
  /** The #14 duplicate note naming every location and the delete repair, or null. */
  duplicateNote: string | null;
  occurrences: EditDslOccurrence[];
}

/** One clause that could not resolve, carrying its typed cause. */
export interface EditDslFailure {
  index: number;
  path: string;
  locator: Locator;
  stage: EditDslFailureStage;
  /** The cascade cause (`null` for an address failure owned by `resolveCurrentEntry`). */
  cause: CascadeCause | null;
  diagnostics: string;
  undeclaredName: string | null;
}

export interface EditDslResolution {
  regions: EditDslRegion[];
  viewers: EditDslViewer[];
  failures: EditDslFailure[];
}

// One cascade cause maps to the loop's rejection stage. Everything matcher-like
// (including `regex-invalid`, #109) is the `matcher` stage; the loop's
// classifier reads the cause to pick the exact `RejectionCause`.
function stageForCause(cause: CascadeCause): EditDslFailureStage {
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
 * The #14 duplicate-declaration note: names every merged-out copy by
 * `path:line` and gives a repair that works with the current grammar — the
 * address edits the indexed (first) copy, an identical whole-declaration
 * replacement is a no-op, and an empty fence deletes that copy so the remaining
 * declaration becomes selectable. Null when the symbol is not a duplicate.
 */
export function duplicateDeclarationNote(
  path: string,
  source: string,
  entry: IndexEntry,
): string | null {
  const duplicates = duplicateDeclarations(entry.symbol);
  if (duplicates.length < 2) {
    return null;
  }
  const locations = duplicates.map((node) => `${path}:${positionAt(source, node.start).line}`);
  const first = locations[0] ?? `${path}:1`;
  const last = locations.at(-1) ?? first;
  const listed = locations.length <= 1 ? first : `${locations.slice(0, -1).join(", ")} and ${last}`;
  const label = `${entry.locator.kind} ${JSON.stringify(entry.locator.name)}`;
  return [
    `Duplicate declarations: the top-level ${label} in ${path} is declared ${duplicates.length} times, at ${listed}.`,
    `The address edits the first declaration (${first}); replacing it with identical text is a no-op.`,
    `To remove one duplicate, reply with an empty-fence \`replace with\` clause on this address: it deletes the indexed declaration at ${first}, and the remaining copy is then selectable by name.`,
  ].join("\n");
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

/** The declaration a create fence actually adds, independent of the locator kind. */
interface CreatedDeclaration {
  kind: string;
  name: string;
}

type CreateBody =
  | { ok: true; text: string; declaration: CreatedDeclaration }
  | { ok: false; diagnostics: string };

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
    "code: EDIT_TARGET_MISMATCH",
    `cannot create ${label} in ${locator.path}: ${detail}${spaceNote}`,
    "hint: make the fence declare exactly the clause's target, or send a body that the clause's space can wrap",
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
    const wrapped = wrapCreateBody(name, selection.space, body);
    return { ok: true, text: wrapped.text, declaration: wrapped.declaration };
  }
  if (!program.body.some(isDeclarationStatement)) {
    const wrapped = wrapCreateBody(name, selection.space, body);
    return { ok: true, text: wrapped.text, declaration: wrapped.declaration };
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
  return { ok: true, text: body, declaration: { kind: declarationKindOf(declaration), name } };
}

// The declaration kind the fence body actually creates (#13). The locator's
// requested kind is only an address hint: `select const X` may carry a
// `type X = …` fence, and two clauses conflict when they add the same
// declaration in the same file, whatever their locators asked for.
function declarationKindOf(declaration: Node): string {
  const kind = (declaration as Node & { kind: string }).kind;
  switch (kind) {
    case "FunctionDeclaration":
      return "function";
    case "ClassDeclaration":
      return "class";
    case "TypeAliasDeclaration":
      return "type";
    case "InterfaceDeclaration":
      return "interface";
    case "EnumDeclaration":
      return "enum";
    case "NamespaceDeclaration":
      return "namespace";
    case "VariableDeclarator":
      return "variable";
    default:
      return kind;
  }
}

function wrapCreateBody(
  name: string,
  space: SymbolSpace | null,
  body: string,
): { text: string; declaration: CreatedDeclaration } {
  switch (space) {
    case "type":
      return { text: `type ${name} = ${body};`, declaration: { kind: "type", name } };
    case "namespace":
      return {
        text: `namespace ${name} {\n${body}\n}`,
        declaration: { kind: "namespace", name },
      };
    default:
      // No `resolve` defaults to a `let` binding; `value` uses the same form.
      return { text: `let ${name} = ${body};`, declaration: { kind: "variable", name } };
  }
}

function createConflictDiagnostics(
  path: string,
  declaration: CreatedDeclaration,
  earlierIndex: number,
  index: number,
): string {
  return [
    "stage: duplicate",
    `clause ${earlierIndex + 1} and clause ${index + 1} both create the same top-level ${declaration.kind} ${JSON.stringify(declaration.name)} in ${JSON.stringify(path)}; the whole edit-dsl reply is discarded and nothing is written`,
    `declare ${JSON.stringify(declaration.name)} once per reply, or replace the existing declaration instead of adding another copy`,
  ].join("\n");
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
 * Resolve a parsed edit-dsl reply (`docs/edit-protocol.md` §3) into editor
 * regions, viewer occurrences, and typed failures. Each clause is resolved
 * independently against its own file's current source; the loop applies the
 * whole reply atomically (§6): any failing clause discards every resolved
 * region, and no file is written.
 */
export function resolveEditDslReply(
  selections: readonly Selection[],
  deps: EditDslDeps,
  indices?: readonly number[],
): EditDslResolution {
  const regions: EditDslRegion[] = [];
  const viewers: EditDslViewer[] = [];
  const failures: EditDslFailure[] = [];
  // #13: the creates a reply has already queued, keyed by file and the
  // declaration the fence body actually adds. Every create appends at the same
  // pre-reply offset, so the shared overlap pass cannot see two creates of the
  // same name; reject the repeat here, naming both clauses.
  const creates = new Map<string, number>();

  for (let position = 0; position < selections.length; position += 1) {
    const selection = selections[position];
    if (selection === undefined) {
      continue;
    }
    const index = indices?.[position] ?? position;
    const path = selection.locator.path;
    const source = deps.sourceFor(path);
    const address = deps.resolveEntry(source, path, selection.locator, selection.space);
    if (!address.ok) {
      // Implicit create (edit-dsl §6): any editor clause (non-empty `replace`)
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
        // The created declaration's kind comes from the fence body, not the
        // locator: both `select const X` with a type fence and `select type X`
        // add the same type alias and must not both apply.
        const createKey = `${path}\u0000${created.declaration.kind}\u0000${created.declaration.name}`;
        const earlierIndex = creates.get(createKey);
        if (earlierIndex !== undefined) {
          failures.push({
            index,
            path,
            locator: selection.locator,
            stage: "duplicate",
            cause: null,
            diagnostics: createConflictDiagnostics(path, created.declaration, earlierIndex, index),
            undeclaredName: null,
          });
          continue;
        }
        creates.set(createKey, index);
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
        duplicates: duplicateDeclarations(address.entry.symbol).map((node) =>
          occurrenceLines(source, node.start, node.end),
        ),
        duplicateNote: duplicateDeclarationNote(path, source, address.entry),
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
          const duplicateNote =
            part.cause === "no-op" ? duplicateDeclarationNote(path, source, address.entry) : null;
          firstFailure = {
            cause: part.cause,
            diagnostics:
              duplicateNote === null ? part.diagnostics : `${part.diagnostics}\n${duplicateNote}`,
          };
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
      const duplicateNote =
        resolved.cause === "no-op" ? duplicateDeclarationNote(path, source, address.entry) : null;
      failures.push({
        index,
        path,
        locator: selection.locator,
        stage: stageForCause(resolved.cause),
        cause: resolved.cause,
        diagnostics:
          duplicateNote === null
            ? resolved.diagnostics
            : `${resolved.diagnostics}\n${duplicateNote}`,
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
 * The gutter every marker-rendered source line carries: `⁉️  ` when a matched
 * span intersected the line, four spaces otherwise. Shared by the viewer
 * feedback and the first-turn `# details` block so both align identically.
 */
export function markerGutter(marked: boolean): string {
  return marked ? "⁉️  " : "    ";
}

/** Head/tail source lines kept when a prompt block folds. */
export const FOLD_HEAD_LINES = 3;
export const FOLD_TAIL_LINES = 3;

/**
 * The single line that replaces a folded source range. It names the hidden
 * file-absolute range, how many of the block's lines that hides, and the exact
 * command that expands exactly that range, so a repeated whole-file `read`
 * cannot look like the only way to see more.
 */
export function foldMarker(
  startLine: number,
  endLine: number,
  totalLines?: number,
  path?: string,
): string {
  // The hidden count is the block's line count minus the six kept lines, so a
  // `read within` with gaps between selecters still reports the true number.
  const hidden =
    totalLines === undefined
      ? endLine - startLine + 1
      : Math.max(0, totalLines - FOLD_HEAD_LINES - FOLD_TAIL_LINES);
  const counts = totalLines === undefined ? "" : ` (${hidden} of ${totalLines} lines hidden)`;
  return `... // content folded, source range: ${startLine}-${endLine}${counts}; expand with read ${path ?? "<path>"} within ${startLine}-${endLine} end`;
}

/**
 * The file-absolute lines a viewer's matched spans intersect. A bare viewer's
 * only occurrence is the declaration itself, so it marks nothing.
 */
export function markedViewerLines(viewer: EditDslViewer): Set<number> {
  const marked = new Set<number>();
  if (viewer.stage === "whole-symbol") {
    return marked;
  }
  for (const occurrence of viewer.occurrences) {
    for (const line of occurrence.lines) {
      marked.add(line.line);
    }
  }
  return marked;
}

/**
 * Render the viewer results as the next prompt's feedback: one numbered block
 * of the whole resolved declaration per clause, with every line intersected by
 * a matched AST span marked `⁉️` in the gutter (a bare viewer marks nothing).
 * The exact candidate `path:line:col` positions precede each block. A locate
 * turn that resolved at least one viewer but wrote nothing carries this text so
 * the model can add `pick` or a `replace`.
 */
export function renderViewerFeedback(viewers: readonly EditDslViewer[]): string {
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
    const marked = markedViewerLines(viewer);
    const blocks = viewer.duplicates.length > 0 ? viewer.duplicates : [viewer.declaration];
    const width = String(Math.max(...blocks.map((block) => block.at(-1)?.line ?? 0))).length;
    const renderBlockLine = (line: OccurrenceLine): string => {
      const gutter = markerGutter(marked.has(line.line));
      return `${gutter}${String(line.line).padStart(width)} | ${line.text}`;
    };
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];
      if (block === undefined) {
        continue;
      }
      if (blockIndex > 0) {
        lines.push(`  duplicate declaration at ${viewer.path}:${block[0]?.line ?? 0}`);
      }
      if (block.length > FOLD_HEAD_LINES + FOLD_TAIL_LINES) {
        for (const line of block.slice(0, FOLD_HEAD_LINES)) {
          lines.push(renderBlockLine(line));
        }
        const hiddenStart = block[FOLD_HEAD_LINES]?.line ?? 0;
        const hiddenEnd = block[block.length - FOLD_TAIL_LINES - 1]?.line ?? hiddenStart;
        lines.push(
          `${markerGutter(false)}${" ".repeat(width)} | ${foldMarker(hiddenStart, hiddenEnd, block.length, viewer.path)}`,
        );
        for (const line of block.slice(-FOLD_TAIL_LINES)) {
          lines.push(renderBlockLine(line));
        }
      } else {
        for (const line of block) {
          lines.push(renderBlockLine(line));
        }
      }
    }
    if (viewer.duplicateNote !== null) {
      lines.push("", viewer.duplicateNote);
    }
  }
  lines.push("", "Reply with an edit clause: add `replace` (use `pick` only with `replace`).");
  return lines.join("\n");
}
