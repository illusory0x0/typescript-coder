---
id: 12
title: "Fix duplicate-declaration handling in the compact edit protocol"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-22
---

## Context

The #11 compact baseline exposed a duplicate-declaration failure mode. The json-parser run (0/1, `token-budget`) started from one compact reply that carried two create clauses per symbol (a draft plus a `resolve` correction). All four clauses resolved against the pre-reply empty source, all four were queued as creates at the same zero offset, and both guards missed them: the overlap check uses `current.start < previous.end` (so `0 < 0` is not an overlap), and the duplicate check exempts names the file did not declare before. The file ended up with `JsonValue` and `parseJson` twice each. Because the symbol binder merges same-name declarations and the index exposes only the first, the second copy is unselectable by name; the model rewrote the visible copy with identical text, got `no-op`, and looped to the token budget.

The minilisp run also burned six `duplicate` rejections before its budget. Fixing only the seed still leaves the model without a way out of an already-duplicated file, so both halves are needed.

## Goal

Make compact multi-clause replies unable to seed duplicate declarations, and make a duplicate that already exists repairable through the model-facing diagnostics.

## Acceptance criteria

- [ ] Every child issue is `done` or `wontfix`.
- [ ] `issue check` passes and no child is open.
- [ ] No code or docs are changed by this umbrella itself.

## Verification

```
issue check
issue list --open
```

The open list contains no issue parented to this umbrella.

## Notes

- Children: the create/overlap guard fix, and duplicate-declaration repairability.
- The #11 compact baseline stays as recorded; do not rewrite it. Re-measure with `--reps 3` only after both children land.
- Held-out rule: do not tune prompts or code against `csv-parser`.
- Both children are done: #13 (create-conflict and same-offset zero-width guards, plus defense-in-depth duplicate detection) and #14 (duplicates rendered in the viewer/details with a grammar-valid empty-fence delete repair, and the dangling-`export` fix for whole-declaration deletes). The umbrella itself changed no code or docs. `issue check` is clean and no child is open. Re-measuring the compact benchmark (--reps 3) is deliberately left out of this resolution and can be run separately once approved.
