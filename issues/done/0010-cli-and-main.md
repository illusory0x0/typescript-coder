---
id: 10
title: CLI and main stdin entry
status: done
priority: medium
milestone: M8
parent: 1
deps: [9]
labels: [cli]
created: 2026-10-16
---

## Context

Milestone **M8** of [spec.md](../spec.md) §11, implementing `cli.ts` and
`main.ts` (spec §5). The issue is delivered on **stdin** (spec §6, §8);
`cli.ts` currently provides only `--help` and the `--model` flag; `main.ts`
wires stdin into the loop.

## Goal

`main.ts` reads the issue from stdin and drives the loop; `cli.ts` exposes
`--help` and `--model`, and the agent passes the self-host smoke test.

## Acceptance criteria

- [x] `main.ts` reads the issue from stdin and invokes the loop.
- [x] `cli.ts` supports `--help` and `--model <id>` (model selection is the only
      CLI option affecting the run).
- [x] Failure explanations are surfaced (stderr + final stdout message per spec
      §13).
- [x] Self-host smoke: after the agent edits its own `src/`, `tsc --noEmit` and
      `bun test` still pass.

## Verification

```
echo "<issue text>" | bun run src/main.ts --model deepseek
bun run src/cli.ts --help
bunx tsc --noEmit && bun test
```

## Notes

- Depends on #9 (loop).
- Closes the umbrella #1 once the three anchor fixtures pass.
- **Implementation:**
  - `cli.ts`: `parseArgs(argv) -> {help, model}` (`--help`/`-h`, `--model <id>`,
    `--model=<id>`, unknown args throw, default `deepseek`, last `--model`
    wins), `helpText()`; `import.meta.main` guard prints help.
  - `main.ts`: `runMain({issue, model, cwd, provider, io?, maxRetries?})` ->
    exit code; empty issue -> 1 `error: no issue provided on stdin`; success ->
    `applied <kind> <name> to <path> after <n> attempt(s)` on stdout; failure ->
    diagnostics on stderr + explanation on stderr AND as the final stdout
    message; entry block reads `Bun.stdin.text()`, builds
    `OpenAIProvider(readConfigFromEnv(model))`, `process.exit(code)`.
  - Self-host smoke test: copies `src/` + `tsconfig.json` into a temp dir,
    symlinks `node_modules`, scripted provider rewrites `src/index.ts` `greet`
    behavior-preservingly; `runMain` returns 0, which requires the loop's own
    verification (default `checkTool` = `bunx tsc --noEmit` and `testTool` =
    `bun test`) to have passed on the edited copy; the copied suite also runs
    green. A `.nested-smoke` marker prevents infinite recursion in the copy.
  - Live `main.ts` runs require a key permitting `deepseek`/`qwen` (see #7's
    live-smoke note); CLI tests are fully offline.
- **Implementation history:** delegated as one bounded sub-agent task; diff
  reviewed, verification re-run by the main agent.
- Verified 2026-10-16: `bun test src/cli.test.ts` 14 pass / 0 fail;
  `bunx tsc --noEmit` exit 0; `bun test` 394 pass / 0 fail across 9 files
  (suite ~55s, dominated by the 41s self-host smoke).
