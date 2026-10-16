---
id: 25
title: "Provider: request timeout and runLoop error handling"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [provider, agent-loop]
created: 2026-10-17
---

## Context

`src/openai.ts:120` issues `fetch` without any `AbortSignal`, and `runLoop`
never catches provider errors (`src/loop.ts:307,330,389,461`); `src/main.ts:69`
has no catch either. A hung connection, network error or transient 429/5xx
therefore crashes the CLI with a stack trace (or hangs forever) — the bounded
retries only cover verification failures. The acceptance live runner already
wraps fetch with a 90s timeout (`acceptance/run.ts:76-83`), showing the
intended pattern. Audit 2026-10-17.

## Goal

Provider calls time out instead of hanging, and provider failures surface as a
clean failed run/diagnostic instead of an uncaught exception.

## Acceptance criteria

- [ ] `OpenAIProvider` applies a request timeout via `AbortSignal` (default
      120_000 ms; overridable, e.g. constructor option and `OPENAI_TIMEOUT_MS`
      through `readConfigFromEnv`).
- [ ] On timeout/abort/network error, `runLoop` returns `ok: false` with a
      clear diagnostics message; a previously applied edit is rolled back
      first; the failure explanation is best-effort (skipped when the provider
      is unreachable).
- [ ] `runMain` exits 1 with a readable message, no uncaught stack trace.
- [ ] Tests: `openai.test.ts` with a fetch stub that never resolves and one
      that rejects → timeout/error message; `loop.test.ts` with a provider that
      throws on a later call → failed result, no unhandled rejection.
- [ ] `src/tools.ts` command timeout (`commandTimeoutMs = 30000`,
      `src/tools.ts:32`) is configurable through `LoopOptions` (optional third
      parameter on `checkTool`/`testTool`), default unchanged.
- [ ] `bunx tsc --noEmit` 0; `bun test` green; `bun run accept` 5/5 and
      `bun run accept --all` 6/6.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
bun run accept --all
```

## Notes

- Priority `medium` (Eisenhower Q2: resilience; no happy-path impact).
- Timeout tests must use tiny values to stay fast.
- Non-goals: provider-side retry/backoff for 429/5xx (possible follow-up),
  streaming, request cancellation UX.
