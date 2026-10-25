---
id: 30
title: "Add the Plan patch DSL and finish/finalTaskId merge"
status: done
priority: medium
milestone: null
parent: 26
deps: [28, 29]
labels: [agent-loop, edit-protocol]
created: 2026-10-25
---

## Context

Full-tree replanning caused 7/9 plan-exec failures: invalid final tasks, attempts to modify done edits, and identical-tree no-progress. The target is a patch DSL with add/update/remove operators, applied to a clone of the current tree and validated by `mergeReplan`. `finish` tracks the final `test` task.

## Goal

Add the Plan patch DSL and the `finish`/`finalTaskId` merge, including both final-test repair paths, without allowing partial destructive application.

## Acceptance criteria

- [ ] Parser/serializer covers the `docs/spec.md` §4 patch BNF: `plan~`, `stage+~-`, `task+~-`, `edit+~-`, fenced text, and `finish`.
- [ ] A patch is applied to a clone of the current tree and then validated by `mergeReplan`; immutability, append order, parent rules, caps, and final-test coverage are not relaxed.
- [ ] `+` appends, `~` replaces present fields, and `-` removes pending/failed work with cascade checks; done edits and passed tasks remain immutable.
- [ ] `finish` marks the last task as `finalTaskId`; in-place final repair keeps it, while appending repair work requires a new `finish` on the new last task.
- [ ] A patch is all-or-nothing: one malformed op rejects the whole patch.
- [ ] Tests cover add/update/remove, cascades, finish/finalTaskId migration, in-place vs new-final repair, and immutability.
- [ ] `just typecheck && just test` passes.
- [ ] No benchmark or live model run is required.

## Verification

- `bun test src/plan-dsl.test.ts src/tasks.test.ts src/task-loop.test.ts`
- `just typecheck && just test`
- Apply the patch examples in `docs/spec.md` §4 to a current tree and assert the merged tree.

## Notes

- Depends on #27 and #29.
- Tolerant parsing/diagnostics for patches is #33; this issue covers the strict/happy path.
- The driver's one-unit-per-turn rule is #31.
- Dependency correction: this issue depends on #28 and #29; #27 is the functional-first prompt issue, not the string-id issue.
- Resolved: strict patch DSL parser/serializer and applyPlanPatch; patches clone the plan, apply ops, then mergeReplan; finalTaskId/finish with in-place vs new-final checks; initial finish flows into TaskRunState. Verification: just typecheck && just test -> 1378 pass, 0 fail (298.40s); just accept -> 8 passed. Finding for #31: the current validator still requires the tree's last task to be test, so a next-task patch ending in a tsc task (spec 3.2) is rejected until the incremental/finish rule is implemented.
