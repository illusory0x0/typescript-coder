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
  TASK_EDIT_STRATEGY_GUIDE,
  TASK_EDITING_TECHNIQUES,
  TASK_EXECUTION_OUTPUT_CONTRACT,
  TASK_FAILED_WRITE_REPAIR_ADVICE,
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
    expect(prompt).not.toContain("A dotted class member is not a create target");
    expect(prompt).not.toContain("never plan a dotted `create`");
    expect(prompt).toContain("A `create` adds one named declaration or member");
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

  test("the workflow suggests an early test checkpoint without forcing a shape", () => {
    expect(TASK_PLANNING_WORKFLOW).toContain("consider an early `verify test` checkpoint");
    expect(TASK_PLANNING_WORKFLOW).toContain(
      "after the scaffold/contract phase, once a compiling skeleton exists",
    );
    expect(TASK_PLANNING_WORKFLOW).toContain(
      "test feedback can arrive before most behavior is written",
    );
    expect(TASK_PLANNING_WORKFLOW).toContain("End with a final `test` node marked by `finish`");
    expect(TASK_PLANNING_WORKFLOW).toContain("still the plan's success condition");
    expect(TASK_PLANNING_WORKFLOW).toContain("advice, not a required shape");
    expect(TASK_PLANNING_WORKFLOW).toContain("may have only the final test node");
    expect(TASK_PLANNING_WORKFLOW).not.toContain("Do not defer");
    expect(TASK_PLANNING_WORKFLOW).not.toContain("place an early");
    expect(buildTaskPlanningSystemPrompt()).toContain(
      "often benefits from a compiling scaffold node",
    );
    expect(buildTaskPlanningSystemPrompt()).toContain(
      "consider an early `verify test` checkpoint after that scaffold/contract phase",
    );
    expect(buildTaskPlanningSystemPrompt()).not.toContain("needs a compiling scaffold node");
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

  test("a finish rejection gets a concrete final-test patch recovery", () => {
    const diagnostics = [
      "stage: plan-graph",
      "code: PLAN_FINISH_NOT_LAST",
      '- finish marks node #06-eval, but it verifies "tsc"; the final node must verify "test"',
    ].join("\n");
    const prompt = buildTaskPatchRetryPrompt(diagnostics);
    expect(prompt).toContain("Recovery for this finish rejection:");
    expect(prompt).toContain('node+ "06-eval-final" after "06-eval" verify test');
    expect(prompt).toContain('node~ "06-eval" verify test');
    expect(prompt).toContain("Keep the rejected patch available");
    expect(prompt).toContain("do not resend the unchanged patch");
    expect(prompt).toContain("`finish` is valid only as the last line");
    expect(prompt).toContain("graph shape stay yours");
    expect(prompt).not.toContain("05-repair");
    expect(prompt).not.toContain("at most one new Task");
  });

  test("a finish-placement rejection is actionable without inventing ids", () => {
    const prompt = buildTaskPatchRetryPrompt(
      'stage: plan-graph\ncode: PLAN_FINISH_NOT_LAST\n- finish must be the last line; found "node" after it',
    );
    expect(prompt).toContain("Recovery for this finish rejection:");
    expect(prompt).toContain('node+ "07-final" verify test');
    expect(prompt).toContain('node~ "06-last" verify test');
    expect(prompt).toContain("move `finish` to the last line");
  });

  test("the final-node recovery anchors the new node on the actual last node", () => {
    const prompt = buildTaskPatchRetryPrompt(
      "stage: plan-graph\ncode: PLAN_FINISH_NOT_LAST\n- the final node #02-answer is no longer last (the new last node is #03-next); append a final test node",
    );
    expect(prompt).toContain('node+ "03-next-final" after "03-next" verify test');
    expect(prompt).toContain('node~ "03-next" verify test');
  });

  test("an unrelated patch rejection keeps the generic retry", () => {
    const prompt = buildTaskPatchRetryPrompt("stage: plan-graph\n- dangling after");
    expect(prompt).not.toContain("Recovery for this finish rejection:");
    expect(prompt).not.toContain("verify test");
    expect(prompt).toContain('node+ "05-repair"');
  });
});

describe("execution prompts", () => {
  test("the execution system prompt teaches autonomy and the editing techniques", () => {
    const prompt = buildTaskExecutionSystemPrompt();
    expect(prompt).toContain("You own the concrete actions and their granularity");
    expect(prompt).toContain("hints and approach are advice");
    expect(TASK_EDITING_TECHNIQUES).toContain("whole-file");
    expect(TASK_EDITING_TECHNIQUES).toContain("scaffold");
    expect(TASK_EDITING_TECHNIQUES).toContain("one whole-file `write`");
    expect(TASK_EDITING_TECHNIQUES).toContain("dozens of separate `create` clauses");
    expect(TASK_EDITING_TECHNIQUES).toContain("later additions fit targeted edits or `create`");
    expect(TASK_EDITING_TECHNIQUES).toContain("xxV1");
    expect(TASK_EDITING_TECHNIQUES).toContain("no technique is a gate");
    expect(prompt).toContain("Editing techniques");
    expect(prompt).toContain("different declaration `(path, symbol, kind)`");
    expect(prompt).toContain("`create <path> end`");
    expect(prompt).toContain("create [static] <kind> <name> in <path>");
    expect(prompt).toContain("`enum-member`");
    expect(prompt).toContain("dotted `Owner.name`");
    expect(prompt).toContain("select file <path>");
    expect(prompt).toContain("create import in <path>");
    expect(prompt).not.toContain("never create a dotted member");
    expect(prompt).toContain("`delete <path> end`");
    expect(prompt).toContain("`read <path>");
    expect(prompt).toContain("`write <path> with");
    expect(prompt).not.toContain("one bounded self-check");
    expect(prompt).not.toContain("MAX_TASK");
  });

  test("the execution guide chooses an action from the source and keeps write valid", () => {
    const prompt = buildTaskExecutionSystemPrompt();
    expect(prompt).toContain(TASK_EDIT_STRATEGY_GUIDE);
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("New file or skeleton");
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("Local edit in an existing file");
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("Several related declarations in one file");
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("Large declaration rewrite");
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("Whole-file rewrite of an existing file");
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("no hard size or shape rejection");
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain(TASK_FAILED_WRITE_REPAIR_ADVICE);
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("`write` is always a valid action");
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("advice you may override");
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("Small requirement on a small file");
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("large module");
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("one whole-file `write` scaffold");
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("not dozens of separate `create` clauses");
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("A small file can still be one whole-file write");
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("Add or edit an import/export statement");
    expect(TASK_EDIT_STRATEGY_GUIDE).toContain("no whole-file write is required");
  });

  test("functional style stays the shared plan-exec block", () => {
    expect(TASK_FUNCTIONAL_STYLE).toContain("Prefer ML-style functional TypeScript");
    expect(TASK_FUNCTIONAL_STYLE).toContain("Do not create new classes");
    expect(buildTaskExecutionSystemPrompt()).toContain(TASK_FUNCTIONAL_STYLE);
  });

  test("the execution prompt ends with a binding no-tools edit-dsl contract", () => {
    const prompt = buildTaskExecutionSystemPrompt();
    expect(prompt.trimEnd().endsWith(TASK_EXECUTION_OUTPUT_CONTRACT)).toBe(true);
    expect(TASK_EXECUTION_OUTPUT_CONTRACT).toContain("No tools are available on this turn");
    expect(TASK_EXECUTION_OUTPUT_CONTRACT).toContain(
      "`read`, `select`, `write`, `create`, and `delete` are literal edit-dsl text commands, not function calls",
    );
    expect(TASK_EXECUTION_OUTPUT_CONTRACT).toContain("Never emit `<|...|>`, `<｜...｜>`");
    expect(TASK_EXECUTION_OUTPUT_CONTRACT).toContain(
      "is plain text: it is not a Markdown code fence and not a tool-call boundary",
    );
    expect(TASK_EXECUTION_OUTPUT_CONTRACT).toContain("no prose preamble, no Markdown fence");
    expect(TASK_EXECUTION_OUTPUT_CONTRACT).toContain(
      "A viewer/read is inspection only; to finish a node, include edit clauses or file commands",
    );
  });

  test("the execution turn repeats the no-tools/no-DSML instruction", () => {
    const prompt = buildTaskTurnPrompt({ node: node("02-answer"), views: [] });
    expect(prompt).toContain("No tools are available");
    expect(prompt).toContain("never DSML/tool-call markup");
    expect(prompt).toContain("treat the sentinel block as literal text");
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

  test("renders the soft edit strategy advisory as separate guidance", () => {
    const prompt = buildTaskTurnPrompt({
      node: node("03-impl"),
      views: [],
      editStrategyAdvisory:
        "`src/helper.ts` existed with 300 lines before the write and has 301 lines after it.",
    });
    expect(prompt).toContain("# Edit strategy advisory");
    expect(prompt).toContain("src/helper.ts");
    expect(prompt).toContain("300 lines");
    expect(prompt).toContain("Reply with the edit-dsl clauses");
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

  test("a failed gate carries the targeted-repair criteria", () => {
    const prompt = buildTaskReviewPrompt({
      node: node("03-impl"),
      gate: { verify: "tsc", ok: false, diagnostics: "src/helper.ts(2,3): error TS2322" },
      diff: '--- a/src/helper.ts\n+++ b/src/helper.ts\n@@ -1 +1 @@\n-return 1;\n+return "bad";',
    });
    expect(prompt).toContain("Gate: tsc failed.");
    expect(prompt).toContain("# Failed-gate edit strategy");
    expect(prompt).toContain(TASK_FAILED_WRITE_REPAIR_ADVICE);
    expect(prompt).toContain("broad structural breakage");
    expect(prompt).toContain("not a gate");
  });

  test("a review retry keeps the approve-or-patch contract", () => {
    const prompt = buildTaskReviewRetryPrompt("stage: plan-protocol\nmissing end");
    expect(prompt).toContain("# Review retry");
    expect(prompt).toContain("missing end");
    expect(prompt).toContain("`approve` or one corrected `patch`");
    expect(prompt).not.toContain("Recovery for this finish rejection:");
  });

  test("a review retry carries the final-node recovery when finish is rejected", () => {
    const prompt = buildTaskReviewRetryPrompt(
      'stage: plan-graph\ncode: PLAN_FINISH_NOT_LAST\n- finish marks node #04-final, but it verifies "tsc"; the final node must verify "test"',
    );
    expect(prompt).toContain("Recovery for this finish rejection:");
    expect(prompt).toContain('node+ "04-final-final" after "04-final" verify test');
    expect(prompt).toContain("`approve` or one corrected `patch`");
  });
});
