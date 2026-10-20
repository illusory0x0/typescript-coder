---
id: 98
title: "Provider: bound output-limit continuations to a three-strike"
status: done
priority: low
milestone: null
parent: 91
deps: []
labels: [provider, agent-loop]
created: 2026-10-20
---

## Context

#64 absorption candidate 6 (sibling of #74). opencode2's runner counts the last
three settled messages and, if all are assistant `length` finishes, fails instead
of continuing again
(`packages/core/src/session/runner/llm.ts:290-319`). tc can keep continuing a
repeatedly truncated reply and burn budget.

## Goal

Bound output-limit continuations to a three-strike: count consecutive
`finish_reason == "length"` replies and terminate through the defined
summary/stop path rather than continuing indefinitely.

## Acceptance criteria

- [ ] Consecutive `finish_reason == "length"` replies are counted in `records`;
      the third consecutive one terminates through the summary/stop path.
- [ ] Unit tests cover the counter (reset on a non-length finish; fires on the
      third).
- [ ] Live evidence; rows in `benchmark/results/consumption.md`.
- [ ] Guards, caps, and the single-edit protocol unchanged.

## Verification

```
bun test
bunx tsc --noEmit
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-tc-length.json --replay-dir tmp/replays-<name>
bun benchmark/check.ts
```

## Notes

- Parent: the #64 absorption umbrella.
- Sibling of #74; complements #74 (timeout retries) and #30 (guard truncation).
- Non-goals: hard caps on total tokens; auto-stop on ordinary failures.
- Landed 2026-10-20. Added `MAX_CONSECUTIVE_LENGTH = 3` (`src/loop.ts:1244`), `consecutiveLengthFinishes(records)` (`:1743`, derives the trailing run from the existing `records[].finishReason`, so any non-length latest finish resets it to 0), a new `output-limit` member of `TerminationReason` (`:1764`) with its `TERMINATION_SUMMARY` entry, and the guard in the `finishReason === "length"` block after the record push (`:4752`): the third consecutive length reply `terminate("output-limit", …)`s through the existing `explain` summary path instead of continuing into another exchange or round. No new mutable counter; guards/caps/single-edit protocol unchanged. Tests: 3 new (unit counter incl. reset; integration: always-length → `terminationReason === "output-limit"` after exactly 3 truncated rows; length,length,valid-edit → `ok: true`). Docs `docs/design.md` (termination matrix) and `docs/spec.md` updated for the new reason. Gates: tsc clean, `bun test` 888 pass, `benchmark/check` 4 passed/0 failed. Live matrix `benchmark/results/2026-10-20-tc-length.json`: 12/12, minilisp 3/3, overall $0.00286/success; no run hit three consecutive length replies, so the cap is unit/integration-tested only. Ledger row added (37 rows).
