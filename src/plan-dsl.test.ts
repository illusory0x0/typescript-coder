import { describe, expect, test } from "bun:test";
import {
  applyPlanPatch,
  parsePlan,
  parsePlanDsl,
  parsePlanDslDetailed,
  parsePlanPatch,
  parsePlanPatchDetailed,
  readPlan,
  serializePlanDsl,
  serializePlanPatch,
} from "./plan-dsl";
import type { PlanPatch, PlanPatchOp } from "./plan-dsl";
import { initialState, nodeById, readyNodes, validatePlan } from "./tasks";
import type { Plan, PlanRunState, WorkNode, WorkVerify } from "./tasks";

const SPEC_EXAMPLE = `plan "01-main"
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
end`;

const SPEC_PLAN: Plan = {
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
};

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

function plan(nodes: WorkNode[], goal = "Make the change."): Plan {
  return { id: "01-main", goal, nodes };
}

function accepted(content: string): Plan {
  const parsed = parsePlanDsl(content);
  if (!parsed.ok) {
    throw new Error(`expected an accepted plan, got ${parsed.diagnostics}`);
  }
  return parsed.plan;
}

function rejected(content: string): string {
  const parsed = parsePlanDsl(content);
  if (parsed.ok) {
    throw new Error("expected the plan to be rejected");
  }
  return parsed.diagnostics;
}

function acceptedPatch(content: string): PlanPatch {
  const parsed = parsePlanPatch(content);
  if (!parsed.ok) {
    throw new Error(`expected an accepted patch, got ${parsed.diagnostics}`);
  }
  return parsed.patch;
}

function rejectedPatch(content: string): string {
  const parsed = parsePlanPatch(content);
  if (parsed.ok) {
    throw new Error("expected the patch to be rejected");
  }
  return parsed.diagnostics;
}

function stateOf(nodes: WorkNode[] = SPEC_PLAN.nodes): PlanRunState {
  return initialState(plan(nodes));
}

function applied(state: PlanRunState, content: string): PlanRunState {
  const merged = applyPlanPatch(state, acceptedPatch(content));
  if (!merged.ok) {
    throw new Error(merged.diagnostics);
  }
  return merged.state;
}

function snapshot(state: PlanRunState): string {
  return JSON.stringify({
    plan: state.plan,
    nodeStatus: [...state.nodeStatus.entries()].sort(),
    finalNodeId: state.finalNodeId,
  });
}

describe("Plan DSL parse", () => {
  test("parses the canonical WorkNode DAG example", () => {
    const plan = accepted(SPEC_EXAMPLE);
    expect(plan).toEqual(SPEC_PLAN);
    expect(parsePlan(SPEC_EXAMPLE).ok).toBe(true);
    expect(readPlan(SPEC_EXAMPLE).ok).toBe(true);
  });

  test("parses a branching DAG and preserves record order", () => {
    const content = `plan "01-main"
goal: Branch.

node "02-a" verify tsc
instruction: First root.
end

node "03-b" after "02-a" verify test
instruction: After a.
end

node "04-c" verify tsc
instruction: Second root.
end

node "05-d" after "03-b" "04-c" verify test
instruction: Join.
end`;
    const parsed = accepted(content);
    expect(parsed.nodes.map((entry) => entry.id)).toEqual(["02-a", "03-b", "04-c", "05-d"]);
    expect(parsed.nodes[3]?.after).toEqual(["03-b", "04-c"]);
    expect(accepted(serializePlanDsl(parsed))).toEqual(parsed);
  });

  test("accepts after on its own line as well as on the node header", () => {
    const parsed = accepted(`plan "01-main"
goal: g

node "02-a" verify tsc
instruction: First.
end

node "03-b" verify test
after "02-a"
instruction: Second.
end`);
    expect(parsed.nodes[1]?.after).toEqual(["02-a"]);
  });

  test("accepts blank lines, indentation, and CRLF", () => {
    const indented = SPEC_EXAMPLE.split("\n")
      .map((line) => `  ${line}`)
      .join("\n\n");
    expect(accepted(indented)).toEqual(SPEC_PLAN);
    expect(accepted(SPEC_EXAMPLE.replace(/\n/g, "\r\n"))).toEqual(SPEC_PLAN);
  });

  test("preserves fenced instruction, approach, phase, and goal text raw", () => {
    const content = `plan "01-main"
goal:
TC_EDIT_BEGIN
line one

  line two
TC_EDIT_END

node "02-a" verify test
instruction:
TC_EDIT_BEGIN
alpha
  beta
TC_EDIT_END
approach: TC_EDIT_BEGIN
approach line
TC_EDIT_END
phase:
TC_EDIT_BEGIN
  phase raw
TC_EDIT_END
end`;
    const parsed = accepted(content);
    expect(parsed.goal).toBe("line one\n\n  line two");
    expect(parsed.nodes[0]?.instruction).toBe("alpha\n  beta");
    expect(parsed.nodes[0]?.approach).toBe("approach line");
    expect(parsed.nodes[0]?.phase).toBe("  phase raw");
    expect(accepted(serializePlanDsl(parsed))).toEqual(parsed);
  });

  test("accepts a trailing finish and returns the final node id", () => {
    const parsed = parsePlanDsl(`${SPEC_EXAMPLE}\nfinish`);
    if (!parsed.ok) {
      throw new Error(parsed.diagnostics);
    }
    expect(parsed.finalNodeId).toBe("03-impl");
    expect(parsePlanDsl(SPEC_EXAMPLE)).toMatchObject({ ok: true, finalNodeId: null });
  });

  test("rejects a final node that does not verify test", () => {
    expect(
      rejected(
        `${SPEC_EXAMPLE.replace("verify test\ninstruction: Implement", "verify tsc\ninstruction: Implement")}\nfinish`,
      ),
    ).toContain('must verify "test"');
  });

  test("rejects legacy stage/task/edit records with a dedicated diagnostic", () => {
    const stageFirst = rejected(`stage "02-current" plan "01-main"
goal: g
end`);
    expect(stageFirst).toContain("PLAN_LEGACY_RECORD");

    const detailed = parsePlanDslDetailed(`stage "02-current" plan "01-main"
goal: g
end`);
    expect(
      String(detailed.issues.find((issue) => issue.code === "PLAN_LEGACY_RECORD")?.stage),
    ).toBe("plan-protocol");

    const taskAfterNode = rejected(`plan "01-main"
goal: g

node "02-a" verify test
instruction: x
end

task "03-b" stage "02-a" verify test
instruction: x
end`);
    expect(taskAfterNode).toContain("PLAN_LEGACY_RECORD");

    const editAfterNode = rejected(`plan "01-main"
goal: g

node "02-a" verify test
instruction: x
end

edit "03-b" task "02-a" modify value answer in src/a.ts
instruction: x
end`);
    expect(editAfterNode).toContain("PLAN_LEGACY_RECORD");
  });

  test("uses plan-protocol and plan-graph diagnostic stages", () => {
    const graph = parsePlanDslDetailed(`plan "01-main"
goal: g

node "02-a" after "03-b" verify test
instruction: x
end

node "03-b" after "02-a" verify test
instruction: x
end`);
    expect(String(graph.issues.find((issue) => issue.code === "PLAN_CYCLE")?.stage)).toBe(
      "plan-graph",
    );

    const patch = parsePlanPatchDetailed(`patch
stage+ "04-next" plan "01-main"
goal: g
end`);
    expect(String(patch.issues.find((issue) => issue.code === "PLAN_LEGACY_RECORD")?.stage)).toBe(
      "plan-protocol",
    );
  });
});

describe("Plan DSL validation through the parser", () => {
  test("rejects dangling, self, and cyclic after edges", () => {
    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" verify test
instruction: x
end

node "03-b" after "09-missing" verify test
instruction: x
end`),
    ).toContain("#09-missing");

    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" after "02-a" verify test
instruction: x
end`),
    ).toContain("lists itself");

    const cycle = rejected(`plan "01-main"
goal: g

node "02-a" after "03-b" verify test
instruction: x
end

node "03-b" after "02-a" verify test
instruction: x
end`);
    expect(cycle).toContain("cycle");
    expect(cycle).toContain("#02-a");
    expect(cycle).toContain("#03-b");
  });

  test("rejects an unknown verify and a missing instruction", () => {
    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" verify lint
instruction: x
end`),
    ).toContain('verify must be "tsc" or "test"');

    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" verify test
end`),
    ).toContain("needs instruction:");
  });

  test("rejects unsafe and duplicate hints", () => {
    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" verify test
instruction: x
hint file ../a.ts
end`),
    ).toContain("writable repo-relative path");

    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" verify test
instruction: x
hint value answer in src/a.ts
hint value answer in src/a.ts
end`),
    ).toContain("more than once");
  });

  test("rejects hint clear and approach/phase clear in an initial Plan", () => {
    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" verify test
instruction: x
hint clear
end`),
    ).toContain("only in a node~ patch");

    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" verify test
instruction: x
approach clear
end`),
    ).toContain("only in a node~ patch");

    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" verify test
instruction: x
phase clear
end`),
    ).toContain("only in a node~ patch");
  });

  test("rejects malformed hint forms and unknown spaces", () => {
    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" verify test
instruction: x
hint answer in src/a.ts
end`),
    ).toContain("hint <space> <symbol> in <path>");

    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" verify test
instruction: x
hint function answer in src/a.ts
end`),
    ).toContain("space");

    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" verify test
instruction: x
hint file src/a.ts symbol
end`),
    ).toContain("hint file <path>");
  });

  test("rejects duplicate ids without imposing an arbitrary node cap", () => {
    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" verify test
instruction: x
end

node "02-a" verify test
instruction: x
end`),
    ).toContain("reuses node id");

    const many = Array.from({ length: 200 }, (_, index) => node(`${10 + index}-n-${index}`));
    expect(accepted(serializePlanDsl(plan(many))).nodes.length).toBe(200);
  });

  test("a plan without finish may end in a tsc node", () => {
    const parsed = accepted(`plan "01-main"
goal: g

node "02-a" verify tsc
instruction: x
end`);
    expect(parsed.nodes[0]?.verify).toBe("tsc");
    expect(validatePlan(parsed)).toBeNull();
  });
});

describe("Plan DSL tolerant diagnostics", () => {
  test("strips a whole-reply markdown fence with a warning", () => {
    const parsed = parsePlanDslDetailed(`\`\`\`\n${SPEC_EXAMPLE}\n\`\`\``);
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.plan).toEqual(SPEC_PLAN);
    expect(parsed.issues.some((issue) => issue.code === "PLAN_WHOLE_REPLY_FENCE")).toBe(true);
  });

  test("accepts bare ids with a warning", () => {
    const parsed = parsePlanDslDetailed(SPEC_EXAMPLE.replace('plan "01-main"', "plan 01-main"));
    expect(parsed.ok).toBe(true);
    expect(parsed.issues.some((issue) => issue.code === "PLAN_BARE_ID")).toBe(true);
    expect(rejected('plan "1-main"\ngoal: g')).toContain("must be a string node id");
    expect(rejected('plan "01-Main"\ngoal: g')).toContain("must be a string node id");
  });

  test("recovers a missing end at a record boundary or EOF with a warning", () => {
    const atEof = parsePlanDslDetailed(SPEC_EXAMPLE.replace(/\nend$/, ""));
    expect(atEof.ok).toBe(true);
    expect(atEof.issues.some((issue) => issue.code === "PLAN_MISSING_END")).toBe(true);

    const beforeSibling = parsePlanDslDetailed(`plan "01-main"
goal: g

node "02-a" verify test
instruction: x

node "03-b" verify test
instruction: y
end`);
    expect(beforeSibling.ok).toBe(true);
    expect(beforeSibling.issues.filter((issue) => issue.code === "PLAN_MISSING_END")).toHaveLength(
      1,
    );
  });

  test("rejects an unclosed field fence as truncated", () => {
    const parsed = parsePlanDslDetailed(`plan "01-main"
goal:
TC_EDIT_BEGIN
unterminated`);
    expect(parsed.ok).toBe(false);
    expect(parsed.truncated).toBe(true);
    expect(parsed.issues.some((issue) => issue.code === "PLAN_UNCLOSED_FENCE")).toBe(true);
  });

  test("rejects legacy hyphen and backtick field fences", () => {
    for (const fence of ["-----", "``````"]) {
      const parsed = parsePlanDslDetailed(`plan "01-main"
goal:
${fence}
text
${fence}`);
      expect(parsed.ok).toBe(false);
      expect(parsed.issues.some((issue) => issue.code === "PLAN_LEGACY_FENCE")).toBe(true);
    }
  });

  test("rejects JSON, prose, unknown records, and duplicate fields", () => {
    expect(rejected('{"id":"01-main","goal":"g","nodes":[]}')).toContain(
      "JSON plan objects are not accepted",
    );
    expect(rejected(`Here is the plan:\n\n${SPEC_EXAMPLE}`)).toContain("expected the plan header");
    expect(rejected(`${SPEC_EXAMPLE}\n\ntodo: later`)).toContain("unknown record header");
    expect(rejected(`${SPEC_EXAMPLE}\n\nend`)).toContain('unexpected "end"');

    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" verify test
instruction: a
instruction: b
end`),
    ).toContain("carries instruction more than once");

    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" verify test
verify tsc
instruction: x
end`),
    ).toContain("carries verify more than once");

    expect(
      rejected(`plan "01-main"
goal: g

node "02-a" after "03-b" verify test
instruction: x
after "04-c"
end

node "03-b" verify test
instruction: b
end

node "04-c" verify test
instruction: c
end`),
    ).toContain("carries after more than once");
  });
});

describe("Plan DSL serialize", () => {
  test("serializes the canonical example byte-for-byte", () => {
    expect(serializePlanDsl(SPEC_PLAN)).toBe(SPEC_EXAMPLE);
    expect(serializePlanDsl(SPEC_PLAN)).not.toMatch(/^finish$/m);
  });

  test("round-trips multiline text, hints, approach, and phase", () => {
    const shape = plan(
      [
        node("02-shape", {
          verify: "tsc",
          instruction: "Change the shape.\nKeep the helper in sync.",
          hints: [
            { path: "src/a.ts", symbol: "Formatter", kind: "type" },
            { path: "src/a.ts", symbol: "formatNumber", kind: "value" },
          ],
          approach: "Scaffold first.\nThen fill bodies.",
          phase: "scaffold",
        }),
      ],
      "Migrate.\nThen rename.",
    );
    const wire = serializePlanDsl(shape);
    expect(wire).toContain("hint type Formatter in src/a.ts");
    expect(wire).toContain("hint value formatNumber in src/a.ts");
    expect(accepted(wire)).toEqual(shape);
    expect(serializePlanDsl(accepted(wire))).toBe(wire);
  });

  test("chooses a safe one-line or fenced form", () => {
    const shape = plan([
      node("02-a", {
        instruction: "alpha\n-----\nbeta",
        approach: "  padded approach  ",
        phase: "phase",
      }),
    ]);
    const wire = serializePlanDsl(shape);
    expect(wire).toContain("instruction:\nTC_EDIT_BEGIN\nalpha\n-----\nbeta\nTC_EDIT_END");
    expect(wire).toContain("approach:\nTC_EDIT_BEGIN\n  padded approach  \nTC_EDIT_END");
    expect(accepted(wire)).toEqual(shape);
  });

  test("throws when Plan text contains the close sentinel line", () => {
    expect(() => serializePlanDsl(plan([], "before\nTC_EDIT_END\nafter"))).toThrow(/literal line/);
  });
});

const PATCH_EXAMPLE = `patch
node+ "04-impl" after "03-scaffold" verify test
instruction: Implement evaluate.
hint value evaluate in src/workbook.ts
approach: Prefer targeted edits.
phase: implement
end
node~ "02-scaffold"
after "01-main" "03-other"
verify tsc
instruction: Rework the skeleton.
hint clear
approach clear
phase clear
end
node- "05-repair"
end
finish`;

const PATCH_OPS: PlanPatchOp[] = [
  {
    kind: "node-add",
    id: "04-impl",
    after: ["03-scaffold"],
    verify: "test",
    instruction: "Implement evaluate.",
    hints: [{ path: "src/workbook.ts", symbol: "evaluate", kind: "value" }],
    approach: "Prefer targeted edits.",
    phase: "implement",
  },
  {
    kind: "node-update",
    id: "02-scaffold",
    after: ["01-main", "03-other"],
    verify: "tsc",
    instruction: "Rework the skeleton.",
    hints: [],
    approach: null,
    phase: null,
  },
  { kind: "node-remove", id: "05-repair" },
];

describe("plan sentinel hard switch", () => {
  test("rejects the removed angle-bracket sentinel", () => {
    const old = `plan "01-main"
goal:
<<<TC_EDIT_BEGIN>>>
g
<<<TC_EDIT_END>>>

node "02-a" verify tsc
instruction: x
end
finish`;
    const parsed = parsePlan(old);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.diagnostics).toContain("TC_EDIT_BEGIN");
  });
});

describe("Plan patch DSL parse", () => {
  test("parses every node operator and finish", () => {
    const patch = acceptedPatch(PATCH_EXAMPLE);
    expect(patch).toEqual({ ops: PATCH_OPS, finish: true });
  });

  test("accepts blank lines, indentation, and CRLF", () => {
    const indented = PATCH_EXAMPLE.split("\n")
      .map((line) => `  ${line}`)
      .join("\n\n");
    expect(acceptedPatch(indented)).toEqual(acceptedPatch(PATCH_EXAMPLE));
    expect(acceptedPatch(PATCH_EXAMPLE.replace(/\n/g, "\r\n"))).toEqual(
      acceptedPatch(PATCH_EXAMPLE),
    );
  });

  test("parses empty updates and optional fields", () => {
    const empty = acceptedPatch(`patch
node~ "02-a"
end
node~ "03-b" verify test
end
node~ "04-c"
after
end
node~ "05-d"
hint clear
approach clear
phase clear
end`);
    expect(empty.ops).toEqual([
      { kind: "node-update", id: "02-a" },
      { kind: "node-update", id: "03-b", verify: "test" },
      { kind: "node-update", id: "04-c", after: [] },
      {
        kind: "node-update",
        id: "05-d",
        hints: [],
        approach: null,
        phase: null,
      },
    ]);
  });

  test("node+ accepts header or body after, and defaults to no dependencies", () => {
    const patch = acceptedPatch(`patch
node+ "04-a" after "03-b" verify tsc
instruction: x
end
node+ "05-c" verify test
after "04-a"
instruction: y
end
node+ "06-d" verify test
instruction: z
end`);
    expect(patch.ops.map((op) => (op.kind === "node-add" ? op.after : null))).toEqual([
      ["03-b"],
      ["04-a"],
      [],
    ]);
  });

  test("parses empty patches and a bare finish", () => {
    expect(acceptedPatch("patch")).toEqual({ ops: [], finish: false });
    expect(acceptedPatch("patch\nfinish")).toEqual({ ops: [], finish: true });
  });

  test("recovers a missing end at a patch boundary", () => {
    const atEof = parsePlanPatchDetailed('patch\nnode~ "02-a"\ninstruction: x');
    expect(atEof.ok).toBe(true);
    expect(atEof.issues.some((issue) => issue.code === "PLAN_MISSING_END")).toBe(true);
    const beforeSibling = parsePlanPatchDetailed(
      'patch\nnode~ "02-a"\ninstruction: x\nnode- "03-b"\nend',
    );
    expect(beforeSibling.ok).toBe(true);
    expect(beforeSibling.issues.some((issue) => issue.code === "PLAN_MISSING_END")).toBe(true);
  });
});

describe("Plan patch DSL rejection", () => {
  test("rejects legacy stage/task/edit operators and plan~", () => {
    for (const content of [
      `patch
stage+ "04-next" plan "01-main"
goal: g
end`,
      `patch
task+ "04-next" stage "02-a" verify test
instruction: x
end`,
      `patch
edit+ "04-change" task "02-a" modify value answer in src/a.ts
instruction: x
end`,
      `patch
plan~ "01-main"
goal: g
end`,
    ]) {
      expect(rejectedPatch(content)).toContain("PLAN_LEGACY_RECORD");
    }
  });

  test("rejects a missing header, JSON, unknown records, and stray end", () => {
    expect(rejectedPatch("")).toContain("the reply is empty");
    expect(rejectedPatch('plan "01-main"\ngoal: g')).toContain("expected the patch header");
    expect(rejectedPatch('{"ops":[],"finish":false}')).toContain("JSON patch objects");
    expect(rejectedPatch("patch\nnope\nend")).toContain("unknown patch record");
    expect(rejectedPatch("patch\nend")).toContain('unexpected "end"');
    expect(rejectedPatch(`patch\n${PATCH_EXAMPLE}`)).toContain("patch header is a singleton");
  });

  test("rejects trailing records after finish", () => {
    expect(rejectedPatch('patch\nfinish\nnode~ "02-a"\nend')).toContain(
      "finish must be the last line",
    );
    expect(rejectedPatch("patch\nfinish\nfinish")).toContain("finish must be the last line");
  });

  test("rejects malformed headers, unknown verifies, and missing instructions", () => {
    expect(rejectedPatch('patch\nnode+ "04-a" verify lint\ninstruction: x\nend')).toContain(
      'verify must be "tsc" or "test"',
    );
    expect(rejectedPatch('patch\nnode+ "04-a" verify test\nend')).toContain("needs instruction:");
    expect(rejectedPatch('patch\nnode+ "04-a" after verify test\ninstruction: x\nend')).toContain(
      "after clause",
    );
    expect(rejectedPatch('patch\nnode~ "04-a"\nverify lint\nend')).toContain(
      'verify must be "tsc" or "test"',
    );
    expect(rejectedPatch('patch\nnode- "04-a" extra\nend')).toContain(
      'must be "node- \\"NN-slug\\""',
    );
    expect(rejectedPatch('patch\nnode~ "04-a"\ninstruction: a\ninstruction: b\nend')).toContain(
      "carries instruction more than once",
    );
  });

  test("rejects duplicate node+ ids inside one patch", () => {
    expect(
      rejectedPatch(`patch
node+ "04-a" verify test
instruction: x
end
node+ "04-a" verify test
instruction: y
end`),
    ).toContain("reuses node id");
  });

  test("rejects an unsafe hint through the graph validator", () => {
    const state = stateOf();
    expect(() =>
      applied(
        state,
        `patch
node+ "04-a" verify test
instruction: x
hint file ../a.ts
end`,
      ),
    ).toThrow("writable repo-relative path");
  });
});

describe("Plan patch DSL serialize", () => {
  test("round-trips the combined example byte-for-byte", () => {
    const patch = acceptedPatch(PATCH_EXAMPLE);
    expect(serializePlanPatch(patch)).toBe(PATCH_EXAMPLE);
    expect(acceptedPatch(serializePlanPatch(patch))).toEqual(patch);
  });

  test("round-trips empty updates, clears, and empty after", () => {
    const content = `patch
node~ "02-a"
end
node~ "03-b"
after
hint clear
approach clear
phase clear
end`;
    const patch = acceptedPatch(content);
    expect(serializePlanPatch(patch)).toBe(content);
    expect(acceptedPatch(serializePlanPatch(patch))).toEqual(patch);
  });

  test("round-trips fenced text", () => {
    const content = `patch
node~ "02-a"
instruction:
TC_EDIT_BEGIN
alpha
  beta
TC_EDIT_END
approach:
TC_EDIT_BEGIN
scaffold
then fill bodies
TC_EDIT_END
end`;
    expect(serializePlanPatch(acceptedPatch(content))).toBe(content);
  });
});

describe("applyPlanPatch", () => {
  function basePlan(): Plan {
    return plan([
      node("02-scaffold", { verify: "tsc" }),
      node("03-impl", { after: ["02-scaffold"] }),
      node("04-final", { after: ["03-impl"] }),
    ]);
  }

  function baseState(): PlanRunState {
    return initialState(basePlan());
  }

  test("node+ appends work and finish moves the final node", () => {
    const state = applied(
      baseState(),
      `patch
node+ "05-extra" after "04-final" verify test
instruction: Add the extra behavior.
hint value extra in src/a.ts
end
finish`,
    );
    expect(state.nodes.map((entry) => entry.id)).toEqual([
      "02-scaffold",
      "03-impl",
      "04-final",
      "05-extra",
    ]);
    expect(state.nodeStatus.get("05-extra")).toBe("pending");
    expect(state.finalNodeId).toBe("05-extra");
    expect(nodeById(state, "05-extra")?.hints).toEqual([
      { path: "src/a.ts", symbol: "extra", kind: "value" },
    ]);
  });

  test("node~ replaces after, hints, approach, and phase", () => {
    const state = stateOf([
      node("02-scaffold", { verify: "tsc" }),
      node("03-impl", { after: ["02-scaffold"] }),
      node("04-final", { after: ["03-impl"] }),
      node("05-other", { verify: "tsc" }),
    ]);
    const replaced = applied(
      state,
      `patch
node~ "03-impl"
after "05-other"
instruction: Implement after the other root.
hint value impl in src/a.ts
approach: Target edits first.
phase: implement
end`,
    );
    expect(nodeById(replaced, "03-impl")).toMatchObject({
      after: ["05-other"],
      instruction: "Implement after the other root.",
      hints: [{ path: "src/a.ts", symbol: "impl", kind: "value" }],
      approach: "Target edits first.",
      phase: "implement",
    });

    const replacedAgain = applied(
      replaced,
      `patch
node~ "03-impl"
hint file src/b.ts
approach: Prefer a whole-file write for this small module.
phase: finalize
end`,
    );
    expect(nodeById(replacedAgain, "03-impl")).toMatchObject({
      after: ["05-other"],
      instruction: "Implement after the other root.",
      hints: [{ path: "src/b.ts", symbol: "", kind: "file" }],
      approach: "Prefer a whole-file write for this small module.",
      phase: "finalize",
    });

    const cleared = applied(
      replacedAgain,
      `patch
node~ "03-impl"
after
hint clear
approach clear
phase clear
end`,
    );
    expect(nodeById(cleared, "03-impl")).toMatchObject({
      after: [],
      hints: [],
    });
    expect(nodeById(cleared, "03-impl")?.approach).toBeUndefined();
    expect(nodeById(cleared, "03-impl")?.phase).toBeUndefined();
  });

  test("a changed failed node reopens; an unchanged failed node stays failed", () => {
    const state = baseState();
    state.nodeStatus.set("03-impl", "failed");

    const unchanged = applied(state, 'patch\nnode~ "03-impl"\nend');
    expect(unchanged.nodeStatus.get("03-impl")).toBe("failed");

    const repaired = applied(
      state,
      `patch
node~ "03-impl"
instruction: Repair the implementation.
end`,
    );
    expect(repaired.nodeStatus.get("03-impl")).toBe("pending");
  });

  test("removing pending and failed nodes works; passed/review/in-progress nodes are held", () => {
    const pending = applied(baseState(), 'patch\nnode- "04-final"\nend');
    expect(pending.nodes.map((entry) => entry.id)).toEqual(["02-scaffold", "03-impl"]);

    const failed = baseState();
    failed.nodeStatus.set("04-final", "failed");
    const removedFailed = applied(failed, 'patch\nnode- "04-final"\nend');
    expect(removedFailed.nodes.map((entry) => entry.id)).toEqual(["02-scaffold", "03-impl"]);

    const passed = baseState();
    passed.nodeStatus.set("02-scaffold", "passed");
    expect(() => applied(passed, 'patch\nnode- "02-scaffold"\nend')).toThrow(
      "passed node #02-scaffold cannot be removed",
    );

    const review = baseState();
    review.nodeStatus.set("04-final", "review");
    expect(() => applied(review, 'patch\nnode- "04-final"\nend')).toThrow("is in review");

    const inProgress = baseState();
    inProgress.nodeStatus.set("03-impl", "in-progress");
    expect(() => applied(inProgress, 'patch\nnode- "03-impl"\nend')).toThrow(/in[- ]progress/);
  });

  test("a passed node cannot be mutated", () => {
    const state = baseState();
    state.nodeStatus.set("02-scaffold", "passed");
    expect(() =>
      applied(
        state,
        `patch
node~ "02-scaffold"
instruction: Change the passed node.
end`,
      ),
    ).toThrow("passed node #02-scaffold is immutable");
  });

  test("node+ reusing an existing id is rejected", () => {
    expect(() =>
      applied(
        baseState(),
        `patch
node+ "02-scaffold" verify test
instruction: Duplicate.
end`,
      ),
    ).toThrow("reuses node id");
  });

  test("removing a dependency leaves a dangling graph and is rejected", () => {
    expect(() => applied(baseState(), 'patch\nnode- "02-scaffold"\nend')).toThrow(
      "depends on #02-scaffold, which is not in the plan",
    );
  });

  test("a patch that creates a cycle is rejected and names the cycle", () => {
    expect(() =>
      applied(
        baseState(),
        `patch
node~ "02-scaffold"
after "04-final"
end`,
      ),
    ).toThrow("cycle");
  });

  test("finish requires the merged last node to verify test", () => {
    const state = stateOf([
      node("02-scaffold", { verify: "tsc" }),
      node("03-impl", { after: ["02-scaffold"] }),
      node("04-final", { after: ["03-impl"], verify: "tsc" }),
    ]);
    expect(() => applied(state, "patch\nfinish")).toThrow('must verify "test"');
  });

  test("appending after the final node needs a new finish", () => {
    const state = applied(baseState(), "patch\nfinish");
    expect(state.finalNodeId).toBe("04-final");
    const append = `patch
node+ "05-extra" after "04-final" verify test
instruction: More work.
end`;

    expect(() => applied(state, append)).toThrow("no longer last");
    expect(() => applied(state, append)).toThrow("emit finish");

    const finished = applied(state, `${append}\nfinish`);
    expect(finished.finalNodeId).toBe("05-extra");
  });

  test("removing the final node without a new finish is rejected", () => {
    const state = applied(baseState(), "patch\nfinish");
    expect(() => applied(state, 'patch\nnode- "04-final"\nend')).toThrow("no longer last");
  });

  test("in-place repair preserves finalNodeId", () => {
    const state = applied(baseState(), "patch\nfinish");
    state.nodeStatus.set("04-final", "failed");
    const repaired = applied(
      state,
      `patch
node~ "04-final"
instruction: Repair the final test.
end`,
    );
    expect(repaired.finalNodeId).toBe("04-final");
    expect(repaired.nodeStatus.get("04-final")).toBe("pending");
  });

  test("a rejected patch leaves the previous state untouched", () => {
    const state = baseState();
    const before = snapshot(state);
    const merged = applyPlanPatch(
      state,
      acceptedPatch(`patch
node~ "03-impl"
instruction: Change it.
end
node- "09-missing"
end`),
    );
    expect(merged.ok).toBe(false);
    expect(snapshot(state)).toBe(before);
  });

  test("a patch preserves the previous final node when it stays last", () => {
    const state = applied(baseState(), "patch\nfinish");
    const repaired = applied(
      state,
      `patch
node~ "04-final"
instruction: Keep this node final.
end`,
    );
    expect(repaired.finalNodeId).toBe("04-final");
  });

  test("the appended node becomes ready only after its dependency passes", () => {
    const state = applied(
      baseState(),
      `patch
node+ "05-extra" after "04-final" verify test
instruction: More work.
end`,
    );
    expect(readyNodes(state).map((entry) => entry.id)).toEqual(["02-scaffold"]);
    state.nodeStatus.set("02-scaffold", "passed");
    expect(readyNodes(state).map((entry) => entry.id)).toEqual(["03-impl"]);
    state.nodeStatus.set("03-impl", "passed");
    expect(readyNodes(state).map((entry) => entry.id)).toEqual(["04-final"]);
    state.nodeStatus.set("04-final", "passed");
    expect(readyNodes(state).map((entry) => entry.id)).toEqual(["05-extra"]);
  });
});

describe("patch DSL validation of final and custom nodes", () => {
  test("a patch may add nodes with no dependencies and custom verifies", () => {
    const verify: WorkVerify = "tsc";
    const patch = acceptedPatch(`patch
node+ "04-a" verify ${verify}
instruction: x
end`);
    expect(patch.ops[0]).toMatchObject({ kind: "node-add", after: [], verify: "tsc" });
  });
});
