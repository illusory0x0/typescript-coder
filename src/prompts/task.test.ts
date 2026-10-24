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
  taskEditDslHelp,
  TASK_PLAN_COMPLEX_EXAMPLE,
  TASK_PLAN_EXAMPLE,
} from "./task";
import { initialState, parseTaskPlan, readPlan } from "../tasks";
import type { EditTask, TaskRunState } from "../tasks";

const TASK: EditTask = {
  id: 1,
  root: 1,
  verify: "test",
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
  test("the system prompt teaches every field and the invariants with one minimal example", () => {
    const prompt = buildTaskPlanningSystemPrompt();
    for (const field of [
      '"id"',
      '"root"',
      '"verify"',
      '"related"',
      '"loc"',
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
    expect(prompt).toContain("root gate");
    expect(prompt).toContain("Reply with ONLY one bare JSON object");
    expect(prompt).toContain('"kind": "value"');
    // The initial prompt carries only the minimal shape; the larger example is
    // reserved for the retry/help path.
    expect(prompt).toContain(TASK_PLAN_EXAMPLE);
    expect(prompt).not.toContain(TASK_PLAN_COMPLEX_EXAMPLE);
    expect(prompt.indexOf(TASK_PLAN_EXAMPLE)).toBeLessThan(prompt.indexOf('- "tasks"'));
    expect(prompt).not.toContain("```json");
    expect(parseTaskPlan(TASK_PLAN_EXAMPLE).ok).toBe(true);
    expect(parseTaskPlan(TASK_PLAN_COMPLEX_EXAMPLE).ok).toBe(true);
  });

  test("the first user prompt carries the requirement and the index", () => {
    const prompt = buildTaskPlanningUserPrompt("add a helper", "select helper in src/a.ts");
    expect(prompt).toContain("# Requirement\n\nadd a helper");
    expect(prompt).toContain("select helper in src/a.ts");
    expect(prompt).toContain("complete task plan JSON");
  });

  test("the retry prompt names the rejection and appends help", () => {
    const prompt = buildTaskPlanRetryPrompt("stage: task-dag\n- bad");
    expect(prompt).toContain("stage: task-dag");
    expect(prompt).toContain(TASK_PLAN_COMPLEX_EXAMPLE);
    expect(buildTaskPlanRetryPrompt("bad", false)).not.toContain(TASK_PLAN_COMPLEX_EXAMPLE);
  });

  test("a re-plan prompt carries the DAG, status, failures, and tests", () => {
    const state = stateOf();
    state.status.set(1, "failed");
    const prompt = buildTaskReplanPrompt({
      state,
      failures: new Map([[1, "stage: tsc\nTS2322"]]),
      gateDiagnostics: "expected 2, got 1",
      symbolIndex: 'files:\n  - path: "src/helper.ts"\n',
      delta: replanDelta({ failedIds: [1], testsFailed: false, blocked: false }),
    });
    expect(prompt).toContain("# Edit-task DAG");
    expect(prompt).toContain('#1 modify value "answer" in "src/helper.ts"');
    expect(prompt).toContain("# Status");
    expect(prompt).toContain("#1 failed");
    expect(prompt).toContain("TS2322");
    expect(prompt).toContain("expected 2, got 1");
    expect(prompt).toContain("# Current symbol index");
    expect(prompt).toContain("src/helper.ts");
    expect(prompt).toContain("The failed task(s) #1 could not be carried out.");
    expect(prompt).toContain("A failed task may be retried by changing its definition");
    expect(prompt).toContain("Use related same-file locs");
    expect(prompt).not.toContain("Shape of a valid amendment");
  });

  test("a test-failure re-plan names the test verdict", () => {
    const state = stateOf();
    state.status.set(1, "done");
    const prompt = buildTaskReplanPrompt({
      state,
      failures: new Map(),
      gateDiagnostics: "1 test failed",
      delta: replanDelta({ failedIds: [], testsFailed: true, blocked: false }),
    });
    expect(prompt).toContain("A root gate failed after its micro-tasks completed.");
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
  test("the system prompt teaches the edit-action grammar and the root gate", () => {
    const prompt = buildTaskExecutionSystemPrompt();
    expect(prompt).toContain("select … end");
    expect(prompt).toContain("root gate");
    expect(prompt).not.toContain("TASK_DONE");
    expect(prompt).toContain("Reply shape: `select <symbol> in <path>");
    expect(prompt).not.toContain("Action-specific rules:");
    expect(prompt).not.toContain("Example for this action:");
  });

  test("format help is injected only on the help turn", () => {
    const state = stateOf();
    const base = {
      state,
      task: TASK,
      contentView: renderTaskContentView("export function answer(): number {\n  return 1;\n}"),
    };
    expect(buildTaskTurnPrompt(base)).not.toContain("# Format help");
    const help = buildTaskTurnPrompt({ ...base, help: true });
    expect(help).toContain("# Format help");
    expect(help).toContain(taskEditDslHelp("modify"));
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
        "Reply with the edit clauses for this task. The root gate runs after all sibling micro-tasks finish.",
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
