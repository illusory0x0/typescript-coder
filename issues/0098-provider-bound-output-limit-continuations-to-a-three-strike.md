---
id: 98
title: "Provider: bound output-limit continuations to a three-strike"
status: todo
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
