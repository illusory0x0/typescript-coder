---
id: 6
title: Editor apply-edits and oxfmt formatting
status: todo
priority: medium
milestone: M4
parent: 1
deps: [5]
labels: [editor]
created: 2026-10-16
---

## Context

Milestone **M4** of [spec.md](../spec.md) §11, implementing `editor.ts` (spec
§5). Implements the `apply-edits` abstraction from spec §4:
`applyEdits(source, edits) → new-source`. Each `Edit` pairs a `Locator` with the
LLM's complete replacement text for that symbol. Spans shift as edits are
applied, so edits must be applied **bottom-up by offset**.

## Goal

`editor.ts` replaces each target symbol's source range with the LLM text (safely,
bottom-up) and formats the result with `oxfmt`, returning the new source.

## Acceptance criteria

- [ ] `applyEdits(source, edits)` replaces each symbol's span with its
      `llm-output`.
- [ ] Multiple edits are applied bottom-up by offset so spans stay valid.
- [ ] The result is formatted with `oxfmt` (or the fallback chosen in #2).
- [ ] Before/after unit tests pass, including a multi-edit case.
- [ ] A `Locator` that does not resolve to a node produces a clear error.

## Verification

```
bun test src/editor.test.ts
```

## Notes

- Depends on #5 (binder provides Locator → span).
- Blocks #8 (rename) and #9 (loop).
- v1 applies one symbol per iteration in the loop (spec §13); `applyEdits` still
  supports the multi-edit signature.
