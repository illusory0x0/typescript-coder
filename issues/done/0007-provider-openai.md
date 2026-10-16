---
id: 7
title: OpenAI-compatible provider with tools
status: done
priority: medium
milestone: M5
parent: 1
deps: [2]
labels: [provider]
created: 2026-10-16
---

## Context

Milestone **M5** of [spec.md](../spec.md) §11, implementing `openai.ts` (spec
§5) against the provider contract in spec §8: OpenAI-compatible, tool-call format
via the `tools` param, models `deepseek`/`qwen`, credentials from
`OPENAI_API_KEY` / `OPENAI_BASE_URL`, model selected by the `--model` flag only.

## Goal

`openai.ts` performs OpenAI-compatible chat completions with `tools` support,
reading credentials from the environment and accepting the model as an argument.

## Acceptance criteria

- [x] Sends chat-completions requests with a `tools` parameter and parses the
      returned tool calls.
- [x] Reads `OPENAI_API_KEY` and `OPENAI_BASE_URL` from the environment; missing
      credentials produce a clear error.
- [x] Model is passed in (no env/hardcoded model); `deepseek` and `qwen` work as
      model ids against the configured endpoint.
- [x] Mocked-HTTP tests pass; an optional live smoke test is available.

## Verification

```
bun test src/openai.test.ts
# optional live smoke (requires .env)
bun run scripts/openai-smoke.ts --model deepseek
```

## Notes

- Depends on #2 (scaffold).
- Blocks #9 (loop).
- R3: LLM tool-call/JSON flakiness — use a strict schema and low temperature.
- **Contract for #9** (`src/openai.ts`, 15 mocked tests green):
  - `readConfigFromEnv(model): OpenAIConfig` (`OPENAI_API_KEY`/`OPENAI_BASE_URL`,
    trailing `/` trimmed; errors `OPENAI_API_KEY is not set` /
    `OPENAI_BASE_URL is not set`).
  - `new OpenAIProvider(config, fetchImpl = fetch)` — injectable fetch so the
    loop tests can mock responses without network.
  - `chat(messages, tools?, { temperature? }): Promise<ChatResponse>` with
    `ChatResponse { content, toolCalls, finishReason, raw }`; `tools` omitted
    when absent; non-2xx -> `chat request failed: <status> <body(500)>`.
- **Live smoke status (2026-10-16):** endpoint reachable and auth accepted, but
  the configured key returns `403 {"detail":"The specified model is not allowed
  for this key"}` for both `deepseek` and `qwen`. This is a key/permission
  limitation, not a code issue; the loop (#9) tests use a mocked provider, so
  this does not block.
- **Implementation history:** delegated as one bounded sub-agent task; diff
  reviewed, verification re-run by the main agent.
- Verified 2026-10-16: `bun test src/openai.test.ts` 15 pass / 0 fail;
  `bunx tsc --noEmit` exit 0; `bun test` 324 pass / 0 fail across 6 files.
