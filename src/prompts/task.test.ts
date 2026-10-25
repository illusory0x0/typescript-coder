import { describe, expect, test } from "bun:test";
import {
  buildTaskExecutionSystemPrompt,
  buildTaskPatchRetryPrompt,
  buildTaskPlanRetryPrompt,
  buildTaskPlanningSystemPrompt,
  buildTaskPlanningUserPrompt,
  buildTaskReplanPrompt,
  buildTaskReviewPrompt,
  buildTaskTurnPrompt,
  replanDelta,
  renderTaskContentView,
  taskEditDslHelp,
  TASK_FUNCTIONAL_STYLE,
  TASK_PATCH_EXAMPLE,
  TASK_PATCH_FINAL_EXAMPLE,
  TASK_PLAN_COMPLEX_EXAMPLE,
  TASK_PLAN_EXAMPLE,
} from "./task";
import { initialState } from "../tasks";
import type { EditNode, Stage, TaskNode, TaskRunState } from "../tasks";
import { parsePlan, parsePlanPatch, serializePlanDsl } from "../plan-dsl";

const FUNCTIONAL_STYLE = `Prefer ML-style functional TypeScript:
- Data + functions over classes and prototypes.
- Model data with type aliases, tagged unions (string-literal tag), tuples, and plain records.
- Implement behavior as top-level functions with explicit parameter and return types.
- Extract small helpers when they make the code clearer; do not force a stage/task split.
- Do not create new classes, inheritance, \`super\`, implicit \`this\`, private state, getters/setters, or class-based state machines.
- If an existing class must change, modify it minimally; never create a dotted member with \`create\`.`;

const EDIT: EditNode = {
  id: "03-edit",
  loc: { path: "src/helper.ts", symbol: "answer", kind: "value" },
  action: "modify",
  instruction: "Change answer so it returns 2.",
};

const TASK: TaskNode = {
  id: "02-task",
  verify: "test",
  instruction: "Make the failing test green.",
  edits: [EDIT],
};

const STAGE: Stage = {
  id: "01-stage",
  goal: "Fix the answer behavior.",
  tasks: [TASK],
};

const PLAN_GOAL = "Make the failing test pass.";

function stateOf(stages: Stage[] = [STAGE]): TaskRunState {
  const parsed = parsePlan(serializePlanDsl({ id: "01-main", goal: PLAN_GOAL, stages }));
  if (!parsed.ok) {
    throw new Error(parsed.diagnostics);
  }
  return initialState(parsed.plan);
}

describe("planning prompts", () => {
  test("the system prompt teaches the flat Plan DSL fields and invariants", () => {
    const prompt = buildTaskPlanningSystemPrompt();
    for (const field of [
      'plan "',
      'stage "',
      'task "',
      'edit "',
      "goal:",
      "instruction:",
      "verify tsc|test",
      "related ",
      "renameTo:",
      "end",
    ]) {
      expect(prompt).toContain(field);
    }
    expect(prompt).toContain("Plan -> Stage -> Task -> edit");
    expect(prompt).toContain("flat Plan DSL");
    expect(prompt).toContain("NN-slug");
    expect(prompt).toContain("globally unique across the Plan");
    expect(prompt).toContain("small named functions");
    expect(prompt).toContain("thin orchestrator");
    expect(prompt).toContain("verification boundary");
    expect(prompt).toContain("finish");
    expect(prompt).toContain("exactly one current Stage and one current Task");
    expect(prompt).toContain("The first reply is ONLY the initial Plan DSL");
    expect(prompt).toContain("Every later planning turn replies with exactly one patch");
    expect(prompt).toContain('task+ "');
    expect(prompt).toContain('edit+ "');
    expect(prompt).toContain('stage+ "');
    expect(prompt).toContain("at most one new Task");
    expect(prompt).not.toContain('"stages"');
    expect(prompt).not.toContain('"deps"');
    expect(prompt).not.toContain('"todo"');
    expect(prompt).toContain(TASK_PLAN_EXAMPLE);
    expect(prompt).toContain(TASK_PATCH_EXAMPLE);
    expect(prompt).toContain(TASK_PATCH_FINAL_EXAMPLE);
    expect(prompt).not.toContain(TASK_PLAN_COMPLEX_EXAMPLE);
    expect(prompt.indexOf(TASK_PLAN_EXAMPLE)).toBeLessThan(prompt.indexOf("flat Plan DSL"));
    expect(prompt).not.toContain("```json");
    expect(parsePlan(TASK_PLAN_EXAMPLE).ok).toBe(true);
    expect(parsePlan(TASK_PLAN_COMPLEX_EXAMPLE).ok).toBe(true);
    expect(parsePlanPatch(TASK_PATCH_EXAMPLE).ok).toBe(true);
    expect(parsePlanPatch(TASK_PATCH_FINAL_EXAMPLE).ok).toBe(true);
  });

  test("the system prompt carries the functional-style block and the existing-class rule", () => {
    const prompt = buildTaskPlanningSystemPrompt();
    expect(TASK_FUNCTIONAL_STYLE).toBe(FUNCTIONAL_STYLE);
    expect(prompt).toContain(FUNCTIONAL_STYLE);
    expect(prompt).toContain("Never plan a new class");
    expect(prompt).toContain("prefer a top-level helper");
    expect(prompt).toContain("one whole-class `modify` that adds all needed stubs");
    expect(prompt).toContain("then `modify` the existing members");
    expect(prompt).toContain("Never plan a dotted `create`");
    expect(prompt).toContain("a dotted class member is never a create target");
  });

  test("the first user prompt asks for one current Stage and one current Task", () => {
    const prompt = buildTaskPlanningUserPrompt("add a helper", "select helper in src/a.ts");
    expect(prompt).toContain("# Requirement\n\nadd a helper");
    expect(prompt).toContain("select helper in src/a.ts");
    expect(prompt).toContain("exactly one current Stage and one current Task");
  });

  test("the retry prompt names the rejection and appends initial Plan help", () => {
    const prompt = buildTaskPlanRetryPrompt("stage: task-tree\n- bad");
    expect(prompt).toContain("stage: task-tree");
    expect(prompt).toContain("one current Stage and one current Task");
    expect(prompt).toContain(TASK_PLAN_COMPLEX_EXAMPLE);
    expect(buildTaskPlanRetryPrompt("bad", false)).not.toContain(TASK_PLAN_COMPLEX_EXAMPLE);
  });

  test("the patch retry prompt asks for one patch and appends a patch example", () => {
    const prompt = buildTaskPatchRetryPrompt("stage: task-tree\n- two new tasks");
    expect(prompt).toContain("stage: task-tree");
    expect(prompt).toContain("two new tasks");
    expect(prompt).toContain("Example of a valid patch");
    expect(prompt).toContain(TASK_PATCH_EXAMPLE);
    expect(prompt).toContain("Do not re-emit the Plan");
    expect(buildTaskPatchRetryPrompt("bad", false)).not.toContain(TASK_PATCH_EXAMPLE);
  });

  test("a re-plan prompt carries the tree, status, failures, and tests", () => {
    const state = stateOf();
    state.editStatus.set(EDIT.id, "failed");
    state.taskStatus.set(TASK.id, "failed");
    const prompt = buildTaskReplanPrompt({
      state,
      editFailures: new Map([[EDIT.id, "stage: task-failed\nTS2322"]]),
      taskFailures: new Map([[TASK.id, "expected 2, got 1"]]),
      gateDiagnostics: "expected 2, got 1",
      symbolIndex: 'files:\n  - path: "src/helper.ts"\n',
      delta: replanDelta({ failedEditIds: [EDIT.id], failedTaskIds: [TASK.id], blocked: false }),
    });
    expect(prompt).toContain("# Plan tree");
    expect(prompt).toContain('@stage #01-stage goal="Fix the answer behavior."');
    expect(prompt).toContain("@task #02-task verify=test");
    expect(prompt).toContain("# Status");
    expect(prompt).toContain("@task #02-task failed");
    expect(prompt).toContain("TS2322");
    expect(prompt).toContain("expected 2, got 1");
    expect(prompt).toContain("# Failed edits and diagnostics");
    expect(prompt).toContain("# Failed task gates and diagnostics");
    expect(prompt).toContain("# Current symbol index");
    expect(prompt).toContain(`The edit(s) #${EDIT.id} could not be carried out.`);
    expect(prompt).toContain("A failed task reopens");
    expect(prompt).toContain("small helper function");
    expect(prompt).toContain("Reply with exactly one `patch`");
    expect(prompt).toContain("Add at most one new Task");
    expect(prompt).not.toContain("Reply with the complete Plan DSL");
  });

  test("a test-failure re-plan names the task gate verdict", () => {
    const state = stateOf();
    state.editStatus.set(EDIT.id, "done");
    state.taskStatus.set(TASK.id, "failed");
    const prompt = buildTaskReplanPrompt({
      state,
      editFailures: new Map(),
      taskFailures: new Map([[TASK.id, "1 test failed"]]),
      gateDiagnostics: "1 test failed",
      delta: replanDelta({ failedEditIds: [], failedTaskIds: [TASK.id], blocked: false }),
    });
    expect(prompt).toContain(`The task gate(s) #${TASK.id} failed`);
  });

  test("a blocked re-plan asks for tree repair", () => {
    expect(replanDelta({ failedEditIds: [], failedTaskIds: [], blocked: true })).toContain(
      "No task is runnable",
    );
  });
});

describe("review prompts", () => {
  const DIFF = [
    "--- a/src/helper.ts",
    "+++ b/src/helper.ts",
    "@@ -1,3 +1,3 @@",
    " export function answer(): number {",
    "-  return 1;",
    "+  return 2;",
    " }",
  ].join("\n");

  test("the review prompt carries the gate, current task, and applied diff only", () => {
    const prompt = buildTaskReviewPrompt({
      stage: STAGE,
      task: TASK,
      gate: { ok: true, diagnostics: null },
      diff: DIFF,
    });
    expect(prompt.startsWith("# Review")).toBe(true);
    expect(prompt).toContain("Gate: test passed.");
    expect(prompt).toContain("#01-stage goal: Fix the answer behavior.");
    expect(prompt).toContain("#02-task (verify test) — review");
    expect(prompt).toContain("Instruction: Make the failing test green.");
    expect(prompt).toContain(`- #${EDIT.id} modify value "answer" in "src/helper.ts"`);
    expect(prompt).toContain("# Applied diff");
    expect(prompt).toContain("```diff");
    expect(prompt).toContain("--- a/src/helper.ts");
    expect(prompt).toContain("+++ b/src/helper.ts");
    expect(prompt).toContain("@@");
    expect(prompt).toContain("-  return 1;");
    expect(prompt).toContain("+  return 2;");
    expect(prompt).toContain("Reply with exactly `approve` or one `patch`");
    expect(prompt).toContain(`task~ "#${TASK.id}"`);
    expect(prompt).toContain("It may carry `finish`");
    expect(prompt).toContain("Do not add a Stage or Task");
    // The requirement and full source live in the cached planning prefix.
    expect(prompt).not.toContain(PLAN_GOAL);
    expect(prompt).not.toContain("helperOne");
  });

  test("a failed gate carries its diagnostics and does not approve", () => {
    const prompt = buildTaskReviewPrompt({
      stage: STAGE,
      task: TASK,
      gate: { ok: false, diagnostics: "1 test failed" },
      diff: DIFF,
    });
    expect(prompt).toContain("Gate: test failed.");
    expect(prompt).toContain("1 test failed");
    expect(prompt).toContain("prefer a repair");
    expect(prompt).toContain("failure lies outside this Task");
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

  test("the system prompt carries the same functional constraints as planning", () => {
    const prompt = buildTaskExecutionSystemPrompt();
    expect(prompt).toContain(FUNCTIONAL_STYLE);
    expect(prompt).toContain("Do not create new classes");
    expect(prompt).toContain("never create a dotted member with `create`");
    expect(prompt).toContain("select … end");
  });

  test("the create action rule teaches top-level create and the existing-class route", () => {
    const createEdit = { ...EDIT, action: "create" as const };
    const state = stateOf([{ ...STAGE, tasks: [{ ...TASK, edits: [createEdit] }] }]);
    const createStage = state.stages[0] as Stage;
    const prompt = buildTaskTurnPrompt({
      state,
      stage: createStage,
      task: createStage.tasks[0] as TaskNode,
      edit: createStage.tasks[0]?.edits[0] as EditNode,
      contentView: "",
    });
    expect(prompt).toContain("top-level declaration only");
    expect(prompt).toContain("never target a dotted class member");
    expect(prompt).toContain("one whole-class `modify`");
    expect(prompt).toContain("select … replace with <fence> end");
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
    expect(prompt).toContain("#01-stage — Fix the answer behavior.");
    expect(prompt).toContain("# Task");
    expect(prompt).toContain("#02-task (verify test) — pending");
    expect(prompt).toContain("Make the failing test green.");
    expect(prompt).toContain("# Micro edit");
    expect(prompt).toContain("#03-edit (modify) — todo");
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
