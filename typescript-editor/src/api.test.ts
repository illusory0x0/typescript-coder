import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { applyEditDsl, readEditDsl } from "./api";

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

let directories: string[] = [];

function makeWorkspace(files: Record<string, string> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), "tc-api-"));
  directories.push(directory);
  for (const [path, source] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return directory;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function replacement(body: string, path = "src/helper.ts"): string {
  return [
    `select function answer in ${path}`,
    "replace with",
    "TC_EDIT_BEGIN",
    body,
    "TC_EDIT_END",
    "end",
  ].join("\n");
}

function writeFileReply(path: string, body: string): string {
  return ["write " + path + " with", "TC_EDIT_BEGIN", body, "TC_EDIT_END"].join("\n");
}

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories = [];
});

describe("readEditDsl", () => {
  test("read returns numbered lines and writes nothing", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");
    const before = read(target);

    const result = await readEditDsl("read src/helper.ts end", { cwd: directory });

    expect(result.ok).toBe(true);
    expect(result.reads).toHaveLength(1);
    expect(result.reads[0]?.path).toBe("src/helper.ts");
    expect(result.reads[0]?.lines[0]).toEqual({
      line: 1,
      text: "export function answer(): number {",
    });
    expect(result.text).toContain("Read results");
    expect(result.text).toContain("1 | export function answer(): number {");
    expect(read(target)).toBe(before);
  });

  test("viewer returns occurrences and writes nothing", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");
    const before = read(target);

    const result = await readEditDsl("select function answer in src/helper.ts end", {
      cwd: directory,
    });

    expect(result.ok).toBe(true);
    expect(result.reads).toEqual([]);
    expect(result.viewers).toHaveLength(1);
    expect(result.viewers[0]?.locator.name).toBe("answer");
    expect(result.text).toContain("Located occurrences");
    expect(result.text).toContain("export function answer(): number {");
    expect(read(target)).toBe(before);
  });

  test("rejects every mutation clause with stage: protocol", async () => {
    const directory = makeWorkspace({
      "src/helper.ts": HELPER,
      "src/old.ts": "export const old = 1;\n",
    });
    const target = join(directory, "src/helper.ts");
    const before = read(target);

    const mutations = [
      replacement("function answer(): number {\n  return 3;\n}"),
      writeFileReply("src/new.ts", "export const created = 1;"),
      "create src/empty.ts end",
      "delete src/old.ts end",
      "select function answer in src/helper.ts\nrename answer to result\nend",
    ];
    for (const mutation of mutations) {
      const result = await readEditDsl(mutation, { cwd: directory });
      expect(result.ok).toBe(false);
      expect(result.failures.some((failure) => failure.stage === "protocol")).toBe(true);
      expect(result.text).toContain("stage: protocol");
      expect(result.text).toContain("read-only");
    }
    expect(read(target)).toBe(before);
    expect(existsSync(join(directory, "src/new.ts"))).toBe(false);
    expect(existsSync(join(directory, "src/empty.ts"))).toBe(false);
    expect(existsSync(join(directory, "src/old.ts"))).toBe(true);
  });

  test("a failed read is returned in readFailures", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });

    const result = await readEditDsl("read src/helper.ts within 99 end", { cwd: directory });

    expect(result.ok).toBe(true);
    expect(result.reads).toEqual([]);
    expect(result.readFailures).toHaveLength(1);
    expect(result.text).toContain("Read failed");
  });
});

describe("applyEditDsl", () => {
  test("applies a whole-symbol replacement through the format/gate pipeline", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");

    const result = await applyEditDsl(
      replacement("export function answer(): number {\n  return 2;\n}"),
      { cwd: directory },
    );

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.changed).toEqual(["src/helper.ts"]);
    expect(result.created).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(read(target)).toContain("return 2;");
    expect(read(target)).not.toContain("return 1;");
  });

  test("applies write/create/delete commands and reports created/deleted", async () => {
    const directory = makeWorkspace({
      "src/helper.ts": HELPER,
      "src/old.ts": "export const old = 1;\n",
    });
    const text = [
      writeFileReply("src/new.ts", "export const created = 1;"),
      "create src/empty.ts end",
      "delete src/old.ts end",
    ].join("\n");

    const result = await applyEditDsl(text, { cwd: directory });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.changed).toEqual(["src/empty.ts", "src/new.ts"]);
    expect(result.created).toEqual(["src/empty.ts", "src/new.ts"]);
    expect(result.deleted).toEqual(["src/old.ts"]);
    expect(read(join(directory, "src/new.ts"))).toContain("export const created = 1;");
    expect(read(join(directory, "src/empty.ts"))).toBe("");
    expect(existsSync(join(directory, "src/old.ts"))).toBe(false);
  });

  test("a dry run reports the plan without mutating the workspace", async () => {
    const directory = makeWorkspace({
      "src/helper.ts": HELPER,
      "src/old.ts": "export const old = 1;\n",
    });
    const target = join(directory, "src/helper.ts");
    const oldFile = join(directory, "src/old.ts");
    const before = read(target);
    const oldBefore = read(oldFile);
    const text = [
      writeFileReply("src/helper.ts", "export const helper = 1;\n"),
      writeFileReply("src/new.ts", "export const created = 1;"),
      "create src/empty.ts end",
      "delete src/old.ts end",
    ].join("\n");

    const preview = await applyEditDsl(text, { cwd: directory, dryRun: true });

    expect(preview.ok).toBe(true);
    expect(preview.failures).toEqual([]);
    expect(preview.changed).toEqual(["src/empty.ts", "src/helper.ts", "src/new.ts"]);
    expect(preview.created).toEqual(["src/empty.ts", "src/new.ts"]);
    expect(preview.deleted).toEqual(["src/old.ts"]);
    expect(read(target)).toBe(before);
    expect(read(oldFile)).toBe(oldBefore);
    expect(existsSync(join(directory, "src/new.ts"))).toBe(false);
    expect(existsSync(join(directory, "src/empty.ts"))).toBe(false);

    const applied = await applyEditDsl(text, { cwd: directory });

    expect(applied.ok).toBe(true);
    expect(applied.changed).toEqual(preview.changed);
    expect(applied.created).toEqual(preview.created);
    expect(applied.deleted).toEqual(preview.deleted);
    expect(read(target)).toBe("export const helper = 1;\n");
    expect(read(join(directory, "src/new.ts"))).toContain("export const created = 1;");
    expect(read(join(directory, "src/empty.ts"))).toBe("");
    expect(existsSync(oldFile)).toBe(false);
  });

  test("a mixed reply applies the edit and returns read feedback", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");
    const text = [
      replacement("export function answer(): number {\n  return 4;\n}"),
      "read src/helper.ts end",
    ].join("\n\n");

    const result = await applyEditDsl(text, { cwd: directory });

    expect(result.ok).toBe(true);
    expect(result.changed).toEqual(["src/helper.ts"]);
    expect(result.reads).toHaveLength(1);
    expect(result.text).toContain("Read results");
    expect(read(target)).toContain("return 4;");
  });

  test("invalid DSL writes nothing", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");
    const before = read(target);

    const result = await applyEditDsl("this is not an edit reply", { cwd: directory });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.text).toContain("stage: syntax");
    expect(result.changed).toEqual([]);
    expect(read(target)).toBe(before);
  });

  test("an absent dotted member selector fails at address and writes nothing (#96)", async () => {
    const source = "export class N {\n  value = 1;\n}\n";
    const directory = makeWorkspace({ "src/new.ts": source });
    const target = join(directory, "src/new.ts");
    const text = [
      "select N.newMethod in src/new.ts",
      "replace with",
      "TC_EDIT_BEGIN",
      "  private newMethod(): void {",
      "    return;",
      "  }",
      "TC_EDIT_END",
    ].join("\n");

    const result = await applyEditDsl(text, { cwd: directory });

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).not.toContain("let N.newMethod");
    expect(result.text).toContain('create method N.newMethod in "src/new.ts" with <fence>');
    expect(result.changed).toEqual([]);
    expect(read(target)).toBe(source);
  });

  test("explicit create method Owner.name inserts the member (#96)", async () => {
    const source = "export class N {\n  value = 1;\n}\n";
    const directory = makeWorkspace({ "src/new.ts": source });
    const target = join(directory, "src/new.ts");
    const text = [
      "create method N.newMethod in src/new.ts with",
      "TC_EDIT_BEGIN",
      "  private newMethod(): void {",
      "    return;",
      "  }",
      "TC_EDIT_END",
    ].join("\n");

    const result = await applyEditDsl(text, { cwd: directory });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.changed).toEqual(["src/new.ts"]);
    const edited = read(target);
    expect(edited).toContain("private newMethod(): void {");
    expect(edited).toContain("value = 1;");
  });

  test("a clean edit plus one failing edit writes nothing", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");
    const before = read(target);
    const text = [
      replacement("export function answer(): number {\n  return 5;\n}"),
      writeFileReply("src/broken.ts", "export const = ;"),
    ].join("\n\n");

    const result = await applyEditDsl(text, { cwd: directory });

    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.changed).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(read(target)).toBe(before);
    expect(existsSync(join(directory, "src/broken.ts"))).toBe(false);
  });

  test("a failed read does not discard a clean mutation", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");
    const text = [
      replacement("export function answer(): number {\n  return 6;\n}"),
      "read src/helper.ts within 99 end",
    ].join("\n\n");

    const result = await applyEditDsl(text, { cwd: directory });

    expect(result.ok).toBe(true);
    expect(result.readFailures).toHaveLength(1);
    expect(result.failures).toEqual([]);
    expect(result.changed).toEqual(["src/helper.ts"]);
    expect(result.text).toContain("Read failed");
    expect(read(target)).toContain("return 6;");
  });

  test("a no-op replacement writes nothing and fails", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");
    const before = read(target);
    const text = [
      "select function answer in src/helper.ts",
      "match `return 1;`",
      "replace with",
      "TC_EDIT_BEGIN",
      "return 1;",
      "TC_EDIT_END",
      "end",
    ].join("\n");

    const result = await applyEditDsl(text, { cwd: directory });

    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.stage === "no-op")).toBe(true);
    expect(result.changed).toEqual([]);
    expect(read(target)).toBe(before);
  });

  test("creates parent directories for a new nested path", async () => {
    const directory = makeWorkspace();
    const text = writeFileReply("deep/nested/new.ts", "export const nested = 1;");

    const result = await applyEditDsl(text, { cwd: directory });

    expect(result.ok).toBe(true);
    expect(result.changed).toEqual(["deep/nested/new.ts"]);
    expect(result.created).toEqual(["deep/nested/new.ts"]);
    expect(existsSync(join(directory, "deep/nested/new.ts"))).toBe(true);
    expect(read(join(directory, "deep/nested/new.ts"))).toContain("export const nested = 1;");
  });

  test("dry run and apply agree on non-regular paths", async () => {
    const directory = makeWorkspace();
    for (const path of ["dircreate", "dirdelete", "dirwrite"]) {
      mkdirSync(join(directory, path));
    }
    const replies = [
      "create dircreate end",
      "delete dirdelete end",
      writeFileReply("dirwrite", "export const nope = true;"),
    ];

    for (const reply of replies) {
      const preview = await applyEditDsl(reply, { cwd: directory, dryRun: true });
      const applied = await applyEditDsl(reply, { cwd: directory });

      expect(preview.ok).toBe(false);
      expect(preview.failures.map((failure) => failure.diagnostics)).toEqual(
        applied.failures.map((failure) => failure.diagnostics),
      );
      expect(preview.failures[0]?.stage).toBe("address");
      expect(preview.text).toContain("not a regular file");
      expect(preview.changed).toEqual([]);
      expect(preview.created).toEqual([]);
      expect(preview.deleted).toEqual([]);
    }
    for (const path of ["dircreate", "dirdelete", "dirwrite"]) {
      expect(existsSync(join(directory, path))).toBe(true);
    }
  });
});

describe("applyEditDsl dry-run diffs", () => {
  test("a dry run with diff describes a modification and leaves every byte unchanged", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");

    const result = await applyEditDsl(
      replacement("export function answer(): number {\n  return 2;\n}"),
      { cwd: directory, dryRun: true, diff: true },
    );

    expect(result.ok).toBe(true);
    expect(result.diffs.map((entry) => entry.path)).toEqual(["src/helper.ts"]);
    const diff = result.diffs[0]?.diff ?? "";
    expect(diff).toContain("--- a/src/helper.ts");
    expect(diff).toContain("+++ b/src/helper.ts");
    expect(diff).toContain("@@ -");
    expect(diff).toContain("-  return 1;");
    expect(diff).toContain("+  return 2;");
    expect(read(target)).toBe(HELPER);
  });

  test("diffs are empty unless the dry run asks for them", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");
    const reply = replacement("export function answer(): number {\n  return 2;\n}");

    const preview = await applyEditDsl(reply, { cwd: directory, dryRun: true });
    expect(preview.diffs).toEqual([]);

    const applied = await applyEditDsl(reply, { cwd: directory });
    expect(applied.diffs).toEqual([]);
    expect(read(target)).toContain("return 2;");
  });

  test("create and delete sides use /dev/null, sorted by path", async () => {
    const directory = makeWorkspace({
      "src/helper.ts": HELPER,
      "src/old.ts": "export const old = 1;\n",
    });
    const oldSource = "export const old = 1;\n";
    const text = [
      writeFileReply("src/new.ts", "export const created = 1;\n"),
      writeFileReply("src/helper.ts", "export const helper = 1;\n"),
      "delete src/old.ts end",
    ].join("\n");

    const result = await applyEditDsl(text, { cwd: directory, dryRun: true, diff: true });

    expect(result.ok).toBe(true);
    expect(result.diffs.map((entry) => entry.path)).toEqual([
      "src/helper.ts",
      "src/new.ts",
      "src/old.ts",
    ]);
    expect(result.diffs[0]?.diff.startsWith("--- a/src/helper.ts\n+++ b/src/helper.ts\n")).toBe(
      true,
    );
    expect(result.diffs[1]?.diff.startsWith("--- /dev/null\n+++ b/src/new.ts\n")).toBe(true);
    expect(result.diffs[2]?.diff.startsWith("--- a/src/old.ts\n+++ /dev/null\n")).toBe(true);
    expect(read(join(directory, "src/helper.ts"))).toBe(HELPER);
    expect(read(join(directory, "src/old.ts"))).toBe(oldSource);
    expect(existsSync(join(directory, "src/new.ts"))).toBe(false);
  });

  test("separated changes produce multiple hunks", async () => {
    const lines = Array.from(
      { length: 20 },
      (_, index) => `export const value${index + 1} = ${index + 1};`,
    );
    const oldSource = `${lines.join("\n")}\n`;
    const changed = [...lines];
    changed[1] = "export const value2 = 200;";
    changed[16] = "export const value17 = 1700;";
    const newSource = `${changed.join("\n")}\n`;
    const directory = makeWorkspace({ "src/values.ts": oldSource });

    const result = await applyEditDsl(writeFileReply("src/values.ts", newSource), {
      cwd: directory,
      dryRun: true,
      diff: true,
    });

    expect(result.ok).toBe(true);
    const diff = result.diffs[0]?.diff ?? "";
    expect(diff.match(/^@@ /gm)).toHaveLength(2);
    expect(read(join(directory, "src/values.ts"))).toBe(oldSource);
  });

  test("a deleted file without a trailing newline gets the marker", async () => {
    const source = "export const value = 1;";
    const directory = makeWorkspace({ "src/nonl.ts": source });

    const result = await applyEditDsl("delete src/nonl.ts end", {
      cwd: directory,
      dryRun: true,
      diff: true,
    });

    expect(result.ok).toBe(true);
    const diff = result.diffs[0]?.diff ?? "";
    expect(diff).toContain("-export const value = 1;");
    expect(diff).toContain("\\ No newline at end of file");
    expect(read(join(directory, "src/nonl.ts"))).toBe(source);
  });

  test("diff without dryRun is rejected and writes nothing", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");

    const result = await applyEditDsl(
      replacement("export function answer(): number {\n  return 2;\n}"),
      { cwd: directory, diff: true },
    );

    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.stage === "protocol")).toBe(true);
    expect(result.diffs).toEqual([]);
    expect(read(target)).toBe(HELPER);
  });
});

describe("workspace path safety", () => {
  test("rejects traversal, absolute, protected, hidden-directory and node_modules paths", async () => {
    const directory = makeWorkspace({
      ".hidden/file.ts": "export const hidden = 1;\n",
      "node_modules/pkg/file.ts": "export const module = 1;\n",
    });
    const outside = join(directory, "..", "tc-api-outside.ts");
    writeFileSync(outside, "export const outside = 1;\n");
    const hidden = join(directory, ".hidden/file.ts");
    const moduleFile = join(directory, "node_modules/pkg/file.ts");
    try {
      const paths = [
        "../outside.ts",
        join(directory, "src/absolute.ts"),
        "human/spec.ts",
        ".hidden/file.ts",
        "node_modules/pkg/file.ts",
      ];
      for (const path of paths) {
        const result = await applyEditDsl(writeFileReply(path, "export const touched = 1;"), {
          cwd: directory,
        });
        expect(result.ok).toBe(false);
        expect(result.changed).toEqual([]);
        expect(result.created).toEqual([]);
      }
      expect(read(outside)).toBe("export const outside = 1;\n");
      expect(read(hidden)).toBe("export const hidden = 1;\n");
      expect(read(moduleFile)).toBe("export const module = 1;\n");
      expect(existsSync(join(directory, "src/absolute.ts"))).toBe(false);
      expect(existsSync(join(directory, "human/spec.ts"))).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("rejects symlink escapes for reads and writes", async () => {
    const directory = makeWorkspace();
    const outsideDirectory = mkdtempSync(join(tmpdir(), "tc-api-outside-"));
    const outsideFile = join(outsideDirectory, "secret.ts");
    writeFileSync(outsideFile, "export const secret = 1;\n");
    symlinkSync(outsideDirectory, join(directory, "link"), "dir");
    try {
      const readResult = await readEditDsl("read link/secret.ts end", { cwd: directory });
      expect(readResult.readFailures).toHaveLength(1);
      expect(readResult.readFailures[0]?.diagnostics).toContain("outside the workspace");

      const writeResult = await applyEditDsl(
        writeFileReply("link/secret.ts", "export const changed = 1;"),
        { cwd: directory },
      );
      expect(writeResult.ok).toBe(false);
      expect(writeResult.changed).toEqual([]);
      expect(read(outsideFile)).toBe("export const secret = 1;\n");

      const newFileResult = await applyEditDsl(
        writeFileReply("link/new.ts", "export const created = 1;"),
        { cwd: directory },
      );
      expect(newFileResult.ok).toBe(false);
      expect(existsSync(join(outsideDirectory, "new.ts"))).toBe(false);
    } finally {
      rmSync(outsideDirectory, { recursive: true, force: true });
    }
  });

  test("an unsafe select returns a typed failure instead of throwing", async () => {
    const directory = makeWorkspace();
    const outsideName = `${basename(directory)}-outside-select.ts`;
    const outside = join(dirname(directory), outsideName);
    const outsideRelative = `../${outsideName}`;
    const outsideSource = "export function secret(): number {\n  return 1;\n}\n";
    writeFileSync(outside, outsideSource);
    try {
      // A bare file-level select is already rejected by the parser, so it must
      // not reach `sourceFor` at all.
      const bareFile = await readEditDsl(`select file ${outsideRelative} end`, {
        cwd: directory,
      });
      expect(bareFile.ok).toBe(false);
      expect(bareFile.text.length).toBeGreaterThan(0);

      // A file-level select with a replacement reaches resolution; it must fail
      // with a typed address diagnostic before any source read.
      const fileLevel = await applyEditDsl(
        [
          `select file ${outsideRelative}`,
          "replace with",
          "TC_EDIT_BEGIN",
          "export function replaced(): number {",
          "  return 2;",
          "}",
          "TC_EDIT_END",
          "end",
        ].join("\n"),
        { cwd: directory },
      );
      expect(fileLevel.ok).toBe(false);
      expect(fileLevel.failures).toHaveLength(1);
      expect(fileLevel.failures[0]?.stage).toBe("address");
      expect(fileLevel.failures[0]?.diagnostics).toContain("outside the editable workspace");
      expect(fileLevel.changed).toEqual([]);
      expect(fileLevel.created).toEqual([]);

      // A declaration-level editor address outside the workspace takes the same
      // typed path, not an exception from `sourceFor`.
      const editor = await applyEditDsl(
        [
          `select function secret in ${outsideRelative}`,
          "replace with",
          "TC_EDIT_BEGIN",
          "export function secret(): number {",
          "  return 3;",
          "}",
          "TC_EDIT_END",
          "end",
        ].join("\n"),
        { cwd: directory },
      );
      expect(editor.ok).toBe(false);
      expect(editor.failures).toHaveLength(1);
      expect(editor.failures[0]?.stage).toBe("address");
      expect(editor.failures[0]?.diagnostics).toContain("outside the editable workspace");
      expect(editor.changed).toEqual([]);
      expect(editor.created).toEqual([]);
      expect(editor.text).toContain("outside the editable workspace");

      // The outside file was neither read into an edit nor written.
      expect(read(outside)).toBe(outsideSource);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("cwd must exist and be a directory", async () => {
    const directory = makeWorkspace();
    await expect(readEditDsl("", { cwd: join(directory, "missing") })).rejects.toThrow(
      /does not exist/,
    );
    const file = join(directory, "file.txt");
    writeFileSync(file, "x");
    await expect(readEditDsl("", { cwd: file })).rejects.toThrow(/not a directory/);
  });
});

describe("workspace rename apply", () => {
  const IMPORTER = ['import { helper } from "./b";', "export const n = helper();", ""].join("\n");
  const TARGET = "export function helper(): number { return 1; }\n";
  const REPLY = ["select function helper in src/b.ts", "rename helper to helper2", "end"].join(
    "\n",
  );

  test("dry-run lists every file and apply rolls back a partially written rename", async () => {
    const directory = makeWorkspace({ "src/a.ts": IMPORTER, "src/b.ts": TARGET });
    const importer = join(directory, "src/a.ts");
    const target = join(directory, "src/b.ts");

    const preview = await applyEditDsl(REPLY, { cwd: directory, dryRun: true });
    expect(preview.ok).toBe(true);
    expect(preview.failures).toEqual([]);
    expect(preview.changed).toEqual(["src/a.ts", "src/b.ts"]);
    expect(read(importer)).toBe(IMPORTER);
    expect(read(target)).toBe(TARGET);

    chmodSync(target, 0o444);
    try {
      const applied = await applyEditDsl(REPLY, { cwd: directory });
      expect(applied.ok).toBe(false);
      expect(applied.changed).toEqual([]);
      expect(applied.created).toEqual([]);
      expect(applied.deleted).toEqual([]);
      expect(applied.failures).toHaveLength(1);
      expect(applied.failures[0]?.diagnostics).toContain("rolled back");
      expect(read(importer)).toBe(IMPORTER);
      expect(read(target)).toBe(TARGET);
    } finally {
      chmodSync(target, 0o644);
    }
  });
});
