---
id: 110
title: "Record the resolved selection stage/selector per applied edit"
status: todo
priority: medium
milestone: null
parent: 105
deps: [106, 108]
labels: [benchmark, harness]
created: 2026-10-20
---

## Context

`#101` records `LoopRecord.selectors` (`range | matcher | whole-symbol`) and the
report's "Selector adoption" section. The cascade adds stages (select / match /
pick / replace) and a resolved-stage notion; unless the metric covers that
vocabulary, adoption of the new syntax is unmeasurable — the exact gap `#100`
hit, where a *successful* edit was indistinguishable from a whole-symbol edit.

## Goal

Per applied edit, record which stage/selector resolved it, and surface the
totals in the benchmark report.

## Acceptance criteria

- [ ] `LoopRecord` and the report record the resolved stage and selector kind
      for every applied edit (success included), not only failures.
- [ ] The report's adoption section lists each selector kind and each resolved
      stage, and an aggregate row is available for the A/B.
- [ ] Unit tests cover the classification; a live `--all --side tc --reps 1` run
      shows non-zero attribution for the kinds exercised.
- [ ] Guards, caps, and prompts are unchanged.

## Verification

```
bunx tsc --noEmit
bun test
bun run benchmark/run.ts --all --side tc --reps 1 --json tmp/report.json
```

then read the adoption section of the produced report.

## Notes

- Depends on the specification (`#106`) and cascade resolution (`#108`); builds
  on `#101` (done).
- Cache-excluded token accounting (`#89`) is unchanged.
