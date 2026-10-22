---
id: 21
title: "Apply renames atomically in the edit-dsl loop and teach the grammar"
status: todo
priority: medium
milestone: null
parent: 17
deps: [19, 20]
labels: [agent-loop, edit-protocol, docs]
created: 2026-10-22
---

## Context

The parser and rename engine need to participate in the edit-dsl loop. The loop
already parses a `multiEditor` reply in `src/loop.ts` via `parseMultiEditor`,
resolves statements through `resolveMultiEditor`, applies regions through
`applyResolvedRegions`, and writes only when the whole reply is clean. Rename
needs the same atomicity, diagnostics, prompt teaching, and docs, without
calling the `rename` tool.

## Goal

A rename clause works end to end: the loop resolves it, applies it atomically,
verifies the result, and reports actionable failures; the prompt and docs teach
the same grammar.

## Acceptance criteria

- [ ] A scripted `runLoop` scenario selects a declaration, replies with a
      `rename` clause, and returns success with both the declaration and its
      references updated.
- [ ] Rename failures use staged diagnostics (address/duplicate/range as
      appropriate), name the selected target and the conflicting name, and
      write nothing.
- [ ] A reply mixing a rename with another editor/file command applies both or
      neither; a failure in one discards the whole reply.
- [ ] The rename path never invokes the `rename` tool or any provider tool call.
- [ ] `buildEditDslSystemPrompt`, `editDslInstruction`, the protocol correction
      text, `docs/editing-protocol.md`, and `docs/agent-loop.md` describe
      `rename <old> to <new>`.
- [ ] An offline acceptance scenario (for example `edit-dsl-rename`) proves a
      rename through the real CLI path and passes.
- [ ] `just typecheck && just test && just accept --all` pass.

## Verification

```sh
just typecheck
just test
just accept --all
```

## Notes

- Depends on the parser, local-scope, and dotted-target leaves.
- Prompt text is benchmark-sensitive; keep the rename teaching concise and do
  not tune against the held-out `csv-parser` fixture.
- Do not remove the existing `rename` tool in this issue; removing tools is a
  separate decision.
