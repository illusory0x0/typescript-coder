---
id: 112
title: "Rename the internal anchor vocabulary to matcher"
status: todo
priority: medium
milestone: null
parent: 105
deps: [106]
labels: [refactor, agent-loop]
created: 2026-10-20
---

## Context

The specification (`#106`, `docs/edit-protocol.md`) fixes the term **matcher**
for the locator that yields a candidate set, rejecting "anchor". The shipped
implementation still uses "anchor" as its internal name: `src/anchor.ts`,
`findAnchor`, `parseAnchorFragment`, and the implementation vocabulary in
`docs/design.md` / `docs/glossary.md`. The documentation pass deliberately left
the code naming alone, so the codebase and the spec now use two words for one
concept.

## Goal

Rename the internal concept from "anchor" to "matcher" across code and
implementation docs, with no behavior change. The wire protocol and prompts are
unchanged.

## Acceptance criteria

- [ ] `src/anchor.ts` → `src/matcher.ts`; `findAnchor`, `parseAnchorFragment`
      and any other `anchor`-named symbols renamed to `matcher` analogues.
- [ ] Imports, tests, and call sites updated; `bunx tsc --noEmit` clean and
      `bun test` green.
- [ ] `docs/design.md` and `docs/glossary.md` use "matcher" for the concept; no
      `anchor` remains as a term.
- [ ] No behavior, wire-format, or prompt change.

## Verification

```
bunx tsc --noEmit
bun test
grep -rn "anchor" src/ docs/design.md docs/glossary.md
```

## Notes

- Filed from the `#106` cleanup: the spec uses **matcher**; the code kept
  **anchor**.
- Historical artifacts (`issues/done/`, `issues/wontfix/`, `dependencies.dot`,
  dated results) keep their original labels and wording.
- Scope also covers docs/spec.md (findAnchor/AnchorResult at :139, anchor.ts at :226) and docs/review-guide.md (:25, :72), which name the old anchor vocabulary — the rename must stay consistent across every editable doc.
