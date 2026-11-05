# Acceptance harness

Scripted end-to-end tests for the agent loop harness (context/index -> Edit ->
Verification -> keep-progress next iteration -> summary). Scenarios are split by
what they need:

- `acceptance/offline/` - scenarios that drive the real `runLoop` with a
  `ScriptedProvider`; no network access or API key.
- `acceptance/live/` - scenarios that call the real model through
  `OpenAIProvider`; opt-in with `--live` or `--live-only`.
- `acceptance/support/` - the `Scenario` shape, `ScriptedProvider`, and shared
  assertions.
- `acceptance/scenarios.ts` - the aggregation point; it validates unique ids
  across the lanes and exports both arrays.
- `acceptance/run.ts` - the one runner; it selects the lane from the flags and
  builds `OpenAIProvider` only for the live lane.

Default runs never construct `OpenAIProvider` and never touch the network. The
live lane is covered in [Live checks](#live-checks).

## Running

- `just test` - the unified offline lane; it runs the fast offline scenarios
  as its `acceptance` suite, alongside the package unit suites and scripts
- `just test --api all` - offline lane first, then the live lane below
- `just accept` - fast scenarios only
- `just accept --all` - also runs the slow `self-host` scenario
- `just accept --live` - also runs live scenarios against the real model
- `just accept --live-only` - only live scenarios (`just test --api llm` uses this)
- `just accept --model <id>` - model id for live scenarios
  (default `$ACCEPT_MODEL` or `deepseek-v4.1-flash`)
- `just accept --only <id>` - run a single scenario by id
- `just accept --keep` - keep per-scenario temp dirs (paths are printed)
- `just accept --json <path>` - write the JSON report to `<path>`
- `just accept --induce-failure [id]` - meta-check: injects a synthetic
  failing assertion so the run exits non-zero

## Scenarios

| id                         | folder  | title                                                                                                  | slow | live |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------ | ---- | ---- |
| fix-answer                 | offline | failing test becomes green                                                                             | no   | no   |
| plan-exec-fix-answer       | offline | flat-DSL plan/execute plans one task and the executor makes the failing test green                     | no   | no   |
| plan-exec-write-fix-answer | offline | flat-DSL plan/execute accepts sentinel goal, instruction, and whole-file write fences                  | no   | no   |
| edit-dsl-viewer-edit       | offline | edit-dsl select viewer opens details then an edit lands                                                | no   | no   |
| edit-dsl-rename            | offline | edit-dsl rename updates a declaration and its references                                               | no   | no   |
| live-fix-answer            | live    | real model makes the failing test pass                                                                 | no   | yes  |
| keep-progress-retry        | offline | type-invalid replacement stays and the next iteration builds on it                                     | no   | no   |
| persistent-failure         | offline | repeated no-progress keeps the attempted state and explains                                            | no   | no   |
| check-test-propagation     | offline | test-only failure feeds back diagnostics                                                               | no   | no   |
| self-host                  | offline | agent edits its own sources and the copied suite stays green                                           | yes  | no   |

## Report and exit codes

Results are written to `acceptance/report.json` (gitignored) and summarized on
the console. The exit code is 0 only when every executed scenario passes.

## Live checks

`live-fix-answer` in `acceptance/live/scenarios.ts` drives the real `runLoop`
against the `fix-answer` fixture through `OpenAIProvider`, exercising the actual
gateway end to end. Live scenarios run only with `--live` or `--live-only` and
are excluded from default runs, `--all`, and `bun test`. The runner constructs
`OpenAIProvider` only for scenarios loaded from the live lane. Each request is
wrapped in a 90s timeout and the loop runs at temperature 0.

- `just test --api llm` - the unified runner's live lane; runs only
  `acceptance-live`, which invokes `just accept --live-only`
- `just accept --live` - fast scenarios plus live scenarios
- `just accept --live-only` - only the live scenarios
- `just accept --live --all` - everything, including slow and live scenarios
- `just accept --only live-fix-answer --live` - a single live scenario
- `just accept --model <id> --live` - override the model id
- `just accept --live --only live-fix-answer --induce-failure` - confirms the
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
`ACCEPT_TSC`) and `bun test`. Root `bun test` discovers both package suites and
ignores fixture directories via the root `bunfig.toml`, so fixture projects are
not discovered by the unit-test suite.
