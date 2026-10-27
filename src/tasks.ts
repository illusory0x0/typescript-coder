/**
 * The plan/execute work-graph contract (`docs/plan-exec.md`). The planning model
 * emits a flat reply of `node` and `amend` records (`src/plan-dsl.ts`); this
 * module owns the Plan/WorkNode types, validates the DAG, and applies one reply
 * to the harness-owned run state.
 *
 * A WorkNode is one unit of work with a verification boundary: its gate runs
 * after the executor has applied the node's edits. The planner owns the
 * decomposition, dependencies, verification boundary, instruction, target hints,
 * and an optional advisory approach; the executor owns the concrete edit actions
 * and their granularity. `after` edges define readiness; record order is the
 * deterministic tie-break among ready nodes.
 *
 * The graph is append plus one narrow mutation: an `amend` may revise a pending,
 * failed, or just-reviewed node. There is no delete, no `finish` marker, and no
 * general patch algebra. Run success is derived from the scheduler and the last
 * gate: no node is ready and the most recent gate was a passing `test`.
 *
 * `HintLoc.kind` is the TypeScript symbol space (`value` | `type` | `namespace`),
 * matching the edit-dsl `resolve` vocabulary, or `file` for a whole-file target.
 * A file hint uses `symbol: ""`. Hints are guidance, not a hard allowlist.
 */
import type { SymbolSpace } from "./utility";

/**
 * A globally unique node id: two or more digits, a hyphen, then a lowercase
 * kebab-case slug (`"01-main"`, `"02-scaffold"`, `"03-impl"`).
 */
export type NodeId = string;

/** The wire form of a node id. */
export const NODE_ID_PATTERN = /^[0-9]{2,}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The verification gate a work node runs after its edits settle. */
export const WORK_VERIFIES = ["tsc", "test"] as const;
export type WorkVerify = (typeof WORK_VERIFIES)[number];

/** The TypeScript symbol spaces a hint can target (edit-dsl `resolve`). */
export const HINT_SPACES: readonly SymbolSpace[] = ["value", "type", "namespace"];

/**
 * Harness-owned run state for one work node. `review` is a driver phase, not a
 * graph status; a node is `pending` while it executes and only settles as
 * `passed` or `failed`.
 */
export const NODE_STATUSES = ["pending", "passed", "failed"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/** True only for a settled node. */
export function isTerminalNodeStatus(status: NodeStatus | undefined): boolean {
  return status === "passed" || status === "failed";
}

/**
 * One target hint: a repo-relative path plus a symbol space and symbol. A file
 * hint uses `kind: "file"` and an empty symbol. The executor may edit outside
 * the hinted paths when the instruction requires it; that is surfaced in review.
 */
export interface HintLoc {
  /** Repo-relative path, inside the workspace. */
  path: string;
  /** Declared identifier; empty for a file hint. */
  symbol: string;
  /** TypeScript symbol space, or `file` for a whole-file target. */
  kind: SymbolSpace | "file";
}

/**
 * One task-level unit of work. The planner chooses the decomposition, its
 * dependency edges, its verification boundary, its instruction, its target
 * hints, and an optional approach hint. The executor chooses the concrete edit
 * actions from the current source and may override the approach hint.
 */
export interface WorkNode {
  id: NodeId;
  /** Dependency node ids; empty means ready at the start. */
  after: NodeId[];
  /** The node's verification gate. */
  verify: WorkVerify;
  /** Self-contained imperative: the executor does not see the requirement. */
  instruction: string;
  /** Advisory target hints (paths/symbols/kind); never a hard allowlist. */
  hints: HintLoc[];
  /**
   * Advisory strategy, e.g. "small file -> whole write" or "large module ->
   * scaffold declarations, then fill bodies". The executor may override it.
   */
  approach?: string;
  /** Optional workflow label (for example "scaffold"); not a scheduling input. */
  phase?: string;
}

/**
 * One reasoning reply: append zero or more nodes, then amend zero or more
 * existing nodes. The initial reply also carries the run goal.
 */
export interface PlanReply {
  goal?: string;
  nodes: WorkNode[];
  amends: NodeAmend[];
}

/**
 * A field-level revision of one node. Omitted fields are preserved; `null`
 * clears an optional field; an empty `after` or `hints` list clears that list.
 */
export interface NodeAmend {
  id: NodeId;
  after?: NodeId[];
  verify?: WorkVerify;
  instruction?: string;
  hints?: HintLoc[];
  approach?: string | null;
  phase?: string | null;
}

/** The most recent gate result; run completion is derived from it. */
export interface GateSnapshot {
  nodeId: NodeId;
  verify: WorkVerify;
  ok: boolean;
}

/** The run state: the work graph plus harness-owned status and gate history. */
export interface PlanRunState {
  /** The whole-requirement goal; planning context for the executor. */
  goal: string;
  /** Work nodes in record order (the deterministic readiness tie-break). */
  nodes: WorkNode[];
  nodeStatus: Map<NodeId, NodeStatus>;
  /** The last gate that ran, or `null` before the first execution. */
  lastGate: GateSnapshot | null;
}

/** Caps the contract enforces before a plan can drive a run. */
export const MAX_PLAN_GOAL_LENGTH = 1_000;
export const MAX_INSTRUCTION_LENGTH = 4_000;
export const MAX_APPROACH_LENGTH = 2_000;
export const MAX_PHASE_LENGTH = 200;

const VERIFY_SET: ReadonlySet<string> = new Set(WORK_VERIFIES);
const SPACE_SET: ReadonlySet<string> = new Set(HINT_SPACES);

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

/** A plan rejection: `stage: plan-protocol` or `stage: plan-graph`. */
export type PlanParse =
  | { ok: true; reply: PlanReply }
  | { ok: false; stage: "plan-protocol" | "plan-graph"; diagnostics: string };

/** A reply-application rejection; always a graph amendment violation. */
export type PlanApply =
  | { ok: true; state: PlanRunState; amended: NodeId[] }
  | { ok: false; diagnostics: string };

/** How one reply may change the graph. */
export interface ApplyOptions {
  /**
   * A review turn may amend only this node and may not append work. Omitted for
   * an ordinary planning turn, where pending and failed nodes are amendable.
   */
  reviewTarget?: NodeId;
  /** The initial reply must carry a non-empty goal. */
  requireGoal?: boolean;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * True for a repo-relative, writable edit path: no absolute path, no `..`, no
 * empty or hidden/build segment, and inside the workspace. Existence is not
 * checked because a hint may target a path that does not exist yet.
 */
export function isSafeHintPath(path: string): boolean {
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

/** Every work node in record order. Accepts a PlanReply or the run state. */
export function allNodes(source: { nodes: readonly WorkNode[] }): WorkNode[] {
  return [...source.nodes];
}

/** The work node with this id, or `undefined`. */
export function nodeById(source: { nodes: readonly WorkNode[] }, id: NodeId): WorkNode | undefined {
  return source.nodes.find((node) => node.id === id);
}

/** Direct dependents of a node, in record order. */
export function dependentsOf(source: { nodes: readonly WorkNode[] }, id: NodeId): WorkNode[] {
  return source.nodes.filter((node) => node.after.includes(id));
}

/**
 * True when a non-terminal node cannot run because a dependency failed (directly
 * or through another blocked dependency). Blocked is derived from status, not
 * stored. A cycle cannot reach here because validation rejects it first; the
 * visited set keeps this helper total even on a malformed graph.
 */
export function isNodeBlocked(state: PlanRunState, node: WorkNode): boolean {
  const status = state.nodeStatus.get(node.id);
  if (status === "passed" || status === "failed") {
    return false;
  }
  const visiting = new Set<NodeId>();
  const blocked = (id: NodeId): boolean => {
    if (visiting.has(id)) {
      return false;
    }
    visiting.add(id);
    const candidate = state.nodeStatus.get(id);
    if (candidate === "failed") {
      return true;
    }
    if (candidate === "passed") {
      return false;
    }
    const dependency = nodeById(state, id);
    if (dependency === undefined) {
      return true;
    }
    return dependency.after.some(blocked);
  };
  return node.after.some(blocked);
}

/** Every blocked non-terminal node, in record order. */
export function blockedNodes(state: PlanRunState): WorkNode[] {
  return state.nodes.filter((node) => isNodeBlocked(state, node));
}

/**
 * Nodes that may run now: pending, not blocked, and with every `after`
 * dependency passed. Record order is the deterministic tie-break.
 */
export function readyNodes(state: PlanRunState): WorkNode[] {
  return state.nodes.filter((node) => {
    if (state.nodeStatus.get(node.id) !== "pending") {
      return false;
    }
    if (isNodeBlocked(state, node)) {
      return false;
    }
    return node.after.every((id) => state.nodeStatus.get(id) === "passed");
  });
}

/** The first ready node in record order; `undefined` when nothing is runnable. */
export function nextReadyNode(state: PlanRunState): WorkNode | undefined {
  return readyNodes(state)[0];
}

/** True when every node is `passed` or `failed`. */
export function allNodesTerminal(state: PlanRunState): boolean {
  return state.nodes.every((node) => isTerminalNodeStatus(state.nodeStatus.get(node.id)));
}

/**
 * The run is green only when no node is runnable and the most recent gate was a
 * passing `test`. Blocked pending nodes are abandoned once the suite is green;
 * earlier failed nodes are superseded in exactly the same way.
 */
export function runComplete(state: PlanRunState): boolean {
  return (
    nextReadyNode(state) === undefined &&
    state.lastGate !== null &&
    state.lastGate.verify === "test" &&
    state.lastGate.ok
  );
}

/**
 * Render the stable graph structure: nodes in record order with their dependency
 * edges, hints, and advisory approach. Status is deliberately absent so this
 * block can stay in the cache-stable prefix.
 */
export function renderNodeTree(source: { nodes: readonly WorkNode[] }): string {
  const lines: string[] = [];
  for (const node of source.nodes) {
    const after = node.after.length === 0 ? "" : ` after=[${node.after.join(", ")}]`;
    const phase = node.phase === undefined ? "" : ` phase=${quote(node.phase)}`;
    lines.push(`@node #${node.id} verify=${node.verify}${after}${phase}`);
    lines.push(`  node: ${node.instruction.replace(/\s*\n\s*/g, " ").trim()}`);
    for (const hint of node.hints) {
      lines.push(`  hint: ${formatHint(hint)}`);
    }
    if (node.approach !== undefined) {
      lines.push(`  approach: ${node.approach.replace(/\s*\n\s*/g, " ").trim()}`);
    }
  }
  return lines.join("\n");
}

/** Render node statuses in record order. */
export function renderNodeStatus(state: PlanRunState): string {
  return state.nodes
    .map((node) => `@node #${node.id} ${state.nodeStatus.get(node.id) ?? "pending"}`)
    .join("\n");
}

/** Render failed nodes with their diagnostics. */
export function renderFailedNodes(
  state: PlanRunState,
  failures: ReadonlyMap<NodeId, string>,
): string {
  const lines: string[] = [];
  for (const node of state.nodes) {
    if (state.nodeStatus.get(node.id) !== "failed") {
      continue;
    }
    lines.push(`@node #${node.id} (${node.verify} gate) failed:`);
    const diagnostics = failures.get(node.id);
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
export function formatHint(loc: HintLoc): string {
  return loc.kind === "file"
    ? `file ${quote(loc.path)}`
    : `${loc.kind} ${quote(loc.symbol)} in ${quote(loc.path)}`;
}

function claimId(id: unknown, where: string, nodeIds: Set<NodeId>, problems: string[]): void {
  if (typeof id !== "string" || !NODE_ID_PATTERN.test(id)) {
    problems.push(
      `${where} must be a string node id "NN-slug" (two or more digits, a hyphen, then a lowercase kebab slug; got ${JSON.stringify(id)})`,
    );
    return;
  }
  if (nodeIds.has(id)) {
    problems.push(`${where} reuses node id ${quote(id)}; work-node ids must be globally unique`);
    return;
  }
  nodeIds.add(id);
}

function textProblems(value: unknown, where: string, maxLength: number, problems: string[]): void {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${where} must be a non-empty string`);
    return;
  }
  if (value.length > maxLength) {
    problems.push(`${where} is ${value.length} characters; keep it at most ${maxLength}`);
  }
}

function hintProblems(node: WorkNode): string[] {
  const problems: string[] = [];
  if (!Array.isArray(node.hints)) {
    return [`node #${node.id}.hints must be an array of target hints`];
  }
  const seen = new Set<string>();
  for (const hint of node.hints) {
    if (typeof hint.path !== "string" || !isSafeHintPath(hint.path)) {
      problems.push(
        `node #${node.id} hint targets ${quote(String(hint.path))}, which is not a writable repo-relative path (no absolute path, "..", hidden/build segment, or human/)`,
      );
      continue;
    }
    if (!SPACE_SET.has(hint.kind) && hint.kind !== "file") {
      problems.push(
        `node #${node.id} hint ${formatHint(hint)} must use kind value, type, namespace, or file`,
      );
      continue;
    }
    if (hint.kind === "file") {
      if (hint.symbol !== "") {
        problems.push(
          `node #${node.id} hint ${formatHint(hint)} is a file hint but carries symbol ${quote(hint.symbol)}; a file hint uses symbol ""`,
        );
        continue;
      }
    } else if (typeof hint.symbol !== "string" || hint.symbol.trim() === "") {
      problems.push(
        `node #${node.id} hint in ${quote(hint.path)} has an empty symbol; use kind "file" for a whole-file hint`,
      );
      continue;
    }
    const key = `${hint.kind}\u0000${hint.symbol}\u0000${hint.path}`;
    if (seen.has(key)) {
      problems.push(`node #${node.id} lists hint ${formatHint(hint)} more than once`);
      continue;
    }
    seen.add(key);
  }
  return problems;
}

/**
 * Every cycle among `after` edges, each reported once with the node ids in the
 * cycle so the diagnostic can name them.
 */
function cycleProblems(nodes: readonly WorkNode[]): string[] {
  const byId = new Map<NodeId, WorkNode>(nodes.map((node) => [node.id, node]));
  const state = new Map<NodeId, 0 | 1 | 2>();
  const stack: NodeId[] = [];
  const problems: string[] = [];

  const visit = (id: NodeId): void => {
    const color = state.get(id) ?? 0;
    if (color === 2) {
      return;
    }
    if (color === 1) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      problems.push(`after edges form a cycle: ${cycle.map((entry) => `#${entry}`).join(" -> ")}`);
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const dependency of byId.get(id)?.after ?? []) {
      if (dependency !== id && byId.has(dependency)) {
        visit(dependency);
      }
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const node of nodes) {
    if ((state.get(node.id) ?? 0) === 0) {
      visit(node.id);
    }
  }
  return problems;
}

/**
 * Validate a complete graph. `goal` is `null` for an incremental reply, where
 * the run goal is already established. Each returned string is one problem.
 */
function graphProblems(goal: string | null, nodes: readonly WorkNode[]): string[] {
  const problems: string[] = [];
  const nodeIds = new Set<NodeId>();
  if (goal !== null) {
    textProblems(goal, "plan.goal", MAX_PLAN_GOAL_LENGTH, problems);
  }

  if (nodes.length === 0) {
    problems.push("the plan must contain at least one work node");
  }

  for (const node of nodes) {
    claimId(node.id, `node #${String(node.id)}.id`, nodeIds, problems);
    if (!VERIFY_SET.has(node.verify)) {
      problems.push(
        `node #${node.id}.verify must be "tsc" or "test" (got ${quote(String(node.verify))})`,
      );
    }
    textProblems(
      node.instruction,
      `node #${node.id}.instruction`,
      MAX_INSTRUCTION_LENGTH,
      problems,
    );
    if (node.approach !== undefined) {
      textProblems(node.approach, `node #${node.id}.approach`, MAX_APPROACH_LENGTH, problems);
    }
    if (node.phase !== undefined) {
      textProblems(node.phase, `node #${node.id}.phase`, MAX_PHASE_LENGTH, problems);
    }
    if (!Array.isArray(node.after)) {
      problems.push(`node #${node.id}.after must be an array of node ids`);
    } else {
      const seen = new Set<NodeId>();
      for (const dependency of node.after) {
        if (typeof dependency !== "string" || !NODE_ID_PATTERN.test(dependency)) {
          problems.push(
            `node #${node.id} after entry ${JSON.stringify(dependency)} is not a node id "NN-slug"`,
          );
          continue;
        }
        if (dependency === node.id) {
          problems.push(
            `node #${node.id} lists itself in after; a dependency edge must point at another node`,
          );
          continue;
        }
        if (seen.has(dependency)) {
          problems.push(`node #${node.id} lists dependency #${dependency} more than once in after`);
          continue;
        }
        seen.add(dependency);
      }
    }
    problems.push(...hintProblems(node));
  }

  const known = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    if (!Array.isArray(node.after)) {
      continue;
    }
    for (const dependency of node.after) {
      if (typeof dependency === "string" && !known.has(dependency)) {
        problems.push(`node #${node.id} depends on #${dependency}, which is not in the plan`);
      }
    }
  }

  problems.push(...cycleProblems(nodes));
  return problems;
}

/** Validate the full run graph, including the goal; `null` when valid. */
export function validatePlan(goal: string, nodes: readonly WorkNode[]): string | null {
  const problems = graphProblems(goal, nodes);
  return problems.length === 0 ? null : problems.map((problem) => `- ${problem}`).join("\n");
}

/** Validate a graph fragment without a goal; `null` when valid. */
export function validateNodes(nodes: readonly WorkNode[]): string | null {
  const problems = graphProblems(null, nodes);
  return problems.length === 0 ? null : problems.map((problem) => `- ${problem}`).join("\n");
}

/** Build the run state from a freshly parsed initial reply (every node pending). */
export function initialState(reply: PlanReply): PlanRunState {
  return {
    goal: reply.goal ?? "",
    nodes: cloneNodes(reply.nodes),
    nodeStatus: new Map(reply.nodes.map((node) => [node.id, "pending" as NodeStatus])),
    lastGate: null,
  };
}

function cloneHints(hints: readonly HintLoc[]): HintLoc[] {
  return hints.map((hint) => ({ ...hint }));
}

function cloneNode(node: WorkNode): WorkNode {
  return {
    id: node.id,
    after: [...node.after],
    verify: node.verify,
    instruction: node.instruction,
    hints: cloneHints(node.hints),
    ...(node.approach === undefined ? {} : { approach: node.approach }),
    ...(node.phase === undefined ? {} : { phase: node.phase }),
  };
}

function cloneNodes(nodes: readonly WorkNode[]): WorkNode[] {
  return nodes.map(cloneNode);
}

function sameWorkNode(a: WorkNode, b: WorkNode): boolean {
  return (
    a.verify === b.verify &&
    a.instruction === b.instruction &&
    a.approach === b.approach &&
    a.phase === b.phase &&
    a.after.length === b.after.length &&
    a.after.every((id, index) => id === b.after[index]) &&
    a.hints.length === b.hints.length &&
    a.hints.every((hint, index) => {
      const other = b.hints[index];
      return (
        other !== undefined &&
        hint.path === other.path &&
        hint.symbol === other.symbol &&
        hint.kind === other.kind
      );
    })
  );
}

/**
 * Apply one amend to a node. Omitted fields are preserved; `null` clears an
 * optional field; an empty `after`/`hints` list clears that list. Returns `null`
 * when the amendment changes nothing.
 */
function amendedNode(node: WorkNode, amend: NodeAmend): WorkNode | null {
  const approach =
    amend.approach === undefined
      ? node.approach
      : amend.approach === null
        ? undefined
        : amend.approach;
  const phase =
    amend.phase === undefined ? node.phase : amend.phase === null ? undefined : amend.phase;
  const next: WorkNode = {
    id: node.id,
    after: amend.after === undefined ? [...node.after] : [...amend.after],
    verify: amend.verify ?? node.verify,
    instruction: amend.instruction ?? node.instruction,
    hints: amend.hints === undefined ? cloneHints(node.hints) : cloneHints(amend.hints),
    ...(approach === undefined ? {} : { approach }),
    ...(phase === undefined ? {} : { phase }),
  };
  return sameWorkNode(node, next) ? null : next;
}

function applyProblems(problems: readonly string[]): PlanApply {
  const code = problems.some((problem) => problem.includes("reuses node id"))
    ? "PLAN_DUPLICATE_ID"
    : problems.some((problem) => problem.includes("cycle"))
      ? "PLAN_CYCLE"
      : problems.some((problem) => problem.includes("not in the plan"))
        ? "PLAN_UNKNOWN_PARENT"
        : "PLAN_STRUCTURE";
  return {
    ok: false,
    diagnostics: `stage: plan-graph\ncode: ${code}\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
  };
}

/**
 * Apply one parsed reply to the run state. Structure is all-or-nothing: a
 * rejected reply leaves `previous` untouched. Append adds nodes after the
 * existing record order; amend revises a pending or failed node, or the current
 * review target. Passed nodes are immutable, and a review reply cannot append.
 */
export function applyPlanReply(
  previous: PlanRunState,
  reply: PlanReply,
  options: ApplyOptions = {},
): PlanApply {
  const problems: string[] = [];
  // The run goal is fixed by the initial reply; a later reply may echo it, but
  // it does not rewrite the run's goal.
  const goal = options.requireGoal === true ? (reply.goal ?? "") : previous.goal;
  if (options.requireGoal === true && (reply.goal === undefined || reply.goal.trim() === "")) {
    problems.push("the initial plan needs a non-empty goal: field");
  }
  if (reply.nodes.length === 0 && reply.amends.length === 0) {
    problems.push(
      "the reply carries no node or amend record; append work or revise a pending or failed node",
    );
  }
  if (options.reviewTarget !== undefined && reply.nodes.length > 0) {
    problems.push(
      "a review reply may not add nodes; reply with approve or one amend for the reviewed node",
    );
  }

  const nodes = cloneNodes(previous.nodes);
  const nodeStatus = new Map(previous.nodeStatus);
  const amended: NodeId[] = [];

  for (const node of reply.nodes) {
    if (nodes.some((candidate) => candidate.id === node.id)) {
      problems.push(
        `node #${node.id} reuses node id ${quote(node.id)}; work-node ids must be unique`,
      );
      continue;
    }
    nodes.push(cloneNode(node));
    nodeStatus.set(node.id, "pending");
  }

  for (const amend of reply.amends) {
    const index = nodes.findIndex((node) => node.id === amend.id);
    if (index === -1) {
      problems.push(`amend names node #${amend.id}, which is not in the graph`);
      continue;
    }
    const current = nodes[index];
    if (current === undefined) {
      problems.push(`amend names node #${amend.id}, which is not in the graph`);
      continue;
    }
    const status = nodeStatus.get(amend.id) ?? "pending";
    if (options.reviewTarget !== undefined) {
      if (amend.id !== options.reviewTarget) {
        problems.push(
          `a review reply may amend only #${options.reviewTarget}; #${amend.id} is not the reviewed node`,
        );
        continue;
      }
    } else if (status === "passed") {
      problems.push(`passed node #${amend.id} is immutable; add repair work in a new node`);
      continue;
    }
    const next = amendedNode(current, amend);
    if (next === null) {
      problems.push(`amend #${amend.id} changes nothing`);
      continue;
    }
    nodes[index] = next;
    if (status === "failed") {
      nodeStatus.set(amend.id, "pending");
    }
    amended.push(amend.id);
  }

  const graphIssues = validatePlan(goal, nodes);
  if (graphIssues !== null) {
    problems.push(
      ...graphIssues
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2)),
    );
  }
  if (problems.length > 0) {
    return applyProblems(problems);
  }

  return {
    ok: true,
    state: {
      goal,
      nodes,
      nodeStatus,
      // A review amend reopens a node whose gate had passed; that gate no
      // longer certifies the graph until the node passes again.
      lastGate: options.reviewTarget === undefined ? previous.lastGate : null,
    },
    amended,
  };
}

/** The per-node result summary a plan/execute run reports (string node ids). */
export interface NodeSummary {
  id: NodeId;
  verify: WorkVerify;
  status: NodeStatus;
  phase?: string;
  approach?: string;
}

/** Snapshot the run state as the result's per-node summary, in record order. */
export function summaryOf(state: PlanRunState): NodeSummary[] {
  return state.nodes.map((node) => ({
    id: node.id,
    verify: node.verify,
    status: state.nodeStatus.get(node.id) ?? "pending",
    ...(node.phase === undefined ? {} : { phase: node.phase }),
    ...(node.approach === undefined ? {} : { approach: node.approach }),
  }));
}
