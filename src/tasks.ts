/**
 * The plan/execute task contract (`docs/spec.md`). The planning model emits a
 * `TaskPlan` as JSON; this module parses it strictly, validates the edit-task
 * DAG, and owns the scheduling state the harness (never the model) advances.
 *
 * Wire shape (the `status` object maps a task id to its status):
 *
 * ```json
 * {
 *   "tasks": [
 *     {
 *       "id": 1,
 *       "loc": { "path": "src/helper.ts", "symbol": "answer", "kind": "value" },
 *       "deps": [],
 *       "action": "modify",
 *       "instruction": "Change answer to return 2."
 *     }
 *   ],
 *   "todo": [1],
 *   "status": { "1": "todo" }
 * }
 * ```
 *
 * `Loc.kind` is the TypeScript symbol space (`value` | `type` | `namespace`),
 * matching the edit-dsl `resolve` vocabulary; the declaration kind is looked up
 * from the index by address resolution.
 */
import { extractJsonObject } from "./matcher";
import type { SymbolSpace } from "./utility";

export type TaskId = number;

/** The one edit action a task asks for. */
export const TASK_ACTIONS = ["modify", "create", "delete", "rename"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/** Run state owned by the harness; the planner only echoes it. */
export const TASK_STATUSES = ["todo", "in-progress", "done", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskLoc {
  /** Repo-relative path, inside the workspace. */
  path: string;
  /** Declared identifier (or the name a `create` adds). */
  symbol: string;
  /** TypeScript symbol space, not the declaration kind. */
  kind: SymbolSpace;
}

export interface EditTask {
  id: TaskId;
  loc: TaskLoc;
  /** Organizational grouping only; never orders execution. Omitted = root. */
  parent?: TaskId;
  /** Execution-order edges. Every dependency must finish first. */
  deps: TaskId[];
  action: TaskAction;
  /** Self-contained imperative: the executor does not see the requirement. */
  instruction: string;
  /** Required exactly when `action` is `rename`. */
  renameTo?: string;
}

/** One parsed planning reply. */
export interface TaskPlan {
  tasks: EditTask[];
  /** Ordered ready frontier the planner wants executed first. */
  todo: TaskId[];
  /** The planner's echo of the harness status map. */
  status: ReadonlyMap<TaskId, TaskStatus>;
}

/** The scheduling state: the DAG plus the harness-owned status map. */
export interface TaskRunState {
  tasks: EditTask[];
  status: Map<TaskId, TaskStatus>;
}

/** Caps the contract enforces before a plan can drive a run. */
export const MAX_TASKS = 64;
export const MAX_INSTRUCTION_LENGTH = 4_000;

const TASK_KEYS: ReadonlySet<string> = new Set([
  "id",
  "loc",
  "parent",
  "deps",
  "action",
  "instruction",
  "renameTo",
]);
const LOC_KEYS: ReadonlySet<string> = new Set(["path", "symbol", "kind"]);
const PLAN_KEYS: ReadonlySet<string> = new Set(["tasks", "todo", "status"]);
const SPACES: ReadonlySet<string> = new Set(["value", "type", "namespace"]);
const STATUS_SET: ReadonlySet<string> = new Set(TASK_STATUSES);

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

/** A plan rejection: `stage: task-protocol` or `stage: task-dag`. */
export type TaskPlanParse =
  | { ok: true; plan: TaskPlan }
  | { ok: false; stage: "task-protocol" | "task-dag"; diagnostics: string };

/** A re-plan merge rejection; always a DAG amendment violation. */
export type TaskPlanMerge =
  | { ok: true; state: TaskRunState }
  // A stale echo (the harness already advanced past it) is recoverable: the
  // harness's own status is the truth. Anything structural is not.
  | { ok: false; diagnostics: string; stale?: boolean };

function protocol(detail: string): TaskPlanParse {
  return { ok: false, stage: "task-protocol", diagnostics: `stage: task-protocol\n${detail}` };
}

function dag(detail: string): TaskPlanParse {
  return { ok: false, stage: "task-dag", diagnostics: `stage: task-dag\n${detail}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * True for a repo-relative, writable task path: no absolute path, no `..`,
 * no empty or hidden/build segment, and inside the workspace. Existence is not
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

/**
 * The tasks whose dependencies are all `done` and whose own status is `todo`,
 * in task order (the plan's priority). This is the only execution frontier:
 * a `todo` list the planner emits is validated against it, never trusted.
 */
export function readyFrontier(state: TaskRunState): TaskId[] {
  const done = new Set<TaskId>();
  for (const task of state.tasks) {
    if (state.status.get(task.id) === "done") {
      done.add(task.id);
    }
  }
  return state.tasks
    .filter(
      (task) => state.status.get(task.id) === "todo" && task.deps.every((dep) => done.has(dep)),
    )
    .map((task) => task.id);
}

/** True when every task is `done`. */
export function allTasksDone(state: TaskRunState): boolean {
  return state.tasks.every((task) => state.status.get(task.id) === "done");
}

/** The highest id in the DAG, or 0 for an empty one. */
export function maxTaskId(state: TaskRunState): TaskId {
  let max = 0;
  for (const task of state.tasks) {
    max = Math.max(max, task.id);
  }
  return max;
}

/**
 * Render the stable DAG structure: one line per task with its action, space,
 * address, deps, and instruction. Children are indented under their parent
 * (any depth). Status is deliberately absent so this block can stay in the
 * cache-stable prefix.
 */
export function renderTaskDag(tasks: readonly EditTask[]): string {
  const lines: string[] = [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const rendered = new Set<TaskId>();
  const render = (task: EditTask, indent: string): void => {
    if (rendered.has(task.id)) {
      return;
    }
    rendered.add(task.id);
    const dep = task.deps.length === 0 ? "none" : task.deps.join(", ");
    const rename = task.renameTo === undefined ? "" : ` renameTo=${quote(task.renameTo)}`;
    lines.push(
      `${indent}- #${task.id} ${task.action} ${task.loc.kind} ${quote(task.loc.symbol)} in ${quote(task.loc.path)} (deps: ${dep})${rename}`,
    );
    lines.push(`${indent}  ${task.instruction.replace(/\s*\n\s*/g, " ").trim()}`);
    for (const child of tasks.filter((candidate) => candidate.parent === task.id)) {
      render(child, `${indent}  `);
    }
  };
  for (const task of tasks) {
    if (task.parent === undefined || !byId.has(task.parent)) {
      render(task, "");
    }
  }
  // A malformed plan is never rendered, but a partial merge may leave a child
  // whose parent is absent; show it rather than losing it.
  for (const task of tasks) {
    render(task, "");
  }
  return lines.join("\n");
}

/** Render `#<id> <status>` for every task, in task order. */
export function renderTaskStatus(state: TaskRunState): string {
  return state.tasks.map((task) => `#${task.id} ${state.status.get(task.id) ?? "todo"}`).join("\n");
}

/** Render the failed tasks with the diagnostics that failed them. */
export function renderFailedTasks(
  state: TaskRunState,
  failures: ReadonlyMap<TaskId, string>,
): string {
  const lines: string[] = [];
  for (const task of state.tasks) {
    if (state.status.get(task.id) !== "failed") {
      continue;
    }
    lines.push(
      `#${task.id} ${task.action} ${quote(task.loc.symbol)} in ${quote(task.loc.path)} failed:`,
    );
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

function readId(value: unknown, where: string, problems: string[]): TaskId | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    problems.push(`${where} must be a positive integer task id (got ${JSON.stringify(value)})`);
    return null;
  }
  return value;
}

function readIdList(value: unknown, where: string, problems: string[]): TaskId[] | null {
  if (!Array.isArray(value)) {
    problems.push(`${where} must be an array of task ids`);
    return null;
  }
  const ids: TaskId[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const id = readId(value[index], `${where}[${index}]`, problems);
    if (id !== null) {
      ids.push(id);
    }
  }
  return ids;
}

function readTask(loc: TaskLoc, raw: unknown, index: number, problems: string[]): EditTask | null {
  const where = `tasks[${index}]`;
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  const extra = Object.keys(raw).filter((key) => !TASK_KEYS.has(key));
  if (extra.length > 0) {
    problems.push(
      `${where} carries unexpected key(s) ${extra.map(quote).join(", ")}; allowed keys are id, loc, parent, deps, action, instruction, renameTo`,
    );
    return null;
  }
  const id = readId(raw["id"], `${where}.id`, problems);
  if (id === null) {
    return null;
  }
  const rawDeps = raw["deps"];
  let deps: TaskId[] = [];
  if (rawDeps !== undefined) {
    const read = readIdList(rawDeps, `${where}.deps`, problems);
    if (read === null) {
      return null;
    }
    deps = read;
  }
  let parent: TaskId | undefined;
  if (raw["parent"] !== undefined && raw["parent"] !== null) {
    const read = readId(raw["parent"], `${where}.parent`, problems);
    if (read === null) {
      return null;
    }
    parent = read;
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
    loc,
    ...(parent === undefined ? {} : { parent }),
    deps,
    action: action as TaskAction,
    instruction: instruction.trim(),
    ...(renameTo === undefined ? {} : { renameTo }),
  };
}

function readLoc(raw: unknown, where: string, problems: string[]): TaskLoc | null {
  if (!isRecord(raw)) {
    problems.push(`${where}.loc must be an object {"path": ..., "symbol": ..., "kind": ...}`);
    return null;
  }
  const extra = Object.keys(raw).filter((key) => !LOC_KEYS.has(key));
  if (extra.length > 0) {
    problems.push(
      `${where}.loc carries unexpected key(s) ${extra.map(quote).join(", ")}; allowed keys are path, symbol, kind`,
    );
    return null;
  }
  const path = raw["path"];
  const symbol = raw["symbol"];
  const kind = raw["kind"];
  if (typeof path !== "string" || path === "") {
    problems.push(`${where}.loc.path must be a non-empty string`);
    return null;
  }
  if (typeof symbol !== "string" || symbol.trim() === "") {
    problems.push(`${where}.loc.symbol must be a non-empty string`);
    return null;
  }
  if (typeof kind !== "string" || !SPACES.has(kind)) {
    problems.push(
      `${where}.loc.kind must be the TypeScript symbol space "value", "type", or "namespace" (got ${JSON.stringify(kind)})`,
    );
    return null;
  }
  return { path, symbol: symbol.trim(), kind: kind as SymbolSpace };
}

/** Parse the `{"<id>": "<status>"}` status object. */
function readStatus(
  raw: unknown,
  where: string,
  problems: string[],
): Map<TaskId, TaskStatus> | null {
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object mapping task ids to statuses`);
    return null;
  }
  const status = new Map<TaskId, TaskStatus>();
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[1-9]\d*$/.test(key)) {
      problems.push(`${where} carries ${quote(key)}, which is not a positive integer task id`);
      return null;
    }
    if (typeof value !== "string" || !STATUS_SET.has(value)) {
      problems.push(
        `${where}[${quote(key)}] must be one of ${TASK_STATUSES.map(quote).join(", ")} (got ${JSON.stringify(value)})`,
      );
      return null;
    }
    status.set(Number(key), value as TaskStatus);
  }
  return status;
}

// ---------------------------------------------------------------------------
// DAG validation (shared by the initial plan and the re-plan merge)

interface DagIssue {
  task: EditTask;
  problem: string;
}

/**
 * Structural graph checks: duplicate ids, reference integrity, and acyclicity
 * of both the `deps` graph and the `parent` graph. `extraIds` names ids a
 * merge requires but the plan does not declare (reported by the caller).
 */
function graphIssues(tasks: readonly EditTask[]): DagIssue[] {
  const issues: DagIssue[] = [];
  const byId = new Map<TaskId, EditTask>();
  for (const task of tasks) {
    if (byId.has(task.id)) {
      issues.push({ task, problem: `task id #${task.id} is declared more than once` });
      continue;
    }
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (dep === task.id) {
        issues.push({ task, problem: `#${task.id} lists itself as a dependency` });
      } else if (!byId.has(dep)) {
        issues.push({ task, problem: `#${task.id} depends on #${dep}, which is not a task` });
      }
    }
    if (new Set(task.deps).size !== task.deps.length) {
      issues.push({ task, problem: `#${task.id} lists the same dependency more than once` });
    }
    if (task.parent === task.id) {
      issues.push({ task, problem: `#${task.id} is its own parent` });
    } else if (task.parent !== undefined && !byId.has(task.parent)) {
      issues.push({ task, problem: `#${task.id} has parent #${task.parent}, which is not a task` });
    }
  }
  issues.push(...cycleIssues(tasks, byId, "dependency", (task) => task.deps));
  issues.push(
    ...cycleIssues(tasks, byId, "parent", (task) =>
      task.parent === undefined ? [] : [task.parent],
    ),
  );
  return issues;
}

function cycleIssues(
  tasks: readonly EditTask[],
  byId: ReadonlyMap<TaskId, EditTask>,
  label: string,
  edges: (task: EditTask) => readonly TaskId[],
): DagIssue[] {
  const state = new Map<TaskId, "visiting" | "done">();
  const stack: TaskId[] = [];
  const issues: DagIssue[] = [];
  const reported = new Set<string>();
  const visit = (id: TaskId): void => {
    const current = state.get(id);
    if (current === "done") {
      return;
    }
    if (current === "visiting") {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      const key = cycle.join(">");
      if (!reported.has(key)) {
        reported.add(key);
        const task = byId.get(id);
        if (task !== undefined) {
          issues.push({
            task,
            problem: `the ${label} cycle ${cycle.map((n) => `#${n}`).join(" -> ")} is not allowed`,
          });
        }
      }
      return;
    }
    state.set(id, "visiting");
    stack.push(id);
    const task = byId.get(id);
    for (const next of task === undefined ? [] : edges(task)) {
      if (byId.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const task of tasks) {
    visit(task.id);
  }
  return issues;
}

function locProblems(task: EditTask): string | null {
  if (!isSafeTaskPath(task.loc.path)) {
    return `#${task.id} targets ${quote(task.loc.path)}, which is not a writable repo-relative path (no absolute path, "..", hidden/build segment, or human/)`;
  }
  if (task.action === "rename") {
    if (task.renameTo === undefined) {
      return `#${task.id} is a rename but carries no renameTo`;
    }
    if (task.renameTo === task.loc.symbol) {
      return `#${task.id} renames ${quote(task.loc.symbol)} to itself; a rename must change the name`;
    }
    if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(task.renameTo)) {
      return `#${task.id} renameTo ${quote(task.renameTo)} is not a TypeScript identifier or dotted path`;
    }
  } else if (task.renameTo !== undefined) {
    return `#${task.id} carries renameTo but its action is ${quote(task.action)}; renameTo is allowed only with action "rename"`;
  }
  return null;
}

function checkTodo(
  todo: readonly TaskId[],
  status: ReadonlyMap<TaskId, TaskStatus>,
  frontier: readonly TaskId[],
  problems: string[],
): void {
  const seen = new Set<TaskId>();
  for (const id of todo) {
    if (seen.has(id)) {
      problems.push(`todo lists #${id} more than once`);
      return;
    }
    seen.add(id);
    const taskStatus = status.get(id);
    if (taskStatus !== "todo") {
      problems.push(
        `todo lists #${id}, whose status is ${taskStatus === undefined ? "missing" : quote(taskStatus)}; todo may list only todo tasks`,
      );
      return;
    }
  }
  const frontierSet = new Set(frontier);
  for (const id of frontier) {
    if (!seen.has(id)) {
      problems.push(
        `todo omits #${id}, whose dependencies are all done; todo must be exactly the ready frontier (${frontier.join(", ")})`,
      );
      return;
    }
  }
  for (const id of todo) {
    if (!frontierSet.has(id)) {
      problems.push(`todo lists #${id} before its dependencies are done`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Parse one planning reply without judging it as a first plan: the wire shape,
 * ids, dep/parent references, acyclicity, locs, action/rename pairing, and
 * status coverage. Both the initial plan and a re-plan come through here; the
 * initial-plan-only rules (every task starts `todo`) live in `readInitialPlan`.
 */
export function readPlan(content: string): TaskPlanParse {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(content);
  } catch (error) {
    return protocol(
      `expected a JSON object {"tasks": [...], "todo": [...], "status": {...}}; ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    return protocol(
      'expected a JSON object {"tasks": [...], "todo": [...], "status": {...}}; got a JSON value that is not an object',
    );
  }
  const extra = Object.keys(parsed).filter((key) => !PLAN_KEYS.has(key));
  if (extra.length > 0) {
    return protocol(
      `the plan carries unexpected key(s) ${extra.map(quote).join(", ")}; send only "tasks", "todo", and "status"`,
    );
  }
  const rawTasks = parsed["tasks"];
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    return protocol('"tasks" must be a non-empty array of task objects');
  }
  if (rawTasks.length > MAX_TASKS) {
    return protocol(
      `the plan carries ${rawTasks.length} tasks; at most ${MAX_TASKS} are allowed (split the requirement into a later DAG)`,
    );
  }
  const problems: string[] = [];
  const tasks: EditTask[] = [];
  for (let index = 0; index < rawTasks.length; index += 1) {
    const raw = rawTasks[index];
    const loc = isRecord(raw) ? readLoc(raw["loc"], `tasks[${index}]`, problems) : null;
    if (loc === null) {
      if (!isRecord(raw)) {
        problems.push(`tasks[${index}] must be an object`);
      }
      continue;
    }
    const task = readTask(loc, raw, index, problems);
    if (task !== null) {
      tasks.push(task);
    }
  }
  const todo = readIdList(parsed["todo"], "todo", problems);
  const status = readStatus(parsed["status"], "status", problems);
  if (problems.length > 0 || todo === null || status === null) {
    return protocol(
      `the plan is not a valid task plan:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  }
  const dagProblems: string[] = [];
  for (const issue of graphIssues(tasks)) {
    dagProblems.push(issue.problem);
  }
  for (const task of tasks) {
    const problem = locProblems(task);
    if (problem !== null) {
      dagProblems.push(problem);
    }
  }
  const ids = new Set(tasks.map((task) => task.id));
  for (const id of status.keys()) {
    if (!ids.has(id)) {
      dagProblems.push(`status names #${id}, which is not a task`);
    }
  }
  for (const task of tasks) {
    if (!status.has(task.id)) {
      dagProblems.push(`status omits #${task.id}; every task needs a status`);
    }
  }
  if (todo.some((id) => !ids.has(id))) {
    dagProblems.push(`todo names a task id that does not exist (${todo.join(", ")})`);
  }
  for (const [id, value] of status) {
    if (value === "in-progress") {
      dagProblems.push(
        `#${id} is "in-progress" in a planning reply; the planner emits only "todo", "done", or "failed" (the harness owns in-progress)`,
      );
    }
    if (value === "done") {
      const task = tasks.find((candidate) => candidate.id === id);
      const pending = (task?.deps ?? []).filter((dep) => status.get(dep) !== "done");
      if (pending.length > 0) {
        dagProblems.push(
          `#${id} is done but its dependencies ${pending.map((n) => `#${n}`).join(", ")} are not`,
        );
      }
    }
  }
  if (dagProblems.length > 0) {
    return dag(dagProblems.map((problem) => `- ${problem}`).join("\n"));
  }
  return { ok: true, plan: { tasks, todo, status } };
}

/**
 * Parse and validate the planner's initial reply. A protocol error names the
 * field to fix; a DAG error names the graph violation. Never partially accepts.
 */
export function parseTaskPlan(content: string): TaskPlanParse {
  const read = readPlan(content);
  if (!read.ok) {
    return read;
  }
  const { tasks, todo, status } = read.plan;
  const problems: string[] = [];
  const initial = new Map<TaskId, TaskStatus>();
  for (const task of tasks) {
    if (status.get(task.id) !== "todo") {
      problems.push(
        `#${task.id} is ${quote(status.get(task.id) ?? "missing")} in the first plan; every task of a new DAG starts "todo"`,
      );
    }
    initial.set(task.id, "todo");
  }
  if (problems.length === 0) {
    checkTodo(todo, initial, readyFrontier({ tasks, status: initial }), problems);
  }
  if (problems.length > 0) {
    return dag(problems.map((problem) => `- ${problem}`).join("\n"));
  }
  return { ok: true, plan: { tasks, todo, status: initial } };
}

/** Build the run state from a freshly parsed plan (every task starts `todo`). */
export function initialState(plan: TaskPlan): TaskRunState {
  return {
    tasks: plan.tasks,
    status: new Map(plan.tasks.map((task) => [task.id, "todo" as TaskStatus])),
  };
}

function signatureOf(task: EditTask, parent: TaskId | undefined): string {
  return JSON.stringify({
    id: task.id,
    loc: task.loc,
    parent,
    deps: [...task.deps],
    action: task.action,
    instruction: task.instruction,
    renameTo: task.renameTo,
  });
}

/**
 * Merge a re-planning reply into the harness state. The reply re-emits the
 * full task list with stable ids:
 *
 * - a `done` task is immutable (same definition) and cannot be removed;
 * - a `failed` task may be kept as failed, or reset to `todo` only when its
 *   definition changed (the planner's retry of the same failing task is
 *   rejected);
 * - a `todo` task may be amended or removed, but nothing may still depend on
 *   it after removal;
 * - a new task takes an unused id and starts `todo`.
 *
 * The harness recomputes `todo` from the merged graph and rejects a planner
 * list that disagrees with the ready frontier.
 */
export function mergeReplan(previous: TaskRunState, plan: TaskPlan): TaskPlanMerge {
  const problems: string[] = [];
  const previousById = new Map(previous.tasks.map((task) => [task.id, task]));
  const nextIds = new Set(plan.tasks.map((task) => task.id));
  const nextStatus = new Map<TaskId, TaskStatus>();
  const nextTasks: EditTask[] = [];
  const staleEchoes: TaskId[] = [];

  for (const task of plan.tasks) {
    const before = previousById.get(task.id);
    const echo = plan.status.get(task.id);
    if (before === undefined) {
      if (echo !== "todo") {
        problems.push(`new task #${task.id} must have status "todo" (got ${JSON.stringify(echo)})`);
      }
      nextTasks.push(task);
      nextStatus.set(task.id, "todo");
      continue;
    }
    const beforeStatus = previous.status.get(before.id) ?? "todo";
    const changed = signatureOf(before, before.parent) !== signatureOf(task, task.parent);
    if (beforeStatus === "done") {
      if (changed) {
        problems.push(`#${task.id} is done and its definition cannot change`);
      }
      // The harness status is authoritative; a stale echo is tolerated.
      if (echo !== "done") {
        staleEchoes.push(task.id);
      }
      nextTasks.push(changed ? before : task);
      nextStatus.set(before.id, "done");
      continue;
    }
    if (beforeStatus === "in-progress") {
      problems.push(
        `#${task.id} is in progress and the harness holds it until the task finishes; a re-plan cannot re-describe it`,
      );
      continue;
    }
    if (beforeStatus === "failed") {
      if (echo === "failed") {
        if (changed) {
          problems.push(
            `#${task.id} is failed; to retry it, set status "todo" (an amending reply) or leave it unchanged as "failed"`,
          );
          continue;
        }
        nextTasks.push(task);
        nextStatus.set(task.id, "failed");
        continue;
      }
      if (echo !== "todo") {
        problems.push(
          `#${task.id} is failed; echo status "failed" (keep it), or "todo" with a changed definition to retry it, or omit the task to drop it (got ${JSON.stringify(echo)})`,
        );
        continue;
      }
      if (!changed) {
        problems.push(
          `#${task.id} is failed; retrying it requires a changed definition (a different loc, action, instruction, or deps), not the same failing task`,
        );
        continue;
      }
      nextTasks.push(task);
      nextStatus.set(task.id, "todo");
      continue;
    }
    // The task was todo or blocked. A blocked task (deps not done) cannot be
    // reset; an in-progress echo is always a protocol error.
    if (echo === "in-progress") {
      problems.push(
        `#${task.id} is "in-progress" in a planning reply; the harness owns that status`,
      );
      continue;
    }
    if (echo !== "todo") {
      problems.push(
        `#${task.id} is todo in the harness state; echo status "todo" (got ${JSON.stringify(echo)})`,
      );
      continue;
    }
    nextTasks.push(task);
    nextStatus.set(task.id, "todo");
  }

  // Per-placement new-task ids are checked while walking `plan.tasks`; an id
  // that never existed is new by construction and starts todo.

  for (const before of previous.tasks) {
    if (nextIds.has(before.id)) {
      continue;
    }
    const beforeStatus = previous.status.get(before.id) ?? "todo";
    if (beforeStatus === "done") {
      problems.push(`done task #${before.id} cannot be removed by a re-plan`);
      continue;
    }
    const dependent = plan.tasks.find((task) => task.deps.includes(before.id));
    if (dependent !== undefined) {
      problems.push(`#${before.id} was removed but #${dependent.id} still depends on it`);
    }
  }

  const state: TaskRunState = { tasks: nextTasks, status: nextStatus };
  if (problems.length === 0) {
    for (const issue of graphIssues(nextTasks)) {
      problems.push(issue.problem);
    }
    for (const task of nextTasks) {
      const problem = locProblems(task);
      if (problem !== null) {
        problems.push(problem);
      }
    }
    if (problems.length === 0) {
      // Receiving a plan is what makes work runnable: tasks that already sit on
      // the frontier after a merge are the plan's own todo tasks. The harness
      // recomputes the frontier, so a stale todo list (an omitted ready task or
      // an already-done one) is corrected rather than rejected. Only a *blocked*
      // id — one whose dependencies are not done — is a real contradiction.
      const ready = new Set(readyFrontier(state));
      for (const id of plan.todo) {
        if (nextStatus.get(id) !== "todo") {
          continue;
        }
        if (!ready.has(id)) {
          const task = state.tasks.find((candidate) => candidate.id === id);
          problems.push(
            `todo lists #${id} before its dependencies are done (${
              task?.deps
                .filter((dep) => nextStatus.get(dep) !== "done")
                .map((dep) => `#${dep} is ${nextStatus.get(dep) ?? "todo"}`)
                .join(", ") ?? "unknown"
            })`,
          );
          break;
        }
      }
      if (problems.length === 0) {
        plan.todo.length = 0;
        plan.todo.push(...readyFrontier(state));
      }
    }
  }
  if (problems.length > 0) {
    return {
      ok: false,
      diagnostics: `stage: task-dag\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    };
  }
  // A plan that only repeated an outdated status is accepted with the
  // harness's status; a todo list that named such a task is corrected by the
  // frontier recomputation above. Anything else is a real contradiction.
  if (staleEchoes.length > 0) {
    const badTodo = plan.todo.filter((id) => nextStatus.get(id) !== "todo");
    if (badTodo.length > 0) {
      return {
        ok: false,
        stale: true,
        diagnostics: `stage: task-dag\n- todo lists ${badTodo.map((id) => `#${id}`).join(", ")}, whose harness status is not "todo"; todo is the ready frontier after a merge`,
      };
    }
  }
  return { ok: true, state };
}

/** The per-task result summary a plan/execute run reports. */
export interface TaskSummary {
  id: TaskId;
  action: EditTask["action"];
  path: string;
  symbol: string;
  kind: string;
  status: TaskStatus;
}

/** Snapshot the run state as the result's per-task summary. */
export function summaryOf(state: TaskRunState): TaskSummary[] {
  return state.tasks.map((task) => ({
    id: task.id,
    action: task.action,
    path: task.loc.path,
    symbol: task.loc.symbol,
    kind: task.loc.kind,
    status: state.status.get(task.id) ?? "todo",
  }));
}
