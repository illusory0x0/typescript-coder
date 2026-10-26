---
id: 48
title: "Make the plan-exec executor choose whole-file writes by context"
status: todo
priority: medium
milestone: null
parent: 44
deps: [49]
labels: [agent-loop, edit-protocol]
created: 2026-10-26
---

## Context

Under the hints-based DAG model (#49), the planner no longer selects each edit's action; the executor sees the current source and decides whether to write a whole file, rewrite a declaration, or make a targeted edit. The current prompt is binary and gives the executor no usable decision procedure.

In the mini-spreadsheet pilots, whole-file writes of an existing ~839-line file dominated the budget: 21k–23k characters per write, 6k–7k completion tokens, and prompts growing to 20k–38k tokens. The one-rep pilot stopped at 127,438 cache-excluded loop tokens against the 120k budget after reaching 56/60 tests with `tsc` clean. The earlier five-rep runs also failed, so this is a strategy/cost issue rather than a single-run outlier.

The executor should carry a small, growing knowledge base of editing techniques rather than a single rule. Initial examples:

1. **Simple requirement / small file**: one whole-file write is often the cheapest and clearest.
2. **Large module**: write the exported types, signatures, and stub bodies first (whole-file or declaration creates), then fill implementations with fine-grained edits.
3. **Complex refactor**: introduce a parallel `xxV1` implementation, copy the original behavior, test it, switch call sites, then remove the old implementation; clean up last.

These are suggestions the executor may choose or ignore from the source; they are not gates. The planner may name one in an optional `approach` hint, but the executor owns the decision.

## Goal

Make the executor choose between whole-file writes, whole-declaration rewrites, and targeted edits from the current source, file size, and diff scope, with a non-blocking advisory for large or consecutive whole-file writes.

## Acceptance criteria

- [ ] The executor prompt contains a situation-aware decision guide: new file/skeleton; local edit in an existing file; several related declarations in one file; large declaration rewrite; whole-file rewrite; and recovery after a failed or unhelpful write. The guide distinguishes a small requirement where a whole-file write is reasonable from a large module where the executor should scaffold top-level declarations first and then fill bodies with finer edits.
- [ ] The executor prompt exposes a small, documented editing-techniques knowledge base (at least: simple-file whole write; large-module skeleton then fill; parallel `xxV1` refactor then swap and clean up), marked advisory. No technique is mandatory, and the executor may combine or ignore them based on the source.
- [ ] The planner's optional `approach` hint can name a technique or describe one, but the executor may override it; validation and review never require adherence.
- [ ] The guide preserves `write` as valid and never rejects an edit solely for its size or shape; it tells the executor to choose from the source it can see, not from a planner-selected action. A planner-provided `approach` hint is advice the executor may override.
- [ ] The review prompt uses the same criteria when a node gate fails; it repeats a whole-file write only when the diagnostics show broad structural breakage.
- [ ] The harness tracks whole-file writes to existing files and emits a non-blocking advisory on the next executor turn when the write is large or when the node writes the whole file again without an intervening targeted edit. The advisory names the observed size/coverage and suggests a targeted repair; it does not change records, status, gate results, or termination.
- [ ] The advisory does not fire for a new file's skeleton write or for a targeted declaration edit.
- [ ] Tests cover the prompt guide, advisory trigger and non-trigger cases, the targeted-repair path, and non-regression of the existing #46 post-edit `tsc` advisory.
- [ ] `docs/plan-exec.md` documents the decision rules and the advisory as guidance, not a hard gate.
- [ ] `just typecheck && just test` and `just accept` pass.

## Verification

```sh
bun test src/prompts/task.test.ts
bun test src/task-loop.test.ts
just typecheck && just test
just accept
git diff --check
```

A live mini-spreadsheet pilot is optional follow-up evidence, not part of this issue's acceptance; it requires explicit human approval.

## Notes

- Depends on #49: the executor only owns the action once the hints-based work DAG lands.
- Parent #44: this is the strategy/cost half of stabilizing the mini-spreadsheet plan-exec path.
- Use a relative size/coverage heuristic for the advisory, not a hard cap or a fixed step count; the advisory is guidance, not a policy gate.
- Keep the DAG/schema change out of this issue.
- Do not regenerate frozen baselines or spend live benchmark tokens without approval.
