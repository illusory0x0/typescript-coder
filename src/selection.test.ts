import { describe, expect, test } from "bun:test";
import { renderDslIssues } from "./dsl-diagnostics";
import { EDIT_DSL_EXAMPLE_FORMS } from "./prompts/edit-dsl";
import {
  END_OF_LINE_COLUMN,
  SelectionSyntaxError,
  parseMultiEditor,
  parseMultiEditorDetailed,
  parseSelection,
  parseSelectionDetailed,
  serializeMultiEditor,
  serializeSelection,
  serializeSelections,
} from "./selection";
import type { Selection } from "./selection";

const BEGIN = "TC_EDIT_BEGIN";
const END = "TC_EDIT_END";
const LEGACY_TICKS = "``````";
const LEGACY_DASH = "-----";

function first(text: string): Selection {
  const selections = parseSelection(text);
  const selection = selections[0];
  if (selection === undefined) {
    throw new Error("expected at least one selection");
  }
  return selection;
}

function expectSyntax(text: string, fragment: string): SelectionSyntaxError {
  let caught: unknown;
  try {
    parseSelection(text);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SelectionSyntaxError);
  const error = caught as SelectionSyntaxError;
  expect(error.stage).toBe("syntax");
  expect(error.diagnostics.startsWith("stage: syntax\n")).toBe(true);
  expect(error.diagnostics).toContain(fragment);
  return error;
}

describe("parseSelection", () => {
  test("parses a viewer of the whole declaration", () => {
    expect(parseSelection("select function clamp in src/math.ts\nend")).toEqual([
      {
        locator: { path: "src/math.ts", name: "clamp", kind: "function" },
        space: null,
        matcher: null,
        pick: null,
        replacement: null,
      },
    ]);
  });

  test("an empty or whitespace-only reply is no clauses", () => {
    expect(parseSelection("")).toEqual([]);
    expect(parseSelection("  \n\t\n ")).toEqual([]);
  });

  test("treats all whitespace and newlines as insignificant", () => {
    const one = first("select   function\n   clamp   in   src/math.ts\n  end");
    expect(one.locator).toEqual({ path: "src/math.ts", name: "clamp", kind: "function" });
  });

  test("kind is optional", () => {
    expect(first("select clamp in src/math.ts end").locator).toEqual({
      path: "src/math.ts",
      name: "clamp",
      kind: "",
    });
  });

  test("a symbol may be spelled like a kind when followed by `in`", () => {
    expect(first("select function in a.ts end").locator).toEqual({
      path: "a.ts",
      name: "function",
      kind: "",
    });
  });

  test("parses the resolve header after the path", () => {
    const selection = first("select answer in main.ts resolve value end");
    expect(selection.locator).toEqual({ path: "main.ts", name: "answer", kind: "" });
    expect(selection.space).toBe("value");
  });

  test("parses each admitted resolve kind", () => {
    for (const space of ["value", "type", "namespace"] as const) {
      expect(first(`select answer in main.ts resolve ${space} end`).space).toBe(space);
    }
  });

  test("parses a declaration kind and resolve together", () => {
    const selection = first("select function answer in main.ts resolve value end");
    expect(selection.locator).toEqual({
      path: "main.ts",
      name: "answer",
      kind: "function",
    });
    expect(selection.space).toBe("value");
  });

  test("resolve is optional", () => {
    expect(first("select answer in main.ts end").space).toBeNull();
  });

  test("parses a viewer slice with within", () => {
    const selection = first("select function answer in main.ts within 4-12 end");
    expect(selection.locator).toEqual({
      path: "main.ts",
      name: "answer",
      kind: "function",
    });
    expect(selection.within).toEqual([
      { line: 4, column: 1, endLine: 12, endColumn: END_OF_LINE_COLUMN },
    ]);
    expect(selection.replacement).toBeNull();
  });

  test("within is viewer-only", () => {
    expectSyntax(
      `select answer in main.ts within 4-12 replace with\n${BEGIN}\ny\n${END}\nend`,
      "viewer-only slice",
    );
  });

  test("parses a rename clause", () => {
    const selection = first("select value in src/a.ts rename value to total end");
    expect(selection.rename).toEqual({ from: "value", to: "total" });
    expect(selection.pick).toBeNull();
    expect(selection.replacement).toBeNull();
  });

  test("parses a rename after a match", () => {
    const selection = first(
      "select function clamp in src/math.ts\nmatch `Number.isNaN`\nrename clamp to clampTo\nend",
    );
    expect(selection.matcher).toEqual({ kind: "snippet", value: "Number.isNaN" });
    expect(selection.rename).toEqual({ from: "clamp", to: "clampTo" });
  });

  test("parses a dotted rename symbol", () => {
    const selection = first("select std.array.length in src/a.ts\nrename length to size\nend");
    expect(selection.locator.name).toBe("std.array.length");
    expect(selection.rename).toEqual({ from: "length", to: "size" });
  });

  test("parses a match snippet viewer", () => {
    const selection = first("select function clamp in src/math.ts\nmatch `Number.isNaN`\nend");
    expect(selection.matcher).toEqual({ kind: "snippet", value: "Number.isNaN" });
    expect(selection.pick).toBeNull();
    expect(selection.replacement).toBeNull();
  });

  test("parses a regex match with no flags", () => {
    const selection = first("select function tokenize in src/lexer.ts\nmatch /^if \\(/\nend");
    expect(selection.matcher).toEqual({ kind: "regex", value: "^if \\(" });
  });

  test("parses a single-range pick (sugar) as one range", () => {
    const selection = first(
      `select function tokenize in src/lexer.ts\nmatch /^if \\(/\npick 12\nreplace with\n${BEGIN}\ny\n${END}\nend`,
    );
    expect(selection.pick).toEqual([
      { line: 12, column: 1, endLine: 12, endColumn: END_OF_LINE_COLUMN },
    ]);
  });

  test("parses a multi-range pick", () => {
    const selection = first(
      `select function tokenize in src/lexer.ts\nmatch /^if \\(/\npick {10, 12:3-14:5}\nreplace with\n${BEGIN}\ny\n${END}\nend`,
    );
    expect(selection.pick).toEqual([
      { line: 10, column: 1, endLine: 10, endColumn: END_OF_LINE_COLUMN },
      { line: 12, column: 3, endLine: 14, endColumn: 5 },
    ]);
  });

  test("parses a single character range", () => {
    const selection = first(
      `select foo in a.ts\nmatch \`x\`\npick 7:2\nreplace with\n${BEGIN}\ny\n${END}\nend`,
    );
    expect(selection.pick).toEqual([{ line: 7, column: 2, endLine: 7, endColumn: 2 }]);
  });

  test("parses a match + replace editor", () => {
    const text = [
      "select function clamp in src/math.ts",
      "match `Number.isNaN`",
      "replace with",
      BEGIN,
      "Number.isFinite",
      END,
      "end",
    ].join("\n");
    const selection = first(text);
    expect(selection.replacement).toBe("Number.isFinite");
    expect(selection.matcher).toEqual({ kind: "snippet", value: "Number.isNaN" });
  });

  test("parses a bare replace (whole-declaration rewrite)", () => {
    const text = [
      "select const MAX in src/lexer.ts",
      "replace with",
      BEGIN,
      "return 1;",
      END,
      "end",
    ].join("\n");
    const selection = first(text);
    expect(selection.matcher).toBeNull();
    expect(selection.pick).toBeNull();
    expect(selection.replacement).toBe("return 1;");
  });

  test("accepts an inline opener after with", () => {
    const text = [
      "select answer in src/a.ts",
      `replace with ${BEGIN}`,
      "return 2;",
      END,
      "end",
    ].join("\n");
    const detailed = parseSelectionDetailed(text);
    expect(detailed.ok).toBe(true);
    expect(detailed.issues.some((issue) => issue.code === "EDIT_INLINE_FENCE_OPEN")).toBe(true);
    expect(detailed.value?.[0]?.replacement).toBe("return 2;");

    const [statement] = parseMultiEditor(
      [`write src/a.ts with ${BEGIN}`, "export const a = 2;", END].join("\n"),
    );
    expect(statement?.type).toBe("fs");
    if (statement?.type === "fs" && statement.statement.op === "write") {
      expect(statement.statement.replacement).toBe("export const a = 2;");
    } else {
      throw new Error("expected a write statement");
    }
  });

  test("a warning-only inline-fence multi-editor reply is accepted", () => {
    const detailed = parseMultiEditorDetailed(
      [`write src/a.ts with ${BEGIN}`, "export const a = 2;", END].join("\n"),
    );
    expect(detailed.ok).toBe(true);
    expect(detailed.value).toHaveLength(1);
    expect(detailed.issues).toHaveLength(1);
    expect(detailed.issues[0]?.code).toBe("EDIT_INLINE_FENCE_OPEN");
    expect(detailed.issues[0]?.severity).toBe("warning");
  });

  test("renders an inline-fence warning after a real error", () => {
    const detailed = parseMultiEditorDetailed(
      [`write src/a.ts with ${BEGIN}`, "export const a = 2;", END, "nonsense"].join("\n"),
    );
    expect(detailed.ok).toBe(false);
    expect(detailed.issues.map((issue) => issue.code)).toContain("EDIT_INLINE_FENCE_OPEN");
    const rendered = renderDslIssues(detailed.issues);
    expect(rendered.indexOf("code: EDIT_MISSING_FIELD")).toBeLessThan(
      rendered.indexOf("code: EDIT_INLINE_FENCE_OPEN"),
    );
  });

  test("rejects text after an inline opener", () => {
    expectSyntax(
      [`select answer in src/a.ts`, `replace with ${BEGIN} extra`, "return 2;", END, "end"].join(
        "\n",
      ),
      "own line",
    );
  });

  test("parses a delete (empty fence body)", () => {
    const text = [
      "select const MAX_TOKENS in src/lexer.ts",
      "replace with",
      BEGIN,
      END,
      "end",
    ].join("\n");
    expect(first(text).replacement).toBe("");
  });

  test("preserves a multi-line fence body verbatim", () => {
    const body = "if (x) {\n  return 1;\n}";
    const text = ["select foo in a.ts", "replace with", BEGIN, body, END, "end"].join("\n");
    expect(first(text).replacement).toBe(body);
  });

  test("accepts `end` on the line after the close sentinel", () => {
    const text = ["select foo in a.ts replace with", BEGIN, "x", END, "end"].join("\n");
    expect(first(text).replacement).toBe("x");
  });

  test("accepts a body with one or two backticks", () => {
    const text = ["select foo in a.ts", "replace with", BEGIN, "a``b", END, "end"].join("\n");
    expect(first(text).replacement).toBe("a``b");
  });

  test("accepts a body with an eight-backtick line", () => {
    const body = "````````";
    const text = ["select foo in a.ts", "replace with", BEGIN, body, END, "end"].join("\n");
    expect(first(text).replacement).toBe(body);
  });

  test("strips a whole-reply markdown fence with a warning", () => {
    const parsed = parseSelectionDetailed(`\`\`\`\nselect foo in a.ts\nend\n\`\`\``);
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.[0]?.locator).toEqual({ path: "a.ts", name: "foo", kind: "" });
    expect(parsed.issues.some((issue) => issue.code === "EDIT_WHOLE_REPLY_FENCE")).toBe(true);
  });

  test("parses one reply with several clauses", () => {
    const text = [
      "select function clamp in src/math.ts",
      "match `Number.isNaN`",
      "replace with",
      BEGIN,
      "Number.isFinite",
      END,
      "end",
      "",
      "select function sum in src/math.ts",
      "end",
    ].join("\n");
    const selections = parseSelection(text);
    expect(selections).toHaveLength(2);
    expect(selections[1]?.locator).toEqual({
      path: "src/math.ts",
      name: "sum",
      kind: "function",
    });
  });

  test("takes a colon in a path verbatim", () => {
    expect(first("select main in C:/src/a.ts end").locator.path).toBe("C:/src/a.ts");
  });

  test("decodes a backtick and a backslash inside a snippet", () => {
    const backtick = first("select foo in a.ts\nmatch `a\\`b`\nend");
    expect(backtick.matcher).toEqual({ kind: "snippet", value: "a`b" });
    const backslash = first("select foo in a.ts\nmatch `a\\\\b`\nend");
    expect(backslash.matcher).toEqual({ kind: "snippet", value: "a\\b" });
  });

  test("decodes an escaped slash inside a regex", () => {
    const selection = first("select foo in a.ts\nmatch /a\\/b/\nend");
    expect(selection.matcher).toEqual({ kind: "regex", value: "a/b" });
  });
});

describe("parseSelection failures", () => {
  test("names a missing `in <path>`", () => {
    expectSyntax("select foo", "in");
  });

  test("names a missing symbol", () => {
    expectSyntax("select in a.ts end", "symbol");
  });

  test("names a bad kind", () => {
    expectSyntax("select public foo in a.ts end", "kind");
  });

  test("rejects too many header tokens", () => {
    expectSyntax("select a b c in d.ts end", "select");
  });

  test("names an unknown resolve kind with EDIT_UNKNOWN_SPACE", () => {
    expect(expectSyntax("select foo in a.ts resolve function end", "resolve").issues[0]?.code).toBe(
      "EDIT_UNKNOWN_SPACE",
    );
    expectSyntax("select foo in a.ts resolve value, end", "resolve");
  });

  test("names a missing resolve kind", () => {
    expectSyntax("select foo in a.ts resolve end", "value");
  });

  test("rejects a pick without a replace with EDIT_PICK_WITHOUT_REPLACE", () => {
    expect(expectSyntax("select foo in a.ts\npick 10\nend", "pick").issues[0]?.code).toBe(
      "EDIT_PICK_WITHOUT_REPLACE",
    );
    expectSyntax("select foo in a.ts\npick 10\nend", "pick");
    // The diagnostic names both fields the grammar couples.
    expectSyntax("select foo in a.ts\npick 10\nend", "replace");
    expectSyntax("select foo in a.ts\nmatch `x`\npick 10\nend", "replace");
  });

  test("parses a pick without a match when a replace follows", () => {
    const text = [
      "select function tokenize in src/lexer.ts",
      "pick 12:3-14:5",
      "replace with",
      BEGIN,
      "y",
      END,
      "end",
    ].join("\n");
    const selection = first(text);
    expect(selection.matcher).toBeNull();
    expect(selection.pick).toEqual([{ line: 12, column: 3, endLine: 14, endColumn: 5 }]);
    expect(selection.replacement).toBe("y");
  });

  test("parses a pick after a match with a replace", () => {
    const text = [
      "select function tokenize in src/lexer.ts",
      "match `x`",
      "pick 12",
      "replace with",
      BEGIN,
      "y",
      END,
      "end",
    ].join("\n");
    const selection = first(text);
    expect(selection.matcher).toEqual({ kind: "snippet", value: "x" });
    expect(selection.pick).toEqual([
      { line: 12, column: 1, endLine: 12, endColumn: END_OF_LINE_COLUMN },
    ]);
    expect(selection.replacement).toBe("y");
  });

  test("rejects a rename combined with pick with EDIT_RENAME_MIXED", () => {
    expect(
      expectSyntax("select value in a.ts\nrename value to total\npick 1\nend", "rename").issues[0]
        ?.code,
    ).toBe("EDIT_RENAME_MIXED");
    expectSyntax("select value in a.ts\nrename value to total\npick 1\nend", "rename");
    expectSyntax("select value in a.ts\nrename value to total\npick 1\nend", "pick");
    expectSyntax(
      "select value in a.ts\npick 1\nrename value to total\nend",
      "rename cannot be combined with `pick`",
    );
  });

  test("rejects a rename combined with replace", () => {
    expectSyntax(
      `select value in a.ts\nrename value to total\nreplace with\n${BEGIN}\nx\n${END}\nend`,
      "rename cannot be combined with `replace`",
    );
    expectSyntax(
      `select value in a.ts\nreplace with\n${BEGIN}\nx\n${END}\nrename value to total\nend`,
      "rename cannot be combined with `replace`",
    );
  });

  test("names a missing `to`", () => {
    expectSyntax("select value in a.ts\nrename value end", "to");
  });

  test("names an empty rename identifier", () => {
    expectSyntax("select value in a.ts\nrename", "identifier");
    expectSyntax("select value in a.ts\nrename value to", "identifier");
  });

  test("names a mid-clause missing end", () => {
    expectSyntax("select foo in a.ts\nmatch `x`\nnonsense", "end");
  });

  test("recovers a missing end at EOF and before the next clause with a warning", () => {
    const atEof = parseSelectionDetailed("select foo in a.ts\nmatch `x`");
    expect(atEof.ok).toBe(true);
    expect(atEof.issues.some((issue) => issue.code === "EDIT_MISSING_END")).toBe(true);
    expect(atEof.value?.[0]?.matcher).toEqual({ kind: "snippet", value: "x" });
    const beforeNext = parseSelectionDetailed("select foo in a.ts end select bar in b.ts end");
    expect(beforeNext.ok).toBe(true);
    expect(beforeNext.value).toHaveLength(2);
  });

  test("`select` inside a replacement fence is not a clause boundary", () => {
    const text = [
      "select foo in a.ts",
      "replace with",
      BEGIN,
      "select inside the fence",
      END,
      "end",
      "select bar in b.ts",
      "end",
    ].join("\n");
    const parsed = parseSelectionDetailed(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.value).toHaveLength(2);
    expect(parsed.value?.[0]?.replacement).toBe("select inside the fence");
  });

  test("all-or-nothing: one bad clause keeps the parsed value for diagnostics only", () => {
    const parsed = parseSelectionDetailed(
      "select foo in a.ts\nend\nselect bar in b.ts\npick 1\nend",
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.some((issue) => issue.code === "EDIT_PICK_WITHOUT_REPLACE")).toBe(true);
    expect(parsed.value?.length).toBe(1);
    expect(() => parseSelection(serializeSelections(parsed.value ?? []))).not.toThrow();
  });

  test("names trailing junk after `end`", () => {
    expectSyntax("select foo in a.ts\nend\nnonsense", "after `end`");
  });

  test("names an unclosed snippet", () => {
    expectSyntax("select foo in a.ts\nmatch `abc\nend", "snippet");
  });

  test("names an unclosed regex", () => {
    expectSyntax("select foo in a.ts\nmatch /abc\nend", "regex");
  });

  test("names an unclosed sentinel fence with EDIT_UNCLOSED_FENCE", () => {
    const error = expectSyntax(`select foo in a.ts\nreplace with\n${BEGIN}\nfoo\nend`, "fence");
    expect(error.issues[0]?.code).toBe("EDIT_UNCLOSED_FENCE");
    expect(error.truncated).toBe(true);
  });

  test("rejects a legacy six-tick fence with EDIT_LEGACY_FENCE", () => {
    const error = expectSyntax(
      `select foo in a.ts\nreplace with\n${LEGACY_TICKS}\nx\n${LEGACY_TICKS}\nend`,
      BEGIN,
    );
    expect(error.issues[0]?.code).toBe("EDIT_LEGACY_FENCE");
    expect(error.issues[0]?.hint).toContain(BEGIN);
  });

  test("rejects a legacy five-hyphen fence with EDIT_LEGACY_FENCE", () => {
    const error = expectSyntax(
      `select foo in a.ts\nreplace with\n${LEGACY_DASH}\nx\n${LEGACY_DASH}\nend`,
      BEGIN,
    );
    expect(error.issues[0]?.code).toBe("EDIT_LEGACY_FENCE");
  });

  test("rejects a fence-looking opener that is not the sentinel", () => {
    expectSyntax("select foo in a.ts\nreplace with\n```\nx\n```\nend", BEGIN);
    expectSyntax("select foo in a.ts\nreplace with\n----\nx\n----\nend", BEGIN);
  });

  test("rejects trailing text after the close sentinel on the same line", () => {
    const error = expectSyntax(
      `select foo in a.ts\nreplace with\n${BEGIN}\nx\n${END} end`,
      "own line",
    );
    expect(error.issues[0]?.code).toBe("EDIT_FENCE_TRAILING_TEXT");
  });

  test("accepts a raw body with legacy fences, six backticks, done, and end (#25)", () => {
    const body = ["alpha", "-----", "``````", "done", "end", "select inside"].join("\n");
    const [selection] = parseSelection(
      `select foo in a.ts\nreplace with\n${BEGIN}\n${body}\n${END}\nend`,
    );
    expect(selection?.replacement).toBe(body);
  });

  test("accepts leading and trailing whitespace on both sentinel lines", () => {
    const [selection] = parseSelection(
      `select foo in a.ts\nreplace with\n  ${BEGIN}  \n${"x"}\n\t${END}\t\nend`,
    );
    expect(selection?.replacement).toBe("x");
  });

  test("rejects a body containing an exact close sentinel line", () => {
    const text = [
      "select foo in a.ts",
      "replace with",
      BEGIN,
      "before",
      END,
      "after",
      END,
      "end",
    ].join("\n");
    const error = expectSyntax(text, END);
    expect(error.issues[0]?.code).toBe("EDIT_EMBEDDED_FENCE_END");
    expect(error.issues[0]?.hint).toContain(END);
  });

  test("rejects a non-1-based pick coordinate", () => {
    expectSyntax("select foo in a.ts\nmatch `x`\npick 0\nend", "line");
    expectSyntax("select foo in a.ts\nmatch `x`\npick {10, 0}\nend", "line");
  });

  test("rejects a negative pick coordinate", () => {
    expectSyntax("select foo in a.ts\nmatch `x`\npick -5\nend", "line");
  });

  test("rejects an empty pick range set", () => {
    expectSyntax("select foo in a.ts\nmatch `x`\npick {}\nend", "range");
  });

  test("rejects a missing matcher value with EDIT_MATCHER_MISSING", () => {
    expect(expectSyntax("select foo in a.ts\nmatch\nend", "snippet").issues[0]?.code).toBe(
      "EDIT_MATCHER_MISSING",
    );
  });

  test("reports every failing clause with an index and bounds the rendered list", () => {
    const text = Array.from(
      { length: 10 },
      (_, index) => `select foo${index} in a.ts\npick 1\nend`,
    ).join("\n");
    const parsed = parseSelectionDetailed(text);
    expect(parsed.ok).toBe(false);
    const errors = parsed.issues.filter((issue) => issue.severity === "error");
    expect(errors).toHaveLength(10);
    expect(errors[0]?.clauseIndex).toBe(1);
    expect(errors[9]?.clauseIndex).toBe(10);
    try {
      parseSelection(text);
      throw new Error("expected a syntax error");
    } catch (error) {
      expect(error).toBeInstanceOf(SelectionSyntaxError);
      const syntax = error as SelectionSyntaxError;
      expect(syntax.diagnostics).toContain("… 2 more issue(s)");
      expect(syntax.diagnostics).toContain("clause: 1");
    }
  });

  test("no partial selection is produced", () => {
    expect(() =>
      parseSelection("select foo in a.ts\nend\nselect bar in b.ts\npick 1\nend"),
    ).toThrow(SelectionSyntaxError);
  });
});

describe("serializeSelection", () => {
  test("round-trips each optional clause", () => {
    const table: Selection[] = [
      {
        locator: { path: "src/math.ts", name: "clamp", kind: "function" },
        space: null,
        matcher: null,
        pick: null,
        replacement: null,
      },
      {
        locator: { path: "src/math.ts", name: "clamp", kind: "" },
        space: "value",
        matcher: null,
        pick: null,
        within: [{ line: 4, column: 1, endLine: 8, endColumn: END_OF_LINE_COLUMN }],
        replacement: null,
      },
      {
        locator: { path: "src/math.ts", name: "clamp", kind: "" },
        space: "value",
        matcher: { kind: "snippet", value: "Number.isNaN" },
        pick: null,
        replacement: null,
      },
      {
        locator: { path: "src/lexer.ts", name: "tokenize", kind: "function" },
        space: null,
        matcher: { kind: "regex", value: "^if \\(" },
        pick: [{ line: 12, column: 1, endLine: 12, endColumn: END_OF_LINE_COLUMN }],
        replacement: "y",
      },
      {
        locator: { path: "src/lexer.ts", name: "tokenize", kind: "function" },
        space: "namespace",
        matcher: { kind: "snippet", value: "x" },
        pick: [
          { line: 10, column: 1, endLine: 10, endColumn: END_OF_LINE_COLUMN },
          { line: 12, column: 3, endLine: 14, endColumn: 5 },
        ],
        replacement: "y",
      },
      {
        locator: { path: "src/math.ts", name: "clamp", kind: "function" },
        space: null,
        matcher: { kind: "snippet", value: "Number.isNaN" },
        pick: null,
        replacement: "Number.isFinite",
      },
      {
        locator: { path: "src/lexer.ts", name: "MAX_TOKENS", kind: "const" },
        space: null,
        matcher: null,
        pick: null,
        replacement: "",
      },
      {
        locator: { path: "src/math.ts", name: "sum", kind: "function" },
        space: "type",
        matcher: null,
        pick: null,
        replacement: "a\nb\n",
      },
    ];
    for (const selection of table) {
      const text = serializeSelections([selection]);
      expect(parseSelection(text)).toEqual([selection]);
    }
    expect(parseSelection(serializeSelections(table))).toEqual(table);
  });

  test("round-trips a rename clause with a dotted symbol and a match", () => {
    const selection: Selection = {
      locator: { path: "src/a.ts", name: "std.array.length", kind: "" },
      space: null,
      matcher: { kind: "snippet", value: "length" },
      pick: null,
      replacement: null,
      rename: { from: "length", to: "size" },
    };
    const text = serializeSelection(selection);
    expect(text).toBe(
      [
        "select std.array.length in src/a.ts",
        "match `length`",
        "rename length to size",
        "end",
      ].join("\n"),
    );
    expect(parseSelection(text)).toEqual([selection]);
  });

  test("round-trips a rename clause without a match", () => {
    const selection: Selection = {
      locator: { path: "src/a.ts", name: "value", kind: "" },
      space: null,
      matcher: null,
      pick: null,
      replacement: null,
      rename: { from: "value", to: "total" },
    };
    expect(serializeSelection(selection)).toBe(
      "select value in src/a.ts\nrename value to total\nend",
    );
    expect(parseSelection(serializeSelection(selection))).toEqual([selection]);
  });

  test("emits resolve after the path", () => {
    const selection: Selection = {
      locator: { path: "a.ts", name: "answer", kind: "" },
      space: "value",
      matcher: null,
      pick: null,
      replacement: null,
    };
    expect(serializeSelection(selection)).toBe("select answer in a.ts resolve value\nend");
  });

  test("uses the sentinel fence", () => {
    const selection: Selection = {
      locator: { path: "a.ts", name: "foo", kind: "" },
      space: null,
      matcher: null,
      pick: null,
      replacement: "y",
    };
    expect(serializeSelection(selection)).toContain(`${BEGIN}\ny\n${END}`);
  });

  test("serializes a body containing hyphen and backtick runs", () => {
    const selection: Selection = {
      locator: { path: "a.ts", name: "foo", kind: "" },
      space: null,
      matcher: null,
      pick: null,
      replacement: "---\n``````\na---b",
    };
    expect(serializeSelection(selection)).toContain(`${BEGIN}\n---\n\`\`\`\`\`\`\na---b\n${END}`);
    expect(parseSelection(serializeSelection(selection))).toEqual([selection]);
  });

  test("escapes a backtick and a backslash in a snippet", () => {
    const selection: Selection = {
      locator: { path: "a.ts", name: "foo", kind: "" },
      space: null,
      matcher: { kind: "snippet", value: "a`b\\c" },
      pick: null,
      replacement: null,
    };
    expect(serializeSelection(selection)).toBe("select foo in a.ts\nmatch `a\\`b\\\\c`\nend");
    expect(parseSelection(serializeSelection(selection))).toEqual([selection]);
  });

  test("escapes a slash in a regex", () => {
    const selection: Selection = {
      locator: { path: "a.ts", name: "foo", kind: "" },
      space: null,
      matcher: { kind: "regex", value: "a/b" },
      pick: null,
      replacement: null,
    };
    expect(serializeSelection(selection)).toContain("/a\\/b/");
    expect(parseSelection(serializeSelection(selection))).toEqual([selection]);
  });

  test("serializes a body containing three backticks inside the sentinel", () => {
    const selection: Selection = {
      locator: { path: "a.ts", name: "foo", kind: "" },
      space: null,
      matcher: null,
      pick: null,
      replacement: "before\n```\nafter",
    };
    expect(serializeSelection(selection)).toContain(`${BEGIN}\nbefore\n\`\`\`\nafter\n${END}`);
    expect(parseSelection(serializeSelection(selection))).toEqual([selection]);
  });

  test("throws when the body contains the close sentinel line", () => {
    const selection: Selection = {
      locator: { path: "a.ts", name: "foo", kind: "" },
      space: null,
      matcher: null,
      pick: null,
      replacement: `before\n${END}\nafter`,
    };
    expect(() => serializeSelection(selection)).toThrow(SelectionSyntaxError);
    expect(() => serializeSelection(selection)).toThrow(/literal line/);
  });
});

describe("parseMultiEditor", () => {
  test("parses create, delete, read, write, and editor statements", () => {
    const text = [
      "create src/new.ts end",
      "delete src/old.ts end",
      "read src/a.ts within {1, 3:2-4} end",
      "write src/a.ts within 2 with",
      BEGIN,
      "return 2;",
      END,
      "select answer in src/a.ts resolve value end",
    ].join("\n");
    const statements = parseMultiEditor(text);
    expect(statements).toHaveLength(5);
    expect(statements[0]).toEqual({
      type: "fs",
      statement: { op: "create", path: "src/new.ts" },
    });
    expect(statements[1]).toEqual({
      type: "fs",
      statement: { op: "delete", path: "src/old.ts" },
    });
    expect(statements[2]).toEqual({
      type: "fs",
      statement: {
        op: "read",
        path: "src/a.ts",
        ranges: [
          { line: 1, column: 1, endLine: 1, endColumn: END_OF_LINE_COLUMN },
          { line: 3, column: 2, endLine: 4, endColumn: END_OF_LINE_COLUMN },
        ],
      },
    });
    expect(statements[3]).toEqual({
      type: "fs",
      statement: {
        op: "write",
        path: "src/a.ts",
        ranges: [{ line: 2, column: 1, endLine: 2, endColumn: END_OF_LINE_COLUMN }],
        replacement: "return 2;",
      },
    });
    expect(statements[4]?.type).toBe("editor");
  });

  test("write with no within replaces the whole file at EOF", () => {
    const [statement] = parseMultiEditor(
      ["write src/a.ts with", BEGIN, "export const a = 1;", END].join("\n"),
    );
    expect(statement).toEqual({
      type: "fs",
      statement: {
        op: "write",
        path: "src/a.ts",
        ranges: null,
        replacement: "export const a = 1;",
      },
    });
  });

  test("write followed by the next statement parses both", () => {
    const statements = parseMultiEditor(
      ["write src/a.ts with", BEGIN, "x", END, "read src/a.ts end"].join("\n"),
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]?.type).toBe("fs");
    expect(statements[1]).toEqual({
      type: "fs",
      statement: { op: "read", path: "src/a.ts", ranges: null },
    });
  });

  test("write with an empty sentinel body replaces the file with empty text", () => {
    const [statement] = parseMultiEditor(["write src/a.ts with", BEGIN, END].join("\n"));
    expect(statement).toEqual({
      type: "fs",
      statement: { op: "write", path: "src/a.ts", ranges: null, replacement: "" },
    });
  });

  test("rejects the removed angle-bracket sentinel", () => {
    const text = ["write src/a.ts with", "<<<TC_EDIT_BEGIN>>>", "x", "<<<TC_EDIT_END>>>"].join(
      "\n",
    );
    expect(() => parseMultiEditor(text)).toThrow(SelectionSyntaxError);
  });

  test("rejects a legacy write fence with EDIT_LEGACY_FENCE", () => {
    for (const fence of [LEGACY_TICKS, LEGACY_DASH]) {
      try {
        parseMultiEditor(["write src/a.ts with", fence, "x", fence].join("\n"));
        throw new Error("expected a syntax error");
      } catch (error) {
        expect(error).toBeInstanceOf(SelectionSyntaxError);
        const syntax = error as SelectionSyntaxError;
        expect(syntax.issues[0]?.code).toBe("EDIT_LEGACY_FENCE");
        expect(syntax.issues[0]?.hint).toContain(BEGIN);
      }
    }
  });

  test("rejects a write body containing an exact close sentinel line", () => {
    const text = ["write src/a.ts with", BEGIN, "before", END, "after", END].join("\n");
    try {
      parseMultiEditor(text);
      throw new Error("expected a syntax error");
    } catch (error) {
      expect(error).toBeInstanceOf(SelectionSyntaxError);
      const syntax = error as SelectionSyntaxError;
      expect(syntax.issues[0]?.code).toBe("EDIT_EMBEDDED_FENCE_END");
      expect(syntax.issues[0]?.message).toContain(END);
    }
  });

  test("round-trips every fs statement", () => {
    const text = [
      "create src/new.ts end",
      "delete src/old.ts end",
      "read src/a.ts end",
      "read src/a.ts within 1 end",
      "write src/a.ts with",
      BEGIN,
      "export const a = 1;",
      END,
      "select answer in src/a.ts end",
    ].join("\n");
    expect(serializeMultiEditor(parseMultiEditor(text))).toBe(
      [
        "create src/new.ts end",
        "delete src/old.ts end",
        "read src/a.ts end",
        "read src/a.ts within 1 end",
        ["write src/a.ts with", BEGIN, "export const a = 1;", END].join("\n"),
        "select answer in src/a.ts\nend",
      ].join("\n\n"),
    );
  });

  test("recovers a missing end after create, delete, and read", () => {
    for (const text of ["create src/new.ts", "delete src/old.ts", "read src/a.ts within 1"]) {
      const parsed = parseMultiEditorDetailed(text);
      expect(parsed.ok).toBe(true);
      expect(parsed.value).toHaveLength(1);
      const warning = parsed.issues.find((issue) => issue.code === "EDIT_MISSING_END");
      expect(warning?.severity).toBe("warning");
    }
    const beforeNext = parseMultiEditorDetailed("create src/new.ts\ndelete src/old.ts end");
    expect(beforeNext.ok).toBe(true);
    expect(beforeNext.value).toHaveLength(2);
    expect(beforeNext.issues.some((issue) => issue.code === "EDIT_MISSING_END")).toBe(true);
  });

  test("a missing end before arbitrary text is a hard error", () => {
    for (const text of [
      "create src/new.ts nonsense",
      "delete src/old.ts nonsense",
      "read src/a.ts nonsense",
    ]) {
      try {
        parseMultiEditor(text);
        throw new Error("expected a syntax error");
      } catch (error) {
        expect(error).toBeInstanceOf(SelectionSyntaxError);
        const syntax = error as SelectionSyntaxError;
        expect(syntax.issues[0]?.code).toBe("EDIT_MISSING_END");
        expect(syntax.issues[0]?.found).toBe("nonsense");
      }
    }
  });

  test("rejects the retired done after a file command or a select clause", () => {
    const replies = [
      "create src/new.ts done",
      "delete src/old.ts done",
      "read src/a.ts within 1 done",
      "select foo in src/a.ts done",
      ["select foo in src/a.ts", "replace with", BEGIN, "x", END, "done"].join("\n"),
    ];
    for (const reply of replies) {
      try {
        parseMultiEditor(reply);
        throw new Error("expected a syntax error");
      } catch (error) {
        expect(error).toBeInstanceOf(SelectionSyntaxError);
        const syntax = error as SelectionSyntaxError;
        expect(syntax.issues[0]?.code).toBe("EDIT_RETIRED_DONE");
        expect(syntax.issues[0]?.hint).toContain("end");
        expect(syntax.issues[0]?.hint).toContain("done");
      }
    }
  });

  test("rejects a stray done after a write close", () => {
    const text = ["write src/a.ts with", BEGIN, "x", END, "done"].join("\n");
    try {
      parseMultiEditor(text);
      throw new Error("expected a syntax error");
    } catch (error) {
      expect(error).toBeInstanceOf(SelectionSyntaxError);
      const syntax = error as SelectionSyntaxError;
      expect(syntax.issues[0]?.code).toBe("EDIT_RETIRED_DONE");
      expect(syntax.issues[0]?.hint).toContain("remove");
      expect(syntax.issues[0]?.hint).toContain("sentinel close");
    }
  });

  test("accepts one compatibility trailing end after a write close", () => {
    const text = ["write src/a.ts with", BEGIN, "x", END, "end"].join("\n");
    expect(parseMultiEditor(text)).toEqual([
      {
        type: "fs",
        statement: { op: "write", path: "src/a.ts", ranges: null, replacement: "x" },
      },
    ]);
  });

  test("rejects a second trailing end after a write close", () => {
    const text = ["write src/a.ts with", BEGIN, "x", END, "end", "end"].join("\n");
    expect(() => parseMultiEditor(text)).toThrow(SelectionSyntaxError);
  });

  test("a replace or create body close terminates the statement without end", () => {
    const selection = [
      "select function f in src/a.ts",
      "replace with",
      BEGIN,
      "return 1;",
      END,
    ].join("\n");
    expect(first(selection).replacement).toBe("return 1;");

    const create = [
      "create function f in src/a.ts with",
      BEGIN,
      "function f(): number {",
      "  return 1;",
      "}",
      END,
    ].join("\n");
    expect(serializeMultiEditor(parseMultiEditor(create))).toBe(create);

    const both = [
      selection,
      "",
      "create function g in src/a.ts with",
      BEGIN,
      "function g(): number {",
      "  return 2;",
      "}",
      END,
    ].join("\n");
    expect(parseMultiEditor(both)).toHaveLength(2);
  });

  test("a body close also ends a file-level select without end", () => {
    const selection = [
      "select file src/a.ts",
      'match `import { a } from "./a";`',
      "replace with",
      BEGIN,
      'import { b } from "./b";',
      END,
    ].join("\n");
    expect(first(selection).replacement).toBe('import { b } from "./b";');
  });

  test("accepts one compatibility end after a replace or create close and serializes canonically", () => {
    const selection = [
      "select function f in src/a.ts",
      "replace with",
      BEGIN,
      "return 1;",
      END,
      "end",
    ].join("\n");
    expect(serializeSelection(first(selection))).not.toMatch(/TC_EDIT_END\nend$/);

    const create = [
      "create function f in src/a.ts with",
      BEGIN,
      "function f(): number {",
      "  return 1;",
      "}",
      END,
      "end",
    ].join("\n");
    expect(serializeMultiEditor(parseMultiEditor(create))).not.toMatch(/TC_EDIT_END\nend$/);
  });

  test("rejects a second end after a replace or create close", () => {
    for (const text of [
      ["select function f in src/a.ts", "replace with", BEGIN, "x", END, "end", "end"].join("\n"),
      ["create function f in src/a.ts with", BEGIN, "x", END, "end", "end"].join("\n"),
    ]) {
      expect(() => parseMultiEditor(text)).toThrow(SelectionSyntaxError);
    }
  });

  test("rejects arbitrary text after a replace or create close", () => {
    for (const text of [
      ["select function f in src/a.ts", "replace with", BEGIN, "x", END, "nonsense"].join("\n"),
      ["create function f in src/a.ts with", BEGIN, "x", END, "nonsense"].join("\n"),
    ]) {
      try {
        parseMultiEditor(text);
        throw new Error("expected a syntax error");
      } catch (error) {
        expect(error).toBeInstanceOf(SelectionSyntaxError);
        expect((error as SelectionSyntaxError).issues[0]?.code).toBe("EDIT_EMBEDDED_FENCE_END");
      }
    }
  });

  test("an unclosed write fence remains EDIT_UNCLOSED_FENCE", () => {
    const text = ["write src/a.ts with", BEGIN, "x"].join("\n");
    try {
      parseMultiEditor(text);
      throw new Error("expected a syntax error");
    } catch (error) {
      expect(error).toBeInstanceOf(SelectionSyntaxError);
      const syntax = error as SelectionSyntaxError;
      expect(syntax.issues[0]?.code).toBe("EDIT_UNCLOSED_FENCE");
    }
  });

  test("requires with before the write fence", () => {
    expect(() => parseMultiEditor(["write src/a.ts", BEGIN, "x", END].join("\n"))).toThrow(/with/);
  });

  test("a shorter delimiter run inside the fence body is ordinary text (#25)", () => {
    const [statement] = parseMultiEditor(
      ["write src/a.ts with", BEGIN, "one", "---", "two", END].join("\n"),
    );
    expect(statement).toEqual({
      type: "fs",
      statement: {
        op: "write",
        path: "src/a.ts",
        ranges: null,
        replacement: "one\n---\ntwo",
      },
    });
  });

  test("a syntax error carries the reader offset (#25)", () => {
    try {
      parseMultiEditor(["select f in src/a.ts", "replace with", "x"].join("\n"));
      throw new Error("expected a syntax error");
    } catch (error) {
      expect(error).toBeInstanceOf(SelectionSyntaxError);
      const syntax = error as SelectionSyntaxError;
      expect(syntax.offset).not.toBeNull();
      expect(syntax.offset ?? 0).toBeGreaterThan(0);
      expect(syntax.detail).toContain("fence");
    }
  });

  test("rejects an unknown statement keyword", () => {
    expect(() => parseMultiEditor("rename src/a.ts")).toThrow(/select/);
  });
});

describe("reply entry recovery", () => {
  test("accepts a single leading prose preamble with a warning", () => {
    const parsed = parseMultiEditorDetailed(
      ["I will inspect the helper first.", "", "select answer in src/helper.ts", "end"].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.value).toHaveLength(1);
    expect(parsed.value?.[0]?.type).toBe("editor");
    const warning = parsed.issues.find((issue) => issue.code === "EDIT_PROSE_PREAMBLE");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("ignored 1 leading prose line");
  });

  test("accepts a prose preamble before a file command", () => {
    const parsed = parseMultiEditorDetailed(
      ["Here is the write:", "write src/a.ts with", BEGIN, "export const a = 2;", END].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    const statement = parsed.value?.[0];
    expect(statement?.type).toBe("fs");
    expect(parsed.issues.some((issue) => issue.code === "EDIT_PROSE_PREAMBLE")).toBe(true);
  });

  test("rejects prose followed by an invalid edit-dsl suffix", () => {
    const parsed = parseMultiEditorDetailed(
      ["Here is the edit:", "select answer in src/helper.ts", "pick 2", "end"].join("\n"),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.value).toEqual([]);
    expect(parsed.issues.some((issue) => issue.code === "EDIT_PROSE_PREAMBLE")).toBe(false);
  });

  test("does not trim a mixed command line or trailing prose", () => {
    const mixed = parseMultiEditorDetailed(
      [
        "Here is the edit:",
        "select answer in src/helper.ts end and write src/helper.ts",
        "end",
      ].join("\n"),
    );
    expect(mixed.ok).toBe(false);
    expect(mixed.issues.some((issue) => issue.code === "EDIT_PROSE_PREAMBLE")).toBe(false);
    const trailing = parseMultiEditorDetailed(
      ["Here is the edit:", "select answer in src/helper.ts end", "that should do it"].join("\n"),
    );
    expect(trailing.ok).toBe(false);
    expect(trailing.issues.some((issue) => issue.code === "EDIT_PROSE_PREAMBLE")).toBe(false);
  });

  test("reports DSML/tool-call markup and produces no edit", () => {
    const parsed = parseMultiEditorDetailed(
      [
        "<｜｜DSML｜｜ calls>",
        '<｜｜DSML｜｜ invoke name="select" file="src/helper.ts">',
        '<｜｜DSML｜｜ parameter name="symbol">answer</｜｜DSML｜｜ parameter>',
      ].join("\n"),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.value).toEqual([]);
    expect(parsed.issues).toHaveLength(1);
    const issue = parsed.issues[0];
    expect(issue?.code).toBe("EDIT_DSML_UNSUPPORTED");
    expect(issue?.stage).toBe("protocol");
    expect(issue?.message).toContain("no tool namespace");
    expect(issue?.message).toContain("literal edit-dsl text commands");
    expect(issue?.message).toContain("Reply with edit-dsl only");
    expect(issue?.message).toContain("literal text");
  });

  test("reports ASCII DSML markers after prose", () => {
    const parsed = parseMultiEditorDetailed(
      ["Let me read that file.", "<|tool calls|>", '<|invoke name="read">'].join("\n"),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.issues[0]?.code).toBe("EDIT_DSML_UNSUPPORTED");
    expect(parsed.issues[0]?.found).toBe("<|tool calls|>");
  });

  test("a DSML-looking literal inside a valid fence body is untouched", () => {
    const body = 'const marker = "<|not a tool|>";';
    const [statement] = parseMultiEditor(["write src/a.ts with", BEGIN, body, END].join("\n"));
    expect(statement?.type).toBe("fs");
    if (statement?.type === "fs" && statement.statement.op === "write") {
      expect(statement.statement.replacement).toBe(body);
    } else {
      throw new Error("expected a write statement");
    }
  });
});

describe("create declaration statements (#50)", () => {
  test("parses every top-level declaration kind", () => {
    const kinds = [
      "function",
      "class",
      "interface",
      "type",
      "enum",
      "namespace",
      "const",
      "let",
      "var",
      "using",
    ] as const;
    for (const kind of kinds) {
      const text = [
        `create ${kind} Target in src/target.ts with`,
        BEGIN,
        "// body",
        END,
        "end",
      ].join("\n");
      const [statement] = parseMultiEditor(text);
      expect(statement).toEqual({
        type: "fs",
        statement: {
          op: "create-declaration",
          path: "src/target.ts",
          kind,
          name: "Target",
          static: false,
          replacement: "// body",
        },
      });
    }
  });

  test("parses every member kind, including static, accessor, and constructor", () => {
    const cases = [
      ["method", "Owner.member", false],
      ["property", "Owner.member", false],
      ["getter", "Owner.member", false],
      ["setter", "Owner.member", false],
      ["accessor", "Owner.member", false],
      ["constructor", "Owner", false],
      ["enum-member", "Owner.member", false],
      ["method", "Owner.member", true],
      ["property", "Owner.member", true],
    ] as const;
    for (const [kind, name, isStatic] of cases) {
      const text = [
        `create ${isStatic ? "static " : ""}${kind} ${name} in src/owner.ts with`,
        BEGIN,
        "member",
        END,
        "end",
      ].join("\n");
      const [statement] = parseMultiEditor(text);
      expect(statement).toEqual({
        type: "fs",
        statement: {
          op: "create-declaration",
          path: "src/owner.ts",
          kind,
          name,
          static: isStatic,
          replacement: "member",
        },
      });
    }
  });

  test("a path literally named like a kind stays an empty-file create", () => {
    for (const kind of ["function", "type", "static", "enum-member", "in"]) {
      const [statement] = parseMultiEditor(`create ${kind} end`);
      expect(statement).toEqual({
        type: "fs",
        statement: { op: "create", path: kind },
      });
    }
  });

  test("accepts the fence directly after the header as well as after with", () => {
    const text = [
      "create function parseJson in src/json.ts",
      BEGIN,
      "export function parseJson(): void {}",
      END,
      "end",
    ].join("\n");
    const [statement] = parseMultiEditor(text);
    expect(statement).toEqual({
      type: "fs",
      statement: {
        op: "create-declaration",
        path: "src/json.ts",
        kind: "function",
        name: "parseJson",
        static: false,
        replacement: "export function parseJson(): void {}",
      },
    });
  });

  test("round-trips declaration creates and member creates", () => {
    const text = [
      "create function parseJson in src/json.ts with",
      BEGIN,
      "export function parseJson(input: string): string {",
      "  return input;",
      "}",
      END,
      "",
      "create static method Parser.parse in src/parser.ts with",
      BEGIN,
      "static parse(): number {",
      "  return 1;",
      "}",
      END,
      "",
      "create enum-member Color.Red in src/color.ts with",
      BEGIN,
      "Red = 0",
      END,
      "",
      "create src/empty.ts end",
    ].join("\n");
    expect(serializeMultiEditor(parseMultiEditor(text))).toBe(text);
  });

  test("rejects an unknown create kind and a static non-member kind", () => {
    expect(() =>
      parseMultiEditor(["create widget X in src/a.ts with", BEGIN, "x", END, "end"].join("\n")),
    ).toThrow(/unknown create kind/);
    expect(() =>
      parseMultiEditor(
        ["create static const X in src/a.ts with", BEGIN, "x", END, "end"].join("\n"),
      ),
    ).toThrow(/static/);
  });

  test("requires in, with, and the fence close", () => {
    expect(() =>
      parseMultiEditor(["create function f src/a.ts with", BEGIN, "x", END, "end"].join("\n")),
    ).toThrow(/in <path>/);
    expect(() =>
      parseMultiEditor(["create function f in src/a.ts with", BEGIN, "x"].join("\n")),
    ).toThrow(/UNCLOSED_FENCE|unclosed fence/i);
  });
});

describe("file-level select statements (#54)", () => {
  test("parses a file-level matcher editor with a file locator", () => {
    const text = [
      "select file src/helper.ts",
      'match `import { answer } from "./answer";`',
      "replace with",
      BEGIN,
      'import { answer } from "./answer-v2";',
      END,
      "end",
    ].join("\n");
    expect(first(text)).toEqual({
      locator: { path: "src/helper.ts", name: "", kind: "file" },
      space: null,
      matcher: { kind: "snippet", value: 'import { answer } from "./answer";' },
      pick: null,
      replacement: 'import { answer } from "./answer-v2";',
    });
  });

  test("a declaration literally named file keeps the symbol form", () => {
    expect(first("select file in src/a.ts end").locator).toEqual({
      path: "src/a.ts",
      name: "file",
      kind: "",
    });
  });

  test("round-trips a file-level select through the serializer", () => {
    const text = [
      "select file src/a.ts",
      'match /from "\\.\\/old";/',
      "pick 3-3:22",
      "replace with",
      BEGIN,
      'import { value } from "./new";',
      END,
    ].join("\n");
    expect(serializeSelection(first(text))).toBe(text);
  });

  test("rejects a file-level rename with a documented limitation", () => {
    const error = expectSyntax(
      ["select file src/a.ts", 'match `import { a } from "./a";`', "rename a to b", "end"].join(
        "\n",
      ),
      "file-level select cannot rename",
    );
    expect(error.issues[0]?.code).toBe("EDIT_FILE_RENAME_UNSUPPORTED");
  });

  test("rejects a file-level viewer clearly", () => {
    const error = expectSyntax("select file src/a.ts end", "requires `replace with <fence>`");
    expect(error.issues[0]?.code).toBe("EDIT_FILE_VIEWER_UNSUPPORTED");
  });

  test("rejects resolve and within on a file-level select", () => {
    expectSyntax("select file src/a.ts resolve value end", "no symbol space");
    expectSyntax("select file src/a.ts within 1-2 end", "file-level select is an editor");
  });

  test("rejects pick without replace", () => {
    const error = expectSyntax("select file src/a.ts pick 1 end", "pick` requires a `replace");
    expect(error.issues[0]?.code).toBe("EDIT_PICK_WITHOUT_REPLACE");
  });
});

describe("module-boundary create statements (#54)", () => {
  test("parses a nameless import create and an export create", () => {
    expect(
      parseMultiEditor(
        ["create import in src/a.ts with", BEGIN, 'import { a } from "./a";', END, "end"].join(
          "\n",
        ),
      ),
    ).toEqual([
      {
        type: "fs",
        statement: {
          op: "create-module",
          path: "src/a.ts",
          kind: "import",
          replacement: 'import { a } from "./a";',
        },
      },
    ]);
    expect(
      parseMultiEditor(
        ["create export in src/a.ts with", BEGIN, 'export { a } from "./a";', END, "end"].join(
          "\n",
        ),
      ),
    ).toEqual([
      {
        type: "fs",
        statement: {
          op: "create-module",
          path: "src/a.ts",
          kind: "export",
          replacement: 'export { a } from "./a";',
        },
      },
    ]);
  });

  test("accepts the fence directly after the module header", () => {
    const [statement] = parseMultiEditor(
      ["create import in src/a.ts", BEGIN, 'import "side-effect";', END, "end"].join("\n"),
    );
    expect(statement?.type).toBe("fs");
    expect(statement?.type === "fs" ? statement.statement : null).toMatchObject({
      op: "create-module",
      kind: "import",
      path: "src/a.ts",
    });
  });

  test("round-trips module creates", () => {
    const text = [
      "create import in src/a.ts with",
      BEGIN,
      'import type { Config } from "./config";',
      END,
      "",
      "create export in src/a.ts with",
      BEGIN,
      'export * from "./b";',
      END,
    ].join("\n");
    expect(serializeMultiEditor(parseMultiEditor(text))).toBe(text);
  });

  test("rejects static and a named module create", () => {
    expect(() =>
      parseMultiEditor(
        ["create static import in src/a.ts with", BEGIN, 'import "a";', END, "end"].join("\n"),
      ),
    ).toThrow(/static|module-boundary/i);
    expect(() =>
      parseMultiEditor(
        ["create import Binding in src/a.ts with", BEGIN, 'import "a";', END, "end"].join("\n"),
      ),
    ).toThrow(/in <path>/);
  });
});

describe("prompt examples", () => {
  test("every edit-dsl example is a parseable canonical reply", () => {
    for (const form of EDIT_DSL_EXAMPLE_FORMS) {
      if ("raw" in form) {
        expect(() => parseMultiEditor(form.raw)).not.toThrow();
      } else {
        const reply = serializeSelections(form.selections);
        expect(() => parseSelection(reply)).not.toThrow();
      }
    }
  });
});
