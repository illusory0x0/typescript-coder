---
id: 36
title: "Run budget: progress-based attempt extension and hard token cap"
status: todo
priority: high
milestone: null
parent: 28
deps: [30]
labels: [harness]
created: 2026-10-17
---

## Context

R8/R3: there is no consumption ceiling (minilisp failures burned 150k/124k
tokens and still failed), and the fixed 3-retry budget gives up even while an
attempt series is making measurable progress. User-approved (2026-10-17):
progress-based extension plus a per-run hard cap; best-state retention was
declined.

## Goal

Attempts extend while verification progress is measurable (bounded), and a
run aborts cleanly with a recorded reason once it exceeds its token budget.

## Acceptance criteria

- [ ] Extension rule: after a failed attempt whose failure signature improves
      strictly (fewer tsc diagnostics + failing tests than the previous
      attempt), one extra attempt is granted; total extension bounded
      (default +2, hard ceiling 5 attempts overall) and configurable; granted
      extensions are visible in the run records.
- [ ] Token cap: every run tracks accumulated provider usage; exceeding the
      budget (default 120,000 tokens, configurable incl. benchmark flag)
      aborts the run with `ok:false` and a `token-budget` classification (not
      a provider/infra failure), preserving records and the exit path.
- [ ] Unit tests: progress detection, extension bounds, cap abort with mock
      usage (including exactly-at-budget), record fields; gates green.
- [ ] `benchmark/README.md` documents the flag and the abort semantics; the
      #19 report wording/comparability notes are checked for staleness.

## Verification

```
bun test
bun run benchmark/run.ts --task minilisp --side ts --reps 1 --token-budget 1000  # mock/scale check
```

plus a mocked run that aborts at the cap and records `token-budget`.

## Notes

- Depends on #30 (retry loop shape) and #29 (attempt/usage records).
- The cap must never mask infra errors: provider errors keep their own path;
  budget aborts count as run failures in benchmark aggregates, with the abort
  reason preserved.
- Non-goals: per-call output caps, cost-in-USD budgets, model-side controls
  (see #35).
