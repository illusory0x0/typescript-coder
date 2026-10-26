import { describe, expect, test } from "bun:test";
import { foldMarker, renderViewerFeedback, resolveEditDslReply } from "./edit-dsl";
import type { EditDslDeps } from "./edit-dsl";
import { parseSelection } from "./selection";
import { buildIndexTolerant, declarationSpaces } from "./utility";
import type { Locator, SymbolSpace } from "./utility";

const TWICE = ["export function twice(): number {", "  return 1;", "  return 1;", "}", ""].join(
  "\n",
);

const ONCE = ["export function once(): number {", "  return 1;", "}", ""].join("\n");

function resolveEntryIn(
  current: string,
  currentPath: string,
  locator: Locator,
  space: SymbolSpace | null,
): ReturnType<EditDslDeps["resolveEntry"]> {
  const { index } = buildIndexTolerant([{ path: currentPath, source: current }]);
  const matches = index.lookup(locator, space);
  const entry = matches[0];
  if (matches.length === 1 && entry !== undefined) {
    return { ok: true, entry };
  }
  const byName = index.byName(locator.name);
  const spaces = [...new Set(byName.flatMap((candidate) => declarationSpaces(candidate)))];
  const diagnostics =
    space === null
      ? "stage: address\nno unique declaration"
      : `stage: address\nno declaration in the ${space} space; the name is declared in ${spaces.map((candidate) => JSON.stringify(candidate)).join(", ")}`;
  return {
    ok: false,
    diagnostics,
    // Mirror `resolveCurrentEntry`: the name is undeclared only when it is
    // absent under every kind, not merely under the requested one.
    undeclared: byName.length === 0,
    spaceMiss:
      space !== null &&
      byName.length > 0 &&
      byName.every((candidate) => !declarationSpaces(candidate).includes(space)),
  };
}

function deps(source: string): EditDslDeps {
  return {
    sourceFor: () => source,
    resolveEntry: resolveEntryIn,
  };
}

function multiDeps(files: Record<string, string>): EditDslDeps {
  return {
    sourceFor: (path) => files[path] ?? "",
    resolveEntry: resolveEntryIn,
  };
}

/** One whole-declaration editor clause, for the multi-clause #40 tests. */
function wholeReplace(path: string, kind: string, name: string, body: string): string {
  const head = kind === "" ? `select ${name} in ${path}` : `select ${kind} ${name} in ${path}`;
  return [head, "replace with", "<<<TC_EDIT_BEGIN>>>", body, "<<<TC_EDIT_END>>>", "end"].join("\n");
}

describe("resolveEditDslReply (#111)", () => {
  test("resolves an editor clause with its cascade stage and matcher kind", () => {
    const selections = parseSelection(
      "select function once in a.ts\nmatch `return 1;`\nreplace with\n<<<TC_EDIT_BEGIN>>>\nreturn 2;\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.viewers).toEqual([]);
    expect(result.regions).toHaveLength(1);
    const region = result.regions[0];
    expect(region?.stage).toBe("match");
    expect(region?.matcherKind).toBe("snippet");
    expect(region?.text).toBe("return 2;");
    expect(region?.path).toBe("a.ts");
  });

  test("a whole-declaration replace records the whole-symbol stage and no matcher kind", () => {
    const selections = parseSelection(
      "select function once in a.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\nfunction once(): number {\n  return 2;\n}\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    const region = result.regions[0];
    expect(region?.stage).toBe("whole-symbol");
    expect(region?.matcherKind).toBeNull();
  });

  test("a pick-only multi-range applies the same fence to every picked span", () => {
    const selections = parseSelection(
      "select function twice in a.ts\npick {2, 3}\nreplace with\n<<<TC_EDIT_BEGIN>>>\n  return 2;\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(TWICE));
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(2);
    const first = TWICE.indexOf("  return 1;");
    const second = TWICE.indexOf("  return 1;", first + 1);
    expect(result.regions.map((region) => region.start)).toEqual([first, second]);
    expect(result.regions.map((region) => region.end)).toEqual([
      first + "  return 1;".length,
      second + "  return 1;".length,
    ]);
    for (const region of result.regions) {
      expect(region.text).toBe("  return 2;");
      expect(region.stage).toBe("pick");
      expect(region.matcherKind).toBeNull();
      expect(region.create).toBe(false);
      expect(region.index).toBe(0);
    }
  });

  test("a pick-only multi-range with overlapping ranges fails at the range stage", () => {
    const selections = parseSelection(
      "select function twice in a.ts\npick {2, 2:5}\nreplace with\n<<<TC_EDIT_BEGIN>>>\n  return 2;\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(TWICE));
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("range");
    expect(result.failures[0]?.cause).toBe("range-invalid");
    expect(result.failures[0]?.diagnostics).toContain("overlapping");
  });

  test("a pick-only multi-range fails the whole clause when one range is a no-op", () => {
    const selections = parseSelection(
      "select function twice in a.ts\npick {2, 4}\nreplace with\n<<<TC_EDIT_BEGIN>>>\n}\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(TWICE));
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("no-op");
    expect(result.failures[0]?.cause).toBe("no-op");
  });

  test("a viewer enumerates every candidate occurrence and resolves no region", () => {
    const selections = parseSelection("select function twice in a.ts\nmatch `return 1;`\nend");
    const result = resolveEditDslReply(selections, deps(TWICE));
    expect(result.regions).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.viewers).toHaveLength(1);
    const viewer = result.viewers[0];
    expect(viewer?.stage).toBe("match");
    expect(viewer?.occurrences).toHaveLength(2);
    expect(viewer?.occurrences[0]?.line).toBe(2);
    expect(viewer?.occurrences[1]?.line).toBe(3);
  });

  test("a bare viewer returns the whole declaration as its only occurrence", () => {
    const selections = parseSelection("select function once in a.ts\nend");
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.viewers).toHaveLength(1);
    expect(result.viewers[0]?.stage).toBe("whole-symbol");
    expect(result.viewers[0]?.occurrences).toHaveLength(1);
  });

  test("an ambiguous editor fails at the matcher stage with its cascade cause", () => {
    const selections = parseSelection(
      "select function twice in a.ts\nmatch `return 1;`\nreplace with\n<<<TC_EDIT_BEGIN>>>\nreturn 2;\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(TWICE));
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("matcher");
    expect(result.failures[0]?.cause).toBe("matcher-ambiguous");
  });

  test("a malformed regex fails as regex-invalid on the matcher stage", () => {
    const selections = parseSelection(
      "select function once in a.ts\nmatch /(/\nreplace with\n<<<TC_EDIT_BEGIN>>>\nreturn 2;\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures[0]?.stage).toBe("matcher");
    expect(result.failures[0]?.cause).toBe("regex-invalid");
  });

  test("a matched editor on an undeclared name still creates (match is ignored)", () => {
    const selections = parseSelection(
      "select function missing in a.ts\nmatch `return 1;`\nreplace with\n<<<TC_EDIT_BEGIN>>>\nfunction missing(): number {\n  return 0;\n}\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\nfunction missing(): number {\n  return 0;\n}\n");
  });

  test("a whole-declaration editor on an undeclared name resolves to a create region", () => {
    const selections = parseSelection(
      "select function missing in a.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\nfunction missing(): number {\n  return 0;\n}\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(1);
    const region = result.regions[0];
    expect(region?.create).toBe(true);
    expect(region?.stage).toBe("whole-symbol");
    expect(region?.matcherKind).toBeNull();
    expect(region?.start).toBe(ONCE.length);
    expect(region?.end).toBe(ONCE.length);
    expect(region?.text).toBe("\nfunction missing(): number {\n  return 0;\n}\n");
  });

  test("a create appends with no leading newline to an empty file", () => {
    const selections = parseSelection(
      "select const NEW in src/new.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\nconst NEW = 1;\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(""));
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("const NEW = 1;\n");
  });

  test("a no-kind whole-declaration editor on an undeclared name also creates", () => {
    const selections = parseSelection(
      "select missing in a.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\nfunction missing(): number {\n  return 0;\n}\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.create).toBe(true);
    // No kind was given, so the locator kind is the empty string.
    expect(result.regions[0]?.locator.kind).toBe("");
  });

  test("rejects repeated implicit creates of the same declaration (#13)", () => {
    // The #11 json-parser reply: two creates followed by a "correction" that
    // asks for the other locator kind. Both fences add the same type alias /
    // function, so the correction clauses must conflict with the first pair.
    const selections = parseSelection(
      [
        "select const JsonValue in src/json.ts",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "export type JsonValue = string | number;",
        "<<<TC_EDIT_END>>>",
        "end",
        "select function parseJson in src/json.ts",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "export function parseJson(text: string): JsonValue {",
        "  return text;",
        "}",
        "<<<TC_EDIT_END>>>",
        "end",
        "select type JsonValue in src/json.ts resolve type",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "export type JsonValue = string | number;",
        "<<<TC_EDIT_END>>>",
        "end",
        "select function parseJson in src/json.ts resolve value",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "export function parseJson(text: string): JsonValue {",
        "  return text;",
        "}",
        "<<<TC_EDIT_END>>>",
        "end",
      ].join("\n"),
    );
    const result = resolveEditDslReply(selections, deps(""));
    // The first create of each name is queued; the repeats are rejected.
    expect(result.regions.map((region) => region.locator.name)).toEqual(["JsonValue", "parseJson"]);
    expect(result.failures).toHaveLength(2);
    const [first, second] = result.failures;
    expect(first?.index).toBe(2);
    expect(first?.stage).toBe("duplicate");
    expect(first?.diagnostics).toContain(
      'clause 1 and clause 3 both create the same top-level type "JsonValue"',
    );
    expect(first?.diagnostics).toContain(
      "the whole edit-dsl reply is discarded and nothing is written",
    );
    expect(second?.index).toBe(3);
    expect(second?.stage).toBe("duplicate");
    expect(second?.diagnostics).toContain(
      'clause 2 and clause 4 both create the same top-level function "parseJson"',
    );
  });

  test("two editors on one declaration with distinct match spans are duplicates (#40)", () => {
    const source = [
      "export function once(): number {",
      "  const value = 1;",
      "  return value;",
      "}",
      "",
    ].join("\n");
    const selections = parseSelection(
      [
        "select function once in a.ts",
        "match `const value = 1;`",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "const value = 2;",
        "<<<TC_EDIT_END>>>",
        "end",
        "select function once in a.ts",
        "match `return value;`",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "return value + 1;",
        "<<<TC_EDIT_END>>>",
        "end",
      ].join("\n"),
    );
    const result = resolveEditDslReply(selections, deps(source));
    // The first clause is queued; the second is rejected before its matcher
    // can run, even though the two spans do not overlap.
    expect(result.regions).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    const failure = result.failures[0];
    expect(failure?.index).toBe(1);
    expect(failure?.stage).toBe("duplicate");
    expect(failure?.cause).toBeNull();
    expect(failure?.diagnostics).toContain("stage: duplicate");
    expect(failure?.diagnostics).toContain(
      'clause 1 and clause 2 both select the same function "once" in "a.ts"',
    );
    expect(failure?.diagnostics).toContain("nothing is written");
  });

  test("two pick spans on one declaration are duplicates (#40)", () => {
    const clause = (line: number, text: string): string =>
      [
        "select function twice in a.ts",
        `pick ${line}`,
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        text,
        "<<<TC_EDIT_END>>>",
        "end",
      ].join("\n");
    const result = resolveEditDslReply(
      parseSelection([clause(2, "  return 2;"), clause(3, "  return 3;")].join("\n")),
      deps(TWICE),
    );
    expect(result.regions).toHaveLength(1);
    expect(result.failures[0]?.index).toBe(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    expect(result.failures[0]?.diagnostics).toContain(
      'clause 1 and clause 2 both select the same function "twice" in "a.ts"',
    );
  });

  test("a viewer and an editor on one declaration are duplicates (#40)", () => {
    const selections = parseSelection(
      [
        "select function once in a.ts",
        "match `return 1;`",
        "end",
        wholeReplace("a.ts", "function", "once", "function once(): number {\n  return 2;\n}"),
      ].join("\n"),
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.viewers).toHaveLength(1);
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.index).toBe(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    expect(result.failures[0]?.diagnostics).toContain(
      'clause 1 and clause 2 both select the same function "once" in "a.ts"',
    );
  });

  test("an omitted kind and an explicit kind resolve to the same target (#40)", () => {
    const selections = parseSelection(
      [
        wholeReplace("a.ts", "", "once", "function once(): number {\n  return 2;\n}"),
        wholeReplace("a.ts", "function", "once", "function once(): number {\n  return 3;\n}"),
      ].join("\n"),
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toHaveLength(1);
    expect(result.failures[0]?.index).toBe(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    // The key and message use the resolved declaration kind, not the raw
    // empty locator kind.
    expect(result.failures[0]?.diagnostics).toContain('same function "once" in "a.ts"');
    expect(result.failures[0]?.diagnostics).not.toContain('same  "once"');
  });

  test("two viewers on one declaration are duplicates (#40)", () => {
    const selections = parseSelection(
      ["select function once in a.ts end", "select once in a.ts end"].join("\n"),
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.viewers).toHaveLength(1);
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.index).toBe(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
  });

  test("a class selected through value and type is still one declaration (#40)", () => {
    const result = resolveEditDslReply(
      parseSelection(
        [
          "select class Widget in a.ts resolve value end",
          "select Widget in a.ts resolve type end",
        ].join("\n"),
      ),
      deps("export class Widget {}\n"),
    );
    expect(result.viewers).toHaveLength(1);
    expect(result.failures[0]?.index).toBe(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    expect(result.failures[0]?.diagnostics).toContain('same class "Widget" in "a.ts"');
  });

  test("different declarations in one file are allowed (#40)", () => {
    const source = [
      "export function one(): number {",
      "  return 1;",
      "}",
      "export function two(): number {",
      "  return 2;",
      "}",
      "",
    ].join("\n");
    const selections = parseSelection(
      [
        wholeReplace("a.ts", "function", "one", "function one(): number {\n  return 3;\n}"),
        wholeReplace("a.ts", "function", "two", "function two(): number {\n  return 4;\n}"),
      ].join("\n"),
    );
    const result = resolveEditDslReply(selections, deps(source));
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(2);
  });

  test("the same symbol in different files is allowed (#40)", () => {
    const selections = parseSelection(
      [
        wholeReplace("a.ts", "function", "once", "function once(): number {\n  return 2;\n}"),
        wholeReplace("b.ts", "function", "once", "function once(): number {\n  return 3;\n}"),
      ].join("\n"),
    );
    const result = resolveEditDslReply(selections, multiDeps({ "a.ts": ONCE, "b.ts": ONCE }));
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(2);
    expect(result.regions.map((region) => region.path)).toEqual(["a.ts", "b.ts"]);
  });

  test("a no-kind clause resolves a declaration of any kind", () => {
    // The empty kind is the edit-dsl wildcard: path + name only.
    const selections = parseSelection(
      "select once in a.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\nfunction once(): number {\n  return 2;\n}\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.create).toBe(false);
    expect(result.regions[0]?.stage).toBe("whole-symbol");
  });

  test("the edit-dsl address selects a function under resolve value", () => {
    const result = resolveEditDslReply(
      parseSelection("select answer in src/helper.ts resolve value end"),
      deps(ONCE.replace(/once/g, "answer")),
    );
    expect(result.failures).toEqual([]);
    expect(result.viewers).toHaveLength(1);
    expect(result.viewers[0]?.occurrences).toHaveLength(1);
  });

  const SPACE_SOURCE = [
    "export class Widget {}",
    "export enum Color { Red }",
    "export interface Shape { side: number }",
    "export type Alias = number;",
    "export namespace Space { export const inner = 1; }",
    "export function work(): number {",
    "  return 1;",
    "}",
    "export const constant = 1;",
    "export let mutable = 2;",
    "",
  ].join("\n");

  const SPACE_CASES: Array<[string, string]> = [
    ["Widget", "value"],
    ["Widget", "type"],
    ["Color", "value"],
    ["Color", "type"],
    ["Shape", "type"],
    ["Alias", "type"],
    ["Space", "namespace"],
    ["work", "value"],
    ["constant", "value"],
    ["mutable", "value"],
  ];

  for (const [name, space] of SPACE_CASES) {
    test(`${name} resolves in the ${space} space`, () => {
      const result = resolveEditDslReply(
        parseSelection(`select ${name} in a.ts resolve ${space} end`),
        deps(SPACE_SOURCE),
      );
      expect(result.failures).toEqual([]);
      expect(result.regions).toEqual([]);
      expect(result.viewers).toHaveLength(1);
      expect(result.viewers[0]?.occurrences).toHaveLength(1);
    });
  }

  test("without resolve a name declared in two spaces is ambiguous", () => {
    const source = "interface Dual {}\nconst Dual = 1;\n";
    const result = resolveEditDslReply(
      parseSelection(
        "select Dual in a.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\n42\n<<<TC_EDIT_END>>>\nend",
      ),
      deps(source),
    );
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.undeclaredName).toBeNull();
  });

  test("a resolve space miss creates in the requested space instead of failing", () => {
    const source = "interface Thing {}\nconst Thing = 1;\n";
    const result = resolveEditDslReply(
      parseSelection(
        "select Thing in a.ts resolve namespace\nreplace with\n<<<TC_EDIT_BEGIN>>>\n42\n<<<TC_EDIT_END>>>\nend",
      ),
      deps(source),
    );
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(1);
    // The name exists in other spaces, so this is the create path: the body is
    // wrapped as a namespace named Thing.
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\nnamespace Thing {\n42\n}\n");
  });

  test("a no-resolve non-declaration body creates a let binding", () => {
    const selections = parseSelection(
      "select missing in a.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\n42\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\nlet missing = 42;\n");
  });

  test("a resolve value non-declaration body creates a let binding", () => {
    const selections = parseSelection(
      "select missing in a.ts resolve value\nreplace with\n<<<TC_EDIT_BEGIN>>>\n42\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\nlet missing = 42;\n");
  });

  test("a resolve type non-declaration body creates a type alias", () => {
    const selections = parseSelection(
      "select missing in a.ts resolve type\nreplace with\n<<<TC_EDIT_BEGIN>>>\n{ n: number }\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\ntype missing = { n: number };\n");
  });

  test("a resolve namespace non-declaration body creates a namespace block", () => {
    const selections = parseSelection(
      "select missing in a.ts resolve namespace\nreplace with\n<<<TC_EDIT_BEGIN>>>\n42\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\nnamespace missing {\n42\n}\n");
  });

  const COMPLETE = "function missing(): number {\n  return 0;\n}";
  const COMPLETE_TYPE = "type missing = number;";
  const COMPLETE_NAMESPACE = "namespace missing {\n  export const inner = 1;\n}";

  const COMPLETE_CASES: Array<[null | "value" | "type" | "namespace", string]> = [
    [null, COMPLETE],
    ["value", COMPLETE],
    ["type", COMPLETE_TYPE],
    ["namespace", COMPLETE_NAMESPACE],
  ];

  for (const [space, complete] of COMPLETE_CASES) {
    test(`a complete declaration body is appended verbatim${
      space === null ? "" : ` under resolve ${space}`
    }`, () => {
      const resolve = space === null ? "" : ` resolve ${space}`;
      const selections = parseSelection(
        `select missing in a.ts${resolve}\nreplace with\n<<<TC_EDIT_BEGIN>>>\n${complete}\n<<<TC_EDIT_END>>>\nend`,
      );
      const result = resolveEditDslReply(selections, deps(ONCE));
      expect(result.failures).toEqual([]);
      expect(result.regions[0]?.create).toBe(true);
      expect(result.regions[0]?.text).toBe(`\n${complete}\n`);
    });
  }

  test("a pick on an undeclared name still creates (pick is ignored)", () => {
    const selections = parseSelection(
      "select function missing in a.ts\npick 2\nreplace with\n<<<TC_EDIT_BEGIN>>>\nfunction missing(): number {\n  return 0;\n}\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\nfunction missing(): number {\n  return 0;\n}\n");
  });

  test("a class+interface merge is rejected as multiple same-name declarations", () => {
    const body = "class missing {}\ninterface missing {}";
    const selections = parseSelection(
      `select missing in a.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\n${body}\n<<<TC_EDIT_END>>>\nend`,
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain("exactly one");
    expect(result.failures[0]?.diagnostics).toContain("TypeScript would merge");
  });

  test("function overloads are rejected as multiple same-name declarations", () => {
    const body =
      "function missing(x: string): string;\nfunction missing(x: any): any {\n  return x;\n}";
    const selections = parseSelection(
      `select missing in a.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\n${body}\n<<<TC_EDIT_END>>>\nend`,
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain("exactly one");
  });

  test("a function+type merge is rejected as multiple same-name declarations", () => {
    const body = "function missing() {}\ntype missing = number;";
    const selections = parseSelection(
      `select missing in a.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\n${body}\n<<<TC_EDIT_END>>>\nend`,
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain("exactly one");
  });

  const ACCEPTED_COMPLETE: Array<[null | "value" | "type" | "namespace", string]> = [
    ["value", "class missing {}"],
    ["type", "class missing {}"],
    ["value", "function missing(): number {\n  return 0;\n}"],
    ["type", "type missing = number;"],
    ["namespace", "namespace missing {}"],
  ];

  for (const [space, body] of ACCEPTED_COMPLETE) {
    test(`a single ${space === null ? "" : `${space}-space `}declaration is accepted${
      space === null ? "" : ` under resolve ${space}`
    }`, () => {
      const resolve = space === null ? "" : ` resolve ${space}`;
      const selections = parseSelection(
        `select missing in a.ts${resolve}\nreplace with\n<<<TC_EDIT_BEGIN>>>\n${body}\n<<<TC_EDIT_END>>>\nend`,
      );
      const result = resolveEditDslReply(selections, deps(ONCE));
      expect(result.failures).toEqual([]);
      expect(result.regions[0]?.create).toBe(true);
      expect(result.regions[0]?.text).toBe(`\n${body}\n`);
    });
  }

  test("a resolve type create with a function body fails at the address stage", () => {
    const selections = parseSelection(
      `select missing in a.ts resolve type\nreplace with\n<<<TC_EDIT_BEGIN>>>\n${COMPLETE}\n<<<TC_EDIT_END>>>\nend`,
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.cause).toBeNull();
    expect(result.failures[0]?.diagnostics).toContain("stage: address");
    expect(result.failures[0]?.diagnostics).toContain('"value"');
    expect(result.failures[0]?.diagnostics).toContain('"type"');
  });

  test("a resolve namespace create with a type alias body fails at the address stage", () => {
    const selections = parseSelection(
      `select missing in a.ts resolve namespace\nreplace with\n<<<TC_EDIT_BEGIN>>>\n${COMPLETE_TYPE}\n<<<TC_EDIT_END>>>\nend`,
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain('"type"');
    expect(result.failures[0]?.diagnostics).toContain('"namespace"');
  });

  test("a declaration body with a different name fails instead of wrapping", () => {
    const selections = parseSelection(
      "select missing in a.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\nfunction other(): number {\n  return 0;\n}\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain("code: EDIT_TARGET_MISMATCH");
    expect(result.failures[0]?.diagnostics).toContain('declares no top-level "missing"');
  });

  test("a declaration list with exactly one declaration named the symbol is appended verbatim", () => {
    const body = "const before = 1;\nfunction missing(): number {\n  return 0;\n}";
    const selections = parseSelection(
      `select missing in a.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\n${body}\n<<<TC_EDIT_END>>>\nend`,
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe(`\n${body}\n`);
  });

  test("a declaration list with two declarations named the symbol fails", () => {
    const body = "function missing(): number {\n  return 0;\n}\nconst missing = 1;";
    const selections = parseSelection(
      `select missing in a.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\n${body}\n<<<TC_EDIT_END>>>\nend`,
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain("exactly one");
  });

  test("a kind miss is not a create", () => {
    const selections = parseSelection(
      "select const once in a.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\n42\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.undeclaredName).toBeNull();
  });

  test("an empty fence on an undeclared name is not a create", () => {
    const selections = parseSelection(
      "select function missing in a.ts\nreplace with\n<<<TC_EDIT_BEGIN>>>\n<<<TC_EDIT_END>>>\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
  });

  test("a viewer on an undeclared name is not a create", () => {
    const selections = parseSelection("select function missing in a.ts\nend");
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.viewers).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
  });

  test("a bare viewer renders the whole declaration once, unmarked", () => {
    const selections = parseSelection("select answer in src/helper.ts resolve value end");
    const result = resolveEditDslReply(selections, deps(ONCE.replace(/once/g, "answer")));
    expect(renderViewerFeedback(result.viewers)).toBe(
      [
        "Located occurrences (viewer clauses write nothing):",
        "",
        "select answer in src/helper.ts resolve value",
        "  src/helper.ts:1:8",
        "    1 | export function answer(): number {",
        "    2 |   return 1;",
        "    3 | }",
        "",
        "Reply with an edit clause: add `replace` (use `pick` only with `replace`).",
      ].join("\n"),
    );
  });

  test("a match viewer marks the matched line in the declaration block", () => {
    const selections = parseSelection(
      "select answer in src/helper.ts resolve value\nmatch `return 1;`\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE.replace(/once/g, "answer")));
    expect(renderViewerFeedback(result.viewers)).toBe(
      [
        "Located occurrences (viewer clauses write nothing):",
        "",
        "select answer in src/helper.ts resolve value",
        "  src/helper.ts:2:3",
        "    1 | export function answer(): number {",
        "⁉️  2 |   return 1;",
        "    3 | }",
        "",
        "Reply with an edit clause: add `replace` (use `pick` only with `replace`).",
      ].join("\n"),
    );
  });

  test("a multi-candidate viewer marks every line and renders the declaration once", () => {
    const selections = parseSelection("select function twice in a.ts\nmatch `return 1;`\nend");
    const result = resolveEditDslReply(selections, deps(TWICE));
    expect(renderViewerFeedback(result.viewers)).toBe(
      [
        "Located occurrences (viewer clauses write nothing):",
        "",
        "select function twice in a.ts",
        "  a.ts:2:3",
        "  a.ts:3:3",
        "    1 | export function twice(): number {",
        "⁉️  2 |   return 1;",
        "⁉️  3 |   return 1;",
        "    4 | }",
        "",
        "Reply with an edit clause: add `replace` (use `pick` only with `replace`).",
      ].join("\n"),
    );
  });

  test("a duplicate-symbol address is rejected instead of selecting the first copy", () => {
    const source = ["export type Value = number;", "", "export type Value = string;", ""].join(
      "\n",
    );
    const selections = parseSelection("select type Value in a.ts end");
    const result = resolveEditDslReply(selections, deps(source));
    expect(result.viewers).toEqual([]);
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain("no unique declaration");
  });

  test("the fold marker stays self-describing with or without a total", () => {
    expect(foldMarker(4, 7)).toBe(
      "... // content folded, <path>: 4-7L; expand with read <path> within 4-7 end",
    );
    expect(foldMarker(4, 7, 10, "src/a.ts")).toBe(
      "... // content folded, src/a.ts: 4-7L (4 of 10 lines hidden); expand with read src/a.ts within 4-7 end",
    );
  });

  test("a huge viewer declaration folds to three head and three tail lines", () => {
    const source = [
      "export function huge(): number {",
      "  const a = 1;",
      "  const b = 2;",
      "  const c = 3;",
      "  const d = 4;",
      "  const e = 5;",
      "  const f = 6;",
      "  const g = 7;",
      "  const h = 8;",
      "  return a + b + c + d + e + f + g + h;",
      "}",
    ].join("\n");
    const selections = parseSelection("select function huge in a.ts end");
    const result = resolveEditDslReply(selections, deps(source));
    const feedback = renderViewerFeedback(result.viewers);
    expect(feedback).toContain("1 | export function huge(): number {");
    expect(feedback).toContain("3 |   const b = 2;");
    expect(feedback).toContain("... // content folded, a.ts: 4-8L");
    expect(feedback).toContain("(5 of 11 lines hidden)");
    expect(feedback).toContain("expand with read a.ts within 4-8 end");
    expect(feedback).toContain("9 |   const h = 8;");
    expect(feedback).toContain("11 | }");
    expect(feedback).not.toContain("4 |   const c = 3;");
  });

  test("an indented viewer outline folds a nested block", () => {
    const source = [
      "export function outer(): number {",
      "  const a = 1;",
      "  if (a > 0) {",
      "    const b = 2;",
      "    const c = 3;",
      "    const d = 4;",
      "    return b + c + d;",
      "  }",
      "  return a;",
      "}",
    ].join("\n");
    const selections = parseSelection("select function outer in a.ts end");
    const result = resolveEditDslReply(selections, deps(source));
    const feedback = renderViewerFeedback(result.viewers);
    expect(feedback).toContain("3 |   if (a > 0) {");
    expect(feedback).toContain("... // content folded, a.ts: 4-7L");
    expect(feedback).toContain("8 |   }");
    expect(feedback).toContain("9 |   return a;");
    expect(feedback).not.toContain("4 |     const b = 2;");
  });

  test("a viewer within slice returns exact lines unfolded", () => {
    const source = [
      "export function outer(): number {",
      "  const a = 1;",
      "  if (a > 0) {",
      "    const b = 2;",
      "    const c = 3;",
      "    return b + c;",
      "  }",
      "  return a;",
      "}",
    ].join("\n");
    const selections = parseSelection("select function outer in a.ts within 4-5 end");
    const result = resolveEditDslReply(selections, deps(source));
    const feedback = renderViewerFeedback(result.viewers);
    expect(feedback).toContain("4 |     const b = 2;");
    expect(feedback).toContain("5 |     const c = 3;");
    expect(feedback).not.toContain("content folded");
    expect(feedback).not.toContain("6 |     return b + c;");
  });

  test("a viewer slice outside the declaration follows the range stage", () => {
    const selections = parseSelection("select function answer in a.ts within 1-99 end");
    const result = resolveEditDslReply(selections, deps(ONCE.replace(/once/g, "answer")));
    expect(result.viewers).toEqual([]);
    expect(result.failures[0]?.stage).toBe("range");
    expect(result.failures[0]?.diagnostics).toContain("outside the declaration");
  });

  test("a viewer with no occurrences keeps the empty marker and skips the block", () => {
    const selections = parseSelection("select function twice in a.ts\nmatch `return 9;`\nend");
    const result = resolveEditDslReply(selections, deps(TWICE));
    expect(result.viewers).toHaveLength(1);
    expect(result.viewers[0]?.occurrences).toEqual([]);
    expect(renderViewerFeedback(result.viewers)).toBe(
      [
        "Located occurrences (viewer clauses write nothing):",
        "",
        "select function twice in a.ts",
        "  (no occurrences)",
        "",
        "Reply with an edit clause: add `replace` (use `pick` only with `replace`).",
      ].join("\n"),
    );
  });

  test("a viewer that fails its matcher reports stage matcher and renders no block", () => {
    const selections = parseSelection("select function twice in a.ts\nmatch /(/\nend");
    const result = resolveEditDslReply(selections, deps(TWICE));
    expect(result.viewers).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("matcher");
    expect(result.failures[0]?.diagnostics).toContain("stage: matcher");
  });
});

describe("file-level module-boundary select (#54)", () => {
  const replace = (body: string): string =>
    ["replace with", "<<<TC_EDIT_BEGIN>>>", body, "<<<TC_EDIT_END>>>", "end"].join("\n");

  const SOURCE = [
    'import { alpha, beta } from "./values";',
    'import type { Config } from "./config";',
    "",
    "export { alpha as first };",
    "export function work(): number {",
    "  return alpha;",
    "}",
    "",
  ].join("\n");

  function fileDeps(
    files: Record<string, string>,
    options: { safe?: boolean; exists?: boolean } = {},
  ): EditDslDeps {
    return {
      sourceFor: (path) => files[path] ?? "",
      fileExists: (path) => options.exists ?? path in files,
      isSafePath: () => options.safe ?? true,
      resolveEntry: resolveEntryIn,
    };
  }

  test("edits an import statement through a structural snippet", () => {
    const result = resolveEditDslReply(
      parseSelection(
        [
          "select file a.ts",
          'match `import { alpha, beta } from "./values";`',
          replace('import { alpha, gamma } from "./values";'),
        ].join("\n"),
      ),
      fileDeps({ "a.ts": SOURCE }),
    );
    expect(result.failures).toEqual([]);
    const region = result.regions[0];
    expect(region?.start).toBe(0);
    expect(region?.end).toBe('import { alpha, beta } from "./values";'.length);
    expect(region?.stage).toBe("match");
    expect(region?.matcherKind).toBe("snippet");
  });

  test("deletes an import statement with an empty fence", () => {
    const result = resolveEditDslReply(
      parseSelection(
        ["select file a.ts", 'match `import { alpha, beta } from "./values";`', replace("")].join(
          "\n",
        ),
      ),
      fileDeps({ "a.ts": SOURCE }),
    );
    expect(result.failures).toEqual([]);
    const region = result.regions[0];
    expect(region?.start).toBe(0);
    expect(SOURCE.slice(region?.end ?? 0)).toStartWith('import type { Config } from "./config";');
  });

  test("deletes one named import specifier and its separator", () => {
    const result = resolveEditDslReply(
      parseSelection(["select file a.ts", "match `beta`", replace("")].join("\n")),
      fileDeps({ "a.ts": SOURCE }),
    );
    expect(result.failures).toEqual([]);
    const region = result.regions[0];
    const start = region?.start ?? -1;
    const end = region?.end ?? -1;
    expect(SOURCE.slice(start, end)).toBe(", beta");
    expect(SOURCE.slice(0, start) + SOURCE.slice(end)).toContain(
      'import { alpha } from "./values";',
    );
  });

  test("edits an export specifier through a regex matcher", () => {
    const result = resolveEditDslReply(
      parseSelection(
        ["select file a.ts", "match /alpha as first/", replace("alpha as primary")].join("\n"),
      ),
      fileDeps({ "a.ts": SOURCE }),
    );
    expect(result.failures).toEqual([]);
    const region = result.regions[0];
    expect(region?.start).toBe(SOURCE.indexOf("alpha as first"));
    expect(region?.text).toBe("alpha as primary");
  });

  test("edits a specifier through file-absolute pick coordinates", () => {
    const result = resolveEditDslReply(
      parseSelection(["select file a.ts", "pick 1:10-1:14", replace("ALPHA")].join("\n")),
      fileDeps({ "a.ts": SOURCE }),
    );
    expect(result.failures).toEqual([]);
    const region = result.regions[0];
    expect(SOURCE.slice(region?.start ?? 0, region?.end ?? 0)).toBe("alpha");
    expect(region?.stage).toBe("pick");
  });

  test("structural matching keeps the module specifier significant", () => {
    const source = [
      'import { a } from "./a";',
      'import { a as b } from "./b";',
      "export const value = a + b;",
      "",
    ].join("\n");
    const result = resolveEditDslReply(
      parseSelection(
        [
          "select file a.ts",
          'match `import { a } from "./a";`',
          replace('import { a } from "./a2";'),
        ].join("\n"),
      ),
      fileDeps({ "a.ts": source }),
    );
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.start).toBe(0);
    expect(result.regions[0]?.end).toBe('import { a } from "./a";'.length);
  });

  test("rejects an ambiguous match with each candidate location", () => {
    const source = 'import "side-effect";\nimport "side-effect";\n';
    const result = resolveEditDslReply(
      parseSelection(
        ["select file a.ts", 'match `import "side-effect";`', replace('import "./other";')].join(
          "\n",
        ),
      ),
      fileDeps({ "a.ts": source }),
    );
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("matcher");
    expect(result.failures[0]?.diagnostics).toContain("a.ts:1:1");
    expect(result.failures[0]?.diagnostics).toContain("a.ts:2:1");
    expect(result.failures[0]?.diagnostics).toContain("exactly one span");
  });

  test("rejects a match outside a module-boundary statement", () => {
    const source = ["function work(): number {", "  return 1;", "}", ""].join("\n");
    const result = resolveEditDslReply(
      parseSelection(["select file a.ts", "match `return 1;`", replace("return 2;")].join("\n")),
      fileDeps({ "a.ts": source }),
    );
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain("outside an import/export statement");
  });

  test("requires match or pick and rejects an unsafe path", () => {
    const bare = resolveEditDslReply(
      parseSelection(["select file a.ts", replace("export {};")].join("\n")),
      fileDeps({ "a.ts": SOURCE }),
    );
    expect(bare.failures[0]?.stage).toBe("address");
    expect(bare.failures[0]?.diagnostics).toContain("needs `match` or `pick`");

    const unsafe = resolveEditDslReply(
      parseSelection(["select file ../a.ts", "match `beta`", replace("gamma")].join("\n")),
      fileDeps({ "../a.ts": SOURCE }, { safe: false }),
    );
    expect(unsafe.failures[0]?.stage).toBe("address");
    expect(unsafe.failures[0]?.diagnostics).toContain("outside the editable workspace");

    const missing = resolveEditDslReply(
      parseSelection(["select file a.ts", "match `beta`", replace("gamma")].join("\n")),
      fileDeps({}, { exists: false }),
    );
    expect(missing.failures[0]?.stage).toBe("address");
    expect(missing.failures[0]?.diagnostics).toContain("does not exist");
  });
});

describe("nested declaration addresses (#52)", () => {
  const replace = (body: string): string =>
    ["replace with", "<<<TC_EDIT_BEGIN>>>", body, "<<<TC_EDIT_END>>>", "end"].join("\n");

  test("modifies and deletes an interface member through its dotted address", () => {
    const source = ["interface Cell {", "  value: number;", "  getValue(): number;", "}"].join(
      "\n",
    );
    const modify = resolveEditDslReply(
      parseSelection(`select Cell.value in a.ts\n${replace("value: string;")}`),
      deps(source),
    );
    expect(modify.failures).toEqual([]);
    const modified = modify.regions[0];
    expect(modified?.start).toBe(source.indexOf("value: number"));
    expect(modified?.end).toBe(source.indexOf("value: number") + "value: number".length);

    const remove = resolveEditDslReply(
      parseSelection(`select Cell.value in a.ts\n${replace("")}`),
      deps(source),
    );
    expect(remove.failures).toEqual([]);
    const removed = remove.regions[0];
    expect(removed?.start).toBe(source.indexOf("value: number"));
    expect(removed?.end).toBe(source.indexOf("value: number") + "value: number;".length);
  });

  test("modifies and deletes an enum member including its separator", () => {
    const source = ["enum Color {", "  Red = 1,", "  Green,", "  Blue = 3", "}"].join("\n");
    const modify = resolveEditDslReply(
      parseSelection(`select Color.Red in a.ts\n${replace("Red = 10")}`),
      deps(source),
    );
    expect(modify.regions[0]?.start).toBe(source.indexOf("Red = 1"));
    expect(modify.regions[0]?.end).toBe(source.indexOf("Red = 1") + "Red = 1".length);

    const middle = resolveEditDslReply(
      parseSelection(`select Color.Green in a.ts\n${replace("")}`),
      deps(source),
    );
    const middleStart = source.indexOf("Green");
    expect(middle.regions[0]?.start).toBe(middleStart);
    expect(middle.regions[0]?.end).toBe(source.indexOf(",", middleStart) + 1);

    const last = resolveEditDslReply(
      parseSelection(`select Color.Blue in a.ts\n${replace("")}`),
      deps(source),
    );
    const lastStart = source.indexOf("Blue");
    expect(last.regions[0]?.start).toBe(source.lastIndexOf(",", lastStart));
    expect(last.regions[0]?.end).toBe(lastStart + "Blue = 3".length);
  });

  test("modifies and deletes object-literal members recursively", () => {
    const source = [
      "const config = {",
      "  timeout: 100,",
      "  server: {",
      '    host: "localhost",',
      "    port: 80",
      "  },",
      "};",
    ].join("\n");
    const host = resolveEditDslReply(
      parseSelection(`select config.server.host in a.ts\n${replace('host: "remote";')}`),
      deps(source),
    );
    expect(host.failures).toEqual([]);
    expect(host.regions[0]?.start).toBe(source.indexOf('host: "localhost"'));

    const timeout = resolveEditDslReply(
      parseSelection(`select config.timeout in a.ts\n${replace("")}`),
      deps(source),
    );
    expect(timeout.failures).toEqual([]);
    const timeoutStart = source.indexOf("timeout: 100");
    expect(timeout.regions[0]?.start).toBe(timeoutStart);
    expect(timeout.regions[0]?.end).toBe(source.indexOf(",", timeoutStart) + 1);

    const port = resolveEditDslReply(
      parseSelection(`select config.server.port in a.ts\n${replace("")}`),
      deps(source),
    );
    const portStart = source.indexOf("port: 80");
    expect(port.regions[0]?.start).toBe(source.lastIndexOf(",", portStart));
    expect(port.regions[0]?.end).toBe(portStart + "port: 80".length);
  });

  test("modifies and deletes a named default export through its declared name", () => {
    const source = "export default function boot(): number {\n  return 1;\n}\n";
    const modify = resolveEditDslReply(
      parseSelection(
        `select boot in a.ts\n${replace("function boot(): number {\n  return 2;\n}")}`,
      ),
      deps(source),
    );
    expect(modify.failures).toEqual([]);
    expect(modify.regions[0]?.start).toBe("export default ".length);
    expect(modify.regions[0]?.text).toContain("return 2;");

    const remove = resolveEditDslReply(
      parseSelection(`select boot in a.ts\n${replace("")}`),
      deps(source),
    );
    expect(remove.failures).toEqual([]);
    expect(remove.regions[0]?.start).toBe(0);
    expect(remove.regions[0]?.end).toBe(source.trimEnd().length);
  });

  test("rejects a whole-symbol edit on a multi-declarator binding", () => {
    const source = "const first = 1, second = 2;\n";
    const result = resolveEditDslReply(
      parseSelection(`select first in a.ts\n${replace("const first = 10;")}`),
      deps(source),
    );
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain("silently rewrite a sibling binding");
    expect(result.failures[0]?.diagnostics).toContain("match");
  });

  test("allows a matcher edit on one multi-declarator/destructuring binding", () => {
    const multi = resolveEditDslReply(
      parseSelection(`select first in a.ts\nmatch \`1\`\n${replace("10")}`),
      deps("const first = 1, second = 2;\n"),
    );
    expect(multi.failures).toEqual([]);
    expect(multi.regions[0]?.text).toBe("10");
    expect(multi.regions[0]?.start).toBe("const first = ".length);
    expect(multi.regions[0]?.end).toBe("const first = 1".length);

    const picked = resolveEditDslReply(
      parseSelection(`select first in a.ts\npick 1:15\n${replace("10")}`),
      deps("const first = 1, second = 2;\n"),
    );
    expect(picked.failures).toEqual([]);
    expect(picked.regions[0]?.text).toBe("10");
    expect(picked.regions[0]?.start).toBe("const first = ".length);
    expect(picked.regions[0]?.end).toBe("const first = 1".length);

    const destructured = resolveEditDslReply(
      parseSelection(`select a in a.ts\nmatch \`1\`\n${replace("3")}`),
      deps("const { a = 1, b = 2 } = pair;\n"),
    );
    expect(destructured.failures).toEqual([]);
    expect(destructured.regions[0]?.text).toBe("3");
    expect(destructured.regions[0]?.start).toBe("const { a = ".length);
    expect(destructured.regions[0]?.end).toBe("const { a = 1".length);
  });

  test("rejects a whole-symbol edit on a destructuring binding", () => {
    const result = resolveEditDslReply(
      parseSelection(`select a in a.ts\n${replace("const { a } = pair;")}`),
      deps("const { a, b } = pair;\n"),
    );
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain("destructuring pattern");
  });
});
