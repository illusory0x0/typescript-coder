---
id: 101
title: "Record the edit selector (range / matcher / whole-symbol) in loop records and the benchmark report"
status: todo
priority: medium
milestone: null
parent: 100
deps: []
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

`#72` added the optional `range` selector, but nothing records which selector a
payload actually used. `LoopRecord` (`src/loop.ts:1648-1676`) and `recordRow`
(`src/loop.ts:1909-1949`) carry `outcome`, `cause`, `replacementChars`,
`payloads` (a count), and `toolCalls`; the report's `RecordSummary` and
`exchangeStats` (`benchmark/run.ts:83-113`) mirror those. None carries a
selector field.

Consequence: a *successful* `range` edit records `cause: null` and is
indistinguishable in the records from a matcher or whole-symbol edit; only a
failed `range-invalid` is observable. Measured adoption therefore required
replay-bundle surgery, and the committed "0 adoption" note in #72 was a
single-sample reading that the corpus contradicts (22 `range` payloads across 82
replay dirs). The internal discriminator already exists for the byte-identical
resubmission guard — `ModifySubmissionEntry` with `matcher: string | null` and
`rangeJson: string | null` (`src/loop.ts:3846-3853`) — but it is neither exported
nor recorded.

## Goal

Every applied `modify` edit records the selector it used (`range`, `matcher`, or
`whole-symbol`) and the benchmark report surfaces per-task adoption counts, so
selector adoption is a mechanical metric instead of replay archaeology.

## Acceptance criteria

- [ ] Each exchange record carries the selector used by its payload; for a
      `{"payloads": [...]}` batch (#69/#78), each entry is classified (adoption
      counts distinguish batch entries).
- [ ] The benchmark report/records surface the selector adoption counts per task
      (and per side where meaningful).
- [ ] Unit tests pin the classification for flat payloads, batch payloads, and
      exchanges with no payload (field omitted/null when nothing was applied).
- [ ] No behavior change beyond the added field: guards, caps, addressing, and
      all prompt text stay byte-identical; `bun test` and the judge unchanged.

## Verification

```
bunx tsc --noEmit
bun test
bun run benchmark/run.ts --all --side tc --reps 1 --json benchmark/results/<date>-selector.json --replay-dir tmp/replays-selector
bun benchmark/check.ts
```

plus inspecting the new report field for a genuine live `range` use (the corpus
recorded several).

## Notes

- Parent: the `range`-adoption umbrella. Prerequisite for the steer experiment
  (its sibling `deps` on this issue).
- Existing discriminator to reuse: `ModifySubmissionEntry.matcher` / `.rangeJson`
  (`src/loop.ts:3846-3853`, resubmission guard `:3896-3913`).
- Non-goals: changing the payload protocol, adding a prompt field, or altering
  the resubmission guard's behavior.
