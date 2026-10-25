import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "./loop";
import { MAX_TASK_PLAN_ROUNDS, runTaskLoop } from "./task-loop";
import { serializePlanDsl } from "./plan-dsl";
import type { EditNode, Stage, TaskNode } from "./tasks";
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

  constructor(
    private readonly responses: string[],
    private readonly reviewResponses: string[] = [],
    private readonly rawUsage: Record<string, unknown> = {},
  ) {}

  async chat(
    messages: ChatMessage[],
    _tools?: ToolDefinition[],
    _options?: ChatOptions,
  ): Promise<ChatResponse> {
    this.calls.push(structuredClone(messages));
    const last = messages[messages.length - 1]?.content ?? "";
    const review = last.startsWith("# Review");
    const content = review ? (this.reviewResponses.shift() ?? "approve") : this.responses.shift();
    if (content === undefined) {
      throw new Error("no scripted response left");
    }
    return {
      content,
      toolCalls: [],
      finishReason: "stop",
      raw: { usage: this.rawUsage },
    };
  }
}

/** The review turns in call order, identified by their prompt header. */
function reviewPrompts(provider: ScriptedProvider): ChatMessage[][] {
  return provider.calls.filter((messages) =>
    (messages[messages.length - 1]?.content ?? "").startsWith("# Review"),
  );
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

function nodeId(kind: "stage" | "task" | "edit" | "main", label: number): string {
  return `${String(label).padStart(2, "0")}-${kind}`;
}

function editSpec(label: number, overrides: Partial<Omit<EditNode, "id">> = {}): EditNode {
  return {
    id: nodeId("edit", label),
    loc: { path: "src/helper.ts", symbol: "answer", kind: "value" },
    action: "modify",
    instruction: `Carry out edit ${label}.`,
    ...overrides,
  };
}

function taskSpec(label: number, overrides: Partial<Omit<TaskNode, "id">> = {}): TaskNode {
  return {
    id: nodeId("task", label),
    verify: "test",
    instruction: `Carry out task ${label}.`,
    edits: [editSpec(label + 1_000)],
    ...overrides,
  };
}

function stageSpec(label: number, tasks: TaskNode[], goal = `Carry out stage ${label}.`): Stage {
  return { id: nodeId("stage", label), goal, tasks };
}

function planText(stages: Stage[], finish = false): string {
  const wire = serializePlanDsl({
    id: nodeId("main", 1),
    goal: "Make the failing test pass.",
    stages,
  });
  return finish ? `${wire}\nfinish` : wire;
}

function patchText(...lines: string[]): string {
  return ["patch", ...lines].join("\n");
}

function editDsl(replacement: string): string {
  return [
    "select answer in src/helper.ts resolve value",
    "replace with",
    "<<<TC_EDIT_BEGIN>>>",
    replacement,
    "<<<TC_EDIT_END>>>",
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
    const provider = new ScriptedProvider([
      planText([stageSpec(1, [taskSpec(1)])], true),
      GOOD_EDIT,
    ]);
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
        "<<<TC_EDIT_BEGIN>>>",
        "export function answer(): number {\n  return 2;\n}",
        "<<<TC_EDIT_END>>>",
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
    const plan = planText(
      [
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
      ],
      true,
    );
    const provider = new ScriptedProvider([plan, GOOD_EDIT]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
    expect(result.tasks?.map((entry) => entry.status)).toEqual(["done"]);
    expect(result.tasks?.map((entry) => [entry.id, entry.stage, entry.task])).toEqual([
      [nodeId("edit", 1001), nodeId("stage", 1), nodeId("task", 1)],
    ]);
    const outcomes = result.records.map((record) => record.outcome);
    expect(outcomes).toEqual(["applied", "ok"]);
    expect(result.records[0]?.diagnostics).toBeNull();
    // The execution conversation starts with the flat Plan DSL and carries the
    // current stage/task/edit turn.
    expect(provider.calls[1]?.[0]?.content).toContain("one edit at a time");
    expect(provider.calls[1]?.[1]?.content).toContain('plan "01-main"');
    expect(provider.calls[1]?.[1]?.content).toContain(
      'task "01-task" stage "01-stage" verify test',
    );
    expect(provider.calls[1]?.at(-1)?.content).toContain("Fix the answer behavior.");
    expect(provider.calls[1]?.at(-1)?.content).toContain(
      "Make the failing test green with a small change.",
    );
    expect(provider.calls[1]?.at(-1)?.content).toContain(
      "Change answer so it returns 2 instead of 1.",
    );
  });

  test("a planner can inspect a declaration slice before planning", async () => {
    const dir = project();
    const plan = planText(
      [
        stageSpec(1, [
          taskSpec(1, {
            verify: "test",
            edits: [
              editSpec(1001, {
                instruction: "Change answer so it returns 2.",
              }),
            ],
          }),
        ]),
      ],
      true,
    );
    const provider = new ScriptedProvider([
      "select answer in src/helper.ts resolve value\nwithin 2-2\nend",
      plan,
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const viewPrompt = provider.calls[1]?.at(-1)?.content ?? "";
    expect(viewPrompt).toContain("# Source view");
    expect(viewPrompt).toContain("2 |   return 1;");
    expect(viewPrompt).not.toContain("1 | export function answer");
    expect(viewPrompt).toContain("# Next");
    expect(viewPrompt).toContain("initial Plan");
    expect(provider.calls[2]?.at(-1)?.content).toContain("# Content view");
  }, 30000);

  test("a planner gets at most one viewer per turn", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])], true);
    const viewer = "select answer in src/helper.ts resolve value\nend";
    const provider = new ScriptedProvider([viewer, viewer, plan, GOOD_EDIT]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(provider.calls[2]?.at(-1)?.content).toContain(
      "Only one viewer request is allowed per planning turn",
    );
  }, 30000);

  test("a planner viewer is read-only and a write request is rejected", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])], true);
    const provider = new ScriptedProvider([
      [
        "select answer in src/helper.ts resolve value",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "export function answer(): number {",
        "  return 2;",
        "}",
        "<<<TC_EDIT_END>>>",
        "end",
      ].join("\n"),
      plan,
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const viewPrompt = provider.calls[1]?.at(-1)?.content ?? "";
    expect(viewPrompt).toContain("# Source view");
    expect(viewPrompt).toContain("read-only");
    expect(viewPrompt).toContain("replace");
    expect(provider.calls[2]?.at(-1)?.content).toContain("# Content view");
  }, 30000);

  test("a task gate waits for every edit in the task", async () => {
    const dir = project();
    // The first edit makes the file temporarily type-broken; the task gate
    // must not run until the second edit fixes it.
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export type Answer = 1;\nexport function answer(): Answer {\n  return 1;\n}\n",
    );
    const plan = planText(
      [
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
      ],
      true,
    );
    const provider = new ScriptedProvider([
      plan,
      [
        "select Answer in src/helper.ts resolve type",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "export type Answer = 2;",
        "<<<TC_EDIT_END>>>",
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

  test("a next Stage patch appends its first Task after the current stage closes", async () => {
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
    ]);
    const patch = patchText(
      `stage+ "${nodeId("stage", 2)}" plan "${nodeId("main", 1)}"`,
      "goal: Make the failing test green.",
      "end",
      `task+ "${nodeId("task", 2)}" stage "${nodeId("stage", 2)}" verify test`,
      "instruction: Make the failing test green.",
      "end",
      `edit+ "${nodeId("edit", 1002)}" task "${nodeId("task", 2)}" modify value answer in src/helper.ts`,
      "instruction: Change answer so it returns 2.",
      "end",
      "finish",
    );
    const provider = new ScriptedProvider([
      plan,
      [
        "select other in src/settings.ts resolve value",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "export const other = 2;",
        "<<<TC_EDIT_END>>>",
        "end",
      ].join("\n"),
      patch,
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
    expect(provider.calls[3]?.at(-1)?.content).toContain("Reply with exactly one `patch`");
    expect(provider.calls[3]?.at(-1)?.content).toContain("Every Task is terminal");
  }, 30000);

  test("patches task A, task B, then the final test and finish across turns", async () => {
    const dir = project();
    const plan = planText([
      stageSpec(1, [
        taskSpec(1, {
          verify: "tsc",
          instruction: "Change the answer value.",
          edits: [editSpec(1001, { instruction: "Return 2." })],
        }),
      ]),
    ]);
    const nextTask = patchText(
      `stage+ "${nodeId("stage", 2)}" plan "${nodeId("main", 1)}"`,
      "goal: Add the next helper.",
      "end",
      `task+ "${nodeId("task", 2)}" stage "${nodeId("stage", 2)}" verify tsc`,
      "instruction: Add a small helper.",
      "end",
      `edit+ "${nodeId("edit", 1002)}" task "${nodeId("task", 2)}" create value note in src/extra.ts`,
      "instruction: Add a top-level note helper.",
      "end",
    );
    const finalTaskPatch = patchText(
      `stage+ "${nodeId("stage", 3)}" plan "${nodeId("main", 1)}"`,
      "goal: Finish with the final test.",
      "end",
      `task+ "${nodeId("task", 3)}" stage "${nodeId("stage", 3)}" verify test`,
      "instruction: Keep the suite green.",
      "end",
      `edit+ "${nodeId("edit", 1003)}" task "${nodeId("task", 3)}" modify value note in src/extra.ts`,
      "instruction: Change note to return 2.",
      "end",
      "finish",
    );
    const createNote = [
      "select note in src/extra.ts resolve value",
      "replace with",
      "<<<TC_EDIT_BEGIN>>>",
      "export function note(): number {",
      "  return 1;",
      "}",
      "<<<TC_EDIT_END>>>",
      "end",
    ].join("\n");
    const changeNote = editDsl("export function note(): number {\n  return 2;\n}").replace(
      "select answer in src/helper.ts",
      "select note in src/extra.ts",
    );
    const provider = new ScriptedProvider([
      plan,
      GOOD_EDIT,
      nextTask,
      createNote,
      finalTaskPatch,
      changeNote,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(provider.calls.length).toBe(9);
    for (const call of [provider.calls[3], provider.calls[6]]) {
      expect(call?.at(-1)?.content).toContain("Reply with exactly one `patch`");
      expect(call?.at(-1)?.content).not.toContain("Reply with the complete Plan DSL");
    }
    expect(result.records.map((record) => record.outcome)).toEqual([
      "applied",
      "ok",
      "applied",
      "ok",
      "applied",
      "ok",
    ]);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
    expect(readFileSync(join(dir, "src", "extra.ts"), "utf8")).toContain("return 2;");
  }, 30000);

  test("a failed task gate patches a repair task in the same stage", async () => {
    const dir = project();
    const plan = planText([
      stageSpec(1, [
        taskSpec(1, {
          verify: "test",
          instruction: "Try a first answer.",
          edits: [editSpec(1001, { instruction: "Return 3." })],
        }),
      ]),
    ]);
    const patch = patchText(
      `task+ "${nodeId("task", 2)}" stage "${nodeId("stage", 1)}" verify test`,
      "instruction: Fix the answer if the previous task missed.",
      "end",
      `edit+ "${nodeId("edit", 1002)}" task "${nodeId("task", 2)}" modify value answer in src/helper.ts`,
      "instruction: Return 2.",
      "end",
      "finish",
    );
    const provider = new ScriptedProvider(
      [plan, editDsl("export function answer(): number {\n  return 3;\n}"), patch, GOOD_EDIT],
      ["approve"],
    );
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(provider.calls.length).toBe(6);
    const reviews = reviewPrompts(provider);
    expect(reviews.length).toBe(2);
    expect(reviews[0]?.at(-1)?.content).toContain("Gate: test failed.");
    expect(reviews[1]?.at(-1)?.content).toContain("Gate: test passed.");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "applied",
      "tests",
      "applied",
      "ok",
    ]);
    // The patch names the failed gate; the repair task sees it as coordination context.
    expect(provider.calls[3]?.at(-1)?.content).toContain("# Gate results");
    expect(provider.calls[3]?.at(-1)?.content).toContain(
      `The task gate(s) #${nodeId("task", 1)} failed`,
    );
    expect(provider.calls[4]?.at(-1)?.content).toContain("# Context");
    expect(provider.calls[4]?.at(-1)?.content).toContain(`Task #${nodeId("task", 1)} gate failed`);
  }, 30000);

  test("a review patch reopens the task, re-executes it, and gets no second review", async () => {
    const dir = project();
    const plan = planText(
      [
        stageSpec(1, [
          taskSpec(1, {
            verify: "test",
            edits: [editSpec(1001, { instruction: "Return 3 on the first attempt." })],
          }),
        ]),
      ],
      true,
    );
    const reviewPatch = patchText(
      `task~ "${nodeId("task", 1)}"`,
      "instruction: Repair the answer after review.",
      "end",
      `edit+ "${nodeId("edit", 1002)}" task "${nodeId("task", 1)}" modify value answer in src/helper.ts`,
      "instruction: Return 2.",
      "end",
    );
    const provider = new ScriptedProvider(
      [plan, editDsl("export function answer(): number {\n  return 3;\n}"), GOOD_EDIT],
      [reviewPatch],
    );
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(reviewPrompts(provider).length).toBe(1);
    // plan, failed edit, review, re-execution: no second review after the fix.
    expect(provider.calls.length).toBe(4);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "applied",
      "tests",
      "applied",
      "ok",
    ]);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
  }, 30000);

  test("a failed review re-execution is not reviewed twice and plans a repair", async () => {
    const dir = project();
    const plan = planText(
      [
        stageSpec(1, [
          taskSpec(1, {
            verify: "test",
            edits: [editSpec(1001, { instruction: "Return 3 on the first attempt." })],
          }),
        ]),
      ],
      true,
    );
    const reviewPatch = patchText(
      `edit+ "${nodeId("edit", 1002)}" task "${nodeId("task", 1)}" modify value answer in src/helper.ts`,
      "instruction: Return 2.",
      "end",
    );
    const repairPatch = patchText(
      `task~ "${nodeId("task", 1)}"`,
      "instruction: Repair the answer after the failed re-execution.",
      "end",
      `edit+ "${nodeId("edit", 1003)}" task "${nodeId("task", 1)}" modify value answer in src/helper.ts`,
      "instruction: Return 2 on the final attempt.",
      "end",
    );
    const provider = new ScriptedProvider(
      [
        plan,
        editDsl("export function answer(): number {\n  return 3;\n}"),
        editDsl("export function answer(): number {\n  return 4;\n}"),
        repairPatch,
        GOOD_EDIT,
      ],
      [reviewPatch],
    );
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(reviewPrompts(provider).length).toBe(1);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "applied",
      "tests",
      "applied",
      "tests",
      "applied",
      "ok",
    ]);
    expect(provider.calls[4]?.at(-1)?.content).toContain("The task gate(s) #01-task failed");
  }, 30000);

  test("a review patch may mark the current final test task with finish", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])]);
    const provider = new ScriptedProvider([plan, GOOD_EDIT], ["patch\nfinish"]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(reviewPrompts(provider).length).toBe(1);
    // The finish-only patch reopens the Task; the second gate is local.
    expect(provider.calls.length).toBe(3);
    expect(result.records.map((record) => record.outcome)).toEqual(["applied", "ok", "ok"]);
  }, 30000);

  test("a review patch may not add a future Stage or Task", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])]);
    const future = patchText(
      `stage+ "${nodeId("stage", 2)}" plan "${nodeId("main", 1)}"`,
      "goal: Future stage.",
      "end",
      `task+ "${nodeId("task", 3)}" stage "${nodeId("stage", 2)}" verify test`,
      "instruction: Future work.",
      "end",
    );
    const provider = new ScriptedProvider(
      [plan, editDsl("export function answer(): number {\n  return 3;\n}")],
      [future],
    );
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("task-exhausted");
    expect(result.diagnostics).toContain(`stage+ #${nodeId("stage", 2)}`);
    expect(result.diagnostics).toContain(`task+ #${nodeId("task", 3)}`);
    expect(result.diagnostics).toContain("future work");
    expect(reviewPrompts(provider).length).toBe(1);
  }, 30000);

  test("a review patch may not edit another Task", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])]);
    const foreign = patchText(
      `edit+ "${nodeId("edit", 1002)}" task "${nodeId("task", 2)}" modify value answer in src/helper.ts`,
      "instruction: Future work.",
      "end",
    );
    const provider = new ScriptedProvider(
      [plan, editDsl("export function answer(): number {\n  return 3;\n}")],
      [foreign],
    );
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("task-exhausted");
    expect(result.diagnostics).toContain(`targets task #${nodeId("task", 2)}`);
    expect(reviewPrompts(provider).length).toBe(1);
  }, 30000);

  test("a malformed review patch gets one format retry and can repair the task", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])], true);
    const reviewPatch = patchText(
      `task~ "${nodeId("task", 1)}"`,
      "instruction: Repair the answer after review.",
      "end",
      `edit+ "${nodeId("edit", 1002)}" task "${nodeId("task", 1)}" modify value answer in src/helper.ts`,
      "instruction: Return 2.",
      "end",
    );
    const provider = new ScriptedProvider(
      [plan, editDsl("export function answer(): number {\n  return 3;\n}"), GOOD_EDIT],
      [plan, reviewPatch],
    );
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(reviewPrompts(provider).length).toBe(2);
    const retry = reviewPrompts(provider)[1]?.at(-1)?.content ?? "";
    expect(retry).toContain("The previous review reply was rejected.");
    expect(retry).toContain("do not repeat `task`");
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
  }, 30000);

  test("a review edit~ on a done edit gets one correction retry", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])], true);
    const doneEditPatch = patchText(
      `edit~ "${nodeId("edit", 1001)}"`,
      "instruction: Repair the done edit.",
      "end",
    );
    const provider = new ScriptedProvider([plan, GOOD_EDIT], [doneEditPatch, "approve"]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(reviewPrompts(provider)).toHaveLength(2);
    const retry = reviewPrompts(provider)[1]?.at(-1)?.content ?? "";
    expect(retry).toContain("done edit");
    expect(retry).toContain("Do not use `edit~`");
    expect(retry).toContain("edit+");
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
  }, 30000);

  test("a second done-edit review mutation terminates", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])], true);
    const doneEditPatch = patchText(
      `edit~ "${nodeId("edit", 1001)}"`,
      "instruction: Repair the done edit.",
      "end",
    );
    const provider = new ScriptedProvider([plan, GOOD_EDIT], [doneEditPatch, doneEditPatch]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("task-exhausted");
    expect(result.diagnostics).toContain("done edit");
    expect(reviewPrompts(provider)).toHaveLength(2);
  }, 30000);

  test("two malformed review replies terminate after one format retry", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])]);
    const provider = new ScriptedProvider(
      [plan, editDsl("export function answer(): number {\n  return 3;\n}")],
      [plan, plan],
    );
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("task-exhausted");
    expect(result.diagnostics).toContain("neither approve nor one valid repair patch");
    expect(result.diagnostics).toContain("expected the patch header");
    expect(reviewPrompts(provider).length).toBe(2);
  }, 30000);

  test("the review prompt carries the gate result and only the applied diff", async () => {
    const dir = project();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      [
        "// sentinel-unchanged",
        "export function helperOne(): number {",
        "  return 0;",
        "}",
        "export function helperTwo(): number {",
        "  return 0;",
        "}",
        "export function helperThree(): number {",
        "  return 0;",
        "}",
        "export function answer(): number {",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
    );
    const plan = planText([stageSpec(1, [taskSpec(1)])], true);
    const provider = new ScriptedProvider([plan, GOOD_EDIT]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const review = reviewPrompts(provider)[0]?.at(-1)?.content ?? "";
    expect(review).toContain("Gate: test passed.");
    expect(review).toContain("--- a/src/helper.ts");
    expect(review).toContain("+++ b/src/helper.ts");
    expect(review).toContain("@@");
    expect(review).toContain("-  return 1;");
    expect(review).toContain("+  return 2;");
    expect(review).toContain(`Task #${nodeId("task", 1)} (verify test) — review`);
    expect(review).toContain("Reply with exactly `approve` or one `patch`");
    expect(review).toContain(`task~ "${nodeId("task", 1)}"`);
    expect(review).toContain("Do not repeat `task`");
    expect(review).toContain("A done edit is immutable");
    expect(review).toContain("Never use `edit~` on a done edit");
    expect(review).not.toContain('task~ "#');
    expect(review).toContain("Do not add a Stage or Task");
    // The requirement and unchanged source stay in the cached planning prefix,
    // not in the review turn.
    expect(review).not.toContain("make the failing test pass");
    expect(review).not.toContain("sentinel-unchanged");
    expect(review).not.toContain("helperOne");
  }, 30000);

  test("review usage is its own bucket and the run total is the sum", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])], true);
    const rawUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const provider = new ScriptedProvider([plan, GOOD_EDIT], [], rawUsage);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const usage = result.usage;
    expect(usage).toBeDefined();
    if (usage === undefined) {
      return;
    }
    expect(usage.planning.total).toBe(15);
    expect(usage.execution.total).toBe(15);
    expect(usage.review.total).toBe(15);
    expect(result.tokens.total).toBe(45);
    expect(result.tokens.total).toBe(
      usage.planning.total + usage.review.total + usage.execution.total,
    );
    expect(result.tokens.input).toBe(30);
    expect(result.tokens.output).toBe(15);
  }, 30000);

  test("a review call counts toward the run token budget", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])], true);
    const rawUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const provider = new ScriptedProvider([plan, GOOD_EDIT], [], rawUsage);
    const result = await runTaskLoop({ ...baseOptions(dir, provider), tokenBudget: 34 });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("token-budget");
    expect(result.usage?.review.total).toBe(15);
    expect(result.diagnostics).toContain("token budget");
  }, 30000);

  test("a failed final task reopens in place and keeps finalTaskId", async () => {
    const dir = project();
    const firstPlan = planText(
      [
        stageSpec(1, [
          taskSpec(1, {
            verify: "test",
            instruction: "Try a first answer.",
            edits: [editSpec(1001, { instruction: "Return 3." })],
          }),
        ]),
      ],
      true,
    );
    const repairPatch = patchText(
      `task~ "${nodeId("task", 1)}"`,
      "instruction: Repair the first answer in place.",
      "end",
      `edit+ "${nodeId("edit", 1002)}" task "${nodeId("task", 1)}" modify value answer in src/helper.ts`,
      "instruction: Return 2 instead of 3.",
      "end",
    );
    const provider = new ScriptedProvider([
      firstPlan,
      editDsl("export function answer(): number {\n  return 3;\n}"),
      repairPatch,
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(provider.calls[3]?.at(-1)?.content).toContain("# Gate results");
    expect(provider.calls[3]?.at(-1)?.content).toContain(
      `The task gate(s) #${nodeId("task", 1)} failed`,
    );
    expect(result.records.map((record) => record.outcome)).toEqual([
      "applied",
      "tests",
      "applied",
      "ok",
    ]);
  }, 30000);

  test("a plan with a recovered missing end is accepted and logs the warning", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])], true);
    const missingEnd = plan.replace(/\nend(\nfinish)$/, "$1");
    const provider = new ScriptedProvider([missingEnd, GOOD_EDIT]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.warnings?.some((warning) => warning.includes("PLAN_MISSING_END"))).toBe(true);
  }, 30000);

  test("a malformed multi-clause action writes nothing from its valid first clause", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])], true);
    const partial = [
      "select answer in src/helper.ts resolve value",
      "replace with",
      "<<<TC_EDIT_BEGIN>>>",
      "export function answer(): number {\n  return 99;\n}",
      "<<<TC_EDIT_END>>>",
      "end",
      "select answer in src/helper.ts resolve value",
      "pick 1",
      "end",
    ].join("\n");
    const provider = new ScriptedProvider([plan, partial, GOOD_EDIT]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records[0]?.diagnostics).toContain("EDIT_PICK_WITHOUT_REPLACE");
    expect(result.records[1]?.outcome).toBe("applied");
    const text = readFileSync(join(dir, "src", "helper.ts"), "utf8");
    expect(text).toContain("return 2;");
    expect(text).not.toContain("return 99;");
  }, 30000);

  test("a recovered missing end is applied and logged as a warning", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])], true);
    const missingEnd = GOOD_EDIT.slice(0, -"\nend".length);
    const provider = new ScriptedProvider([plan, missingEnd]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.warnings?.some((warning) => warning.includes("EDIT_MISSING_END"))).toBe(true);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
  }, 30000);

  test("a malformed initial plan is retried without building a partial tree", async () => {
    const dir = project();
    const valid = planText([stageSpec(1, [taskSpec(1)])], true);
    const malformed = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "99-missing" verify test
instruction: x
end

edit "04-change" task "03-first" modify value answer in src/helper.ts
instruction: x
end`;
    const provider = new ScriptedProvider([malformed, valid, GOOD_EDIT]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const retry = provider.calls[1]?.at(-1)?.content ?? "";
    expect(retry).toContain("PLAN_UNKNOWN_PARENT");
    expect(retry).toContain("99-missing");
    expect(result.tasks?.map((entry) => entry.status)).toEqual(["done"]);
  }, 30000);

  test("a multi-task initial plan is retried with explicit compression rules", async () => {
    const dir = project();
    const valid = planText([stageSpec(1, [taskSpec(1)])], true);
    const malformed = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "02-current" verify tsc
instruction: first
end

edit "04-change" task "03-first" modify value answer in src/helper.ts
instruction: change
end

task "05-second" stage "02-current" verify test
instruction: second
end`;
    const provider = new ScriptedProvider([malformed, valid, GOOD_EDIT]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const retry = provider.calls[1]?.at(-1)?.content ?? "";
    expect(retry).toContain("task records must come before edit records");
    expect(retry).toContain("keep only the current Task");
    expect(retry).toContain("Put every task record before every edit record");
    expect(retry).toContain("Do not emit finish");
  }, 30000);

  test("a whole-file write edit replaces the file and verifies", async () => {
    const dir = project();
    const plan = planText(
      [
        stageSpec(1, [
          taskSpec(1, {
            verify: "test",
            edits: [
              editSpec(1001, {
                loc: { path: "src/helper.ts", symbol: "", kind: "file" },
                action: "write",
                instruction: "Write the complete module.",
              }),
            ],
          }),
        ]),
      ],
      true,
    );
    const provider = new ScriptedProvider([
      plan,
      [
        "write src/helper.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        "export function answer(): number {",
        "  return 2;",
        "}",
        "<<<TC_EDIT_END>>>",
      ].join("\n"),
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain(
      "export function answer(): number",
    );
    expect(result.tasks?.map((entry) => entry.action)).toEqual(["write"]);
  }, 30000);

  test("an inline write opener applies without a protocol retry", async () => {
    const dir = project();
    const plan = planText(
      [
        stageSpec(1, [
          taskSpec(1, {
            verify: "test",
            edits: [
              editSpec(1001, {
                loc: { path: "src/helper.ts", symbol: "", kind: "file" },
                action: "write",
                instruction: "Write the complete module.",
              }),
            ],
          }),
        ]),
      ],
      true,
    );
    const provider = new ScriptedProvider([
      plan,
      [
        "write src/helper.ts with <<<TC_EDIT_BEGIN>>>",
        "export function answer(): number {",
        "  return 2;",
        "}",
        "<<<TC_EDIT_END>>>",
      ].join("\n"),
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["applied", "ok"]);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain(
      "export function answer(): number",
    );
  }, 30000);

  test("a failed edit is reported to the planner, which changes its definition", async () => {
    const dir = project();
    const wrongTarget = editDsl("export function missing(): number {\n  return 2;\n}").replace(
      "select answer",
      "select missing",
    );
    const firstPlan = planText([stageSpec(1, [taskSpec(1)])], true);
    const retryPatch = patchText(
      `edit~ "${nodeId("edit", 1001)}"`,
      "instruction: Use a smaller edit on the existing answer declaration.",
      "end",
    );
    const provider = new ScriptedProvider([
      firstPlan,
      wrongTarget,
      wrongTarget,
      retryPatch,
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records.filter((record) => record.outcome === "address").length).toBe(2);
    expect(provider.calls[3]?.at(-1)?.content).toContain("# Failed edits and diagnostics");
    expect(provider.calls[3]?.at(-1)?.content).toContain("ADDRESS_RETRY_LIMIT");
  }, 30000);

  test("a create fence carrying extra declarations is rejected", async () => {
    const dir = project();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  return 2;\n}\n",
    );
    writeFileSync(join(dir, "src", "extra.ts"), "");
    const plan = planText(
      [
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
      ],
      true,
    );
    const provider = new ScriptedProvider([
      plan,
      [
        "select run in src/extra.ts resolve value",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        [
          "type LispValue = number | boolean;",
          "export function run(): number {",
          "  return 2;",
          "}",
        ].join("\n"),
        "<<<TC_EDIT_END>>>",
        "end",
      ].join("\n"),
      [
        "select run in src/extra.ts resolve value",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "export function run(): number {\n  return 2;\n}",
        "<<<TC_EDIT_END>>>",
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
    const plan = planText(
      [
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
      ],
      true,
    );
    const provider = new ScriptedProvider([
      plan,
      [
        "select Answer in src/helper.ts resolve type",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "export type Answer = 2;",
        "<<<TC_EDIT_END>>>",
        "end",
        "select answer in src/helper.ts resolve value",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "export function answer(): Answer {\n  return 2;\n}",
        "<<<TC_EDIT_END>>>",
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
    const plan = planText(
      [
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
      ],
      true,
    );
    const provider = new ScriptedProvider([
      plan,
      [
        "select unused in src/unused.ts resolve value",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "<<<TC_EDIT_END>>>",
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
    const plan = planText([stageSpec(1, [taskSpec(1)])], true);
    const provider = new ScriptedProvider([
      plan,
      [
        "select other in src/other.ts resolve value",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "export const other = 2;",
        "<<<TC_EDIT_END>>>",
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
    const plan = planText([stageSpec(1, [taskSpec(1)])], true);
    const provider = new ScriptedProvider([plan, "TASK_DONE", GOOD_EDIT]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records[0]?.outcome).toBe("protocol");
    expect(result.records[0]?.diagnostics).toContain("has not changed");
  });

  test("the initial plan must be exactly one current Stage and one current Task", async () => {
    const dir = project();
    const twoStages = planText([
      stageSpec(1, [taskSpec(1)]),
      stageSpec(2, [taskSpec(2, { verify: "tsc" })]),
    ]);
    const twoTasks = planText([stageSpec(1, [taskSpec(1), taskSpec(2, { verify: "tsc" })])]);
    const valid = planText([stageSpec(1, [taskSpec(1)])], true);
    const provider = new ScriptedProvider([twoStages, twoTasks, valid, GOOD_EDIT]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(provider.calls[1]?.at(-1)?.content).toContain("exactly one current Stage");
    expect(provider.calls[2]?.at(-1)?.content).toContain("exactly one current Task");
    expect(result.records.map((record) => record.outcome)).toEqual(["applied", "ok"]);
  }, 30000);

  test("a full Plan reply is rejected as a patch; a bare finish patch completes", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])]);
    const provider = new ScriptedProvider([plan, GOOD_EDIT, plan, "patch\nfinish"]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(provider.calls.length).toBe(5);
    const retry = provider.calls[4]?.at(-1)?.content ?? "";
    expect(retry).toContain("expected the patch header");
    expect(retry).toContain("Do not re-emit the Plan");
    expect(result.records.map((record) => record.outcome)).toEqual(["applied", "ok"]);
  }, 30000);

  test("a new final test task supersedes a failed final task", async () => {
    const dir = project();
    const plan = planText(
      [
        stageSpec(1, [
          taskSpec(1, {
            instruction: "Try a first answer.",
            edits: [editSpec(1001, { instruction: "Return 3." })],
          }),
        ]),
      ],
      true,
    );
    const patch = patchText(
      `stage+ "${nodeId("stage", 2)}" plan "${nodeId("main", 1)}"`,
      "goal: Repair with a new final test.",
      "end",
      `task+ "${nodeId("task", 2)}" stage "${nodeId("stage", 2)}" verify test`,
      "instruction: Make the failing test green.",
      "end",
      `edit+ "${nodeId("edit", 1002)}" task "${nodeId("task", 2)}" modify value answer in src/helper.ts`,
      "instruction: Change answer so it returns 2.",
      "end",
      "finish",
    );
    const provider = new ScriptedProvider([
      plan,
      editDsl("export function answer(): number {\n  return 3;\n}"),
      patch,
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(provider.calls[3]?.at(-1)?.content).toContain("# Gate results");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "applied",
      "tests",
      "applied",
      "ok",
    ]);
  }, 30000);

  test("a patch that adds two new Tasks is rejected as one-unit", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])]);
    const twoTasks = patchText(
      `task+ "${nodeId("task", 2)}" stage "${nodeId("stage", 1)}" verify test`,
      "instruction: First repair.",
      "end",
      `edit+ "${nodeId("edit", 1002)}" task "${nodeId("task", 2)}" modify value answer in src/helper.ts`,
      "instruction: Return 2.",
      "end",
      `task+ "${nodeId("task", 3)}" stage "${nodeId("stage", 1)}" verify test`,
      "instruction: Second repair.",
      "end",
      `edit+ "${nodeId("edit", 1003)}" task "${nodeId("task", 3)}" modify value answer in src/helper.ts`,
      "instruction: Return 2.",
      "end",
    );
    const repair = patchText(
      `task+ "${nodeId("task", 2)}" stage "${nodeId("stage", 1)}" verify test`,
      "instruction: Make the failing test green.",
      "end",
      `edit+ "${nodeId("edit", 1002)}" task "${nodeId("task", 2)}" modify value answer in src/helper.ts`,
      "instruction: Return 2.",
      "end",
      "finish",
    );
    const provider = new ScriptedProvider([
      plan,
      editDsl("export function answer(): number {\n  return 3;\n}"),
      twoTasks,
      repair,
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(provider.calls[4]?.at(-1)?.content).toContain("at most one new Task");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "applied",
      "tests",
      "applied",
      "ok",
    ]);
  }, 30000);

  test("a new Stage is rejected while the current Stage still has a pending Task", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])]);
    const reopen = patchText(
      `task~ "${nodeId("task", 1)}"`,
      "instruction: Repair the task in place.",
      "end",
    );
    const earlyStage = patchText(
      `stage+ "${nodeId("stage", 2)}" plan "${nodeId("main", 1)}"`,
      "goal: Start a later phase too early.",
      "end",
      `task+ "${nodeId("task", 2)}" stage "${nodeId("stage", 2)}" verify test`,
      "instruction: Make the failing test green.",
      "end",
      `edit+ "${nodeId("edit", 1002)}" task "${nodeId("task", 2)}" modify value answer in src/helper.ts`,
      "instruction: Return 2.",
      "end",
      "finish",
    );
    const repair = patchText(
      `edit~ "${nodeId("edit", 1001)}"`,
      "instruction: Return 2 with the original edit.",
      "end",
      "finish",
    );
    const provider = new ScriptedProvider([
      plan,
      "TASK_DONE",
      "TASK_DONE",
      "TASK_DONE",
      reopen,
      earlyStage,
      repair,
      GOOD_EDIT,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(provider.calls[6]?.at(-1)?.content).toContain(
      "a new Stage is allowed only when the current Stage has no pending Task",
    );
    expect(result.records.map((record) => record.outcome)).toEqual([
      "protocol",
      "protocol",
      "protocol",
      "applied",
      "ok",
    ]);
  }, 30000);

  test("the 32-turn planning cap terminates with task-exhausted", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])]);
    const goalPatches = Array.from({ length: MAX_TASK_PLAN_ROUNDS - 1 }, (_, index) =>
      patchText('plan~ "01-main"', `goal: Planning turn ${index + 2}.`, "end"),
    );
    const provider = new ScriptedProvider([
      plan,
      "TASK_DONE",
      "TASK_DONE",
      "TASK_DONE",
      ...goalPatches,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("task-exhausted");
    expect(result.diagnostics).toContain(`${MAX_TASK_PLAN_ROUNDS} planning turns`);
    // The run's summary call follows the 32 planning turns.
    expect(provider.calls.length).toBe(1 + 3 + goalPatches.length + 1);
    expect(goalPatches.length).toBe(MAX_TASK_PLAN_ROUNDS - 1);
    // An edit that never landed runs no gate, so it gets no review turn.
    expect(reviewPrompts(provider).length).toBe(0);
  }, 30000);

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

  test("patch planning attempts are bounded per turn", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])]);
    const badPatch = patchText("nope", "end");
    const provider = new ScriptedProvider([
      plan,
      "TASK_DONE",
      "TASK_DONE",
      "TASK_DONE",
      badPatch,
      badPatch,
      badPatch,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("task-exhausted");
    expect(result.diagnostics).toContain("no valid patch after 3 attempts");
  }, 30000);

  test("a patch that leaves the Plan unchanged makes no progress", async () => {
    const dir = project();
    const plan = planText([stageSpec(1, [taskSpec(1)])]);
    const provider = new ScriptedProvider([
      plan,
      // The edit never lands; after its exchange rounds it fails. An empty
      // patch applies cleanly but changes neither the Plan nor finalTaskId.
      "TASK_DONE",
      "TASK_DONE",
      "TASK_DONE",
      "patch",
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("task-exhausted");
    expect(result.diagnostics).toContain("left the Plan and finalTaskId unchanged");
  }, 30000);
});
