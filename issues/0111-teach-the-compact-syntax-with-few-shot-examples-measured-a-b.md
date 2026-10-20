---
id: 111
title: "Teach the compact syntax with few-shot examples, measured A/B"
status: todo
priority: medium
milestone: null
parent: 105
deps: [107, 108, 109, 110]
labels: [harness, benchmark]
created: 2026-10-20
---

## Context

`#102` showed that a hint appended only to matcher-**failure** corrections did
not move adoption (range 0 in both arms). The compact syntax changes what the
model emits, so the right intervention is few-shot examples in the **fresh edit
prompt**, seen before the first reply rather than only after a failure.
Placement also decides provenance cost: `currentInputHashes` hashes
`buildSystemPrompt(multiPayload)` (`src/provenance.ts:214`) but **not** the edit
prompts, so examples added to the edit prompt keep the ledger fresh, while
examples in the system prompt stale every row.

## Goal

Few-shot examples teach the compact positional syntax and the cascade, and an
A/B reports adoption plus cache-excluded tokens/USD per success with an honest
verdict.

## Acceptance criteria

- [ ] The edit prompt carries few-shot examples showing: path-only (viewer),
      path+line/point, path+range, and path+range+anchor
      (`src/lexer.ts:10:1-20:2 \`xs.push\``).
- [ ] The change is A/B-measurable on byte-identical source via a runtime
      opt-out in the style of `TC_DIAG_DECL_NAMING` (`#92`) /
      `TC_MATCHER_RANGE_HINT` (`#102`).
- [ ] The A/B reports selector/stage adoption (from `#110`) and cache-excluded
      tokens + USD per success per arm (uniform `none`, same model), with an
      honest verdict including "no effect".
- [ ] No regression on the happy paths; guards and caps unchanged.
- [ ] `consumption.md` row(s) with the source JSON per arm.

## Verification

```
bunx tsc --noEmit
bun test
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-syntax-on.json  --replay-dir tmp/replays-syntax-on
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-syntax-off.json --replay-dir tmp/replays-syntax-off
bun benchmark/check.ts
```

plus reading the adoption counts from each arm's report and the tokens/USD
columns from the reports.

## Notes

- Depends on the parser (`#107`), cascade resolution (`#108`), regex (`#109`),
  and instrumentation (`#110`).
- Placement: edit prompt (keeps provenance fresh). The system-prompt option
  stales the ledger and is not preferred.
