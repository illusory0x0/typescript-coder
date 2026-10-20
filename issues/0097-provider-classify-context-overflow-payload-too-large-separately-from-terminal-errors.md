---
id: 97
title: "Provider: classify context-overflow / payload-too-large separately from terminal errors"
status: todo
priority: low
milestone: null
parent: 91
deps: []
labels: [provider, agent-loop]
created: 2026-10-20
---

## Context

#64 absorption candidate 5 (sibling of #74, the provider retry family). opencode2
classifies provider errors with typed categories including `context-overflow` and
`payload-too-large`, distinct from retryable errors, and recovers by compacting /
resending
(`packages/ai/src/provider-error.ts:66-75`, `.../provider-error.ts:252-258`,
`.../session/compaction.ts:434-458`). tc has **no context-overflow path at all**: a
provider "too long" reply ends the run.

## Goal

Classify a provider context-overflow / payload-too-large reply separately from
terminal errors and recover (reduce context and retry, or end through a defined
summary path) instead of failing outright.

## Acceptance criteria

- [ ] `src/openai.ts` classifies context-overflow / payload-too-large separately
      from terminal and retryable errors.
- [ ] The harness recovers on that classification (shrink/trim and retry, bounded)
      or terminates through a defined summary; unit tests cover both.
- [ ] No regression on the happy paths; live evidence; rows in
      `benchmark/results/consumption.md`.
- [ ] Guards and caps unchanged.

## Verification

```
bun test
bunx tsc --noEmit
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-tc-overflow.json --replay-dir tmp/replays-<name>
bun benchmark/check.ts
```

## Notes

- Parent: the #64 absorption umbrella.
- Sibling of #74 (provider timeouts); #39 (429/5xx backoff) is done.
- May share the shrink machinery with candidate 3 (repair-context ladder); note
  the dependency if it lands first.
- Non-goals: hard caps; auto-stop.
