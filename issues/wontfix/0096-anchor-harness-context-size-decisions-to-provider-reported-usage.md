---
id: 96
title: "Anchor harness context-size decisions to provider-reported usage"
status: wontfix
priority: low
milestone: null
parent: 91
deps: []
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

#64 absorption candidate 4. opencode2 anchors its compaction trigger to the newest
provider-measured prompt and explicitly **skips** when a checkpoint just landed
("let the runner rebuild the request from it first")
(`packages/core/src/session/compaction.ts:242-251`, `.../compaction.ts:920-929`).
tc reads provider `total_tokens` (`src/loop.ts:1333-1354`) but uses it only for the
budget; context-size/digest decisions are otherwise estimate-driven.

## Goal

Thread provider-reported usage into the context-size/digest trigger predicate and
skip the trigger immediately after a digest/checkpoint was produced, so decisions
use measured tokens and do not thrash every round.

## Acceptance criteria

- [ ] One trigger predicate consumes provider-reported usage (falling back to the
      estimate when absent).
- [ ] The trigger is skipped in the round right after a digest/checkpoint landed.
- [ ] Unit tests cover measured-vs-estimated and the post-checkpoint skip.
- [ ] Live tc-side matrix non-regression; rows in `benchmark/results/consumption.md`.
- [ ] Budget semantics and guards unchanged.

## Verification

```
bun test
bunx tsc --noEmit
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-tc-anchor.json --replay-dir tmp/replays-<name>
bun benchmark/check.ts
```

## Notes

- Parent: the #64 absorption umbrella.
- Related: #49 (context audit and cut), #57 (attempt digest), #65 (storm ask).
- Non-goals: changing the token budget; new mechanisms beyond the trigger.
- Recon 2026-10-20: premise does not map to tc. Candidate 4 assumes a "context-size/digest trigger predicate" that decides when to compact/emit a checkpoint. tc has none: the attempt digest is rendered unconditionally on every continuation and stalled-ask prompt (`digestText()` at `src/loop.ts:4271`, `:4307`, `:4584`), and stall detection is round-milestone-based (`isStalledAskMilestone(stalledRounds)`), not size-based. Provider usage is already read and threaded into the token budget (`addTokens`/`tokensFromResponse`, `src/loop.ts:1333-1354`), but there is no other size decision to anchor it to. So "thread usage into the trigger" has no predicate to feed, and "skip after a checkpoint landed" has no trigger to skip — implementing it would mean inventing the trigger first (the same missing mechanism as #95).
- Wontfix (2026-10-20): Premise does not map to tc: there is no context-size/digest trigger predicate to anchor provider usage to (the digest renders unconditionally on continuation/stalled-ask prompts, src/loop.ts:4271/:4307/:4584; stall detection is round-milestone-based). Nothing for the measured-usage trigger to replace.
