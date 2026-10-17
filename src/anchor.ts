import { LexError } from "./lexer";
import { ParseError, Parser } from "./parser";
import type { Node, Program } from "./parser";

export interface ParsedEdit {
  anchor: string;
  replacement: string;
}

const EDITS_EXPECTED = 'expected {"edits":[{"anchor": ..., "replacement": ...}]}';

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

export function parseEditsResponse(content: string): { edits: ParsedEdit[] } {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(content);
  } catch {
    throw new Error(EDITS_EXPECTED);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(EDITS_EXPECTED);
  }
  const edits = (parsed as Record<string, unknown>)["edits"];
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error(EDITS_EXPECTED);
  }
  const result: ParsedEdit[] = edits.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(EDITS_EXPECTED);
    }
    const record = entry as Record<string, unknown>;
    const anchor = record["anchor"];
    const replacement = record["replacement"];
    if (typeof anchor !== "string" || typeof replacement !== "string") {
      throw new Error(EDITS_EXPECTED);
    }
    return { anchor, replacement };
  });
  return { edits: result };
}

export type AnchorFragmentResult =
  | { kind: "parsed"; nodes: Node[] }
  | { kind: "unparseable"; message: string };

const ANCHOR_SHAPE_ERROR = "the anchor does not form a single statement, member, or expression";

interface FragmentAttempt {
  node: Node | null;
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

/**
 * Parses an anchor with wrapper heuristics in priority order: a whole
 * statement, then a single class-body member, then an expression. Each
 * successful wrapper contributes one node; matching tries them in that order.
 */
export function parseAnchorFragment(anchor: string): AnchorFragmentResult {
  const nodes: Node[] = [];
  let firstError: string | null = null;

  const statement = attemptFragment(anchor, (program) =>
    program.body.length === 1 ? (program.body[0] ?? null) : null,
  );
  firstError ??= statement.error;
  if (statement.node !== null) {
    nodes.push(statement.node);
  }

  const member = attemptFragment(`class __Anchor { ${anchor} }`, (program) => {
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

  const expression = attemptFragment(`const __anchor = ${anchor};`, (program) => {
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

  if (nodes.length === 0) {
    return { kind: "unparseable", message: firstError ?? ANCHOR_SHAPE_ERROR };
  }
  return { kind: "parsed", nodes };
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

export type AnchorResult =
  | { kind: "match"; start: number; end: number }
  | { kind: "unparseable"; message: string }
  | { kind: "not-found" }
  | { kind: "ambiguous"; matches: number };

// Walks the AST generically: node objects carry numeric start/end and a string
// kind; containers and arrays are traversed, strings are ignored. Only nodes
// fully inside the symbol range are candidates.
function collectCandidateNodes(value: unknown, symbol: SymbolRange, out: Node[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectCandidateNodes(item, symbol, out);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  const record = value as Record<string, unknown>;
  const start = record["start"];
  const end = record["end"];
  const kind = record["kind"];
  if (typeof start === "number" && typeof end === "number" && typeof kind === "string") {
    if (end <= symbol.start || start >= symbol.end) {
      return;
    }
    if (start >= symbol.start && end <= symbol.end) {
      out.push(record as unknown as Node);
    }
  }
  for (const key of Object.keys(record)) {
    if (key === "source") {
      continue;
    }
    collectCandidateNodes(record[key], symbol, out);
  }
}

export function findAnchor(source: string, symbol: SymbolRange, anchor: string): AnchorResult {
  const fragment = parseAnchorFragment(anchor);
  if (fragment.kind === "unparseable") {
    return fragment;
  }
  const candidates: Node[] = [];
  collectCandidateNodes(new Parser(source).parseProgram(), symbol, candidates);
  for (const node of fragment.nodes) {
    const matches = candidates.filter((candidate) => structurallyEqual(candidate, node));
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only !== undefined) {
      return { kind: "match", start: only.start, end: only.end };
    }
    if (matches.length > 1) {
      return { kind: "ambiguous", matches: matches.length };
    }
  }
  return { kind: "not-found" };
}

export function applyAnchorSplice(
  source: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return source.slice(0, start) + replacement + source.slice(end);
}
