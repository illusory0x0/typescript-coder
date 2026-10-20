---
id: 116
title: "Add a body-edit command to the issue-tracker CLI"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [cli, tools]
created: 2026-10-20
---

## Context

`.opencode/scripts/issue-tracker.ts` can `add`, `set` (frontmatter fields),
`note` (append only), `archive`, and `reorder`, but has no way to edit an
issue's prose. `set` ignores the body and `note` only appends, so this session
had to edit issue markdown by hand — contradicting "all writes through the
script" and forcing ad-hoc frontmatter handling.

## Goal

The CLI can replace an issue's body and re-derive its files, so prose edits go
through the script.

## Acceptance criteria

- [ ] `edit <id> --body <file|->` (or `set --body`) replaces the body, preserves
      frontmatter, and refreshes the derived files.
- [ ] a body missing a required section (`## Context`, `## Goal`,
      `## Acceptance criteria`, `## Verification`) is rejected the same way
      `add` rejects it.
- [ ] tests cover the new command; `check --strict` clean.
- [ ] the existing commands' output contract is unchanged.

## Verification

```
bun .opencode/scripts/issue-tracker.ts help
bun test
bun .opencode/scripts/issue-tracker.ts check --strict
```

## Notes

- Would let the vocabulary and `#106` reconciliations land through the tool
  instead of by hand.
