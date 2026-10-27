import { describe, expect, test } from "bun:test";
import {
  parsePlan,
  parsePlanDsl,
  parsePlanDslDetailed,
  readPlan,
  serializePlanDsl,
} from "./plan-dsl";
import type { PlanReply, WorkNode } from "./tasks";

const SPEC_EXAMPLE = `plan
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

const SPEC_PLAN: PlanReply = {
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

function plan(nodes: WorkNode[], goal = "Make the change."): PlanReply {
  return { goal, nodes, amends: [] };
}

function accepted(content: string): PlanReply {
  const parsed = parsePlanDsl(content);
  if (!parsed.ok) {
    throw new Error(`expected an accepted plan, got ${parsed.diagnostics}`);
  }
  return parsed.reply;
}

function rejected(content: string): string {
  const parsed = parsePlanDsl(content);
  if (parsed.ok) {
    throw new Error("expected the plan to be rejected");
  }
  return parsed.diagnostics;
}

function acceptedFragment(content: string): PlanReply {
  const parsed = parsePlanDsl(content, { initial: false });
  if (!parsed.ok) {
    throw new Error(`expected an accepted reply, got ${parsed.diagnostics}`);
  }
  return parsed.reply;
}

function rejectedFragment(content: string): string {
  const parsed = parsePlanDsl(content, { initial: false });
  if (parsed.ok) {
    throw new Error("expected the reply to be rejected");
  }
  return parsed.diagnostics;
}

describe("Plan DSL parse", () => {
  test("parses the canonical WorkNode DAG example", () => {
    expect(accepted(SPEC_EXAMPLE)).toEqual(SPEC_PLAN);
    expect(parsePlan(SPEC_EXAMPLE).ok).toBe(true);
    expect(readPlan(SPEC_EXAMPLE).ok).toBe(true);
  });

  test("accepts a legacy quoted plan id without keeping a plan-root id", () => {
    const parsed = accepted(SPEC_EXAMPLE.replace("plan\n", 'plan "01-main"\n'));
    expect(parsed).toEqual(SPEC_PLAN);
  });

  test("parses a branching DAG and preserves record order", () => {
    const content = `plan
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
    const parsed = accepted(`plan
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
    const content = `plan
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

  test("the initial plan requires a goal", () => {
    const diagnostics = rejected(`plan
node "02-a" verify test
instruction: x
end`);
    expect(diagnostics).toContain("PLAN_MISSING_FIELD");
    expect(diagnostics).toContain("needs a non-empty goal");
  });

  test("the initial plan may not amend nodes", () => {
    const diagnostics = rejected(`plan
goal: g
amend "02-a"
instruction: x
end`);
    expect(diagnostics).toContain("initial plan may not amend");
  });
});

describe("Plan DSL validation through the parser", () => {
  test("rejects dangling, self, and cyclic after edges", () => {
    expect(
      rejected(`plan
goal: g
node "02-a" verify test
instruction: x
after "09-missing"
end`),
    ).toContain("not in the plan");

    expect(
      rejected(`plan
goal: g
node "02-a" verify test
instruction: x
after "02-a"
end`),
    ).toContain("lists itself");

    const cycle = rejected(`plan
goal: g
node "02-a" verify test
instruction: x
after "03-b"
end
node "03-b" verify test
instruction: y
after "02-a"
end`);
    expect(cycle).toContain("PLAN_CYCLE");
    expect(cycle).toContain("#02-a -> #03-b -> #02-a");
  });

  test("rejects an unknown verify and a missing instruction", () => {
    expect(
      rejected(`plan
goal: g
node "02-a" verify lint
instruction: x
end`),
    ).toContain('verify must be "tsc" or "test"');

    expect(
      rejected(`plan
goal: g
node "02-a" verify test
end`),
    ).toContain("needs instruction");
  });

  test("rejects unsafe and duplicate hints", () => {
    expect(
      rejected(`plan
goal: g
node "02-a" verify test
instruction: x
hint value a in ../a.ts
end`),
    ).toContain("not a writable repo-relative path");

    expect(
      rejected(`plan
goal: g
node "02-a" verify test
instruction: x
hint value a in src/a.ts
hint value a in src/a.ts
end`),
    ).toContain("more than once");
  });

  test("rejects clear fields in an initial node record", () => {
    for (const field of ["hint clear", "approach clear", "phase clear"]) {
      expect(
        rejected(`plan
goal: g
node "02-a" verify test
instruction: x
${field}
end`),
      ).toContain("allowed only in an amend record");
    }
  });

  test("rejects malformed hint forms and unknown spaces", () => {
    expect(
      rejected(`plan
goal: g
node "02-a" verify test
instruction: x
hint file a.ts extra
end`),
    ).toContain("hint file <path>");

    expect(
      rejected(`plan
goal: g
node "02-a" verify test
instruction: x
hint widget a in src/a.ts
end`),
    ).toContain("must be one of value, type, namespace");
  });

  test("rejects duplicate ids without imposing an arbitrary node cap", () => {
    expect(
      rejected(`plan
goal: g
node "02-a" verify test
instruction: x
end
node "02-a" verify test
instruction: y
end`),
    ).toContain("PLAN_DUPLICATE_ID");
  });

  test("uses plan-protocol and plan-graph diagnostic stages", () => {
    const protocol = rejected(`plan
goal: g
node "02-a" verify test
end`);
    expect(protocol).toContain("stage: plan-protocol");

    const graph = rejected(`plan
goal: g
node "02-a" verify test
instruction: x
after "09-missing"
end`);
    expect(graph).toContain("stage: plan-graph");
  });
});

describe("Plan DSL tolerant diagnostics", () => {
  test("strips a whole-reply markdown fence with a warning", () => {
    const parsed = parsePlanDslDetailed(`\`\`\`text\n${SPEC_EXAMPLE}\n\`\`\``);
    expect(parsed.ok).toBe(true);
    expect(parsed.issues.some((issue) => issue.code === "PLAN_WHOLE_REPLY_FENCE")).toBe(true);
  });

  test("accepts bare ids with a warning", () => {
    const parsed = parsePlanDslDetailed(`plan
goal: g
node 02-a verify test
instruction: x
end`);
    expect(parsed.ok).toBe(true);
    expect(parsed.issues.some((issue) => issue.code === "PLAN_BARE_ID")).toBe(true);
  });

  test("recovers a missing end at a record boundary or EOF with a warning", () => {
    const boundary = parsePlanDslDetailed(`plan
goal: g
node "02-a" verify test
instruction: x
node "03-b" verify test
instruction: y
end`);
    expect(boundary.ok).toBe(true);
    expect(boundary.issues.some((issue) => issue.code === "PLAN_MISSING_END")).toBe(true);

    const eof = parsePlanDslDetailed(`plan
goal: g
node "02-a" verify test
instruction: x`);
    expect(eof.ok).toBe(true);
    expect(eof.issues.some((issue) => issue.code === "PLAN_MISSING_END")).toBe(true);
  });

  test("rejects an unclosed field fence as truncated", () => {
    const parsed = parsePlanDslDetailed(`plan
goal: g
node "02-a" verify test
instruction:
TC_EDIT_BEGIN
never closed`);
    expect(parsed.ok).toBe(false);
    expect(parsed.truncated).toBe(true);
    expect(parsed.issues.some((issue) => issue.code === "PLAN_UNCLOSED_FENCE")).toBe(true);
  });

  test("rejects legacy hyphen and backtick field fences", () => {
    expect(
      rejected(`plan
goal: g
node "02-a" verify test
instruction:
------
x
------
end`),
    ).toContain("PLAN_LEGACY_FENCE");
  });

  test("rejects JSON, prose, unknown records, and duplicate fields", () => {
    expect(rejected(`{"plan": "x"}`)).toContain("JSON plan objects are not accepted");
    expect(rejected(`hello world`)).toContain("unknown record header");
    expect(
      rejected(`plan
goal: g
node "02-a" verify test
instruction: x
verify tsc
end`),
    ).toContain("carries verify more than once");
  });

  test("rejects legacy finish, patch, and node operators", () => {
    for (const content of [
      `finish`,
      `patch`,
      `node+ "02-a" verify test
instruction: x
end`,
      `node~ "02-a"
instruction: x
end`,
      `node- "02-a"
end`,
    ]) {
      const diagnostics = rejected(content);
      expect(diagnostics).toContain("PLAN_LEGACY_RECORD");
    }
  });
});

describe("amend records", () => {
  test("parses every replacement field", () => {
    const parsed = acceptedFragment(`amend "03-impl"
after "02-scaffold"
verify tsc
instruction: Rewrite the return path.
hint value evaluate in src/workbook.ts
approach clear
phase clear
end`);
    expect(parsed.nodes).toEqual([]);
    expect(parsed.amends).toEqual([
      {
        id: "03-impl",
        after: ["02-scaffold"],
        verify: "tsc",
        instruction: "Rewrite the return path.",
        hints: [{ path: "src/workbook.ts", symbol: "evaluate", kind: "value" }],
        approach: null,
        phase: null,
      },
    ]);
  });

  test("supports hint clear and empty after", () => {
    const parsed = acceptedFragment(`amend "03-impl"
after
hint clear
end`);
    expect(parsed.amends[0]).toEqual({ id: "03-impl", after: [], hints: [] });
  });

  test("rejects an amend with no fields and a malformed header", () => {
    expect(
      rejectedFragment(`amend "03-impl"
end`),
    ).toContain("needs at least one replacement field");

    expect(
      rejectedFragment(`amend
instruction: x
end`),
    ).toContain('must be "amend \\"NN-slug\\""');
  });

  test("accepts a reply that appends and amends together", () => {
    const parsed = acceptedFragment(`node "05-final" after "03-impl" verify test
instruction: Final.
end

amend "03-impl"
instruction: Narrow the repair.
end`);
    expect(parsed.nodes.map((entry) => entry.id)).toEqual(["05-final"]);
    expect(parsed.amends.map((amend) => amend.id)).toEqual(["03-impl"]);
  });

  test("incremental replies may name existing nodes in after", () => {
    const parsed = acceptedFragment(`node "05-final" after "03-impl" verify test
instruction: Final.
end`);
    expect(parsed.nodes[0]?.after).toEqual(["03-impl"]);
  });
});

describe("Plan DSL serialize", () => {
  test("serializes the canonical example byte-for-byte", () => {
    expect(serializePlanDsl(SPEC_PLAN)).toBe(SPEC_EXAMPLE);
  });

  test("round-trips multiline text, hints, approach, and phase", () => {
    const reply = plan([
      node("02-a", {
        instruction: "alpha\n  beta",
        hints: [{ path: "src/a.ts", symbol: "answer", kind: "value" }],
        approach: "line one\nline two",
        phase: "impl",
      }),
    ]);
    expect(accepted(serializePlanDsl(reply))).toEqual(reply);
  });

  test("serializes amends and clears", () => {
    const reply: PlanReply = {
      goal: "g",
      nodes: [],
      amends: [
        { id: "03-impl", instruction: "x", hints: [], approach: null, phase: null, after: [] },
      ],
    };
    const wire = serializePlanDsl(reply);
    expect(wire).toContain('amend "03-impl"');
    expect(wire).toContain("hint clear");
    expect(wire).toContain("approach clear");
    expect(wire).toContain("phase clear");
    expect(acceptedFragment(wire)).toEqual({ goal: "g", nodes: [], amends: reply.amends });
  });

  test("chooses a safe one-line or fenced form", () => {
    const wire = serializePlanDsl({
      goal: "line one\nline two",
      nodes: [node("02-a", { instruction: "x" })],
      amends: [],
    });
    expect(wire).toContain("goal:\nTC_EDIT_BEGIN\nline one\nline two\nTC_EDIT_END");
  });

  test("throws when Plan text contains the close sentinel line", () => {
    expect(() =>
      serializePlanDsl({
        goal: "g",
        nodes: [node("02-a", { instruction: "before\nTC_EDIT_END\nafter" })],
        amends: [],
      }),
    ).toThrow(/cannot serialize/);
  });
});

describe("plan sentinel hard switch", () => {
  test("rejects the removed angle-bracket sentinel", () => {
    const diagnostics = rejected(`plan
goal: g
node "02-a" verify test
instruction: <<<BEGIN>>>
x
<<<END>>>
end`);
    expect(diagnostics).toContain("PLAN_MISSING_END");
  });
});
