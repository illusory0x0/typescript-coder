---
id: 44
title: "Stabilize plan-exec on mini-spreadsheet after guard and matcher changes"
status: in-progress
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
- Offline acceptance after #50/#52/#53/#54: #45/#46/#47 are done; just typecheck passes; just test 1619 pass; just accept 9/9 and just accept --all 10/10 including self-host pass; no frozen baseline changed. The remaining criterion is the human-approved controlled 5-rep mini-spreadsheet plan-exec pilot at 120k cache-excluded tokens. No live benchmark was run; awaiting explicit human approval.
- Approved live 5-rep run completed (2026-10-26): 0/5 passed, all five terminated on token-budget. Cache-excluded loop tokens: 213191, 130465, 121768, 122170, 136931 (mean 144905, min 121768, max 213191, total 724525). Steps: 37, 19, 31, 33, 33 (mean 30.6); durations: 348.9, 353.1, 343.3, 362.0, 152.1 s. Final judge: rep1 tsc fail + tests fail; rep2 tsc ok + tests fail; rep3 tsc ok + tests fail; rep4 tsc fail + tests fail; rep5 tsc ok + tests fail; fixtureOk 5/5. Protocol records show DSML/commentary syntax rejections, address mismatches, no-ops, viewers, and token-budget termination. Report: benchmark/results/2026-10-26.json and .md. No frozen baseline changed; no live command run outside this approved measurement. Offline checks remain green (typecheck, 1619 tests, accept 9/9). Holding #44 in review because the stabilization goal is not met at 0/5, even though the measurement criterion is complete.
- Triage of the 5-rep report (2026-10-26): 120 exchange turns, 33 applied, 69 rejected (43 protocol, 15 address, 3 no-op, 2 matcher), 18 viewer-only; all 5 terminated on token-budget; tsc 3/5, tests 0/5. Protocol breakdown: 20 DSML/tool-call preambles, 12 prose preambles, 5 missing end, 5 inline-fence warnings, 1 matcher-missing. Address breakdown: 7 whole-declaration replacements containing multiple declarations, 6 create target/fence mismatches, 2 declaration-kind mismatches. Applied edits: 33, of which 8 were >5k chars and 5 >10k; 137,826 replacement chars total. Telemetry gap: plan-exec records report 0 selectors/stages/creates and payloads are hardcoded to 1 despite 33 applied edits. Root causes: (1) the executor contract is not binding the model to edit-dsl, so it emits DSML/tool-call/prose; (2) whole-declaration and create-mismatch feedback does not point to write/create remediation; (3) viewer-only replies are deliberately excluded from the repeated/no-progress fingerprint, allowing 18 inspection-only turns; (4) task-loop records do not populate edit-dsl selector/stage/create metadata; (5) the functional-style no-new-class directive conflicts with the spec-mandated Workbook class. Proposed offline sequence: P0 strict executor response contract + safe prose-preamble trim (never guess DSML) + targeted protocol diagnostics; P0 actionable write/create/kind remediation in the shape/create guards; P1 viewer-only no-progress fingerprint; P1 populate selector/stage/matcher/create/payload telemetry; P2 conditional class-style guidance; add focused tests and rerun typecheck/test/accept. Then request approval for a one-rep smoke, and only after that a fresh 5-rep measurement. No live run until approved.
- Implemented the approved offline P0+P1 fixes: explicit no-tools/no-DSML executor output contract; safe single-prose-preamble recovery; EDIT_DSML_UNSUPPORTED diagnostic without parsing DSML; write/create/kind remediation in address/create failures; identical viewer/read no-progress fingerprint; and real plan-exec selectors/stages/matcherKinds/creates/payloads telemetry. Verified: just typecheck; just test 1632 pass/0 fail; just accept 9/9; just accept --all 10/10; git diff --check. No live run after these fixes; #44 remains in-progress pending a smoke and the next 5-rep measurement.
- P0+P1 1-rep smoke (approved): 0/1; 121401 cache-excluded loop tokens (budget 120000, +1401), 35 steps, 189.6s, $0.03133; tsc ok, tests fail. Protocol: 4 (DSML-specific diagnostic 1, malformed fence 1, missing field 1, inline fence 1), viewer-only 8, payloads 80, creates 53, whole-symbol 61. Protocol rejection rate is much lower than the prior 5-rep (4 in 26 turns vs 43 in 120), and telemetry is now non-zero, but the smoke still exceeds budget and tests fail. No 5-rep run; #44 remains in-progress. Report: benchmark/results/pilot-2026-10-26-p0p1-smoke.json/.md; no baseline change.
- Second-pass no-op salvage implemented: partition edit-dsl failures into inert no-op and fatal; ignore inert clauses only when another region/create/delete/write applies; all-inert replies still reject; any non-no-op failure keeps whole-reply atomicity; ignored clauses surface a warning and are excluded from applied telemetry. Updated docs and tests (including the old pinned-repair no-op test). Verified: just typecheck; just test 1640 pass/0 fail; just accept 9/9; just accept --all 10/10; git diff --check. No live run after this change; #44 remains in-progress pending smoke.
