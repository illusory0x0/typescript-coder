import { describe, expect, test } from "bun:test";
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
  toEditPayload,
} from "./selection";
import type { Selection } from "./selection";

const FENCE = "``````";
const DASH_FENCE = "-----";

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
      "select function tokenize in src/lexer.ts\nmatch /^if \\(/\npick 12\nreplace with\n``````\ny\n``````\nend",
    );
    expect(selection.pick).toEqual([
      { line: 12, column: 1, endLine: 12, endColumn: END_OF_LINE_COLUMN },
    ]);
  });

  test("parses a multi-range pick", () => {
    const selection = first(
      "select function tokenize in src/lexer.ts\nmatch /^if \\(/\npick {10, 12:3-14:5}\nreplace with\n``````\ny\n``````\nend",
    );
    expect(selection.pick).toEqual([
      { line: 10, column: 1, endLine: 10, endColumn: END_OF_LINE_COLUMN },
      { line: 12, column: 3, endLine: 14, endColumn: 5 },
    ]);
  });

  test("parses a single character range", () => {
    const selection = first(
      "select foo in a.ts\nmatch `x`\npick 7:2\nreplace with\n``````\ny\n``````\nend",
    );
    expect(selection.pick).toEqual([{ line: 7, column: 2, endLine: 7, endColumn: 2 }]);
  });

  test("parses a match + replace editor", () => {
    const text = [
      "select function clamp in src/math.ts",
      "match `Number.isNaN`",
      "replace with",
      FENCE,
      "Number.isFinite",
      FENCE,
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
      FENCE,
      "return 1;",
      FENCE,
      "end",
    ].join("\n");
    const selection = first(text);
    expect(selection.matcher).toBeNull();
    expect(selection.pick).toBeNull();
    expect(selection.replacement).toBe("return 1;");
  });

  test("parses a delete (empty fence body)", () => {
    const text = [
      "select const MAX_TOKENS in src/lexer.ts",
      "replace with",
      FENCE,
      FENCE,
      "end",
    ].join("\n");
    expect(first(text).replacement).toBe("");
  });

  test("preserves a multi-line fence body verbatim", () => {
    const body = "if (x) {\n  return 1;\n}";
    const text = ["select foo in a.ts", "replace with", FENCE, body, FENCE, "end"].join("\n");
    expect(first(text).replacement).toBe(body);
  });

  test("accepts `end` on the closing fence line", () => {
    const text = ["select foo in a.ts replace with", DASH_FENCE, "x", `${DASH_FENCE} end`].join(
      "\n",
    );
    expect(first(text).replacement).toBe("x");
  });

  test("accepts a body with one or two backticks", () => {
    const text = ["select foo in a.ts", "replace with", FENCE, "a``b", FENCE, "end"].join("\n");
    expect(first(text).replacement).toBe("a``b");
  });

  test("accepts a longer opening when the closing run matches", () => {
    const ticks = "````````";
    const text = ["select foo in a.ts", "replace with", ticks, "x", ticks, "end"].join("\n");
    expect(first(text).replacement).toBe("x");
  });

  test("parses a five-hyphen fence", () => {
    const text = ["select foo in a.ts", "replace with", DASH_FENCE, "x", DASH_FENCE, "end"].join(
      "\n",
    );
    expect(first(text).replacement).toBe("x");
  });

  test("accepts a longer hyphen fence when the closing run matches", () => {
    const dashes = "-".repeat(8);
    const text = ["select foo in a.ts", "replace with", dashes, "x", dashes, "end"].join("\n");
    expect(first(text).replacement).toBe("x");
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
      FENCE,
      "Number.isFinite",
      FENCE,
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
      FENCE,
      "y",
      FENCE,
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
      FENCE,
      "y",
      FENCE,
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
      `select value in a.ts\nrename value to total\nreplace with\n${FENCE}\nx\n${FENCE}\nend`,
      "rename cannot be combined with `replace`",
    );
    expectSyntax(
      `select value in a.ts\nreplace with\n${FENCE}\nx\n${FENCE}\nrename value to total\nend`,
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
      FENCE,
      "select inside the fence",
      FENCE,
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

  test("names an unclosed six-tick fence with EDIT_UNCLOSED_FENCE", () => {
    const error = expectSyntax(`select foo in a.ts\nreplace with\n${FENCE}\nfoo\nend`, "fence");
    expect(error.issues[0]?.code).toBe("EDIT_UNCLOSED_FENCE");
    expect(error.truncated).toBe(true);
  });

  test("rejects a three-tick fence opening", () => {
    expectSyntax("select foo in a.ts\nreplace with\n```\nx\n```\nend", "6");
  });

  test("rejects a four-hyphen fence opening", () => {
    expectSyntax("select foo in a.ts\nreplace with\n----\nx\n----\nend", "5");
  });

  test("rejects a closing hyphen run that differs from the opening", () => {
    expectSyntax(`select foo in a.ts\nreplace with\n${DASH_FENCE}\nx\n------\nend`, "fence");
  });

  test("accepts a hyphen fence body with three hyphens (#25)", () => {
    const [selection] = parseSelection(
      `select foo in a.ts\nreplace with\n${DASH_FENCE}\na---b\n${DASH_FENCE}\nend`,
    );
    expect(selection?.replacement).toBe("a---b");
  });

  test("rejects a closing run that differs from the opening", () => {
    const seven = "`".repeat(7);
    expectSyntax(`select foo in a.ts\nreplace with\n${FENCE}\nx\n${seven}\nend`, "fence");
  });

  test("accepts a fence body with three backticks (#25)", () => {
    const body = `a${"`".repeat(3)}b`;
    const [selection] = parseSelection(
      `select foo in a.ts\nreplace with\n${FENCE}\n${body}\n${FENCE}\nend`,
    );
    expect(selection?.replacement).toBe(body);
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

  test("uses a five-hyphen fence", () => {
    const selection: Selection = {
      locator: { path: "a.ts", name: "foo", kind: "" },
      space: null,
      matcher: null,
      pick: null,
      replacement: "y",
    };
    expect(serializeSelection(selection)).toContain(`${DASH_FENCE}\ny\n${DASH_FENCE}`);
  });

  test("falls back to a six-tick fence when the body contains a hyphen run", () => {
    const selection: Selection = {
      locator: { path: "a.ts", name: "foo", kind: "" },
      space: null,
      matcher: null,
      pick: null,
      replacement: "a---b",
    };
    expect(serializeSelection(selection)).toContain(`${FENCE}\na---b\n${FENCE}`);
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

  test("serializes a body containing three backticks with a hyphen fence", () => {
    const selection: Selection = {
      locator: { path: "a.ts", name: "foo", kind: "" },
      space: null,
      matcher: null,
      pick: null,
      replacement: "before\n```\nafter",
    };
    expect(serializeSelection(selection)).toContain(
      `${DASH_FENCE}\nbefore\n\`\`\`\nafter\n${DASH_FENCE}`,
    );
    expect(parseSelection(serializeSelection(selection))).toEqual([selection]);
  });

  test("throws when the body contains both delimiter runs", () => {
    const selection: Selection = {
      locator: { path: "a.ts", name: "foo", kind: "" },
      space: null,
      matcher: null,
      pick: null,
      replacement: "---\n```",
    };
    expect(() => serializeSelection(selection)).toThrow(SelectionSyntaxError);
    expect(() => serializeSelection(selection)).toThrow(/3 or more backticks or hyphens/);
  });
});

describe("toEditPayload", () => {
  test("bridges a snippet editor with no pick", () => {
    const selection = first(
      `select function clamp in src/math.ts\nmatch \`Number.isNaN\`\nreplace with\n${FENCE}\nNumber.isFinite\n${FENCE}\nend`,
    );
    expect(toEditPayload(selection)).toEqual({
      locator: { path: "src/math.ts", name: "clamp", kind: "function" },
      matcher: "Number.isNaN",
      range: null,
      replacement: "Number.isFinite",
    });
  });

  test("bridges a whole-declaration rewrite and a delete", () => {
    const rewrite = first(
      `select const MAX in a.ts\nreplace with\n${FENCE}\nreturn 1;\n${FENCE}\nend`,
    );
    expect(toEditPayload(rewrite)).toEqual({
      locator: { path: "a.ts", name: "MAX", kind: "const" },
      matcher: null,
      range: null,
      replacement: "return 1;",
    });
    const remove = first(`select const MAX in a.ts\nreplace with\n${FENCE}\n${FENCE}\nend`);
    expect(toEditPayload(remove)?.replacement).toBe("");
  });

  test("bridges a single-range pick as a payload range", () => {
    const selection = first(
      `select function tokenize in src/lexer.ts\nmatch \`x\`\npick 12:3-14:5\nreplace with\n${FENCE}\ny\n${FENCE}\nend`,
    );
    expect(toEditPayload(selection)).toEqual({
      locator: { path: "src/lexer.ts", name: "tokenize", kind: "function" },
      matcher: "x",
      range: { line: 12, column: 3, endLine: 14, endColumn: 5 },
      replacement: "y",
    });
  });

  test("has no payload form for a viewer", () => {
    expect(toEditPayload(first("select foo in a.ts\nend"))).toBeNull();
  });

  test("has no payload form for a rename", () => {
    expect(toEditPayload(first("select value in a.ts\nrename value to total\nend"))).toBeNull();
  });

  test("has no payload form for a regex matcher", () => {
    expect(
      toEditPayload(
        first(`select foo in a.ts\nmatch /x/\nreplace with\n${FENCE}\ny\n${FENCE}\nend`),
      ),
    ).toBeNull();
  });

  test("has no payload form for a multi-range pick", () => {
    const selection = first(
      `select foo in a.ts\nmatch \`x\`\npick {1, 2}\nreplace with\n${FENCE}\ny\n${FENCE}\nend`,
    );
    expect(toEditPayload(selection)).toBeNull();
  });

  test("has no payload form when a resolve space is set", () => {
    const selection = first(
      `select answer in main.ts resolve value\nreplace with\n${FENCE}\nlet answer = 2;\n${FENCE}\nend`,
    );
    expect(toEditPayload(selection)).toBeNull();
  });
});

describe("parseMultiEditor", () => {
  test("parses create, delete, read, write, and editor statements", () => {
    const text = [
      "create src/new.ts done",
      "delete src/old.ts done",
      "read src/a.ts within {1, 3:2-4} done",
      "write src/a.ts within 2 with",
      DASH_FENCE,
      "return 2;",
      DASH_FENCE,
      "done",
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

  test("write with no within replaces the whole file", () => {
    const [statement] = parseMultiEditor(
      ["write src/a.ts with", DASH_FENCE, "export const a = 1;", DASH_FENCE, "done"].join("\n"),
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

  test("round-trips every fs statement", () => {
    const text = [
      "create src/new.ts done",
      "delete src/old.ts done",
      "read src/a.ts done",
      "read src/a.ts within 1 done",
      "write src/a.ts with",
      DASH_FENCE,
      "export const a = 1;",
      DASH_FENCE,
      "done",
      "select answer in src/a.ts end",
    ].join("\n");
    expect(serializeMultiEditor(parseMultiEditor(text))).toBe(
      [
        "create src/new.ts done",
        "delete src/old.ts done",
        "read src/a.ts done",
        "read src/a.ts within 1 done",
        ["write src/a.ts with", DASH_FENCE, "export const a = 1;", DASH_FENCE, "done"].join("\n"),
        "select answer in src/a.ts\nend",
      ].join("\n\n"),
    );
  });

  test("requires done after a create", () => {
    expect(() => parseMultiEditor("create src/new.ts")).toThrow(/done/);
  });

  test("requires with before the write fence", () => {
    expect(() =>
      parseMultiEditor(["write src/a.ts", DASH_FENCE, "x", DASH_FENCE, "done"].join("\n")),
    ).toThrow(/with/);
  });

  test("a shorter delimiter run inside the fence body is ordinary text (#25)", () => {
    const [statement] = parseMultiEditor(
      ["write src/a.ts with", DASH_FENCE, "one", "---", "two", DASH_FENCE, "done"].join("\n"),
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
    expect(() => parseMultiEditor("rename src/a.ts done")).toThrow(/select/);
  });
});
