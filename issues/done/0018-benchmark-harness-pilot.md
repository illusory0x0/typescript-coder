---
id: 18
title: Benchmark harness and pilot run
status: done
priority: medium
milestone: null
parent: 16
deps: [15, 17]
labels: [benchmark]
created: 2026-10-17
---

## Context

Both agents must run in identical copies of the fixture projects on the same
model, with token usage collected per run. opencode v2.0.31 is available
(`/home/illu/.opencode/bin/opencode`); gateway `deepseek-v4.1-flash` is verified
for both sides. opencode `cost` is always 0 on this gateway (no prices) → the
benchmark compares tokens only. The gateway `.env` (`OPENAI_API_KEY`,
`OPENAI_BASE_URL`) is already set up for live acceptance runs; Bun loads it
automatically.

## Goal

`benchmark/run.ts` orchestrates isolated runs for both sides, records per-run
results (success, tokens, duration, steps), and a pilot (1 rep per task per
side) validates the pipeline end-to-end before the full run in #19.

## Design

CLI: `--task <json-parser|sexp-parser|minilisp>` / `--all` (default `--all`),
`--reps <n>` (default 3), `--pilot` (forces 1 rep per task per side and writes
`benchmark/results/pilot-<date>.json`), `--side ts|opencode|both` (default
both), `--model <id>` (default `deepseek-v4.1-flash`), `--keep`, `--json <path>`.

Per run, a fresh workspace under `./tmp/benchmark/`:

1. Copy `benchmark/fixtures/<task>/` (only that directory) into the workspace.
2. **typescript-coder side:** recording provider wrapping `OpenAIProvider`
   (`readConfigFromEnv(model)`); `runLoop({cwd, issue, model, provider,
   temperature: 0})` with the default check/test commands (tsc binary from the
   repo's `node_modules`, `bun test`). Sum usage from each `ChatResponse.raw`
   (OpenAI-style `prompt_tokens`, `completion_tokens`, `total_tokens`, plus
   cache/reasoning fields when present; tolerate absent fields).
3. **opencode side:** `opencode run --model honghong/deepseek-v4.1-flash
   <TASK_ISSUE>` with cwd = workspace (binary from `OPENCODE_BIN` or `PATH`;
   confirm exact flags with `opencode run --help` during implementation). Then
   collect tokens for that isolated project via `opencode session export <id>`
   (preferred) or `opencode stats --json --days 0 --project <workspace>`
   (fallback); store the raw usage JSON.
4. Judge: `bun test` exit 0 **and** tsc exit 0
   (`bun <repo>/node_modules/typescript/bin/tsc --noEmit`) **and** fixture
   `src/*.test.ts` + `tsconfig.json` byte-identical to the fixture.
5. Record: task, side, rep, ok, tokens {input, output, cache read/write,
   reasoning, total} (null when not reported), durationMs, steps, raw usage,
   log/workspace path, model, bun/opencode versions.

`TASK_ISSUE` is one shared string per task, used verbatim by both sides, e.g.
for G1:

```
Implement src/json.ts exporting JsonValue and parseJson(text: string): JsonValue
so that src/json.test.ts passes. Keep tsc --noEmit clean. Do not modify the test
file or tsconfig.json. The test file is the specification.
```

(analogous for G2/G3 with their exported names). The harness must never copy
`benchmark/references/` into a workspace. `--keep` retains workspaces and logs;
default cleans after recording. Exit 0 when all requested runs execute (model
failures are recorded data); non-zero on infrastructure errors (cannot start a
side, cannot read usage). `bunx tsc --noEmit` covers `benchmark/run.ts` via the
root include/exclude added in #17.

## Acceptance criteria

- [ ] `bun run benchmark/run.ts --all --pilot` executes 6 runs (3 tasks × 2
      sides), writes the pilot JSON, and exits 0.
- [ ] Every pilot run records success/failure judged by tests + tsc + fixture
      byte-equality, and non-null token totals for both sides (or an explicit
      "usage unavailable" record with the raw payload attached).
- [ ] Running the same task twice produces two isolated workspaces with
      independent token accounting (no cross-run leakage).
- [ ] The judge detects a tampered workspace (e.g. a modified test file) and
      fails that run record; verified by a manual tamper check during
      implementation.
- [ ] `bunx tsc --noEmit` 0 errors; `bun test` unaffected.

## Verification

```
bun run benchmark/run.ts --all --pilot
bunx tsc --noEmit
bun test
```

plus: inspect the pilot JSON (6 records, token fields populated) and optionally
`--keep` one run to inspect the workspace.

## Notes

- Deps: #15 (append/create for the TS side), #17 (fixtures + check.ts).
- opencode details to confirm at implementation time: headless `run`
  invocation and prompt flag, session id retrieval, `session export` vs
  `stats --json` scoping to the workspace; `cost` is always 0 (record but do
  not compare).
- Token definitions differ between sides (opencode counts its own tool-loop and
  cache/reasoning usage when reported); record all available fields verbatim
  and document the definitions in the report.
- Pilot results are calibration evidence only; excluded from the final
  aggregates in #19.
- Probe (2026-10-17): repo-local temp workspaces work with `bun test` (only the
  workspace's `src/*.test.ts` is discovered).
- Optional: `benchmark/README.md` with usage and metric definitions.
- Non-goals: CI wiring, parallel run execution, statistical analysis.

## Validation (2026-10-17)

- Pilot: `benchmark/results/pilot-2026-10-17.json` — 6 records, `infraErrors: []`,
  5/6 judged ok; the single failure (sexp-parser/ts) is a genuine model failure
  recorded as data (fixture bytes identical).
- Isolation fix: opencode v2.0.31 derives its session directory from `PWD`, which
  `Bun.spawn({cwd})` does not update; an early pilot attempt escaped the
  workspace (repo writes were removed and the repo re-verified clean). The
  harness now sets `PWD=cwd` on every spawn and `git init`s each workspace;
  re-verified clean after fresh live runs.
- Tamper check (reproduced by the main agent 2026-10-17): a modified
  `src/json.test.ts` fails the judge on byte-equality even while tests and tsc
  still pass.
- `cost` is no longer always 0 on the gateway: session exports include small
  costs, recorded verbatim and not compared.
