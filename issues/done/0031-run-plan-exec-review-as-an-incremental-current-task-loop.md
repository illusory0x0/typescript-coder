---
id: 31
title: "Run plan-exec-review as an incremental current-Task loop"
status: done
priority: medium
milestone: null
parent: 26
deps: [29, 30]
labels: [agent-loop, edit-protocol]
created: 2026-10-25
---

## Context

The agreed flow is `Plan -> Stage -> Task`: only the current Task is planned; executor consumes exactly one Task and its Edit sequence; after the Task gate, the planner plans the next Task, or the next Stage only after the current Stage has no pending work. This removes future-task pre-planning and full-tree re-emission.

## Goal

Run `plan-exec-review` as an incremental current-Task loop with one-unit planning, a 32-planning-turn cap, implicit stage closure, and `finish`/`finalTaskId`, before adding the post-execution review hook.

## Acceptance criteria

- [ ] Initial Plan contains exactly one current Stage and one current Task (with its edits); no future task list.
- [ ] Each planning turn adds at most one new Task; a new Stage includes its first Task in the same turn.
- [ ] The executor consumes one Task; after its gate, the loop requests the next patch (next Task, next Stage, repair, or final test + `finish`).
- [ ] A new Stage is allowed only when the current Stage has no pending Task; a failed Task may be repaired in the current Stage.
- [ ] 32 planning turns per run; planning attempts per turn remain bounded; no full-tree re-emission.
- [ ] `finish`/`finalTaskId`, final test, in-place repair, and new-final repair work through the incremental loop.
- [ ] Tests cover initial one-Task planning, next-Task/next-Stage patches, stage closure, one-unit enforcement, turn cap, finish, and final-test repair.
- [ ] `just typecheck && just test` passes.
- [ ] No benchmark or live model run is required.

## Verification

- `bun test src/plan-dsl.test.ts src/task-loop.test.ts src/tasks.test.ts`
- `just typecheck && just test`
- Run a scripted `runTaskLoop` that plans task A, executes it, patches task B, then patches the final test + `finish`.

## Notes

- Depends on #29 and #30.
- This issue may run the review step as an `approve` stub; #32 adds the real post-execution review and `TaskStatus review`.
- Stage closure becomes `pending` + `review` after #32.
- Resolved: initial Plan is driver-validated to one current Stage/Task; later turns use exactly one patch with one-unit enforcement (one new Task, new Stage includes its first Task); 32-turn cap; no full-tree re-emission; runComplete now requires finalTaskId on the last passed test task; finish/in-place/new-final repair tested. Final-test validation relaxed to finish-specific. Verification: just typecheck && just test -> 1388 pass, 0 fail (295.43s); just accept -> 8 passed.
