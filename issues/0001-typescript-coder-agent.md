---
id: 1
title: typescript-coder agent (umbrella)
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [umbrella]
created: 2026-10-16
---

## Context

Umbrella for the `typescript-coder` project defined in
[spec.md](../spec.md). The agent reads an issue from **stdin**, uses a
hand-written TypeScript frontend plus a symbol index to select a target symbol
(`Locator`), asks an OpenAI-compatible LLM to emit a complete replacement,
applies it via span replacement + `oxfmt`, and accepts it only if `tsc --noEmit`
and `bun test` pass. On failure it rolls back, retries up to 3 times, then
reports an explanation for the planning main agent.

This issue holds no direct implementation work; the milestone children do.

## Goal

Deliver a working end-to-end TypeScript coding agent matching spec.md.

## Acceptance criteria

- [ ] All child milestones are `done`.
- [ ] Anchor fixture 1: on a fixture repo with a failing `bun test`, the agent
      applies a symbol replacement that turns tests green and keeps
      `tsc --noEmit` clean.
- [ ] Anchor fixture 2: a deliberately-bad edit triggers rollback + retry and a
      final explanation.
- [ ] Anchor fixture 3: after the agent edits its own `src/`, `tsc` and
      `bun test` still pass (self-host smoke).

## Verification

`bunx tsc --noEmit && bun test` on the project, plus the three anchor fixtures
described in spec.md §10.

## Notes

- Children: #2 Scaffold, #3 Lexer, #4 Parser, #5 Binder & symbol index,
  #6 Editor, #7 Provider, #8 Tools, #9 Agent loop, #10 CLI & main.
- Non-goals (v1): JSX/TSX support, lossless CST, custom TS printer, build step.
- Priority defaulted to `medium` because spec.md states no priorities.
