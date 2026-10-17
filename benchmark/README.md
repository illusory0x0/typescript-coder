# benchmark

Token benchmark comparing the typescript-coder loop (`ts`) with the opencode
CLI (`opencode`) on identical fixture copies, prompts, and model.

`results/consumption.md` is the canonical before/after token-efficiency view
across the series.

## Usage

    bun run benchmark/run.ts --all --pilot
    bun run benchmark/run.ts --task json-parser --side ts --reps 2 --keep

Flags: `--task`, `--all` (default), `--reps <n>` (default 3), `--concurrency
<n>` (default 4, max parallel runs), `--pilot` (1 rep per task and side, writes
`benchmark/results/pilot-<date>.json`), `--side ts|opencode|both`, `--model`
(default `deepseek-v4.1-flash`), `--keep`, `--json <path>`, `--replay-dir
<path>` (ts side only: write one replay bundle per run to `<path>/<task>-ts-
rep<n>.json`; off by default), `--help`. Non-pilot results default to
`benchmark/results/<date>.json`.

Each run also writes a sibling Markdown report next to the `--json` target
(`.json` replaced by `.md`): aggregates per task and side plus token-accounting
and anomaly notes.

Each run gets a fresh workspace under `tmp/benchmark/<stamp>/` (fixture copy plus
its own git repo, so the agent cannot reach this repository's
`benchmark/references/`). The judge is `bun test` + `tsc --noEmit` + byte
equality of the fixture's `src/*.test.ts` and `tsconfig.json`. The task × side ×
rep matrix runs through a bounded worker pool (`--concurrency`, default 4); each
run keeps its own workspace, git repo, session, and logs, and `report.runs`
stays in matrix order even though runs finish in arbitrary order.

## Metrics per record

- `tokens.input` / `tokens.output`: prompt / completion tokens.
- `tokens.cacheRead` / `tokens.cacheWrite`: cache hits and writes
  (`cache.read/write` for opencode, `prompt_tokens_details.cached_tokens` for
  the gateway); null when not reported.
- `tokens.reasoning`: reasoning tokens when reported (a subset of output on the
  OpenAI side, a separate counter on the opencode side).
- `tokens.total`: reported total when available, otherwise the sum of reported
  input + output + reasoning; cache counters are not added in.
- `usageSource`: `chat-completions` (ts) or `session-export` / `stats-project`
  (opencode); `rawUsage` keeps the verbatim payload and null fields mean the
  side did not report them.
- `steps`: ts = runLoop attempts; opencode = assistant messages in the session
  export (null when unavailable).
- `attempts` (ts side): per-attempt summaries with `attempt`, `outcome` (`ok`,
  `selection-invalid`, `empty-output`, `format`, `tsc`, `tests`), a bounded
  `diagnosticsHead` (≤200 chars, whitespace collapsed), `replacementChars`,
  and the provider `finishReason`; null for the opencode side.
- `loopDiagnostics` (ts side): the loop's final run-level diagnostic (e.g. a
  provider error that aborted the run before any attempt), null when none.
- Replay bundles (`--replay-dir`): versioned JSON (`format` =
  `typescript-coder-replay@1`) with the task issue, fixture path, and the
  ordered chat calls (request messages, response content, finishReason,
  usage); consumed offline by the replay runner.
- `durationMs`: model work only (the judge runs afterwards and is not counted).
- `ok`: judge verdict; `sideOk` is the side's own result.

## Replay runner

    bun run benchmark/replay.ts <bundle.json> [--keep]

Replays a recorded bundle (`--replay-dir`, above) through the current loop in a
fresh copy of the bundle's fixture under `tmp/replay/<stamp>/`, with no network
calls. The summary reports the calls consumed against the recorded count,
per-attempt outcomes and diagnostics, prompt mismatches against the recorded
requests, and where the loop stopped; exit codes: 0 = loop ok, 1 = loop failed,
2 = usage or IO error. `--keep` leaves the workspace for inspection (removed
otherwise).

Limitation: the recorded responses were produced for the prompts current at
recording time, so the runner validates mechanics (parsing, matching, state
flow) — not model behavior under new prompts.

Token conventions differ between the sides; compare like for like.
