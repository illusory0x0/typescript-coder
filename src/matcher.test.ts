import { describe, expect, test } from "bun:test";
import {
  applyMatcherSplice,
  extractJsonObject,
  findMatcher,
  parseMatcherFragment,
  structurallyEqual,
} from "./matcher";
import type { MatcherFragmentResult, SymbolRange } from "./matcher";
import { buildIndexTolerant, findDefinition } from "./utility";

describe("extractJsonObject", () => {
  test("parses plain JSON", () => {
    expect(extractJsonObject('{"symbol":"answer"}')).toEqual({ symbol: "answer" });
  });

  test("strips a whole-text markdown fence", () => {
    expect(
      extractJsonObject('```json\n{"path":"src/a.ts","symbol":"answer","kind":"function"}\n```'),
    ).toEqual({ path: "src/a.ts", symbol: "answer", kind: "function" });
  });

  test("scans an object out of surrounding prose", () => {
    const content =
      'Sure, here is the edit:\n```json\n{"symbol":"answer","replacement":"return 2;"}\n```\nDone.';
    expect(extractJsonObject(content)).toEqual({
      symbol: "answer",
      replacement: "return 2;",
    });
  });

  test("brace-matches nested objects and string literals with braces and escapes", () => {
    const content =
      'prefix {"symbol":"answer","matcher":"if (x) { return \\"}\\"; }","replacement":"y"} suffix';
    expect(extractJsonObject(content)).toEqual({
      symbol: "answer",
      matcher: 'if (x) { return "}"; }',
      replacement: "y",
    });
  });

  test("throws when no object exists", () => {
    expect(() => extractJsonObject("plain text")).toThrow("no JSON object found");
    expect(() => extractJsonObject('{"unterminated":')).toThrow("no complete JSON object found");
  });
});

describe("parseMatcherFragment", () => {
  function kinds(result: MatcherFragmentResult): string[] {
    if (result.kind !== "parsed") {
      throw new Error(`expected a parsed fragment, got ${result.message}`);
    }
    return result.nodes.map((node) => (node as unknown as { kind: string }).kind);
  }

  test("parses a statement", () => {
    expect(kinds(parseMatcherFragment("return 1;"))).toEqual(["ReturnStatement"]);
  });

  test("parses a class member", () => {
    expect(kinds(parseMatcherFragment('render(): string {\n  return "x";\n}'))).toContain(
      "MethodDeclaration",
    );
    expect(kinds(parseMatcherFragment("count = 1;"))).toContain("PropertyDeclaration");
  });

  test("parses a sub-expression", () => {
    expect(kinds(parseMatcherFragment("x + 1"))).toContain("BinaryExpression");
  });

  test("reports unparseable fragments with a message", () => {
    const result = parseMatcherFragment("if (");
    expect(result.kind).toBe("unparseable");
    if (result.kind === "unparseable") {
      expect(result.message).not.toBe("");
    }
  });

  test("records a multi-statement fragment as a run alternative", () => {
    const result = parseMatcherFragment("const a = 1;\nconst b = 2;\nreturn a;");
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") {
      return;
    }
    expect(result.nodes).toEqual([]);
    const runKinds = result.runs?.map((run) =>
      run.map((node) => (node as unknown as { kind: string }).kind),
    );
    expect(runKinds).toEqual([["VariableStatement", "VariableStatement", "ReturnStatement"]]);
  });

  test("keeps a single statement as a node without a run", () => {
    const result = parseMatcherFragment("return 1;");
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") {
      return;
    }
    expect(result.runs).toBeUndefined();
  });
});

describe("structurallyEqual", () => {
  test("ignores spans and raw text", () => {
    const left = { kind: "StringLiteral", value: "a", raw: '"a"', start: 0, end: 3 };
    const right = { kind: "StringLiteral", value: "a", raw: "'a'", start: 40, end: 43 };
    expect(structurallyEqual(left, right)).toBe(true);
  });

  test("compares identifiers by exact name", () => {
    expect(
      structurallyEqual({ kind: "Identifier", name: "x" }, { kind: "Identifier", name: "x" }),
    ).toBe(true);
    expect(
      structurallyEqual({ kind: "Identifier", name: "x" }, { kind: "Identifier", name: "y" }),
    ).toBe(false);
  });

  test("compares arrays elementwise and detects kind mismatches", () => {
    expect(structurallyEqual([1, 2], [1, 2])).toBe(true);
    expect(structurallyEqual([1, 2], [2, 1])).toBe(false);
    expect(structurallyEqual({ kind: "A" }, { kind: "B" })).toBe(false);
  });
});

const HELPER = [
  "export function answer(): number {",
  "  return 1;",
  "}",
  "",
  "export function other(): number {",
  "  const x = 1;",
  "  return x;",
  "}",
  "",
].join("\n");

function symbolRange(source: string, name: string, kind: string): SymbolRange {
  const { index } = buildIndexTolerant([{ path: "a.ts", source }]);
  const entry = findDefinition(index, { path: "a.ts", name, kind });
  if (entry === null) {
    throw new Error(`no symbol ${kind} ${name}`);
  }
  return entry.node;
}

describe("findMatcher", () => {
  test("matches an exact nested statement and only inside the symbol", () => {
    const range = symbolRange(HELPER, "answer", "function");
    const start = HELPER.indexOf("return 1;", range.start);
    const result = findMatcher(HELPER, range, "return 1;");
    expect(result).toEqual({ kind: "match", start, end: start + "return 1;".length });
    if (result.kind === "match") {
      expect(HELPER.slice(result.start, result.end)).toBe("return 1;");
    }
  });

  test("does not match a structurally equal node elsewhere in the file", () => {
    const range = symbolRange(HELPER, "answer", "function");
    expect(findMatcher(HELPER, range, "const x = 1;")).toEqual({ kind: "not-found" });
  });

  test("matches the whole symbol as the prompt shows it", () => {
    const range = symbolRange(HELPER, "answer", "function");
    const matcher = HELPER.slice(range.start, range.end);
    expect(findMatcher(HELPER, range, matcher)).toEqual({
      kind: "match",
      start: range.start,
      end: range.end,
    });
  });

  test("ignores whitespace and comments in the matcher", () => {
    const range = symbolRange(HELPER, "answer", "function");
    const start = HELPER.indexOf("return 1;", range.start);
    const result = findMatcher(HELPER, range, "return   /* keep */   1;");
    expect(result).toEqual({ kind: "match", start, end: start + "return 1;".length });
  });

  test("reports identifier mismatches as not-found", () => {
    const range = symbolRange(HELPER, "answer", "function");
    expect(findMatcher(HELPER, range, "return 2;")).toEqual({ kind: "not-found" });
  });

  test("reports duplicates as ambiguous", () => {
    const source = ["function twice(): number {", "  return 1;", "  return 1;", "}", ""].join("\n");
    const range = symbolRange(source, "twice", "function");
    expect(findMatcher(source, range, "return 1;")).toEqual({ kind: "ambiguous", matches: 2 });
  });

  test("matches a sub-expression fragment", () => {
    const source = [
      "export function f(x: number): number {",
      "  const y = x + 1;",
      "  return y;",
      "}",
      "",
    ].join("\n");
    const range = symbolRange(source, "f", "function");
    const result = findMatcher(source, range, "x + 1");
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(source.slice(result.start, result.end)).toBe("x + 1");
    }
  });

  test("matches a method fragment inside a class", () => {
    const source = [
      "export class Widget {",
      "  render(): string {",
      '    return "x";',
      "  }",
      "}",
      "",
    ].join("\n");
    const range = symbolRange(source, "Widget", "class");
    const matcher = ["render(): string {", '    return "x";', "  }"].join("\n");
    const result = findMatcher(source, range, matcher);
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(source.slice(result.start, result.end)).toBe(matcher);
    }
  });

  test("reports unparseable matchers", () => {
    const range = symbolRange(HELPER, "answer", "function");
    const result = findMatcher(HELPER, range, "if (");
    expect(result.kind).toBe("unparseable");
  });

  test("matches a run of consecutive statements uniquely with the source span", () => {
    const source = [
      "export function f(): number {",
      "  const a = 1;",
      "  const b = 2;",
      "  return a + b;",
      "}",
      "",
    ].join("\n");
    const range = symbolRange(source, "f", "function");
    const matcher = ["const a = 1;", "  const b = 2;", "  return a + b;"].join("\n");
    const start = source.indexOf("const a = 1;");
    const end = source.indexOf("return a + b;") + "return a + b;".length;
    const result = findMatcher(source, range, matcher);
    expect(result).toEqual({ kind: "match", start, end });
    if (result.kind === "match") {
      expect(source.slice(result.start, result.end)).toBe(matcher);
    }
  });

  test("does not match a run broken by a non-matching sibling", () => {
    const source = [
      "export function f(): number {",
      "  const a = 1;",
      "  const b = 2;",
      "  const c = 3;",
      "  return a;",
      "}",
      "",
    ].join("\n");
    const range = symbolRange(source, "f", "function");
    const matcher = ["const a = 1;", "  const b = 9;", "  const c = 3;"].join("\n");
    expect(findMatcher(source, range, matcher)).toEqual({ kind: "not-found" });
  });

  test("reports two identical runs as ambiguous", () => {
    const source = [
      "export function f(): number {",
      "  const a = 1;",
      "  const b = 2;",
      "  return a;",
      "  const a = 1;",
      "  const b = 2;",
      "  return a;",
      "}",
      "",
    ].join("\n");
    const range = symbolRange(source, "f", "function");
    const matcher = ["const a = 1;", "  const b = 2;", "  return a;"].join("\n");
    expect(findMatcher(source, range, matcher)).toEqual({ kind: "ambiguous", matches: 2 });
  });

  test("does not match a run across a container boundary", () => {
    const source = [
      "export function f(): number {",
      "  if (true) {",
      "    const a = 1;",
      "  }",
      "  return a;",
      "}",
      "",
    ].join("\n");
    const range = symbolRange(source, "f", "function");
    const matcher = ["const a = 1;", "  return a;"].join("\n");
    expect(findMatcher(source, range, matcher)).toEqual({ kind: "not-found" });
  });
});

describe("applyMatcherSplice", () => {
  test("replaces the matched range", () => {
    expect(applyMatcherSplice("abcdef", 1, 3, "XY")).toBe("aXYdef");
  });

  test("supports deleting the matched range with an empty replacement", () => {
    const source = "function f() {\n  return 1;\n}\n";
    const result = findMatcher(source, symbolRange(source, "f", "function"), "return 1;");
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(applyMatcherSplice(source, result.start, result.end, "")).toBe(
        "function f() {\n  \n}\n",
      );
    }
  });
});
