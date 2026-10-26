import { describe, expect, test } from "bun:test";
import {
  buildTaskExecutionSystemPrompt,
  buildTaskPatchRetryPrompt,
  buildTaskPlanRetryPrompt,
  buildTaskPlanningSystemPrompt,
  buildTaskPlanningUserPrompt,
  buildTaskReplanPrompt,
  buildTaskReviewPrompt,
  buildTaskReviewRetryPrompt,
  buildTaskTurnPrompt,
  TASK_EDITING_TECHNIQUES,
  TASK_FUNCTIONAL_STYLE,
  TASK_PLANNING_WORKFLOW,
  TASK_PLANNER_VIEW,
} from "./task";
import { initialState } from "../tasks";
import type { Plan, WorkNode } from "../tasks";

function node(id: string, overrides: Partial<Omit<WorkNode, "id">> = {}): WorkNode {
  return {
    id,
    after: [],
    verify: "test",
    instruction: "Make the failing test green.",
    hints: [{ path: "src/helper.ts", symbol: "answer", kind: "value" }],
    ...overrides,
  };
}

function plan(nodes: WorkNode[]): Plan {
  return { id: "01-main", goal: "Make the failing test pass.", nodes };
}

describe("planning prompts", () => {
  test("the planning system prompt is WorkNode-based", () => {
    const prompt = buildTaskPlanningSystemPrompt();
    expect(prompt).toContain("work-graph planner");
    expect(prompt).toContain('node "02-answer" verify test');
    expect(prompt).toContain("after");
    expect(prompt).toContain("hint file src/workbook.ts");
    expect(prompt).toContain("approach:");
    expect(prompt).toContain("phase:");
    expect(prompt).toContain("finish");
    expect(prompt).not.toMatch(/\bstage\b/i);
    expect(prompt).not.toContain('edit "');
    expect(prompt).not.toContain("Stage -> Task");
    expect(prompt).toContain("no node-count, planning-round, viewer, or exchange cap");
  });

  test("the workflow recommends inspect -> contract -> scaffold -> implement -> verify without forcing a shape", () => {
    expect(TASK_PLANNING_WORKFLOW).toContain(
      "inspect -> contract -> scaffold -> implement -> verify",
    );
    expect(TASK_PLANNING_WORKFLOW).toContain(
      "single node, a linear chain, and a branching DAG are all valid",
    );
    expect(buildTaskPlanningSystemPrompt()).toContain(TASK_PLANNING_WORKFLOW);
  });

  test("planner inspection allows multiple read-only viewers", () => {
    expect(TASK_PLANNER_VIEW).toContain("one or more read-only viewer requests");
    expect(TASK_PLANNER_VIEW).toContain("Each viewer consumes the run token budget");
    expect(TASK_PLANNER_VIEW).toContain("repeated identical");
    expect(TASK_PLANNER_VIEW).toContain("Never use `replace`");
    expect(buildTaskPlanningSystemPrompt()).toContain(TASK_PLANNER_VIEW);
  });

  test("the planning user prompt carries the requirement and symbol index", () => {
    const prompt = buildTaskPlanningUserPrompt(
      "Fix the answer.",
      "select answer in src/helper.ts",
      [{ path: "src/helper.test.ts", source: "expect(answer()).toBe(2);" }],
    );
    expect(prompt).toContain("# Requirement");
    expect(prompt).toContain("Fix the answer.");
    expect(prompt).toContain("# Symbol index");
    expect(prompt).toContain("src/helper.test.ts");
    expect(prompt).toContain("initial Plan DSL");
  });

  test("a replan turn renders the graph, statuses, failures, blocked work, and index", () => {
    const state = initialState(plan([node("02-answer")]), "02-answer");
    state.nodeStatus.set("02-answer", "failed");
    const prompt = buildTaskReplanPrompt({
      state,
      nodeFailures: new Map([["02-answer", "stage: tsc\nerror TS2322"]]),
      blocked: "Blocked node(s): #03-next.",
      symbolIndex: "select answer in src/helper.ts",
    });
    expect(prompt).toContain("# Work graph");
    expect(prompt).toContain("@node #02-answer");
    expect(prompt).toContain("# Status");
    expect(prompt).toContain("# Failed nodes and diagnostics");
    expect(prompt).toContain("error TS2322");
    expect(prompt).toContain("# Blocked");
    expect(prompt).toContain("Blocked node(s): #03-next.");
    expect(prompt).toContain("# Current symbol index");
    expect(prompt).toContain("Reply with exactly one `patch`");
  });

  test("retry prompts name the diagnostics and keep the DSL shape", () => {
    const planRetry = buildTaskPlanRetryPrompt("stage: plan-graph\n- cycle");
    expect(planRetry).toContain("stage: plan-graph");
    expect(planRetry).toContain("node");
    expect(planRetry).toContain("finish");
    const patchRetry = buildTaskPatchRetryPrompt("stage: plan-graph\n- dangling after");
    expect(patchRetry).toContain("stage: plan-graph");
    expect(patchRetry).toContain("Reply with exactly one corrected `patch`");
    expect(patchRetry).not.toContain("at most one new Task");
  });
});

describe("execution prompts", () => {
  test("the execution system prompt teaches autonomy and the editing techniques", () => {
    const prompt = buildTaskExecutionSystemPrompt();
    expect(prompt).toContain("You own the concrete actions and their granularity");
    expect(prompt).toContain("hints and approach are advice");
    expect(TASK_EDITING_TECHNIQUES).toContain("whole-file");
    expect(TASK_EDITING_TECHNIQUES).toContain("scaffold");
    expect(TASK_EDITING_TECHNIQUES).toContain("xxV1");
    expect(TASK_EDITING_TECHNIQUES).toContain("no technique is a gate");
    expect(prompt).toContain("Editing techniques");
    expect(prompt).toContain("different declaration `(path, symbol, kind)`");
    expect(prompt).toContain("`create <path> end`");
    expect(prompt).toContain("`delete <path> end`");
    expect(prompt).toContain("`read <path>");
    expect(prompt).toContain("`write <path> with");
    expect(prompt).not.toContain("one bounded self-check");
    expect(prompt).not.toContain("MAX_TASK");
  });

  test("functional style stays the shared plan-exec block", () => {
    expect(TASK_FUNCTIONAL_STYLE).toContain("Prefer ML-style functional TypeScript");
    expect(TASK_FUNCTIONAL_STYLE).toContain("Do not create new classes");
    expect(buildTaskExecutionSystemPrompt()).toContain(TASK_FUNCTIONAL_STYLE);
  });

  test("one execution turn carries the node, advice, diagnostics, and source views", () => {
    const prompt = buildTaskTurnPrompt({
      node: node("03-impl", {
        instruction: "Return 2 from answer.",
        hints: [
          { path: "src/helper.ts", symbol: "answer", kind: "value" },
          { path: "src/helper.ts", symbol: "", kind: "file" },
        ],
        approach: "The file is small; a whole-file write is often cheapest.",
        phase: "implement",
      }),
      diagnostics: "stage: protocol\nthe reply carried no edit statement",
      gateDiagnostics: "stage: tsc\nerror TS2322",
      feedback: "read results (read commands write nothing)",
      views: [
        {
          label: 'value "answer" in "src/helper.ts" (lines 1-3)',
          source: "1 | export function answer(): number {\n2 |   return 1;\n3 | }",
          startLine: 1,
        },
      ],
    });
    expect(prompt).toContain("# Work node");
    expect(prompt).toContain("Return 2 from answer.");
    expect(prompt).toContain('value "answer" in "src/helper.ts"');
    expect(prompt).toContain('file "src/helper.ts"');
    expect(prompt).toContain("Approach (advice; override it from the source)");
    expect(prompt).toContain("Phase: implement");
    expect(prompt).toContain("# Diagnostics");
    expect(prompt).toContain("# Gate diagnostics");
    expect(prompt).toContain("# Source feedback");
    expect(prompt).toContain("# Source views");
    expect(prompt).toContain("return 1;");
    expect(prompt).toContain("each declaration may appear at most once");
  });

  test("a node without hints tells the executor to inspect with read", () => {
    const prompt = buildTaskTurnPrompt({
      node: node("02-answer", { hints: [] }),
      views: [],
    });
    expect(prompt).toContain("Hints: none");
    expect(prompt).toContain("read");
    expect(prompt).toContain("No hinted source is available");
  });
});

describe("review prompts", () => {
  test("shows the gate, node advice, out-of-hint edits, and the applied diff", () => {
    const prompt = buildTaskReviewPrompt({
      node: node("03-impl", {
        instruction: "Return 2 from answer.",
        approach: "Prefer a targeted edit.",
        phase: "implement",
      }),
      gate: { verify: "test", ok: true, diagnostics: null },
      diff: "--- a/src/helper.ts\n+++ b/src/helper.ts\n@@ -1 +1 @@\n-return 1;\n+return 2;",
      outOfHint: ["src/extra.ts"],
    });
    expect(prompt).toContain("# Review");
    expect(prompt).toContain("Gate: test passed.");
    expect(prompt).toContain("Return 2 from answer.");
    expect(prompt).toContain("Approach (advice): Prefer a targeted edit.");
    expect(prompt).toContain("# Out-of-hint edits");
    expect(prompt).toContain("src/extra.ts");
    expect(prompt).toContain("# Applied diff");
    expect(prompt).toContain("Reply with exactly `approve` or one `patch`");
    expect(prompt).toContain("targeted repair after a failed large write");
    expect(prompt).toContain("do not hard-reject a strategy");
    expect(prompt).not.toContain("at most one patch per Task");
    expect(prompt).not.toContain("one review");
  });

  test("a review retry keeps the approve-or-patch contract", () => {
    const prompt = buildTaskReviewRetryPrompt("stage: plan-protocol\nmissing end");
    expect(prompt).toContain("# Review retry");
    expect(prompt).toContain("missing end");
    expect(prompt).toContain("`approve` or one corrected `patch`");
  });
});
