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

function editSpec(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    loc: { path: "src/helper.ts", symbol: "answer", kind: "value" },
    action: "modify",
    instruction: `Carry out edit ${id}.`,
    ...overrides,
  };
}

function taskSpec(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const edits = overrides["edits"] ?? [editSpec(id + 1_000)];
  return {
    id,
    verify: "test",
    instruction: `Carry out task ${id}.`,
    edits,
    ...overrides,
  };
}

function stageSpec(
  id: number,
  tasks: Record<string, unknown>[],
  goal = `Carry out stage ${id}.`,
): Record<string, unknown> {
  return { id, goal, tasks };
}

function planText(stages: Record<string, unknown>[]): string {
  return JSON.stringify({ stages });
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
    const provider = new ScriptedProvider([planText([stageSpec(1, [taskSpec(1)])]), GOOD_EDIT]);
    const result = await runLoop({
      ...baseOptions(dir, provider),
      protocolFormat: "edit-dsl",
    });
    expect(result.ok).toBe(true);
    expect(result.tasks?.map((entry) => entry.status)).toEqual(["done"]);
    // The planning call is the first provider call; the edit-dsl driver would
    // have started from its select-first system prompt instead.
    expect(provider.calls[0]?.[0]?.content).toContain("Stage -> Task -> edit");
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
  test("plans a Plan -> Stage -> Task -> edit tree, executes it, and verifies", async () => {
    const dir = project();
    const plan = planText([
      stageSpec(
        1,
        [
          taskSpec(1, {
            verify: "test",
            instruction: "Make the failing test green with a small change.",
            edits: [
              editSpec(1001, {
                instruction: "Change answer so it returns 2 instead of 1.",
              }),
            ],
          }),
        ],
        "Fix the answer behavior.",
      ),
    ]);
    const provider = new ScriptedProvider([plan, GOOD_EDIT]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
    expect(result.tasks?.map((entry) => entry.status)).toEqual(["done"]);
    const outcomes = result.records.map((record) => record.outcome);
    expect(outcomes).toEqual(["applied", "ok"]);
    expect(result.records[0]?.diagnostics).toBeNull();
    // The execution conversation starts with the tree and carries the current
    // stage/task/edit turn.
    expect(provider.calls[1]?.[0]?.content).toContain("one micro edit");
    expect(provider.calls[1]?.[1]?.content).toContain('"stages"');
    expect(provider.calls[1]?.at(-1)?.content).toContain("Fix the answer behavior.");
    expect(provider.calls[1]?.at(-1)?.content).toContain(
      "Make the failing test green with a small change.",
    );
    expect(provider.calls[1]?.at(-1)?.content).toContain(
      "Change answer so it returns 2 instead of 1.",
    );
  });

  test("a task gate waits for every edit in the task", async () => {
    const dir = project();
    // The first edit makes the file temporarily type-broken; the task gate
    // must not run until the second edit fixes it.
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export type Answer = 1;\nexport function answer(): Answer {\n  return 1;\n}\n",
    );
    const plan = planText([
      stageSpec(1, [
        taskSpec(1, {
          verify: "test",
          edits: [
            editSpec(1001, {
              loc: { path: "src/helper.ts", symbol: "Answer", kind: "type" },
              instruction: "Change Answer to 2.",
            }),
            editSpec(1002, {
              instruction: "Return 2 with the new Answer type.",
            }),
          ],
        }),
      ]),
    ]);
    const provider = new ScriptedProvider([
      plan,
      [
        "select Answer in src/helper.ts resolve type",
        "replace with",
        "-----",
        "export type Answer = 2;",
        "-----",
        "end",
      ].join("\n"),
      editDsl("export function answer(): Answer {\n  return 2;\n}"),
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["applied", "applied", "ok"]);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain(
      "export type Answer = 2;",
    );
    // Every edit turn starts from the stable system + Plan prefix instead of
    // accumulating the previous edit exchange.
    expect(provider.calls[2]?.length).toBe(3);
  }, 30000);

  test("stages and tasks run in array order with their own gates", async () => {
    const dir = project();
    writeFileSync(join(dir, "src", "settings.ts"), "export const other = 1;\n");
    const plan = planText([
      stageSpec(1, [
        taskSpec(1, {
          verify: "tsc",
          instruction: "Change the settings value.",
          edits: [
            editSpec(1001, {
              loc: { path: "src/settings.ts", symbol: "other", kind: "value" },
              instruction: "Change other to 2.",
            }),
          ],
        }),
      ]),
      stageSpec(2, [
        taskSpec(2, {
          verify: "test",
          instruction: "Make the failing test green.",
          edits: [
            editSpec(1002, {
              instruction: "Change answer so it returns 2.",
            }),
          ],
        }),
      ]),
    ]);
    const provider = new ScriptedProvider([
      plan,
      [
        "select other in src/settings.ts resolve value",
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
    expect(result.records.map((record) => record.outcome)).toEqual([
      "applied",
      "ok",
      "applied",
      "ok",
    ]);
    const verifications = result.records.filter((record) => record.kind === "verification");
    expect(verifications.map((record) => record.locator.name)).toEqual(["other", "answer"]);
    expect(readFileSync(join(dir, "src", "settings.ts"), "utf8")).toContain("other = 2");
  }, 30000);

  test("a failed task gate lets a later task in the same stage repair it", async () => {
    const dir = project();
    const plan = planText([
      stageSpec(1, [
        taskSpec(1, {
          verify: "test",
          instruction: "Try a first answer.",
          edits: [editSpec(1001, { instruction: "Return 3." })],
        }),
        taskSpec(2, {
          verify: "test",
          instruction: "Fix the answer if the previous task missed.",
          edits: [editSpec(1002, { instruction: "Return 2." })],
        }),
      ]),
    ]);
    const provider = new ScriptedProvider([
      plan,
      editDsl("export function answer(): number {\n  return 3;\n}"),
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(provider.calls.length).toBe(3);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "applied",
      "tests",
      "applied",
      "ok",
    ]);
    // The later task sees the earlier gate failure as coordination context.
    expect(provider.calls[2]?.at(-1)?.content).toContain("# Context");
    expect(provider.calls[2]?.at(-1)?.content).toContain("Task #1 gate failed");
  }, 30000);

  test("a failed task gate with no later task triggers a re-plan and reopens with a repair edit", async () => {
    const dir = project();
    const firstPlan = planText([
      stageSpec(1, [
        taskSpec(1, {
          verify: "test",
          instruction: "Try a first answer.",
          edits: [editSpec(1001, { instruction: "Return 3." })],
        }),
      ]),
    ]);
    const repairPlan = planText([
      stageSpec(1, [
        taskSpec(1, {
          verify: "test",
          instruction: "Try a first answer.",
          edits: [
            editSpec(1001, { instruction: "Return 3." }),
            editSpec(1002, { instruction: "Add the missing return-2 repair." }),
          ],
        }),
      ]),
    ]);
    const provider = new ScriptedProvider([
      firstPlan,
      editDsl("export function answer(): number {\n  return 3;\n}"),
      repairPlan,
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(provider.calls[2]?.at(-1)?.content).toContain("# Gate results");
    expect(provider.calls[2]?.at(-1)?.content).toContain("The task gate(s) #1 failed");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "applied",
      "tests",
      "applied",
      "ok",
    ]);
  }, 30000);

  test("a failed edit is reported to the planner, which changes its definition", async () => {
    const dir = project();
    const wrongTarget = editDsl("export function missing(): number {\n  return 2;\n}").replace(
      "select answer",
      "select missing",
    );
    const firstPlan = planText([stageSpec(1, [taskSpec(1)])]);
    const secondPlan = planText([
      stageSpec(1, [
        taskSpec(1, {
          edits: [
            editSpec(1001, {
              instruction: "Use a smaller edit on the existing answer declaration.",
            }),
          ],
        }),
      ]),
    ]);
    const provider = new ScriptedProvider([
      firstPlan,
      wrongTarget,
      wrongTarget,
      wrongTarget,
      secondPlan,
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records.filter((record) => record.outcome === "address").length).toBe(3);
    expect(provider.calls[4]?.at(-1)?.content).toContain("# Failed edits and diagnostics");
    expect(provider.calls[4]?.at(-1)?.content).toContain("did not land an edit");
  }, 30000);

  test("a create fence carrying extra declarations is rejected", async () => {
    const dir = project();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  return 2;\n}\n",
    );
    writeFileSync(join(dir, "src", "extra.ts"), "");
    const plan = planText([
      stageSpec(1, [
        taskSpec(1, {
          verify: "test",
          edits: [
            editSpec(1001, {
              loc: { path: "src/extra.ts", symbol: "run", kind: "value" },
              action: "create",
              instruction: "Add run.",
            }),
          ],
        }),
      ]),
    ]);
    const provider = new ScriptedProvider([
      plan,
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
    const plan = planText([
      stageSpec(1, [
        taskSpec(1, {
          verify: "test",
          edits: [
            editSpec(1001, {
              loc: { path: "src/helper.ts", symbol: "Answer", kind: "type" },
              related: [{ path: "src/helper.ts", symbol: "answer", kind: "value" }],
              instruction: "Migrate Answer to 2 and update answer.",
            }),
          ],
        }),
      ]),
    ]);
    const provider = new ScriptedProvider([
      plan,
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

  test("a delete edit removes a whole declaration and keeps the suite green", async () => {
    const dir = project();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  return 2;\n}\n",
    );
    writeFileSync(join(dir, "src", "unused.ts"), "export const unused = 1;\n");
    const plan = planText([
      stageSpec(1, [
        taskSpec(1, {
          verify: "test",
          edits: [
            editSpec(1001, {
              loc: { path: "src/unused.ts", symbol: "unused", kind: "value" },
              action: "delete",
              instruction: "Remove the unused declaration.",
            }),
          ],
        }),
      ]),
    ]);
    const provider = new ScriptedProvider([
      plan,
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

  test("an off-target edit is rejected without touching the file", async () => {
    const dir = project();
    writeFileSync(join(dir, "src", "other.ts"), "export const other = 1;\n");
    const plan = planText([stageSpec(1, [taskSpec(1)])]);
    const provider = new ScriptedProvider([
      plan,
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

  test("TASK_DONE before any edit is a protocol rejection", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])]);
    const provider = new ScriptedProvider([plan, "TASK_DONE", GOOD_EDIT]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records[0]?.outcome).toBe("protocol");
    expect(result.records[0]?.diagnostics).toContain("has not changed");
  });

  test("the same rejected plan repeated ends as task-exhausted", async () => {
    const dir = project();
    const bad = planText([
      stageSpec(1, [
        taskSpec(1, {
          verify: "tsc",
          edits: [editSpec(1001, { loc: { path: "../a.ts", symbol: "a", kind: "value" } })],
        }),
      ]),
    ]);
    const provider = new ScriptedProvider([bad, bad, bad]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("task-exhausted");
    expect(result.diagnostics).toContain("no valid plan");
  });

  test("a re-plan that repeats the same tree makes no progress", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])]);
    const provider = new ScriptedProvider([
      plan,
      // The edit never lands; after its exchange rounds it fails, and the
      // planner re-emits the identical tree on every attempt.
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
