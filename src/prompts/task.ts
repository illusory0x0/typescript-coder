/**
 * Planning, execution, and review prompts for the plan/execute loop
 * (`docs/plan-exec.md`).
 *
 * Planning context (stability-descending): role -> requirement + symbol index
 * -> (re-plan only) work graph, statuses, and diagnostics.
 *
 * Execution context: role + editing techniques + edit-action grammar (stable
 * for the node) -> the work-node turn (instruction, hints, approach, gate
 * diagnostics, source views).
 *
 * The planner emits a flat work-node DAG as the Plan DSL, then patches it. A
 * WorkNode is the verification boundary. The executor owns the concrete edit
 * actions and their granularity; hints and `approach` are advice, never a hard
 * allowlist. The harness owns scheduling, gates, review, and the final result.
 * There are no Stage/Task/Edit records and no fixed exchange, viewer, review, or
 * planning-round caps.
 */

import type { NodeId, PlanRunState, WorkNode, WorkVerify } from "../tasks";
import { formatHint, renderFailedNodes, renderNodeStatus, renderNodeTree } from "../tasks";
import type { SourceFile } from "../utility";
import { appendSpecSection, splitSourceLines } from "./shared";

export const TASK_PLANNING_ROLE =
  "You are a work-graph planner for a TypeScript change. You own the decomposition, dependency edges, verification boundaries, instructions, target hints, and optional approach/phase guidance. A separate coding expert owns the concrete edit actions and their granularity. You do not write files or run commands.";

export const TASK_EXECUTION_ROLE =
  "You are a TypeScript coding expert. You receive one work node at a time and carry it out with precise edit clauses or file commands. You own the concrete actions and their granularity: the hints and approach are advice, not a contract.";

export const TASK_PLANNING_WORKFLOW = `Workflow guidance (inspect -> contract -> scaffold -> implement -> verify):
1. Inspect the requirement, symbol index, and any source you need.
2. Settle the public contract: types, signatures, and data shapes.
3. For a large module, scaffold exported declarations and stub bodies first.
4. Implement behavior in nodes whose gates can pass meaningfully.
5. End with a final \`test\` node marked by \`finish\`.

The graph shape is yours. A single node, a linear chain, and a branching DAG are all valid; do not force a fixed workflow.`;

export const TASK_PLANNER_VIEW = `Read-only inspection:
Before a Plan or patch, you may reply with one or more read-only viewer requests:

select [kind] <symbol> in <path> [resolve value|type|namespace] [within <selecters>] end
read <path> [within <selecters>] end

A viewer writes nothing. A declaration viewer shows an indentation-folded
outline; add \`within <start>-<end>\` for an exact slice. \`read\` returns a file
outline, or an exact slice with \`within\`. Ranges are 1-based, inclusive, and
file-absolute. Each viewer consumes the run token budget; a repeated identical
view or a no-progress cycle forces the Plan/patch reply. Never use \`replace\`,
\`rename\`, \`write\`, \`create\`, or \`delete\` in a planner viewer.`;

/**
 * The functional style shared by the planner and executor prompts
 * (`docs/plan-exec.md` §1.3). Keep this literal identical to the plan-exec block.
 */
export const TASK_FUNCTIONAL_STYLE = `Prefer ML-style functional TypeScript:
- Data + functions over classes and prototypes.
- Model data with type aliases, tagged unions (string-literal tag), tuples, and plain records.
- Implement behavior as top-level functions with explicit parameter and return types.
- Extract small helpers when they make the code clearer; do not force an extra work node.
- Do not create new classes, inheritance, \`super\`, implicit \`this\`, private state, getters/setters, or class-based state machines.
- If an existing class must change, modify it minimally; never create a dotted member with \`create\`.`;

/**
 * Advisory editing techniques. The executor may choose, combine, or ignore
 * these from the current source; they are never a gate.
 */
export const TASK_EDITING_TECHNIQUES = `Editing techniques (advice, not rules; compose or ignore them from the source):
1. Small requirement on a small file -> one whole-file \`write\` is often the cheapest correct change.
2. Large module -> scaffold the exported types, signatures, and stub bodies first, then fill bodies with targeted edits.
3. Complex refactor -> introduce a parallel \`xxV1\` implementation, copy the existing behavior, test it, switch the call sites, then remove the old path.
Later techniques can be added; no technique is a gate.`;

const TASK_PLAN_EXAMPLE = `plan "01-main"
goal: Make the failing test pass.

node "02-answer" verify test
instruction: Make the failing test green.
hint value answer in src/helper.ts
approach: The file and requirement are small; one whole-file write is often cheapest.
end

finish`;

const TASK_SCAFFOLD_PLAN_EXAMPLE = `plan "01-main"
goal: Implement the workbook module.

node "02-contract" verify tsc
instruction: Create a compiling skeleton for src/workbook.ts with the exported types, signatures, and stub bodies.
hint file src/workbook.ts
approach: Scaffold the top-level declarations first; fill bodies with later targeted edits.
phase: scaffold
end

node "03-impl" after "02-contract" verify test
instruction: Implement evaluate and keep the suite green.
hint value evaluate in src/workbook.ts
hint type CellResult in src/workbook.ts
phase: implement
end

finish`;

const TASK_PLAN_BRANCHING_EXAMPLE = `plan "01-main"
goal: Add the parser and its formatter.

node "02-parser" verify tsc
instruction: Implement the parser functions and stub the formatter entry point.
hint value parseValue in src/parser.ts
end

node "03-format" verify tsc
instruction: Implement the formatter functions.
hint value formatValue in src/format.ts
end

node "04-final" after "02-parser" "03-format" verify test
instruction: Wire the entry point and keep the suite green.
hint value parseFile in src/parser.ts
end

finish`;

const TASK_PATCH_EXAMPLE = `patch
node+ "05-repair" after "03-impl" verify tsc
instruction: Repair the return path the last gate reported.
hint value parseValue in src/parser.ts
end`;

const TASK_PATCH_FINAL_EXAMPLE = `patch
node+ "06-final" after "03-impl" verify test
instruction: Wire the final entry point and keep the suite green.
hint value parseFile in src/parser.ts
end
finish`;

const TASK_PLAN_FIELDS = `- The initial reply is the flat Plan DSL. Start with the singleton header \`plan "<id>"\`, then a \`goal:\` label. The Plan header has no \`end\`.
- A work node is \`node "<id>" [after "<id>"…] verify tsc|test\`, then \`instruction:\`, optional \`hint\` lines, optional \`approach:\`, optional \`phase:\`, then \`end\`.
- \`after\` lists dependency node ids; the executor runs only nodes whose dependencies passed. A node may depend on a node declared later in the same reply as long as the graph stays acyclic. Record order is the deterministic readiness tie-break.
- \`verify\` is the node gate: \`tsc\` runs the type check, \`test\` runs the type check and the test suite after each applied executor reply.
- \`instruction:\` is a self-contained local goal for the executor; it does not see the requirement. Do not paste a whole file into an instruction.
- \`hint file <path>\` marks a whole-file target; \`hint <value|type|namespace> <symbol> in <path>\` marks a declaration. Hints are advisory guidance, not an allowlist.
- \`approach:\` is optional advisory strategy. \`phase:\` is an optional workflow label such as \`scaffold\` or \`implement\`; it never changes scheduling.
- Every id is a quoted "NN-slug": two or more digits, a hyphen, then lowercase kebab words (for example "01-main"). Plan and node ids share one namespace and are globally unique.
- \`goal:\`, \`instruction:\`, \`approach:\`, and \`phase:\` carry one-line text after the label, or an empty label followed by \`<<<TC_EDIT_BEGIN>>>\` on its own line, the raw text lines, then \`<<<TC_EDIT_END>>>\` on its own line. The body is raw: hyphen runs, backticks, \`done\`, and \`end\` are ordinary text lines. A node record ends with \`end\`.
- A trailing \`finish\` line marks the last node final. It is valid only as the last line, and only when that node verifies \`test\`. A plan without \`finish\` may end in a \`tsc\` node, but the run cannot succeed until a final \`test\` node is marked and passes.`;

const TASK_PLAN_RULES = `Rules:
1. Choose the smallest graph that keeps each gate meaningful. One node is valid when its change is cohesive; a large greenfield module needs a compiling scaffold node before behavior is filled in.
2. Use \`after\` only for a real prerequisite. Independent work may be ready at the same time; do not invent edges to force a favorite order.
3. Prefer top-level functions with explicit types. Extract a helper when it makes the code easier to read; keep the caller thin.
4. Hints identify likely targets, not every file the instruction may touch. The executor may edit outside them when the instruction requires it; review sees those edits.
5. \`approach\` may recommend a whole-file write for a small change, scaffold-then-fill for a large module, or a parallel implementation for a risky refactor. Never make a technique mandatory.
6. A \`create\` adds one top-level declaration. A dotted class member is not a create target; modify the class instead.
7. Do not target *.test.ts unless the requirement explicitly changes tests; copy required behavior into the instruction.
8. End the run with a \`test\` node and a trailing \`finish\`. If the current last test node has passed, a bare \`patch\` + \`finish\` is enough.
9. Do not plan a new class. If an existing class must change, modify it; never plan a dotted \`create\`.
10. Emit only the Plan DSL records on a planning turn: no JSON, no markdown fence around the whole reply, and no prose. A read-only viewer request is the only non-Plan reply accepted before a Plan/patch.
11. There is no node-count, planning-round, viewer, or exchange cap. Growth is bounded by the token budget and repeated/no-progress detection.`;

const TASK_PATCH_FIELDS = `Patch records (a later planning turn replies with one patch, not a complete Plan):
- Start with the singleton header \`patch\`. Every operation ends with \`end\`; a trailing \`finish\` may follow the last operation. The patch header has no \`end\`.
- \`node+ "<id>" [after "<id>"…] verify tsc|test\`, then \`instruction:\` and optional fields, appends one node. A patch may add any number of nodes.
- \`node~ "<id>"\`, optional \`after\`, \`verify\`, \`instruction:\`, \`hint\` lines or \`hint clear\`, \`approach:\` or \`approach clear\`, \`phase:\` or \`phase clear\`, then \`end\` changes a node. A changed failed or review node reopens.
- \`node- "<id>"\` + \`end\` removes a pending or failed node.
- \`finish\` as the last line marks the current last node final; it must verify \`test\`. Adding work after the old final node requires a new \`finish\` on the new last test node.`;

const TASK_PATCH_RULES = `Rules for a patch turn:
1. Reply with exactly one \`patch\`. Do not re-emit the Plan or unchanged records.
2. Add any number of nodes in one patch when the graph needs them; do not artificially serialize independent work.
3. Prefer repairing a failed node in place (\`node~\`) or appending a targeted repair node. A passed node is immutable; a node in review reopens only when its definition changes.
4. If an executor repeatedly cannot land work, narrow the instruction or hints, split the work, or change the approach. Prefer a targeted repair after a failed large write; do not hard-reject a strategy.
5. Keep the ids of nodes you keep. New ids must be unused. Existing nodes keep their record order; new nodes append.
6. If the last node is a passing test node and no work remains, emit \`patch\` + \`finish\`. Otherwise plan the remaining work (or one final \`test\` node) and emit \`finish\` when the graph is complete.
7. There is no per-turn node cap and no planning-round cap. Stop planning and act; the token budget and repeated/no-progress detection bound the run.`;

export function buildTaskPlanningSystemPrompt(): string {
  return [
    TASK_PLANNING_ROLE,
    "",
    TASK_FUNCTIONAL_STYLE,
    "",
    TASK_PLANNING_WORKFLOW,
    "",
    TASK_PLANNER_VIEW,
    "",
    "Minimal initial Plan:",
    "",
    TASK_PLAN_EXAMPLE,
    "",
    "Scaffold-then-implement example:",
    "",
    TASK_SCAFFOLD_PLAN_EXAMPLE,
    "",
    "Branching DAG example:",
    "",
    TASK_PLAN_BRANCHING_EXAMPLE,
    "",
    "Repair patch example:",
    "",
    TASK_PATCH_EXAMPLE,
    "",
    "Final test patch example:",
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
  ].join("\n");
}

/** The first planning turn: requirement, symbol index, spec files. */
export function buildTaskPlanningUserPrompt(
  requirement: string,
  indexText: string,
  specFiles: readonly SourceFile[] = [],
): string {
  const prompt = `# Requirement\n\n${requirement}\n\n# Symbol index\n\n\`\`\`text\n${indexText}\n\`\`\`\n\nReply with the initial Plan DSL: a \`plan\` header, one or more \`node\` records, and a trailing \`finish\` when the graph is complete. You may inspect with read-only viewers first.\n`;
  return appendSpecSection(prompt, specFiles);
}

export interface TaskReplanInput {
  state: PlanRunState;
  /** Failed node diagnostics, keyed by node id. */
  nodeFailures: ReadonlyMap<NodeId, string>;
  /** Why no node is runnable, when the graph is blocked instead of failed. */
  blocked?: string;
  /** Fresh symbol index of the current workspace, after edits. */
  symbolIndex?: string;
}

/**
 * A re-planning turn: the requirement stays in the cached prefix; this turn
 * carries the current graph, harness status, failed nodes, and the fresh symbol
 * index. It may add any number of nodes, update/remove pending or failed work,
 * or finish the graph.
 */
export function buildTaskReplanPrompt(input: TaskReplanInput): string {
  const blocks = [
    "# Work graph",
    "",
    renderNodeTree(input.state),
    "",
    "# Status",
    "",
    renderNodeStatus(input.state),
  ];
  const finalId = input.state.finalNodeId;
  blocks.push("", `Final node: ${finalId === null ? "(not marked)" : `#${finalId}`}`);
  const failed = renderFailedNodes(input.state, input.nodeFailures);
  if (failed !== "") {
    blocks.push("", "# Failed nodes and diagnostics", "", failed);
  }
  if (input.blocked !== undefined && input.blocked.trim() !== "") {
    blocks.push("", "# Blocked", "", input.blocked);
  }
  if (input.symbolIndex !== undefined && input.symbolIndex.trim() !== "") {
    blocks.push("", "# Current symbol index", "", "```text", input.symbolIndex.trim(), "```");
  }
  blocks.push(
    "",
    "# Amend the graph",
    "",
    "Reply with exactly one `patch`, not a complete Plan. Add any number of ready nodes; update or remove pending/failed nodes; keep passed nodes and their ids unchanged. If the last node is a passing test node, `patch` + `finish` is enough. Use the token budget and progress, not a fixed node count.",
  );
  return blocks.join("\n");
}

/**
 * The first-plan correction: a protocol/graph error, then the same ask. The
 * illustrative plan is appended only when the reply shape has already failed.
 */
export function buildTaskPlanRetryPrompt(diagnostics: string, help = true): string {
  const example = help ? `\n\nExample of a valid initial Plan DSL:\n\n${TASK_PLAN_EXAMPLE}` : "";
  return `The previous plan was rejected.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`

Correct the graph:
- Keep one \`plan\` header with a \`goal:\`.
- Emit flat \`node\` records with \`after\`, \`verify\`, \`instruction\`, and optional hints/approach/phase.
- End each node with \`end\`.
- Mark the last \`test\` node with a trailing \`finish\` when the graph is complete.${example}

Reply with the complete, corrected initial Plan DSL only.`;
}

/** The patch correction: a rejected patch keeps the planning turn alive. */
export function buildTaskPatchRetryPrompt(diagnostics: string, help = true): string {
  const example = help ? `\n\nExample of a valid patch:\n\n${TASK_PATCH_EXAMPLE}` : "";
  return `The previous patch was rejected.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`

Reply with exactly one corrected \`patch\` only. Do not re-emit the Plan. Add any number of nodes; update or remove pending/failed work; keep passed nodes and their ids unchanged.${example}`;
}

/**
 * The execution instruction. It teaches the same clause grammar as the
 * edit-action driver, but the executor owns the target, action, and granularity.
 */
export function taskEditDslInstruction(): string {
  return [
    "A declaration edit is one or more `select … end` clauses; file commands are `create`, `delete`, `read`, and `write <path> with <fence>`. No prose, no JSON.",
    "",
    "Every clause in one reply must resolve to a different declaration `(path, symbol, kind)`; target one declaration at most once per reply, even with different `match` or `pick` spans, and split edits to one declaration across replies.",
    "",
    "Clause: `select <symbol> in <path> [ resolve <value|type|namespace> ] [ match (<snippet> | /regex/) ] [ [ pick <range> ] replace with <fence> | rename <old> to <new> ] end`.",
    "`match` accepts only a backtick snippet or `/regex/`; `match (` and unquoted code are rejected. A snippet must be a complete statement or expression, or a contiguous run of complete statements copied from the target, never an unbalanced partial function body; if the span is hard to copy, omit `match` and rewrite the whole declaration. It locates a span inside the declaration; `pick` narrows a match and requires `replace`; omit `match` to rewrite the whole declaration; an empty body deletes it. Open the body with `<<<TC_EDIT_BEGIN>>>` on its own line and close it with `<<<TC_EDIT_END>>>` on its own line; the body is raw text (hyphen runs, backticks, `done`, and `end` are ordinary body lines). `pick` coordinates are the 1-based file-absolute lines of the content view.",
    "For a whole-file edit, `write <path> with <<<TC_EDIT_BEGIN>>> … <<<TC_EDIT_END>>>` replaces the file with the raw body; no terminator follows the sentinel close. `create <path> end` adds an empty file, `delete <path> end` removes one, and `read <path> [within <range>] end` only returns source.",
    "",
    "You do not run the type check; the harness runs the node gate after every applied reply. Hints and `approach` are advice: edit outside the hinted paths when the instruction requires it, and choose the action and granularity that fit the source.",
  ].join("\n");
}

/** The execution system prompt: the editing grammar and techniques, stable per node. */
export function buildTaskExecutionSystemPrompt(): string {
  return [
    TASK_EXECUTION_ROLE,
    "",
    TASK_FUNCTIONAL_STYLE,
    "",
    TASK_EDITING_TECHNIQUES,
    "",
    taskEditDslInstruction(),
    "",
    "Reply with only the clauses that carry the node out; no prose and no JSON. The harness runs the node gate after every applied reply. There is no fixed attempt limit: a repeated no-progress reply or the token budget ends the node.",
    "",
  ].join("\n");
}

export interface TaskSourceView {
  /** A short label, e.g. `file "src/a.ts"` or `value "answer" in "src/a.ts"`. */
  label: string;
  /** Raw source slice; numbered by the prompt. */
  source: string;
  /** 1-based file-absolute line number of the first source line. */
  startLine: number;
  /** Optional note when the hint did not resolve. */
  note?: string;
}

export interface TaskTurnInput {
  node: WorkNode;
  /** Current source views for the node's hints (file or declaration). */
  views: readonly TaskSourceView[];
  /** Diagnostics from the previous rejected attempt. */
  diagnostics?: string;
  /** Gate diagnostics from the previous applied attempt. */
  gateDiagnostics?: string;
  /** Read/viewer feedback from the previous attempt; writes nothing. */
  feedback?: string;
}

function renderSourceView(view: TaskSourceView): string[] {
  const lines = [
    `## ${view.label}`,
    "",
    ...(view.note === undefined ? [] : [view.note, ""]),
    "```text",
    view.source.trim() === "" ? "(missing or empty)" : view.source,
    "```",
  ];
  return lines;
}

/**
 * One execution turn: the work node, its advice, prior diagnostics, then the
 * current source views as the volatile tail.
 */
export function buildTaskTurnPrompt(input: TaskTurnInput): string {
  const { node } = input;
  const blocks = [
    "# Work node",
    "",
    `#${node.id} (verify ${node.verify})`,
    "",
    `Instruction: ${node.instruction}`,
  ];
  if (node.hints.length > 0) {
    blocks.push("", "Hints (advice; edit outside them when the instruction requires it):");
    for (const hint of node.hints) {
      blocks.push(`- ${formatHint(hint)}`);
    }
  } else {
    blocks.push("", "Hints: none. Inspect the source with `read` if you need more.");
  }
  if (node.approach !== undefined) {
    blocks.push("", `Approach (advice; override it from the source): ${node.approach}`);
  }
  if (node.phase !== undefined) {
    blocks.push("", `Phase: ${node.phase}`);
  }
  if (input.diagnostics !== undefined && input.diagnostics.trim() !== "") {
    blocks.push("", "# Diagnostics", "", "```", input.diagnostics.trim(), "```");
  }
  if (input.gateDiagnostics !== undefined && input.gateDiagnostics.trim() !== "") {
    blocks.push(
      "",
      "# Gate diagnostics",
      "",
      "The previous applied reply did not pass this node's gate. Repair these errors and try again.",
      "",
      "```",
      input.gateDiagnostics.trim(),
      "```",
    );
  }
  if (input.feedback !== undefined && input.feedback.trim() !== "") {
    blocks.push("", "# Source feedback", "", input.feedback.trim());
  }
  blocks.push("", "# Source views", "");
  if (input.views.length === 0) {
    blocks.push("No hinted source is available; inspect the workspace with `read` first.");
  } else {
    for (const view of input.views) {
      blocks.push(...renderSourceView(view), "");
    }
  }
  blocks.push(
    "Reply with the edit-dsl clauses or file commands for this work node. You may use multiple clauses and multiple actions in one reply; each declaration may appear at most once.",
  );
  return blocks.join("\n");
}

/** Render a declaration (or file) region for a source view. */
export function renderTaskContentView(source: string, startLine = 1): string {
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
 * The post-execution review turn. The planner already has the requirement and
 * graph in the cached prefix; this turn adds the gate verdict, the node's
 * advice, any out-of-hint paths, and the applied diff.
 */
export interface TaskReviewInput {
  node: WorkNode;
  gate: {
    /** Gate kind; defaults to the node's own verify when omitted. */
    verify?: WorkVerify;
    ok: boolean;
    diagnostics: string | null;
  };
  /** Concise applied diff from the node's cached base to the current files. */
  diff: string;
  /** Changed paths that the node's hints did not name. */
  outOfHint?: readonly string[];
}

export function buildTaskReviewPrompt(input: TaskReviewInput): string {
  const { node, gate } = input;
  const verify = gate.verify ?? node.verify;
  const blocks = ["# Review", "", `Gate: ${verify} ${gate.ok ? "passed" : "failed"}.`];
  if (gate.diagnostics !== null && gate.diagnostics.trim() !== "") {
    blocks.push("", "```", gate.diagnostics.trim(), "```");
  }
  blocks.push(
    "",
    `Work node #${node.id} (verify ${node.verify})`,
    `Instruction: ${node.instruction}`,
  );
  if (node.hints.length > 0) {
    blocks.push("Hints:");
    for (const hint of node.hints) {
      blocks.push(`- ${formatHint(hint)}`);
    }
  }
  if (node.approach !== undefined) {
    blocks.push(`Approach (advice): ${node.approach}`);
  }
  if (node.phase !== undefined) {
    blocks.push(`Phase: ${node.phase}`);
  }
  if (input.outOfHint !== undefined && input.outOfHint.length > 0) {
    blocks.push(
      "",
      "# Out-of-hint edits",
      "",
      `These changed paths were not named by the node's hints; confirm the instruction required them: ${input.outOfHint.join(", ")}`,
    );
  }
  blocks.push(
    "",
    "# Applied diff",
    "",
    "```diff",
    input.diff.trim() === "" ? "(no applied changes)" : input.diff.trim(),
    "```",
    "",
    "Reply with exactly `approve` or one `patch`; no prose and no other format.",
    "- `approve` when the gate passed and the applied diff implements the instruction.",
    "- A patch may repair this node, its hints, its dependencies, or add follow-up nodes. Prefer a targeted repair after a failed large write, but do not hard-reject a strategy.",
    `- Use \`node~ "${node.id}"\` to change this node; a changed node reopens and executes again. \`node+\` adds work; \`node-\` removes pending or failed work. Keep passed nodes immutable.`,
    "- A review patch may carry `finish` when the last node is a `test` node.",
  );
  return blocks.join("\n");
}

/** A format retry for a malformed review reply. */
export function buildTaskReviewRetryPrompt(diagnostics: string): string {
  return `# Review retry

The previous review reply was rejected.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`

Reply with exactly \`approve\` or one corrected \`patch\`; no prose. A patch may repair the current node, its hints or dependencies, or add follow-up work.`;
}
