---
id: 8
title: "Keep a confirmation edit after the last normal exchange"
status: todo
priority: medium
milestone: null
parent: 6
deps: []
labels: [agent-loop]
created: 2026-10-22
---

## Context

The compact `# modified text` confirmation asks the model to reply `Great! I resolve this problem!` or another edit clause. In `src/loop.ts` the confirmation reply is prefetched only when `exchange < MAX_EDIT_EXCHANGES`; when the verified edit used the last of the 3 exchanges and the model returns a valid editor clause, the code returns `success(newSource)` and drops that edit.

The confirmed semantics are “an editor clause continues”; dropping it loses the model’s requested correction.

## Goal

Apply and verify a valid editor reply to `# modified text` even when the verified edit consumed the last normal edit exchange, without losing the verified state or double-counting provider tokens.

## Acceptance criteria

- [ ] A scripted compact flow where the edit verifies on exchange 3 and the `# modified text` reply is a valid editor clause applies that edit and verifies it again.
- [ ] The second edit is applied without a duplicate provider call for the prefetched reply.
- [ ] A Great/prose/malformed/viewer reply still ends successfully without applying anything.
- [ ] The confirmation turn’s budget/round accounting is explicit (a new round or a defined extra exchange) and the run cap/token budget still apply.
- [ ] Records remain ordered and include the `confirmed` row plus the applied/verification rows for the second edit.
- [ ] JSON mode still has no confirmation turn.

## Verification

```
bun test src/loop.test.ts -t "modified|confirm|budget"
bunx tsc --noEmit
just accept
```

Add a test that consumes all three exchanges before the confirmation and asserts the second edit lands.

## Notes

- The current guard is the `exchange < MAX_EDIT_EXCHANGES` condition in the compact confirmation block.
- Starting a fresh round with the prefetched reply is acceptable if the modified prompt and prefetched edit stay paired in the transcript.
