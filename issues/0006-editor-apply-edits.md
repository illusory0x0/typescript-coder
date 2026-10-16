---
id: 6
title: Editor apply-edits and oxfmt formatting
status: done
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

- [x] `applyEdits(source, edits)` replaces each symbol's span with its
      `llm-output`.
- [x] Multiple edits are applied bottom-up by offset so spans stay valid.
- [x] The result is formatted with `oxfmt` (or the fallback chosen in #2).
- [x] Before/after unit tests pass, including a multi-edit case.
- [x] A `Locator` that does not resolve to a node produces a clear error.

## Verification

```
bun test src/editor.test.ts
```

## Notes

- Depends on #5 (binder provides Locator → span).
- Blocks #8 (rename) and #9 (loop).
- **Contract for #8/#9** (`src/editor.ts`, 11 tests green):
  - `Edit { locator: Locator; llmOutput: string }`.
  - `applyEdits(source: string, edits: Edit[], fileName = "file.ts"):
    Promise<string>` — resolves each Locator via `buildIndex([{path: fileName,
    source}])` + `lookup` (path must equal `fileName`), applies replacements
    bottom-up, then formats with `oxfmt` (`format(fileName, updated, {})`).
  - Empty `edits` returns `source` byte-identical (no formatting pass).
  - Errors: unresolved Locator → `no symbol <kind> <name> in <fileName>`;
    overlapping ranges → `overlapping edits for ...`; unparsable replacement →
    `oxfmt failed: ...`.
  - v1 resolution semantics: overload sets resolve to the FIRST declaration span
    only; class/interface Locators span the whole declaration incl. body;
    variable Locators resolve to the `VariableDeclarator` span (not the whole
    statement); `C.m` replaces just the member.
  - oxfmt v0.73.0 defaults: prettier style, 2-space indent, trailing newline,
    semicolons added.
- v1 applies one symbol per iteration in the loop (spec §13); `applyEdits` still
  supports the multi-edit signature.
- **Implementation history:** delegated as one bounded sub-agent task; diff
  reviewed, verification re-run by the main agent.
- Verified 2026-10-16: `bun test src/editor.test.ts` 11 pass / 0 fail;
  `bunx tsc --noEmit` exit 0; `bun test` 309 pass / 0 fail across 5 files.
