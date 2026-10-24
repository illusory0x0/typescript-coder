/**
 * Planning and execution prompts for the plan/execute loop (`docs/spec.md`).
 *
 * Planning context (stability-descending): role -> requirement + symbol index
 * -> (re-plan only) tree, status, and diagnostics.
 *
 * Execution context: role + edit-action grammar (stable for the tree) -> the
 * execution turn (stage, task, current edit, diagnostics, numbered view).
 *
 * The planner emits a Stage -> Task -> edit tree. A task is the verification
 * boundary; an edit is one declaration action. Array order is execution order,
 * and the harness owns status.
 */

import type { EditNode, NodeId, Stage, TaskNode, TaskRunState } from "../tasks";
import {
  formatTaskLoc,
  MAX_EDITS_PER_TASK,
  MAX_STAGES,
  MAX_TASKS_PER_STAGE,
  renderFailedEdits,
  renderFailedTaskGates,
  renderTaskStatus,
  renderTaskTree,
} from "../tasks";
import type { SourceFile } from "../utility";
import { appendSpecSection, splitSourceLines } from "./shared";

/** Caps shared with the planner prompt text and the driver. */
export const MAX_TASK_EXCHANGES = 3;
export const MAX_TASK_PLAN_ROUNDS = 8;

export const TASK_PLANNING_ROLE =
  "You are a senior software engineer planning a TypeScript change. You decompose one requirement into a Plan -> Stage -> Task -> edit tree; a separate coding expert then executes the edits one at a time. You do not write code and you do not run commands.";

export const TASK_EXECUTION_ROLE =
  "You are a TypeScript coding expert. You receive one micro edit at a time from a Stage -> Task -> edit tree and carry it out with precise edit clauses. The task instruction is the local goal; the planner owns the tree.";

/** The canonical minimal plan example, shown to the planner. */
export const TASK_PLAN_EXAMPLE = `{
  "stages": [
    {
      "id": 1,
      "goal": "Add a formatting helper and make the report use it.",
      "tasks": [
        {
          "id": 2,
          "verify": "test",
          "instruction": "Add formatNumber and call it from printTotal.",
          "edits": [
            {
              "id": 3,
              "loc": { "path": "src/format.ts", "symbol": "formatNumber", "kind": "value" },
              "action": "create",
              "instruction": "Add a small exported formatNumber(value: number): string helper."
            },
            {
              "id": 4,
              "loc": { "path": "src/report.ts", "symbol": "printTotal", "kind": "value" },
              "action": "modify",
              "instruction": "Call formatNumber(total) instead of String(total)."
            }
          ]
        }
      ]
    }
  ]
}`;

/**
 * A complex plan example: a type migration and its direct caller form one
 * type-check task, then a later test task finishes the rename. The final task
 * must use `verify: "test"`.
 */
export const TASK_PLAN_COMPLEX_EXAMPLE = `{
  "stages": [
    {
      "id": 1,
      "goal": "Migrate the Formatter shape without breaking its callers.",
      "tasks": [
        {
          "id": 2,
          "verify": "tsc",
          "instruction": "Make Formatter and its direct formatting helper agree.",
          "edits": [
            {
              "id": 3,
              "loc": { "path": "src/format.ts", "symbol": "Formatter", "kind": "type" },
              "related": [
                { "path": "src/format.ts", "symbol": "formatNumber", "kind": "value" }
              ],
              "action": "modify",
              "instruction": "Change the Formatter shape and update formatNumber atomically."
            },
            {
              "id": 4,
              "loc": { "path": "src/report.ts", "symbol": "printTotal", "kind": "value" },
              "action": "modify",
              "instruction": "Make printTotal use the new Formatter shape."
            }
          ]
        }
      ]
    },
    {
      "id": 5,
      "goal": "Finish the rename and verify the behavior.",
      "tasks": [
        {
          "id": 6,
          "verify": "test",
          "instruction": "Rename printTotal to printAmount and leave the suite green.",
          "edits": [
            {
              "id": 7,
              "loc": { "path": "src/report.ts", "symbol": "printTotal", "kind": "value" },
              "action": "rename",
              "renameTo": "printAmount",
              "instruction": "Rename printTotal to printAmount and update its same-file references."
            }
          ]
        }
      ]
    }
  ]
}`;

const TASK_PLAN_FIELDS = `- The root object is the Plan; it contains "stages" (1-${MAX_STAGES}). Each stage has "id", "goal", and "tasks" (1-${MAX_TASKS_PER_STAGE}). Stage order is execution order; the goal is planning context for the executor.
- A "task" (id, verify: "tsc" | "test", instruction, edits) is a verification boundary. Its gate runs after every edit in it settles, so plan the whole task so that gate passes. The final task must verify "test".
- An "edit" (id, loc {path, symbol, kind: value|type|namespace}, action: modify|create|delete|rename, instruction) is one declaration action. Optional "related" lists same-file declarations a modify edit may change atomically; "renameTo" is required only for rename.
- Ids are unique across all tasks and edits. Array order is execution order. There are no deps, todo, or status fields; the harness owns status.`;

const TASK_PLAN_RULES = `Rules:
1. Write like a normal TypeScript engineer: small named functions with one job, helpers extracted and called by a thin orchestrator. Do not put a large multi-step algorithm into one declaration or one create edit.
2. Plan each task to pass its own gate. Normally 2-4 edits per task; never more than ${MAX_EDITS_PER_TASK}. If a task needs more, split it into another task in the same stage or another stage.
3. A stage groups a coherent phase. Keep a stage small (normally 1-3 tasks, at most ${MAX_TASKS_PER_STAGE}); stages run in array order.
4. One edit has one main address. Use "related" only for an atomic same-file type/representation migration; cross-file work is separate edits.
5. A create edit must carry the complete declaration body and declare exactly the target. Put helper declarations in their own create edits, then add the caller.
6. Use action "rename" with "renameTo" when the declaration name changes; cross-file callers need their own edits.
7. Name the smallest declaration that must change; never paste a whole file into an instruction. Instructions are self-contained because the executor does not see the requirement or tests.
8. Do not target *.test.ts unless the requirement explicitly changes tests; copy required behavior into the instruction.
9. Order expresses dependency: an edit sees the results of earlier edits, tasks see earlier tasks, and stages see earlier stages. Do not rely on later work.
10. The final task must verify "test". If the requirement is too large or not expressible, stop and say why.`;

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
    "Address one symbol-index entry per edit; a symbol that the index does not list is not a target unless the edit creates it.",
    "",
  ].join("\n");
}

/** The first planning turn: requirement, symbol index, spec files. */
export function buildTaskPlanningUserPrompt(
  requirement: string,
  indexText: string,
  specFiles: readonly SourceFile[] = [],
): string {
  const prompt = `# Requirement\n\n${requirement}\n\n# Symbol index\n\n\`\`\`text\n${indexText}\n\`\`\`\n\nReply with the complete plan tree JSON.\n`;
  return appendSpecSection(prompt, specFiles);
}

/**
 * A re-planning turn: the requirement stays in the cached prefix; this turn
 * carries the current tree, harness status, failed edits, failed task gates,
 * and (after a gate failure) the test output. It also names the delta the
 * planner must apply.
 */
export function buildTaskReplanPrompt(input: {
  state: TaskRunState;
  editFailures: ReadonlyMap<NodeId, string>;
  taskFailures: ReadonlyMap<NodeId, string>;
  /** The gate diagnostics, also rendered as a direct block. */
  gateDiagnostics?: string;
  /** Why no task is runnable, when the tree is blocked instead of failed. */
  blocked?: string;
  /** Fresh symbol index of the current workspace, after edits. */
  symbolIndex?: string;
  /** Explanation of what the planner may change in this reply. */
  delta: string;
}): string {
  const blocks = [
    "# Plan tree",
    "",
    renderTaskTree(input.state.stages),
    "",
    "# Status",
    "",
    renderTaskStatus(input.state),
  ];
  const failedEdits = renderFailedEdits(input.state, input.editFailures);
  if (failedEdits !== "") {
    blocks.push("", "# Failed edits and diagnostics", "", failedEdits);
  }
  const failedTasks = renderFailedTaskGates(input.state, input.taskFailures);
  if (failedTasks !== "") {
    blocks.push("", "# Failed task gates and diagnostics", "", failedTasks);
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
    "Reply with the complete plan tree JSON, including every existing stage, task, and edit.",
  );
  return blocks.join("\n");
}

/**
 * The first-plan correction: a protocol/tree error, then the same ask. The
 * illustrative plan is appended only here, when the model has already failed
 * the shape once; the initial prompt stays lean.
 */
export function buildTaskPlanRetryPrompt(diagnostics: string, help = true): string {
  const example = help
    ? `\n\nExample of a valid multi-stage plan:\n\n${TASK_PLAN_COMPLEX_EXAMPLE}`
    : "";
  return `The previous plan was rejected.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`${example}

Reply with the complete, corrected plan tree JSON only.`;
}

const TASK_ACTION_RULES: Record<string, string> = {
  modify:
    "The declaration must already exist. Reply with one or more edit clauses that change it; a reply that writes nothing is rejected.",
  create:
    "The declaration must be absent. Reply with a whole-declaration `select … replace with <fence> end` clause carrying no `match` or `pick`; the fence must contain exactly one top-level declaration, the target. Any other body is wrapped by the edit's symbol space (value -> `let`, type -> `type`, namespace -> `namespace`).",
  delete:
    "Reply with a whole-declaration clause with an empty fence (no `match`, no `pick`) to remove the declaration. Deleting a whole file is not an edit action.",
  rename:
    "Reply with `select … rename <current> to <newName> end`; the harness rewrites the declaration name and its same-file references and refuses a colliding name.",
};

/** The bounded self-check offer on an edit turn's repair prompt. */
export const TASK_SELF_CHECK_OFFER =
  'You may make at most one bounded self-check read per edit: reply with exactly {"request":"read"} to see the current source again; the harness returns it, then asks again.';

/**
 * The execution instruction. It teaches the same clause grammar as the edit
 * driver, but the target is already selected, so it omits the select-first
 * workflow and the raw file commands the executor rejects.
 */
export function taskEditDslInstruction(): string {
  return [
    "A reply is one or more `select … end` clauses; no prose, no JSON edit payload. The edit's target is already selected: edit it directly (a bare viewer only locates a match).",
    "",
    "Clause: `select <symbol> in <path> [ resolve <value|type|namespace> ] [ match (<snippet> | /regex/) ] [ [ pick <range> ] replace with <fence> | rename <old> to <new> ] end`.",
    "`match` locates a span inside the declaration; `pick` narrows a match and requires `replace`; omit `match` to rewrite the whole declaration; an empty fence deletes it. The fence opens with 5+ hyphens (for example `-----`) or 6+ backticks and closes with the same run. `pick` coordinates are the 1-based file-absolute lines of the content view.",
    "",
    "You do not run the type check; the harness runs the task gate after every edit in the task settles. An edit may also change the same-file declarations listed in its `related` field.",
  ].join("\n");
}

/** One action-specific example, injected only after a format rejection. */
export function taskEditDslHelp(action: EditNode["action"]): string {
  const examples: Record<EditNode["action"], string> = {
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

/** The execution system prompt: the editing grammar, stable for the whole tree. */
export function buildTaskExecutionSystemPrompt(): string {
  return [
    TASK_EXECUTION_ROLE,
    "",
    'The current source of the edit target is included below. Reply with ONLY the edit clauses that carry the edit out — no prose, no JSON edit payload. After a rejected edit the one JSON exception is the bounded self-check read {"request":"read"}; the harness returns the source, then asks again. The task gate runs after every edit in the task settles; land this edit and stop.',
    "",
    "The stage goal and task instruction define the local design. Prefer small single-purpose functions and a thin caller; do not inline unrelated work into this edit.",
    "",
    "Reply shape: `select <symbol> in <path> [ resolve <value|type|namespace> ] [ match (<snippet> | /regex/) ] [ [ pick <range> ] replace with <fence> | rename <old> to <new> ] end`. A bare clause with no `replace` or `rename` is a read-only viewer.",
    "",
    taskEditDslInstruction(),
    "",
  ].join("\n");
}

export interface TaskTurnInput {
  state: TaskRunState;
  stage: Stage;
  task: TaskNode;
  edit: EditNode;
  /** Numbered, file-absolute source view for the current target (or the file). */
  contentView: string;
  /** First line number of `contentView`'s first line (1 for a whole file). */
  startLine?: number;
  /** Diagnostics from the previous rejected/failed exchange, or the opening state. */
  diagnostics?: string;
  /** Stage/task coordination context (for example an earlier failed gate). */
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
 * One execution turn: stage goal, task goal, the current micro edit, and the
 * content view last (the volatile tail). The tree structure is in the
 * execution system prompt once; repeating it here would invalidate the
 * cache-stable prefix on every turn.
 */
export function buildTaskTurnPrompt(input: TaskTurnInput): string {
  const { stage, task, edit } = input;
  const taskStatus = input.state.taskStatus.get(task.id) ?? "pending";
  const editStatus = input.state.editStatus.get(edit.id) ?? "todo";
  const action =
    edit.action === "rename" ? `rename to ${JSON.stringify(edit.renameTo)}` : edit.action;
  const blocks = [
    "# Stage",
    "",
    `#${stage.id} — ${stage.goal}`,
    "",
    "# Task",
    "",
    `#${task.id} (verify ${task.verify}) — ${taskStatus}`,
    "",
    `Task goal: ${task.instruction}`,
    "",
    "# Micro edit",
    "",
    `#${edit.id} (${action}) — ${editStatus}`,
    "",
    `Target: ${formatTaskLoc(edit.loc)}`,
    ...(edit.related === undefined || edit.related.length === 0
      ? []
      : [
          "",
          `Related targets (same migration): ${edit.related
            .map((loc) => formatTaskLoc(loc))
            .join(", ")}`,
        ]),
    "",
    `Instruction: ${edit.instruction}`,
    "",
    TASK_ACTION_RULES[edit.action] ?? "",
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
    blocks.push("", "# Format help", "", taskEditDslHelp(edit.action));
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
    "Reply with the edit clauses for this micro edit. The task gate runs after every edit in the task settles.",
  );
  return blocks.join("\n");
}

/** Render a declaration (or file) region for the content view. */
export function renderTaskContentView(source: string, startLine = 1): string {
  return numberedView(source, startLine);
}

/** The planner's re-plan delta sentence for the common causes. */
export function replanDelta(input: {
  failedEditIds: readonly NodeId[];
  failedTaskIds: readonly NodeId[];
  blocked: boolean;
}): string {
  const rules = [
    "Keep every passed task and done edit exactly as it is, and keep the ids of nodes you keep.",
    "A failed edit may be retried by changing its definition. A failed task reopens when you change it or add repair edits; a passed task is immutable.",
    "Repair in place first: change the failed edit/task or append a small repair edit to the same task. A fully passed task or stage is closed, so put later work in a new task or stage.",
    "New tasks append to their stage; new stages append after existing stages; new edits append to their task. New ids must be unused.",
    "Array order is execution order. There are no deps, todo, or status fields; do not add them.",
    "Every task must be able to pass its own gate. The final task must verify test.",
    "Prefer a small helper function and a thin caller over a large rewrite; keep tasks small enough to verify.",
  ];
  const lead =
    input.failedEditIds.length > 0
      ? `The edit(s) ${input.failedEditIds.map((id) => `#${id}`).join(", ")} could not be carried out. Fix the cause with a changed definition or a smaller follow-up edit.`
      : input.failedTaskIds.length > 0
        ? `The task gate(s) ${input.failedTaskIds.map((id) => `#${id}`).join(", ")} failed after their edits settled. Add repair edits to that task (it reopens), or add a later task/stage; the final task must still verify test.`
        : input.blocked
          ? "No task is runnable. Repair the tree so the remaining work becomes runnable, or remove work that is not needed."
          : "Continue the plan.";
  return [lead, "", ...rules.map((rule) => `- ${rule}`)].join("\n");
}
