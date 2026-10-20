---
id: 93
title: "tc-vs-oc: canonical none-vs-none matrix under the #89 cache-excluded accounting"
status: done
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
- Landed 2026-10-20. Added `--oc-model <id>` to `benchmark/run.ts` (defaults to `--model`; helper `opencodeModelFor`, `benchmark/run.ts:1209`) because the tc gateway rejects the oc `#none` variant suffix (403 "model is not allowed") and `--model` is shared by both sides; the report records `ocModel` and renders `- oc model:` only when set, and absent flag is byte-identical to before. Canonical matrix `benchmark/results/2026-10-20-tc-vs-oc-none.json` (`--all --side both --reps 3 --model deepseek-v4.1-flash --oc-model deepseek-v4.1-flash#none`): tc 10/12, oc 12/12, oc reasoning 0 (none confirmed). Cache-excluded tokens per success (oc/tc): json 9.02x, sexp 9.60x, csv 1.39x, **minilisp tc 1.40x oc** (tc 1/3 — rep1 18,039 vs rep2/rep3 storms 63,708/49,594; oc 26,354/44,435/22,994), overall oc 1.28x tc. The #46 minilisp caveat is reproduced: tc's clean minilisp run is cheaper but it storms 2/3. Ledger row added (35 rows) and the two pre-#89 comparison reports annotated. Gates: tsc clean, bun test 875 pass, benchmark/check 4 passed/0 failed.
