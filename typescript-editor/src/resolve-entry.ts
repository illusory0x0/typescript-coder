import { lineColumnAt } from "./commit";
import { buildIndexTolerant, declarationSpaces, grammarKindsForEntryKind } from "./utility";
import type { IndexEntry, Locator, SymbolSpace } from "./utility";

const ADDRESS_CANDIDATE_LIMIT = 5;

export function addressJson(locator: Locator): string {
  return JSON.stringify({ path: locator.path, symbol: locator.name, kind: locator.kind });
}

function describeEntry(entry: IndexEntry, sourceByPath: ReadonlyMap<string, string>): string {
  const source = sourceByPath.get(entry.locator.path) ?? "";
  const { line, column } = lineColumnAt(source, entry.node.start);
  const kind = grammarKindsForEntryKind(entry.locator.kind).join("/");
  return `${entry.locator.path}: ${kind} ${JSON.stringify(entry.locator.name)} (line ${line}, column ${column})`;
}

function candidateLines(
  entries: readonly IndexEntry[],
  sourceByPath: ReadonlyMap<string, string>,
): string[] {
  const lines = entries
    .slice(0, ADDRESS_CANDIDATE_LIMIT)
    .map((entry) => `  - ${describeEntry(entry, sourceByPath)}`);
  if (entries.length > ADDRESS_CANDIDATE_LIMIT) {
    lines.push(`  ... ${entries.length - ADDRESS_CANDIDATE_LIMIT} more`);
  }
  return lines;
}

// Address diagnostics name where the symbol actually exists (path + kind +
// position) and, for a same-path kind mismatch, say which kind to use. A
// `resolve` space mismatch names the spaces the name is actually declared in
// and never suggests another path's candidate as a fallback.
function addressMissDiagnostics(
  locator: Locator,
  byName: readonly IndexEntry[],
  sourceByPath: ReadonlyMap<string, string>,
  space: SymbolSpace | null = null,
): string {
  const spaceSuffix = space === null ? "" : ` in the ${space} space`;
  const lines = [
    "stage: address",
    locator.kind === ""
      ? `no symbol named ${JSON.stringify(locator.name)} in ${JSON.stringify(locator.path)}${spaceSuffix}`
      : `no symbol with kind ${JSON.stringify(locator.kind)} named ${JSON.stringify(locator.name)} in ${JSON.stringify(locator.path)}${spaceSuffix}`,
  ];
  if (byName.length === 0) {
    lines.push(
      `the name ${JSON.stringify(locator.name)} is not declared in the indexed source; correct the address or use mode "create" to add it`,
    );
    return lines.join("\n");
  }
  lines.push(`the name ${JSON.stringify(locator.name)} exists at:`);
  lines.push(...candidateLines(byName, sourceByPath));
  const kinds = [
    ...new Set(
      byName
        .filter((entry) => entry.locator.path === locator.path)
        .map((entry) => entry.locator.kind),
    ),
  ];
  if (kinds.length > 0) {
    if (kinds.includes("variable")) {
      // The internal `"variable"` label is not a grammar kind: name the
      // const/let/var alternatives (plus the bare-select wildcard) instead.
      const grammarKinds = [...new Set(kinds.flatMap((kind) => grammarKindsForEntryKind(kind)))];
      lines.push(
        `in ${JSON.stringify(locator.path)} the name exists as ${grammarKinds.map((kind) => JSON.stringify(kind)).join(", ")}; change "kind" to one of those, or omit "kind" for a bare select`,
      );
    } else {
      lines.push(
        `in ${JSON.stringify(locator.path)} the name exists as ${kinds.map((kind) => JSON.stringify(kind)).join(", ")}; change "kind" to match`,
      );
    }
  }
  if (space !== null) {
    const samePath = byName.filter((entry) => entry.locator.path === locator.path);
    const samePathSpaces = [...new Set(samePath.flatMap((entry) => declarationSpaces(entry)))];
    if (samePathSpaces.length > 0 && !samePathSpaces.includes(space)) {
      lines.push(
        `in ${JSON.stringify(locator.path)} the name is declared in the ${samePathSpaces.map((candidate) => JSON.stringify(candidate)).join(", ")} space${samePathSpaces.length === 1 ? "" : "s"}; change "resolve" to match`,
      );
    } else if (samePathSpaces.length === 0) {
      const spaces = [...new Set(byName.flatMap((entry) => declarationSpaces(entry)))];
      lines.push(
        `the name ${JSON.stringify(locator.name)} is declared in the ${spaces.map((candidate) => JSON.stringify(candidate)).join(", ")} space${spaces.length === 1 ? "" : "s"}; the requested ${JSON.stringify(space)} space does not match this path`,
      );
    }
  }
  return lines.join("\n");
}

function addressAmbiguousDiagnostics(
  locator: Locator,
  matches: readonly IndexEntry[],
  sourceByPath: ReadonlyMap<string, string>,
  space: SymbolSpace | null = null,
): string {
  return [
    "stage: address",
    `the address ${addressJson(locator)}${space === null ? "" : ` in the ${space} space`} matches ${matches.length} declarations; the harness never picks one silently`,
    ...candidateLines(matches, sourceByPath),
    "correct the address (path/symbol/kind) so it matches exactly one declaration",
  ].join("\n");
}

export type CurrentEntryResolution =
  | { ok: true; entry: IndexEntry }
  | { ok: false; diagnostics: string; undeclared: boolean; spaceMiss: boolean };

// Strict-AND resolution of one locator against the current source that would be
// spliced: no silent first-match pick, no kind coercion, no auto-append. An
// empty locator kind is the edit-dsl wildcard (path + name only); `space` is the
// edit-dsl `resolve value|type|namespace` filter and is `null` when omitted.
export function resolveCurrentEntry(
  sourceBefore: string,
  target: string,
  locator: Locator,
  space: SymbolSpace | null = null,
): CurrentEntryResolution {
  const currentBuild = buildIndexTolerant([{ path: target, source: sourceBefore }]);
  const matches = currentBuild.index.lookup(locator, space);
  const sources = new Map([[target, sourceBefore]]);
  if (matches.length === 0) {
    // `undeclared` (#65): the name is absent under every kind, so the
    // diagnostics suggest mode "create" — the retry lead keeps that add path
    // open instead of demanding an impossible re-pin. A name declared only in
    // another symbol space is a `spaceMiss`: it is a creation candidate for the
    // requested space, but is not "undeclared" everywhere. A kind miss is
    // neither: the name occupies the requested space and must be re-addressed.
    const byName = currentBuild.index.byName(locator.name);
    const spaceMiss =
      space !== null &&
      byName.length > 0 &&
      byName.every((entry) => !declarationSpaces(entry).includes(space));
    return {
      ok: false,
      diagnostics: addressMissDiagnostics(locator, byName, sources, space),
      undeclared: byName.length === 0,
      spaceMiss,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      diagnostics: addressAmbiguousDiagnostics(locator, matches, sources, space),
      undeclared: false,
      spaceMiss: false,
    };
  }
  const entry = matches[0];
  if (entry === undefined) {
    // Unreachable: matches.length is exactly one here.
    return {
      ok: false,
      diagnostics: addressMissDiagnostics(locator, [], sources, space),
      undeclared: true,
      spaceMiss: false,
    };
  }
  return { ok: true, entry };
}
