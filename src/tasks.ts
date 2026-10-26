/**
 * The plan/execute work-graph contract (`docs/plan-exec.md`). The planning model
 * emits a flat Plan DSL (`src/plan-dsl.ts`); this module owns the Plan/WorkNode
 * types, validates the DAG, and owns the scheduling state the harness (never the
 * model) advances.
 *
 * A WorkNode is one unit of work with a verification boundary: its gate runs
 * after the executor has applied the node's edits. The planner owns the
 * decomposition, dependencies, verification boundary, instruction, target hints,
 * and an optional advisory approach; the executor owns the concrete edit actions
 * and their granularity. `after` edges define readiness; record order is the
 * deterministic tie-break among ready nodes. There are no Stage/Task/Edit
 * records in this contract.
 *
 * `HintLoc.kind` is the TypeScript symbol space (`value` | `type` | `namespace`),
 * matching the edit-dsl `resolve` vocabulary, or `file` for a whole-file target.
 * A file hint uses `symbol: ""`. Hints are guidance, not a hard allowlist.
 */
import type { SymbolSpace } from "./utility";

/**
 * A globally unique node id: two or more digits, a hyphen, then a lowercase
 * kebab-case slug (`"01-main"`, `"02-scaffold"`, `"03-impl"`).
 * Plan and work-node ids share one namespace.
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
 * Harness-owned run state for one work node. `in-progress` means the executor
 * holds the node; `review` means its gate has finished but the planner's
 * post-execution review has not approved it yet.
 */
export const NODE_STATUSES = ["pending", "in-progress", "review", "passed", "failed"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/** True only for a settled node; `review` and `in-progress` are neither runnable nor done. */
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

/** One parsed planning reply. Status is harness-owned and never echoed. */
export interface Plan {
  /** Root node id, unique in the same namespace as every work node. */
  id: NodeId;
  /** The whole-requirement goal; planning context for the executor. */
  goal: string;
  /** Work nodes in record order (the deterministic readiness tie-break). */
  nodes: WorkNode[];
}

/** The run state: the DAG plus harness-owned node status. */
export interface PlanRunState {
  /** The Plan root; `nodes` mirrors `plan.nodes`. */
  plan: Plan;
  nodes: WorkNode[];
  nodeStatus: Map<NodeId, NodeStatus>;
  /** The node marked by `finish`; `null` until the planner ends the run. */
  finalNodeId: NodeId | null;
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
  | { ok: true; plan: Plan; finalNodeId: NodeId | null }
  | { ok: false; stage: "plan-protocol" | "plan-graph"; diagnostics: string };

/** A re-plan merge rejection; always a graph amendment violation. */
export type PlanMerge = { ok: true; state: PlanRunState } | { ok: false; diagnostics: string };

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

/** Every work node in record order. Accepts a Plan or the run state. */
export function allNodes(source: { nodes: readonly WorkNode[] }): WorkNode[] {
  return [...source.nodes];
}

/** The work node with this id, or `undefined`. */
export function nodeById(source: { nodes: readonly WorkNode[] }, id: NodeId): WorkNode | undefined {
  return source.nodes.find((node) => node.id === id);
}

/** The last node in record order; `undefined` for an empty plan. */
export function finalNode(source: { nodes: readonly WorkNode[] }): WorkNode | undefined {
  return source.nodes[source.nodes.length - 1];
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
 * The `finish` node is the run's final test gate. It must still be the last
 * node in record order and it must verify `test`.
 */
export function finalNodePassed(state: PlanRunState): boolean {
  const finalId = state.finalNodeId;
  if (finalId === null) {
    return false;
  }
  const last = finalNode(state);
  return (
    last !== undefined &&
    last.id === finalId &&
    last.verify === "test" &&
    state.nodeStatus.get(finalId) === "passed"
  );
}

/**
 * The run is done only when every node is terminal and the `finish` node's gate
 * passed. Earlier failed nodes are allowed when later work supersedes them,
 * exactly like a failed phase followed by a green suite.
 */
export function runComplete(state: PlanRunState): boolean {
  return finalNodePassed(state) && allNodesTerminal(state);
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
    problems.push(
      `${where} reuses node id ${quote(id)}; Plan and work-node ids must be globally unique`,
    );
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
 * Validate the complete graph, including the Plan root. Each returned string is
 * one problem; `validatePlan` renders them as a diagnostic list.
 */
function graphProblems(plan: Plan): string[] {
  const problems: string[] = [];
  const nodeIds = new Set<NodeId>();
  claimId(plan.id, "plan.id", nodeIds, problems);
  textProblems(plan.goal, "plan.goal", MAX_PLAN_GOAL_LENGTH, problems);

  if (plan.nodes.length === 0) {
    problems.push("the plan must contain at least one work node");
  }

  for (const node of plan.nodes) {
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

  const known = new Set(plan.nodes.map((node) => node.id));
  for (const node of plan.nodes) {
    if (!Array.isArray(node.after)) {
      continue;
    }
    for (const dependency of node.after) {
      if (typeof dependency === "string" && !known.has(dependency)) {
        problems.push(`node #${node.id} depends on #${dependency}, which is not in the plan`);
      }
    }
  }

  problems.push(...cycleProblems(plan.nodes));
  return problems;
}

/** Validate a Plan graph; `null` when it is valid, else a bullet diagnostic list. */
export function validatePlan(plan: Plan): string | null {
  const problems = graphProblems(plan);
  return problems.length === 0 ? null : problems.map((problem) => `- ${problem}`).join("\n");
}

/**
 * Validate a `finish` marker against the graph: the final id must exist, be the
 * last node in record order, and verify `test`. `null` when valid.
 */
export function validateFinalNode(plan: Plan, finalNodeId: NodeId): string | null {
  const last = finalNode(plan);
  if (last === undefined) {
    return `finish needs at least one work node; the plan has none`;
  }
  if (last.id !== finalNodeId) {
    return `finish marks #${finalNodeId}, but the last work node is #${last.id}; finish must mark the last node in record order`;
  }
  if (last.verify !== "test") {
    return `finish marks #${last.id}, which verifies "${last.verify}"; the final node must verify "test"`;
  }
  return null;
}

/** Build the run state from a freshly parsed plan (every node pending). */
export function initialState(plan: Plan, finalNodeId: NodeId | null = null): PlanRunState {
  return {
    plan,
    nodes: plan.nodes,
    nodeStatus: new Map(plan.nodes.map((node) => [node.id, "pending" as NodeStatus])),
    finalNodeId,
  };
}

function sameLoc(a: HintLoc, b: HintLoc): boolean {
  return a.path === b.path && a.symbol === b.symbol && a.kind === b.kind;
}

function sameHints(a: readonly HintLoc[], b: readonly HintLoc[]): boolean {
  return (
    a.length === b.length &&
    a.every((loc, index) => {
      const other = b[index];
      return other !== undefined && sameLoc(loc, other);
    })
  );
}

function sameWorkNode(a: WorkNode, b: WorkNode): boolean {
  return (
    a.verify === b.verify &&
    a.instruction === b.instruction &&
    a.approach === b.approach &&
    a.phase === b.phase &&
    a.after.length === b.after.length &&
    a.after.every((id, index) => id === b.after[index]) &&
    sameHints(a.hints, b.hints)
  );
}

/**
 * Merge a re-planning reply into the harness state. The reply re-emits the full
 * graph; ids are stable and record order is the readiness tie-break.
 *
 * - a passed node is immutable and cannot be removed;
 * - an in-progress node is held until it finishes;
 * - a failed node reopens when its definition changes, otherwise stays failed;
 * - a review node reopens pending when a review patch changes it;
 * - a new node starts pending and is appended after existing nodes;
 * - removed nodes must be pending or failed;
 * - the existing node order is preserved.
 */
export function mergeReplan(previous: PlanRunState, plan: Plan): PlanMerge {
  const problems: string[] = [];

  const previousNodes = new Map<NodeId, WorkNode>(previous.nodes.map((node) => [node.id, node]));

  const nextIds = plan.nodes.map((node) => node.id);
  const nextSet = new Set(nextIds);
  const keptPrevious = previous.nodes.map((node) => node.id).filter((id) => nextSet.has(id));
  const keptNext = nextIds.filter((id) => previousNodes.has(id));
  if (keptPrevious.join(",") !== keptNext.join(",")) {
    problems.push("existing nodes must keep their plan order");
  }
  const firstNew = nextIds.findIndex((id) => !previousNodes.has(id));
  if (firstNew !== -1 && nextIds.slice(firstNew).some((id) => previousNodes.has(id))) {
    problems.push("new nodes must be appended after existing nodes");
  }

  for (const node of previous.nodes) {
    if (nextSet.has(node.id)) {
      continue;
    }
    const status = previous.nodeStatus.get(node.id) ?? "pending";
    if (status === "passed") {
      problems.push(`passed node #${node.id} cannot be removed by a re-plan`);
    } else if (status === "review") {
      problems.push(`node #${node.id} is in review and cannot be removed by a re-plan`);
    } else if (status === "in-progress") {
      problems.push(
        `node #${node.id} is in progress; the harness holds it until the node finishes`,
      );
    }
  }

  const nodeStatus = new Map<NodeId, NodeStatus>();
  for (const node of plan.nodes) {
    const before = previousNodes.get(node.id);
    if (before === undefined) {
      nodeStatus.set(node.id, "pending");
      continue;
    }
    const beforeStatus = previous.nodeStatus.get(node.id) ?? "pending";
    const changed = !sameWorkNode(before, node);
    if (beforeStatus === "passed") {
      if (changed) {
        problems.push(
          `passed node #${node.id} is immutable; add repair work in a new node or reopen it explicitly`,
        );
      }
      nodeStatus.set(node.id, "passed");
    } else if (beforeStatus === "in-progress") {
      if (changed) {
        problems.push(
          `node #${node.id} is in progress; the harness holds it until the node finishes`,
        );
      }
      nodeStatus.set(node.id, "in-progress");
    } else if (beforeStatus === "review") {
      nodeStatus.set(node.id, changed ? "pending" : "review");
    } else if (beforeStatus === "failed") {
      nodeStatus.set(node.id, changed ? "pending" : "failed");
    } else {
      nodeStatus.set(node.id, "pending");
    }
  }

  if (problems.length > 0) {
    return {
      ok: false,
      diagnostics: `stage: plan-graph\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    };
  }
  const graphIssues = validatePlan(plan);
  if (graphIssues !== null) {
    return {
      ok: false,
      diagnostics: `stage: plan-graph\n${graphIssues}`,
    };
  }

  return {
    ok: true,
    state: {
      plan,
      nodes: plan.nodes,
      nodeStatus,
      finalNodeId: previous.finalNodeId,
    },
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
