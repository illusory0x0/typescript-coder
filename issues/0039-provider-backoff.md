---
id: 39
title: "Provider resilience: bounded backoff on 429/5xx"
status: todo
priority: high
milestone: null
parent: 28
deps: []
labels: [provider]
created: 2026-10-17
---

## Context

R9: `OpenAIProvider.chat` fails the whole run on any non-OK response,
including transient 429/5xx conditions; with parallel benchmark runs and real
usage, transient failures are showed up as run failures (the 2026-10-17 matrix
happened to have `infraErrors: []`, but nothing defends against it).

## Goal

Transient provider failures are retried with bounded backoff inside the
provider; permanent failures still fail fast with the existing error shape.

## Acceptance criteria

- [ ] `chat` retries 429 and 5xx responses (and network-level fetch failures)
      up to N additional attempts (default 2, configurable), with exponential
      backoff (base decided at resolve, default 1s doubling) and a per-attempt
      timeout unchanged from #25; `Retry-After` is honored when present
      (capped).
- [ ] Non-retryable statuses (other 4xx) fail immediately with the current
      error format; retries never multiply-trigger on success paths.
- [ ] Unit tests with a stubbed fetch: 429→200, 500→500→200, 500×3 → error,
      Retry-After honored, 400 not retried, timeout semantics preserved; gates
      green.

## Verification

```
bun test
```

plus: no live probe required; existing provider tests must stay green.

## Notes

- Keep backoff parameters constants or provider options; do not leak retry
  details into loop diagnostics beyond the final error.
- Non-goals: circuit breakers, queueing, rate limiting local concurrency
  (benchmark `--concurrency` remains the knob).
