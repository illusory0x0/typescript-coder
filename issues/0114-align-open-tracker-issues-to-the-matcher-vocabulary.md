---
id: 114
title: "Align open tracker issues to the matcher vocabulary"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [hygiene]
created: 2026-10-20
---

## Context

After `#106` settled the vocabulary, several open issues still use the old
words and framing:

- `#105`'s Goal and acceptance criteria say "stage/selector" and frame the
  coordinate kinds `line`/`(line,column)` as standalone selector kinds, which the
  final model replaces with `pick` ranges.
- `#109`'s title is "regex selector".
- `#110` still reasons about `LoopRecord.selectors` with the old stage names.

## Goal

Open issues use **matcher** / **viewer** / **editor** and the
`select → match → pick → replace` cascade, matching `docs/edit-protocol.md`.

## Acceptance criteria

- [ ] `#105` Goal/AC say "matcher" (not "selector") and frame coordinates as
      `pick` ranges, not standalone selector kinds.
- [ ] `#109`'s title and body use "matcher"; `#110` names the stage vocabulary
      `select / match / pick / replace`.
- [ ] wording only — no design, dependency, or status change.
- [ ] `bun .opencode/scripts/issue-tracker.ts check --strict` clean.

## Verification

```
bun .opencode/scripts/issue-tracker.ts check --strict
grep -rn "selector" issues/0105-*.md issues/0109-*.md issues/0110-*.md
```

## Notes

- `issues/done/` and `issues/wontfix/` keep their original wording.
- Body edits need the body-edit CLI path (see the CLI issue) or a manual edit.
