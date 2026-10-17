---
id: 16
title: Token benchmark vs opencode CLI on generation tasks (G1–G3)
status: done
priority: high
milestone: null
parent: null
deps: []
labels: [umbrella, benchmark]
created: 2026-10-17
---

## Context

Follow-up to the live-acceptance work (#11–#14): the user wants a
token-consumption benchmark comparing typescript-coder with the opencode CLI on
the same model and the same from-scratch tasks. Earlier draft tasks (C1–C6)
were rejected as too easy; the agreed task set is three generation tasks:
G1 `json-parser`, G2 `sexp-parser`, G3 `minilisp` (a minimal Lisp interpreter).
opencode's `cost` is always 0 on this gateway (no price configuration), so the
comparison is token-only. opencode v2.0.31 is available at
`/home/illu/.opencode/bin/opencode`; `honghong/deepseek-v4.1-flash` is verified
working for both sides.

## Goal

A reproducible offline harness runs both agents on G1–G3 in identical fixture
projects and produces a committed report of success rates, token usage, and
duration per task and agent.

## Acceptance criteria

- [ ] Children #17, #18, #19 are `done`.
- [ ] 18 full runs executed and recorded (3 tasks × 3 repetitions × 2 agents)
      with frozen fixture specs; the pilot is recorded but excluded from
      aggregates.
- [ ] `benchmark/results/<date>.json` + `benchmark/results/<date>.md` show, per
      task and per agent: success rate, input/output/total tokens, duration, and
      step counts; opencode `cost` is recorded as 0 / not comparable, and the
      token-only comparison is documented.
- [ ] The report states per-task and overall token ratios at equal success rates
      (or explicitly flags where success rates differ and reports
      tokens-per-success alongside).
- [ ] Benchmark changes are confined to `benchmark/`, the root `tsconfig.json`
      include/exclude, and `.gitignore`; the only `src/` change in the whole
      workstream is #15.
- [ ] Offline suites still green: `bunx tsc --noEmit` 0 errors, `bun test` all
      pass, `bun run accept` 5/5.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
bun run benchmark/run.ts --all --reps 3
ls benchmark/results/
```

plus: read the generated report and spot-check aggregates against the raw
per-run JSON.

## Notes

- Model both sides: `deepseek-v4.1-flash` (opencode:
  `-m honghong/deepseek-v4.1-flash`).
- Cross-cutting prerequisite: #15 (append/create) blocks #18/#19; fixtures
  (#17) can proceed in parallel.
- Metric caveat: opencode token counts include its own tool-loop usage;
  typescript-coder's count sums gateway `usage` per provider call. Step counts
  and cache/reasoning fields are not directly comparable — definitions must be
  documented in the report.
- Priority `high` because this is the user's active goal; child issues default
  to `medium` unless their own context states otherwise. Milestone left `null`
  (post-spec hardening, not one of M0–M8).
- Non-goals: cost comparison (opencode cost is recorded verbatim, not compared),
  statistical significance, task sets beyond G1–G3.
- Validation (2026-10-17): children #17/#18/#19 and #27 (parallel harness) are
  done. Full matrix: 18 runs at concurrency 4, 16/18 passes, `infraErrors: []`,
  no reruns; the only failures are model-side (`minilisp ts rep1/rep3`,
  rollback-by-design; the report explains the judged pristine state).
  `benchmark/results/2026-10-17.json` carries the 18 records, aggregates
  (byTaskSide/bySide/overall), and metadata (date, concurrency, versions, model,
  pilot reference); the pilot is a separate file and excluded from aggregates.
  `benchmark/results/2026-10-17.md` documents frozen specs (fixture + reference
  paths), token/step definitions per side, per-task and overall tables, and the
  token-only comparison: equal-success tasks use mean totals (ts ÷ opencode:
  json 0.38×, sexp 3.67×), differing tasks flag the difference and use tokens
  per success (minilisp 15.04×; overall 4.21×, success 7/9 vs 9/9).
  Confinement: benchmark commits (#17, #18, #27, #19) touch only `benchmark/`,
  the root tsconfig include/exclude, and the issue tracker; the only `src/`
  change in the workstream is #15. Verified: tsc 0, 446 tests, `accept` 5/5,
  `benchmark/check.ts` 3 PASS.
- Update (2026-10-17): opencode `cost` is no longer always 0 on this gateway
  (session exports report small non-zero values); it is recorded verbatim and
  not compared, so the token-only comparison stands.
