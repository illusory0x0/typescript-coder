import { describe, expect, test } from "bun:test";
import {
  applyAnchorSplice,
  extractJsonObject,
  findAnchor,
  parseAnchorFragment,
  parseEditsResponse,
  structurallyEqual,
} from "./anchor";
import type { AnchorFragmentResult, SymbolRange } from "./anchor";
import { buildIndexTolerant, findDefinition } from "./utility";

describe("extractJsonObject", () => {
  test("parses plain JSON", () => {
    expect(extractJsonObject('{"edits":[]}')).toEqual({ edits: [] });
  });

  test("strips a whole-text markdown fence", () => {
    expect(extractJsonObject('```json\n{"edits":[{"anchor":"a","replacement":"b"}]}\n```')).toEqual(
      { edits: [{ anchor: "a", replacement: "b" }] },
    );
  });

  test("scans an object out of surrounding prose", () => {
    const content =
      'Sure, here is the edit:\n```json\n{"edits":[{"anchor":"return 1;","replacement":"return 2;"}]}\n```\nDone.';
    expect(extractJsonObject(content)).toEqual({
      edits: [{ anchor: "return 1;", replacement: "return 2;" }],
    });
  });

  test("brace-matches nested objects and string literals with braces and escapes", () => {
    const content =
      'prefix {"edits":[{"anchor":"if (x) { return \\"}\\"; }","replacement":"y"}]} suffix';
    expect(extractJsonObject(content)).toEqual({
      edits: [{ anchor: 'if (x) { return "}"; }', replacement: "y" }],
    });
  });

  test("throws when no object exists", () => {
    expect(() => extractJsonObject("plain text")).toThrow("no JSON object found");
    expect(() => extractJsonObject('{"unterminated":')).toThrow(
      "no complete JSON object found",
    );
  });
});

describe("parseEditsResponse", () => {
  test("parses a single plain edit", () => {
    expect(parseEditsResponse('{"edits":[{"anchor":"return 1;","replacement":"return 2;"}]}')).toEqual(
      { edits: [{ anchor: "return 1;", replacement: "return 2;" }] },
    );
  });

  test("tolerates a fenced object", () => {
    const content = '```json\n{"edits":[{"anchor":"a","replacement":""}]}\n```';
    expect(parseEditsResponse(content)).toEqual({ edits: [{ anchor: "a", replacement: "" }] });
  });

  test("tolerates prose around the object", () => {
    const content = 'Here you go: {"edits":[{"anchor":"a","replacement":"b"}]} hope it helps';
    expect(parseEditsResponse(content)).toEqual({ edits: [{ anchor: "a", replacement: "b" }] });
  });

  test("ignores extra keys", () => {
    const content = '{"edits":[{"anchor":"a","replacement":"b","why":"x"}],"note":"n"}';
    expect(parseEditsResponse(content)).toEqual({ edits: [{ anchor: "a", replacement: "b" }] });
  });

  test("parses multiple edits in order", () => {
    const content = '{"edits":[{"anchor":"a","replacement":"b"},{"anchor":"c","replacement":"d"}]}';
    expect(parseEditsResponse(content)).toEqual({
      edits: [
        { anchor: "a", replacement: "b" },
        { anchor: "c", replacement: "d" },
      ],
    });
  });

  test("rejects missing or wrongly typed fields", () => {
    expect(() => parseEditsResponse("{}")).toThrow('expected {"edits"');
    expect(() => parseEditsResponse('{"edits":[]}')).toThrow('expected {"edits"');
    expect(() => parseEditsResponse('{"edits":[{"anchor":"a"}]}')).toThrow('expected {"edits"');
    expect(() => parseEditsResponse('{"edits":[{"anchor":1,"replacement":"b"}]}')).toThrow(
      'expected {"edits"',
    );
    expect(() => parseEditsResponse('{"edits":[{"replacement":"b"}]}')).toThrow(
      'expected {"edits"',
    );
  });

  test("rejects a malformed entry anywhere in the array", () => {
    expect(() =>
      parseEditsResponse('{"edits":[{"anchor":"a","replacement":"b"},{"anchor":"c"}]}'),
    ).toThrow('expected {"edits"');
    expect(() =>
      parseEditsResponse('{"edits":[{"anchor":"a","replacement":"b"},5]}'),
    ).toThrow('expected {"edits"');
    expect(() =>
      parseEditsResponse('{"edits":["nope",{"anchor":"a","replacement":"b"}]}'),
    ).toThrow('expected {"edits"');
  });

  test("rejects non-object JSON", () => {
    expect(() => parseEditsResponse("[]")).toThrow('expected {"edits"');
    expect(() => parseEditsResponse('"nope"')).toThrow('expected {"edits"');
    expect(() => parseEditsResponse("not json at all")).toThrow('expected {"edits"');
  });
});

describe("parseAnchorFragment", () => {
  function kinds(result: AnchorFragmentResult): string[] {
    if (result.kind !== "parsed") {
      throw new Error(`expected a parsed fragment, got ${result.message}`);
    }
    return result.nodes.map((node) => (node as unknown as { kind: string }).kind);
  }

  test("parses a statement", () => {
    expect(kinds(parseAnchorFragment("return 1;"))).toEqual(["ReturnStatement"]);
  });

  test("parses a class member", () => {
    expect(kinds(parseAnchorFragment('render(): string {\n  return "x";\n}'))).toContain(
      "MethodDeclaration",
    );
    expect(kinds(parseAnchorFragment("count = 1;"))).toContain("PropertyDeclaration");
  });

  test("parses a sub-expression", () => {
    expect(kinds(parseAnchorFragment("x + 1"))).toContain("BinaryExpression");
  });

  test("reports unparseable fragments with a message", () => {
    const result = parseAnchorFragment("if (");
    expect(result.kind).toBe("unparseable");
    if (result.kind === "unparseable") {
      expect(result.message).not.toBe("");
    }
  });
});

describe("structurallyEqual", () => {
  test("ignores spans and raw text", () => {
    const left = { kind: "StringLiteral", value: "a", raw: '"a"', start: 0, end: 3 };
    const right = { kind: "StringLiteral", value: "a", raw: "'a'", start: 40, end: 43 };
    expect(structurallyEqual(left, right)).toBe(true);
  });

  test("compares identifiers by exact name", () => {
    expect(structurallyEqual({ kind: "Identifier", name: "x" }, { kind: "Identifier", name: "x" })).toBe(
      true,
    );
    expect(structurallyEqual({ kind: "Identifier", name: "x" }, { kind: "Identifier", name: "y" })).toBe(
      false,
    );
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

describe("findAnchor", () => {
  test("matches an exact nested statement and only inside the symbol", () => {
    const range = symbolRange(HELPER, "answer", "function");
    const start = HELPER.indexOf("return 1;", range.start);
    const result = findAnchor(HELPER, range, "return 1;");
    expect(result).toEqual({ kind: "match", start, end: start + "return 1;".length });
    if (result.kind === "match") {
      expect(HELPER.slice(result.start, result.end)).toBe("return 1;");
    }
  });

  test("does not match a structurally equal node elsewhere in the file", () => {
    const range = symbolRange(HELPER, "answer", "function");
    expect(findAnchor(HELPER, range, "const x = 1;")).toEqual({ kind: "not-found" });
  });

  test("matches the whole symbol as the prompt shows it", () => {
    const range = symbolRange(HELPER, "answer", "function");
    const anchor = HELPER.slice(range.start, range.end);
    expect(findAnchor(HELPER, range, anchor)).toEqual({
      kind: "match",
      start: range.start,
      end: range.end,
    });
  });

  test("ignores whitespace and comments in the anchor", () => {
    const range = symbolRange(HELPER, "answer", "function");
    const start = HELPER.indexOf("return 1;", range.start);
    const result = findAnchor(HELPER, range, "return   /* keep */   1;");
    expect(result).toEqual({ kind: "match", start, end: start + "return 1;".length });
  });

  test("reports identifier mismatches as not-found", () => {
    const range = symbolRange(HELPER, "answer", "function");
    expect(findAnchor(HELPER, range, "return 2;")).toEqual({ kind: "not-found" });
  });

  test("reports duplicates as ambiguous", () => {
    const source = ["function twice(): number {", "  return 1;", "  return 1;", "}", ""].join("\n");
    const range = symbolRange(source, "twice", "function");
    expect(findAnchor(source, range, "return 1;")).toEqual({ kind: "ambiguous", matches: 2 });
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
    const result = findAnchor(source, range, "x + 1");
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(source.slice(result.start, result.end)).toBe("x + 1");
    }
  });

  test("matches a method fragment inside a class", () => {
    const source = [
      "export class Widget {",
      "  render(): string {",
      "    return \"x\";",
      "  }",
      "}",
      "",
    ].join("\n");
    const range = symbolRange(source, "Widget", "class");
    const anchor = ["render(): string {", '    return "x";', "  }"].join("\n");
    const result = findAnchor(source, range, anchor);
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(source.slice(result.start, result.end)).toBe(anchor);
    }
  });

  test("reports unparseable anchors", () => {
    const range = symbolRange(HELPER, "answer", "function");
    const result = findAnchor(HELPER, range, "if (");
    expect(result.kind).toBe("unparseable");
  });
});

describe("applyAnchorSplice", () => {
  test("replaces the matched range", () => {
    expect(applyAnchorSplice("abcdef", 1, 3, "XY")).toBe("aXYdef");
  });

  test("supports deleting the matched range with an empty replacement", () => {
    const source = "function f() {\n  return 1;\n}\n";
    const result = findAnchor(source, symbolRange(source, "f", "function"), "return 1;");
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(applyAnchorSplice(source, result.start, result.end, "")).toBe(
        "function f() {\n  \n}\n",
      );
    }
  });
});
