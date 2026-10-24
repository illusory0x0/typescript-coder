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
import { formatTaskLoc, renderFailedTasks, renderTaskDag, renderTaskStatus } from "../tasks";
import type { SourceFile } from "../utility";
import { appendSpecSection, splitSourceLines } from "./shared";

/** Caps shared with the planner prompt text and the driver. */
export const MAX_TASK_EXCHANGES = 3;
export const MAX_TASK_ROUNDS = 2;
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
 * A complex plan example: create a helper, use it, then rename the old
 * function to the new name (the planner workflow from `human/agent-mode.yaml`).
 */
export const TASK_PLAN_COMPLEX_EXAMPLE = `{
  "tasks": [
    {
      "id": 1,
      "loc": { "path": "src/format.ts", "symbol": "formatNumber", "kind": "value" },
      "deps": [],
      "action": "create",
      "instruction": "Add an exported function formatNumber(value: number): string with its complete declaration."
    },
    {
      "id": 2,
      "loc": { "path": "src/report.ts", "symbol": "printTotal", "kind": "value" },
      "parent": 1,
      "deps": [1],
      "action": "modify",
      "instruction": "Make printTotal call formatNumber(total) instead of String(total)."
    },
    {
      "id": 3,
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

/** Two independent ready tasks, one of them a delete. */
export const TASK_PLAN_PARALLEL_EXAMPLE = `{
  "tasks": [
    {
      "id": 1,
      "loc": { "path": "src/legacy.ts", "symbol": "oldHelper", "kind": "value" },
      "deps": [],
      "action": "delete",
      "instruction": "Remove oldHelper; nothing references it."
    },
    {
      "id": 2,
      "loc": { "path": "src/main.ts", "symbol": "run", "kind": "value" },
      "deps": [],
      "action": "modify",
      "instruction": "Make run return the number of processed rows."
    }
  ],
  "todo": [1, 2],
  "status": { "1": "todo", "2": "todo" }
}`;

/** The amendment shape on a re-plan: done, retried failed, and new tasks. */
export const TASK_REPLAN_EXAMPLE = `{
  "tasks": [
    {
      "id": 1,
      "loc": { "path": "src/a.ts", "symbol": "parse", "kind": "value" },
      "deps": [],
      "action": "modify",
      "instruction": "Keep this completed change unchanged."
    },
    {
      "id": 2,
      "loc": { "path": "src/a.ts", "symbol": "format", "kind": "value" },
      "deps": [],
      "action": "modify",
      "instruction": "Retry with a smaller change: return the formatted string instead of rewriting the caller."
    },
    {
      "id": 3,
      "loc": { "path": "src/a.ts", "symbol": "render", "kind": "value" },
      "deps": [2],
      "action": "modify",
      "instruction": "Use the new format result."
    }
  ],
  "todo": [2],
  "status": { "1": "done", "2": "todo", "3": "todo" }
}`;

const TASK_PLAN_FIELDS = `- "tasks": a non-empty array (at most 64), each task with:
  - "id": a positive integer, unique in the plan;
  - "loc": {"path": repo-relative file path, "symbol": declared name, "kind": "value" | "type" | "namespace"}. "kind" is the TypeScript symbol space, not the declaration keyword. For "create" it selects the wrapper of a body that is not a complete declaration;
  - "parent": optional positive integer naming another task in the plan; it groups tasks only and never orders execution;
  - "deps": array of task ids that must finish first (execution order);
  - "action": "modify" | "create" | "delete" | "rename";
  - "instruction": a short, self-contained paragraph (at most 4,000 characters) that states the intended code change and every behavioral detail this task needs. The executor sees only this task and the current source, never the requirement text or the test files;
  - "renameTo": required only for action "rename", the new identifier;
- "todo": the ids that are ready now (every dependency done), in priority order. Initially this is exactly the root set: no task in "todo" may depend on another todo task;
- "status": an object mapping every task id to its status. A new plan starts every task "todo"; on a re-plan echo the status the harness gives you.`;

const TASK_PLAN_RULES = `Rules:
1. One task has one address. A change that spans declarations or files becomes several tasks linked by deps, in order.
2. Keep every intermediate state type-correct: after each task the harness runs the type check, and a failing task is handed back as failed. When a change would break the type check until a later task lands, give the plan a compatibility step (for example the new declaration before its callers change, or an alias before the rename) so no task leaves the project broken.
3. Model a rename as action "rename" with "renameTo" on the declaration that owns the name; its "instruction" says to update the references the harness rewrites. Same-file references are rewritten; a rename that must cross files becomes tasks that change each caller, then a rename, or is not expressible and must be escalated.
4. Prefer modify over rewrite: name the smallest declaration that must change. An instruction may mention a span, a signature, or an expected shape, but must not paste a whole file.
5. Test files (*.test.ts) are specifications. Do not target them unless the requirement explicitly asks for a test change. The executor does not see them, so copy the behavior this task must satisfy into its instruction.
6. Dependencies must describe the real order; do not add cycles or redundant dependencies. A task that is independent of another should not depend on it.
7. If the requirement is vague, too large for one DAG, or not expressible as these tasks, stop and say why instead of guessing.`;

export function buildTaskPlanningSystemPrompt(): string {
  return [
    TASK_PLANNING_ROLE,
    "",
    "Reply with ONLY one bare JSON object, no markdown fences, no prose:",
    "",
    "Minimal example (the actual reply shape):",
    "",
    TASK_PLAN_EXAMPLE,
    "",
    "Fields:",
    "",
    TASK_PLAN_FIELDS,
    "",
    TASK_PLAN_RULES,
    "",
    "A multi-step example (a create, its caller, then a rename):",
    "",
    TASK_PLAN_COMPLEX_EXAMPLE,
    "",
    "Two independent ready tasks, including a delete:",
    "",
    TASK_PLAN_PARALLEL_EXAMPLE,
    "",
    "The symbol index and the current task status below are the only project context you get. Address one symbol-index entry per task; a symbol that the index does not list is not a target unless the task creates it.",
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
  /** Test diagnostics when all tasks finished but the suite failed. */
  testDiagnostics?: string;
  /** Why no task is ready, when the frontier is blocked instead of failed. */
  blocked?: string;
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
  if (input.testDiagnostics !== undefined && input.testDiagnostics.trim() !== "") {
    blocks.push("", "# Test results", "", "```", input.testDiagnostics.trim(), "```");
  }
  if (input.blocked !== undefined && input.blocked.trim() !== "") {
    blocks.push("", "# Blocked", "", input.blocked);
  }
  blocks.push(
    "",
    "# Amend the plan",
    "",
    input.delta,
    "",
    "Shape of a valid amendment (keep #1 done, retry failed #2, add #3):",
    "",
    TASK_REPLAN_EXAMPLE,
    "",
    "Reply with the complete plan JSON, including every existing task.",
  );
  return blocks.join("\n");
}

/** The first-plan correction: a protocol/DAG error, then the same ask. */
export function buildTaskPlanRetryPrompt(diagnostics: string): string {
  return `The previous plan was rejected.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`

Reply with the complete, corrected task plan JSON only.`;
}

const TASK_ACTION_RULES: Record<string, string> = {
  modify:
    "The declaration must already exist. Reply with one or more edit clauses that change it; a reply that writes nothing is rejected.",
  create:
    "The declaration (or the file) must be absent. Reply with a whole-declaration `select … replace with <fence> end` clause carrying no `match` or `pick`; a complete top-level declaration is appended verbatim, any other body is wrapped by the task's symbol space (value → `let`, type → `type`, namespace → `namespace`).",
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
    "A reply is one or more `select … end` clauses; no prose and no JSON edit payload. The task's target is already selected: edit it directly (a bare viewer only locates a match).",
    "",
    "Clause: `select <symbol> in <path> [ resolve <value|type|namespace> ] [ match (<snippet> | /regex/) ] [ [ pick <range> ] replace with <fence> | rename <old> to <new> ] end`.",
    "`match` locates a span inside the declaration; `pick` narrows a match and requires `replace`; omit `match` to rewrite the whole declaration; an empty fence deletes it. `resolve` is optional and, when present, must name the task's symbol space. The fence opens with 5+ hyphens (for example `-----`) or 6+ backticks and closes with the same run. `pick` coordinates are the 1-based file-absolute lines of the content view.",
    "",
    "Examples:",
    "",
    "Whole-declaration modify:",
    "",
    "```````",
    [
      "select answer in src/a.ts resolve value",
      "replace with",
      "-----",
      "export function answer(): number {",
      "  return 2;",
      "}",
      "-----",
      "end",
    ].join("\n"),
    "```````",
    "",
    "Match and pick one line:",
    "",
    "```````",
    [
      "select answer in src/a.ts resolve value",
      "match `return 1;`",
      "pick 2",
      "replace with",
      "-----",
      "return 2;",
      "-----",
      "end",
    ].join("\n"),
    "```````",
    "",
    "Create an absent declaration:",
    "",
    "```````",
    [
      "select double in src/a.ts resolve value",
      "replace with",
      "-----",
      "export function double(value: number): number {",
      "  return value * 2;",
      "}",
      "-----",
      "end",
    ].join("\n"),
    "```````",
    "",
    "Delete (empty fence):",
    "",
    "```````",
    ["select unused in src/a.ts resolve value", "replace with", "-----", "-----", "end"].join("\n"),
    "```````",
    "",
    "Rename:",
    "",
    "```````",
    ["select answer in src/a.ts resolve value", "rename answer to result", "end"].join("\n"),
    "```````",
  ].join("\n");
}

/** The execution system prompt: the editing grammar, stable for the whole DAG. */
export function buildTaskExecutionSystemPrompt(): string {
  return [
    TASK_EXECUTION_ROLE,
    "",
    'The current source of the task target is included below. Reply with ONLY the edit clauses that carry the task out — no prose, no JSON edit payload. After a rejected edit or a failed type check the one JSON exception is the bounded self-check read {"request":"read"}; the harness returns the source, then asks again. Report the end of a task in one word only if an edit already landed: `TASK_DONE`.',
    "",
    "Reply shape: `select <symbol> in <path> [ resolve <value|type|namespace> ] [ match (<snippet> | /regex/) ] [ [ pick <range> ] replace with <fence> | rename <old> to <new> ] end`. A bare clause with no `replace` or `rename` is a read-only viewer.",
    "",
    "Action-specific rules:",
    ...Object.entries(TASK_ACTION_RULES).map(([action, rule]) => `- ${action}: ${rule}`),
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
  /** Task-scoped retry/round framing. */
  context?: string;
  /** Whether the edit is a repair after a failed type check. */
  repair?: boolean;
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
    `Target: ${formatTaskLoc(task.loc)}`,
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
      input.repair === true ? "# Type check failed" : "# Diagnostics",
      "",
      "```",
      input.diagnostics.trim(),
      "```",
      "",
      TASK_SELF_CHECK_OFFER,
    );
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
    "Reply with the edit clauses for this task. After an edit lands, reply `TASK_DONE` to finish it.",
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
    "A failed task may be retried only by changing its definition and setting its status to todo; otherwise leave it failed.",
    "Add new tasks with fresh ids (above the current maximum) and status todo; amend or remove unfinished tasks by re-emitting the full list.",
    "Emit todo as exactly the ready frontier after your changes.",
  ];
  const lead =
    input.failedIds.length > 0
      ? `The failed task(s) ${input.failedIds.map((id) => `#${id}`).join(", ")} could not be carried out. Fix the cause: amend the failing task (a different address or a smaller step), or add tasks that do what it could not.`
      : input.testsFailed
        ? "Every task is done and the type check passes, but the test suite fails. Add the tasks the test output calls for, or amend the plan they contradict."
        : input.blocked
          ? "No task is ready to run. Repair the dependency graph so the remaining work becomes ready, or remove work that is not needed."
          : "Continue the plan.";
  return [lead, "", ...rules.map((rule) => `- ${rule}`)].join("\n");
}
