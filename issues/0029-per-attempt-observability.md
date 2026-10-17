---
id: 29
title: "Record per-attempt summaries and replay bundles"
status: todo
priority: high
milestone: null
parent: 28
deps: []
labels: [benchmark]
created: 2026-10-17
---

## Context

Failure anatomy from 2026-10-17 (minilisp ts rep1/rep3) had to be reconstructed
from usage numbers alone: per-attempt diagnostics live only in `side.log`
inside the run workspace, which is deleted unless `--keep`. There is no
structured record of what each attempt was, why it failed, or what the model
actually returned. This blind spot blocks attribution for the whole
improvement series.

## Goal

Every attempt is recorded in structured form in the result JSON, and the
harness can optionally capture full replay bundles (messages + responses) for
offline iteration.

## Acceptance criteria

- [ ] `LoopAttempt` (src/loop.ts) carries a structured outcome per attempt:
      `outcome` (e.g. ok | selection-invalid | edits-invalid |
      anchor-not-found | anchor-ambiguous | format | tsc | tests | provider |
      truncated), a bounded `diagnosticsHead` (≤200 chars), the replacement
      size in chars, and the provider finish reason when relevant.
- [ ] The benchmark `RunRecord` JSON includes per-attempt summaries for every
      run (smoke: one green and one failing run show non-empty entries);
      keys are documented in `benchmark/README.md`.
- [ ] Optional replay capture: when enabled (benchmark flag, name decided at
      resolve, default off) each run writes one bundle JSON containing the
      ordered chat calls (request messages, response content, finishReason,
      usage) plus task id; no bundle is written when disabled.
- [ ] Unit tests cover outcome classification and bundle assembly with a mock
      provider; gates: `bunx tsc --noEmit` 0, `bun test`, `bun run accept`.

## Verification

```
bun test
bun run benchmark/run.ts --task json-parser --side ts --reps 1 --keep
```

plus: inspect the run JSON for per-attempt entries; with capture enabled,
inspect one bundle and replay-read it by hand.

## Notes

- Bundle format is the input contract of #40 (replay runner); keep it minimal
  and versioned with a `format` field.
- The `outcome` taxonomy is shared with #38 (structured diagnostics) and #31
  (edits/anchor failures); evolve both together.
- Non-goals: uploading bundles anywhere, capturing provider internals beyond
  messages/responses/usage.
