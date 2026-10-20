---
id: 80
title: "CLI sub-agent contract: --format json result, budget/verify/cwd flags, tc bin"
status: todo
priority: medium
milestone: null
parent: 79
deps: []
labels: [cli, integration]
created: 2026-10-20
---

## Context

`tc`'s CLI (`src/main.ts`, `src/cli.ts`) reads an issue on stdin and prints a
human sentence to stdout; it exposes only `--model`/`--help` and never passes a
token budget, although `LoopOptions` already supports `tokenBudget`,
`checkCommand`, `testCommand`, `commandTimeoutMs`, `cwd` (`src/loop.ts:1218`).
`opencode` needs a machine-parseable result and spend control to use `tc` as a
sub-agent.

## Goal

`tc` gains a documented `typescript-coder-result@1` JSON result on stdout, a hard
per-call token budget, verify-command flags, an explicit cwd, and a runnable
`tc` bin — with the default text output unchanged.

## Acceptance criteria

- [ ] `--format json` emits exactly one `typescript-coder-result@1` JSON object
      on stdout; diagnostics/progress go to stderr; the object carries
      `{status, verified, files, targets, records, tokens, terminationReason, diagnostics}`.
- [ ] exit code is `0` iff `verified`, non-zero otherwise.
- [ ] `--token-budget <n>`, `--check <cmd>`, `--test <cmd>`, `--cwd <dir>` map
      to `LoopOptions` (`tokenBudget`/`checkCommand`/`testCommand`/`cwd`) and are
      enforced; a default hard budget applies.
- [ ] the default `--format text` output is byte-identical to today and every
      `acceptance` scenario still passes.
- [ ] a `tc` bin is declared (`package.json` `"bin"`) and runs via `bun link`.
- [ ] unit tests cover result serialization, exit codes, and the stdout/stderr
      split.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
printf 'update greet to store the greeting\n' | tc --format json   # parses as one JSON object
```

## Notes

- Contract reference: plan §2. Blocks C2, C3, C4.
- Non-goals: registry publish, `opencode` plugin.
