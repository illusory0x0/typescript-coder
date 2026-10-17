import { describe, expect, test } from "bun:test";
import { parseSexp } from "./sexp";
import type { Sexp } from "./sexp";

function parse(text: string): Sexp {
  return parseSexp(text);
}

describe("sexp-parser atoms", () => {
  test("numbers", () => {
    expect(parse("42")).toBe(42);
    expect(parse("-7")).toBe(-7);
    expect(parse("3.5")).toBe(3.5);
  });

  test("symbols", () => {
    expect(parse("foo")).toBe("foo");
    expect(parse("+")).toBe("+");
    expect(parse("foo-bar?")).toBe("foo-bar?");
  });
});

describe("sexp-parser lists", () => {
  test("empty list", () => {
    expect(parse("()")).toEqual([]);
  });

  test("flat list", () => {
    expect(parse("(a b c)")).toEqual(["a", "b", "c"]);
  });

  test("nested list", () => {
    expect(parse("(a (b 1) ())")).toEqual(["a", ["b", 1], []]);
  });

  test("outer whitespace is ignored", () => {
    expect(parse("  ( a\n\tb )  ")).toEqual(["a", "b"]);
  });
});

describe("sexp-parser rejects malformed input", () => {
  const invalid: Array<[string, string]> = [
    ["", "empty input"],
    ["  ", "whitespace only"],
    ["(a", "unterminated list"],
    [")", "stray close paren"],
    ["(a))", "trailing close paren"],
    ["(a b) c", "trailing expression"],
    ["a b", "multiple expressions"],
  ];

  for (const [text, label] of invalid) {
    test(`throws SyntaxError for ${label}`, () => {
      expect(() => parseSexp(text)).toThrow(SyntaxError);
    });
  }
});
