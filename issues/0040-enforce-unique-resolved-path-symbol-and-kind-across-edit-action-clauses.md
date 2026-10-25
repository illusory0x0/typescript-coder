---
id: 40
title: "Enforce unique resolved path, symbol, and kind across edit-action clauses"
status: todo
priority: medium
milestone: null
parent: 37
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-25
---

## Context

Multi-clause edit-action replies are retained, but the current resolver only
rejects same-declaration edits when their resolved regions overlap. A reply
with two clauses targeting the same declaration at different non-overlapping
spans can currently pass resolution. The benchmark also produced a two-clause
reply on one `src/lisp.ts` declaration that was rejected only as an overlap.

The required invariant is: in one reply, every `select` clause resolves to a
distinct `(path, symbol, kind)` target.

## Goal

Reject duplicate resolved clause addresses before any matcher or write can
apply, with a deterministic diagnostic naming the conflicting clauses.

## Acceptance criteria

- [ ] The key is the resolved target address, not the raw locator text; an
      omitted `kind` uses the resolved declaration kind.
- [ ] The uniqueness set includes every `select` clause: viewers, `replace`,
      `rename`, and implicit creates. For creates, the key uses the declaration
      actually added by the fence body.
- [ ] A duplicate target rejects the whole reply with `stage: duplicate` and a
      message naming both clause numbers and the resolved address.
- [ ] The rejection writes nothing, including when only one duplicate clause
      would otherwise apply.
- [ ] Different declarations in the same file are allowed.
- [ ] The same symbol in different files is allowed; `path` remains part of the
      key.
- [ ] Different non-overlapping `match`/`pick` spans on the same declaration
      are rejected; the retry must split them across exchanges.
- [ ] `rename` + `replace` on the same declaration is rejected.
- [ ] `viewer` + `edit` on the same declaration is rejected.
- [ ] Existing path conflict and region-overlap checks remain for
      `write`/`create`/`delete` and write ranges.
- [ ] Tests cover omitted kind vs explicit kind, viewer+editor, rename+replace,
      duplicate creates, different declarations, and multi-file same-name
      declarations.

## Verification

- `bun test src/edit-dsl.test.ts src/multi-editor.test.ts`
- `bun test src/loop.test.ts src/task-loop.test.ts`
- `just typecheck && just test`

## Notes

- This removes the current viewer-then-editor same-declaration example from the
  prompt; the prompt child issue updates it.
- The uniqueness key intentionally ignores `resolve space`, `match`, and
  `pick`; a class selected as value or type is still one declaration.
- Resolving a rename target may require a small helper/shared resolution step
  so rename and editor clauses use the same key.
