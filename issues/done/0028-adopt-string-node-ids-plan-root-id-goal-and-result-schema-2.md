---
id: 28
title: "Adopt string node IDs, Plan root id/goal, and result schema @2"
status: done
priority: medium
milestone: null
parent: 26
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-25
---

## Context

The V2 flat DSL identifies every node by a stable string (`"01-main"`, `"02-stage-parser"`, `"03-task-reader"`). The current contract uses numeric task/edit ids and has no Plan root identity. This is a foundation change for the flat DSL, patches, status maps, and the public result schema.

## Goal

Adopt globally unique string node ids, a Plan root with `id` and `goal`, and `typescript-coder-result@2`, with all status maps, summaries, records, tests, and docs using the string ids.

## Acceptance criteria

- [ ] `Plan` has `id: NodeId` and `goal: string`; `Stage`, `Task`, and `Edit` use string `NodeId`.
- [ ] `NodeId` format is `"NN-slug"` and ids are globally unique across Plan/Stage/Task/Edit.
- [ ] `TaskRunState`, scheduling maps, summaries, loop records, and `LoopResult.tasks` use string ids; no production path assumes numbers.
- [ ] `LoopResult.tasks[].id`, `.stage`, and `.task` are strings and the JSON contract is documented as `typescript-coder-result@2`.
- [ ] Existing tests, fixtures, and result-contract tests are migrated; no numeric-id compatibility shim is added.
- [ ] `just typecheck && just test` passes.
- [ ] No benchmark or live model run is required.

## Verification

- `bun test src/tasks.test.ts src/result.test.ts src/task-loop.test.ts`
- `just typecheck && just test`
- Inspect a `--format json` result and confirm the node-id fields are strings and the schema version is `@2`.

## Notes

- This is a breaking result-schema change; document it rather than keeping mixed numeric/string ids.
- Do not implement the flat DSL parser here; this issue only changes the model/types and result contract.
- TaskStatus `review` is introduced by #32, not here.
- Resolved: Plan root id/goal and globally unique NN-slug string ids across Plan/Stage/Task/Edit; TaskRunState/summaries/result use strings; typescript-coder-result@2 exposes optional plan/execute tasks; CLI/glossary/acceptance migrated. Verification: just typecheck && just test -> 1329 pass, 0 fail (282.53s); just accept --only plan-exec-fix-answer -> 1 passed.
