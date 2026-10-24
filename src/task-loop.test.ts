import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "./loop";
import { runTaskLoop } from "./task-loop";
import type { ProviderLike } from "./loop";
import type { ChatMessage, ChatOptions, ChatResponse, ToolDefinition } from "./openai";

const TSC = [
  "bun",
  new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname,
  "--noEmit",
];

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

class ScriptedProvider implements ProviderLike {
  readonly calls: ChatMessage[][] = [];

  constructor(private readonly responses: string[]) {}

  async chat(
    messages: ChatMessage[],
    _tools?: ToolDefinition[],
    _options?: ChatOptions,
  ): Promise<ChatResponse> {
    this.calls.push(structuredClone(messages));
    const content = this.responses.shift();
    if (content === undefined) {
      throw new Error("no scripted response left");
    }
    return { content, toolCalls: [], finishReason: "stop", raw: {} };
  }
}

/** A minimal project: a failing test and the function it exercises. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "tctask-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", strict: true, noEmit: true },
      include: ["src"],
    }),
  );
  writeFileSync(
    join(dir, "src", "helper.ts"),
    "export function answer(): number {\n  return 1;\n}\n",
  );
  writeFileSync(join(dir, "bunfig.toml"), '[test]\nroot = "./src"\n');
  // Standalone projects have no bun type declarations; the shim keeps
  // `import { test } from "bun:test"` type-checkable under tsc.
  writeFileSync(
    join(dir, "src", "bun-shim.d.ts"),
    [
      'declare module "bun:test" {',
      "  export const test: (name: string, fn: () => void) => void;",
      "  export const expect: (value: unknown) => { toBe: (expected: unknown) => void; toContain: (expected: string) => void };",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "src", "helper.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      'import { answer } from "./helper";',
      'test("answer", () => {',
      "  expect(answer()).toBe(2);",
      "});",
      "",
    ].join("\n"),
  );
  return dir;
}

function planText(tasks: unknown[], todo: number[], status: Record<string, string>): string {
  return JSON.stringify({ tasks, todo, status });
}

function task(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    root: overrides["root"] ?? id,
    ...(overrides["root"] === undefined || overrides["root"] === id
      ? { verify: overrides["verify"] ?? "test" }
      : {}),
    loc: { path: "src/helper.ts", symbol: "answer", kind: "value" },
    deps: [],
    action: "modify",
    instruction: "Change answer so it returns 2.",
    ...overrides,
  };
}

function editDsl(replacement: string): string {
  return [
    "select answer in src/helper.ts resolve value",
    "replace with",
    "-----",
    replacement,
    "-----",
    "end",
  ].join("\n");
}

const GOOD_EDIT = editDsl("export function answer(): number {\n  return 2;\n}");

function baseOptions(dir: string, provider: ProviderLike) {
  return {
    cwd: dir,
    issue: "make the failing test pass",
    provider,
    agentMode: "plan-exec" as const,
    checkCommand: TSC,
    testCommand: ["bun", "test"],
    tokenBudget: 1_000_000,
  };
}

describe("runLoop dispatch", () => {
  test("agentMode plan-exec routes through the task driver", async () => {
    const dir = project();
    const provider = new ScriptedProvider([planText([task(1)], [1], { "1": "todo" }), GOOD_EDIT]);
    const result = await runLoop({
      ...baseOptions(dir, provider),
      protocolFormat: "edit-dsl",
    });
    expect(result.ok).toBe(true);
    expect(result.tasks?.map((entry) => entry.status)).toEqual(["done"]);
    // The planning call is the first provider call; the edit-dsl driver would
    // have started from its select-first system prompt instead.
    expect(provider.calls[0]?.[0]?.content).toContain("edit-task DAG");
  });

  test("the default edit mode is unchanged", async () => {
    const dir = project();
    const provider = new ScriptedProvider([
      [
        "select answer in src/helper.ts resolve value",
        "replace with",
        "-----",
        "export function answer(): number {\n  return 2;\n}",
        "-----",
        "end",
      ].join("\n"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the failing test pass",
      provider,
      protocolFormat: "edit-dsl",
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(provider.calls[0]?.[0]?.content).toContain("Edit-action DSL");
    expect(result.tasks).toBeUndefined();
  }, 30000);
});

describe("runTaskLoop", () => {
  test("plans one task, executes it, and verifies tsc + tests", async () => {
    const dir = project();
    const provider = new ScriptedProvider([planText([task(1)], [1], { "1": "todo" }), GOOD_EDIT]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
    expect(result.tasks?.map((entry) => entry.status)).toEqual(["done"]);
    const outcomes = result.records.map((record) => record.outcome);
    expect(outcomes).toEqual(["applied", "ok"]);
    // An applied edit carries no read feedback; a read-only turn does.
    expect(result.records[0]?.diagnostics).toBeNull();
    // The execution conversation starts with the DAG and carries the task turn.
    expect(provider.calls[1]?.[0]?.content).toContain("You receive one task at a time");
    expect(provider.calls[1]?.[1]?.content).toContain('"tasks"');
    expect(provider.calls[1]?.at(-1)?.content).toContain("Change answer so it returns 2.");
  });

  test("a root gate waits for every micro-task, then the next root runs tests", async () => {
    const dir = project();
    writeFileSync(join(dir, "src", "settings.ts"), "export const other = 1;\n");
    const provider = new ScriptedProvider([
      planText(
        [
          task(1, { verify: "tsc" }),
          task(2, {
            root: 1,
            deps: [1],
            loc: { path: "src/settings.ts", symbol: "other", kind: "value" },
          }),
          task(3, {
            deps: [1, 2],
            loc: { path: "src/settings.ts", symbol: "other", kind: "value" },
            instruction: "Change other to 3 for the test root.",
          }),
        ],
        [1],
        { "1": "todo", "2": "todo", "3": "todo" },
      ),
      GOOD_EDIT,
      [
        "select other in src/settings.ts resolve value",
        "replace with",
        "-----",
        "export const other = 2;",
        "-----",
        "end",
      ].join("\n"),
      [
        "select other in src/settings.ts resolve value",
        "replace with",
        "-----",
        "export const other = 3;",
        "-----",
        "end",
      ].join("\n"),
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "applied",
      "applied",
      "ok",
      "applied",
      "ok",
    ]);
    const verifications = result.records.filter((record) => record.kind === "verification");
    expect(verifications.map((record) => record.locator.name)).toEqual(["answer", "other"]);
    expect(readFileSync(join(dir, "src", "settings.ts"), "utf8")).toContain("other = 3");
  }, 30000);

  test("runs a dependency chain in order and stops at each type check", async () => {
    // A self-contained project: the chain test only cares about order and the
    // per-task type check, so its suite is green from the start.
    const dir = mkdtempSync(join(tmpdir(), "tcchain-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", strict: true, noEmit: true },
        include: ["src"],
      }),
    );
    writeFileSync(join(dir, "bunfig.toml"), '[test]\nroot = "./src"\n');
    writeFileSync(
      join(dir, "src", "total.ts"),
      "export function total(values: number[]): number {\n  return values.length;\n}\n\nexport function describe(values: number[]): string {\n  return `total ${total(values)}`;\n}\n",
    );
    writeFileSync(
      join(dir, "src", "total.test.ts"),
      'import { expect, test } from "bun:test";\nimport { describe } from "./total";\ntest("describe", () => {\n  expect(describe([1, 2])).toContain("total");\n});\n',
    );
    writeFileSync(
      join(dir, "src", "bun-shim.d.ts"),
      [
        'declare module "bun:test" {',
        "  export const test: (name: string, fn: () => void) => void;",
        "  export const expect: (value: unknown) => { toBe: (expected: unknown) => void; toContain: (expected: string) => void };",
        "}",
        "",
      ].join("\n"),
    );
    const chain = planText(
      [
        task(1, {
          loc: { path: "src/total.ts", symbol: "total", kind: "value" },
          instruction: "Change total so it sums the values instead of counting them.",
        }),
        task(2, {
          loc: { path: "src/total.ts", symbol: "total", kind: "value" },
          deps: [1],
          action: "rename",
          renameTo: "sum",
          instruction: "Rename total to sum; the same-file references in describe follow.",
        }),
      ],
      [1],
      { "1": "todo", "2": "todo" },
    );
    const provider = new ScriptedProvider([
      chain,
      [
        "select total in src/total.ts resolve value",
        "replace with",
        "-----",
        "export function total(values: number[]): number {\n  return values.reduce((sum, value) => sum + value, 0);\n}",
        "-----",
        "end",
      ].join("\n"),
      ["select total in src/total.ts resolve value", "rename total to sum", "end"].join("\n"),
    ]);
    const result = await runTaskLoop({
      ...baseOptions(dir, provider),
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "total.ts"), "utf8")).toContain("export function sum(");
    expect(result.tasks?.map((entry) => entry.status)).toEqual(["done", "done"]);
    // Each root has one gate after all of its micro-tasks finish.
    const verifications = result.records.filter((record) => record.kind === "verification");
    expect(verifications.length).toBeGreaterThanOrEqual(2);
  }, 30000);

  test("retries an invalid plan with its diagnostics before executing", async () => {
    const dir = project();
    const provider = new ScriptedProvider([
      planText([task(1, { deps: [1] })], [1], { "1": "todo" }),
      planText([task(1)], [1], { "1": "todo" }),
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(provider.calls[1]?.at(-1)?.content).toContain("stage: task-dag");
    expect(provider.calls[1]?.at(-1)?.content).toContain("lists itself as a dependency");
  });

  test("a failed micro-task is reported to the planner, which amends it", async () => {
    const dir = project();
    const wrongTarget = editDsl("export function missing(): number {\n  return 2;\n}").replace(
      "select answer",
      "select missing",
    );
    const provider = new ScriptedProvider([
      planText([task(1)], [1], { "1": "todo" }),
      // Three address misses exhaust the micro-task's exchange budget.
      wrongTarget,
      wrongTarget,
      wrongTarget,
      // The failed task's root is closed; the planner adds a fresh repair root.
      planText([task(1), task(2, { deps: [], instruction: "Repair answer to return 2." })], [2], {
        "1": "failed",
        "2": "todo",
      }),
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records.filter((record) => record.outcome === "address").length).toBe(3);
    expect(provider.calls[4]?.at(-1)?.content).toContain("# Failed tasks and diagnostics");
    expect(provider.calls[4]?.at(-1)?.content).toContain("did not land an edit");
  });

  test("a passing type check with a failing suite opens a re-plan", async () => {
    const dir = project();
    // The edit compiles but keeps the test red; the re-plan adds the task that
    // fixes it, and that task's edit passes both.
    const provider = new ScriptedProvider([
      // Task 1 compiles but leaves the suite red. The re-plan cannot amend a
      // done task, so it adds task 2 on the same declaration.
      planText([task(1)], [1], { "1": "todo" }),
      editDsl("export function answer(): number {\n  return 3;\n}"),
      planText([task(1), task(2, { deps: [1] })], [2], { "1": "done", "2": "todo" }),
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records.some((record) => record.outcome === "tests")).toBe(true);
    expect(provider.calls[2]?.at(-1)?.content).toContain("# Gate results");
    expect(provider.calls[2]?.at(-1)?.content).toContain(
      "A root gate failed after its micro-tasks completed.",
    );
  });

  test("a create task appends an absent declaration", async () => {
    const dir = project();
    // This test is about the create action, not the baseline failure: start green.
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  return 2;\n}\n",
    );
    writeFileSync(join(dir, "src", "extra.ts"), "");
    const provider = new ScriptedProvider([
      planText(
        [
          task(1, {
            loc: { path: "src/extra.ts", symbol: "double", kind: "value" },
            action: "create",
            instruction: "Add an exported double function.",
          }),
        ],
        [1],
        { "1": "todo" },
      ),
      [
        "select double in src/extra.ts resolve value",
        "replace with",
        "-----",
        "export function double(value: number): number {\n  return value * 2;\n}",
        "-----",
        "end",
      ].join("\n"),
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "extra.ts"), "utf8")).toContain("export function double");
  });

  test("a syntax rejection injects the on-demand format help", async () => {
    const dir = project();
    const provider = new ScriptedProvider([
      planText([task(1)], [1], { "1": "todo" }),
      [
        "select answer in src/helper.ts resolve value",
        "replace with",
        "-----",
        "export function answer(): number {",
        "  return 2;",
        "}",
      ].join("\n"),
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(provider.calls[2]?.at(-1)?.content).toContain("# Format help");
    expect(provider.calls[2]?.at(-1)?.content).toContain("Example for this action");
  }, 30000);

  test("a create fence carrying extra declarations is rejected", async () => {
    const dir = project();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  return 2;\n}\n",
    );
    writeFileSync(join(dir, "src", "extra.ts"), "");
    const provider = new ScriptedProvider([
      planText(
        [
          task(1, {
            loc: { path: "src/extra.ts", symbol: "run", kind: "value" },
            action: "create",
            instruction: "Add run.",
          }),
        ],
        [1],
        { "1": "todo" },
      ),
      [
        "select run in src/extra.ts resolve value",
        "replace with",
        "-----",
        [
          "type LispValue = number | boolean;",
          "export function run(): number {",
          "  return 2;",
          "}",
        ].join("\n"),
        "-----",
        "end",
      ].join("\n"),
      [
        "select run in src/extra.ts resolve value",
        "replace with",
        "-----",
        "export function run(): number {\n  return 2;\n}",
        "-----",
        "end",
      ].join("\n"),
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records[0]?.diagnostics).toContain("exactly one top-level declaration");
    const text = readFileSync(join(dir, "src", "extra.ts"), "utf8");
    expect(text).toContain("export function run");
    expect(text).not.toContain("LispValue");
  }, 30000);

  test("a related migration edits several same-file declarations atomically", async () => {
    const dir = project();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      [
        "export type Answer = 1;",
        "export function answer(): Answer {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
    );
    const provider = new ScriptedProvider([
      planText(
        [
          task(1, {
            loc: { path: "src/helper.ts", symbol: "Answer", kind: "type" },
            related: [{ path: "src/helper.ts", symbol: "answer", kind: "value" }],
            instruction: "Migrate Answer to 2 and update answer.",
          }),
        ],
        [1],
        { "1": "todo" },
      ),
      [
        "select Answer in src/helper.ts resolve type",
        "replace with",
        "-----",
        "export type Answer = 2;",
        "-----",
        "end",
        "select answer in src/helper.ts resolve value",
        "replace with",
        "-----",
        "export function answer(): Answer {\n  return 2;\n}",
        "-----",
        "end",
      ].join("\n"),
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const text = readFileSync(join(dir, "src", "helper.ts"), "utf8");
    expect(text).toContain("export type Answer = 2;");
    expect(text).toContain("return 2;");
  }, 30000);

  test("a delete task requires the empty-fence form", async () => {
    const dir = project();
    const provider = new ScriptedProvider([
      planText([task(1, { action: "delete", instruction: "Remove answer." })], [1], {
        "1": "todo",
      }),
      editDsl("export function answer(): number {\n  return 2;\n}"),
      [
        "select answer in src/helper.ts resolve value",
        "replace with",
        "-----",
        "-----",
        "end",
      ].join("\n"),
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    // The first reply is a non-empty fence on a delete task: rejected, then
    // the empty fence deletes. The remaining file no longer compiles, so the
    // run fails, which is what the test asserts about the form's enforcement.
    expect(provider.calls[2]?.at(-1)?.content).toContain("empty fence");
    expect(result.records[0]?.outcome).toBe("address");
  }, 30000);

  test("a delete task removes a whole declaration and keeps the suite green", async () => {
    const dir = project();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  return 2;\n}\n",
    );
    writeFileSync(join(dir, "src", "unused.ts"), "export const unused = 1;\n");
    const provider = new ScriptedProvider([
      planText(
        [
          task(1, {
            loc: { path: "src/unused.ts", symbol: "unused", kind: "value" },
            action: "delete",
            instruction: "Remove the unused declaration.",
          }),
        ],
        [1],
        { "1": "todo" },
      ),
      [
        "select unused in src/unused.ts resolve value",
        "replace with",
        "-----",
        "-----",
        "end",
      ].join("\n"),
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "unused.ts"), "utf8").trim()).toBe("");
  }, 30000);

  test("a whole-declaration empty fence is rejected under action modify", async () => {
    const dir = project();
    const provider = new ScriptedProvider([
      planText([task(1)], [1], { "1": "todo" }),
      [
        "select answer in src/helper.ts resolve value",
        "replace with",
        "-----",
        "-----",
        "end",
      ].join("\n"),
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records[0]?.diagnostics).toContain('action "delete"');
  }, 30000);

  test("a whole-symbol variable rewrite replaces the enclosing statement", async () => {
    const dir = project();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  return 2;\n}\n",
    );
    writeFileSync(join(dir, "src", "settings.ts"), "export const limit = 1;\n");
    const provider = new ScriptedProvider([
      planText(
        [
          task(1, {
            loc: { path: "src/settings.ts", symbol: "limit", kind: "value" },
            instruction: "Change limit to 2.",
          }),
        ],
        [1],
        { "1": "todo" },
      ),
      [
        "select limit in src/settings.ts resolve value",
        "replace with",
        "-----",
        "export const limit = 2;",
        "-----",
        "end",
      ].join("\n"),
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "settings.ts"), "utf8")).toBe("export const limit = 2;\n");
  }, 30000);

  test("a variable rename rewrites the binding without expanding to the statement", async () => {
    const dir = project();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  return 2;\n}\n",
    );
    writeFileSync(
      join(dir, "src", "settings.ts"),
      "export const limit = 1;\nexport const doubled = limit * 2;\n",
    );
    const provider = new ScriptedProvider([
      planText(
        [
          task(1, {
            loc: { path: "src/settings.ts", symbol: "limit", kind: "value" },
            action: "rename",
            renameTo: "max",
            instruction: "Rename limit to max.",
          }),
        ],
        [1],
        { "1": "todo" },
      ),
      ["select limit in src/settings.ts resolve value", "rename limit to max", "end"].join("\n"),
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "settings.ts"), "utf8")).toBe(
      "export const max = 1;\nexport const doubled = max * 2;\n",
    );
  }, 30000);

  test("a read statement before the editor does not shift the target guard", async () => {
    const dir = project();
    const provider = new ScriptedProvider([
      planText([task(1)], [1], { "1": "todo" }),
      [
        "read src/helper.test.ts done",
        "select answer in src/helper.ts resolve value",
        "replace with",
        "-----",
        "export function answer(): number {\n  return 2;\n}",
        "-----",
        "end",
      ].join("\n"),
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
    expect(result.records[0]?.diagnostics).toContain("Read results");
  }, 30000);

  test("an off-target edit is rejected without touching the file", async () => {
    const dir = project();
    writeFileSync(join(dir, "src", "other.ts"), "export const other = 1;\n");
    const provider = new ScriptedProvider([
      planText([task(1)], [1], { "1": "todo" }),
      [
        "select other in src/other.ts resolve value",
        "replace with",
        "-----",
        "export const other = 2;",
        "-----",
        "end",
      ].join("\n"),
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "other.ts"), "utf8")).toContain("other = 1");
    expect(result.records[0]?.outcome).toBe("address");
    expect(result.records[0]?.diagnostics).toContain("must edit only that declared target");
  });

  test("a match edit keeps its body fragment unprefixed", async () => {
    const dir = project();
    const provider = new ScriptedProvider([
      planText([task(1)], [1], { "1": "todo" }),
      [
        "select answer in src/helper.ts resolve value",
        "match `return 1;`",
        "replace with",
        "-----",
        "return 2;",
        "-----",
        "end",
      ].join("\n"),
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain(
      "export function answer(): number {",
    );
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
  }, 30000);

  test("a clause that resolves the wrong symbol space is rejected", async () => {
    const dir = project();
    const provider = new ScriptedProvider([
      planText([task(1)], [1], { "1": "todo" }),
      [
        "select answer in src/helper.ts resolve type",
        "replace with",
        "-----",
        "export function answer(): number {\n  return 2;\n}",
        "-----",
        "end",
      ].join("\n"),
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records[0]?.outcome).toBe("address");
    expect(result.records[0]?.diagnostics).toContain("task target is");
  }, 30000);

  test("TASK_DONE before any edit is a protocol rejection", async () => {
    const dir = project();
    const provider = new ScriptedProvider([
      planText([task(1)], [1], { "1": "todo" }),
      "TASK_DONE",
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records[0]?.outcome).toBe("protocol");
    expect(result.records[0]?.diagnostics).toContain("has not changed");
  });

  test("the same rejected plan repeated ends as task-exhausted", async () => {
    const dir = project();
    const bad = planText([task(1, { deps: [9] })], [1], { "1": "todo" });
    const provider = new ScriptedProvider([bad, bad, bad]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("task-exhausted");
    expect(result.diagnostics).toContain("no valid plan");
  });

  test("a re-plan that repeats the same DAG makes no progress", async () => {
    const dir = project();
    const plan = planText([task(1)], [1], { "1": "todo" });
    const provider = new ScriptedProvider([
      plan,
      // The task never edits anything; after its exchange rounds it fails, and
      // the planner re-emits the identical DAG.
      // 3 exchanges × 2 rounds exhaust the task, then the planner repeats the
      // unchanged failing task on each of its three re-plan attempts.
      ...Array.from({ length: 6 }, () => "TASK_DONE"),
      plan,
      plan,
      plan,
    ]);
    const result = await runTaskLoop({
      ...baseOptions(dir, provider),
      tokenBudget: 1_000_000,
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("task-exhausted");
  }, 30000);
});
