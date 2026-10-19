---
id: 45
title: "Self-host verification: check/test command timeout below suite runtime"
status: done
priority: high
milestone: null
parent: null
deps: []
labels: [harness]
created: 2026-10-18
---

## Context

`bun test` is currently red on master, independent of #42-#44: the self-host
smoke in `src/cli.test.ts:322` copies `src/` to a temp dir and drives `runMain`
with a scripted provider, letting `runLoop` verify the edit with `tsc --noEmit`
plus the full copied `bun test`. `runLoop` defaults its check/test command
timeout to 30s (`commandTimeoutMs` in `src/tools.ts:34`), but the copied suite
now runs ~33s on this machine, so the full-suite verification is killed
mid-run: attempt 1 fails with `outcome: tests`, the smoke's scripted provider
has no second response, and `runMain` exits 1 (`provider error: no scripted
response`). The acceptance `self-host` scenario (`bun run accept --all`) drives
the same path with the same default and fails identically.

Reproduced 2026-10-18: `bun test src/cli.test.ts` fails today; the same
fixture through `runLoop` passes first try with `commandTimeoutMs: 120000`
(verified with a scratch driver).

## Goal

Self-host verification passes on this repository: the loop's check/test command
timeout accommodates the repo's own suite runtime, so `bun test` and
`bun run accept --all` are green.

## Acceptance criteria

- [ ] `bun test` passes including the `src/cli.test.ts` self-host smoke (no new skips for it).
- [ ] `bun run accept --all` passes, including the self-host scenario.
- [ ] The chosen timeout is documented where loop options are described (`spec.md` §12 R4 or the relevant comments).

## Verification

```
bun test
bunx tsc --noEmit
bun run accept --all
```
