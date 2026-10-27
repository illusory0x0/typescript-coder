/**
 * Planning, execution, and review prompts for the plan/execute loop
 * (`docs/plan-exec.md`).
 *
 * Planning context (stability-descending): role -> requirement + symbol index
 * -> (re-plan only) work graph, statuses, and diagnostics.
 *
 * Execution context: role + editing decision guide/techniques + edit-action
 * grammar (stable for the node) -> the work-node turn (instruction, hints,
 * approach, gate diagnostics, edit-strategy advisory, source views).
 *
 * The planner emits a flat work-node DAG as `node` records, then appends more
 * `node` records or revises an unsettled node with `amend`. A WorkNode is the
 * verification boundary. The executor owns the concrete edit actions and their
 * granularity; hints and `approach` are advice, never a hard allowlist. The
 * harness owns scheduling, gates, review, and the final result. There are no
 * Stage/Task/Edit records, no delete, no finish marker, and no fixed exchange,
 * viewer, review, or planning-round caps.
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
4. When a visible test suite exists, consider an early \`verify test\` checkpoint after the scaffold/contract phase, once a compiling skeleton exists, so test feedback can arrive before most behavior is written. The graph shape is yours; the run succeeds only when the last gate is a passing \`test\` and no node is ready.
5. Implement behavior in nodes whose gates can pass meaningfully, using early test feedback when it exists.
6. End with a \`test\` node that depends on the work it verifies. There is no \`finish\` record: the harness completes the run from the graph and the last gate.

A single node, a linear chain, and a branching DAG are all valid; do not force a fixed workflow. The early checkpoint is advice, not a required shape: a single-node task, or one with no visible test suite, may have only the final test node.`;

export const TASK_PLANNER_VIEW = `Read-only inspection:
Before a plan reply, you may reply with one or more read-only viewer requests:

select [kind] <symbol> in <path> [resolve value|type|namespace] [within <selecters>] end
read <path> [within <selecters>] end

A viewer writes nothing. A declaration viewer shows an indentation-folded
outline; add \`within <start>-<end>\` for an exact slice. \`read\` returns a file
outline, or an exact slice with \`within\`. Ranges are 1-based, inclusive, and
file-absolute. Each viewer consumes the run's USD cost budget; a repeated identical
view or a no-progress cycle forces the plan reply. Never use \`replace\`,
\`rename\`, \`write\`, \`create\`, or \`delete\` in a planner viewer.`;

/**
 * The functional style shared by the planner and executor prompts
 * (`docs/plan-exec.md` §1.4). Keep this literal identical to the plan-exec block.
 */
export const TASK_FUNCTIONAL_STYLE = `Prefer ML-style functional TypeScript:
- Data + functions over classes and prototypes.
- Model data with type aliases, tagged unions (string-literal tag), tuples, and plain records.
- Implement behavior as top-level functions with explicit parameter and return types.
- Extract small helpers when they make the code clearer; do not force an extra work node.
- Do not create new classes, inheritance, \`super\`, implicit \`this\`, private state, getters/setters, or class-based state machines.
- If an existing class must change, modify it minimally.`;

/**
 * Advisory editing techniques. The executor may choose, combine, or ignore
 * these from the current source; they are never a gate.
 */
export const TASK_EDITING_TECHNIQUES = `Editing techniques (advice, not rules; compose or ignore them from the source):
1. Small requirement on a small file -> one whole-file \`write\` is often the cheapest correct change.
2. Large module -> scaffold the exported types, signatures, and stub bodies first, then fill bodies with targeted edits. When the module is new, seed that scaffold with one whole-file \`write\`; dozens of separate \`create\` clauses for the initial file cost more and are easy to break, while later additions fit targeted edits or \`create\`.
3. Complex refactor -> introduce a parallel \`xxV1\` implementation, copy the existing behavior, test it, switch the call sites, then remove the old path.
Later techniques can be added; no technique is a gate.`;

/**
 * The shared recovery criteria for a failed or unhelpful whole-file write.
 * Used by the execution decision guide.
 */
export const TASK_FAILED_WRITE_REPAIR_ADVICE = `After a failed or unhelpful whole-file write:
- Read the diagnostics first; repair the named declarations with a targeted \`match\`/\`pick\` or a single-declaration rewrite.
- Repeat a whole-file write only when the diagnostics show broad structural breakage across the file.
- This is advice, not a gate: no write is rejected for its size or shape.`;

/**
 * Situation-aware edit decision guide. The executor owns the choice from the
 * source; a planner `approach` is advice it may override.
 */
export const TASK_EDIT_STRATEGY_GUIDE = `How to choose an edit (advice, not rules; decide from the source you can see):
- New file or skeleton: \`write\` the whole file, or \`create\` it and add the top-level declarations. For a new large file or module, one whole-file \`write\` scaffold with the public types, signatures, and stub bodies is usually cheapest; add later declarations with targeted edits or \`create\`, not dozens of separate \`create\` clauses for the initial file. A small file can still be one whole-file write.
- Local edit in an existing file: prefer a \`match\`/\`pick\` or a single-declaration \`select … replace\`; a whole-file rewrite discards unchanged code.
- Several related declarations in one file: edit each declaration, splitting replies when one declaration would repeat; a small, tightly coupled file may still be clearest as one whole-file write.
- Large declaration rewrite: rewrite only that declaration and leave the file's other declarations untouched.
- Add one named declaration to a file: use \`create <kind> <name> in <path> with <fence>\`; for a class/interface/namespace/enum member use the member kind and a dotted \`Owner.name\` (the owner must already exist).
- Add or edit an import/export statement: use \`create import|export in <path> with <fence>\` to add one, or \`select file <path> [ match <snippet> | match /<regex>/ ] [ pick … ] replace with <fence>\` to edit/delete an existing statement or specifier; no whole-file write is required.
- Whole-file rewrite of an existing file: valid when the change touches most of the file or a targeted edit would be riskier. There is no hard size or shape rejection.
- Small requirement on a small file: one whole-file \`write\` is often cheapest; for a large module, scaffold first and fill bodies with finer edits.
${TASK_FAILED_WRITE_REPAIR_ADVICE}
A planner \`approach\` hint is advice you may override, and \`write\` is always a valid action.`;

const TASK_PLAN_EXAMPLE = `plan
goal: Make the failing test pass.

node "02-answer" verify test
instruction: Make the failing test green.
hint value answer in src/helper.ts
approach: The file and requirement are small; one whole-file write is often cheapest.
end`;

const TASK_SCAFFOLD_PLAN_EXAMPLE = `plan
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
end`;

const TASK_PLAN_BRANCHING_EXAMPLE = `plan
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
end`;

const TASK_AMEND_EXAMPLE = `amend "02-parser"
instruction: Repair the return path the last gate reported; keep the module surface unchanged.
end`;

const TASK_FOLLOWUP_EXAMPLE = `node "05-final" after "03-impl" verify test
instruction: Wire the final entry point and keep the suite green.
hint value parseFile in src/parser.ts
end`;

const TASK_FIELDS = `Records:
- The initial reply starts with the singleton \`plan\` header, then \`goal:\`, then one or more \`node\` records. Later replies contain only \`node\` and \`amend\` records.
- A work node is \`node "<id>" [after "<id>"…] verify tsc|test\`, then \`instruction:\`, optional \`hint\` lines, optional \`approach:\`, optional \`phase:\`, then \`end\`.
- \`after\` lists dependency node ids; the executor runs only nodes whose dependencies passed. A node may depend on an existing node or one declared later in the same reply, as long as the graph stays acyclic. Record order is the deterministic readiness tie-break.
- \`verify\` is the node gate: \`tsc\` runs the type check, \`test\` runs the type check and the test suite after each applied executor reply.
- \`instruction:\` is a self-contained local goal for the executor; it does not see the requirement. Do not paste a whole file into an instruction.
- \`hint file <path>\` marks a whole-file target; \`hint <value|type|namespace> <symbol> in <path>\` marks a declaration, including a dotted member such as \`Parser.parseValue\`. Hints are advisory guidance, not an allowlist.
- \`approach:\` is optional advisory strategy. \`phase:\` is an optional workflow label such as \`scaffold\` or \`implement\`; it never changes scheduling.
- Every id is a quoted "NN-slug": two or more digits, a hyphen, then lowercase kebab words (for example "02-answer"). Work-node ids are globally unique.
- \`goal:\`, \`instruction:\`, \`approach:\`, and \`phase:\` carry one-line text after the label, or an empty label followed by \`TC_EDIT_BEGIN\` on its own line, the raw text lines, then \`TC_EDIT_END\` on its own line. The body is raw: hyphen runs, backticks, \`done\`, and \`end\` are ordinary text lines. A record ends with \`end\`.
- \`amend "<id>"\` revises a pending or failed node in place. It takes only the replacement fields (\`instruction:\`, \`verify\`, \`after\`, \`hint\` lines or \`hint clear\`, \`approach:\`/\`approach clear\`, \`phase:\`/\`phase clear\`), then \`end\`. Omitted fields are preserved. A passed node is immutable.
- There is no \`finish\`, no delete, and no \`patch\` header. Use \`node\` to append work and \`amend\` to repair a node that has not settled.`;

const TASK_RULES = `Rules:
1. Choose the smallest graph that keeps each gate meaningful. One node is valid when its change is cohesive; a large greenfield module often benefits from a compiling scaffold node before behavior is filled in. When a visible test suite exists, consider an early \`verify test\` checkpoint after that scaffold/contract phase so test feedback can arrive before most behavior is written; the run's success condition is a passing \`test\` as the last gate.
2. Use \`after\` only for a real prerequisite. Independent work may be ready at the same time; do not invent edges to force a favorite order.
3. Prefer top-level functions with explicit types. Extract a helper when it makes the code easier to read; keep the caller thin.
4. Hints identify likely targets, not every file the instruction may touch. The executor may edit outside them when the instruction requires it; review sees those edits.
5. \`approach\` may recommend a whole-file write for a small change or a new-file scaffold, scaffold-then-fill for a large existing module, or a parallel implementation for a risky refactor. Never make a technique mandatory.
6. Do not target *.test.ts unless the requirement explicitly changes tests; copy required behavior into the instruction.
7. Do not plan a new class. If an existing class must change, prefer a minimal targeted edit; a named member \`create\` is valid when it is the smallest change.
8. When a node stops making progress or its gate fails, amend that node with a narrower instruction or different hints. Append independent work when the graph needs it.
9. Emit only plan records on a planning turn: no JSON, no markdown fence around the whole reply, and no prose. A read-only viewer request is the only non-plan reply accepted before a plan reply.
10. There is no node-count, planning-round, viewer, or exchange cap. Growth is bounded by the USD cost budget and repeated/no-progress detection.`;

const TASK_REPLAN_RULES = `Rules for a later planning turn:
- Reply with \`node\` records to append work, or \`amend\` records to revise pending or failed nodes. Do not re-emit the plan.
- Prefer repairing a failed node in place with \`amend\`, or appending a targeted repair node. A passed node is immutable.
- If an executor repeatedly cannot land work, narrow the instruction or hints, split the work, or change the approach.
- If no node is ready and the last gate is a failing or non-test gate, plan the missing work and end with a \`test\` node whose gate can pass.
- There is no per-turn node cap and no planning-round cap. Stop planning and act; the USD cost budget and repeated/no-progress detection bound the run.`;

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
    "Minimal initial plan:",
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
    "Amend a failed node:",
    "",
    TASK_AMEND_EXAMPLE,
    "",
    "Append follow-up work:",
    "",
    TASK_FOLLOWUP_EXAMPLE,
    "",
    TASK_FIELDS,
    "",
    TASK_RULES,
    "",
    TASK_REPLAN_RULES,
    "",
  ].join("\n");
}

/** The first planning turn: requirement, symbol index, spec files. */
export function buildTaskPlanningUserPrompt(
  requirement: string,
  indexText: string,
  specFiles: readonly SourceFile[] = [],
): string {
  const prompt = `# Requirement\n\n${requirement}\n\n# Symbol index\n\n\`\`\`text\n${indexText}\n\`\`\`\n\nReply with the initial plan: a \`plan\` header, a \`goal:\` line, and one or more \`node\` records. You may inspect with read-only viewers first.\n`;
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
 * index. It may append nodes or amend pending/failed work.
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
    "Reply with `node` records to append ready work, or `amend` records to revise pending/failed nodes. Do not re-emit the plan. There is no `finish`: the run completes when no node is ready and the last gate is a passing `test`.",
  );
  return blocks.join("\n");
}

/**
 * The first-plan correction: a protocol/graph error, then the same ask. The
 * illustrative plan is appended only when the reply shape has already failed.
 */
export function buildTaskPlanRetryPrompt(diagnostics: string, help = true): string {
  const example = help ? `\n\nExample of a valid initial plan:\n\n${TASK_PLAN_EXAMPLE}` : "";
  return `The previous plan was rejected.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`

Correct the graph:
- Keep one \`plan\` header with a \`goal:\`.
- Emit flat \`node\` records with \`after\`, \`verify\`, \`instruction\`, and optional hints/approach/phase.
- End each node with \`end\`.
- Do not emit \`finish\`, \`patch\`, \`node+\`, \`node~\`, or \`node-\`.${example}

Reply with the complete, corrected initial plan only.`;
}

/** The incremental correction: a rejected reply keeps the planning turn alive. */
export function buildTaskReplanRetryPrompt(diagnostics: string, help = true): string {
  const example = help
    ? `\n\nExample of a valid amend:\n\n${TASK_AMEND_EXAMPLE}\n\nExample of appended work:\n\n${TASK_FOLLOWUP_EXAMPLE}`
    : "";
  return `The previous plan reply was rejected.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`

Reply with corrected \`node\` or \`amend\` records only. Do not re-emit the plan and do not emit \`patch\`, \`finish\`, or \`node+\`/\`node~\`/\`node-\` records.${example}`;
}

/**
 * The execution instruction. It teaches the same clause grammar as the
 * edit-action driver, but the executor owns the target, action, and granularity.
 */
export function taskEditDslInstruction(): string {
  return [
    "A declaration edit is one or more `select … end` clauses; file commands are `create`, `delete`, `read`, and `write <path> with <fence>`. No prose and no JSON: the first non-whitespace token must be `select`, `create`, `delete`, `read`, or `write`.",
    "",
    "Every clause in one reply must resolve to a different declaration `(path, symbol, kind)`; target one declaration at most once per reply, even with different `match` or `pick` spans, and split edits to one declaration across replies.",
    "",
    "Clause: `select <symbol> in <path> [ resolve <value|type|namespace> ] [ match <snippet> | match /<regex>/ ] [ [ pick <range> ] replace with <fence> | rename <old> to <new> end | end ]`. A replacement ends at the fence close; a viewer or rename ends with `end`.",
    "`match` accepts only a backtick snippet or `/regex/`; the matcher has no parentheses, so a parenthesized matcher and unquoted code are rejected. A snippet must be a complete statement or expression, or a contiguous run of complete statements copied from the target, never an unbalanced partial function body; if the span is hard to copy, omit `match` and rewrite the whole declaration. It locates a span inside the declaration; `pick` narrows a match and requires `replace`; omit `match` to rewrite the whole declaration; an empty body deletes it. The fence is line-sensitive: open the body with `TC_EDIT_BEGIN` on its own line and close it with `TC_EDIT_END` on its own line; the body is raw text (hyphen runs, backticks, `done`, and `end` are ordinary body lines), and the close terminates the clause, so do not add `end` after it. `pick` coordinates are the 1-based file-absolute lines of the content view.",
    "For a whole-file edit, `write <path> with <fence>` replaces the file with the raw body; no terminator follows the sentinel close, and a `create … with` body also ends at its close. `create <path> end` adds an empty file; use `write <path> with <fence>` for file content. `delete <path> end` removes one, and `read <path> [within <range>] end` only returns source.",
    "A kind-aware create adds one named declaration or member: `create [static] <kind> <name> in <path> with <fence>`. Top-level kinds are `function`, `class`, `interface`, `type`, `enum`, `namespace`, `const`, `let`, `var`, and `using`; member kinds are `method`, `property`, `getter`, `setter`, `accessor`, `constructor`, and `enum-member`. Use a dotted `Owner.name` for a member (or `create constructor Owner …`); the owner must already be a class/interface/namespace/enum, because a dotted create never creates its owner. `method`/`property` work in classes and interfaces, `getter`/`setter`/`accessor`/`constructor` in classes, and declaration kinds with a dotted namespace owner add namespace members. The fence must declare exactly that name and kind, and its modifiers must fit: `export`/`default`/`declare`/`abstract` come from the declaration text, while the descriptor's optional `static` must match a class member's `static` exactly. An absent symbol in a whole-declaration `select … replace` still creates implicitly.",
    "Imports and exports have no declaration address. Add one with `create import in <path> with <fence>` or `create export in <path> with <fence>`; the fence must be exactly one matching module statement, inserted after the shebang, directives, and existing imports. Edit or delete an existing statement or specifier with `select file <path> [ match <snippet> | match /<regex>/ ] [ pick <range> ] replace with <fence>`: it must resolve exactly one import/export span, a match outside one is rejected, and a file-level `rename` is unsupported because imported bindings and export aliases have no declaration address. A whole-file write is not required for imports/exports.",
    "",
    "You do not run the type check; the harness runs the node gate after every applied reply. Hints and `approach` are advice: edit outside the hinted paths when the instruction requires it, and choose the action and granularity that fit the source.",
  ].join("\n");
}

/**
 * The binding output contract at the end of the execution system prompt. The
 * executor previously matched the agentic prompt with native tool-call markup
 * even though the harness sends no tool definitions, so this names the absence
 * of tools and the literal edit-dsl text form explicitly.
 */
export const TASK_EXECUTION_OUTPUT_CONTRACT = `Output contract (binding):
- No tools are available on this turn; do not call tools or emit tool-call markup.
- \`read\`, \`select\`, \`write\`, \`create\`, and \`delete\` are literal edit-dsl text commands, not function calls.
- Never emit \`<|...|>\`, \`<｜...｜>\`, or any DSML/tool-call markup.
- The block opened by \`TC_EDIT_BEGIN\` and closed by \`TC_EDIT_END\` is plain text: it is not a Markdown code fence and not a tool-call boundary.
- Reply with edit-dsl only: no prose preamble, no Markdown fence around the reply, no JSON. The first non-whitespace token must be \`select\`, \`create\`, \`delete\`, \`read\`, or \`write\`; never start with an explanation or failure summary.
- A viewer/read is inspection only; to finish a node, include edit clauses or file commands.`;

/** The execution system prompt: the editing grammar and techniques, stable per node. */
export function buildTaskExecutionSystemPrompt(): string {
  return [
    TASK_EXECUTION_ROLE,
    "",
    TASK_FUNCTIONAL_STYLE,
    "",
    TASK_EDIT_STRATEGY_GUIDE,
    "",
    TASK_EDITING_TECHNIQUES,
    "",
    taskEditDslInstruction(),
    "",
    "The harness runs the node gate after every applied reply. There is no fixed attempt limit: a repeated no-progress reply or the USD cost budget ends the node.",
    "",
    TASK_EXECUTION_OUTPUT_CONTRACT,
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
  /** Soft, non-blocking advice after a large or repeated whole-file write. */
  editStrategyAdvisory?: string;
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
  if (input.editStrategyAdvisory !== undefined && input.editStrategyAdvisory.trim() !== "") {
    blocks.push("", "# Edit strategy advisory", "", input.editStrategyAdvisory.trim());
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
    "Reply with the edit-dsl clauses or file commands for this work node. You may use multiple clauses and multiple actions in one reply; each declaration may appear at most once. No tools are available: send edit-dsl text only, never DSML/tool-call markup, and treat the sentinel block as literal text.",
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
 *
 * The review is a verdict, not a second planning pass: approve the node, or
 * amend this node and let it execute again. New work belongs to the next
 * planning turn.
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
    "Reply with exactly `approve`, or one `amend` record for this node; no prose and no other format.",
    "- `approve` when the gate passed and the applied diff implements the instruction.",
    `- If the work is wrong or incomplete, write \`amend "${node.id}"\` and the replacement instruction/hints, then \`end\`. The node reopens and executes again.`,
    "- Do not add nodes or amend other nodes in a review reply; follow-up work belongs to the next planning turn.",
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

Reply with exactly \`approve\` or one \`amend\` record for the reviewed node; no prose.`;
}
