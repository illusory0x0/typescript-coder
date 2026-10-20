---
id: 106
title: "Specify the compact positional syntax and the selection cascade"
status: review
priority: medium
milestone: null
parent: 105
deps: []
labels: [docs, agent-loop]
created: 2026-10-20
---

## Context

`docs/spec.md` defines the shipped wire protocol as a flat JSON payload with a
mandatory strict-AND address and matcher/range selectors (`:7-12`, `:89-107`,
`:175-198`). The compact syntax the model should emit is specified in
`docs/edit-protocol.md`:
`select [kind] <symbol> in <path> [ match (<snippet> | /regex/) [ pick
<multiRange> ] ] [ replace with <fence> ] end`. Nothing before it defined this
grammar, the `select → match → pick → replace` cascade, the per-stage fallback
rule, the precedence between `match` and `pick`, or that one selection serves
both reading and editing.

## Goal

`docs/edit-protocol.md` defines the compact syntax grammar, the selection
cascade, optional-stage fallback, the selector kinds (`match` snippet / regex,
`pick` ranges), and the viewer/editor neutrality of a selection.

## Acceptance criteria

- [ ] `docs/edit-protocol.md` states the syntax grammar (the `select` / `match` /
      `pick` / `replace` forms) with at least three concrete examples.
- [ ] The cascade order is defined and, for each omitted stage, the fallback
      rule is stated; the precedence between `match` and `pick` is stated;
      "never a silent wrong match" is stated.
- [ ] The mode-neutral use (one selection as viewer or as editor) is stated.
- [ ] The selection terms (matcher, viewer, editor, stage) are defined once; no
      doc disagreement, and `anchor` is not used for the matcher.

## Verification

```
dm xref
bunx tsc --noEmit
grep -nE "cascade|matcher|select" docs/edit-protocol.md
```

Review the stated grammar against the cascade children's behavior once they
land.

## Notes

- Root of the umbrella; every other child depends on this vocabulary.
- Settled (2026-10-20): `pick` sits inside `match` (it filters the match set),
  never beside it.
- Non-goals: implementation and prompt changes.
- Syntax parity with compiler diagnostics (2026-10-20 refinement): adopt the gcc/clang shape `<path>[:<line>[:<col>[-<endline>[:<endcol>]]]]: [`<matcher>`]` — note the `: ` before the matcher form, mirroring `error: `. References: gcc `tmp.c:2: error:` / `tmp.c:1:5-1:8:` (-fdiagnostics-print-source-range-info); clang `tmp.c:1:13: error:` plus the `1 | ` gutter and caret `^`, and fix-it `{1:9-1:9}:"{"`; tsc machine `tmp.ts(1,13): error TS1005:` and pretty `tmp.ts:1:13 - error TS1005:`; python tracebacks `File "x", line N` with `~~~^~~` (3.11+). What we borrow: the colon form as primary (widely parsed), the `N | ` gutter (tc already renders it via numberedSourceBlock, src/loop.ts:239), an optional caret line as the viewer affordance, and the `l:c-l:c` range. Examples: `src/lexer.ts:10:5`, `src/lexer.ts:10:5-20:2`, `src/lexer.ts:10:5-20:2: `xs.push``, `src/lexer.ts: /^export function/`. Open for this child (superseded 2026-10-20): the final grammar keeps `symbol`/`kind` mandatory (a position does not derive the containing declaration) and expresses the replacement as a fenced block.
- Range-format survey written to docs/edit-protocol.md, captured live: gcc 15.2, clang 21.1.8, rustc 1.96, python 3.14, node 22.17, bun 1.3.13, tsc 7.0.2. Key facts: `path:line:col` is universal; only clang spells a text range (path:l:c:{l:c-l:c}:) and rustc carries a full range only in its JSON span (line_start + column_start to line_end + column_end); gcc/tsc/node/bun are point-only; python tracebacks are the outlier (no colon, no column before 3.11); the `N | ` gutter plus caret is universal and tc already renders the gutter. Recommendation: primary `path:line:col:`, optional `l:c-l:c` range suffix (clang braces dropped, rustc start-to-end), gutter plus caret for the viewer affordance. The range-encoding decision is recorded in the next bullet.
- Decision (2026-10-20): range encoding is `path:line:col` with an optional `l:c-l:c` suffix, i.e. `<path>[:<line>[:<col>[-<line>[:<col>]]]]: [`<matcher>`]`. Chosen over clang brace-exact `{l:c-l:c}` (more punctuation), point-only text (cannot carry a range on one line), and a `..` variant. Grounded in the position-format survey (now the appendix of docs/edit-protocol.md).
- Grammar (2026-10-20): the wire syntax is
  `select [kind] <symbol> in <path> [ match (<snippet> | /regex/) [ pick
  <multiRange> ] ] [ replace with <fence> ] end`, superseding the one-line
  `<path>[:<line>…] [`<matcher>`]` draft in the notes above. The selection is a
  `select → match → pick → replace` cascade; the term is **matcher** (not
  anchor); `pick` sits inside `match` and only disambiguates. Specified in
  `docs/edit-protocol.md`.
- Dropped from this issue: the "exported selector/selection types" AC —
  `docs/edit-protocol.md` defines no code, and the parser/serializer types are
  `#107`'s; no two issues own it.
