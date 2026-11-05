import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EDITOR_TOOL_NAME, dispatchEditorTool, editorTool } from "./tool";

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
  const directory = mkdtempSync(join(tmpdir(), "tc-tool-"));
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

function failingReplacement(path = "src/helper.ts"): string {
  return [
    `select answer in ${path}`,
    "pick 99",
    "replace with",
    "TC_EDIT_BEGIN",
    "return 9;",
    "TC_EDIT_END",
    "end",
  ].join("\n");
}

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories = [];
});

describe("dispatchEditorTool read mode", () => {
  test("dispatches a read reply and leaves the workspace unchanged", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");
    const before = read(target);

    const result = await dispatchEditorTool(
      { reply: "read src/helper.ts end" },
      { cwd: directory },
    );

    expect(result.ok).toBe(true);
    expect(result.reads).toHaveLength(1);
    expect(result.reads[0]?.path).toBe("src/helper.ts");
    expect(result.reads[0]?.lines[0]).toEqual({
      line: 1,
      text: "export function answer(): number {",
    });
    expect(result.text).toContain("Read results");
    expect(result.changed).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(read(target)).toBe(before);
  });

  test("rejects a mutation without write and leaves the file unchanged", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");
    const before = read(target);

    const result = await dispatchEditorTool(
      { reply: replacement("export function answer(): number {\n  return 2;\n}") },
      { cwd: directory },
    );

    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.stage === "protocol")).toBe(true);
    expect(result.text).toContain("read-only");
    expect(result.changed).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(read(target)).toBe(before);
  });

  test("a failed read is a failure result and writes nothing", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");
    const before = read(target);

    const result = await dispatchEditorTool(
      { reply: "read src/helper.ts within 99 end" },
      { cwd: directory },
    );

    expect(result.ok).toBe(false);
    expect(result.readFailures).toHaveLength(1);
    expect(result.text).toContain("Read failed");
    expect(result.changed).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(read(target)).toBe(before);
  });
});

describe("dispatchEditorTool write mode", () => {
  test("applies a replacement when write is true", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");

    const result = await dispatchEditorTool(
      {
        reply: replacement("export function answer(): number {\n  return 2;\n}"),
        write: true,
      },
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

  test("a failing edit reports failure and leaves the file unchanged", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const target = join(directory, "src/helper.ts");
    const before = read(target);

    const result = await dispatchEditorTool(
      { reply: failingReplacement(), write: true },
      { cwd: directory },
    );

    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.changed).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(read(target)).toBe(before);
  });
});

describe("dispatchEditorTool argument validation", () => {
  test("rejects malformed or unknown arguments with structured failures", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const invalidArgs: unknown[] = [
      {},
      { reply: 42 },
      { reply: "   " },
      { reply: "read src/helper.ts end", write: "yes" },
      { reply: "read src/helper.ts end", cwd: directory },
      "{not json",
    ];

    for (const args of invalidArgs) {
      const result = await dispatchEditorTool(args, { cwd: directory });
      expect(result.ok).toBe(false);
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.reads).toEqual([]);
      expect(result.viewers).toEqual([]);
      expect(result.failures).toEqual([]);
      expect(result.readFailures).toEqual([]);
      expect(result.changed).toEqual([]);
      expect(result.created).toEqual([]);
      expect(result.deleted).toEqual([]);
    }
  });

  test("rejects a missing workspace root", async () => {
    const result = await dispatchEditorTool({ reply: "read src/helper.ts end" }, { cwd: "" });

    expect(result.ok).toBe(false);
    expect(result.text).toContain("workspace root");
    expect(result.changed).toEqual([]);
  });
});

describe("dispatchEditorTool workspace and schema", () => {
  test("takes the workspace root only from options and accepts string arguments", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });

    const result = await dispatchEditorTool(JSON.stringify({ reply: "read src/helper.ts end" }), {
      cwd: directory,
    });

    expect(result.ok).toBe(true);
    expect(result.reads[0]?.path).toBe("src/helper.ts");

    const parameters = editorTool.function.parameters;
    const properties = parameters["properties"] as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["reply", "write"]);
    expect(JSON.stringify(parameters)).not.toContain("cwd");
    expect(parameters["required"]).toEqual(["reply"]);
    expect(parameters["additionalProperties"]).toBe(false);
    expect(editorTool.function.name).toBe(EDITOR_TOOL_NAME);
  });

  test("never spawns a process", async () => {
    const directory = makeWorkspace({ "src/helper.ts": HELPER });
    const spawn = spyOn(Bun, "spawn");

    try {
      const result = await dispatchEditorTool(
        { reply: "read src/helper.ts end" },
        { cwd: directory },
      );
      expect(result.ok).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });
});
