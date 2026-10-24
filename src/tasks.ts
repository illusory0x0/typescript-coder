/**
 * The plan/execute tree contract (`docs/spec.md`). The planning model emits a
 * `Plan` as JSON; this module parses it strictly, validates the
 * Stage -> Task -> edit tree, and owns the scheduling state the harness (never
 * the model) advances.
 *
 * Wire shape:
 *
 * ```json
 * {
 *   "stages": [
 *     {
 *       "id": 1,
 *       "goal": "Add a helper and make the caller use it.",
 *       "tasks": [
 *         {
 *           "id": 2,
 *           "verify": "test",
 *           "instruction": "Add formatNumber and call it from printTotal.",
 *           "edits": [
 *             {
 *               "id": 3,
 *               "loc": { "path": "src/format.ts", "symbol": "formatNumber", "kind": "value" },
 *               "action": "create",
 *               "instruction": "Add a small formatNumber helper."
 *             }
 *           ]
 *         }
 *       ]
 *     }
 *   ]
 * }
 * ```
 *
 * A stage is planning context. A task is the verification boundary: its gate
 * runs after every edit in the task is settled. An edit is one declaration
 * action, the unit the executor answers. Array order is execution order; there
 * are no dependency edges and the planner does not own status.
 *
 * `Loc.kind` is the TypeScript symbol space (`value` | `type` | `namespace`),
 * matching the edit-dsl `resolve` vocabulary; the declaration kind is looked up
 * from the index by address resolution.
 */
import { extractJsonObject } from "./matcher";
import type { SymbolSpace } from "./utility";

/** Globally unique node id for tasks and edits (they share the status space). */
export type NodeId = number;
export type StageId = number;

/** The one edit action an edit asks for. */
export const TASK_ACTIONS = ["modify", "create", "delete", "rename"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/** Run state owned by the harness for one edit. */
export const EDIT_STATUSES = ["todo", "in-progress", "done", "failed"] as const;
export type EditStatus = (typeof EDIT_STATUSES)[number];

/** The verification gate a task runs after all of its edits settle. */
export const TASK_VERIFIES = ["tsc", "test"] as const;
export type TaskVerify = (typeof TASK_VERIFIES)[number];

/** Harness-owned gate state for one task. */
export const GATE_STATUSES = ["pending", "passed", "failed"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export interface TaskLoc {
  /** Repo-relative path, inside the workspace. */
  path: string;
  /** Declared identifier (or the name a `create` adds). */
  symbol: string;
  /** TypeScript symbol space, not the declaration kind. */
  kind: SymbolSpace;
}

/**
 * One declaration-level operation inside a task. The executor receives one
 * edit at a time; the task's gate covers the whole sequence.
 */
export interface EditNode {
  id: NodeId;
  loc: TaskLoc;
  /**
   * Additional same-file declarations a migration edit may change atomically.
   * Allowed only with action `modify`.
   */
  related?: TaskLoc[];
  action: TaskAction;
  /** Self-contained imperative: the executor does not see the requirement. */
  instruction: string;
  /** Required exactly when `action` is `rename`. */
  renameTo?: string;
}

/**
 * A verification boundary. The planner should make the whole task small
 * enough that its gate passes; normally 2-4 edits, never more than the cap.
 */
export interface TaskNode {
  id: NodeId;
  verify: TaskVerify;
  /** The task-level goal the executor should satisfy across its edits. */
  instruction: string;
  edits: EditNode[];
}

/** A coherent planning phase. Stages run in array order. */
export interface Stage {
  id: StageId;
  goal: string;
  tasks: TaskNode[];
}

/** One parsed planning reply. Status is harness-owned and never echoed. */
export interface Plan {
  stages: Stage[];
}

/** The run state: the tree plus harness-owned task/edit status. */
export interface TaskRunState {
  stages: Stage[];
  editStatus: Map<NodeId, EditStatus>;
  taskStatus: Map<NodeId, GateStatus>;
}

/** Caps the contract enforces before a plan can drive a run. */
export const MAX_STAGES = 12;
export const MAX_TASKS_PER_STAGE = 8;
export const MAX_EDITS_PER_TASK = 6;
export const MAX_NODES = 96;
export const MAX_STAGE_GOAL_LENGTH = 1_000;
export const MAX_INSTRUCTION_LENGTH = 4_000;
export const MAX_RELATED_LOCS = 16;

const STAGE_KEYS: ReadonlySet<string> = new Set(["id", "goal", "tasks"]);
const TASK_KEYS: ReadonlySet<string> = new Set(["id", "verify", "instruction", "edits"]);
const EDIT_KEYS: ReadonlySet<string> = new Set([
  "id",
  "related",
  "loc",
  "action",
  "instruction",
  "renameTo",
]);
const LOC_KEYS: ReadonlySet<string> = new Set(["path", "symbol", "kind"]);
const PLAN_KEYS: ReadonlySet<string> = new Set(["stages"]);
const SPACES: ReadonlySet<string> = new Set(["value", "type", "namespace"]);
const VERIFY_SET: ReadonlySet<string> = new Set(TASK_VERIFIES);

/**
 * Directories the harness never edits (`src/loop.ts` `SKIPPED_DIRECTORIES`),
 * plus the human-authored `human/` tree, which is read-only for agents.
 */
const SKIPPED_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "tmp",
  "human",
]);

/** A plan rejection: `stage: task-protocol` or `stage: task-tree`. */
export type PlanParse =
  | { ok: true; plan: Plan }
  | { ok: false; stage: "task-protocol" | "task-tree"; diagnostics: string };

/** A re-plan merge rejection; always a tree amendment violation. */
export type PlanMerge = { ok: true; state: TaskRunState } | { ok: false; diagnostics: string };

function protocol(detail: string): PlanParse {
  return { ok: false, stage: "task-protocol", diagnostics: `stage: task-protocol\n${detail}` };
}

function tree(detail: string): PlanParse {
  return { ok: false, stage: "task-tree", diagnostics: `stage: task-tree\n${detail}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * True for a repo-relative, writable edit path: no absolute path, no `..`, no
 * empty or hidden/build segment, and inside the workspace. Existence is not
 * checked because `create` targets a path that may not exist yet.
 */
export function isSafeTaskPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
    return false;
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return false;
    }
    if (segment.startsWith(".") || SKIPPED_SEGMENTS.has(segment)) {
      return false;
    }
  }
  return true;
}

/** Every task in stage order. */
export function allTasks(stages: readonly Stage[]): TaskNode[] {
  return stages.flatMap((stage) => stage.tasks);
}

/** Every edit in stage -> task -> edit order. */
export function allEdits(stages: readonly Stage[]): EditNode[] {
  return allTasks(stages).flatMap((task) => task.edits);
}

/** A task always has at least one edit; fail loudly if a malformed tree slips in. */
export function firstEdit(task: TaskNode): EditNode {
  const edit = task.edits[0];
  if (edit === undefined) {
    throw new Error(`task #${task.id} has no edits`);
  }
  return edit;
}

/** The final task in the final stage; `undefined` for an empty tree. */
export function finalTask(stages: readonly Stage[]): TaskNode | undefined {
  const stage = stages[stages.length - 1];
  if (stage === undefined) {
    return undefined;
  }
  return stage.tasks[stage.tasks.length - 1];
}

/** The stage that owns a task. */
export function stageOfTask(state: TaskRunState, taskId: NodeId): Stage | undefined {
  return state.stages.find((stage) => stage.tasks.some((task) => task.id === taskId));
}

/** The task that owns an edit. */
export function taskOfEdit(state: TaskRunState, editId: NodeId): TaskNode | undefined {
  return allTasks(state.stages).find((task) => task.edits.some((edit) => edit.id === editId));
}

/** The stage that owns an edit. */
export function stageOfEdit(state: TaskRunState, editId: NodeId): Stage | undefined {
  return state.stages.find((stage) =>
    stage.tasks.some((task) => task.edits.some((edit) => edit.id === editId)),
  );
}

/** Every edit which is `todo`, in tree order. */
export function todoEdits(state: TaskRunState): EditNode[] {
  return allEdits(state.stages).filter((edit) => state.editStatus.get(edit.id) === "todo");
}

/** True when every edit in a task is done or failed (the gate may run). */
export function taskEditsSettled(state: TaskRunState, task: TaskNode): boolean {
  return task.edits.every((edit) => {
    const status = state.editStatus.get(edit.id);
    return status === "done" || status === "failed";
  });
}

/** True when at least one edit in the task actually landed. */
export function taskHasDoneEdit(state: TaskRunState, task: TaskNode): boolean {
  return task.edits.some((edit) => state.editStatus.get(edit.id) === "done");
}

/** The next runnable edit in a task, or `undefined` when its gate is next. */
export function nextEdit(state: TaskRunState, task: TaskNode): EditNode | undefined {
  return task.edits.find((edit) => state.editStatus.get(edit.id) === "todo");
}

/**
 * The first stage that still has a pending task. A stage with only passed or
 * failed tasks is closed; a stage with a pending task after a failed one stays
 * active so later planned work can still repair the stage.
 */
export function activeStage(state: TaskRunState): Stage | undefined {
  return state.stages.find((stage) =>
    stage.tasks.some(
      (task) =>
        state.taskStatus.get(task.id) === "pending" ||
        task.edits.some((edit) => state.editStatus.get(edit.id) === "todo"),
    ),
  );
}

/** The first pending task in the active stage. */
export function activeTask(state: TaskRunState): TaskNode | undefined {
  const stage = activeStage(state);
  return stage?.tasks.find((task) => state.taskStatus.get(task.id) === "pending");
}

/** True when a later task in the same stage is still pending. */
export function hasLaterPendingTaskInStage(state: TaskRunState, task: TaskNode): boolean {
  const stage = stageOfTask(state, task.id);
  if (stage === undefined) {
    return false;
  }
  const index = stage.tasks.findIndex((candidate) => candidate.id === task.id);
  return stage.tasks
    .slice(index + 1)
    .some((candidate) => state.taskStatus.get(candidate.id) === "pending");
}

/** True when every task and edit has reached a terminal state. */
export function allStagesClosed(state: TaskRunState): boolean {
  for (const task of allTasks(state.stages)) {
    const status = state.taskStatus.get(task.id);
    if (status !== "passed" && status !== "failed") {
      return false;
    }
    if (
      status === "passed" &&
      !task.edits.every((edit) => state.editStatus.get(edit.id) === "done")
    ) {
      return false;
    }
  }
  return allEdits(state.stages).every((edit) => {
    const status = state.editStatus.get(edit.id);
    return status === "done" || status === "failed";
  });
}

/** The final task is the run's final test gate. */
export function finalTaskPassed(state: TaskRunState): boolean {
  const task = finalTask(state.stages);
  return task !== undefined && state.taskStatus.get(task.id) === "passed";
}

/**
 * The run is done only when every stage is closed and the final task's gate
 * passed. Earlier failed tasks are allowed: a later repair task/test can
 * supersede them, exactly like a failed phase followed by a green suite.
 */
export function runComplete(state: TaskRunState): boolean {
  return finalTaskPassed(state) && allStagesClosed(state);
}

/** The highest task/edit id in the tree, or 0 for an empty one. */
export function maxNodeId(state: TaskRunState): NodeId {
  let max = 0;
  for (const task of allTasks(state.stages)) {
    max = Math.max(max, task.id);
  }
  for (const edit of allEdits(state.stages)) {
    max = Math.max(max, edit.id);
  }
  return max;
}

/**
 * Render the stable tree structure: stages, tasks, and edits in execution
 * order. Status is deliberately absent so this block can stay in the
 * cache-stable prefix.
 */
export function renderTaskTree(stages: readonly Stage[]): string {
  const lines: string[] = [];
  for (const stage of stages) {
    lines.push(`@stage #${stage.id} goal=${quote(stage.goal)}`);
    for (const task of stage.tasks) {
      lines.push(`  @task #${task.id} verify=${task.verify}`);
      lines.push(`    task: ${task.instruction.replace(/\s*\n\s*/g, " ").trim()}`);
      for (const edit of task.edits) {
        const related =
          edit.related === undefined || edit.related.length === 0
            ? ""
            : ` related=[${edit.related
                .map((loc) => `${loc.kind} ${quote(loc.symbol)}`)
                .join(", ")}]`;
        const rename = edit.renameTo === undefined ? "" : ` renameTo=${quote(edit.renameTo)}`;
        lines.push(
          `    - #${edit.id} ${edit.action} ${edit.loc.kind} ${quote(edit.loc.symbol)} in ${quote(edit.loc.path)}${rename}${related}`,
        );
        lines.push(`      edit: ${edit.instruction.replace(/\s*\n\s*/g, " ").trim()}`);
      }
    }
  }
  return lines.join("\n");
}

/** Render task and edit statuses in tree order. */
export function renderTaskStatus(state: TaskRunState): string {
  const lines: string[] = [];
  for (const stage of state.stages) {
    lines.push(`@stage #${stage.id}`);
    for (const task of stage.tasks) {
      lines.push(`  @task #${task.id} ${state.taskStatus.get(task.id) ?? "pending"}`);
      const edits = task.edits.map(
        (edit) => `#${edit.id} ${state.editStatus.get(edit.id) ?? "todo"}`,
      );
      lines.push(`    ${edits.join("  ")}`);
    }
  }
  return lines.join("\n");
}

/** Render failed edits with their diagnostics. */
export function renderFailedEdits(
  state: TaskRunState,
  failures: ReadonlyMap<NodeId, string>,
): string {
  const lines: string[] = [];
  for (const edit of allEdits(state.stages)) {
    if (state.editStatus.get(edit.id) !== "failed") {
      continue;
    }
    lines.push(
      `#${edit.id} ${edit.action} ${quote(edit.loc.symbol)} in ${quote(edit.loc.path)} failed:`,
    );
    const diagnostics = failures.get(edit.id);
    lines.push(diagnostics === undefined ? "  (no diagnostics recorded)" : indent(diagnostics));
  }
  return lines.join("\n");
}

/** Render failed task gates with their diagnostics. */
export function renderFailedTaskGates(
  state: TaskRunState,
  failures: ReadonlyMap<NodeId, string>,
): string {
  const lines: string[] = [];
  for (const task of allTasks(state.stages)) {
    if (state.taskStatus.get(task.id) !== "failed") {
      continue;
    }
    lines.push(`@task #${task.id} (${task.verify} gate) failed after its edits:`);
    const diagnostics = failures.get(task.id);
    lines.push(diagnostics === undefined ? "  (no diagnostics recorded)" : indent(diagnostics));
  }
  return lines.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");
}

/** Describe one loc the way diagnostics expect. */
export function formatTaskLoc(loc: TaskLoc): string {
  return `${loc.kind} ${quote(loc.symbol)} in ${quote(loc.path)}`;
}

function readId(value: unknown, where: string, problems: string[]): NodeId | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    problems.push(`${where} must be a positive integer id (got ${JSON.stringify(value)})`);
    return null;
  }
  return value;
}

function readStageId(value: unknown, where: string, problems: string[]): StageId | null {
  return readId(value, where, problems);
}

function readLoc(raw: unknown, where: string, problems: string[]): TaskLoc | null {
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object {"path": ..., "symbol": ..., "kind": ...}`);
    return null;
  }
  const extra = Object.keys(raw).filter((key) => !LOC_KEYS.has(key));
  if (extra.length > 0) {
    problems.push(
      `${where} carries unexpected key(s) ${extra.map(quote).join(", ")}; allowed keys are path, symbol, kind`,
    );
    return null;
  }
  const path = raw["path"];
  const symbol = raw["symbol"];
  const kind = raw["kind"];
  if (typeof path !== "string" || path === "") {
    problems.push(`${where}.path must be a non-empty string`);
    return null;
  }
  if (typeof symbol !== "string" || symbol.trim() === "") {
    problems.push(`${where}.symbol must be a non-empty string`);
    return null;
  }
  if (typeof kind !== "string" || !SPACES.has(kind)) {
    problems.push(
      `${where}.kind must be the TypeScript symbol space "value", "type", or "namespace" (got ${JSON.stringify(kind)})`,
    );
    return null;
  }
  return { path, symbol: symbol.trim(), kind: kind as SymbolSpace };
}

function claimNodeId(
  value: unknown,
  where: string,
  nodeIds: Set<NodeId>,
  problems: string[],
): NodeId | null {
  const id = readId(value, where, problems);
  if (id === null) {
    return null;
  }
  if (nodeIds.has(id)) {
    problems.push(
      `${where} reuses node id #${id}; task and edit ids must be unique across the tree`,
    );
    return null;
  }
  nodeIds.add(id);
  return id;
}

function readEdit(
  raw: unknown,
  where: string,
  problems: string[],
  nodeIds: Set<NodeId>,
): EditNode | null {
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  const extra = Object.keys(raw).filter((key) => !EDIT_KEYS.has(key));
  if (extra.length > 0) {
    problems.push(
      `${where} carries unexpected key(s) ${extra.map(quote).join(", ")}; allowed keys are id, related, loc, action, instruction, renameTo`,
    );
    return null;
  }
  const id = claimNodeId(raw["id"], `${where}.id`, nodeIds, problems);
  if (id === null) {
    return null;
  }
  const loc = readLoc(raw["loc"], `${where}.loc`, problems);
  if (loc === null) {
    return null;
  }
  let related: TaskLoc[] | undefined;
  if (raw["related"] !== undefined) {
    const rawRelated = raw["related"];
    if (!Array.isArray(rawRelated)) {
      problems.push(`${where}.related must be an array of loc objects`);
      return null;
    }
    if (rawRelated.length > MAX_RELATED_LOCS) {
      problems.push(
        `${where}.related carries ${rawRelated.length} entries; keep it at most ${MAX_RELATED_LOCS}`,
      );
      return null;
    }
    const readRelated: TaskLoc[] = [];
    for (let relatedIndex = 0; relatedIndex < rawRelated.length; relatedIndex += 1) {
      const relatedLoc = readLoc(
        rawRelated[relatedIndex],
        `${where}.related[${relatedIndex}]`,
        problems,
      );
      if (relatedLoc !== null) {
        readRelated.push(relatedLoc);
      }
    }
    related = readRelated;
  }
  const action = raw["action"];
  if (typeof action !== "string" || !(TASK_ACTIONS as readonly string[]).includes(action)) {
    problems.push(
      `${where}.action must be one of ${TASK_ACTIONS.map(quote).join(", ")} (got ${JSON.stringify(action)})`,
    );
    return null;
  }
  const instruction = raw["instruction"];
  if (typeof instruction !== "string" || instruction.trim() === "") {
    problems.push(`${where}.instruction must be a non-empty string`);
    return null;
  }
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    problems.push(
      `${where}.instruction is ${instruction.length} characters; keep it at most ${MAX_INSTRUCTION_LENGTH}`,
    );
    return null;
  }
  let renameTo: string | undefined;
  if (raw["renameTo"] !== undefined) {
    const value = raw["renameTo"];
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`${where}.renameTo must be a non-empty string when present`);
      return null;
    }
    renameTo = value;
  }
  return {
    id,
    ...(related === undefined ? {} : { related }),
    loc,
    action: action as TaskAction,
    instruction: instruction.trim(),
    ...(renameTo === undefined ? {} : { renameTo }),
  };
}

function readTask(
  raw: unknown,
  where: string,
  problems: string[],
  nodeIds: Set<NodeId>,
): TaskNode | null {
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  const extra = Object.keys(raw).filter((key) => !TASK_KEYS.has(key));
  if (extra.length > 0) {
    problems.push(
      `${where} carries unexpected key(s) ${extra.map(quote).join(", ")}; allowed keys are id, verify, instruction, edits`,
    );
    return null;
  }
  const id = claimNodeId(raw["id"], `${where}.id`, nodeIds, problems);
  if (id === null) {
    return null;
  }
  const verify = raw["verify"];
  if (typeof verify !== "string" || !VERIFY_SET.has(verify)) {
    problems.push(
      `${where}.verify must be one of ${TASK_VERIFIES.map(quote).join(", ")} (got ${JSON.stringify(verify)})`,
    );
    return null;
  }
  const instruction = raw["instruction"];
  if (typeof instruction !== "string" || instruction.trim() === "") {
    problems.push(`${where}.instruction must be a non-empty string`);
    return null;
  }
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    problems.push(
      `${where}.instruction is ${instruction.length} characters; keep it at most ${MAX_INSTRUCTION_LENGTH}`,
    );
    return null;
  }
  const rawEdits = raw["edits"];
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    problems.push(`${where}.edits must be a non-empty array of edit objects`);
    return null;
  }
  if (rawEdits.length > MAX_EDITS_PER_TASK) {
    problems.push(
      `${where}.edits carries ${rawEdits.length} entries; keep a task to at most ${MAX_EDITS_PER_TASK} edits`,
    );
    return null;
  }
  const edits: EditNode[] = [];
  for (let index = 0; index < rawEdits.length; index += 1) {
    const edit = readEdit(rawEdits[index], `${where}.edits[${index}]`, problems, nodeIds);
    if (edit !== null) {
      edits.push(edit);
    }
  }
  return {
    id,
    verify: verify as TaskVerify,
    instruction: instruction.trim(),
    edits,
  };
}

function readStage(
  raw: unknown,
  where: string,
  problems: string[],
  stageIds: Set<StageId>,
  nodeIds: Set<NodeId>,
): Stage | null {
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  const extra = Object.keys(raw).filter((key) => !STAGE_KEYS.has(key));
  if (extra.length > 0) {
    problems.push(
      `${where} carries unexpected key(s) ${extra.map(quote).join(", ")}; allowed keys are id, goal, tasks`,
    );
    return null;
  }
  const id = readStageId(raw["id"], `${where}.id`, problems);
  if (id === null) {
    return null;
  }
  if (stageIds.has(id)) {
    problems.push(`${where}.id reuses stage id #${id}`);
    return null;
  }
  stageIds.add(id);
  const goal = raw["goal"];
  if (typeof goal !== "string" || goal.trim() === "") {
    problems.push(`${where}.goal must be a non-empty string`);
    return null;
  }
  if (goal.length > MAX_STAGE_GOAL_LENGTH) {
    problems.push(
      `${where}.goal is ${goal.length} characters; keep it at most ${MAX_STAGE_GOAL_LENGTH}`,
    );
    return null;
  }
  const rawTasks = raw["tasks"];
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    problems.push(`${where}.tasks must be a non-empty array of task objects`);
    return null;
  }
  if (rawTasks.length > MAX_TASKS_PER_STAGE) {
    problems.push(
      `${where}.tasks carries ${rawTasks.length} entries; keep a stage to at most ${MAX_TASKS_PER_STAGE} tasks`,
    );
    return null;
  }
  const tasks: TaskNode[] = [];
  for (let index = 0; index < rawTasks.length; index += 1) {
    const task = readTask(rawTasks[index], `${where}.tasks[${index}]`, problems, nodeIds);
    if (task !== null) {
      tasks.push(task);
    }
  }
  return { id, goal: goal.trim(), tasks };
}

function locProblems(edit: EditNode): string | null {
  if (!isSafeTaskPath(edit.loc.path)) {
    return `#${edit.id} targets ${quote(edit.loc.path)}, which is not a writable repo-relative path (no absolute path, "..", hidden/build segment, or human/)`;
  }
  if (edit.action === "rename") {
    if (edit.renameTo === undefined) {
      return `#${edit.id} is a rename but carries no renameTo`;
    }
    if (edit.renameTo === edit.loc.symbol) {
      return `#${edit.id} renames ${quote(edit.loc.symbol)} to itself; a rename must change the name`;
    }
    if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(edit.renameTo)) {
      return `#${edit.id} renameTo ${quote(edit.renameTo)} is not a TypeScript identifier or dotted path`;
    }
  } else if (edit.renameTo !== undefined) {
    return `#${edit.id} carries renameTo but its action is ${quote(edit.action)}; renameTo is allowed only with action "rename"`;
  }
  if (edit.related !== undefined) {
    if (edit.action !== "modify") {
      return `#${edit.id} carries related; only a modify edit may migrate several declarations atomically`;
    }
    const seen = new Set<string>([`${edit.loc.kind}\u0000${edit.loc.symbol}`]);
    for (const loc of edit.related) {
      if (loc.path !== edit.loc.path) {
        return `#${edit.id} related target ${formatTaskLoc(loc)} is not in the edit's file ${quote(edit.loc.path)}; split cross-file work into separate edits`;
      }
      if (!isSafeTaskPath(loc.path)) {
        return `#${edit.id} related target ${formatTaskLoc(loc)} is not a writable repo-relative path`;
      }
      const key = `${loc.kind}\u0000${loc.symbol}`;
      if (seen.has(key)) {
        return `#${edit.id} lists ${formatTaskLoc(loc)} more than once as a target or related target`;
      }
      seen.add(key);
    }
  }
  return null;
}

function treeProblems(stages: readonly Stage[]): string[] {
  const problems: string[] = [];
  const taskIds = new Set<NodeId>();
  const editIds = new Set<NodeId>();
  let nodeCount = 0;
  for (const stage of stages) {
    for (const task of stage.tasks) {
      nodeCount += 1;
      if (taskIds.has(task.id)) {
        problems.push(`task id #${task.id} is declared more than once`);
      }
      taskIds.add(task.id);
      for (const edit of task.edits) {
        nodeCount += 1;
        if (editIds.has(edit.id)) {
          problems.push(`edit id #${edit.id} is declared more than once`);
        }
        editIds.add(edit.id);
        const problem = locProblems(edit);
        if (problem !== null) {
          problems.push(problem);
        }
      }
    }
  }
  for (const id of editIds) {
    if (taskIds.has(id)) {
      problems.push(`node id #${id} is used by both a task and an edit`);
    }
  }
  if (nodeCount > MAX_NODES) {
    problems.push(
      `the tree carries ${nodeCount} task/edit nodes; at most ${MAX_NODES} are allowed (split the requirement)`,
    );
  }
  const last = finalTask(stages);
  if (last !== undefined && last.verify !== "test") {
    problems.push(
      `the final task #${last.id} must verify "test" so the run ends with the test suite, not only tsc`,
    );
  }
  return problems;
}

/**
 * Parse one planning reply. The wire shape is the tree, parser strictness is
 * shared by the initial plan and a re-plan; status is harness-owned and is
 * never accepted from the model.
 */
export function readPlan(content: string): PlanParse {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(content);
  } catch (error) {
    return protocol(
      `expected a JSON object {"stages": [...]}; ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    return protocol(
      'expected a JSON object {"stages": [...]}; got a JSON value that is not an object',
    );
  }
  const extra = Object.keys(parsed).filter((key) => !PLAN_KEYS.has(key));
  if (extra.length > 0) {
    return protocol(
      `the plan carries unexpected key(s) ${extra.map(quote).join(", ")}; send only "stages"`,
    );
  }
  const rawStages = parsed["stages"];
  if (!Array.isArray(rawStages) || rawStages.length === 0) {
    return protocol('"stages" must be a non-empty array of stage objects');
  }
  if (rawStages.length > MAX_STAGES) {
    return protocol(
      `the plan carries ${rawStages.length} stages; at most ${MAX_STAGES} are allowed`,
    );
  }
  const problems: string[] = [];
  const stageIds = new Set<StageId>();
  const nodeIds = new Set<NodeId>();
  const stages: Stage[] = [];
  for (let index = 0; index < rawStages.length; index += 1) {
    const stage = readStage(rawStages[index], `stages[${index}]`, problems, stageIds, nodeIds);
    if (stage !== null) {
      stages.push(stage);
    }
  }
  if (problems.length > 0) {
    return protocol(
      `the plan is not a valid task tree:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  }
  const treeIssues = treeProblems(stages);
  if (treeIssues.length > 0) {
    return tree(treeIssues.map((problem) => `- ${problem}`).join("\n"));
  }
  return { ok: true, plan: { stages } };
}

/** Parse and validate the planner's initial reply. */
export function parsePlan(content: string): PlanParse {
  return readPlan(content);
}

/** Build the run state from a freshly parsed plan (every task pending, every edit todo). */
export function initialState(plan: Plan): TaskRunState {
  return {
    stages: plan.stages,
    editStatus: new Map(allEdits(plan.stages).map((edit) => [edit.id, "todo" as EditStatus])),
    taskStatus: new Map(allTasks(plan.stages).map((task) => [task.id, "pending" as GateStatus])),
  };
}

function sameLoc(a: TaskLoc, b: TaskLoc): boolean {
  return a.path === b.path && a.symbol === b.symbol && a.kind === b.kind;
}

function sameEdit(a: EditNode, b: EditNode): boolean {
  const relatedA = a.related ?? [];
  const relatedB = b.related ?? [];
  return (
    a.action === b.action &&
    a.instruction === b.instruction &&
    a.renameTo === b.renameTo &&
    sameLoc(a.loc, b.loc) &&
    relatedA.length === relatedB.length &&
    relatedA.every((loc, index) => {
      const other = relatedB[index];
      return other !== undefined && sameLoc(loc, other);
    })
  );
}

function sameTaskDefinition(a: TaskNode, b: TaskNode): boolean {
  return a.verify === b.verify && a.instruction === b.instruction;
}

interface PreviousTask {
  task: TaskNode;
  stage: Stage;
}

interface PreviousEdit {
  edit: EditNode;
  task: TaskNode;
  stage: Stage;
}

/**
 * Merge a re-planning reply into the harness state. The reply re-emits the
 * full tree; ids are stable and array order is execution order.
 *
 * - a done edit and a passed task are immutable and cannot be removed;
 * - a failed edit retries only with a changed definition;
 * - a failed task reopens when its definition changes or it gains edits;
 * - a new task starts pending and is appended to its stage; a fully passed
 *   stage is closed, so later work goes in a new stage;
 * - new edits are appended to their task.
 */
export function mergeReplan(previous: TaskRunState, plan: Plan): PlanMerge {
  const problems: string[] = [];

  const previousStages = new Map<StageId, Stage>(previous.stages.map((stage) => [stage.id, stage]));
  const previousTasks = new Map<NodeId, PreviousTask>();
  const previousEdits = new Map<NodeId, PreviousEdit>();
  for (const stage of previous.stages) {
    for (const task of stage.tasks) {
      previousTasks.set(task.id, { task, stage });
      for (const edit of task.edits) {
        previousEdits.set(edit.id, { edit, task, stage });
      }
    }
  }

  const nextStageIds = plan.stages.map((stage) => stage.id);
  const nextStageSet = new Set(nextStageIds);
  const nextTasks = new Map<NodeId, TaskNode>();
  const nextEdits = new Map<NodeId, EditNode>();
  for (const stage of plan.stages) {
    for (const task of stage.tasks) {
      nextTasks.set(task.id, task);
      for (const edit of task.edits) {
        nextEdits.set(edit.id, edit);
      }
    }
  }

  // Existing stages keep their order; new stages are appended.
  const keptPreviousStages = [...previousStages.keys()].filter((id) => nextStageSet.has(id));
  const keptNextStages = nextStageIds.filter((id) => previousStages.has(id));
  if (keptPreviousStages.join(",") !== keptNextStages.join(",")) {
    problems.push("existing stages must keep their plan order");
  }
  const firstNewStage = nextStageIds.findIndex((id) => !previousStages.has(id));
  if (
    firstNewStage !== -1 &&
    nextStageIds.slice(firstNewStage).some((id) => previousStages.has(id))
  ) {
    problems.push("new stages must be appended after existing stages");
  }

  // A stage that already passed is closed; a stage with failed work may be
  // repaired, but done edits may not disappear.
  for (const [stageId, stage] of previousStages) {
    if (nextStageSet.has(stageId)) {
      continue;
    }
    const hasPassedTask = stage.tasks.some((task) => previous.taskStatus.get(task.id) === "passed");
    const hasDoneEdit = stage.tasks.some((task) =>
      task.edits.some((edit) => previous.editStatus.get(edit.id) === "done"),
    );
    if (hasPassedTask || hasDoneEdit) {
      problems.push(`stage #${stageId} contains passed tasks or done edits and cannot be removed`);
    }
  }

  // Existing tasks keep their order inside a stage; new tasks are appended.
  for (const stage of plan.stages) {
    const beforeStage = previousStages.get(stage.id);
    if (beforeStage === undefined) {
      continue;
    }
    const previousTaskIds = beforeStage.tasks.map((task) => task.id);
    const nextTaskSet = new Set(stage.tasks.map((task) => task.id));
    const keptPreviousTasks = previousTaskIds.filter((id) => nextTaskSet.has(id));
    const keptNextTasks = stage.tasks.map((task) => task.id).filter((id) => previousTasks.has(id));
    if (keptPreviousTasks.join(",") !== keptNextTasks.join(",")) {
      problems.push(`tasks in stage #${stage.id} must keep their plan order`);
    }
    const firstNewTask = stage.tasks.findIndex((task) => !previousTasks.has(task.id));
    if (
      firstNewTask !== -1 &&
      stage.tasks.slice(firstNewTask).some((task) => previousTasks.has(task.id))
    ) {
      problems.push(`new tasks in stage #${stage.id} must be appended after existing tasks`);
    }
    const stagePassed =
      beforeStage.tasks.length > 0 &&
      beforeStage.tasks.every((task) => previous.taskStatus.get(task.id) === "passed");
    if (stagePassed && stage.tasks.some((task) => !previousTasks.has(task.id))) {
      problems.push(
        `stage #${stage.id} already passed; add repair work in a new stage instead of extending it`,
      );
    }
  }

  // A task may not move to another stage.
  for (const stage of plan.stages) {
    for (const task of stage.tasks) {
      const before = previousTasks.get(task.id);
      if (before !== undefined && before.stage.id !== stage.id) {
        problems.push(
          `task #${task.id} moved from stage #${before.stage.id} to stage #${stage.id}; keep tasks in their stage`,
        );
      }
    }
  }

  // Removed tasks may not carry passed work or done edits.
  for (const [taskId, before] of previousTasks) {
    if (nextTasks.has(taskId)) {
      continue;
    }
    if (previous.taskStatus.get(taskId) === "passed") {
      problems.push(`passed task #${taskId} cannot be removed by a re-plan`);
      continue;
    }
    const done = before.task.edits.some((edit) => previous.editStatus.get(edit.id) === "done");
    if (done) {
      problems.push(`task #${taskId} contains done edits and cannot be removed by a re-plan`);
    }
  }

  const editStatus = new Map<NodeId, EditStatus>();
  const taskStatus = new Map<NodeId, GateStatus>();

  for (const stage of plan.stages) {
    for (const task of stage.tasks) {
      const beforeTask = previousTasks.get(task.id);
      if (beforeTask === undefined) {
        taskStatus.set(task.id, "pending");
        for (const edit of task.edits) {
          editStatus.set(edit.id, "todo");
        }
        continue;
      }

      const beforeGate = previous.taskStatus.get(task.id) ?? "pending";
      let changed = !sameTaskDefinition(beforeTask.task, task);
      const nextEditIds = new Set(task.edits.map((edit) => edit.id));

      // Existing edits keep their order; new edits are appended.
      const previousEditIds = beforeTask.task.edits.map((edit) => edit.id);
      const keptPreviousEdits = previousEditIds.filter((id) => nextEditIds.has(id));
      const keptNextEdits = task.edits.map((edit) => edit.id).filter((id) => previousEdits.has(id));
      if (keptPreviousEdits.join(",") !== keptNextEdits.join(",")) {
        problems.push(`edits in task #${task.id} must keep their plan order`);
      }
      const firstNewEdit = task.edits.findIndex((edit) => !previousEdits.has(edit.id));
      if (
        firstNewEdit !== -1 &&
        task.edits.slice(firstNewEdit).some((edit) => previousEdits.has(edit.id))
      ) {
        problems.push(`new edits in task #${task.id} must be appended after existing edits`);
      }

      for (const edit of task.edits) {
        const beforeEdit = previousEdits.get(edit.id);
        if (beforeEdit === undefined) {
          editStatus.set(edit.id, "todo");
          changed = true;
          continue;
        }
        if (beforeEdit.task.id !== task.id) {
          problems.push(
            `edit #${edit.id} moved from task #${beforeEdit.task.id} to task #${task.id}; keep edits in their task`,
          );
          continue;
        }
        const beforeStatus = previous.editStatus.get(edit.id) ?? "todo";
        if (beforeStatus === "done") {
          if (!sameEdit(beforeEdit.edit, edit)) {
            problems.push(`done edit #${edit.id} is immutable`);
          }
          editStatus.set(edit.id, "done");
          continue;
        }
        if (beforeStatus === "in-progress") {
          problems.push(
            `edit #${edit.id} is in progress; the harness holds it until the edit finishes`,
          );
          continue;
        }
        if (beforeStatus === "failed") {
          if (sameEdit(beforeEdit.edit, edit)) {
            editStatus.set(edit.id, "failed");
          } else {
            editStatus.set(edit.id, "todo");
            changed = true;
          }
          continue;
        }
        // todo
        if (!sameEdit(beforeEdit.edit, edit)) {
          changed = true;
        }
        editStatus.set(edit.id, "todo");
      }

      for (const beforeEdit of beforeTask.task.edits) {
        if (nextEditIds.has(beforeEdit.id)) {
          continue;
        }
        if (previous.editStatus.get(beforeEdit.id) === "done") {
          problems.push(`done edit #${beforeEdit.id} cannot be removed by a re-plan`);
        } else {
          changed = true;
        }
      }

      if (beforeGate === "passed") {
        if (changed) {
          problems.push(
            `passed task #${task.id} is immutable; add repair work in a new task or stage`,
          );
        }
        taskStatus.set(task.id, "passed");
      } else if (beforeGate === "failed") {
        // A changed failed task is a repair: reopen it. An unchanged failed
        // task stays closed so a later task can supersede it.
        taskStatus.set(task.id, changed ? "pending" : "failed");
      } else {
        taskStatus.set(task.id, "pending");
      }
    }
  }

  if (problems.length > 0) {
    return {
      ok: false,
      diagnostics: `stage: task-tree\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    };
  }
  const treeIssues = treeProblems(plan.stages);
  if (treeIssues.length > 0) {
    return {
      ok: false,
      diagnostics: `stage: task-tree\n${treeIssues.map((problem) => `- ${problem}`).join("\n")}`,
    };
  }

  return {
    ok: true,
    state: {
      stages: plan.stages,
      editStatus,
      taskStatus,
    },
  };
}

/** The per-edit result summary a plan/execute run reports. */
export interface TaskSummary {
  id: NodeId;
  stage: StageId;
  task: NodeId;
  verify: TaskVerify;
  action: TaskAction;
  path: string;
  symbol: string;
  kind: string;
  status: EditStatus;
}

/** Snapshot the run state as the result's per-edit summary. */
export function summaryOf(state: TaskRunState): TaskSummary[] {
  const summaries: TaskSummary[] = [];
  for (const stage of state.stages) {
    for (const task of stage.tasks) {
      for (const edit of task.edits) {
        summaries.push({
          id: edit.id,
          stage: stage.id,
          task: task.id,
          verify: task.verify,
          action: edit.action,
          path: edit.loc.path,
          symbol: edit.loc.symbol,
          kind: edit.loc.kind,
          status: state.editStatus.get(edit.id) ?? "todo",
        });
      }
    }
  }
  return summaries;
}
