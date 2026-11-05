---
id: 59
title: "Add slice-level test gates to plan-exec"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop, edit-protocol, benchmark]
created: 2026-10-27
---

## Context

`WorkNode.verify` is `tsc | test`. A `test` gate always runs the configured whole test command, so a parser/evaluator/builtins split cannot be independently verified: every behavioral node must wait for the entire suite. In the current minilisp 5-rep diagnostic, four of five plans chose one monolithic `02-impl`; the single `02-contract` → `03-impl` split did not reduce execution retries (8 vs 8–9). Bun 1.3.13 supports `bun test -t <regex>` and file filters; `-t` with zero matches exits 1.

This umbrella covers a minimal slice gate: a WorkNode may run a test subset, but run completion still requires an unfiltered full-suite test.

## Goal

A plan-exec node can verify a named test slice, the planner can plan independently verifiable slices for greenfield multi-behavior modules, and a filtered green gate can never complete the run by itself.

## Acceptance criteria

- [ ] The Plan DSL and WorkNode model carry an optional test filter; parser, serializer, and validation are complete.
- [ ] A filtered `test` node runs the check command and the filtered tests; no-match fails; the custom `testCommand` contract is documented.
- [ ] `lastGate` distinguishes filtered from full-suite tests, and `runComplete` requires a full-suite test gate.
- [ ] The planner prompt teaches the filter, when to use it, and the mandatory final unfiltered `test` node.
- [ ] Docs, acceptance, and benchmark evidence are updated; the held-out `csv-parser` is reported but not used to tune the prompt.
- [ ] Every child issue is done or wontfix.

## Verification

```
just typecheck && just test
just accept
```

A targeted minilisp slice run and the 4×5 matrix are human-gated; ask before running them.

## Notes

- `bun test -t` is a regex over test names; positional arguments filter test files, which does not slice these single-file fixtures.
- No prompt tuning against `csv-parser`; it is the held-out task.
- The umbrella is additive; the existing `verify tsc` and unfiltered `verify test` behavior stay unchanged.
- Slicing is optional: a cohesive small task stays one node.
- Verification 2026-11-05: `just typecheck && just test` passes (editor 804, harness 702, scripts 15, acceptance 9); `just accept` passes 9/9 offline scenarios including `plan-exec-slice-gate`. Parser/serializer/validation carry `testFilter` (`harness/src/plan-dsl.ts`, `harness/src/tasks.ts`); filtered gates run the check plus `-t <regex>`, no-match fails (`harness/src/task-loop.ts`); `lastGate.fullSuite` gates completion (`harness/src/tasks.ts`); the planner prompt teaches slices and the mandatory final unfiltered test (`harness/src/prompts/task.ts`). #62 supplies docs, acceptance, and benchmark evidence; minilisp replay 5/5 with 0 sliced plans (negative adoption result), full 4x5 19/20 with held-out csv 5/5. Children #60, #61, #62 are done.
