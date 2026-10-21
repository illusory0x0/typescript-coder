---
id: 4
title: "Render viewer details as a numbered declaration block with match markers"
status: todo
priority: medium
milestone: null
parent: 1
deps: [2]
labels: [agent-loop]
created: 2026-10-21
---

## Context

`human/edit.md` says a clause that stops before `replace` views the code with
line numbers and marks the matched AST with `⁉️` (`:14-20`). The shipped
`renderViewerFeedback` (`src/compact.ts:284-305`) instead prints
`Located occurrences (viewer clauses write nothing):`, a `path:line:col` line
per occurrence, and a repeated numbered snippet per occurrence. It neither
renders the whole declaration as one numbered block nor marks the matched
lines, so the model cannot see the declaration around a match the way the human
example does.

## Goal

A viewer clause's next-prompt feedback renders the resolved declaration once as
a numbered source block, marking every matched AST line with `⁉️`; a bare
viewer renders the declaration unmarked.

## Acceptance criteria

- [ ] A bare viewer (`select answer in src/helper.ts resolve value end`) renders
      the whole declaration as `1 | export function answer(): number {`, `2 | …`,
      `3 | }` and writes nothing.
- [ ] A `match` viewer marks every display line intersected by a matched AST
      span with `⁉️` in the left gutter, before the line number, and leaves the
      other lines unmarked.
- [ ] Multiple candidates mark every intersecting line, and the declaration
      block is rendered once per clause, not once per occurrence.
- [ ] The exact `path:line:col` candidate positions and the term
      `viewer clauses write nothing` are retained somewhere in the feedback.
- [ ] A viewer that fails its matcher/range still reports its typed
      `stage: matcher` or `stage: range` diagnostic and renders no block.
- [ ] The feedback still ends with "Reply with an edit clause (add `replace`)
      or narrow a viewer with `pick`."
- [ ] `src/compact.test.ts` asserts the exact text for a bare viewer, a
      single-match viewer, and a multi-candidate viewer.

## Verification

```
bun test src/compact.test.ts
bunx tsc --noEmit
```

## Notes

- Depends on the grammar issue only for the `resolve` spelling in the example;
  the renderer works with a legacy declaration-kind locator too.
- Extend `CompactViewer` with the declaration's numbered lines (for example a
  `declaration: OccurrenceLine[]` field) so the renderer can show the whole
  declaration; keep `CompactOccurrence` offsets and `path:line:col` for the
  header.
- Marker format decided here: `⁉️` in the gutter on each intersecting line.
  It keeps the code text after `N | ` byte-copyable as a matcher, unlike inline
  boundary markers.
- A no-`match` viewer renders the whole top-level declaration; no separate
  `str_search` engine is introduced.
- No prompt changes here; the model-facing example is the last child.
