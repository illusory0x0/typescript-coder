---
id: 61
title: "Teach the planner to plan test slices"
status: todo
priority: medium
milestone: null
parent: 59
deps: [60]
labels: [agent-loop, edit-protocol]
created: 2026-10-27
---

## Context

The planner currently has no reason or syntax to plan slices. Adding the field without prompt guidance would leave the planner on monoliths. The prompt examples should use a minilisp-like parser/evaluator/builtins shape and the visible test names from the planning spec files.

## Goal

The planner prompt teaches `test-filter`, its narrow use cases, and the mandatory final unfiltered test, with examples that keep small tasks single-node.

## Acceptance criteria

- [ ] `src/prompts/task.ts` documents the `test-filter:` field, its regex semantics, and that it is valid only on `verify test`.
- [ ] The prompt says to use slices only for greenfield modules with multiple independently testable behaviors and visible test names; small or cohesive single-file changes stay one node.
- [ ] The prompt requires a final `verify test` node with no filter and states that a filtered green gate does not complete the run.
- [ ] At least one example shows parser/evaluator/builtins slices plus the final full test.
- [ ] `src/prompts/task.test.ts` pins the new guidance and examples.
- [ ] The prompt does not mention or tune against `csv-parser`.

## Verification

```
bun test src/prompts/task.test.ts
just typecheck && just test
```

## Notes

- Depends on the slice-gate parser/gate/completion issue for the final grammar and semantics.
- This is prompt-only; no driver behavior changes here.
- The final full-suite node is the completion boundary, so a filtered checkpoint cannot be the last node.
