---
id: 59
title: "Add slice-level test gates to plan-exec"
status: todo
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
