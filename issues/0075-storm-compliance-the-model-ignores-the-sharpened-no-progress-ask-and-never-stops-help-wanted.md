---
id: 75
title: "Storm compliance: the model ignores the sharpened no-progress ask and never STOPs (help wanted)"
status: in-progress
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
