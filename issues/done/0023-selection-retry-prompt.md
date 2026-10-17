---
id: 23
title: "Loop: correct the selection-retry prompt and echo the rejected response"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop]
created: 2026-10-17
---

## Context

When the model's locator is invalid, `src/loop.ts:345-358` pushes
`buildDiagnosticsPrompt(diagnostic)`, whose text (`src/loop.ts:140-151`) says
"The previous replacement failed verification" and asks for "a corrected
COMPLETE replacement for the selected symbol". In the selection phase there is
no replacement and no selected symbol: the model must re-emit a locator JSON.
The rejected assistant response is also not echoed into `messages` (the edit
loop does echo it: `src/loop.ts:450-451`), so the model cannot see its own
malformed output. `src/loop.test.ts:375-407` only checks that the string
"invalid locator" appears, so the mismatch is not covered.

## Goal

Selection retries ask for exactly what is needed — a corrected locator JSON —
and include the rejected response in the conversation history.

## Acceptance criteria

- [ ] A selection-specific diagnostics prompt (no replacement wording)
      instructs the model to output ONLY a corrected locator JSON, no fences or
      prose.
- [ ] The rejected assistant response is echoed before the retry prompt
      (mirroring the edit loop's assistant turn).
- [ ] The stable prompt prefix (system + issue/context) is unchanged; only the
      variable tail grows (assert in tests).
- [ ] `src/loop.test.ts` invalid-locator retry test asserts the new prompt
      semantics and the echo; the retries-exhausted test still passes.
- [ ] `bunx tsc --noEmit` 0; `bun test` green; `bun run accept` 5/5.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
```

## Notes

- Priority `medium` (Eisenhower Q2: important, not urgent).
- Related: #21 (context/report changes), #24 (loop message plumbing) — no hard
  deps.
- Non-goals: changing the maximum number of selection retries (stays
  `maxRetries`).
- Validation (2026-10-17): the retry test asserts the stable prefix is
  byte-identical and the tail grows by exactly two messages (rejected response
  echo + retry prompt); the exhausted-retries path breaks before the echo
  (explain call stays `["system", "user", "user"]`). Edge recorded for #24: a
  rejected locator arriving as a tool call has `response.content === null`, so
  the echo is empty — tool-call arguments are not echoed.
