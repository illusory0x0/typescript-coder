---
id: 49
title: "Model plan-exec as a task-level DAG with dependency edges"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop]
created: 2026-10-26
---

## Context

The plan-exec model is a fixed `Plan -> Stage[] -> Task[] -> Edit[]` tree. Record order is execution order, there are no dependency edges, and the planner adds only one new Task per planning turn. A Stage closes before the next Stage can be appended. This makes cross-branch dependencies awkward, forces unrelated work into one linear chain, and hides real prerequisites behind ordering rules.

The agreed direction is a task-level DAG: nodes are independently verifiable work units; edits remain children; each node carries explicit dependencies and optional workflow hints. This issue covers the model/spec and implementation, not the whole-file edit strategy, which is tracked separately.

## Goal

Replace the mandatory Stage -> Task hierarchy with a task-level DAG of verifiable work nodes that supports explicit dependencies, optional workflow hints, and a linear-plan compatibility path without changing gate, review, or finish semantics.

## Acceptance criteria

- [ ] `docs/plan-exec.md` defines the node schema: `id`, `dependsOn`, `verify`, `instruction`, `edits`, and optional `phase`/workflow hint; it states that edits remain children of a node and are not independent graph nodes.
- [ ] Validation rejects duplicate/dangling/self/cyclic dependencies, unknown nodes, and dependencies on failed nodes at scheduling time; diagnostics name the offending ids.
- [ ] The parser/serializer accepts a DAG plan and the existing linear Stage/Task plan as a compatible subset; legacy replay bundles and current tests do not require rewriting.
- [ ] The scheduler executes ready nodes in deterministic order (record order as the tie-break), blocks dependents of a failed/skipped node, and reports blocked nodes without hanging.
- [ ] The planner may add one or more ready nodes per planning turn, with a documented cap; incremental planning and the 96-node limit still bound the plan. The prompt recommends a workflow (inspect -> contract -> scaffold -> implement -> verify) but explicitly allows a single node, a linear chain, or a branching DAG.
- [ ] Gate, review, in-place repair, final-task, and `finish` semantics are defined per node; a review patch may repair the current node and adjust its dependents without violating the DAG.
- [ ] Tests cover parsing and validation (valid DAG, cycles, dangling/self deps), scheduler ready/blocked order, linear compatibility, finish, review repair, and the workflow guidance in prompts.
- [ ] `docs/plan-exec.md` and CLI help describe the new model; `just typecheck && just test` and `just accept` pass.
- [ ] No frozen baseline or historical benchmark report is modified.

## Verification

```sh
bun test src/tasks.test.ts
bun test src/plan-dsl.test.ts
bun test src/task-loop.test.ts
bun test src/prompts/task.test.ts
just typecheck && just test
just accept
git diff --check
```

No live benchmark is required for acceptance; any measured comparison needs explicit human approval.

## Notes

- Confirmed shape: task-level DAG, not edit-level; edits stay inside a node. Parallel provider calls are out of scope unless a later spec explicitly adds them.
- Keep the whole-file rewrite strategy separate so prompt effects and DAG effects can be measured independently.
- The existing Stage/Task DSL should remain a valid linear subset during migration; do not force replay bundles or historical plans to change.
- This is an architectural change: write the spec first, then parser/validator/scheduler, then prompts and review semantics.
