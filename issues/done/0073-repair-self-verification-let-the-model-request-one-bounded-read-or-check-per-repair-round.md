---
id: 73
title: "Repair self-verification: let the model request one bounded read or check per repair round"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [harness]
created: 2026-10-19
---

## Context

User consult (2026-10-19): the oc survey's A-group triage rated A1 — the
model-side self-verification loop — the highest-leverage mechanism gap, and
approved filing it strictly bounded, sequenced after #69/#72.

Today the model edits blind: a prompt carries the pinned selection, the
current source (or its restore rules), and the harness diagnostics, but the
model cannot inspect the working tree or run anything between rounds. A fix
whose assumptions miss the actual file state surfaces only after the harness
applies it and runs the gate — the applied-but-unverified oscillation #71
measured (identical failing sets for 14-20 rounds; minilisp storm reps up to
~125k tokens).

The comparison: in oc's loop the model can read files and run checks itself;
its minilisp comparison runs are clean (6/6) where tc's canonical runs remain
the weak spot. But oc's edge is a bundle (full transcript, tool loop, no tc
guard classes), so this is a hypothesis to measure — protocol robustness, not
an assumed storm fix. tc's standing stance is explicit: tools are internal
library APIs and are "never offered to the model" (`docs/spec.md:383-390`,
§7). This issue proposes one deliberately bounded exception, scoped to repair
rounds.

## Goal

In a repair round the model may make at most one bounded self-verification
request — an explicit read of the current source or one whitelisted command —
whose bounded result the harness runs locally and returns before the model's
next edit; rounds with no request stay byte-identical.

## Acceptance criteria

- [ ] Speced before implementation: request shape and placement in the payload,
      the read target, the command whitelist (`bunx tsc --noEmit` and the
      task's test command), bounded result rendering, the at-most-one rule,
      and the interaction with #52 continuations and the #71 `Failure history`
      note. `docs/spec.md` §7 records the bounded exception.
- [ ] The model can request the check in a repair round (rounds opened by a
      rejection or a verification failure); the harness executes it and
      returns a bounded result; a second request in the same round is not
      executed and cannot extend the round.
- [ ] Happy path: rounds with no request add zero provider calls and zero
      local commands; the no-repair prompt path is byte-identical.
- [ ] Guards unchanged: echo/address, the syntax gate,
      no-op/repeat/duplicate, budgets, rejection classes, and escalation
      stages keep their behavior; no new hard caps or auto-stops.
- [ ] Unit tests: request parsing (read / command / malformed), whitelist
      enforcement, the at-most-one rule, result rendering bounds, the
      no-request byte-identical path, and the #52/#71 interactions.
- [ ] Live evidence on an independent tc-side matrix (frozen text, series
      before/after): json 3/3, sexp 3/3, minilisp >=2/3 and tokens/USD per
      success not worse than the then-current `consumption.md` row — or the
      outcome (low adoption / no gain / worse) is recorded honestly.
- [ ] `benchmark/results/consumption.md` rows added.
- [ ] Gates: `bunx tsc --noEmit` 0, `bun test` all pass, `bun run accept` 5/5,
      `bun benchmark/check.ts` 3 PASS.

## Verification

```
bun test
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-tc-selfverification.json --keep --replay-dir tmp/replays-<name>
```

plus replay-bundle inspection: count self-check requests per round, confirm
the at-most-one bound and bounded rendering, and read the minilisp storm spend
against the then-current row.

## Notes

- Filed 2026-10-19 (file-issue); source: 2026-10-19 filing consult over the oc
  survey A-group (A1 row, session `ses_ead4e4970ffeXOfR05dc2M7v8l`).
  Sequence: after #69 and #72.
- Related: #71 (storms — convergence before the gate vs surfacing
  non-convergence), #65/#60 (no-progress levers), #49 (input tokens), #64
  (context study), #24 (tools-internal precedent, done), #46.
- Non-goals: a general agentic tool-execution loop; sending `tools` to the
  provider; write access; commands beyond the whitelist; more than one request
  per round; weakening or bypassing any guard.
- Open questions: read target (pinned file vs expanded declaration); result
  rendering (staged block vs plain message); per-round vs per-task bound
  (first cut: per round).
- Priority defaulted to medium; no milestone. Filed as a root issue so the v3
  close-out (#46) is not gated on it; re-parent on request.

### Measurement (2026-10-19)

One tc-side matrix on the frozen #72+#73 code
(`benchmark/results/2026-10-19-tc-self-verification.json`, replays
`tmp/replays-73-tc-matrix/`; row added to `benchmark/results/consumption.md`):

- json 3/3 $0.00151, sexp 3/3 $0.00035, minilisp **2/3** $0.01652, overall 8/9
  $0.00483 (runs 17:07:21-17:09:15 UTC).
- **Adoption:** every minilisp run issued self-check requests (rep1 1, rep2 1,
  rep3 2 — `exchangeStats.selfChecks`); json/sexp issued none. So the bounded
  exception is live and used in the weak-spot task.
- **Outcome vs the then-current #72 row:** minilisp tokens/USD per success are
  worse (108,465 / $0.01652 vs 30,002 / $0.00508) because rep3 ran the
  applied-but-unverified storm to the bare budget (127,548) despite 2
  self-checks. json/sexp stay on the happy path. Recorded honestly per the
  issue's "or the outcome (low adoption / no gain / worse) is recorded" clause;
  the two samples either side (#72 clean 9/9, this one 8/9) show the storm is
  high-variance, not a deterministic feature effect.
- Gates: `bunx tsc --noEmit` 0, `bun test` 729 pass, accept 5/5,
  `bun benchmark/check.ts` 3 PASS; the ledger row is `fresh` under #66.
