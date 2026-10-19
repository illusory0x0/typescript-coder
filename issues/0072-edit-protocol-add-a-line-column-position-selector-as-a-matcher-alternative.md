---
id: 72
title: "Edit protocol: add a (line,column) position selector as a matcher alternative"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [harness]
created: 2026-10-19
---

## Context

User directive (2026-10-19): add a selector that addresses the edit range by
`(line, column)` so the ambiguity class the snippet matcher cannot handle has an
unambiguous escape. The user clarified this is an addition, not an abandonment —
the structural path and the symbol pin stay as they are.

Today a `modify` edit resolves inside the pinned declaration by structural
matcher with an exactly-one-match rule; two-or-more occurrences reject as
`matcher-ambiguous` with an extend-the-matcher hint, and every matcher rejection
class escalates to a whole-declaration rewrite without a matcher
(`docs/spec.md:111-128`, `docs/spec.md:219-237`). Matcher mechanics have been the
most expensive rejection family in the storm chain: the canonical minilisp
failures were matcher/format-stage dominated (#50), the pre-#65 cycles looped
stale matchers (`matcher-not-found` 11x / 9x; #60/#65 Notes), and an ambiguous
match has no recovery short of a full rewrite. Post-#65 the matcher classes
collapsed and the residual storm moved to applied-but-unverified oscillation
(#71), so this is protocol robustness — measured on the benchmark, not assumed
to be a storm fix. It also unblocks any future same-symbol batching (#69 covers
path-independent payloads only).

The 2026-10-19 oc survey (`ses_ead4e4970ffeXOfR05dc2M7v8l`, A2
edit-expressiveness row) supports the direction: oc's file-level edits
structurally avoid the matcher/no-op/address rejection classes.

## Goal

A `modify` payload may carry an optional position range — `(line, column)`
against the current source shown in the prompt — as an alternative to
`matcher`; a valid range resolves to exactly the intended occurrence (ambiguity
cannot arise), invalid ranges reject as a staged diagnostic that names the
current bounds, and the structural matcher stays the default path with
unchanged semantics.

## Acceptance criteria

- [ ] Speced before implementation: payload field shape, coordinate base and
      numbering (relative to the shown source), end semantics, resolution rules
      (the range must sit inside the pinned declaration), rejection class/hints
      (single `range-invalid` vs split out-of-bounds / outside-declaration /
      empty), and prompt support for deriving positions (e.g. a line-numbered
      source block; its token cost is part of the measurement).
- [ ] Unit tests: valid single-line and multi-line ranges; out-of-bounds;
      outside the declaration; empty and end-before-start ranges; matcher
      behavior byte-identical when no range is sent; `export`-range expansion
      unchanged.
- [ ] Guards unchanged: echo/address, syntax gate, no-op/repeat/duplicate,
      budgets, and stages keep their behavior; matcher-cause escalations may
      offer the range as an additional alternative.
- [ ] Live evidence on the next tc-side matrices: json 3/3, sexp 3/3,
      minilisp >=2/3, and tokens/USD per success not worse than the standing
      `consumption.md` row — or the outcome (including low adoption / matcher
      still preferred) is recorded honestly.
- [ ] `benchmark/results/consumption.md` rows added.
- [ ] Gates: `bunx tsc --noEmit` 0, `bun test` all pass, `bun run accept` 5/5,
      `bun benchmark/check.ts` 3 PASS.

## Verification

```
bun test
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-tc.json --keep --replay-dir tmp/replays-<name>
```

plus replay-bundle inspection for range adoption and the new rejection classes.

## Notes

- Filed 2026-10-19 (file-issue) from the user's directive; sequence after #71's
  live evidence and coordinated with #69 (batched edits).
- Open questions: coordinate base (file vs shown slice), whether columns are
  optional and line-only ranges allowed, single vs split rejection classes,
  interaction with the `export`-range expansion, and whether a matcher + position
  hint (`at`) is a cheaper intermediate lever before a full range selector.
- Related: #50 (matcher ergonomics), #48 (matcher not-found declaration search),
  #69 (batching), #71 (verification-cycle storms).
- Non-goals: replacing or removing the structural matcher, unified diffs,
  tolerant/ambiguous matching, weakening the symbol pin/echo guard, path-level
  edits with no declaration.
- Consult (2026-10-19): coupling with #69 — the coordinate scheme must leave
  an interface for same-symbol multi-range batching (extension filed separately
  when needed); the structural matcher stays the default and the selector
  remains an alternative, not a replacement.
- Priority defaulted to medium; no milestone.
