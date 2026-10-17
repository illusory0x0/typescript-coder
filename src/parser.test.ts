import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { ParseError, Parser } from "./parser";
import type { Expression, Program, Type } from "./parser";

function parse(source: string): Expression {
  return new Parser(source).parseExpression();
}

function parseType(source: string): Type {
  return new Parser(source).parseType();
}

function parseProgram(source: string): Program {
  return new Parser(source).parseProgram();
}

function captureTypeParseError(source: string): ParseError {
  try {
    parseType(source);
  } catch (error) {
    if (error instanceof ParseError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected ParseError to be thrown");
}

function captureParseError(source: string): ParseError {
  try {
    parse(source);
  } catch (error) {
    if (error instanceof ParseError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected ParseError to be thrown");
}

function captureProgramParseError(source: string): ParseError {
  try {
    parseProgram(source);
  } catch (error) {
    if (error instanceof ParseError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected ParseError to be thrown");
}

function errorPosition(error: ParseError): { offset: number; line: number; column: number } {
  return { offset: error.offset, line: error.line, column: error.column };
}

function captureThrownError(source: string): unknown {
  try {
    parse(source);
  } catch (error) {
    return error;
  }
  throw new Error("expected an error to be thrown");
}

function thrownPosition(
  error: unknown,
): { offset: number; line: number; column: number } | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "offset" in error &&
    "line" in error &&
    "column" in error
  ) {
    const record = error as { offset: unknown; line: unknown; column: unknown };
    if (
      typeof record.offset === "number" &&
      typeof record.line === "number" &&
      typeof record.column === "number"
    ) {
      return { offset: record.offset, line: record.line, column: record.column };
    }
  }
  return undefined;
}

test("parses identifiers with full spans", () => {
  expect(parse("foo")).toEqual({ kind: "Identifier", name: "foo", start: 0, end: 3 });
  expect(parse("$x")).toEqual({ kind: "Identifier", name: "$x", start: 0, end: 2 });
});

test("parses contextual keywords as identifiers", () => {
  expect(parse("type")).toEqual({ kind: "Identifier", name: "type", start: 0, end: 4 });
});

test("parses this and super", () => {
  expect(parse("this")).toEqual({ kind: "ThisExpression", start: 0, end: 4 });
  expect(parse("super")).toEqual({ kind: "SuperExpression", start: 0, end: 5 });
});

test("parses number literals", () => {
  expect(parse("42")).toEqual({ kind: "NumberLiteral", value: 42, raw: "42", start: 0, end: 2 });
  expect(parse("1_000")).toMatchObject({ kind: "NumberLiteral", value: 1000, raw: "1_000" });
  expect(parse("0xff")).toMatchObject({ kind: "NumberLiteral", value: 255, raw: "0xff" });
});

test("parses bigint literals", () => {
  expect(parse("10n")).toMatchObject({ kind: "BigIntLiteral", value: "10n", raw: "10n" });
});

test("parses string literals", () => {
  expect(parse('"a\\tb"')).toEqual({
    kind: "StringLiteral",
    value: "a\tb",
    raw: '"a\\tb"',
    start: 0,
    end: 6,
  });
  expect(parse("'x'")).toMatchObject({ kind: "StringLiteral", value: "x", raw: "'x'" });
});

test("parses boolean and null literals", () => {
  expect(parse("true")).toEqual({ kind: "BooleanLiteral", value: true, start: 0, end: 4 });
  expect(parse("false")).toMatchObject({ kind: "BooleanLiteral", value: false });
  expect(parse("null")).toEqual({ kind: "NullLiteral", start: 0, end: 4 });
});

test("skips trivia between tokens", () => {
  expect(parse("/* c */ foo")).toEqual({ kind: "Identifier", name: "foo", start: 8, end: 11 });
  expect(parse("( // c\n x )")).toEqual({
    kind: "ParenthesizedExpression",
    start: 0,
    end: 11,
    expression: { kind: "Identifier", name: "x", start: 8, end: 9 },
  });
});

test("parses nested parenthesized expressions with spans", () => {
  expect(parse("(((x)))")).toEqual({
    kind: "ParenthesizedExpression",
    start: 0,
    end: 7,
    expression: {
      kind: "ParenthesizedExpression",
      start: 1,
      end: 6,
      expression: {
        kind: "ParenthesizedExpression",
        start: 2,
        end: 5,
        expression: { kind: "Identifier", name: "x", start: 3, end: 4 },
      },
    },
  });
});

test("throws ParseError for unsupported primary expressions", () => {
  const at = captureParseError("@");
  expect(at).toBeInstanceOf(ParseError);
  expect(errorPosition(at)).toEqual({ offset: 0, line: 1, column: 1 });

  const plus = captureParseError("+");
  expect(plus).toBeInstanceOf(ParseError);
  expect(errorPosition(plus)).toEqual({ offset: 0, line: 1, column: 1 });
});

test("throws ParseError at end of input", () => {
  const eof = captureParseError("");
  expect(eof).toBeInstanceOf(ParseError);
  expect(errorPosition(eof)).toEqual({ offset: 0, line: 1, column: 1 });
  expect(eof.message).toBe("unexpected end of input");
});

test("throws ParseError for unterminated parenthesized expressions", () => {
  const unclosed = captureParseError("(x");
  expect(unclosed).toBeInstanceOf(ParseError);
  expect(errorPosition(unclosed)).toEqual({ offset: 2, line: 1, column: 3 });
  expect(unclosed.message).toBe('expected ")"');

  const multiline = captureParseError("(\n@\n)");
  expect(multiline).toBeInstanceOf(ParseError);
  expect(errorPosition(multiline)).toEqual({ offset: 2, line: 2, column: 1 });
});

test("parses empty array literals with full spans", () => {
  expect(parse("[]")).toEqual({ kind: "ArrayLiteral", elements: [], start: 0, end: 2 });
});

test("parses [1, 2] with full spans", () => {
  expect(parse("[1, 2]")).toEqual({
    kind: "ArrayLiteral",
    start: 0,
    end: 6,
    elements: [
      { kind: "NumberLiteral", value: 1, raw: "1", start: 1, end: 2 },
      { kind: "NumberLiteral", value: 2, raw: "2", start: 4, end: 5 },
    ],
  });
});

test("parses array literals with single and multiple elements", () => {
  expect(parse("[1]")).toMatchObject({
    kind: "ArrayLiteral",
    start: 0,
    end: 3,
    elements: [{ kind: "NumberLiteral", value: 1, raw: "1", start: 1, end: 2 }],
  });
  expect(parse("[1, 2, 3]")).toMatchObject({
    kind: "ArrayLiteral",
    start: 0,
    end: 9,
    elements: [
      { kind: "NumberLiteral", value: 1, start: 1, end: 2 },
      { kind: "NumberLiteral", value: 2, start: 4, end: 5 },
      { kind: "NumberLiteral", value: 3, start: 7, end: 8 },
    ],
  });
});

test("parses array elisions and trailing commas", () => {
  expect(parse("[1,, 2]")).toMatchObject({
    kind: "ArrayLiteral",
    start: 0,
    end: 7,
    elements: [
      { kind: "NumberLiteral", value: 1, start: 1, end: 2 },
      null,
      { kind: "NumberLiteral", value: 2, start: 5, end: 6 },
    ],
  });
  expect(parse("[1, ]")).toMatchObject({
    kind: "ArrayLiteral",
    start: 0,
    end: 5,
    elements: [{ kind: "NumberLiteral", value: 1, start: 1, end: 2 }],
  });
});

test("parses spread elements in array literals", () => {
  expect(parse("[...a, 1]")).toMatchObject({
    kind: "ArrayLiteral",
    start: 0,
    end: 9,
    elements: [
      {
        kind: "SpreadElement",
        start: 1,
        end: 5,
        argument: { kind: "Identifier", name: "a", start: 4, end: 5 },
      },
      { kind: "NumberLiteral", value: 1, start: 7, end: 8 },
    ],
  });
});

test("parses empty object literals with full spans", () => {
  expect(parse("{}")).toEqual({ kind: "ObjectLiteral", properties: [], start: 0, end: 2 });
});

test("parses { a: 1 } with full spans", () => {
  expect(parse("{ a: 1 }")).toEqual({
    kind: "ObjectLiteral",
    start: 0,
    end: 8,
    properties: [
      {
        kind: "Property",
        start: 2,
        end: 6,
        shorthand: false,
        computed: false,
        key: { kind: "Identifier", name: "a", start: 2, end: 3 },
        value: { kind: "NumberLiteral", value: 1, raw: "1", start: 5, end: 6 },
      },
    ],
  });
});

test("parses string and number keys", () => {
  expect(parse('{ "k": 2 }')).toMatchObject({
    kind: "ObjectLiteral",
    start: 0,
    end: 10,
    properties: [
      {
        kind: "Property",
        start: 2,
        end: 8,
        shorthand: false,
        computed: false,
        key: { kind: "StringLiteral", value: "k", raw: '"k"', start: 2, end: 5 },
        value: { kind: "NumberLiteral", value: 2, start: 7, end: 8 },
      },
    ],
  });
  expect(parse('{ 1: "x" }')).toMatchObject({
    kind: "ObjectLiteral",
    start: 0,
    end: 10,
    properties: [
      {
        kind: "Property",
        start: 2,
        end: 8,
        shorthand: false,
        computed: false,
        key: { kind: "NumberLiteral", value: 1, raw: "1", start: 2, end: 3 },
        value: { kind: "StringLiteral", value: "x", raw: '"x"', start: 5, end: 8 },
      },
    ],
  });
});

test("parses shorthand properties", () => {
  expect(parse("{ a }")).toMatchObject({
    kind: "ObjectLiteral",
    start: 0,
    end: 5,
    properties: [
      {
        kind: "Property",
        start: 2,
        end: 3,
        shorthand: true,
        computed: false,
        key: { kind: "Identifier", name: "a", start: 2, end: 3 },
        value: { kind: "Identifier", name: "a", start: 2, end: 3 },
      },
    ],
  });
});

test("parses computed properties", () => {
  expect(parse("{ [k]: 1 }")).toMatchObject({
    kind: "ObjectLiteral",
    start: 0,
    end: 10,
    properties: [
      {
        kind: "Property",
        start: 3,
        end: 8,
        shorthand: false,
        computed: true,
        key: { kind: "Identifier", name: "k", start: 3, end: 4 },
        value: { kind: "NumberLiteral", value: 1, start: 7, end: 8 },
      },
    ],
  });
});

test("parses spread properties", () => {
  expect(parse("{ ...a }")).toMatchObject({
    kind: "ObjectLiteral",
    start: 0,
    end: 8,
    properties: [
      {
        kind: "SpreadElement",
        start: 2,
        end: 6,
        argument: { kind: "Identifier", name: "a", start: 5, end: 6 },
      },
    ],
  });
});

test("parses object literals with trailing commas and nesting", () => {
  expect(parse("{ a: 1, b: 2, }")).toMatchObject({
    kind: "ObjectLiteral",
    start: 0,
    end: 15,
    properties: [
      {
        kind: "Property",
        shorthand: false,
        computed: false,
        key: { kind: "Identifier", name: "a", start: 2, end: 3 },
        value: { kind: "NumberLiteral", value: 1, start: 5, end: 6 },
      },
      {
        kind: "Property",
        shorthand: false,
        computed: false,
        key: { kind: "Identifier", name: "b", start: 8, end: 9 },
        value: { kind: "NumberLiteral", value: 2, start: 11, end: 12 },
      },
    ],
  });
  expect(parse("{ a: [1, { b }] }")).toMatchObject({
    kind: "ObjectLiteral",
    start: 0,
    end: 17,
    properties: [
      {
        kind: "Property",
        start: 2,
        end: 15,
        shorthand: false,
        computed: false,
        key: { kind: "Identifier", name: "a", start: 2, end: 3 },
        value: {
          kind: "ArrayLiteral",
          start: 5,
          end: 15,
          elements: [
            { kind: "NumberLiteral", value: 1, start: 6, end: 7 },
            {
              kind: "ObjectLiteral",
              start: 9,
              end: 14,
              properties: [
                {
                  kind: "Property",
                  start: 11,
                  end: 12,
                  shorthand: true,
                  computed: false,
                  key: { kind: "Identifier", name: "b", start: 11, end: 12 },
                  value: { kind: "Identifier", name: "b", start: 11, end: 12 },
                },
              ],
            },
          ],
        },
      },
    ],
  });
});

test("throws ParseError with line and column for malformed array literals", () => {
  const trailingCommaEof = captureParseError("[1,");
  expect(trailingCommaEof).toBeInstanceOf(ParseError);
  expect(errorPosition(trailingCommaEof)).toEqual({ offset: 3, line: 1, column: 4 });
  expect(trailingCommaEof.message).toBe("unexpected end of input");

  const unclosed = captureParseError("[");
  expect(unclosed).toBeInstanceOf(ParseError);
  expect(errorPosition(unclosed)).toEqual({ offset: 1, line: 1, column: 2 });
  expect(unclosed.message).toBe("unexpected end of input");
});

test("throws ParseError with line and column for malformed object literals", () => {
  const missingValue = captureParseError("{a:");
  expect(missingValue).toBeInstanceOf(ParseError);
  expect(errorPosition(missingValue)).toEqual({ offset: 3, line: 1, column: 4 });
  expect(missingValue.message).toBe("unexpected end of input");

  const missingColon = captureParseError("{a");
  expect(missingColon).toBeInstanceOf(ParseError);
  expect(errorPosition(missingColon)).toEqual({ offset: 2, line: 1, column: 3 });
  expect(missingColon.message).toBe('expected ":"');

  const adjacentKeys = captureParseError("{ a b }");
  expect(adjacentKeys).toBeInstanceOf(ParseError);
  expect(errorPosition(adjacentKeys)).toEqual({ offset: 4, line: 1, column: 5 });
  expect(adjacentKeys.message).toBe('expected ":"');
});

test("parses templates without substitutions", () => {
  expect(parse("`plain`")).toEqual({
    kind: "TemplateLiteral",
    quasis: ["plain"],
    expressions: [],
    start: 0,
    end: 7,
  });
});

test("parses templates with one substitution", () => {
  expect(parse("`a${x}b`")).toEqual({
    kind: "TemplateLiteral",
    quasis: ["a", "b"],
    expressions: [{ kind: "Identifier", name: "x", start: 4, end: 5 }],
    start: 0,
    end: 8,
  });
});

test("parses templates with multiple substitutions", () => {
  expect(parse("`a${x}b${y}c`")).toEqual({
    kind: "TemplateLiteral",
    quasis: ["a", "b", "c"],
    expressions: [
      { kind: "Identifier", name: "x", start: 4, end: 5 },
      { kind: "Identifier", name: "y", start: 9, end: 10 },
    ],
    start: 0,
    end: 13,
  });
});

test("parses nested templates", () => {
  expect(parse("`a${`b${c}d`}e`")).toEqual({
    kind: "TemplateLiteral",
    quasis: ["a", "e"],
    expressions: [
      {
        kind: "TemplateLiteral",
        quasis: ["b", "d"],
        expressions: [{ kind: "Identifier", name: "c", start: 8, end: 9 }],
        start: 4,
        end: 12,
      },
    ],
    start: 0,
    end: 15,
  });
});

test("preserves newlines in template quasis", () => {
  expect(parse("`a\nb`")).toEqual({
    kind: "TemplateLiteral",
    quasis: ["a\nb"],
    expressions: [],
    start: 0,
    end: 5,
  });
});

test("parses regex literals", () => {
  expect(parse("/a+b/gi")).toEqual({
    kind: "RegexLiteral",
    pattern: "a+b",
    flags: "gi",
    raw: "/a+b/gi",
    start: 0,
    end: 7,
  });
});

test("parses regex literals with slashes in classes and empty flags", () => {
  expect(parse("/[a/]b/g")).toEqual({
    kind: "RegexLiteral",
    pattern: "[a/]b",
    flags: "g",
    raw: "/[a/]b/g",
    start: 0,
    end: 8,
  });
  expect(parse("/=/")).toEqual({
    kind: "RegexLiteral",
    pattern: "=",
    flags: "",
    raw: "/=/",
    start: 0,
    end: 3,
  });
});

test("reports full spans for template and regex literals", () => {
  expect(parse("`ab`")).toEqual({
    kind: "TemplateLiteral",
    quasis: ["ab"],
    expressions: [],
    start: 0,
    end: 4,
  });
  expect(parse("/x/g")).toEqual({
    kind: "RegexLiteral",
    pattern: "x",
    flags: "g",
    raw: "/x/g",
    start: 0,
    end: 4,
  });
});

test("throws for unterminated template literal", () => {
  const error = captureParseError("`a${b");
  expect(error).toBeInstanceOf(ParseError);
  expect(errorPosition(error)).toEqual({ offset: 5, line: 1, column: 6 });
  expect(error.message).toBe("unexpected end of input");
});

test("throws for unterminated regular expression", () => {
  const error = captureThrownError("/abc");
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("unterminated regular expression");
  expect(thrownPosition(error)).toEqual({ offset: 0, line: 1, column: 1 });
});

test("parses binary operator precedence with full spans", () => {
  expect(parse("1 + 2 * 3")).toEqual({
    kind: "BinaryExpression",
    operator: "+",
    start: 0,
    end: 9,
    left: { kind: "NumberLiteral", value: 1, raw: "1", start: 0, end: 1 },
    right: {
      kind: "BinaryExpression",
      operator: "*",
      start: 4,
      end: 9,
      left: { kind: "NumberLiteral", value: 2, raw: "2", start: 4, end: 5 },
      right: { kind: "NumberLiteral", value: 3, raw: "3", start: 8, end: 9 },
    },
  });
});

test("parses right-associative exponentiation", () => {
  expect(parse("2 ** 3 ** 2")).toEqual({
    kind: "BinaryExpression",
    operator: "**",
    start: 0,
    end: 11,
    left: { kind: "NumberLiteral", value: 2, raw: "2", start: 0, end: 1 },
    right: {
      kind: "BinaryExpression",
      operator: "**",
      start: 5,
      end: 11,
      left: { kind: "NumberLiteral", value: 3, raw: "3", start: 5, end: 6 },
      right: { kind: "NumberLiteral", value: 2, raw: "2", start: 10, end: 11 },
    },
  });
});

test("parses logical operator precedence", () => {
  expect(parse("a || b && c")).toEqual({
    kind: "LogicalExpression",
    operator: "||",
    start: 0,
    end: 11,
    left: { kind: "Identifier", name: "a", start: 0, end: 1 },
    right: {
      kind: "LogicalExpression",
      operator: "&&",
      start: 5,
      end: 11,
      left: { kind: "Identifier", name: "b", start: 5, end: 6 },
      right: { kind: "Identifier", name: "c", start: 10, end: 11 },
    },
  });
});

test("parses additive before shift", () => {
  expect(parse("a + b << c")).toEqual({
    kind: "BinaryExpression",
    operator: "<<",
    start: 0,
    end: 10,
    left: {
      kind: "BinaryExpression",
      operator: "+",
      start: 0,
      end: 5,
      left: { kind: "Identifier", name: "a", start: 0, end: 1 },
      right: { kind: "Identifier", name: "b", start: 4, end: 5 },
    },
    right: { kind: "Identifier", name: "c", start: 9, end: 10 },
  });
});

test("parses bitwise operator precedence", () => {
  expect(parse("a | b ^ c & d")).toMatchObject({
    kind: "BinaryExpression",
    operator: "|",
    start: 0,
    end: 13,
    left: { kind: "Identifier", name: "a", start: 0, end: 1 },
    right: {
      kind: "BinaryExpression",
      operator: "^",
      start: 4,
      end: 13,
      left: { kind: "Identifier", name: "b", start: 4, end: 5 },
      right: {
        kind: "BinaryExpression",
        operator: "&",
        start: 8,
        end: 13,
        left: { kind: "Identifier", name: "c", start: 8, end: 9 },
        right: { kind: "Identifier", name: "d", start: 12, end: 13 },
      },
    },
  });
});

test("parses left-associative subtraction", () => {
  expect(parse("a - b - c")).toEqual({
    kind: "BinaryExpression",
    operator: "-",
    start: 0,
    end: 9,
    left: {
      kind: "BinaryExpression",
      operator: "-",
      start: 0,
      end: 5,
      left: { kind: "Identifier", name: "a", start: 0, end: 1 },
      right: { kind: "Identifier", name: "b", start: 4, end: 5 },
    },
    right: { kind: "Identifier", name: "c", start: 8, end: 9 },
  });
});

test("parses relational keyword operators", () => {
  expect(parse("a instanceof b")).toEqual({
    kind: "BinaryExpression",
    operator: "instanceof",
    start: 0,
    end: 14,
    left: { kind: "Identifier", name: "a", start: 0, end: 1 },
    right: { kind: "Identifier", name: "b", start: 13, end: 14 },
  });
  expect(parse("a in b")).toEqual({
    kind: "BinaryExpression",
    operator: "in",
    start: 0,
    end: 6,
    left: { kind: "Identifier", name: "a", start: 0, end: 1 },
    right: { kind: "Identifier", name: "b", start: 5, end: 6 },
  });
});

test("parses unary operator expressions", () => {
  expect(parse("typeof x")).toEqual({
    kind: "UnaryExpression",
    operator: "typeof",
    operand: { kind: "Identifier", name: "x", start: 7, end: 8 },
    prefix: true,
    start: 0,
    end: 8,
  });
  expect(parse("-x")).toEqual({
    kind: "UnaryExpression",
    operator: "-",
    operand: { kind: "Identifier", name: "x", start: 1, end: 2 },
    prefix: true,
    start: 0,
    end: 2,
  });
  expect(parse("!x")).toEqual({
    kind: "UnaryExpression",
    operator: "!",
    operand: { kind: "Identifier", name: "x", start: 1, end: 2 },
    prefix: true,
    start: 0,
    end: 2,
  });
  expect(parse("void 0")).toEqual({
    kind: "UnaryExpression",
    operator: "void",
    operand: { kind: "NumberLiteral", value: 0, raw: "0", start: 5, end: 6 },
    prefix: true,
    start: 0,
    end: 6,
  });
  expect(parse("delete a")).toEqual({
    kind: "UnaryExpression",
    operator: "delete",
    operand: { kind: "Identifier", name: "a", start: 7, end: 8 },
    prefix: true,
    start: 0,
    end: 8,
  });
  expect(parse("await x")).toEqual({
    kind: "UnaryExpression",
    operator: "await",
    operand: { kind: "Identifier", name: "x", start: 6, end: 7 },
    prefix: true,
    start: 0,
    end: 7,
  });
});

test("parses chained unary operators", () => {
  expect(parse("!!x")).toEqual({
    kind: "UnaryExpression",
    operator: "!",
    start: 0,
    end: 3,
    prefix: true,
    operand: {
      kind: "UnaryExpression",
      operator: "!",
      start: 1,
      end: 3,
      prefix: true,
      operand: { kind: "Identifier", name: "x", start: 2, end: 3 },
    },
  });
  expect(parse("- - x")).toEqual({
    kind: "UnaryExpression",
    operator: "-",
    start: 0,
    end: 5,
    prefix: true,
    operand: {
      kind: "UnaryExpression",
      operator: "-",
      start: 2,
      end: 5,
      prefix: true,
      operand: { kind: "Identifier", name: "x", start: 4, end: 5 },
    },
  });
});

test("parses update expressions with prefix flags", () => {
  expect(parse("++i")).toEqual({
    kind: "UpdateExpression",
    operator: "++",
    operand: { kind: "Identifier", name: "i", start: 2, end: 3 },
    prefix: true,
    start: 0,
    end: 3,
  });
  expect(parse("i++")).toEqual({
    kind: "UpdateExpression",
    operator: "++",
    operand: { kind: "Identifier", name: "i", start: 0, end: 1 },
    prefix: false,
    start: 0,
    end: 3,
  });
  expect(parse("--i")).toEqual({
    kind: "UpdateExpression",
    operator: "--",
    operand: { kind: "Identifier", name: "i", start: 2, end: 3 },
    prefix: true,
    start: 0,
    end: 3,
  });
  expect(parse("i--")).toEqual({
    kind: "UpdateExpression",
    operator: "--",
    operand: { kind: "Identifier", name: "i", start: 0, end: 1 },
    prefix: false,
    start: 0,
    end: 3,
  });
});

test("parses conditional expressions with full spans", () => {
  expect(parse("a ? b : c")).toEqual({
    kind: "ConditionalExpression",
    start: 0,
    end: 9,
    test: { kind: "Identifier", name: "a", start: 0, end: 1 },
    consequent: { kind: "Identifier", name: "b", start: 4, end: 5 },
    alternate: { kind: "Identifier", name: "c", start: 8, end: 9 },
  });
  expect(parse("a ? b : c ? d : e")).toEqual({
    kind: "ConditionalExpression",
    start: 0,
    end: 17,
    test: { kind: "Identifier", name: "a", start: 0, end: 1 },
    consequent: { kind: "Identifier", name: "b", start: 4, end: 5 },
    alternate: {
      kind: "ConditionalExpression",
      start: 8,
      end: 17,
      test: { kind: "Identifier", name: "c", start: 8, end: 9 },
      consequent: { kind: "Identifier", name: "d", start: 12, end: 13 },
      alternate: { kind: "Identifier", name: "e", start: 16, end: 17 },
    },
  });
  expect(parse("a ? b ? c : d : e")).toEqual({
    kind: "ConditionalExpression",
    start: 0,
    end: 17,
    test: { kind: "Identifier", name: "a", start: 0, end: 1 },
    consequent: {
      kind: "ConditionalExpression",
      start: 4,
      end: 13,
      test: { kind: "Identifier", name: "b", start: 4, end: 5 },
      consequent: { kind: "Identifier", name: "c", start: 8, end: 9 },
      alternate: { kind: "Identifier", name: "d", start: 12, end: 13 },
    },
    alternate: { kind: "Identifier", name: "e", start: 16, end: 17 },
  });
});

test("parses right-associative assignment", () => {
  expect(parse("a = b = c")).toEqual({
    kind: "AssignmentExpression",
    operator: "=",
    start: 0,
    end: 9,
    left: { kind: "Identifier", name: "a", start: 0, end: 1 },
    right: {
      kind: "AssignmentExpression",
      operator: "=",
      start: 4,
      end: 9,
      left: { kind: "Identifier", name: "b", start: 4, end: 5 },
      right: { kind: "Identifier", name: "c", start: 8, end: 9 },
    },
  });
  expect(parse("a += 1")).toEqual({
    kind: "AssignmentExpression",
    operator: "+=",
    start: 0,
    end: 6,
    left: { kind: "Identifier", name: "a", start: 0, end: 1 },
    right: { kind: "NumberLiteral", value: 1, raw: "1", start: 5, end: 6 },
  });
  expect(parse("a >>>= b")).toEqual({
    kind: "AssignmentExpression",
    operator: ">>>=",
    start: 0,
    end: 8,
    left: { kind: "Identifier", name: "a", start: 0, end: 1 },
    right: { kind: "Identifier", name: "b", start: 7, end: 8 },
  });
});

test("parses sequence expressions", () => {
  expect(parse("a, b, c")).toEqual({
    kind: "SequenceExpression",
    start: 0,
    end: 7,
    expressions: [
      { kind: "Identifier", name: "a", start: 0, end: 1 },
      { kind: "Identifier", name: "b", start: 3, end: 4 },
      { kind: "Identifier", name: "c", start: 6, end: 7 },
    ],
  });
  expect(parse("(a, b)")).toEqual({
    kind: "ParenthesizedExpression",
    start: 0,
    end: 6,
    expression: {
      kind: "SequenceExpression",
      start: 1,
      end: 5,
      expressions: [
        { kind: "Identifier", name: "a", start: 1, end: 2 },
        { kind: "Identifier", name: "b", start: 4, end: 5 },
      ],
    },
  });
});

test("parses non-null expressions", () => {
  expect(parse("a!")).toEqual({
    kind: "NonNullExpression",
    start: 0,
    end: 2,
    expression: { kind: "Identifier", name: "a", start: 0, end: 1 },
  });
  expect(parse("a!!")).toEqual({
    kind: "NonNullExpression",
    start: 0,
    end: 3,
    expression: {
      kind: "NonNullExpression",
      start: 0,
      end: 2,
      expression: { kind: "Identifier", name: "a", start: 0, end: 1 },
    },
  });
  expect(parse("a != b")).toEqual({
    kind: "BinaryExpression",
    operator: "!=",
    start: 0,
    end: 6,
    left: { kind: "Identifier", name: "a", start: 0, end: 1 },
    right: { kind: "Identifier", name: "b", start: 5, end: 6 },
  });
});

test("parses mixed operator expressions", () => {
  expect(parse("a + b! * c")).toMatchObject({
    kind: "BinaryExpression",
    operator: "+",
    start: 0,
    end: 10,
    left: { kind: "Identifier", name: "a", start: 0, end: 1 },
    right: {
      kind: "BinaryExpression",
      operator: "*",
      start: 4,
      end: 10,
      left: {
        kind: "NonNullExpression",
        start: 4,
        end: 6,
        expression: { kind: "Identifier", name: "b", start: 4, end: 5 },
      },
      right: { kind: "Identifier", name: "c", start: 9, end: 10 },
    },
  });
  expect(parse('typeof a === "string"')).toMatchObject({
    kind: "BinaryExpression",
    operator: "===",
    start: 0,
    end: 21,
    left: {
      kind: "UnaryExpression",
      operator: "typeof",
      start: 0,
      end: 8,
      operand: { kind: "Identifier", name: "a", start: 7, end: 8 },
    },
    right: { kind: "StringLiteral", value: "string", start: 13, end: 21 },
  });
  expect(parse("x = a ? b : c")).toMatchObject({
    kind: "AssignmentExpression",
    operator: "=",
    start: 0,
    end: 13,
    left: { kind: "Identifier", name: "x", start: 0, end: 1 },
    right: {
      kind: "ConditionalExpression",
      start: 4,
      end: 13,
      test: { kind: "Identifier", name: "a", start: 4, end: 5 },
      consequent: { kind: "Identifier", name: "b", start: 8, end: 9 },
      alternate: { kind: "Identifier", name: "c", start: 12, end: 13 },
    },
  });
});

test("parses assignment-level elements in arrays, objects, and spreads", () => {
  expect(parse("[a = b, c]")).toMatchObject({
    kind: "ArrayLiteral",
    start: 0,
    end: 10,
    elements: [
      {
        kind: "AssignmentExpression",
        operator: "=",
        start: 1,
        end: 6,
        left: { kind: "Identifier", name: "a", start: 1, end: 2 },
        right: { kind: "Identifier", name: "b", start: 5, end: 6 },
      },
      { kind: "Identifier", name: "c", start: 8, end: 9 },
    ],
  });
  expect(parse("{ a: b = c }")).toMatchObject({
    kind: "ObjectLiteral",
    start: 0,
    end: 12,
    properties: [
      {
        kind: "Property",
        start: 2,
        end: 10,
        key: { kind: "Identifier", name: "a", start: 2, end: 3 },
        value: {
          kind: "AssignmentExpression",
          operator: "=",
          start: 5,
          end: 10,
          left: { kind: "Identifier", name: "b", start: 5, end: 6 },
          right: { kind: "Identifier", name: "c", start: 9, end: 10 },
        },
      },
    ],
  });
  expect(parse("[...a = b]")).toMatchObject({
    kind: "ArrayLiteral",
    start: 0,
    end: 10,
    elements: [
      {
        kind: "SpreadElement",
        start: 1,
        end: 9,
        argument: {
          kind: "AssignmentExpression",
          operator: "=",
          start: 4,
          end: 9,
          left: { kind: "Identifier", name: "a", start: 4, end: 5 },
          right: { kind: "Identifier", name: "b", start: 8, end: 9 },
        },
      },
    ],
  });
});

test("throws ParseError with line and column for operator expressions", () => {
  const binaryOperand = captureParseError("a +");
  expect(binaryOperand).toBeInstanceOf(ParseError);
  expect(errorPosition(binaryOperand)).toEqual({ offset: 3, line: 1, column: 4 });
  expect(binaryOperand.message).toBe("unexpected end of input");

  const unaryOperand = captureParseError("!");
  expect(unaryOperand).toBeInstanceOf(ParseError);
  expect(errorPosition(unaryOperand)).toEqual({ offset: 0, line: 1, column: 1 });
  expect(unaryOperand.message).toBe('unexpected token "!"');

  const conditionalColon = captureParseError("a ? b");
  expect(conditionalColon).toBeInstanceOf(ParseError);
  expect(errorPosition(conditionalColon)).toEqual({ offset: 5, line: 1, column: 6 });
  expect(conditionalColon.message).toBe('expected ":"');

  const assignmentOperand = captureParseError("a =");
  expect(assignmentOperand).toBeInstanceOf(ParseError);
  expect(errorPosition(assignmentOperand)).toEqual({ offset: 3, line: 1, column: 4 });
  expect(assignmentOperand.message).toBe("unexpected end of input");

  const sequenceHead = captureParseError(", a");
  expect(sequenceHead).toBeInstanceOf(ParseError);
  expect(errorPosition(sequenceHead)).toEqual({ offset: 0, line: 1, column: 1 });
  expect(sequenceHead.message).toBe('unexpected token ","');
});

test("reports operator expression errors on later lines", () => {
  const error = captureParseError("a +\n*");
  expect(error).toBeInstanceOf(ParseError);
  expect(errorPosition(error)).toEqual({ offset: 4, line: 2, column: 1 });
  expect(error.message).toBe('unexpected token "*"');
});

test("parses member expressions", () => {
  expect(parse("a.b")).toEqual({
    kind: "MemberExpression",
    object: { kind: "Identifier", name: "a", start: 0, end: 1 },
    property: { kind: "Identifier", name: "b", start: 2, end: 3 },
    computed: false,
    optional: false,
    start: 0,
    end: 3,
  });
  expect(parse("a.b.c")).toMatchObject({
    kind: "MemberExpression",
    start: 0,
    end: 5,
    computed: false,
    optional: false,
    object: {
      kind: "MemberExpression",
      start: 0,
      end: 3,
      computed: false,
      optional: false,
      object: { kind: "Identifier", name: "a", start: 0, end: 1 },
      property: { kind: "Identifier", name: "b", start: 2, end: 3 },
    },
    property: { kind: "Identifier", name: "c", start: 4, end: 5 },
  });
});

test("parses computed member expressions", () => {
  expect(parse("a[0]")).toMatchObject({
    kind: "MemberExpression",
    start: 0,
    end: 4,
    computed: true,
    optional: false,
    object: { kind: "Identifier", name: "a", start: 0, end: 1 },
    property: { kind: "NumberLiteral", value: 0, raw: "0", start: 2, end: 3 },
  });
  expect(parse('a["k"]')).toMatchObject({
    kind: "MemberExpression",
    start: 0,
    end: 6,
    computed: true,
    optional: false,
    object: { kind: "Identifier", name: "a", start: 0, end: 1 },
    property: { kind: "StringLiteral", value: "k", raw: '"k"', start: 2, end: 5 },
  });
});

test("parses call expressions", () => {
  expect(parse("a()")).toMatchObject({
    kind: "CallExpression",
    callee: { kind: "Identifier", name: "a", start: 0, end: 1 },
    arguments: [],
    optional: false,
    start: 0,
    end: 3,
  });
  expect(parse("a(b, ...c)")).toMatchObject({
    kind: "CallExpression",
    callee: { kind: "Identifier", name: "a", start: 0, end: 1 },
    optional: false,
    start: 0,
    end: 10,
    arguments: [
      { kind: "Identifier", name: "b", start: 2, end: 3 },
      {
        kind: "SpreadElement",
        start: 5,
        end: 9,
        argument: { kind: "Identifier", name: "c", start: 8, end: 9 },
      },
    ],
  });
  expect(parse("a(b,)")).toMatchObject({
    kind: "CallExpression",
    optional: false,
    start: 0,
    end: 5,
    arguments: [{ kind: "Identifier", name: "b", start: 2, end: 3 }],
  });
});

test("parses chained member and call expressions with full spans", () => {
  expect(parse("a.b()")).toEqual({
    kind: "CallExpression",
    callee: {
      kind: "MemberExpression",
      object: { kind: "Identifier", name: "a", start: 0, end: 1 },
      property: { kind: "Identifier", name: "b", start: 2, end: 3 },
      computed: false,
      optional: false,
      start: 0,
      end: 3,
    },
    arguments: [],
    optional: false,
    start: 0,
    end: 5,
  });
  expect(parse("a.b().c()")).toMatchObject({
    kind: "CallExpression",
    optional: false,
    start: 0,
    end: 9,
    callee: {
      kind: "MemberExpression",
      start: 0,
      end: 7,
      computed: false,
      optional: false,
      object: {
        kind: "CallExpression",
        start: 0,
        end: 5,
        optional: false,
        callee: {
          kind: "MemberExpression",
          start: 0,
          end: 3,
          computed: false,
          optional: false,
          object: { kind: "Identifier", name: "a", start: 0, end: 1 },
          property: { kind: "Identifier", name: "b", start: 2, end: 3 },
        },
        arguments: [],
      },
      property: { kind: "Identifier", name: "c", start: 6, end: 7 },
    },
    arguments: [],
  });
});

test("parses optional chaining", () => {
  expect(parse("a?.b")).toEqual({
    kind: "MemberExpression",
    object: { kind: "Identifier", name: "a", start: 0, end: 1 },
    property: { kind: "Identifier", name: "b", start: 3, end: 4 },
    computed: false,
    optional: true,
    start: 0,
    end: 4,
  });
  expect(parse("a?.[0]")).toMatchObject({
    kind: "MemberExpression",
    computed: true,
    optional: true,
    start: 0,
    end: 6,
    object: { kind: "Identifier", name: "a", start: 0, end: 1 },
    property: { kind: "NumberLiteral", value: 0, raw: "0", start: 4, end: 5 },
  });
  expect(parse("a?.()")).toEqual({
    kind: "CallExpression",
    callee: { kind: "Identifier", name: "a", start: 0, end: 1 },
    arguments: [],
    optional: true,
    start: 0,
    end: 5,
  });
});

test("parses non-null member access and non-null of members", () => {
  expect(parse("a!.b")).toEqual({
    kind: "MemberExpression",
    object: {
      kind: "NonNullExpression",
      expression: { kind: "Identifier", name: "a", start: 0, end: 1 },
      start: 0,
      end: 2,
    },
    property: { kind: "Identifier", name: "b", start: 3, end: 4 },
    computed: false,
    optional: false,
    start: 0,
    end: 4,
  });
  expect(parse("a.b!")).toEqual({
    kind: "NonNullExpression",
    expression: {
      kind: "MemberExpression",
      object: { kind: "Identifier", name: "a", start: 0, end: 1 },
      property: { kind: "Identifier", name: "b", start: 2, end: 3 },
      computed: false,
      optional: false,
      start: 0,
      end: 3,
    },
    start: 0,
    end: 4,
  });
});

test("parses new expressions", () => {
  expect(parse("new A")).toEqual({
    kind: "NewExpression",
    callee: { kind: "Identifier", name: "A", start: 4, end: 5 },
    arguments: [],
    start: 0,
    end: 5,
  });
  expect(parse("new A()")).toMatchObject({
    kind: "NewExpression",
    callee: { kind: "Identifier", name: "A", start: 4, end: 5 },
    arguments: [],
    start: 0,
    end: 7,
  });
  expect(parse("new A().b")).toMatchObject({
    kind: "MemberExpression",
    start: 0,
    end: 9,
    computed: false,
    optional: false,
    object: {
      kind: "NewExpression",
      start: 0,
      end: 7,
      callee: { kind: "Identifier", name: "A", start: 4, end: 5 },
      arguments: [],
    },
    property: { kind: "Identifier", name: "b", start: 8, end: 9 },
  });
  expect(parse("new A(1, ...b)")).toMatchObject({
    kind: "NewExpression",
    start: 0,
    end: 14,
    callee: { kind: "Identifier", name: "A", start: 4, end: 5 },
    arguments: [
      { kind: "NumberLiteral", value: 1, raw: "1", start: 6, end: 7 },
      {
        kind: "SpreadElement",
        start: 9,
        end: 13,
        argument: { kind: "Identifier", name: "b", start: 12, end: 13 },
      },
    ],
  });
});

test("parses tagged template expressions", () => {
  expect(parse("tag`x${y}`")).toEqual({
    kind: "TaggedTemplateExpression",
    tag: { kind: "Identifier", name: "tag", start: 0, end: 3 },
    quasi: {
      kind: "TemplateLiteral",
      quasis: ["x", ""],
      expressions: [{ kind: "Identifier", name: "y", start: 7, end: 8 }],
      start: 3,
      end: 10,
    },
    start: 0,
    end: 10,
  });
});

test("parses yield expressions", () => {
  expect(parse("yield")).toEqual({
    kind: "YieldExpression",
    argument: null,
    delegate: false,
    start: 0,
    end: 5,
  });
  expect(parse("yield x")).toEqual({
    kind: "YieldExpression",
    argument: { kind: "Identifier", name: "x", start: 6, end: 7 },
    delegate: false,
    start: 0,
    end: 7,
  });
  expect(parse("yield* x")).toEqual({
    kind: "YieldExpression",
    argument: { kind: "Identifier", name: "x", start: 7, end: 8 },
    delegate: true,
    start: 0,
    end: 8,
  });
});

test("parses dynamic import expressions", () => {
  expect(parse('import("m")')).toEqual({
    kind: "ImportExpression",
    source: { kind: "StringLiteral", value: "m", raw: '"m"', start: 7, end: 10 },
    start: 0,
    end: 11,
  });
});

test("throws ParseError with line and column for malformed left-hand-side expressions", () => {
  const trailingDot = captureParseError("a.");
  expect(trailingDot).toBeInstanceOf(ParseError);
  expect(errorPosition(trailingDot)).toEqual({ offset: 2, line: 1, column: 3 });
  expect(trailingDot.message).toBe("unexpected end of input");

  const danglingOptional = captureParseError("a?.");
  expect(danglingOptional).toBeInstanceOf(ParseError);
  expect(errorPosition(danglingOptional)).toEqual({ offset: 3, line: 1, column: 4 });
  expect(danglingOptional.message).toBe("unexpected end of input");

  const bareNew = captureParseError("new");
  expect(bareNew).toBeInstanceOf(ParseError);
  expect(errorPosition(bareNew)).toEqual({ offset: 3, line: 1, column: 4 });
  expect(bareNew.message).toBe("unexpected end of input");

  const openCall = captureParseError("f(");
  expect(openCall).toBeInstanceOf(ParseError);
  expect(errorPosition(openCall)).toEqual({ offset: 2, line: 1, column: 3 });
  expect(openCall.message).toBe("unexpected end of input");

  const openIndex = captureParseError("a[");
  expect(openIndex).toBeInstanceOf(ParseError);
  expect(errorPosition(openIndex)).toEqual({ offset: 2, line: 1, column: 3 });
  expect(openIndex.message).toBe("unexpected end of input");
});

test("parses keyword types with full spans", () => {
  expect(parseType("string")).toEqual({ kind: "KeywordType", name: "string", start: 0, end: 6 });
  expect(parseType("number")).toEqual({ kind: "KeywordType", name: "number", start: 0, end: 6 });
  expect(parseType("boolean")).toEqual({ kind: "KeywordType", name: "boolean", start: 0, end: 7 });
  expect(parseType("any")).toEqual({ kind: "KeywordType", name: "any", start: 0, end: 3 });
  expect(parseType("unknown")).toEqual({ kind: "KeywordType", name: "unknown", start: 0, end: 7 });
  expect(parseType("never")).toEqual({ kind: "KeywordType", name: "never", start: 0, end: 5 });
  expect(parseType("void")).toEqual({ kind: "KeywordType", name: "void", start: 0, end: 4 });
  expect(parseType("undefined")).toEqual({
    kind: "KeywordType",
    name: "undefined",
    start: 0,
    end: 9,
  });
  expect(parseType("null")).toEqual({ kind: "KeywordType", name: "null", start: 0, end: 4 });
});

test("parses this type with full spans", () => {
  expect(parseType("this")).toEqual({ kind: "ThisType", start: 0, end: 4 });
});

test("parses type references with full spans", () => {
  expect(parseType("A")).toEqual({
    kind: "TypeReference",
    name: "A",
    typeArguments: null,
    start: 0,
    end: 1,
  });
  expect(parseType("A.B.C")).toEqual({
    kind: "TypeReference",
    name: "A.B.C",
    typeArguments: null,
    start: 0,
    end: 5,
  });
});

test("parses type arguments with full spans", () => {
  expect(parseType("Array<string>")).toEqual({
    kind: "TypeReference",
    name: "Array",
    typeArguments: [{ kind: "KeywordType", name: "string", start: 6, end: 12 }],
    start: 0,
    end: 13,
  });
  expect(parseType("A.B<C>")).toEqual({
    kind: "TypeReference",
    name: "A.B",
    typeArguments: [{ kind: "TypeReference", name: "C", typeArguments: null, start: 4, end: 5 }],
    start: 0,
    end: 6,
  });
});

test("splits shared greater-than tokens in nested type arguments", () => {
  expect(parseType("Foo<Bar, Baz<Q>>")).toEqual({
    kind: "TypeReference",
    name: "Foo",
    typeArguments: [
      { kind: "TypeReference", name: "Bar", typeArguments: null, start: 4, end: 7 },
      {
        kind: "TypeReference",
        name: "Baz",
        typeArguments: [
          { kind: "TypeReference", name: "Q", typeArguments: null, start: 13, end: 14 },
        ],
        start: 9,
        end: 15,
      },
    ],
    start: 0,
    end: 16,
  });
});

test("parses literal types", () => {
  expect(parseType('"lit"')).toEqual({ kind: "LiteralType", literal: "lit", start: 0, end: 5 });
  expect(parseType("42")).toEqual({ kind: "LiteralType", literal: 42, start: 0, end: 2 });
  expect(parseType("true")).toEqual({ kind: "LiteralType", literal: true, start: 0, end: 4 });
  expect(parseType("123n")).toEqual({
    kind: "LiteralType",
    literal: { value: "123n", raw: "123n" },
    start: 0,
    end: 4,
  });
  expect(parseType("1_0n")).toEqual({
    kind: "LiteralType",
    literal: { value: "10n", raw: "1_0n" },
    start: 0,
    end: 4,
  });
});

test("parses union types with full spans", () => {
  expect(parseType("A | B")).toEqual({
    kind: "UnionType",
    types: [
      { kind: "TypeReference", name: "A", typeArguments: null, start: 0, end: 1 },
      { kind: "TypeReference", name: "B", typeArguments: null, start: 4, end: 5 },
    ],
    start: 0,
    end: 5,
  });
  expect(parseType("A | B | C")).toMatchObject({
    kind: "UnionType",
    start: 0,
    end: 9,
    types: [
      { kind: "TypeReference", name: "A" },
      { kind: "TypeReference", name: "B" },
      { kind: "TypeReference", name: "C" },
    ],
  });
});

test("parses intersection types and union precedence", () => {
  expect(parseType("A & B")).toEqual({
    kind: "IntersectionType",
    types: [
      { kind: "TypeReference", name: "A", typeArguments: null, start: 0, end: 1 },
      { kind: "TypeReference", name: "B", typeArguments: null, start: 4, end: 5 },
    ],
    start: 0,
    end: 5,
  });
  expect(parseType("A | B & C")).toEqual({
    kind: "UnionType",
    start: 0,
    end: 9,
    types: [
      { kind: "TypeReference", name: "A", typeArguments: null, start: 0, end: 1 },
      {
        kind: "IntersectionType",
        start: 4,
        end: 9,
        types: [
          { kind: "TypeReference", name: "B", typeArguments: null, start: 4, end: 5 },
          { kind: "TypeReference", name: "C", typeArguments: null, start: 8, end: 9 },
        ],
      },
    ],
  });
});

test("parses parenthesized types and arrays of them", () => {
  expect(parseType("(A | B)[]")).toEqual({
    kind: "ArrayType",
    elementType: {
      kind: "ParenthesizedType",
      type: {
        kind: "UnionType",
        start: 1,
        end: 6,
        types: [
          { kind: "TypeReference", name: "A", typeArguments: null, start: 1, end: 2 },
          { kind: "TypeReference", name: "B", typeArguments: null, start: 5, end: 6 },
        ],
      },
      start: 0,
      end: 7,
    },
    start: 0,
    end: 9,
  });
});

test("parses prefix type operators", () => {
  expect(parseType("keyof T")).toEqual({
    kind: "TypeOperator",
    operator: "keyof",
    type: { kind: "TypeReference", name: "T", typeArguments: null, start: 6, end: 7 },
    start: 0,
    end: 7,
  });
  expect(parseType("typeof x")).toEqual({
    kind: "TypeOperator",
    operator: "typeof",
    type: { kind: "TypeReference", name: "x", typeArguments: null, start: 7, end: 8 },
    start: 0,
    end: 8,
  });
  expect(parseType("readonly T[]")).toEqual({
    kind: "TypeOperator",
    operator: "readonly",
    type: {
      kind: "ArrayType",
      elementType: { kind: "TypeReference", name: "T", typeArguments: null, start: 9, end: 10 },
      start: 9,
      end: 12,
    },
    start: 0,
    end: 12,
  });
  expect(parseType("unique symbol")).toEqual({
    kind: "TypeOperator",
    operator: "unique",
    type: { kind: "KeywordType", name: "symbol", start: 7, end: 13 },
    start: 0,
    end: 13,
  });
});

test("parses indexed access types with full spans", () => {
  expect(parseType("T[K]")).toEqual({
    kind: "IndexedAccessType",
    objectType: { kind: "TypeReference", name: "T", typeArguments: null, start: 0, end: 1 },
    indexType: { kind: "TypeReference", name: "K", typeArguments: null, start: 2, end: 3 },
    start: 0,
    end: 4,
  });
});

test("parses tuple types with full spans", () => {
  expect(parseType("[A, B]")).toEqual({
    kind: "TupleType",
    elements: [
      {
        kind: "TupleElement",
        elementType: { kind: "TypeReference", name: "A", typeArguments: null, start: 1, end: 2 },
        optional: false,
        rest: false,
        start: 1,
        end: 2,
      },
      {
        kind: "TupleElement",
        elementType: { kind: "TypeReference", name: "B", typeArguments: null, start: 4, end: 5 },
        optional: false,
        rest: false,
        start: 4,
        end: 5,
      },
    ],
    start: 0,
    end: 6,
  });
  expect(parseType("[]")).toEqual({ kind: "TupleType", elements: [], start: 0, end: 2 });
  expect(parseType("[A, B,]")).toMatchObject({
    kind: "TupleType",
    start: 0,
    end: 7,
    elements: [
      { kind: "TupleElement", elementType: { name: "A" } },
      { kind: "TupleElement", elementType: { name: "B" } },
    ],
  });
});

test("parses tuple optional and rest elements", () => {
  expect(parseType("[A?, ...B[]]")).toEqual({
    kind: "TupleType",
    start: 0,
    end: 12,
    elements: [
      {
        kind: "TupleElement",
        elementType: { kind: "TypeReference", name: "A", typeArguments: null, start: 1, end: 2 },
        optional: true,
        rest: false,
        start: 1,
        end: 3,
      },
      {
        kind: "TupleElement",
        elementType: {
          kind: "ArrayType",
          elementType: { kind: "TypeReference", name: "B", typeArguments: null, start: 8, end: 9 },
          start: 8,
          end: 11,
        },
        optional: false,
        rest: true,
        start: 5,
        end: 11,
      },
    ],
  });
});

test("throws ParseError with line and column for malformed types", () => {
  const leadingUnion = captureTypeParseError("| A");
  expect(leadingUnion).toBeInstanceOf(ParseError);
  expect(errorPosition(leadingUnion)).toEqual({ offset: 0, line: 1, column: 1 });
  expect(leadingUnion.message).toBe('unexpected token "|"');

  const trailingUnion = captureTypeParseError("A |");
  expect(trailingUnion).toBeInstanceOf(ParseError);
  expect(errorPosition(trailingUnion)).toEqual({ offset: 3, line: 1, column: 4 });
  expect(trailingUnion.message).toBe("unexpected end of input");

  const bareKeyof = captureTypeParseError("keyof");
  expect(bareKeyof).toBeInstanceOf(ParseError);
  expect(errorPosition(bareKeyof)).toEqual({ offset: 5, line: 1, column: 6 });
  expect(bareKeyof.message).toBe("unexpected end of input");

  const openArguments = captureTypeParseError("Array<");
  expect(openArguments).toBeInstanceOf(ParseError);
  expect(errorPosition(openArguments)).toEqual({ offset: 6, line: 1, column: 7 });
  expect(openArguments.message).toBe("unexpected end of input");

  const openIndex = captureTypeParseError("A[");
  expect(openIndex).toBeInstanceOf(ParseError);
  expect(errorPosition(openIndex)).toEqual({ offset: 2, line: 1, column: 3 });
  expect(openIndex.message).toBe("unexpected end of input");

  const unclosedParen = captureTypeParseError("(A");
  expect(unclosedParen).toBeInstanceOf(ParseError);
  expect(errorPosition(unclosedParen)).toEqual({ offset: 2, line: 1, column: 3 });
  expect(unclosedParen.message).toBe('expected ")"');

  const unclosedTuple = captureTypeParseError("[A");
  expect(unclosedTuple).toBeInstanceOf(ParseError);
  expect(errorPosition(unclosedTuple)).toEqual({ offset: 2, line: 1, column: 3 });
  expect(unclosedTuple.message).toBe('expected "]"');

  const trailingIntersection = captureTypeParseError("A &");
  expect(trailingIntersection).toBeInstanceOf(ParseError);
  expect(errorPosition(trailingIntersection)).toEqual({ offset: 3, line: 1, column: 4 });
  expect(trailingIntersection.message).toBe("unexpected end of input");

  const laterLine = captureTypeParseError("A |\n| B");
  expect(laterLine).toBeInstanceOf(ParseError);
  expect(errorPosition(laterLine)).toEqual({ offset: 4, line: 2, column: 1 });
  expect(laterLine.message).toBe('unexpected token "|"');
});

test("parses empty type literals with full spans", () => {
  expect(parseType("{}")).toEqual({ kind: "TypeLiteral", members: [], start: 0, end: 2 });
  expect(parseType("{ }")).toEqual({ kind: "TypeLiteral", members: [], start: 0, end: 3 });
});

test("parses property signatures with full spans", () => {
  expect(parseType("{ a: string }")).toEqual({
    kind: "TypeLiteral",
    start: 0,
    end: 13,
    members: [
      {
        kind: "PropertySignature",
        name: { kind: "Identifier", name: "a", start: 2, end: 3 },
        optional: false,
        readonly: false,
        type: { kind: "KeywordType", name: "string", start: 5, end: 11 },
        start: 2,
        end: 11,
      },
    ],
  });
});

test("parses optional and readonly property signatures", () => {
  expect(parseType("{ a?: number; readonly b: string }")).toMatchObject({
    kind: "TypeLiteral",
    start: 0,
    end: 34,
    members: [
      {
        kind: "PropertySignature",
        name: { kind: "Identifier", name: "a", start: 2, end: 3 },
        optional: true,
        readonly: false,
        type: { kind: "KeywordType", name: "number", start: 6, end: 12 },
        start: 2,
        end: 12,
      },
      {
        kind: "PropertySignature",
        name: { kind: "Identifier", name: "b", start: 23, end: 24 },
        optional: false,
        readonly: true,
        type: { kind: "KeywordType", name: "string", start: 26, end: 32 },
        start: 14,
        end: 32,
      },
    ],
  });
});

test("parses method signatures", () => {
  expect(parseType("{ m(): void }")).toMatchObject({
    kind: "TypeLiteral",
    start: 0,
    end: 13,
    members: [
      {
        kind: "MethodSignature",
        name: { kind: "Identifier", name: "m", start: 2, end: 3 },
        optional: false,
        typeParameters: null,
        parameters: [],
        returnType: { kind: "KeywordType", name: "void", start: 7, end: 11 },
        start: 2,
        end: 11,
      },
    ],
  });
});

test("parses generic method signatures with parameters and return types", () => {
  expect(parseType("{ m<T>(x: T): T }")).toMatchObject({
    kind: "TypeLiteral",
    start: 0,
    end: 17,
    members: [
      {
        kind: "MethodSignature",
        name: { kind: "Identifier", name: "m", start: 2, end: 3 },
        optional: false,
        typeParameters: [
          {
            kind: "TypeParameter",
            name: { kind: "Identifier", name: "T", start: 4, end: 5 },
            constraint: null,
            default: null,
            start: 4,
            end: 5,
          },
        ],
        parameters: [
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "x", start: 7, end: 8 },
            optional: false,
            rest: false,
            type: { kind: "TypeReference", name: "T", typeArguments: null, start: 10, end: 11 },
            start: 7,
            end: 11,
          },
        ],
        returnType: { kind: "TypeReference", name: "T", typeArguments: null, start: 14, end: 15 },
        start: 2,
        end: 15,
      },
    ],
  });
});

test("parses optional method signatures and trailing separators", () => {
  expect(parseType("{ m?(): void; }")).toMatchObject({
    kind: "TypeLiteral",
    start: 0,
    end: 15,
    members: [
      {
        kind: "MethodSignature",
        name: { kind: "Identifier", name: "m", start: 2, end: 3 },
        optional: true,
        typeParameters: null,
        parameters: [],
        returnType: { kind: "KeywordType", name: "void", start: 8, end: 12 },
        start: 2,
        end: 12,
      },
    ],
  });
});

test("parses construct signatures", () => {
  expect(parseType("{ new (): A }")).toMatchObject({
    kind: "TypeLiteral",
    start: 0,
    end: 13,
    members: [
      {
        kind: "ConstructSignature",
        typeParameters: null,
        parameters: [],
        returnType: { kind: "TypeReference", name: "A", typeArguments: null, start: 10, end: 11 },
        start: 2,
        end: 11,
      },
    ],
  });
});

test("parses call signatures", () => {
  expect(parseType("{ (x: number): string }")).toMatchObject({
    kind: "TypeLiteral",
    start: 0,
    end: 23,
    members: [
      {
        kind: "CallSignature",
        typeParameters: null,
        parameters: [
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "x", start: 3, end: 4 },
            optional: false,
            rest: false,
            type: { kind: "KeywordType", name: "number", start: 6, end: 12 },
            start: 3,
            end: 12,
          },
        ],
        returnType: { kind: "KeywordType", name: "string", start: 15, end: 21 },
        start: 2,
        end: 21,
      },
    ],
  });
});

test("parses index signatures", () => {
  expect(parseType("{ [key: string]: number }")).toMatchObject({
    kind: "TypeLiteral",
    start: 0,
    end: 25,
    members: [
      {
        kind: "IndexSignature",
        readonly: false,
        keyName: { kind: "Identifier", name: "key", start: 3, end: 6 },
        keyType: { kind: "KeywordType", name: "string", start: 8, end: 14 },
        type: { kind: "KeywordType", name: "number", start: 17, end: 23 },
        start: 2,
        end: 23,
      },
    ],
  });
});

test("parses readonly index signatures", () => {
  expect(parseType("{ readonly [key: string]: number }")).toMatchObject({
    kind: "TypeLiteral",
    start: 0,
    end: 34,
    members: [
      {
        kind: "IndexSignature",
        readonly: true,
        keyName: { kind: "Identifier", name: "key", start: 12, end: 15 },
        keyType: { kind: "KeywordType", name: "string", start: 17, end: 23 },
        type: { kind: "KeywordType", name: "number", start: 26, end: 32 },
        start: 2,
        end: 32,
      },
    ],
  });
});

test("parses string and number member names", () => {
  expect(parseType('{ "k": 1 }')).toMatchObject({
    kind: "TypeLiteral",
    start: 0,
    end: 10,
    members: [
      {
        kind: "PropertySignature",
        name: { kind: "StringLiteral", value: "k", raw: '"k"', start: 2, end: 5 },
        optional: false,
        readonly: false,
        type: { kind: "LiteralType", literal: 1, start: 7, end: 8 },
        start: 2,
        end: 8,
      },
    ],
  });
  expect(parseType("{ 42: true }")).toMatchObject({
    kind: "TypeLiteral",
    start: 0,
    end: 12,
    members: [
      {
        kind: "PropertySignature",
        name: { kind: "NumberLiteral", value: 42, raw: "42", start: 2, end: 4 },
        optional: false,
        readonly: false,
        type: { kind: "LiteralType", literal: true, start: 6, end: 10 },
        start: 2,
        end: 10,
      },
    ],
  });
});

test("parses computed member names", () => {
  expect(parseType("{ [k]: T }")).toMatchObject({
    kind: "TypeLiteral",
    start: 0,
    end: 10,
    members: [
      {
        kind: "PropertySignature",
        name: {
          kind: "ComputedPropertyName",
          expression: { kind: "Identifier", name: "k", start: 3, end: 4 },
          start: 2,
          end: 5,
        },
        optional: false,
        readonly: false,
        type: { kind: "TypeReference", name: "T", typeArguments: null, start: 7, end: 8 },
        start: 2,
        end: 8,
      },
    ],
  });
});

test("parses mixed member separators", () => {
  expect(parseType("{ a: 1, b: 2; c: 3 }")).toMatchObject({
    kind: "TypeLiteral",
    start: 0,
    end: 20,
    members: [
      {
        kind: "PropertySignature",
        name: { kind: "Identifier", name: "a" },
        type: { kind: "LiteralType", literal: 1 },
      },
      {
        kind: "PropertySignature",
        name: { kind: "Identifier", name: "b" },
        type: { kind: "LiteralType", literal: 2 },
      },
      {
        kind: "PropertySignature",
        name: { kind: "Identifier", name: "c" },
        type: { kind: "LiteralType", literal: 3 },
      },
    ],
  });
});

test("parses nested type literals", () => {
  expect(parseType("{ a: { b: string } }")).toMatchObject({
    kind: "TypeLiteral",
    start: 0,
    end: 20,
    members: [
      {
        kind: "PropertySignature",
        name: { kind: "Identifier", name: "a", start: 2, end: 3 },
        type: {
          kind: "TypeLiteral",
          start: 5,
          end: 18,
          members: [
            {
              kind: "PropertySignature",
              name: { kind: "Identifier", name: "b", start: 7, end: 8 },
              type: { kind: "KeywordType", name: "string", start: 10, end: 16 },
              start: 7,
              end: 16,
            },
          ],
        },
        start: 2,
        end: 18,
      },
    ],
  });
});

test("parses type parameters directly", () => {
  expect(new Parser("<T>").parseTypeParameters()).toEqual([
    {
      kind: "TypeParameter",
      name: { kind: "Identifier", name: "T", start: 1, end: 2 },
      constraint: null,
      default: null,
      start: 1,
      end: 2,
    },
  ]);
  expect(new Parser("<T extends U, U = D>").parseTypeParameters()).toMatchObject([
    {
      kind: "TypeParameter",
      name: { kind: "Identifier", name: "T", start: 1, end: 2 },
      constraint: { kind: "TypeReference", name: "U", start: 11, end: 12 },
      default: null,
      start: 1,
      end: 12,
    },
    {
      kind: "TypeParameter",
      name: { kind: "Identifier", name: "U", start: 14, end: 15 },
      constraint: null,
      default: { kind: "TypeReference", name: "D", start: 18, end: 19 },
      start: 14,
      end: 19,
    },
  ]);
  expect(new Parser("x").parseTypeParameters()).toBeNull();
});

test("parses const type parameters", () => {
  expect(new Parser("<const T>").parseTypeParameters()).toEqual([
    {
      kind: "TypeParameter",
      name: { kind: "Identifier", name: "T", start: 7, end: 8 },
      constraint: null,
      default: null,
      const: true,
      start: 1,
      end: 8,
    },
  ]);
  const mixed = new Parser("<T, const U extends V = W>").parseTypeParameters();
  expect(mixed).toMatchObject([
    { kind: "TypeParameter", name: { kind: "Identifier", name: "T" } },
    {
      kind: "TypeParameter",
      name: { kind: "Identifier", name: "U" },
      constraint: { kind: "TypeReference", name: "V" },
      default: { kind: "TypeReference", name: "W" },
      const: true,
    },
  ]);
  expect(mixed?.[0]?.const).toBeUndefined();
});

test("parses const type parameters on declarations and arrows", () => {
  expect(parseProgram("function f<const T>(x: T) { return x; }").body[0]).toMatchObject({
    kind: "FunctionDeclaration",
    typeParameters: [
      {
        kind: "TypeParameter",
        name: { kind: "Identifier", name: "T", start: 17, end: 18 },
        const: true,
        start: 11,
        end: 18,
      },
    ],
  });
  expect(
    parseProgram("class A<const T> { m<const U>(x: U): U { return x; } }").body[0],
  ).toMatchObject({
    kind: "ClassDeclaration",
    typeParameters: [{ name: { kind: "Identifier", name: "T" }, const: true }],
    members: [
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "m" },
        typeParameters: [{ name: { kind: "Identifier", name: "U" }, const: true }],
      },
    ],
  });
  expect(parseProgram("const f = <const T>(x: T) => x;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarations: [
      {
        initializer: {
          kind: "ArrowFunctionExpression",
          typeParameters: [{ name: { kind: "Identifier", name: "T" }, const: true }],
        },
      },
    ],
  });
  const plain = parseProgram("function f<T>(x: T) { return x; }").body[0];
  if (plain === undefined || plain.kind !== "FunctionDeclaration") {
    throw new Error("expected a function declaration");
  }
  expect(plain.typeParameters?.[0]?.const).toBeUndefined();
});

test("parses parameter lists directly", () => {
  expect(new Parser("()").parseParameters()).toEqual([]);
  expect(new Parser("(a)").parseParameters()).toEqual([
    {
      kind: "Parameter",
      name: { kind: "Identifier", name: "a", start: 1, end: 2 },
      optional: false,
      rest: false,
      type: null,
      initializer: null,
      start: 1,
      end: 2,
    },
  ]);
  expect(new Parser("(a?: T, ...rest: U[])").parseParameters()).toMatchObject([
    {
      kind: "Parameter",
      name: { kind: "Identifier", name: "a", start: 1, end: 2 },
      optional: true,
      rest: false,
      type: { kind: "TypeReference", name: "T", start: 5, end: 6 },
      start: 1,
      end: 6,
    },
    {
      kind: "Parameter",
      name: { kind: "Identifier", name: "rest", start: 11, end: 15 },
      optional: false,
      rest: true,
      type: {
        kind: "ArrayType",
        elementType: { kind: "TypeReference", name: "U", start: 17, end: 18 },
        start: 17,
        end: 20,
      },
      start: 8,
      end: 20,
    },
  ]);
  expect(new Parser("(a,)").parseParameters()).toMatchObject([
    { kind: "Parameter", name: { kind: "Identifier", name: "a", start: 1, end: 2 } },
  ]);
});

test("throws ParseError with line and column for malformed type literals", () => {
  const missingType = captureTypeParseError("{ a: }");
  expect(missingType).toBeInstanceOf(ParseError);
  expect(errorPosition(missingType)).toEqual({ offset: 5, line: 1, column: 6 });
  expect(missingType.message).toBe('unexpected token "}"');

  const unterminated = captureTypeParseError("{ a");
  expect(unterminated).toBeInstanceOf(ParseError);
  expect(errorPosition(unterminated)).toEqual({ offset: 3, line: 1, column: 4 });
  expect(unterminated.message).toBe("unexpected end of input");

  const emptyCall = captureTypeParseError("{ ( }");
  expect(emptyCall).toBeInstanceOf(ParseError);
  expect(errorPosition(emptyCall)).toEqual({ offset: 4, line: 1, column: 5 });
  expect(emptyCall.message).toBe('unexpected token "}"');

  const indexMissingType = captureTypeParseError("{ [key: string] }");
  expect(indexMissingType).toBeInstanceOf(ParseError);
  expect(errorPosition(indexMissingType)).toEqual({ offset: 16, line: 1, column: 17 });
  expect(indexMissingType.message).toBe('expected ":"');

  const bareReadonly = captureTypeParseError("{ readonly }");
  expect(bareReadonly).toBeInstanceOf(ParseError);
  expect(errorPosition(bareReadonly)).toEqual({ offset: 11, line: 1, column: 12 });
  expect(bareReadonly.message).toBe('unexpected token "}"');

  const unclosed = captureTypeParseError("{ a: string");
  expect(unclosed).toBeInstanceOf(ParseError);
  expect(errorPosition(unclosed)).toEqual({ offset: 11, line: 1, column: 12 });
  expect(unclosed.message).toBe("unexpected end of input");

  const laterLine = captureTypeParseError("{\n a:\n}");
  expect(laterLine).toBeInstanceOf(ParseError);
  expect(errorPosition(laterLine)).toEqual({ offset: 6, line: 3, column: 1 });
  expect(laterLine.message).toBe('unexpected token "}"');
});

test("parses function types with full spans for () => void", () => {
  expect(parseType("() => void")).toEqual({
    kind: "FunctionType",
    typeParameters: null,
    parameters: [],
    returnType: { kind: "KeywordType", name: "void", start: 6, end: 10 },
    start: 0,
    end: 10,
  });
});

test("parses function types with parameters and type parameters", () => {
  expect(parseType("(a: T) => U")).toMatchObject({
    kind: "FunctionType",
    typeParameters: null,
    parameters: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "a", start: 1, end: 2 },
        optional: false,
        rest: false,
        type: { kind: "TypeReference", name: "T", typeArguments: null, start: 4, end: 5 },
        start: 1,
        end: 5,
      },
    ],
    returnType: { kind: "TypeReference", name: "U", typeArguments: null, start: 10, end: 11 },
    start: 0,
    end: 11,
  });
  expect(parseType("<T>(x: T) => T")).toMatchObject({
    kind: "FunctionType",
    typeParameters: [
      {
        kind: "TypeParameter",
        name: { kind: "Identifier", name: "T", start: 1, end: 2 },
        constraint: null,
        default: null,
        start: 1,
        end: 2,
      },
    ],
    parameters: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "x", start: 4, end: 5 },
        type: { kind: "TypeReference", name: "T", typeArguments: null, start: 7, end: 8 },
        start: 4,
        end: 8,
      },
    ],
    returnType: { kind: "TypeReference", name: "T", typeArguments: null, start: 13, end: 14 },
    start: 0,
    end: 14,
  });
  expect(parseType("<T extends U>(x: T) => T")).toMatchObject({
    kind: "FunctionType",
    typeParameters: [
      {
        kind: "TypeParameter",
        name: { kind: "Identifier", name: "T", start: 1, end: 2 },
        constraint: { kind: "TypeReference", name: "U", typeArguments: null, start: 11, end: 12 },
        default: null,
        start: 1,
        end: 12,
      },
    ],
    start: 0,
  });
  expect(parseType("(a: T, b?: U, ...c: V[]) => W")).toMatchObject({
    kind: "FunctionType",
    typeParameters: null,
    parameters: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "a" },
        optional: false,
        rest: false,
        type: { kind: "TypeReference", name: "T" },
      },
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "b" },
        optional: true,
        rest: false,
        type: { kind: "TypeReference", name: "U" },
      },
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "c" },
        optional: false,
        rest: true,
        type: { kind: "ArrayType", elementType: { kind: "TypeReference", name: "V" } },
      },
    ],
    returnType: { kind: "TypeReference", name: "W" },
    start: 0,
    end: 29,
  });
});

test("parses constructor types", () => {
  expect(parseType("new (a: T) => U")).toMatchObject({
    kind: "ConstructorType",
    abstract: false,
    typeParameters: null,
    parameters: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "a", start: 5, end: 6 },
        optional: false,
        rest: false,
        type: { kind: "TypeReference", name: "T", typeArguments: null, start: 8, end: 9 },
        start: 5,
        end: 9,
      },
    ],
    returnType: { kind: "TypeReference", name: "U", typeArguments: null, start: 14, end: 15 },
    start: 0,
    end: 15,
  });
  expect(parseType("abstract new () => A")).toMatchObject({
    kind: "ConstructorType",
    abstract: true,
    typeParameters: null,
    parameters: [],
    returnType: { kind: "TypeReference", name: "A", typeArguments: null, start: 19, end: 20 },
    start: 0,
    end: 20,
  });
  expect(parseType("new <T>(x: T) => T")).toMatchObject({
    kind: "ConstructorType",
    abstract: false,
    typeParameters: [{ kind: "TypeParameter", name: { kind: "Identifier", name: "T", start: 5 } }],
    start: 0,
    end: 18,
  });
});

test("keeps parenthesized types distinct from function types", () => {
  expect(parseType("(A | B)")).toEqual({
    kind: "ParenthesizedType",
    type: {
      kind: "UnionType",
      start: 1,
      end: 6,
      types: [
        { kind: "TypeReference", name: "A", typeArguments: null, start: 1, end: 2 },
        { kind: "TypeReference", name: "B", typeArguments: null, start: 5, end: 6 },
      ],
    },
    start: 0,
    end: 7,
  });
  expect(parseType("(A)[]")).toMatchObject({
    kind: "ArrayType",
    elementType: {
      kind: "ParenthesizedType",
      type: { kind: "TypeReference", name: "A", typeArguments: null, start: 1, end: 2 },
      start: 0,
      end: 3,
    },
    start: 0,
    end: 5,
  });
  expect(parseType("((a: T) => U)[]")).toMatchObject({
    kind: "ArrayType",
    elementType: {
      kind: "ParenthesizedType",
      type: {
        kind: "FunctionType",
        parameters: [
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "a", start: 2, end: 3 },
            type: { kind: "TypeReference", name: "T", typeArguments: null, start: 5, end: 6 },
            start: 2,
            end: 6,
          },
        ],
        returnType: { kind: "TypeReference", name: "U", typeArguments: null, start: 11, end: 12 },
        start: 1,
        end: 12,
      },
      start: 0,
      end: 13,
    },
    start: 0,
    end: 15,
  });
});

test("parses function type property signatures and nested returns", () => {
  expect(parseType("{ f: (x: number) => string }")).toMatchObject({
    kind: "TypeLiteral",
    members: [
      {
        kind: "PropertySignature",
        name: { kind: "Identifier", name: "f", start: 2, end: 3 },
        optional: false,
        readonly: false,
        type: {
          kind: "FunctionType",
          typeParameters: null,
          parameters: [
            {
              kind: "Parameter",
              name: { kind: "Identifier", name: "x", start: 6, end: 7 },
              type: { kind: "KeywordType", name: "number", start: 9, end: 15 },
              start: 6,
              end: 15,
            },
          ],
          returnType: { kind: "KeywordType", name: "string", start: 20, end: 26 },
          start: 5,
          end: 26,
        },
        start: 2,
        end: 26,
      },
    ],
  });
  expect(parseType("() => () => void")).toMatchObject({
    kind: "FunctionType",
    typeParameters: null,
    parameters: [],
    returnType: {
      kind: "FunctionType",
      typeParameters: null,
      parameters: [],
      returnType: { kind: "KeywordType", name: "void", start: 12, end: 16 },
      start: 6,
      end: 16,
    },
    start: 0,
    end: 16,
  });
});

test("parses method signatures with type predicates", () => {
  expect(parseType("{ m(x: unknown): asserts x is string }")).toMatchObject({
    kind: "TypeLiteral",
    members: [
      {
        kind: "MethodSignature",
        name: { kind: "Identifier", name: "m", start: 2, end: 3 },
        parameters: [
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "x", start: 4, end: 5 },
            type: { kind: "KeywordType", name: "unknown", start: 7, end: 14 },
          },
        ],
        returnType: {
          kind: "TypePredicate",
          asserts: true,
          parameterName: "x",
          type: { kind: "KeywordType", name: "string", start: 30, end: 36 },
          start: 17,
          end: 36,
        },
        start: 2,
        end: 36,
      },
    ],
  });
  expect(parseType("{ m(x: unknown): asserts x }")).toMatchObject({
    kind: "TypeLiteral",
    members: [
      {
        kind: "MethodSignature",
        returnType: {
          kind: "TypePredicate",
          asserts: true,
          parameterName: "x",
          type: null,
          start: 17,
          end: 26,
        },
        start: 2,
        end: 26,
      },
    ],
  });
  expect(parseType("{ m(x): x is T }")).toMatchObject({
    kind: "TypeLiteral",
    members: [
      {
        kind: "MethodSignature",
        returnType: {
          kind: "TypePredicate",
          asserts: false,
          parameterName: "x",
          type: { kind: "TypeReference", name: "T", typeArguments: null, start: 13, end: 14 },
          start: 8,
          end: 14,
        },
        start: 2,
        end: 14,
      },
    ],
  });
  expect(parseType("{ m(x: unknown): asserts this }")).toMatchObject({
    kind: "TypeLiteral",
    members: [
      {
        kind: "MethodSignature",
        returnType: {
          kind: "TypePredicate",
          asserts: true,
          parameterName: "this",
          type: null,
        },
      },
    ],
  });
});

test("throws ParseError with line and column for function and constructor types", () => {
  const badParameter = captureTypeParseError("(: T) => U");
  expect(badParameter).toBeInstanceOf(ParseError);
  expect(errorPosition(badParameter)).toEqual({ offset: 1, line: 1, column: 2 });
  expect(badParameter.message).toBe('unexpected token ":"');

  const missingArrow = captureTypeParseError("(a: T)");
  expect(missingArrow).toBeInstanceOf(ParseError);
  expect(errorPosition(missingArrow)).toEqual({ offset: 6, line: 1, column: 7 });
  expect(missingArrow.message).toBe('expected "=>"');

  const bareNew = captureTypeParseError("new ()");
  expect(bareNew).toBeInstanceOf(ParseError);
  expect(errorPosition(bareNew)).toEqual({ offset: 6, line: 1, column: 7 });
  expect(bareNew.message).toBe('expected "=>"');

  const abstractWithoutNew = captureTypeParseError("abstract () => A");
  expect(abstractWithoutNew).toBeInstanceOf(ParseError);
  expect(errorPosition(abstractWithoutNew)).toEqual({ offset: 9, line: 1, column: 10 });
  expect(abstractWithoutNew.message).toBe('expected keyword "new"');

  const bareAsserts = captureTypeParseError("() => asserts");
  expect(bareAsserts).toBeInstanceOf(ParseError);
  expect(errorPosition(bareAsserts)).toEqual({ offset: 13, line: 1, column: 14 });
  expect(bareAsserts.message).toBe("unexpected end of input");
});

test("parses conditional types with full spans", () => {
  expect(parseType("T extends U ? X : Y")).toEqual({
    kind: "ConditionalType",
    checkType: { kind: "TypeReference", name: "T", typeArguments: null, start: 0, end: 1 },
    extendsType: { kind: "TypeReference", name: "U", typeArguments: null, start: 10, end: 11 },
    trueType: { kind: "TypeReference", name: "X", typeArguments: null, start: 14, end: 15 },
    falseType: { kind: "TypeReference", name: "Y", typeArguments: null, start: 18, end: 19 },
    start: 0,
    end: 19,
  });
});

test("parses nested conditional types right-associatively", () => {
  expect(parseType("T extends U ? X : T extends V ? A : B")).toMatchObject({
    kind: "ConditionalType",
    checkType: { kind: "TypeReference", name: "T" },
    extendsType: { kind: "TypeReference", name: "U" },
    trueType: { kind: "TypeReference", name: "X" },
    falseType: {
      kind: "ConditionalType",
      checkType: { kind: "TypeReference", name: "T" },
      extendsType: { kind: "TypeReference", name: "V" },
      trueType: { kind: "TypeReference", name: "A" },
      falseType: { kind: "TypeReference", name: "B" },
      start: 18,
      end: 37,
    },
    start: 0,
    end: 37,
  });
});

test("applies postfix arrays to the false branch of conditional types", () => {
  expect(parseType("T extends U ? X : Y[]")).toMatchObject({
    kind: "ConditionalType",
    falseType: {
      kind: "ArrayType",
      elementType: { kind: "TypeReference", name: "Y", start: 18, end: 19 },
      start: 18,
      end: 21,
    },
    start: 0,
    end: 21,
  });
});

test("parses conditional types with union check types", () => {
  expect(parseType("A | B extends C ? X : Y")).toMatchObject({
    kind: "ConditionalType",
    checkType: {
      kind: "UnionType",
      types: [
        { kind: "TypeReference", name: "A" },
        { kind: "TypeReference", name: "B" },
      ],
      start: 0,
      end: 5,
    },
    extendsType: { kind: "TypeReference", name: "C", start: 14, end: 15 },
    start: 0,
    end: 23,
  });
});

test("parses infer types", () => {
  expect(parseType("infer U")).toMatchObject({
    kind: "InferType",
    name: { kind: "Identifier", name: "U", start: 6, end: 7 },
    constraint: null,
    start: 0,
    end: 7,
  });
  expect(parseType("infer U extends string")).toMatchObject({
    kind: "InferType",
    name: { kind: "Identifier", name: "U", start: 6, end: 7 },
    constraint: { kind: "KeywordType", name: "string", start: 16, end: 22 },
    start: 0,
    end: 22,
  });
});

test("parses mapped types", () => {
  expect(parseType("{ [K in T]: V }")).toMatchObject({
    kind: "MappedType",
    keyName: { kind: "Identifier", name: "K", start: 3, end: 4 },
    constraint: { kind: "TypeReference", name: "T", start: 8, end: 9 },
    readonly: null,
    optional: null,
    valueType: { kind: "TypeReference", name: "V", start: 12, end: 13 },
    start: 0,
    end: 15,
  });
  expect(parseType("{ [K in T]; }")).toMatchObject({
    kind: "MappedType",
    valueType: null,
    readonly: null,
    optional: null,
    start: 0,
    end: 13,
  });
});

test("parses mapped type readonly and optional modifiers", () => {
  expect(parseType("{ readonly [K in T]: V }")).toMatchObject({
    kind: "MappedType",
    readonly: "add",
    optional: null,
    valueType: { kind: "TypeReference", name: "V" },
  });
  expect(parseType("{ [K in T]?: V }")).toMatchObject({
    kind: "MappedType",
    readonly: null,
    optional: "add",
    valueType: { kind: "TypeReference", name: "V" },
  });
  expect(parseType("{ -readonly [K in keyof T]-?: T[K] }")).toMatchObject({
    kind: "MappedType",
    keyName: { kind: "Identifier", name: "K", start: 13, end: 14 },
    constraint: {
      kind: "TypeOperator",
      operator: "keyof",
      type: { kind: "TypeReference", name: "T", start: 24, end: 25 },
    },
    readonly: "remove",
    optional: "remove",
    valueType: {
      kind: "IndexedAccessType",
      objectType: { kind: "TypeReference", name: "T" },
      indexType: { kind: "TypeReference", name: "K" },
    },
    start: 0,
    end: 36,
  });
});

test("parses import types", () => {
  expect(parseType('import("m")')).toMatchObject({
    kind: "ImportType",
    argument: "m",
    qualifier: null,
    typeArguments: null,
    start: 0,
    end: 11,
  });
  expect(parseType('import("m").A')).toMatchObject({
    kind: "ImportType",
    argument: "m",
    qualifier: "A",
    typeArguments: null,
    start: 0,
    end: 13,
  });
  expect(parseType('import("./x").A.B<C>')).toMatchObject({
    kind: "ImportType",
    argument: "./x",
    qualifier: "A.B",
    typeArguments: [{ kind: "TypeReference", name: "C", start: 18, end: 19 }],
    start: 0,
    end: 20,
  });
});

test("parses template literal types with full spans", () => {
  expect(parseType("`a${T}b`")).toEqual({
    kind: "TemplateLiteralType",
    quasis: ["a", "b"],
    types: [{ kind: "TypeReference", name: "T", typeArguments: null, start: 4, end: 5 }],
    start: 0,
    end: 8,
  });
});

test("parses template literal types with multiple substitutions", () => {
  expect(parseType("`a${T}b${U}c`")).toMatchObject({
    kind: "TemplateLiteralType",
    quasis: ["a", "b", "c"],
    types: [
      { kind: "TypeReference", name: "T", start: 4, end: 5 },
      { kind: "TypeReference", name: "U", start: 9, end: 10 },
    ],
    start: 0,
    end: 13,
  });
});

test("parses template literal types with literal substitutions", () => {
  expect(parseType('`a${"x"}b`')).toMatchObject({
    kind: "TemplateLiteralType",
    quasis: ["a", "b"],
    types: [{ kind: "LiteralType", literal: "x", start: 4, end: 7 }],
    start: 0,
    end: 10,
  });
});

test("parses no-substitution template literal types", () => {
  expect(parseType("`x`")).toEqual({
    kind: "TemplateLiteralType",
    quasis: ["x"],
    types: [],
    start: 0,
    end: 3,
  });
});

test("throws ParseError with line and column for malformed advanced types", () => {
  const bareInfer = captureTypeParseError("infer");
  expect(bareInfer).toBeInstanceOf(ParseError);
  expect(errorPosition(bareInfer)).toEqual({ offset: 5, line: 1, column: 6 });
  expect(bareInfer.message).toBe("unexpected end of input");

  const emptyMappedConstraint = captureTypeParseError("{ [K in ]: V }");
  expect(emptyMappedConstraint).toBeInstanceOf(ParseError);
  expect(errorPosition(emptyMappedConstraint)).toEqual({ offset: 8, line: 1, column: 9 });
  expect(emptyMappedConstraint.message).toBe('unexpected token "]"');

  const emptyImport = captureTypeParseError("import()");
  expect(emptyImport).toBeInstanceOf(ParseError);
  expect(errorPosition(emptyImport)).toEqual({ offset: 7, line: 1, column: 8 });
  expect(emptyImport.message).toBe('unexpected token ")"');

  const missingExtendsType = captureTypeParseError("T extends ? X : Y");
  expect(missingExtendsType).toBeInstanceOf(ParseError);
  expect(errorPosition(missingExtendsType)).toEqual({ offset: 10, line: 1, column: 11 });
  expect(missingExtendsType.message).toBe('unexpected token "?"');

  const unclosedMapped = captureTypeParseError("{ [K in T");
  expect(unclosedMapped).toBeInstanceOf(ParseError);
  expect(errorPosition(unclosedMapped)).toEqual({ offset: 9, line: 1, column: 10 });
  expect(unclosedMapped.message).toBe('expected "]"');

  const unterminatedTemplate = captureTypeParseError("`a${T ");
  expect(unterminatedTemplate).toBeInstanceOf(ParseError);
  expect(errorPosition(unterminatedTemplate)).toEqual({ offset: 6, line: 1, column: 7 });
  expect(unterminatedTemplate.message).toBe("unexpected end of input");
});

test("parses as and satisfies expressions with full spans", () => {
  expect(parse("x as T")).toEqual({
    kind: "AsExpression",
    expression: { kind: "Identifier", name: "x", start: 0, end: 1 },
    operator: "as",
    type: { kind: "TypeReference", name: "T", typeArguments: null, start: 5, end: 6 },
    start: 0,
    end: 6,
  });
  expect(parse("x as const")).toMatchObject({
    kind: "AsExpression",
    expression: { kind: "Identifier", name: "x", start: 0, end: 1 },
    operator: "as",
    type: { kind: "ConstType", start: 5, end: 10 },
    start: 0,
    end: 10,
  });
  expect(parse("x satisfies T")).toMatchObject({
    kind: "AsExpression",
    expression: { kind: "Identifier", name: "x", start: 0, end: 1 },
    operator: "satisfies",
    type: { kind: "TypeReference", name: "T", start: 12, end: 13 },
    start: 0,
    end: 13,
  });
});

test("chains as and satisfies expressions", () => {
  expect(parse("x as A as B")).toMatchObject({
    kind: "AsExpression",
    expression: {
      kind: "AsExpression",
      expression: { kind: "Identifier", name: "x", start: 0, end: 1 },
      operator: "as",
      type: { kind: "TypeReference", name: "A", start: 5, end: 6 },
      start: 0,
      end: 6,
    },
    operator: "as",
    type: { kind: "TypeReference", name: "B", start: 10, end: 11 },
    start: 0,
    end: 11,
  });
  expect(parse("x as T satisfies U")).toMatchObject({
    kind: "AsExpression",
    expression: {
      kind: "AsExpression",
      expression: { kind: "Identifier", name: "x", start: 0, end: 1 },
      operator: "as",
      type: { kind: "TypeReference", name: "T", start: 5, end: 6 },
      start: 0,
      end: 6,
    },
    operator: "satisfies",
    type: { kind: "TypeReference", name: "U", start: 17, end: 18 },
    start: 0,
    end: 18,
  });
});

test("parses call expressions with type arguments", () => {
  expect(parse("f<T>()")).toEqual({
    kind: "CallExpression",
    callee: { kind: "Identifier", name: "f", start: 0, end: 1 },
    arguments: [],
    optional: false,
    start: 0,
    end: 6,
    typeArguments: [{ kind: "TypeReference", name: "T", typeArguments: null, start: 2, end: 3 }],
  });
  expect(parse("f<T, U>(1)")).toMatchObject({
    kind: "CallExpression",
    callee: { kind: "Identifier", name: "f", start: 0, end: 1 },
    arguments: [{ kind: "NumberLiteral", value: 1, start: 8, end: 9 }],
    optional: false,
    start: 0,
    end: 10,
    typeArguments: [
      { kind: "TypeReference", name: "T", start: 2, end: 3 },
      { kind: "TypeReference", name: "U", start: 5, end: 6 },
    ],
  });
  expect(parse("a.b<T>(x)")).toMatchObject({
    kind: "CallExpression",
    callee: {
      kind: "MemberExpression",
      object: { kind: "Identifier", name: "a", start: 0, end: 1 },
      property: { kind: "Identifier", name: "b", start: 2, end: 3 },
      computed: false,
      optional: false,
      start: 0,
      end: 3,
    },
    arguments: [{ kind: "Identifier", name: "x", start: 7, end: 8 }],
    optional: false,
    start: 0,
    end: 9,
    typeArguments: [{ kind: "TypeReference", name: "T", start: 4, end: 5 }],
  });
});

test("parses new expressions with type arguments", () => {
  expect(parse("new A<T>()")).toEqual({
    kind: "NewExpression",
    callee: { kind: "Identifier", name: "A", start: 4, end: 5 },
    arguments: [],
    start: 0,
    end: 10,
    typeArguments: [{ kind: "TypeReference", name: "T", typeArguments: null, start: 6, end: 7 }],
  });
  expect(parse("new A<T>(1, 2)")).toMatchObject({
    kind: "NewExpression",
    callee: { kind: "Identifier", name: "A", start: 4, end: 5 },
    arguments: [
      { kind: "NumberLiteral", value: 1, start: 9, end: 10 },
      { kind: "NumberLiteral", value: 2, start: 12, end: 13 },
    ],
    start: 0,
    end: 14,
    typeArguments: [{ kind: "TypeReference", name: "T", start: 6, end: 7 }],
  });
});

test("parses angle bracket type assertions", () => {
  expect(parse("<T>x")).toEqual({
    kind: "TypeAssertion",
    type: { kind: "TypeReference", name: "T", typeArguments: null, start: 1, end: 2 },
    expression: { kind: "Identifier", name: "x", start: 3, end: 4 },
    start: 0,
    end: 4,
  });
  expect(parse("<string>y + z")).toMatchObject({
    kind: "BinaryExpression",
    operator: "+",
    left: {
      kind: "TypeAssertion",
      type: { kind: "KeywordType", name: "string", start: 1, end: 7 },
      expression: { kind: "Identifier", name: "y", start: 8, end: 9 },
      start: 0,
      end: 9,
    },
    right: { kind: "Identifier", name: "z", start: 12, end: 13 },
    start: 0,
    end: 13,
  });
  expect(parse("<Foo<Bar>>x")).toMatchObject({
    kind: "TypeAssertion",
    type: {
      kind: "TypeReference",
      name: "Foo",
      typeArguments: [{ kind: "TypeReference", name: "Bar", start: 5, end: 8 }],
      start: 1,
      end: 9,
    },
    expression: { kind: "Identifier", name: "x", start: 10, end: 11 },
    start: 0,
    end: 11,
  });
});

test("applies as to type assertions", () => {
  expect(parse("<T>a as U")).toMatchObject({
    kind: "AsExpression",
    expression: {
      kind: "TypeAssertion",
      type: { kind: "TypeReference", name: "T", start: 1, end: 2 },
      expression: { kind: "Identifier", name: "a", start: 3, end: 4 },
      start: 0,
      end: 4,
    },
    operator: "as",
    type: { kind: "TypeReference", name: "U", start: 8, end: 9 },
    start: 0,
    end: 9,
  });
});

test("restores type argument speculation when no call follows", () => {
  const expression = parse("f<T> g");
  expect(expression).toEqual({
    kind: "BinaryExpression",
    operator: ">",
    left: {
      kind: "BinaryExpression",
      operator: "<",
      left: { kind: "Identifier", name: "f", start: 0, end: 1 },
      right: { kind: "Identifier", name: "T", start: 2, end: 3 },
      start: 0,
      end: 3,
    },
    right: { kind: "Identifier", name: "g", start: 5, end: 6 },
    start: 0,
    end: 6,
  });
  expect("typeArguments" in expression).toBe(false);
  expect(parse("a < b")).toEqual({
    kind: "BinaryExpression",
    operator: "<",
    left: { kind: "Identifier", name: "a", start: 0, end: 1 },
    right: { kind: "Identifier", name: "b", start: 4, end: 5 },
    start: 0,
    end: 5,
  });
});

test("omits typeArguments on calls without type arguments", () => {
  const call = parse("f()");
  expect(call).toEqual({
    kind: "CallExpression",
    callee: { kind: "Identifier", name: "f", start: 0, end: 1 },
    arguments: [],
    optional: false,
    start: 0,
    end: 3,
  });
  expect("typeArguments" in call).toBe(false);
});

test("throws ParseError with line and column for malformed typed expressions", () => {
  const missingAsType = captureParseError("x as");
  expect(missingAsType).toBeInstanceOf(ParseError);
  expect(errorPosition(missingAsType)).toEqual({ offset: 4, line: 1, column: 5 });
  expect(missingAsType.message).toBe("unexpected end of input");

  const emptyTypeArguments = captureParseError("f<>(");
  expect(emptyTypeArguments).toBeInstanceOf(ParseError);
  expect(errorPosition(emptyTypeArguments)).toEqual({ offset: 2, line: 1, column: 3 });
  expect(emptyTypeArguments.message).toBe('unexpected token ">"');

  const missingAssertionOperand = captureParseError("<T>");
  expect(missingAssertionOperand).toBeInstanceOf(ParseError);
  expect(errorPosition(missingAssertionOperand)).toEqual({ offset: 3, line: 1, column: 4 });
  expect(missingAssertionOperand.message).toBe("unexpected end of input");
});

test("parses empty programs and empty statements", () => {
  expect(parseProgram("")).toEqual({
    kind: "Program",
    body: [],
    source: "",
    start: 0,
    end: 0,
  });
  expect(parseProgram(";")).toEqual({
    kind: "Program",
    body: [{ kind: "EmptyStatement", start: 0, end: 1 }],
    source: ";",
    start: 0,
    end: 1,
  });
});

test("parses expression statements with full spans", () => {
  expect(parseProgram("x;")).toEqual({
    kind: "Program",
    body: [
      {
        kind: "ExpressionStatement",
        expression: { kind: "Identifier", name: "x", start: 0, end: 1 },
        start: 0,
        end: 2,
      },
    ],
    source: "x;",
    start: 0,
    end: 2,
  });
  expect(parseProgram("x + 1;").body[0]).toMatchObject({
    kind: "ExpressionStatement",
    expression: {
      kind: "BinaryExpression",
      operator: "+",
      left: { kind: "Identifier", name: "x", start: 0, end: 1 },
      right: { kind: "NumberLiteral", value: 1, raw: "1", start: 4, end: 5 },
      start: 0,
      end: 5,
    },
    start: 0,
    end: 6,
  });
});

test("parses block statements", () => {
  expect(parseProgram("{ x; }")).toEqual({
    kind: "Program",
    body: [
      {
        kind: "BlockStatement",
        body: [
          {
            kind: "ExpressionStatement",
            expression: { kind: "Identifier", name: "x", start: 2, end: 3 },
            start: 2,
            end: 4,
          },
        ],
        start: 0,
        end: 6,
      },
    ],
    source: "{ x; }",
    start: 0,
    end: 6,
  });
  expect(parseProgram("{ { y } }").body[0]).toMatchObject({
    kind: "BlockStatement",
    start: 0,
    end: 9,
    body: [
      {
        kind: "BlockStatement",
        start: 2,
        end: 7,
        body: [
          {
            kind: "ExpressionStatement",
            expression: { kind: "Identifier", name: "y", start: 4, end: 5 },
            start: 4,
            end: 5,
          },
        ],
      },
    ],
  });
  expect(parseProgram("{}")).toEqual({
    kind: "Program",
    body: [{ kind: "BlockStatement", body: [], start: 0, end: 2 }],
    source: "{}",
    start: 0,
    end: 2,
  });
});

test("parses variable statements with full spans", () => {
  expect(parseProgram("let a = 1;")).toEqual({
    kind: "Program",
    body: [
      {
        kind: "VariableStatement",
        declarationKind: "let",
        declarations: [
          {
            kind: "VariableDeclarator",
            name: { kind: "Identifier", name: "a", start: 4, end: 5 },
            type: null,
            initializer: { kind: "NumberLiteral", value: 1, raw: "1", start: 8, end: 9 },
            start: 4,
            end: 9,
          },
        ],
        start: 0,
        end: 10,
      },
    ],
    source: "let a = 1;",
    start: 0,
    end: 10,
  });
});

test("parses variable declarations with types and initializers", () => {
  expect(parseProgram("const b: T = x;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarationKind: "const",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: { kind: "Identifier", name: "b", start: 6, end: 7 },
        type: { kind: "TypeReference", name: "T", typeArguments: null, start: 9, end: 10 },
        initializer: { kind: "Identifier", name: "x", start: 13, end: 14 },
        start: 6,
        end: 14,
      },
    ],
    start: 0,
    end: 15,
  });
  expect(parseProgram("var c;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarationKind: "var",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: { kind: "Identifier", name: "c", start: 4, end: 5 },
        type: null,
        initializer: null,
        start: 4,
        end: 5,
      },
    ],
    start: 0,
    end: 6,
  });
  expect(parseProgram("let a = 1, b;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarationKind: "let",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: { kind: "Identifier", name: "a", start: 4, end: 5 },
        type: null,
        initializer: { kind: "NumberLiteral", value: 1, raw: "1", start: 8, end: 9 },
        start: 4,
        end: 9,
      },
      {
        kind: "VariableDeclarator",
        name: { kind: "Identifier", name: "b", start: 11, end: 12 },
        type: null,
        initializer: null,
        start: 11,
        end: 12,
      },
    ],
    start: 0,
    end: 13,
  });
  expect(parseProgram('const s = "x" + `y`;').body[0]).toMatchObject({
    kind: "VariableStatement",
    declarationKind: "const",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: { kind: "Identifier", name: "s", start: 6, end: 7 },
        type: null,
        initializer: {
          kind: "BinaryExpression",
          operator: "+",
          left: { kind: "StringLiteral", value: "x", raw: '"x"', start: 10, end: 13 },
          right: {
            kind: "TemplateLiteral",
            quasis: ["y"],
            expressions: [],
            start: 16,
            end: 19,
          },
          start: 10,
          end: 19,
        },
        start: 6,
        end: 19,
      },
    ],
    start: 0,
    end: 20,
  });
});

test("parses using and await using declarations as variable statements", () => {
  expect(parseProgram("using x = resource();").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarationKind: "using",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: { kind: "Identifier", name: "x", start: 6, end: 7 },
        initializer: { kind: "CallExpression", start: 10, end: 20 },
        start: 6,
        end: 20,
      },
    ],
    start: 0,
    end: 21,
  });
  expect(parseProgram("using x = resource();").body[0]).not.toHaveProperty("await");
  expect(parseProgram("async function f() { await using x = resource(); }").body[0]).toMatchObject({
    kind: "FunctionDeclaration",
    body: {
      body: [
        {
          kind: "VariableStatement",
          declarationKind: "using",
          await: true,
          declarations: [{ name: { kind: "Identifier", name: "x", start: 33, end: 34 } }],
          start: 21,
          end: 48,
        },
      ],
    },
  });
  expect(parseProgram("function f() { using a = 1, b = 2; }").body[0]).toMatchObject({
    body: {
      body: [
        {
          kind: "VariableStatement",
          declarationKind: "using",
          declarations: [
            { name: { kind: "Identifier", name: "a" } },
            { name: { kind: "Identifier", name: "b" } },
          ],
        },
      ],
    },
  });
  expect(parseProgram("function f() { using { a, b } = obj; }").body[0]).toMatchObject({
    body: {
      body: [
        {
          kind: "VariableStatement",
          declarationKind: "using",
          declarations: [{ name: { kind: "ObjectPattern" } }],
        },
      ],
    },
  });
});

test("keeps using usable as an ordinary identifier", () => {
  expect(parseProgram("using(1);").body[0]).toMatchObject({
    kind: "ExpressionStatement",
    expression: {
      kind: "CallExpression",
      callee: { kind: "Identifier", name: "using", start: 0, end: 5 },
      start: 0,
      end: 8,
    },
  });
  expect(parseProgram("using = 1;").body[0]).toMatchObject({
    kind: "ExpressionStatement",
    expression: {
      kind: "AssignmentExpression",
      left: { kind: "Identifier", name: "using" },
    },
  });
  // Like TypeScript, `using [` stays a member expression, not a declaration.
  expect(parseProgram("using[0] = 1;").body[0]).toMatchObject({
    kind: "ExpressionStatement",
    expression: {
      kind: "AssignmentExpression",
      left: {
        kind: "MemberExpression",
        object: { kind: "Identifier", name: "using", start: 0, end: 5 },
        property: { kind: "NumberLiteral", value: 0, start: 6, end: 7 },
        computed: true,
      },
    },
  });
  const separated = parseProgram("function f() { using\nx = 1; }").body[0];
  expect(separated).toMatchObject({
    kind: "FunctionDeclaration",
    body: {
      body: [{ kind: "ExpressionStatement" }, { kind: "ExpressionStatement" }],
    },
  });
});

test("parses function declarations", () => {
  expect(parseProgram("function f(a: T): U { return a; }").body[0]).toMatchObject({
    kind: "FunctionDeclaration",
    name: { kind: "Identifier", name: "f", start: 9, end: 10 },
    typeParameters: null,
    parameters: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "a", start: 11, end: 12 },
        optional: false,
        rest: false,
        type: { kind: "TypeReference", name: "T", typeArguments: null, start: 14, end: 15 },
        start: 11,
        end: 15,
      },
    ],
    returnType: { kind: "TypeReference", name: "U", typeArguments: null, start: 18, end: 19 },
    body: {
      kind: "BlockStatement",
      start: 20,
      end: 33,
      body: [
        {
          kind: "ReturnStatement",
          argument: { kind: "Identifier", name: "a", start: 29, end: 30 },
          start: 22,
          end: 31,
        },
      ],
    },
    start: 0,
    end: 33,
  });
  expect(parseProgram("function f() {}").body[0]).toMatchObject({
    kind: "FunctionDeclaration",
    name: { kind: "Identifier", name: "f", start: 9, end: 10 },
    typeParameters: null,
    parameters: [],
    returnType: null,
    body: { kind: "BlockStatement", body: [], start: 13, end: 15 },
    start: 0,
    end: 15,
  });
  expect(parseProgram("function g<T>(x: T): T { return x; }").body[0]).toMatchObject({
    kind: "FunctionDeclaration",
    name: { kind: "Identifier", name: "g", start: 9, end: 10 },
    typeParameters: [
      {
        kind: "TypeParameter",
        name: { kind: "Identifier", name: "T", start: 11, end: 12 },
        constraint: null,
        default: null,
        start: 11,
        end: 12,
      },
    ],
    parameters: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "x", start: 14, end: 15 },
        type: { kind: "TypeReference", name: "T", typeArguments: null, start: 17, end: 18 },
        start: 14,
        end: 18,
      },
    ],
    returnType: { kind: "TypeReference", name: "T", typeArguments: null, start: 21, end: 22 },
    body: {
      kind: "BlockStatement",
      start: 23,
      end: 36,
      body: [
        {
          kind: "ReturnStatement",
          argument: { kind: "Identifier", name: "x", start: 32, end: 33 },
          start: 25,
          end: 34,
        },
      ],
    },
    start: 0,
    end: 36,
  });
});

test("parses generator and async function declarations", () => {
  const generator = parseProgram("function* g() {}").body[0];
  expect(generator).toMatchObject({
    kind: "FunctionDeclaration",
    name: { kind: "Identifier", name: "g", start: 10, end: 11 },
    body: { kind: "BlockStatement", start: 14, end: 16 },
    start: 0,
    end: 16,
  });
  expect(generator).toHaveProperty("generator", true);

  const plain = parseProgram("function f() {}").body[0];
  expect(plain).not.toHaveProperty("generator");
  expect(plain).not.toHaveProperty("async");

  const async = parseProgram("async function f() {}").body[0];
  expect(async).toMatchObject({
    kind: "FunctionDeclaration",
    name: { kind: "Identifier", name: "f", start: 15, end: 16 },
    body: { kind: "BlockStatement", start: 19, end: 21 },
    start: 0,
    end: 21,
  });
  expect(async).toHaveProperty("async", true);
  expect(async).not.toHaveProperty("generator");

  expect(parseProgram("async;").body[0]).toMatchObject({
    kind: "ExpressionStatement",
    expression: { kind: "Identifier", name: "async", start: 0, end: 5 },
    start: 0,
    end: 6,
  });
});

test("parses function overload signatures", () => {
  const program = parseProgram("function f(a: T): U; function f(a: T): U { return a; }");
  expect(program.body.length).toBe(2);
  expect(program.body[0]).toMatchObject({
    kind: "FunctionDeclaration",
    name: { kind: "Identifier", name: "f", start: 9, end: 10 },
    returnType: { kind: "TypeReference", name: "U", typeArguments: null, start: 18, end: 19 },
    body: null,
    start: 0,
    end: 20,
  });
  expect(program.body[1]).toMatchObject({
    kind: "FunctionDeclaration",
    name: { kind: "Identifier", name: "f", start: 30, end: 31 },
    returnType: { kind: "TypeReference", name: "U", typeArguments: null, start: 39, end: 40 },
    body: { kind: "BlockStatement", start: 41, end: 54 },
    start: 21,
    end: 54,
  });
});

test("parses return statements", () => {
  expect(parseProgram("function f() { return; }").body[0]).toMatchObject({
    kind: "FunctionDeclaration",
    body: {
      kind: "BlockStatement",
      body: [{ kind: "ReturnStatement", argument: null, start: 15, end: 22 }],
    },
  });
  expect(parseProgram("function f() { return x; }").body[0]).toMatchObject({
    kind: "FunctionDeclaration",
    body: {
      kind: "BlockStatement",
      body: [
        {
          kind: "ReturnStatement",
          argument: { kind: "Identifier", name: "x", start: 22, end: 23 },
          start: 15,
          end: 24,
        },
      ],
    },
  });
});

test("applies ASI to return statements", () => {
  expect(parseProgram("function f() { return\nx; }").body[0]).toMatchObject({
    kind: "FunctionDeclaration",
    body: {
      kind: "BlockStatement",
      body: [
        { kind: "ReturnStatement", argument: null, start: 15, end: 21 },
        {
          kind: "ExpressionStatement",
          expression: { kind: "Identifier", name: "x", start: 22, end: 23 },
          start: 22,
          end: 24,
        },
      ],
    },
  });
});

test("applies automatic semicolon insertion between statements", () => {
  expect(parseProgram("x\ny")).toEqual({
    kind: "Program",
    body: [
      {
        kind: "ExpressionStatement",
        expression: { kind: "Identifier", name: "x", start: 0, end: 1 },
        start: 0,
        end: 1,
      },
      {
        kind: "ExpressionStatement",
        expression: { kind: "Identifier", name: "y", start: 2, end: 3 },
        start: 2,
        end: 3,
      },
    ],
    source: "x\ny",
    start: 0,
    end: 3,
  });
  expect(parseProgram("let a = 1\nlet b = 2")).toMatchObject({
    kind: "Program",
    body: [
      {
        kind: "VariableStatement",
        declarationKind: "let",
        declarations: [{ name: { name: "a" }, initializer: { value: 1 } }],
        start: 0,
        end: 9,
      },
      {
        kind: "VariableStatement",
        declarationKind: "let",
        declarations: [{ name: { name: "b" }, initializer: { value: 2 } }],
        start: 10,
        end: 19,
      },
    ],
    start: 0,
    end: 19,
  });
  expect(parseProgram("{ x }")).toMatchObject({
    kind: "Program",
    body: [
      {
        kind: "BlockStatement",
        start: 0,
        end: 5,
        body: [
          {
            kind: "ExpressionStatement",
            expression: { kind: "Identifier", name: "x", start: 2, end: 3 },
            start: 2,
            end: 3,
          },
        ],
      },
    ],
  });
});

test("throws ParseError with line and column for malformed statements", () => {
  const missingVariableName = captureProgramParseError("let ;");
  expect(missingVariableName).toBeInstanceOf(ParseError);
  expect(errorPosition(missingVariableName)).toEqual({ offset: 4, line: 1, column: 5 });
  expect(missingVariableName.message).toBe('unexpected token ";"');

  const missingInitializer = captureProgramParseError("let a = ;");
  expect(missingInitializer).toBeInstanceOf(ParseError);
  expect(errorPosition(missingInitializer)).toEqual({ offset: 8, line: 1, column: 9 });
  expect(missingInitializer.message).toBe('unexpected token ";"');

  const missingFunctionName = captureProgramParseError("function () {}");
  expect(missingFunctionName).toBeInstanceOf(ParseError);
  expect(errorPosition(missingFunctionName)).toEqual({ offset: 9, line: 1, column: 10 });
  expect(missingFunctionName.message).toBe('unexpected token "("');

  const nestedReturn = captureProgramParseError("{ return return; }");
  expect(nestedReturn).toBeInstanceOf(ParseError);
  expect(errorPosition(nestedReturn)).toEqual({ offset: 9, line: 1, column: 10 });
  expect(nestedReturn.message).toBe('unexpected token "return"');

  const unclosedBlock = captureProgramParseError("{");
  expect(unclosedBlock).toBeInstanceOf(ParseError);
  expect(errorPosition(unclosedBlock)).toEqual({ offset: 1, line: 1, column: 2 });
  expect(unclosedBlock.message).toBe('expected "}"');

  const unclosedParameters = captureProgramParseError("function f(");
  expect(unclosedParameters).toBeInstanceOf(ParseError);
  expect(errorPosition(unclosedParameters)).toEqual({ offset: 11, line: 1, column: 12 });
  expect(unclosedParameters.message).toBe("unexpected end of input");

  const missingSemicolon = captureProgramParseError("x y");
  expect(missingSemicolon).toBeInstanceOf(ParseError);
  expect(errorPosition(missingSemicolon)).toEqual({ offset: 2, line: 1, column: 3 });
  expect(missingSemicolon.message).toBe("expected ;");
});

test("parses if statements", () => {
  expect(parseProgram("if (a) b;").body[0]).toMatchObject({
    kind: "IfStatement",
    test: { kind: "Identifier", name: "a", start: 4, end: 5 },
    consequent: {
      kind: "ExpressionStatement",
      expression: { kind: "Identifier", name: "b", start: 7, end: 8 },
      start: 7,
      end: 9,
    },
    alternate: null,
    start: 0,
    end: 9,
  });
  expect(parseProgram("if (a) b; else c;").body[0]).toMatchObject({
    kind: "IfStatement",
    consequent: { kind: "ExpressionStatement", expression: { name: "b" }, start: 7, end: 9 },
    alternate: {
      kind: "ExpressionStatement",
      expression: { kind: "Identifier", name: "c", start: 15, end: 16 },
      start: 15,
      end: 17,
    },
    start: 0,
    end: 17,
  });
  expect(parseProgram("if (a) { b; } else if (c) d; else e;").body[0]).toMatchObject({
    kind: "IfStatement",
    consequent: { kind: "BlockStatement", start: 7, end: 13 },
    alternate: {
      kind: "IfStatement",
      test: { kind: "Identifier", name: "c", start: 23, end: 24 },
      consequent: { kind: "ExpressionStatement", expression: { name: "d" }, start: 26, end: 28 },
      alternate: {
        kind: "ExpressionStatement",
        expression: { kind: "Identifier", name: "e", start: 34, end: 35 },
        start: 34,
        end: 36,
      },
      start: 19,
      end: 36,
    },
    start: 0,
    end: 36,
  });
});

test("parses while and do-while statements", () => {
  expect(parseProgram("while (a) b;").body[0]).toEqual({
    kind: "WhileStatement",
    test: { kind: "Identifier", name: "a", start: 7, end: 8 },
    body: {
      kind: "ExpressionStatement",
      expression: { kind: "Identifier", name: "b", start: 10, end: 11 },
      start: 10,
      end: 12,
    },
    start: 0,
    end: 12,
  });
  expect(parseProgram("do b; while (a);").body[0]).toMatchObject({
    kind: "DoWhileStatement",
    body: {
      kind: "ExpressionStatement",
      expression: { kind: "Identifier", name: "b", start: 3, end: 4 },
      start: 3,
      end: 5,
    },
    test: { kind: "Identifier", name: "a", start: 13, end: 14 },
    start: 0,
    end: 16,
  });
});

test("parses classic for statements", () => {
  expect(parseProgram("for (;;) ;").body[0]).toMatchObject({
    kind: "ForStatement",
    init: null,
    test: null,
    update: null,
    body: { kind: "EmptyStatement", start: 9, end: 10 },
    start: 0,
    end: 10,
  });
  expect(parseProgram("for (let i = 0; i < 10; i++) f(i);").body[0]).toMatchObject({
    kind: "ForStatement",
    init: {
      kind: "VariableStatement",
      declarationKind: "let",
      declarations: [
        {
          kind: "VariableDeclarator",
          name: { kind: "Identifier", name: "i", start: 9, end: 10 },
          initializer: { kind: "NumberLiteral", value: 0, raw: "0", start: 13, end: 14 },
          start: 9,
          end: 14,
        },
      ],
      start: 5,
      end: 14,
    },
    test: {
      kind: "BinaryExpression",
      operator: "<",
      left: { kind: "Identifier", name: "i", start: 16, end: 17 },
      right: { kind: "NumberLiteral", value: 10, raw: "10", start: 20, end: 22 },
      start: 16,
      end: 22,
    },
    update: {
      kind: "UpdateExpression",
      operator: "++",
      operand: { kind: "Identifier", name: "i", start: 24, end: 25 },
      prefix: false,
      start: 24,
      end: 27,
    },
    body: { kind: "ExpressionStatement", start: 29, end: 34 },
    start: 0,
    end: 34,
  });
  expect(parseProgram("for (i = 0; ; ) ;").body[0]).toMatchObject({
    kind: "ForStatement",
    init: {
      kind: "AssignmentExpression",
      operator: "=",
      left: { kind: "Identifier", name: "i", start: 5, end: 6 },
      right: { kind: "NumberLiteral", value: 0, raw: "0", start: 9, end: 10 },
      start: 5,
      end: 10,
    },
    test: null,
    update: null,
    body: { kind: "EmptyStatement", start: 16, end: 17 },
    start: 0,
    end: 17,
  });
});

test("parses for-in, for-of, and for-await-of statements", () => {
  expect(parseProgram("for (const k in obj) h(k);").body[0]).toMatchObject({
    kind: "ForInStatement",
    left: {
      kind: "VariableStatement",
      declarationKind: "const",
      declarations: [
        {
          kind: "VariableDeclarator",
          name: { kind: "Identifier", name: "k", start: 11, end: 12 },
          start: 11,
          end: 12,
        },
      ],
      start: 5,
      end: 12,
    },
    right: { kind: "Identifier", name: "obj", start: 16, end: 19 },
    body: { kind: "ExpressionStatement", start: 21, end: 26 },
    start: 0,
    end: 26,
  });
  expect(parseProgram("for (const x of xs) g(x);").body[0]).toMatchObject({
    kind: "ForOfStatement",
    left: {
      kind: "VariableStatement",
      declarationKind: "const",
      declarations: [
        {
          kind: "VariableDeclarator",
          name: { kind: "Identifier", name: "x", start: 11, end: 12 },
          start: 11,
          end: 12,
        },
      ],
      start: 5,
      end: 12,
    },
    right: { kind: "Identifier", name: "xs", start: 16, end: 18 },
    body: { kind: "ExpressionStatement", start: 20, end: 25 },
    start: 0,
    end: 25,
  });
  const awaited = parseProgram("for await (const x of xs) ;").body[0];
  expect(awaited).toMatchObject({
    kind: "ForOfStatement",
    left: {
      kind: "VariableStatement",
      declarationKind: "const",
      declarations: [
        {
          kind: "VariableDeclarator",
          name: { kind: "Identifier", name: "x", start: 17, end: 18 },
          start: 17,
          end: 18,
        },
      ],
      start: 11,
      end: 18,
    },
    right: { kind: "Identifier", name: "xs", start: 22, end: 24 },
    body: { kind: "EmptyStatement", start: 26, end: 27 },
    start: 0,
    end: 27,
  });
  expect(awaited).toHaveProperty("await", true);
  expect(parseProgram("for (const x of xs) ;").body[0]).not.toHaveProperty("await");
  expect(parseProgram("for (k in obj) ;").body[0]).toMatchObject({
    kind: "ForInStatement",
    left: { kind: "Identifier", name: "k", start: 5, end: 6 },
    right: { kind: "Identifier", name: "obj", start: 10, end: 13 },
    body: { kind: "EmptyStatement", start: 15, end: 16 },
    start: 0,
    end: 16,
  });
});

test("parses switch statements", () => {
  expect(
    parseProgram("switch (x) { case 1: a; break; case 2: b; default: c; }").body[0],
  ).toMatchObject({
    kind: "SwitchStatement",
    discriminant: { kind: "Identifier", name: "x", start: 8, end: 9 },
    cases: [
      {
        kind: "SwitchCase",
        test: { kind: "NumberLiteral", value: 1, raw: "1", start: 18, end: 19 },
        consequent: [
          {
            kind: "ExpressionStatement",
            expression: { kind: "Identifier", name: "a", start: 21, end: 22 },
            start: 21,
            end: 23,
          },
          { kind: "BreakStatement", label: null, start: 24, end: 30 },
        ],
        start: 13,
        end: 30,
      },
      {
        kind: "SwitchCase",
        test: { kind: "NumberLiteral", value: 2, raw: "2", start: 36, end: 37 },
        consequent: [
          {
            kind: "ExpressionStatement",
            expression: { kind: "Identifier", name: "b", start: 39, end: 40 },
            start: 39,
            end: 41,
          },
        ],
        start: 31,
        end: 41,
      },
      {
        kind: "SwitchCase",
        test: null,
        consequent: [
          {
            kind: "ExpressionStatement",
            expression: { kind: "Identifier", name: "c", start: 51, end: 52 },
            start: 51,
            end: 53,
          },
        ],
        start: 42,
        end: 53,
      },
    ],
    start: 0,
    end: 55,
  });
  expect(parseProgram("switch (x) { case 1: a; case 2: b; }").body[0]).toMatchObject({
    kind: "SwitchStatement",
    cases: [
      {
        kind: "SwitchCase",
        test: { kind: "NumberLiteral", value: 1, raw: "1", start: 18, end: 19 },
        consequent: [
          {
            kind: "ExpressionStatement",
            expression: { kind: "Identifier", name: "a", start: 21, end: 22 },
            start: 21,
            end: 23,
          },
        ],
        start: 13,
        end: 23,
      },
      {
        kind: "SwitchCase",
        test: { kind: "NumberLiteral", value: 2, raw: "2", start: 29, end: 30 },
        consequent: [
          {
            kind: "ExpressionStatement",
            expression: { kind: "Identifier", name: "b", start: 32, end: 33 },
            start: 32,
            end: 34,
          },
        ],
        start: 24,
        end: 34,
      },
    ],
    start: 0,
    end: 36,
  });
});

test("parses try statements", () => {
  expect(parseProgram("try { a; } catch (e) { b; }").body[0]).toMatchObject({
    kind: "TryStatement",
    block: { kind: "BlockStatement", start: 4, end: 10 },
    handler: {
      kind: "CatchClause",
      param: { kind: "Identifier", name: "e", start: 18, end: 19 },
      paramType: null,
      body: { kind: "BlockStatement", start: 21, end: 27 },
      start: 11,
      end: 27,
    },
    finalizer: null,
    start: 0,
    end: 27,
  });
  expect(parseProgram("try { a; } catch (e: unknown) { }").body[0]).toMatchObject({
    kind: "TryStatement",
    handler: {
      kind: "CatchClause",
      param: { kind: "Identifier", name: "e", start: 18, end: 19 },
      paramType: { kind: "KeywordType", name: "unknown", start: 21, end: 28 },
      body: { kind: "BlockStatement", body: [], start: 30, end: 33 },
      start: 11,
      end: 33,
    },
    finalizer: null,
    start: 0,
    end: 33,
  });
  expect(parseProgram("try { a; } finally { c; }").body[0]).toMatchObject({
    kind: "TryStatement",
    block: { kind: "BlockStatement", start: 4, end: 10 },
    handler: null,
    finalizer: {
      kind: "BlockStatement",
      body: [
        {
          kind: "ExpressionStatement",
          expression: { kind: "Identifier", name: "c", start: 21, end: 22 },
          start: 21,
          end: 23,
        },
      ],
      start: 19,
      end: 25,
    },
    start: 0,
    end: 25,
  });
  expect(parseProgram("try { a; } catch { }").body[0]).toMatchObject({
    kind: "TryStatement",
    handler: {
      kind: "CatchClause",
      param: null,
      paramType: null,
      body: { kind: "BlockStatement", body: [], start: 17, end: 20 },
      start: 11,
      end: 20,
    },
    finalizer: null,
    start: 0,
    end: 20,
  });
  expect(parseProgram("try {} catch (e) {} finally {}").body[0]).toMatchObject({
    kind: "TryStatement",
    block: { kind: "BlockStatement", body: [], start: 4, end: 6 },
    handler: {
      kind: "CatchClause",
      param: { kind: "Identifier", name: "e", start: 14, end: 15 },
      paramType: null,
      body: { kind: "BlockStatement", body: [], start: 17, end: 19 },
      start: 7,
      end: 19,
    },
    finalizer: { kind: "BlockStatement", body: [], start: 28, end: 30 },
    start: 0,
    end: 30,
  });
});

test("parses throw statements", () => {
  expect(parseProgram('throw new Error("x");').body[0]).toMatchObject({
    kind: "ThrowStatement",
    argument: {
      kind: "NewExpression",
      callee: { kind: "Identifier", name: "Error", start: 10, end: 15 },
      arguments: [{ kind: "StringLiteral", value: "x", raw: '"x"', start: 16, end: 19 }],
      start: 6,
      end: 20,
    },
    start: 0,
    end: 21,
  });
});

test("parses break, continue, and labeled statements", () => {
  expect(parseProgram("break;").body[0]).toEqual({
    kind: "BreakStatement",
    label: null,
    start: 0,
    end: 6,
  });
  expect(parseProgram("continue;").body[0]).toEqual({
    kind: "ContinueStatement",
    label: null,
    start: 0,
    end: 9,
  });
  expect(parseProgram("outer: for (;;) { break outer; continue outer; }").body[0]).toMatchObject({
    kind: "LabeledStatement",
    label: { kind: "Identifier", name: "outer", start: 0, end: 5 },
    body: {
      kind: "ForStatement",
      init: null,
      test: null,
      update: null,
      body: {
        kind: "BlockStatement",
        body: [
          {
            kind: "BreakStatement",
            label: { kind: "Identifier", name: "outer", start: 24, end: 29 },
            start: 18,
            end: 30,
          },
          {
            kind: "ContinueStatement",
            label: { kind: "Identifier", name: "outer", start: 40, end: 45 },
            start: 31,
            end: 46,
          },
        ],
        start: 16,
        end: 48,
      },
      start: 7,
      end: 48,
    },
    start: 0,
    end: 48,
  });
});

test("throws ParseError with line and column for malformed control flow statements", () => {
  const missingTestParen = captureProgramParseError("if a) ;");
  expect(missingTestParen).toBeInstanceOf(ParseError);
  expect(errorPosition(missingTestParen)).toEqual({ offset: 3, line: 1, column: 4 });
  expect(missingTestParen.message).toBe('expected "("');

  const unclosedTest = captureProgramParseError("if (a");
  expect(unclosedTest).toBeInstanceOf(ParseError);
  expect(errorPosition(unclosedTest)).toEqual({ offset: 5, line: 1, column: 6 });
  expect(unclosedTest.message).toBe('expected ")"');

  const unclosedForHeader = captureProgramParseError("for (;;");
  expect(unclosedForHeader).toBeInstanceOf(ParseError);
  expect(errorPosition(unclosedForHeader)).toEqual({ offset: 7, line: 1, column: 8 });
  expect(unclosedForHeader.message).toBe("unexpected end of input");

  const missingCaseExpression = captureProgramParseError("switch (x) { case }");
  expect(missingCaseExpression).toBeInstanceOf(ParseError);
  expect(errorPosition(missingCaseExpression)).toEqual({ offset: 18, line: 1, column: 19 });
  expect(missingCaseExpression.message).toBe('unexpected token "}"');

  const missingCatchOrFinally = captureProgramParseError("try {}");
  expect(missingCatchOrFinally).toBeInstanceOf(ParseError);
  expect(errorPosition(missingCatchOrFinally)).toEqual({ offset: 6, line: 1, column: 7 });
  expect(missingCatchOrFinally.message).toBe("expected catch or finally");

  const newlineAfterThrow = captureProgramParseError("throw\nx");
  expect(newlineAfterThrow).toBeInstanceOf(ParseError);
  expect(errorPosition(newlineAfterThrow)).toEqual({ offset: 6, line: 2, column: 1 });
  expect(newlineAfterThrow.message).toBe("illegal newline after throw");

  const numericBreakLabel = captureProgramParseError("break 1;");
  expect(numericBreakLabel).toBeInstanceOf(ParseError);
  expect(errorPosition(numericBreakLabel)).toEqual({ offset: 6, line: 1, column: 7 });
  expect(numericBreakLabel.message).toBe("expected ;");
});

test("parses object binding patterns with full spans", () => {
  expect(parseProgram("const {a} = x;")).toEqual({
    kind: "Program",
    body: [
      {
        kind: "VariableStatement",
        declarationKind: "const",
        declarations: [
          {
            kind: "VariableDeclarator",
            name: {
              kind: "ObjectPattern",
              properties: [
                {
                  kind: "BindingElement",
                  key: { kind: "Identifier", name: "a", start: 7, end: 8 },
                  binding: { kind: "Identifier", name: "a", start: 7, end: 8 },
                  default: null,
                  rest: false,
                  computed: false,
                  start: 7,
                  end: 8,
                },
              ],
              start: 6,
              end: 9,
            },
            type: null,
            initializer: { kind: "Identifier", name: "x", start: 12, end: 13 },
            start: 6,
            end: 13,
          },
        ],
        start: 0,
        end: 14,
      },
    ],
    source: "const {a} = x;",
    start: 0,
    end: 14,
  });
});

test("parses object binding patterns with aliases, defaults, and rests", () => {
  expect(parseProgram("const {a, b} = x;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarationKind: "const",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: {
          kind: "ObjectPattern",
          start: 6,
          end: 12,
          properties: [
            {
              kind: "BindingElement",
              key: { kind: "Identifier", name: "a", start: 7, end: 8 },
              binding: { kind: "Identifier", name: "a", start: 7, end: 8 },
              default: null,
              rest: false,
              computed: false,
              start: 7,
              end: 8,
            },
            {
              kind: "BindingElement",
              key: { kind: "Identifier", name: "b", start: 10, end: 11 },
              binding: { kind: "Identifier", name: "b", start: 10, end: 11 },
              default: null,
              rest: false,
              computed: false,
              start: 10,
              end: 11,
            },
          ],
        },
        type: null,
        initializer: { kind: "Identifier", name: "x", start: 15, end: 16 },
        start: 6,
        end: 16,
      },
    ],
    start: 0,
    end: 17,
  });
  expect(parseProgram("const {a: c, d = 1, ...rest} = x;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarationKind: "const",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: {
          kind: "ObjectPattern",
          start: 6,
          end: 28,
          properties: [
            {
              kind: "BindingElement",
              key: { kind: "Identifier", name: "a", start: 7, end: 8 },
              binding: { kind: "Identifier", name: "c", start: 10, end: 11 },
              default: null,
              rest: false,
              computed: false,
              start: 7,
              end: 11,
            },
            {
              kind: "BindingElement",
              key: { kind: "Identifier", name: "d", start: 13, end: 14 },
              binding: { kind: "Identifier", name: "d", start: 13, end: 14 },
              default: { kind: "NumberLiteral", value: 1, raw: "1", start: 17, end: 18 },
              rest: false,
              computed: false,
              start: 13,
              end: 18,
            },
            {
              kind: "BindingElement",
              key: null,
              binding: { kind: "Identifier", name: "rest", start: 23, end: 27 },
              default: null,
              rest: true,
              computed: false,
              start: 20,
              end: 27,
            },
          ],
        },
        type: null,
        initializer: { kind: "Identifier", name: "x", start: 31, end: 32 },
        start: 6,
        end: 32,
      },
    ],
    start: 0,
    end: 33,
  });
});

test("parses shorthand defaults and computed keys in object binding patterns", () => {
  expect(parseProgram("const {a = 1} = x;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: {
          kind: "ObjectPattern",
          start: 6,
          end: 13,
          properties: [
            {
              kind: "BindingElement",
              key: { kind: "Identifier", name: "a", start: 7, end: 8 },
              binding: { kind: "Identifier", name: "a", start: 7, end: 8 },
              default: { kind: "NumberLiteral", value: 1, raw: "1", start: 11, end: 12 },
              rest: false,
              computed: false,
              start: 7,
              end: 12,
            },
          ],
        },
        type: null,
        initializer: { kind: "Identifier", name: "x", start: 16, end: 17 },
        start: 6,
        end: 17,
      },
    ],
    start: 0,
    end: 18,
  });
  expect(parseProgram('const {["k"]: v} = x;').body[0]).toMatchObject({
    kind: "VariableStatement",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: {
          kind: "ObjectPattern",
          start: 6,
          end: 16,
          properties: [
            {
              kind: "BindingElement",
              key: { kind: "StringLiteral", value: "k", raw: '"k"', start: 8, end: 11 },
              binding: { kind: "Identifier", name: "v", start: 14, end: 15 },
              default: null,
              rest: false,
              computed: true,
              start: 8,
              end: 15,
            },
          ],
        },
        type: null,
        initializer: { kind: "Identifier", name: "x", start: 19, end: 20 },
        start: 6,
        end: 20,
      },
    ],
    start: 0,
    end: 21,
  });
  expect(parseProgram("const {[k]: v} = obj;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: {
          kind: "ObjectPattern",
          start: 6,
          end: 14,
          properties: [
            {
              kind: "BindingElement",
              key: { kind: "Identifier", name: "k", start: 8, end: 9 },
              binding: { kind: "Identifier", name: "v", start: 12, end: 13 },
              default: null,
              rest: false,
              computed: true,
              start: 8,
              end: 13,
            },
          ],
        },
        type: null,
        initializer: { kind: "Identifier", name: "obj", start: 17, end: 20 },
        start: 6,
        end: 20,
      },
    ],
    start: 0,
    end: 21,
  });
});

test("parses array binding patterns with holes, defaults, and rests", () => {
  expect(parseProgram("const [a, , b = 2, ...r] = x;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarationKind: "const",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: {
          kind: "ArrayPattern",
          start: 6,
          end: 24,
          elements: [
            {
              kind: "BindingElement",
              key: null,
              binding: { kind: "Identifier", name: "a", start: 7, end: 8 },
              default: null,
              rest: false,
              computed: false,
              start: 7,
              end: 8,
            },
            null,
            {
              kind: "BindingElement",
              key: null,
              binding: { kind: "Identifier", name: "b", start: 12, end: 13 },
              default: { kind: "NumberLiteral", value: 2, raw: "2", start: 16, end: 17 },
              rest: false,
              computed: false,
              start: 12,
              end: 17,
            },
            {
              kind: "BindingElement",
              key: null,
              binding: { kind: "Identifier", name: "r", start: 22, end: 23 },
              default: null,
              rest: true,
              computed: false,
              start: 19,
              end: 23,
            },
          ],
        },
        type: null,
        initializer: { kind: "Identifier", name: "x", start: 27, end: 28 },
        start: 6,
        end: 28,
      },
    ],
    start: 0,
    end: 29,
  });
});

test("parses empty array and object binding patterns", () => {
  expect(parseProgram("const [] = x;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: { kind: "ArrayPattern", elements: [], start: 6, end: 8 },
        type: null,
        initializer: { kind: "Identifier", name: "x", start: 11, end: 12 },
        start: 6,
        end: 12,
      },
    ],
    start: 0,
    end: 13,
  });
  expect(parseProgram("const {} = x;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: { kind: "ObjectPattern", properties: [], start: 6, end: 8 },
        type: null,
        initializer: { kind: "Identifier", name: "x", start: 11, end: 12 },
        start: 6,
        end: 12,
      },
    ],
    start: 0,
    end: 13,
  });
});

test("parses nested binding patterns", () => {
  expect(parseProgram("const {a: [b, {c}]} = x;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: {
          kind: "ObjectPattern",
          start: 6,
          end: 19,
          properties: [
            {
              kind: "BindingElement",
              key: { kind: "Identifier", name: "a", start: 7, end: 8 },
              binding: {
                kind: "ArrayPattern",
                start: 10,
                end: 18,
                elements: [
                  {
                    kind: "BindingElement",
                    key: null,
                    binding: { kind: "Identifier", name: "b", start: 11, end: 12 },
                    default: null,
                    rest: false,
                    computed: false,
                    start: 11,
                    end: 12,
                  },
                  {
                    kind: "BindingElement",
                    key: null,
                    binding: {
                      kind: "ObjectPattern",
                      start: 14,
                      end: 17,
                      properties: [
                        {
                          kind: "BindingElement",
                          key: { kind: "Identifier", name: "c", start: 15, end: 16 },
                          binding: { kind: "Identifier", name: "c", start: 15, end: 16 },
                          default: null,
                          rest: false,
                          computed: false,
                          start: 15,
                          end: 16,
                        },
                      ],
                    },
                    default: null,
                    rest: false,
                    computed: false,
                    start: 14,
                    end: 17,
                  },
                ],
              },
              default: null,
              rest: false,
              computed: false,
              start: 7,
              end: 18,
            },
          ],
        },
        type: null,
        initializer: { kind: "Identifier", name: "x", start: 22, end: 23 },
        start: 6,
        end: 23,
      },
    ],
    start: 0,
    end: 24,
  });
});

test("parses destructured parameters with defaults and annotations", () => {
  expect(parseProgram("function f({a, b = 1}: T = {}): void {}").body[0]).toMatchObject({
    kind: "FunctionDeclaration",
    name: { kind: "Identifier", name: "f", start: 9, end: 10 },
    parameters: [
      {
        kind: "Parameter",
        name: {
          kind: "ObjectPattern",
          start: 11,
          end: 21,
          properties: [
            {
              kind: "BindingElement",
              key: { kind: "Identifier", name: "a", start: 12, end: 13 },
              binding: { kind: "Identifier", name: "a", start: 12, end: 13 },
              default: null,
              rest: false,
              computed: false,
              start: 12,
              end: 13,
            },
            {
              kind: "BindingElement",
              key: { kind: "Identifier", name: "b", start: 15, end: 16 },
              binding: { kind: "Identifier", name: "b", start: 15, end: 16 },
              default: { kind: "NumberLiteral", value: 1, raw: "1", start: 19, end: 20 },
              rest: false,
              computed: false,
              start: 15,
              end: 20,
            },
          ],
        },
        optional: false,
        rest: false,
        type: { kind: "TypeReference", name: "T", typeArguments: null, start: 23, end: 24 },
        initializer: { kind: "ObjectLiteral", properties: [], start: 27, end: 29 },
        start: 11,
        end: 29,
      },
    ],
    returnType: { kind: "KeywordType", name: "void", start: 32, end: 36 },
    body: { kind: "BlockStatement", body: [], start: 37, end: 39 },
    start: 0,
    end: 39,
  });
  expect(parseProgram("function g([x, ...y]) {}").body[0]).toMatchObject({
    kind: "FunctionDeclaration",
    name: { kind: "Identifier", name: "g", start: 9, end: 10 },
    parameters: [
      {
        kind: "Parameter",
        name: {
          kind: "ArrayPattern",
          start: 11,
          end: 20,
          elements: [
            {
              kind: "BindingElement",
              key: null,
              binding: { kind: "Identifier", name: "x", start: 12, end: 13 },
              default: null,
              rest: false,
              computed: false,
              start: 12,
              end: 13,
            },
            {
              kind: "BindingElement",
              key: null,
              binding: { kind: "Identifier", name: "y", start: 18, end: 19 },
              default: null,
              rest: true,
              computed: false,
              start: 15,
              end: 19,
            },
          ],
        },
        optional: false,
        rest: false,
        type: null,
        initializer: null,
        start: 11,
        end: 20,
      },
    ],
    body: { kind: "BlockStatement", body: [], start: 22, end: 24 },
    start: 0,
    end: 24,
  });
  expect(parseProgram("function h(a = 1, {b}: U = {}) {}").body[0]).toMatchObject({
    kind: "FunctionDeclaration",
    name: { kind: "Identifier", name: "h", start: 9, end: 10 },
    parameters: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "a", start: 11, end: 12 },
        optional: false,
        rest: false,
        type: null,
        initializer: { kind: "NumberLiteral", value: 1, raw: "1", start: 15, end: 16 },
        start: 11,
        end: 16,
      },
      {
        kind: "Parameter",
        name: {
          kind: "ObjectPattern",
          start: 18,
          end: 21,
          properties: [
            {
              kind: "BindingElement",
              key: { kind: "Identifier", name: "b", start: 19, end: 20 },
              binding: { kind: "Identifier", name: "b", start: 19, end: 20 },
              default: null,
              rest: false,
              computed: false,
              start: 19,
              end: 20,
            },
          ],
        },
        optional: false,
        rest: false,
        type: { kind: "TypeReference", name: "U", typeArguments: null, start: 23, end: 24 },
        initializer: { kind: "ObjectLiteral", properties: [], start: 27, end: 29 },
        start: 18,
        end: 29,
      },
    ],
    body: { kind: "BlockStatement", body: [], start: 31, end: 33 },
    start: 0,
    end: 33,
  });
});

test("throws ParseError with line and column for malformed binding patterns", () => {
  const doubleComma = captureProgramParseError("const {a,,} = x;");
  expect(doubleComma).toBeInstanceOf(ParseError);
  expect(errorPosition(doubleComma)).toEqual({ offset: 9, line: 1, column: 10 });
  expect(doubleComma.message).toBe('unexpected token ","');

  const unclosedObject = captureProgramParseError("function f({) {}");
  expect(unclosedObject).toBeInstanceOf(ParseError);
  expect(errorPosition(unclosedObject)).toEqual({ offset: 12, line: 1, column: 13 });
  expect(unclosedObject.message).toBe('unexpected token ")"');

  const missingDefault = captureProgramParseError("const [a = ] = x;");
  expect(missingDefault).toBeInstanceOf(ParseError);
  expect(errorPosition(missingDefault)).toEqual({ offset: 11, line: 1, column: 12 });
  expect(missingDefault.message).toBe('unexpected token "]"');

  const restInitializer = captureProgramParseError("function f(...a = 1) {}");
  expect(restInitializer).toBeInstanceOf(ParseError);
  expect(errorPosition(restInitializer)).toEqual({ offset: 16, line: 1, column: 17 });
  expect(restInitializer.message).toBe("rest parameter may not have an initializer");
});

test("parses single-parameter arrow functions with full spans", () => {
  const arrow = parse("x => x");
  expect(arrow).toEqual({
    kind: "ArrowFunctionExpression",
    params: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "x", start: 0, end: 1 },
        optional: false,
        rest: false,
        type: null,
        initializer: null,
        start: 0,
        end: 1,
      },
    ],
    body: { kind: "Identifier", name: "x", start: 5, end: 6 },
    start: 0,
    end: 6,
  });
  expect(arrow).not.toHaveProperty("async");
  expect(arrow).not.toHaveProperty("typeParameters");
});

test("parses parenthesized arrow functions", () => {
  expect(parse("(x) => x")).toMatchObject({
    kind: "ArrowFunctionExpression",
    params: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "x", start: 1, end: 2 },
        optional: false,
        rest: false,
        type: null,
        initializer: null,
        start: 1,
        end: 2,
      },
    ],
    body: { kind: "Identifier", name: "x", start: 7, end: 8 },
    start: 0,
    end: 8,
  });
  expect(parse("() => 1")).toMatchObject({
    kind: "ArrowFunctionExpression",
    params: [],
    body: { kind: "NumberLiteral", value: 1, raw: "1", start: 6, end: 7 },
    start: 0,
    end: 7,
  });
  expect(parse("(a, b) => a + b")).toMatchObject({
    kind: "ArrowFunctionExpression",
    params: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "a", start: 1, end: 2 },
        optional: false,
        rest: false,
        type: null,
        initializer: null,
        start: 1,
        end: 2,
      },
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "b", start: 4, end: 5 },
        optional: false,
        rest: false,
        type: null,
        initializer: null,
        start: 4,
        end: 5,
      },
    ],
    body: {
      kind: "BinaryExpression",
      operator: "+",
      left: { kind: "Identifier", name: "a", start: 10, end: 11 },
      right: { kind: "Identifier", name: "b", start: 14, end: 15 },
      start: 10,
      end: 15,
    },
    start: 0,
    end: 15,
  });
});

test("parses arrow functions with parameter and return annotations", () => {
  expect(parse("(a: T, b = 1): U => a")).toMatchObject({
    kind: "ArrowFunctionExpression",
    params: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "a", start: 1, end: 2 },
        optional: false,
        rest: false,
        type: { kind: "TypeReference", name: "T", typeArguments: null, start: 4, end: 5 },
        initializer: null,
        start: 1,
        end: 5,
      },
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "b", start: 7, end: 8 },
        optional: false,
        rest: false,
        type: null,
        initializer: { kind: "NumberLiteral", value: 1, raw: "1", start: 11, end: 12 },
        start: 7,
        end: 12,
      },
    ],
    body: { kind: "Identifier", name: "a", start: 20, end: 21 },
    start: 0,
    end: 21,
  });
  expect(parse("(x): asserts x is string => {}")).toMatchObject({
    kind: "ArrowFunctionExpression",
    params: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "x", start: 1, end: 2 },
        optional: false,
        rest: false,
        type: null,
        initializer: null,
        start: 1,
        end: 2,
      },
    ],
    body: { kind: "BlockStatement", body: [], start: 28, end: 30 },
    start: 0,
    end: 30,
  });
});

test("parses block bodies and right-associative nested arrows", () => {
  expect(parse("x => { return x; }")).toMatchObject({
    kind: "ArrowFunctionExpression",
    params: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "x", start: 0, end: 1 },
        optional: false,
        rest: false,
        type: null,
        initializer: null,
        start: 0,
        end: 1,
      },
    ],
    body: {
      kind: "BlockStatement",
      body: [
        {
          kind: "ReturnStatement",
          argument: { kind: "Identifier", name: "x", start: 14, end: 15 },
          start: 7,
          end: 16,
        },
      ],
      start: 5,
      end: 18,
    },
    start: 0,
    end: 18,
  });
  expect(parse("x => y => x + y")).toMatchObject({
    kind: "ArrowFunctionExpression",
    params: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "x", start: 0, end: 1 },
        optional: false,
        rest: false,
        type: null,
        initializer: null,
        start: 0,
        end: 1,
      },
    ],
    body: {
      kind: "ArrowFunctionExpression",
      params: [
        {
          kind: "Parameter",
          name: { kind: "Identifier", name: "y", start: 5, end: 6 },
          optional: false,
          rest: false,
          type: null,
          initializer: null,
          start: 5,
          end: 6,
        },
      ],
      body: {
        kind: "BinaryExpression",
        operator: "+",
        left: { kind: "Identifier", name: "x", start: 10, end: 11 },
        right: { kind: "Identifier", name: "y", start: 14, end: 15 },
        start: 10,
        end: 15,
      },
      start: 5,
      end: 15,
    },
    start: 0,
    end: 15,
  });
});

test("parses arrows as call arguments and variable initializers", () => {
  expect(parse("f(x => x)")).toMatchObject({
    kind: "CallExpression",
    callee: { kind: "Identifier", name: "f", start: 0, end: 1 },
    arguments: [
      {
        kind: "ArrowFunctionExpression",
        params: [
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "x", start: 2, end: 3 },
            optional: false,
            rest: false,
            type: null,
            initializer: null,
            start: 2,
            end: 3,
          },
        ],
        body: { kind: "Identifier", name: "x", start: 7, end: 8 },
        start: 2,
        end: 8,
      },
    ],
    optional: false,
    start: 0,
    end: 9,
  });
  expect(parseProgram("const f = (x) => x;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: { kind: "Identifier", name: "f", start: 6, end: 7 },
        type: null,
        initializer: {
          kind: "ArrowFunctionExpression",
          params: [
            {
              kind: "Parameter",
              name: { kind: "Identifier", name: "x", start: 11, end: 12 },
              optional: false,
              rest: false,
              type: null,
              initializer: null,
              start: 11,
              end: 12,
            },
          ],
          body: { kind: "Identifier", name: "x", start: 17, end: 18 },
          start: 10,
          end: 18,
        },
        start: 6,
        end: 18,
      },
    ],
    start: 0,
    end: 19,
  });
  expect(parse("x => ({a: x})")).toMatchObject({
    kind: "ArrowFunctionExpression",
    params: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "x", start: 0, end: 1 },
        optional: false,
        rest: false,
        type: null,
        initializer: null,
        start: 0,
        end: 1,
      },
    ],
    body: {
      kind: "ParenthesizedExpression",
      expression: {
        kind: "ObjectLiteral",
        properties: [
          {
            kind: "Property",
            key: { kind: "Identifier", name: "a", start: 7, end: 8 },
            value: { kind: "Identifier", name: "x", start: 10, end: 11 },
            shorthand: false,
            computed: false,
            start: 7,
            end: 11,
          },
        ],
        start: 6,
        end: 12,
      },
      start: 5,
      end: 13,
    },
    start: 0,
    end: 13,
  });
});

test("parses async arrow functions", () => {
  const single = parse("async x => x");
  expect(single).toMatchObject({
    kind: "ArrowFunctionExpression",
    params: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "x", start: 6, end: 7 },
        optional: false,
        rest: false,
        type: null,
        initializer: null,
        start: 6,
        end: 7,
      },
    ],
    body: { kind: "Identifier", name: "x", start: 11, end: 12 },
    start: 0,
    end: 12,
  });
  expect(single).toHaveProperty("async", true);

  const parenthesized = parse("async (a) => a");
  expect(parenthesized).toMatchObject({
    kind: "ArrowFunctionExpression",
    params: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "a", start: 7, end: 8 },
        optional: false,
        rest: false,
        type: null,
        initializer: null,
        start: 7,
        end: 8,
      },
    ],
    body: { kind: "Identifier", name: "a", start: 13, end: 14 },
    start: 0,
    end: 14,
  });
  expect(parenthesized).toHaveProperty("async", true);

  expect(parseProgram("const g = async () => 1;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: { kind: "Identifier", name: "g", start: 6, end: 7 },
        type: null,
        initializer: {
          kind: "ArrowFunctionExpression",
          params: [],
          body: { kind: "NumberLiteral", value: 1, raw: "1", start: 22, end: 23 },
          start: 10,
          end: 23,
        },
        start: 6,
        end: 23,
      },
    ],
    start: 0,
    end: 24,
  });
});

test("falls back when async is not part of an arrow", () => {
  expect(parse("async")).toEqual({ kind: "Identifier", name: "async", start: 0, end: 5 });
  expect(parse("async(x)")).toMatchObject({
    kind: "CallExpression",
    callee: { kind: "Identifier", name: "async", start: 0, end: 5 },
    arguments: [{ kind: "Identifier", name: "x", start: 6, end: 7 }],
    optional: false,
    start: 0,
    end: 8,
  });
  expect(parse("async (x)")).toMatchObject({
    kind: "CallExpression",
    callee: { kind: "Identifier", name: "async", start: 0, end: 5 },
    arguments: [{ kind: "Identifier", name: "x", start: 7, end: 8 }],
    optional: false,
    start: 0,
    end: 9,
  });
});

test("parses generic arrow functions", () => {
  expect(parse("<T>(x: T) => x")).toMatchObject({
    kind: "ArrowFunctionExpression",
    typeParameters: [
      {
        kind: "TypeParameter",
        name: { kind: "Identifier", name: "T", start: 1, end: 2 },
        constraint: null,
        default: null,
        start: 1,
        end: 2,
      },
    ],
    params: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "x", start: 4, end: 5 },
        optional: false,
        rest: false,
        type: { kind: "TypeReference", name: "T", typeArguments: null, start: 7, end: 8 },
        initializer: null,
        start: 4,
        end: 8,
      },
    ],
    body: { kind: "Identifier", name: "x", start: 13, end: 14 },
    start: 0,
    end: 14,
  });
  const constrained = parse("<T extends U>(x: T): T => x");
  expect(constrained).toMatchObject({
    kind: "ArrowFunctionExpression",
    typeParameters: [
      {
        kind: "TypeParameter",
        name: { kind: "Identifier", name: "T", start: 1, end: 2 },
        constraint: {
          kind: "TypeReference",
          name: "U",
          typeArguments: null,
          start: 11,
          end: 12,
        },
        default: null,
        start: 1,
        end: 12,
      },
    ],
    params: [
      {
        kind: "Parameter",
        name: { kind: "Identifier", name: "x", start: 14, end: 15 },
        optional: false,
        rest: false,
        type: { kind: "TypeReference", name: "T", typeArguments: null, start: 17, end: 18 },
        initializer: null,
        start: 14,
        end: 18,
      },
    ],
    body: { kind: "Identifier", name: "x", start: 26, end: 27 },
    start: 0,
    end: 27,
  });
  expect(constrained).not.toHaveProperty("async");
});

test("falls back when generic arrow speculation fails", () => {
  expect(parse("<T>(x)")).toMatchObject({
    kind: "TypeAssertion",
    type: { kind: "TypeReference", name: "T", typeArguments: null, start: 1, end: 2 },
    expression: {
      kind: "ParenthesizedExpression",
      expression: { kind: "Identifier", name: "x", start: 4, end: 5 },
      start: 3,
      end: 6,
    },
    start: 0,
    end: 6,
  });
});

test("falls back to parenthesized sequences when no arrow follows", () => {
  expect(parse("(a, b)")).toMatchObject({
    kind: "ParenthesizedExpression",
    expression: {
      kind: "SequenceExpression",
      expressions: [
        { kind: "Identifier", name: "a", start: 1, end: 2 },
        { kind: "Identifier", name: "b", start: 4, end: 5 },
      ],
      start: 1,
      end: 5,
    },
    start: 0,
    end: 6,
  });
});

test("throws ParseError for malformed arrow functions", () => {
  const missingBody = captureParseError("x => ");
  expect(missingBody).toBeInstanceOf(ParseError);
  expect(errorPosition(missingBody)).toEqual({ offset: 5, line: 1, column: 6 });
  expect(missingBody.message).toBe("unexpected end of input");

  const parenthesized = captureParseError("(a) =>");
  expect(parenthesized).toBeInstanceOf(ParseError);
  expect(errorPosition(parenthesized)).toEqual({ offset: 6, line: 1, column: 7 });
  expect(parenthesized.message).toBe("unexpected end of input");
});

test("parses empty interface declarations", () => {
  expect(parseProgram("interface I {}").body[0]).toMatchObject({
    kind: "InterfaceDeclaration",
    name: { kind: "Identifier", name: "I", start: 10, end: 11 },
    typeParameters: null,
    extends: [],
    members: [],
    start: 0,
    end: 14,
  });
});

test("parses interface extends clauses and members", () => {
  expect(
    parseProgram("interface I extends A, B<C> { x: T; m(): void }").body[0],
  ).toMatchObject({
    kind: "InterfaceDeclaration",
    name: { kind: "Identifier", name: "I", start: 10, end: 11 },
    typeParameters: null,
    extends: [
      { kind: "TypeReference", name: "A", typeArguments: null, start: 20, end: 21 },
      {
        kind: "TypeReference",
        name: "B",
        typeArguments: [
          { kind: "TypeReference", name: "C", typeArguments: null, start: 25, end: 26 },
        ],
        start: 23,
        end: 27,
      },
    ],
    members: [
      {
        kind: "PropertySignature",
        name: { kind: "Identifier", name: "x", start: 30, end: 31 },
        optional: false,
        readonly: false,
        type: { kind: "TypeReference", name: "T", typeArguments: null, start: 33, end: 34 },
        start: 30,
        end: 34,
      },
      {
        kind: "MethodSignature",
        name: { kind: "Identifier", name: "m", start: 36, end: 37 },
        optional: false,
        typeParameters: null,
        parameters: [],
        returnType: { kind: "KeywordType", name: "void", start: 41, end: 45 },
        start: 36,
        end: 45,
      },
    ],
    start: 0,
    end: 47,
  });
});

test("parses generic interfaces with generic methods", () => {
  expect(parseProgram("interface I<T> extends A<T> { m<U>(x: U): T }").body[0]).toMatchObject({
    kind: "InterfaceDeclaration",
    name: { kind: "Identifier", name: "I", start: 10, end: 11 },
    typeParameters: [
      {
        kind: "TypeParameter",
        name: { kind: "Identifier", name: "T", start: 12, end: 13 },
        constraint: null,
        default: null,
        start: 12,
        end: 13,
      },
    ],
    extends: [
      {
        kind: "TypeReference",
        name: "A",
        typeArguments: [
          { kind: "TypeReference", name: "T", typeArguments: null, start: 25, end: 26 },
        ],
        start: 23,
        end: 27,
      },
    ],
    members: [
      {
        kind: "MethodSignature",
        name: { kind: "Identifier", name: "m", start: 30, end: 31 },
        optional: false,
        typeParameters: [
          {
            kind: "TypeParameter",
            name: { kind: "Identifier", name: "U", start: 32, end: 33 },
            constraint: null,
            default: null,
            start: 32,
            end: 33,
          },
        ],
        parameters: [
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "x", start: 35, end: 36 },
            optional: false,
            rest: false,
            type: { kind: "TypeReference", name: "U", typeArguments: null, start: 38, end: 39 },
            initializer: null,
            start: 35,
            end: 39,
          },
        ],
        returnType: { kind: "TypeReference", name: "T", typeArguments: null, start: 42, end: 43 },
        start: 30,
        end: 43,
      },
    ],
    start: 0,
    end: 45,
  });
});

test("parses type aliases with full spans", () => {
  expect(parseProgram("type T = A;").body[0]).toEqual({
    kind: "TypeAliasDeclaration",
    name: { kind: "Identifier", name: "T", start: 5, end: 6 },
    typeParameters: null,
    type: { kind: "TypeReference", name: "A", typeArguments: null, start: 9, end: 10 },
    start: 0,
    end: 11,
  });
});

test("parses generic and structured type aliases", () => {
  expect(parseProgram("type F<T> = (x: T) => T;").body[0]).toMatchObject({
    kind: "TypeAliasDeclaration",
    name: { kind: "Identifier", name: "F", start: 5, end: 6 },
    typeParameters: [
      {
        kind: "TypeParameter",
        name: { kind: "Identifier", name: "T", start: 7, end: 8 },
        constraint: null,
        default: null,
        start: 7,
        end: 8,
      },
    ],
    type: {
      kind: "FunctionType",
      typeParameters: null,
      parameters: [
        {
          kind: "Parameter",
          name: { kind: "Identifier", name: "x", start: 13, end: 14 },
          type: { kind: "TypeReference", name: "T", typeArguments: null, start: 16, end: 17 },
        },
      ],
      returnType: { kind: "TypeReference", name: "T", typeArguments: null, start: 22, end: 23 },
      start: 12,
      end: 23,
    },
    start: 0,
    end: 24,
  });
  expect(parseProgram("type M = { a: string; b?: number }").body[0]).toMatchObject({
    kind: "TypeAliasDeclaration",
    name: { kind: "Identifier", name: "M", start: 5, end: 6 },
    typeParameters: null,
    type: {
      kind: "TypeLiteral",
      members: [
        {
          kind: "PropertySignature",
          name: { kind: "Identifier", name: "a", start: 11, end: 12 },
          optional: false,
          type: { kind: "KeywordType", name: "string", start: 14, end: 20 },
        },
        {
          kind: "PropertySignature",
          name: { kind: "Identifier", name: "b", start: 22, end: 23 },
          optional: true,
          type: { kind: "KeywordType", name: "number", start: 26, end: 32 },
        },
      ],
    },
  });
});

test("parses type as an ordinary expression identifier", () => {
  expect(parseProgram("type;").body[0]).toEqual({
    kind: "ExpressionStatement",
    expression: { kind: "Identifier", name: "type", start: 0, end: 4 },
    start: 0,
    end: 5,
  });
  expect(parseProgram("type = 1;").body[0]).toMatchObject({
    kind: "ExpressionStatement",
    expression: {
      kind: "AssignmentExpression",
      operator: "=",
      left: { kind: "Identifier", name: "type", start: 0, end: 4 },
      right: { kind: "NumberLiteral", value: 1, raw: "1", start: 7, end: 8 },
      start: 0,
      end: 8,
    },
    start: 0,
    end: 9,
  });
});

test("parses enum declarations", () => {
  expect(parseProgram("enum E {}").body[0]).toEqual({
    kind: "EnumDeclaration",
    name: { kind: "Identifier", name: "E", start: 5, end: 6 },
    const: false,
    members: [],
    start: 0,
    end: 9,
  });
  expect(parseProgram("enum E { A, B }").body[0]).toMatchObject({
    kind: "EnumDeclaration",
    name: { kind: "Identifier", name: "E", start: 5, end: 6 },
    const: false,
    members: [
      {
        kind: "EnumMember",
        name: { kind: "Identifier", name: "A", start: 9, end: 10 },
        initializer: null,
        start: 9,
        end: 10,
      },
      {
        kind: "EnumMember",
        name: { kind: "Identifier", name: "B", start: 12, end: 13 },
        initializer: null,
        start: 12,
        end: 13,
      },
    ],
    start: 0,
    end: 15,
  });
  expect(parseProgram('enum E { A = 1, B = "b" }').body[0]).toMatchObject({
    kind: "EnumDeclaration",
    const: false,
    members: [
      {
        kind: "EnumMember",
        name: { kind: "Identifier", name: "A", start: 9, end: 10 },
        initializer: { kind: "NumberLiteral", value: 1, raw: "1", start: 13, end: 14 },
        start: 9,
        end: 14,
      },
      {
        kind: "EnumMember",
        name: { kind: "Identifier", name: "B", start: 16, end: 17 },
        initializer: { kind: "StringLiteral", value: "b", raw: '"b"', start: 20, end: 23 },
        start: 16,
        end: 23,
      },
    ],
    start: 0,
    end: 25,
  });
  expect(parseProgram("enum E { A, }").body[0]).toMatchObject({
    kind: "EnumDeclaration",
    const: false,
    members: [
      {
        kind: "EnumMember",
        name: { kind: "Identifier", name: "A", start: 9, end: 10 },
        initializer: null,
        start: 9,
        end: 10,
      },
    ],
    start: 0,
    end: 13,
  });
});

test("parses const enums", () => {
  expect(parseProgram("const enum C { X }").body[0]).toEqual({
    kind: "EnumDeclaration",
    name: { kind: "Identifier", name: "C", start: 11, end: 12 },
    const: true,
    members: [
      {
        kind: "EnumMember",
        name: { kind: "Identifier", name: "X", start: 15, end: 16 },
        initializer: null,
        start: 15,
        end: 16,
      },
    ],
    start: 0,
    end: 18,
  });
});

test("parses mixed interface, type alias, enum, and variable statements", () => {
  const program = parseProgram("interface I {}\ntype T = I;\nenum E { A }\nconst x = 1;");
  expect(program.body).toMatchObject([
    {
      kind: "InterfaceDeclaration",
      name: { kind: "Identifier", name: "I", start: 10, end: 11 },
      start: 0,
      end: 14,
    },
    {
      kind: "TypeAliasDeclaration",
      name: { kind: "Identifier", name: "T", start: 20, end: 21 },
      type: { kind: "TypeReference", name: "I", typeArguments: null, start: 24, end: 25 },
      start: 15,
      end: 26,
    },
    {
      kind: "EnumDeclaration",
      name: { kind: "Identifier", name: "E", start: 32, end: 33 },
      const: false,
      members: [
        {
          kind: "EnumMember",
          name: { kind: "Identifier", name: "A", start: 36, end: 37 },
          start: 36,
          end: 37,
        },
      ],
      start: 27,
      end: 39,
    },
    {
      kind: "VariableStatement",
      declarationKind: "const",
      declarations: [
        { kind: "VariableDeclarator", name: { kind: "Identifier", name: "x", start: 46, end: 47 } },
      ],
      start: 40,
      end: 52,
    },
  ]);
});

test("reports errors for malformed interface declarations", () => {
  const missingBody = captureProgramParseError("interface I");
  expect(missingBody).toBeInstanceOf(ParseError);
  expect(errorPosition(missingBody)).toEqual({ offset: 11, line: 1, column: 12 });
  expect(missingBody.message).toBe('expected "{"');

  const missingExtends = captureProgramParseError("interface I extends {");
  expect(missingExtends).toBeInstanceOf(ParseError);
  expect(errorPosition(missingExtends)).toEqual({ offset: 20, line: 1, column: 21 });
  expect(missingExtends.message).toBe('unexpected token "{"');
});

test("reports errors for malformed type alias declarations", () => {
  const missingEquals = captureProgramParseError("type T");
  expect(missingEquals).toBeInstanceOf(ParseError);
  expect(errorPosition(missingEquals)).toEqual({ offset: 6, line: 1, column: 7 });
  expect(missingEquals.message).toBe('expected "="');

  const missingType = captureProgramParseError("type T =");
  expect(missingType).toBeInstanceOf(ParseError);
  expect(errorPosition(missingType)).toEqual({ offset: 8, line: 1, column: 9 });
  expect(missingType.message).toBe("unexpected end of input");
});

test("reports errors for malformed enum declarations", () => {
  const missingClose = captureProgramParseError("enum E {");
  expect(missingClose).toBeInstanceOf(ParseError);
  expect(errorPosition(missingClose)).toEqual({ offset: 8, line: 1, column: 9 });
  expect(missingClose.message).toBe("unexpected end of input");

  const missingInitializer = captureProgramParseError("enum E { A = }");
  expect(missingInitializer).toBeInstanceOf(ParseError);
  expect(errorPosition(missingInitializer)).toEqual({ offset: 13, line: 1, column: 14 });
  expect(missingInitializer.message).toBe('unexpected token "}"');

  const missingName = captureProgramParseError("const enum");
  expect(missingName).toBeInstanceOf(ParseError);
  expect(errorPosition(missingName)).toEqual({ offset: 10, line: 1, column: 11 });
  expect(missingName.message).toBe("unexpected end of input");
});

test("parses empty class declarations with full spans", () => {
  expect(parseProgram("class A {}").body[0]).toEqual({
    kind: "ClassDeclaration",
    name: { kind: "Identifier", name: "A", start: 6, end: 7 },
    typeParameters: null,
    extends: null,
    implements: [],
    members: [],
    start: 0,
    end: 10,
  });
});

test("parses class extends and implements clauses", () => {
  expect(parseProgram("class A extends B implements I, J {}").body[0]).toMatchObject({
    kind: "ClassDeclaration",
    name: { kind: "Identifier", name: "A", start: 6, end: 7 },
    extends: { kind: "Identifier", name: "B", start: 16, end: 17 },
    implements: [
      { kind: "TypeReference", name: "I", typeArguments: null, start: 29, end: 30 },
      { kind: "TypeReference", name: "J", typeArguments: null, start: 32, end: 33 },
    ],
    members: [],
    start: 0,
    end: 36,
  });
  expect(parseProgram("class A extends mixin(B) {}").body[0]).toMatchObject({
    kind: "ClassDeclaration",
    extends: {
      kind: "CallExpression",
      callee: { kind: "Identifier", name: "mixin", start: 16, end: 21 },
      arguments: [{ kind: "Identifier", name: "B", start: 22, end: 23 }],
    },
  });
});

test("parses abstract class declarations", () => {
  expect(parseProgram("abstract class A {}").body[0]).toEqual({
    kind: "ClassDeclaration",
    name: { kind: "Identifier", name: "A", start: 15, end: 16 },
    typeParameters: null,
    extends: null,
    implements: [],
    members: [],
    abstract: true,
    start: 0,
    end: 19,
  });
});

test("parses class type parameters and generic methods", () => {
  expect(parseProgram("class A<T> { m<U>(x: U): T { return x; } }").body[0]).toMatchObject({
    kind: "ClassDeclaration",
    typeParameters: [
      {
        kind: "TypeParameter",
        name: { kind: "Identifier", name: "T", start: 8, end: 9 },
        constraint: null,
        default: null,
      },
    ],
    members: [
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "m", start: 13, end: 14 },
        typeParameters: [
          { kind: "TypeParameter", name: { kind: "Identifier", name: "U", start: 15, end: 16 } },
        ],
        parameters: [{ name: { kind: "Identifier", name: "x", start: 18, end: 19 } }],
        returnType: { kind: "TypeReference", name: "T", start: 25, end: 26 },
        body: { kind: "BlockStatement", start: 27, end: 40 },
        start: 13,
        end: 40,
      },
    ],
    start: 0,
    end: 42,
  });
});

test("parses property declarations with types and initializers", () => {
  expect(parseProgram("class A { x: number = 1; }").body[0]).toMatchObject({
    kind: "ClassDeclaration",
    members: [
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", name: "x", start: 10, end: 11 },
        type: { kind: "KeywordType", name: "number", start: 13, end: 19 },
        initializer: { kind: "NumberLiteral", value: 1, raw: "1", start: 22, end: 23 },
        static: false,
        readonly: false,
        optional: false,
        definite: false,
        accessibility: null,
        abstract: false,
        declare: false,
        override: false,
        start: 10,
        end: 23,
      },
    ],
    end: 26,
  });
});

test("parses static, readonly, and accessibility modifiers", () => {
  expect(parseProgram("class A { static s = 1; }").body[0]).toMatchObject({
    members: [
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", name: "s", start: 17, end: 18 },
        initializer: { kind: "NumberLiteral", value: 1, start: 21, end: 22 },
        static: true,
        readonly: false,
        start: 10,
        end: 22,
      },
    ],
  });
  expect(parseProgram("class A { readonly r = 2; }").body[0]).toMatchObject({
    members: [
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", name: "r", start: 19, end: 20 },
        static: false,
        readonly: true,
        start: 10,
        end: 24,
      },
    ],
  });
  expect(parseProgram("class A { private p; protected q; public w; }").body[0]).toMatchObject({
    members: [
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", name: "p", start: 18, end: 19 },
        accessibility: "private",
        start: 10,
        end: 19,
      },
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", name: "q", start: 31, end: 32 },
        accessibility: "protected",
        start: 21,
        end: 32,
      },
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", name: "w", start: 41, end: 42 },
        accessibility: "public",
        start: 34,
        end: 42,
      },
    ],
  });
  expect(parseProgram("class A { static readonly sr = 1; }").body[0]).toMatchObject({
    members: [
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", name: "sr", start: 26, end: 28 },
        static: true,
        readonly: true,
        start: 10,
        end: 32,
      },
    ],
  });
});

test("parses optional and definite properties", () => {
  expect(parseProgram("class A { x?: number; }").body[0]).toMatchObject({
    members: [
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", name: "x", start: 10, end: 11 },
        type: { kind: "KeywordType", name: "number", start: 14, end: 20 },
        optional: true,
        definite: false,
        start: 10,
        end: 20,
      },
    ],
  });
  expect(parseProgram("class A { x!: number; }").body[0]).toMatchObject({
    members: [
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", name: "x", start: 10, end: 11 },
        type: { kind: "KeywordType", name: "number", start: 14, end: 20 },
        optional: false,
        definite: true,
        start: 10,
        end: 20,
      },
    ],
  });
});

test("parses string, number, and computed class member names", () => {
  expect(parseProgram('class A { "str" = 1; 42 = 2; [k]() {} }').body[0]).toMatchObject({
    members: [
      {
        kind: "PropertyDeclaration",
        name: {
          kind: "StringLiteral",
          value: "str",
          raw: '"str"',
          start: 10,
          end: 15,
        },
        initializer: { kind: "NumberLiteral", value: 1, start: 18, end: 19 },
        start: 10,
        end: 19,
      },
      {
        kind: "PropertyDeclaration",
        name: { kind: "NumberLiteral", value: 42, raw: "42", start: 21, end: 23 },
        initializer: { kind: "NumberLiteral", value: 2, start: 26, end: 27 },
        start: 21,
        end: 27,
      },
      {
        kind: "MethodDeclaration",
        name: {
          kind: "ComputedPropertyName",
          expression: { kind: "Identifier", name: "k", start: 30, end: 31 },
          start: 29,
          end: 32,
        },
        body: { kind: "BlockStatement", start: 35, end: 37 },
        start: 29,
        end: 37,
      },
    ],
  });
});

test("parses private fields and methods with #-prefixed identifier names", () => {
  expect(parseProgram("class A { #x = 1; }").body[0]).toMatchObject({
    members: [
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", name: "#x", start: 10, end: 12 },
        initializer: { kind: "NumberLiteral", value: 1, raw: "1", start: 15, end: 16 },
        static: false,
        readonly: false,
        start: 10,
        end: 16,
      },
    ],
  });
  expect(parseProgram("class A { static #count = 0; }").body[0]).toMatchObject({
    members: [
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", name: "#count", start: 17, end: 23 },
        static: true,
        start: 10,
        end: 27,
      },
    ],
  });
  expect(parseProgram("class A { readonly #r = 1; }").body[0]).toMatchObject({
    members: [
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", name: "#r", start: 19, end: 21 },
        readonly: true,
      },
    ],
  });
  expect(parseProgram("class A { #m() {} }").body[0]).toMatchObject({
    members: [
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "#m", start: 10, end: 12 },
        body: { kind: "BlockStatement", body: [], start: 15, end: 17 },
        start: 10,
        end: 17,
      },
    ],
  });
  expect(parseProgram("class A { get #g() { return 1; } }").body[0]).toMatchObject({
    members: [
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "#g", start: 14, end: 16 },
        accessor: "get",
      },
    ],
  });
  expect(parseProgram("class A { #x = 1\n#y = 2 }").body[0]).toMatchObject({
    members: [
      { kind: "PropertyDeclaration", name: { kind: "Identifier", name: "#x" } },
      { kind: "PropertyDeclaration", name: { kind: "Identifier", name: "#y" } },
    ],
  });
});

test("parses private member access with #-prefixed identifier names", () => {
  expect(parseProgram("class A { m() { return this.#x; } }").body[0]).toMatchObject({
    members: [
      {
        kind: "MethodDeclaration",
        body: {
          body: [
            {
              kind: "ReturnStatement",
              argument: {
                kind: "MemberExpression",
                object: { kind: "ThisExpression", start: 23, end: 27 },
                property: { kind: "Identifier", name: "#x", start: 28, end: 30 },
                computed: false,
                optional: false,
                start: 23,
                end: 30,
              },
            },
          ],
        },
      },
    ],
  });
});

test("parses method declarations with bodies and signatures", () => {
  expect(parseProgram("class A { m() {} }").body[0]).toMatchObject({
    members: [
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "m", start: 10, end: 11 },
        typeParameters: null,
        parameters: [],
        returnType: null,
        body: { kind: "BlockStatement", body: [], start: 14, end: 16 },
        static: false,
        readonly: false,
        optional: false,
        accessibility: null,
        abstract: false,
        override: false,
        start: 10,
        end: 16,
      },
    ],
  });
  expect(parseProgram("class A { m(a: T): U { return a; } }").body[0]).toMatchObject({
    members: [
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "m", start: 10, end: 11 },
        parameters: [
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "a", start: 12, end: 13 },
            type: { kind: "TypeReference", name: "T", start: 15, end: 16 },
            start: 12,
            end: 16,
          },
        ],
        returnType: { kind: "TypeReference", name: "U", start: 19, end: 20 },
        body: { kind: "BlockStatement", start: 21, end: 34 },
        start: 10,
        end: 34,
      },
    ],
  });
});

test("parses constructor declarations", () => {
  expect(parseProgram("class A { constructor(a: T) {} }").body[0]).toMatchObject({
    members: [
      {
        kind: "ConstructorDeclaration",
        parameters: [
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "a", start: 22, end: 23 },
            type: { kind: "TypeReference", name: "T", start: 25, end: 26 },
            start: 22,
            end: 26,
          },
        ],
        body: { kind: "BlockStatement", body: [], start: 28, end: 30 },
        accessibility: null,
        start: 10,
        end: 30,
      },
    ],
  });
  expect(parseProgram("class A { private constructor() {} }").body[0]).toMatchObject({
    members: [
      {
        kind: "ConstructorDeclaration",
        accessibility: "private",
        start: 10,
      },
    ],
  });
});

test("parses get and set accessors", () => {
  expect(
    parseProgram("class A { get x(): T { return this.y; } set x(v: T) {} }").body[0],
  ).toMatchObject({
    members: [
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "x", start: 14, end: 15 },
        parameters: [],
        returnType: { kind: "TypeReference", name: "T", start: 19, end: 20 },
        body: { kind: "BlockStatement", start: 21, end: 39 },
        accessor: "get",
        start: 10,
        end: 39,
      },
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "x", start: 44, end: 45 },
        parameters: [
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "v", start: 46, end: 47 },
            type: { kind: "TypeReference", name: "T", start: 49, end: 50 },
            start: 46,
            end: 50,
          },
        ],
        returnType: null,
        body: { kind: "BlockStatement", start: 52, end: 54 },
        accessor: "set",
        start: 40,
        end: 54,
      },
    ],
  });
});

test("parses generator and async methods", () => {
  expect(parseProgram("class A { *g() {} async am() {} }").body[0]).toMatchObject({
    members: [
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "g", start: 11, end: 12 },
        body: { kind: "BlockStatement", start: 15, end: 17 },
        generator: true,
        start: 10,
        end: 17,
      },
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "am", start: 24, end: 26 },
        body: { kind: "BlockStatement", start: 29, end: 31 },
        async: true,
        start: 18,
        end: 31,
      },
    ],
  });
});

test("parses method overload signatures", () => {
  expect(parseProgram("class A { m(a: T): U; m(a: T): U { return a; } }").body[0]).toMatchObject({
    members: [
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "m", start: 10, end: 11 },
        returnType: { kind: "TypeReference", name: "U", start: 19, end: 20 },
        body: null,
        start: 10,
        end: 20,
      },
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "m", start: 22, end: 23 },
        returnType: { kind: "TypeReference", name: "U", start: 31, end: 32 },
        body: { kind: "BlockStatement", start: 33, end: 46 },
        start: 22,
        end: 46,
      },
    ],
  });
});

test("parses index signatures in classes", () => {
  expect(parseProgram("class A { [k: string]: any }").body[0]).toMatchObject({
    members: [
      {
        kind: "IndexSignature",
        readonly: false,
        keyName: { kind: "Identifier", name: "k", start: 11, end: 12 },
        keyType: { kind: "KeywordType", name: "string", start: 14, end: 20 },
        type: { kind: "KeywordType", name: "any", start: 23, end: 26 },
        start: 10,
        end: 26,
      },
    ],
  });
  expect(parseProgram("class A { readonly [k: string]: any }").body[0]).toMatchObject({
    members: [{ kind: "IndexSignature", readonly: true, start: 10, end: 35 }],
  });
});

test("parses declare and abstract class members", () => {
  expect(parseProgram("class A { declare d: number; }").body[0]).toMatchObject({
    members: [
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", name: "d", start: 18, end: 19 },
        type: { kind: "KeywordType", name: "number", start: 21, end: 27 },
        declare: true,
        start: 10,
        end: 27,
      },
    ],
  });
  expect(parseProgram("class A { abstract m(): void; }").body[0]).toMatchObject({
    members: [
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "m", start: 19, end: 20 },
        returnType: { kind: "KeywordType", name: "void", start: 24, end: 28 },
        body: null,
        abstract: true,
        start: 10,
        end: 28,
      },
    ],
  });
});

test("parses class declarations mixed with other statements", () => {
  const program = parseProgram("class A {}\ninterface I {}\nconst x = new A();");
  expect(program.body).toMatchObject([
    { kind: "ClassDeclaration", name: { kind: "Identifier", name: "A" }, start: 0, end: 10 },
    { kind: "InterfaceDeclaration", name: { kind: "Identifier", name: "I" }, start: 11, end: 25 },
    { kind: "VariableStatement", declarationKind: "const", start: 26, end: 44 },
  ]);
});

test("reports errors for malformed class declarations", () => {
  const missingName = captureProgramParseError("class {");
  expect(missingName).toBeInstanceOf(ParseError);
  expect(errorPosition(missingName)).toEqual({ offset: 6, line: 1, column: 7 });
  expect(missingName.message).toBe('unexpected token "{"');

  const badParameter = captureProgramParseError("class A { m( }");
  expect(badParameter).toBeInstanceOf(ParseError);
  expect(errorPosition(badParameter)).toEqual({ offset: 13, line: 1, column: 14 });
  expect(badParameter.message).toBe('unexpected token "}"');

  const missingHeritage = captureProgramParseError("class A extends");
  expect(missingHeritage).toBeInstanceOf(ParseError);
  expect(errorPosition(missingHeritage)).toEqual({ offset: 15, line: 1, column: 16 });
  expect(missingHeritage.message).toBe("unexpected end of input");

  const missingClose = captureProgramParseError("class A {");
  expect(missingClose).toBeInstanceOf(ParseError);
  expect(errorPosition(missingClose)).toEqual({ offset: 9, line: 1, column: 10 });
  expect(missingClose.message).toBe("unexpected end of input");

  const missingCloseOnLine = captureProgramParseError("class A {\n  m() {");
  expect(missingCloseOnLine).toBeInstanceOf(ParseError);
  expect(errorPosition(missingCloseOnLine)).toEqual({ offset: 17, line: 2, column: 8 });
  expect(missingCloseOnLine.message).toBe('expected "}"');
});

test("parses anonymous function expressions with full spans", () => {
  expect(parseProgram("const f = function () {};").body[0]).toEqual({
    kind: "VariableStatement",
    declarationKind: "const",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: { kind: "Identifier", name: "f", start: 6, end: 7 },
        type: null,
        initializer: {
          kind: "FunctionExpression",
          name: null,
          typeParameters: null,
          parameters: [],
          returnType: null,
          body: { kind: "BlockStatement", body: [], start: 22, end: 24 },
          start: 10,
          end: 24,
        },
        start: 6,
        end: 24,
      },
    ],
    start: 0,
    end: 25,
  });
});

test("parses named, generator, and async function expressions", () => {
  expect(parseProgram("const f = function g() {};").body[0]).toMatchObject({
    declarations: [
      {
        initializer: {
          kind: "FunctionExpression",
          name: { kind: "Identifier", name: "g", start: 19, end: 20 },
          body: { kind: "BlockStatement", start: 23, end: 25 },
          start: 10,
          end: 25,
        },
      },
    ],
  });
  expect(parseProgram("const f = function* () {};").body[0]).toMatchObject({
    declarations: [
      {
        initializer: {
          kind: "FunctionExpression",
          name: null,
          generator: true,
          start: 10,
          end: 25,
        },
      },
    ],
  });
  expect(parseProgram("const f = async function () {};").body[0]).toMatchObject({
    declarations: [
      {
        initializer: {
          kind: "FunctionExpression",
          name: null,
          async: true,
          start: 10,
          end: 30,
        },
      },
    ],
  });
  expect(parseProgram("const f = async function* g() {};").body[0]).toMatchObject({
    declarations: [
      {
        initializer: {
          kind: "FunctionExpression",
          name: { kind: "Identifier", name: "g", start: 26, end: 27 },
          async: true,
          generator: true,
          start: 10,
          end: 32,
        },
      },
    ],
  });
});

test("parses generic function expressions with parameters and return types", () => {
  expect(parseProgram("const f = function <T>(x: T): T { return x; };").body[0]).toMatchObject({
    declarations: [
      {
        initializer: {
          kind: "FunctionExpression",
          name: null,
          typeParameters: [
            {
              kind: "TypeParameter",
              name: { kind: "Identifier", name: "T", start: 20, end: 21 },
            },
          ],
          parameters: [
            {
              kind: "Parameter",
              name: { kind: "Identifier", name: "x", start: 23, end: 24 },
              type: { kind: "TypeReference", name: "T", start: 26, end: 27 },
            },
          ],
          returnType: { kind: "TypeReference", name: "T", start: 30, end: 31 },
          start: 10,
          end: 45,
        },
      },
    ],
  });
});

test("parses class expressions", () => {
  expect(parseProgram("const c = class {};").body[0]).toMatchObject({
    declarations: [
      {
        initializer: {
          kind: "ClassExpression",
          name: null,
          typeParameters: null,
          extends: null,
          implements: [],
          members: [],
          start: 10,
          end: 18,
        },
      },
    ],
  });
  expect(parseProgram("const c = class Named {};").body[0]).toMatchObject({
    declarations: [
      {
        initializer: {
          kind: "ClassExpression",
          name: { kind: "Identifier", name: "Named", start: 16, end: 21 },
          start: 10,
          end: 24,
        },
      },
    ],
  });
  expect(parseProgram("const c = class extends B {};").body[0]).toMatchObject({
    declarations: [
      {
        initializer: {
          kind: "ClassExpression",
          name: null,
          extends: { kind: "Identifier", name: "B", start: 24, end: 25 },
          start: 10,
          end: 28,
        },
      },
    ],
  });
  expect(parseProgram("const c = class { m() {} };").body[0]).toMatchObject({
    declarations: [
      {
        initializer: {
          kind: "ClassExpression",
          members: [
            {
              kind: "MethodDeclaration",
              name: { kind: "Identifier", name: "m", start: 18, end: 19 },
              start: 18,
              end: 24,
            },
          ],
          start: 10,
          end: 26,
        },
      },
    ],
  });
});

test("parses abstract class expressions", () => {
  expect(parseProgram("const c = abstract class {};").body[0]).toMatchObject({
    declarations: [
      {
        initializer: {
          kind: "ClassExpression",
          name: null,
          members: [],
          abstract: true,
          start: 10,
          end: 27,
        },
      },
    ],
  });
});

test("parses object methods with full spans", () => {
  expect(parse("{ f() {} }")).toEqual({
    kind: "ObjectLiteral",
    start: 0,
    end: 10,
    properties: [
      {
        kind: "ObjectMethod",
        name: { kind: "Identifier", name: "f", start: 2, end: 3 },
        typeParameters: null,
        parameters: [],
        returnType: null,
        body: { kind: "BlockStatement", body: [], start: 6, end: 8 },
        start: 2,
        end: 8,
      },
    ],
  });
});

test("parses object methods with parameters and return types", () => {
  expect(parse("{ f(a: T): U { return a; } }")).toMatchObject({
    kind: "ObjectLiteral",
    start: 0,
    end: 28,
    properties: [
      {
        kind: "ObjectMethod",
        name: { kind: "Identifier", name: "f", start: 2, end: 3 },
        typeParameters: null,
        parameters: [
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "a", start: 4, end: 5 },
            type: { kind: "TypeReference", name: "T", start: 7, end: 8 },
          },
        ],
        returnType: { kind: "TypeReference", name: "U", start: 11, end: 12 },
        body: { kind: "BlockStatement", start: 13, end: 26 },
        start: 2,
        end: 26,
      },
    ],
  });
});

test("parses object accessors", () => {
  expect(parse("{ get x() { return 1; } }")).toMatchObject({
    properties: [
      {
        kind: "ObjectMethod",
        name: { kind: "Identifier", name: "x", start: 6, end: 7 },
        parameters: [],
        accessor: "get",
        start: 2,
        end: 23,
      },
    ],
  });
  expect(parse("{ set x(v: T) {} }")).toMatchObject({
    properties: [
      {
        kind: "ObjectMethod",
        name: { kind: "Identifier", name: "x", start: 6, end: 7 },
        parameters: [
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "v", start: 8, end: 9 },
            type: { kind: "TypeReference", name: "T", start: 11, end: 12 },
          },
        ],
        accessor: "set",
        start: 2,
        end: 16,
      },
    ],
  });
});

test("parses async and generator object methods", () => {
  expect(parse("{ async m() {} }")).toMatchObject({
    properties: [
      {
        kind: "ObjectMethod",
        name: { kind: "Identifier", name: "m", start: 8, end: 9 },
        async: true,
        start: 2,
        end: 14,
      },
    ],
  });
  expect(parse("{ *g() {} }")).toMatchObject({
    properties: [
      {
        kind: "ObjectMethod",
        name: { kind: "Identifier", name: "g", start: 3, end: 4 },
        generator: true,
        start: 2,
        end: 9,
      },
    ],
  });
});

test("parses computed and string-keyed object methods", () => {
  expect(parse("{ [k]() {} }")).toMatchObject({
    properties: [
      {
        kind: "ObjectMethod",
        name: {
          kind: "ComputedPropertyName",
          expression: { kind: "Identifier", name: "k", start: 3, end: 4 },
          start: 2,
          end: 5,
        },
        start: 2,
        end: 10,
      },
    ],
  });
  expect(parse('{ "s"() {} }')).toMatchObject({
    properties: [
      {
        kind: "ObjectMethod",
        name: { kind: "StringLiteral", value: "s", raw: '"s"', start: 2, end: 5 },
        start: 2,
        end: 10,
      },
    ],
  });
});

test("parses object literals mixing properties and methods", () => {
  expect(parse("{ a: 1, m() {}, b: 2 }")).toMatchObject({
    kind: "ObjectLiteral",
    start: 0,
    end: 22,
    properties: [
      {
        kind: "Property",
        key: { kind: "Identifier", name: "a", start: 2, end: 3 },
        value: { kind: "NumberLiteral", value: 1, start: 5, end: 6 },
        start: 2,
        end: 6,
      },
      {
        kind: "ObjectMethod",
        name: { kind: "Identifier", name: "m", start: 8, end: 9 },
        start: 8,
        end: 14,
      },
      {
        kind: "Property",
        key: { kind: "Identifier", name: "b", start: 16, end: 17 },
        value: { kind: "NumberLiteral", value: 2, start: 19, end: 20 },
        start: 16,
        end: 20,
      },
    ],
  });
  expect(parse("{ f: function () {} }")).toMatchObject({
    properties: [
      {
        kind: "Property",
        key: { kind: "Identifier", name: "f", start: 2, end: 3 },
        value: {
          kind: "FunctionExpression",
          name: null,
          body: { kind: "BlockStatement", start: 17, end: 19 },
          start: 5,
          end: 19,
        },
        start: 2,
        end: 19,
      },
    ],
  });
});

test("keeps get, set, and async as ordinary object property keys", () => {
  expect(parse("{ get: 1, set: 2, async: 3 }")).toMatchObject({
    properties: [
      {
        kind: "Property",
        key: { kind: "Identifier", name: "get", start: 2, end: 5 },
        value: { kind: "NumberLiteral", value: 1, start: 7, end: 8 },
      },
      {
        kind: "Property",
        key: { kind: "Identifier", name: "set", start: 10, end: 13 },
        value: { kind: "NumberLiteral", value: 2, start: 15, end: 16 },
      },
      {
        kind: "Property",
        key: { kind: "Identifier", name: "async", start: 18, end: 23 },
        value: { kind: "NumberLiteral", value: 3, start: 25, end: 26 },
      },
    ],
  });
  expect(parse("{ get, set, async }")).toMatchObject({
    properties: [
      { kind: "Property", shorthand: true, key: { kind: "Identifier", name: "get" } },
      { kind: "Property", shorthand: true, key: { kind: "Identifier", name: "set" } },
      { kind: "Property", shorthand: true, key: { kind: "Identifier", name: "async" } },
    ],
  });
  expect(parse("{ async() {} }")).toMatchObject({
    properties: [
      {
        kind: "ObjectMethod",
        name: { kind: "Identifier", name: "async", start: 2, end: 7 },
        start: 2,
        end: 12,
      },
    ],
  });
});

test("throws ParseError for malformed function, class, and method expressions", () => {
  const missingBody = captureProgramParseError("const f = function ();");
  expect(missingBody).toBeInstanceOf(ParseError);
  expect(errorPosition(missingBody)).toEqual({ offset: 21, line: 1, column: 22 });
  expect(missingBody.message).toBe('expected "{"');

  const missingParameter = captureProgramParseError("const o = { f( }");
  expect(missingParameter).toBeInstanceOf(ParseError);
  expect(errorPosition(missingParameter)).toEqual({ offset: 15, line: 1, column: 16 });
  expect(missingParameter.message).toBe('unexpected token "}"');

  const unclosedClass = captureProgramParseError("const c = class {");
  expect(unclosedClass).toBeInstanceOf(ParseError);
  expect(errorPosition(unclosedClass)).toEqual({ offset: 17, line: 1, column: 18 });
  expect(unclosedClass.message).toBe("unexpected end of input");

  const optionalMethod = captureParseError("{ f?() {} }");
  expect(optionalMethod).toBeInstanceOf(ParseError);
  expect(errorPosition(optionalMethod)).toEqual({ offset: 3, line: 1, column: 4 });
  expect(optionalMethod.message).toBe("object method may not be optional");
});

test("parses side-effect import declarations with full spans", () => {
  expect(parseProgram('import "m";')).toEqual({
    kind: "Program",
    body: [
      {
        kind: "ImportDeclaration",
        defaultImport: null,
        namespaceImport: null,
        namedImports: [],
        source: { kind: "StringLiteral", value: "m", raw: '"m"', start: 7, end: 10 },
        importKind: "value",
        start: 0,
        end: 11,
      },
    ],
    source: 'import "m";',
    start: 0,
    end: 11,
  });
});

test("parses default, namespace, and named import declarations", () => {
  expect(parseProgram('import a from "m";').body[0]).toMatchObject({
    kind: "ImportDeclaration",
    defaultImport: { kind: "Identifier", name: "a", start: 7, end: 8 },
    namespaceImport: null,
    namedImports: [],
    source: { kind: "StringLiteral", value: "m", raw: '"m"', start: 14, end: 17 },
    importKind: "value",
    start: 0,
    end: 18,
  });
  expect(parseProgram('import * as ns from "m";').body[0]).toMatchObject({
    kind: "ImportDeclaration",
    defaultImport: null,
    namespaceImport: { kind: "Identifier", name: "ns", start: 12, end: 14 },
    namedImports: [],
    source: { kind: "StringLiteral", value: "m", start: 20, end: 23 },
    importKind: "value",
    start: 0,
    end: 24,
  });
  expect(parseProgram('import {a, b as c} from "m";').body[0]).toMatchObject({
    kind: "ImportDeclaration",
    defaultImport: null,
    namespaceImport: null,
    namedImports: [
      {
        kind: "ImportSpecifier",
        imported: { kind: "Identifier", name: "a", start: 8, end: 9 },
        local: { kind: "Identifier", name: "a", start: 8, end: 9 },
        typeOnly: false,
        start: 8,
        end: 9,
      },
      {
        kind: "ImportSpecifier",
        imported: { kind: "Identifier", name: "b", start: 11, end: 12 },
        local: { kind: "Identifier", name: "c", start: 16, end: 17 },
        typeOnly: false,
        start: 11,
        end: 17,
      },
    ],
    source: { kind: "StringLiteral", value: "m", start: 24, end: 27 },
    importKind: "value",
    start: 0,
    end: 28,
  });
  expect(parseProgram('import a, {b} from "m";').body[0]).toMatchObject({
    kind: "ImportDeclaration",
    defaultImport: { kind: "Identifier", name: "a", start: 7, end: 8 },
    namespaceImport: null,
    namedImports: [
      {
        kind: "ImportSpecifier",
        imported: { kind: "Identifier", name: "b", start: 11, end: 12 },
        local: { kind: "Identifier", name: "b", start: 11, end: 12 },
        typeOnly: false,
      },
    ],
    source: { kind: "StringLiteral", value: "m", start: 19, end: 22 },
    start: 0,
    end: 23,
  });
  expect(parseProgram('import a, * as ns from "m";').body[0]).toMatchObject({
    kind: "ImportDeclaration",
    defaultImport: { kind: "Identifier", name: "a", start: 7, end: 8 },
    namespaceImport: { kind: "Identifier", name: "ns", start: 15, end: 17 },
    namedImports: [],
    source: { kind: "StringLiteral", value: "m", start: 23, end: 26 },
    start: 0,
    end: 27,
  });
  expect(parseProgram('import {a,} from "m";').body[0]).toMatchObject({
    kind: "ImportDeclaration",
    namedImports: [
      {
        kind: "ImportSpecifier",
        imported: { kind: "Identifier", name: "a", start: 8, end: 9 },
        local: { kind: "Identifier", name: "a", start: 8, end: 9 },
        typeOnly: false,
      },
    ],
    source: { kind: "StringLiteral", value: "m", start: 17, end: 20 },
    start: 0,
    end: 21,
  });
});

test("parses type-only import declarations and specifiers", () => {
  expect(parseProgram('import type {a} from "m";').body[0]).toMatchObject({
    kind: "ImportDeclaration",
    defaultImport: null,
    namespaceImport: null,
    namedImports: [
      {
        kind: "ImportSpecifier",
        imported: { kind: "Identifier", name: "a", start: 13, end: 14 },
        local: { kind: "Identifier", name: "a", start: 13, end: 14 },
        typeOnly: false,
      },
    ],
    source: { kind: "StringLiteral", value: "m", start: 21, end: 24 },
    importKind: "type",
    start: 0,
    end: 25,
  });
  expect(parseProgram('import type a from "m";').body[0]).toMatchObject({
    kind: "ImportDeclaration",
    defaultImport: { kind: "Identifier", name: "a", start: 12, end: 13 },
    namespaceImport: null,
    namedImports: [],
    source: { kind: "StringLiteral", value: "m", start: 19, end: 22 },
    importKind: "type",
    start: 0,
    end: 23,
  });
  expect(parseProgram('import type * as ns from "m";').body[0]).toMatchObject({
    kind: "ImportDeclaration",
    defaultImport: null,
    namespaceImport: { kind: "Identifier", name: "ns", start: 17, end: 19 },
    namedImports: [],
    source: { kind: "StringLiteral", value: "m", start: 25, end: 28 },
    importKind: "type",
    start: 0,
    end: 29,
  });
  expect(parseProgram('import {type a, b} from "m";').body[0]).toMatchObject({
    kind: "ImportDeclaration",
    namedImports: [
      {
        kind: "ImportSpecifier",
        imported: { kind: "Identifier", name: "a", start: 13, end: 14 },
        local: { kind: "Identifier", name: "a", start: 13, end: 14 },
        typeOnly: true,
      },
      {
        kind: "ImportSpecifier",
        imported: { kind: "Identifier", name: "b", start: 16, end: 17 },
        local: { kind: "Identifier", name: "b", start: 16, end: 17 },
        typeOnly: false,
      },
    ],
    source: { kind: "StringLiteral", value: "m", start: 24, end: 27 },
    importKind: "value",
    start: 0,
    end: 28,
  });
  expect(parseProgram('import {"str" as x} from "m";').body[0]).toMatchObject({
    kind: "ImportDeclaration",
    namedImports: [
      {
        kind: "ImportSpecifier",
        imported: { kind: "StringLiteral", value: "str", raw: '"str"', start: 8, end: 13 },
        local: { kind: "Identifier", name: "x", start: 17, end: 18 },
        typeOnly: false,
      },
    ],
    source: { kind: "StringLiteral", value: "m", start: 25, end: 28 },
    importKind: "value",
    start: 0,
    end: 29,
  });
});

test("parses import declarations with with attributes", () => {
  expect(parseProgram('import data from "./d.json" with { type: "json" };').body[0]).toMatchObject({
    kind: "ImportDeclaration",
    defaultImport: { kind: "Identifier", name: "data", start: 7, end: 11 },
    source: { kind: "StringLiteral", value: "./d.json", raw: '"./d.json"', start: 17, end: 27 },
    importKind: "value",
    attributes: [
      {
        kind: "ImportAttribute",
        key: { kind: "Identifier", name: "type", start: 35, end: 39 },
        value: { kind: "StringLiteral", value: "json", raw: '"json"', start: 41, end: 47 },
        start: 35,
        end: 47,
      },
    ],
    start: 0,
    end: 50,
  });
  expect(parseProgram('import "./style.css" with { type: "css" };').body[0]).toMatchObject({
    kind: "ImportDeclaration",
    defaultImport: null,
    source: { kind: "StringLiteral", value: "./style.css", start: 7, end: 20 },
    attributes: [{ key: { kind: "Identifier", name: "type" }, value: { value: "css" } }],
  });
  expect(
    parseProgram('import * as ns from "./m" with { "resolution-mode": "import" };').body[0],
  ).toMatchObject({
    kind: "ImportDeclaration",
    namespaceImport: { kind: "Identifier", name: "ns" },
    attributes: [
      {
        key: { kind: "StringLiteral", value: "resolution-mode", raw: '"resolution-mode"' },
        value: { kind: "StringLiteral", value: "import" },
      },
    ],
  });
});

test("parses with attributes on export-from declarations", () => {
  expect(parseProgram('export { a } from "./m" with { type: "json" };').body[0]).toMatchObject({
    kind: "ExportNamedDeclaration",
    declaration: null,
    source: { kind: "StringLiteral", value: "./m", start: 18, end: 23 },
    attributes: [
      {
        kind: "ImportAttribute",
        key: { kind: "Identifier", name: "type", start: 31, end: 35 },
        value: { kind: "StringLiteral", value: "json", start: 37, end: 43 },
      },
    ],
  });
  expect(parseProgram('export * from "./m" with { type: "json" };').body[0]).toMatchObject({
    kind: "ExportAllDeclaration",
    source: { kind: "StringLiteral", value: "./m", start: 14, end: 19 },
    attributes: [{ key: { kind: "Identifier", name: "type" }, value: { value: "json" } }],
  });
});

test("omits import attributes without a with clause", () => {
  expect(parseProgram('import a from "m";').body[0]).not.toHaveProperty("attributes");
  expect(parseProgram('import "m";').body[0]).not.toHaveProperty("attributes");
  expect(parseProgram('export { a } from "m";').body[0]).not.toHaveProperty("attributes");
  expect(parseProgram('export * from "m";').body[0]).not.toHaveProperty("attributes");
  expect(parseProgram("export { a };").body[0]).not.toHaveProperty("attributes");
});

test("parses import equals declarations", () => {
  expect(parseProgram('import x = require("m");').body[0]).toMatchObject({
    kind: "ImportEqualsDeclaration",
    name: { kind: "Identifier", name: "x", start: 7, end: 8 },
    moduleReference: {
      kind: "CallExpression",
      callee: { kind: "Identifier", name: "require", start: 11, end: 18 },
      arguments: [{ kind: "StringLiteral", value: "m", raw: '"m"', start: 19, end: 22 }],
      start: 11,
      end: 23,
    },
    start: 0,
    end: 24,
  });
});

test("parses namespace and module declarations", () => {
  expect(parseProgram("namespace A {}")).toEqual({
    kind: "Program",
    body: [{ kind: "NamespaceDeclaration", name: "A", body: [], start: 0, end: 14 }],
    source: "namespace A {}",
    start: 0,
    end: 14,
  });
  expect(parseProgram("namespace A.B { const x = 1; }").body[0]).toMatchObject({
    kind: "NamespaceDeclaration",
    name: "A.B",
    body: [
      {
        kind: "VariableStatement",
        declarationKind: "const",
        declarations: [
          {
            kind: "VariableDeclarator",
            name: { kind: "Identifier", name: "x", start: 22, end: 23 },
            initializer: { kind: "NumberLiteral", value: 1, raw: "1", start: 26, end: 27 },
          },
        ],
      },
    ],
    start: 0,
    end: 30,
  });
  expect(parseProgram("module M { }").body[0]).toMatchObject({
    kind: "NamespaceDeclaration",
    name: "M",
    body: [],
    start: 0,
    end: 12,
  });
  expect(parseProgram('module "str" { }').body[0]).toMatchObject({
    kind: "NamespaceDeclaration",
    name: "str",
    body: [],
    start: 0,
    end: 16,
  });
});

test("keeps module and import usable as identifiers and expressions", () => {
  expect(parseProgram("module.exports = 1;").body[0]).toEqual({
    kind: "ExpressionStatement",
    expression: {
      kind: "AssignmentExpression",
      operator: "=",
      left: {
        kind: "MemberExpression",
        object: { kind: "Identifier", name: "module", start: 0, end: 6 },
        property: { kind: "Identifier", name: "exports", start: 7, end: 14 },
        computed: false,
        optional: false,
        start: 0,
        end: 14,
      },
      right: { kind: "NumberLiteral", value: 1, raw: "1", start: 17, end: 18 },
      start: 0,
      end: 18,
    },
    start: 0,
    end: 19,
  });
  expect(parseProgram('import("m");').body[0]).toEqual({
    kind: "ExpressionStatement",
    expression: {
      kind: "ImportExpression",
      source: { kind: "StringLiteral", value: "m", raw: '"m"', start: 7, end: 10 },
      start: 0,
      end: 11,
    },
    start: 0,
    end: 12,
  });
  expect(parseProgram("const module = 1;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarationKind: "const",
    declarations: [
      { kind: "VariableDeclarator", name: { kind: "Identifier", name: "module", start: 6, end: 12 } },
    ],
  });
});

test("throws ParseError for malformed import and namespace declarations", () => {
  const emptyNamed = captureProgramParseError('import {} from "m";');
  expect(emptyNamed).toBeInstanceOf(ParseError);
  expect(errorPosition(emptyNamed)).toEqual({ offset: 8, line: 1, column: 9 });
  expect(emptyNamed.message).toBe("named imports may not be empty");

  const missingBinding = captureProgramParseError('import from "m";');
  expect(missingBinding).toBeInstanceOf(ParseError);
  expect(errorPosition(missingBinding)).toEqual({ offset: 7, line: 1, column: 8 });
  expect(missingBinding.message).toBe('unexpected token "from"');

  const nonStringSource = captureProgramParseError("import a from b;");
  expect(nonStringSource).toBeInstanceOf(ParseError);
  expect(errorPosition(nonStringSource)).toEqual({ offset: 14, line: 1, column: 15 });
  expect(nonStringSource.message).toBe("expected string literal");

  const unclosedNamespace = captureProgramParseError("namespace A {");
  expect(unclosedNamespace).toBeInstanceOf(ParseError);
  expect(errorPosition(unclosedNamespace)).toEqual({ offset: 13, line: 1, column: 14 });
  expect(unclosedNamespace.message).toBe('expected "}"');
});

test("parses named export specifiers", () => {
  expect(parseProgram("export {a, b as c};").body[0]).toEqual({
    kind: "ExportNamedDeclaration",
    declaration: null,
    specifiers: [
      {
        kind: "ExportSpecifier",
        local: { kind: "Identifier", name: "a", start: 8, end: 9 },
        exported: null,
        typeOnly: false,
        start: 8,
        end: 9,
      },
      {
        kind: "ExportSpecifier",
        local: { kind: "Identifier", name: "b", start: 11, end: 12 },
        exported: { kind: "Identifier", name: "c", start: 16, end: 17 },
        typeOnly: false,
        start: 11,
        end: 17,
      },
    ],
    source: null,
    exportKind: "value",
    start: 0,
    end: 19,
  });
  expect(parseProgram('export {"str" as x};').body[0]).toEqual({
    kind: "ExportNamedDeclaration",
    declaration: null,
    specifiers: [
      {
        kind: "ExportSpecifier",
        local: { kind: "StringLiteral", value: "str", raw: '"str"', start: 8, end: 13 },
        exported: { kind: "Identifier", name: "x", start: 17, end: 18 },
        typeOnly: false,
        start: 8,
        end: 18,
      },
    ],
    source: null,
    exportKind: "value",
    start: 0,
    end: 20,
  });
  expect(parseProgram('export {a} from "m";').body[0]).toEqual({
    kind: "ExportNamedDeclaration",
    declaration: null,
    specifiers: [
      {
        kind: "ExportSpecifier",
        local: { kind: "Identifier", name: "a", start: 8, end: 9 },
        exported: null,
        typeOnly: false,
        start: 8,
        end: 9,
      },
    ],
    source: { kind: "StringLiteral", value: "m", raw: '"m"', start: 16, end: 19 },
    exportKind: "value",
    start: 0,
    end: 20,
  });
  expect(parseProgram("export type {a};").body[0]).toEqual({
    kind: "ExportNamedDeclaration",
    declaration: null,
    specifiers: [
      {
        kind: "ExportSpecifier",
        local: { kind: "Identifier", name: "a", start: 13, end: 14 },
        exported: null,
        typeOnly: false,
        start: 13,
        end: 14,
      },
    ],
    source: null,
    exportKind: "type",
    start: 0,
    end: 16,
  });
  expect(parseProgram('export type {a} from "m";').body[0]).toEqual({
    kind: "ExportNamedDeclaration",
    declaration: null,
    specifiers: [
      {
        kind: "ExportSpecifier",
        local: { kind: "Identifier", name: "a", start: 13, end: 14 },
        exported: null,
        typeOnly: false,
        start: 13,
        end: 14,
      },
    ],
    source: { kind: "StringLiteral", value: "m", raw: '"m"', start: 21, end: 24 },
    exportKind: "type",
    start: 0,
    end: 25,
  });
  expect(parseProgram("export {a, b as c, type d,};").body[0]).toMatchObject({
    kind: "ExportNamedDeclaration",
    specifiers: [
      { kind: "ExportSpecifier", local: { name: "a" }, exported: null, typeOnly: false },
      { kind: "ExportSpecifier", local: { name: "b" }, exported: { name: "c" }, typeOnly: false },
      { kind: "ExportSpecifier", local: { name: "d" }, exported: null, typeOnly: true },
    ],
    source: null,
    exportKind: "value",
    start: 0,
    end: 28,
  });
});

test("parses export all declarations", () => {
  expect(parseProgram('export * from "m";').body[0]).toEqual({
    kind: "ExportAllDeclaration",
    source: { kind: "StringLiteral", value: "m", raw: '"m"', start: 14, end: 17 },
    exported: null,
    exportKind: "value",
    start: 0,
    end: 18,
  });
  expect(parseProgram('export * as ns from "m";').body[0]).toEqual({
    kind: "ExportAllDeclaration",
    source: { kind: "StringLiteral", value: "m", raw: '"m"', start: 20, end: 23 },
    exported: { kind: "Identifier", name: "ns", start: 12, end: 14 },
    exportKind: "value",
    start: 0,
    end: 24,
  });
  expect(parseProgram('export type * from "m";').body[0]).toMatchObject({
    kind: "ExportAllDeclaration",
    source: { kind: "StringLiteral", value: "m", start: 19, end: 22 },
    exported: null,
    exportKind: "type",
    start: 0,
    end: 23,
  });
});

test("parses export default declarations", () => {
  expect(parseProgram("export default 1;").body[0]).toEqual({
    kind: "ExportDefaultDeclaration",
    declaration: { kind: "NumberLiteral", value: 1, raw: "1", start: 15, end: 16 },
    start: 0,
    end: 17,
  });
  expect(parseProgram("export default function () {}").body[0]).toEqual({
    kind: "ExportDefaultDeclaration",
    declaration: {
      kind: "FunctionDeclaration",
      name: null,
      typeParameters: null,
      parameters: [],
      returnType: null,
      body: { kind: "BlockStatement", body: [], start: 27, end: 29 },
      start: 15,
      end: 29,
    },
    start: 0,
    end: 29,
  });
  expect(parseProgram("export default function f() {}").body[0]).toMatchObject({
    kind: "ExportDefaultDeclaration",
    declaration: {
      kind: "FunctionDeclaration",
      name: { kind: "Identifier", name: "f", start: 24, end: 25 },
      start: 15,
      end: 30,
    },
    start: 0,
    end: 30,
  });
  expect(parseProgram("export default class {}").body[0]).toEqual({
    kind: "ExportDefaultDeclaration",
    declaration: {
      kind: "ClassDeclaration",
      name: null,
      typeParameters: null,
      extends: null,
      implements: [],
      members: [],
      start: 15,
      end: 23,
    },
    start: 0,
    end: 23,
  });
  expect(parseProgram("export default class C {}").body[0]).toMatchObject({
    kind: "ExportDefaultDeclaration",
    declaration: {
      kind: "ClassDeclaration",
      name: { kind: "Identifier", name: "C", start: 21, end: 22 },
      start: 15,
      end: 25,
    },
    start: 0,
    end: 25,
  });
  expect(parseProgram("export default async function f() {}").body[0]).toMatchObject({
    kind: "ExportDefaultDeclaration",
    declaration: {
      kind: "FunctionDeclaration",
      name: { kind: "Identifier", name: "f", start: 30, end: 31 },
      async: true,
      start: 15,
      end: 36,
    },
    start: 0,
    end: 36,
  });
});

test("parses export declarations with full spans for export const", () => {
  expect(parseProgram("export const x = 1;")).toEqual({
    kind: "Program",
    body: [
      {
        kind: "ExportNamedDeclaration",
        declaration: {
          kind: "VariableStatement",
          declarationKind: "const",
          declarations: [
            {
              kind: "VariableDeclarator",
              name: { kind: "Identifier", name: "x", start: 13, end: 14 },
              type: null,
              initializer: { kind: "NumberLiteral", value: 1, raw: "1", start: 17, end: 18 },
              start: 13,
              end: 18,
            },
          ],
          start: 7,
          end: 19,
        },
        specifiers: [],
        source: null,
        exportKind: "value",
        start: 0,
        end: 19,
      },
    ],
    source: "export const x = 1;",
    start: 0,
    end: 19,
  });
  expect(parseProgram("export function f() {}").body[0]).toMatchObject({
    kind: "ExportNamedDeclaration",
    declaration: {
      kind: "FunctionDeclaration",
      name: { kind: "Identifier", name: "f", start: 16, end: 17 },
    },
    exportKind: "value",
    start: 0,
    end: 22,
  });
  expect(parseProgram("export class A {}").body[0]).toMatchObject({
    kind: "ExportNamedDeclaration",
    declaration: {
      kind: "ClassDeclaration",
      name: { kind: "Identifier", name: "A", start: 13, end: 14 },
    },
    start: 0,
    end: 17,
  });
  expect(parseProgram("export abstract class A {}").body[0]).toMatchObject({
    kind: "ExportNamedDeclaration",
    declaration: {
      kind: "ClassDeclaration",
      abstract: true,
      name: { kind: "Identifier", name: "A" },
    },
    start: 0,
    end: 26,
  });
  expect(parseProgram("export interface I {}").body[0]).toMatchObject({
    kind: "ExportNamedDeclaration",
    declaration: { kind: "InterfaceDeclaration", name: { kind: "Identifier", name: "I" } },
    start: 0,
    end: 21,
  });
  expect(parseProgram("export type T = A;").body[0]).toMatchObject({
    kind: "ExportNamedDeclaration",
    declaration: {
      kind: "TypeAliasDeclaration",
      name: { kind: "Identifier", name: "T" },
      type: { kind: "TypeReference", name: "A" },
    },
    exportKind: "value",
    start: 0,
    end: 18,
  });
  expect(parseProgram("export enum E {}").body[0]).toMatchObject({
    kind: "ExportNamedDeclaration",
    declaration: { kind: "EnumDeclaration", name: { kind: "Identifier", name: "E" } },
    start: 0,
    end: 16,
  });
  expect(parseProgram("export namespace N {}").body[0]).toMatchObject({
    kind: "ExportNamedDeclaration",
    declaration: { kind: "NamespaceDeclaration", name: "N", body: [] },
    start: 0,
    end: 21,
  });
  expect(parseProgram("export declare function f(): void;").body[0]).toMatchObject({
    kind: "ExportNamedDeclaration",
    declaration: {
      kind: "FunctionDeclaration",
      name: { kind: "Identifier", name: "f" },
      returnType: { kind: "KeywordType", name: "void" },
      declare: true,
    },
    start: 0,
    end: 34,
  });
});

test("parses declare declarations", () => {
  expect(parseProgram("declare const x: T;").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarationKind: "const",
    declare: true,
    declarations: [
      {
        kind: "VariableDeclarator",
        name: { kind: "Identifier", name: "x" },
        type: { kind: "TypeReference", name: "T" },
      },
    ],
    start: 8,
    end: 19,
  });
  expect(parseProgram("declare function f(): void;").body[0]).toMatchObject({
    kind: "FunctionDeclaration",
    name: { kind: "Identifier", name: "f" },
    declare: true,
    start: 8,
    end: 27,
  });
  expect(parseProgram("declare class A {}").body[0]).toMatchObject({
    kind: "ClassDeclaration",
    name: { kind: "Identifier", name: "A" },
    declare: true,
    start: 8,
    end: 18,
  });
  expect(parseProgram("declare interface I {}").body[0]).toMatchObject({
    kind: "InterfaceDeclaration",
    name: { kind: "Identifier", name: "I" },
    declare: true,
    start: 8,
    end: 22,
  });
  expect(parseProgram("declare type T = A;").body[0]).toMatchObject({
    kind: "TypeAliasDeclaration",
    name: { kind: "Identifier", name: "T" },
    declare: true,
  });
  expect(parseProgram("declare enum E {}").body[0]).toMatchObject({
    kind: "EnumDeclaration",
    name: { kind: "Identifier", name: "E" },
    declare: true,
  });
  expect(parseProgram("declare namespace N {}").body[0]).toMatchObject({
    kind: "NamespaceDeclaration",
    name: "N",
    declare: true,
  });
});

test("parses class decorators", () => {
  expect(parseProgram("@dec class A {}").body[0]).toEqual({
    kind: "ClassDeclaration",
    name: { kind: "Identifier", name: "A", start: 11, end: 12 },
    typeParameters: null,
    extends: null,
    implements: [],
    members: [],
    start: 0,
    end: 15,
    decorators: [{ kind: "Identifier", name: "dec", start: 1, end: 4 }],
  });
  expect(parseProgram("@dec() class A {}").body[0]).toMatchObject({
    kind: "ClassDeclaration",
    decorators: [
      {
        kind: "CallExpression",
        callee: { kind: "Identifier", name: "dec", start: 1, end: 4 },
        arguments: [],
        start: 1,
        end: 6,
      },
    ],
    start: 0,
    end: 17,
  });
  expect(parseProgram("@ns.dec class A {}").body[0]).toMatchObject({
    kind: "ClassDeclaration",
    decorators: [
      {
        kind: "MemberExpression",
        object: { kind: "Identifier", name: "ns", start: 1, end: 3 },
        property: { kind: "Identifier", name: "dec", start: 4, end: 7 },
        computed: false,
        start: 1,
        end: 7,
      },
    ],
    start: 0,
    end: 18,
  });
  expect(parseProgram("@dec\n@other\nclass A {}").body[0]).toEqual({
    kind: "ClassDeclaration",
    name: { kind: "Identifier", name: "A", start: 18, end: 19 },
    typeParameters: null,
    extends: null,
    implements: [],
    members: [],
    start: 0,
    end: 22,
    decorators: [
      { kind: "Identifier", name: "dec", start: 1, end: 4 },
      { kind: "Identifier", name: "other", start: 6, end: 11 },
    ],
  });
  expect(parseProgram("@dec export class A {}").body[0]).toEqual({
    kind: "ExportNamedDeclaration",
    declaration: {
      kind: "ClassDeclaration",
      name: { kind: "Identifier", name: "A", start: 18, end: 19 },
      typeParameters: null,
      extends: null,
      implements: [],
      members: [],
      start: 0,
      end: 22,
      decorators: [{ kind: "Identifier", name: "dec", start: 1, end: 4 }],
    },
    specifiers: [],
    source: null,
    exportKind: "value",
    start: 0,
    end: 22,
  });
});

test("parses class member and parameter decorators", () => {
  expect(parseProgram("class A { @d x: number; }").body[0]).toMatchObject({
    kind: "ClassDeclaration",
    members: [
      {
        kind: "PropertyDeclaration",
        name: { kind: "Identifier", name: "x", start: 13, end: 14 },
        type: { kind: "KeywordType", name: "number", start: 16, end: 22 },
        start: 10,
        end: 22,
        decorators: [{ kind: "Identifier", name: "d", start: 11, end: 12 }],
      },
    ],
  });
  expect(parseProgram("class A { @d m() {} }").body[0]).toMatchObject({
    kind: "ClassDeclaration",
    members: [
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "m", start: 13, end: 14 },
        parameters: [],
        body: { kind: "BlockStatement", start: 17, end: 19 },
        start: 10,
        end: 19,
        decorators: [{ kind: "Identifier", name: "d", start: 11, end: 12 }],
      },
    ],
  });
  expect(parseProgram("class A { @d get x() { return 1; } }").body[0]).toMatchObject({
    kind: "ClassDeclaration",
    members: [
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "x", start: 17, end: 18 },
        accessor: "get",
        start: 10,
        end: 34,
        decorators: [{ kind: "Identifier", name: "d", start: 11, end: 12 }],
      },
    ],
  });
  expect(parseProgram("class A { @d [k: string]: number; }").body[0]).toMatchObject({
    kind: "ClassDeclaration",
    members: [
      {
        kind: "IndexSignature",
        keyName: { kind: "Identifier", name: "k", start: 14, end: 15 },
        keyType: { kind: "KeywordType", name: "string" },
        type: { kind: "KeywordType", name: "number" },
        start: 10,
        end: 32,
        decorators: [{ kind: "Identifier", name: "d", start: 11, end: 12 }],
      },
    ],
  });
  expect(parseProgram("class A { constructor(@inject p: T) {} }").body[0]).toMatchObject({
    kind: "ClassDeclaration",
    members: [
      {
        kind: "ConstructorDeclaration",
        start: 10,
        end: 38,
        parameters: [
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "p", start: 30, end: 31 },
            type: { kind: "TypeReference", name: "T", start: 33, end: 34 },
            start: 22,
            end: 34,
            decorators: [{ kind: "Identifier", name: "inject", start: 23, end: 29 }],
          },
        ],
      },
    ],
  });
  expect(parseProgram("class A { m(@d p: T) {} }").body[0]).toMatchObject({
    kind: "ClassDeclaration",
    members: [
      {
        kind: "MethodDeclaration",
        name: { kind: "Identifier", name: "m", start: 10, end: 11 },
        parameters: [
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "p", start: 15, end: 16 },
            start: 12,
            end: 19,
            decorators: [{ kind: "Identifier", name: "d", start: 13, end: 14 }],
          },
        ],
      },
    ],
  });
  expect(parseProgram("const c = class { @d m() {} };").body[0]).toMatchObject({
    kind: "VariableStatement",
    declarations: [
      {
        kind: "VariableDeclarator",
        name: { kind: "Identifier", name: "c", start: 6, end: 7 },
        initializer: {
          kind: "ClassExpression",
          name: null,
          start: 10,
          end: 29,
          members: [
            {
              kind: "MethodDeclaration",
              name: { kind: "Identifier", name: "m", start: 21, end: 22 },
              start: 18,
              end: 27,
              decorators: [{ kind: "Identifier", name: "d", start: 19, end: 20 }],
            },
          ],
        },
      },
    ],
  });
});

test("reports export and decorator error positions", () => {
  const defaultEmpty = captureProgramParseError("export default;");
  expect(defaultEmpty).toBeInstanceOf(ParseError);
  expect(errorPosition(defaultEmpty)).toEqual({ offset: 14, line: 1, column: 15 });

  const unclosedNamed = captureProgramParseError("export {a");
  expect(unclosedNamed).toBeInstanceOf(ParseError);
  expect(errorPosition(unclosedNamed)).toEqual({ offset: 9, line: 1, column: 10 });
  expect(unclosedNamed.message).toBe('expected "}"');

  const missingSource = captureProgramParseError("export * from");
  expect(missingSource).toBeInstanceOf(ParseError);
  expect(errorPosition(missingSource)).toEqual({ offset: 13, line: 1, column: 14 });
  expect(missingSource.message).toBe("expected string literal");

  const bareDecorator = captureProgramParseError("@");
  expect(bareDecorator).toBeInstanceOf(ParseError);
  expect(errorPosition(bareDecorator)).toEqual({ offset: 1, line: 1, column: 2 });

  const decoratorNotClass = captureProgramParseError("@dec const x = 1;");
  expect(decoratorNotClass).toBeInstanceOf(ParseError);
  expect(errorPosition(decoratorNotClass)).toEqual({ offset: 5, line: 1, column: 6 });

  const declareEof = captureProgramParseError("declare");
  expect(declareEof).toBeInstanceOf(ParseError);
  expect(errorPosition(declareEof)).toEqual({ offset: 7, line: 1, column: 8 });
  expect(declareEof.message).toBe("unexpected end of input");
});

test("parses every TypeScript file in src without throwing", () => {
  const dir = new URL(".", import.meta.url);
  const files = readdirSync(dir, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string")
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
  expect(files).toContain("lexer.ts");
  expect(files).toContain("parser.ts");
  expect(files).toContain("utility.ts");
  for (const file of files) {
    const source = readFileSync(new URL(file, dir), "utf8");
    let program: Program;
    try {
      program = new Parser(source).parseProgram();
    } catch (error) {
      if (error instanceof ParseError) {
        throw new Error(
          `failed to parse ${file} at ${error.line}:${error.column} (${error.message})\n${source
            .split("\n")
            .slice(Math.max(0, error.line - 2), error.line + 1)
            .join("\n")}`,
        );
      }
      throw error;
    }
    const last = program.body.at(-1);
    if (last !== undefined) {
      expect(last.end).toBeLessThanOrEqual(source.length);
    }
    expect(program.end).toBe(source.length);
    expect(program.source).toBe(source);
  }
});

test("parses a broad fixture corpus in order", () => {
  const source = [
    "import { A, type B } from './a';",
    "export type Maybe<T extends object = {}> = T | null;",
    "interface Box<T> extends Iterable<T> {",
    "  readonly value: T;",
    "  [key: string]: unknown;",
    "  map<U>(fn: (value: T) => U, ...rest: never[]): Box<U>;",
    "}",
    "function overloaded(x: string): string;",
    "function overloaded(x: number): number;",
    "function overloaded(x: string | number): string | number {",
    "  if (typeof x === 'string') return x;",
    "  for (let i = 0; i < 3; i += 1) { x = x + i; }",
    "  return x;",
    "}",
    "@sealed",
    "export abstract class Widget<T> extends Base<T> implements Box<T> {",
    "  static count = 0;",
    "  constructor(private readonly source: string, protected value: T) { super(); }",
    "  abstract render(): T;",
    "  get current(): T { return this.value; }",
    "  [Symbol.iterator](): Iterator<T> { yield this.value; }",
    "  async run(): Promise<void> { await Promise.resolve(); }",
    "}",
    "enum Color { Red, Green = 'g' }",
    "namespace NS { export const n = 1; }",
    "const re = /a+b/gi;",
    "let tuple: [first: string, second?: number, ...rest: boolean[]] = ['a'];",
    "const cond = tuple satisfies unknown;",
    "const cast = cond as const;",
    "const inline = (x: number) => x ** 2",
    "const text = `value ${inline(2)} end`",
    "label: while (true) { break label; }",
    "do { NS.n; } while (false);",
    "switch (re.source) { case 'x': break; default: break; }",
    "try { throw new Error('x'); } catch (e: unknown) { console.log(e); } finally { console.log('done'); }",
    "with1: { break with1; }",
    "export default class extends Widget<string> { render(): string { return 'r'; } }",
  ].join("\n");
  const program = parseProgram(source);
  expect(program.end).toBe(source.length);
  expect(program.body.map((statement) => statement.kind)).toEqual([
    "ImportDeclaration",
    "ExportNamedDeclaration",
    "InterfaceDeclaration",
    "FunctionDeclaration",
    "FunctionDeclaration",
    "FunctionDeclaration",
    "ExportNamedDeclaration",
    "EnumDeclaration",
    "NamespaceDeclaration",
    "VariableStatement",
    "VariableStatement",
    "VariableStatement",
    "VariableStatement",
    "VariableStatement",
    "VariableStatement",
    "LabeledStatement",
    "DoWhileStatement",
    "SwitchStatement",
    "TryStatement",
    "LabeledStatement",
    "ExportDefaultDeclaration",
  ]);
  const widget = program.body[6];
  expect(widget).toMatchObject({
    kind: "ExportNamedDeclaration",
    declaration: {
      kind: "ClassDeclaration",
      abstract: true,
      name: { kind: "Identifier", name: "Widget" },
      decorators: [{ kind: "Identifier", name: "sealed" }],
      members: [
        { kind: "PropertyDeclaration", static: true, name: { kind: "Identifier", name: "count" } },
        {
          kind: "ConstructorDeclaration",
          parameters: [
            {
              kind: "Parameter",
              name: { kind: "Identifier", name: "source" },
              accessibility: "private",
              readonly: true,
            },
            {
              kind: "Parameter",
              name: { kind: "Identifier", name: "value" },
              accessibility: "protected",
            },
          ],
        },
        {
          kind: "MethodDeclaration",
          abstract: true,
          name: { kind: "Identifier", name: "render" },
        },
        {
          kind: "MethodDeclaration",
          accessor: "get",
          name: { kind: "Identifier", name: "current" },
        },
        {
          kind: "MethodDeclaration",
          name: { kind: "ComputedPropertyName" },
        },
        { kind: "MethodDeclaration", async: true, name: { kind: "Identifier", name: "run" } },
      ],
    },
  });
  const overloaded = program.body[3];
  expect(overloaded).toMatchObject({
    kind: "FunctionDeclaration",
    body: null,
    name: { kind: "Identifier", name: "overloaded" },
  });
  const implementation = program.body[5];
  expect(implementation).toMatchObject({ kind: "FunctionDeclaration" });
  if (
    implementation !== undefined &&
    implementation.kind === "FunctionDeclaration" &&
    implementation.body !== null
  ) {
    expect(implementation.body.body.map((statement) => statement.kind)).toEqual([
      "IfStatement",
      "ForStatement",
      "ReturnStatement",
    ]);
  }
  const templateStatement = program.body[14];
  expect(templateStatement).toMatchObject({
    kind: "VariableStatement",
    declarations: [{ initializer: { kind: "TemplateLiteral", quasis: ["value ", " end"] } }],
  });
  expect(program.body[9]).toMatchObject({
    kind: "VariableStatement",
    declarations: [{ initializer: { kind: "RegexLiteral", pattern: "a+b", flags: "gi" } }],
  });
  expect(program.body[11]).toMatchObject({
    kind: "VariableStatement",
    declarations: [{ initializer: { kind: "AsExpression", operator: "satisfies" } }],
  });
  expect(program.body[12]).toMatchObject({
    kind: "VariableStatement",
    declarations: [{ initializer: { kind: "AsExpression", operator: "as" } }],
  });
  expect(program.body[20]).toMatchObject({
    kind: "ExportDefaultDeclaration",
    declaration: {
      kind: "ClassDeclaration",
      name: null,
      extends: {
        kind: "ExpressionWithTypeArguments",
        typeArguments: [{ kind: "KeywordType", name: "string" }],
      },
    },
  });
});

test("parses a fixture of modern declaration forms", () => {
  const source = [
    "import { A } from './a';",
    "declare global { interface Window { x: number } }",
    "export = api;",
    "class Widget<T> extends Base<T> implements Box<T> {",
    "  static { Widget.count = 0 }",
    "  constructor(private readonly source: string, public value?: T, ...rest: unknown[]) { super() }",
    "}",
    "function withThis(this: Widget<string>, x: number): x is number { return true }",
    "const meta = import.meta.url;",
    "type Keys = | 'a' | 'b';",
    "let tuple: [first: string, second?: number, ...rest: boolean[]] = ['a'];",
  ].join("\n");
  const program = parseProgram(source);
  expect(program.end).toBe(source.length);
  expect(program.body.map((statement) => statement.kind)).toEqual([
    "ImportDeclaration",
    "NamespaceDeclaration",
    "ExportAssignment",
    "ClassDeclaration",
    "FunctionDeclaration",
    "VariableStatement",
    "TypeAliasDeclaration",
    "VariableStatement",
  ]);
  expect(program.body[1]).toMatchObject({
    kind: "NamespaceDeclaration",
    name: "global",
    declare: true,
    body: [{ kind: "InterfaceDeclaration", name: { kind: "Identifier", name: "Window" } }],
  });
  expect(program.body[2]).toMatchObject({
    kind: "ExportAssignment",
    expression: { kind: "Identifier", name: "api" },
  });
  expect(program.body[3]).toMatchObject({
    kind: "ClassDeclaration",
    name: { kind: "Identifier", name: "Widget" },
    extends: {
      kind: "ExpressionWithTypeArguments",
      expression: { kind: "Identifier", name: "Base" },
      typeArguments: [{ kind: "TypeReference", name: "T" }],
    },
    implements: [{ kind: "TypeReference", name: "Box" }],
    members: [
      { kind: "StaticBlock", body: { kind: "BlockStatement" } },
      {
        kind: "ConstructorDeclaration",
        parameters: [
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "source" },
            accessibility: "private",
            readonly: true,
          },
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "value" },
            accessibility: "public",
            optional: true,
          },
          {
            kind: "Parameter",
            name: { kind: "Identifier", name: "rest" },
            rest: true,
          },
        ],
      },
    ],
  });
  expect(program.body[4]).toMatchObject({
    kind: "FunctionDeclaration",
    parameters: [
      { kind: "Parameter", name: { kind: "Identifier", name: "this" } },
      { kind: "Parameter", name: { kind: "Identifier", name: "x" } },
    ],
    returnType: { kind: "TypePredicate", parameterName: "x" },
  });
  expect(program.body[5]).toMatchObject({
    kind: "VariableStatement",
    declarations: [
      {
        initializer: {
          kind: "MemberExpression",
          object: { kind: "MetaProperty", property: { kind: "Identifier", name: "meta" } },
          property: { kind: "Identifier", name: "url" },
        },
      },
    ],
  });
  expect(program.body[6]).toMatchObject({
    kind: "TypeAliasDeclaration",
    type: { kind: "UnionType" },
  });
  expect(program.body[7]).toMatchObject({
    kind: "VariableStatement",
    declarations: [
      {
        type: {
          kind: "TupleType",
          elements: [
            { kind: "TupleElement", name: { kind: "Identifier", name: "first" } },
            {
              kind: "TupleElement",
              name: { kind: "Identifier", name: "second" },
              optional: true,
            },
            { kind: "TupleElement", name: { kind: "Identifier", name: "rest" }, rest: true },
          ],
        },
      },
    ],
  });
});
