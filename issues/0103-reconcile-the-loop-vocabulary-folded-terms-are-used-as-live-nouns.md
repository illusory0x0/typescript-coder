---
id: 103
title: "Reconcile the loop vocabulary: folded terms are used as live nouns"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [docs]
created: 2026-10-20
---

## Context

`docs/glossary.md:3-5` folds the old loop names — turn / selection / correction /
attempt — into Run / Edit / Verification and defines them as "not separate terms"
(`docs/glossary.md:26-31`). But `docs/spec.md` and `docs/design.md` still use them
as live nouns, and the glossary's own definition of Selection ("the first
round(s) of the Edit loop", `docs/glossary.md:27`) disagrees with spec's use of
"selection" as *the target* (mode + address):

- `docs/spec.md:74` "A selection carries one of three modes";
- `docs/spec.md:82` "the selection is the whole model exchange";
- `docs/spec.md:288` "that cause's concrete correction"; `:366-368` "prior attempts";
- `docs/design.md:218` "feeds the next correction";
- and `docs/glossary.md:19` itself writes "no separate selection budget".

So the "these are not separate terms" rule is not actually followed, and one word
("selection") carries two meanings across the docs.

## Goal

One settled vocabulary: each of turn / selection / correction / attempt has
exactly one meaning across spec, design, and glossary — or is marked
historical-only — decided explicitly and then applied.

## Acceptance criteria

- [ ] For each of turn / selection / correction / attempt: decide
      retained-as-live-noun (with a single definition) or historical-only; record
      the decision.
- [ ] `docs/glossary.md` defines every retained term once (including "selection"
      if retained, stated as the target) and marks the rest historical.
- [ ] `docs/spec.md` and `docs/design.md` use the settled words consistently;
      no glossary/spec disagreement on "selection".
- [ ] Docs-only: no code, prompt, or protocol change.

## Verification

```
bun .opencode/scripts/docrefs.ts check
grep -rnE "\b(selection|turn|correction|attempt)\b" docs/
```

Review the remaining uses against the recorded decision.

## Notes

- Filed 2026-10-20 from the editor-protocol documentation-drift audit; sibling of
  the range-adoption work (#100–#102).
- Non-goals: renaming the protocol or changing prompts — this is vocabulary
  reconciliation in the docs.
