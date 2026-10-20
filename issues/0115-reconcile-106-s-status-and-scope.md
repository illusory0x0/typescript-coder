---
id: 115
title: "Reconcile #106's status and scope"
status: review
priority: medium
milestone: null
parent: null
deps: []
labels: [hygiene]
created: 2026-10-20
---

## Context

`#106` asked for the compact-syntax specification. It was written and committed
(`50b7d7c`) and its grammar home is now `docs/edit-protocol.md`, so the doc part
is done — yet `#106` is still `todo`. Two mismatches remain:

- Its last AC ("exported selector/selection types") is code work, which
  `edit-protocol.md` explicitly disclaims ("defines no code") and which `#107`
  (parse/serialize) already owns.
- Its Notes keep the superseded one-line `<path>[:<line>…] [\`<matcher>\`]`
  grammar and two open questions ("where symbol/kind go — position may derive the
  containing declaration, dropping the name inputs"; "the range-encoding decision
  is the open ask") that the final spec rejects.

## Goal

`#106` reflects reality: doc work marked done, the code AC owned by `#107`, and
Notes that no longer contradict `docs/edit-protocol.md`.

## Acceptance criteria

- [ ] `#106` is `done`/`review`, or its remaining scope is stated as exactly the
      outstanding doc regressions.
- [ ] the "exported selector/selection types" AC moves to `#107` (or is dropped)
      so no two issues own it.
- [ ] `#106` Notes drop the superseded one-line grammar and the two stale open
      questions, or mark them explicitly superseded.
- [ ] `bun .opencode/scripts/issue-tracker.ts check --strict` clean; no other
      issue's scope changes.

## Verification

```
bun .opencode/scripts/issue-tracker.ts show 106
bun .opencode/scripts/issue-tracker.ts check --strict
```

## Notes

- Body edits need the body-edit CLI path (see the CLI issue) or a manual edit.
- Do the vocabulary cleanup first so `#106`'s AC uses the final terms.
