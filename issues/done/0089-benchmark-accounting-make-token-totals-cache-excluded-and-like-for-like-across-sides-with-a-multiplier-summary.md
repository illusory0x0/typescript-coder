---
id: 89
title: "Benchmark accounting: make token totals cache-excluded and like-for-like across sides, with a multiplier summary"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [benchmark, docs]
created: 2026-10-20
---

## Context

The 2026-10-20 tc-vs-oc analysis exposed an asymmetry in the report's token
accounting. The two sides report usage differently and the report compared them
across conventions:

- tc (OpenAI format): `input` **includes** cache hits (miss = input - cacheRead).
- oc (session export): `input` **excludes** cache reads (miss = input; hit = cacheRead).

The "Mean total" columns render `tokens.total` (input + output) per side, so tc's
total silently carries its cache-hit tokens while oc's does not. In the
`2026-10-20-tc-vs-oc` run the headline read `tc 13,110 vs oc 16,035 (1.22x)`,
but on a like-for-like basis (cache-miss + output) it is `tc 7,041 vs oc 16,035
(2.28x)`, and cache-inclusive prompt is `4.7x`. The comparison understates oc's
usage and inflates tc's reported advantage.

Decision (2026-10-20): the token total should count **input + output with cache
excluded**, identically on both sides; USD stays computed but is decision-only,
and the summary should state the multiplier.

## Goal

Token totals in the report are cache-excluded and like-for-like across sides, with
a multiplier summary, while USD remains available for decisions.

## Acceptance criteria

- [ ] A run's reported token total = **cache-miss input + output** (reasoning
      counted as output), computed identically for both sides via the existing
      bucket normalization; cache-hit input is excluded from the total.
- [ ] The per-task and overall report tables show cache-miss input (`in`), output
      (`out`) and `total = in + out`; the cache-inclusive raw input is not used as
      the comparison total.
- [ ] A summary states the token multiplier between sides, overall and per task
      (e.g. `oc 2.28x tc overall; json 3.2x, sexp 3.9x, minilisp 1.34x, csv 0.48x`).
- [ ] USD remains computed and recorded (result JSON + `consumption.md`) for
      decisions, but is not the headline comparison metric.
- [ ] `src/benchmark-pricing.ts` / `benchmark/README.md` and the report's method
      note document that the token total excludes cache.
- [ ] Historical result files and ledger rows are unchanged; the new accounting
      applies to new runs.
- [ ] Gates stay green.

## Verification

- `bunx tsc --noEmit`
- `bun test`
- `bun benchmark/check.ts`
- A unit test asserting, for recorded sample rows, that the reported in/out/total
  equal cache-miss input / output / (miss + output) on **both** sides, and that a
  rendered report prints the multiplier summary.

## Notes

- Motivated by the `2026-10-20-tc-vs-oc` / `2026-10-20-oc-none` analysis.
- Non-goals: rewriting historical rows or result files; changing pricing or rates;
  altering the tc loop.
- Landed 2026-10-20. `billableTokens` (`src/benchmark-pricing.ts`) wraps the existing `normalizeBuckets` to give the cache-excluded triple `{in,out,total}` (in = cache-miss input, out = output+reasoning, total = in+out); `aggregateRuns` (`benchmark/run.ts`) builds the report token stats from it; each run's JSON now carries `tokens.billable` while the raw buckets stay untouched (cost path unchanged). Report tables read `Mean in (no cache) | Mean out | Mean total`; a `Token multiplier` sentence prints the higher/lower ratio overall and per task; USD is labeled decision-only (still computed in the JSON + `consumption.md`). The `## Raw runs` columns were renamed `Raw in/out/total` with a note so they can't be conflated with the cache-excluded totals. Docs updated: `src/benchmark-pricing.ts` header, `benchmark/README.md`, and the report method note; historical rows/files are untouched. New test file `src/benchmark-run.test.ts` (guarded dynamic import so the self-host smoke still passes). Gates: `tsc` 0, `bun test` 870 pass, `benchmark/check` 4 passed/0 failed. Re-rendering the real `2026-10-20-tc-vs-oc` data gives tc 7,041 vs oc 16,058 overall (oc 2.28x; json 8.10x, sexp 13.96x, minilisp 2.05x, csv 1.08x) — tc's previous 13,110 counted ~6,069 cheap cache-hit tokens. Side finding: like-for-like, csv is a near tie (oc 1.08x), so the earlier "tc 2x worse on csv" was a cache-convention artifact, not a tc deficit.
