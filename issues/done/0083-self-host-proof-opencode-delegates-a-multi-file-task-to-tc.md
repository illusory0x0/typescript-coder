---
id: 83
title: "Self-host proof: opencode delegates a multi-file task to tc"
status: done
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
- Self-host proof. Isolated worktree (branch selfhost-83) at HEAD; wrote tmp/targets83.json naming two {path,symbol,kind} targets and invoked 'bun run src/main.ts --format json --cwd <worktree> --targets tmp/targets83.json --timeout 600000' with the task on stdin, per docs/subagent.md. tc applied both targets in one run: src/cli.ts readTargetsFile rejects a duplicate {path,symbol,kind}; src/loop.ts validateTargetsReply requires each payload to address an active pending target. Result JSON: status ok, verified true, files [readTargetsFile, validateTargetsReply], tokens input 121686 / output 1400 / total 123086 / cacheRead 72320 (~$0.017 peak, ~$0.0085 off-peak), exit 0. Diff normalized to drop oxfmt reflows of unrelated lines, reviewed, committed d401366 and fast-forwarded into master. Worktree gates: bunx tsc --noEmit clean; bun test 853 pass; bun run accept 5/5; bun benchmark/check.ts 4 passed/0 failed. The first three attempts could not reach verified:true because tc's verification command was killed at the tools 120s default (this repo's bun test is ~183s); that gap was filed and fixed as #85 (--timeout).
