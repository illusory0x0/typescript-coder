---
id: 8
title: Tools (rename, scroll, find-definition, check, test)
status: done
priority: medium
milestone: M6
parent: 1
deps: [6]
labels: [tools]
created: 2026-10-16
---

## Context

Milestone **M6** of [spec.md](../../docs/spec.md) §11, implementing the tool set from
spec §7 and `scroll.ts` (spec §5). These are the tools exposed to the LLM through
the provider's `tools` param (spec §8). `check` shells out to `tsc --noEmit` and
`test` to `bun test` (spec §10).

## Goal

All five tools are implemented and independently invocable: `rename`, `scroll`,
`find-definition`, `check`, `test`.

## Acceptance criteria

- [x] `find-definition` resolves a `Locator` to its declaration via the index.
- [x] `check` runs `tsc --noEmit` and returns diagnostics (exit status + parsed
      messages).
- [x] `test` runs `bun test` and returns pass/fail plus output.
- [x] `scroll` shows a symbol's signature view with on-demand expand (N-line
      expand per spec §13).
- [x] `rename` applies a symbol rename through the editor.
- [x] Each tool has a passing unit test.

## Verification

```
bun test src/tools/*.test.ts
```

## Notes

- Depends on #6 (editor; transitively binder/parser/lexer).
- Blocks #9 (loop drives tools).
- R4: `check`/`test` cost — support changed-files scoping and timeouts.
- **Contract for #9** (27 tests green; tools live in `src/tools.ts`, scroll
  rendering in `src/scroll.ts`; note: the spec's file list did not name a tools
  module — deviation recorded):
  - `findDefinitionTool(files: SourceFile[], locator): IndexEntry | null`.
  - `renameTool(source, locator, newName, fileName?): Promise<string>` — renames
    the declaration name via `applyEdits` (v1: declaration only; same-file
    references are NOT rewritten).
  - `checkTool(cwd, command?): Promise<CommandResult & { diagnostics }>` —
    defaults to `bunx tsc --noEmit` in `cwd`; diagnostics parsed as
    `{file, line, column, message}`; 30s kill timeout.
  - `testTool(cwd, command?): Promise<CommandResult>` — defaults to `bun test`.
  - `buildSignatureView(source, locator, fileName?)` and
    `expand(source, locator, {fileName, maxLines?})` (default 40 lines; appends
    `// ... N more lines (use expand with a higher maxLines)`).
  - `tools: ToolDefinition[]` exposes all five (find-definition, scroll, rename,
    check, test) for the provider's `tools` param.
- **Implementation history:** delegated in 2 bounded sub-agent tasks; diffs
  reviewed, verification re-run by the main agent.
- Verified 2026-10-16: `bun test src/tools.test.ts` 27 pass / 0 fail;
  `bunx tsc --noEmit` exit 0; `bun test` 351 pass / 0 fail across 7 files.
