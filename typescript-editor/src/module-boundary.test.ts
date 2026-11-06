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

const BIG_FILE = ["const first = 1;", `${"x".repeat(9_000)}`, "const last = 2;", ""].join("\n");

describe("file-level pick ranges in a large file (#90)", () => {
  test("resolves a pick near the start of a file over the old limit", () => {
    expect(BIG_FILE.length).toBeGreaterThan(8_000);
    const result = resolve(
      BIG_FILE,
      ["select file a.ts", "pick 1:7-1:11", replace("alpha")].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(BIG_FILE.slice(result.start, result.end)).toBe("first");
    expect(result.stage).toBe("pick");
  });

  test("resolves a pick near the end of a file over the old limit", () => {
    const result = resolve(
      BIG_FILE,
      ["select file a.ts", "pick 3:7-3:10", replace("omega")].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(BIG_FILE.slice(result.start, result.end)).toBe("last");
    expect(result.stage).toBe("pick");
  });

  test("an out-of-bounds pick still fails in a large file", () => {
    const result = resolve(BIG_FILE, ["select file a.ts", "pick 99", replace("x")].join("\n"));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("range");
    expect(result.diagnostics).toContain("out-of-bounds");
  });
});

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
    expect(result.diagnostics).toContain("needs `match`, `pick`, or a `pick before|after` anchor");
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

describe("file-level pick before/after anchors (#93)", () => {
  const SOURCE = [
    'import { test } from "bun:test";',
    "",
    "const value = 1;",
    "export function once(): number {",
    "  return value;",
    "}",
    "",
  ].join("\n");

  function anchored(position: "before" | "after", matcher: string, body = "// inserted"): string {
    return ["select file a.ts", `pick ${position} ${matcher}`, replace(body)].join("\n");
  }

  test("inserts after a unique literal span", () => {
    const result = resolve(SOURCE, anchored("after", "`const value = 1;`"));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const point = SOURCE.indexOf("const value = 1;") + "const value = 1;".length;
    expect(result.start).toBe(point);
    expect(result.end).toBe(point);
    expect(result.stage).toBe("match");
    expect(result.gateStart).toBe(point);
  });

  test("inserts before a unique literal span", () => {
    const result = resolve(SOURCE, anchored("before", "`export function once`"));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.start).toBe(SOURCE.indexOf("export function once"));
    expect(result.end).toBe(result.start);
  });

  test("accepts a regex anchor", () => {
    const result = resolve(SOURCE, anchored("after", "/return value;/"));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.start).toBe(SOURCE.indexOf("return value;") + "return value;".length);
  });

  test("zero matches fail at matcher with the file-level wording", () => {
    const result = resolve(SOURCE, anchored("after", "`return missing;`"));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("matcher");
    expect(result.diagnostics).toContain("file-level `pick after`");
    expect(result.diagnostics).toContain("matched nothing");
  });

  test("multiple matches list candidate lines", () => {
    const result = resolve(SOURCE, anchored("after", "`value`"));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("matcher");
    expect(result.diagnostics).toContain("matches 2 places");
    expect(result.diagnostics).toContain("candidates:");
    expect(result.diagnostics).toContain("a.ts:3:7");
    expect(result.diagnostics).toContain("a.ts:5:10");
  });

  test("an empty fence anchor is a no-op failure", () => {
    const result = resolve(SOURCE, anchored("after", "`const value = 1;`", ""));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("no-op");
    expect(result.diagnostics).toContain("does not change the file");
  });

  test("an invalid regex anchor fails at matcher", () => {
    const result = resolve(SOURCE, anchored("after", "/[a-/"));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("matcher");
    expect(result.diagnostics).toContain("`/regex/` anchor is invalid");
  });
});
