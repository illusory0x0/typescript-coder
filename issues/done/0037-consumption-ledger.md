---
id: 37
title: "Consumption ledger under benchmark/results"
status: done
priority: high
milestone: null
parent: 28
deps: []
labels: [benchmark]
created: 2026-10-17
---

## Context

The series narrative is "consumption drops step by step". There is no single
place where the baseline and each measured result live side by side; the
2026-10-17 numbers are buried in the full-run report, and per-issue evidence
is scattered.

## Goal

One ledger file records the pre-series baseline and the final measured row
(plus any intermediate measurements taken during the series), each citing its
source result file.

## Acceptance criteria

- [ ] `benchmark/results/consumption.md` exists with a documented row format
      (date, change-set/issue refs, json/sexp/minilisp/overall
      tokens-per-success, success counts, source file, notes) and the
      baseline row from `2026-10-17.json` (json 5,877 · sexp 43,293 ·
      minilisp 348,080 · overall 70,799, ts side; opencode reference 15,517 /
      11,812 / 23,142 / 16,824).
- [ ] `benchmark/README.md` points at the ledger as the canonical
      before/after view.
- [ ] Gates green (`bunx tsc --noEmit` 0, `bun test`, `bun run accept`).

## Verification

Read `benchmark/results/consumption.md` and cross-check the baseline row
against `2026-10-17.json` aggregates.

## Notes

- The final row is appended during #28 close-out.
- Non-goals: charts, automated report generation (H1 horizon is about run
  result JSON, not this ledger).
- Validation (2026-10-17): `benchmark/results/consumption.md` documents the
  row format (Date | Change set | json/sexp/minilisp | Overall | Source |
  Notes, cells `N,NNN (ok/runs)`) and holds the single baseline row (json
  5,877 (3/3) · sexp 43,293 (3/3) · minilisp 348,080 (1/3) · overall 70,799
  (7/9); opencode reference 15,517 / 11,812 / 23,142 / 16,824 recorded
  verbatim), cross-checked against `2026-10-17.json` aggregates byte-for-byte
  on the ts rows. `benchmark/README.md` points at the ledger as the canonical
  before/after view. Verified: tsc 0, 471 tests, `accept` 5/5.
