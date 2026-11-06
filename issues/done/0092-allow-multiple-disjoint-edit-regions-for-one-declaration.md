---
id: 92
title: "Allow multiple disjoint edit regions for one declaration"
status: done
priority: high
milestone: null
parent: null
deps: []
labels: [typescript-editor, harness, cli]
created: 2026-11-06
---

## Context

One reply may address a resolved declaration `(path, symbol, kind)` only once.
The limitation forces independent edits to one declaration across exchanges,
which is exactly where stale line/column coordinates and extra model turns come
from. `pick {a, b}` can repeat one fence over several spans, but it cannot apply
different replacement text to disjoint regions in one atomic reply.

## Goal

Allow multiple editor clauses on one declaration when their resolved regions are
pairwise disjoint, while keeping duplicate rejection for every ambiguous or
whole-declaration combination.

## Acceptance criteria

- [ ] Two pick-only clauses on the same declaration with different fences and
  disjoint spans both apply in one reply.
- [ ] Two disjoint `match` editor clauses on the same declaration apply in one
  reply, as do a `pick` and a `match` clause whose resolved spans are disjoint.
- [ ] Overlapping or touching zero-width regions, and a duplicate resolved span,
  still fail before any write (typed `stage: duplicate` or `stage: range`) with
  diagnostics naming both clauses.
- [ ] A viewer+editor, rename+editor, whole-symbol editor+partial editor, and
  repeated implicit create on one declaration remain duplicate failures.
- [ ] Different declarations and the existing single-clause `pick {a, b}`
  behavior are unchanged; the reply stays atomic.
- [ ] Every prompt occurrence of the one-target rule is updated to state the
  disjoint-editor exception, and the docs explain the overlap rule.
- [ ] Tests cover disjoint picks, disjoint matches, pick+match, overlap,
  viewer/rename/whole-symbol conflicts, and a CLI dry-run with two disjoint
  clauses.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
bun test typescript-editor/src/edit-dsl.test.ts typescript-editor/src/multi-editor.test.ts \
  typescript-editor/src/cli.test.ts harness/src/loop.test.ts
just tsed-check && just typecheck && just test
```

Manual check with a two-function body: two disjoint `pick` clauses on one
function with different replacement text must apply in one `--dry-run`.

## Notes

Disjoint means half-open spans do not intersect; two zero-width insertions at
the same offset are not disjoint. Keep the duplicate key `(path, name, kind)` so
a rename cannot bypass the rule. This is a follow-up to #40 and the range
ergonomics work.
