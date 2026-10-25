---
id: 32
title: "Add post-execution planner review with gate result and concise diff"
status: done
priority: medium
milestone: null
parent: 26
deps: [31]
labels: [agent-loop, edit-protocol]
created: 2026-10-25
---

## Context

The user chose review after the Task executes: only after the edits and gate exist can the planner review code that passes tsc. Review sees the gate result plus a concise applied diff, not full files, and uses a separate `review` token bucket.

## Goal

Add the post-execution planner review, `TaskStatus review`, one current-Task review patch, and planning/review/execution usage buckets.

## Acceptance criteria

- [ ] `TaskStatus` is `pending | review | passed | failed`; a Task in `review` is not runnable and not terminal, and stage closure waits for it.
- [ ] After a Task's edits and gate, a review turn receives the gate result and a concise applied diff; it does not receive full files or the whole requirement.
- [ ] Review returns `approve` or one patch; the patch may only repair the current Task, may carry `finish`, and must not add a future Stage/Task.
- [ ] A review patch is structurally validated, reopens the current Task, and executes it again; there is no second review for that Task.
- [ ] `approve` finalizes the Task as `passed` or `failed` from the gate; the planner then plans the next unit or finishes.
- [ ] Review calls are recorded in the `review` usage bucket and count toward the run budget; planning and execution remain separate buckets.
- [ ] Tests cover pass/fail review, patch + re-execute, finish, review status, no-future-work rejection, and token buckets.
- [ ] `just typecheck && just test` passes.
- [ ] No benchmark or live model run is required.

## Verification

- `bun test src/task-loop.test.ts src/prompts/task.test.ts src/tasks.test.ts`
- `just typecheck && just test`
- Inspect a scripted run's usage buckets and records for planning/review/execution separation.

## Notes

- Depends on #31.
- Review uses the same planner conversation, not a fresh reviewer.
- Keep the review prompt short; do not repeat the full source or full Plan grammar.
- Resolved: TaskStatus includes review (non-runnable/non-terminal); gate then one review turn in the planner conversation with gate verdict + concise LCS diff; approve finalizes from gate, review patch is restricted to current-task task~/edit ops plus finish, reopens/re-executes once with no second review; LoopResult.usage records planning/review/execution buckets and total stays the run budget. Verification: just typecheck && just test -> 1400 pass, 0 fail (311.87s); just accept -> 8 passed after adding the scenario review approve.
