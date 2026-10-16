---
id: 19
title: Full benchmark run and report
status: todo
priority: medium
milestone: null
parent: 16
deps: [18]
labels: [benchmark]
created: 2026-10-17
---

## Context

After the pilot validates the harness (#18), run the full matrix: 3 tasks × 3
repetitions × 2 sides = 18 runs, then write the committed report comparing
token consumption and success.

## Goal

`benchmark/results/<date>.json` (raw per-run records + aggregates) and
`benchmark/results/<date>.md` (readable report) for the frozen G1–G3 specs on
`deepseek-v4.1-flash`.

## Acceptance criteria

- [ ] `bun run benchmark/run.ts --all --reps 3 --json benchmark/results/<date>.json`
      completes 18 runs with no infrastructure errors.
- [ ] `<date>.json` contains all 18 records plus aggregates per task and per
      side (success rate, token means/totals, duration, steps) and harness
      metadata (date, bun/opencode versions, model, pilot reference).
- [ ] `<date>.md` documents: frozen task specs (fixture + reference paths),
      token-field definitions per side, a per-task table (success n/3, mean
      input/output/total tokens, mean duration, mean steps), the overall
      comparison, and any anomalies (usage gaps, truncation, reruns).
- [ ] If a run is re-executed due to an infrastructure failure, the report
      lists the reruns and only final records are aggregated.
- [ ] `bunx tsc --noEmit` 0 errors; `bun test` all pass; `bun run accept` 5/5.

## Verification

```
bun run benchmark/run.ts --all --reps 3 --json benchmark/results/<date>.json
bunx tsc --noEmit
bun test
bun run accept
```

plus: read `benchmark/results/<date>.md` and spot-check aggregates against the
JSON.

## Notes

- Deps: #18 (and transitively #15, #17).
- Compare tokens at equal success rates; if success rates differ, report
  tokens-per-success alongside raw means.
- Keep raw session transcripts out of the commit unless small; summarize.
- `<date>` = `YYYY-MM-DD` of the run day.
- Non-goals: cost figures (always 0), multiple models, >3 repetitions.
