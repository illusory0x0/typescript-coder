---
id: 105
title: "LLM-friendly cascading selection protocol (compact positional syntax)"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [umbrella]
created: 2026-10-20
---

## Context

Today the model addresses and edits through a flat JSON payload
(`{"path","symbol","kind","matcher"?,"range"?,"replacement"}`) whose address
`path × symbol × kind` is a mandatory strict AND (`docs/spec.md:7-12`, `:89-107`)
and whose within-declaration selectors are a short-circuit `range ▸ matcher ▸
whole-symbol` (`src/loop.ts:2853`, not a cascade). The `range` selector's
adoption measured **0** (`#101`), and a steer that merely *offered* `range` in
matcher-failure text showed **no effect** (`#102`, range 0 in both arms). The
root cause is that JSON addressing is not the form the model reads text in.

Compiler diagnostics (C and friends) put the position first in a compact,
model-familiar form: `src/lexer.ts:10:1-20:2 \`xs.push\``. We want one such
compact positional syntax whose optional prefix stages **are** the addressing
cascade:

```
<path>[:<line>[:<col>[-<line>[:<col>]]]] [`<anchor>`]
```

- Stages `path → symbol → matcher → selector`, where a selector is one of
  `line | (line,column) | range | regex`.
- Each stage is optional: supplying a finer stage narrows inside the coarser
  one; omitting it resolves at the coarser stage, never as a silent wrong match
  ("if the model doesn't give it, it can still select").
- One selection serves both reading (**viewer**) and editing (**editor**).

## Goal

The model addresses and edits with a compact positional syntax over an
optional-stage cascade; every stage may be omitted with fallback; the resolved
stage/selector is instrumented; few-shot examples teach it; and an A/B measures
adoption and cost.

## Acceptance criteria

- [ ] The syntax grammar and the `path → symbol → matcher → selector` cascade
      are specified in spec/glossary (child: specification).
- [ ] The syntax parses and serializes with typed parse diagnostics (child:
      parser/serializer).
- [ ] Optional stages resolve with fallback and never a silent wrong match, and
      the coordinate kinds `line`/`(line,column)` are supported (child: cascade
      resolution).
- [ ] `regex` is a supported selector kind (child: regex selector).
- [ ] The resolved stage/selector is recorded per applied edit and surfaced in
      the benchmark report (child: instrumentation).
- [ ] Few-shot examples exist and an A/B reports adoption plus cache-excluded
      tokens/USD per success with an honest verdict (child: few-shot + A/B).
- [ ] Each child is decided (`done` or `wontfix`); the umbrella closes only when
      all are.

## Verification

```
bun .opencode/scripts/issue-tracker.ts check --strict
```

plus each child's own verification.

## Notes

- Supersedes the range-only premise of `#100`; the range-only steer `#102`
  should be retired in favor of this cascade (decided through the resolver, not
  here).
- Filed 2026-10-20 from the selector discussion (`#72` / `#100`–`#102`
  follow-up).
- Non-goals: removing the structural matcher, weakening the ambiguity/echo/
  syntax gates, or making any stage mandatory.
