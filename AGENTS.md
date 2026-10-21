# AGENTS.md

`tc` — a TypeScript coding agent: an Edit → Verify loop driven by an OpenAI-compatible
gateway, packaged as a sub-agent for opencode. Bun runtime, no build step.

## Commands (there is no CI; `just` is the source of truth)

```sh
just typecheck   # bunx tsc --noEmit
just test        # bun test  (scoped to src/ via bunfig.toml)
just format      # bunx oxfmt  — formatter is oxfmt, NOT prettier/biome
just accept      # offline acceptance scenarios; flags pass through (--all, --live, --only <id>)
```

Run before finishing: `just format && just typecheck && just test`. Tests are colocated
`src/*.test.ts`; single test: `bun test src/loop.test.ts -t "pattern"`.

## Layout / entrypoints

- `src/main.ts` — CLI entry (`#!/usr/bin/env bun`, piped-stdin contract `tc < task.txt`; a TTY stdin prints help).
- `src/loop.ts` — `runLoop` + `buildSystemPrompt` (the model-facing prompt is a literal in this file; prompt text is benchmark-sensitive).
- `src/tools.ts` — check/test tools; default verify commands are `bunx tsc --noEmit` and `bun test`.
- `src/editor.ts` — splice + oxfmt + parse gate. `src/utility.ts` — symbol index (path×symbol×kind).
- `src/openai.ts` — provider config from env, retries/timeouts. `src/result.ts` — the JSON sub-agent result contract.
- `src/index.ts` — leftover scaffold (`greet`) kept as the self-host fixture target; don't "clean it up".
- `acceptance/`, `benchmark/` — harnesses, read their READMEs before changing.

## Gotchas

- `.env` (gitignored) holds `OPENAI_BASE_URL`/`OPENAI_API_KEY`; Bun auto-loads it into `process.env`, but invoking as `node` (`bun --bun`, `bunx --bun`) disables that loading. Offline tests must not hit the network.
- `bun test` at root only sees `src/` (`bunfig.toml` `root = "./src"`); acceptance/benchmark run their own commands.
- `benchmark/` is excluded from `tsc` (`benchmark/fixtures`), and `judge-golden.test.ts` imports it through a computed specifier so the self-host copy of just `src/` stays green — preserve that trick when touching `benchmark/`.
- `tsconfig` is strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`: use `import type`, handle possibly-undefined index results (code style follows this: `const x = arr[i]; if (x === undefined) …`).
- Live checks cost tokens: `just accept --live` and `bun run benchmark/run.ts` call the real model (default `deepseek-v4.1-flash`). Don't run them unprompted.
- `csv-parser` benchmark fixture is held out — never tune prompts or code against it.
- Benchmark artifacts (`benchmark/results/`, `failures/`, `tmp/`, `acceptance/report.json`) are generated; don't commit unless the ledger (`consumption.md`) cites them.
- Commits are titled by topic (`resolve-issue: …`, `Land #80: …`) and reference tracker issue numbers in comments as `(#NN)`; the tracker is the local coding-skills set, not GitHub.
