---
id: 23
title: "Align variable kinds between the symbol index and the edit-dsl grammar"
status: todo
priority: high
milestone: null
parent: 22
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-22
---

## Context

The edit-dsl target resolver and the selection grammar disagree about variable
declaration kinds:

- `src/utility.ts` `declarationKind()` returns `"variable"` for
  `VariableDeclarator`, `VariableStatement`, and `PropertyDeclaration` nodes.
- `src/selection.ts` `SELECTION_KINDS` accepts `const`, `let`, and `var`, but
  not `variable`.
- `SymbolIndex.lookup()` compares the locator kind exactly.

As a result, `select const builtins in src/lisp.ts` resolves zero entries even
though the index contains `builtins` as a variable. The address diagnostic says
`the name exists as "variable"; change "kind" to match`, but
`select variable builtins` is a syntax error. The model-facing example in
`src/prompts/edit-dsl.ts` teaches `select const MAX_TOKENS`, reinforcing the
kind that cannot resolve.

This is the direct target-resolution failure behind the `minilisp` token-budget
storms documented in the umbrella issue.

## Goal

Align the variable declaration kind vocabulary across the symbol index,
selection grammar, and model-facing diagnostics so a variable target can be
edited with the kind the model is taught.

## Acceptance criteria

- [ ] A top-level `const`, `let`, or `var` declaration can be resolved and
      edited with that exact kind.
- [ ] A bare `select <name>` still works as the empty-kind wildcard.
- [ ] A kind mismatch on a variable names only grammar-valid alternatives
      (`const`/`let`/`var` as appropriate, or bare `select`), never
      `variable`.
- [ ] The `select const MAX_TOKENS` prompt example has a matching index entry
      and resolver behavior.
- [ ] Unit coverage checks index lookup for `const`, `let`, and `var`.
- [ ] Loop coverage edits a top-level `const` through edit-dsl.
- [ ] `just typecheck && just test` pass.

## Verification

```sh
just typecheck
just test
```

A focused test can first reproduce the current mismatch:

```ts
const index = buildIndex([{ path: "src/lisp.ts", source: "const builtins = 1;" }]);
index.lookup({ path: "src/lisp.ts", name: "builtins", kind: "const" });
```

## Notes

Do not change function/block scope indexing in this issue. The failing
`builtins` target was indexed as a top-level `variable`. Class fields are also
currently labelled `variable`; preserve their behavior or add a grammar-valid
kind rather than making them unaddressable. Keep the fix at the address/kind
layer; it must not depend on the rename engine.
