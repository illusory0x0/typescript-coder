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

- [ ] All child issues (#29–#41) are done.
- [ ] A final ts-side run (`--all --side ts --reps 3`) is committed under
      `benchmark/results/` (JSON + MD) and compared in the report against the
      2026-10-17 baseline: json 3/3 (≤6,900 — pre-S 5,877 plus the documented
      #34 spec-input allowance), sexp <43,293 (goal ≤11,812), minilisp ≥2/3
      (goal 3/3) and <348,080, overall ≤16,824 when 9/9 (else documented
      deviation).
- [ ] `benchmark/results/consumption.md` holds the baseline row and the final
      row, each citing its source result file.
- [ ] Gates green at close: `bunx tsc --noEmit` 0, `bun test` all pass,
      `bun run accept` 5/5, `bun benchmark/check.ts` 3 PASS.

## Verification

```
bun run benchmark/run.ts --all --side ts --reps 3 --json benchmark/results/<date>-ts.json
bunx tsc --noEmit
bun test
bun run accept
bun benchmark/check.ts
```

plus: compare aggregates in the new MD/JSON against the figures above.

## Notes

- Horizon (recorded, not planned): H1 structured run-result JSON for planner
  integration; H2 git-aware safety (clean-tree check, optional checkpoint
  commits); H3 multi-model routing / per-phase reasoning shaping; H4 large-repo
  context (relevance ranking + on-demand fetch).
- Non-goals: model change, opencode-side changes, cost-in-USD comparison,
  re-running the opencode side (its baseline is static).
- Open items are resolved inside the child issues; no direct implementation
  work lands on this umbrella.
