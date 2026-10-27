---
id: 62
title: "Document, accept, and benchmark slice gates"
status: todo
priority: medium
milestone: null
parent: 59
deps: [58, 60, 61]
labels: [agent-loop, benchmark, docs]
created: 2026-10-27
---

## Context

The slice-gate feature is only useful if the planner actually plans slices and the benchmark shows an effect. The benchmark fixtures are single-file tests; `bun test -t` is therefore the only useful selector. The held-out `csv-parser` is reported but never used to tune the prompt.

## Goal

Slice gates are documented, covered by offline acceptance, and measured on minilisp and the 4×5 matrix without regressing the held-out task.

## Acceptance criteria

- [ ] `docs/plan-exec.md` documents `test-filter`, filtered vs full-suite completion, the final unfiltered test, and the custom test-command contract.
- [ ] `docs/glossary.yaml` and any affected `feedback-loop.md` references match the new model.
- [ ] An offline acceptance scenario exercises a filtered gate and a final full test; `just accept` passes.
- [ ] A human-gated minilisp 5-rep run compares monolith, contract-only, and sliced plans for success, planning/execution turns, and USD.
- [ ] A human-gated full 4×5 run records the result; `csv-parser` is reported but not used for tuning.
- [ ] The issue notes state whether slices reduced execution retries or were a negative result; do not claim a win from a single run.

## Verification

```
just typecheck && just test
just accept
# human-gated:
bun run benchmark/run.ts --task minilisp --side tc --agent-mode plan-exec --reps 5 --keep
bun run benchmark/run.ts --all --side tc --agent-mode plan-exec --reps 5 --keep
```

## Notes

- Depends on the terminator-recovery issue and the slice-gate parser/gate/completion and planner-prompt issues.
- Benchmark artifacts are generated; do not commit them unless the human asks.
- `csv-parser` is held out; a sliced plan must not be tuned to its test names.
- Report a negative result if slices increase turns/cost without reducing retries.
