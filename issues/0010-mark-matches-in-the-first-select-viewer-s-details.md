---
id: 10
title: "Mark matches in the first select viewer's details"
status: todo
priority: medium
milestone: null
parent: 6
deps: []
labels: [agent-loop]
created: 2026-10-22
---

## Context

The compact select-first turn accepts a viewer clause such as `select answer in src/helper.ts resolve value\nmatch \`return 1;\`\nend`. The harness pins the declaration and builds `# details` with `buildCompactDetailsPrompt`, which currently renders the declaration without `⁉️` markers even when the viewer carried a `match`. The edit-phase viewer feedback (`renderViewerFeedback`) does mark matched lines, so the first-turn details loses that information.

## Goal

When the first select viewer carries a `match`, mark every line intersected by a matched span in `# details`; a bare select viewer stays unmarked.

## Acceptance criteria

- [ ] A compact first reply `select answer in src/helper.ts resolve value` + `match \`return 1;\`` + `end` leads to a `# details` block with `⁉️` on the matched line(s).
- [ ] A bare select viewer’s `# details` has no `⁉️` marker.
- [ ] The declaration block is rendered once, keeps file-absolute `N | ` line numbers, and the select head/index is unchanged.
- [ ] The behavior is covered by a loop test and a prompt-rendering test if the details builder is unit-tested.
- [ ] No marker leaks into the JSON path.

## Verification

```
bun test src/loop.test.ts -t "details|viewer|compact"
bunx tsc --noEmit
just accept
```

## Notes

- Reuse the existing viewer occurrence/marker logic or `renderViewerFeedback` rather than adding a second span renderer.
- The first-turn viewer is usually bare; this is a correctness polish for a match viewer, not a change to the bare path.
