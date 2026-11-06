import { describe, expect, test } from "bun:test";
import {
  BLOCK_MARKER_MIN_LINES,
  collectBlockInfos,
  renderUnifyView,
  resolveBlockSelection,
  unifyLines,
} from "./block-select";
import type { BlockSelectionResolution } from "./block-select";
import { Parser } from "./parser";
import { parseSelection } from "./selection";

const BEGIN = "TC_EDIT_BEGIN";
const END = "TC_EDIT_END";

const OUTER = [
  "export function outer(): number {",
  "  let total = 0;",
  "  if (true) {",
  "    total += 1;",
  "    total += 2;",
  "    total += 3;",
  "    total += 4;",
  "    total += 5;",
  "    total += 6;",
  "  }",
  "  return total;",
  "}",
  "",
].join("\n");

const CLASS = [
  "class Parser {",
  "  parse(): number {",
  "    let x = 0;",
  "    if (x === 0) {",
  "      x += 1;",
  "      x += 2;",
  "      x += 3;",
  "      x += 4;",
  "      x += 5;",
  "      x += 6;",
  "    }",
  "    return x;",
  "  }",
  "}",
  "",
].join("\n");

function replace(body: string): string {
  const lines = ["replace with", BEGIN];
  if (body !== "") {
    lines.push(body);
  }
  lines.push(END);
  return lines.join("\n");
}

function resolve(source: string, reply: string): BlockSelectionResolution {
  const selection = parseSelection(reply)[0];
  if (selection === undefined) {
    throw new Error("expected one selection");
  }
  return resolveBlockSelection(source, selection);
}

function annotated(source: string, minLines?: number): string {
  return unifyLines(source, "a.ts", minLines)
    .map((line) => `${line.text}${line.markers.map((id) => ` // ${id}`).join("")}`)
    .join("\n");
}

describe("block markers (#84)", () => {
  test("marks nested blocks in source preorder with the default threshold", () => {
    const blocks = collectBlockInfos(OUTER, "a.ts");
    expect(blocks.map((block) => block.id)).toEqual(["outer:1", "outer:2"]);
    expect(blocks.map((block) => [block.startLine, block.endLine])).toEqual([
      [1, 12],
      [3, 10],
    ]);

    const lines = unifyLines(OUTER, "a.ts");
    expect(lines).toHaveLength(12);
    expect(lines[0]).toMatchObject({ line: 1, markers: ["outer:1"] });
    expect(lines[2]).toMatchObject({ line: 3, markers: ["outer:2"] });
    expect(lines[1]?.text).toBe("  let total = 0;");
    expect(lines[1]?.markers).toEqual([]);
  });

  test("uses the nearest method address for a class method", () => {
    const blocks = collectBlockInfos(CLASS, "a.ts");
    expect(blocks.map((block) => block.id)).toEqual(["Parser.parse:1", "Parser.parse:2"]);
    expect(blocks.map((block) => block.startLine)).toEqual([2, 4]);

    const markers = unifyLines(CLASS, "a.ts").filter((line) => line.markers.length > 0);
    expect(markers.map((line) => [line.line, line.markers])).toEqual([
      [2, ["Parser.parse:1"]],
      [4, ["Parser.parse:2"]],
    ]);
  });

  test("--unify-min-lines changes which blocks are marked without changing IDs", () => {
    const nine = unifyLines(OUTER, "a.ts", 9).filter((line) => line.markers.length > 0);
    expect(nine.map((line) => line.markers)).toEqual([["outer:1"]]);

    const none = unifyLines(OUTER, "a.ts", 13).filter((line) => line.markers.length > 0);
    expect(none).toEqual([]);

    const all = unifyLines(CLASS, "a.ts", 0).filter((line) => line.markers.length > 0);
    expect(all.map((line) => line.markers)).toEqual([["Parser.parse:1"], ["Parser.parse:2"]]);
    expect(collectBlockInfos(CLASS, "a.ts").map((block) => block.id)).toEqual([
      "Parser.parse:1",
      "Parser.parse:2",
    ]);
  });

  test("appends a marker after an existing line comment and stays parseable", () => {
    const source = [
      "export function f(): number {",
      "  if (true) { // keep this",
      "    let x = 0;",
      "    x += 1;",
      "    x += 2;",
      "    x += 3;",
      "    x += 4;",
      "    x += 5;",
      "  }",
      "  return 0;",
      "}",
      "",
    ].join("\n");
    const line = unifyLines(source, "a.ts").find((entry) => entry.line === 2);
    expect(line?.text).toBe("  if (true) { // keep this");
    expect(line?.markers).toEqual(["f:2"]);
    const rendered = annotated(source);
    expect(rendered.split("\n")[1]).toBe("  if (true) { // keep this // f:2");
    expect(() => new Parser(rendered).parseProgram()).not.toThrow();
  });

  test("keeps 1-based file-absolute line numbers and the source line count", () => {
    const lines = unifyLines(OUTER, "a.ts");
    expect(lines.map((line) => line.line)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(lines[0]?.text).toBe("export function outer(): number {");
    expect(lines[11]?.text).toBe("}");
    const view = renderUnifyView(OUTER, "a.ts");
    expect(view).toContain(" 1 | export function outer(): number { // outer:1");
    expect(view).toContain(" 2 |   let total = 0;");
    expect(view).toContain(" 3 |   if (true) { // outer:2");
    expect(view).toContain(`a.ts (unified view, 12 lines`);
  });

  test("uses <module> for a top-level unscoped block", () => {
    const source = ["if (true) {", "  let x = 1;", "}", ""].join("\n");
    expect(collectBlockInfos(source, "a.ts").map((block) => block.id)).toEqual(["<module>:1"]);
  });

  test("suffixes colliding display names with the declaration start line", () => {
    const source = [
      "namespace A { export function run(): number { let x = 1; return x; } }",
      "namespace A { export function run(): number { let y = 2; return y; } }",
      "",
    ].join("\n");
    const ids = collectBlockInfos(source, "a.ts").map((block) => block.id);
    expect(ids).toEqual(["A.run@1:1", "A.run@2:1"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("falls back to <module> when no declaration contains the block", () => {
    const source = [
      "for (let i = 0; i < 10; i += 1) {",
      "  if (i > 1) {",
      "    console.log(i);",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(collectBlockInfos(source, "a.ts").map((block) => block.id)).toEqual([
      "<module>:1",
      "<module>:2",
    ]);
    expect(BLOCK_MARKER_MIN_LINES).toBe(8);
  });
});

describe("select block resolution (#84)", () => {
  test("edits the full brace span by default", () => {
    const result = resolve(
      OUTER,
      ["select block outer:2 in a.ts", replace(["{"].join("\n"))].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.start).toBe(OUTER.indexOf("if (true) {") + "if (true) ".length);
    expect(OUTER.slice(result.start, result.end)).toBe(
      [
        "{",
        "    total += 1;",
        "    total += 2;",
        "    total += 3;",
        "    total += 4;",
        "    total += 5;",
        "    total += 6;",
        "  }",
      ].join("\n"),
    );
    expect(result.stage).toBe("whole-symbol");
  });

  test("an empty fence deletes exactly the selected block", () => {
    const result = resolve(OUTER, ["select block outer:2 in a.ts", replace("")].join("\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(OUTER.slice(result.start, result.end).startsWith("{")).toBe(true);
    expect(OUTER.slice(result.start, result.end).endsWith("  }")).toBe(true);
    expect(result.text).toBe("");
  });

  test("narrows with a structural match", () => {
    const result = resolve(
      OUTER,
      ["select block outer:2 in a.ts", "match `total += 2;`", replace("total += 42;")].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(OUTER.slice(result.start, result.end)).toBe("total += 2;");
    expect(result.stage).toBe("match");
  });

  test("narrows with file-absolute pick coordinates", () => {
    const result = resolve(
      OUTER,
      ["select block outer:2 in a.ts", "pick 4", replace("    total += 42;")].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(OUTER.slice(result.start, result.end)).toBe("    total += 1;");
    expect(result.stage).toBe("pick");
  });

  test("intersects match and pick", () => {
    const result = resolve(
      OUTER,
      ["select block outer:2 in a.ts", "match `total += 2;`", "pick 5", replace("x")].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(OUTER.slice(result.start, result.end)).toBe("total += 2;");
  });

  test("an unknown block ID fails at address with the --unify hint", () => {
    const result = resolve(OUTER, ["select block outer:99 in a.ts", replace("x")].join("\n"));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("address");
    expect(result.diagnostics).toContain("outer:99");
    expect(result.diagnostics).toContain("--unify");
  });

  test("an ambiguous match fails at matcher", () => {
    const result = resolve(
      OUTER,
      ["select block outer:1 in a.ts", "match /total/", replace("x")].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("matcher");
    expect(result.diagnostics).toContain("resolves to 8 spans");
  });

  test("a match and pick that do not intersect fail at matcher", () => {
    const result = resolve(
      OUTER,
      ["select block outer:2 in a.ts", "match `total += 2;`", "pick 6", replace("x")].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("matcher");
    expect(result.diagnostics).toContain("intersect no candidate");
  });

  test("a pick outside the block fails at range", () => {
    const result = resolve(
      OUTER,
      ["select block outer:2 in a.ts", "pick 11", replace("x")].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("range");
    expect(result.diagnostics).toContain("outside");
  });

  test("a multi-range pick without match fails at range", () => {
    const result = resolve(
      OUTER,
      ["select block outer:2 in a.ts", "pick {4, 5}", replace("x")].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("range");
    expect(result.diagnostics).toContain("exactly one");
  });

  test("an identical replacement fails at no-op", () => {
    const blockText = OUTER.slice(
      OUTER.indexOf("if (true) {") + "if (true) ".length,
      OUTER.indexOf("  return total;") - 1,
    );
    const result = resolve(OUTER, ["select block outer:2 in a.ts", replace(blockText)].join("\n"));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("no-op");
  });

  test("a missing replacement fails at address", () => {
    const result = resolve(OUTER, "select block outer:2 in a.ts end");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("address");
    expect(result.diagnostics).toContain("requires `replace with <fence>`");
  });

  test("a file that does not parse fails at address", () => {
    const result = resolve(
      "export function broken( {",
      ["select block broken:1 in a.ts", replace("x")].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("address");
    expect(result.diagnostics).toContain("does not parse");
  });
});

describe("block pick before/after anchors (#93)", () => {
  test("inserts after a unique literal span inside the block", () => {
    const result = resolve(
      OUTER,
      [
        "select block outer:2 in a.ts",
        "pick after `total += 2;`",
        replace("    total += 42;"),
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const point = OUTER.indexOf("total += 2;") + "total += 2;".length;
    expect(result.start).toBe(point);
    expect(result.end).toBe(point);
    expect(result.stage).toBe("match");
  });

  test("inserts before a unique literal span inside the block", () => {
    const result = resolve(
      OUTER,
      ["select block outer:2 in a.ts", "pick before `total += 1;`", replace("    // first")].join(
        "\n",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.start).toBe(OUTER.indexOf("total += 1;"));
    expect(result.end).toBe(result.start);
  });

  test("zero matches fail at matcher", () => {
    const result = resolve(
      OUTER,
      ["select block outer:2 in a.ts", "pick after `total += 9;`", replace("x")].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("matcher");
    expect(result.diagnostics).toContain("matched nothing");
  });

  test("multiple matches fail as ambiguous with candidate lines", () => {
    const result = resolve(
      OUTER,
      ["select block outer:2 in a.ts", "pick after /total \\+= /", replace("x")].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("matcher");
    expect(result.diagnostics).toContain("matches 6 places");
    expect(result.diagnostics).toContain("candidates:");
  });

  test("an anchor outside the block is not a candidate", () => {
    const result = resolve(
      OUTER,
      ["select block outer:2 in a.ts", "pick before `let total = 0;`", replace("x")].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("matcher");
  });

  test("an empty fence anchor is a no-op", () => {
    const result = resolve(
      OUTER,
      ["select block outer:2 in a.ts", "pick after `total += 2;`", replace("")].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe("no-op");
  });
});
