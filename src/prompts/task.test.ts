import { describe, expect, test } from "bun:test";
import {
  buildTaskExecutionSystemPrompt,
  buildTaskPlanRetryPrompt,
  buildTaskPlanningSystemPrompt,
  buildTaskPlanningUserPrompt,
  buildTaskReplanPrompt,
  buildTaskTurnPrompt,
  replanDelta,
  renderTaskContentView,
  TASK_PLAN_COMPLEX_EXAMPLE,
  TASK_PLAN_EXAMPLE,
  TASK_PLAN_PARALLEL_EXAMPLE,
  TASK_REPLAN_EXAMPLE,
} from "./task";
import { initialState, parseTaskPlan, readPlan } from "../tasks";
import type { EditTask, TaskRunState } from "../tasks";

const TASK: EditTask = {
  id: 1,
  loc: { path: "src/helper.ts", symbol: "answer", kind: "value" },
  deps: [],
  action: "modify",
  instruction: "Change answer so it returns 2.",
};

function stateOf(tasks: EditTask[] = [TASK]): TaskRunState {
  const parsed = parseTaskPlan(
    JSON.stringify({
      tasks,
      todo: tasks.filter((task) => task.deps.length === 0).map((task) => task.id),
      status: Object.fromEntries(tasks.map((task) => [String(task.id), "todo"])),
    }),
  );
  if (!parsed.ok) {
    throw new Error(parsed.diagnostics);
  }
  return initialState(parsed.plan);
}

describe("planning prompts", () => {
  test("the system prompt teaches every field, the invariants, and both examples", () => {
    const prompt = buildTaskPlanningSystemPrompt();
    for (const field of [
      '"id"',
      '"loc"',
      '"parent"',
      '"deps"',
      '"action"',
      '"instruction"',
      '"renameTo"',
      '"todo"',
      '"status"',
    ]) {
      expect(prompt).toContain(field);
    }
    expect(prompt).toContain("symbol space");
    expect(prompt).toContain("type-correct");
    expect(prompt).toContain("Reply with ONLY one bare JSON object");
    expect(prompt).toContain('"kind": "value"');
    // Both JSON examples survive verbatim so a planner can copy their shape.
    expect(prompt).toContain(TASK_PLAN_EXAMPLE);
    expect(prompt).toContain(TASK_PLAN_COMPLEX_EXAMPLE);
    expect(prompt).toContain(TASK_PLAN_PARALLEL_EXAMPLE);
    // The minimal example is front-loaded, before the field reference.
    expect(prompt.indexOf(TASK_PLAN_EXAMPLE)).toBeLessThan(prompt.indexOf("Fields:"));
    expect(prompt).not.toContain("```json");
    // And they are themselves valid plans for the parser.
    expect(parseTaskPlan(TASK_PLAN_EXAMPLE).ok).toBe(true);
    expect(parseTaskPlan(TASK_PLAN_COMPLEX_EXAMPLE).ok).toBe(true);
    expect(parseTaskPlan(TASK_PLAN_PARALLEL_EXAMPLE).ok).toBe(true);
  });

  test("the first user prompt carries the requirement and the index", () => {
    const prompt = buildTaskPlanningUserPrompt("add a helper", "select helper in src/a.ts");
    expect(prompt).toContain("# Requirement\n\nadd a helper");
    expect(prompt).toContain("select helper in src/a.ts");
    expect(prompt).toContain("complete task plan JSON");
  });

  test("the retry prompt names the rejection", () => {
    expect(buildTaskPlanRetryPrompt("stage: task-dag\n- bad")).toContain("stage: task-dag");
  });

  test("a re-plan prompt carries the DAG, status, failures, and tests", () => {
    const state = stateOf();
    state.status.set(1, "failed");
    const prompt = buildTaskReplanPrompt({
      state,
      failures: new Map([[1, "stage: tsc\nTS2322"]]),
      testDiagnostics: "expected 2, got 1",
      delta: replanDelta({ failedIds: [1], testsFailed: false, blocked: false }),
    });
    expect(prompt).toContain("# Edit-task DAG");
    expect(prompt).toContain('#1 modify value "answer" in "src/helper.ts"');
    expect(prompt).toContain("# Status");
    expect(prompt).toContain("#1 failed");
    expect(prompt).toContain("TS2322");
    expect(prompt).toContain("expected 2, got 1");
    expect(prompt).toContain("The failed task(s) #1 could not be carried out.");
    expect(prompt).toContain("A failed task may be retried only by changing its definition");
    expect(prompt).toContain(TASK_REPLAN_EXAMPLE);
  });

  test("a test-failure re-plan names the test verdict", () => {
    const state = stateOf();
    state.status.set(1, "done");
    const prompt = buildTaskReplanPrompt({
      state,
      failures: new Map(),
      testDiagnostics: "1 test failed",
      delta: replanDelta({ failedIds: [], testsFailed: true, blocked: false }),
    });
    expect(prompt).toContain("the test suite fails");
  });

  test("a blocked re-plan asks for graph repair", () => {
    expect(replanDelta({ failedIds: [], testsFailed: false, blocked: true })).toContain(
      "No task is ready to run",
    );
  });

  test("readPlan accepts the examples as re-plans too", () => {
    const state = stateOf();
    state.status.set(1, "done");
    const merged = readPlan(
      JSON.stringify({
        tasks: [{ ...TASK, id: 1 }],
        todo: [],
        status: { "1": "done" },
      }),
    );
    expect(merged.ok).toBe(true);
  });
});

describe("execution prompts", () => {
  test("the system prompt teaches the edit-action grammar and the task report word", () => {
    const prompt = buildTaskExecutionSystemPrompt();
    expect(prompt).toContain("select … end");
    expect(prompt).toContain("TASK_DONE");
    expect(prompt).toContain("Reply shape: `select <symbol> in <path>");
    expect(prompt).toContain("Action-specific rules:");
    for (const action of ["modify", "create", "delete", "rename"]) {
      expect(prompt).toContain(`- ${action}:`);
    }
  });

  test("the turn prompt puts the task first and the content view last", () => {
    const state = stateOf();
    const prompt = buildTaskTurnPrompt({
      state,
      task: TASK,
      contentView: renderTaskContentView("export function answer(): number {\n  return 1;\n}"),
      diagnostics: "stage: protocol\nbad clause",
    });
    expect(prompt).toContain("# Task");
    expect(prompt).toContain("#1 (modify) — todo");
    expect(prompt).toContain(TASK.instruction);
    expect(prompt).toContain("1 | export function answer");
    expect(prompt.indexOf("# Task")).toBeLessThan(prompt.indexOf("# Project status"));
    expect(prompt.indexOf("# Diagnostics")).toBeLessThan(prompt.indexOf("# Content view"));
    expect(prompt).toContain('{"request":"read"}');
    expect(
      prompt.endsWith(
        "Reply with the edit clauses for this task. After an edit lands, reply `TASK_DONE` to finish it.",
      ),
    ).toBe(true);
  });

  test("a rename turn names the new identifier and an empty view renders explicitly", () => {
    const state = stateOf([{ ...TASK, action: "rename", renameTo: "result" }]);
    const prompt = buildTaskTurnPrompt({
      state,
      task: state.tasks[0] as EditTask,
      contentView: "",
    });
    expect(prompt).toContain('rename to "result"');
    expect(prompt).toContain("(empty)");
    expect(prompt).toContain("select … rename");
  });

  test("the content view numbers lines from 1 and keeps source order", () => {
    expect(renderTaskContentView("a\nb")).toBe("1 | a\n2 | b");
    expect(renderTaskContentView("")).toBe("");
  });
});
