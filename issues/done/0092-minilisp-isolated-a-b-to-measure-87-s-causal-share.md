---
id: 92
title: "minilisp: isolated A/B to measure #87's causal share"
status: done
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
- Landed 2026-10-20. Added a runtime opt-out for #87's declaration suffix: `formatDiagnostics` (`src/loop.ts:3581`) reads `process.env.TC_DIAG_DECL_NAMING` once per call and `declarationSuffix` (`src/loop.ts:3610`) returns "" when it is `off`/`0`/`false`; absent/anything else keeps today's behavior, so both A/B arms run byte-identical source (provenance-identical). Two tests in `src/loop.test.ts:388` cover the unset and `off` renders. Verify: tsc clean, `bun test` 872 pass, `bun benchmark/check.ts` 4 passed/0 failed. A/B: `bun run benchmark/run.ts --task minilisp --side tc --reps 5` with the env on vs off → cache-excluded tokens per success 35,254 (5/5) vs 33,533 (4/5), within-arm spread ~5x, medians 32,470 vs 33,048. Verdict: **confounded** — no isolated #87 effect detectable at n=5 (the minilisp win is within variance); rows added to `consumption.md` (34 rows) and the finding recorded on #46. No behavior change beyond the toggle.
