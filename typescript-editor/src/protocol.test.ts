import { describe, expect, test } from "bun:test";
import {
  EditProtocolError,
  isMutatingOperation,
  parseJsonEditRequest,
  renderEditRequest,
} from "./protocol";
import type { EditOperation, EditRequest } from "./protocol";

const BEGIN = "TC_EDIT_BEGIN";
const END = "TC_EDIT_END";

function request(...operations: EditOperation[]): EditRequest {
  return { operations };
}

function expectProtocolError(run: () => unknown, fragment: string): EditProtocolError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EditProtocolError);
  const error = caught as EditProtocolError;
  expect(error.message).toContain(fragment);
  return error;
}

describe("renderEditRequest", () => {
  test("renders a read", () => {
    expect(renderEditRequest(request({ op: "read", path: "src/a.ts" }))).toBe("read src/a.ts end");
  });

  test("renders a read with a within range", () => {
    expect(renderEditRequest(request({ op: "read", path: "src/a.ts", within: "1-3, 9-10" }))).toBe(
      "read src/a.ts within 1-3, 9-10 end",
    );
  });

  test("renders a viewer select", () => {
    expect(renderEditRequest(request({ op: "select", symbol: "answer", path: "src/a.ts" }))).toBe(
      "select answer in src/a.ts\nend",
    );
  });

  test("renders a viewer select with a within range", () => {
    expect(
      renderEditRequest(
        request({ op: "select", symbol: "answer", path: "src/a.ts", within: "4-7" }),
      ),
    ).toBe("select answer in src/a.ts within 4-7\nend");
  });

  test("renders kind, resolve, within, match, and pick in grammar order", () => {
    const rendered = renderEditRequest(
      request({
        op: "select",
        symbol: "answer",
        path: "src/a.ts",
        kind: "function",
        resolve: "value",
        within: "1-2",
        match: "return 1;",
        pick: "2:3-2:10",
      }),
    );
    expect(rendered).toBe(
      "select function answer in src/a.ts resolve value within 1-2 match `return 1;` pick 2:3-2:10\nend",
    );
  });

  test("renders a select-file span edit", () => {
    const rendered = renderEditRequest(
      request({
        op: "select-file",
        path: "src/a.test.ts",
        match: "if (value === 1) {",
        pick: "3:3-3:22",
        replace: "if (value === 2) {",
      }),
    );
    expect(rendered).toBe(
      [
        "select file src/a.test.ts",
        "match `if (value === 1) {`",
        "pick 3:3-3:22",
        "replace with",
        BEGIN,
        "if (value === 2) {",
        END,
      ].join("\n"),
    );
  });

  test("renders a select-file without a replacement as a bare file select", () => {
    expect(
      renderEditRequest(request({ op: "select-file", path: "src/a.test.ts", match: "return 1;" })),
    ).toBe("select file src/a.test.ts\nmatch `return 1;`\nend");
  });

  test("renders a replacement fence", () => {
    const rendered = renderEditRequest(
      request({
        op: "select",
        symbol: "answer",
        path: "src/a.ts",
        replace: "export const answer = 2;\n",
      }),
    );
    expect(rendered).toBe(
      [
        "select answer in src/a.ts",
        "replace with",
        BEGIN,
        "export const answer = 2;",
        "",
        END,
      ].join("\n"),
    );
  });

  test("renders a rename", () => {
    const rendered = renderEditRequest(
      request({ op: "select", symbol: "answer", path: "src/a.ts", rename: "result" }),
    );
    expect(rendered).toBe("select answer in src/a.ts\nrename answer to result\nend");
  });

  test("renders create, delete, and rewrite", () => {
    expect(renderEditRequest(request({ op: "create", path: "src/new.ts" }))).toBe(
      "create src/new.ts end",
    );
    expect(renderEditRequest(request({ op: "delete", path: "src/old.ts" }))).toBe(
      "delete src/old.ts end",
    );
    expect(
      renderEditRequest(request({ op: "rewrite", path: "src/a.ts", content: "const a = 1;\n" })),
    ).toBe(["write src/a.ts with", BEGIN, "const a = 1;", "", END].join("\n"));
  });

  test("joins operations with a blank line", () => {
    const rendered = renderEditRequest(
      request({ op: "read", path: "src/a.ts" }, { op: "delete", path: "src/b.ts" }),
    );
    expect(rendered).toBe("read src/a.ts end\n\ndelete src/b.ts end");
  });

  test("escapes backslashes and backticks in a match snippet", () => {
    const rendered = renderEditRequest(
      request({
        op: "select",
        symbol: "answer",
        path: "src/a.ts",
        match: "a`b\\c",
      }),
    );
    expect(rendered).toBe("select answer in src/a.ts match `a\\`b\\\\c`\nend");
  });

  test("rejects an empty request", () => {
    expectProtocolError(() => renderEditRequest({ operations: [] }), "no operations");
  });

  test("rejects an empty or whitespace path", () => {
    expectProtocolError(
      () => renderEditRequest(request({ op: "read", path: "" })),
      "non-empty path",
    );
    expectProtocolError(
      () => renderEditRequest(request({ op: "delete", path: "src/a b.ts" })),
      "no whitespace",
    );
  });

  test("rejects whitespace in symbol, kind, and rename tokens", () => {
    expectProtocolError(
      () => renderEditRequest(request({ op: "select", symbol: "a b", path: "src/a.ts" })),
      "select.symbol",
    );
    expectProtocolError(
      () =>
        renderEditRequest(
          request({ op: "select", symbol: "a", path: "src/a.ts", kind: "function x" }),
        ),
      "select.kind",
    );
    expectProtocolError(
      () =>
        renderEditRequest(
          request({ op: "select", symbol: "a", path: "src/a.ts", rename: "new name" }),
        ),
      "select.rename",
    );
  });

  test("rejects a line break in a range", () => {
    expectProtocolError(
      () => renderEditRequest(request({ op: "read", path: "src/a.ts", within: "1-2\n3-4" })),
      "line break",
    );
    expectProtocolError(
      () =>
        renderEditRequest(
          request({ op: "select", symbol: "a", path: "src/a.ts", within: "1-2\n3-4" }),
        ),
      "line break",
    );
  });

  test("rejects replace and rename together", () => {
    expectProtocolError(
      () =>
        renderEditRequest(
          request({
            op: "select",
            symbol: "a",
            path: "src/a.ts",
            replace: "const a = 1;",
            rename: "b",
          }),
        ),
      "mutually exclusive",
    );
  });

  test("rejects match and rename together", () => {
    expectProtocolError(
      () =>
        renderEditRequest(
          request({
            op: "select",
            symbol: "a",
            path: "src/a.ts",
            match: "return 1;",
            rename: "b",
          }),
        ),
      "match and rename are mutually exclusive",
    );
  });

  test("rejects a replacement or rewrite body carrying the fence close", () => {
    expectProtocolError(
      () =>
        renderEditRequest(
          request({
            op: "select",
            symbol: "a",
            path: "src/a.ts",
            replace: `one\n${END}\ntwo`,
          }),
        ),
      END,
    );
    expectProtocolError(
      () =>
        renderEditRequest(
          request({ op: "rewrite", path: "src/a.ts", content: `one\n  ${END}  \ntwo` }),
        ),
      END,
    );
  });
});

describe("parseJsonEditRequest", () => {
  test("accepts a bare operation array", () => {
    const parsed = parseJsonEditRequest(
      JSON.stringify([
        { op: "read", path: "src/a.ts" },
        { op: "select", symbol: "answer", path: "src/a.ts", resolve: "value", replace: "x" },
      ]),
    );
    expect(parsed.operations).toEqual([
      { op: "read", path: "src/a.ts" },
      { op: "select", symbol: "answer", path: "src/a.ts", resolve: "value", replace: "x" },
    ]);
  });

  test("accepts select and read within ranges", () => {
    const parsed = parseJsonEditRequest(
      JSON.stringify([
        { op: "read", path: "src/a.ts", within: "1-3" },
        { op: "select", symbol: "answer", path: "src/a.ts", within: "4-7" },
      ]),
    );
    expect(parsed.operations).toEqual([
      { op: "read", path: "src/a.ts", within: "1-3" },
      { op: "select", symbol: "answer", path: "src/a.ts", within: "4-7" },
    ]);
    expect(renderEditRequest(parsed)).toBe(
      "read src/a.ts within 1-3 end\n\nselect answer in src/a.ts within 4-7\nend",
    );
  });

  test("accepts the operations wrapper", () => {
    const parsed = parseJsonEditRequest(
      JSON.stringify({
        operations: [
          { op: "create", path: "src/new.ts" },
          { op: "rewrite", path: "src/a.ts", content: "const a = 1;\n" },
        ],
      }),
    );
    expect(parsed.operations).toEqual([
      { op: "create", path: "src/new.ts" },
      { op: "rewrite", path: "src/a.ts", content: "const a = 1;\n" },
    ]);
  });

  test("accepts a select-file operation and renders the DSL form", () => {
    const parsed = parseJsonEditRequest(
      JSON.stringify([
        {
          op: "select-file",
          path: "src/a.test.ts",
          match: "return 1;",
          pick: "4:3-4:11",
          replace: "return 2;",
        },
      ]),
    );
    expect(parsed.operations).toEqual([
      {
        op: "select-file",
        path: "src/a.test.ts",
        match: "return 1;",
        pick: "4:3-4:11",
        replace: "return 2;",
      },
    ]);
    expect(renderEditRequest(parsed)).toBe(
      [
        "select file src/a.test.ts",
        "match `return 1;`",
        "pick 4:3-4:11",
        "replace with",
        BEGIN,
        "return 2;",
        END,
      ].join("\n"),
    );
  });

  test("rejects select-file fields that belong to a declaration select", () => {
    for (const field of ["symbol", "kind", "resolve", "within", "rename"]) {
      expectProtocolError(
        () =>
          parseJsonEditRequest(
            JSON.stringify([{ op: "select-file", path: "src/a.ts", [field]: "x" }]),
          ),
        `unknown field ${JSON.stringify(field)}`,
      );
    }
  });

  test("rejects malformed JSON", () => {
    expectProtocolError(() => parseJsonEditRequest("{"), "invalid JSON");
  });

  test("rejects a top-level shape that is not an array or wrapper", () => {
    expectProtocolError(() => parseJsonEditRequest("42"), "operation array");
    expectProtocolError(
      () => parseJsonEditRequest(JSON.stringify({ operations: {} })),
      "must be an array",
    );
    expectProtocolError(
      () => parseJsonEditRequest(JSON.stringify({ operation: [] })),
      "unknown top-level field",
    );
    expectProtocolError(() => parseJsonEditRequest("[]"), "no operations");
  });

  test("rejects a missing, unknown, or non-string op", () => {
    expectProtocolError(
      () => parseJsonEditRequest(JSON.stringify([{ path: "src/a.ts" }])),
      'missing a string "op"',
    );
    expectProtocolError(
      () => parseJsonEditRequest(JSON.stringify([{ op: "move", path: "src/a.ts" }])),
      "unknown op",
    );
    expectProtocolError(
      () => parseJsonEditRequest(JSON.stringify([{ op: 7, path: "src/a.ts" }])),
      'missing a string "op"',
    );
  });

  test("rejects missing and unknown operation fields", () => {
    expectProtocolError(
      () => parseJsonEditRequest(JSON.stringify([{ op: "read" }])),
      'missing the required field "path"',
    );
    expectProtocolError(
      () => parseJsonEditRequest(JSON.stringify([{ op: "create", path: "a", content: "x" }])),
      'unknown field "content"',
    );
    expectProtocolError(
      () => parseJsonEditRequest(JSON.stringify([{ op: "read", path: 3 }])),
      "must be a string",
    );
    expectProtocolError(
      () =>
        parseJsonEditRequest(
          JSON.stringify([{ op: "select", symbol: "a", path: "src/a.ts", within: 7 }]),
        ),
      "must be a string",
    );
  });

  test("validates resolve and reject replace plus rename", () => {
    expectProtocolError(
      () =>
        parseJsonEditRequest(
          JSON.stringify([{ op: "select", symbol: "a", path: "src/a.ts", resolve: "constructor" }]),
        ),
      "resolve",
    );
    expectProtocolError(
      () =>
        parseJsonEditRequest(
          JSON.stringify([
            { op: "select", symbol: "a", path: "src/a.ts", replace: "b", rename: "c" },
          ]),
        ),
      "mutually exclusive",
    );
    expectProtocolError(
      () =>
        parseJsonEditRequest(
          JSON.stringify([
            { op: "select", symbol: "a", path: "src/a.ts", match: "b", rename: "c" },
          ]),
        ),
      "match and rename are mutually exclusive",
    );
  });
});

describe("isMutatingOperation", () => {
  test("classifies every operation", () => {
    expect(isMutatingOperation({ op: "read", path: "a.ts" })).toBe(false);
    expect(isMutatingOperation({ op: "select", symbol: "a", path: "a.ts" })).toBe(false);
    expect(isMutatingOperation({ op: "select", symbol: "a", path: "a.ts", replace: "b" })).toBe(
      true,
    );
    expect(isMutatingOperation({ op: "select", symbol: "a", path: "a.ts", rename: "b" })).toBe(
      true,
    );
    expect(isMutatingOperation({ op: "select-file", path: "a.ts" })).toBe(false);
    expect(isMutatingOperation({ op: "select-file", path: "a.ts", replace: "b" })).toBe(true);
    expect(isMutatingOperation({ op: "create", path: "a.ts" })).toBe(true);
    expect(isMutatingOperation({ op: "delete", path: "a.ts" })).toBe(true);
    expect(isMutatingOperation({ op: "rewrite", path: "a.ts", content: "" })).toBe(true);
  });
});

describe("insertion anchors in the JSON/flag protocol (#93)", () => {
  test("renders a select with a pick-after literal anchor", () => {
    const rendered = renderEditRequest(
      request({
        op: "select",
        symbol: "answer",
        path: "src/a.ts",
        pickAfter: "return 1;",
        replace: "  return 2;",
      }),
    );
    expect(rendered).toBe(
      [
        "select answer in src/a.ts",
        "pick after `return 1;`",
        "replace with",
        BEGIN,
        "  return 2;",
        END,
      ].join("\n"),
    );
  });

  test("renders a select-file with a pick-before literal anchor", () => {
    const rendered = renderEditRequest(
      request({
        op: "select-file",
        path: "src/a.ts",
        pickBefore: "export function once",
        replace: "// inserted",
      }),
    );
    expect(rendered).toBe(
      [
        "select file src/a.ts",
        "pick before `export function once`",
        "replace with",
        BEGIN,
        "// inserted",
        END,
      ].join("\n"),
    );
  });

  test("escapes backslashes and backticks in an anchor", () => {
    const rendered = renderEditRequest(
      request({
        op: "select",
        symbol: "answer",
        path: "src/a.ts",
        pickBefore: "a`b\\c",
        replace: "x",
      }),
    );
    expect(rendered).toContain("pick before `a\\`b\\\\c`");
  });

  test("accepts pickAfter from JSON and renders the anchor clause", () => {
    const parsed = parseJsonEditRequest(
      JSON.stringify([
        {
          op: "select",
          symbol: "answer",
          path: "a.ts",
          pickAfter: "return 1;",
          replace: "  return 2;",
        },
      ]),
    );
    expect(parsed.operations[0]).toEqual({
      op: "select",
      symbol: "answer",
      path: "a.ts",
      pickAfter: "return 1;",
      replace: "  return 2;",
    });
    expect(renderEditRequest(parsed)).toBe(
      [
        "select answer in a.ts",
        "pick after `return 1;`",
        "replace with",
        BEGIN,
        "  return 2;",
        END,
      ].join("\n"),
    );
  });

  test("accepts pickBefore on a select-file operation", () => {
    const parsed = parseJsonEditRequest(
      JSON.stringify([
        {
          op: "select-file",
          path: "a.ts",
          pickBefore: "// anchor",
          replace: "// inserted",
        },
      ]),
    );
    expect(renderEditRequest(parsed)).toContain("pick before `// anchor`");
  });

  test("rejects both anchors on one operation", () => {
    expectProtocolError(
      () =>
        renderEditRequest(
          request({
            op: "select",
            symbol: "answer",
            path: "src/a.ts",
            pickBefore: "a",
            pickAfter: "b",
            replace: "x",
          }),
        ),
      "mutually exclusive",
    );
    expectProtocolError(
      () =>
        renderEditRequest(
          request({
            op: "select-file",
            path: "src/a.ts",
            pickBefore: "a",
            pickAfter: "b",
            replace: "x",
          }),
        ),
      "mutually exclusive",
    );
  });

  test("rejects an anchor combined with match, pick, rename, or within", () => {
    const selectBase = { op: "select" as const, symbol: "answer", path: "src/a.ts" };
    expectProtocolError(
      () => renderEditRequest(request({ ...selectBase, pickAfter: "x", match: "y", replace: "z" })),
      "cannot be combined with match",
    );
    expectProtocolError(
      () => renderEditRequest(request({ ...selectBase, pickAfter: "x", pick: "1", replace: "z" })),
      "cannot be combined with pick",
    );
    expectProtocolError(
      () => renderEditRequest(request({ ...selectBase, pickAfter: "x", rename: "value" })),
      "cannot be combined with rename",
    );
    expectProtocolError(
      () =>
        renderEditRequest(request({ ...selectBase, pickAfter: "x", within: "1-2", replace: "z" })),
      "cannot be combined with within",
    );
    expectProtocolError(
      () =>
        renderEditRequest(
          request({
            op: "select-file",
            path: "src/a.ts",
            pickAfter: "x",
            match: "y",
            replace: "z",
          }),
        ),
      "cannot be combined with match",
    );
  });

  test("rejects an anchor without replace", () => {
    expectProtocolError(
      () =>
        renderEditRequest(
          request({ op: "select", symbol: "answer", path: "src/a.ts", pickAfter: "x" }),
        ),
      "requires replace",
    );
    expectProtocolError(
      () => renderEditRequest(request({ op: "select-file", path: "src/a.ts", pickBefore: "x" })),
      "requires replace",
    );
  });

  test("rejects an empty anchor", () => {
    expectProtocolError(
      () =>
        renderEditRequest(
          request({
            op: "select",
            symbol: "answer",
            path: "src/a.ts",
            pickBefore: "",
            replace: "x",
          }),
        ),
      "non-empty literal anchor",
    );
  });
});
