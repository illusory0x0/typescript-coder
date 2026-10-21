---
id: 11
title: "Re-baseline the compact benchmark with replay evidence"
status: todo
priority: medium
milestone: null
parent: 6
deps: [7, 8, 9, 10]
labels: [benchmark]
created: 2026-10-22
---

## Context

Compact is now the default protocol, and the compact prompts, select-first flow, details/confirmation turns, and compact atomicity have changed the model-facing contract. Existing benchmark results and the consumption ledger are JSON-era baselines; `benchmark/run.ts` now defaults to compact, and replay bundles need a protocol field before their evidence can be trusted.

No compact benchmark run has been made, so no performance claim may cite the old JSON baseline as like-for-like.

## Goal

Record a fresh compact benchmark baseline with provenance and working replay evidence, and clearly label the protocol in the report/ledger.

## Acceptance criteria

- [ ] A human-approved compact benchmark run writes a report whose provenance/report states `protocol-format: compact`.
- [ ] Replay bundles from the run contain the protocol and replay successfully through `benchmark/replay.ts` (depends on the replay issue).
- [ ] The consumption ledger/report records the compact baseline and marks JSON-era rows as a different protocol.
- [ ] The held-out `csv-parser` rule is respected; no prompt/code is tuned against it.
- [ ] The issue records the exact task/side/reps matrix and the artifact paths it cites.

## Verification

```
bun run benchmark/run.ts --all --side tc --reps 1 --replay-dir tmp/replay-compact --json tmp/compact-baseline.json
bun run benchmark/replay.ts <bundle.json>
```

The live run is human-approved and costs tokens; the replay checks are offline. Read the produced report and ledger.

## Notes

- Depends on the replay-metadata, confirmation-budget, retry-prompt, and viewer-details issues so the baseline is measured after the prompt/flow is stable.
- Historical JSON results stay in place but are not a like-for-like compact comparison.
- No live/benchmark run is made by the filing or by CI.
