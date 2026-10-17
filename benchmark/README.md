# benchmark

Token benchmark comparing the typescript-coder loop (`ts`) with the opencode
CLI (`opencode`) on identical fixture copies, prompts, and model.

## Usage

    bun run benchmark/run.ts --all --pilot
    bun run benchmark/run.ts --task json-parser --side ts --reps 2 --keep

Flags: `--task`, `--all` (default), `--reps <n>` (default 3), `--concurrency
<n>` (default 4, max parallel runs), `--pilot` (1 rep per task and side, writes
`benchmark/results/pilot-<date>.json`), `--side ts|opencode|both`, `--model`
(default `deepseek-v4.1-flash`), `--keep`, `--json <path>`, `--help`. Non-pilot
results default to `benchmark/results/<date>.json`.

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
- `durationMs`: model work only (the judge runs afterwards and is not counted).
- `ok`: judge verdict; `sideOk` is the side's own result.

Token conventions differ between the sides; compare like for like.
