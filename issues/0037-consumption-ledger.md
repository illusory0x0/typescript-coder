---
id: 37
title: "Consumption ledger under benchmark/results"
status: todo
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
