---
id: 100
title: "Raise range selector adoption, with mechanical measurement"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [umbrella]
created: 2026-10-20
---

## Context

`#72` added an optional `range` `{line,column,endLine,endColumn}` selector as the
unambiguous escape from the structural `matcher` (matcher-ambiguous has no
recovery short of a full rewrite). Its only measurement recorded 0 adoption *in
that sample*; a code audit (2026-10-20) shows why the selector does not take:

- It is wired into the model-facing prompts — the base system prompt
  (`src/loop.ts:171`) and every modify fresh-edit / retry / continuation prompt
  (`RANGE_SELECTOR_NOTE` at `src/loop.ts:248`, interpolated at
  `:266/284/322/452/553/554`) — so the model can see it.
- But **no rejection correction or escalation ever mentions it**, including
  `matcher-ambiguous`, the class it was built to escape (`rejectionPolicy`
  `src/loop.ts:1567-1587`, `MATCHER_ESCALATION` `:1439`): all three matcher
  causes say only "extend matcher / omit matcher for a whole-symbol rewrite".
  Issue #72's acceptance criterion "matcher-cause escalations *may* offer the
  range" was never implemented; `docs/spec.md:650` (risk R6) reads as if it had
  been.
- Adoption is **not mechanically measurable**: `LoopRecord`/`recordRow`
  (`src/loop.ts:1648-1676`, `:1909-1949`) and the report's `RecordSummary` /
  `exchangeStats` (`benchmark/run.ts:83-113`) carry `payloads` (a count),
  `replacementChars`, and `cause` — but no selector. A *successful* `range` edit
  records `cause: null`, indistinguishable from a matcher or whole-symbol edit;
  only a failed `range-invalid` is observable. So "adoption" could only be read
  by replay surgery.

Two facts constrain the experiment: across the replay corpus `range` **is** used
(22 payloads in 82 replay dirs), while `matcher-ambiguous` fired only **2** times
in all committed results — dominated by `matcher-unparseable` (113) and
`matcher-not-found` (49). A steer aimed only at `matcher-ambiguous` would have no
statistical power, so adoption must be raised where the failures actually occur
and measured mechanically.

## Goal

`range` adoption is a first-class, mechanical metric, and a matcher-failure steer
drives adoption up without regressing tokens or USD per success.

## Acceptance criteria

- [ ] Selector choice (`range` / `matcher` / whole-symbol) is recorded per
      applied edit and surfaced in the benchmark report (child: the
      instrumentation issue).
- [ ] Matcher-failure corrections/escalations actively offer `range` as the
      escape, evaluated by an A/B with adoption as the primary metric and
      tokens/USD per success as the regression guard (child: the steer
      experiment).
- [ ] Each child is decided (`done` or `wontfix`) with evidence, and the
      umbrella closes only when both are.

## Verification

```
bun .opencode/scripts/issue-tracker.ts check --strict
```

plus each child's own verification.

## Notes

- Umbrella parent of the two children below; the steer child `deps` on the
  instrumentation child (its measurement needs the recorded selector).
- Filed 2026-10-20 from the `range` selector discussion (#72 follow-up).
- Non-goals: changing matcher semantics, weakening the ambiguity guard, or
  removing the structural matcher as the default path.
