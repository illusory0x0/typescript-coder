---
id: 80
title: "CLI sub-agent contract: --format json result, budget/verify/cwd flags, tc bin"
status: done
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
- Implemented. New src/result.ts (typescript-coder-result@1; buildSubagentResult/serializeSubagentResult) + src/result.test.ts. LoopResult gains a required tokens tally {input,output,total,cacheRead} accumulated from provider usage alongside the unchanged consumedTokens budget, threaded to every return (deletion path zeros). cli.ts adds --format text|json (validated), --token-budget, --check, --test, --cwd in both --flag value and --flag=value forms; main.ts adds a JSON path that prints exactly one result object on stdout with the failure artifact/diagnostics/explanation on stderr, leaving the text path byte-identical; package.json declares bin tc -> ./src/main.ts with a #!/usr/bin/env bun shebang. Supporting change: src/lexer.ts treats a byte-0 #!... as a line comment so the repo's own parser accepts the runnable entry (parser/utility/self-host tests otherwise break); two existing LoopResult fixtures gained the required tokens field. Verification: bunx tsc --noEmit clean; bun test 843 pass; bun run accept 5/5; printf '' | tc --format json emits exactly one result object on stdout, error on stderr, exit 1. The live 'printf ...greet... | tc --format json' check is deferred because it would mutate this repo's src/index.ts.
