import { describe, expect, test } from "bun:test";
import {
  allNodes,
  allNodesTerminal,
  applyPlanReply,
  blockedNodes,
  dependentsOf,
  formatHint,
  initialState,
  isNodeBlocked,
  isSafeHintPath,
  isTerminalNodeStatus,
  MAX_APPROACH_LENGTH,
  MAX_INSTRUCTION_LENGTH,
  MAX_PHASE_LENGTH,
  MAX_PLAN_GOAL_LENGTH,
  nextReadyNode,
  nodeById,
  readyNodes,
  renderFailedNodes,
  renderNodeStatus,
  renderNodeTree,
  runComplete,
  summaryOf,
  validateNodes,
  validatePlan,
} from "./tasks";
import type { NodeId, PlanReply, PlanRunState, WorkNode } from "./tasks";
import { parsePlan, serializePlanDsl } from "./plan-dsl";

function node(id: string, overrides: Partial<Omit<WorkNode, "id">> = {}): WorkNode {
  return {
    id,
    after: [],
    verify: "test",
    instruction: `Do ${id}.`,
    hints: [],
    ...overrides,
  };
}

function plan(nodes: WorkNode[], goal = "Make the change."): PlanReply {
  return { goal, nodes, amends: [] };
}

function planText(nodes: WorkNode[], goal = "Make the change."): string {
  return serializePlanDsl(plan(nodes, goal));
}

function accepted(content: string): PlanReply {
  const parsed = parsePlan(content);
  if (!parsed.ok) {
    throw new Error(`expected an accepted plan, got ${parsed.diagnostics}`);
  }
  return parsed.reply;
}

function stateOf(nodes: WorkNode[]): PlanRunState {
  return initialState(accepted(planText(nodes)));
}

function pass(state: PlanRunState, id: NodeId): void {
  state.nodeStatus.set(id, "passed");
}

function fail(state: PlanRunState, id: NodeId): void {
  state.nodeStatus.set(id, "failed");
}

function ids(nodes: readonly WorkNode[]): NodeId[] {
  return nodes.map((candidate) => candidate.id);
}

function gate(state: PlanRunState, id: NodeId, ok = true): void {
  const candidate = nodeById(state, id);
  state.lastGate = {
    nodeId: id,
    verify: candidate?.verify ?? "test",
    ok,
  };
}

describe("Plan/WorkNode schema", () => {
  test("parses a minimal plan with hints, approach, and phase", () => {
    const parsed = parsePlan(`plan
goal: Make the failing test pass.

node "02-scaffold" verify tsc
instruction: Create a compiling skeleton.
hint file src/workbook.ts
approach: Write the top-level declarations and stub bodies first; fill bodies later with targeted edits.
phase: scaffold
end

node "03-impl" after "02-scaffold" verify test
instruction: Implement evaluate.
hint value evaluate in src/workbook.ts
hint type CellResult in src/workbook.ts
end
`);
    if (!parsed.ok) {
      throw new Error(parsed.diagnostics);
    }
    expect(parsed.reply).toEqual({
      goal: "Make the failing test pass.",
      nodes: [
        {
          id: "02-scaffold",
          after: [],
          verify: "tsc",
          instruction: "Create a compiling skeleton.",
          hints: [{ path: "src/workbook.ts", symbol: "", kind: "file" }],
          approach:
            "Write the top-level declarations and stub bodies first; fill bodies later with targeted edits.",
          phase: "scaffold",
        },
        {
          id: "03-impl",
          after: ["02-scaffold"],
          verify: "test",
          instruction: "Implement evaluate.",
          hints: [
            { path: "src/workbook.ts", symbol: "evaluate", kind: "value" },
            { path: "src/workbook.ts", symbol: "CellResult", kind: "type" },
          ],
        },
      ],
      amends: [],
    });
  });

  test("parses a legacy quoted plan id without keeping a plan-root id", () => {
    const parsed = parsePlan(`plan "01-main"
goal: Keep the goal.
node "02-a" verify test
instruction: Do it.
end`);
    if (!parsed.ok) {
      throw new Error(parsed.diagnostics);
    }
    expect(parsed.reply.goal).toBe("Keep the goal.");
    expect(parsed.reply.nodes.map((entry) => entry.id)).toEqual(["02-a"]);
  });

  test("accepts a linear chain and a branching DAG", () => {
    const linear = accepted(
      planText([
        node("02-a", { verify: "tsc" }),
        node("03-b", { after: ["02-a"] }),
        node("04-c", { after: ["03-b"] }),
      ]),
    );
    expect(linear.nodes.map((entry) => entry.after)).toEqual([[], ["02-a"], ["03-b"]]);

    const branch = accepted(
      planText([
        node("02-a", { verify: "tsc" }),
        node("03-b", { after: ["02-a"] }),
        node("04-c"),
        node("05-d", { after: ["03-b", "04-c"] }),
      ]),
    );
    expect(branch.nodes[3]?.after).toEqual(["03-b", "04-c"]);
    expect(nodeById(branch, "05-d")?.after).toEqual(["03-b", "04-c"]);
    expect(dependentsOf(branch, "02-a").map((entry) => entry.id)).toEqual(["03-b"]);
    expect(allNodes(branch).map((entry) => entry.id)).toEqual(["02-a", "03-b", "04-c", "05-d"]);
  });

  test("rejects duplicate node ids and malformed ids", () => {
    const duplicate = parsePlan(planText([node("02-a"), node("02-a")]));
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.diagnostics).toContain("reuses node id");
    }
    const malformed = parsePlan(serializePlanDsl({ goal: "g", nodes: [node("2-a")] }));
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.diagnostics).toContain("must be a string node id");
    }
  });

  test("rejects an unknown verify value", () => {
    const bad = { ...node("02-a"), verify: "lint" } as unknown as WorkNode;
    const parsed = parsePlan(serializePlanDsl(plan([bad])));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.diagnostics).toContain('verify must be "tsc" or "test"');
    }
  });

  test("rejects an empty plan without imposing an arbitrary node cap", () => {
    expect(validatePlan("g", [])).toContain("at least one work node");
    expect(parsePlan("plan\ngoal: g").ok).toBe(false);
    const many = Array.from({ length: 200 }, (_, index) => node(`${10 + index}-n-${index}`));
    expect(validatePlan("g", many)).toBeNull();
  });

  test("enforces plan goal and node text lengths", () => {
    expect(validatePlan("x".repeat(MAX_PLAN_GOAL_LENGTH + 1), [node("02-a")])).toContain(
      `at most ${MAX_PLAN_GOAL_LENGTH}`,
    );
    expect(
      validatePlan("g", [node("02-a", { instruction: "x".repeat(MAX_INSTRUCTION_LENGTH + 1) })]),
    ).toContain(`at most ${MAX_INSTRUCTION_LENGTH}`);
    expect(
      validatePlan("g", [node("02-a", { approach: "x".repeat(MAX_APPROACH_LENGTH + 1) })]),
    ).toContain(`at most ${MAX_APPROACH_LENGTH}`);
    expect(
      validatePlan("g", [node("02-a", { phase: "x".repeat(MAX_PHASE_LENGTH + 1) })]),
    ).toContain(`at most ${MAX_PHASE_LENGTH}`);
    expect(validatePlan("g", [node("02-a", { approach: "  " })])).toContain(
      "approach must be a non-empty string",
    );
    expect(validatePlan("g", [node("02-a", { phase: "" })])).toContain(
      "phase must be a non-empty string",
    );
  });
});

describe("hint validation", () => {
  test("rejects unsafe hint paths and duplicate hints", () => {
    const unsafe = plan([
      node("02-a", { hints: [{ path: "../a.ts", symbol: "x", kind: "value" }] }),
    ]);
    expect(validatePlan("g", unsafe.nodes)).toContain("not a writable repo-relative path");
    const human = plan([
      node("02-a", { hints: [{ path: "human/spec.md", symbol: "", kind: "file" }] }),
    ]);
    expect(validatePlan("g", human.nodes)).toContain("not a writable repo-relative path");
    const duplicate = plan([
      node("02-a", {
        hints: [
          { path: "src/a.ts", symbol: "x", kind: "value" },
          { path: "src/a.ts", symbol: "x", kind: "value" },
        ],
      }),
    ]);
    expect(validatePlan("g", duplicate.nodes)).toContain("more than once");
  });

  test("requires file hints to use an empty symbol and symbol hints to name a symbol", () => {
    const fileWithSymbol = plan([
      node("02-a", { hints: [{ path: "src/a.ts", symbol: "x", kind: "file" }] }),
    ]);
    expect(validatePlan("g", fileWithSymbol.nodes)).toContain('a file hint uses symbol ""');

    const emptySymbol = plan([
      node("02-a", { hints: [{ path: "src/a.ts", symbol: "", kind: "value" }] }),
    ]);
    expect(validatePlan("g", emptySymbol.nodes)).toContain("has an empty symbol");

    const unknownKind = plan([
      node("02-a", {
        hints: [{ path: "src/a.ts", symbol: "x", kind: "function" } as never],
      }),
    ]);
    expect(validatePlan("g", unknownKind.nodes)).toContain(
      "must use kind value, type, namespace, or file",
    );
  });

  test("formats file and symbol hints", () => {
    expect(formatHint({ path: "src/a.ts", symbol: "", kind: "file" })).toBe('file "src/a.ts"');
    expect(formatHint({ path: "src/a.ts", symbol: "answer", kind: "value" })).toBe(
      'value "answer" in "src/a.ts"',
    );
  });
});

describe("dependency validation", () => {
  test("rejects self, dangling, and duplicate after edges", () => {
    const self = plan([node("02-a", { after: ["02-a"] })]);
    expect(validatePlan("g", self.nodes)).toContain(`node #02-a lists itself in after`);

    const dangling = plan([node("02-a"), node("03-b", { after: ["09-missing"] })]);
    expect(validatePlan("g", dangling.nodes)).toContain(
      `node #03-b depends on #09-missing, which is not in the plan`,
    );

    const duplicate = plan([node("02-a"), node("03-b", { after: ["02-a", "02-a"] })]);
    expect(validatePlan("g", duplicate.nodes)).toContain(
      `node #03-b lists dependency #02-a more than once`,
    );
  });

  test("rejects cycles and names every node in the cycle", () => {
    const cycle = plan([
      node("02-a", { after: ["04-c"] }),
      node("03-b", { after: ["02-a"] }),
      node("04-c", { after: ["03-b"] }),
    ]);
    const problems = validateNodes(cycle.nodes);
    expect(problems).toContain("cycle");
    expect(problems).toContain("#02-a");
    expect(problems).toContain("#03-b");
    expect(problems).toContain("#04-c");

    const parsed = parsePlan(serializePlanDsl(cycle));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.stage).toBe("plan-graph");
      expect(parsed.diagnostics).toContain("#02-a -> #04-c -> #03-b -> #02-a");
    }
  });

  test("a self-dependency is not reported as a cycle as well", () => {
    const problems = validatePlan("g", [node("02-a", { after: ["02-a"] })]);
    expect(problems).toContain("lists itself");
    expect(problems).not.toContain("cycle");
  });
});

describe("legacy record rejection", () => {
  test("rejects finish, patch, and node operator records with a repair hint", () => {
    const finish = parsePlan(`plan
goal: g
node "02-a" verify test
instruction: x
end
finish`);
    expect(finish.ok).toBe(false);
    if (!finish.ok) {
      expect(finish.diagnostics).toContain("PLAN_LEGACY_RECORD");
      expect(finish.diagnostics).toContain("last gate is a passing test");
    }

    const patch = parsePlan(`patch
node+ "02-a" verify test
instruction: x
end`);
    expect(patch.ok).toBe(false);
    if (!patch.ok) {
      expect(patch.diagnostics).toContain("PLAN_LEGACY_RECORD");
    }

    const update = parsePlan(`node~ "02-a"
instruction: x
end`);
    expect(update.ok).toBe(false);
    if (!update.ok) {
      expect(update.diagnostics).toContain("PLAN_LEGACY_RECORD");
    }
  });

  test("rejects legacy stage/task/edit plan records", () => {
    const stageFirst = parsePlan(`stage "02-current" plan "01-main"
goal: g
end`);
    expect(stageFirst.ok).toBe(false);
    if (!stageFirst.ok) {
      expect(stageFirst.diagnostics).toContain("PLAN_LEGACY_RECORD");
      expect(stageFirst.diagnostics).toContain("node");
    }

    const taskAfterNode = parsePlan(`plan
goal: g

node "02-a" verify test
instruction: x
end

task "03-b" stage "02-a" verify test
instruction: x
end`);
    expect(taskAfterNode.ok).toBe(false);
    if (!taskAfterNode.ok) {
      expect(taskAfterNode.diagnostics).toContain("PLAN_LEGACY_RECORD");
    }
  });
});

describe("scheduling", () => {
  test("ready nodes follow dependency edges and record order", () => {
    const state = stateOf([
      node("02-a", { verify: "tsc" }),
      node("03-b", { after: ["02-a"] }),
      node("04-c"),
      node("05-d", { after: ["03-b", "04-c"] }),
    ]);
    expect(ids(readyNodes(state))).toEqual(["02-a", "04-c"]);
    expect(nextReadyNode(state)?.id).toBe("02-a");

    pass(state, "02-a");
    expect(ids(readyNodes(state))).toEqual(["03-b", "04-c"]);

    pass(state, "04-c");
    expect(ids(readyNodes(state))).toEqual(["03-b"]);

    pass(state, "03-b");
    expect(ids(readyNodes(state))).toEqual(["05-d"]);
    expect(readyNodes(state)[0]).toBe(nodeById(state, "05-d"));
  });

  test("a failed dependency blocks its dependents transitively", () => {
    const state = stateOf([
      node("02-a"),
      node("03-b", { after: ["02-a"] }),
      node("04-c", { after: ["03-b"] }),
      node("05-independent", { verify: "tsc" }),
    ]);
    fail(state, "02-a");
    expect(isNodeBlocked(state, nodeById(state, "03-b") as WorkNode)).toBe(true);
    expect(isNodeBlocked(state, nodeById(state, "04-c") as WorkNode)).toBe(true);
    expect(isNodeBlocked(state, nodeById(state, "05-independent") as WorkNode)).toBe(false);
    expect(ids(blockedNodes(state))).toEqual(["03-b", "04-c"]);
    expect(ids(readyNodes(state))).toEqual(["05-independent"]);
    expect(allNodesTerminal(state)).toBe(false);
    expect(runComplete(state)).toBe(false);
  });

  test("a passed dependency unblocks but a pending dependency does not", () => {
    const state = stateOf([node("02-a"), node("03-b", { after: ["02-a"] })]);
    expect(ids(readyNodes(state))).toEqual(["02-a"]);
    pass(state, "02-a");
    expect(ids(readyNodes(state))).toEqual(["03-b"]);
  });

  test("run completion is the last passing test gate with nothing ready", () => {
    const state = stateOf([node("02-a", { verify: "tsc" }), node("03-final")]);
    expect(runComplete(state)).toBe(false);
    pass(state, "02-a");
    gate(state, "02-a");
    expect(runComplete(state)).toBe(false);

    pass(state, "03-final");
    gate(state, "03-final");
    expect(runComplete(state)).toBe(true);

    const failedTsc = stateOf([node("02-a", { verify: "tsc" }), node("03-final")]);
    pass(failedTsc, "03-final");
    gate(failedTsc, "03-final");
    fail(failedTsc, "02-a");
    expect(runComplete(failedTsc)).toBe(true);

    failedTsc.nodeStatus.set("02-a", "pending");
    expect(runComplete(failedTsc)).toBe(false);
  });

  test("a blocked pending node does not keep a green run open", () => {
    const state = stateOf([
      node("02-a", { verify: "tsc" }),
      node("03-blocked", { after: ["02-a"] }),
      node("04-final"),
    ]);
    fail(state, "02-a");
    pass(state, "04-final");
    gate(state, "04-final");
    expect(ids(readyNodes(state))).toEqual([]);
    expect(runComplete(state)).toBe(true);
  });

  test("a passing tsc gate is not completion", () => {
    const state = stateOf([node("02-a", { verify: "tsc" })]);
    pass(state, "02-a");
    gate(state, "02-a");
    expect(runComplete(state)).toBe(false);
  });

  test("review is not a graph status", () => {
    expect(isTerminalNodeStatus("pending")).toBe(false);
    expect(isTerminalNodeStatus("failed")).toBe(true);
    expect(isTerminalNodeStatus("passed")).toBe(true);
  });

  test("renderNodeTree is stable and status renders separately", () => {
    const state = stateOf([
      node("02-a", {
        hints: [{ path: "src/a.ts", symbol: "answer", kind: "value" }],
        approach: "Use a targeted edit.",
        phase: "impl",
      }),
      node("03-b", { after: ["02-a"] }),
    ]);
    const rendered = renderNodeTree(state);
    expect(rendered).toContain('@node #02-a verify=test phase="impl"');
    expect(rendered).toContain('hint: value "answer" in "src/a.ts"');
    expect(rendered).toContain("approach: Use a targeted edit.");
    expect(rendered).toContain("@node #03-b verify=test after=[02-a]");
    pass(state, "02-a");
    expect(renderNodeTree(state)).toBe(rendered);
    expect(renderNodeStatus(state)).toContain("@node #02-a passed");
    expect(renderNodeStatus(state)).toContain("@node #03-b pending");
  });

  test("renderFailedNodes reports failed node diagnostics", () => {
    const state = stateOf([node("02-a")]);
    fail(state, "02-a");
    const rendered = renderFailedNodes(state, new Map([["02-a", "expected 2, got 1"]]));
    expect(rendered).toContain("@node #02-a (test gate) failed:");
    expect(rendered).toContain("expected 2, got 1");
  });

  test("summaryOf reports every node with its status", () => {
    const state = stateOf([
      node("02-a", { verify: "tsc", approach: "scaffold first", phase: "scaffold" }),
      node("03-b", { after: ["02-a"] }),
    ]);
    pass(state, "02-a");
    const summary = summaryOf(state);
    expect(summary).toEqual([
      {
        id: "02-a",
        verify: "tsc",
        status: "passed",
        phase: "scaffold",
        approach: "scaffold first",
      },
      { id: "03-b", verify: "test", status: "pending" },
    ]);
  });
});

describe("applyPlanReply", () => {
  function baseState(): PlanRunState {
    return stateOf([
      node("02-a", { verify: "tsc" }),
      node("03-b", { after: ["02-a"] }),
      node("04-c"),
    ]);
  }

  test("appends nodes after existing nodes with pending status", () => {
    const state = baseState();
    pass(state, "02-a");
    const applied = applyPlanReply(state, {
      nodes: [node("05-d", { after: ["04-c"] })],
      amends: [],
    });
    if (!applied.ok) {
      throw new Error(applied.diagnostics);
    }
    expect(applied.state.nodeStatus.get("02-a")).toBe("passed");
    expect(applied.state.nodeStatus.get("05-d")).toBe("pending");
    expect(applied.state.nodes.map((entry) => entry.id)).toEqual(["02-a", "03-b", "04-c", "05-d"]);
  });

  test("rejects duplicate append ids and dangling edges", () => {
    const state = baseState();
    const duplicate = applyPlanReply(state, {
      nodes: [node("02-a")],
      amends: [],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.diagnostics).toContain("reuses node id");
    }

    const dangling = applyPlanReply(state, {
      nodes: [node("05-d", { after: ["09-missing"] })],
      amends: [],
    });
    expect(dangling.ok).toBe(false);
    if (!dangling.ok) {
      expect(dangling.diagnostics).toContain("not in the plan");
    }
  });

  test("amends a failed node in place and reopens it", () => {
    const state = baseState();
    fail(state, "03-b");
    const applied = applyPlanReply(state, {
      nodes: [],
      amends: [{ id: "03-b", instruction: "Try a smaller repair." }],
    });
    if (!applied.ok) {
      throw new Error(applied.diagnostics);
    }
    expect(applied.state.nodeStatus.get("03-b")).toBe("pending");
    expect(nodeById(applied.state, "03-b")?.instruction).toBe("Try a smaller repair.");
  });

  test("a passed node is immutable", () => {
    const state = baseState();
    pass(state, "02-a");
    const changed = applyPlanReply(state, {
      nodes: [],
      amends: [{ id: "02-a", verify: "test" }],
    });
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.diagnostics).toContain("passed node #02-a is immutable");
    }
  });

  test("a review reply may amend only the reviewed node and may not append", () => {
    const state = baseState();
    gate(state, "03-b");
    const other = applyPlanReply(
      state,
      { nodes: [], amends: [{ id: "04-c", instruction: "No." }] },
      { reviewTarget: "03-b" },
    );
    expect(other.ok).toBe(false);
    if (!other.ok) {
      expect(other.diagnostics).toContain("may amend only #03-b");
    }

    const appended = applyPlanReply(
      state,
      { nodes: [node("05-d")], amends: [] },
      { reviewTarget: "03-b" },
    );
    expect(appended.ok).toBe(false);
    if (!appended.ok) {
      expect(appended.diagnostics).toContain("may not add nodes");
    }

    const reviewed = applyPlanReply(
      state,
      { nodes: [], amends: [{ id: "03-b", instruction: "Apply the review repair." }] },
      { reviewTarget: "03-b" },
    );
    if (!reviewed.ok) {
      throw new Error(reviewed.diagnostics);
    }
    expect(reviewed.state.nodeStatus.get("03-b")).toBe("pending");
    expect(reviewed.state.lastGate).toBeNull();
  });

  test("an amend that changes nothing and an empty reply are rejected", () => {
    const state = baseState();
    const noop = applyPlanReply(state, {
      nodes: [],
      amends: [{ id: "03-b", instruction: "Do 03-b." }],
    });
    expect(noop.ok).toBe(false);
    if (!noop.ok) {
      expect(noop.diagnostics).toContain("changes nothing");
    }

    const empty = applyPlanReply(state, { nodes: [], amends: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.diagnostics).toContain("no node or amend record");
    }
  });

  test("amending after or hints validates the resulting graph", () => {
    const state = baseState();
    fail(state, "03-b");
    const applied = applyPlanReply(state, {
      nodes: [],
      amends: [{ id: "03-b", after: ["09-missing"] }],
    });
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.diagnostics).toContain("not in the plan");
    }

    const cleared = applyPlanReply(state, {
      nodes: [],
      amends: [{ id: "03-b", after: [], hints: [] }],
    });
    if (!cleared.ok) {
      throw new Error(cleared.diagnostics);
    }
    expect(nodeById(cleared.state, "03-b")?.after).toEqual([]);
  });

  test("the initial reply requires a goal and at least one node", () => {
    const base: PlanRunState = { goal: "", nodes: [], nodeStatus: new Map(), lastGate: null };
    const missingGoal = applyPlanReply(
      base,
      { nodes: [node("02-a")], amends: [] },
      { requireGoal: true },
    );
    expect(missingGoal.ok).toBe(false);
    if (!missingGoal.ok) {
      expect(missingGoal.diagnostics).toContain("needs a non-empty goal: field");
    }

    const ok = applyPlanReply(
      base,
      { goal: "g", nodes: [node("02-a")], amends: [] },
      { requireGoal: true },
    );
    if (!ok.ok) {
      throw new Error(ok.diagnostics);
    }
    expect(ok.state.nodes.map((entry) => entry.id)).toEqual(["02-a"]);
  });
});

describe("isSafeHintPath", () => {
  test("accepts ordinary repo paths and rejects escapes", () => {
    expect(isSafeHintPath("src/tasks.ts")).toBe(true);
    expect(isSafeHintPath("./src/tasks.ts")).toBe(false);
    expect(isSafeHintPath("src/.hidden.ts")).toBe(false);
    expect(isSafeHintPath("dist/a.ts")).toBe(false);
    expect(isSafeHintPath("human/spec.ts")).toBe(false);
    expect(isSafeHintPath("/etc/passwd.ts")).toBe(false);
    expect(isSafeHintPath("../a.ts")).toBe(false);
  });
});
