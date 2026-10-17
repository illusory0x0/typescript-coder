---
id: 27
title: "Parallelize benchmark runs (concurrency pool)"
status: done
priority: medium
milestone: null
parent: 16
deps: [18]
labels: [benchmark]
created: 2026-10-17
---

## Context

`benchmark/run.ts` executes the task × side × rep matrix in a serial triple
loop (`benchmark/run.ts:1049-1060`): the planned full run (#19) is 18 live
generations and would take 1.5–2.5 h wall time sequentially. The user asked for
parallel execution before running the full matrix. Per-run state is already
isolated (fresh workspace + git repo + session + log dir per run), so the
matrix can run through a bounded worker pool.

## Goal

The benchmark matrix executes with bounded parallelism (`--concurrency`,
default 4) while per-run isolation, report content, and error semantics stay
unchanged.

## Acceptance criteria

- [ ] `benchmark/run.ts` runs the task/side/rep matrix through a bounded worker
      pool; `--concurrency <n>` is parsed/validated (positive integer) and
      documented in `--help` and `benchmark/README.md`; default 4.
- [ ] Per-run isolation unchanged: each run keeps its fresh workspace + git
      repo + session + logs; no shared mutable state between concurrent runs.
- [ ] `report.runs` order is deterministic (task, side, rep) regardless of
      completion order; `infraErrors` from records are aggregated after the
      pool; progress prints may appear in completion order.
- [ ] Smoke proof: `bun run benchmark/run.ts --task json-parser --side both
      --reps 2 --concurrency 4 --keep` completes 4 runs with distinct
      workspaces and a wall time ≈ the slowest run (not the sum).
- [ ] `bunx tsc --noEmit` 0; `bun test` all pass; `bun run accept` 5/5.

## Verification

```
bun run benchmark/run.ts --help
bun run benchmark/run.ts --task json-parser --side both --reps 2 --concurrency 4 --keep
bunx tsc --noEmit
bun test
bun run accept
```

plus: check the four workspace dirs are distinct and `git status` stays clean.

## Notes

- Blocks #19: the full run should use the parallel harness.
- Default 4 balances gateway rate limits and 12 local cores; raise per run with
  `--concurrency`.
- Durations get noisier under contention; tokens remain the primary metric
  (record this in the #19 report).
- Non-goals: retry/backoff policy changes, distributed execution.
- Validation (2026-10-17): the matrix runs through a bounded worker pool
  (`--concurrency <n>`, default 4; `Math.min(concurrency, jobs)` workers claim
  indices); `report.runs` is rebuilt in job order and `infraErrors` aggregated
  after the pool. Smokes: `json-parser --side both --reps 2 --concurrency 4`
  wall 90.5 s ≈ slowest run (89.9 s) vs 172.4 s serial sum, 4 distinct
  workspaces; `json-parser --side opencode --reps 2 --concurrency 2` wall
  29.6 s vs 52.7 s sum. Verified: tsc 0, 446 tests, `accept` 5/5.
