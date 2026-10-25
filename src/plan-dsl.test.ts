import { describe, expect, test } from "bun:test";
import {
  parsePlan,
  parsePlanDsl,
  parsePlanDslDetailed,
  parsePlanPatch,
  parsePlanPatchDetailed,
  readPlan,
  serializePlanDsl,
  serializePlanPatch,
} from "./plan-dsl";
import { MAX_NODES, MAX_RELATED_LOCS } from "./tasks";
import type { EditNode, Plan, Stage, TaskNode, TaskVerify } from "./tasks";

const SPEC_EXAMPLE = `plan "01-main"
goal: Make the failing test pass.

stage "02-current" plan "01-main"
goal: Fix the answer behavior.
end

task "03-first" stage "02-current" verify test
instruction: Make the failing test green.
end

edit "04-change" task "03-first" modify value answer in src/helper.ts
instruction: Change answer to return 2.
end`;

const CHANGE: EditNode = {
  id: "04-change",
  loc: { path: "src/helper.ts", symbol: "answer", kind: "value" },
  action: "modify",
  instruction: "Change answer to return 2.",
};

const FIRST: TaskNode = {
  id: "03-first",
  verify: "test",
  instruction: "Make the failing test green.",
  edits: [CHANGE],
};

const CURRENT: Stage = {
  id: "02-current",
  goal: "Fix the answer behavior.",
  tasks: [FIRST],
};

const SPEC_PLAN: Plan = {
  id: "01-main",
  goal: "Make the failing test pass.",
  stages: [CURRENT],
};

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

function edit(id: string, overrides: Partial<Omit<EditNode, "id">> = {}): EditNode {
  return {
    id,
    loc: { path: "src/a.ts", symbol: `symbol-${id}`, kind: "value" },
    action: "modify",
    instruction: `Do ${id}.`,
    ...overrides,
  };
}

function task(
  id: string,
  verify: TaskVerify = "test",
  edits: EditNode[] = [edit(`${id}-edit`)],
): TaskNode {
  return { id, verify, instruction: `Do ${id}.`, edits };
}

function stage(id: string, tasks: TaskNode[] = [task(`${id}-task`)]): Stage {
  return { id, goal: `Goal ${id}.`, tasks };
}

function planOf(stages: Stage[], goal = "Make the change."): Plan {
  return { id: "01-main", goal, stages };
}

describe("Plan DSL parse", () => {
  test("parses the spec §3.1 initial Plan example", () => {
    const plan = accepted(SPEC_EXAMPLE);
    expect(plan).toEqual(SPEC_PLAN);
    expect(parsePlan(SPEC_EXAMPLE).ok).toBe(true);
    expect(readPlan(SPEC_EXAMPLE).ok).toBe(true);
  });

  test("parses and serializes a whole-file write edit", () => {
    const content = `plan "01-main"
goal: Implement the parser.

stage "02-current" plan "01-main"
goal: Implement the parser.
end

task "03-first" stage "02-current" verify test
instruction: Implement the module.
end

edit "04-file" task "03-first" write src/json.ts
instruction: Write the complete module.
end`;
    const plan = accepted(content);
    const edit = plan.stages[0]?.tasks[0]?.edits[0];
    expect(edit?.action).toBe("write");
    expect(edit?.loc).toEqual({ path: "src/json.ts", symbol: "", kind: "file" });
    expect(accepted(serializePlanDsl(plan))).toEqual(plan);

    const patch = parsePlanPatch(`patch
edit+ "05-file" task "03-first" write src/other.ts
instruction: Write the other module.
end`);
    expect(patch.ok).toBe(true);
    if (patch.ok) {
      expect(serializePlanPatch(patch.patch)).toContain(
        'edit+ "05-file" task "03-first" write src/other.ts',
      );
    }

    const update = parsePlanPatch(`patch
edit~ "04-file"
write src/next.ts
end`);
    expect(update.ok).toBe(true);
    if (update.ok) {
      expect(serializePlanPatch(update.patch)).toContain("write src/next.ts");
    }
  });

  test("rejects a write edit that carries a symbol space", () => {
    expect(
      rejected(
        SPEC_EXAMPLE.replace(
          "modify value answer in src/helper.ts",
          "write value answer in src/helper.ts",
        ),
      ),
    ).toContain("write <path>");
  });

  test("accepts blank lines, surrounding indentation, and CRLF", () => {
    const indented = SPEC_EXAMPLE.split("\n")
      .map((line) => `  ${line}`)
      .join("\n\n");
    expect(accepted(indented)).toEqual(SPEC_PLAN);
    expect(accepted(SPEC_EXAMPLE.replace(/\n/g, "\r\n"))).toEqual(SPEC_PLAN);
  });

  test("preserves fenced goal and instruction text raw", () => {
    const content = `plan "01-main"
goal:
<<<TC_EDIT_BEGIN>>>
line one

  line two
<<<TC_EDIT_END>>>

stage "02-current" plan "01-main"
goal:
<<<TC_EDIT_BEGIN>>>
  indented goal
<<<TC_EDIT_END>>>
end

task "03-first" stage "02-current" verify test
instruction:
<<<TC_EDIT_BEGIN>>>
alpha
  beta
<<<TC_EDIT_END>>>
end

edit "04-change" task "03-first" modify value answer in src/helper.ts
instruction:
<<<TC_EDIT_BEGIN>>>
raw \`\`\` inner
<<<TC_EDIT_END>>>
end`;
    const plan = accepted(content);
    expect(plan.goal).toBe("line one\n\n  line two");
    expect(plan.stages[0]?.goal).toBe("  indented goal");
    expect(plan.stages[0]?.tasks[0]?.instruction).toBe("alpha\n  beta");
    expect(plan.stages[0]?.tasks[0]?.edits[0]?.instruction).toBe("raw ``` inner");
  });

  test("keeps legacy delimiter runs, done, and end as raw fenced text", () => {
    const body = ["alpha", "-----", "``````", "done", "end", "select inside"].join("\n");
    const content = `plan "01-main"
goal:
${"  <<<TC_EDIT_BEGIN>>>  "}
${body}
\t<<<TC_EDIT_END>>>\t

stage "02-current" plan "01-main"
goal: Current.
end

task "03-first" stage "02-current" verify test
instruction: Run the test.
end

edit "04-change" task "03-first" modify value answer in src/a.ts
instruction: Change it.
end`;
    const plan = accepted(content);
    expect(plan.goal).toBe(body);
    expect(accepted(serializePlanDsl(plan))).toEqual(plan);
  });

  test("keeps stage, task, and edit record order as sibling order", () => {
    const content = `plan "01-main"
goal: Make the change.

stage "02-current" plan "01-main"
goal: Current.
end

stage "05-next" plan "01-main"
goal: Next.
end

task "06-next-task" stage "05-next" verify test
instruction: Next task.
end

task "03-first" stage "02-current" verify tsc
instruction: First task.
end

task "04-second" stage "02-current" verify test
instruction: Second task.
end

edit "07-next-edit" task "06-next-task" modify value next in src/a.ts
instruction: Next edit.
end

edit "08-first-edit" task "03-first" modify value first in src/a.ts
instruction: First edit.
end

edit "09-second-edit" task "04-second" modify value second in src/a.ts
instruction: Second edit.
end`;
    const plan = accepted(content);
    expect(plan.stages.map((stageNode) => stageNode.id)).toEqual(["02-current", "05-next"]);
    expect(plan.stages[0]?.tasks.map((taskNode) => taskNode.id)).toEqual(["03-first", "04-second"]);
    expect(plan.stages[0]?.tasks[0]?.edits.map((editNode) => editNode.id)).toEqual([
      "08-first-edit",
    ]);
    expect(plan.stages[1]?.tasks[0]?.edits.map((editNode) => editNode.id)).toEqual([
      "07-next-edit",
    ]);
  });

  test("accepts a trailing finish only when the final task verifies test", () => {
    expect(accepted(`${SPEC_EXAMPLE}\nfinish`)).toEqual(SPEC_PLAN);
    expect(rejected(`${SPEC_EXAMPLE}\nfinish\nend`)).toContain("finish must be the last line");
    const tscFinal = `plan "01-main"
goal: Make the change.

stage "02-current" plan "01-main"
goal: Current.
end

task "03-first" stage "02-current" verify tsc
instruction: Only type-check.
end

edit "04-change" task "03-first" modify value answer in src/a.ts
instruction: Change it.
end

finish`;
    expect(rejected(tscFinal)).toContain('must verify "test"');
    expect(rejected('plan "01-main"\ngoal: g\nfinish')).toContain("at least one task");
  });

  test("returns the initial finalTaskId only when finish is present", () => {
    const withFinish = parsePlanDsl(`${SPEC_EXAMPLE}\nfinish`);
    if (!withFinish.ok) {
      throw new Error(withFinish.diagnostics);
    }
    expect(withFinish.finalTaskId).toBe("03-first");
    const withoutFinish = parsePlanDsl(SPEC_EXAMPLE);
    if (!withoutFinish.ok) {
      throw new Error(withoutFinish.diagnostics);
    }
    expect(withoutFinish.finalTaskId).toBeNull();
  });
});

describe("Plan DSL tolerant diagnostics", () => {
  test("reports a missing required field with PLAN_MISSING_FIELD", () => {
    const parsed = parsePlanDslDetailed('plan "01-main"\nstage "02-current" plan "01-main"');
    expect(parsed.ok).toBe(false);
    const issue = parsed.issues.find((candidate) => candidate.code === "PLAN_MISSING_FIELD");
    expect(issue?.message).toContain("needs goal:");
  });

  test("recovers a missing final end at EOF with a warning", () => {
    const withoutFinalEnd = SPEC_EXAMPLE.replace(/\nend$/, "");
    const parsed = parsePlanDslDetailed(withoutFinalEnd);
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.plan).toEqual(SPEC_PLAN);
    const warning = parsed.issues.find((issue) => issue.code === "PLAN_MISSING_END");
    expect(warning?.severity).toBe("warning");
    expect(warning?.recovered).toBe(true);
  });

  test("rejects an unclosed field fence as truncated", () => {
    const content = `plan "01-main"
goal:
<<<TC_EDIT_BEGIN>>>
unterminated`;
    const parsed = parsePlanDslDetailed(content);
    expect(parsed.ok).toBe(false);
    expect(parsed.truncated).toBe(true);
    expect(parsed.issues.some((issue) => issue.code === "PLAN_UNCLOSED_FENCE")).toBe(true);
  });

  test("rejects legacy hyphen and backtick field fences with PLAN_LEGACY_FENCE", () => {
    for (const fence of ["-----", "``````"]) {
      const parsed = parsePlanDslDetailed(`plan "01-main"
goal:
${fence}
text
${fence}`);
      expect(parsed.ok).toBe(false);
      const issue = parsed.issues.find((candidate) => candidate.code === "PLAN_LEGACY_FENCE");
      expect(issue?.found).toBe(fence);
      expect(issue?.hint).toContain("<<<TC_EDIT_BEGIN>>>");
    }
    const legacyDash = "-----";
    const patch = parsePlanPatchDetailed(`patch
task+ "03-first" stage "02-current" verify test
instruction:
${legacyDash}
text
${legacyDash}`);
    expect(patch.issues.some((issue) => issue.code === "PLAN_LEGACY_FENCE")).toBe(true);
  });

  test("rejects an empty sentinel field body", () => {
    const parsed = parsePlanDslDetailed(`plan "01-main"
goal:
<<<TC_EDIT_BEGIN>>>
<<<TC_EDIT_END>>>`);
    expect(parsed.ok).toBe(false);
    const issue = parsed.issues.find((candidate) => candidate.code === "PLAN_MISSING_FIELD");
    expect(issue?.message).toContain("empty");
  });

  test("rejects a field body containing an exact close sentinel line", () => {
    const parsed = parsePlanDslDetailed(`plan "01-main"
goal:
<<<TC_EDIT_BEGIN>>>
before
<<<TC_EDIT_END>>>
after
<<<TC_EDIT_END>>>`);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.some((issue) => issue.code === "PLAN_EMBEDDED_FENCE_END")).toBe(true);
  });

  test("reports unknown fields with a code and the record identity", () => {
    const parsed = parsePlanDslDetailed(`plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
bogus: x
end`);
    expect(parsed.ok).toBe(false);
    const issue = parsed.issues.find((candidate) => candidate.code === "PLAN_UNKNOWN_FIELD");
    expect(issue?.recordId).toBe("02-current");
    expect(issue?.line).toBe(6);
    expect(issue?.found).toBe("bogus: x");
  });

  test("reports unknown parents with a nearest-id hint", () => {
    const parsed = parsePlanDslDetailed(`plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "02-curren" verify test
instruction: x
end`);
    expect(parsed.ok).toBe(false);
    const issue = parsed.issues.find((candidate) => candidate.code === "PLAN_UNKNOWN_PARENT");
    expect(issue?.recordId).toBe("03-first");
    expect(issue?.hint).toContain('"02-current"');
  });

  test("reports duplicate ids at the second declaration", () => {
    const parsed = parsePlanDslDetailed(`plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

stage "02-current" plan "01-main"
goal: g
end`);
    expect(parsed.ok).toBe(false);
    const issue = parsed.issues.find((candidate) => candidate.code === "PLAN_DUPLICATE_ID");
    expect(issue?.recordId).toBe("02-current");
    expect(issue?.line).toBe(8);
  });

  test("dotted create surfaces PLAN_CREATE_MEMBER with the edit id", () => {
    const content = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "02-current" verify test
instruction: x
end

edit "04-change" task "03-first" create value Parser.answer in src/a.ts
instruction: x
end`;
    const parsed = parsePlanDslDetailed(content);
    expect(parsed.ok).toBe(false);
    const issue = parsed.issues.find((candidate) => candidate.code === "PLAN_CREATE_MEMBER");
    expect(issue?.stage).toBe("task-tree");
    expect(issue?.recordId).toBe("04-change");
    expect(issue?.message).toContain("create adds a top-level declaration");
    expect(issue?.hint).toContain("modify the class");
  });

  test("finish names the exact last task and verify", () => {
    const parsed = parsePlanDslDetailed(`plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "02-current" verify tsc
instruction: x
end

edit "04-change" task "03-first" modify value answer in src/a.ts
instruction: x
end

finish`);
    expect(parsed.ok).toBe(false);
    const issue = parsed.issues.find((candidate) => candidate.code === "PLAN_FINISH_NOT_LAST");
    expect(issue?.message).toBe(
      'finish marks task "03-first", which verifies tsc; the last task must verify "test"',
    );
    expect(issue?.recordId).toBe("03-first");
  });

  test("collects several recoverable issues instead of stopping at the first", () => {
    const parsed = parsePlanDslDetailed(`plan 01-main
goal: g

stage 02-current plan "01-main"
goal: g

task "03-first" stage "02-current" verify test
instruction: x
end

edit "04-change" task "03-first" modify value answer in src/a.ts
instruction: x
end`);
    expect(parsed.ok).toBe(true);
    expect(parsed.issues.filter((issue) => issue.code === "PLAN_BARE_ID")).toHaveLength(2);
    expect(parsed.issues.filter((issue) => issue.code === "PLAN_MISSING_END")).toHaveLength(1);
  });
});

describe("Plan DSL serialize", () => {
  test("serializes the spec example byte-for-byte", () => {
    expect(serializePlanDsl(SPEC_PLAN)).toBe(SPEC_EXAMPLE);
    expect(serializePlanDsl(SPEC_PLAN)).not.toMatch(/^finish$/m);
  });

  test("round-trips multiline text, related locs, and renameTo", () => {
    const shape: EditNode = {
      id: "04-shape",
      loc: { path: "src/a.ts", symbol: "Formatter", kind: "type" },
      related: [{ path: "src/a.ts", symbol: "formatNumber", kind: "value" }],
      action: "modify",
      instruction: "Change the shape.\nKeep the helper in sync.",
    };
    const rename: EditNode = {
      id: "06-rename",
      loc: { path: "src/a.ts", symbol: "printTotal", kind: "value" },
      action: "rename",
      renameTo: "printAmount",
      instruction: "Rename it.",
    };
    const plan: Plan = {
      id: "01-main",
      goal: "Migrate.\nThen rename.",
      stages: [
        { id: "02-stage", goal: "Migrate.", tasks: [task("03-task", "tsc", [shape])] },
        { id: "05-stage", goal: "Rename.", tasks: [task("07-task", "test", [rename])] },
      ],
    };
    const wire = serializePlanDsl(plan);
    expect(wire).toContain("related value formatNumber in src/a.ts");
    expect(wire.indexOf("related value formatNumber")).toBeLessThan(
      wire.indexOf("renameTo: printAmount"),
    );
    expect(accepted(wire)).toEqual(plan);
    expect(serializePlanDsl(accepted(wire))).toBe(wire);
  });

  test("chooses a safe one-line or fenced form", () => {
    const plan = planOf(
      [
        {
          id: "02-current",
          goal: "  padded goal  ",
          tasks: [
            {
              id: "03-first",
              verify: "test",
              instruction: "alpha\n-----\nbeta",
              edits: [edit("04-change")],
            },
          ],
        },
      ],
      "short goal",
    );
    const wire = serializePlanDsl(plan);
    expect(wire).toContain("goal: short goal");
    expect(wire).toContain("goal:\n<<<TC_EDIT_BEGIN>>>\n  padded goal  \n<<<TC_EDIT_END>>>");
    expect(wire).toContain(
      "instruction:\n<<<TC_EDIT_BEGIN>>>\nalpha\n-----\nbeta\n<<<TC_EDIT_END>>>",
    );
    expect(accepted(wire)).toEqual(plan);
  });

  test("throws when Plan text contains the close sentinel line", () => {
    const plan = planOf([], `before\n<<<TC_EDIT_END>>>\nafter`);
    expect(() => serializePlanDsl(plan)).toThrow(/literal line/);
  });

  test("round-trips every action and space", () => {
    const edits: EditNode[] = [
      edit("04-modify", {
        loc: { path: "src/a.ts", symbol: "a", kind: "type" },
        related: [{ path: "src/a.ts", symbol: "b", kind: "value" }],
      }),
      edit("05-create", {
        loc: { path: "src/a.ts", symbol: "c", kind: "namespace" },
        action: "create",
      }),
      edit("06-delete", {
        loc: { path: "src/a.ts", symbol: "d", kind: "value" },
        action: "delete",
      }),
      edit("07-rename", {
        loc: { path: "src/a.ts", symbol: "e", kind: "value" },
        action: "rename",
        renameTo: "f",
      }),
    ];
    const plan = planOf([
      { id: "02-current", goal: "All actions.", tasks: [task("03-task", "test", edits)] },
    ]);
    expect(accepted(serializePlanDsl(plan))).toEqual(plan);
  });
});

describe("Plan DSL structure", () => {
  test("rejects a stage whose plan ref is not the Plan root", () => {
    const content = `plan "01-main"
goal: g

stage "02-current" plan "09-other"
goal: g
end`;
    expect(rejected(content)).toContain("names plan 09-other");
  });

  test("rejects a task or edit whose parent is not declared earlier", () => {
    const taskBeforeStage = `plan "01-main"
goal: g

task "03-first" stage "02-current" verify test
instruction: x
end`;
    expect(rejected(taskBeforeStage)).toContain("not declared earlier");

    const editBeforeTask = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

edit "04-change" task "03-first" modify value answer in src/a.ts
instruction: x
end`;
    expect(rejected(editBeforeTask)).toContain("not declared earlier");
  });

  test("rejects stage, task, and edit records out of order", () => {
    const stageAfterTask = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "02-current" verify test
instruction: x
end

stage "05-next" plan "01-main"
goal: g
end`;
    expect(rejected(stageAfterTask)).toContain("stage records must come before");

    const taskAfterEdit = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "02-current" verify test
instruction: x
end

edit "04-change" task "03-first" modify value answer in src/a.ts
instruction: x
end

task "05-second" stage "02-current" verify test
instruction: x
end`;
    expect(rejected(taskAfterEdit)).toContain("task records must come before");
  });

  test("rejects duplicate ids across every node kind", () => {
    const duplicateStage = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "02-current" verify test
instruction: x
end

edit "04-change" task "03-first" modify value answer in src/a.ts
instruction: x
end`;
    expect(rejected(duplicateStage)).toContain("reuses node id");

    const planStageClash = `plan "01-main"
goal: g

stage "01-main" plan "01-main"
goal: g
end

task "03-first" stage "01-main" verify test
instruction: x
end

edit "04-change" task "03-first" modify value answer in src/a.ts
instruction: x
end`;
    expect(rejected(planStageClash)).toContain("reuses node id");

    const duplicateTask = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "02-current" verify test
instruction: x
end

task "03-first" stage "02-current" verify test
instruction: x
end

edit "04-change" task "03-first" modify value answer in src/a.ts
instruction: x
end`;
    expect(rejected(duplicateTask)).toContain("reuses node id");

    const duplicateEdit = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "02-current" verify test
instruction: x
end

edit "04-change" task "03-first" modify value answer in src/a.ts
instruction: x
end

edit "04-change" task "03-first" modify value answer in src/a.ts
instruction: x
end`;
    expect(rejected(duplicateEdit)).toContain("reuses node id");
  });

  test("accepts a bare NN-slug id with a warning but rejects a malformed id", () => {
    const bare = parsePlanDslDetailed(SPEC_EXAMPLE.replace('plan "01-main"', "plan 01-main"));
    expect(bare.ok).toBe(true);
    expect(bare.issues.some((issue) => issue.code === "PLAN_BARE_ID")).toBe(true);
    expect(rejected('plan "1-main"\ngoal: g')).toContain("must be a string node id");
    expect(rejected('plan "01-Main"\ngoal: g')).toContain("must be a string node id");
    expect(rejected('plan "01_main"\ngoal: g')).toContain("must be a string node id");
    expect(rejected('plan "01.main"\ngoal: g')).toContain("must be a string node id");
  });

  test("accepts large stage/task/edit counts and enforces related and node caps", () => {
    const manyStages = planOf(
      Array.from({ length: 20 }, (_, index) =>
        stage(`${String(index + 2).padStart(2, "0")}-stage`),
      ),
    );
    expect(accepted(serializePlanDsl(manyStages)).stages.length).toBe(20);

    const manyTasks = planOf([
      stage(
        "02-current",
        Array.from({ length: 20 }, (_, index) => task(`${index + 10}-task`)),
      ),
    ]);
    expect(accepted(serializePlanDsl(manyTasks)).stages[0]?.tasks.length).toBe(20);

    const manyEdits = planOf([
      stage("02-current", [
        task(
          "03-task",
          "test",
          Array.from({ length: 10 }, (_, index) => edit(`${index + 10}-edit`)),
        ),
      ]),
    ]);
    expect(accepted(serializePlanDsl(manyEdits)).stages[0]?.tasks[0]?.edits.length).toBe(10);

    const manyRelated = planOf([
      stage("02-current", [
        task("03-task", "test", [
          edit("04-change", {
            related: Array.from({ length: MAX_RELATED_LOCS + 1 }, (_, index) => ({
              path: "src/a.ts",
              symbol: `related${index}`,
              kind: "value" as const,
            })),
          }),
        ]),
      ]),
    ]);
    expect(rejected(serializePlanDsl(manyRelated))).toContain(`at most ${MAX_RELATED_LOCS}`);

    const fullTree = planOf(
      Array.from({ length: 20 }, (_, stageIndex) => ({
        id: `${String(stageIndex + 2).padStart(2, "0")}-stage`,
        goal: `Stage ${stageIndex}.`,
        tasks: Array.from({ length: 5 }, (_, taskIndex) => {
          const label = 100 + stageIndex * 10 + taskIndex;
          return task(`${label}-task`, "test", [edit(`${label}-edit`)]);
        }),
      })),
    );
    expect(rejected(serializePlanDsl(fullTree))).toContain(`at most ${MAX_NODES} are allowed`);
  });

  test("a plan without finish may end in a tsc task; finish still requires test", () => {
    const content = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "02-current" verify tsc
instruction: x
end

edit "04-change" task "03-first" modify value answer in src/a.ts
instruction: x
end`;
    expect(accepted(content).stages[0]?.tasks[0]?.verify).toBe("tsc");
    expect(rejected(`${content}\nfinish`)).toContain('must verify "test"');
  });
});

describe("Plan DSL rejection", () => {
  test("strips a whole-reply markdown fence with a warning", () => {
    const fenced = parsePlanDslDetailed(`\`\`\`\n${SPEC_EXAMPLE}\n\`\`\``);
    expect(fenced.ok).toBe(true);
    expect(fenced.value?.plan).toEqual(SPEC_PLAN);
    expect(fenced.issues.some((issue) => issue.code === "PLAN_WHOLE_REPLY_FENCE")).toBe(true);
  });

  test("rejects JSON, prose, and unknown records", () => {
    expect(rejected('{"id":"01-main","goal":"g","stages":[]}')).toContain(
      "JSON plan objects are not accepted",
    );
    expect(rejected(`Here is the plan:\n\n${SPEC_EXAMPLE}`)).toContain("expected the plan header");
    expect(rejected(`${SPEC_EXAMPLE}\n\ntodo: later`)).toContain("unknown record header");
    expect(rejected(`${SPEC_EXAMPLE}\n\nend`)).toContain('unexpected "end"');
    expect(rejected(`${SPEC_EXAMPLE}\n\n${SPEC_EXAMPLE}`)).toContain("plan header is a singleton");
  });

  test("rejects missing fields, missing end, and empty text", () => {
    expect(rejected('plan "01-main"\nstage "02-current" plan "01-main"')).toContain("needs goal:");

    const missingStageEnd = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g

task "03-first" stage "02-current" verify test
instruction: x
end

edit "04-change" task "03-first" modify value answer in src/a.ts
instruction: x
end`;
    const recovered = parsePlanDslDetailed(missingStageEnd);
    expect(recovered.ok).toBe(true);
    expect(recovered.issues.some((issue) => issue.code === "PLAN_MISSING_END")).toBe(true);

    const midRecord = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
nonsense
end`;
    expect(rejected(midRecord)).toContain('must be closed with "end"');

    const emptyGoal = `plan "01-main"
goal:

stage "02-current" plan "01-main"
goal: g
end`;
    expect(rejected(emptyGoal)).toContain("is empty");

    const missingInstruction = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "02-current" verify test
end`;
    expect(rejected(missingInstruction)).toContain("needs instruction:");
  });

  test("rejects invalid verify, action, and space tokens", () => {
    const invalidVerify = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "02-current" verify lint
instruction: x
end`;
    expect(rejected(invalidVerify)).toContain('verify must be "tsc" or "test"');

    const invalidAction = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "02-current" verify test
instruction: x
end

edit "04-change" task "03-first" patch value answer in src/a.ts
instruction: x
end`;
    expect(rejected(invalidAction)).toContain("action must be one of");

    const invalidSpace = `plan "01-main"
goal: g

stage "02-current" plan "01-main"
goal: g
end

task "03-first" stage "02-current" verify test
instruction: x
end

edit "04-change" task "03-first" modify function answer in src/a.ts
instruction: x
end`;
    expect(rejected(invalidSpace)).toContain("space must be one of");
  });

  test("rejects invalid edit semantics through the tree validator", () => {
    const dottedCreate = SPEC_EXAMPLE.replace("modify value answer", "create value Parser.answer");
    expect(rejected(dottedCreate)).toContain("PLAN_CREATE_MEMBER");

    const relatedOnCreate = SPEC_EXAMPLE.replace(
      "instruction: Change answer to return 2.",
      "related value other in src/helper.ts\ninstruction: Change answer to return 2.",
    ).replace("modify value answer", "create value answer");
    expect(rejected(relatedOnCreate)).toContain("only a modify edit");

    const strayRename = SPEC_EXAMPLE.replace(
      "instruction: Change answer to return 2.",
      "renameTo: other\ninstruction: Change answer to return 2.",
    );
    expect(rejected(strayRename)).toContain('action is "modify"');

    const missingRenameTo = SPEC_EXAMPLE.replace(
      "modify value answer in src/helper.ts",
      "rename value answer in src/helper.ts",
    );
    expect(rejected(missingRenameTo)).toContain("carries no renameTo");

    const unsafePath = SPEC_EXAMPLE.replace("src/helper.ts", "../helper.ts");
    expect(rejected(unsafePath)).toContain("writable repo-relative path");

    const dottedRelated = SPEC_EXAMPLE.replace(
      "instruction: Change answer to return 2.",
      "related value extra in src/other.ts\ninstruction: Change answer to return 2.",
    );
    expect(rejected(dottedRelated)).toContain("not in the edit's file");
  });
});

const PATCH_EXAMPLE = `patch
plan~ "01-main"
goal: Updated goal.
end
stage+ "07-next" plan "01-main"
goal: Finish the remaining behavior.
end
stage~ "02-current"
goal: Optional new goal.
end
stage- "05-repair"
end
task+ "08-final" stage "07-next" verify test
instruction: Keep the suite green.
end
task~ "03-answer"
verify test
instruction: Optional replacement.
end
task- "06-object"
end
edit+ "09-final" task "08-final" modify value parseJson in src/helper.ts
instruction: Wire the entry point.
end
edit~ "04-change"
instruction: Change only the return expression.
end
edit- "07-object"
end
finish`;

const NEXT_TASK_PATCH = `patch
task+ "05-next" stage "02-current" verify tsc
instruction: Add the next helper and wire it in.
end
edit+ "06-helper" task "05-next" create value parseLiteral in src/helper.ts
instruction: Add a small top-level helper; no class.
end`;

const NEXT_STAGE_PATCH = `patch
stage+ "07-next" plan "01-main"
goal: Finish the remaining behavior.
end
task+ "08-final" stage "07-next" verify test
instruction: Run the full behavior and keep the suite green.
end
edit+ "09-final" task "08-final" modify value parseJson in src/helper.ts
instruction: Wire the final entry point; no new class.
end
finish`;

const REPAIR_PATCH = `patch
task~ "03-answer"
instruction: Keep the final test task; repair only the return expression.
end
edit~ "04-change"
instruction: Replace only the return statement with \`return 2;\`.
end`;

const REMOVE_PATCH = `patch
edit- "07-object"
end
task- "06-object"
end
stage- "05-repair"
end`;

function acceptedPatch(content: string) {
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

describe("Plan patch DSL parse", () => {
  test("parses every §4 operator and marks finish", () => {
    const patch = acceptedPatch(PATCH_EXAMPLE);
    expect(patch.finish).toBe(true);
    expect(patch.ops.map((op) => op.kind)).toEqual([
      "plan-update",
      "stage-add",
      "stage-update",
      "stage-remove",
      "task-add",
      "task-update",
      "task-remove",
      "edit-add",
      "edit-update",
      "edit-remove",
    ]);
    expect(patch.ops[0]).toEqual({
      kind: "plan-update",
      id: "01-main",
      goal: "Updated goal.",
    });
    expect(patch.ops[1]).toEqual({
      kind: "stage-add",
      id: "07-next",
      plan: "01-main",
      goal: "Finish the remaining behavior.",
    });
    expect(patch.ops[4]).toEqual({
      kind: "task-add",
      id: "08-final",
      stage: "07-next",
      verify: "test",
      instruction: "Keep the suite green.",
    });
    expect(patch.ops[7]).toEqual({
      kind: "edit-add",
      id: "09-final",
      task: "08-final",
      loc: { path: "src/helper.ts", symbol: "parseJson", kind: "value" },
      action: "modify",
      instruction: "Wire the entry point.",
    });
    expect(patch.ops[8]).toEqual({
      kind: "edit-update",
      id: "04-change",
      instruction: "Change only the return expression.",
    });
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

  test("parses empty update records and edit+ related/renameTo fields", () => {
    const empty = acceptedPatch(`patch
stage~ "02-current"
end
task~ "03-answer"
end
edit~ "04-change"
end`);
    expect(empty.ops).toEqual([
      { kind: "stage-update", id: "02-current" },
      { kind: "task-update", id: "03-answer" },
      { kind: "edit-update", id: "04-change" },
    ]);
    expect(serializePlanPatch(empty)).toBe(`patch
stage~ "02-current"
end
task~ "03-answer"
end
edit~ "04-change"
end`);

    const content = `patch
edit+ "04-change" task "03-answer" modify value answer in src/a.ts
related value helper in src/a.ts
instruction: Change it.
end
edit+ "05-rename" task "03-answer" rename value oldName in src/a.ts
renameTo: newName
instruction: Rename it.
end`;
    const patch = acceptedPatch(content);
    expect(patch.ops[0]).toEqual({
      kind: "edit-add",
      id: "04-change",
      task: "03-answer",
      loc: { path: "src/a.ts", symbol: "answer", kind: "value" },
      action: "modify",
      related: [{ path: "src/a.ts", symbol: "helper", kind: "value" }],
      instruction: "Change it.",
    });
    expect(patch.ops[1]).toMatchObject({
      kind: "edit-add",
      id: "05-rename",
      action: "rename",
      renameTo: "newName",
    });
    expect(serializePlanPatch(patch)).toBe(content);
  });

  test("parses empty patches and a bare finish", () => {
    expect(acceptedPatch("patch")).toEqual({ ops: [], finish: false });
    expect(acceptedPatch("patch\nfinish")).toEqual({ ops: [], finish: true });
  });

  test("parses fenced text and an edit~ full loc/related/rename header", () => {
    const content = `patch
plan~ "01-main"
goal:
<<<TC_EDIT_BEGIN>>>
line one

  line two
<<<TC_EDIT_END>>>
end
stage~ "02-current"
goal:
<<<TC_EDIT_BEGIN>>>
  padded goal
<<<TC_EDIT_END>>>
end
task~ "03-answer"
verify test
instruction:
<<<TC_EDIT_BEGIN>>>
alpha
  beta
<<<TC_EDIT_END>>>
end
edit+ "04-change" task "03-answer" modify value answer in src/a.ts
instruction:
<<<TC_EDIT_BEGIN>>>
raw \`\`\` inner
<<<TC_EDIT_END>>>
end
edit~ "05-change"
modify value other in src/b.ts
related value helper in src/b.ts
instruction: Change it.
end
edit~ "06-rename"
rename value oldName in src/c.ts
renameTo: newName
instruction: Rename it.
end
finish`;
    const patch = acceptedPatch(content);
    expect(patch.ops[0]).toMatchObject({ goal: "line one\n\n  line two" });
    expect(patch.ops[1]).toMatchObject({ goal: "  padded goal" });
    expect(patch.ops[2]).toMatchObject({ instruction: "alpha\n  beta" });
    expect(patch.ops[3]).toMatchObject({ instruction: "raw ``` inner" });
    expect(patch.ops[4]).toEqual({
      kind: "edit-update",
      id: "05-change",
      loc: { path: "src/b.ts", symbol: "other", kind: "value" },
      action: "modify",
      related: [{ path: "src/b.ts", symbol: "helper", kind: "value" }],
      instruction: "Change it.",
    });
    expect(patch.ops[5]).toEqual({
      kind: "edit-update",
      id: "06-rename",
      loc: { path: "src/c.ts", symbol: "oldName", kind: "value" },
      action: "rename",
      renameTo: "newName",
      instruction: "Rename it.",
    });
    expect(acceptedPatch(serializePlanPatch(patch))).toEqual(patch);
  });
});

describe("Plan patch DSL serialize", () => {
  test("round-trips the §4 combined example byte-for-byte", () => {
    const patch = acceptedPatch(PATCH_EXAMPLE);
    expect(serializePlanPatch(patch)).toBe(PATCH_EXAMPLE);
    expect(acceptedPatch(serializePlanPatch(patch))).toEqual(patch);
  });

  test("round-trips the §3.2, §3.3, §4.1, and §4.2 examples", () => {
    expect(serializePlanPatch(acceptedPatch(NEXT_TASK_PATCH))).toBe(NEXT_TASK_PATCH);
    expect(serializePlanPatch(acceptedPatch(NEXT_STAGE_PATCH))).toBe(NEXT_STAGE_PATCH);
    expect(serializePlanPatch(acceptedPatch(REPAIR_PATCH))).toBe(REPAIR_PATCH);
    expect(serializePlanPatch(acceptedPatch(REMOVE_PATCH))).toBe(REMOVE_PATCH);
    expect(acceptedPatch(NEXT_STAGE_PATCH).finish).toBe(true);
    expect(acceptedPatch(NEXT_TASK_PATCH).finish).toBe(false);
  });

  test("rejects an edit~ with only one of action and loc", () => {
    expect(() =>
      serializePlanPatch({
        ops: [{ kind: "edit-update", id: "04-change", action: "delete" }],
        finish: false,
      }),
    ).toThrow("only one of action/loc");
  });
});

describe("Plan patch DSL rejection", () => {
  test("rejects a missing patch header, JSON, fences, and unknown records", () => {
    expect(rejectedPatch("")).toContain("the reply is empty");
    expect(rejectedPatch('plan "01-main"\ngoal: g')).toContain("expected the patch header");
    expect(rejectedPatch(`Here is the patch:\n\n${PATCH_EXAMPLE}`)).toContain(
      "expected the patch header",
    );
    const fenced = parsePlanPatchDetailed(`\`\`\`\n${PATCH_EXAMPLE}\n\`\`\``);
    expect(fenced.ok).toBe(true);
    expect(fenced.issues.some((issue) => issue.code === "PLAN_WHOLE_REPLY_FENCE")).toBe(true);
    expect(rejectedPatch('{"ops":[],"finish":false}')).toContain("JSON patch objects");
    expect(rejectedPatch('patch\n{"ops":[]}')).toContain("JSON patch objects");
    expect(rejectedPatch("patch\nnope\nend")).toContain("unknown patch record");
    expect(rejectedPatch(`patch\n${PATCH_EXAMPLE}`)).toContain("patch header is a singleton");
    expect(rejectedPatch("patch\nend")).toContain('unexpected "end"');
  });

  test("recovers a missing end at a patch boundary but rejects a mid-record one", () => {
    const atEof = parsePlanPatchDetailed('patch\ntask~ "03-answer"\ninstruction: x');
    expect(atEof.ok).toBe(true);
    expect(atEof.issues.some((issue) => issue.code === "PLAN_MISSING_END")).toBe(true);
    const beforeSibling = parsePlanPatchDetailed(
      'patch\ntask~ "03-answer"\ninstruction: x\nedit- "04-change"\nend',
    );
    expect(beforeSibling.ok).toBe(true);
    expect(beforeSibling.issues.some((issue) => issue.code === "PLAN_MISSING_END")).toBe(true);
    expect(rejectedPatch('patch\ntask~ "03-answer"\ninstruction: x\nnonsense\nend')).toContain(
      'must be closed with "end"',
    );
  });

  test("accepts bare ids with a warning", () => {
    const bare = parsePlanPatchDetailed("patch\nstage~ 02-current\nend");
    expect(bare.ok).toBe(true);
    expect(bare.issues.some((issue) => issue.code === "PLAN_BARE_ID")).toBe(true);
    expect(rejectedPatch('patch\nstage~ "2-current"\nend')).toContain("must be a string node id");
  });

  test("parses all patch ops but rejects the whole patch when one is malformed", () => {
    const parsed = parsePlanPatchDetailed(`patch
task~ "03-answer"
instruction: x
end
edit- "04-change"
bogus: y
end`);
    expect(parsed.ok).toBe(false);
    expect(parsed.value?.ops).toHaveLength(1);
    expect(parsed.issues.some((issue) => issue.code === "PLAN_UNKNOWN_FIELD")).toBe(true);
  });

  test("rejects trailing records after finish", () => {
    expect(rejectedPatch('patch\nfinish\ntask~ "03-answer"\nend')).toContain(
      "finish must be the last line",
    );
    expect(rejectedPatch("patch\nfinish\nfinish")).toContain("finish must be the last line");
    expect(
      rejectedPatch(
        'patch\ntask~ "03-answer"\ninstruction: x\nend\nfinish\ntask- "03-answer"\nend',
      ),
    ).toContain("finish must be the last line");
  });

  test("rejects unknown actions, spaces, and verifies", () => {
    expect(
      rejectedPatch(
        'patch\nedit+ "04-change" task "03-answer" patch value answer in src/a.ts\ninstruction: x\nend',
      ),
    ).toContain("action must be one of");
    expect(
      rejectedPatch(
        'patch\nedit+ "04-change" task "03-answer" modify function answer in src/a.ts\ninstruction: x\nend',
      ),
    ).toContain("space must be one of");
    expect(
      rejectedPatch('patch\ntask+ "03-first" stage "02-current" verify lint\ninstruction: x\nend'),
    ).toContain('verify must be "tsc" or "test"');
    expect(
      rejectedPatch('patch\nedit~ "04-change"\npatch value answer in src/a.ts\nend'),
    ).toContain("action must be one of");
    expect(rejectedPatch('patch\ntask~ "03-first"\nverify lint\nend')).toContain(
      'verify must be "tsc" or "test"',
    );
  });

  test("rejects missing required fields and malformed headers", () => {
    expect(rejectedPatch('patch\nplan~ "01-main"\nend')).toContain("needs goal:");
    expect(rejectedPatch('patch\ntask+ "03-first" stage "02-current" verify test\nend')).toContain(
      "needs instruction:",
    );
    expect(
      rejectedPatch(
        'patch\nedit+ "04-change" task "03-answer" modify value answer in src/a.ts\nend',
      ),
    ).toContain("needs instruction:");
    expect(
      rejectedPatch('patch\nedit+ "04-change" task "03-answer"\ninstruction: x\nend'),
    ).toContain("edit+ record");
    expect(rejectedPatch('patch\nplan~ "01-main" extra\ngoal: g\nend')).toContain(
      'must be "plan~ \\"NN-slug\\""',
    );
    expect(rejectedPatch('patch\nstage- "05-repair" extra\nend')).toContain(
      'must be "stage- \\"NN-slug\\""',
    );
    expect(rejectedPatch('patch\nedit~ "04-change"\nmodify value answer src/a.ts\nend')).toContain(
      'must be "<action> <space> <symbol> in <path>"',
    );
  });

  test("rejects duplicate and extra fields", () => {
    expect(rejectedPatch('patch\ntask~ "03-first"\nverify test\nverify test\nend')).toContain(
      "carries verify more than once",
    );
    expect(rejectedPatch('patch\ntask~ "03-first"\ninstruction: a\ninstruction: b\nend')).toContain(
      "carries instruction more than once",
    );
    expect(rejectedPatch('patch\nedit~ "04-change"\nrenameTo: a\nrenameTo: b\nend')).toContain(
      "carries renameTo more than once",
    );
    expect(rejectedPatch('patch\nplan~ "01-main"\ngoal: a\ngoal: b\nend')).toContain(
      'must be closed with "end"',
    );
    expect(rejectedPatch('patch\nstage~ "02-current"\ngoal: a\ngoal: b\nend')).toContain(
      'must be closed with "end"',
    );
    expect(
      rejectedPatch('patch\ntask~ "03-first"\ninstruction: a\nrelated value x in src/a.ts\nend'),
    ).toContain('must be closed with "end"');
  });
});
