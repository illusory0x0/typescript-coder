---
id: 57
title: "Remove fixed exchange and round caps from pinned-repair"
status: todo
priority: medium
milestone: null
parent: 55
deps: [56]
labels: [agent-loop]
created: 2026-10-27
---

## Context

Pinned-repair still terminates through fixed caps: `MAX_EDIT_EXCHANGES = 3` and `MAX_RUN_ITERATIONS = 32`. The project contract says there should be no arbitrary finite caps for viewer/exchange/review/round/node counts; termination should use the token budget plus repeated/no-progress fingerprints. Plan-exec has already moved to that model.

Removing the fixed caps is a scheduling and prompt change, not a style change. The hard correctness guards — parse gate, path safety, atomic writes, one-declaration claims, rename rules — stay.

## Goal

Replace pinned-repair's fixed exchange/round termination with token-budget and no-progress termination, while preserving correctness guards and the existing no-progress decision points.

## Acceptance criteria

- [ ] Pinned-repair no longer hard-terminates solely because it reached 3 exchanges in a round or 32 rounds.
- [ ] The token budget and existing repeated/no-progress fingerprints are the termination path for failed loops; `MAX_STALLED_ROUNDS` may remain as a no-progress ask cadence, not a hard cap.
- [ ] The pinned system prompt and continuation/diagnostic text no longer promise "3 exchanges" or "32 rounds"; they describe budget/no-progress termination.
- [ ] Correctness behavior is unchanged: edit-dsl parsing, path safety, atomic apply, one-declaration target claims, and rename rules.
- [ ] `MAX_CONSECUTIVE_LENGTH` may remain as an output-length guard; it is not an exchange/round cap. State this in the implementation notes.
- [ ] Tests cover: a long failed round is not cut at the old exchange count; a long run is not cut at the old round count; token budget still stops; repeated/no-progress still stops; ordinary successful edits still work.
- [ ] No live benchmark and no frozen baseline change.

## Verification

```sh
bun test src/loop.test.ts
bun test src/prompts/parity.test.ts
just typecheck && just test
just accept
git diff --check
```

## Notes

- Depends on the pinned prompt/contract child to avoid conflicting edits in `src/prompts/edit-dsl.ts`.
- Do not import the plan-exec WorkNode DAG, final-test-node validation, or early test checkpoint into pinned-repair.
- A controlled pinned-repair smoke is human-gated and not part of this issue's offline closure.
