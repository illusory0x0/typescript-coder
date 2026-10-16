import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { LexError, Lexer, contextualKeywords, reservedKeywords, tokenize } from "./lexer";
import type { Token, TokenKind } from "./lexer";

function lexAll(source: string): Token[] {
  const lexer = new Lexer(source);
  const tokens: Token[] = [];
  for (;;) {
    const token = lexer.next();
    tokens.push(token);
    if (token.kind === "eof") {
      return tokens;
    }
  }
}

function captureLexError(run: () => unknown): LexError {
  try {
    run();
  } catch (error) {
    if (error instanceof LexError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected LexError to be thrown");
}

function identifiersIn(source: string): Token[] {
  return lexAll(source).filter((token) => token.kind === "identifier");
}

function punctuatorsIn(source: string): Token[] {
  return lexAll(source).filter((token) => token.kind === "punctuator");
}

test("scans identifiers with dollar, underscore, and unicode letters", () => {
  expect(identifiersIn("café").map((token) => token.value)).toEqual(["café"]);
  expect(identifiersIn("$value _temp digits1").map((token) => token.value)).toEqual([
    "$value",
    "_temp",
    "digits1",
  ]);
});

test("decodes unicode escapes inside identifiers", () => {
  expect(lexAll("\\u{41}bc")[0]).toEqual({
    kind: "identifier",
    text: "\\u{41}bc",
    value: "Abc",
    start: 0,
    end: 8,
    line: 1,
    column: 1,
  });
  expect(lexAll("\\u0041\\u{42}c")[0]?.value).toBe("ABc");
  expect(lexAll("a\\u0062")[0]?.value).toBe("ab");
  expect(lexAll("a\\u{62}")[0]?.value).toBe("ab");
});

test("classifies reserved keywords and keeps contextual keywords as identifiers", () => {
  expect(reservedKeywords.has("const")).toBe(true);
  expect(contextualKeywords.has("type")).toBe(true);
  expect(lexAll("const")[0]?.kind).toBe("keyword");
  expect(lexAll("const")[0]?.value).toBe("const");
  expect(lexAll("type")[0]?.kind).toBe("identifier");
  expect(lexAll("type")[0]?.value).toBe("type");
});

test("matches punctuators longest first", () => {
  expect(punctuatorsIn("? ?. ?? ??= >>>=").map((token) => token.text)).toEqual([
    "?",
    "?.",
    "??",
    "??=",
    ">>>=",
  ]);
  expect(punctuatorsIn("> >> >>> >>= >>>=").map((token) => token.text)).toEqual([
    ">",
    ">>",
    ">>>",
    ">>=",
    ">>>=",
  ]);
});

test("scans whitespace, line comments, and block comments as trivia", () => {
  const tokens = lexAll(" \t\r\n// hi\n/* x */");
  expect(tokens.map((token) => token.kind)).toEqual([
    "whitespace",
    "line-comment",
    "whitespace",
    "block-comment",
    "eof",
  ]);
  expect(tokens.map((token) => token.text)).toEqual([" \t\r\n", "// hi", "\n", "/* x */", ""]);
  expect(tokens[1]).toEqual({
    kind: "line-comment",
    text: "// hi",
    value: "// hi",
    start: 4,
    end: 9,
    line: 2,
    column: 1,
  });
  expect(tokens[4]).toEqual({
    kind: "eof",
    text: "",
    value: "",
    start: 17,
    end: 17,
    line: 3,
    column: 8,
  });
});

test("tracks lines across a block comment", () => {
  const tokens = lexAll("/*\n */");
  expect(tokens[0]).toEqual({
    kind: "block-comment",
    text: "/*\n */",
    value: "/*\n */",
    start: 0,
    end: 6,
    line: 1,
    column: 1,
  });
  expect(tokens[1]).toEqual({
    kind: "eof",
    text: "",
    value: "",
    start: 6,
    end: 6,
    line: 2,
    column: 4,
  });
});

test("keeps returning eof and peeks without consuming", () => {
  const empty = new Lexer("");
  const first = empty.next();
  const second = empty.next();
  expect(first.kind).toBe("eof");
  expect(second).toEqual(first);
  expect(first.start).toBe(0);
  expect(first.end).toBe(0);
  expect(first.line).toBe(1);
  expect(first.column).toBe(1);

  const lexer = new Lexer("const x");
  const peeked = lexer.peek();
  expect(peeked).toEqual(lexer.next());
  expect(lexer.peek().text).toBe(" ");
});

test("throws LexError for an unterminated block comment", () => {
  const error = captureLexError(() => new Lexer("/* x").next());
  expect(error).toBeInstanceOf(LexError);
  expect(error.message).toBe("unterminated block comment");
  expect(error.offset).toBe(0);
  expect(error.line).toBe(1);
  expect(error.column).toBe(1);

  const later = captureLexError(() => lexAll("a\n/* x"));
  expect(later.offset).toBe(2);
  expect(later.line).toBe(2);
  expect(later.column).toBe(1);
});

test("throws LexError for a lone backslash", () => {
  const error = captureLexError(() => new Lexer("\\").next());
  expect(error).toBeInstanceOf(LexError);
  expect(error.message).toContain("unexpected character");
  expect(error.offset).toBe(0);
  expect(error.line).toBe(1);
  expect(error.column).toBe(1);
});

test("throws LexError for an invalid identifier escape", () => {
  const error = captureLexError(() => new Lexer("a\\u{zz}").next());
  expect(error).toBeInstanceOf(LexError);
});

test("scans decimal, hexadecimal, octal, binary, and bigint literals", () => {
  const cases: Array<[string, TokenKind, string, string]> = [
    ["0", "number", "0", "0"],
    ["42", "number", "42", "42"],
    ["3.14", "number", "3.14", "3.14"],
    ["1e10", "number", "1e10", "1e10"],
    ["1E+5", "number", "1E+5", "1E+5"],
    ["1.5e-3", "number", "1.5e-3", "1.5e-3"],
    ["0xff", "number", "0xff", "0xff"],
    ["0XAB", "number", "0XAB", "0XAB"],
    ["0o17", "number", "0o17", "0o17"],
    ["0b1010", "number", "0b1010", "0b1010"],
    ["1_000_000", "number", "1_000_000", "1000000"],
    ["0x1_2", "number", "0x1_2", "0x12"],
    ["1_0.2_5", "number", "1_0.2_5", "10.25"],
    ["1.2e1_0", "number", "1.2e1_0", "1.2e10"],
    ["9007199254740993n", "bigint", "9007199254740993n", "9007199254740993n"],
    ["0xffn", "bigint", "0xffn", "0xffn"],
  ];
  for (const [source, kind, text, value] of cases) {
    const tokens = lexAll(source);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.kind).toBe(kind);
    expect(tokens[0]?.text).toBe(text);
    expect(tokens[0]?.value).toBe(value);
    expect(tokens[0]?.value).not.toContain("_");
    expect(tokens[0]?.start).toBe(0);
    expect(tokens[0]?.end).toBe(text.length);
    expect(tokens[1]?.kind).toBe("eof");
  }
});

test("throws LexError for malformed numbers", () => {
  for (const source of ["0x", "1__2", "1_", "1_.5", "08", "3in", "0b2", "1e+", "1e", "0x1g", "1.2f", "1n2"]) {
    const error = captureLexError(() => lexAll(source));
    expect(error).toBeInstanceOf(LexError);
    expect(error.message).toBe("invalid number");
  }
  expect(lexAll("_1")[0]?.kind).toBe("identifier");
});

test("stops a number before a following dot and resumes lexing", () => {
  const tokens = lexAll("1.2.3");
  expect(tokens.map((token) => token.kind)).toEqual(["number", "punctuator", "number", "eof"]);
  expect(tokens.map((token) => token.text)).toEqual(["1.2", ".", "3", ""]);
});

test("scans string literals and decodes escapes", () => {
  const cases: Array<[string, string]> = [
    ['"hello"', "hello"],
    ["'a\\tb'", "a\tb"],
    ['"\\u0041\\u{1F600}"', "A\u{1F600}"],
    ['"line\\n"', "line\n"],
    ['"a\\"b"', 'a"b'],
    ["'it\\'s'", "it's"],
    ['"\\x41"', "A"],
    ['"\\0"', "\0"],
    ['"\\q"', "q"],
    ['"back\\\\slash"', "back\\slash"],
    ['"tick\\`"', "tick`"],
  ];
  for (const [source, value] of cases) {
    const tokens = lexAll(source);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.kind).toBe("string");
    expect(tokens[0]?.text).toBe(source);
    expect(tokens[0]?.value).toBe(value);
    expect(tokens[0]?.start).toBe(0);
    expect(tokens[0]?.end).toBe(source.length);
    expect(tokens[1]?.kind).toBe("eof");
  }
});

test("treats line continuations as empty string content and tracks lines", () => {
  const tokens = lexAll('"a\\\nb"');
  expect(tokens[0]?.kind).toBe("string");
  expect(tokens[0]?.text).toBe('"a\\\nb"');
  expect(tokens[0]?.value).toBe("ab");
  expect(tokens[0]?.start).toBe(0);
  expect(tokens[0]?.end).toBe(6);
  expect(tokens[0]?.line).toBe(1);
  expect(tokens[0]?.column).toBe(1);
  expect(tokens[1]).toEqual({ kind: "eof", text: "", value: "", start: 6, end: 6, line: 2, column: 3 });

  const crlf = lexAll('"a\\\r\nb"');
  expect(crlf[0]?.value).toBe("ab");
  expect(crlf[1]).toEqual({ kind: "eof", text: "", value: "", start: 7, end: 7, line: 2, column: 3 });
});

test("throws LexError for unterminated strings and raw newlines", () => {
  const unterminated = captureLexError(() => new Lexer('"unterminated').next());
  expect(unterminated).toBeInstanceOf(LexError);
  expect(unterminated.message).toBe("unterminated string");
  expect(unterminated.offset).toBe(0);
  expect(unterminated.line).toBe(1);
  expect(unterminated.column).toBe(1);

  const newline = captureLexError(() => lexAll("'a\nb'"));
  expect(newline).toBeInstanceOf(LexError);
  expect(newline.message).toBe("unterminated string");
  expect(newline.offset).toBe(0);
  expect(newline.line).toBe(1);
  expect(newline.column).toBe(1);

  const trailingBackslash = captureLexError(() => new Lexer('"abc\\').next());
  expect(trailingBackslash.message).toBe("unterminated string");
});

test("throws LexError for invalid string escapes", () => {
  expect(captureLexError(() => lexAll('"\\xZ"')).message).toBe("invalid escape sequence");
  expect(captureLexError(() => lexAll('"\\x4"')).message).toBe("invalid escape sequence");
  expect(captureLexError(() => lexAll('"\\u12"')).message).toBe("invalid escape sequence");
  expect(captureLexError(() => lexAll('"\\u{}"')).message).toBe("invalid escape sequence");
  expect(captureLexError(() => lexAll('"\\u{110000}"')).message).toBe("invalid escape sequence");
  expect(captureLexError(() => lexAll('"\\u{1234567}"')).message).toBe("invalid escape sequence");
});

test("tokenize rescans a regular expression at the start of input", () => {
  const tokens = tokenize("/a+b/gi");
  expect(tokens.map((token) => token.kind)).toEqual(["regex", "eof"]);
  expect(tokens[0]).toEqual({
    kind: "regex",
    text: "/a+b/gi",
    value: "/a+b/gi",
    start: 0,
    end: 7,
    line: 1,
    column: 1,
  });
});

test("tokenize keeps division between operands instead of scanning a regex", () => {
  const tokens = tokenize("x / y / z");
  expect(tokens.map((token) => token.kind)).toEqual([
    "identifier",
    "whitespace",
    "punctuator",
    "whitespace",
    "identifier",
    "whitespace",
    "punctuator",
    "whitespace",
    "identifier",
    "eof",
  ]);
  expect(tokens.filter((token) => token.kind === "punctuator").map((token) => token.text)).toEqual([
    "/",
    "/",
  ]);
});

test("tokenize rescans a regular expression after return", () => {
  const tokens = tokenize("return /ab/.test(s)");
  const regex = tokens.find((token) => token.kind === "regex");
  expect(regex).toEqual({
    kind: "regex",
    text: "/ab/",
    value: "/ab/",
    start: 7,
    end: 11,
    line: 1,
    column: 8,
  });
});

test("tokenize treats a slash after a closing paren as division", () => {
  const tokens = tokenize("(a)/b/");
  expect(tokens.map((token) => token.kind)).toEqual([
    "punctuator",
    "identifier",
    "punctuator",
    "punctuator",
    "identifier",
    "punctuator",
    "eof",
  ]);
  expect(tokens.map((token) => token.text)).toEqual(["(", "a", ")", "/", "b", "/", ""]);
});

test("tokenize scans a regular expression with a slash inside a character class", () => {
  const tokens = tokenize("/[/]/");
  expect(tokens.map((token) => token.kind)).toEqual(["regex", "eof"]);
  expect(tokens[0]?.text).toBe("/[/]/");
  expect(tokens[0]?.value).toBe("/[/]/");
});

test("tokenize rescans a /= punctuator as a regular expression body", () => {
  const tokens = tokenize("x = /=/");
  const regex = tokens.find((token) => token.kind === "regex");
  expect(regex?.text).toBe("/=/");
  expect(regex?.value).toBe("/=/");
  expect(regex?.start).toBe(4);
  expect(regex?.end).toBe(7);
});

test("rescanRegex rewinds to the punctuator and scans a regular expression", () => {
  const lexer = new Lexer("=/[a/]/g");
  expect(lexer.next().text).toBe("=");
  const slash = lexer.next();
  expect(slash).toEqual({
    kind: "punctuator",
    text: "/",
    value: "/",
    start: 1,
    end: 2,
    line: 1,
    column: 2,
  });
  const regex = lexer.rescanRegex();
  expect(regex).toEqual({
    kind: "regex",
    text: "/[a/]/g",
    value: "/[a/]/g",
    start: 1,
    end: 8,
    line: 1,
    column: 2,
  });
  expect(lexer.next().kind).toBe("eof");
});

test("rescanRegex throws without a preceding slash punctuator", () => {
  const fresh = new Lexer("a");
  expect(() => fresh.rescanRegex()).toThrow("rescanRegex requires a preceding / or /= punctuator");
  const lexer = new Lexer("+");
  lexer.next();
  expect(() => lexer.rescanRegex()).toThrow("rescanRegex requires a preceding / or /= punctuator");
});

test("tokenize throws LexError for unterminated regular expressions", () => {
  const unterminated = captureLexError(() => tokenize("/abc"));
  expect(unterminated).toBeInstanceOf(LexError);
  expect(unterminated.message).toBe("unterminated regular expression");
  expect(unterminated.offset).toBe(0);
  expect(unterminated.line).toBe(1);
  expect(unterminated.column).toBe(1);

  const newline = captureLexError(() => tokenize("x = /a\nb/"));
  expect(newline).toBeInstanceOf(LexError);
  expect(newline.message).toBe("unterminated regular expression");
  expect(newline.offset).toBe(4);
  expect(newline.line).toBe(1);
  expect(newline.column).toBe(5);
});

test("tokenize scans a no-substitution template literal", () => {
  const tokens = tokenize("`plain`");
  expect(tokens.map((token) => token.kind)).toEqual(["no-substitution-template", "eof"]);
  expect(tokens[0]).toEqual({
    kind: "no-substitution-template",
    text: "`plain`",
    value: "`plain`",
    start: 0,
    end: 7,
    line: 1,
    column: 1,
  });
});

test("tokenize splits a template with one substitution", () => {
  const tokens = tokenize("`a${x}b`");
  expect(tokens.map((token) => token.kind)).toEqual([
    "template-head",
    "identifier",
    "template-tail",
    "eof",
  ]);
  expect(tokens.map((token) => token.text)).toEqual(["`a${", "x", "}b`", ""]);
  expect(tokens[0]?.value).toBe("`a${");
  expect(tokens[2]).toEqual({
    kind: "template-tail",
    text: "}b`",
    value: "}b`",
    start: 5,
    end: 8,
    line: 1,
    column: 6,
  });
});

test("tokenize scans middles between multiple substitutions", () => {
  const tokens = tokenize("`a${x}b${y}c`");
  expect(tokens.map((token) => token.kind)).toEqual([
    "template-head",
    "identifier",
    "template-middle",
    "identifier",
    "template-tail",
    "eof",
  ]);
  expect(tokens.map((token) => token.text)).toEqual(["`a${", "x", "}b${", "y", "}c`", ""]);
});

test("tokenize scans nested templates inside substitutions", () => {
  const tokens = tokenize("`a${`b${c}d`}e`");
  expect(tokens.map((token) => token.kind)).toEqual([
    "template-head",
    "template-head",
    "identifier",
    "template-tail",
    "template-tail",
    "eof",
  ]);
  expect(tokens.map((token) => token.text)).toEqual(["`a${", "`b${", "c", "}d`", "}e`", ""]);
});

test("tokenize keeps an escaped dollar inside a no-substitution template", () => {
  const tokens = tokenize("`a\\${x}`");
  expect(tokens.map((token) => token.kind)).toEqual(["no-substitution-template", "eof"]);
  expect(tokens[0]?.text).toBe("`a\\${x}`");
  expect(tokens[0]?.value).toBe("`a\\${x}`");
});

test("tokenize keeps an escaped backtick inside a template", () => {
  const tokens = tokenize("`a\\`b`");
  expect(tokens.map((token) => token.kind)).toEqual(["no-substitution-template", "eof"]);
  expect(tokens[0]?.text).toBe("`a\\`b`");
});

test("tokenize tracks lines across a multiline template", () => {
  const tokens = tokenize("`a\nb`");
  expect(tokens.map((token) => token.kind)).toEqual(["no-substitution-template", "eof"]);
  expect(tokens[0]?.text).toBe("`a\nb`");
  expect(tokens[0]?.text).toContain("\n");
  expect(tokens[0]?.line).toBe(1);
  expect(tokens[0]?.column).toBe(1);
  expect(tokens[1]).toEqual({ kind: "eof", text: "", value: "", start: 5, end: 5, line: 2, column: 3 });
});

test("tokenize throws LexError for unterminated templates", () => {
  const unterminated = captureLexError(() => tokenize("`abc"));
  expect(unterminated).toBeInstanceOf(LexError);
  expect(unterminated.message).toBe("unterminated template literal");
  expect(unterminated.offset).toBe(0);
  expect(unterminated.line).toBe(1);
  expect(unterminated.column).toBe(1);

  const trailingBackslash = captureLexError(() => tokenize("`abc\\"));
  expect(trailingBackslash.message).toBe("unterminated template literal");

  const expression = captureLexError(() => tokenize("`a${b"));
  expect(expression).toBeInstanceOf(LexError);
  expect(expression.message).toBe("unterminated template literal");
  expect(expression.offset).toBe(5);
  expect(expression.line).toBe(1);
  expect(expression.column).toBe(6);

  const missingTail = captureLexError(() => tokenize("`a${b}c"));
  expect(missingTail.message).toBe("unterminated template literal");
  expect(missingTail.offset).toBe(5);
  expect(missingTail.line).toBe(1);
  expect(missingTail.column).toBe(6);
});

test("rescanTemplateToken scans a tail from the closing brace", () => {
  const lexer = new Lexer("`a${b}c`");
  expect(lexer.next()).toEqual({
    kind: "template-head",
    text: "`a${",
    value: "`a${",
    start: 0,
    end: 4,
    line: 1,
    column: 1,
  });
  expect(lexer.next()).toEqual({
    kind: "identifier",
    text: "b",
    value: "b",
    start: 4,
    end: 5,
    line: 1,
    column: 5,
  });
  expect(lexer.next()).toEqual({
    kind: "punctuator",
    text: "}",
    value: "}",
    start: 5,
    end: 6,
    line: 1,
    column: 6,
  });
  expect(lexer.rescanTemplateToken()).toEqual({
    kind: "template-tail",
    text: "}c`",
    value: "}c`",
    start: 5,
    end: 8,
    line: 1,
    column: 6,
  });
  expect(lexer.next().kind).toBe("eof");
});

test("rescanTemplateToken scans a middle when more substitutions follow", () => {
  const lexer = new Lexer("`a${b}c${d}e`");
  lexer.next();
  lexer.next();
  lexer.next();
  const middle = lexer.rescanTemplateToken();
  expect(middle.kind).toBe("template-middle");
  expect(middle.text).toBe("}c${");
  expect(middle.value).toBe("}c${");
});

test("rescanTemplateToken throws without a preceding closing brace", () => {
  const fresh = new Lexer("a");
  expect(() => fresh.rescanTemplateToken()).toThrow(
    "rescanTemplateToken requires a preceding } punctuator",
  );
  const lexer = new Lexer("+");
  lexer.next();
  expect(() => lexer.rescanTemplateToken()).toThrow(
    "rescanTemplateToken requires a preceding } punctuator",
  );
});

test("treats true and false as reserved keyword literal tokens", () => {
  const tokens = tokenize("true false").filter((token) => token.kind !== "whitespace");
  expect(tokens.map((token) => token.kind)).toEqual(["keyword", "keyword", "eof"]);
  expect(tokens.map((token) => token.value)).toEqual(["true", "false", ""]);
  expect(reservedKeywords.has("true")).toBe(true);
  expect(reservedKeywords.has("false")).toBe(true);
  expect(contextualKeywords.has("true")).toBe(false);
  expect(contextualKeywords.has("false")).toBe(false);
});

test("keeps reserved and contextual keyword sets disjoint", () => {
  expect(reservedKeywords.has("const")).toBe(true);
  expect(reservedKeywords.has("return")).toBe(true);
  expect(reservedKeywords.has("true")).toBe(true);
  expect(contextualKeywords.has("type")).toBe(true);
  expect(contextualKeywords.has("namespace")).toBe(true);
  expect(contextualKeywords.has("as")).toBe(true);
  for (const keyword of reservedKeywords) {
    expect(contextualKeywords.has(keyword)).toBe(false);
  }
  for (const keyword of contextualKeywords) {
    expect(reservedKeywords.has(keyword)).toBe(false);
  }
});

test("keeps the token stream contiguous across templates, regex, and trivia", () => {
  const source = "const x = `t${y}` + /a/g; // c\n/* d */";
  const tokens = tokenize(source);
  const body = tokens.filter((token) => token.kind !== "eof");
  for (let index = 1; index < body.length; index += 1) {
    expect(body[index]?.start).toBe(body[index - 1]?.end);
  }
  const last = tokens[tokens.length - 1];
  expect(last?.kind).toBe("eof");
  expect(last?.start).toBe(source.length);
});

test("tokenizes the repository's own TypeScript sources", () => {
  const commentSuffix = "\n// corpus line comment\n/* corpus block comment */\n";
  for (const file of ["index.ts", "lexer.ts"]) {
    const fileSource = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(() => tokenize(fileSource)).not.toThrow();
    const source = `${fileSource}${commentSuffix}`;
    const tokens = tokenize(source);
    const eofTokens = tokens.filter((token) => token.kind === "eof");
    expect(eofTokens).toHaveLength(1);
    expect(tokens[tokens.length - 1]?.kind).toBe("eof");
    expect(tokens[tokens.length - 1]?.start).toBe(source.length);
    expect(tokens.some((token) => token.kind === "identifier")).toBe(true);
    expect(tokens.some((token) => token.kind === "keyword")).toBe(true);
    expect(tokens.some((token) => token.kind === "punctuator")).toBe(true);
    expect(tokens.some((token) => token.kind === "line-comment")).toBe(true);
    expect(tokens.some((token) => token.kind === "block-comment")).toBe(true);
  }
});

test("scans a regex after equals and division between operands on later lines", () => {
  const source = "const re = /ab+c/;\nconst x = a / b / c;";
  const tokens = tokenize(source);
  const regex = tokens.find((token) => token.kind === "regex");
  expect(regex?.text).toBe("/ab+c/");
  expect(regex?.start).toBe(11);
  expect(regex?.end).toBe(17);
  expect(regex?.line).toBe(1);
  const secondLinePunctuators = tokens
    .filter((token) => token.line === 2 && token.kind === "punctuator")
    .map((token) => token.text);
  expect(secondLinePunctuators).toEqual(["=", "/", "/", ";"]);
});
