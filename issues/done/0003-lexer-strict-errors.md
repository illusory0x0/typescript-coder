---
id: 3
title: Lexer with strict errors
status: done
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

- [x] Tokens cover identifiers, keywords, all literals (string, template with
      substitutions, numeric incl. separators/bigint, regex, boolean), and
      punctuation/delimiters.
- [x] Trivia (whitespace, line/block comments) is captured, not silently dropped.
- [x] Invalid input (unterminated string/template/comment, bad number) throws an
      error carrying line/column (or byte span).
- [x] Tokenizer snapshot tests pass over the fixture corpus.

## Verification

```
bun test src/lexer.test.ts
```

## Notes

- Depends on #2 (scaffold).
- Blocks #4 (parser).
- **Public API contract for #4** (`src/lexer.ts`, 42 lexer tests green):
  - `TokenKind`: identifier, keyword, number, bigint, string, regex, punctuator,
    whitespace, line-comment, block-comment, no-substitution-template,
    template-head, template-middle, template-tail, eof.
  - `Token { kind, text, value, start, end, line, column }` — `text` is the raw
    slice, `value` the decoded text; 1-based `line`/`column`; `start`/`end` are
    code-unit offsets.
  - `LexError extends Error` with `offset`, `line`, `column`; thrown (never
    returned) for malformed input.
  - `class Lexer { next(): Token; peek(): Token; rescanRegex(): Token;
    rescanTemplateToken(): Token }`.
    - `rescanRegex()`: call after `next()` returned a `/` or `/=` **punctuator**
      at an expression position; it rewinds to that token and returns a `regex`
      token. Do not call `peek()` in between.
    - `rescanTemplateToken()`: called after the `}` punctuator that closes a
      `${...}` substitution; returns `template-middle` (another `${` follows) or
      `template-tail`. The returned token's `text` includes the `}` itself.
  - `tokenize(source): Token[]` — all tokens incl. trivia, eof last; uses a
    previous-non-trivia-token heuristic for regex-vs-division (see lexer.ts
    `allowsRegexAfter`).
  - `reservedKeywords` → kind `keyword`; `contextualKeywords` → lexed as
    `identifier` but exported for parser decisions. Booleans `true`/`false`
    (and `null`) are reserved keywords, not a separate kind — parser treats them
    as literals.
  - Templates: `next()` emits `no-substitution-template` or `template-head`;
    expression tokens follow; then consumer calls `rescanTemplateToken()`.
- **Implementation history:** delegated in 5 bounded chunks (initial single-shot
  delegations failed silently; see umbrella notes); final review by main agent.
- Verified 2026-10-16: `bun test src/lexer.test.ts` 42 pass / 0 fail;
  `bunx tsc --noEmit` exit 0; `bun test` 43 pass / 0 fail.
