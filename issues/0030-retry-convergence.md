---
id: 30
title: "Retry convergence: keep progress, reset context, guard truncation"
status: todo
priority: high
milestone: null
parent: 28
deps: [29]
labels: [harness]
created: 2026-10-17
---

## Context

Failure anatomy (2026-10-17): each failed attempt is rolled back
(`restoreTarget`, src/loop.ts:633) so the next retry restarts from pristine
state; every retry re-echoes the full previous replacement into the
conversation (src/loop.ts:606/641), inflating input; retry prompts carry no
attempt awareness; and `finishReason === "length"` is ignored, so a truncated
completion is consumed as a complete replacement and burns an attempt
(openai.ts parses `finishReason` but the loop never reads it).

## Goal

Failed attempts keep their applied progress, retries iterate on the current
state with compact focused context, and truncated outputs get targeted
guidance instead of a wasted verification cycle.

## Acceptance criteria

- [ ] Keep-progress: a verification failure no longer restores the target file
      (for both replace and append modes); the attempted state stays on disk
      and the next attempt sees the current source. The comment at
      src/loop.ts:560 and the benchmark report wording about pristine failure
      workspaces are updated to match the new semantics.
- [ ] Fresh-reset retry context: each retry rebuilds a bounded message history
      (system + issue/context + selected locator + retry prompt with current
      symbol source + diagnostics + attempt info); previous assistant
      replacements are not re-echoed and history does not grow per attempt.
      The retry prompt includes the current source of the target (re-read from
      disk, not the original snapshot).
- [ ] Attempt-aware prompts: retry prompts state the attempt number/remaining
      budget and instruct minimal corrective changes to the current source.
- [ ] Truncation guard (C-lite): `finishReason === "length"` is classified as
      `truncated` (not as a normal format/tsc/test failure) with an explicit
      diagnostic asking for a more compact output; recorded per #29.
- [ ] Unit tests: no-rollback on failure, bounded/rebuilt retry messages,
      attempt-aware prompt content, truncated classification; gates
      (`bunx tsc --noEmit` 0, `bun test`, `bun run accept`).

## Verification

```
bun test
```

plus a mocked-loop scenario proving the file on disk contains the attempted
text after a failed verification, and that retry messages contain no previous
replacement echo.

## Notes

- Depends on #29 for outcome fields and bundle evidence.
- Provider-error paths: with rollback removed, update the stale comment at
  src/loop.ts:560; a provider error after a failed attempt now leaves the
  attempted state in place (this is intended).
- Depends on #36 for progress-based attempt extension and budget caps; #30
  keeps the attempt loop structure that #36 extends.
- Non-goals: best-state selection (user declined), sampling/temperature
  changes, prompt content beyond attempt awareness.
