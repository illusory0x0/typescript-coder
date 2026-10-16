---
id: 9
title: Agent loop with verify, rollback, retry
status: todo
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

- [ ] Context assembly emits YAML; symbol selection returns a JSON `Locator`;
      replacement is text (spec §6).
- [ ] The edit is accepted only if both `tsc --noEmit` and `bun test` pass.
- [ ] On failure the loop reports the diagnostic, rolls back, and retries, up to
      3 times, then emits a failure explanation.
- [ ] The outbound prompt keeps a stable prefix (system + tools + context) with
      only a variable tail.
- [ ] End-to-end anchor fixture: a failing `bun test` in a fixture repo becomes
      green after the loop runs.
- [ ] Bad-edit fixture: a deliberately invalid replacement triggers rollback +
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
