import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// #68: the benchmark's fixture parsers are load-bearing (benchmark/check.ts
// validates the three frontends through them). These round-trip nets pin the
// frontends: canonical printed output must re-parse to an equal AST.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REFERENCES_DIR = join(REPO_ROOT, "benchmark", "references");

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Sexp = string | number | Sexp[];
type LispValue = number | boolean | LispValue[];

interface JsonFrontend {
  readonly parseJson: (text: string) => JsonValue;
  readonly printJson: (value: JsonValue) => string;
}

interface SexpFrontend {
  readonly parseSexp: (text: string) => Sexp;
  readonly printSexp: (value: Sexp) => string;
}

interface LispFrontend {
  readonly run: (program: string) => LispValue;
  readonly printLisp: (value: LispValue) => string;
}

// Import through computed specifiers so `tsc` never pins `../benchmark`: the
// self-host smoke test copies only `src/` and must stay green. When the
// references are absent this suite skips instead of failing to resolve.
async function loadFrontend<T>(file: string): Promise<T | null> {
  const path = join(REFERENCES_DIR, file);
  if (!existsSync(path)) {
    return null;
  }
  return (await import(pathToFileURL(path).href)) as T;
}

const json = await loadFrontend<JsonFrontend>("json.ts");
const sexp = await loadFrontend<SexpFrontend>("sexp.ts");
const lisp = await loadFrontend<LispFrontend>("lisp.ts");
const haveReferences = json !== null && sexp !== null && lisp !== null;

// Values a round trip must preserve: the fixtures' shapes plus edge cases
// (nested arrays, empty containers, escaped/unicode/quoted strings, numbers,
// booleans, null).
const JSON_VALUES: ReadonlyArray<readonly [string, JsonValue]> = [
  ["null", null],
  ["true", true],
  ["false", false],
  ["zero", 0],
  ["positive integer", 42],
  ["negative decimal", -3.5],
  ["small decimal", 0.025],
  ["empty string", ""],
  ["embedded quote", 'a"b'],
  ["backslash", "a\\b"],
  ["control characters", "line\nbreak\ttab\bform\ffeed\r"],
  ["unicode", "café ☕"],
  ["empty array", []],
  ["array of literals", [1, true, null]],
  ["nested arrays", [1, [2, [3, null]]]],
  ["empty object", {}],
  ["nested object", { a: 1, b: { c: [2, null] } }],
  ["special key", { 'a"b\\c': [null, false] }],
];

// The exact strings the json-parser fixture parses (minus the malformed ones,
// which are not values), so the round trip covers the fixture corpus itself.
const JSON_FIXTURE_SOURCES: readonly string[] = [
  "null",
  "true",
  "false",
  "42",
  "-3.5",
  "1e3",
  "2.5E-2",
  '""',
  '"hello"',
  '"\\""',
  '"\\\\"',
  '"\\/"',
  '"\\b"',
  '"\\f"',
  '"\\n"',
  '"\\r"',
  '"\\t"',
  '"\\u0041"',
  "[]",
  "[1, true, null]",
  "[1, [2, [3, null]]]",
  "{}",
  '{"a":1,"b":{"c":[2,null]}}',
  ' { "a" : [ 1 , 2 ] } ',
];

const SEXP_VALUES: ReadonlyArray<readonly [string, Sexp]> = [
  ["empty list", []],
  ["symbol", "foo"],
  ["symbol with punctuation", "foo-bar?"],
  ["quoted symbol", '"quoted"'],
  ["symbol with quote", 'a"b'],
  ["integer", 42],
  ["negative integer", -7],
  ["decimal", 3.5],
  ["flat list", ["a", "b", "c"]],
  ["nested list", ["a", ["b", 1], []]],
];

const SEXP_FIXTURE_SOURCES: readonly string[] = [
  "42",
  "-7",
  "3.5",
  "foo",
  "+",
  "foo-bar?",
  "()",
  "(a b c)",
  "(a (b 1) ())",
  "  ( a\n\tb )  ",
];

// In minilisp a bare list form is a call, so data is printed as an explicit
// `cons` pair. These programs evaluate to a data value, then the printed value
// is re-evaluated and must be deep-equal.
const LISP_PROGRAMS: ReadonlyArray<readonly [string, LispValue]> = [
  ["integer", 42],
  ["negative integer", -7],
  ["decimal", 3.5],
  ["true", true],
  ["false", false],
  ["pair", [1, 2]],
  ["nested pair", [1, [2, 3]]],
  ["cons chain", [1, [2, [3, 4]]]],
  ["booleans in pairs", [true, [false, 1]]],
];

describe.skipIf(!haveReferences)("reference frontends round-trip (#68)", () => {
  for (const [name, value] of JSON_VALUES) {
    test(`json parallel value: ${name}`, () => {
      expect(json!.parseJson(json!.printJson(value))).toEqual(value);
    });
  }

  for (const source of JSON_FIXTURE_SOURCES) {
    test(`json fixture source: ${JSON.stringify(source)}`, () => {
      const value = json!.parseJson(source);
      expect(json!.parseJson(json!.printJson(value))).toEqual(value);
    });
  }

  for (const [name, value] of SEXP_VALUES) {
    test(`sexp parallel value: ${name}`, () => {
      expect(sexp!.parseSexp(sexp!.printSexp(value))).toEqual(value);
    });
  }

  for (const source of SEXP_FIXTURE_SOURCES) {
    test(`sexp fixture source: ${JSON.stringify(source)}`, () => {
      const value = sexp!.parseSexp(source);
      expect(sexp!.parseSexp(sexp!.printSexp(value))).toEqual(value);
    });
  }

  for (const [name, value] of LISP_PROGRAMS) {
    test(`lisp program: ${name}`, () => {
      expect(lisp!.run(lisp!.printLisp(value))).toEqual(value);
    });
  }
});
