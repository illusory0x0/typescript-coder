---
id: 74
title: "Provider: retry timed-out chat requests (max 5 additional attempts)"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [provider, agent-loop]
created: 2026-10-19
---

## Context

The provider currently treats a request timeout as terminal: `src/openai.ts:229-232`
explicitly skips retries for `ChatTimeoutError` ("#25 semantics: timeouts surface
immediately and are never retried"), even though transient network failures and
429/5xx responses are retried (#39). A slow or dropped upstream connection
therefore fails the whole run instead of being re-sent.

Requested change: when a chat request exceeds its per-attempt timeout, re-send
the message (bounded retries), instead of failing immediately.

## Goal

A timed-out chat request is re-sent up to 5 additional times before the run
fails, with the existing final error shape preserved.

## Acceptance criteria

- [ ] On a per-attempt timeout (`ChatTimeoutError`), `OpenAIProvider.chat`
      re-sends the identical request body, up to 5 additional attempts
      (6 requests total), instead of throwing on the first timeout.
- [ ] Timeout retries use bounded backoff (reuse the `#39` backoff helper) and a
      fresh `AbortController`/timer per attempt; the default per-attempt timeout
      stays 120_000 ms (`OPENAI_TIMEOUT_MS` unchanged).
- [ ] The retry budget is configurable (provider option and/or env, e.g.
      `OPENAI_TIMEOUT_RETRIES`) with default 5; invalid values throw at
      construction like `retries` does.
- [ ] A timeout that persists through the whole retry budget throws the current
      `chat request timed out after <n> ms` error message unchanged.
- [ ] Unit tests with a stubbed fetch: a fetch that times out once then
      succeeds; a fetch that times out on every attempt → error after exactly
      6 requests; existing `#25`/`#39` tests that pin single-request timeout
      semantics are updated to the new contract.
- [ ] `bunx tsc --noEmit` 0 and `bun test` green.

## Verification

```
bunx tsc --noEmit
bun test
```

## Notes

- Clarified with the requester: the 120s default timeout is kept (3s was only an
  example); "retry 5 times" means 5 additional attempts (6 requests total).
- Relationship to #25/#39: this reverses the explicit "timeouts are never
  retried" clause from #25. #25's timeout mechanism and #39's backoff stay;
  only the retry decision on `ChatTimeoutError` changes.
- Non-goals: lowering the default timeout, streaming, circuit breakers.
