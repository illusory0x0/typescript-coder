import { describe, expect, test } from "bun:test";
import { renderReadFailureFeedback, renderReadFeedback, resolveMultiEditor } from "./multi-editor";
import type { MultiEditorDeps } from "./multi-editor";
import { parseMultiEditor } from "./selection";
import { buildIndexTolerant } from "./utility";
import type { Locator, SymbolSpace } from "./utility";

function resolveEntryIn(
  current: string,
  currentPath: string,
  locator: Locator,
  space: SymbolSpace | null,
): ReturnType<MultiEditorDeps["resolveEntry"]> {
  const { index } = buildIndexTolerant([{ path: currentPath, source: current }]);
  const matches = index.lookup(locator, space);
  const entry = matches[0];
  if (matches.length === 1 && entry !== undefined) {
    return { ok: true, entry };
  }
  return {
    ok: false,
    diagnostics: "stage: address\nno unique declaration",
    undeclared: index.byName(locator.name).length === 0,
  };
}

function deps(
  files: Record<string, string>,
  unsafe: ReadonlySet<string> = new Set(),
): MultiEditorDeps {
  return {
    sourceFor: (path) => files[path] ?? "",
    fileExists: (path) => Object.prototype.hasOwnProperty.call(files, path),
    isSafePath: (path) => !unsafe.has(path),
    resolveEntry: resolveEntryIn,
  };
}

function resolve(text: string, files: Record<string, string>, unsafe?: ReadonlySet<string>) {
  return resolveMultiEditor(parseMultiEditor(text), deps(files, unsafe));
}

describe("resolveMultiEditor file commands", () => {
  test("create queues an empty file and rejects an existing path", () => {
    const ok = resolve("create src/new.ts end", {});
    expect(ok.failures).toEqual([]);
    expect(ok.creates).toEqual([{ index: 0, path: "src/new.ts" }]);

    const exists = resolve("create src/a.ts end", { "src/a.ts": "x" });
    expect(exists.creates).toEqual([]);
    expect(exists.failures[0]?.diagnostics).toContain("already exists");
  });

  test("delete queues an existing file and rejects a missing path", () => {
    const ok = resolve("delete src/a.ts end", { "src/a.ts": "x" });
    expect(ok.deletes).toEqual([{ index: 0, path: "src/a.ts" }]);

    const missing = resolve("delete src/a.ts end", {});
    expect(missing.deletes).toEqual([]);
    expect(missing.failures[0]?.diagnostics).toContain("does not exist");
  });

  test("read returns whole-file lines or selected lines without writing", () => {
    const files = { "src/a.ts": "one\ntwo\nthree\n" };
    const whole = resolve("read src/a.ts end", files);
    expect(whole.reads[0]?.lines).toEqual([
      { line: 1, text: "one" },
      { line: 2, text: "two" },
      { line: 3, text: "three" },
    ]);
    expect(whole.regions).toEqual([]);

    const selected = resolve("read src/a.ts within 2 end", files);
    expect(selected.reads[0]?.lines).toEqual([{ line: 2, text: "two" }]);
  });

  test("a huge read result folds to three head and three tail lines", () => {
    const source = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const read = resolve("read src/a.ts end", { "src/a.ts": source });
    const feedback = renderReadFeedback(read.reads);
    expect(feedback).toContain("src/a.ts (whole file, 10 lines; folded):");
    expect(feedback).toContain("1 | line 1");
    expect(feedback).toContain("3 | line 3");
    expect(feedback).toContain("... // content folded, src/a.ts: 4-7L");
    expect(feedback).toContain("(4 of 10 lines hidden)");
    expect(feedback).toContain("expand with read src/a.ts within 4-7 end");
    expect(feedback).toContain("8 | line 8");
    expect(feedback).toContain("10 | line 10");
    expect(feedback).not.toContain("4 | line 4");
  });

  test("a whole-file read folds top-level function bodies into an outline", () => {
    const source = [
      "export function first(): number {",
      "  const a = 1;",
      "  if (a > 0) {",
      "    const b = 2;",
      "    const c = 3;",
      "    return b + c;",
      "  }",
      "  return a;",
      "}",
      "export function second(): number {",
      "  return 2;",
      "}",
    ].join("\n");
    const read = resolve("read src/a.ts end", { "src/a.ts": source });
    const feedback = renderReadFeedback(read.reads);
    expect(feedback).toContain("src/a.ts (whole file, 12 lines; folded):");
    expect(feedback).toContain("1 | export function first(): number {");
    expect(feedback).toContain("... // content folded, src/a.ts: 2-8L");
    expect(feedback).toContain("9 | }");
    expect(feedback).toContain("10 | export function second(): number {");
    expect(feedback).not.toContain("4 |     const b = 2;");
  });

  test("a selected-lines read is the expansion and comes back unfolded", () => {
    const source = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
    const read = resolve("read src/a.ts within 1-20 end", { "src/a.ts": source });
    const feedback = renderReadFeedback(read.reads);
    expect(feedback).toContain("src/a.ts (selected lines, 20 lines):");
    expect(feedback).toContain("1 | line 1");
    expect(feedback).toContain("20 | line 20");
    expect(feedback).not.toContain("content folded");
    expect(feedback).not.toContain("showing 6");
  });

  test("a short read keeps the quiet header shape", () => {
    const read = resolve("read src/a.ts end", { "src/a.ts": "one\ntwo\nthree\n" });
    const feedback = renderReadFeedback(read.reads);
    expect(feedback).toContain("src/a.ts (whole file, 3 lines):");
    expect(feedback).not.toContain("folded");
  });

  test("write with no within replaces the whole file", () => {
    const result = resolve(
      [
        "write src/a.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        "export const a = 2;",
        "<<<TC_EDIT_END>>>",
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
      ].join("\n"),
      {},
    );
    expect(result.failures).toEqual([]);
    expect(result.regions[0]).toMatchObject({ path: "src/new.ts", start: 0, end: 0 });
  });

  test("rejects unsafe paths", () => {
    const result = resolve("create ../outside.ts end", {}, new Set(["../outside.ts"]));
    expect(result.creates).toEqual([]);
    expect(result.failures[0]?.diagnostics).toContain("outside the editable workspace");
  });

  test("conflicts create/delete with another operation on the same path", () => {
    const createWrite = resolve(
      [
        "create src/a.ts end",
        "write src/a.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        "x",
        "<<<TC_EDIT_END>>>",
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
        "read src/a.ts within 99 end",
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
      ["read src/a.ts within 1 end", "read src/a.ts within 99 end"].join("\n"),
      { "src/a.ts": "one\ntwo\n" },
    );
    expect(result.reads).toHaveLength(1);
    expect(result.readFailures).toHaveLength(1);
    expect(result.failures).toEqual([]);
  });
});

const HELPER = [
  "export function answer(): number {",
  "  return 1;",
  "}",
  "",
  "export function other(): number {",
  "  return 2;",
  "}",
  "",
].join("\n");

function replaceClause(name: string, body: string, path = "src/helper.ts"): string {
  return [
    `select function ${name} in ${path}`,
    "match `return 1;`",
    "replace with",
    "<<<TC_EDIT_BEGIN>>>",
    body,
    "<<<TC_EDIT_END>>>",
    "end",
  ].join("\n");
}

function renameClause(name: string, to: string, path = "src/helper.ts"): string {
  return `select function ${name} in ${path}\nrename ${name} to ${to}\nend`;
}

describe("resolveMultiEditor unique resolved targets (#40)", () => {
  test("rename + replace on one declaration is a duplicate", () => {
    const result = resolve(
      [replaceClause("answer", "return 3;"), renameClause("answer", "result")].join("\n\n"),
      { "src/helper.ts": HELPER },
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.index).toBe(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    expect(result.failures[0]?.diagnostics).toContain(
      'clause 1 and clause 2 both select the same function "answer" in "src/helper.ts"',
    );
    // The first clause is queued; the duplicate rename contributes no edits.
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.index).toBe(0);
  });

  test("two renames of one declaration are duplicates", () => {
    const result = resolve(
      [renameClause("answer", "result"), renameClause("answer", "renamed")].join("\n\n"),
      { "src/helper.ts": HELPER },
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.index).toBe(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    expect(result.failures[0]?.diagnostics).toContain(
      'clause 1 and clause 2 both select the same function "answer" in "src/helper.ts"',
    );
    // Only the first rename's edit is queued.
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.index).toBe(0);
    expect(result.regions[0]?.text).toBe("result");
  });

  test("a viewer and a rename on one declaration are duplicates", () => {
    const viewer = "select function answer in src/helper.ts\nmatch `return 1;`\nend";
    const result = resolve([viewer, renameClause("answer", "result")].join("\n\n"), {
      "src/helper.ts": HELPER,
    });
    expect(result.viewers).toHaveLength(1);
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.index).toBe(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    expect(result.failures[0]?.diagnostics).toContain(
      'clause 1 and clause 2 both select the same function "answer" in "src/helper.ts"',
    );
  });

  test("a rename of one declaration and an edit of another are allowed", () => {
    const result = resolve(
      [replaceClause("answer", "return 3;"), renameClause("other", "second")].join("\n\n"),
      { "src/helper.ts": HELPER },
    );
    expect(result.failures).toEqual([]);
    expect(result.regions.map((region) => region.index)).toEqual([0, 1]);
  });

  test("the same symbol renamed in another file is allowed", () => {
    const result = resolve(
      [
        replaceClause("answer", "return 3;", "src/a.ts"),
        renameClause("answer", "result", "src/b.ts"),
      ].join("\n\n"),
      { "src/a.ts": HELPER, "src/b.ts": HELPER },
    );
    expect(result.failures).toEqual([]);
    expect(result.regions.map((region) => region.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a rename registered before an editor still names both clause numbers", () => {
    const result = resolve(
      [renameClause("answer", "result"), replaceClause("answer", "return 3;")].join("\n\n"),
      { "src/helper.ts": HELPER },
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    expect(result.failures[0]?.diagnostics).toContain(
      'clause 1 and clause 2 both select the same function "answer" in "src/helper.ts"',
    );
    // The editor is claimed first, so the rename (clause 1) is the rejected
    // clause and its edits are not queued.
    expect(result.failures[0]?.index).toBe(0);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.index).toBe(1);
  });
});
