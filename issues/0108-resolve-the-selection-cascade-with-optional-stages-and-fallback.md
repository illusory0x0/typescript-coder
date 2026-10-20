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
whole-symbol`, and the address `path × symbol × kind` is mandatory. The cascade
model makes each stage optional: `path → symbol → matcher → selector`, where a
supplied finer stage must narrow inside the coarser result and an omitted stage
falls back to the coarser one — never a silent wrong match. The new coordinate
kinds `line` and `(line,column)` are degenerate `range`s.

## Goal

Resolution honors the cascade: the coarsest supplied stage wins when nothing
finer is given; a finer stage must sit inside the coarser span; ambiguous,
empty, or out-of-bounds selections fail with typed diagnostics.

## Acceptance criteria

- [ ] `line` and `(line,column)` resolve as degenerate 1-based spans inside the
      enclosing stage, with typed causes on out-of-bounds/empty.
- [ ] A supplied anchor (matcher) plus a coordinate selector combine per the
      rule settled in the specification (or explicitly "selector wins", matching
      today's range-over-matcher), with a test.
- [ ] Omitting `symbol`/`kind` (path-only, or path+line) resolves at the
      file/line level for viewer use; ambiguity or a multi-declaration file
      fails loudly.
- [ ] Existing guards (echo/address/ambiguity/syntax gate) are unchanged; no
      silent first match.
- [ ] Unit tests cover each omitted stage and each failure mode.

## Verification

```
bunx tsc --noEmit
bun test
```

## Notes

- Depends on the specification (`#106`) for the cascade order and fallback rule.
- Open question (settle in `#106`): whether a finer stage must sit inside the
  matcher match or only inside the declaration.
