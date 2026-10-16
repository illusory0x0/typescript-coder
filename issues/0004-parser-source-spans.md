---
id: 4
title: Recursive-descent parser with source spans
status: todo
priority: medium
milestone: M2
parent: 1
deps: [3]
labels: [frontend]
created: 2026-10-16
---

## Context

Milestone **M2** of [spec.md](../spec.md) §11, implementing `parser.ts` (spec
§5). Consumes the lexer token stream and produces an AST annotated with source
spans. Per spec §9 the surface is modern app TS: ES2024 syntax, full TS type
grammar, decorators, namespaces, `.d.ts`, declaration merging, and overloads —
**excluding** JSX/TSX.

## Goal

`parser.ts` parses the supported TypeScript surface into an AST where every node
carries a source span, and rejects malformed input with a located error.

## Acceptance criteria

- [ ] Recursive-descent parser produces an AST with source spans for ES2024 + TS
      type grammar constructs (declarations, statements, expressions, types).
- [ ] Decorators, namespaces, `.d.ts`, declaration merging, and overload
      signatures parse correctly.
- [ ] JSX/TSX is out of scope and is not required to parse.
- [ ] Malformed input throws a located parse error.
- [ ] AST snapshot tests pass over the fixture corpus.

## Verification

```
bun test src/parser.test.ts
```

## Notes

- Depends on #3 (lexer).
- Blocks #5 (binder).
- AST shape is the contract consumed by the binder (#5) and editor (#6).
