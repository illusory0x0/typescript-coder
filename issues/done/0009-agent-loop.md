---
id: 9
title: Agent loop with verify, rollback, retry
status: done
priority: medium
milestone: M7
parent: 1
deps: [6, 7, 8]
labels: [loop]
created: 2026-10-16
---

## Context

Milestone **M7** of [spec.md](../spec.md) §11, implementing `loop.ts` (spec §5)
and the agent loop in spec §6. The harness parses project TS files, builds the
symbol index, and combines context; the model reads context (YAML), selects the
modified symbol (JSON `Locator`), and outputs a complete replacement (text); the
harness then applies edits, runs the checker (`tsc --noEmit`) and tests
(`bun test`). On failure: report diagnostic → rollback → retry (max 3), and exit
with an explanation for the main agent. Requests the prompt-prefix-invariant
optimization (stable system + tools + context prefix, variable tail).

## Goal

An end-to-end loop that turns an issue into a verified, applied edit, with
rollback/retry and a final explanation on failure.

## Acceptance criteria

- [x] Context assembly emits YAML; symbol selection returns a JSON `Locator`;
      replacement is text (spec §6).
- [x] The edit is accepted only if both `tsc --noEmit` and `bun test` pass.
- [x] On failure the loop reports the diagnostic, rolls back, and retries, up to
      3 times, then emits a failure explanation.
- [x] The outbound prompt keeps a stable prefix (system + tools + context) with
      only a variable tail.
- [x] End-to-end anchor fixture: a failing `bun test` in a fixture repo becomes
      green after the loop runs.
- [x] Bad-edit fixture: a deliberately invalid replacement triggers rollback +
      retry and a final explanation.

## Verification

```
bun test src/loop.test.ts
```

## Notes

- Depends on #6 (editor), #7 (provider), #8 (tools).
- Blocks #10 (CLI/main wiring).
- R7: prompt prefix invariant — cover with a golden-prompt test.
- Defaults (spec §13): per-issue snapshot rollback, per-attempt retry, 3 total;
  one symbol per iteration.
- **Contract for #10** (`src/loop.ts`, 29 tests green):
  - `runLoop(options: LoopOptions): Promise<LoopResult>` with
    `LoopOptions { cwd, issue, model, provider, maxRetries?, temperature?,
    tools?, checkCommand?, testCommand? }` and
    `LoopResult { ok, locator, filePath, editedSource, attempts, diagnostics,
    explanation, messages }`.
  - `ProviderLike` is the injectable provider interface (use `OpenAIProvider`
    with `readConfigFromEnv(model)` in production).
  - Flow: discover+index → context YAML → selection (JSON content or first tool
    call) → replacement → apply via editor → write → `checkTool` + `testTool`;
    on failure the original file is restored, diagnostics are appended to the
    message tail, and the next attempt runs; after `maxRetries` (default 3) a
    final `explain` call fills `explanation`.
  - `maxRetries` bounds selection failures AND edit attempts independently (each
    ≤ maxRetries). Prompt prefix is append-only: system + user(context) are
    built once and never mutated; only the tail (locator/replacement/diagnostics/
    explanation) grows.
  - IMPORTANT for callers: symbol spans exclude the `export` keyword; the LLM
    replacement must be the declaration text WITHOUT `export`.
- **Implementation history:** delegated in 3 bounded sub-agent tasks (context/
  prompts, runLoop, prefix+failure tests); single-shot mega-briefs for this repo
  fail silently, so tasks are kept small. Diffs reviewed and verification re-run
  by the main agent.
- Verified 2026-10-16: `bun test src/loop.test.ts` 29 pass / 0 fail;
  `bunx tsc --noEmit` exit 0; `bun test` 380 pass / 0 fail across 8 files.
  End-to-end anchor fixture (failing `bun test` → green, with real local `tsc`
  + `bun test` verification) and persistent-failure rollback/explanation
  fixtures both pass.
