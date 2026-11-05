# AGENTS.md

`tc` — a TypeScript coding agent: a pinned-repair Edit → Verify loop plus a
plan-exec Plan → Execute → Review loop, driven by an OpenAI-compatible
gateway and packaged as a sub-agent for opencode. Bun runtime, no build step.

## Boundaries

- `human/` is human-authored and **read-only for agents**: read it for context,
  but never write to it — no edits, moves, deletions, or generated files, and no
  formatter rewrites. Format only files outside `human/`; do not run a
  repo-wide formatter that rewrites it.

## Editing code

Prefer `tsed` for TypeScript code edits (install it with `just tsed-install` if
needed); use ordinary file tools for docs, config, generated files, and
non-TypeScript files. If `tsed` cannot express or reliably apply an edit after a
reasonable attempt, file an issue in the local tracker (use the `file-issue`
skill) describing the limitation, then fall back to another editing method so
the task still lands. Do not silently work around a `tsed` limitation without
recording it.

## Commands (there is no CI; `just` is the source of truth)

```sh
just typecheck   # bunx tsc --noEmit over the root harnesses and both packages
just test        # offline suites (editor, harness, scripts, acceptance); no API
just test --api llm|all  # opt-in real-model suites; costs money, owner lanes are serial
just test --include-slow # add the slow self-host acceptance suite
just test --list # show every suite, its api lane, and its owner
just test-parallel [n]   # alias for `just test --jobs <n>`
just tsed-install  # bun add -g the local typescript-editor package; points at this checkout
just tsed-check  # scs generate --check for the committed tsed CLI surface
just tsed-generate  # regenerate tsed parser/help/completions from scs/tsed.scs
just format      # bunx oxfmt  — formatter is oxfmt, NOT prettier/biome; repo-wide, rewrites human/
just accept      # offline acceptance scenarios; flags pass through (--all, --live, --only <id>)
```

Run before finishing: format only the files you changed (`bunx oxfmt <files>`), then
`just typecheck && just test`. Do not run `just format` repo-wide — it rewrites
`human/`; see Boundaries. Tests are colocated with their sources in each package;
single test: `bun test harness/src/loop.test.ts -t "pattern"`.

### Testing / parallel safety

`just test` runs the offline lane by default: `editor`, `harness`, `scripts`, and
`acceptance`, one suite at a time, with file-level `bun test --parallel` workers
inside the bun-test suites. `jobs` defaults to `min(nproc, 4)`, caps at 4, honors
`--jobs`/`TC_TEST_JOBS`, and `just test-parallel [n]` is the alias.
`--include-slow` adds `acceptance-self-host`. It is file-level parallelism only
(Bun implies `--isolate`); do not add `--concurrent`.

`--api llm` selects only suites declared `api: "llm"`; `--api all` runs the offline
lane first, then the API lane. API suites are grouped by `owner` and run one owner
at a time, with `--api-jobs` (default 1) bounding concurrency inside an owner; a
failing offline phase skips the API phase. `just accept` stays the
acceptance-specific entrypoint for `--only`, `--keep`, and `--induce-failure`.

Do not add `test.concurrent` yet. `harness/src/loop.test.ts` is one large file that
mutates process-global env flags, and other files spawn `tsc`/`bun` subprocesses
or use fixed repo workspaces (`harness/src/judge-golden.test.ts`); within-file
concurrency is out of scope until those are proven isolated. Env-mutating tests
must restore state in `finally`/`afterEach`. The `harness/src/cli.test.ts`
self-host smoke writes `.nested-smoke` and runs only the copied target test
(`harness/src/index.test.ts`), never a full copied suite, so a parallel worker
cannot fan out the suite recursively.

## Evaluation

Live evaluation is not a development loop. Do not run `just test --api llm|all`,
`just accept --live`, or benchmarks frequently: the human can predict most
outcomes from engineering intuition, and repeated runs only burn tokens. Prefer
improving the harness — deterministic tests, offline acceptance scenarios,
replay fixtures, diagnostics — and reserve a targeted live run for the end of a
change, when a human asks for it or the harness cannot answer the question.

The oc side is **frozen and currently has no committed baseline**: the historical
`benchmark/results/` tree, the cost ledger, and the oc baseline were removed
on 2026-10-27. The benchmark still hard-rejects `--side oc`; a new oc reference
run requires explicit human approval and a deliberate, temporary bypass of the
guard. Restore the guard after the approved matrix, and verify it is restored
before finishing. Never leave the bypass enabled.

**Live tests and any new baseline are human-gated.** Before running any benchmark
with `--reps >= 1` (including `--pilot`) or `just accept --live`, ask the human
first and warn that the run calls the real model and costs money. Do not run any
of these unprompted, and do not use them as an iteration loop.

Normal tc reports run `--side tc` with the edit-dsl protocol. The default
benchmark matrix is the four tasks `json-parser`, `sexp-parser`, `minilisp`, and
`csv-parser`; `mini-spreadsheet` is targeted-only via `--task mini-spreadsheet`.
Cost accounting is always at the official DeepSeek peak prices, even when the
run happens off-peak; comparisons and the `--budget-usd` cap use cache-excluded
USD, not tokens. `--agent-mode pinned-repair|plan-exec|both` selects the tc loop
mode(s), where `both` is the benchmark's multi-mode selector; the `edit` alias is
deprecated. With no committed baseline, a tc-only report does not render an oc
savings comparison.

The oc side measures the ambient OpenCode configuration of this repo, including
its registered skills. If a baseline is re-created, keep `.opencode/skills` and
other OpenCode-level inputs stable across the freeze.

## Layout / entrypoints

`typescript-editor/` is the editing engine; `harness/` is the agent and CLI.
The harness depends on `@tc/typescript-editor`; the editor never imports the
harness.

- `typescript-editor/src/` — lexer/parser, symbol index (`utility`), matcher,
  selection, edit-dsl, cascade, range, and the splice/format/commit gate
  (`editor`, `commit`); `api.ts`/`workspace.ts` are the public read/apply
  surface, and `tool.ts` is the OpenAI-compatible editor tool.
- `typescript-editor/src/cli.ts` — `tsed` CLI entry; `typescript-editor/scs/tsed.scs`
  is the source of truth for its argument surface/help/completions, with
  committed generated artifacts under `typescript-editor/scs/generated/`.
- `harness/src/main.ts` — CLI entry (`#!/usr/bin/env bun`, piped-stdin contract `tc < task.txt`; a TTY stdin prints help).
- `harness/src/loop.ts` — `runLoop` dispatcher (default pinned-repair; plan-exec route), the edit-dsl loop, and prompt entry points. The model-facing edit-dsl prompt is a literal in `harness/src/prompts/edit-dsl.ts`; prompt text is benchmark-sensitive.
- `harness/src/tasks.ts` / `harness/src/task-loop.ts` — Plan/WorkNode DAG contract and the `--mode plan-exec` driver: ready-node scheduling, gates, post-execution review, usage buckets; spec in `docs/plan-exec.md`.
- `harness/src/plan-dsl.ts` — flat Plan and patch DSL parser/serializer; `typescript-editor/src/dsl-diagnostics.ts` — shared tolerant diagnostics renderer.
- `harness/src/prompts/task.ts` — planning/execution/review prompt text for plan-exec.
- `harness/src/tools.ts` — check/test tools; default verify commands are `bunx tsc --noEmit` and `bun test`; it re-exports and registers the editor `tsed` tool but the text loop does not use it.
- `harness/src/openai.ts` — provider config from env, retries/timeouts. `harness/src/result.ts` — the `typescript-coder-result@3` sub-agent result contract.
- `harness/src/index.ts` — leftover scaffold (`greet`) kept as the self-host fixture target; don't "clean it up".
- `human/` — human-authored specs; read-only (see Boundaries).
- `acceptance/`, `benchmark/` — harnesses, read their READMEs before changing.
  `acceptance/offline/` is network-free; `acceptance/live/` calls the real model
  and runs only under `just accept --live`; shared scenario code is in
  `acceptance/support/`.
- Root configuration: `package.json`, `justfile`, `tsconfig.json`, `bunfig.toml`, `bun.lock`; `README.md` and `docs/` document the repository.

## Gotchas

- `.env` (gitignored) holds `OPENAI_BASE_URL`/`OPENAI_API_KEY`; Bun auto-loads it into the process environment, but invoking as `node` (`bun --bun`, `bunx --bun`) disables that loading. Offline tests must not hit the network.
- `bun test` at the root discovers both package suites (`bunfig.toml` `root = "."`) and ignores fixture/tmp paths; each package has its own `bunfig.toml` scoping its suite to that package's sources. `just test` runs the registered offline suites; acceptance/benchmark also run their own commands.
- `benchmark/` is excluded from `tsc` (`benchmark/fixtures`), and `judge-golden.test.ts` imports it through a computed specifier so the self-host copy of just `harness/src` stays green — preserve that trick when touching `benchmark/`.
- `typescript-editor/scs/tsed.scs` owns the `tsed` argument surface. The generated artifacts are committed, so a clone does not need `scs` to typecheck/test; regenerate with `just tsed-generate` and verify with `just tsed-check`. Never hand-edit `scs/generated/`.
- `just tsed-install` runs `bun add -g` on the local private package; the global `tsed` entry points at this checkout, so rerun it after moving the checkout. It is not a registry publish.
- `tsconfig` is strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`: use `import type`, handle possibly-undefined index results (code style follows this: `const x = arr[i]; if (x === undefined) …`).
- Live checks cost tokens: `just test --api llm|all`, `just accept --live`, and benchmark runs call the real model (benchmark default `deepseek-v4.1-flash` on the official endpoint). Don't run them unprompted, and don't use them as an iteration loop — see Evaluation. Measured benchmark runs default to 5 reps and warm only the stable system-prompt prefix; reports print cache-hit ratios and warn when they are badly imbalanced.
- `csv-parser` benchmark fixture is held out — never tune prompts or code against it.
- Benchmark artifacts (`benchmark/results/`, `failures/`, `tmp/`, `acceptance/report.json`) are generated; don't commit them unless a human explicitly asks.
- Commits are titled by topic (`resolve-issue: …`, `Land #80: …`) and reference tracker issue numbers in comments as `(#NN)`; the tracker is the local coding-skills set, not GitHub.
