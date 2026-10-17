---
id: 36
title: "Run budget: progress-based attempt extension and hard token cap"
status: done
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
- Validation (2026-10-18): extension implemented — on a verification failure
  the signature (`check.diagnostics.length + failingTestNames(test.output).length`)
  is compared with the previous verification failure; strict improvement
  grants one attempt (bounded by `retryExtensions`, default 2, and the absolute
  `MAX_TOTAL_ATTEMPTS = 5`), marks that attempt `extensionGranted`, and raises
  the dynamic limit the retry prompt advertises ("Attempt 3 of 4 ...");
  non-verification failures reset the chain; `LoopResult.extensions` records
  the total. Budget: every successful provider chat (selection + edit)
  accumulates `total_tokens` (fallback `prompt_tokens + completion_tokens`);
  strictly exceeding `tokenBudget` (default 120,000) aborts before
  parsing/applying the in-flight response with `abortReason: "token-budget"`,
  `explanation: null` (no further provider call), and preserved
  attempts/messages/skipped. Benchmark: `--token-budget <n>` (ts side, positive
  integer) threaded to the loop; `RunRecord` gains `extensions`, `abortReason`,
  per-attempt `extensionGranted`; `ok` is forced false on abort with judge
  fields recorded as-is; `benchmark/README.md` documents the flag, fields, and
  aggregate semantics. The #19-style comparability wording
  (`benchmark/results/2026-10-17.md:69`) was checked and is still accurate —
  left untouched.
- Evidence: mocked runs (exactly-at-budget continues; 101 > 100 aborts with the
  exact diagnostic, no third call, unchanged file; selection-phase abort has a
  null locator and one call; 3→2→1→1→1 stops at 5 attempts with `extensions: 2`;
  `retryExtensions: 1` stops at 4; stalled signatures stop at 3; a non-verification
  failure breaks the chain) plus the live scale check
  `bun run benchmark/run.ts --task minilisp --side ts --reps 1 --token-budget 1000`
  → `ok:false, sideOk:false, steps:0, abortReason:"token-budget", extensions:0,
  attempts:[], loopDiagnostics:"token-budget: accumulated 10544 tokens exceeded
  the 1000 token budget"`; `--token-budget 0|abc|missing` exit 2.
- Validation gates: tsc 0, 506 → 514 tests, `accept` 5/5,
  `benchmark/check.ts` 3 PASS.
