import { describe, expect, test } from "bun:test";
import {
  allTasksDone,
  initialState,
  isSafeTaskPath,
  MAX_TASKS,
  maxTaskId,
  mergeReplan,
  readPlan,
  parseTaskPlan,
  readyFrontier,
  renderTaskDag,
  renderTaskStatus,
} from "./tasks";
import type { EditTask, TaskRunState } from "./tasks";

function task(overrides: Partial<EditTask> & Pick<EditTask, "id">): EditTask {
  return {
    loc: { path: "src/a.ts", symbol: "answer", kind: "value" },
    deps: [],
    action: "modify",
    instruction: `Do task ${overrides.id}.`,
    ...overrides,
  };
}

function planJson(tasks: EditTask[], todo: number[], status: Record<string, string>): string {
  return JSON.stringify({ tasks, todo, status });
}

function okPlan(content: string) {
  const parsed = parseTaskPlan(content);
  if (!parsed.ok) {
    throw new Error(`expected an accepted plan, got ${parsed.diagnostics}`);
  }
  return parsed.plan;
}

function rejectPlan(content: string) {
  const parsed = parseTaskPlan(content);
  if (parsed.ok) {
    throw new Error("expected the plan to be rejected");
  }
  return parsed;
}

describe("parseTaskPlan", () => {
  test("accepts the minimal plan shape and normalizes status", () => {
    const plan = okPlan(planJson([task({ id: 1 })], [1], { "1": "todo" }));
    expect(plan.tasks.length).toBe(1);
    expect(plan.todo).toEqual([1]);
    expect(plan.status.get(1)).toBe("todo");
  });

  test("tolerates a whole-text fence and surrounding prose", () => {
    const body = planJson([task({ id: 1 })], [1], { "1": "todo" });
    expect(okPlan(`Here is the plan:\n\n\`\`\`json\n${body}\n\`\`\`\n`).tasks.length).toBe(1);
  });

  test("rejects a non-object, missing tasks, and extra top-level keys", () => {
    expect(rejectPlan("[]").diagnostics).toContain("not an object");
    expect(rejectPlan(`{"tasks": [], "todo": [], "status": {}}`).diagnostics).toContain(
      "non-empty array",
    );
    expect(rejectPlan(`{"tasks": [], "todo": [], "status": {}, "plan": 1}`).diagnostics).toContain(
      "unexpected key",
    );
  });

  test("names an unexpected task key and an invalid action", () => {
    const withExtra = { ...task({ id: 1 }), note: "x" } as unknown as EditTask;
    expect(rejectPlan(planJson([withExtra], [1], { "1": "todo" })).diagnostics).toContain(
      'unexpected key(s) "note"',
    );
    const badAction = { ...task({ id: 1 }), action: "rewrite" } as unknown as EditTask;
    expect(rejectPlan(planJson([badAction], [1], { "1": "todo" })).diagnostics).toContain(
      "must be one of",
    );
  });

  test("loc.kind is a symbol space, not a declaration keyword", () => {
    const bad = {
      ...task({ id: 1 }),
      loc: { path: "src/a.ts", symbol: "answer", kind: "function" },
    } as unknown as EditTask;
    expect(rejectPlan(planJson([bad], [1], { "1": "todo" })).diagnostics).toContain("symbol space");
  });

  test("rejects duplicate ids, unknown deps, self deps, and cycles", () => {
    expect(
      rejectPlan(planJson([task({ id: 1 }), task({ id: 1 })], [1], { "1": "todo" })).diagnostics,
    ).toContain("declared more than once");
    expect(
      rejectPlan(planJson([task({ id: 1, deps: [9] })], [1], { "1": "todo" })).diagnostics,
    ).toContain("depends on #9");
    expect(
      rejectPlan(planJson([task({ id: 1, deps: [1] })], [1], { "1": "todo" })).diagnostics,
    ).toContain("itself");
    const cycle = rejectPlan(
      planJson([task({ id: 1, deps: [2] }), task({ id: 2, deps: [1] })], [1], {
        "1": "todo",
        "2": "todo",
      }),
    );
    expect(cycle.diagnostics).toContain("dependency cycle");
  });

  test("rejects a parent cycle", () => {
    const parsed = rejectPlan(
      planJson([task({ id: 1, parent: 2 }), task({ id: 2, parent: 1 })], [1, 2], {
        "1": "todo",
        "2": "todo",
      }),
    );
    expect(parsed.diagnostics).toContain("parent cycle");
  });

  test("todo must equal the ready frontier", () => {
    const chain = [
      task({ id: 1 }),
      task({ id: 2, deps: [1], loc: { path: "src/a.ts", symbol: "caller", kind: "value" } }),
    ];
    // A dependent task cannot be in the initial todo.
    expect(rejectPlan(planJson(chain, [1, 2], { "1": "todo", "2": "todo" })).diagnostics).toContain(
      "before its dependencies are done",
    );
    // Omitting a ready task is equally wrong.
    expect(rejectPlan(planJson(chain, [], { "1": "todo", "2": "todo" })).diagnostics).toContain(
      "exactly the ready frontier",
    );
    expect(okPlan(planJson(chain, [1], { "1": "todo", "2": "todo" })).todo).toEqual([1]);
  });

  test("status must cover exactly the task ids and never start done or in-progress", () => {
    expect(rejectPlan(planJson([task({ id: 1 })], [1], { "2": "todo" })).diagnostics).toContain(
      "status omits #1",
    );
    expect(
      rejectPlan(planJson([task({ id: 1 })], [1], { "1": "in-progress" })).diagnostics,
    ).toContain("in-progress");
    expect(rejectPlan(planJson([task({ id: 1 })], [1], { "1": "done" })).diagnostics).toContain(
      "first plan",
    );
  });

  test("rename needs renameTo and nothing else may carry it", () => {
    const rename = task({ id: 1, action: "rename" });
    expect(rejectPlan(planJson([rename], [1], { "1": "todo" })).diagnostics).toContain("renameTo");
    const same = task({ id: 1, action: "rename", renameTo: "answer" });
    expect(rejectPlan(planJson([same], [1], { "1": "todo" })).diagnostics).toContain("to itself");
    const stray = task({ id: 1, renameTo: "other" });
    expect(rejectPlan(planJson([stray], [1], { "1": "todo" })).diagnostics).toContain(
      'action is "modify"',
    );
  });

  test("rejects unsafe target paths", () => {
    for (const path of [
      "/etc/passwd.ts",
      "../a.ts",
      "human/spec.ts",
      "node_modules/x.ts",
      "a//b.ts",
    ]) {
      const bad = task({ id: 1, loc: { path, symbol: "x", kind: "value" } });
      expect(rejectPlan(planJson([bad], [1], { "1": "todo" })).diagnostics).toContain(
        "writable repo-relative path",
      );
    }
  });

  test("caps the instruction length and the task count", () => {
    const long = task({ id: 1, instruction: "x".repeat(4_001) });
    expect(rejectPlan(planJson([long], [1], { "1": "todo" })).diagnostics).toContain(
      "at most 4000",
    );
    const many = Array.from({ length: MAX_TASKS + 1 }, (_, index) => task({ id: index + 1 }));
    expect(
      rejectPlan(
        planJson(
          many,
          many.map((t) => t.id),
          Object.fromEntries(many.map((t) => [String(t.id), "todo"])),
        ),
      ).diagnostics,
    ).toContain(`at most ${MAX_TASKS}`);
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
  const state = initialState(
    okPlan(
      planJson([task({ id: 1 }), task({ id: 2, deps: [1] }), task({ id: 3 })], [1, 3], {
        "1": "todo",
        "2": "todo",
        "3": "todo",
      }),
    ),
  );

  test("the ready frontier follows deps and task order", () => {
    expect(readyFrontier(state)).toEqual([1, 3]);
    state.status.set(1, "done");
    expect(readyFrontier(state)).toEqual([2, 3]);
    state.status.set(2, "done");
    state.status.set(3, "done");
    expect(readyFrontier(state)).toEqual([]);
    expect(allTasksDone(state)).toBe(true);
    expect(maxTaskId(state)).toBe(3);
  });

  test("renderTaskDag is stable and status renders separately", () => {
    const dag = renderTaskDag(state.tasks);
    expect(dag).toContain('#1 modify value "answer" in "src/a.ts" (deps: none)');
    expect(dag).toContain("(deps: 1)");
    state.status.set(1, "done");
    expect(renderTaskDag(state.tasks)).toBe(dag);
    expect(renderTaskStatus(state)).toContain("#1 done");
  });
});

describe("readPlan", () => {
  test("accepts a re-plan echo with done and failed statuses", () => {
    const parsed = readPlan(
      planJson([task({ id: 1 }), task({ id: 2, deps: [1] }), task({ id: 3, deps: [1] })], [2], {
        "1": "done",
        "2": "todo",
        "3": "failed",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.plan.status.get(1)).toBe("done");
      expect(parsed.plan.status.get(3)).toBe("failed");
    }
  });

  test("rejects a done task whose dependencies are not done", () => {
    const parsed = readPlan(
      planJson([task({ id: 1 }), task({ id: 2, deps: [1] })], [1], {
        "1": "failed",
        "2": "done",
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.diagnostics).toContain("dependencies #1 are not");
    }
  });
});

describe("mergeReplan", () => {
  function baseState(): TaskRunState {
    return initialState(
      okPlan(
        planJson([task({ id: 1 }), task({ id: 2, deps: [1] })], [1], { "1": "todo", "2": "todo" }),
      ),
    );
  }

  function replan(content: string) {
    const parsed = readPlan(content);
    if (!parsed.ok) {
      throw new Error(`expected an accepted re-plan, got ${parsed.diagnostics}`);
    }
    return parsed.plan;
  }

  test("keeps done tasks and adds a new task with a fresh id", () => {
    const state = baseState();
    state.status.set(1, "done");
    const merged = mergeReplan(
      state,
      replan(
        planJson(
          [
            task({ id: 1 }),
            task({ id: 2, deps: [1] }),
            task({ id: 3, deps: [2], loc: { path: "src/b.ts", symbol: "next", kind: "value" } }),
          ],
          [2],
          { "1": "done", "2": "todo", "3": "todo" },
        ),
      ),
    );
    if (!merged.ok) {
      throw new Error(merged.diagnostics);
    }
    expect(merged.state.status.get(1)).toBe("done");
    expect(merged.state.tasks.length).toBe(3);
    expect(readyFrontier(merged.state)).toEqual([2]);
  });

  test("rejects changing or removing a done task", () => {
    const state = baseState();
    state.status.set(1, "done");
    const changed = mergeReplan(
      state,
      replan(
        planJson(
          [task({ id: 1, instruction: "Rewrite it differently." }), task({ id: 2, deps: [1] })],
          [2],
          { "1": "done", "2": "todo" },
        ),
      ),
    );
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.diagnostics).toContain("is done and its definition cannot change");
    }
    const removed = mergeReplan(state, replan(planJson([task({ id: 2 })], [2], { "2": "todo" })));
    expect(removed.ok).toBe(false);
    if (!removed.ok) {
      expect(removed.diagnostics).toContain("done task #1 cannot be removed");
    }
  });

  test("a failed task retries only with a changed definition and status todo", () => {
    const state = baseState();
    state.status.set(1, "failed");
    const same = mergeReplan(
      state,
      replan(
        planJson([task({ id: 1 }), task({ id: 2, deps: [1] })], [1], {
          "1": "todo",
          "2": "todo",
        }),
      ),
    );
    expect(same.ok).toBe(false);
    if (!same.ok) {
      expect(same.diagnostics).toContain("requires a changed definition");
    }
    const kept = mergeReplan(
      state,
      replan(
        planJson([task({ id: 1 }), task({ id: 2, deps: [1] })], [], {
          "1": "failed",
          "2": "todo",
        }),
      ),
    );
    expect(kept.ok).toBe(true);
    if (kept.ok) {
      expect(kept.state.status.get(1)).toBe("failed");
      expect(readyFrontier(kept.state)).toEqual([]);
    }
    const amended = mergeReplan(
      state,
      replan(
        planJson(
          [
            task({ id: 1, instruction: "Change only the return value." }),
            task({ id: 2, deps: [1] }),
          ],
          [1],
          { "1": "todo", "2": "todo" },
        ),
      ),
    );
    expect(amended.ok).toBe(true);
    if (amended.ok) {
      expect(amended.state.status.get(1)).toBe("todo");
    }
  });

  test("drops a failed task when the planner omits it", () => {
    const state = baseState();
    state.status.set(1, "failed");
    const merged = mergeReplan(state, replan(planJson([task({ id: 2 })], [2], { "2": "todo" })));
    if (!merged.ok) {
      throw new Error(merged.diagnostics);
    }
    expect(merged.state.tasks.map((task) => task.id)).toEqual([2]);
    expect(readyFrontier(merged.state)).toEqual([2]);
  });

  test("rejects a todo list naming a blocked task", () => {
    const state = baseState();
    const merged = mergeReplan(
      state,
      replan(
        planJson([task({ id: 1 }), task({ id: 2, deps: [1] })], [1, 2], {
          "1": "todo",
          "2": "todo",
        }),
      ),
    );
    expect(merged.ok).toBe(false);
    if (!merged.ok) {
      expect(merged.diagnostics).toContain("before its dependencies are done");
    }
  });

  test("a new task that becomes ready is added to todo even if the planner omitted it", () => {
    const state = baseState();
    state.status.set(1, "done");
    const merged = mergeReplan(
      state,
      replan(
        planJson(
          [task({ id: 1 }), task({ id: 2, deps: [1] }), task({ id: 3, deps: [2] })],
          [2, 3],
          { "1": "done", "2": "todo", "3": "todo" },
        ),
      ),
    );
    expect(merged.ok).toBe(false);
    if (!merged.ok) {
      expect(merged.diagnostics).toContain("#3");
    }
  });

  test("an in-progress echo is a protocol error", () => {
    const state = baseState();
    state.status.set(1, "in-progress");
    const merged = mergeReplan(
      state,
      replan(
        planJson([task({ id: 1 }), task({ id: 2, deps: [1] })], [], {
          "1": "todo",
          "2": "todo",
        }),
      ),
    );
    expect(merged.ok).toBe(false);
    if (!merged.ok) {
      expect(merged.diagnostics).toContain("in progress");
    }
    expect(
      readPlan(
        planJson([task({ id: 1 }), task({ id: 2, deps: [1] })], [1], {
          "1": "in-progress",
          "2": "todo",
        }),
      ).ok,
    ).toBe(false);
  });
});
