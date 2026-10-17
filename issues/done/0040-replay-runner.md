---
id: 40
title: "Replay runner: offline iteration on recorded bundles"
status: done
priority: high
milestone: null
parent: 28
deps: [29]
labels: [benchmark]
created: 2026-10-17
---

## Context

The one-shot series (#28) changes retry mechanics, the edit protocol, matching
and diagnostics in rapid succession; live re-measures cost gateway tokens and
are noisy. The bundles recorded by #29 make it possible to re-run the current
loop code against real model responses with zero network calls.

## Goal

A CLI replays a recorded bundle through the current loop in a fresh fixture
copy and reports the mechanics outcome (parses, matches, retry flow,
diagnostics), with no network.

## Acceptance criteria

- [ ] `benchmark/replay.ts <bundle.json>` materializes the bundle's fixture
      into a scratch workspace, drives `runLoop` with a replaying
      `ProviderLike` (responses in order), and prints a summary: OK/fail,
      attempt outcomes, where parsing/matching stopped; exit code reflects
      the outcome; bundle exhaustion is reported explicitly.
- [ ] Replay never performs network calls and never mutates the recorded
      bundle; workspaces live under `tmp/` and are cleaned up unless
      `--keep`.
- [ ] Unit tests with synthetic bundles: in-order replay, exhaustion,
      mismatch reporting; one recorded real bundle from #29 is replayed and
      the result captured in this issue.
- [ ] `benchmark/README.md` documents the command and the known limitation:
      replayed responses were produced for the *old* prompts, so the runner
      validates mechanics (parsing/matching/state flow) — not model
      behavior under new prompts.
- [ ] Gates green (`bunx tsc --noEmit` 0, `bun test`, `bun run accept`).

## Verification

```
bun test
bun benchmark/replay.ts tmp/replays/<bundle>.json
```

## Notes

- Depends on #29 (bundle format). Used as evidence vehicle by #30/#31/#33/#38.
- Non-goals: synthesizing new responses, live fallbacks, parallel replays.
- Validation (2026-10-17): `bun run benchmark/replay.ts <bundle.json> [--keep]`
  replays offline via `ReplayProvider` (src/replay-runner.ts), copying the
  bundle fixture to `tmp/replay/<stamp>/` (removed unless `--keep`); the
  summary lists result/mode/filePath, `calls X/N`, exhaustion, prompt
  mismatches, and per-attempt outcomes; exit 0 ok, 1 loop fail, 2 usage/IO.
  Real bundle replay (`tmp/replays2/json-parser-ts-rep1.json`, recorded from
  a passing run): `result: ok`, `calls: 3/3`, `prompt mismatches: none`,
  `attempt 1: outcome=selection-invalid`, `attempt 2: outcome=ok` —
  deterministically reproduced with zero network. Exhaustion path verified
  (1-call bundle → fail, `bundle exhausted after 1 call(s)`, exit 1).
  Unit tests: 6 (in-order replay through the real loop, exhaustion + cleanup,
  parse validation, provider order/mismatch, summary text). Verified: tsc 0,
  461 tests, `accept` 5/5, `benchmark/check.ts` 3 PASS.
