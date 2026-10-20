---
id: 81
title: "Explicit-targets multi-file mode (--targets)"
status: todo
priority: medium
milestone: null
parent: 79
deps: [80]
labels: [harness, agent-loop, integration]
created: 2026-10-20
---

## Context

#69 added an opt-in path-independent `{"payloads":[…]}` batch, but it is
default-off and the model never emitted a batch live; #78 (filed) covers
same-file multi-region edits. For a sub-agent, `opencode` should pass exactly
which declarations `tc` must edit instead of having `tc` discover them.

## Goal

A modify call accepts an explicit list of `{path,symbol,kind}` targets and
applies edits across those files via the #69 path-independent shape, sequencing
same-file targets across exchanges and reporting any target it could not apply.

## Acceptance criteria

- [ ] `--targets <file.json>` (or a documented equivalent) seeds the run with
      the given addresses, and the edit exchange emits a `{"payloads":[…]}` batch
      covering them.
- [ ] at most one target per file per exchange; multiple targets in one file are
      sequenced across exchanges within the same call.
- [ ] each target resolves strictly (#48): a miss or ambiguity is a staged
      diagnostic, never a silent pick; unapplied targets are reported.
- [ ] a target-naming retry lead is added to close the #69 compliance gap (the
      model must emit the batch).
- [ ] the default behavior (no `--targets`) is the unchanged single payload.
- [ ] unit tests cover: two-file batch success; same-file sequencing; a missed
      target reported; resolution failure rejected.

## Verification

```
bunx tsc --noEmit
bun test
# a scripted multi-file call showing the batch applied end to end
```

## Notes

- Depends on C1. Builds on #69; same-file multi-declaration is #78 (non-goal).
- Fallback for correctness: sequence one declaration per exchange.
