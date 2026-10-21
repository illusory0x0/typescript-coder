import { describe, expect, test } from "bun:test";
import {
  END_OF_LINE_COLUMN,
  SelectionSyntaxError,
  parseSelection,
  serializeSelection,
  serializeSelections,
  toEditPayload,
} from "./selection";
import type { Selection } from "./selection";

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
      "select function tokenize in src/lexer.ts\nmatch /^if \\(/\npick 12\nend",
    );
    expect(selection.pick).toEqual([
      { line: 12, column: 1, endLine: 12, endColumn: END_OF_LINE_COLUMN },
    ]);
  });

  test("parses a multi-range pick", () => {
    const selection = first(
      "select function tokenize in src/lexer.ts\nmatch /^if \\(/\npick {10, 12:3-14:5}\nend",
    );
    expect(selection.pick).toEqual([
      { line: 10, column: 1, endLine: 10, endColumn: END_OF_LINE_COLUMN },
      { line: 12, column: 3, endLine: 14, endColumn: 5 },
    ]);
  });

  test("parses a single character range", () => {
    const selection = first("select foo in a.ts\nmatch `x`\npick 7:2\nend");
    expect(selection.pick).toEqual([{ line: 7, column: 2, endLine: 7, endColumn: 2 }]);
  });

  test("parses a match + replace editor", () => {
    const text = [
      "select function clamp in src/math.ts",
      "match `Number.isNaN`",
      "replace with",
      "```",
      "Number.isFinite",
      "```",
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
      "```",
      "return 1;",
      "```",
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
      "```",
      "```",
      "end",
    ].join("\n");
    expect(first(text).replacement).toBe("");
  });

  test("preserves a multi-line fence body verbatim", () => {
    const body = "if (x) {\n  return 1;\n}";
    const text = ["select foo in a.ts", "replace with", "```", body, "```", "end"].join("\n");
    expect(first(text).replacement).toBe(body);
  });

  test("parses one reply with several clauses", () => {
    const text = [
      "select function clamp in src/math.ts",
      "match `Number.isNaN`",
      "replace with",
      "```",
      "Number.isFinite",
      "```",
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

  test("rejects a pick without a match", () => {
    expectSyntax("select foo in a.ts\npick 10\nend", "pick");
  });

  test("names an unterminated clause", () => {
    expectSyntax("select foo in a.ts\nmatch `x`", "end");
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

  test("names an unclosed fence", () => {
    expectSyntax("select foo in a.ts\nreplace with\n```\nfoo\nend", "fence");
  });

  test("rejects a fence body with a run as long as the opening", () => {
    expectSyntax("select foo in a.ts\nreplace with\n```\na```b\n```\nend", "fence");
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

  test("rejects a missing matcher value", () => {
    expectSyntax("select foo in a.ts\nmatch\nend", "snippet");
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
        matcher: null,
        pick: null,
        replacement: null,
      },
      {
        locator: { path: "src/math.ts", name: "clamp", kind: "" },
        matcher: { kind: "snippet", value: "Number.isNaN" },
        pick: null,
        replacement: null,
      },
      {
        locator: { path: "src/lexer.ts", name: "tokenize", kind: "function" },
        matcher: { kind: "regex", value: "^if \\(" },
        pick: [{ line: 12, column: 1, endLine: 12, endColumn: END_OF_LINE_COLUMN }],
        replacement: null,
      },
      {
        locator: { path: "src/lexer.ts", name: "tokenize", kind: "function" },
        matcher: { kind: "snippet", value: "x" },
        pick: [
          { line: 10, column: 1, endLine: 10, endColumn: END_OF_LINE_COLUMN },
          { line: 12, column: 3, endLine: 14, endColumn: 5 },
        ],
        replacement: null,
      },
      {
        locator: { path: "src/math.ts", name: "clamp", kind: "function" },
        matcher: { kind: "snippet", value: "Number.isNaN" },
        pick: null,
        replacement: "Number.isFinite",
      },
      {
        locator: { path: "src/lexer.ts", name: "MAX_TOKENS", kind: "const" },
        matcher: null,
        pick: null,
        replacement: "",
      },
      {
        locator: { path: "src/math.ts", name: "sum", kind: "function" },
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

  test("escapes a backtick and a backslash in a snippet", () => {
    const selection: Selection = {
      locator: { path: "a.ts", name: "foo", kind: "" },
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
      matcher: { kind: "regex", value: "a/b" },
      pick: null,
      replacement: null,
    };
    expect(serializeSelection(selection)).toContain("/a\\/b/");
    expect(parseSelection(serializeSelection(selection))).toEqual([selection]);
  });

  test("grows the fence past a backtick run in the body", () => {
    const selection: Selection = {
      locator: { path: "a.ts", name: "foo", kind: "" },
      matcher: null,
      pick: null,
      replacement: "before\n```\nafter",
    };
    const text = serializeSelection(selection);
    expect(text).toContain("````");
    expect(parseSelection(text)).toEqual([selection]);
  });
});

describe("toEditPayload", () => {
  test("bridges a snippet editor with no pick", () => {
    const selection = first(
      "select function clamp in src/math.ts\nmatch `Number.isNaN`\nreplace with\n```\nNumber.isFinite\n```\nend",
    );
    expect(toEditPayload(selection)).toEqual({
      locator: { path: "src/math.ts", name: "clamp", kind: "function" },
      matcher: "Number.isNaN",
      range: null,
      replacement: "Number.isFinite",
    });
  });

  test("bridges a whole-declaration rewrite and a delete", () => {
    const rewrite = first("select const MAX in a.ts\nreplace with\n```\nreturn 1;\n```\nend");
    expect(toEditPayload(rewrite)).toEqual({
      locator: { path: "a.ts", name: "MAX", kind: "const" },
      matcher: null,
      range: null,
      replacement: "return 1;",
    });
    const remove = first("select const MAX in a.ts\nreplace with\n```\n```\nend");
    expect(toEditPayload(remove)?.replacement).toBe("");
  });

  test("bridges a single-range pick as a payload range", () => {
    const selection = first(
      "select function tokenize in src/lexer.ts\nmatch `x`\npick 12:3-14:5\nreplace with\n```\ny\n```\nend",
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

  test("has no payload form for a regex matcher", () => {
    expect(
      toEditPayload(first("select foo in a.ts\nmatch /x/\nreplace with\n```\ny\n```\nend")),
    ).toBeNull();
  });

  test("has no payload form for a multi-range pick", () => {
    const selection = first(
      "select foo in a.ts\nmatch `x`\npick {1, 2}\nreplace with\n```\ny\n```\nend",
    );
    expect(toEditPayload(selection)).toBeNull();
  });
});
