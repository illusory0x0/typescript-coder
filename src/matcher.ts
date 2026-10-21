import { LexError } from "./lexer";
import { ParseError, Parser } from "./parser";
import type { Node, Program } from "./parser";

export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 6 || !trimmed.startsWith("```") || !trimmed.endsWith("```")) {
    return trimmed;
  }
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) {
    return trimmed;
  }
  const inner = trimmed.slice(firstNewline + 1);
  if (!inner.endsWith("```")) {
    return trimmed;
  }
  return inner.slice(0, -3).trim();
}

/**
 * Tolerant JSON object reader shared with the other phases: strips a whole-text
 * fence, then falls back to the first brace-matched object inside surrounding
 * prose. The brace scan understands string literals and escapes.
 */
export function extractJsonObject(text: string): unknown {
  const stripped = stripCodeFences(text);
  try {
    return JSON.parse(stripped);
  } catch {
    // Fall through to scanning for an embedded object.
  }
  const start = stripped.indexOf("{");
  if (start === -1) {
    throw new Error("no JSON object found in the response");
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < stripped.length; index += 1) {
    const char = stripped[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(stripped.slice(start, index + 1));
      }
    }
  }
  throw new Error("no complete JSON object found in the response");
}

export type MatcherFragmentResult =
  | { kind: "parsed"; nodes: Node[]; runs?: Node[][] }
  | { kind: "unparseable"; message: string };

const MATCHER_SHAPE_ERROR =
  "the matcher does not form a single statement, member, expression, or contiguous run of statements";

interface FragmentAttempt {
  node: Node | null;
  error: string | null;
}

interface RunAttempt {
  run: Node[] | null;
  error: string | null;
}

function attemptFragment(
  source: string,
  select: (program: Program) => Node | null,
): FragmentAttempt {
  try {
    const program = new Parser(source).parseProgram();
    return { node: select(program), error: null };
  } catch (error) {
    if (error instanceof ParseError || error instanceof LexError) {
      return {
        node: null,
        error: `${error.message} (line ${error.line}, column ${error.column})`,
      };
    }
    throw error;
  }
}

// A multi-statement fragment (>=2 top-level statements) is kept whole as a run
// alternative rather than reduced to its first statement (#59).
function attemptRunFragment(source: string): RunAttempt {
  try {
    const program = new Parser(source).parseProgram();
    return { run: program.body.length >= 2 ? program.body : null, error: null };
  } catch (error) {
    if (error instanceof ParseError || error instanceof LexError) {
      return {
        run: null,
        error: `${error.message} (line ${error.line}, column ${error.column})`,
      };
    }
    throw error;
  }
}

/**
 * Parses a matcher with wrapper heuristics in priority order: a whole
 * statement, then a single class-body member, then an expression, and finally
 * a contiguous run of statements (>1 top-level statement). Each successful
 * single-node wrapper contributes one node; a multi-statement fragment
 * contributes one run. Matching tries the single nodes first, then the runs.
 */
export function parseMatcherFragment(matcher: string): MatcherFragmentResult {
  const nodes: Node[] = [];
  const runs: Node[][] = [];
  let firstError: string | null = null;

  const statement = attemptFragment(matcher, (program) =>
    program.body.length === 1 ? (program.body[0] ?? null) : null,
  );
  firstError ??= statement.error;
  if (statement.node !== null) {
    nodes.push(statement.node);
  }

  const member = attemptFragment(`class __Matcher { ${matcher} }`, (program) => {
    const declaration = program.body.length === 1 ? (program.body[0] ?? null) : null;
    if (
      declaration === null ||
      declaration.kind !== "ClassDeclaration" ||
      declaration.members.length !== 1
    ) {
      return null;
    }
    return declaration.members[0] ?? null;
  });
  firstError ??= member.error;
  if (member.node !== null) {
    nodes.push(member.node);
  }

  const expression = attemptFragment(`const __matcher = ${matcher};`, (program) => {
    const declaration = program.body.length === 1 ? (program.body[0] ?? null) : null;
    if (
      declaration === null ||
      declaration.kind !== "VariableStatement" ||
      declaration.declarations.length !== 1
    ) {
      return null;
    }
    return declaration.declarations[0]?.initializer ?? null;
  });
  firstError ??= expression.error;
  if (expression.node !== null) {
    nodes.push(expression.node);
  }

  const run = attemptRunFragment(matcher);
  firstError ??= run.error;
  if (run.run !== null) {
    runs.push(run.run);
  }

  if (nodes.length === 0 && runs.length === 0) {
    return { kind: "unparseable", message: firstError ?? MATCHER_SHAPE_ERROR };
  }
  return runs.length === 0 ? { kind: "parsed", nodes } : { kind: "parsed", nodes, runs };
}

const STRUCTURAL_IGNORED_KEYS: ReadonlySet<string> = new Set(["start", "end", "raw", "source"]);

/** Deep structural AST equality ignoring spans, raw text, and trivia. */
export function structurallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!structurallyEqual(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  for (const key of keys) {
    if (STRUCTURAL_IGNORED_KEYS.has(key)) {
      continue;
    }
    if (!structurallyEqual(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }
  return true;
}

export interface SymbolRange {
  start: number;
  end: number;
}

export type MatcherResult =
  | { kind: "match"; start: number; end: number }
  | { kind: "unparseable"; message: string }
  | { kind: "not-found" }
  | { kind: "ambiguous"; matches: number };

interface CandidateNode {
  node: Node;
  /** The array the node was found in; null when an object field holds it. */
  container: readonly unknown[] | null;
  /** The node's slot inside `container`; -1 when `container` is null. */
  index: number;
}

// Walks the AST generically: node objects carry numeric start/end and a string
// kind; containers and arrays are traversed, strings are ignored. Only nodes
// fully inside the symbol range are candidates. Each array's own element nodes
// are recorded before their children, so consecutive siblings sit next to each
// other in the candidate list and a run can be matched positionally.
function nodeRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const start = record["start"];
  const end = record["end"];
  const kind = record["kind"];
  if (typeof start !== "number" || typeof end !== "number" || typeof kind !== "string") {
    return null;
  }
  return record;
}

function insideRange(record: Record<string, unknown>, symbol: SymbolRange): boolean {
  const start = record["start"] as number;
  const end = record["end"] as number;
  if (end <= symbol.start || start >= symbol.end) {
    return false;
  }
  return start >= symbol.start && end <= symbol.end;
}

function collectChildNodes(
  record: Record<string, unknown>,
  symbol: SymbolRange,
  out: CandidateNode[],
): void {
  for (const key of Object.keys(record)) {
    if (key === "source") {
      continue;
    }
    collectCandidateNodes(record[key], symbol, out);
  }
}

function collectCandidateNodes(value: unknown, symbol: SymbolRange, out: CandidateNode[]): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const record = nodeRecord(value[index]);
      if (record !== null && insideRange(record, symbol)) {
        out.push({ node: record as unknown as Node, container: value, index });
      }
    }
    for (const item of value) {
      if (Array.isArray(item)) {
        collectCandidateNodes(item, symbol, out);
        continue;
      }
      const record = nodeRecord(item);
      if (record !== null) {
        collectChildNodes(record, symbol, out);
      }
    }
    return;
  }
  const record = nodeRecord(value);
  if (record === null) {
    return;
  }
  if (insideRange(record, symbol)) {
    out.push({ node: record as unknown as Node, container: null, index: -1 });
  }
  collectChildNodes(record, symbol, out);
}

/**
 * Every structural span a matcher resolves to inside `symbol` (#108): the
 * enumeration behind `findMatcher`, so the cascade can filter the candidate set
 * with `pick` instead of returning on the first hit.
 *
 * For the **first** fragment node (in `parseMatcherFragment`'s priority order)
 * with at least one structural match, all of its spans are returned; else the
 * runs are tried the same way; else `{ kind: "matches", spans: [] }`. An
 * unparseable fragment is reported as `unparseable`.
 */
export type MatcherSpans =
  | { kind: "matches"; spans: { start: number; end: number }[] }
  | { kind: "unparseable"; message: string };

export function findMatcherMatches(
  source: string,
  symbol: SymbolRange,
  matcher: string,
): MatcherSpans {
  const fragment = parseMatcherFragment(matcher);
  if (fragment.kind === "unparseable") {
    return fragment;
  }
  const candidates: CandidateNode[] = [];
  collectCandidateNodes(new Parser(source).parseProgram(), symbol, candidates);
  for (const node of fragment.nodes) {
    const matches = candidates.filter((candidate) => structurallyEqual(candidate.node, node));
    if (matches.length > 0) {
      return {
        kind: "matches",
        spans: matches.map((candidate) => ({
          start: candidate.node.start,
          end: candidate.node.end,
        })),
      };
    }
  }
  for (const run of fragment.runs ?? []) {
    // A run matches only at consecutive sibling slots of one container; the
    // reported span is the matched source range, not the fragment's own
    // parsing offsets.
    const spans: { start: number; end: number }[] = [];
    for (let position = 0; position < candidates.length; position += 1) {
      const base = candidates[position];
      if (base === undefined || base.container === null) {
        continue;
      }
      let runMatches = true;
      for (let offset = 0; offset < run.length; offset += 1) {
        const candidate = candidates[position + offset];
        if (
          candidate === undefined ||
          candidate.container !== base.container ||
          candidate.index !== base.index + offset ||
          !structurallyEqual(candidate.node, run[offset])
        ) {
          runMatches = false;
          break;
        }
      }
      if (!runMatches) {
        continue;
      }
      const last = candidates[position + run.length - 1];
      if (last !== undefined) {
        spans.push({ start: base.node.start, end: last.node.end });
      }
    }
    if (spans.length > 0) {
      return { kind: "matches", spans };
    }
  }
  return { kind: "matches", spans: [] };
}

/**
 * Regex matchers compile with the `g` and `m` flags and no user-supplied flags:
 * `docs/edit-protocol.md` §2 admits no flags, and the internal `m` makes the
 * defined anchoring useful — `^` and `$` anchor at line boundaries inside the
 * scanned source (the declaration span), not just the file's start/end. `.`
 * does not span newlines (no `s` flag). The scan stays within `symbol`.
 *
 * Two bounds keep a hostile or accidental pattern from wedging the loop:
 * `MAX_REGEX_PATTERN_LENGTH` rejects an over-long pattern before compilation,
 * and `MAX_REGEX_MATCHES` stops the enumeration after a pathological number of
 * hits. Both surface as `invalid`, which the cascade maps to `regex-invalid`. A
 * single catastrophic-backtracking `exec` cannot be interrupted in-process; the
 * pattern-length cap plus the caller's bounded target are the practical limit.
 */
export const MAX_REGEX_PATTERN_LENGTH = 1024;
export const MAX_REGEX_MATCHES = 1000;

export type RegexMatches =
  | { kind: "matches"; spans: { start: number; end: number }[] }
  | { kind: "invalid"; message: string };

/**
 * Enumerate every regex match whose span lies inside `symbol` (#109): the
 * text-matching sibling of `findMatcherMatches`. A malformed pattern, an
 * over-long pattern, or a pattern that matches absurdly many times is
 * `invalid`; otherwise every fully-contained match is returned in document
 * order. A **zero-width** match (`start === end`) is a valid span — an
 * insertion point — and counts once at each position, per the engine's `g`-flag
 * rule; the scan steps `lastIndex` forward itself so an engine that leaves it
 * put (Bun does) cannot loop forever.
 */
export function findRegexMatches(
  source: string,
  symbol: SymbolRange,
  pattern: string,
): RegexMatches {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return {
      kind: "invalid",
      message: `the pattern is longer than ${MAX_REGEX_PATTERN_LENGTH} characters`,
    };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "gm");
  } catch (error) {
    return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
  const spans: { start: number; end: number }[] = [];
  regex.lastIndex = symbol.start;
  for (;;) {
    const match = regex.exec(source);
    if (match === null) {
      break;
    }
    const start = match.index;
    if (start > symbol.end) {
      break;
    }
    const end = start + match[0].length;
    if (start >= symbol.start && end <= symbol.end) {
      spans.push({ start, end });
      if (spans.length > MAX_REGEX_MATCHES) {
        return {
          kind: "invalid",
          message: `the pattern matched more than ${MAX_REGEX_MATCHES} times inside the symbol`,
        };
      }
    }
    if (match[0].length === 0 && regex.lastIndex === start) {
      regex.lastIndex = start + 1;
    }
  }
  return { kind: "matches", spans };
}

export function findMatcher(source: string, symbol: SymbolRange, matcher: string): MatcherResult {
  const found = findMatcherMatches(source, symbol, matcher);
  if (found.kind === "unparseable") {
    return found;
  }
  if (found.spans.length === 1) {
    const only = found.spans[0];
    if (only !== undefined) {
      return { kind: "match", start: only.start, end: only.end };
    }
  }
  if (found.spans.length > 1) {
    return { kind: "ambiguous", matches: found.spans.length };
  }
  return { kind: "not-found" };
}

export function applyMatcherSplice(
  source: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return source.slice(0, start) + replacement + source.slice(end);
}
