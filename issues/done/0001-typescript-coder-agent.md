---
id: 1
title: typescript-coder agent (umbrella)
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [umbrella]
created: 2026-10-16
---

## Context

Umbrella for the `typescript-coder` project defined in
[spec.md](../../spec.md). The agent reads an issue from **stdin**, uses a
hand-written TypeScript frontend plus a symbol index to select a target symbol
(`Locator`), asks an OpenAI-compatible LLM to emit a complete replacement,
applies it via span replacement + `oxfmt`, and accepts it only if `tsc --noEmit`
and `bun test` pass. On failure it rolls back, retries up to 3 times, then
reports an explanation for the planning main agent.

This issue holds no direct implementation work; the milestone children do.

## Goal

Deliver a working end-to-end TypeScript coding agent matching spec.md.

## Acceptance criteria

- [x] All child milestones are `done`.
- [x] Anchor fixture 1: on a fixture repo with a failing `bun test`, the agent
      applies a symbol replacement that turns tests green and keeps
      `tsc --noEmit` clean.
- [x] Anchor fixture 2: a deliberately-bad edit triggers rollback + retry and a
      final explanation.
- [x] Anchor fixture 3: after the agent edits its own `src/`, `tsc` and
      `bun test` still pass (self-host smoke).

## Verification

`bunx tsc --noEmit && bun test` on the project, plus the three anchor fixtures
described in spec.md §10.

## Notes

- Children: #2 Scaffold, #3 Lexer, #4 Parser, #5 Binder & symbol index,
  #6 Editor, #7 Provider, #8 Tools, #9 Agent loop, #10 CLI & main.
- Non-goals (v1): JSX/TSX support, lossless CST, custom TS printer, build step.
- Priority defaulted to `medium` because spec.md states no priorities.
- **Final state (2026-10-16):** all children `done`; 394 tests green across 9
  files; `bunx tsc --noEmit` clean. Anchor fixtures:
  1. `src/loop.test.ts` happy-path e2e (temp repo with failing test → green
     through real `tsc` + `bun test` verification);
  2. `src/loop.test.ts` persistent-failure e2e (type-invalid replacement →
     rollback ×3 → explanation, file restored);
  3. `src/cli.test.ts` self-host smoke (agent edits a copy of `src/`, loop's
     check+test pass there, copied suite green).
- **Known v1 limitations carried forward:** live LLM calls need a key that
  permits `deepseek`/`qwen` (current key returns 403 for those model ids; all
  automated tests use mocked providers); parser gaps for private `#names`,
  import attributes, `using`, `<const>`, mapped key remapping, `typeof import`;
  rename tool rewrites declaration names only; `scroll` variable view omits the
  declaration keyword; the editor applies one symbol per loop iteration
  (spec §13 default).
- **Process note:** large single-shot sub-agent delegations fail silently in
  this environment; all milestones were implemented via small bounded
  sub-agent tasks with main-agent review + re-verification, committed per
  component.
- **Live evidence (2026-10-17, #13):** `bun run accept --live --model
  deepseek-v4.1-flash` exit 0, `PASS live-fix-answer`; result passed, attempts
  2, duration 7421ms. `acceptance/report.json` records the entry with
  `live: true`, `model: "deepseek-v4.1-flash"`, `status: "passed"`. This
  supersedes the "Known v1 limitations" reading that the key could not use the
  configured models — the real, key-permitted chat ids are now in spec.md §8.
