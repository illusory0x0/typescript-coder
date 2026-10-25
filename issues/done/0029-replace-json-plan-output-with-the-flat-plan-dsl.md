---
id: 29
title: "Replace JSON plan output with the flat Plan DSL"
status: done
priority: medium
milestone: null
parent: 26
deps: [28]
labels: [agent-loop, edit-protocol]
created: 2026-10-25
---

## Context

The planner currently emits a full JSON tree. It is verbose, expensive to re-emit, and hard to repair. The target is a flat block DSL with explicit parent refs and fenced text, specified in `docs/spec.md` §3. This issue implements the happy-path Plan DSL; tolerant recovery and shared diagnostics are #33.

## Goal

Replace the JSON plan output with the flat Plan DSL parser/serializer, keep the tree semantics, and migrate the planner prompt and unit tests to the new wire format.

## Acceptance criteria

- [ ] New parser/serializer covers the `docs/spec.md` §3 BNF: `plan` header with id/goal, `stage`/`task`/`edit` records, quoted `NN-slug` ids, parent refs, fenced text, and explicit `end`.
- [ ] Validation covers parent existence/order, sibling order, caps, final `test` task, and the Plan root.
- [ ] The planner prompt uses the flat DSL grammar and examples; no JSON plan object, no JSON fences, no prose.
- [ ] The JSON plan parser/examples are removed; the parser boundary is the new Plan DSL only.
- [ ] Initial Plan output contains exactly one current Stage and one current Task; later units are added by patches (#30).
- [ ] Unit tests cover parse, serialize, round-trip, fences, parent refs, ordering, ids, caps, and rejection cases.
- [ ] `just typecheck && just test` passes.
- [ ] No benchmark or live model run is required.

## Verification

- `bun test src/plan-dsl.test.ts src/tasks.test.ts src/prompts/task.test.ts`
- `just typecheck && just test`
- Parse and re-serialize the examples in `docs/spec.md` §3.

## Notes

- Depends on #27 for string ids and the Plan root.
- Do not add tolerant recovery here; that is #33.
- No JSON runtime fallback; old plan-exec replay bundles with JSON plan replies become incompatible (document in #35).
- Dependency correction: string ids are #28, so this issue depends on #28; the body's earlier #27 reference is a typo.
- Resolved: strict flat Plan DSL parser/serializer in src/plan-dsl.ts; JSON plan parser and examples removed; prompts, execution prefix, task-loop fixtures, and acceptance migrated; initial prompt asks one current Stage/Task; finish parsed but finalTaskId deferred to #30; TaskRunState carries the Plan root. Verification: just typecheck && just test -> 1348 pass, 0 fail (282.50s); just accept -> 8 passed.
