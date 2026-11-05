# typescript-coder

`tc` is a TypeScript coding agent packaged as an opencode sub-agent. It runs a
pinned-repair Edit → Verify loop by default and an optional plan-exec
Plan → Execute → Review loop, driven by an OpenAI-compatible gateway.

## Quick start

```sh
bun install
just typecheck
just test
tc < task.txt
bun run typescript-editor/src/cli.ts --help
```

The root `package.json` `bin` entry points `tc` at `harness/src/main.ts`. The
`.env` file carries `OPENAI_BASE_URL` and `OPENAI_API_KEY`; Bun auto-loads it,
and it must not be committed.

## Editor library and `tsed`

`typescript-editor/` is also a reusable package. It ships `tsed`, an
scs-generated CLI over the same edit-dsl engine, plus typed `readEditDsl` /
`applyEditDsl` operations and an OpenAI-compatible editor tool. The CLI is
read-only by default; `--write` is the only file-modification opt-in. Input is
selected with `--protocol-format flag|dsl|json` (`flag` is the default), and
`dsl`/`json` read their payload from stdin.

```sh
bun run typescript-editor/src/cli.ts --read typescript-editor/src/index.ts
printf 'read typescript-editor/src/index.ts end\n' | \
  bun run typescript-editor/src/cli.ts --protocol-format dsl
```

See [`typescript-editor/README.md`](typescript-editor/README.md) for the formats,
exit codes, path-safety rules, library API, and tool schema.

## Package layout

| Path                 | Owns                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `typescript-editor/` | The editing engine, the scs-generated `tsed` CLI, the typed read/apply API, and the OpenAI-compatible editor tool. |
| `harness/`           | The agent loops, prompts, provider, tools, CLI, result contract, pricing, and replay.                              |
| `acceptance/`        | Scripted acceptance scenarios: `acceptance/offline/` (no API) and `acceptance/live/` (opt-in real model).          |
| `benchmark/`         | The tc/oc benchmark harness, fixtures, and reports; the oc side is frozen.                                         |
| `docs/`              | Protocol, loop, plan-exec, and evaluation specifications, plus their ownership map.                                |
| `issues/`            | The local tracked-issue set.                                                                                       |
| `scripts/`           | Repository utility scripts.                                                                                        |

Root configuration lives in `package.json`, `justfile`, `tsconfig.json`,
`bunfig.toml`, and `bun.lock`; `AGENTS.md` holds the agent-facing rules.

## Commands

| Command                                    | What it does                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `just typecheck`                           | Typecheck the root harnesses and both workspace packages.                                                       |
| `just test`                                | Run the offline suites with bounded file-level workers; never calls the model.                                  |
| `just tsed-generate`                       | Regenerate the committed `tsed` parser, help, and completions from `typescript-editor/scs/tsed.scs`.            |
| `just tsed-check`                          | Verify the committed `tsed` generated artifacts with `scs generate --check`.                                    |
| `just test --api llm`                      | Run only the real-model suites (costs money; owner lanes are serial).                                           |
| `just test --api all`                      | Run the offline suites, then the real-model suites if the offline phase passes.                                 |
| `just test --include-slow`                 | Add the slow `acceptance-self-host` suite to the offline lane.                                                  |
| `just test --list`                         | List every suite with its `api=none` or `api=llm` lane and its owner.                                           |
| `just test-parallel [n]`                   | Alias for `just test --jobs <n>`; workers default to `min(nproc, 4)` and cap at 4.                              |
| `just accept [--all\|--live\|--only <id>]` | Run acceptance scenarios; flags pass through. Live scenarios call the real model.                               |
| `just format`                              | Format with `oxfmt`. Repo-wide formatting rewrites `human/` when present, so format only the files you changed. |

## Documentation and evaluation

- `docs/README.md` maps the documentation and records which package owns which
  semantics.
- `docs/roadmap.md` describes the current monorepo state, near-term work, and
  the evaluation policy.
- `typescript-editor/README.md` documents the `tsed` CLI, input protocols,
  library API, and editor tool.
- `benchmark/README.md` documents the benchmark harness, fixtures, and metrics.
- `acceptance/README.md` documents the acceptance scenarios and live checks.
- `AGENTS.md` holds the operational rules for agents working in this repository.

The `just test` offline lane and `just accept` are the normal development loop.
Live runs — `just test --api llm|all`, `just accept --live`, and benchmark runs
with reps, including `--pilot` — call the real model, cost money, and are
human-gated. The held-out `csv-parser` task is never used for tuning.
