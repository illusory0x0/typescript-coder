---
id: 11
title: Live end-to-end acceptance and model-record corrections
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [umbrella, acceptance]
created: 2026-10-17
---

## Context

Umbrella for the live-acceptance workstream planned in the 2026-10-17
consult-me session (see the "unverified inventory" in that conversation). The
provider key was verified working: `GET $OPENAI_BASE_URL/models` returns 200
(149 models) and single-shot smoke calls passed for `deepseek-v4.1-flash`,
`deepseek-v4-pro-0813`, `glm-5.3`, and `zoe/glm-5.3`. Previously the spec's
literal model ids `deepseek`/`qwen` returned 403, which was mis-recorded as a
key-permission problem.

Two gaps remain: (A1) the agent loop has never been exercised end-to-end with a
real model, and (A2) spec/issue records still name the wrong model ids. This
umbrella closes both; children hold the implementation work.

## Goal

A real-model live acceptance run of the harness is green with retained
evidence, and spec/issue/README model records match the actual gateway.

## Acceptance criteria

- [ ] All child issues (#12, #13, #14) are `done`.
- [ ] `bun run accept --live --model deepseek-v4.1-flash` exits 0 with
      `PASS live-fix-answer`, and `acceptance/report.json` records the live run
      (`live: true`, model, attempts, duration).
- [ ] `spec.md` §8 and the notes of `issues/done/0007` + `0001` state the real
      gateway model ids and the `qwen` limitation.
- [ ] Offline suites are unchanged: `bunx tsc --noEmit` 0, `bun test` 394 pass,
      `bun run accept` 5/5, `bun run accept --all` 6/6.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
bun run accept --all
bun run accept --live --model deepseek-v4.1-flash
```

plus: read `spec.md` §8 and the correction notes in `issues/done/0007` /
`issues/done/0001`.

## Notes

- Children: #12 runner live layer, #13 live run + evidence, #14 record
  corrections.
- Non-goals this round: self-host live scenario, CI wiring, live verification of
  additional models (glm/kimi/claude…), streaming/caching observation.
- Priority defaulted to `medium` (source states none); milestone left `null`
  (this is post-spec hardening, not one of M0–M8).
