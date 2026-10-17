import { describe, expect, test } from "bun:test";
import { parseJson } from "./json";
import type { JsonValue } from "./json";

function parse(text: string): JsonValue {
  return parseJson(text);
}

describe("json-parser literals", () => {
  test("null, true, and false", () => {
    expect(parse("null")).toBeNull();
    expect(parse("true")).toBe(true);
    expect(parse("false")).toBe(false);
  });

  test("numbers", () => {
    expect(parse("42")).toBe(42);
    expect(parse("-3.5")).toBe(-3.5);
    expect(parse("1e3")).toBe(1000);
    expect(parse("2.5E-2")).toBe(0.025);
  });
});

describe("json-parser strings", () => {
  test("empty string", () => {
    expect(parse('""')).toBe("");
  });

  test("simple string", () => {
    expect(parse('"hello"')).toBe("hello");
  });

  test("escape sequences", () => {
    expect(parse('"\\""')).toBe('"');
    expect(parse('"\\\\"')).toBe("\\");
    expect(parse('"\\/"')).toBe("/");
    expect(parse('"\\b"')).toBe("\b");
    expect(parse('"\\f"')).toBe("\f");
    expect(parse('"\\n"')).toBe("\n");
    expect(parse('"\\r"')).toBe("\r");
    expect(parse('"\\t"')).toBe("\t");
  });

  test("unicode escape", () => {
    expect(parse('"\\u0041"')).toBe("A");
  });
});

describe("json-parser arrays and objects", () => {
  test("empty array", () => {
    expect(parse("[]")).toEqual([]);
  });

  test("array of literals", () => {
    expect(parse("[1, true, null]")).toEqual([1, true, null]);
  });

  test("nested arrays", () => {
    expect(parse("[1, [2, [3, null]]]")).toEqual([1, [2, [3, null]]]);
  });

  test("empty object", () => {
    expect(parse("{}")).toEqual({});
  });

  test("nested object", () => {
    expect(parse('{"a":1,"b":{"c":[2,null]}}')).toEqual({ a: 1, b: { c: [2, null] } });
  });

  test("whitespace tolerant", () => {
    expect(parse(' { "a" : [ 1 , 2 ] } ')).toEqual({ a: [1, 2] });
  });
});

describe("json-parser rejects malformed input", () => {
  const invalid: Array<[string, string]> = [
    ["", "empty input"],
    ["tru", "truncated literal"],
    ["01", "leading zero"],
    ["[1,]", "trailing comma in array"],
    ['{"a":}', "missing object value"],
    ['"abc', "unterminated string"],
  ];

  for (const [text, label] of invalid) {
    test(`throws SyntaxError for ${label}`, () => {
      expect(() => parseJson(text)).toThrow(SyntaxError);
    });
  }
});
