import { describe, expect, test } from "bun:test";
import {
  activeStage,
  activeTask,
  allStagesClosed,
  allTasks,
  finalTask,
  finalTaskPassed,
  firstEdit,
  hasLaterPendingTaskInStage,
  initialState,
  isSafeTaskPath,
  MAX_NODES,
  MAX_PLAN_GOAL_LENGTH,
  mergeReplan,
  nextEdit,
  renderTaskStatus,
  renderTaskTree,
  runComplete,
  summaryOf,
  taskEditsSettled,
  taskHasDoneEdit,
  validatePlanTree,
} from "./tasks";
import { applyPlanPatch, parsePlan, parsePlanPatch, readPlan, serializePlanDsl } from "./plan-dsl";
import type { PlanPatchOp } from "./plan-dsl";
import type { EditNode, NodeId, Plan, Stage, TaskNode, TaskRunState, TaskVerify } from "./tasks";

// Test fixtures keep numeric labels for readability and convert them to valid
// globally unique node ids; production accepts strings only.
function nodeId(kind: "stage" | "task" | "edit", label: number): NodeId {
  return `${String(label).padStart(2, "0")}-${kind}`;
}

function stageId(label: number): NodeId {
  return nodeId("stage", label);
}

function taskId(label: number): NodeId {
  return nodeId("task", label);
}

function editId(label: number): NodeId {
  return nodeId("edit", label);
}

function edit(overrides: Partial<Omit<EditNode, "id">> & { id: number }): EditNode {
  const { id: label, ...rest } = overrides;
  return {
    id: editId(label),
    loc: { path: "src/a.ts", symbol: `symbol${label}`, kind: "value" },
    action: "modify",
    instruction: `Do edit ${label}.`,
    ...rest,
  };
}

function task(overrides: Partial<Omit<TaskNode, "id">> & { id: number }): TaskNode {
  const { id: label, ...rest } = overrides;
  return {
    id: taskId(label),
    verify: "test",
    instruction: `Do task ${label}.`,
    edits: [edit({ id: label + 1_000 })],
    ...rest,
  };
}

function stage(label: number, tasks: TaskNode[], goal = `Stage ${label}.`): Stage {
  return { id: stageId(label), goal, tasks };
}

function planDsl(stages: Stage[], overrides: { id?: string; goal?: string } = {}): string {
  return serializePlanDsl({
    id: overrides.id ?? "01-main",
    goal: overrides.goal ?? "Make the change.",
    stages,
  });
}

function okPlan(content: string) {
  const parsed = parsePlan(content);
  if (!parsed.ok) {
    throw new Error(`expected an accepted plan, got ${parsed.diagnostics}`);
  }
  return parsed.plan;
}

function rejectPlan(content: string) {
  const parsed = parsePlan(content);
  if (parsed.ok) {
    throw new Error("expected the plan to be rejected");
  }
  return parsed;
}

function stateOf(stages: Stage[]): TaskRunState {
  return initialState(okPlan(planDsl(stages)));
}

function snapshot(state: TaskRunState): string {
  return JSON.stringify({
    plan: state.plan,
    editStatus: [...state.editStatus.entries()].sort(),
    taskStatus: [...state.taskStatus.entries()].sort(),
    finalTaskId: state.finalTaskId,
  });
}

function replan(content: string) {
  const parsed = readPlan(content);
  if (!parsed.ok) {
    throw new Error(`expected an accepted re-plan, got ${parsed.diagnostics}`);
  }
  return parsed.plan;
}

describe("parsePlan", () => {
  test("accepts the minimal Plan -> Stage -> Task -> edit shape", () => {
    const plan = okPlan(
      planDsl([
        stage(1, [
          task({
            id: 2,
            verify: "test",
            edits: [
              edit({
                id: 3,
                loc: { path: "src/helper.ts", symbol: "answer", kind: "value" },
                instruction: "Change answer to return 2.",
              }),
            ],
          }),
        ]),
      ]),
    );
    expect(plan.id).toBe("01-main");
    expect(plan.goal).toBe("Make the change.");
    expect(plan.stages.length).toBe(1);
    expect(plan.stages[0]?.id).toBe(stageId(1));
    expect(plan.stages[0]?.tasks[0]?.id).toBe(taskId(2));
    expect(plan.stages[0]?.tasks[0]?.edits[0]?.id).toBe(editId(3));
  });

  test("accepts a whole-reply markdown fence with a warning; rejects prose and JSON", () => {
    const body = planDsl([stage(1, [task({ id: 2 })])]);
    const fenced = readPlan(`\`\`\`\n${body}\n\`\`\``);
    expect(fenced.ok).toBe(true);
    if (fenced.ok) {
      expect(fenced.plan.stages[0]?.tasks[0]?.id).toBe(taskId(2));
    }
    expect(rejectPlan(`Here is the plan:\n\n${body}`).diagnostics).toContain(
      "expected the plan header",
    );
    expect(
      rejectPlan(JSON.stringify({ id: "01-main", goal: "g", stages: [] })).diagnostics,
    ).toContain("JSON plan objects are not accepted");
  });

  test("rejects an empty Plan, empty stages, empty tasks, and empty edits", () => {
    expect(rejectPlan(planDsl([])).diagnostics).toContain("at least one stage");
    expect(rejectPlan(planDsl([{ id: stageId(1), goal: "g", tasks: [] }])).diagnostics).toContain(
      "at least one task",
    );
    const emptyEdits = { ...task({ id: 2 }), edits: [] };
    expect(rejectPlan(planDsl([stage(1, [emptyEdits])])).diagnostics).toContain(
      "at least one edit",
    );
  });

  test("rejects duplicate ids across the Plan, stages, tasks, and edits", () => {
    expect(
      rejectPlan(planDsl([stage(1, [task({ id: 2 })]), stage(1, [task({ id: 3 })])])).diagnostics,
    ).toContain("reuses node id");
    // The Plan root shares the namespace with a stage.
    expect(
      rejectPlan(planDsl([{ ...stage(1, [task({ id: 2 })]), id: "01-main" }])).diagnostics,
    ).toContain("reuses node id");
    // A task may not reuse an edit id.
    const sharedEdit = edit({ id: 3 });
    expect(
      rejectPlan(
        planDsl([
          stage(1, [
            task({ id: 2, edits: [sharedEdit] }),
            { ...task({ id: 4 }), id: sharedEdit.id },
          ]),
        ]),
      ).diagnostics,
    ).toContain("reuses node id");
    // A duplicate edit id inside or across tasks is rejected.
    expect(
      rejectPlan(
        planDsl([
          stage(1, [
            task({ id: 2, edits: [edit({ id: 3 })] }),
            task({ id: 4, edits: [edit({ id: 3 })] }),
          ]),
        ]),
      ).diagnostics,
    ).toContain("reuses node id");
  });

  test("requires a valid Plan root id and goal", () => {
    const stages = [stage(1, [task({ id: 2 })])];
    expect(rejectPlan(planDsl(stages, { id: "main" })).diagnostics).toContain(
      "plan.id must be a string node id",
    );
    expect(rejectPlan(planDsl(stages, { id: "1-stage" })).diagnostics).toContain(
      "plan.id must be a string node id",
    );
    expect(
      rejectPlan(planDsl(stages, { goal: "x".repeat(MAX_PLAN_GOAL_LENGTH + 1) })).diagnostics,
    ).toContain(`at most ${MAX_PLAN_GOAL_LENGTH}`);
  });

  test("rejects malformed stage, task, and edit ids", () => {
    const badStage = { ...stage(1, [task({ id: 2 })]), id: "1-stage" };
    expect(rejectPlan(planDsl([badStage])).diagnostics).toContain("must be a string node id");
    const badTask = { ...task({ id: 2 }), id: "task-two" };
    expect(rejectPlan(planDsl([stage(1, [badTask])])).diagnostics).toContain(
      "must be a string node id",
    );
    const badEdit = { ...edit({ id: 3 }), id: "03_edit" };
    expect(
      rejectPlan(planDsl([stage(1, [task({ id: 2, edits: [badEdit] })])])).diagnostics,
    ).toContain("must be a string node id");
  });

  test("requires a task verify and only a finished last task must be test", () => {
    const noVerify = { ...task({ id: 2 }), verify: undefined } as unknown as TaskNode;
    expect(rejectPlan(planDsl([stage(1, [noVerify])])).diagnostics).toContain("verify must be");
    const badVerify = { ...task({ id: 2 }), verify: "lint" } as unknown as TaskNode;
    expect(rejectPlan(planDsl([stage(1, [badVerify])])).diagnostics).toContain("verify must be");
    const tscOnly = planDsl([stage(1, [task({ id: 2, verify: "tsc" })])]);
    expect(okPlan(tscOnly).stages[0]?.tasks[0]?.verify).toBe("tsc");
    expect(rejectPlan(`${tscOnly}\nfinish`).diagnostics).toContain('must verify "test"');
  });

  test("accepts large stage/task/edit counts and caps total nodes", () => {
    const manyStages = Array.from({ length: 20 }, (_, index) =>
      stage(index + 1, [task({ id: index + 100 })]),
    );
    expect(okPlan(planDsl(manyStages)).stages.length).toBe(20);
    const manyTasks = Array.from({ length: 20 }, (_, index) => task({ id: index + 100 }));
    expect(okPlan(planDsl([stage(1, manyTasks)])).stages[0]?.tasks.length).toBe(20);
    const manyEdits = Array.from({ length: 10 }, (_, index) => edit({ id: index + 100 }));
    expect(
      okPlan(planDsl([stage(1, [task({ id: 2, edits: manyEdits })])])).stages[0]?.tasks[0]?.edits
        .length,
    ).toBe(10);
    const fullTree = Array.from({ length: 20 }, (_, stageIndex) =>
      stage(
        stageIndex + 1,
        Array.from({ length: 5 }, (_, taskIndex) =>
          task({ id: 100 + stageIndex * 10 + taskIndex }),
        ),
      ),
    );
    expect(rejectPlan(planDsl(fullTree)).diagnostics).toContain(`at most ${MAX_NODES} are allowed`);
  });

  test("loc.kind is a symbol space, not a declaration keyword", () => {
    const bad = {
      ...task({ id: 2 }),
      edits: [
        {
          id: editId(3),
          loc: { path: "src/a.ts", symbol: "answer", kind: "function" },
          action: "modify",
          instruction: "Change it.",
        },
      ],
    } as unknown as TaskNode;
    expect(rejectPlan(planDsl([stage(1, [bad])])).diagnostics).toContain(
      "must be one of value, type, namespace",
    );
  });

  test("write edits use a whole-file loc", () => {
    const write = okPlan(
      planDsl([
        stage(1, [
          task({
            id: 2,
            edits: [
              edit({
                id: 3,
                loc: { path: "src/json.ts", symbol: "", kind: "file" },
                action: "write",
                instruction: "Write the module.",
              }),
            ],
          }),
        ]),
      ]),
    );
    expect(write.stages[0]?.tasks[0]?.edits[0]?.loc).toEqual({
      path: "src/json.ts",
      symbol: "",
      kind: "file",
    });

    const symbolSpace: Plan = {
      id: "01-main",
      goal: "Test.",
      stages: [
        stage(1, [
          task({
            id: 2,
            edits: [
              edit({
                id: 3,
                loc: { path: "src/json.ts", symbol: "parse", kind: "value" },
                action: "write",
              }),
            ],
          }),
        ]),
      ],
    };
    expect(validatePlanTree(symbolSpace)).toContain('kind "file"');

    const symbol: Plan = {
      id: "01-main",
      goal: "Test.",
      stages: [
        stage(1, [
          task({
            id: 2,
            edits: [
              edit({
                id: 3,
                loc: { path: "src/json.ts", symbol: "parse", kind: "file" },
                action: "write",
              }),
            ],
          }),
        ]),
      ],
    };
    expect(validatePlanTree(symbol)).toContain("carries a symbol");
  });

  test("accepts related migration targets and rejects cross-file related locs", () => {
    const migration = okPlan(
      planDsl([
        stage(1, [
          task({
            id: 2,
            edits: [
              edit({
                id: 3,
                loc: { path: "src/a.ts", symbol: "Answer", kind: "type" },
                related: [{ path: "src/a.ts", symbol: "answer", kind: "value" }],
              }),
            ],
          }),
        ]),
      ]),
    );
    expect(migration.stages[0]?.tasks[0]?.edits[0]?.related?.length).toBe(1);
    const crossFile = rejectPlan(
      planDsl([
        stage(1, [
          task({
            id: 2,
            edits: [
              edit({
                id: 3,
                loc: { path: "src/a.ts", symbol: "Answer", kind: "type" },
                related: [{ path: "src/b.ts", symbol: "answer", kind: "value" }],
              }),
            ],
          }),
        ]),
      ]),
    );
    expect(crossFile.diagnostics).toContain("not in the edit's file");
  });

  test("rename needs renameTo and nothing else may carry it", () => {
    const missing = task({
      id: 2,
      edits: [edit({ id: 3, action: "rename" })],
    });
    expect(rejectPlan(planDsl([stage(1, [missing])])).diagnostics).toContain("renameTo");
    const same = task({
      id: 2,
      edits: [edit({ id: 3, action: "rename", renameTo: "symbol3" })],
    });
    expect(rejectPlan(planDsl([stage(1, [same])])).diagnostics).toContain("to itself");
    const stray = task({
      id: 2,
      edits: [edit({ id: 3, renameTo: "other" })],
    });
    expect(rejectPlan(planDsl([stage(1, [stray])])).diagnostics).toContain('action is "modify"');
  });

  test("allows modify, delete, and rename of an already-resolved dotted class member", () => {
    const memberLoc = {
      path: "src/parser.ts",
      symbol: "Parser.parseValue",
      kind: "value" as const,
    };
    const modify = okPlan(
      planDsl([
        stage(1, [task({ id: 2, edits: [edit({ id: 3, action: "modify", loc: memberLoc })] })]),
      ]),
    );
    expect(modify.stages[0]?.tasks[0]?.edits[0]?.loc.symbol).toBe("Parser.parseValue");

    const remove = okPlan(
      planDsl([
        stage(1, [task({ id: 2, edits: [edit({ id: 3, action: "delete", loc: memberLoc })] })]),
      ]),
    );
    expect(remove.stages[0]?.tasks[0]?.edits[0]?.action).toBe("delete");

    const rename = okPlan(
      planDsl([
        stage(1, [
          task({
            id: 2,
            edits: [
              edit({
                id: 3,
                action: "rename",
                loc: memberLoc,
                renameTo: "Parser.parseOther",
              }),
            ],
          }),
        ]),
      ]),
    );
    expect(rename.stages[0]?.tasks[0]?.edits[0]?.renameTo).toBe("Parser.parseOther");
  });

  test("rejects a dotted create before execution with PLAN_CREATE_MEMBER", () => {
    const dottedCreate = task({
      id: 2,
      edits: [
        edit({
          id: 3,
          action: "create",
          loc: { path: "src/parser.ts", symbol: "Parser.parseValue", kind: "value" },
        }),
      ],
    });
    const rejected = rejectPlan(planDsl([stage(1, [dottedCreate])]));
    expect(rejected.stage).toBe("task-tree");
    expect(rejected.diagnostics).toContain("PLAN_CREATE_MEMBER");
    expect(rejected.diagnostics).toContain(
      'create adds a top-level declaration; "Parser.parseValue" is a class member.',
    );
    expect(rejected.diagnostics).toContain(
      "Modify the class with all needed stubs, then modify the member, or use a top-level function.",
    );
    const topLevelCreate = okPlan(
      planDsl([
        stage(1, [
          task({
            id: 2,
            edits: [
              edit({
                id: 3,
                action: "create",
                loc: { path: "src/parser.ts", symbol: "parseValue", kind: "value" },
              }),
            ],
          }),
        ]),
      ]),
    );
    expect(topLevelCreate.stages[0]?.tasks[0]?.edits[0]?.action).toBe("create");
  });

  test("rejects unsafe target paths", () => {
    for (const path of [
      "/etc/passwd.ts",
      "../a.ts",
      "human/spec.ts",
      "node_modules/x.ts",
      "a//b.ts",
    ]) {
      const bad = task({
        id: 2,
        edits: [edit({ id: 3, loc: { path, symbol: "x", kind: "value" } })],
      });
      expect(rejectPlan(planDsl([stage(1, [bad])])).diagnostics).toContain(
        "writable repo-relative path",
      );
    }
  });

  test("rejects an instruction that is too long", () => {
    const long = task({
      id: 2,
      edits: [edit({ id: 3, instruction: "x".repeat(4_001) })],
    });
    expect(rejectPlan(planDsl([stage(1, [long])])).diagnostics).toContain("at most 4000");
  });
});

describe("isSafeTaskPath", () => {
  test("accepts ordinary repo paths and rejects escapes", () => {
    expect(isSafeTaskPath("src/tasks.ts")).toBe(true);
    expect(isSafeTaskPath("./src/tasks.ts")).toBe(false);
    expect(isSafeTaskPath("src/.hidden.ts")).toBe(false);
    expect(isSafeTaskPath("dist/a.ts")).toBe(false);
  });
});

describe("scheduling", () => {
  function tree(): TaskRunState {
    return stateOf([
      stage(1, [
        task({
          id: 2,
          edits: [edit({ id: 3 }), edit({ id: 4 })],
        }),
        task({ id: 5, edits: [edit({ id: 6 })] }),
      ]),
      stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
    ]);
  }

  test("runs stages, tasks, and edits in tree order", () => {
    const state = tree();
    const firstStage = state.stages[0];
    expect(firstStage).toBeDefined();
    if (firstStage === undefined) {
      return;
    }
    expect(activeStage(state)?.id).toBe(stageId(1));
    expect(activeTask(state)?.id).toBe(taskId(2));
    const first = activeTask(state);
    expect(first === undefined ? undefined : nextEdit(state, first)?.id).toBe(editId(3));
    state.editStatus.set(editId(3), "done");
    const firstAgain = activeTask(state);
    expect(firstAgain === undefined ? undefined : nextEdit(state, firstAgain)?.id).toBe(editId(4));
    state.editStatus.set(editId(4), "done");
    expect(firstAgain === undefined ? false : taskEditsSettled(state, firstAgain)).toBe(true);
    expect(firstAgain === undefined ? false : taskHasDoneEdit(state, firstAgain)).toBe(true);
    state.taskStatus.set(taskId(2), "passed");
    expect(activeTask(state)?.id).toBe(taskId(5));
    state.editStatus.set(editId(6), "done");
    state.taskStatus.set(taskId(5), "passed");
    expect(activeStage(state)?.id).toBe(stageId(2));
    expect(activeTask(state)?.id).toBe(taskId(7));
    expect(runComplete(state)).toBe(false);
    state.editStatus.set(editId(8), "done");
    state.taskStatus.set(taskId(7), "passed");
    expect(runComplete(state)).toBe(false);
    state.finalTaskId = taskId(7);
    expect(runComplete(state)).toBe(true);
  });

  test("a failed task with a later pending task keeps the stage active", () => {
    const state = tree();
    const firstStage = state.stages[0];
    const firstTask = firstStage?.tasks[0];
    if (firstStage === undefined || firstTask === undefined) {
      return;
    }
    state.taskStatus.set(firstTask.id, "failed");
    expect(hasLaterPendingTaskInStage(state, firstTask)).toBe(true);
    expect(activeTask(state)?.id).toBe(taskId(5));
  });

  test("allStagesClosed allows earlier failed tasks but not pending work", () => {
    const state = tree();
    for (const stageNode of state.stages) {
      for (const taskNode of stageNode.tasks) {
        state.taskStatus.set(taskNode.id, taskNode.id === taskId(2) ? "failed" : "passed");
        for (const editNode of taskNode.edits) {
          state.editStatus.set(editNode.id, editNode.id === editId(3) ? "failed" : "done");
        }
      }
    }
    expect(allStagesClosed(state)).toBe(true);
    state.finalTaskId = taskId(7);
    expect(finalTaskPassed(state)).toBe(true);
    expect(runComplete(state)).toBe(true);
  });

  test("a task in review is not runnable, not terminal, and keeps its stage open", () => {
    const state = tree();
    const reviewTask = state.stages[1]?.tasks[0];
    if (reviewTask === undefined) {
      throw new Error("expected the final task");
    }
    state.taskStatus.set(reviewTask.id, "review");
    state.finalTaskId = reviewTask.id;
    expect(allStagesClosed(state)).toBe(false);
    expect(runComplete(state)).toBe(false);
    // A review task is not runnable; the earlier pending task still is.
    expect(activeTask(state)?.id).toBe(taskId(2));
    expect(renderTaskStatus(state)).toContain(`@task #${reviewTask.id} review`);

    // With every edit done, only the review keeps the stage open.
    for (const stageNode of state.stages) {
      for (const taskNode of stageNode.tasks) {
        state.taskStatus.set(taskNode.id, taskNode.id === reviewTask.id ? "review" : "passed");
        for (const editNode of taskNode.edits) {
          state.editStatus.set(editNode.id, "done");
        }
      }
    }
    expect(activeTask(state)).toBeUndefined();
    expect(allStagesClosed(state)).toBe(false);
    expect(runComplete(state)).toBe(false);
  });

  test("finalTaskPassed requires finalTaskId to point at a passed last test task", () => {
    const state = tree();
    for (const stageNode of state.stages) {
      for (const taskNode of stageNode.tasks) {
        state.taskStatus.set(taskNode.id, "passed");
        for (const editNode of taskNode.edits) {
          state.editStatus.set(editNode.id, "done");
        }
      }
    }
    expect(finalTaskPassed(state)).toBe(false);
    state.finalTaskId = taskId(2);
    expect(finalTaskPassed(state)).toBe(false);
    state.finalTaskId = taskId(7);
    expect(finalTaskPassed(state)).toBe(true);
    const last = finalTask(state.stages);
    if (last === undefined) {
      throw new Error("expected a final task");
    }
    last.verify = "tsc";
    expect(finalTaskPassed(state)).toBe(false);
    state.taskStatus.set(taskId(7), "failed");
    expect(finalTaskPassed(state)).toBe(false);
  });

  test("renderTaskTree is stable and status renders separately", () => {
    const state = tree();
    const rendered = renderTaskTree(state.stages);
    expect(rendered).toContain('@stage #01-stage goal="Stage 1."');
    expect(rendered).toContain("@task #02-task verify=test");
    expect(rendered).toContain("#03-edit modify value");
    state.taskStatus.set(taskId(2), "passed");
    state.editStatus.set(editId(3), "done");
    expect(renderTaskTree(state.stages)).toBe(rendered);
    const status = renderTaskStatus(state);
    expect(status).toContain("@task #02-task passed");
    expect(status).toContain("#03-edit done");
  });

  test("summaryOf reports every edit with its string task and stage ids", () => {
    const state = tree();
    const summary = summaryOf(state);
    expect(summary.length).toBe(4);
    expect(summary[0]).toMatchObject({
      id: editId(3),
      stage: stageId(1),
      task: taskId(2),
      verify: "test",
      status: "todo",
    });
  });

  test("firstEdit is the first edit or a loud contract error", () => {
    const taskNode = task({ id: 2, edits: [edit({ id: 3 })] });
    expect(firstEdit(taskNode).id).toBe(editId(3));
    expect(() => firstEdit({ ...taskNode, edits: [] })).toThrow("no edits");
  });
});

describe("mergeReplan", () => {
  function baseState(): TaskRunState {
    return stateOf([
      stage(1, [
        task({
          id: 2,
          verify: "tsc",
          edits: [edit({ id: 3 }), edit({ id: 4 })],
        }),
        task({ id: 5, edits: [edit({ id: 6 })] }),
      ]),
      stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
    ]);
  }

  test("keeps done edits and appends a new task to the same stage", () => {
    const state = baseState();
    state.editStatus.set(editId(3), "done");
    const merged = mergeReplan(
      state,
      replan(
        planDsl([
          stage(1, [
            task({
              id: 2,
              verify: "tsc",
              edits: [edit({ id: 3 }), edit({ id: 4 })],
            }),
            task({ id: 5, edits: [edit({ id: 6 })] }),
            task({ id: 9, edits: [edit({ id: 10 })] }),
          ]),
          stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
        ]),
      ),
    );
    if (!merged.ok) {
      throw new Error(merged.diagnostics);
    }
    expect(merged.state.editStatus.get(editId(3))).toBe("done");
    expect(merged.state.taskStatus.get(taskId(9))).toBe("pending");
    expect(merged.state.editStatus.get(editId(10))).toBe("todo");
  });

  test("a passed task is immutable", () => {
    const state = baseState();
    state.taskStatus.set(taskId(2), "passed");
    const changed = mergeReplan(
      state,
      replan(
        planDsl([
          stage(1, [
            task({
              id: 2,
              verify: "tsc",
              instruction: "Change it differently.",
              edits: [edit({ id: 3 }), edit({ id: 4 })],
            }),
            task({ id: 5, edits: [edit({ id: 6 })] }),
          ]),
          stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
        ]),
      ),
    );
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.diagnostics).toContain(`passed task #${taskId(2)} is immutable`);
    }
  });

  test("a failed task stays closed unchanged and reopens with a repair edit", () => {
    const state = baseState();
    state.taskStatus.set(taskId(2), "failed");
    state.editStatus.set(editId(3), "done");
    state.editStatus.set(editId(4), "failed");
    const same = mergeReplan(
      state,
      replan(
        planDsl([
          stage(1, [
            task({
              id: 2,
              verify: "tsc",
              edits: [edit({ id: 3 }), edit({ id: 4 })],
            }),
            task({ id: 5, edits: [edit({ id: 6 })] }),
          ]),
          stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
        ]),
      ),
    );
    expect(same.ok).toBe(true);
    if (same.ok) {
      expect(same.state.taskStatus.get(taskId(2))).toBe("failed");
      expect(same.state.editStatus.get(editId(4))).toBe("failed");
    }

    const repaired = mergeReplan(
      state,
      replan(
        planDsl([
          stage(1, [
            task({
              id: 2,
              verify: "tsc",
              edits: [edit({ id: 3 }), edit({ id: 4 }), edit({ id: 9 })],
            }),
            task({ id: 5, edits: [edit({ id: 6 })] }),
          ]),
          stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
        ]),
      ),
    );
    if (!repaired.ok) {
      throw new Error(repaired.diagnostics);
    }
    expect(repaired.state.taskStatus.get(taskId(2))).toBe("pending");
    expect(repaired.state.editStatus.get(editId(9))).toBe("todo");
  });

  test("a failed edit retries only with a changed definition", () => {
    const state = baseState();
    state.editStatus.set(editId(3), "failed");
    const same = mergeReplan(
      state,
      replan(
        planDsl([
          stage(1, [
            task({
              id: 2,
              verify: "tsc",
              edits: [edit({ id: 3 }), edit({ id: 4 })],
            }),
            task({ id: 5, edits: [edit({ id: 6 })] }),
          ]),
          stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
        ]),
      ),
    );
    expect(same.ok).toBe(true);
    if (same.ok) {
      expect(same.state.editStatus.get(editId(3))).toBe("failed");
    }
    const retried = mergeReplan(
      state,
      replan(
        planDsl([
          stage(1, [
            task({
              id: 2,
              verify: "tsc",
              edits: [edit({ id: 3, instruction: "A smaller retry." }), edit({ id: 4 })],
            }),
            task({ id: 5, edits: [edit({ id: 6 })] }),
          ]),
          stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
        ]),
      ),
    );
    if (!retried.ok) {
      throw new Error(retried.diagnostics);
    }
    expect(retried.state.editStatus.get(editId(3))).toBe("todo");
    expect(retried.state.taskStatus.get(taskId(2))).toBe("pending");
  });

  test("removing a done edit or a task with done work is rejected", () => {
    const state = baseState();
    state.editStatus.set(editId(3), "done");
    state.editStatus.set(editId(4), "done");
    const removeEdit = mergeReplan(
      state,
      replan(
        planDsl([
          stage(1, [
            task({
              id: 2,
              verify: "tsc",
              edits: [edit({ id: 3 })],
            }),
            task({ id: 5, edits: [edit({ id: 6 })] }),
          ]),
          stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
        ]),
      ),
    );
    expect(removeEdit.ok).toBe(false);
    if (!removeEdit.ok) {
      expect(removeEdit.diagnostics).toContain(`done edit #${editId(4)} cannot be removed`);
    }

    const removeTask = mergeReplan(
      state,
      replan(
        planDsl([
          stage(1, [task({ id: 5, edits: [edit({ id: 6 })] })]),
          stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
        ]),
      ),
    );
    expect(removeTask.ok).toBe(false);
    if (!removeTask.ok) {
      expect(removeTask.diagnostics).toContain("contains done edits and cannot be removed");
    }
  });

  test("a fully passed stage is closed; new work goes in a new stage", () => {
    const state = baseState();
    state.taskStatus.set(taskId(2), "passed");
    state.taskStatus.set(taskId(5), "passed");
    for (const id of [3, 4, 6]) {
      state.editStatus.set(editId(id), "done");
    }
    const extend = mergeReplan(
      state,
      replan(
        planDsl([
          stage(1, [
            task({
              id: 2,
              verify: "tsc",
              edits: [edit({ id: 3 }), edit({ id: 4 })],
            }),
            task({ id: 5, edits: [edit({ id: 6 })] }),
            task({ id: 9, edits: [edit({ id: 10 })] }),
          ]),
          stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
        ]),
      ),
    );
    expect(extend.ok).toBe(false);
    if (!extend.ok) {
      expect(extend.diagnostics).toContain("already passed");
    }

    const newStage = mergeReplan(
      state,
      replan(
        planDsl([
          stage(1, [
            task({
              id: 2,
              verify: "tsc",
              edits: [edit({ id: 3 }), edit({ id: 4 })],
            }),
            task({ id: 5, edits: [edit({ id: 6 })] }),
          ]),
          stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
          stage(3, [task({ id: 9, edits: [edit({ id: 10 })] })]),
        ]),
      ),
    );
    if (!newStage.ok) {
      throw new Error(newStage.diagnostics);
    }
    expect(newStage.state.stages.map((stageNode) => stageNode.id)).toEqual([
      stageId(1),
      stageId(2),
      stageId(3),
    ]);
  });

  test("new stages are appended and existing order is preserved", () => {
    const state = baseState();
    const moved = mergeReplan(
      state,
      replan(
        planDsl([
          stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
          stage(1, [
            task({
              id: 2,
              verify: "tsc",
              edits: [edit({ id: 3 }), edit({ id: 4 })],
            }),
            task({ id: 5, edits: [edit({ id: 6 })] }),
          ]),
        ]),
      ),
    );
    expect(moved.ok).toBe(false);
    if (!moved.ok) {
      expect(moved.diagnostics).toContain("existing stages must keep their plan order");
    }
  });

  test("preserves finalTaskId while a full-tree re-plan is in flight", () => {
    const state = baseState();
    state.finalTaskId = taskId(7);
    const merged = mergeReplan(
      state,
      replan(
        planDsl([
          stage(1, [
            task({
              id: 2,
              verify: "tsc",
              edits: [edit({ id: 3 }), edit({ id: 4 })],
            }),
            task({ id: 5, edits: [edit({ id: 6 })] }),
          ]),
          stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
        ]),
      ),
    );
    if (!merged.ok) {
      throw new Error(merged.diagnostics);
    }
    expect(merged.state.finalTaskId).toBe(taskId(7));
  });

  test("a plan without finish may end in a tsc task; finish still requires test", () => {
    const content = planDsl([
      stage(1, [
        task({
          id: 2,
          verify: "tsc",
          edits: [edit({ id: 3 }), edit({ id: 4 })],
        }),
        task({ id: 5, edits: [edit({ id: 6 })] }),
      ]),
      stage(2, [task({ id: 7, verify: "tsc", edits: [edit({ id: 8 })] })]),
    ]);
    const accepted = readPlan(content);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.finalTaskId).toBeNull();
      expect(finalTask(accepted.plan.stages)?.verify).toBe("tsc");
    }
    const rejected = readPlan(`${content}\nfinish`);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.diagnostics).toContain('must verify "test"');
    }
  });

  test("an edit cannot move to a different task", () => {
    const state = baseState();
    const movedEdit = mergeReplan(
      state,
      replan(
        planDsl([
          stage(1, [
            task({
              id: 2,
              verify: "tsc",
              edits: [edit({ id: 4 })],
            }),
            task({ id: 5, edits: [edit({ id: 6 }), edit({ id: 3 })] }),
          ]),
          stage(2, [task({ id: 7, edits: [edit({ id: 8 })] })]),
        ]),
      ),
    );
    expect(movedEdit.ok).toBe(false);
    if (!movedEdit.ok) {
      expect(movedEdit.diagnostics).toContain(
        `moved from task #${taskId(2)} to task #${taskId(5)}`,
      );
    }
  });
});

describe("applyPlanPatch", () => {
  function patchTree(): TaskRunState {
    return stateOf([
      stage(1, [
        task({
          id: 2,
          verify: "test",
          edits: [edit({ id: 3 }), edit({ id: 4 })],
        }),
        task({ id: 5, verify: "tsc", edits: [edit({ id: 6 })] }),
      ]),
      stage(2, [task({ id: 7, verify: "test", edits: [edit({ id: 8 })] })]),
    ]);
  }

  function patchOf(content: string) {
    const parsed = parsePlanPatch(content);
    if (!parsed.ok) {
      throw new Error(`expected an accepted patch, got ${parsed.diagnostics}`);
    }
    return parsed.patch;
  }

  function applied(state: TaskRunState, content: string): TaskRunState {
    const merged = applyPlanPatch(state, patchOf(content));
    if (!merged.ok) {
      throw new Error(merged.diagnostics);
    }
    return merged.state;
  }

  test("applies plan/stage/task/edit updates and appends new work", () => {
    const state = patchTree();
    state.editStatus.set(editId(4), "done");
    state.editStatus.set(editId(6), "done");
    state.taskStatus.set(taskId(5), "passed");

    const merged = applied(
      state,
      `patch
plan~ "01-main"
goal: Updated plan.
end
stage~ "01-stage"
goal: Updated stage.
end
task~ "02-task"
verify tsc
instruction: Updated task.
end
edit~ "03-edit"
modify value renamed in src/b.ts
instruction: Updated edit.
end
stage+ "09-stage" plan "01-main"
goal: Added stage.
end
task+ "10-task" stage "09-stage" verify test
instruction: Added task.
end
edit+ "11-edit" task "10-task" create value helper in src/helper.ts
instruction: Added edit.
end
finish`,
    );

    expect(merged.plan.goal).toBe("Updated plan.");
    expect(merged.stages[0]?.goal).toBe("Updated stage.");
    expect(merged.stages[0]?.tasks[0]).toMatchObject({
      id: taskId(2),
      verify: "tsc",
      instruction: "Updated task.",
    });
    expect(merged.stages[0]?.tasks[0]?.edits[0]).toMatchObject({
      id: editId(3),
      loc: { path: "src/b.ts", symbol: "renamed", kind: "value" },
      action: "modify",
      instruction: "Updated edit.",
    });
    expect(merged.editStatus.get(editId(3))).toBe("todo");
    expect(merged.editStatus.get(editId(4))).toBe("done");
    expect(merged.taskStatus.get(taskId(5))).toBe("passed");

    expect(merged.stages.map((stageNode) => stageNode.id)).toEqual([
      stageId(1),
      stageId(2),
      "09-stage",
    ]);
    expect(merged.stages[2]?.tasks[0]).toMatchObject({
      id: "10-task",
      verify: "test",
      instruction: "Added task.",
    });
    expect(merged.stages[2]?.tasks[0]?.edits[0]).toMatchObject({
      id: "11-edit",
      action: "create",
      loc: { path: "src/helper.ts", symbol: "helper", kind: "value" },
      instruction: "Added edit.",
    });
    expect(merged.taskStatus.get("10-task")).toBe("pending");
    expect(merged.editStatus.get("11-edit")).toBe("todo");
    expect(merged.finalTaskId).toBe("10-task");

    // The source state is untouched.
    expect(state.plan.goal).toBe("Make the change.");
    expect(state.stages.length).toBe(2);
    expect(state.finalTaskId).toBeNull();
  });

  test("stage- and task- cascade their tasks and edits", () => {
    const state = patchTree();
    state.taskStatus.set(taskId(5), "failed");
    state.editStatus.set(editId(6), "failed");

    const merged = applied(
      state,
      `patch
edit- "08-edit"
end
task- "07-task"
end
stage- "02-stage"
end
task- "05-task"
end`,
    );

    expect(merged.stages.map((stageNode) => stageNode.id)).toEqual([stageId(1)]);
    expect(merged.stages[0]?.tasks.map((taskNode) => taskNode.id)).toEqual([taskId(2)]);
    expect(merged.stages[0]?.tasks[0]?.edits.map((editNode) => editNode.id)).toEqual([
      editId(3),
      editId(4),
    ]);
    for (const id of [taskId(5), taskId(7)]) {
      expect(merged.taskStatus.has(id)).toBe(false);
    }
    for (const id of [editId(6), editId(8)]) {
      expect(merged.editStatus.has(id)).toBe(false);
    }
    expect(merged.taskStatus.get(taskId(2))).toBe("pending");
    expect(merged.editStatus.get(editId(3))).toBe("todo");

    // Failed work was removable, and the source state still carries it.
    expect(state.taskStatus.get(taskId(5))).toBe("failed");
    expect(state.editStatus.get(editId(6))).toBe("failed");
    expect(state.stages.length).toBe(2);
  });

  test("done edits and passed tasks are immutable", () => {
    const state = patchTree();
    state.editStatus.set(editId(3), "done");
    const beforeDone = snapshot(state);

    const removeDone = applyPlanPatch(state, patchOf('patch\nedit- "03-edit"\nend'));
    expect(removeDone.ok).toBe(false);
    if (!removeDone.ok) {
      expect(removeDone.diagnostics).toContain(`done edit #${editId(3)} cannot be removed`);
    }
    expect(snapshot(state)).toBe(beforeDone);

    const changeDone = applyPlanPatch(
      state,
      patchOf('patch\nedit~ "03-edit"\ninstruction: Different.\nend'),
    );
    expect(changeDone.ok).toBe(false);
    if (!changeDone.ok) {
      expect(changeDone.diagnostics).toContain(`done edit #${editId(3)} is immutable`);
    }
    expect(snapshot(state)).toBe(beforeDone);

    const removeTask = applyPlanPatch(state, patchOf('patch\ntask- "02-task"\nend'));
    expect(removeTask.ok).toBe(false);
    if (!removeTask.ok) {
      expect(removeTask.diagnostics).toContain("contains done edits and cannot be removed");
    }
    const removeStage = applyPlanPatch(state, patchOf('patch\nstage- "01-stage"\nend'));
    expect(removeStage.ok).toBe(false);
    if (!removeStage.ok) {
      expect(removeStage.diagnostics).toContain("contains passed tasks or done edits");
    }
    expect(snapshot(state)).toBe(beforeDone);

    const passed = patchTree();
    passed.taskStatus.set(taskId(2), "passed");
    const beforePassed = snapshot(passed);
    const removePassed = applyPlanPatch(passed, patchOf('patch\ntask- "02-task"\nend'));
    expect(removePassed.ok).toBe(false);
    if (!removePassed.ok) {
      expect(removePassed.diagnostics).toContain(`passed task #${taskId(2)} cannot be removed`);
    }
    const changePassed = applyPlanPatch(
      passed,
      patchOf('patch\ntask~ "02-task"\ninstruction: Different.\nend'),
    );
    expect(changePassed.ok).toBe(false);
    if (!changePassed.ok) {
      expect(changePassed.diagnostics).toContain(`passed task #${taskId(2)} is immutable`);
    }
    expect(snapshot(passed)).toBe(beforePassed);
  });

  test("in-progress work cannot be removed directly or by cascade", () => {
    const state = patchTree();
    state.editStatus.set(editId(3), "in-progress");
    const before = snapshot(state);

    for (const content of [
      'patch\nedit- "03-edit"\nend',
      'patch\ntask- "02-task"\nend',
      'patch\nstage- "01-stage"\nend',
    ]) {
      const rejected = applyPlanPatch(state, patchOf(content));
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.diagnostics).toMatch(/in[- ]progress/);
      }
    }
    expect(snapshot(state)).toBe(before);
  });

  test("a failed later op leaves the whole previous state untouched", () => {
    const state = patchTree();
    state.taskStatus.set(taskId(2), "passed");
    const before = snapshot(state);

    const mergeFailure = applyPlanPatch(
      state,
      patchOf(`patch
stage- "02-stage"
end
task~ "02-task"
instruction: Change a passed task.
end`),
    );
    expect(mergeFailure.ok).toBe(false);
    if (!mergeFailure.ok) {
      expect(mergeFailure.diagnostics).toContain(`passed task #${taskId(2)} is immutable`);
    }
    expect(snapshot(state)).toBe(before);
    expect(state.stages.map((stageNode) => stageNode.id)).toEqual([stageId(1), stageId(2)]);

    const applyFailure = applyPlanPatch(
      state,
      patchOf(`patch
stage- "02-stage"
end
edit- "99-missing"
end`),
    );
    expect(applyFailure.ok).toBe(false);
    if (!applyFailure.ok) {
      expect(applyFailure.diagnostics).toContain(
        "edit- names edit #99-missing, which does not exist",
      );
    }
    expect(snapshot(state)).toBe(before);
  });

  test("rejects unknown ids and parents, including forward parents", () => {
    const state = patchTree();
    const before = snapshot(state);
    const cases: [string, string][] = [
      ['patch\nplan~ "09-other"\ngoal: g\nend', "current Plan"],
      ['patch\nstage+ "09-stage" plan "09-other"\ngoal: g\nend', "names plan"],
      ['patch\nstage~ "09-missing"\ngoal: g\nend', "does not exist"],
      ['patch\nstage- "09-missing"\nend', "does not exist"],
      [
        'patch\ntask+ "09-task" stage "09-missing" verify test\ninstruction: x\nend',
        "does not exist",
      ],
      ['patch\ntask~ "09-missing"\ninstruction: x\nend', "does not exist"],
      ['patch\ntask- "09-missing"\nend', "does not exist"],
      [
        'patch\nedit+ "09-edit" task "09-missing" modify value x in src/a.ts\ninstruction: x\nend',
        "does not exist",
      ],
      ['patch\nedit~ "09-missing"\ninstruction: x\nend', "does not exist"],
      ['patch\nedit- "09-missing"\nend', "does not exist"],
      [
        `patch
task+ "09-task" stage "09-stage" verify test
instruction: x
end
stage+ "09-stage" plan "01-main"
goal: g
end`,
        "does not exist",
      ],
    ];
    for (const [content, expected] of cases) {
      const rejected = applyPlanPatch(state, patchOf(content));
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.diagnostics).toContain(expected);
      }
      expect(snapshot(state)).toBe(before);
    }
  });

  test("rejects duplicate added ids without partial application", () => {
    const state = patchTree();
    const before = snapshot(state);
    const duplicate = applyPlanPatch(
      state,
      patchOf(`patch
stage+ "09-stage" plan "01-main"
goal: First.
end
stage+ "09-stage" plan "01-main"
goal: Second.
end`),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.diagnostics).toContain("reuses node id");
    }
    expect(snapshot(state)).toBe(before);
  });

  test("finish moves finalTaskId and supports in-place repair", () => {
    const state = patchTree();
    const finished = applied(state, "patch\nfinish");
    expect(finished.finalTaskId).toBe(taskId(7));
    expect(finalTask(finished.stages)?.id).toBe(taskId(7));

    finished.taskStatus.set(taskId(7), "failed");
    finished.editStatus.set(editId(8), "failed");
    const repaired = applied(
      finished,
      `patch
task~ "07-task"
instruction: Repair the final task in place.
end
edit~ "08-edit"
instruction: Repair the final edit in place.
end`,
    );
    expect(repaired.finalTaskId).toBe(taskId(7));
    expect(finalTask(repaired.stages)?.id).toBe(taskId(7));
    expect(finalTask(repaired.stages)?.instruction).toBe("Repair the final task in place.");
    expect(repaired.taskStatus.get(taskId(7))).toBe("pending");
    expect(repaired.editStatus.get(editId(8))).toBe("todo");
    expect(finished.finalTaskId).toBe(taskId(7));
  });

  test("appending after the final task needs a new finish on the new last test task", () => {
    const state = applied(patchTree(), "patch\nfinish");
    const before = snapshot(state);
    const append = `patch
task+ "09-task" stage "02-stage" verify test
instruction: New final task.
end
edit+ "10-edit" task "09-task" modify value last in src/a.ts
instruction: New final edit.
end`;

    const noFinish = applyPlanPatch(state, patchOf(append));
    expect(noFinish.ok).toBe(false);
    if (!noFinish.ok) {
      expect(noFinish.diagnostics).toContain("no longer last");
      expect(noFinish.diagnostics).toContain("emit finish");
    }
    expect(snapshot(state)).toBe(before);

    const withFinish = applied(state, `${append}\nfinish`);
    expect(withFinish.finalTaskId).toBe("09-task");
    expect(finalTask(withFinish.stages)?.id).toBe("09-task");
    expect(withFinish.stages[1]?.tasks.map((taskNode) => taskNode.id)).toEqual([
      taskId(7),
      "09-task",
    ]);

    const badFinal = applyPlanPatch(
      state,
      patchOf(`patch
task+ "11-task" stage "02-stage" verify tsc
instruction: Not a final test.
end
edit+ "12-edit" task "11-task" modify value x in src/a.ts
instruction: x
end
finish`),
    );
    expect(badFinal.ok).toBe(false);
    if (!badFinal.ok) {
      expect(badFinal.diagnostics).toContain('must verify "test"');
    }
    expect(snapshot(state)).toBe(before);
  });

  test("applies the §4.1 in-place repair example and keeps the final task", () => {
    const answerEdit: EditNode = {
      id: "04-change",
      loc: { path: "src/helper.ts", symbol: "answer", kind: "value" },
      action: "modify",
      instruction: "Change answer to return 2.",
    };
    const answerTask: TaskNode = {
      id: "03-answer",
      verify: "test",
      instruction: "Make the failing test green.",
      edits: [answerEdit],
    };
    const state = initialState(
      {
        id: "01-main",
        goal: "Make the failing test pass.",
        stages: [{ id: "02-current", goal: "Fix the answer behavior.", tasks: [answerTask] }],
      },
      "03-answer",
    );

    const merged = applied(
      state,
      `patch
task~ "03-answer"
instruction: Keep the final test task; repair only the return expression.
end
edit~ "04-change"
instruction: Replace only the return statement with \`return 2;\`.
end`,
    );

    expect(merged.finalTaskId).toBe("03-answer");
    expect(merged.stages[0]?.tasks[0]?.instruction).toBe(
      "Keep the final test task; repair only the return expression.",
    );
    expect(merged.stages[0]?.tasks[0]?.edits[0]?.instruction).toBe(
      "Replace only the return statement with `return 2;`.",
    );
  });

  test("applies the §4.2 remove-pending-work example", () => {
    const state = initialState({
      id: "01-main",
      goal: "Make the failing test pass.",
      stages: [
        {
          id: "02-current",
          goal: "Fix the answer behavior.",
          tasks: [
            {
              id: "03-answer",
              verify: "test",
              instruction: "Make the failing test green.",
              edits: [
                {
                  id: "04-change",
                  loc: { path: "src/helper.ts", symbol: "answer", kind: "value" },
                  action: "modify",
                  instruction: "Change answer to return 2.",
                },
              ],
            },
          ],
        },
        {
          id: "05-repair",
          goal: "Temporary repair context.",
          tasks: [
            {
              id: "06-object",
              verify: "test",
              instruction: "Temporary task.",
              edits: [
                {
                  id: "07-object",
                  loc: { path: "src/a.ts", symbol: "object", kind: "value" },
                  action: "modify",
                  instruction: "Temporary edit.",
                },
              ],
            },
          ],
        },
      ],
    });

    const merged = applied(
      state,
      `patch
edit- "07-object"
end
task- "06-object"
end
stage- "05-repair"
end`,
    );

    expect(merged.stages.map((stageNode) => stageNode.id)).toEqual(["02-current"]);
    expect(merged.stages[0]?.tasks.map((taskNode) => taskNode.id)).toEqual(["03-answer"]);
    expect(merged.stages[0]?.tasks[0]?.edits.map((editNode) => editNode.id)).toEqual(["04-change"]);
    expect(merged.taskStatus.has("06-object")).toBe(false);
    expect(merged.editStatus.has("07-object")).toBe(false);
    expect(merged.finalTaskId).toBeNull();
  });

  test("applies the §3.3 next-stage final-test example", () => {
    const state = initialState({
      id: "01-main",
      goal: "Make the failing test pass.",
      stages: [
        {
          id: "02-current",
          goal: "Fix the answer behavior.",
          tasks: [
            {
              id: "03-answer",
              verify: "test",
              instruction: "Make the failing test green.",
              edits: [
                {
                  id: "04-change",
                  loc: { path: "src/helper.ts", symbol: "answer", kind: "value" },
                  action: "modify",
                  instruction: "Change answer to return 2.",
                },
              ],
            },
          ],
        },
      ],
    });

    const merged = applied(
      state,
      `patch
stage+ "07-next" plan "01-main"
goal: Finish the remaining behavior.
end
task+ "08-final" stage "07-next" verify test
instruction: Run the full behavior and keep the suite green.
end
edit+ "09-final" task "08-final" modify value parseJson in src/helper.ts
instruction: Wire the final entry point; no new class.
end
finish`,
    );

    expect(merged.stages.map((stageNode) => stageNode.id)).toEqual(["02-current", "07-next"]);
    expect(merged.finalTaskId).toBe("08-final");
    expect(finalTask(merged.stages)?.verify).toBe("test");
    expect(merged.taskStatus.get("08-final")).toBe("pending");
    expect(merged.editStatus.get("09-final")).toBe("todo");
  });

  test("merge accepts appended work without per-stage count caps", () => {
    const state = patchTree();
    const ops: PlanPatchOp[] = [];
    for (let index = 0; index < 10; index += 1) {
      const label = 20 + index;
      const taskNodeId = `${label}-task`;
      const editNodeId = `${label}-edit`;
      ops.push({
        kind: "task-add",
        id: taskNodeId,
        stage: stageId(1),
        verify: "test",
        instruction: `Added task ${label}.`,
      });
      ops.push({
        kind: "edit-add",
        id: editNodeId,
        task: taskNodeId,
        loc: { path: "src/a.ts", symbol: `extra${label}`, kind: "value" },
        action: "modify",
        instruction: `Added edit ${label}.`,
      });
    }

    const merged = applyPlanPatch(state, { ops, finish: false });
    if (!merged.ok) {
      throw new Error(merged.diagnostics);
    }
    expect(merged.state.stages[0]?.tasks.length).toBe(12);
  });
});
