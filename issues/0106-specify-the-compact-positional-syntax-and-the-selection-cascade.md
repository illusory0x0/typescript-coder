---
id: 106
title: "Specify the compact positional syntax and the selection cascade"
status: todo
priority: medium
milestone: null
parent: 105
deps: []
labels: [docs, agent-loop]
created: 2026-10-20
---

## Context

`docs/spec.md` defines the wire protocol as a flat JSON payload with a mandatory
strict-AND address and matcher/range selectors (`:7-12`, `:89-107`, `:175-198`).
The compact positional syntax the model should emit is one line —
`<path>[:<line>[:<col>[-<line>[:<col>]]]] [\`<anchor>\`]`, e.g.
`src/lexer.ts:10:1-20:2 \`xs.push\`` — optionally carrying a `regex` selector.
Nothing in the spec or glossary defines this grammar, the
`path → symbol → matcher → selector` cascade, the per-stage fallback rule, the
precedence among selector kinds, or that one selection serves both reading and
editing.

## Goal

`docs/spec.md` and `docs/glossary.md` define the compact syntax grammar, the
selection cascade, optional-stage fallback, the selector kinds
`line | (line,column) | range | regex`, and the viewer/editor neutrality of a
selection.

## Acceptance criteria

- [ ] `docs/spec.md` states the syntax grammar (path / line / point / range /
      anchor / regex forms) with at least three concrete examples, including
      `src/lexer.ts:10:1-20:2 \`xs.push\``.
- [ ] The cascade order is defined and, for each omitted stage, the fallback
      rule is stated; the precedence among selector kinds when several are
      present is stated; "never a silent wrong match" is stated.
- [ ] The mode-neutral use (one selection as viewer or as editor) is stated.
- [ ] `docs/glossary.md` defines the selection terms (selector, anchor/matcher,
      stage) once; no spec/glossary disagreement.
- [ ] The exported selector/selection types are added so later children compile
      against them; no behavior change and no prompt change.

## Verification

```
bun .opencode/scripts/docrefs.ts check
bunx tsc --noEmit
grep -nE "cascade|selector|anchor" docs/spec.md docs/glossary.md
```

Review the stated grammar against the cascade children's behavior once they
land.

## Notes

- Root of the umbrella; every other child depends on this vocabulary.
- Open question to settle here: whether a finer stage must sit inside the
  coarser *match* or only inside the enclosing *declaration/span*.
- Non-goals: implementation and prompt changes.
