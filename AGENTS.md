# AGENTS.md

`tc` — a TypeScript coding agent: a pinned-repair Edit → Verify loop plus a
plan-exec Plan → Execute → Review loop, driven by an OpenAI-compatible
gateway and packaged as a sub-agent for opencode. Bun runtime, no build step.

## Boundaries

- `human/` is human-authored and **read-only for agents**: read it for context,
  but never write to it — no edits, moves, deletions, or generated files, and no
  formatter rewrites. Format only files outside `human/`; do not run a
  repo-wide formatter that rewrites it.

## Commands (there is no CI; `just` is the source of truth)

```sh
just typecheck   # bunx tsc --noEmit
just test        # bun test  (serial default; scoped to src/ via bunfig.toml)
just test-parallel [n]  # opt-in bounded file-level workers; default min(nproc, 4)
just format      # bunx oxfmt  — formatter is oxfmt, NOT prettier/biome; repo-wide, rewrites human/
just accept      # offline acceptance scenarios; flags pass through (--all, --live, --only <id>)
```

Run before finishing: format only the files you changed (`bunx oxfmt <files>`), then
`just typecheck && just test`. Do not run `just format` repo-wide — it rewrites
`human/`; see Boundaries. Tests are colocated `src/*.test.ts`; single test:
`bun test src/loop.test.ts -t "pattern"`.

### Testing / parallel safety

`just test` stays the serial, deterministic default. `just test-parallel [n]`
is opt-in: it runs `bun test --parallel` with `min(nproc, 4)` workers by default
and accepts a lower positive count (`just test-parallel 2`) or the
`TC_TEST_JOBS` env override. It is file-level parallelism only (Bun implies
`--isolate`); do not add `--concurrent`.

Do not add `test.concurrent` yet. `src/loop.test.ts` is one large file that
mutates process-global env flags, and other files spawn `tsc`/`bun` subprocesses
or use fixed repo workspaces (`src/judge-golden.test.ts`); within-file
concurrency is out of scope until those are proven isolated. Env-mutating tests
must restore state in `finally`/`afterEach`. The `src/cli.test.ts` self-host
smoke writes `.nested-smoke` and runs only the copied target test
(`src/index.test.ts`), never a full copied suite, so a parallel worker cannot fan
out the suite recursively.

## Evaluation

Live evaluation is not a development loop. Do not run `just accept --live` or
`bun run benchmark/run.ts` frequently: the human can predict most outcomes from
engineering intuition, and repeated runs only burn tokens. Prefer improving the
harness — deterministic tests, offline acceptance scenarios, replay fixtures,
diagnostics — and reserve a targeted live run for the end of a change, when a
human asks for it or the harness cannot answer the question.

The oc side and the legacy `json` edit protocol are **frozen reference points**:

- `benchmark/results/oc-baseline.json` — oc, official `deepseek/deepseek-flash`,
  4 tasks × 3 reps, 2026-10-24.
- `benchmark/results/json-format-baseline.json` — tc with `--protocol-format
  json`, 4 tasks × 3 reps, 2026-10-24.

Strictly forbidden, with no exception: **do not run `--side oc` and do not run
`--protocol-format json`** in the benchmark. Do not ask whether to run them; the
benchmark now rejects both. tc reports run `--side tc` with the default
`--protocol-format edit-dsl` and report savings against **both** frozen
baselines (oc and tc json) in a four-way table;
`--agent-mode pinned-repair|plan-exec|both` selects the tc loop mode(s),
where `both` is the benchmark's multi-mode selector; the `edit` alias is
deprecated.

## Layout / entrypoints

- `src/main.ts` — CLI entry (`#!/usr/bin/env bun`, piped-stdin contract `tc < task.txt`; a TTY stdin prints help).
- `src/loop.ts` — `runLoop` dispatcher (default pinned-repair; plan-exec route) + `buildSystemPrompt` (the model-facing prompt is a literal in this file; prompt text is benchmark-sensitive).
- `src/tasks.ts` / `src/task-loop.ts` — Plan → Stage → Task → edit tree contract and the `--mode plan-exec` driver: incremental one-Task execution, post-execution review, usage buckets; spec in `docs/spec.md`.
- `src/plan-dsl.ts` — flat Plan and patch DSL parser/serializer; `src/dsl-diagnostics.ts` — shared tolerant diagnostics renderer.
- `src/prompts/task.ts` — planning/execution/review prompt text for plan-exec.
- `src/tools.ts` — check/test tools; default verify commands are `bunx tsc --noEmit` and `bun test`.
- `src/editor.ts` — splice + oxfmt + parse gate. `src/utility.ts` — symbol index (path×symbol×kind).
- `src/openai.ts` — provider config from env, retries/timeouts. `src/result.ts` — the `typescript-coder-result@2` sub-agent result contract.
- `src/index.ts` — leftover scaffold (`greet`) kept as the self-host fixture target; don't "clean it up".
- `human/` — human-authored specs; read-only (see Boundaries).
- `acceptance/`, `benchmark/` — harnesses, read their READMEs before changing.

## Gotchas

- `.env` (gitignored) holds `OPENAI_BASE_URL`/`OPENAI_API_KEY`; Bun auto-loads it into `process.env`, but invoking as `node` (`bun --bun`, `bunx --bun`) disables that loading. Offline tests must not hit the network.
- `bun test` at root only sees `src/` (`bunfig.toml` `root = "./src"`); acceptance/benchmark run their own commands.
- `benchmark/` is excluded from `tsc` (`benchmark/fixtures`), and `judge-golden.test.ts` imports it through a computed specifier so the self-host copy of just `src/` stays green — preserve that trick when touching `benchmark/`.
- `tsconfig` is strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`: use `import type`, handle possibly-undefined index results (code style follows this: `const x = arr[i]; if (x === undefined) …`).
- Live checks cost tokens: `just accept --live` and `bun run benchmark/run.ts` call the real model (benchmark default `deepseek-flash` on the official endpoint). Don't run them unprompted, and don't use them as an iteration loop — see Evaluation. Measured benchmark runs default to 5 reps and warm only the stable system-prompt prefix; reports print cache-hit ratios and warn when they are badly imbalanced.
- `csv-parser` benchmark fixture is held out — never tune prompts or code against it.
- Benchmark artifacts (`benchmark/results/`, `failures/`, `tmp/`, `acceptance/report.json`) are generated; don't commit unless the ledger (`consumption.md`) cites them.
- Commits are titled by topic (`resolve-issue: …`, `Land #80: …`) and reference tracker issue numbers in comments as `(#NN)`; the tracker is the local coding-skills set, not GitHub.
