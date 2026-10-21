import { describe, expect, test } from "bun:test";
import { renderViewerFeedback, resolveCompactReply } from "./compact";
import type { CompactDeps } from "./compact";
import { parseSelection } from "./selection";
import { buildIndexTolerant } from "./utility";

const TWICE = ["export function twice(): number {", "  return 1;", "  return 1;", "}", ""].join(
  "\n",
);

const ONCE = ["export function once(): number {", "  return 1;", "}", ""].join("\n");

function deps(source: string): CompactDeps {
  return {
    sourceFor: () => source,
    resolveEntry: (current, currentPath, locator) => {
      const { index } = buildIndexTolerant([{ path: currentPath, source: current }]);
      const matches = index.lookup(locator);
      const entry = matches[0];
      if (matches.length === 1 && entry !== undefined) {
        return { ok: true, entry };
      }
      return {
        ok: false,
        diagnostics: "stage: address\nno unique declaration",
        // Mirror `resolveCurrentEntry`: the name is undeclared only when it is
        // absent under every kind, not merely under the requested one.
        undeclared: index.byName(locator.name).length === 0,
      };
    },
  };
}

describe("resolveCompactReply (#111)", () => {
  test("resolves an editor clause with its cascade stage and matcher kind", () => {
    const selections = parseSelection(
      "select function once in a.ts\nmatch `return 1;`\nreplace with\n```\nreturn 2;\n```\nend",
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
      "select function once in a.ts\nreplace with\n```\nfunction once(): number {\n  return 2;\n}\n```\nend",
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
      "select function twice in a.ts\nmatch `return 1;`\nreplace with\n```\nreturn 2;\n```\nend",
    );
    const result = resolveCompactReply(selections, deps(TWICE));
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("matcher");
    expect(result.failures[0]?.cause).toBe("matcher-ambiguous");
  });

  test("a malformed regex fails as regex-invalid on the matcher stage", () => {
    const selections = parseSelection(
      "select function once in a.ts\nmatch /(/\nreplace with\n```\nreturn 2;\n```\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.failures[0]?.stage).toBe("matcher");
    expect(result.failures[0]?.cause).toBe("regex-invalid");
  });

  test("a matched unresolvable address fails at the address stage with the undeclared name", () => {
    const selections = parseSelection(
      "select function missing in a.ts\nmatch `return 1;`\nreplace with\n```\nreturn 2;\n```\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.undeclaredName).toBe("missing");
  });

  test("a whole-declaration editor on an undeclared name resolves to a create region", () => {
    const selections = parseSelection(
      "select function missing in a.ts\nreplace with\n```\nfunction missing(): number {\n  return 0;\n}\n```\nend",
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
      "select const NEW in src/new.ts\nreplace with\n```\nconst NEW = 1;\n```\nend",
    );
    const result = resolveCompactReply(selections, deps(""));
    expect(result.regions[0]?.create).toBe(true);
    expect(result.regions[0]?.text).toBe("const NEW = 1;\n");
  });

  test("a no-kind whole-declaration editor on an undeclared name also creates", () => {
    const selections = parseSelection(
      "select missing in a.ts\nreplace with\n```\nfunction missing(): number {\n  return 0;\n}\n```\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.create).toBe(true);
    // No kind was given, so the locator kind is the empty string.
    expect(result.regions[0]?.locator.kind).toBe("");
  });

  test("a no-kind clause whose name exists under another kind is not a create", () => {
    // `once` is declared as a function; a no-kind locator does not match it, but
    // the name is not undeclared either, so it stays an address failure.
    const selections = parseSelection(
      "select once in a.ts\nreplace with\n```\nfunction once(): number {\n  return 2;\n}\n```\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.undeclaredName).toBeNull();
  });

  test("a match on an undeclared name is not a create", () => {
    const selections = parseSelection(
      "select function missing in a.ts\nmatch `return 1;`\nreplace with\n```\nreturn 2;\n```\nend",
    );
    const result = resolveCompactReply(selections, deps(ONCE));
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
  });

  test("an empty fence on an undeclared name is not a create", () => {
    const selections = parseSelection(
      "select function missing in a.ts\nreplace with\n````\n````\nend",
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

  test("renderViewerFeedback names each candidate by file-absolute line:col with a numbered snippet", () => {
    const selections = parseSelection("select function twice in a.ts\nmatch `return 1;`\nend");
    const result = resolveCompactReply(selections, deps(TWICE));
    const text = renderViewerFeedback(result.viewers);
    expect(text).toContain("a.ts:2:3");
    expect(text).toContain("a.ts:3:3");
    expect(text).toContain("2 |   return 1;");
    expect(text).toContain("viewer clauses write nothing");
  });
});
