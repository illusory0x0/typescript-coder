---
id: 1
title: "Implement the editing-protocol deltas from human/edit.md"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-21
---

## Context

`human/edit.md` is the human-authored editing protocol: a reply is one or more
`select <symbol> in <path> [resolve <value|type|namespace>] [match (<snippet> |
/regex/)] [pick <range>] [replace with <fence>] end` clauses, with defaults for
absent paths/symbols and viewer feedback that marks the matched AST. The repo
already ships a close compact variant — the grammar in `src/selection.ts`, the
cascade in `src/cascade.ts`, the reply resolver in `src/compact.ts`, and the
as-built spec in `docs/editing-protocol.md`.

This umbrella covers only the deltas between that shipped variant and
`human/edit.md`:

- `resolve <value|type|namespace>` after the path, resolving TypeScript symbol
  spaces rather than a declaration-kind prefix.
- Creation defaults: create the file when the path is absent, append when the
  symbol is absent, and default to a `let` binding when `resolve` is absent.
- A fence that opens with **6+** backticks, whose body contains no ``` and
  whose closing run matches the opening.
- Viewer feedback as a numbered declaration block with `⁉️` on matched AST
  lines.

The shipped resolver, gates, JSON payload path, and legacy declaration-kind
prefix stay.

## Goal

The compact `select … end` protocol implements the deltas in `human/edit.md`
end to end, with the prompts, docs, and offline tests aligned.

## Acceptance criteria

- [ ] `select <symbol> in <path> resolve value|type|namespace` parses,
      serializes, and resolves a top-level declaration by TS symbol space.
- [ ] An absent path is created, an absent symbol is appended at the top-level
      end, and a create with no `resolve` defaults to a `let` binding.
- [ ] A fence opens with 6+ backticks, its body contains no ```, and the
      closing run matches the opening.
- [ ] A viewer renders the numbered declaration and marks matched AST lines
      with `⁉️`.
- [ ] The system prompt, few-shot examples, protocol correction text,
      `docs/editing-protocol.md`, and `docs/agent-loop.md` describe the same
      grammar and defaults as the implementation.
- [ ] The offline acceptance scenario `compact-viewer-edit` passes.
- [ ] `just format && just typecheck && just test` pass.
- [ ] Every child issue is done or wontfix.

## Verification

```
just format
just typecheck
just test
just accept --only compact-viewer-edit
rg -n "resolve (value|type|namespace)|⁉️|6\+ backticks" src docs acceptance
```

## Notes

- Delta scope only: the shipped JSON payload path (`--protocol-format=json`,
  `parseEditResponse`, `resolveEditRange`, `--multi-payload` batches), the
  separate JSON pick phase, and the declaration-kind prefix form are unchanged.
- Non-goals: re-expressing the pick phase / symbol index as `select` clauses
  (the human example's first turn), the post-edit "Great! I resolve this
  problem!" confirmation turn, a separate `str_search` engine (the top-level
  declaration is resolved by the symbol index; a no-`match` viewer renders
  that declaration), and removing the superset range selecters.
- `human/edit.md` is the source of truth for the delta;
  `docs/editing-protocol.md` is updated to it by the last child.
- Prompt text is benchmark-sensitive. Do not tune against the held-out
  `csv-parser` fixture; live checks stay opt-in.
- Priority is left at the tracker default (medium) because the request did not
  name one.
