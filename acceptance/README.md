# Acceptance harness

Scripted end-to-end tests for the agent loop harness (context/index -> edit ->
check/test -> keep-progress retry -> explanation). Each offline scenario drives
the real `runLoop` with a `ScriptedProvider`, so no network access or manual
steps are needed. Live scenarios are opt-in, call the real model, and are
covered in [Live checks](#live-checks).

## Running

- `bun run accept` - fast scenarios only
- `bun run accept --all` - also runs the slow `self-host` scenario
- `bun run accept --live` - also runs live scenarios against the real model
- `bun run accept --model <id>` - model id for live scenarios
  (default `$ACCEPT_MODEL` or `deepseek-v4.1-flash`)
- `bun run accept --only <id>` - run a single scenario by id
- `bun run accept --keep` - keep per-scenario temp dirs (paths are printed)
- `bun run accept --json <path>` - write the JSON report to `<path>`
- `bun run accept --induce-failure [id]` - meta-check: injects a synthetic
  failing assertion so the run exits non-zero

## Scenarios

| id | title | slow | live |
| --- | --- | --- | --- |
| fix-answer | failing test becomes green | no | no |
| live-fix-answer | real model makes the failing test pass | no | yes |
| keep-progress-retry | type-invalid replacement stays and the retry builds on it | no | no |
| persistent-failure | exhausted retries keep the attempted state and explain | no | no |
| context-correctness | context YAML exposes dotted signatures | no | no |
| check-test-propagation | test-only failure feeds back diagnostics | no | no |
| self-host | agent edits its own sources and the copied suite stays green | yes | no |

## Report and exit codes

Results are written to `acceptance/report.json` (gitignored) and summarized on
the console. The exit code is 0 only when every executed scenario passes.

## Live checks

`live-fix-answer` drives the real `runLoop` against the `fix-answer` fixture
through `OpenAIProvider`, exercising the actual gateway end to end. Live
scenarios run only with `--live` and are excluded from default runs, `--all`,
and `bun test`. Each request is wrapped in a 90s timeout and the loop runs at
temperature 0.

- `bun run accept --live` - fast scenarios plus live scenarios
- `bun run accept --live --all` - everything, including slow and live scenarios
- `bun run accept --only live-fix-answer --live` - a single live scenario
- `bun run accept --model <id> --live` - override the model id
- `bun run accept --live --only live-fix-answer --induce-failure` - confirms the
  synthetic failure path exits non-zero for live runs too

Warnings:

- Live runs need network access plus `OPENAI_API_KEY` and `OPENAI_BASE_URL`.
- Temperature 0 reduces but does not eliminate variance; a live failure does
  not necessarily indicate a harness bug.
- Live runs consume real tokens and therefore cost money; keep them to a single
  scenario when possible.
- `acceptance/report.json` marks live scenario entries with `"live": true` and
  the model id used; offline entries carry neither field.

Running `--only live-fix-answer` without `--live` fails with a usage error
(exit code 2) instead of silently skipping the scenario.

## Fixtures

`acceptance/fixtures/<id>/` templates are copied into fresh temp dirs per run.
Checks use the repo's local `node_modules/typescript/bin/tsc` (override with
`ACCEPT_TSC`) and `bun test`. Root `bun test` is scoped to `src/` via
`bunfig.toml`, so fixture projects are not discovered by the unit-test suite.
