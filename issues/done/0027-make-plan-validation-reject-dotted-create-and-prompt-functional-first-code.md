---
id: 27
title: "Make plan validation reject dotted create and prompt functional-first code"
status: done
priority: medium
milestone: null
parent: 26
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-25
---

## Context

The plan-exec diagnosis showed planner-chosen class designs hitting an unrepresentable edit: `create Parser.parseValue` is accepted by plan validation but the executor can only create top-level declarations, producing malformed source such as `let Parser.parseValue = ...` and a gate rejection. The agreed direction is functional-first: hard-ban new classes, prefer top-level functions and ML-style data, and reject dotted create at plan validation.

## Goal

Make plan validation reject dotted `create` and teach planner/executor prompts to write functional TypeScript with top-level helpers, while existing classes remain minimally modifiable.

## Acceptance criteria

- [ ] Plan validation rejects `create` with a dotted symbol before execution, with a stable code/hint explaining that `create` is top-level only and class members require modifying the class (or a top-level function).
- [ ] `modify`, `delete`, and `rename` of an already-resolved dotted member remain allowed.
- [ ] The planner prompt contains the functional-style block from `docs/spec.md` §1.2: data + functions, tagged unions, tuples, plain records, explicit parameter/return types, small helpers; no new class/inheritance/`this`/private state/getters; helper decomposition is the model's choice; no forced stage/task split.
- [ ] The executor prompt carries the same functional constraints without changing edit-action grammar.
- [ ] Existing class rule is documented and tested: prefer a top-level helper; if the class must grow, use one whole-class `modify` with stubs, then `modify` the existing members; never dotted `create`.
- [ ] Tests cover the dotted-create rejection, the functional prompt text, and an existing-class member `modify`.
- [ ] `just typecheck && just test` passes.
- [ ] No benchmark or live model run is required.

## Verification

- `bun test src/tasks.test.ts src/prompts/task.test.ts`
- `just typecheck && just test`
- Inspect the planner/executor system prompts for the exact style block and no new-class allowance.

## Notes

- This is Phase 1 and can land before the flat Plan DSL; use the shared validator so the rule survives the DSL rewrite.
- Do not import Sophia's `snake_case`, `let`-only, arrow-only, formatting, or `abort` conventions.
- No benchmark-specific tuning.
- Resolved: dotted create is rejected by the shared plan validator with PLAN_CREATE_MEMBER; modify/delete/rename of resolved dotted members still parse; planner and executor prompts carry the functional-style block and existing-class rule. Verification: just typecheck && just test -> 1325 pass, 0 fail (300.22s).
