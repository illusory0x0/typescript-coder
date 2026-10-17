---
id: 35
title: "Reasoning control probe and staged policy"
status: done
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
- Probe (2026-10-17, raw `chat/completions`, deepseek-v4.1-flash):
  - trivial prompt: baseline reasoning 39, `reasoning_effort: "low"` 30,
    `enable_thinking: false` 34 → `enable_thinking` inconclusive/likely
    ignored.
  - reasoning-heavy prompt (12-coin puzzle): baseline 7,849 (hit the 8,000
    completion cap, 397-char content), `"high"` 8,000 (cap, empty content),
    `"medium"` 3,771, `"low"` 2,652 (full 2,500-char answer) → the
    `reasoning_effort` field is honored and the model's default behaves like
    "high".
- Staged policy implemented: `ChatOptions.reasoningEffort`
  (`low|medium|high`) serializes to `reasoning_effort`; selection calls are
  always low (including selection retries); the first generation attempt keeps
  the provider default; edit attempts after a failed verification step to
  medium; the explain call stays default. Unit tests: +6 (body serialization
  and key absence, retry resend, option-call sequences for selection/retry/
  explain).
- A/B evidence: offline decomposition of the 2026-10-17 ts runs (per-call
  `rawUsage`) shows the first (selection) call carried 14% of all reasoning
  tokens (10% of all tokens), up to 76% (18,048/23,847) in sexp rep1. Live
  spot: `sexp-parser --side ts --reps 2` with the policy → 6,828 and 6,094
  tokens (mean 6,461, 2/2 PASS; selection reasoning 2,351 and 1,635+39 vs
  baseline call-0 reasoning 5,874–18,048). Caveat: the spot includes #34 (spec
  visibility), single-session variance is high, and the decisive number comes
  from the final matrix.
- Validation (2026-10-17): tsc 0, 487 tests, `accept` 5/5,
  `benchmark/check.ts` 3 PASS.
