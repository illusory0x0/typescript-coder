---
id: 94
title: "Repair prompt: carry the newest exchange verbatim beside the attempt digest"
status: todo
priority: low
milestone: null
parent: 91
deps: []
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

#64 absorption candidate 2. opencode2's compaction keeps the newest `keep`
tokens verbatim *beside* the summary and omits only the older part
(`packages/core/src/session/compaction.ts:704-744`,
`packages/core/src/session/runner/to-llm-message.ts:311-325`). tc's continuation
prompts carry only a one-line attempt digest, so the model re-derives the exact
last failure from a summary.

## Goal

Continuation/repair prompts render the **newest exchange's diagnostics verbatim**
(already capped by `DIAGNOSTICS_LIMIT = 4_000`) beside the attempt digest, so the
model sees the exact failure it is iterating on instead of only a cause count.

## Acceptance criteria

- [ ] The newest record's diagnostics tail is rendered beside the digest on
      continuation/repair prompts, within the existing cap.
- [ ] Unit tests cover the render (present/absent, capping).
- [ ] A live tc-side matrix shows non-regression (json 3/3, sexp 3/3,
      minilisp >=2/3; no worse tokens per success than the committed #75/#87
      state); rows in `benchmark/results/consumption.md`.
- [ ] Guards, caps, and the single-edit protocol unchanged.

## Verification

```
bun test
bunx tsc --noEmit
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-tc-verbatim.json --replay-dir tmp/replays-<name>
bun benchmark/check.ts
```

Inspect a replay to confirm the newest diagnostics appear verbatim.

## Notes

- Parent: the #64 absorption umbrella.
- Related: #88 (show the model its own prior replies) was measured and reverted
  negative; this candidate is narrower — the newest diagnostics text, not the
  prior replies.
- Non-goals: widening the diagnostics cap; changing guards.
