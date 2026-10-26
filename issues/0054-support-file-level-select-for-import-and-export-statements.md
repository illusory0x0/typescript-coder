---
id: 54
title: "Support file-level select for import and export statements"
status: todo
priority: medium
milestone: null
parent: 51
deps: [50]
labels: [agent-loop, edit-protocol]
created: 2026-10-26
---

## Context

The symbol index deliberately excludes import bindings, and export specifiers, default-export expressions, and `export =`/`export default <expr>` have no editable declaration address. As a result, changing or removing an import/export statement requires a whole-file `write`, which is exactly the expensive path the executor should avoid. The agreed model is a file-level owner, not synthetic declaration names and not a separate action zoo.

## Goal

Let a file-level `select` locate and edit existing import/export statements and specifiers through matcher/regex/pick, and let a kind-aware create add a new module-boundary statement.

## Acceptance criteria

- [ ] `select file <path> [match (<snippet> | /regex/)] [pick <selecters>] replace with <fence> end` (or an equivalent documented file-level select syntax) edits an existing import/export statement or specifier. The match must resolve exactly one span; multiple matches are rejected with candidates.
- [ ] A file-level select can delete an import/export statement or a single specifier without touching the rest of the file; an empty fence deletes the selected span.
- [ ] Adding a new import/export statement is supported through a documented kind-aware create descriptor (for example `create import ...` / `create export ...`) built on #50’s create grammar; no synthetic declaration names.
- [ ] File-level select and create stay inside the file and path-safety rules; the parse gate, formatter, atomic apply, and task/node gate are unchanged.
- [ ] Renaming imported bindings or export aliases is either supported with the existing reference semantics or explicitly rejected with a diagnostic; the limitation is documented rather than silent.
- [ ] Tests cover edit, delete, single-specifier deletion, add, ambiguous match, unsafe path, and no-write failure; docs record the grammar and limits.
- [ ] `just typecheck && just test` and `just accept` pass; no frozen baseline is modified.

## Verification

```sh
bun test src/edit-dsl.test.ts
bun test src/loop.test.ts
bun test src/task-loop.test.ts
just typecheck && just test
just accept
git diff --check
```

## Notes

- Depends on #50 for the kind-aware create descriptor.
- No dedicated `import-add`/`export-remove` action family: the locator is the file, the selector is matcher/regex/pick.
- Structural matching inside module statements uses #53’s contexts where possible; regex/pick remain valid fallbacks.
