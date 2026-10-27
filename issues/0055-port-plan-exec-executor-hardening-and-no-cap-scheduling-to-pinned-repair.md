---
id: 55
title: "Port plan-exec executor hardening and no-cap scheduling to pinned-repair"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop]
created: 2026-10-27
---

## Context

The plan-exec path has accumulated executor hardening: an explicit no-tools/no-DSML output contract, soft scaffold/whole-file guidance, shared prose/DSML diagnostics, no-op salvage, and real selector telemetry. The pinned-repair path is the simpler, default single-target loop and is closer to a ReAct-style agent, but it still carries legacy fixed exchange/round caps and an older prompt that does not state the no-tools boundary.

The goal is not to copy the WorkNode DAG into pinned-repair. It is to reuse the portable executor hardening and replace the arbitrary exchange/round limits with the token budget plus existing no-progress fingerprints.

## Goal

Make pinned-repair use the portable executor hardening from plan-exec and terminate on token budget/no-progress rather than fixed exchange/round caps.

## Acceptance criteria

- [ ] The pinned-repair prompt has the explicit no-tools/no-DSML/literal-sentinel output contract and the soft new-file scaffold/whole-file guidance.
- [ ] Pinned-repair has no fixed `MAX_EDIT_EXCHANGES` or `MAX_RUN_ITERATIONS` hard termination; token budget, repeated fingerprints, and the existing no-progress milestones end a failed run.
- [ ] Correctness guards stay hard: edit-dsl parse, path safety, atomic apply, one-declaration claims, and rename rules.
- [ ] Plan-specific machinery (WorkNode DAG, final-test-node validation, early test checkpoint) is not imposed on pinned-repair.
- [ ] `just typecheck && just test` and `just accept` pass; no frozen baseline or historical result JSON changes.
- [ ] Any live pinned-repair smoke is human-gated and runs only after explicit approval.

## Verification

```sh
just typecheck && just test
just accept
git diff --check
```

After implementation, a controlled pinned-repair 1-rep smoke can be requested separately; it must not run unprompted.

## Notes

- Historical pinned-repair data: 0/5 at mean 56,523 cache-excluded tokens (2026-10-25); this umbrella is about architecture/termination and prompt parity, not a success guarantee.
- Plan-exec remains the multi-file/long-horizon path; do not add plan graph invariants to pinned-repair.
- `MAX_STALLED_ROUNDS` is a no-progress ask cadence, not a hard exchange/round cap. `MAX_CONSECUTIVE_LENGTH` is an output-length guard and may remain.
