import { describe, expect, test } from "bun:test";
import {
  allNodes,
  allNodesTerminal,
  blockedNodes,
  dependentsOf,
  finalNode,
  finalNodePassed,
  formatHint,
  initialState,
  isNodeBlocked,
  isSafeHintPath,
  isTerminalNodeStatus,
  MAX_APPROACH_LENGTH,
  MAX_INSTRUCTION_LENGTH,
  MAX_PHASE_LENGTH,
  MAX_PLAN_GOAL_LENGTH,
  mergeReplan,
  nextReadyNode,
  nodeById,
  readyNodes,
  renderFailedNodes,
  renderNodeStatus,
  renderNodeTree,
  runComplete,
  summaryOf,
  validateFinalNode,
  validatePlan,
} from "./tasks";
import type { NodeId, Plan, PlanRunState, WorkNode } from "./tasks";
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

// Keep fixtures readable: a plan always owns the root id "01-main" and the
// supplied nodes in record order.
function plan(nodes: WorkNode[], goal = "Make the change."): Plan {
  return { id: "01-main", goal, nodes };
}

function planText(nodes: WorkNode[], final = false): string {
  const content = serializePlanDsl(plan(nodes));
  return final ? `${content}\nfinish` : content;
}

function accepted(content: string): Plan {
  const parsed = parsePlan(content);
  if (!parsed.ok) {
    throw new Error(`expected an accepted plan, got ${parsed.diagnostics}`);
  }
  return parsed.plan;
}

function stateOf(nodes: WorkNode[], finalNodeId: NodeId | null = null): PlanRunState {
  return initialState(accepted(planText(nodes)), finalNodeId);
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

describe("Plan/WorkNode schema", () => {
  test("parses a minimal plan with hints, approach, and phase", () => {
    const parsed = parsePlan(`plan "01-main"
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
    expect(parsed.plan).toEqual({
      id: "01-main",
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
    });
    expect(parsed.finalNodeId).toBeNull();
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
    expect(finalNode(branch)?.id).toBe("05-d");
    expect(allNodes(branch).map((entry) => entry.id)).toEqual(["02-a", "03-b", "04-c", "05-d"]);
  });

  test("rejects duplicate plan/node ids and malformed ids", () => {
    const duplicate = parsePlan(planText([node("02-a"), node("02-a")]));
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.diagnostics).toContain("reuses node id");
    }
    const rootClash = parsePlan(
      serializePlanDsl({ id: "01-main", goal: "g", nodes: [node("01-main")] }),
    );
    expect(rootClash.ok).toBe(false);
    if (!rootClash.ok) {
      expect(rootClash.diagnostics).toContain("reuses node id");
    }
    const malformed = parsePlan(serializePlanDsl(plan([node("2-a")])));
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
    expect(validatePlan(plan([]))).toContain("at least one work node");
    const many = Array.from({ length: 200 }, (_, index) => node(`${10 + index}-n-${index}`));
    expect(validatePlan(plan(many))).toBeNull();
  });

  test("enforces plan goal and node text lengths", () => {
    expect(validatePlan(plan([node("02-a")], "x".repeat(MAX_PLAN_GOAL_LENGTH + 1)))).toContain(
      `at most ${MAX_PLAN_GOAL_LENGTH}`,
    );
    expect(
      validatePlan(plan([node("02-a", { instruction: "x".repeat(MAX_INSTRUCTION_LENGTH + 1) })])),
    ).toContain(`at most ${MAX_INSTRUCTION_LENGTH}`);
    expect(
      validatePlan(plan([node("02-a", { approach: "x".repeat(MAX_APPROACH_LENGTH + 1) })])),
    ).toContain(`at most ${MAX_APPROACH_LENGTH}`);
    expect(
      validatePlan(plan([node("02-a", { phase: "x".repeat(MAX_PHASE_LENGTH + 1) })])),
    ).toContain(`at most ${MAX_PHASE_LENGTH}`);
    expect(validatePlan(plan([node("02-a", { approach: "  " })]))).toContain(
      "approach must be a non-empty string",
    );
    expect(validatePlan(plan([node("02-a", { phase: "" })]))).toContain(
      "phase must be a non-empty string",
    );
  });
});

describe("hint validation", () => {
  test("rejects unsafe hint paths and duplicate hints", () => {
    const unsafe = plan([
      node("02-a", { hints: [{ path: "../a.ts", symbol: "x", kind: "value" }] }),
    ]);
    expect(validatePlan(unsafe)).toContain("not a writable repo-relative path");
    const human = plan([
      node("02-a", { hints: [{ path: "human/spec.md", symbol: "", kind: "file" }] }),
    ]);
    expect(validatePlan(human)).toContain("not a writable repo-relative path");
    const duplicate = plan([
      node("02-a", {
        hints: [
          { path: "src/a.ts", symbol: "x", kind: "value" },
          { path: "src/a.ts", symbol: "x", kind: "value" },
        ],
      }),
    ]);
    expect(validatePlan(duplicate)).toContain("more than once");
  });

  test("requires file hints to use an empty symbol and symbol hints to name a symbol", () => {
    const fileWithSymbol = plan([
      node("02-a", { hints: [{ path: "src/a.ts", symbol: "x", kind: "file" }] }),
    ]);
    expect(validatePlan(fileWithSymbol)).toContain('a file hint uses symbol ""');

    const emptySymbol = plan([
      node("02-a", { hints: [{ path: "src/a.ts", symbol: "", kind: "value" }] }),
    ]);
    expect(validatePlan(emptySymbol)).toContain("has an empty symbol");

    const unknownKind = plan([
      node("02-a", {
        hints: [{ path: "src/a.ts", symbol: "x", kind: "function" } as never],
      }),
    ]);
    expect(validatePlan(unknownKind)).toContain("must use kind value, type, namespace, or file");
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
    expect(validatePlan(self)).toContain(`node #02-a lists itself in after`);

    const dangling = plan([node("02-a"), node("03-b", { after: ["09-missing"] })]);
    expect(validatePlan(dangling)).toContain(
      `node #03-b depends on #09-missing, which is not in the plan`,
    );

    const duplicate = plan([node("02-a"), node("03-b", { after: ["02-a", "02-a"] })]);
    expect(validatePlan(duplicate)).toContain(`node #03-b lists dependency #02-a more than once`);
  });

  test("rejects cycles and names every node in the cycle", () => {
    const cycle = plan([
      node("02-a", { after: ["04-c"] }),
      node("03-b", { after: ["02-a"] }),
      node("04-c", { after: ["03-b"] }),
    ]);
    const problems = validatePlan(cycle);
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
    const problems = validatePlan(plan([node("02-a", { after: ["02-a"] })]));
    expect(problems).toContain("lists itself");
    expect(problems).not.toContain("cycle");
  });
});

describe("finish validation", () => {
  const lastTest = [node("02-a", { verify: "tsc" }), node("03-final")];

  test("finish marks the last test node", () => {
    const parsed = parsePlan(planText(lastTest, true));
    if (!parsed.ok) {
      throw new Error(parsed.diagnostics);
    }
    expect(parsed.finalNodeId).toBe("03-final");
    expect(validateFinalNode(parsed.plan, "03-final")).toBeNull();
  });

  test("finish needs a node, a test last node, and must be last", () => {
    const none = parsePlan('plan "01-main"\ngoal: g\nfinish');
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.diagnostics).toContain("at least one work node");
    }

    const tsc = parsePlan(planText([node("02-a", { verify: "tsc" })], true));
    expect(tsc.ok).toBe(false);
    if (!tsc.ok) {
      expect(tsc.diagnostics).toContain('must verify "test"');
    }

    const trailing = parsePlan(
      `${planText(lastTest, true)}\nnode "04-later" verify test\ninstruction: x\nend`,
    );
    expect(trailing.ok).toBe(false);
    if (!trailing.ok) {
      expect(trailing.diagnostics).toContain("finish must be the last line");
    }
  });

  test("finish on a non-final node is reported by validateFinalNode", () => {
    const content = plan([node("02-a"), node("03-b", { verify: "tsc" })]);
    expect(validateFinalNode(content, "02-a")).toContain(
      "finish must mark the last node in record order",
    );
  });
});

describe("legacy record rejection", () => {
  test("rejects legacy stage/task/edit plan records", () => {
    const stageFirst = parsePlan(`stage "02-current" plan "01-main"
goal: g
end`);
    expect(stageFirst.ok).toBe(false);
    if (!stageFirst.ok) {
      expect(stageFirst.diagnostics).toContain("PLAN_LEGACY_RECORD");
      expect(stageFirst.diagnostics).toContain("node");
    }

    const taskAfterNode = parsePlan(`plan "01-main"
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

  test("review is not terminal and is not runnable", () => {
    const state = stateOf([node("02-a"), node("03-final")], "03-final");
    state.nodeStatus.set("02-a", "review");
    pass(state, "03-final");
    expect(isTerminalNodeStatus("review")).toBe(false);
    expect(isTerminalNodeStatus("failed")).toBe(true);
    expect(ids(readyNodes(state))).toEqual([]);
    expect(allNodesTerminal(state)).toBe(false);
    expect(runComplete(state)).toBe(false);
  });

  test("run success requires the final test node to pass and every node to be terminal", () => {
    const state = stateOf([node("02-a", { verify: "tsc" }), node("03-final")], "03-final");
    expect(finalNodePassed(state)).toBe(false);
    pass(state, "02-a");
    pass(state, "03-final");
    expect(finalNodePassed(state)).toBe(true);
    expect(runComplete(state)).toBe(true);

    state.nodeStatus.set("02-a", "failed");
    expect(runComplete(state)).toBe(true);

    state.nodeStatus.set("02-a", "pending");
    expect(runComplete(state)).toBe(false);

    pass(state, "02-a");
    state.nodeStatus.set("03-final", "review");
    expect(finalNodePassed(state)).toBe(false);
    expect(runComplete(state)).toBe(false);
  });

  test("earlier failed nodes are allowed but the finish node must be last and test", () => {
    const state = stateOf([node("02-a", { verify: "tsc" }), node("03-final")], "03-final");
    pass(state, "02-a");
    pass(state, "03-final");
    expect(finalNodePassed(state)).toBe(true);

    state.nodeStatus.set("02-a", "failed");
    expect(finalNodePassed(state)).toBe(true);
    expect(runComplete(state)).toBe(true);

    state.finalNodeId = "02-a";
    expect(finalNodePassed(state)).toBe(false);

    const tscLast = stateOf([node("02-a"), node("03-final", { verify: "tsc" })], "03-final");
    pass(tscLast, "02-a");
    pass(tscLast, "03-final");
    expect(finalNodePassed(tscLast)).toBe(false);
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

describe("mergeReplan", () => {
  function basePlan(): Plan {
    return plan([node("02-a", { verify: "tsc" }), node("03-b", { after: ["02-a"] }), node("04-c")]);
  }

  function baseState(): PlanRunState {
    return initialState(basePlan(), "04-c");
  }

  test("new nodes start pending and append after existing nodes", () => {
    const state = baseState();
    pass(state, "02-a");
    const next = plan([...basePlan().nodes, node("05-d", { after: ["04-c"] })]);
    const merged = mergeReplan(state, next);
    if (!merged.ok) {
      throw new Error(merged.diagnostics);
    }
    expect(merged.state.nodeStatus.get("02-a")).toBe("passed");
    expect(merged.state.nodeStatus.get("05-d")).toBe("pending");
    expect(merged.state.finalNodeId).toBe("04-c");
  });

  test("a passed node is immutable and cannot be removed", () => {
    const state = baseState();
    pass(state, "02-a");

    const changed = mergeReplan(
      state,
      plan([node("02-a", { verify: "test" }), node("03-b", { after: ["02-a"] }), node("04-c")]),
    );
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.diagnostics).toContain("passed node #02-a is immutable");
    }

    const removed = mergeReplan(state, plan([node("03-b"), node("04-c")]));
    expect(removed.ok).toBe(false);
    if (!removed.ok) {
      expect(removed.diagnostics).toContain("passed node #02-a cannot be removed");
    }
  });

  test("a failed node stays closed unchanged and reopens when repaired", () => {
    const state = baseState();
    fail(state, "03-b");
    const unchanged = mergeReplan(state, basePlan());
    if (!unchanged.ok) {
      throw new Error(unchanged.diagnostics);
    }
    expect(unchanged.state.nodeStatus.get("03-b")).toBe("failed");

    const repaired = mergeReplan(
      state,
      plan([
        node("02-a", { verify: "tsc" }),
        node("03-b", { after: ["02-a"], instruction: "Try a smaller repair." }),
        node("04-c"),
      ]),
    );
    if (!repaired.ok) {
      throw new Error(repaired.diagnostics);
    }
    expect(repaired.state.nodeStatus.get("03-b")).toBe("pending");
  });

  test("changing after or hints counts as a repair", () => {
    const state = baseState();
    fail(state, "03-b");
    const changedAfter = mergeReplan(
      state,
      plan([
        node("02-a", { verify: "tsc" }),
        node("03-b", { after: ["02-a", "04-c"] }),
        node("04-c"),
      ]),
    );
    if (!changedAfter.ok) {
      throw new Error(changedAfter.diagnostics);
    }
    expect(changedAfter.state.nodeStatus.get("03-b")).toBe("pending");

    fail(state, "03-b");
    const changedHints = mergeReplan(
      state,
      plan([
        node("02-a", { verify: "tsc" }),
        node("03-b", {
          after: ["02-a"],
          hints: [{ path: "src/a.ts", symbol: "answer", kind: "value" }],
        }),
        node("04-c"),
      ]),
    );
    if (!changedHints.ok) {
      throw new Error(changedHints.diagnostics);
    }
    expect(changedHints.state.nodeStatus.get("03-b")).toBe("pending");
  });

  test("a review node reopens pending when a review patch changes it", () => {
    const state = baseState();
    state.nodeStatus.set("03-b", "review");
    const unchanged = mergeReplan(state, basePlan());
    if (!unchanged.ok) {
      throw new Error(unchanged.diagnostics);
    }
    expect(unchanged.state.nodeStatus.get("03-b")).toBe("review");

    const patched = mergeReplan(
      state,
      plan([
        node("02-a", { verify: "tsc" }),
        node("03-b", { after: ["02-a"], instruction: "Apply the review patch." }),
        node("04-c"),
      ]),
    );
    if (!patched.ok) {
      throw new Error(patched.diagnostics);
    }
    expect(patched.state.nodeStatus.get("03-b")).toBe("pending");
  });

  test("an in-progress node is held and cannot be changed or removed", () => {
    const state = baseState();
    state.nodeStatus.set("03-b", "in-progress");
    const unchanged = mergeReplan(state, basePlan());
    if (!unchanged.ok) {
      throw new Error(unchanged.diagnostics);
    }
    expect(unchanged.state.nodeStatus.get("03-b")).toBe("in-progress");

    const changed = mergeReplan(
      state,
      plan([
        node("02-a", { verify: "tsc" }),
        node("03-b", { after: ["02-a"], instruction: "Changed." }),
        node("04-c"),
      ]),
    );
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.diagnostics).toMatch(/in[- ]progress/);
    }

    const removed = mergeReplan(state, plan([node("02-a"), node("04-c")]));
    expect(removed.ok).toBe(false);
    if (!removed.ok) {
      expect(removed.diagnostics).toMatch(/in[- ]progress/);
    }
  });

  test("a review node cannot be removed", () => {
    const state = baseState();
    state.nodeStatus.set("03-b", "review");
    const removed = mergeReplan(state, plan([node("02-a"), node("04-c")]));
    expect(removed.ok).toBe(false);
    if (!removed.ok) {
      expect(removed.diagnostics).toContain("is in review");
    }
  });

  test("pending and failed nodes can be removed", () => {
    const state = baseState();
    fail(state, "03-b");
    const removed = mergeReplan(state, plan([node("02-a"), node("04-c")]));
    if (!removed.ok) {
      throw new Error(removed.diagnostics);
    }
    expect(removed.state.nodes.map((entry) => entry.id)).toEqual(["02-a", "04-c"]);
    expect(removed.state.nodeStatus.has("03-b")).toBe(false);
  });

  test("existing node order is preserved and new nodes cannot be inserted early", () => {
    const state = baseState();
    const reordered = mergeReplan(
      state,
      plan([node("04-c"), node("02-a"), node("03-b", { after: ["02-a"] })]),
    );
    expect(reordered.ok).toBe(false);
    if (!reordered.ok) {
      expect(reordered.diagnostics).toContain("existing nodes must keep their plan order");
    }

    const inserted = mergeReplan(
      state,
      plan([
        node("02-a"),
        node("05-new", { after: ["02-a"] }),
        node("03-b", { after: ["02-a"] }),
        node("04-c"),
      ]),
    );
    expect(inserted.ok).toBe(false);
    if (!inserted.ok) {
      expect(inserted.diagnostics).toContain("new nodes must be appended after existing nodes");
    }
  });

  test("the merge validates the resulting graph", () => {
    const state = baseState();
    const dangling = mergeReplan(
      state,
      plan([...basePlan().nodes, node("05-d", { after: ["09-missing"] })]),
    );
    expect(dangling.ok).toBe(false);
    if (!dangling.ok) {
      expect(dangling.diagnostics).toContain("not in the plan");
    }
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
