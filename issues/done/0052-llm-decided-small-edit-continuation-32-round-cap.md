---
id: 52
title: "LLM-decided small-edit continuation, 32-round cap"
status: done
priority: medium
milestone: null
parent: 46
deps: []
labels: [harness]
created: 2026-10-18
---

## Context

Deep cause from the #48 live rounds: minilisp repairs need many chained small
edits, but a Run iteration that burns its 3 exchanges hard-kills the run
(`edit-exhausted`) without asking the model, and the run has no round cap (only
the 120k token budget). Round-2 evidence: runs applied edits across ~10 rounds
and died on the final exhausted round even though the model's own summary named
the correct remaining fix. User directive (2026-10-18, chosen form): the LLM
itself evaluates whether to continue small edits, round-level continuation,
hard maximum 32 total Run iterations.

## Goal

When a Run iteration exhausts its 3-exchange budget, the run no longer fails
outright: the harness offers continuation, a valid edit opens the next round
(counted), an explicit STOP ends the run through the existing failure chain, and
32 total Run iterations is the hard cap.

## Acceptance criteria

- [ ] At the would-be `edit-exhausted` point (3 exchanges rejected in a round), if fewer than 32 rounds are used, the loop sends a continuation prompt that shows the current source and diagnostics and states the exhausted round, the rounds used of 32, and that replying `STOP` ends the run; any non-STOP reply is processed as the first exchange of a new round (fresh ≤3 budget), so a valid edit continues normally.
- [ ] A reply whose trimmed text equals `STOP` (case-insensitive) terminates through the existing failure chain: termination diagnostics, exactly one summary call, failure artifact, exit.
- [ ] Total Run iterations are capped at 32 (continuation rounds and ordinary verification-repair rounds both count); reaching 32 without success terminates with diagnostics naming the cap, through the same chain.
- [ ] Continuation exchanges and STOP replies are recorded in the run records with a distinguishable outcome, so replay bundles/reports keep the history.
- [ ] The token budget (default 120k) remains the outer hard cap and is unchanged.
- [ ] Unit tests cover: exhaustion → continuation prompt with counts → valid edit opens a new round and the run can pass; STOP → terminate with one summary; 32nd round → terminate naming the cap; a byte-identical resend at the continuation is still rejected by the `stage: repeat` guard (round 3) and the following STOP ends the run.
- [ ] `spec.md` (round/budget vocabulary, prompts) and `docs/glossary.md` updated; gates: tsc 0 / all tests / accept 5/5 / benchmark check 3 PASS.
- [ ] Live evidence: the next ts-side minilisp matrix is inspected via its replay bundles for continuation events (recorded in Notes); json/sexp show no regressions.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
bun benchmark/check.ts
```

## Notes

- Parent #46. Ordering: implemented after #48 round-3 released src/loop.ts;
  interacts with the `stage: repeat` guard (a repeat at the continuation prompt
  counts as a rejected exchange of the new round).
- The continuation prompt reuses the retry-prompt shape (source + diagnostics)
  plus the STOP/rounds framing; exact wording decided at implementation review.
- Implementation reviewed by the main agent (2026-10-18): round-exhaustion
  continuation for both the pick and content paths, `STOP` honored only as the
  first-exchange reply to a continuation prompt, `stopped` record rows, and the
  32-round cap wired at the loop sites; out-of-fence test adaptations
  (src/cli.test.ts, acceptance/scenarios.ts) are minimal wording/flow updates
  required by the new continuation prompts. Gates re-run green by the main
  agent: tsc 0 / 575 tests / accept 5/5 / benchmark check 3 PASS.
- Live evidence (2026-10-18, `benchmark/results/2026-10-18-ts-continuation.json`,
  replays `tmp/replays-52-continuation/`): minilisp 2/3 — 13,447 tokens pass,
  127,314 tokens token-budget failure, 23,238 tokens pass; json 3/3 (4,649 mean
  tokens per success) and sexp 3/3 (2,971 mean) show no success regressions and
  move within run noise (+3.5% / +5.4%); overall 8/9 at 23,357.
- Replay inspection: zero continuation events in all nine runs. Every round
  applied an edit within its budget (the failing run: 30 exchanges = 1
  selection + 28 applied edits + 1 duplicate rejection, then 28 verification
  failures), so no round exhausted its 3 exchanges and the continuation prompt
  was never sent; the continuation/STOP/cap paths are covered by the
  deterministic unit tests instead. The failing run burned 28 rounds of
  applied-but-failing edits and died on the 120k token budget (122,211
  accumulated; failure artifact
  `failures/2026-10-18T12-58-14-470Z-token-budget.md`) — behavior that
  pre-dates #52 (no exhaustion involved) and motivated the no-progress decision
  point filed as #54.
