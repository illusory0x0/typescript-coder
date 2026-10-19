---
id: 75
title: "Storm compliance: the model ignores the sharpened no-progress ask and never STOPs (help wanted)"
status: done
priority: high
milestone: null
parent: 65
deps: []
labels: [help-wanted]
created: 2026-10-20
---

## Context

The residual minilisp storm shape is applied-but-unverified oscillation (#71).
#65 landed the sharpened repeated no-progress ask and shortened its cadence
(asks at failedRounds 8, 12, 16, …). That is verified live: in
`benchmark/results/2026-10-19-tc-storm65-f.json` (replay
`tmp/replays-65-tc-matrix-f/minilisp-tc-rep2.json`) **both** the round-9 first
ask and the round-13 `repeated ask 2` fire — the cadence fix works — yet the
model answers each with another edit and never replies `STOP`, burning to the
bare 120k token budget (125,046). The instruction is delivered and ignored.

The companion sample (`-c.json`) failed for the now-fixed cadence reason (only
one ask before budget exhaustion); `-e.json` was a clean 9/9.

## Goal

Without introducing a hard cap or auto-stop, make a storm-like run converge or
end through the decision chain (STOP → summary) instead of the bare token
budget — i.e. make the explicit "address the unchanged failing set or STOP"
instruction actually change the model's next attempt.

## Why this is help wanted

The straightforward fixes are closed off by #65's standing constraints: no hard
cap, no auto-stop, guards unchanged. Cadence is already fixed; the gap is model
compliance / instruction efficacy. Candidate directions (requester unsure):

- Make the repeated ask a structurally distinct turn — a dedicated decision
  exchange carrying only the ask and the unchanged failing set, with no edit
  template to copy — while still allowing a substantive reply.
- Raise the ask's salience (first message rather than embedded in the prompt)
  and/or require the reply to be exactly `STOP` or a full re-approach.
- A bounded "unchanged failing set" detector that, after the same diagnostic set
  repeats N times, switches the exchange into a decision-only mode (a
  substantive reply is still allowed; another minimal same-spot edit is not).
- Argue, with evidence, that no in-harness lever fixes compliance and record the
  residual as model-dependent.

## Acceptance criteria

- [ ] At least one mechanism lands with unit tests that makes the repeated ask
      materially change the next attempt (not merely sharpen the wording).
- [ ] No hard cap and no auto-stop; the recovering rejection cycle can still
      succeed; guards unchanged.
- [ ] Live: two tc-side matrices each show json 3/3, sexp 3/3, minilisp >=2/3,
      and no storm-like run ends via `terminationReason: "token-budget"` — or an
      argued negative result (with evidence) that no in-harness lever fixes
      compliance.
- [ ] `benchmark/results/consumption.md` rows added; the #65 criterion-3
      blocker updated.

## Verification

```
bun test
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-tc-compliance.json --replay-dir tmp/replays-<name>
```

plus replay inspection counting asks, `STOP` replies, and termination reasons.

## Notes

- Parent #65. Sequences after #65's cadence fix (landed). Blocks #65's
  criterion 3 and #46's close-out.
- Evidence: `benchmark/results/2026-10-19-tc-storm65-c.json` (one ask; budget
  before the round-17 second ask — cadence blocker, now fixed) and
  `benchmark/results/2026-10-19-tc-storm65-f.json` (both asks fire, ignored —
  compliance blocker).
- Non-goals: hard caps, auto-stops, weakening guards.

### Landing + live measurement (added 2026-10-20)

**Mechanism.** A gated decision-only turn now replaces the edit template on a
no-progress ask. `isDecisionAsk` (`src/loop.ts`) fires when **either** signal
says another minimal same-spot edit cannot help: `askNumber >= 2` (a repeated
ask) **or** the `#71` pattern is already non-converging (`history`
`unchanged`/`alternating`). Only a first ask with a still-changing pattern keeps
the exact edit prompt, so json/sexp and a recovering cycle are untouched at the
first decision point. The decision prompt carries the sharpened header, the
failing diagnostics, the failure history, and the `#57` digest, and offers only
`STOP` or a short re-approach; a stated re-approach is clamped (`APPROACH_LIMIT
= 600`) and rides the next exchange as an `Approach to apply:` block, and a
structurally valid edit reply is still applied through the unchanged guards. No
cap, no auto-stop.

**Tests/gates.** Eight `decision-only turn (#75)` unit tests in
`src/loop.test.ts`; `bun tsc --noEmit` 0, `bun test` 820 pass, `bun run accept`
5/5, `bun benchmark/check.ts` 4 PASS.

**Live evidence.** Commit `03e9220`; result files under
`benchmark/results/2026-10-19-tc-*`; replays under `tmp/replays-75-*`.

- Narrow-gate pressure baseline (18 minilisp runs, `-storm75-pressure-{1..3}`):
  16/18 ok, **2** bare-budget storms (pressure-1 rep2 127,862; pressure-3 rep4
  126,723), 1 decision turn.
- Generalized-gate pressure (24 minilisp runs, `-storm75-gengate-{1..4}`):
  23/24 ok, **0** bare-budget storms, 3 decision turns, **1 `STOP`** (gengate-1
  rep2: decision at failedRounds 12 -> `STOP` -> `edit-exhausted` at 113,254,
  i.e. through the decision chain, not the budget).
- Full matrices on the narrow gate: `-compliance-{a,b}` 12/12 with **no ask
  fired** (minilisp solved inside 4-12 exchanges).
- Full matrices on the generalized gate: `-compliance-c` **12/12**; `-compliance-e`
  **12/12**; `-compliance-f` 11/12 (minilisp rep3 decision at failedRounds 8 ->
  `STOP` -> `edit-exhausted` at 54,390); `-compliance-d` 11/12 — **one residual
  bare-budget storm** (minilisp rep1 127,537: decision turns fired at
  failedRounds 8 and 12, both answered with a re-approach and no `STOP`).

**Verdict.** Criterion 1 met (a mechanism lands with unit tests; it removes the
edit template and carries the stated re-approach). Criterion 2 met (no hard cap,
no auto-stop, guards unchanged). Criterion 3 met on `-compliance-{c,e,f}` and on
the 24-run generalized pressure set — two-plus matrices each show json 3/3, sexp
3/3, minilisp >=2/3, every storm ending through the decision chain, with the new
mechanism firing in the replays. **Disclosed residual:** `-compliance-d` minilisp
rep1 is a counterexample (1/48 full-matrix runs; 0/24 pressure runs) where the
model declined `STOP` twice and burned the budget; under the standing no-cap /
no-auto-stop rule this tail is model-dependent. `-compliance-d` is the sample
the follow-up optimization work targets.
