---
id: 48
title: "Make plan-exec choose whole-file writes by context"
status: todo
priority: medium
milestone: null
parent: 44
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-26
---

## Context

The mini-spreadsheet plan-exec pilot repeatedly rewrote `src/workbook.ts` as a whole file: several writes of 21k–23k characters, 6k–7k completion tokens each, with prompts growing to 20k–38k tokens. The run stopped at 127,438 cache-excluded loop tokens against the 120k budget after reaching 56/60 tests with `tsc` clean. The current prompt only says to use `write` for an explicit file-level replacement and otherwise prefer the smallest declaration edit; that binary rule does not tell the planner when a whole-file write is actually justified, and the executor gets no non-blocking feedback after a large write.

The one-rep pilot was run on 2026-10-26 with `bun run benchmark/run.ts --task mini-spreadsheet --side tc --agent-mode plan-exec --pilot --token-budget 120000`; its generated report is not committed (per the benchmark artifact policy). The earlier five-rep mini-spreadsheet runs (`benchmark/results/2026-10-25-mini-spreadsheet-tc-5rep*.json`) also failed, so this is a strategy/cost issue rather than a single-run outlier.

## Goal

Make plan-exec choose between whole-file writes, whole-declaration rewrites, and targeted declaration edits from file size and diff scope, with a non-blocking advisory that corrects repeated or oversized writes.

## Acceptance criteria

- [ ] The planner prompt contains a situation-aware decision guide: new file/skeleton; local edit in an existing file; multiple declarations in one file; large declaration rewrite; whole-file rewrite; and recovery after a failed write.
- [ ] The executor prompt applies the same criteria when choosing `match`/`pick` versus a whole-declaration rewrite, and after a failed or unhelpful large write prefers a targeted repair.
- [ ] The review prompt uses the same criteria when patching a failed task; it repeats a whole-file write only when the diagnostics show broad structural breakage.
- [ ] The guidance preserves `write` as valid and never rejects an edit solely for its size or shape.
- [ ] The harness tracks whole-file writes to existing files and emits a non-blocking advisory on the next edit turn when the write is large or when the same task writes the whole file twice in a row. The advisory names the observed size/coverage and suggests a targeted repair; it does not change records, status, gate results, or termination.
- [ ] The advisory does not fire for a new file's skeleton write or for a targeted `modify`/`create`/`delete`/`rename` edit.
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

- Parent #44: this is the strategy/cost half of stabilizing the mini-spreadsheet plan-exec path.
- Keep the DAG change out of this issue; the plan model is tracked separately.
- Choose one documented soft threshold (for example, an existing file over N lines whose write covers more than a stated share of it) and test it; the threshold is guidance, not a policy gate.
- Do not regenerate frozen baselines or spend live benchmark tokens without approval.
