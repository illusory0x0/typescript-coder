---
id: 92
title: "minilisp: isolated A/B to measure #87's causal share"
status: todo
priority: high
milestone: null
parent: 90
deps: []
labels: [benchmark, harness]
created: 2026-10-20
---

## Context

#87 (name the failing declaration in the `tsc` diagnostics) landed at `856f9c9`.
Two post-improvement tc-side matrices (`benchmark/results/2026-10-20-tc-diagdecl-{1,2}.json`)
are 12/12 with minilisp 3/3 at 16,269 / 25,497 tokens per success, below the #47
baseline 30,398. #46's close-out **disclosed that #87's causal share is unmeasured
(no isolated A/B)**: the improvement could be the fix or run variance.

## Goal

An isolated A/B on minilisp that measures #87's causal contribution to the
repair-cost drop, or an argued "confounded by variance" verdict with evidence.

## Acceptance criteria

- [ ] A controlled A/B on minilisp, #87 on vs off, same model/effort/session
      window and equal reps (e.g. toggle the declaration-naming render), reporting
      tokens per success for each arm.
- [ ] Verdict recorded: a stated causal share, or a written "confounded" result
      if the spread swamps the effect.
- [ ] Rows added to `benchmark/results/consumption.md`; #46's close-out note
      updated with the finding.
- [ ] No behavior change beyond the A/B toggle.

## Verification

```
bun test
bun run benchmark/run.ts --task minilisp --side tc --reps <n> --json benchmark/results/<date>-tc-diagdecl-ab-{on,off}.json --replay-dir tmp/replays-<name>
bun benchmark/check.ts
```

Inspect replays to confirm the arms differ only in the diagnostic rendering.

## Notes

- Parent: the measurement umbrella.
- #87 is a rendering-only change (no guard/cap/auto-stop), so an A/B toggle is
  self-contained.
- Non-goals: changing #87; new mechanisms.
