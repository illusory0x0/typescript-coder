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
    expect(isMutatingOperation({ op: "create", path: "a.ts" })).toBe(true);
    expect(isMutatingOperation({ op: "delete", path: "a.ts" })).toBe(true);
    expect(isMutatingOperation({ op: "rewrite", path: "a.ts", content: "" })).toBe(true);
  });
});
