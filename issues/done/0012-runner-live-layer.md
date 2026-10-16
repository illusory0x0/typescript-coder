---
id: 12
title: Add live layer to the acceptance runner
status: done
priority: medium
milestone: null
parent: 11
deps: []
labels: [acceptance, live]
created: 2026-10-17
---

## Context

First step of the planned live-acceptance work. The acceptance runner
(`acceptance/run.ts`) currently drives every scenario with a `ScriptedProvider`
and is fully offline; the real `OpenAIProvider` (with injectable `fetchImpl`)
has only been exercised by a single-shot smoke script. We need a first-class,
explicitly gated live scenario that runs the real `runLoop` against a fixture.

## Goal

`bun run accept --live` runs a real-model scenario (`live-fix-answer`) against
the `fix-answer` fixture, while the default and `--all` runs stay fully offline.

## Acceptance criteria

- [ ] `acceptance/run.ts` gains `--live` and `--model <id>` (default
      `process.env.ACCEPT_MODEL ?? "deepseek-v4.1-flash"`); live scenarios run
      only with `--live` and are excluded from default runs and `--all`.
- [ ] New scenario `live-fix-answer` (fixture `fix-answer`) uses
      `new OpenAIProvider(config)` built from env config, temperature 0, with a
      fetch wrapper applying `AbortSignal.timeout(90_000)`; `src/` is not
      modified.
- [ ] Assertions: `result.ok === true`; `result.explanation === null`;
      `src/helper.ts` final content differs from its original; `src/helper.test.ts`
      is unchanged.
- [ ] `acceptance/report.json` records live runs with `live: true` and the
      model id (fields set only for live scenarios); `--help` documents the new
      flags; `acceptance/README.md` gains a "Live checks" section warning about
      network/key/non-determinism/cost.
- [ ] Offline regression unchanged: `bunx tsc --noEmit` exit 0, `bun test`
      394 pass, `bun run accept` 5 passed/0 failed, `bun run accept --all`
      6 passed/0 failed.
- [ ] `bun run accept --live --only live-fix-answer --induce-failure` exits
      non-zero (synthetic failure detection also holds for live runs).

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
bun run accept --all
bun run accept --live --only live-fix-answer --induce-failure; echo "exit: $?"
```

(The last command needs the `.env` key and performs one real model call per
run; `--induce-failure` still spends one chat call.)

## Notes

- Depends on nothing new; reuses `src/openai.ts` (`readConfigFromEnv`,
  `OpenAIProvider`) and existing scenario helpers.
- Files touched: `acceptance/run.ts`, `acceptance/scenarios.ts`,
  `acceptance/README.md` only.
- Live calls: single scenario, temperature 0, minimal fixture → minimal token
  cost. Do not run live scenarios in `bun test` or default `accept`.
- Verified 2026-10-17: `bunx tsc --noEmit` exit 0; `bun test` 394 pass / 0 fail;
  `bun run accept` 5 passed / 0 failed; `bun run accept --all` 6 passed /
  0 failed; `bun run accept --live --only live-fix-answer --induce-failure`
  exit 1 — all four live assertions passed (`ok`, null explanation, helper.ts
  changed, helper.test.ts unchanged), only the synthetic induced failure
  failed (attempts 2, 7279ms, model `deepseek-v4.1-flash`).
