---
id: 28
title: "Cut harness token consumption below the opencode baseline"
status: todo
priority: high
milestone: null
parent: null
deps: []
labels: [harness, benchmark]
created: 2026-10-17
---

## Context

Benchmark full run 2026-10-17 (`benchmark/results/2026-10-17.md`): the harness
loses on consumption overall — 70,799 vs 16,824 tokens-per-success (4.21×) —
driven by sexp-parser (43,293 vs 11,812) and minilisp (348,080 vs 23,142,
1/3 vs 3/3 success). The json-parser win (5,877 vs 15,517, 0.38×, zero
exploration in input) is the moat that must not regress. Root causes R1–R10 and
the user-approved plan v4 (one-shot implementation of all children, one final
ts-side re-measure) were agreed on 2026-10-17.

## Goal

The harness consumes fewer tokens per success, with the final ts-side benchmark
at or below the opencode baseline overall, sexp/minilisp materially improved,
and json still winning.

## Acceptance criteria

- [ ] All child issues are done or formally superseded: #29–#40 and #42–#44
      done; #32/#41 superseded by #42/#43 (wontfix).
- [ ] Final measurement (#44) committed: full ts-side run + report +
      `consumption.md`, with the goal verdict documented.
- [ ] Gates green at close: `bunx tsc --noEmit` 0, `bun test` all pass,
      `bun run accept` 5/5, `bun benchmark/check.ts` 3 PASS.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
bun benchmark/check.ts
```

plus: confirm every child is done (or superseded) and the #44 report is
committed under `benchmark/results/`.

## Notes

- Horizon (recorded, not planned): H1 structured run-result JSON for planner
  integration; H2 git-aware safety (clean-tree check, optional checkpoint
  commits); H3 multi-model routing / per-phase reasoning shaping; H4 large-repo
  context (relevance ranking + on-demand fetch).
- Non-goals: model change, opencode-side changes, cost-in-USD comparison,
  re-running the opencode side (its baseline is static).
- Open items are resolved inside the child issues; no direct implementation
  work lands on this umbrella.
- Update (2026-10-18): the v2 loop redesign (#42 edit protocol, #43 agent
  loop) replaced the anchor-protocol approach; #32/#41 are superseded
  (wontfix); the final full-run measurement moved to #44, deliberately at the
  lowest priority — v2 lands first.
