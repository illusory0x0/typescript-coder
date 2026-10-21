---
id: 9
title: "Make compact retry and decision prompts consistently select-first"
status: todo
priority: medium
milestone: null
parent: 6
deps: []
labels: [agent-loop]
created: 2026-10-22
---

## Context

Compact retry/continuation prompts now use `# Goal` + `# Symbol index` + `# details`, but two shape leaks remain:

- the compact retry prompt still appends `SELF_CHECK_OFFER`, which is a JSON `{"request": ...}` instruction, after teaching only the compact clause form;
- the decision-only branch (`stalled && isDecisionAsk`) returns the old header + diagnostics and bypasses the compact Goal/Index/details context.

JSON prompts must stay byte-identical.

## Goal

Make compact retry and decision-only prompts consistently select-first, with no bare JSON edit/self-check teaching that conflicts with the compact reply shape.

## Acceptance criteria

- [ ] Compact retry/continuation prompts do not contain the unqualified JSON self-check sentence; if the self-check request remains available, it is stated as an explicit JSON-only exception, not mixed into the compact edit instruction.
- [ ] A repeated no-progress decision-only turn under compact includes the Goal, symbol index, and current declaration/details context (or an equivalent compact decision shape) and does not show the JSON pinned-selection block.
- [ ] JSON retry/continuation/decision prompts remain byte-identical.
- [ ] Tests cover a compact edit-retry prompt, a compact selection-retry prompt, and a compact decision-only prompt; a JSON counterpart test confirms the old text.

## Verification

```
bun test src/loop.test.ts -t "retry|continuation|decision|prompt"
bunx tsc --noEmit
```

## Notes

- `SELF_CHECK_OFFER` is still parsed by the repair exchange; decide whether to keep it as an explicit exception or remove it from compact prompts. Do not change the self-check mechanism itself.
- The decision-only branch occurs after repeated stalled rounds; no-progress/STOP semantics must not change.
