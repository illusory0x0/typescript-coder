---
id: 54
title: "No-progress decision point: offer STOP after consecutive failed verification rounds"
status: done
priority: medium
milestone: null
parent: 46
deps: [52]
labels: [harness]
created: 2026-10-18
---

## Context

The 2026-10-18 post-#52 matrix (`benchmark/results/2026-10-18-ts-continuation.json`)
exposed the second place where a run can burn with no decision point: minilisp
rep2 applied 28 consecutive valid edits across 28 rounds, verification failed
after every one (the failure oscillated between two error families, ≈2/16/29
diagnostics), and the run died on the 120k token budget at 127,314 tokens — 58
records (30 exchanges, 28 verifications), one duplicate rejection, and zero #52
continuation events, because every round produced an applied edit and no round
ever exhausted its 3-exchange budget. Healthy repair chains stay far below that:
the longest successful streak across the repin3 and continuation matrices was 6
consecutive failed rounds (repin3 rep3, 34,963 tokens), the most expensive
success was ~35k tokens, and the most expensive pass overall ~35k. The token
budget is currently the only bound on a repair storm, and a storm costs 3-4x
any observed successful run.

## Goal

When a run has MAX_STALLED_ROUNDS (8) consecutive verification-failed rounds,
the opening exchange of the next round asks the model to decide — reply STOP to
end the run through the existing failure chain, or continue with a materially
different edit — recurring at each further multiple of 8, with every hard cap
unchanged.

## Acceptance criteria

- [ ] src/loop.ts exports `MAX_STALLED_ROUNDS = 8` and tracks a stalled-round
      count that increments on every failed verification and survives rounds
      and #52 continuations; it is only consumed while the run has not passed.
- [ ] When a round opens with a verification failure, a pinned target, no
      pending round-continuation, and a stalled count that is a positive
      multiple of MAX_STALLED_ROUNDS, the round's first content prompt keeps the
      retry shape (instruction, pinned selection, current source, diagnostics)
      but replaces the exchange header with a no-progress framing that states
      the number of consecutive failed rounds and the current round (N of 32),
      offers `STOP` to end the run, and asks for a materially different
      approach; the wording biases continuing (STOP only when the failures
      cannot be resolved), stays concise, and names concrete alternative
      actions (for example: change the matcher shape, re-pin to a declaration
      the diagnostics name, or restructure the declaration) instead of vague
      advice.
- [ ] `STOP` (trimmed, case-insensitive) is honored only at that prompt's first
      exchange and terminates through the existing chain: exactly one summary
      call, a `stopped` exchange row whose diagnostics name the
      consecutive-failed-round reason (distinct from #52's exhausted-round STOP
      text), failure artifact, exit with `terminationReason: "edit-exhausted"`.
      A non-STOP reply is processed as a normal first exchange.
- [ ] The ask recurs at multiples (8, 16, 24, …) with the count updated;
      ordinary retry prompts at other rounds are unchanged; a round that opens
      through a #52 continuation prompt does not also carry the no-progress
      framing (the continuation already offers STOP).
- [ ] Guards keep precedence at the ask exchange (byte-identical resubmission
      is still `stage: repeat`) and the token budget, MAX_RUN_ITERATIONS, and
      MAX_EDIT_EXCHANGES semantics are unchanged.
- [ ] Unit tests cover: the ask firing at streak 8 with the prompt content
      asserted and the run passing when the model continues; STOP at the ask
      terminating with one summary and the `stopped` row; recurrence at 16 with
      the updated count; no ask at streaks 1-7 or on rounds not opened by a
      verification failure; a repeat rejected at the ask; a #52 continuation
      round without stall framing.
- [ ] `spec.md` and `docs/glossary.md` updated; gates: `bunx tsc --noEmit` 0,
      `bun test` all pass, `bun run accept` 5/5, `bun benchmark/check.ts`
      3 PASS.
- [ ] Live evidence: the next ts-side minilisp matrix is inspected via its
      replay bundles for no-progress ask events (recorded in Notes; zero events
      acceptable when no streak reaches 8, with the streak maximum reported).

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
bun benchmark/check.ts
```

plus reading the next matrix's report and replay bundles for ask events.

## Notes

- Parent #46. Builds on #52 (continuation prompt, STOP gating, `stopped` row);
  reference implementation points: `buildContinuationPrompt` (src/loop.ts:350),
  STOP gates (src/loop.ts:2012, 2183), `stopRun` (src/loop.ts:1867),
  `stoppedDiagnostics` (src/loop.ts:1737).
- Threshold rationale: 8 > the observed healthy maximum (6 consecutive failed
  rounds); the storm reached 28. A signature-based trigger (same diagnostic
  count) was rejected because the storm's counts oscillated (≈2/16/29), so only
  the raw consecutive-failed-round streak is stable.
- STOP-temptation risk on long-but-converging runs is the main review point;
  the wording bias and the unit test that the ask can be continued through are
  the mitigations.
- Non-goals: no token-budget / round-cap / exchange-budget changes; no changes
  to selection failure handling; no benchmark-flag additions.

## Notes (implementation, 2026-10-19)

- Landed: `MAX_STALLED_ROUNDS = 8` (src/loop.ts:622), run-scope `stalledRounds`
  incremented at every failed verification (src/loop.ts:2589), `stalledAsk` at
  the round top (src/loop.ts:1992-1997), the no-progress framing in
  `buildRetryPrompt` (src/loop.ts:300-324), the ask's STOP gate
  (src/loop.ts:2278-2287), `stalledStopDiagnostics` (src/loop.ts:1770); tests
  src/loop.test.ts:1477-1703 (ask at 8 and 16, STOP exit with one summary,
  below-threshold / soft-failure / #52-continuation exclusions, repeat
  precedence); spec.md:206-218 + docs/glossary.md:39-51.
- Local gates re-run by the main agent: `bunx tsc --noEmit` 0, 585 tests pass,
  accept 5/5, benchmark-check 3 PASS.
- Live evidence (2026-10-19 matrix, `benchmark/results/2026-10-19-ts.json`,
  bundles `tmp/replays-59-final/`): zero no-progress ask events fired. The
  per-rep streaks of consecutive failed verification rounds were 7 / 3 / 4
  (maximum 7, below the 8 threshold) — this criterion accepts zero events with
  the streak maximum reported. The runs' decision points came from the #52
  continuations (6 / 2 / 7 prompts, each carrying the #57 digest and the STOP
  offer). Observation filed to #60: rejection-exhausted rounds do not accrue
  `stalledRounds`, so the ask cannot fire in the residual rejection-cycle
  storms.
