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
import { initialState, parsePlan } from "../tasks";
import type { EditNode, Stage, TaskNode, TaskRunState } from "../tasks";

const EDIT: EditNode = {
  id: 3,
  loc: { path: "src/helper.ts", symbol: "answer", kind: "value" },
  action: "modify",
  instruction: "Change answer so it returns 2.",
};

const TASK: TaskNode = {
  id: 2,
  verify: "test",
  instruction: "Make the failing test green.",
  edits: [EDIT],
};

const STAGE: Stage = {
  id: 1,
  goal: "Fix the answer behavior.",
  tasks: [TASK],
};

function stateOf(stages: Stage[] = [STAGE]): TaskRunState {
  const parsed = parsePlan(JSON.stringify({ stages }));
  if (!parsed.ok) {
    throw new Error(parsed.diagnostics);
  }
  return initialState(parsed.plan);
}

describe("planning prompts", () => {
  test("the system prompt teaches the Plan -> Stage -> Task -> edit fields and invariants", () => {
    const prompt = buildTaskPlanningSystemPrompt();
    for (const field of [
      '"stages"',
      '"goal"',
      '"tasks"',
      '"verify"',
      '"edits"',
      '"loc"',
      '"action"',
      '"instruction"',
      '"related"',
      '"renameTo"',
    ]) {
      expect(prompt).toContain(field);
    }
    expect(prompt).toContain("Plan -> Stage -> Task -> edit");
    expect(prompt).toContain("root object is the Plan");
    expect(prompt).toContain("small named functions");
    expect(prompt).toContain("thin orchestrator");
    expect(prompt).toContain("verification boundary");
    expect(prompt).toContain("final task");
    expect(prompt).toContain("Reply with ONLY one bare JSON object");
    expect(prompt).not.toContain('"deps"');
    expect(prompt).not.toContain('"todo"');
    expect(prompt).toContain(TASK_PLAN_EXAMPLE);
    expect(prompt).not.toContain(TASK_PLAN_COMPLEX_EXAMPLE);
    expect(prompt.indexOf(TASK_PLAN_EXAMPLE)).toBeLessThan(
      prompt.indexOf("root object is the Plan"),
    );
    expect(prompt).not.toContain("```json");
    expect(parsePlan(TASK_PLAN_EXAMPLE).ok).toBe(true);
    expect(parsePlan(TASK_PLAN_COMPLEX_EXAMPLE).ok).toBe(true);
  });

  test("the first user prompt carries the requirement and the index", () => {
    const prompt = buildTaskPlanningUserPrompt("add a helper", "select helper in src/a.ts");
    expect(prompt).toContain("# Requirement\n\nadd a helper");
    expect(prompt).toContain("select helper in src/a.ts");
    expect(prompt).toContain("complete plan tree JSON");
  });

  test("the retry prompt names the rejection and appends help", () => {
    const prompt = buildTaskPlanRetryPrompt("stage: task-tree\n- bad");
    expect(prompt).toContain("stage: task-tree");
    expect(prompt).toContain(TASK_PLAN_COMPLEX_EXAMPLE);
    expect(buildTaskPlanRetryPrompt("bad", false)).not.toContain(TASK_PLAN_COMPLEX_EXAMPLE);
  });

  test("a re-plan prompt carries the tree, status, failures, and tests", () => {
    const state = stateOf();
    state.editStatus.set(3, "failed");
    state.taskStatus.set(2, "failed");
    const prompt = buildTaskReplanPrompt({
      state,
      editFailures: new Map([[3, "stage: task-failed\nTS2322"]]),
      taskFailures: new Map([[2, "expected 2, got 1"]]),
      gateDiagnostics: "expected 2, got 1",
      symbolIndex: 'files:\n  - path: "src/helper.ts"\n',
      delta: replanDelta({ failedEditIds: [3], failedTaskIds: [2], blocked: false }),
    });
    expect(prompt).toContain("# Plan tree");
    expect(prompt).toContain('@stage #1 goal="Fix the answer behavior."');
    expect(prompt).toContain("@task #2 verify=test");
    expect(prompt).toContain("# Status");
    expect(prompt).toContain("@task #2 failed");
    expect(prompt).toContain("TS2322");
    expect(prompt).toContain("expected 2, got 1");
    expect(prompt).toContain("# Failed edits and diagnostics");
    expect(prompt).toContain("# Failed task gates and diagnostics");
    expect(prompt).toContain("# Current symbol index");
    expect(prompt).toContain("The edit(s) #3 could not be carried out.");
    expect(prompt).toContain("A failed task reopens");
    expect(prompt).toContain("small helper function");
  });

  test("a test-failure re-plan names the task gate verdict", () => {
    const state = stateOf();
    state.editStatus.set(3, "done");
    state.taskStatus.set(2, "failed");
    const prompt = buildTaskReplanPrompt({
      state,
      editFailures: new Map(),
      taskFailures: new Map([[2, "1 test failed"]]),
      gateDiagnostics: "1 test failed",
      delta: replanDelta({ failedEditIds: [], failedTaskIds: [2], blocked: false }),
    });
    expect(prompt).toContain("The task gate(s) #2 failed");
  });

  test("a blocked re-plan asks for tree repair", () => {
    expect(replanDelta({ failedEditIds: [], failedTaskIds: [], blocked: true })).toContain(
      "No task is runnable",
    );
  });
});

describe("execution prompts", () => {
  test("the system prompt teaches the edit grammar and the task gate", () => {
    const prompt = buildTaskExecutionSystemPrompt();
    expect(prompt).toContain("select … end");
    expect(prompt).toContain("task gate");
    expect(prompt).not.toContain("TASK_DONE");
    expect(prompt).toContain("Reply shape: `select <symbol> in <path>");
    expect(prompt).toContain("small single-purpose functions");
  });

  test("format help is injected only on the help turn", () => {
    const state = stateOf();
    const base = {
      state,
      stage: STAGE,
      task: TASK,
      edit: EDIT,
      contentView: renderTaskContentView("export function answer(): number {\n  return 1;\n}"),
    };
    expect(buildTaskTurnPrompt(base)).not.toContain("# Format help");
    const help = buildTaskTurnPrompt({ ...base, help: true });
    expect(help).toContain("# Format help");
    expect(help).toContain(taskEditDslHelp("modify"));
  });

  test("the turn prompt carries stage, task, edit, and the content view last", () => {
    const state = stateOf();
    const prompt = buildTaskTurnPrompt({
      state,
      stage: STAGE,
      task: TASK,
      edit: EDIT,
      contentView: renderTaskContentView("export function answer(): number {\n  return 1;\n}"),
      diagnostics: "stage: protocol\nbad clause",
    });
    expect(prompt).toContain("# Stage");
    expect(prompt).toContain("#1 — Fix the answer behavior.");
    expect(prompt).toContain("# Task");
    expect(prompt).toContain("#2 (verify test) — pending");
    expect(prompt).toContain("Make the failing test green.");
    expect(prompt).toContain("# Micro edit");
    expect(prompt).toContain("#3 (modify) — todo");
    expect(prompt).toContain(EDIT.instruction);
    expect(prompt).toContain("1 | export function answer");
    expect(prompt.indexOf("# Stage")).toBeLessThan(prompt.indexOf("# Diagnostics"));
    expect(prompt.indexOf("# Diagnostics")).toBeLessThan(prompt.indexOf("# Content view"));
    expect(prompt).toContain('{"request":"read"}');
    expect(
      prompt.endsWith(
        "Reply with the edit clauses for this micro edit. The task gate runs after every edit in the task settles.",
      ),
    ).toBe(true);
  });

  test("a rename turn names the new identifier and an empty view renders explicitly", () => {
    const rename = { ...EDIT, action: "rename" as const, renameTo: "result" };
    const state = stateOf([{ ...STAGE, tasks: [{ ...TASK, edits: [rename] }] }]);
    const prompt = buildTaskTurnPrompt({
      state,
      stage: state.stages[0] as Stage,
      task: state.stages[0]?.tasks[0] as TaskNode,
      edit: state.stages[0]?.tasks[0]?.edits[0] as EditNode,
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
