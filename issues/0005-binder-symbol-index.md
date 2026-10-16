---
id: 5
title: Binder and symbol index
status: in-progress
priority: medium
milestone: M3
parent: 1
deps: [4]
labels: [frontend]
created: 2026-10-16
---

## Context

Milestone **M3** of [spec.md](../spec.md) §11, implementing the binder/symbol-index
part of `utility.ts` (spec §5). The spec's design premise (§3) requires modeling
TypeScript symbol resolution explicitly: lexical scope, the few overloading
rules, runtime symbols vs type symbols (declaration spaces), namespaces, and
types. The index maps a `Locator(path, name, kind)` (spec §4) to its AST node.

## Goal

A binder that resolves symbols across declaration spaces and a symbol index that
maps `Locator` → node, enabling definition lookup.

## Acceptance criteria

- [ ] Lexical scope resolution works (locals shadow outer, block/function scope).
- [ ] Overload sets are grouped under a single symbol.
- [ ] Runtime symbols vs type symbols are kept distinct (declaration spaces).
- [ ] Namespaces contribute to the `name` dotted path (e.g. `lexer.make`).
- [ ] The index maps `Locator` → node with `path` (repo-relative file) and dotted
      `name`, disambiguated by `kind`.
- [ ] Symbol-lookup and find-definition tests pass on the fixture corpus.

## Verification

```
bun test src/utility.test.ts
```

## Notes

- Depends on #4 (parser).
- Blocks #6 (editor) and #8 (tools: find-definition/rename).
- `kind` vocabulary (v1): function, method, class, interface, type, variable,
  namespace, enum, plus more as the binder is implemented.
