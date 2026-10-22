import { describe, expect, test } from "bun:test";
import { renderViewerFeedback, resolveEditDslReply } from "./edit-dsl";
import type { EditDslDeps } from "./edit-dsl";
import { parseSelection } from "./selection";
import { buildIndexTolerant, declarationSpaces } from "./utility";

const TWICE = ["export function twice(): number {", "  return 1;", "  return 1;", "}", ""].join(
  "\n",
);

const ONCE = ["export function once(): number {", "  return 1;", "}", ""].join("\n");

function deps(source: string): EditDslDeps {
  return {
    sourceFor: () => source,
    resolveEntry: (current, currentPath, locator, space) => {
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
    },
  };
}

describe("resolveEditDslReply (#111)", () => {
  test("resolves an editor clause with its cascade stage and matcher kind", () => {
    const selections = parseSelection(
      "select function once in a.ts\nmatch `return 1;`\nreplace with\n``````\nreturn 2;\n``````\nend",
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
      "select function once in a.ts\nreplace with\n``````\nfunction once(): number {\n  return 2;\n}\n``````\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    const region = result.regions[0];
    expect(region?.stage).toBe("whole-symbol");
    expect(region?.matcherKind).toBeNull();
  });

  test("a pick-only multi-range applies the same fence to every picked span", () => {
    const selections = parseSelection(
      "select function twice in a.ts\npick {2, 3}\nreplace with\n``````\n  return 2;\n``````\nend",
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
      "select function twice in a.ts\npick {2, 2:5}\nreplace with\n``````\n  return 2;\n``````\nend",
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
      "select function twice in a.ts\npick {2, 4}\nreplace with\n``````\n}\n``````\nend",
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
      "select function twice in a.ts\nmatch `return 1;`\nreplace with\n``````\nreturn 2;\n``````\nend",
    );
    const result = resolveEditDslReply(selections, deps(TWICE));
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("matcher");
    expect(result.failures[0]?.cause).toBe("matcher-ambiguous");
  });

  test("a malformed regex fails as regex-invalid on the matcher stage", () => {
    const selections = parseSelection(
      "select function once in a.ts\nmatch /(/\nreplace with\n``````\nreturn 2;\n``````\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures[0]?.stage).toBe("matcher");
    expect(result.failures[0]?.cause).toBe("regex-invalid");
  });

  test("a matched editor on an undeclared name still creates (match is ignored)", () => {
    const selections = parseSelection(
      "select function missing in a.ts\nmatch `return 1;`\nreplace with\n``````\nfunction missing(): number {\n  return 0;\n}\n``````\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\nfunction missing(): number {\n  return 0;\n}\n");
  });

  test("a whole-declaration editor on an undeclared name resolves to a create region", () => {
    const selections = parseSelection(
      "select function missing in a.ts\nreplace with\n``````\nfunction missing(): number {\n  return 0;\n}\n``````\nend",
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
      "select const NEW in src/new.ts\nreplace with\n``````\nconst NEW = 1;\n``````\nend",
    );
    const result = resolveEditDslReply(selections, deps(""));
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("const NEW = 1;\n");
  });

  test("a no-kind whole-declaration editor on an undeclared name also creates", () => {
    const selections = parseSelection(
      "select missing in a.ts\nreplace with\n``````\nfunction missing(): number {\n  return 0;\n}\n``````\nend",
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
        "``````",
        "export type JsonValue = string | number;",
        "``````",
        "end",
        "select function parseJson in src/json.ts",
        "replace with",
        "``````",
        "export function parseJson(text: string): JsonValue {",
        "  return text;",
        "}",
        "``````",
        "end",
        "select type JsonValue in src/json.ts resolve type",
        "replace with",
        "``````",
        "export type JsonValue = string | number;",
        "``````",
        "end",
        "select function parseJson in src/json.ts resolve value",
        "replace with",
        "``````",
        "export function parseJson(text: string): JsonValue {",
        "  return text;",
        "}",
        "``````",
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

  test("a no-kind clause resolves a declaration of any kind", () => {
    // The empty kind is the edit-dsl wildcard: path + name only.
    const selections = parseSelection(
      "select once in a.ts\nreplace with\n``````\nfunction once(): number {\n  return 2;\n}\n``````\nend",
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
      parseSelection("select Dual in a.ts\nreplace with\n``````\n42\n``````\nend"),
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
        "select Thing in a.ts resolve namespace\nreplace with\n``````\n42\n``````\nend",
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
      "select missing in a.ts\nreplace with\n``````\n42\n``````\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\nlet missing = 42;\n");
  });

  test("a resolve value non-declaration body creates a let binding", () => {
    const selections = parseSelection(
      "select missing in a.ts resolve value\nreplace with\n``````\n42\n``````\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\nlet missing = 42;\n");
  });

  test("a resolve type non-declaration body creates a type alias", () => {
    const selections = parseSelection(
      "select missing in a.ts resolve type\nreplace with\n``````\n{ n: number }\n``````\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\ntype missing = { n: number };\n");
  });

  test("a resolve namespace non-declaration body creates a namespace block", () => {
    const selections = parseSelection(
      "select missing in a.ts resolve namespace\nreplace with\n``````\n42\n``````\nend",
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
        `select missing in a.ts${resolve}\nreplace with\n\`\`\`\`\`\`\n${complete}\n\`\`\`\`\`\`\nend`,
      );
      const result = resolveEditDslReply(selections, deps(ONCE));
      expect(result.failures).toEqual([]);
      expect(result.regions[0]?.create).toBe(true);
      expect(result.regions[0]?.text).toBe(`\n${complete}\n`);
    });
  }

  test("a pick on an undeclared name still creates (pick is ignored)", () => {
    const selections = parseSelection(
      "select function missing in a.ts\npick 2\nreplace with\n``````\nfunction missing(): number {\n  return 0;\n}\n``````\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\nfunction missing(): number {\n  return 0;\n}\n");
  });

  test("a class+interface merge is rejected as multiple same-name declarations", () => {
    const body = "class missing {}\ninterface missing {}";
    const selections = parseSelection(
      `select missing in a.ts\nreplace with\n\`\`\`\`\`\`\n${body}\n\`\`\`\`\`\`\nend`,
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
      `select missing in a.ts\nreplace with\n\`\`\`\`\`\`\n${body}\n\`\`\`\`\`\`\nend`,
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain("exactly one");
  });

  test("a function+type merge is rejected as multiple same-name declarations", () => {
    const body = "function missing() {}\ntype missing = number;";
    const selections = parseSelection(
      `select missing in a.ts\nreplace with\n\`\`\`\`\`\`\n${body}\n\`\`\`\`\`\`\nend`,
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
        `select missing in a.ts${resolve}\nreplace with\n\`\`\`\`\`\`\n${body}\n\`\`\`\`\`\`\nend`,
      );
      const result = resolveEditDslReply(selections, deps(ONCE));
      expect(result.failures).toEqual([]);
      expect(result.regions[0]?.create).toBe(true);
      expect(result.regions[0]?.text).toBe(`\n${body}\n`);
    });
  }

  test("a resolve type create with a function body fails at the address stage", () => {
    const selections = parseSelection(
      `select missing in a.ts resolve type\nreplace with\n\`\`\`\`\`\`\n${COMPLETE}\n\`\`\`\`\`\`\nend`,
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
      `select missing in a.ts resolve namespace\nreplace with\n\`\`\`\`\`\`\n${COMPLETE_TYPE}\n\`\`\`\`\`\`\nend`,
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain('"type"');
    expect(result.failures[0]?.diagnostics).toContain('"namespace"');
  });

  test("a declaration body with a different name fails instead of wrapping", () => {
    const selections = parseSelection(
      "select missing in a.ts\nreplace with\n``````\nfunction other(): number {\n  return 0;\n}\n``````\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain('declares no top-level "missing"');
  });

  test("a declaration list with exactly one declaration named the symbol is appended verbatim", () => {
    const body = "const before = 1;\nfunction missing(): number {\n  return 0;\n}";
    const selections = parseSelection(
      `select missing in a.ts\nreplace with\n\`\`\`\`\`\`\n${body}\n\`\`\`\`\`\`\nend`,
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe(`\n${body}\n`);
  });

  test("a declaration list with two declarations named the symbol fails", () => {
    const body = "function missing(): number {\n  return 0;\n}\nconst missing = 1;";
    const selections = parseSelection(
      `select missing in a.ts\nreplace with\n\`\`\`\`\`\`\n${body}\n\`\`\`\`\`\`\nend`,
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain("exactly one");
  });

  test("a kind miss is not a create", () => {
    const selections = parseSelection(
      "select const once in a.ts\nreplace with\n``````\n42\n``````\nend",
    );
    const result = resolveEditDslReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.undeclaredName).toBeNull();
  });

  test("an empty fence on an undeclared name is not a create", () => {
    const selections = parseSelection(
      "select function missing in a.ts\nreplace with\n``````\n``````\nend",
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

  test("a duplicate-symbol viewer renders every declaration and names the delete repair", () => {
    const source = ["export type Value = number;", "", "export type Value = string;", ""].join(
      "\n",
    );
    const selections = parseSelection("select type Value in a.ts end");
    const result = resolveEditDslReply(selections, deps(source));
    expect(result.failures).toEqual([]);
    expect(result.viewers).toHaveLength(1);
    const viewer = result.viewers[0];
    expect(viewer?.duplicates).toHaveLength(2);
    expect(viewer?.duplicateNote).toContain(
      'Duplicate declarations: the top-level type "Value" in a.ts is declared 2 times, at a.ts:1 and a.ts:3.',
    );
    const feedback = renderViewerFeedback(result.viewers);
    expect(feedback).toContain("1 | export type Value = number;");
    expect(feedback).toContain("duplicate declaration at a.ts:3");
    expect(feedback).toContain("3 | export type Value = string;");
    expect(feedback).toContain(
      "To remove one duplicate, reply with an empty-fence `replace with` clause on this address",
    );
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

  test("an editor with an invalid pick range reports stage range and renders no block", () => {
    const selections = parseSelection(
      "select function twice in a.ts\nmatch `return 1;`\npick 99\nreplace with\n``````\n  return 2;\n``````\nend",
    );
    const result = resolveEditDslReply(selections, deps(TWICE));
    expect(result.viewers).toEqual([]);
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("range");
    expect(result.failures[0]?.diagnostics).toContain("stage: range");
  });
});
