---
id: 85
title: "CLI: expose a per-call command timeout (--timeout)"
status: done
priority: medium
milestone: null
parent: 79
deps: []
labels: [cli, integration]
created: 2026-10-20
---

## Context

`LoopOptions.commandTimeoutMs` bounds each `tsc`/test command (default
120_000 ms; see `src/tools.ts`), but the `--targets`/`--format` CLI added in #80
never exposes it. A sub-agent that runs `tc` on a repository whose test suite
takes longer than 120 s gets its check/test command killed, so `tc`'s own
verification always fails and the run storms to `edit-exhausted`/`token-budget`
even when the edit is correct. Found while doing #83: the self-host delegated
edit landed with all gates green, but `tc` reported `edit-exhausted` because its
`bun test` verification was killed at the 120 s default (this repository's
`bun test` is ~183 s).

## Goal

The CLI exposes a per-call command timeout, mapped to
`LoopOptions.commandTimeoutMs`, so self-hosting verification can complete.

## Acceptance criteria

- [ ] `--timeout <ms>` (and `--timeout=<ms>`) parses a positive integer and maps to `LoopOptions.commandTimeoutMs`; a `--check`/`--test` command is bounded by it.
- [ ] the help text documents `--timeout <ms>` and its default (120000 ms).
- [ ] the default behavior is unchanged (no flag keeps the existing 120 s default).
- [ ] unit tests cover parsing, validation, and the mapping.

## Verification

`bunx tsc --noEmit`; `bun test`; a `tc` run with a >120 s `--test` command and
`--timeout <large>` that completes and reports `verified: true`.

## Notes
- Added --timeout <ms> (and --timeout=<ms>) to the CLI, parsed as a positive integer by a parseTimeout sibling of parseTokenBudget and mapped to LoopOptions.commandTimeoutMs through RunMainOptions and the import.meta.main wiring; helpText documents it with the 120000 default and docs/subagent.md gained the flag row. Found via #83: tc's own self-host verification always failed because testTool kills a check/test command at the 120s default while this repo's bun test is ~183s. Verification: bunx tsc --noEmit clean; bun test src/cli.test.ts 38 pass; bun test 853 pass.
