---
id: 7
title: OpenAI-compatible provider with tools
status: todo
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

- [ ] Sends chat-completions requests with a `tools` parameter and parses the
      returned tool calls.
- [ ] Reads `OPENAI_API_KEY` and `OPENAI_BASE_URL` from the environment; missing
      credentials produce a clear error.
- [ ] Model is passed in (no env/hardcoded model); `deepseek` and `qwen` work as
      model ids against the configured endpoint.
- [ ] Mocked-HTTP tests pass; an optional live smoke test is available.

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
