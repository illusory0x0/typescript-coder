---
id: 58
title: "Fix plan terminator retries"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-27
---

## Context

The P1 plan-exec protocol rewrite removed `finish` and the explicit sentence "The Plan header has no `end`." In a 5-rep `minilisp` diagnostic, 4 of 5 runs needed a plan retry and one failed outright: the planner emitted `</plan>` after a complete node, the parser rejected it with `PLAN_UNKNOWN_FIELD`, and the model repeated the same reply until `task-exhausted` (0 execution calls). Other runs retried after a stray extra `end`.

Replays: `tmp/replay-minilisp-new/minilisp-tc-plan-exec-rep1.json` (failure), `tmp/replay-minilisp-new/minilisp-tc-plan-exec-rep2.json` and `.../rep4.json` (extra `end`/`</plan>` retries). The prompt is `src/prompts/task.ts`; the parser is `src/plan-dsl.ts`.

## Goal

A trailing `end` or `</plan>` after an otherwise complete plan is accepted with a warning, the planner prompt forbids inventing a terminator, and the minilisp 5-rep diagnostic returns 5/5 with one planning call per run.

## Acceptance criteria

- [ ] The planner prompt states that the `plan` header and its `goal:` line have no terminator and that the planner must never write `end` or `</plan>` after them; only `node`/`amend` records end with `end`.
- [ ] The parser accepts exactly one trailing `end` or `</plan>` at EOF after a complete reply and records a `PLAN_STRAY_TERMINATOR` warning; a stray `end` in the middle of a reply still fails as before.
- [ ] `src/plan-dsl.test.ts` covers trailing `end`, trailing `</plan>`, a mid-reply stray `end`, and a repeated invalid reply; `just typecheck && just test` pass.
- [ ] `just accept` passes; the existing plan-exec fixtures still parse.
- [ ] A human-gated `minilisp` 5-rep run with `--agent-mode plan-exec` passes 5/5 and shows one planning call per run, or the remaining retries are explained in the issue notes.

## Verification

```
just typecheck && just test
just accept
bun run benchmark/run.ts --task minilisp --side tc --agent-mode plan-exec --reps 5 --keep --replay-dir tmp/replay-minilisp-terminator
```

The last command calls the real model and costs money; ask the human before running it and do not commit the generated report.

## Notes

- Do not reintroduce `finish` or a plan-root id.
- The tolerance is only for a single trailing closer at EOF; it must not guess a missing node boundary.
- A repeated invalid reply still terminates `task-exhausted`.
- Discovered during the 2026-10-27 minilisp diagnostic; the full 4×5 matrix was 20/20, so this is a small-sample regression rather than a universal failure.
