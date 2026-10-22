---
id: 18
title: "Parse and serialize the rename editor clause"
status: done
priority: medium
milestone: null
parent: 17
deps: []
labels: [edit-protocol]
created: 2026-10-22
---

## Context

`human/edit.md` adds `renamer` to the edit-dsl editor clause. `src/selection.ts`
currently parses `select`, optional `resolve`, optional `match`, optional
`pick` + `replace with`, and `end`; `Selection` has no rename state. The parser
and serializer need the new form before any resolver can use it.

## Goal

`rename <identifier> to <identifier>` is a first-class editor-clause alternative
to `replace`, and round-trips through the parser and serializer.

## Acceptance criteria

- [ ] `select value in src/a.ts rename value to total end` parses with a rename
      field carrying `from: "value"` and `to: "total"`.
- [ ] Serializing that selection reproduces the clause, including a dotted
      selected symbol and an optional `match`.
- [ ] `rename` is rejected when combined with `pick` or `replace`, when `to` is
      missing, or when either identifier token is empty.
- [ ] A rename clause is not a viewer: `toEditPayload` returns `null` for it.
- [ ] Existing viewer, replacer, and create/delete/read/write parsing is
      unchanged.
- [ ] `bun test src/selection.test.ts` passes.

## Verification

```sh
bun test src/selection.test.ts
```

## Notes

- The grammar places `match` before `replacer | renamer`, so `rename` may follow
  a `match`; the resolver decides whether the match narrows anything.
- Keep the parse error messages specific (`expected \`to\``, `rename cannot be
  combined with \`replace\``) so the loop's syntax diagnostic is actionable.
- Implemented parser/serializer and tests for rename clauses. Verified with `bunx tsc --noEmit` and `bun test src/selection.test.ts` (82 pass, 0 fail). Resolver/loop work remains in #19–#21.
