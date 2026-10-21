import { describe, expect, test } from "bun:test";
import { renderViewerFeedback, resolveCompactReply } from "./compact";
import type { CompactDeps } from "./compact";
import { parseSelection } from "./selection";
import { buildIndexTolerant, declarationSpaces } from "./utility";

const TWICE = ["export function twice(): number {", "  return 1;", "  return 1;", "}", ""].join(
  "\n",
);

const ONCE = ["export function once(): number {", "  return 1;", "}", ""].join("\n");

function deps(source: string): CompactDeps {
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
      };
    },
  };
}

describe("resolveCompactReply (#111)", () => {
  test("resolves an editor clause with its cascade stage and matcher kind", () => {
    const selections = parseSelection(
      "select function once in a.ts\nmatch `return 1;`\nreplace with\n``````\nreturn 2;\n``````\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
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
    const result = resolveCompactReply(selections, deps(ONCE));
    const region = result.regions[0];
    expect(region?.stage).toBe("whole-symbol");
    expect(region?.matcherKind).toBeNull();
  });

  test("a viewer enumerates every candidate occurrence and resolves no region", () => {
    const selections = parseSelection("select function twice in a.ts\nmatch `return 1;`\nend");
    const result = resolveCompactReply(selections, deps(TWICE));
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
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.viewers).toHaveLength(1);
    expect(result.viewers[0]?.stage).toBe("whole-symbol");
    expect(result.viewers[0]?.occurrences).toHaveLength(1);
  });

  test("an ambiguous editor fails at the matcher stage with its cascade cause", () => {
    const selections = parseSelection(
      "select function twice in a.ts\nmatch `return 1;`\nreplace with\n``````\nreturn 2;\n``````\nend",
    );
    const result = resolveCompactReply(selections, deps(TWICE));
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("matcher");
    expect(result.failures[0]?.cause).toBe("matcher-ambiguous");
  });

  test("a malformed regex fails as regex-invalid on the matcher stage", () => {
    const selections = parseSelection(
      "select function once in a.ts\nmatch /(/\nreplace with\n``````\nreturn 2;\n``````\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.failures[0]?.stage).toBe("matcher");
    expect(result.failures[0]?.cause).toBe("regex-invalid");
  });

  test("a matched unresolvable address fails at the address stage with the undeclared name", () => {
    const selections = parseSelection(
      "select function missing in a.ts\nmatch `return 1;`\nreplace with\n``````\nreturn 2;\n``````\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.undeclaredName).toBe("missing");
  });

  test("a whole-declaration editor on an undeclared name resolves to a create region", () => {
    const selections = parseSelection(
      "select function missing in a.ts\nreplace with\n``````\nfunction missing(): number {\n  return 0;\n}\n``````\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
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
    const result = resolveCompactReply(selections, deps(""));
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("const NEW = 1;\n");
  });

  test("a no-kind whole-declaration editor on an undeclared name also creates", () => {
    const selections = parseSelection(
      "select missing in a.ts\nreplace with\n``````\nfunction missing(): number {\n  return 0;\n}\n``````\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.create).toBe(true);
    // No kind was given, so the locator kind is the empty string.
    expect(result.regions[0]?.locator.kind).toBe("");
  });

  test("a no-kind clause resolves a declaration of any kind", () => {
    // The empty kind is the compact wildcard: path + name only.
    const selections = parseSelection(
      "select once in a.ts\nreplace with\n``````\nfunction once(): number {\n  return 2;\n}\n``````\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.create).toBe(false);
    expect(result.regions[0]?.stage).toBe("whole-symbol");
  });

  test("the compact address selects a function under resolve value", () => {
    const result = resolveCompactReply(
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
      const result = resolveCompactReply(
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
    const result = resolveCompactReply(
      parseSelection("select Dual in a.ts\nreplace with\n``````\n42\n``````\nend"),
      deps(source),
    );
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.undeclaredName).toBeNull();
  });

  test("a resolve space with no matching declaration fails and never creates", () => {
    const source = "interface Thing {}\nconst Thing = 1;\n";
    const result = resolveCompactReply(
      parseSelection(
        "select Thing in a.ts resolve namespace\nreplace with\n``````\n42\n``````\nend",
      ),
      deps(source),
    );
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("address");
    // The name exists in other spaces, so implicit create must not run.
    expect(result.failures[0]?.undeclaredName).toBeNull();
    expect(result.failures[0]?.diagnostics).toContain('"value"');
    expect(result.failures[0]?.diagnostics).toContain('"type"');
  });

  test("a no-resolve non-declaration body creates a let binding", () => {
    const selections = parseSelection(
      "select missing in a.ts\nreplace with\n``````\n42\n``````\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\nlet missing = 42;\n");
  });

  test("a resolve value non-declaration body creates a let binding", () => {
    const selections = parseSelection(
      "select missing in a.ts resolve value\nreplace with\n``````\n42\n``````\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\nlet missing = 42;\n");
  });

  test("a resolve type non-declaration body creates a type alias", () => {
    const selections = parseSelection(
      "select missing in a.ts resolve type\nreplace with\n``````\n{ n: number }\n``````\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\ntype missing = { n: number };\n");
  });

  test("a resolve namespace non-declaration body creates a namespace block", () => {
    const selections = parseSelection(
      "select missing in a.ts resolve namespace\nreplace with\n``````\n42\n``````\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("\nnamespace missing {\n42\n}\n");
  });

  const COMPLETE = "function missing(): number {\n  return 0;\n}";

  for (const space of [null, "value", "type", "namespace"] as const) {
    test(`a complete declaration body is appended verbatim${
      space === null ? "" : ` under resolve ${space}`
    }`, () => {
      const resolve = space === null ? "" : ` resolve ${space}`;
      const selections = parseSelection(
        `select missing in a.ts${resolve}\nreplace with\n\`\`\`\`\`\`\n${COMPLETE}\n\`\`\`\`\`\`\nend`,
      );
      const result = resolveCompactReply(selections, deps(ONCE));
      expect(result.failures).toEqual([]);
      expect(result.regions[0]?.create).toBe(true);
      expect(result.regions[0]?.text).toBe(`\n${COMPLETE}\n`);
    });
  }

  test("a match on an undeclared name is not a create", () => {
    const selections = parseSelection(
      "select function missing in a.ts\nmatch `return 1;`\nreplace with\n``````\nreturn 2;\n``````\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
  });

  test("an empty fence on an undeclared name is not a create", () => {
    const selections = parseSelection(
      "select function missing in a.ts\nreplace with\n``````\n``````\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
  });

  test("a viewer on an undeclared name is not a create", () => {
    const selections = parseSelection("select function missing in a.ts\nend");
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.viewers).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
  });

  test("a bare viewer renders the whole declaration once, unmarked", () => {
    const selections = parseSelection("select answer in src/helper.ts resolve value end");
    const result = resolveCompactReply(selections, deps(ONCE.replace(/once/g, "answer")));
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
        "Reply with an edit clause (add `replace`) or narrow a viewer with `pick`.",
      ].join("\n"),
    );
  });

  test("a match viewer marks the matched line in the declaration block", () => {
    const selections = parseSelection(
      "select answer in src/helper.ts resolve value\nmatch `return 1;`\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE.replace(/once/g, "answer")));
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
        "Reply with an edit clause (add `replace`) or narrow a viewer with `pick`.",
      ].join("\n"),
    );
  });

  test("a multi-candidate viewer marks every line and renders the declaration once", () => {
    const selections = parseSelection("select function twice in a.ts\nmatch `return 1;`\nend");
    const result = resolveCompactReply(selections, deps(TWICE));
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
        "Reply with an edit clause (add `replace`) or narrow a viewer with `pick`.",
      ].join("\n"),
    );
  });

  test("a viewer with no occurrences keeps the empty marker and skips the block", () => {
    const selections = parseSelection("select function twice in a.ts\nmatch `return 9;`\nend");
    const result = resolveCompactReply(selections, deps(TWICE));
    expect(result.viewers).toHaveLength(1);
    expect(result.viewers[0]?.occurrences).toEqual([]);
    expect(renderViewerFeedback(result.viewers)).toBe(
      [
        "Located occurrences (viewer clauses write nothing):",
        "",
        "select function twice in a.ts",
        "  (no occurrences)",
        "",
        "Reply with an edit clause (add `replace`) or narrow a viewer with `pick`.",
      ].join("\n"),
    );
  });

  test("a viewer that fails its matcher reports stage matcher and renders no block", () => {
    const selections = parseSelection("select function twice in a.ts\nmatch /(/\nend");
    const result = resolveCompactReply(selections, deps(TWICE));
    expect(result.viewers).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("matcher");
    expect(result.failures[0]?.diagnostics).toContain("stage: matcher");
  });

  test("a viewer with an invalid pick range reports stage range and renders no block", () => {
    const selections = parseSelection(
      "select function twice in a.ts\nmatch `return 1;`\npick 99\nend",
    );
    const result = resolveCompactReply(selections, deps(TWICE));
    expect(result.viewers).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("range");
    expect(result.failures[0]?.diagnostics).toContain("stage: range");
  });
});
