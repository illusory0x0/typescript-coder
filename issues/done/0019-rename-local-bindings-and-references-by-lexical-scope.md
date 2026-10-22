---
id: 19
title: "Rename local bindings and references by lexical scope"
status: done
priority: medium
milestone: null
parent: 17
deps: [18]
labels: [agent-loop, edit-protocol]
created: 2026-10-22
---

## Context

The renamer must update references, not just the declaration name. The repo
already parses TypeScript with its own parser and builds lexical `Scope`s in
`src/utility.ts` (`Binder`, `Scope.resolveLocal`, `resolve`). Existing
`renameTool` in `src/tools.ts` deliberately changed only the declaration name,
so it is not sufficient.

## Goal

Renaming a local binding changes its declaration and every reference in the
binding's lexical scope, including nested closures, while leaving shadowed and
out-of-scope names untouched.

## Acceptance criteria

- [ ] A top-level local variable rename updates its declaration and direct
      references in the same file.
- [ ] A parameter rename updates the parameter and references in the function
      body, but not a same-named variable outside the function.
- [ ] A block-scoped rename does not touch an outer binding with the same name,
      and an outer rename does not touch an inner shadow.
- [ ] References inside nested functions/closures resolve to the correct
      binding.
- [ ] A rename that would collide with an existing binding in the same scope is
      rejected with a diagnostic and produces no partial source.
- [ ] Renaming a function, class, interface, or type alias declaration updates
      same-file references that resolve to it.
- [ ] Unit tests cover shadowing, closures, parameters, and collision rejection.

## Verification

```sh
bun test src/rename.test.ts
```

## Notes

- Use the existing parser + `Binder`; do not add a TypeScript compiler
  dependency.
- Scope-aware matching is required; a plain textual replace of the old name
  fails the shadowing criteria.
- Destructuring patterns are nice to have but can be called out explicitly if
  the parser cannot yet supply identifier spans for them.
- Implemented a pure scope-aware local rename model in `src/rename.ts` with collision/capture rejection and tests in `src/rename.test.ts`. Verified `bunx tsc --noEmit` and `bun test src/rename.test.ts` (13 pass, 0 fail). Dotted/member and loop integration remain in #20–#21.
