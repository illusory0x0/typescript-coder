# Acceptance harness

Scripted end-to-end tests for the agent loop harness (context/index -> edit ->
check/test -> rollback/retry -> explanation). Each scenario drives the real
`runLoop` with a `ScriptedProvider`, so no network access or manual steps are
needed.

## Running

- `bun run accept` - fast scenarios only
- `bun run accept --all` - also runs the slow `self-host` scenario
- `bun run accept --only <id>` - run a single scenario by id
- `bun run accept --keep` - keep per-scenario temp dirs (paths are printed)
- `bun run accept --json <path>` - write the JSON report to `<path>`
- `bun run accept --induce-failure [id]` - meta-check: injects a synthetic
  failing assertion so the run exits non-zero

## Scenarios

| id | title | slow |
| --- | --- | --- |
| fix-answer | failing test becomes green | no |
| rollback-retry | type-invalid replacement rolls back and retries | no |
| persistent-failure | exhausted retries restore the file and explain | no |
| context-correctness | context YAML exposes dotted signatures | no |
| check-test-propagation | test-only failure feeds back diagnostics | no |
| self-host | agent edits its own sources and the copied suite stays green | yes |

## Report and exit codes

Results are written to `acceptance/report.json` (gitignored) and summarized on
the console. The exit code is 0 only when every executed scenario passes.

## Fixtures

`acceptance/fixtures/<id>/` templates are copied into fresh temp dirs per run.
Checks use the repo's local `node_modules/typescript/bin/tsc` (override with
`ACCEPT_TSC`) and `bun test`. Root `bun test` is scoped to `src/` via
`bunfig.toml`, so fixture projects are not discovered by the unit-test suite.
