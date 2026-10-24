import { describe, expect, test } from "bun:test";
import {
  activeStage,
  activeTask,
  allStagesClosed,
  allTasks,
  finalTaskPassed,
  firstEdit,
  hasLaterPendingTaskInStage,
  initialState,
  isSafeTaskPath,
  MAX_EDITS_PER_TASK,
  MAX_STAGES,
  MAX_TASKS_PER_STAGE,
  mergeReplan,
  nextEdit,
  parsePlan,
  readPlan,
  renderTaskStatus,
  renderTaskTree,
  runComplete,
  summaryOf,
  taskEditsSettled,
  taskHasDoneEdit,
} from "./tasks";
import type { EditNode, Stage, TaskNode, TaskRunState } from "./tasks";

function edit(overrides: Partial<EditNode> & Pick<EditNode, "id">): EditNode {
  return {
    loc: { path: "src/a.ts", symbol: `symbol${overrides.id}`, kind: "value" },
    action: "modify",
    instruction: `Do edit ${overrides.id}.`,
    ...overrides,
  };
}

function task(overrides: Partial<TaskNode> & Pick<TaskNode, "id">): TaskNode {
  return {
    verify: "test",
    instruction: `Do task ${overrides.id}.`,
    edits: [edit({ id: overrides.id + 1_000 })],
    ...overrides,
  };
}

function stage(id: number, tasks: TaskNode[], goal = `Stage ${id}.`): Stage {
  return { id, goal, tasks };
}

function planJson(stages: Stage[]): string {
  return JSON.stringify({ stages });
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
  return initialState(okPlan(planJson(stages)));
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
      planJson([
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
    expect(plan.stages.length).toBe(1);
    expect(plan.stages[0]?.tasks[0]?.edits[0]?.id).toBe(3);
  });

  test("tolerates a whole-text fence and surrounding prose", () => {
    const body = planJson([stage(1, [task({ id: 2 })])]);
    expect(okPlan(`Here is the plan:\n\n\`\`\`json\n${body}\n\`\`\`\n`).stages.length).toBe(1);
  });

  test("rejects a non-object, empty stages, extra keys, and the old flat shape", () => {
    expect(rejectPlan("[]").diagnostics).toContain("not an object");
    expect(rejectPlan(`{"stages": []}`).diagnostics).toContain("non-empty array");
    expect(rejectPlan(`{"stages": [], "tasks": []}`).diagnostics).toContain("unexpected key");
    expect(rejectPlan(`{"tasks": [], "todo": [], "status": {}}`).diagnostics).toContain(
      "unexpected key",
    );
  });

  test("rejects empty tasks/edits and names an unexpected key", () => {
    expect(rejectPlan(planJson([{ id: 1, goal: "g", tasks: [] }])).diagnostics).toContain(
      "non-empty array",
    );
    const emptyEdits = { ...task({ id: 2 }), edits: [] };
    expect(rejectPlan(planJson([stage(1, [emptyEdits])])).diagnostics).toContain("non-empty array");
    const withExtra = { ...task({ id: 2 }), note: "x" } as unknown as TaskNode;
    expect(rejectPlan(planJson([stage(1, [withExtra])])).diagnostics).toContain(
      'unexpected key(s) "note"',
    );
  });

  test("rejects duplicate stage ids and duplicate task/edit node ids", () => {
    expect(
      rejectPlan(planJson([stage(1, [task({ id: 2 })]), stage(1, [task({ id: 3 })])])).diagnostics,
    ).toContain("reuses stage id");
    expect(
      rejectPlan(
        planJson([
          stage(1, [
            task({ id: 2, edits: [edit({ id: 10 })] }),
            task({ id: 10, edits: [edit({ id: 11 })] }),
          ]),
        ]),
      ).diagnostics,
    ).toContain("reuses node id");
    expect(
      rejectPlan(
        planJson([
          stage(1, [
            task({ id: 2, edits: [edit({ id: 3 })] }),
            task({ id: 4, edits: [edit({ id: 3 })] }),
          ]),
        ]),
      ).diagnostics,
    ).toContain("reuses node id");
  });

  test("requires a task verify and a final test task", () => {
    const noVerify = { ...task({ id: 2 }), verify: undefined } as unknown as TaskNode;
    expect(rejectPlan(planJson([stage(1, [noVerify])])).diagnostics).toContain("verify must be");
    const badVerify = { ...task({ id: 2 }), verify: "lint" } as unknown as TaskNode;
    expect(rejectPlan(planJson([stage(1, [badVerify])])).diagnostics).toContain("verify must be");
    expect(
      rejectPlan(planJson([stage(1, [task({ id: 2, verify: "tsc" })])])).diagnostics,
    ).toContain('must verify "test"');
  });

  test("caps stages, tasks per stage, and edits per task", () => {
    const manyStages = Array.from({ length: MAX_STAGES + 1 }, (_, index) =>
      stage(index + 1, [task({ id: index + 100 })]),
    );
    expect(rejectPlan(planJson(manyStages)).diagnostics).toContain("at most");
    const manyTasks = Array.from({ length: MAX_TASKS_PER_STAGE + 1 }, (_, index) =>
      task({ id: index + 100 }),
    );
    expect(rejectPlan(planJson([stage(1, manyTasks)])).diagnostics).toContain("at most");
    const manyEdits = Array.from({ length: MAX_EDITS_PER_TASK + 1 }, (_, index) =>
      edit({ id: index + 100 }),
    );
    expect(
      rejectPlan(planJson([stage(1, [task({ id: 2, edits: manyEdits })])])).diagnostics,
    ).toContain("at most");
  });

  test("loc.kind is a symbol space, not a declaration keyword", () => {
    const bad = {
      ...task({ id: 2 }),
      edits: [
        {
          id: 3,
          loc: { path: "src/a.ts", symbol: "answer", kind: "function" },
          action: "modify",
          instruction: "Change it.",
        },
      ],
    } as unknown as TaskNode;
    expect(rejectPlan(planJson([stage(1, [bad])])).diagnostics).toContain("symbol space");
  });

  test("accepts related migration targets and rejects cross-file related locs", () => {
    const migration = okPlan(
      planJson([
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
      planJson([
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
    expect(rejectPlan(planJson([stage(1, [missing])])).diagnostics).toContain("renameTo");
    const same = task({
      id: 2,
      edits: [edit({ id: 3, action: "rename", renameTo: "symbol3" })],
    });
    expect(rejectPlan(planJson([stage(1, [same])])).diagnostics).toContain("to itself");
    const stray = task({
      id: 2,
      edits: [edit({ id: 3, renameTo: "other" })],
    });
    expect(rejectPlan(planJson([stage(1, [stray])])).diagnostics).toContain('action is "modify"');
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
      expect(rejectPlan(planJson([stage(1, [bad])])).diagnostics).toContain(
        "writable repo-relative path",
      );
    }
  });

  test("rejects an instruction that is too long", () => {
    const long = task({
      id: 2,
      edits: [edit({ id: 3, instruction: "x".repeat(4_001) })],
    });
    expect(rejectPlan(planJson([stage(1, [long])])).diagnostics).toContain("at most 4000");
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
    expect(activeStage(state)?.id).toBe(1);
    expect(activeTask(state)?.id).toBe(2);
    const first = activeTask(state);
    expect(first === undefined ? undefined : nextEdit(state, first)?.id).toBe(3);
    state.editStatus.set(3, "done");
    const firstAgain = activeTask(state);
    expect(firstAgain === undefined ? undefined : nextEdit(state, firstAgain)?.id).toBe(4);
    state.editStatus.set(4, "done");
    expect(firstAgain === undefined ? false : taskEditsSettled(state, firstAgain)).toBe(true);
    expect(firstAgain === undefined ? false : taskHasDoneEdit(state, firstAgain)).toBe(true);
    state.taskStatus.set(2, "passed");
    expect(activeTask(state)?.id).toBe(5);
    state.editStatus.set(6, "done");
    state.taskStatus.set(5, "passed");
    expect(activeStage(state)?.id).toBe(2);
    expect(activeTask(state)?.id).toBe(7);
    expect(runComplete(state)).toBe(false);
    state.editStatus.set(8, "done");
    state.taskStatus.set(7, "passed");
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
    expect(activeTask(state)?.id).toBe(5);
  });

  test("allStagesClosed allows earlier failed tasks but not pending work", () => {
    const state = tree();
    for (const stageNode of state.stages) {
      for (const taskNode of stageNode.tasks) {
        state.taskStatus.set(taskNode.id, taskNode.id === 2 ? "failed" : "passed");
        for (const editNode of taskNode.edits) {
          state.editStatus.set(editNode.id, editNode.id === 3 ? "failed" : "done");
        }
      }
    }
    expect(allStagesClosed(state)).toBe(true);
    expect(finalTaskPassed(state)).toBe(true);
    expect(runComplete(state)).toBe(true);
  });

  test("renderTaskTree is stable and status renders separately", () => {
    const state = tree();
    const rendered = renderTaskTree(state.stages);
    expect(rendered).toContain('@stage #1 goal="Stage 1."');
    expect(rendered).toContain("@task #2 verify=test");
    expect(rendered).toContain("#3 modify value");
    state.taskStatus.set(2, "passed");
    state.editStatus.set(3, "done");
    expect(renderTaskTree(state.stages)).toBe(rendered);
    const status = renderTaskStatus(state);
    expect(status).toContain("@task #2 passed");
    expect(status).toContain("#3 done");
  });

  test("summaryOf reports every edit with its task and stage", () => {
    const state = tree();
    const summary = summaryOf(state);
    expect(summary.length).toBe(4);
    expect(summary[0]).toMatchObject({ id: 3, stage: 1, task: 2, verify: "test", status: "todo" });
  });

  test("firstEdit is the first edit or a loud contract error", () => {
    const taskNode = task({ id: 2, edits: [edit({ id: 3 })] });
    expect(firstEdit(taskNode).id).toBe(3);
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
    state.editStatus.set(3, "done");
    const merged = mergeReplan(
      state,
      replan(
        planJson([
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
    expect(merged.state.editStatus.get(3)).toBe("done");
    expect(merged.state.taskStatus.get(9)).toBe("pending");
    expect(merged.state.editStatus.get(10)).toBe("todo");
  });

  test("a passed task is immutable", () => {
    const state = baseState();
    state.taskStatus.set(2, "passed");
    const changed = mergeReplan(
      state,
      replan(
        planJson([
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
      expect(changed.diagnostics).toContain("passed task #2 is immutable");
    }
  });

  test("a failed task stays closed unchanged and reopens with a repair edit", () => {
    const state = baseState();
    state.taskStatus.set(2, "failed");
    state.editStatus.set(3, "done");
    state.editStatus.set(4, "failed");
    const same = mergeReplan(
      state,
      replan(
        planJson([
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
      expect(same.state.taskStatus.get(2)).toBe("failed");
      expect(same.state.editStatus.get(4)).toBe("failed");
    }

    const repaired = mergeReplan(
      state,
      replan(
        planJson([
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
    expect(repaired.state.taskStatus.get(2)).toBe("pending");
    expect(repaired.state.editStatus.get(9)).toBe("todo");
  });

  test("a failed edit retries only with a changed definition", () => {
    const state = baseState();
    state.editStatus.set(3, "failed");
    const same = mergeReplan(
      state,
      replan(
        planJson([
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
      expect(same.state.editStatus.get(3)).toBe("failed");
    }
    const retried = mergeReplan(
      state,
      replan(
        planJson([
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
    expect(retried.state.editStatus.get(3)).toBe("todo");
    expect(retried.state.taskStatus.get(2)).toBe("pending");
  });

  test("removing a done edit or a task with done work is rejected", () => {
    const state = baseState();
    state.editStatus.set(3, "done");
    state.editStatus.set(4, "done");
    const removeEdit = mergeReplan(
      state,
      replan(
        planJson([
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
      expect(removeEdit.diagnostics).toContain("done edit #4 cannot be removed");
    }

    const removeTask = mergeReplan(
      state,
      replan(
        planJson([
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
    state.taskStatus.set(2, "passed");
    state.taskStatus.set(5, "passed");
    for (const id of [3, 4, 6]) {
      state.editStatus.set(id, "done");
    }
    const extend = mergeReplan(
      state,
      replan(
        planJson([
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
        planJson([
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
    expect(newStage.state.stages.map((stageNode) => stageNode.id)).toEqual([1, 2, 3]);
  });

  test("new stages are appended and existing order is preserved", () => {
    const state = baseState();
    const moved = mergeReplan(
      state,
      replan(
        planJson([
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

  test("a plan that drops final test coverage is rejected", () => {
    const rejected = readPlan(
      planJson([
        stage(1, [
          task({
            id: 2,
            verify: "tsc",
            edits: [edit({ id: 3 }), edit({ id: 4 })],
          }),
          task({ id: 5, edits: [edit({ id: 6 })] }),
        ]),
        stage(2, [task({ id: 7, verify: "tsc", edits: [edit({ id: 8 })] })]),
      ]),
    );
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
        planJson([
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
      expect(movedEdit.diagnostics).toContain("moved from task #2 to task #5");
    }
  });
});
