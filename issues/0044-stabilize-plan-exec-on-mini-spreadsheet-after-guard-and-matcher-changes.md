---
id: 44
title: "Stabilize plan-exec on mini-spreadsheet after guard and matcher changes"
status: todo
priority: medium
milestone: null
parent: null
deps: [47]
labels: [agent-loop, benchmark, edit-protocol]
created: 2026-10-26
---

## Context

The `mini-spreadsheet` plan-exec path is still failing after the bounded viewer,
inline-fence tolerance, declaration shape guard, advisory tsc, and matcher-help
changes.

The latest pilot (`benchmark/results/2026-10-25-mini-spreadsheet-plan-exec-after-matcher-help.json`)
ran 50 steps, stopped at **120,803 cache-excluded tokens**, produced an 839-line
file, and failed tsc with missing `isValidAddress` and an arity mismatch. The
prior post-guard pilot (`...after-guard.json`) also failed. The frozen oc
baseline remains **5/5 at a mean 55,197 cache-excluded tokens**, max **73,745**.

This umbrella tracks the remaining issues needed before the plan-exec result is
stable enough to judge.

## Goal

Make mini-spreadsheet plan-exec failures attributable to implementation quality
or explicit protocol behavior, not avoidable matcher retries, unobserved large
edits, or misleading token accounting.

## Acceptance criteria

- [ ] #45, #46, and #47 are complete.
- [ ] A controlled 5-rep mini-spreadsheet plan-exec pilot at 120k cache-excluded
      is run with human approval and records success rate, token distribution,
      protocol/termination reasons, and the final tsc/test state.
- [ ] No frozen baseline file is changed.
- [ ] The final report is not treated as a success from a single rep.
- [ ] `just typecheck && just test` and `just accept` pass for the implementation
      changes.

## Verification

```sh
just typecheck && just test
just accept
bun run benchmark/run.ts --task mini-spreadsheet --side tc \
  --agent-mode plan-exec --pilot --token-budget 120000
```

The live command is human-gated and must not run unprompted.

## Notes

The oc comparison is a reference point, not a target contract: 5/5 at mean
55,197 cache-excluded. The plan-exec implementation still has different
retry/protocol costs. The controlled pilot is for stability measurement, not a
baseline re-freeze.
- Offline preconditions are complete: #45, #46 and #47 are done; just typecheck and just test (1503 pass), plus fast just accept (9/9), passed after #47. Remaining acceptance item is the human-approved controlled 5-rep mini-spreadsheet plan-exec pilot at 120k cache-excluded tokens; it has not been run and no baseline was changed.
