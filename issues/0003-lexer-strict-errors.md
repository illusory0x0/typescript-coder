---
id: 3
title: Lexer with strict errors
status: todo
priority: medium
milestone: M1
parent: 1
deps: [2]
labels: [frontend]
created: 2026-10-16
---

## Context

Milestone **M1** of [spec.md](../spec.md) §11, implementing `lexer.ts` (spec §5).
The spec requires a full TypeScript lexer with **no error tolerance** — malformed
input must throw with a source location.

## Goal

`lexer.ts` converts TypeScript source into a token stream covering the full TS
token set, capturing trivia/comments, and throwing located errors on invalid
input.

## Acceptance criteria

- [ ] Tokens cover identifiers, keywords, all literals (string, template with
      substitutions, numeric incl. separators/bigint, regex, boolean), and
      punctuation/delimiters.
- [ ] Trivia (whitespace, line/block comments) is captured, not silently dropped.
- [ ] Invalid input (unterminated string/template/comment, bad number) throws an
      error carrying line/column (or byte span).
- [ ] Tokenizer snapshot tests pass over the fixture corpus.

## Verification

```
bun test src/lexer.test.ts
```

## Notes

- Depends on #2 (scaffold).
- Blocks #4 (parser).
