---
id: 33
title: "Multi-edit attempts: serial application of N anchored edits"
status: todo
priority: high
milestone: null
parent: 28
deps: [31]
labels: [harness]
created: 2026-10-17
---

## Context

R7: one attempt can touch exactly one symbol/range, so real tasks with several
change points need several round trips (and the benchmark's minilisp repairs
would re-emit per error). The anchor protocol (#31) defines an `edits` array
with exactly one entry; this issue lifts that to N entries applied serially.
The editor already supports multiple whole-symbol replacements with overlap
detection (src/editor.ts `applyEdits`), but the loop and the anchor matcher do
not yet.

## Goal

A single response may carry N anchored edits (bounded), applied in order with
the existing keep-progress semantics, verified once per attempt.

## Acceptance criteria

- [ ] `edits` accepts 1..N entries (cap decided at resolve, default 8);
      entries are applied serially in listed order, each anchor matched
      against the evolving file state (re-index between edits).
- [ ] Failure semantics: if an edit fails to match (not-found/ambiguous) the
      already-applied prefix is kept (#30 keep-progress); the diagnostic names
      the failing edit index and reason; the retry operates on the current
      state.
- [ ] Whole-attempt verification runs once after all edits are applied (tsc +
      tests as today); outcome and per-edit summary recorded via #29 fields.
- [ ] Prompts describe the multi-edit contract (fewest edits that cover the
      change, top-to-bottom order, unique anchors); the single-edit cap note
      from #31 is removed.
- [ ] Unit tests: two disjoint edits both apply; second-edit failure keeps the
      first; overlapping/duplicate anchors rejected; cap enforcement; loop
      integration test with a mock provider; gates green.
- [ ] Evidence: at least one offline replay (#40) exercising a multi-edit
      attempt.

## Verification

```
bun test
bun benchmark/replay.ts <bundle-with-multi-edit>
```

## Notes

- Depends on #31 (edits protocol + matcher).
- Multi-file orchestration stays out of scope (H4 horizon).
- Open item (resolve): per-edit max count and whether same-anchor duplicates
  are rejected up front.
