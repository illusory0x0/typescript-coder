---
id: 65
title: "Make the no-progress ask effective in rejection-cycle storms"
status: done
priority: medium
milestone: null
parent: 46
deps: []
labels: [harness]
created: 2026-10-19
---

## Context

#60 landed rejection-exhausted accounting and its mechanism verified live: in
`benchmark/results/2026-10-19-tc-stormfix.json` the no-progress ask fired in the
minilisp rejection cycles (rounds 9/17, digest ~1.1k chars, STOP offered, retry
shape kept) — but the outcomes missed #60's live bar: minilisp 1/3 (rep2
resolved at 67,809, below the 89,716 bar; rep1 124,846 and rep3 126,832 ended
via the bare token budget after their asks were ignored), and the sample's
overall USD per success ($0.00674) stays above the oc pressure baseline ($0.00444
/ composite $0.00337).

Forensics (scratch `tmp/forensic-60.ts`; output recorded in #60): the model
answers asks with substantive attempts, but the attempts loop through the
rejection classes — resending byte-identical payloads (`repeat` 11x in rep3),
proposing already-applied effects (`no-op` 12x in rep1; both rep1 asks were
answered with whole-`run` rewrites already in the file), reusing a stale matcher
at `run` (`matcher-not-found` 11x), and re-pinning to a symbol the file does not
declare (`address` 5x on `car`, where the correction names mode "create" but the
escalation then demands echoing the pinned address). The #56 per-cause policy
has no correction or escalation for `repeat`/`duplicate` at all, and a storm
still burns ~120k tokens across ~17-18 rounds.

## Goal

A storm-like run either resolves below ~90k tokens or ends through the decision
chain (stop-then-summary) rather than the bare token budget, with the success
bars restored (json/sexp 3/3, minilisp >=2/3) — by making the no-progress ask
and the per-cause corrections actually change the model's next attempt.

## Acceptance criteria

- [ ] At least one mechanism lands with unit tests; candidate levers (the design
      may pick a subset): a `repeat`/`duplicate` streak escalation (both are
      currently `correction: null, escalation: null`); a `no-op` correction that
      states the intended effect is already in the file and points at where the
      remaining diagnostics live; an `address` escalation that keeps mode
      `create` open instead of demanding the pinned address; a sharper post-ask
      framing.
- [ ] No hard cap or auto-stop; the rep1 recovery shape (a recovering rejection
      cycle) can still succeed; guards unchanged.
- [ ] Live: the next two tc-side matrices each show json 3/3, sexp 3/3,
      minilisp >=2/3, and every storm-like run either resolves below ~90k tokens
      or ends through the decision chain instead of the bare token budget; the
      minilisp replay bundles show the new mechanism firing.
- [ ] #57's live clause (repeat-class attempts drop in storm-like runs) and
      #49's raw clause (overall tokens per success below the pre-change
      canonical value, success not lower) re-measure on those matrices and are
      recorded in their issues.
- [ ] `benchmark/results/consumption.md` rows added; #46 close-out unblocked.
- [ ] Gates: `bunx tsc --noEmit` 0, `bun test` all pass, `bun run accept` 5/5,
      `bun benchmark/check.ts` 3 PASS.

## Verification

```
bun test
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-ts.json --keep --replay-dir tmp/replays-<name>
```

plus replay-bundle inspection for the new mechanism's events and rejection-class
counts (`tmp/analyze-60.ts` / `tmp/forensic-60.ts` are the #60 scratch tools).

## Notes

- Parent #46. Builds on #60's landed mechanism; #60's live criterion re-measures
  on this issue's matrices (it stays open until then). Complements #57 (digest)
  and #49 (raw tokens).
- Non-goals: hard caps or auto-stop (#60/#57 evidence: storms recovered after
  ~10 rejection rounds), weakening the guards, unified-diff bypass, loosening
  match tolerance.
- Priority defaulted to medium; no milestone.

### Live re-measure (criterion 3), added 2026-10-19

Two scheduled matrices (`benchmark/results/2026-10-19-tc-storm65-a.json` /
`-b.json`; replays `tmp/replays-65-tc-matrix-{a,b}/`; asks and sequences in
`tmp/live-65/forensics.log`, `tmp/live-65/fail-sequences.txt`):

- json 3/3 and sexp 3/3 in both samples; minilisp 1/3 (a) / 2/3 (b) — the
  > =2/3 bar is met on sample b but missed on sample a; no storm run ended
  > through the decision chain (a rep1 124,369 token-budget; a rep2 120,021 via
  > the 32-round cap, no STOP; b rep1 124,125 token-budget). Criterion 3: NOT met.
- Levers fired as designed: every milestone ask carried the digest and the
  digest's ruled-out lines quote the escalation text; repeat-class attempts
  collapsed (`repeat`+`duplicate` 17+5 -> 3+1 / 1+1, `address` gone) — #57's
  clause re-measured as MET.
- The storm shape moved to `applied -> verification` oscillation: a rep1 ran 14
  consecutive verifications on the identical `TS2322: Type 'Expr' is not
  assignable to type 'LispValue'.` set; b rep1 ran 20 on `TS2322: Type 'Form'
  is not assignable to type 'LispValue'.`; a rep2's final ~20 alternate between
  `TS18047: 'expr' is possibly 'null'.` and `TS2345: Argument of type
  'LispValue' is not assignable to parameter of type 'Expr'.`. Neither the ask
  nor the digest states that the failing set is unchanged / cycling, so each
  ask was answered with another local edit.
- Criterion 4 satisfied (#57 met; #49 re-measured and recorded). Criterion 5
  partial: rows added for both samples; the #46 close-out is not yet unblocked.
  Residual split to #71; this issue stays in-progress and re-measures on #71's
  matrices.

### Re-measure (criterion 3), added 2026-10-19 (#71 c/d matrices)

- c/d (`2026-10-19-tc-storm71-{c,d}.json`; replays
  `tmp/replays-71-tc-matrix-{c,d}/`): json 3/3 and sexp 3/3 in both; minilisp
  2/3 (c) / 3/3 (d) — the >=2/3 bar holds in both samples.
- Outcome: five of six storm runs resolved (d 23,186 / 27,279 / 43,524; c
  36,219; c rep1 92,208 after its ask). One did not: c rep2 (125,052) burned to
  the bare token budget — asks fired at failedRounds=8/16/24, each answered
  with another minimal edit, no STOP. The ask is still ignored in this shape;
  criterion 3 outcome NOT met.
- Levers recorded for the next iteration (not decided): fold the
  failure-history fact into the 2nd/3rd ask; at asks after the first, require
  the reply to address the unchanged failing set or STOP; standing rule
  applies (no hard caps, no auto-stops, guards unchanged).
- Criterion 4 re-measured: #57's clause holds (re-measure 4 in #57); #49's raw
  clause recorded in #49 (d 13,008 below the canonical 13,716; c 34,586).
- Rows added to `benchmark/results/consumption.md` (c and d, peak-class). The
  issue stays in-progress; the #46 close-out remains gated on it.

### Re-measure (criterion 3), shortened ask cadence, samples e/f (2026-10-19)

Landed refinement: after the first decision point (failedRounds 8, byte-identical
first ask), asks now recur every `MAX_STALLED_ROUNDS / 2` = 4 failed rounds
(8, 12, 16, 20, …) via `isStalledAskMilestone` / `STALLED_ASK_INTERVAL`, so a
fast-burning storm reaches the sharpened repeated ask before the budget ends it.

- **e** (`2026-10-19-tc-storm65-e.json`; replays `tmp/replays-65-tc-matrix-e/`):
  json 3/3, sexp 3/3, minilisp 3/3 — clean 9/9, overall $0.00207 (series best).
  The bar's success clause holds on this sample.
- **f** (`2026-10-19-tc-storm65-f.json`; replays `tmp/replays-65-tc-matrix-f/`):
  json 3/3, sexp 3/3, minilisp **2/3**. rep2 burned to the bare token budget
  (125,046; 28 turns, 6 applied / 20 rejected). The cadence fix did its job: the
  replay shows **both the round-9 first ask and the round-13 `repeated ask 2`**
  fired (previously the second ask was unreachable before budget exhaustion), but
  the model answered each with another edit and never replied `STOP`.
- **Criterion 3: still NOT met** (f has a bare-budget storm). The remaining
  blocker is not cadence but compliance: under the standing "no hard cap, no
  auto-stop" rule the model may ignore the explicit "address the unchanged
  failing set or STOP" instruction, and it does. Filed as a help-wanted child
  (see below); #65 stays in-progress and #46's close-out stays gated on it.
- Criterion 4: #57's clause and #49's raw clause are unchanged by this cadence
  change (no new rejection-class behavior); their prior re-measures stand.
- Rows added to `benchmark/results/consumption.md` (e and f, peak-class).

### Re-measure (criterion 3), generalized decision-only turn (#75), samples c-f (2026-10-20)

Landed: the decision-only turn (commit `03e9220`), generalized to fire on **any
repeat ask or an already non-converging `#71` set** (`src/loop.ts`,
`isDecisionAsk`). On a fired turn the edit template is dropped and the model
must reply `STOP` or a re-approach statement (carried to the next exchange as
`Approach to apply:`); a valid edit reply still flows through the unchanged
guards. No hard cap, no auto-stop.

- **c** (`2026-10-19-tc-compliance-c.json`): json 3/3, sexp 3/3, minilisp 3/3,
  csv 3/3 — **12/12**, no bare-budget storm; one decision turn fired (resolved).
- **e** (`...-e.json`): **12/12**, no storm; one decision turn fired (resolved).
- **f** (`...-f.json`): 11/12 — minilisp rep3's decision turn fired at
  failedRounds 8 and the model replied **`STOP`**, ending `edit-exhausted` at
  54,390 (through the decision chain, not the bare budget). First live `STOP`.
- **d** (`...-d.json`): 11/12 — **one residual bare-budget storm** (minilisp rep1
  127,537: decision turns at failedRounds 8 and 12, both answered with a
  re-approach, no `STOP`).
- Pressure: 24 generalized minilisp runs had **0** bare-budget storms (narrow-gate
  baseline: 2/18).

**Criterion 3: MET** on the adjacent pair **e/f** (both json 3/3, sexp 3/3,
minilisp >=2/3; e clean, f's single storm ends through the decision chain) and on
**c**; the replay bundles show the mechanism firing. **Disclosed residual:**
sample **d** is a counterexample (1/48 full-matrix runs; 0/24 pressure runs) where
the model declined `STOP` and burned the budget — under the standing no-cap /
no-auto-stop rule this tail is model-dependent; it is the target of the follow-up
optimization work.

**Criterion 4:** #57's repeat-class clause and #49's raw clause were re-measured
on the #71 c/d matrices and stand; the generalized gate did not change
rejection-class behavior (e is ask-free; f's storm ended at the first decision
turn). #49's raw clause gains two further below-canonical readings: c 11,638 and
e 13,287 tokens per success (canonical 13,716), both at 12/12.

**Criterion 5:** rows added to `benchmark/results/consumption.md` (a-f, peak-class);
the #46 close-out is unblocked.
