---
id: 22
title: "CLI: default model deepseek-v4.1-flash instead of rejected deepseek"
status: todo
priority: high
milestone: null
parent: null
deps: []
labels: [cli]
created: 2026-10-17
---

## Context

`src/cli.ts:6` sets `const DEFAULT_MODEL = "deepseek"` and `helpText()`
advertises it (`src/cli.ts:50`). spec.md §8 (corrected in #14) records that the
gateway rejects the shorthand `deepseek` (403) and lists the real chat ids
(`deepseek-v4.1-flash`, `deepseek-v4-pro-0813`, `glm-5.3`, `zoe/glm-5.3`).
#14 fixed records only, not the code default, so the documented entry point
`bun run src/main.ts < issue.txt` (no `--model`) always fails at the first chat
call. `src/cli.test.ts:40-46,68-70` currently pins the broken default.

## Goal

The CLI works out of the box with the verified gateway default
`deepseek-v4.1-flash`, with tests and help text updated.

## Acceptance criteria

- [ ] `DEFAULT_MODEL = "deepseek-v4.1-flash"`; `--model` / `--model=` override
      behavior unchanged.
- [ ] `helpText()` prints the new default; `src/cli.test.ts` expectations
      updated.
- [ ] No source occurrence of the bare `"deepseek"` model default remains
      (`grep -rn '"deepseek"' src/` is clean).
- [ ] `bunx tsc --noEmit` 0; `bun test` green; `bun run accept` 5/5.

## Verification

```
grep -rn '"deepseek"' src/
bun run src/main.ts --help
bunx tsc --noEmit
bun test
bun run accept
```

## Notes

- Priority `high` (Eisenhower Q1: out-of-the-box failure).
- Optional live confirmation (already the acceptance default):
  `bun run accept --live --model deepseek-v4.1-flash`.
