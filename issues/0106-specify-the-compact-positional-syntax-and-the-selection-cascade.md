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
- Syntax parity with compiler diagnostics (2026-10-20 refinement): adopt the gcc/clang shape `<path>[:<line>[:<col>[-<endline>[:<endcol>]]]]: [`<anchor>`]` — note the `: ` before the anchor, mirroring `error: `. References: gcc `tmp.c:2: error:` / `tmp.c:1:5-1:8:` (-fdiagnostics-print-source-range-info); clang `tmp.c:1:13: error:` plus the `1 | ` gutter and caret `^`, and fix-it `{1:9-1:9}:"{"`; tsc machine `tmp.ts(1,13): error TS1005:` and pretty `tmp.ts:1:13 - error TS1005:`; python tracebacks `File "x", line N` with `~~~^~~` (3.11+). What we borrow: the colon form as primary (widely parsed), the `N | ` gutter (tc already renders it via numberedSourceBlock, src/loop.ts:239), an optional caret line as the viewer affordance, and the `l:c-l:c` range. Examples: `src/lexer.ts:10:5`, `src/lexer.ts:10:5-20:2`, `src/lexer.ts:10:5-20:2: `xs.push``, `src/lexer.ts: /^export function/`. Open for this child: (a) where symbol/kind go — position may derive the containing declaration, dropping the name inputs; (b) how the replacement is expressed (compiler fix-it style vs a following block); (c) whether tsc (line,col) is accepted leniently.
- Range-format survey written to docs/position-formats.md, captured live: gcc 15.2, clang 21.1.8, rustc 1.96, python 3.14, node 22.17, bun 1.3.13, tsc 7.0.2. Key facts: `path:line:col` is universal; only clang spells a text range (path:l:c:{l:c-l:c}:) and rustc carries a full range only in its JSON span (line_start + column_start to line_end + column_end); gcc/tsc/node/bun are point-only; python tracebacks are the outlier (no colon, no column before 3.11); the `N | ` gutter plus caret is universal and tc already renders the gutter. Recommendation: primary `path:line:col:`, optional `l:c-l:c` range suffix (clang braces dropped, rustc start-to-end), gutter plus caret for the viewer affordance. The range-encoding decision is the open ask.
