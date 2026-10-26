---
id: 49
title: "Replace plan-exec's Stage/Task/Edit tree with a hints-based work DAG"
status: in-progress
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop]
created: 2026-10-26
---

## Context

The current plan-exec loop is a fixed `Plan -> Stage[] -> Task[] -> Edit[]` tree. The planner chooses each edit's declaration, action, and granularity; the executor only carries out one preselected edit. The planner sees the symbol index and outline but not the current source, while the executor sees the source. That information asymmetry is visible in the mini-spreadsheet pilots: the planner repeatedly chose whole-file writes, and prompt rules could not make that choice reliably.

The agreed direction is a direct replacement, not a compatibility mode: the planner emits a task-level DAG of work nodes with target hints and optional approach hints; the executor chooses the concrete edit actions and granularity from the source; the harness owns scheduling, gates, and review. The planner may inspect the codebase with a bounded number of read-only viewer requests before planning, because choosing useful files, symbols, and dependency edges requires some code reading; it still never writes. The planner's programming experience moves into executor-facing hints, not constraints: for example, a small requirement may justify a whole-file write, while a large module should first scaffold top-level declarations and then fill bodies with finer edits. The planner prompt recommends a workflow but does not impose a fixed Stage/Task shape, so later prompt changes can reshape the workflow without changing the graph model.

This is intentionally a large change and may temporarily regress benchmark scores; that tradeoff is accepted.

## Goal

Replace the Stage/Task/Edit plan model with a task-level DAG of work nodes where the planner owns work decomposition, dependencies, verification boundaries, instructions, and file/symbol hints, and the executor owns the concrete edit actions.

## Acceptance criteria

- [ ] `docs/plan-exec.md` defines a `WorkNode` schema: `id`, `after` dependency ids, `verify: tsc|test`, `instruction`, `hints: Loc[]`, optional `approach` strategy hint, and optional `phase`/workflow hint. A `Loc` is `{path, symbol, kind}` with `kind: value|type|namespace|file`; a file hint uses `symbol: ""`.
- [ ] `approach` is advisory: it can suggest a whole-file write for a small requirement or a scaffold-then-fill sequence for a large module, but the executor may override it from the current source; validation and review do not require adherence.
- [ ] The flat Plan DSL and patch DSL emit and parse graph records (`node`, `node+`, `node~`, `node-`, `after`, `hint`, `finish`); no Stage/Task/Edit records remain in the parser, serializer, prompts, or docs.
- [ ] Validation rejects duplicate ids, dangling/self/cyclic `after` edges, unknown `verify`, unsafe hint paths, a missing final `test` node, and a `finish` on a non-final node; diagnostics name the offending ids.
- [ ] The scheduler runs ready nodes in deterministic order (record order as the tie-break), blocks dependents of failed or skipped nodes, reports blocked nodes, and never hangs on a cycle (cycles are rejected earlier).
- [ ] The planner may add one or more ready nodes per planning turn; there is no low arbitrary node-count or planning-round cap. Growth is bounded by the run token budget, duplicate/no-progress detection, and the DSL/safety validation. The prompt recommends a workflow (inspect -> contract -> scaffold -> implement -> verify) but a single node, a linear chain, and a branching DAG are all valid.
- [ ] The executor receives the current node's instruction, target hints, and optional approach hint plus the source; it may choose `modify`/`create`/`delete`/`rename`/`write`, `match`/`pick`/range/whole-declaration, and multiple clauses per reply. Hints guide the executor; edits outside the hinted paths are allowed only when the instruction requires them and are surfaced in review. The executor may override the approach hint.
- [ ] The planner retains read-only inspection without an arbitrary request count: each viewer consumes the run token budget, a repeated identical view or a no-progress cycle forces the Plan/patch reply, and the viewer never writes.
- [ ] A node gate runs after each applied executor reply; a passing gate finishes the node, a failing gate returns diagnostics for another attempt, and a repeated fingerprint/no-progress cycle or the token budget ends the node. There is no low arbitrary exchange cap. Review then sees the applied diff and may approve or patch the node, its hints, or its dependencies.
- [ ] `finish` marks the final `test` node; run success requires that node to pass and every non-repaired node to be terminal.
- [ ] Existing Stage/Task/Edit tests, prompts, docs, and fixtures are migrated to the new schema; legacy plan text fails with a clear diagnostic (no dual mode). Replay fixtures that carry old plan text are updated or explicitly rejected.
- [ ] The machine result contract is updated if the task summary shape changes (bump `typescript-coder-result` and update consumers/tests) rather than silently changing `@2`.
- [ ] `just typecheck && just test` and `just accept` pass; no frozen baseline or historical result JSON is modified.

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

A live benchmark is not required for acceptance; any measured comparison needs explicit human approval.

## Notes

- Direct replacement is confirmed: do not keep a live legacy Stage/Task/Edit mode. Old replay/plan text may be rejected with a clear error.
- Hints are guidance, not a hard allowlist; out-of-hint edits are allowed when required and must be visible in the review diff.
- Arbitrary viewer/exchange/round/node-count caps are policy, not safety. Use the token budget, repeated/no-progress fingerprints, and DSL/safety validation instead. Pinned-repair's low caps are a separate follow-up audit, not part of #49.
- Planner inspection exists to choose files/symbols/dependencies, not to pre-select concrete edits. The executor still owns the action.
- `approach` carries the planner's programming experience as advice, not a contract. Canonical examples: a small requirement on a small file may be one whole-file write; a large module should scaffold top-level declarations first and then fill bodies with targeted edits; a complex refactor may introduce a parallel `xxV1` implementation, copy behavior, test it, swap call sites, then clean up.
- The executor prompt should grow a small editing-techniques knowledge base over time. Techniques are advisory, composable, and never gates; later additions can be separate issues.
- Keep the whole-file strategy itself in #48; this issue provides the node/hints/executor-autonomy foundation. #48 depends on this issue.
- This is an architectural change: write the new spec and schema first, then parser/validator/scheduler, then executor/review and prompt text.
- Benchmark scores may regress during the migration; do not tune against the held-out `csv-parser` fixture.
- Starting the hints-based DAG replacement: planner emits WorkNodes with deps/verify/instruction/hints/approach; executor chooses concrete actions; direct schema replacement, no legacy mode.
