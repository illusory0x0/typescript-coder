---
id: 95
title: "Repair-context shrink ladder on repeated rejection"
status: wontfix
priority: low
milestone: null
parent: 91
deps: []
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

#64 absorption candidate 3. opencode2 reduces an over-large request with a graded
ladder `SHRINK_STEPS = [0.7, 0.5, 0.35]`: after each "too long" rejection the next
attempt aims at that share of the first rejected size, dropping whole oldest
exchanges, and fails only at the floor
(`packages/core/src/session/compaction.ts:94-95`,
`.../compaction.ts:441-447`, `.../compaction.ts:463-510`). tc uses a single
hand-tuned continuation budget with no geometric step-down and no defined floor.

## Goal

A graded shrink ladder for repair/continuation context: a target-size function plus
deterministic oldest-first reduction toward the target, with a defined give-up
instead of one fixed budget.

## Acceptance criteria

- [ ] A target-size function and a step-down ladder (e.g. 0.7 / 0.5 / 0.35)
      reduce continuation context oldest-first, keeping the pinned selection and
      the newest exchange; the floor fails with a fixed message.
- [ ] Unit tests cover the ladder steps, the keep-newest rule, and the floor.
- [ ] No regression on the json/sexp happy paths; live tc-side matrix; rows in
      `benchmark/results/consumption.md`.
- [ ] Guards, caps, and the single-edit protocol unchanged.

## Verification

```
bun test
bunx tsc --noEmit
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-tc-shrink.json --replay-dir tmp/replays-<name>
bun benchmark/check.ts
```

## Notes

- Parent: the #64 absorption umbrella.
- Non-goals: unified diffs; weakening guards; changing the budget cap semantics.
- Recon 2026-10-20: premise does not map to tc. Candidate 3 assumes an accumulated, growable continuation context ("dropping whole oldest exchanges") plus a size/overflow trigger. But tc rebuilds its message array from scratch on every call — `messages = [system, issue, {user: continuationPrompt}]` (`src/loop.ts:4274`; retry at `:4597`) — so there is no list of older exchanges to drop. Every context section is already independently bounded (`SPEC_FILE_LIMIT=8000` `:41`, `DIAGNOSTICS_LIMIT=4000` `:1786`, `DIGEST_MAX_CHARS=1200` `:1941`, `APPROACH_LIMIT=600` `:487`, `SELF_CHECK_OUTPUT_LIMIT=4000` `:1082`, plus the #71 history), and tc has no context-overflow signal to trigger a ladder (no overflow path at all — see #97). So a "target-size function + 0.7/0.5/0.35 ladder + floor" has neither a subject (no oldest exchange to shrink) nor a trigger; wired in isolation it would be dead code. The candidate is effectively coupled to #97, which is where an overflow trigger would first exist (its own Note says #97 "may share the shrink machinery with candidate 3"). Paused for a scope decision rather than implementing an untriggerable mechanism.
- Wontfix (2026-10-20): Premise does not map to tc: no accumulated/growable continuation context to shrink (messages are rebuilt every call, src/loop.ts:4274/:4597) and no context-overflow trigger (see #97), so a target-size ladder + floor would be dead code; coupled to #97's overflow path.
