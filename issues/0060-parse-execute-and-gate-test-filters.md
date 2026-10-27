---
id: 60
title: "Parse, execute, and gate test filters"
status: todo
priority: medium
milestone: null
parent: 59
deps: [58]
labels: [agent-loop, edit-protocol]
created: 2026-10-27
---

## Context

Slice gates need a wire form, a gate implementation, and a completion rule that cannot be fooled by a filtered green test. Adding only the parser or only the gate would produce a false-green run, so this issue covers the full atomic change.

The model is `src/tasks.ts`; the wire grammar is `src/plan-dsl.ts`; the gate and driver are `src/task-loop.ts`; prompt text is owned by the planner issue.

## Goal

A WorkNode can carry an optional test-name filter; the node gate runs the filtered subset; `runComplete` still requires an unfiltered full-suite test.

## Acceptance criteria

- [ ] `WorkNode.testFilter?: string` (or an equivalent typed field) is validated: non-empty, valid regex, only with `verify test`.
- [ ] The Plan DSL accepts one body field `test-filter: <regex>`; duplicate, empty, invalid-regex, and `tsc`+filter combinations produce `PLAN_*` diagnostics; the serializer round-trips the field.
- [ ] A `verify test` node with a filter runs the check command and `testCommand + ["-t", filter]`; a filter that matches zero tests fails the gate (Bun exits 1).
- [ ] `GateSnapshot` carries `fullSuite` (or equivalent); `runComplete` requires `verify === "test"`, `ok`, and `fullSuite`.
- [ ] `blockedReason` tells the planner to append an unfiltered test node when the last gate was a filtered test.
- [ ] Tests cover parse/serialize, filtered pass/fail, zero-match failure, filtered-green-not-complete, and a final full-suite pass.
- [ ] The custom `testCommand` contract is documented in code comments or docs: the filter is appended as `-t <regex>` and requires a runner that accepts it.

## Verification

```
bun test src/plan-dsl.test.ts src/tasks.test.ts src/task-loop.test.ts
just typecheck && just test
```

## Notes

- Depends on the terminator-recovery issue: the plan DSL and planner prompt are already being edited there.
- `tsc` gates ignore the filter; the field is rejected on them.
- Filtered nodes are checkpoints; the final node must be unfiltered.
- No result-schema bump unless the node summary must expose the filter; prefer keeping `NodeSummary` unchanged.
- File-level selectors are out of scope: the benchmark fixtures are single-file tests, so `-t <regex>` is the useful selector.
