import { describe, expect, test } from "bun:test";
import { resolveFileSelection } from "./module-boundary";
import type { FileSelectionResolution } from "./module-boundary";
import { parseSelection } from "./selection";

const BEGIN = "TC_EDIT_BEGIN";
const END = "TC_EDIT_END";

function replace(body: string): string {
  const lines = ["replace with", BEGIN];
  if (body !== "") {
    lines.push(body);
  }
  lines.push(END);
  return lines.join("\n");
}

function resolve(source: string, reply: string): FileSelectionResolution {
  const selection = parseSelection(reply)[0];
  if (selection === undefined) {
    throw new Error("expected one selection");
  }
  return resolveFileSelection(source, selection);
}

const CALLBACK = [
  'import { test } from "bun:test";',
  "",
  'test("answer", () => {',
  "  const value = 1;",
  "  if (value === 1) {",
  '    console.log("ok");',
  "  }",
  "});",
  "",
].join("\n");

describe("file-level unique span resolution (#83)", () => {
  test("edits an incomplete block header literally inside a test callback", () => {
    const result = resolve(
      CALLBACK,
      ["select file a.test.ts", "match `if (value === 1) {`", replace("if (value === 2) {")].join(
        "\n",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.start).toBe(CALLBACK.indexOf("if (value === 1) {"));
    expect(result.end).toBe(CALLBACK.indexOf("if (value === 1) {") + "if (value === 1) {".length);
    expect(result.stage).toBe("match");
    expect(result.gateStart).toBe(result.start);
  });

  test("edits a nested statement structurally", () => {
    const result = resolve(
      CALLBACK,
      ["select file a.test.ts", 'match `console.log("ok");`', replace('console.log("done");')].join(
        "\n",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.start).toBe(CALLBACK.indexOf('console.log("ok");'));
    expect(result.end).toBe(CALLBACK.indexOf('console.log("ok");') + 'console.log("ok");'.length);
  });

  test("edits a template-literal body through a regex", () => {
    const source = "const message = `hello ${name}`;\n";
    const result = resolve(
      source,
      ["select file a.ts", "match /hello/", replace("goodbye")].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(source.slice(result.start, result.end)).toBe("hello");
  });

  test("edits a picked span with file-absolute coordinates", () => {
    const result = resolve(
      CALLBACK,
      ["select file a.test.ts", "pick 5:3-5:20", replace("if (value === 2) {")].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.start).toBe(CALLBACK.indexOf("if (value === 1) {"));
    expect(CALLBACK.slice(result.start, result.end)).toBe("if (value === 1) {");
    expect(result.stage).toBe("pick");
  });

  test("an empty fence deletes exactly the matched span outside a module statement", () => {
    const source = ["function work(): number {", "  return 1;", "}", ""].join("\n");
    const result = resolve(
      source,
      ["select file a.ts", "match `return 1;`", replace("")].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(source.slice(result.start, result.end)).toBe("return 1;");
  });

  test("still expands a whole import deletion to its line", () => {
    const source = 'import { a } from "./a";\nconst value = a;\n';
    const result = resolve(
      source,
      ["select file a.ts", 'match `import { a } from "./a";`', replace("")].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.start).toBe(0);
    expect(result.end).toBe('import { a } from "./a";\n'.length);
  });

  test("still expands a named specifier deletion to its separator", () => {
    const source = 'import { alpha, beta } from "./values";\n';
    const result = resolve(source, ["select file a.ts", "match `beta`", replace("")].join("\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(source.slice(result.start, result.end)).toBe(", beta");
  });

  test("labels ambiguity candidates by module statement or other source", () => {
    const source = [
      'import "side-effect";',
      'import "side-effect";',
      'console.log("side-effect");',
      "",
    ].join("\n");
    const result = resolve(
      source,
      ["select file a.ts", "match /side-effect/", replace("changed")].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("matcher");
    expect(result.diagnostics).toContain("a.ts:1:9 (import statement)");
    expect(result.diagnostics).toContain("a.ts:3:14 (declaration/other source)");
    expect(result.diagnostics).toContain("exactly one unique span");
    expect(result.diagnostics).not.toContain("outside an import/export");
  });

  test("still rejects a bare file select without match or pick", () => {
    const result = resolve(
      "const value = 1;\n",
      ["select file a.ts", replace("const value = 2;")].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("address");
    expect(result.diagnostics).toContain("needs `match` or `pick`");
    expect(result.diagnostics).toContain("whole-file");
  });

  test("reports a missing replacement as an address failure with the native hint", () => {
    const result = resolve(
      "const value = 1;\n",
      ["select file a.ts", "match `const value = 1;`", "end"].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("address");
    expect(result.diagnostics).toContain("requires `replace with <fence>`");
    expect(result.diagnostics).toContain("--replace-file");
  });
});
