---
id: 108
title: "Resolve the selection cascade with optional stages and fallback"
status: todo
priority: medium
milestone: null
parent: 105
deps: [106]
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

`resolveEntrySplice` (`src/loop.ts:2839`) short-circuits `range ▸ matcher ▸
whole-symbol`, and the address `path × symbol × kind` is mandatory. The compact
protocol (grammar in `docs/edit-protocol.md`) keeps the address mandatory but
makes the rest optional: `select` names the declaration, `match` locates a span
in it, `pick` disambiguates among matches, `replace` rewrites the target; a
supplied stage must narrow inside the coarser result, an omitted stage falls
back to the coarser one — never a silent wrong match. The `pick` ranges are the
coordinate selector.

## Goal

Resolution honors the cascade: the coarsest supplied stage wins when nothing
finer is given; a finer stage must sit inside the coarser span; ambiguous,
empty, or out-of-bounds selections fail with typed diagnostics.

## Acceptance criteria

- [ ] `pick` ranges resolve as 1-based file-absolute spans inside the enclosing
      `match` scope, with typed causes on out-of-bounds/empty.
- [ ] `match` is the locator and `pick` only narrows it (no bare-range replace):
      the precedence settled in `docs/edit-protocol.md`, with a test.
- [ ] An omitted `match` targets the whole declaration; an omitted `replace` is a
      viewer; ambiguity (multiple matches) fails loudly, never a silent first
      match.
- [ ] Existing guards (echo/address/ambiguity/syntax gate) are unchanged.
- [ ] Unit tests cover each omitted stage and each failure mode.

## Verification

```
bunx tsc --noEmit
bun test
```

## Notes

- Depends on the specification (`#106`) for the cascade order and fallback rule;
  the grammar lives in `docs/edit-protocol.md`.
- Settled in `#106`: `pick` sits inside `match` (it filters the match set),
  never beside it.
