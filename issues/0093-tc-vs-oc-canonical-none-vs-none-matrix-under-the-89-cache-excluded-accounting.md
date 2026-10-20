---
id: 93
title: "tc-vs-oc: canonical none-vs-none matrix under the #89 cache-excluded accounting"
status: todo
priority: medium
milestone: null
parent: 90
deps: []
labels: [benchmark, docs]
created: 2026-10-20
---

## Context

The committed tc-vs-oc comparison (`benchmark/results/2026-10-20-tc-vs-oc`) ran
oc with **reasoning ON** (model default), so it is not the canonical uniform-`none`
comparison; the canonical oc baseline was recorded separately
(`2026-10-20-oc-none`). Both committed reports (`.md`) were also rendered under the
**pre-#89** accounting: tc `input` included cache hits, so the cross-side totals
were not like-for-like. After #89 the report prints cache-excluded
`in`/`out`/`total` (total = cache-miss input + output) and a token-multiplier
summary.

## Goal

A canonical by-the-book comparison exists: both sides at uniform `none` effort,
one matrix, tokens reported cache-excluded per #89, with the multiplier summary —
and the stale pre-#89 comparison reports are either re-rendered under #89 or
explicitly annotated as pre-#89.

## Acceptance criteria

- [ ] One full matrix on both sides at uniform `none` effort
      (`--model deepseek-v4.1-flash#none`, `--reps 3`), committed under
      `benchmark/results/`.
- [ ] The report renders the #89 cache-excluded `in`/`out`/`total` columns and the
      token multiplier (overall and per task).
- [ ] Rows added to `benchmark/results/consumption.md`; the two pre-#89 comparison
      reports are re-rendered under #89 or carry a "pre-#89 accounting" note.
- [ ] `bun benchmark/check.ts` green with the new rows.

## Verification

```
bun run benchmark/run.ts --all --side both --reps 3 --model deepseek-v4.1-flash#none --json benchmark/results/<date>-tc-vs-oc-none.json
bun benchmark/check.ts
```

## Notes

- Parent: the measurement umbrella.
- Sides use the short labels `tc` / `oc`.
- Non-goals: changing the #89 accounting; new harness mechanisms.
