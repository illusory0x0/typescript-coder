import { formatFailureDiagnostics, formatSource } from "./editor";
import { applyMatcherSplice } from "./matcher";
import { LexError } from "./lexer";
import { ParseError, Parser } from "./parser";
import type { Expression, Program, Statement } from "./parser";
import type { Locator } from "./utility";

// The shared commit pipeline: protocol-neutral primitives used by edit-dsl.
// Protocol-specific overlap wording and atomicity stay with the caller; the
// policy object carries only the rules that are allowed to differ.

/** The fields the commit pipeline needs from a resolved clause/payload. */
export interface CommittableRegion {
  /** Clause/payload position in the reply (0-based), for diagnostics. */
  readonly index: number;
  /** The file the region edits (a same-file batch shares it). */
  readonly path: string;
  readonly locator: Locator;
  /** Half-open offsets into the file's current source. */
  readonly start: number;
  readonly end: number;
  /** Text spliced over `[start, end)`. */
  readonly text: string;
  /** The raw replacement, used by the gate diagnostic's code frame. */
  readonly replacement: string;
  /** True for an implicit create (a new whole declaration). */
  readonly create: boolean;
}

export interface CommitPolicy {
  /**
   * Two zero-width inserts at one offset. `overlap` rejects the second
   * (the historical behavior); `append` applies them in clause order.
   */
  readonly sameOffsetInserts?: "overlap" | "append";
}

export type CommitFailureStage = "address" | "gate" | "duplicate" | "format" | "no-op";

export type CommitMatcherCause =
  | "matcher-unparseable"
  | "matcher-not-found"
  | "matcher-ambiguous"
  | "regex-invalid";

/** One region failed the shared per-file apply pipeline. */
export interface RegionFailureNote<T extends CommittableRegion> {
  region: T;
  path: string;
  stage: CommitFailureStage;
  diagnostics: string;
  matcherCause?: CommitMatcherCause;
  formatMessage?: string;
}

export const NOOP_DIAGNOSTICS =
  "stage: no-op\nthe edit does not change the file: the replacement is identical to the text it replaces; change the code so the diagnostics are actually addressed";

// Formatter-normalized no-op (#59 follow-up): the byte comparison in
// `spliceEntryEdit` cannot see a replacement that re-includes the matched
// span's copied leading indentation, which the format gate normalizes away.
// `formattedCandidate` is the format gate's output; the on-disk source is not
// assumed canonical (a run can start from an unformatted file), so a
// non-byte-equal candidate formats the source once and compares canonical
// forms. Only a provable match rejects; an unformattable baseline applies.
export async function sameAfterFormatting(
  target: string,
  sourceBefore: string,
  formattedCandidate: string,
): Promise<boolean> {
  if (formattedCandidate === sourceBefore) {
    return true;
  }
  try {
    return (await formatSource(target, sourceBefore)) === formattedCandidate;
  } catch {
    return false;
  }
}

export interface ParseFailure {
  message: string;
  offset: number;
  line: number;
  column: number;
}

export type ParseCheck = { ok: true; program: Program } | { ok: false; failure: ParseFailure };

export function parseCheck(source: string): ParseCheck {
  try {
    return { ok: true, program: new Parser(source).parseProgram() };
  } catch (error) {
    if (error instanceof ParseError || error instanceof LexError) {
      return {
        ok: false,
        failure: {
          message: error.message,
          offset: error.offset,
          line: error.line,
          column: error.column,
        },
      };
    }
    throw error;
  }
}

export function prevBrokenDiagnostics(path: string, failure: ParseFailure): string {
  return [
    "stage: prev-broken",
    `the current source of ${JSON.stringify(path)} does not parse; this is external modification or a harness bug, so the run stops instead of repairing silently`,
    `${failure.message} (line ${failure.line}, column ${failure.column})`,
  ].join("\n");
}

export function lineColumnAt(source: string, offset: number): { line: number; column: number } {
  const limit = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < limit; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: limit - lineStart + 1 };
}

export function toLines(source: string): string[] {
  const lines = source.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export function codeFrame(lines: readonly string[], line: number): string[] {
  const first = Math.max(1, line - 1);
  const last = Math.min(lines.length, line + 1);
  const frame: string[] = [];
  for (let current = first; current <= last; current += 1) {
    frame.push(`  ${current} | ${lines[current - 1] ?? ""}`);
  }
  return frame;
}

/** Top-level declaration kinds TypeScript rejects when duplicated (#48). */
type DuplicateKind = "function" | "class" | "type";

interface TopLevelDeclaration {
  kind: DuplicateKind;
  name: string;
  offset: number;
}

// Counts the top-level declarations TypeScript rejects on duplicates: bodyful
// functions, classes, and type aliases. Overload signatures (bodyless) and
// interfaces/namespaces are deliberately not counted (#48).
function topLevelDeclarations(program: Program): TopLevelDeclaration[] {
  const declarations: TopLevelDeclaration[] = [];
  const collect = (statement: Statement | Expression): void => {
    switch (statement.kind) {
      case "FunctionDeclaration":
        if (statement.name !== null && statement.body !== null) {
          declarations.push({
            kind: "function",
            name: statement.name.name,
            offset: statement.start,
          });
        }
        return;
      case "ClassDeclaration":
        if (statement.name !== null) {
          declarations.push({ kind: "class", name: statement.name.name, offset: statement.start });
        }
        return;
      case "TypeAliasDeclaration":
        declarations.push({ kind: "type", name: statement.name.name, offset: statement.start });
        return;
      case "ExportNamedDeclaration":
        if (statement.declaration !== null) {
          collect(statement.declaration);
        }
        return;
      case "ExportDefaultDeclaration":
        collect(statement.declaration);
        return;
      default:
        return;
    }
  };
  for (const statement of program.body) {
    collect(statement);
  }
  return declarations;
}

// Duplicate-declaration guard (#48): reject a candidate that raises the
// top-level count of a (kind, name) TypeScript rejects on duplicates, naming
// the existing declaration.
export function duplicateDeclarationDiagnostics(
  sourceBefore: string,
  target: string,
  before: Program,
  after: Program,
): string | null {
  const existing = topLevelDeclarations(before);
  const counts = new Map<string, number>();
  for (const declaration of existing) {
    const key = `${declaration.kind}:${declaration.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const declaration of topLevelDeclarations(after)) {
    const key = `${declaration.kind}:${declaration.name}`;
    const occurrences = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrences);
    const beforeCount = counts.get(key) ?? 0;
    // A name the file did not declare is new only on its first occurrence: two
    // new declarations of the same (kind, name) in one pass are still a
    // duplicate (#13), even though `before` has no line to point at.
    if (occurrences <= Math.max(beforeCount, 1)) {
      continue;
    }
    if (beforeCount === 0) {
      return [
        "stage: duplicate",
        `the edit was discarded: it would add a second top-level ${declaration.kind} ${JSON.stringify(declaration.name)} in ${target}; a single exchange may declare a new name only once`,
      ].join("\n");
    }
    const first = existing.find(
      (candidate) => candidate.kind === declaration.kind && candidate.name === declaration.name,
    );
    const offset = first === undefined ? declaration.offset : first.offset;
    const line = lineColumnAt(sourceBefore, offset).line;
    return [
      "stage: duplicate",
      `the edit was discarded: it would add a second top-level ${declaration.kind} ${JSON.stringify(declaration.name)} (${target} already declares it at line ${line}); replace the existing declaration instead of adding another copy`,
    ].join("\n");
  }
  return null;
}

// Map a gate parse error into the replacement when it falls inside the spliced
// range, so the model can see which part of its own text broke the file.
export function gateDiagnostics(
  spliceStart: number,
  replacement: string,
  failure: ParseFailure,
): string {
  const lines = [
    "stage: gate",
    "the edit was discarded because the resulting source does not parse; nothing was written",
    `${failure.message} (line ${failure.line}, column ${failure.column})`,
  ];
  if (failure.offset >= spliceStart && failure.offset <= spliceStart + replacement.length) {
    const { line, column } = lineColumnAt(replacement, failure.offset - spliceStart);
    lines.push(`replacement line ${line}, column ${column}:`);
    lines.push(...codeFrame(toLines(replacement), line));
  }
  return lines.join("\n");
}

/**
 * Apply already-resolved regions, one pass per file: overlap rejection, the
 * prev-broken/gate/duplicate/format/no-op guards, and the final formatted write.
 * Used by both the JSON batch path (#69/#78) and edit-dsl replies (#111). A
 * per-file failure is reported through `noteFailure` for every region in that
 * file (the whole file is discarded) and the file is skipped; other files still
 * produce writes here. The caller owns reply-level atomicity.
 */
export async function applyResolvedRegions<T extends CommittableRegion>(input: {
  regions: readonly T[];
  fileSourceOf: (path: string) => string;
  target: string;
  prevCheck: ParseCheck;
  policy?: CommitPolicy;
  noteFailure: (note: RegionFailureNote<T>) => void;
  noteOverlap: (path: string, earlier: T, later: T) => void;
}): Promise<{ path: string; source: string }[]> {
  // Group the resolved regions by file and apply each file in one pass.
  const groups = new Map<string, T[]>();
  for (const region of input.regions) {
    const group = groups.get(region.path);
    if (group === undefined) {
      groups.set(region.path, [region]);
    } else {
      group.push(region);
    }
  }
  const sameOffsetInserts = input.policy?.sameOffsetInserts ?? "overlap";
  const writes: { path: string; source: string }[] = [];
  for (const [path, group] of groups) {
    const payloadSource = input.fileSourceOf(path);
    const ordered = [...group].sort((left, right) => left.start - right.start);
    // Overlap policy (#78): two regions share source text, so the whole
    // exchange is discarded and both regions are named.
    let overlapping: [T, T] | null = null;
    // Zero-width inserts do not advance the sorted interval, so track every
    // insertion offset seen: two inserts at one offset overlap unless the policy
    // opts into clause-order appends (#13).
    const insertsAt = new Map<number, T>();
    for (let i = 0; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      if (previous !== undefined && current !== undefined && current.start < previous.end) {
        overlapping = [previous, current];
        break;
      }
      if (current === undefined || current.start !== current.end) {
        continue;
      }
      if (sameOffsetInserts === "append") {
        continue;
      }
      const earlierInsert = insertsAt.get(current.start);
      if (earlierInsert !== undefined) {
        overlapping = [earlierInsert, current];
        break;
      }
      insertsAt.set(current.start, current);
    }
    if (overlapping !== null) {
      input.noteOverlap(path, overlapping[0], overlapping[1]);
      continue;
    }
    // Apply the file's splices together, from the end as `applyEdits` does, so
    // earlier offsets stay valid. Same-offset inserts therefore land in clause
    // order when the policy allows them.
    let spliced = payloadSource;
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      const region = ordered[i];
      if (region === undefined) {
        continue;
      }
      spliced = applyMatcherSplice(spliced, region.start, region.end, region.text);
    }
    const payloadCheck = path === input.target ? input.prevCheck : parseCheck(payloadSource);
    if (!payloadCheck.ok) {
      // Unreachable for extra files: a strict resolution succeeded, so the file
      // parses.
      for (const region of ordered) {
        input.noteFailure({
          region,
          path,
          stage: "address",
          diagnostics: prevBrokenDiagnostics(path, payloadCheck.failure),
        });
      }
      continue;
    }
    const gate = parseCheck(spliced);
    if (!gate.ok) {
      for (const region of ordered) {
        input.noteFailure({
          region,
          path,
          stage: "gate",
          diagnostics: gateDiagnostics(region.start, region.replacement, gate.failure),
        });
      }
      continue;
    }
    const duplicate = duplicateDeclarationDiagnostics(
      payloadSource,
      path,
      payloadCheck.program,
      gate.program,
    );
    if (duplicate !== null) {
      for (const region of ordered) {
        input.noteFailure({ region, path, stage: "duplicate", diagnostics: duplicate });
      }
      continue;
    }
    let formatted: string | null = null;
    try {
      formatted = await formatSource(path, spliced);
    } catch (error) {
      for (const region of ordered) {
        input.noteFailure({
          region,
          path,
          stage: "format",
          diagnostics: formatFailureDiagnostics(path, error),
          formatMessage: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    if (await sameAfterFormatting(path, payloadSource, formatted)) {
      for (const region of ordered) {
        input.noteFailure({ region, path, stage: "no-op", diagnostics: NOOP_DIAGNOSTICS });
      }
      continue;
    }
    writes.push({ path, source: formatted });
  }
  return writes;
}
