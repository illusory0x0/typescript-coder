---
id: 35
title: "Reasoning control probe and staged policy"
status: todo
priority: high
milestone: null
parent: 28
deps: []
labels: [provider]
created: 2026-10-17
---

## Context

R2: reasoning dominates heavy runs — 87,918 of 150,816 and 64,439 of 123,972
tokens in the minilisp failures (50–80% of output). The gateway may or may not
expose reasoning controls on its OpenAI-compatible endpoint. User-approved
pre-selection (2026-10-17): if controls exist, use a staged policy — low for
selection, default for generation, medium for retries.

## Goal

Establish empirically whether the gateway accepts reasoning-effort controls,
and if it does, apply the staged policy with measured evidence; if not,
document that and close.

## Acceptance criteria

- [ ] Probe: 1–2 live calls test candidate body fields (e.g.
      `reasoning_effort`, thinking-style toggles) against the configured
      gateway; the probe outcome (accepted / ignored / rejected, observed
      `reasoning_tokens` deltas) is recorded in this issue.
- [ ] If supported: implement the staged policy (selection low, generation
      default, retries medium) behind provider options; unit tests for
      per-call option plumbing; an A/B spot measurement (e.g. sexp ×1–2 or
      offline analysis) recorded here.
- [ ] If unsupported: record the negative result here and close with no code
      change (the series must not depend on this item).
- [ ] Gates green (`bunx tsc --noEmit` 0, `bun test`, `bun run accept`).

## Verification

```
bun test               # when plumbing landed
bun run benchmark/run.ts --task sexp-parser --side ts --reps 1   # A/B spot
```

plus the probe transcript in the issue notes.

## Notes

- Candidate parameter names must be verified against the gateway, not assumed;
  unknown fields may be silently ignored (check `reasoning_tokens` in usage).
- Non-goals: switching models, multi-model routing (H3 horizon), changing
  temperature/sampling.
