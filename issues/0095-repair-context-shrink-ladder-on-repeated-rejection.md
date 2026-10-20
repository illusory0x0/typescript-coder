---
id: 95
title: "Repair-context shrink ladder on repeated rejection"
status: todo
priority: low
milestone: null
parent: 91
deps: []
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

#64 absorption candidate 3. opencode2 reduces an over-large request with a graded
ladder `SHRINK_STEPS = [0.7, 0.5, 0.35]`: after each "too long" rejection the next
attempt aims at that share of the first rejected size, dropping whole oldest
exchanges, and fails only at the floor
(`packages/core/src/session/compaction.ts:94-95`,
`.../compaction.ts:441-447`, `.../compaction.ts:463-510`). tc uses a single
hand-tuned continuation budget with no geometric step-down and no defined floor.

## Goal

A graded shrink ladder for repair/continuation context: a target-size function plus
deterministic oldest-first reduction toward the target, with a defined give-up
instead of one fixed budget.

## Acceptance criteria

- [ ] A target-size function and a step-down ladder (e.g. 0.7 / 0.5 / 0.35)
      reduce continuation context oldest-first, keeping the pinned selection and
      the newest exchange; the floor fails with a fixed message.
- [ ] Unit tests cover the ladder steps, the keep-newest rule, and the floor.
- [ ] No regression on the json/sexp happy paths; live tc-side matrix; rows in
      `benchmark/results/consumption.md`.
- [ ] Guards, caps, and the single-edit protocol unchanged.

## Verification

```
bun test
bunx tsc --noEmit
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-tc-shrink.json --replay-dir tmp/replays-<name>
bun benchmark/check.ts
```

## Notes

- Parent: the #64 absorption umbrella.
- Non-goals: unified diffs; weakening guards; changing the budget cap semantics.
