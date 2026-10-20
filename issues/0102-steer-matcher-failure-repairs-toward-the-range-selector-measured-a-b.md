---
id: 102
title: "Steer matcher-failure repairs toward the range selector, measured A/B"
status: in-progress
priority: medium
milestone: null
parent: 100
deps: [101]
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

The `range` selector exists to escape matcher ambiguity, but nothing in the
harness ever steers the model to it. Every matcher-cause correction and
escalation (`rejectionPolicy` `src/loop.ts:1567-1587`; `MATCHER_ESCALATION`
`:1439`) says only "extend matcher" or "omit matcher for a whole-symbol
rewrite" — including `matcher-ambiguous`, the exact class `range` was built for.
Issue #72's acceptance criterion "matcher-cause escalations *may* offer the range
as an additional alternative" was never implemented, and `docs/spec.md:650`
(risk R6) reads as though it had been.

Trigger frequencies parsed from every committed result's `record.cause`:
`matcher-unparseable` 113, `matcher-not-found` 49, `matcher-ambiguous` **2**.
So a steer aimed only at `matcher-ambiguous` would almost never fire; the
experiment must target the classes that do (the general matcher-failure wording),
with adoption — not a single rare cause — as the primary metric. Adoption needs
the selector field from the instrumentation sibling (this issue `deps` on it).

## Goal

On a matcher failure the correction/escalation offers `range` as the
unambiguous escape, and an A/B experiment reports the adoption change and
confirms no tokens/USD-per-success regression.

## Acceptance criteria

- [ ] The matcher-failure correction/escalation text offers `range` (naming its
      shape and that it takes precedence over `matcher`), keeping the existing
      "extend matcher / whole-symbol rewrite" options — applied to the classes
      that actually fire, not only `matcher-ambiguous`.
- [ ] The change is A/B-measurable on byte-identical source via a runtime opt-out
      in the style of `TC_DIAG_DECL_NAMING` (#92), so both arms share provenance.
- [ ] The A/B reports selector adoption (from the instrumentation field) and
      cache-excluded tokens + USD per success per arm (uniform `none`, same
      model), with an honest verdict — including "no effect" or "not triggered".
- [ ] No regression on the happy paths (json/sexp/csv; minilisp recorded), and
      guards, caps, and the matcher default unchanged.
- [ ] `consumption.md` row(s) with the source JSON per arm.

## Verification

```
bunx tsc --noEmit
bun test
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-range-steer-on.json  --replay-dir tmp/replays-range-steer-on
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-range-steer-off.json --replay-dir tmp/replays-range-steer-off
bun benchmark/check.ts
```

plus reading the adoption counts from each arm's report field and the
tokens/USD columns from the reports.

## Notes

- Parent: the `range`-adoption umbrella. `deps`: the instrumentation issue.
- Open question: whether to steer on all matcher causes from the start or only
  the ambiguity-adjacent ones; the A/B can begin with the full matcher-failure
  wording and let the evidence narrow it.
- Related: #50 (matcher ergonomics), #71 (verification-cycle storms), #72 (the
  selector itself).
- Non-goals: replacing or removing the matcher, weakening the ambiguity/echo/
  gate guards, or making `range` mandatory.
