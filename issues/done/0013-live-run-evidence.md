---
id: 13
title: Run live end-to-end acceptance and capture evidence
status: done
priority: medium
milestone: null
parent: 11
deps: [12]
labels: [acceptance, live]
created: 2026-10-17
---

## Context

Second step of the live-acceptance work: execute the gated live scenario from
#12 against the real gateway and capture honest evidence that the harness
(context → symbol selection → replacement → tsc/bun test → write) works with a
real model. This closes gap A1 (never exercised live) and gathers the A3/A4
observations (model JSON behavior, attempts/retries) for the records in #14.

## Goal

One real-model live acceptance run is green and its evidence is retained in the
report and summarized for the issue notes.

## Acceptance criteria

- [ ] `bun run accept --live --model deepseek-v4.1-flash` exits 0 and prints
      `PASS live-fix-answer`.
- [ ] `acceptance/report.json` contains the live scenario entry with
      `live: true`, `model: "deepseek-v4.1-flash"`, `status: "passed"`,
      `attempts`, and `durationMs`.
- [ ] A short evidence summary (result, attempts, duration, and whether the
      locator resolved on the first try) is recorded for use in #14's notes.
- [ ] If the run fails, it is reported as-is (no repeated retries to force
      green); at most one same-day re-run is allowed and must be noted, after
      which the failure diagnostics are recorded and the issue stays open.

## Verification

```
bun run accept --live --model deepseek-v4.1-flash; echo "exit: $?"
bun -e 'const r = await Bun.file("acceptance/report.json").json(); console.log(JSON.stringify(r.scenarios.filter(s => s.live), null, 2));'
```

## Notes

- Depends on #12 (runner live layer).
- Model behavior is non-deterministic; temperature 0 reduces variance but does
  not guarantee identical output. Token cost is one small fixture run.
- Non-goals: other models, self-host live, long-run stability.
- Verified 2026-10-17: `bun run accept --live --model deepseek-v4.1-flash`
  exit 0, `PASS live-fix-answer` (7421ms); report entry: `live: true`,
  `model: "deepseek-v4.1-flash"`, `status: "passed"`, `attempts: 2`,
  `durationMs: 7421`, all four assertions ok; other scenarios carry no
  live/model fields.
- Evidence summary for #14: result passed; attempts 2 (one retry); duration
  7421ms. The retry cannot be attributed to the locator vs the edit: symbol
  selection failures are appended to the same `result.attempts` list as edit
  attempts (`src/loop.ts`), so first-try locator resolution is not itemized by
  the retained evidence.
