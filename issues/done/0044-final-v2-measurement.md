---
id: 44
title: "Final v2 measurement: full ts-side benchmark run + consumption report"
status: done
priority: low
milestone: null
parent: 28
deps: [42, 43]
labels: [harness, benchmark]
created: 2026-10-18
---

## Context

#28's closing measurement, split out on 2026-10-18: the
`--all --side ts --reps 3` run is the longest-running work item in the tree, so
it is deliberately the lowest priority — it runs after the v2 redesign
(#42/#43) lands and measures the redesign as a whole.

## Goal

The v2 verdict: a committed full ts-side run with the baseline-vs-final
comparison against 2026-10-17, and the goal metrics documented.

## Acceptance criteria

- [ ] A full ts-side run is committed under `benchmark/results/` (JSON + MD):
      `bun run benchmark/run.ts --all --side ts --reps 3 --json benchmark/results/<date>-ts.json`.
- [ ] The report compares against the 2026-10-17 baseline: json 3/3 and
      ≤6,900 (5,877 plus the documented #34 spec-input allowance), sexp
      <43,293 (goal ≤11,812), minilisp ≥2/3 (goal 3/3) and <348,080, overall
      ≤16,824 when 9/9 (else a documented deviation). json must not regress
      (the 0.38× moat).
- [ ] `benchmark/results/consumption.md` holds the baseline row and the final
      row, each citing its source result file.
- [ ] Gates green at close: `bunx tsc --noEmit` 0, `bun test` all pass,
      `bun run accept` 5/5, `bun benchmark/check.ts` 3 PASS.

## Verification

```
bun run benchmark/run.ts --all --side ts --reps 3 --json benchmark/results/<date>-ts.json
bunx tsc --noEmit
bun test
bun run accept
bun benchmark/check.ts
```

plus: compare the aggregates in the new MD/JSON against the figures above.

## Notes

- Depends on #42 and #43; lowest priority by design — v2 first.
- Moved from #28's acceptance (2026-10-18) unchanged in substance.
- Non-goals: re-running the opencode side (static baseline), model change,
  cost-in-USD comparison.
- If the metrics miss, file follow-up issues rather than stretching the v2
  scope here.
- Close-out (2026-10-18): canonical run `benchmark/results/2026-10-18-ts.json`
  — json 4,366 (3/3), sexp 2,741 (3/3), minilisp n/a (0/3), overall 13,716 (6/9),
  all under the uniform `none` policy; the effort sweep is archived as
  `benchmark/results/2026-10-18-ts-effort-*.{json,md}`. Verdicts (report section
  "Baseline comparison (2026-10-17)"): json pass (0.28× moat, also under the
  un-adjusted 5,877), sexp pass (goal met), minilisp miss — documented deviation,
  follow-up filed as #48 under #46; overall deviation documented (criterion
  applies at 9/9). `consumption.md` holds the final row. Gates at close: tsc 0
  errors, `bun test` 552 pass / 0 fail, `bun run accept` 5/5,
  `bun benchmark/check.ts` 3 PASS.
