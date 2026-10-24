/**
 * Planning and execution prompts for the plan/execute loop (`docs/spec.md`).
 *
 * Planning context (stability-descending): role → requirement + symbol index →
 * (re-plan only) DAG, status, and diagnostics.
 *
 * Execution context: role + edit-action grammar (stable for the DAG) → the
 * execution turn (current task, status, diagnostics, numbered content view).
 *
 * The execution instruction teaches the same clause grammar as the edit-dsl
 * driver, but starts from an already-selected target: it omits the select-first
 * workflow and the raw file commands the task executor rejects.
 */

import type { EditTask, TaskId, TaskRunState } from "../tasks";
import {
  formatTaskLoc,
  renderFailedRoots,
  renderFailedTasks,
  renderTaskDag,
  renderTaskStatus,
} from "../tasks";
import type { SourceFile } from "../utility";
import { appendSpecSection, splitSourceLines } from "./shared";

/** Caps shared with the planner prompt text and the driver. */
export const MAX_TASK_EXCHANGES = 3;
export const MAX_TASK_PLAN_ROUNDS = 8;

export const TASK_PLANNING_ROLE =
  "You are a senior software engineer planning a TypeScript change. You decompose one requirement into an edit-task DAG; a separate coding expert then executes each task with precise edit clauses. You do not write code and you do not run commands.";

export const TASK_EXECUTION_ROLE =
  "You are a TypeScript coding expert. You receive one task at a time from an edit-task DAG and carry it out with precise edit clauses. You do not re-plan the requirement; the planner owns the DAG.";

/** The canonical minimal plan example, shown to the planner. */
export const TASK_PLAN_EXAMPLE = `{
  "tasks": [
    {
      "id": 1,
      "root": 1,
      "verify": "test",
      "loc": { "path": "src/helper.ts", "symbol": "answer", "kind": "value" },
      "deps": [],
      "action": "modify",
      "instruction": "Change answer so it returns 2 instead of 1."
    }
  ],
  "todo": [1],
  "status": { "1": "todo" }
}`;

/**
 * A complex plan example: a type change migrates coupled declarations in one
 * root, then a later test root verifies the behavior. The final root must use
 * `verify: "test"`.
 */
export const TASK_PLAN_COMPLEX_EXAMPLE = `{
  "tasks": [
    {
      "id": 1,
      "root": 1,
      "verify": "tsc",
      "loc": { "path": "src/format.ts", "symbol": "Formatter", "kind": "type" },
      "related": [
        { "path": "src/format.ts", "symbol": "formatNumber", "kind": "value" }
      ],
      "deps": [],
      "action": "modify",
      "instruction": "Change the Formatter shape and update formatNumber in the same migration."
    },
    {
      "id": 2,
      "root": 1,
      "loc": { "path": "src/report.ts", "symbol": "printTotal", "kind": "value" },
      "deps": [1],
      "action": "modify",
      "instruction": "Make printTotal call formatNumber(total) instead of String(total)."
    },
    {
      "id": 3,
      "root": 3,
      "verify": "test",
      "loc": { "path": "src/report.ts", "symbol": "printTotal", "kind": "value" },
      "deps": [2],
      "action": "rename",
      "renameTo": "printAmount",
      "instruction": "Rename printTotal to printAmount and update its same-file references."
    }
  ],
  "todo": [1],
  "status": { "1": "todo", "2": "todo", "3": "todo" }
}`;

const TASK_PLAN_FIELDS = `- "tasks" (1-64): each has "id", "root", "loc" {path, symbol, kind: value|type|namespace; kind is the TypeScript symbol space}, "deps", "action" (modify|create|delete|rename), and "instruction" (a self-contained paragraph; the executor never sees the requirement or tests).
- "root": the root task id. A root task names itself (root === id) and carries "verify": "tsc" | "test"; all other tasks name that root. Every task in a root runs before the root gate, so a root gate sees the completed batch, not individual micro-edits. Roots run in plan order. The final root must carry "verify": "test".
- "related": optional same-file loc objects that a modify task may edit atomically with its main target; use it for type/representation migrations.
- "renameTo": required only for rename.
- "todo": the ready task ids, in priority order.
- "status": every task id mapped to "todo", "done", or "failed".`;

const TASK_PLAN_RULES = `Rules:
1. One task has one main address; put cohesive coupled changes (a type plus its direct same-file users) in one task's "related" list instead of forcing a temporarily broken intermediate state.
2. A root gate runs only after all of its micro-tasks are done. Use a "tsc" root for a type phase and a "test" root for a semantic phase; the final root must be "test".
3. A create task must carry the complete declaration body. Do not plan a later task that rewrites the same declaration unless the create deliberately made a stub; gates verify, so a task whose only effect would be a no-op does not belong in the DAG.
4. A create fence must declare exactly the task's target declaration. Put helper declarations in their own create tasks.
5. Use action "rename" with "renameTo" when the declaration name changes; cross-file callers need their own tasks.
6. Name the smallest declaration that must change; never paste a whole file into an instruction.
7. Do not target *.test.ts unless the requirement explicitly changes tests; copy required behavior into the instruction.
8. Dependencies must be real and acyclic; roots run in plan order, so a task must not depend on a task in a later root.
9. Keep roots as coherent phases. A root is not a scheduling unit for one-line edits; group related micro-tasks, then gate them.
10. If the requirement is too large or not expressible, stop and say why.`;

export function buildTaskPlanningSystemPrompt(): string {
  return [
    TASK_PLANNING_ROLE,
    "",
    "Reply with ONLY one bare JSON object, no markdown fences, no prose.",
    "",
    TASK_PLAN_EXAMPLE,
    "",
    TASK_PLAN_FIELDS,
    "",
    TASK_PLAN_RULES,
    "",
    "Address one symbol-index entry per task; a symbol that the index does not list is not a target unless the task creates it.",
    "",
  ].join("\n");
}

/** The first planning turn: requirement, symbol index, spec files. */
export function buildTaskPlanningUserPrompt(
  requirement: string,
  indexText: string,
  specFiles: readonly SourceFile[] = [],
): string {
  const prompt = `# Requirement\n\n${requirement}\n\n# Symbol index\n\n\`\`\`text\n${indexText}\n\`\`\`\n\nReply with the complete task plan JSON.\n`;
  return appendSpecSection(prompt, specFiles);
}

/**
 * A re-planning turn: the requirement stays in the cached prefix; this turn
 * carries the current DAG, the harness status, the failed tasks with their
 * diagnostics, and (after a test failure) the test output. It also names the
 * delta the planner must apply.
 */
export function buildTaskReplanPrompt(input: {
  state: TaskRunState;
  failures: ReadonlyMap<TaskId, string>;
  /** Diagnostics from a failed root gate (tsc or test). */
  rootFailures?: ReadonlyMap<TaskId, string>;
  /** The gate diagnostics, also rendered as a direct block. */
  gateDiagnostics?: string;
  /** Why no task is ready, when the frontier is blocked instead of failed. */
  blocked?: string;
  /** Fresh symbol index of the current workspace, after edits. */
  symbolIndex?: string;
  /** Explanation of what the planner may change in this reply. */
  delta: string;
}): string {
  const blocks = [
    "# Edit-task DAG",
    "",
    renderTaskDag(input.state.tasks),
    "",
    "# Status",
    "",
    renderTaskStatus(input.state),
  ];
  const failed = renderFailedTasks(input.state, input.failures);
  if (failed !== "") {
    blocks.push("", "# Failed tasks and diagnostics", "", failed);
  }
  const failedRoots =
    input.rootFailures === undefined ? "" : renderFailedRoots(input.state, input.rootFailures);
  if (failedRoots !== "") {
    blocks.push("", "# Failed root gates and diagnostics", "", failedRoots);
  }
  if (input.gateDiagnostics !== undefined && input.gateDiagnostics.trim() !== "") {
    blocks.push("", "# Gate results", "", "```", input.gateDiagnostics.trim(), "```");
  }
  if (input.blocked !== undefined && input.blocked.trim() !== "") {
    blocks.push("", "# Blocked", "", input.blocked);
  }
  if (input.symbolIndex !== undefined && input.symbolIndex.trim() !== "") {
    blocks.push("", "# Current symbol index", "", "```text", input.symbolIndex.trim(), "```");
  }
  blocks.push(
    "",
    "# Amend the plan",
    "",
    input.delta,
    "",
    "Reply with the complete plan JSON, including every existing task.",
  );
  return blocks.join("\n");
}

/**
 * The first-plan correction: a protocol/DAG error, then the same ask. The
 * illustrative plan is appended only here, when the model has already failed
 * the shape once; the initial prompt stays lean.
 */
export function buildTaskPlanRetryPrompt(diagnostics: string, help = true): string {
  const example = help
    ? `\n\nExample of a valid multi-task plan:\n\n${TASK_PLAN_COMPLEX_EXAMPLE}`
    : "";
  return `The previous plan was rejected.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`${example}

Reply with the complete, corrected task plan JSON only.`;
}

const TASK_ACTION_RULES: Record<string, string> = {
  modify:
    "The declaration must already exist. Reply with one or more edit clauses that change it; a reply that writes nothing is rejected.",
  create:
    "The declaration must be absent. Reply with a whole-declaration `select … replace with <fence> end` clause carrying no `match` or `pick`; the fence must contain exactly one top-level declaration, the task target. Any other body is wrapped by the task's symbol space (value → `let`, type → `type`, namespace → `namespace`).",
  delete:
    "Reply with a whole-declaration clause with an empty fence (no `match`, no `pick`) to remove the declaration. Deleting a whole file is not a task action.",
  rename:
    "Reply with `select … rename <current> to <newName> end`; the harness rewrites the declaration name and its same-file references and refuses a colliding name.",
};

/** The bounded self-check offer on a task turn's repair prompt. */
export const TASK_SELF_CHECK_OFFER =
  'You may make at most one bounded self-check read per task: reply with exactly {"request":"read"} to see the current source again; the harness returns it, then asks again.';

/**
 * The execution instruction. It teaches the same clause grammar as the edit
 * driver, but the target is already selected, so it omits the select-first
 * workflow and the raw file commands the task executor rejects.
 */
export function taskEditDslInstruction(): string {
  return [
    "A reply is one or more `select … end` clauses; no prose, no JSON edit payload. The task's target is already selected: edit it directly (a bare viewer only locates a match).",
    "",
    "Clause: `select <symbol> in <path> [ resolve <value|type|namespace> ] [ match (<snippet> | /regex/) ] [ [ pick <range> ] replace with <fence> | rename <old> to <new> ] end`.",
    "`match` locates a span inside the declaration; `pick` narrows a match and requires `replace`; omit `match` to rewrite the whole declaration; an empty fence deletes it. The fence opens with 5+ hyphens (for example `-----`) or 6+ backticks and closes with the same run. `pick` coordinates are the 1-based file-absolute lines of the content view.",
    "",
    "You do not run the type check; the harness runs the root gate after all micro-tasks in the root finish. A task may also edit the same-file declarations listed in its `related` field.",
  ].join("\n");
}

/** One action-specific example, injected only after a format rejection. */
export function taskEditDslHelp(action: EditTask["action"]): string {
  const examples: Record<EditTask["action"], string> = {
    modify: [
      "select answer in src/a.ts resolve value",
      "match `return 1;`",
      "pick 2",
      "replace with",
      "-----",
      "return 2;",
      "-----",
      "end",
    ].join("\n"),
    create: [
      "select double in src/a.ts resolve value",
      "replace with",
      "-----",
      "export function double(value: number): number {",
      "  return value * 2;",
      "}",
      "-----",
      "end",
    ].join("\n"),
    delete: [
      "select unused in src/a.ts resolve value",
      "replace with",
      "-----",
      "-----",
      "end",
    ].join("\n"),
    rename: ["select answer in src/a.ts resolve value", "rename answer to result", "end"].join(
      "\n",
    ),
  };
  return `Example for this action:\n\n${examples[action]}`;
}

/** The execution system prompt: the editing grammar, stable for the whole DAG. */
export function buildTaskExecutionSystemPrompt(): string {
  return [
    TASK_EXECUTION_ROLE,
    "",
    'The current source of the task target is included below. Reply with ONLY the edit clauses that carry the task out — no prose, no JSON edit payload. After a rejected edit the one JSON exception is the bounded self-check read {"request":"read"}; the harness returns the source, then asks again. The type/test check is a root gate after all micro-tasks in the root finish; land this task\'s edit and stop.',
    "",
    "Reply shape: `select <symbol> in <path> [ resolve <value|type|namespace> ] [ match (<snippet> | /regex/) ] [ [ pick <range> ] replace with <fence> | rename <old> to <new> ] end`. A bare clause with no `replace` or `rename` is a read-only viewer.",
    "",
    taskEditDslInstruction(),
    "",
  ].join("\n");
}

export interface TaskTurnInput {
  state: TaskRunState;
  task: EditTask;
  /** Numbered, file-absolute source view for the current target (or the file). */
  contentView: string;
  /** First line number of `contentView`'s first line (1 for a whole file). */
  startLine?: number;
  /** Diagnostics from the previous rejected/failed exchange, or the task's opening state. */
  diagnostics?: string;
  /** Task-scoped retry framing. */
  context?: string;
  /** Append one action-specific example after a format/address rejection. */
  help?: boolean;
}

function numberedView(source: string, startLine = 1): string {
  const lines = splitSourceLines(source);
  if (lines.length === 0) {
    return "";
  }
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, " ")} | ${line}`)
    .join("\n");
}

/**
 * One execution turn: the current task, the harness status, the content view
 * last (the volatile tail). The DAG structure is in the execution system
 * prompt once; repeating the whole DAG here would invalidate the cache-stable
 * prefix on every turn.
 */
export function buildTaskTurnPrompt(input: TaskTurnInput): string {
  const { task } = input;
  const status = input.state.status.get(task.id) ?? "todo";
  const action =
    task.action === "rename" ? `rename to ${JSON.stringify(task.renameTo)}` : task.action;
  const blocks = [
    "# Task",
    "",
    `#${task.id} (${action}) — ${status}`,
    "",
    `Root: #${task.root}`,
    "",
    `Target: ${formatTaskLoc(task.loc)}`,
    ...(task.related === undefined || task.related.length === 0
      ? []
      : [
          "",
          `Related targets (same migration): ${task.related
            .map((loc) => formatTaskLoc(loc))
            .join(", ")}`,
        ]),
    "",
    `Dependencies done. Instruction: ${task.instruction}`,
    "",
    TASK_ACTION_RULES[task.action] ?? "",
    "",
    "# Project status",
    "",
    renderTaskStatus(input.state),
  ];
  if (input.context !== undefined && input.context.trim() !== "") {
    blocks.push("", "# Context", "", input.context);
  }
  if (input.diagnostics !== undefined && input.diagnostics.trim() !== "") {
    blocks.push(
      "",
      "# Diagnostics",
      "",
      "```",
      input.diagnostics.trim(),
      "```",
      "",
      TASK_SELF_CHECK_OFFER,
    );
  }
  if (input.help === true) {
    blocks.push("", "# Format help", "", taskEditDslHelp(task.action));
  }
  blocks.push(
    "",
    "# Content view",
    "",
    input.startLine === undefined || input.startLine <= 1
      ? "Each line below is prefixed with its 1-based line number."
      : `Each line below is prefixed with its 1-based file-absolute line number; the target declaration starts at line ${input.startLine}.`,
    "",
    "```text",
    input.contentView.trim() === "" ? "(empty)" : input.contentView,
    "```",
    "",
    "Reply with the edit clauses for this task. The root gate runs after all sibling micro-tasks finish.",
  );
  return blocks.join("\n");
}

/** Render a declaration (or file) region for the content view. */
export function renderTaskContentView(source: string, startLine = 1): string {
  return numberedView(source, startLine);
}

/** The planner's re-plan delta sentence for the common causes. */
export function replanDelta(input: {
  failedIds: readonly TaskId[];
  testsFailed: boolean;
  blocked: boolean;
}): string {
  const rules = [
    "Keep every done task exactly as it is, and keep the ids of tasks you keep.",
    "Echo each existing task's status: done tasks stay done, todo tasks stay todo.",
    "A failed task may be retried by changing its definition and setting it to todo. A failed root reopens when you add or amend its repair tasks; its gate runs again after they finish.",
    "A passed root is closed; a failed root may be repaired in place. Add new tasks with fresh ids, or amend the failed task with a changed definition.",
    "Add new tasks with fresh ids (above the current maximum) and status todo; amend or remove unfinished tasks by re-emitting the full list.",
    "Use related same-file locs when a type/representation migration must update several declarations atomically.",
    'The final root must carry verify: "test"; earlier roots may use "tsc" or "test".',
    "Emit todo as the first pending root's ready tasks; the harness recomputes and normalizes it.",
  ];
  const lead =
    input.failedIds.length > 0
      ? `The failed task(s) ${input.failedIds.map((id) => `#${id}`).join(", ")} could not be carried out. Fix the cause: amend the failing task (a different address or a smaller step), or add tasks that do what it could not.`
      : input.testsFailed
        ? "A root gate failed after its micro-tasks completed. Add repair micro-tasks to that root (it reopens), or add a new root; the final gate must still be test."
        : input.blocked
          ? "No task is ready to run. Repair the dependency graph so the remaining work becomes ready, or remove work that is not needed."
          : "Continue the plan.";
  return [lead, "", ...rules.map((rule) => `- ${rule}`)].join("\n");
}
