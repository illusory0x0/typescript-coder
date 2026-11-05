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

/** One owner-context wrapper attempted by `parseMatcherFragment`. */
export interface MatcherContextAttempt {
  /** The model-facing owner context, in priority order. */
  context: string;
  /** The wrapper's parse error, or null when the wrapper parsed. */
  error: string | null;
}

export type MatcherFragmentResult =
  | {
      kind: "parsed";
      nodes: Node[];
      runs?: Node[][];
      /** Every wrapper attempted, in priority order. */
      contexts: MatcherContextAttempt[];
    }
  | {
      kind: "unparseable";
      message: string;
      /** Every wrapper attempted, in priority order; the context metadata. */
      contexts: MatcherContextAttempt[];
    };

const MATCHER_CONTEXTS = [
  "top-level statement",
  "class member",
  "interface/type member",
  "object-literal member",
  "function-body statement",
  "loop body",
  "switch case",
  "generator body",
  "async body",
  "type expression",
  "expression",
  "contiguous statement run",
] as const;

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

function firstBodyStatement(
  source: string,
  select: (program: Program) => Node[] | null,
): FragmentAttempt {
  return attemptFragment(source, (program) => {
    const body = select(program);
    return body !== null && body.length === 1 ? (body[0] ?? null) : null;
  });
}

function singleDeclaration(program: Program, kind: string): Record<string, unknown> | null {
  const declaration = program.body.length === 1 ? (program.body[0] ?? null) : null;
  if (declaration === null || declaration.kind !== kind) {
    return null;
  }
  return declaration as unknown as Record<string, unknown>;
}

function unparseableMessage(matcher: string, contexts: readonly MatcherContextAttempt[]): string {
  const firstError = contexts.find((attempt) => attempt.error !== null)?.error;
  const detail = firstError === null || firstError === undefined ? MATCHER_SHAPE_ERROR : firstError;
  const decoratorNote = matcher.trimStart().startsWith("@")
    ? "; a standalone decorator is not a structural matcher owner: select its class or member owner and use a snippet that includes the member, or use `/regex/` or `pick`"
    : "";
  return [
    `the matcher does not parse in any supported owner context (${MATCHER_CONTEXTS.join(", ")})`,
    detail,
    `use \`/regex/\` or a \`pick\` range when no structural owner context fits${decoratorNote}`,
  ].join("; ");
}

/**
 * Parses a matcher with owner-context wrappers in priority order: a whole
 * top-level statement, a single class-body member, an interface/type-literal
 * member, an object-literal member, a function-body statement, a loop body, a
 * switch case, a generator body, an async body, a type expression, an
 * expression, and finally a contiguous run of top-level statements (>1
 * statement). Each successful single-node wrapper contributes one node; a
 * multi-statement fragment contributes one run. Matching tries the single nodes
 * first, then the runs, and returns the first context with at least one match
 * (`findMatcherMatches`), never a silent first match within that context.
 *
 * The wrappers are owner contexts, not semantic validation: this parser is
 * permissive about `return`/`break` at top level, so several contexts can yield
 * the same node kind. The context list is diagnostic metadata; the node kinds
 * decide what can structurally match.
 */
export function parseMatcherFragment(matcher: string): MatcherFragmentResult {
  const nodes: Node[] = [];
  const runs: Node[][] = [];
  const contexts: MatcherContextAttempt[] = [];

  const record = (attempt: FragmentAttempt): void => {
    contexts.push({
      context: MATCHER_CONTEXTS[contexts.length] ?? "additional context",
      error: attempt.error,
    });
    if (
      attempt.node !== null &&
      !nodes.some((existing) => structurallyEqual(existing, attempt.node))
    ) {
      nodes.push(attempt.node);
    }
  };

  record(
    attemptFragment(matcher, (program) =>
      program.body.length === 1 ? (program.body[0] ?? null) : null,
    ),
  );

  record(
    attemptFragment(`class __Matcher { ${matcher} }`, (program) => {
      const declaration = singleDeclaration(program, "ClassDeclaration");
      const members = declaration?.["members"];
      return Array.isArray(members) && members.length === 1
        ? ((members[0] as Node | undefined) ?? null)
        : null;
    }),
  );

  record(
    attemptFragment(`interface __Matcher { ${matcher} }`, (program) => {
      const declaration = singleDeclaration(program, "InterfaceDeclaration");
      const members = declaration?.["members"];
      return Array.isArray(members) && members.length === 1
        ? ((members[0] as Node | undefined) ?? null)
        : null;
    }),
  );

  record(
    attemptFragment(`const __matcher = { ${matcher} };`, (program) => {
      const declaration = singleDeclaration(program, "VariableStatement");
      const declarations = declaration?.["declarations"];
      if (!Array.isArray(declarations) || declarations.length !== 1) {
        return null;
      }
      const declarator = declarations[0] as { initializer?: Node | null } | undefined;
      const initializer = declarator?.initializer;
      if (
        initializer === null ||
        initializer === undefined ||
        (initializer as unknown as { kind?: string }).kind !== "ObjectLiteral"
      ) {
        return null;
      }
      const properties = (initializer as unknown as { properties: unknown }).properties;
      return Array.isArray(properties) && properties.length === 1
        ? ((properties[0] as Node | undefined) ?? null)
        : null;
    }),
  );

  record(
    firstBodyStatement(`function __matcher() { ${matcher} }`, (program) => {
      const declaration = singleDeclaration(program, "FunctionDeclaration");
      const body = declaration?.["body"] as { body?: Node[] } | undefined;
      return body?.body ?? null;
    }),
  );

  record(
    firstBodyStatement(`while (true) { ${matcher} }`, (program) => {
      const declaration = singleDeclaration(program, "WhileStatement");
      const body = declaration?.["body"] as { body?: Node[] } | undefined;
      return body?.body ?? null;
    }),
  );

  record(
    attemptFragment(`switch (0) { case 0: ${matcher} }`, (program) => {
      const declaration = singleDeclaration(program, "SwitchStatement");
      const cases = declaration?.["cases"];
      if (!Array.isArray(cases) || cases.length !== 1) {
        return null;
      }
      const onlyCase = cases[0] as { consequent?: Node[] } | undefined;
      const consequent = onlyCase?.consequent;
      return Array.isArray(consequent) && consequent.length === 1
        ? ((consequent[0] as Node | undefined) ?? null)
        : null;
    }),
  );

  record(
    firstBodyStatement(`function* __matcher() { ${matcher} }`, (program) => {
      const declaration = singleDeclaration(program, "FunctionDeclaration");
      if (declaration?.["generator"] !== true) {
        return null;
      }
      const body = declaration["body"] as { body?: Node[] } | undefined;
      return body?.body ?? null;
    }),
  );

  record(
    firstBodyStatement(`async function __matcher() { ${matcher} }`, (program) => {
      const declaration = singleDeclaration(program, "FunctionDeclaration");
      if (declaration?.["async"] !== true) {
        return null;
      }
      const body = declaration["body"] as { body?: Node[] } | undefined;
      return body?.body ?? null;
    }),
  );

  record(
    attemptFragment(`type __Matcher = ${matcher};`, (program) => {
      const declaration = singleDeclaration(program, "TypeAliasDeclaration");
      return (declaration?.["type"] as Node | undefined) ?? null;
    }),
  );

  record(
    attemptFragment(`const __matcher = ${matcher};`, (program) => {
      const declaration = singleDeclaration(program, "VariableStatement");
      const declarations = declaration?.["declarations"];
      if (!Array.isArray(declarations) || declarations.length !== 1) {
        return null;
      }
      const declarator = declarations[0] as { initializer?: Node | null } | undefined;
      return declarator?.initializer ?? null;
    }),
  );

  const run = attemptRunFragment(matcher);
  contexts.push({
    context: MATCHER_CONTEXTS[contexts.length] ?? "additional context",
    error: run.error,
  });
  if (run.run !== null) {
    runs.push(run.run);
  }

  if (nodes.length === 0 && runs.length === 0) {
    return { kind: "unparseable", message: unparseableMessage(matcher, contexts), contexts };
  }
  return runs.length === 0
    ? { kind: "parsed", nodes, contexts }
    : { kind: "parsed", nodes, runs, contexts };
}

const STRUCTURAL_IGNORED_KEYS: ReadonlySet<string> = new Set(["start", "end", "raw"]);

/**
 * True when a structural key is trivia rather than syntax. `source` is ignored
 * only when both values are strings: `Program.source` is the raw file text, but
 * an `ImportDeclaration`/`ExportNamedDeclaration`'s `source` is the module
 * specifier node, which must take part in structural equality.
 */
function ignoredStructuralKey(key: string, left: unknown, right: unknown): boolean {
  if (STRUCTURAL_IGNORED_KEYS.has(key)) {
    return true;
  }
  return key === "source" && typeof left === "string" && typeof right === "string";
}

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
    if (ignoredStructuralKey(key, leftRecord[key], rightRecord[key])) {
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
  | { kind: "ambiguous"; matches: number; spans: { start: number; end: number }[] };

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
 * with at least one structural match, all of its distinct spans are returned;
 * else the runs are tried the same way; else `{ kind: "matches", spans: [] }`.
 * Identical spans reached through more than one wrapper or more than one AST
 * field are deduplicated, so they are one candidate, not an ambiguity. An
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
      const seen = new Set<string>();
      const spans: { start: number; end: number }[] = [];
      for (const candidate of matches) {
        const key = `${candidate.node.start}:${candidate.node.end}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        spans.push({ start: candidate.node.start, end: candidate.node.end });
      }
      return { kind: "matches", spans };
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
    return { kind: "ambiguous", matches: found.spans.length, spans: found.spans };
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
