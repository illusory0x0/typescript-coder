---
id: 63
title: "Report consumption in USD using the official DeepSeek Flash peak/off-peak prices"
status: done
priority: high
milestone: null
parent: 46
deps: []
labels: [benchmark]
created: 2026-10-19
---

## Context

User directive (2026-10-19, marked top priority): consumption reporting switches from tokens to USD, valued with the official DeepSeek V4.1-Flash (`deepseek-flash`) peak/off-peak prices.

Official prices (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens): cache-hit input $0.003 off-peak / $0.006 peak; cache-miss input $0.15 / $0.30; output $0.60 / $1.20. Off-peak is half of peak; peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday, excluding Chinese public holidays; all other hours are off-peak. CN 2026 public-holiday dates (timeanddate.com/holidays/china/2026, fetched 2026-10-19): Jan 1-3, Feb 15-23, Apr 4-6, May 1-5, Jun 19-21, Sep 25-27, Oct 1-7.

Current state: reports and `benchmark/results/consumption.md` are token-denominated; result rows carry `tokens` {input, output, cacheRead, cacheWrite, reasoning, total} but no timestamps. Bucket semantics differ by side: tc (OpenAI format) `input` includes cache hits (`cacheRead` is a subset; miss = input - cacheRead); oc (session export) `input` excludes cache reads (miss = input; hit = cacheRead). Cross-check 2026-10-19: the opencode export's own `cost` equals the official off-peak formula on all 18 kept oc runs (both baselines), confirming the formula and bucket semantics. All series runs to date fall inside off-peak windows (weekends UTC), so the historical conversion is at off-peak rates.

User display decision (2026-10-19): the ledger's values switch to USD per success (historical rows converted); reports keep the token columns and add USD columns; the result JSON keeps full detail.

## Goal

Consumption values are expressed in USD using the official deepseek-flash peak/off-peak prices, computed per run from its token buckets and actual time window.

## Acceptance criteria

- [ ] A pricing module (unit-tested, discovered by `bun test`) encodes the official rate table and the peak/off-peak rule (Mon-Fri 01-04 & 06-10 UTC; CN holidays off; otherwise off-peak), with the 2026 CN holiday list as an editable, source-commented constant.
- [ ] Per-run cost: buckets normalized per side (tc miss = input - cacheRead; oc miss = input, hit = cacheRead; output includes reasoning; cacheWrite, if ever present, documented as priced at the miss rate); the window is chosen from per-run `startedAt`/`finishedAt` now recorded in the result rows; a run straddling windows splits by elapsed-time share (approximation documented).
- [ ] Result JSON: runs gain `startedAt`, `finishedAt`, `cost`, and rate class; aggregates gain `cost`/`costPerSuccess` by task and side alongside the token fields.
- [ ] Report md keeps the token table and adds USD columns (5-decimal formatting) plus a pricing footnote (rates, source, window rule); `benchmark/README.md` documents the pricing rule and source.
- [ ] `consumption.md`: metric values switch to USD per success with success counts kept; historical rows converted (off-peak; basis stated); the row-format/how-to sections rewritten; the method footnoted.
- [ ] Recomputed oc costs equal the export `cost` on the kept bundles (relative difference <= 1e-9); preview values reproduce: oc 2026-10-18 $0.00465/run, oc 2026-10-19 $0.00559/run, tc 2026-10-19-ts $0.00438/success, tc 2026-10-19-tc $0.00800/success.
- [ ] Gates green: `bun run typecheck`, `bun test`, `bun run accept`; tracker `check` passes; dated result files are not rewritten.

## Verification

- Unit tests for window boundaries (weekday peak/off-peak minutes, weekends, holidays) and bucket normalization with known fixtures (oc json rep1: miss 9,345 / hit 22,400 / out 2,160 -> $0.00276495; tc json rep1: miss 257 / hit 2,816 / out 1,613 -> $0.0010148).
- Recompute costs for the four source JSONs above and compare against the recorded preview values and the export costs; render a report from an existing result JSON and inspect the new USD columns; run the gates.

## Notes

- One rate table, one window function; DeepSeek may change prices - keep the source URL + fetch date next to the constants.
- Interaction: #62's remaining ledger criteria (refreshed baseline + tc pairing rows) are completed in USD after this lands; the batch proceeds to #60 next.
- While converting the ledger, keep the Source column and success counts; Notes prose may keep historical token figures (label them as token-era).
- Do not regenerate dated reports under `benchmark/results/`; the renderer change applies to future runs.
- Parity check for reviewers: oc json rep1 export cost $0.00276495 (off-peak) is reproduced exactly by miss*0.15 + hit*0.003 + out*0.6 per 1M.

### Evidence (2026-10-19, main-agent verification)

- Independent reproduction of the four preview values (`tmp/verify-63-main.ts`,
  off-peak conversion for historical rows): oc 2026-10-18 $0.00465/run
  (0.004647); oc 2026-10-19 $0.00559/run (0.005586); tc 2026-10-19-ts
  $0.00438/success (0.004382, 8/9); tc 2026-10-19-tc $0.00800/success (0.007996,
  7/9). ALL CHECKS PASSED.
- Parity anchors: oc json rep1 $0.00276495 (9,345 miss / 22,400 hit / 2,160
  out); tc json rep1 0.001014798 (the issue's rounded $0.0010148; source row
  `2026-10-19-tc.json` json-parser rep1: 3,073 input / 2,816 cacheRead / 1,613
  output). Export-cost parity over all 18 oc runs of both baselines: worst
  relative difference 2.86e-16 (<= 1e-9); the module equals an independent
  inline formula on every row of the four source JSONs.
- Live window pricing: the fresh `2026-10-19-oc-none-2.json` sample (9/9, all
  `off-peak`) records per-run `cost`, and every recorded cost equals the
  off-peak recomputation (0 mismatches) — the window logic exercised on real
  runs.
- Render: `benchmark/results/2026-10-19-oc-none-2.md` carries the USD columns
  (per task $0.00306 / $0.00226 / $0.00800; overall $0.00444 mean, $0.03995
  total), the per-run `Rate` column, and the pricing footnote.
- Dated result files untouched (mtime check; only `consumption.md` was
  rewritten, by design).
- Gates (main-agent rerun on the frozen tree): `bun run typecheck` clean;
  `bun test` 647 pass / 0 fail; `bun run accept` 5/5; tracker `check` green.
- Deviations reviewed and accepted: exported `Report`/`writeMarkdownReport`
  (offline re-render support, no behavior change); `cost` aggregates mirror the
  `tokens` shape plus `costPerSuccess`; historical rows converted off-peak
  (documented in the ledger); output+reasoning priced together (per the issue's
  bucket formulas; needed to hit the mandated previews); straddle blend and the
  holiday list documented next to the constants.
