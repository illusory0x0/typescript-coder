---
id: 20
title: "Resolve dotted and member rename targets"
status: todo
priority: medium
milestone: null
parent: 17
deps: [18, 19]
labels: [agent-loop, edit-protocol]
created: 2026-10-22
---

## Context

`human/edit.md` requires path resolution for dotted symbols such as
`std.array.length`, and semantic renaming for fields, namespaces, and enums.
The symbol index already represents dotted locators (`A.B`, `Color.Red`,
`C.field`), but only the declaration name span is currently addressable.

## Goal

Renaming a dotted or member target updates the intended declaration segment and
qualified references, without renaming unrelated names that merely share a
suffix.

## Acceptance criteria

- [ ] Renaming the last segment of a namespace (`A.B` → `A.C`) updates the
      declaration and qualified `A.B` references, and leaves `X.A.B` or `A.B.Z`
      alone unless they resolve to the same target.
- [ ] Renaming an enum member (`Color.Red` → `Color.Crimson`) updates the member
      declaration and `Color.Red` references; an unrelated `Other.Red` stays
      unchanged.
- [ ] Renaming a class field updates the field declaration and `this.field`
      references in that class; a same-named field on another class is
      untouched.
- [ ] A dotted target that does not resolve, or resolves to more than one
      declaration, is rejected with a diagnostic and writes nothing.
- [ ] A new name that collides at the same qualified path is rejected.
- [ ] Unit tests cover namespace, enum, field, suffix-collision, and ambiguity
      cases.

## Verification

```sh
bun test src/rename.test.ts
```

## Notes

- Be conservative for receiver-typed field accesses: `this.field` and
  same-class unqualified references are in scope; arbitrary `obj.field` calls
  may remain unchanged until a later type-aware issue.
- `src/tools.ts` already has helpers for the last namespace segment
  (`namespaceNameSpan`, `declarationNameSpan`); reuse or factor them rather than
  duplicating dotted-span logic.
- Project-wide reference discovery can start with same-file references; if a
  change spans files, the resolver must read every affected file before atomic
  apply.
