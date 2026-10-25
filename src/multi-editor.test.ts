import { describe, expect, test } from "bun:test";
import { renderReadFailureFeedback, renderReadFeedback, resolveMultiEditor } from "./multi-editor";
import type { MultiEditorDeps } from "./multi-editor";
import { parseMultiEditor } from "./selection";

function deps(
  files: Record<string, string>,
  unsafe: ReadonlySet<string> = new Set(),
): MultiEditorDeps {
  return {
    sourceFor: (path) => files[path] ?? "",
    fileExists: (path) => Object.prototype.hasOwnProperty.call(files, path),
    isSafePath: (path) => !unsafe.has(path),
    resolveEntry: () => ({
      ok: false,
      diagnostics: "stage: address\nnot used by file commands",
      undeclared: true,
    }),
  };
}

function resolve(text: string, files: Record<string, string>, unsafe?: ReadonlySet<string>) {
  return resolveMultiEditor(parseMultiEditor(text), deps(files, unsafe));
}

describe("resolveMultiEditor file commands", () => {
  test("create queues an empty file and rejects an existing path", () => {
    const ok = resolve("create src/new.ts done", {});
    expect(ok.failures).toEqual([]);
    expect(ok.creates).toEqual([{ index: 0, path: "src/new.ts" }]);

    const exists = resolve("create src/a.ts done", { "src/a.ts": "x" });
    expect(exists.creates).toEqual([]);
    expect(exists.failures[0]?.diagnostics).toContain("already exists");
  });

  test("delete queues an existing file and rejects a missing path", () => {
    const ok = resolve("delete src/a.ts done", { "src/a.ts": "x" });
    expect(ok.deletes).toEqual([{ index: 0, path: "src/a.ts" }]);

    const missing = resolve("delete src/a.ts done", {});
    expect(missing.deletes).toEqual([]);
    expect(missing.failures[0]?.diagnostics).toContain("does not exist");
  });

  test("read returns whole-file lines or selected lines without writing", () => {
    const files = { "src/a.ts": "one\ntwo\nthree\n" };
    const whole = resolve("read src/a.ts done", files);
    expect(whole.reads[0]?.lines).toEqual([
      { line: 1, text: "one" },
      { line: 2, text: "two" },
      { line: 3, text: "three" },
    ]);
    expect(whole.regions).toEqual([]);

    const selected = resolve("read src/a.ts within 2 done", files);
    expect(selected.reads[0]?.lines).toEqual([{ line: 2, text: "two" }]);
  });

  test("a huge read result folds to three head and three tail lines", () => {
    const source = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const read = resolve("read src/a.ts done", { "src/a.ts": source });
    const feedback = renderReadFeedback(read.reads);
    expect(feedback).toContain("src/a.ts (whole file, 10 lines; showing 6):");
    expect(feedback).toContain("1 | line 1");
    expect(feedback).toContain("3 | line 3");
    expect(feedback).toContain("... // content folded, source range: 4-7");
    expect(feedback).toContain("(4 of 10 lines hidden)");
    expect(feedback).toContain("expand with read src/a.ts within 4-7 done");
    expect(feedback).toContain("8 | line 8");
    expect(feedback).toContain("10 | line 10");
    expect(feedback).not.toContain("4 | line 4");
  });

  test("a selected-lines read is the expansion and comes back unfolded", () => {
    const source = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
    const read = resolve("read src/a.ts within 1-20 done", { "src/a.ts": source });
    const feedback = renderReadFeedback(read.reads);
    expect(feedback).toContain("src/a.ts (selected lines, 20 lines):");
    expect(feedback).toContain("1 | line 1");
    expect(feedback).toContain("20 | line 20");
    expect(feedback).not.toContain("content folded");
    expect(feedback).not.toContain("showing 6");
  });

  test("a short read keeps the quiet header shape", () => {
    const read = resolve("read src/a.ts done", { "src/a.ts": "one\ntwo\nthree\n" });
    const feedback = renderReadFeedback(read.reads);
    expect(feedback).toContain("src/a.ts (whole file):");
    expect(feedback).not.toContain("showing 6");
  });

  test("write with no within replaces the whole file", () => {
    const result = resolve(
      [
        "write src/a.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        "export const a = 2;",
        "<<<TC_EDIT_END>>>",
        "done",
      ].join("\n"),
      { "src/a.ts": "export const a = 1;\n" },
    );
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]).toMatchObject({
      path: "src/a.ts",
      start: 0,
      end: 20,
      text: "export const a = 2;",
    });
  });

  test("write with within replaces only the selected line", () => {
    const result = resolve(
      [
        "write src/a.ts within 2 with",
        "<<<TC_EDIT_BEGIN>>>",
        "two changed",
        "<<<TC_EDIT_END>>>",
        "done",
      ].join("\n"),
      { "src/a.ts": "one\ntwo\nthree\n" },
    );
    expect(result.failures).toEqual([]);
    expect(result.regions[0]).toMatchObject({
      start: 4,
      end: 7,
      text: "two changed",
    });
  });

  test("write creates a missing file at offset 0", () => {
    const result = resolve(
      [
        "write src/new.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        "export const a = 1;",
        "<<<TC_EDIT_END>>>",
        "done",
      ].join("\n"),
      {},
    );
    expect(result.failures).toEqual([]);
    expect(result.regions[0]).toMatchObject({ path: "src/new.ts", start: 0, end: 0 });
  });

  test("rejects unsafe paths", () => {
    const result = resolve("create ../outside.ts done", {}, new Set(["../outside.ts"]));
    expect(result.creates).toEqual([]);
    expect(result.failures[0]?.diagnostics).toContain("outside the editable workspace");
  });

  test("conflicts create/delete with another operation on the same path", () => {
    const createWrite = resolve(
      [
        "create src/a.ts done",
        "write src/a.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        "x",
        "<<<TC_EDIT_END>>>",
        "done",
      ].join("\n"),
      {},
    );
    expect(createWrite.failures[0]?.diagnostics).toContain("conflicts");
  });

  test("rejects overlapping write ranges", () => {
    const result = resolve(
      [
        "write src/a.ts within {1, 1:2-2:4} with",
        "<<<TC_EDIT_BEGIN>>>",
        "x",
        "<<<TC_EDIT_END>>>",
        "done",
      ].join("\n"),
      { "src/a.ts": "one\ntwo\nthree\n" },
    );
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.diagnostics).toContain("overlap");
  });

  test("a failed read is feedback and does not discard the reply's write (#25)", () => {
    const result = resolve(
      [
        "write src/a.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        "two",
        "<<<TC_EDIT_END>>>",
        "done",
        "read src/a.ts within 99 done",
      ].join("\n"),
      { "src/a.ts": "one\n" },
    );
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(1);
    expect(result.reads).toEqual([]);
    expect(result.readFailures).toHaveLength(1);
    expect(result.readFailures[0]?.diagnostics).toContain("stage: range");
    expect(renderReadFailureFeedback(result.readFailures)).toContain("clause 2");
  });

  test("a read-only reply keeps successful reads beside the failed one", () => {
    const result = resolve(
      ["read src/a.ts within 1 done", "read src/a.ts within 99 done"].join("\n"),
      { "src/a.ts": "one\ntwo\n" },
    );
    expect(result.reads).toHaveLength(1);
    expect(result.readFailures).toHaveLength(1);
    expect(result.failures).toEqual([]);
  });
});
