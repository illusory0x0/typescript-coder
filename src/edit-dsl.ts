/**
 * The edit-dsl-reply resolver (#111) for the selection syntax
 * (`docs/edit-protocol.md`). It turns a parsed `Selection[]` into the edit
 * regions the loop applies, the candidate occurrences a **viewer** returns, and
 * the typed failures each clause produced — keeping the cascade's stage
 * vocabulary (#110) so both the JSON and edit-dsl paths record the same metric.
 *
 * This module is reached under the edit-dsl edit protocol
 * (`--protocol-format=edit-dsl`); the loop parses `select … end` clauses first
 * and a JSON payload is rejected. The address stage is delegated to the
 * loop's `resolveCurrentEntry` so the echo/kind rules stay identical on both
 * paths.
 */
import { resolveCascade, resolveCascadeViewer } from "./cascade";
import type { CascadeCause, SelectionStage } from "./cascade";
import { resolveFileSelection } from "./module-boundary";
import { Parser } from "./parser";
import type { Node, Program, Statement } from "./parser";
import { isFileSelection } from "./selection";
import type { Selection } from "./selection";
import { Binder } from "./utility";
import type { IndexEntry, Locator, SymbolSpace } from "./utility";
import { duplicateDeclarations, wholeSymbolRestrictionDiagnostics } from "./utility";
import type { EditRange } from "./loop";

/** #110 `MatcherKind`, mirrored to avoid a value-level import cycle with loop. */
export type EditDslMatcherKind = "snippet" | "regex";

/** The stage an edit-dsl clause failed at, mapped to the loop's failure stages. */
export type EditDslFailureStage = "address" | "matcher" | "range" | "no-op" | "duplicate";

/** Callbacks the loop supplies: address resolution (echo/kind rules) and file reads. */
export interface EditDslDeps {
  /** The current source of `path` (the pinned file's in-memory source, else disk). */
  sourceFor: (path: string) => string;
  /** Whether the path is a regular file (a file-level select edits an existing file). */
  fileExists?: (path: string) => boolean;
  /** Whether the path is inside the workspace and safe to touch. */
  isSafePath?: (path: string) => boolean;
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
   * (`docs/edit-protocol.md` §6). Only the edit-dsl path ever sets this.
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
  /** A viewer-only file-absolute slice, or `null` for the whole declaration. */
  within: EditRange[] | null;
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

/**
 * One resolved `select` target in the symbol index's address vocabulary. The
 * kind is the declaration's resolved kind, never the raw locator text: `select
 * X` and `select function X` are the same target, and a class selected as
 * value or type is still one declaration.
 */
export interface EditDslTargetAddress {
  path: string;
  name: string;
  kind: string;
}

/** A resolved target one clause already claimed, and which clause claimed it. */
export interface EditDslTargetClaim {
  /** 0-based position of the claiming clause in the original reply. */
  index: number;
  /** True when the claiming clause was an implicit create. */
  create: boolean;
}

/**
 * The addresses claimed by the `select` clauses resolved so far in one reply.
 * Shared by editors/viewers/creates (`resolveEditDslReply`) and renames
 * (`resolveMultiEditor`) so every clause uses the same uniqueness key.
 */
export type EditDslTargetClaims = Map<string, EditDslTargetClaim>;

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
  return {
    ok: true,
    text: body,
    declaration: { kind: createdDeclarationKind(declaration, program), name },
  };
}

// A completed variable declaration is appended verbatim, but its precise
// const/let/var/using identity still matters for the one-target-per-reply claim:
// an implicit `select const X` and an explicit `create const X` are the same
// declaration even though the binder nodes a `VariableDeclarator`.
function createdDeclarationKind(declaration: Node, program: Program): string {
  const kind = declarationKindOf(declaration);
  if (kind !== "variable") {
    return kind;
  }
  for (const statement of program.body) {
    const inner = statement.kind === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (inner !== null && inner.kind === "VariableStatement") {
      if (declaration.start >= inner.start && declaration.end <= inner.end) {
        return inner.declarationKind;
      }
    }
  }
  return kind;
}

// The declaration kind the fence body actually creates (#13). The locator's
// requested kind is only an address hint: `select const X` may carry a
// `type X = …` fence, and two clauses conflict when they add the same
// declaration in the same file, whatever their locators asked for.
export function declarationKindOf(declaration: Node): string {
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
    case "VariableStatement":
      return (declaration as Node & { declarationKind: string }).declarationKind;
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

/**
 * The uniqueness key for a resolved target. `match`, `pick`, and `resolve`
 * space are deliberately absent: they select spans/spaces of one declaration,
 * so every clause addressing that declaration shares the key.
 */
export function editDslTargetKey(address: EditDslTargetAddress): string {
  return `${address.path}\u0000${address.name}\u0000${address.kind}`;
}

function duplicateTargetDiagnostics(
  address: EditDslTargetAddress,
  earlierIndex: number,
  index: number,
): string {
  // Name the clauses in ascending reply order even when the claiming clause
  // resolved later (a rename is claimed after editors whatever its position).
  const first = Math.min(earlierIndex, index);
  const second = Math.max(earlierIndex, index);
  return [
    "stage: duplicate",
    `clause ${first + 1} and clause ${second + 1} both select the same ${address.kind} ${JSON.stringify(address.name)} in ${JSON.stringify(address.path)}; the whole edit-dsl reply is discarded and nothing is written`,
    `select ${JSON.stringify(address.name)} once per reply, and split edits to one declaration across exchanges`,
  ].join("\n");
}

/**
 * Claim a resolved `select` target for one reply. Viewers, replace editors,
 * renames, and implicit creates all resolve to the same `(path, name, kind)`
 * key, so a repeat is a `duplicate` for the later clause before any matcher or
 * write can apply. Returns the diagnostic, or null after recording the claim.
 */
export function claimEditDslTarget(
  claims: EditDslTargetClaims,
  address: EditDslTargetAddress,
  index: number,
  create: boolean,
): string | null {
  const key = editDslTargetKey(address);
  const earlier = claims.get(key);
  if (earlier !== undefined) {
    // Preserve the #13 create wording when both clauses add the same
    // declaration; every other duplicate names the resolved address only.
    return earlier.create && create
      ? createConflictDiagnostics(
          address.path,
          { kind: address.kind, name: address.name },
          earlier.index,
          index,
        )
      : duplicateTargetDiagnostics(address, earlier.index, index);
  }
  claims.set(key, { index, create });
  return null;
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
  targetClaims?: EditDslTargetClaims,
): EditDslResolution {
  const regions: EditDslRegion[] = [];
  const viewers: EditDslViewer[] = [];
  const failures: EditDslFailure[] = [];
  // #40: every `select` clause claims its resolved target as `(path, name,
  // kind)` before a matcher can run. A repeat rejects the later clause, and the
  // loop discards the whole reply: one declaration may be addressed once per
  // reply, whatever spans its `match`/`pick` name. `resolveMultiEditor` passes
  // its map in so rename clauses join the same uniqueness set.
  const claims: EditDslTargetClaims = targetClaims ?? new Map();

  for (let position = 0; position < selections.length; position += 1) {
    const selection = selections[position];
    if (selection === undefined) {
      continue;
    }
    const index = indices?.[position] ?? position;
    const path = selection.locator.path;
    const source = deps.sourceFor(path);
    if (isFileSelection(selection)) {
      if (deps.isSafePath !== undefined && !deps.isSafePath(path)) {
        failures.push({
          index,
          path,
          locator: selection.locator,
          stage: "address",
          cause: null,
          diagnostics: `stage: address\nthe path ${JSON.stringify(path)} is outside the editable workspace`,
          undeclaredName: null,
        });
        continue;
      }
      if (deps.fileExists !== undefined && !deps.fileExists(path)) {
        failures.push({
          index,
          path,
          locator: selection.locator,
          stage: "address",
          cause: null,
          diagnostics: `stage: address\ncannot select file ${JSON.stringify(path)}: the file does not exist`,
          undeclaredName: null,
        });
        continue;
      }
      const fileDuplicate = claimEditDslTarget(
        claims,
        { path, name: "", kind: "file" },
        index,
        false,
      );
      if (fileDuplicate !== null) {
        failures.push({
          index,
          path,
          locator: selection.locator,
          stage: "duplicate",
          cause: null,
          diagnostics: fileDuplicate,
          undeclaredName: null,
        });
        continue;
      }
      const fileResolved = resolveFileSelection(source, selection);
      if (!fileResolved.ok) {
        failures.push({
          index,
          path,
          locator: selection.locator,
          stage: fileResolved.stage,
          cause: null,
          diagnostics: fileResolved.diagnostics,
          undeclaredName: null,
        });
        continue;
      }
      regions.push({
        index,
        path,
        locator: selection.locator,
        start: fileResolved.start,
        end: fileResolved.end,
        text: fileResolved.text,
        stage: fileResolved.stage,
        matcherKind: selection.matcher === null ? null : selection.matcher.kind,
        create: false,
      });
      continue;
    }
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
        // add the same type alias and must not both apply. The claim shares the
        // editor/viewer/rename key set so a create cannot slip past the
        // uniqueness rule under a different locator kind (#13/#40).
        const duplicate = claimEditDslTarget(
          claims,
          { path, name: created.declaration.name, kind: created.declaration.kind },
          index,
          true,
        );
        if (duplicate !== null) {
          failures.push({
            index,
            path,
            locator: selection.locator,
            stage: "duplicate",
            cause: null,
            diagnostics: duplicate,
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
    // The resolved entry's locator is authoritative: an omitted kind becomes
    // the declaration's actual kind, and a class addressed through value or
    // type resolves to the one `class` entry (#40).
    const restricted = wholeSymbolRestrictionDiagnostics(address.entry);
    if (
      restricted !== null &&
      selection.matcher === null &&
      selection.pick === null &&
      selection.replacement !== null
    ) {
      failures.push({
        index,
        path,
        locator: selection.locator,
        stage: "address",
        cause: null,
        diagnostics: restricted,
        undeclaredName: null,
      });
      continue;
    }
    const duplicate = claimEditDslTarget(
      claims,
      {
        path: address.entry.locator.path,
        name: address.entry.locator.name,
        kind: address.entry.locator.kind,
      },
      index,
      false,
    );
    if (duplicate !== null) {
      failures.push({
        index,
        path,
        locator: selection.locator,
        stage: "duplicate",
        cause: null,
        diagnostics: duplicate,
        undeclaredName: null,
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
      const declaration = occurrenceLines(source, address.entry.node.start, address.entry.node.end);
      const within = selection.within ?? null;
      if (within !== null) {
        const first = declaration[0]?.line ?? 0;
        const last = declaration[declaration.length - 1]?.line ?? 0;
        const invalid = within.find(
          (range) => range.line < first || range.endLine > last || range.line > range.endLine,
        );
        if (invalid !== undefined) {
          failures.push({
            index,
            path,
            locator: selection.locator,
            stage: "range",
            cause: "range-invalid",
            diagnostics: `stage: range\nthe viewer slice ${invalid.line}-${invalid.endLine} is outside the declaration at ${path}:${first}-${last}; use a range inside the declaration`,
            undeclaredName: null,
          });
          continue;
        }
      }
      viewers.push({
        index,
        path,
        locator: selection.locator,
        space: selection.space,
        within,
        stage: viewed.stage,
        declaration,
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

/** Head/tail source lines kept when a flat prompt block folds. */
export const FOLD_HEAD_LINES = 3;
export const FOLD_TAIL_LINES = 3;
/** Minimum hidden body size for an indentation fold to be worth a marker. */
export const FOLD_MIN_HIDDEN_LINES = 4;

/** One numbered source line shared by viewers and file reads. */
export interface SourceLine {
  line: number;
  text: string;
}

/** A rendered source line; `marker` lines carry a fold marker instead of code. */
export interface FoldedSourceLine extends SourceLine {
  marker: boolean;
}

export type FoldMode = "declaration" | "file";

/**
 * The single line that replaces a folded source range. It names the hidden
 * file-absolute range, how many lines that hides, and the exact command that
 * expands exactly that range, so a repeated whole-file `read` cannot look like
 * the only way to see more.
 */
export function foldMarker(
  startLine: number,
  endLine: number,
  totalLines?: number,
  path?: string,
): string {
  const hidden = endLine - startLine + 1;
  const counts = totalLines === undefined ? "" : ` (${hidden} of ${totalLines} lines hidden)`;
  const target = path ?? "<path>";
  return `... // content folded, ${target}: ${startLine}-${endLine}L${counts}; expand with read ${target} within ${startLine}-${endLine} end`;
}

function indentationOf(text: string): number {
  let width = 0;
  for (const char of text) {
    if (char === " ") {
      width += 1;
    } else if (char === "\t") {
      width += 4 - (width % 4);
    } else {
      break;
    }
  }
  return width;
}

function nextNonBlank(lines: readonly SourceLine[], start: number): number | null {
  for (let index = start; index < lines.length; index += 1) {
    if ((lines[index]?.text ?? "").trim() !== "") {
      return index;
    }
  }
  return null;
}

interface FoldCandidate {
  /** Index of the first hidden line. */
  start: number;
  /** Index of the last hidden line. */
  end: number;
}

/**
 * Fold source by indentation. A declaration view keeps the declaration body and
 * folds large nested blocks; a file view folds large top-level blocks into
 * outline entries. Flat blocks with no usable nested structure fall back to the
 * three-head/three-tail view so a long function still gets a compact preview.
 *
 * The fold is deliberately read-only and line-number preserving: the marker
 * names the file-absolute hidden range, and `read <path> within <range> end`
 * returns exactly those lines unfolded.
 */
export function foldSourceLines(
  lines: readonly SourceLine[],
  options: {
    mode: FoldMode;
    path: string;
    marked?: ReadonlySet<number>;
  },
): FoldedSourceLine[] {
  const plain = lines.map((line) => ({ ...line, marker: false }));
  if (lines.length <= FOLD_HEAD_LINES + FOLD_TAIL_LINES) {
    return plain;
  }
  const marked = options.marked ?? new Set<number>();
  const baseIndent = (() => {
    const first = nextNonBlank(lines, 0);
    return first === null ? 0 : indentationOf(lines[first]?.text ?? "");
  })();

  const candidates: FoldCandidate[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    if (current === undefined || current.text.trim() === "") {
      continue;
    }
    const text = current.text.trimEnd();
    if (/^[}\])]/.test(text) || !/\{\s*$/.test(text)) {
      continue;
    }
    const indent = indentationOf(current.text);
    if (options.mode === "declaration" ? indent <= baseIndent : indent !== baseIndent) {
      continue;
    }
    const next = nextNonBlank(lines, index + 1);
    if (next === null || indentationOf(lines[next]?.text ?? "") <= indent) {
      continue;
    }
    let end = next;
    for (let cursor = next; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line === undefined || line.text.trim() === "") {
        continue;
      }
      if (indentationOf(line.text) <= indent) {
        break;
      }
      end = cursor;
    }
    if (end - next + 1 < FOLD_MIN_HIDDEN_LINES) {
      continue;
    }
    let containsMarked = false;
    for (let cursor = next; cursor <= end; cursor += 1) {
      const line = lines[cursor];
      if (line !== undefined && marked.has(line.line)) {
        containsMarked = true;
        break;
      }
    }
    if (containsMarked) {
      continue;
    }
    candidates.push({ start: next, end });
  }

  // Prefer outer folds when two candidates overlap; an outer marker already
  // expands to the hidden inner lines via `read within`.
  candidates.sort((left, right) => left.start - right.start || right.end - left.end);
  const selected: FoldCandidate[] = [];
  for (const candidate of candidates) {
    const previous = selected[selected.length - 1];
    if (previous === undefined || candidate.start > previous.end) {
      selected.push(candidate);
    }
  }

  if (selected.length === 0) {
    const hiddenStart = FOLD_HEAD_LINES;
    const hiddenEnd = lines.length - FOLD_TAIL_LINES - 1;
    if (hiddenEnd < hiddenStart) {
      return plain;
    }
    let hidesMarked = false;
    for (let index = hiddenStart; index <= hiddenEnd; index += 1) {
      const line = lines[index];
      if (line !== undefined && marked.has(line.line)) {
        hidesMarked = true;
        break;
      }
    }
    if (hidesMarked) {
      return plain;
    }
    const startLine = lines[hiddenStart]?.line ?? 0;
    const endLine = lines[hiddenEnd]?.line ?? startLine;
    return [
      ...plain.slice(0, FOLD_HEAD_LINES),
      {
        line: startLine,
        text: foldMarker(startLine, endLine, lines.length, options.path),
        marker: true,
      },
      ...plain.slice(-FOLD_TAIL_LINES),
    ];
  }

  const rendered: FoldedSourceLine[] = [];
  let cursor = 0;
  for (const candidate of selected) {
    for (let index = cursor; index < candidate.start; index += 1) {
      const line = plain[index];
      if (line !== undefined) {
        rendered.push(line);
      }
    }
    const startLine = lines[candidate.start]?.line ?? 0;
    const endLine = lines[candidate.end]?.line ?? startLine;
    rendered.push({
      line: startLine,
      text: foldMarker(startLine, endLine, lines.length, options.path),
      marker: true,
    });
    cursor = candidate.end + 1;
  }
  for (let index = cursor; index < plain.length; index += 1) {
    const line = plain[index];
    if (line !== undefined) {
      rendered.push(line);
    }
  }
  return rendered;
}

function sliceSourceLines(
  lines: readonly SourceLine[],
  ranges: readonly EditRange[],
): SourceLine[] {
  const wanted = new Set<number>();
  for (const range of ranges) {
    for (let line = range.line; line <= range.endLine; line += 1) {
      wanted.add(line);
    }
  }
  return lines.filter((line) => wanted.has(line.line));
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
export function renderViewerFeedback(
  viewers: readonly EditDslViewer[],
  options: { footer?: string | null } = {},
): string {
  const lines = ["Located occurrences (viewer clauses write nothing):"];
  for (const viewer of viewers) {
    const { kind, name } = viewer.locator;
    let head =
      kind === "" ? `select ${name} in ${viewer.path}` : `select ${kind} ${name} in ${viewer.path}`;
    if (viewer.space !== null) {
      head += ` resolve ${viewer.space}`;
    }
    if (viewer.within !== null) {
      head += ` within ${viewer.within.map((range) => `${range.line}-${range.endLine}`).join(",")}`;
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
    const renderBlockLine = (line: FoldedSourceLine): string => {
      if (line.marker) {
        return `${markerGutter(false)}${" ".repeat(width)} | ${line.text}`;
      }
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
      const rendered =
        viewer.within === null
          ? foldSourceLines(block, {
              mode: "declaration",
              path: viewer.path,
              marked,
            })
          : sliceSourceLines(block, viewer.within).map((line) => ({ ...line, marker: false }));
      if (rendered.length === 0) {
        lines.push("  (no lines in this slice)");
      } else {
        for (const line of rendered) {
          lines.push(renderBlockLine(line));
        }
      }
    }
    if (viewer.duplicateNote !== null) {
      lines.push("", viewer.duplicateNote);
    }
  }
  if (options.footer !== null) {
    lines.push(
      "",
      options.footer ??
        "Reply with an edit clause: add `replace` (use `pick` only with `replace`).",
    );
  }
  return lines.join("\n");
}
