import { describe, expect, test } from "bun:test";
import { SPEC_FILE_LIMIT, resolveEditRange, sourceRevision } from "./range";

describe("resolveEditRange (#72)", () => {
  test("maps 1-based inclusive positions and rejects bad ranges", () => {
    const source = "function f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n";
    const limit = source.length - 1; // one past the final `}` (trailing newline excluded)
    const declaration = { start: 0, end: limit };

    const single = resolveEditRange(
      source,
      { line: 2, column: 3, endLine: 2, endColumn: 14 },
      0,
      limit,
      declaration,
    );
    expect(single.ok).toBe(true);
    if (single.ok) {
      expect(source.slice(single.start, single.end)).toBe("const a = 1;");
    }

    const multi = resolveEditRange(
      source,
      { line: 2, column: 3, endLine: 4, endColumn: 15 },
      0,
      limit,
      declaration,
    );
    expect(multi.ok).toBe(true);
    if (multi.ok) {
      expect(source.slice(multi.start, multi.end)).toBe(
        "const a = 1;\n  const b = 2;\n  return a + b;",
      );
    }

    // The start line does not exist in the shown block.
    expect(
      resolveEditRange(
        source,
        { line: 99, column: 1, endLine: 99, endColumn: 1 },
        0,
        limit,
        declaration,
      ),
    ).toMatchObject({ ok: false, reason: "out-of-bounds" });
    // The end column runs past the line.
    expect(
      resolveEditRange(
        source,
        { line: 2, column: 3, endLine: 2, endColumn: 99 },
        0,
        limit,
        declaration,
      ),
    ).toMatchObject({ ok: false, reason: "out-of-bounds" });
    // End before start (empty span).
    expect(
      resolveEditRange(
        source,
        { line: 3, column: 1, endLine: 2, endColumn: 1 },
        0,
        limit,
        declaration,
      ),
    ).toMatchObject({ ok: false, reason: "empty" });
    // A whole-file coordinate space with the declaration as a sub-span: the
    // range resolves on the file but does not sit inside the declaration.
    const wholeFileDeclaration = { start: 15, end: 29 };
    expect(
      resolveEditRange(
        source,
        { line: 4, column: 3, endLine: 4, endColumn: 15 },
        0,
        source.length,
        wholeFileDeclaration,
      ),
    ).toMatchObject({ ok: false, reason: "outside-declaration" });
  });

  test("resolves ranges in a file larger than the prompt fold limit (#90)", () => {
    const source =
      "function head(): number {\n  return 1;\n}\n" +
      `${"x".repeat(SPEC_FILE_LIMIT)}\n` +
      "function tail(): number {\n  return 2;\n}\n";
    expect(source.length).toBeGreaterThan(SPEC_FILE_LIMIT);
    const fileRange = { start: 0, end: source.length };

    // File-level pick near the start: only the file bounds matter, not the
    // total size, so a range inside the file resolves.
    const nearStart = resolveEditRange(
      source,
      { line: 2, column: 3, endLine: 2, endColumn: 10 },
      0,
      source.length,
      fileRange,
    );
    expect(nearStart.ok).toBe(true);
    if (nearStart.ok) {
      expect(source.slice(nearStart.start, nearStart.end)).toBe("return 1");
    }

    // Declaration pick near the end: the range must sit inside the declaration,
    // which it does even though the file is far larger than the old limit.
    const tailDeclaration = { start: source.lastIndexOf("function tail"), end: source.length };
    const nearEnd = resolveEditRange(
      source,
      { line: 6, column: 3, endLine: 6, endColumn: 10 },
      0,
      source.length,
      tailDeclaration,
    );
    expect(nearEnd.ok).toBe(true);
    if (nearEnd.ok) {
      expect(source.slice(nearEnd.start, nearEnd.end)).toBe("return 2");
    }

    // The declaration bound still rejects a range outside it.
    expect(
      resolveEditRange(
        source,
        { line: 1, column: 1, endLine: 1, endColumn: 8 },
        0,
        source.length,
        tailDeclaration,
      ),
    ).toMatchObject({ ok: false, reason: "outside-declaration" });
  });
});

describe("sourceRevision (#91)", () => {
  test("is a stable 8-character lowercase hex token", () => {
    const first = sourceRevision("export const value = 1;\n");
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(sourceRevision("export const value = 1;\n")).toBe(first);
    expect(sourceRevision("export const value = 2;\n")).not.toBe(first);
  });

  test("hashes UTF-16 code units deterministically, including empty source", () => {
    expect(sourceRevision("")).toMatch(/^[0-9a-f]{8}$/);
    expect(sourceRevision("")).toBe(sourceRevision(""));
    expect(sourceRevision("a")).not.toBe(sourceRevision("b"));
  });
});
