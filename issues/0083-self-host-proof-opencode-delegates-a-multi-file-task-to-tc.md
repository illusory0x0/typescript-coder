---
id: 83
title: "Self-host proof: opencode delegates a multi-file task to tc"
status: in-progress
priority: medium
milestone: null
parent: 79
deps: [81, 82]
labels: [integration, acceptance]
created: 2026-10-20
---

## Context

The sub-agent contract is only proven end to end by using it on real work.

## Goal

In an isolated git worktree + branch, `opencode` delegates one small multi-file
task to `tc` via the documented recipe; `tc` verifies; the repository gates stay
green; a human reviews the diff.

## Acceptance criteria

- [ ] a real multi-file task is delegated from `opencode` to `tc` inside a git
      worktree/branch.
- [ ] the resulting diff is reviewed and lands with `bunx tsc --noEmit` 0,
      `bun test` pass, `bun run accept` 5/5, `bun benchmark/check.ts` PASS.
- [ ] the run's cost/tokens are recorded (delegated vs direct).
- [ ] the parked #77 change is reconciled before this step (kept+committed or
      stashed) so the tree is clean.

## Verification

The worktree's gates; the recorded result JSON; the diff review.

## Notes

- Depends on C2, C3. Uses the worktree tooling.
