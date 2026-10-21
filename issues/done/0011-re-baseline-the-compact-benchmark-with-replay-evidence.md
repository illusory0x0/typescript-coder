---
id: 11
title: "Re-baseline the compact benchmark with replay evidence"
status: done
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
- Resolved 2026-10-21 (UTC). Live run (human-approved): `bun run benchmark/run.ts --all --side tc --reps 1 --replay-dir tmp/replay-compact --json benchmark/results/2026-10-21-compact-baseline.json` — matrix: 4 tasks (json-parser, sexp-parser, minilisp, csv-parser) × tc × 1 rep = 4 runs, model deepseek-v4.1-flash, effort none, multi-payload off, compact protocol. Outcome: 2/4 — sexp-parser 1/1 $0.00080, csv-parser 1/1 $0.00163 (held out, measured only, no tuning), json-parser 0/1 and minilisp 0/1 both `token-budget` after compact `no-op`/`protocol` rejection loops (48/38 steps, 125,905/124,871 raw tokens); overall $0.02650 (2/4) across four tasks. Artifacts: `benchmark/results/2026-10-21-compact-baseline.json` (+ `.md`, states `protocol-format: compact (#119)`; JSON carries `protocolFormat: "compact"` and a `provenance` block), ledger `benchmark/results/consumption.md` (fresh compact-era row with a trailing Protocol column = compact; the deleted JSON-era rows are stated to be a different protocol and not comparable), replay bundles `tmp/replay-compact/*.json` (all `typescript-coder-replay@1` with `protocolFormat: "compact"`). Replay: all four bundles execute through `benchmark/replay.ts`; sexp/csv exit 0 (4/4 calls, no prompt mismatch), json/minilisp exit 1 because the recorded runs themselves failed (43/43 and 33/33 calls consumed, same `token-budget` termination; exit 1 = loop failed, not a replay/parse error). `bun benchmark/check.ts`: 4 fixtures pass, ledger 1 row checked / 1 fresh / 0 stale / 0 failed. `just typecheck` and `just test` (1146 pass) clean. Caveat: minilisp replay reports prompt mismatches from call 6 onward while reproducing the same termination; the JSON report's internal date is the UTC `2026-10-21`, which the artifact names now follow. Residual: the default compact protocol still storms on json-parser/minilisp at this sample (n=1), recorded here rather than tuned away.
