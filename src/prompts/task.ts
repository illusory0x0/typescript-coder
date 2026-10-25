/**
 * Planning and execution prompts for the plan/execute loop (`docs/spec.md`).
 *
 * Planning context (stability-descending): role -> requirement + symbol index
 * -> (re-plan only) tree, status, and diagnostics.
 *
 * Execution context: role + edit-action grammar (stable for the tree) -> the
 * execution turn (stage, task, current edit, diagnostics, numbered view).
 *
 * The planner emits one current Stage and Task as the flat Plan DSL, then one
 * patch per later planning turn. A task is the verification boundary; an edit
 * is one declaration action. Record order is execution order, and the harness
 * owns status.
 */

import type { EditNode, NodeId, Stage, TaskNode, TaskRunState, TaskVerify } from "../tasks";
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
export const MAX_TASK_PLAN_ROUNDS = 32;

export const TASK_PLANNING_ROLE =
  "You are a senior software engineer planning a TypeScript change. You decompose one requirement into a Plan -> Stage -> Task -> edit tree; a separate coding expert then executes the edits one at a time. You do not write code and you do not run commands.";

export const TASK_EXECUTION_ROLE =
  "You are a TypeScript coding expert. You receive one micro edit at a time from a Stage -> Task -> edit tree and carry it out with precise edit clauses. The task instruction is the local goal; the planner owns the tree.";

/**
 * The functional style shared by the planner and executor prompts
 * (`docs/spec.md` §1.2). Keep this literal identical to the spec block.
 */
export const TASK_FUNCTIONAL_STYLE = `Prefer ML-style functional TypeScript:
- Data + functions over classes and prototypes.
- Model data with type aliases, tagged unions (string-literal tag), tuples, and plain records.
- Implement behavior as top-level functions with explicit parameter and return types.
- Extract small helpers when they make the code clearer; do not force a stage/task split.
- Do not create new classes, inheritance, \`super\`, implicit \`this\`, private state, getters/setters, or class-based state machines.
- If an existing class must change, modify it minimally; never create a dotted member with \`create\`.`;

/** The canonical minimal plan example, shown to the planner. */
export const TASK_PLAN_EXAMPLE = `plan "01-main"
goal: Make the failing test pass.

stage "02-current" plan "01-main"
goal: Fix the answer behavior.
end

task "03-first" stage "02-current" verify test
instruction: Make the failing test green.
end

edit "04-change" task "03-first" modify value answer in src/helper.ts
instruction: Change answer to return 2.
end`;

/**
 * A richer initial Plan example: one current Stage/Task with a same-file
 * related migration and a cross-file follow-up edit. The initial turn never
 * pre-plans future tasks.
 */
export const TASK_PLAN_COMPLEX_EXAMPLE = `plan "01-main"
goal: Migrate the Formatter shape without breaking its callers.

stage "02-current" plan "01-main"
goal: Migrate the Formatter shape without breaking its callers.
end

task "03-task-shape" stage "02-current" verify test
instruction: Make Formatter and its direct formatting helper agree.
end

edit "04-edit-shape" task "03-task-shape" modify type Formatter in src/format.ts
related value formatNumber in src/format.ts
instruction: Change the Formatter shape and update formatNumber atomically.
end

edit "05-edit-print-total" task "03-task-shape" modify value printTotal in src/report.ts
instruction: Make printTotal use the new Formatter shape.
end`;

/**
 * The canonical next-Task patch (`docs/spec.md` §3.2): one new Task and its
 * edits, appended to the current stage.
 */
export const TASK_PATCH_EXAMPLE = `patch
task+ "05-next" stage "02-current" verify tsc
instruction: Add the next helper and wire it in.
end
edit+ "06-helper" task "05-next" create value parseLiteral in src/helper.ts
instruction: Add a small top-level helper; no class.
end`;

/**
 * A next-Stage patch with the new Stage's first Task and the final test
 * (`docs/spec.md` §3.3).
 */
export const TASK_PATCH_FINAL_EXAMPLE = `patch
stage+ "07-next" plan "01-main"
goal: Finish the remaining behavior.
end
task+ "08-final" stage "07-next" verify test
instruction: Run the full behavior and keep the suite green.
end
edit+ "09-final" task "08-final" modify value parseJson in src/helper.ts
instruction: Wire the final entry point; no new class.
end
finish`;

const TASK_PLAN_FIELDS = `- The initial reply is the flat Plan DSL. Start with the singleton header \`plan "<id>"\`, then a \`goal:\` label. The Plan header has no \`end\`.
- A stage record is \`stage "<id>" plan "<plan-id>"\`, then \`goal:\` and \`end\`. The Plan goal and stage goal are planning context for the executor; the initial Plan has exactly one current Stage.
- A task record is \`task "<id>" stage "<stage-id>" verify tsc|test\`, then \`instruction:\` and \`end\`. A task is a verification boundary: its gate runs after every edit in it settles, so plan the whole task so that gate passes. The initial Plan has exactly one current Task in that Stage; later Tasks are patches.
- An edit record is \`edit "<id>" task "<task-id>" <modify|create|delete|rename> <value|type|namespace> <symbol> in <path>\`, optional \`related <space> <symbol> in <path>\` lines (modify only), optional \`renameTo: <symbol>\` (rename only), then \`instruction:\` and \`end\`. A task has 1-${MAX_EDITS_PER_TASK} edits.
- Every id is a quoted "NN-slug": two or more digits, a hyphen, then lowercase kebab words (for example "01-main"). Ids are globally unique across the Plan, stages, tasks, and edits. Record order is execution order. There are no deps, todo, or status fields; the harness owns status.
- All stage records come before all task records, and all task records come before all edit records. A parent ref must point at an earlier record: a stage's \`plan\`, a task's \`stage\`, an edit's \`task\`.
- \`goal:\` and \`instruction:\` carry one-line text after the label, or an empty label followed by a fence: 5+ hyphens (for example \`-----\`) or 6+ backticks on its own line, the raw text lines, then the same fence. A stage, task, or edit record ends with \`end\`.
- A trailing \`finish\` line marks the last task final. It is valid only as the last line, and only when that task verifies \`test\`. Only the task marked by \`finish\` must verify \`test\`; a work-in-progress tree may end in a \`tsc\` task.`;

const TASK_PLAN_RULES = `Rules:
1. Write like a normal TypeScript engineer: small named functions with one job, helpers extracted and called by a thin orchestrator. Do not put a large multi-step algorithm into one declaration or one create edit.
2. Plan each task to pass its own gate. Normally 2-4 edits per task; never more than ${MAX_EDITS_PER_TASK}. If a task needs more, split it into another task in the same stage or another stage.
3. A stage groups a coherent phase. Keep a stage small (normally 1-3 tasks, at most ${MAX_TASKS_PER_STAGE}); stage, task, and edit record order is execution order.
4. One edit has one main address. Use \`related\` only for an atomic same-file type/representation migration; cross-file work is separate edits.
5. A create edit must carry the complete declaration body and declare exactly the target. It adds a top-level declaration only; a dotted class member is never a create target. Put helper declarations in their own create edits, then add the caller.
6. Use action \`rename\` with \`renameTo\` when the declaration name changes; cross-file callers need their own edits.
7. Name the smallest declaration that must change; never paste a whole file into an instruction. Instructions are self-contained because the executor does not see the requirement or tests.
8. Do not target *.test.ts unless the requirement explicitly changes tests; copy required behavior into the instruction.
9. Record order expresses dependency: an edit sees the results of earlier edits, tasks see earlier tasks, and stages see earlier stages. Do not rely on later work.
10. End the run with a \`test\` task and a trailing \`finish\`. If that test is already the current last task and has passed, a bare \`patch\` + \`finish\` is enough.
11. Never plan a new class: prefer a top-level helper. If an existing class must grow, plan one whole-class \`modify\` that adds all needed stubs, then \`modify\` the existing members. Never plan a dotted \`create\`.
12. Emit only the Plan DSL records on the initial turn: no JSON, no markdown fence around the whole reply, and no prose.`;

const TASK_PATCH_FIELDS = `Patch records (every later planning turn replies with exactly one patch, never a complete Plan):
- Start with the singleton header \`patch\`. Every operation ends with \`end\`; a trailing \`finish\` may follow the last operation. The patch header has no \`end\`.
- \`plan~ "<id>"\`, then \`goal:\` and \`end\`, replaces the Plan goal; the id must match the current Plan.
- \`stage+ "<id>" plan "<plan-id>"\`, then \`goal:\` and \`end\`, appends a Stage. A new Stage must include its first Task in the same patch.
- \`stage~ "<id>"\`, optional \`goal:\`, then \`end\` updates a Stage; \`stage- "<id>"\` + \`end\` removes a pending/failed Stage.
- \`task+ "<id>" stage "<stage-id>" verify tsc|test\`, then \`instruction:\` and \`end\`, appends one Task. A patch adds at most one new Task.
- \`task~ "<id>"\`, optional \`verify\`, optional \`instruction:\`, then \`end\` changes a Task (a changed failed Task reopens); \`task- "<id>"\` + \`end\` removes pending/failed work.
- \`edit+ "<id>" task "<task-id>" <action> <space> <symbol> in <path>\`, optional \`related\` / \`renameTo:\`, then \`instruction:\` and \`end\` appends an Edit. \`edit~ "<id>"\` updates present fields; \`edit- "<id>"\` + \`end\` removes pending/failed work.
- \`finish\` as the last line marks the current last Task final; it must verify \`test\`. Adding work after the old final Task requires a new \`finish\` on the new last test Task.`;

const TASK_PATCH_RULES = `Rules for a patch turn:
1. Reply with exactly one \`patch\`. Do not re-emit the Plan or any unchanged records.
2. Add at most one new Task. Adding a new Stage includes its first Task in the same turn; a Plan has at most ${MAX_STAGES} Stages.
3. A new Stage is allowed only when the current Stage has no pending Task. A fully passed Stage cannot take a new Task; use a new Stage. A failed Stage may take a repair Task.
4. Repair a failed Task in place first: change it (\`task~\`) and/or change or append a small repair edit (\`edit~\`, \`edit+\`). A failed edit retries only with a changed definition.
5. Never change a passed Task or a done Edit, and keep the ids of nodes you keep.
6. If the last Task is a passing test Task and no work remains, emit \`patch\` + \`finish\`. Otherwise plan the next Task, or one new Stage with its first Task. To finish with new work, plan one final \`test\` Task and emit \`finish\`.
7. A patch may update/remove existing pending or failed work, but it must not introduce a future Task list.
8. New ids must be unused. Record order is execution order.`;

export function buildTaskPlanningSystemPrompt(): string {
  return [
    TASK_PLANNING_ROLE,
    "",
    TASK_FUNCTIONAL_STYLE,
    "",
    "The first reply is ONLY the initial Plan DSL: exactly one current Stage and one current Task. Every later planning turn replies with exactly one patch; never re-emit the Plan.",
    "",
    TASK_PLAN_EXAMPLE,
    "",
    TASK_PATCH_EXAMPLE,
    "",
    TASK_PATCH_FINAL_EXAMPLE,
    "",
    TASK_PLAN_FIELDS,
    "",
    TASK_PLAN_RULES,
    "",
    TASK_PATCH_FIELDS,
    "",
    TASK_PATCH_RULES,
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
  const prompt = `# Requirement\n\n${requirement}\n\n# Symbol index\n\n\`\`\`text\n${indexText}\n\`\`\`\n\nReply with the initial Plan DSL: exactly one current Stage and one current Task, with that Task's edits.\n`;
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
    "Reply with exactly one `patch` in the patch DSL, not a complete Plan. Add at most one new Task and at most one new Stage; a new Stage includes its first Task.",
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
    ? `\n\nExample of a valid initial Plan DSL (one current Stage and one current Task):\n\n${TASK_PLAN_COMPLEX_EXAMPLE}`
    : "";
  return `The previous plan was rejected.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`${example}

Reply with the complete, corrected initial Plan DSL only: exactly one current Stage and one current Task.`;
}

/**
 * The patch correction: a rejected patch keeps the planning turn alive, and
 * the reply must still be one patch rather than a re-emitted Plan. The patch
 * example is appended only when the reply shape has already failed once.
 */
export function buildTaskPatchRetryPrompt(diagnostics: string, help = true): string {
  const example = help ? `\n\nExample of a valid patch:\n\n${TASK_PATCH_EXAMPLE}` : "";
  return `The previous patch was rejected.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`${example}

Reply with exactly one corrected patch only. Do not re-emit the Plan.`;
}

const TASK_ACTION_RULES: Record<string, string> = {
  modify:
    "The declaration must already exist. Reply with one or more edit clauses that change it; a reply that writes nothing is rejected.",
  create:
    "The declaration must be absent. create adds a top-level declaration only: never target a dotted class member (for example Parser.parseValue); prefer a top-level function, or add stubs with one whole-class `modify` and then modify the existing member. Reply with a whole-declaration `select … replace with <fence> end` clause carrying no `match` or `pick`; the fence must contain exactly one top-level declaration, the target. Any other body is wrapped by the edit's symbol space (value -> `let`, type -> `type`, namespace -> `namespace`).",
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
    TASK_FUNCTIONAL_STYLE,
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

/**
 * The post-execution review turn (#32). It is deliberately short: the planner
 * already has the Plan and requirement in the cached prefix, so this turn only
 * adds the gate verdict, the current Task, and the applied diff. Full files are
 * never repeated; the diff carries 2-3 lines of context around each change.
 */
export interface TaskReviewInput {
  stage: Stage;
  task: TaskNode;
  gate: {
    /** Gate kind; defaults to the Task's own verify when omitted. */
    verify?: TaskVerify;
    ok: boolean;
    diagnostics: string | null;
  };
  /** Concise applied diff from the Task's cached base to the current files. */
  diff: string;
}

export function buildTaskReviewPrompt(input: TaskReviewInput): string {
  const { stage, task, gate } = input;
  const verify = gate.verify ?? task.verify;
  const edits = task.edits.map(
    (edit) => `- #${edit.id} ${edit.action} ${formatTaskLoc(edit.loc)}: ${edit.instruction}`,
  );
  const blocks = ["# Review", "", `Gate: ${verify} ${gate.ok ? "passed" : "failed"}.`];
  if (gate.diagnostics !== null && gate.diagnostics.trim() !== "") {
    blocks.push("", "```", gate.diagnostics.trim(), "```");
  }
  blocks.push(
    "",
    `Stage #${stage.id} goal: ${stage.goal}`,
    `Task #${task.id} (verify ${task.verify}) — review`,
    `Instruction: ${task.instruction}`,
    "Edits:",
    ...edits,
    "",
    "# Applied diff",
    "",
    "```diff",
    input.diff.trim() === "" ? "(no applied changes)" : input.diff.trim(),
    "```",
    "",
    "Reply with exactly `approve` or one `patch`; no prose and no other format.",
    "- `approve` when this Task needs no repair: the gate passed and the applied diff matches the instruction; if the gate failed, prefer a repair patch unless the failure lies outside this Task.",
    `- A patch may only repair this Task #${task.id}: \`task~ "#${task.id}"\`, \`edit+\` on it, \`edit~\` / \`edit-\` for its edits. It may carry \`finish\` when this is the last \`test\` Task.`,
    "- Do not add a Stage or Task, do not edit another Task, and do not re-emit the Plan.",
  );
  return blocks.join("\n");
}

/** The planner's patch-delta sentence for the common causes. */
export function replanDelta(input: {
  failedEditIds: readonly NodeId[];
  failedTaskIds: readonly NodeId[];
  blocked: boolean;
}): string {
  const rules = [
    "Reply with one `patch`, not a Plan. Keep every passed task and done edit exactly as it is, and keep the ids of nodes you keep.",
    "Add at most one new Task. Adding a new Stage includes its first Task in the same turn; a new Stage is allowed only when the current Stage has no pending Task.",
    "A failed edit may be retried by changing its definition. A failed task reopens when you change it or add repair edits; a passed task is immutable.",
    "Repair a failed task in the current Stage first: change it or add a small repair edit. A fully passed Stage cannot take a new Task; use a new Stage.",
    "New tasks append to their stage; new stages append after existing stages; new edits append to their task. New ids must be unused.",
    "Record order is execution order. There are no deps, todo, or status fields; do not add them.",
    "Every task must be able to pass its own gate. To end the run, plan a final `test` task and emit `finish`; if the last task is already a passing test task, `patch` + `finish` is enough.",
    "Prefer a small helper function and a thin caller over a large rewrite; keep tasks small enough to verify.",
  ];
  const lead =
    input.failedEditIds.length > 0
      ? `The edit(s) ${input.failedEditIds.map((id) => `#${id}`).join(", ")} could not be carried out. Fix the cause with a changed definition or a smaller follow-up edit.`
      : input.failedTaskIds.length > 0
        ? `The task gate(s) ${input.failedTaskIds.map((id) => `#${id}`).join(", ")} failed after their edits settled. Repair that task in place, or add a later repair task; a final test task still needs finish.`
        : input.blocked
          ? "No task is runnable. Repair the current work, or plan the next Task/Stage (or final test + finish) so the run can continue."
          : "Continue the plan with one patch.";
  return [lead, "", ...rules.map((rule) => `- ${rule}`)].join("\n");
}
