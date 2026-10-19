---
id: 60
title: "Repair rejection-cycle storms: count rejection-exhausted rounds toward the no-progress decision point"
status: done
priority: medium
milestone: null
parent: 46
deps: []
labels: [harness]
created: 2026-10-19
---

## Context

The 2026-10-19 post-#59 matrix (`benchmark/results/2026-10-19-ts.json`): json
4,587 (3/3), sexp 2,965 (3/3), minilisp 2/3 raw 126,454 — totals 89,716
(success), 36,370 (success), 126,822 (token-budget). The applied-no-op class is
gone (#59: 18 live `no-op` rejections, zero applied or verified no-ops); the
residual is the model cycling a small set of already-rejected payloads while
each guard rejects it:

- rep1 (success, 89,716 tokens, 38 steps): 13 `repeat` + 5 `duplicate` + 3
  `no-op` rejections; rows 10-32 cycle a duplicate `isSymbolValue` addition, a
  no-op rewrite, and resends of both, before real edits converge.
- rep3 (failure, token-budget, 34 steps): 10 `no-op` + 9 `matcher-not-found`
  (the same stale matcher at `run` (line 263, col 8)) + 6 `repeat`; eight rounds
  cycle the same three payloads.
- rep2 (success, 36,370): the short version (5 `no-op` + 1 `duplicate`).

The #56 corrections, #57 digests (6/2/7 `Prior attempts` renders, 18/2/23
ruled-out lines) and STOP offers were in context; the model continued. #54's
no-progress ask fired zero times because `stalledRounds` counts failed
verifications only (streaks 7/3/4), so rejection-exhausted rounds — the dominant
no-progress shape — never reach the ask. A hard stop would trade success away:
rep1 recovered after ~10 rejection rounds and succeeded; the ask is only an
offer (it biases continuing), so extending the counting does not by itself fail
a run.

## Goal

A round that ends with no applied edit (all exchanges rejected) counts as a
no-progress round, so the #54 decision point fires at the standard milestones in
rejection cycles exactly as in verification-failure cycles; the next storm-like
run either resolves materially cheaper or ends through the existing decision
chain, with success preserved.

## Acceptance criteria

- [ ] The run-scope stalled counter increments for rejection-exhausted rounds
      (no applied edit in the round) in addition to failed verifications; the
      ask fires at multiples of 8 with the correct count, carries the #57
      digest and STOP offering, and ordinary retries/continuations keep their
      current shape. Unit tests: a rejection-only round contributes; the ask at
      8 asserts its content; continue-through passes; STOP exits through the
      existing chain (one summary, failure artifact, `edit-exhausted`).
- [ ] No hard cap is added: a run with a recovering rejection cycle (the rep1
      shape) can still continue and succeed (scripted test).
- [ ] Live evidence in the next tc-side matrix: json 3/3, sexp 3/3, minilisp >=2/3; the minilisp replay bundles show the ask firing in rejection cycles
      (or no such cycle reaching 8); every storm-like run either resolves below
      the 2026-10-19 totals (89,716 / 126,822) or ends through the decision
      chain rather than the bare token budget; tokens and the
      `benchmark/results/consumption.md` row updated.
- [ ] #57's live clause (repeat-class attempts drop in storm-like runs)
      re-measured with the same matrix and recorded in #57.
- [ ] Gates: `bunx tsc --noEmit` 0, `bun test` all pass, `bun run accept` 5/5,
      `bun benchmark/check.ts` 3 PASS.

## Verification

```
bun test
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-ts.json
```

plus: replay inspection of the minilisp bundles for ask events
(`tmp/replays-*/minilisp-ts-rep*.json`) and the failure artifacts.

## Notes

- Non-goals: hard caps or auto-stop (rep1 evidence), unified diffs, tolerant
  matching, weakening the guards.
- Related: #54 (accounting), #57 (digest effect), #49/#46 (raw metrics blocked
  here), #59 (no-op class resolved).
- Evidence bundles: `tmp/replays-59-final/minilisp-ts-rep{1,2,3}.json`; pre-fix
  `tmp/replays-opt3-final/minilisp-ts-rep3.json`.

### Evidence — implementation + live matrix (added 2026-10-19)

- Implementation + tests (subagent, main-agent reviewed): a round with no
  applied edit advances the run-scope stalled counter (the new increment sits
  with the verification-failure increment, src/loop.ts:3155-3175); the ask fires
  at multiples of 8 when a pinned target is open and the round opens through a
  continuation or a failed verification; a rejection-cycle milestone renders the
  ask through the #52 continuation prompt (header replaced, retry shape, STOP,
  digest, re-pin allowed); STOP at the ask exits through the stalled-diagnostics
  chain (one summary, failure artifact, `edit-exhausted`). Five tests
  (rejection-exhausted counting, ask content at 8, recover-through, recurrence
  at 16, STOP at the rejection-cycle ask); docs/spec.md + docs/glossary.md
  updated.
- Gates (main-agent rerun): `bunx tsc --noEmit` 0, `bun test` 652 pass / 0 fail,
  `bun run accept` 5/5, `bun benchmark/check.ts` 3 PASS.
- Live matrix (all runs 00:06-00:08 UTC, off-peak): `bun run benchmark/run.ts
  --all --side tc --reps 3 --json benchmark/results/2026-10-19-tc-stormfix.json
  --keep --replay-dir tmp/replays-60-tc-matrix`.
- Mechanism bar met: every minilisp bundle shows the ask in rejection cycles
  with the #57 digest — rep1 rounds 9/17 (counts 8/16; 1,135 / 1,085 chars),
  rep2 round 9 (1,116), rep3 rounds 9/17 (1,142 / 1,093); each ask keeps STOP
  and the retry shape; non-milestone continuations keep the round-exhausted
  header (6 / 2 / 6). Rejection classes: rep1 no-op 12 / matcher 11 / repeat 6;
  rep2 no-op 8 / matcher-unparseable 2; rep3 repeat 11 / duplicate 5 / address
  5 / no-op 2 / matcher-unparseable 2 (scratch: `tmp/analyze-60.ts`,
  `tmp/forensic-60.ts`).
- Outcome bar NOT met on this sample: json 3/3, sexp 3/3, minilisp 1/3 (bar
  > =2/3). rep2 resolved at 67,809 tokens (below the 89,716 bar); rep1 (124,846)
  > and rep3 (126,832) answered both asks with already-applied / stale-matcher /
  > address-loop attempts and ended via the bare token budget (46 steps each;
  > neither ends through the decision chain). Counting alone fires the ask but
  > does not change storm outcomes; the residual is split to #65.
- USD (off-peak, from `aggregates`): json $0.00106 (3/3), sexp $0.00034 (3/3),
  minilisp $0.04295 (1/3), overall $0.00674 (7/9); row appended to
  `benchmark/results/consumption.md`. vs the oc pressure baseline: json/sexp
  far below ($0.00217 / $0.00195); minilisp ($0.00598) and overall
  ($0.00444 / $0.00337) still above.
- Disposition: criteria 1, 2, 4, 5 met (criterion 4 re-measured and recorded in
  #57); criterion 3 mechanism met / outcome not met. Issue stays in-progress
  and re-measures on #65's matrices.

### Re-measure (2026-10-19 #65 matrices, added 2026-10-19)

- `benchmark/results/2026-10-19-tc-storm65-a.json` / `-b.json`,
  `tmp/replays-65-tc-matrix-{a,b}/`: criterion 3 mechanism holds again — the
  ask fires at every 8-round milestone in all three storm runs with the #57
  digest (a rep1 rounds 9/17 at 1,166/1,133 chars; a rep2 9/17/25 at
  1,113/1,120/1,120; b rep1 9/17/25 at 1,176/1,098/1,148), STOP offered and
  retry shape kept (ask traces in `tmp/live-65/forensics.log`).
- Outcome: sample a minilisp 1/3 (rep1 124,369 token-budget; rep2 120,021 via
  the 32-round cap, no STOP) and sample b minilisp 2/3 (rep1 124,125
  token-budget) — no storm run ended through the decision chain; all three now
  end below the 126,822 worst case. Overall 7/9 and 8/9 vs the pre-#65
  sample's 7/9. Criterion 4 re-measured and recorded in #57 (clause met and the
  issue closes).
- Criterion 3 outcome still NOT met; the storm shape moved from rejection
  cycles to applied-but-unverified oscillation (`tmp/live-65/fail-sequences.txt`),
  so the residual is split to #71 — this issue re-measures on #71's matrices.

### Re-measure (2026-10-19 #71 matrices, added 2026-10-19)

- c/d (`benchmark/results/2026-10-19-tc-storm71-{c,d}.json`; replays
  `tmp/replays-71-tc-matrix-{c,d}/`): json 3/3 and sexp 3/3 in both; minilisp
  2/3 (c) / 3/3 (d) — the >=2/3 bar holds.
- Mechanism holds live: c rep1's failedRounds=8 streak (ask at round 9)
  includes rejection-exhausted rounds 5-7 — three-exchange rounds with no
  applied edit — i.e. the counting fired the ask there; asks keep the #57
  digest (1,148-1,187 chars) and STOP.
- Outcome: d meets the sub-clause fully (23,186 / 27,279 / 43,524, all below
  the 2026-10-19 totals; one ask, round 9, recovered). c: rep3 36,219 and rep1
  92,208 (2.5% over the 89,716 reference, recovered) resolved; rep2 125,052
  burned to the bare token budget (asks at 8/16/24 ignored) — not fully met on
  c; the residual is #65's.
- Criterion 4 re-measured and recorded in #57 (re-measure 4) and #49
  (measurement 4); rows added to `benchmark/results/consumption.md`.
- Disposition (user decision, 2026-10-19): closed on the mechanism + sample d's
  full reading, with the c rep2 residual recorded and tracked by #65.
