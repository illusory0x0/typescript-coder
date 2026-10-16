---
id: 8
title: Tools (rename, scroll, find-definition, check, test)
status: todo
priority: medium
milestone: M6
parent: 1
deps: [6]
labels: [tools]
created: 2026-10-16
---

## Context

Milestone **M6** of [spec.md](../spec.md) §11, implementing the tool set from
spec §7 and `scroll.ts` (spec §5). These are the tools exposed to the LLM through
the provider's `tools` param (spec §8). `check` shells out to `tsc --noEmit` and
`test` to `bun test` (spec §10).

## Goal

All five tools are implemented and independently invocable: `rename`, `scroll`,
`find-definition`, `check`, `test`.

## Acceptance criteria

- [ ] `find-definition` resolves a `Locator` to its declaration via the index.
- [ ] `check` runs `tsc --noEmit` and returns diagnostics (exit status + parsed
      messages).
- [ ] `test` runs `bun test` and returns pass/fail plus output.
- [ ] `scroll` shows a symbol's signature view with on-demand expand (N-line
      expand per spec §13).
- [ ] `rename` applies a symbol rename through the editor.
- [ ] Each tool has a passing unit test.

## Verification

```
bun test src/tools/*.test.ts
```

## Notes

- Depends on #6 (editor; transitively binder/parser/lexer).
- Blocks #9 (loop drives tools).
- R4: `check`/`test` cost — support changed-files scoping and timeouts.
