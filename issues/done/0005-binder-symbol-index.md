---
id: 5
title: Binder and symbol index
status: done
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

- [x] Lexical scope resolution works (locals shadow outer, block/function scope).
- [x] Overload sets are grouped under a single symbol.
- [x] Runtime symbols vs type symbols are kept distinct (declaration spaces).
- [x] Namespaces contribute to the `name` dotted path (e.g. `lexer.make`).
- [x] The index maps `Locator` → node with `path` (repo-relative file) and dotted
      `name`, disambiguated by `kind`.
- [x] Symbol-lookup and find-definition tests pass on the fixture corpus.

## Verification

```
bun test src/utility.test.ts
```

## Notes

- Depends on #4 (parser).
- Blocks #6 (editor) and #8 (tools: find-definition/rename).
- **Contract for #6/#8** (`src/utility.ts`, 30 tests green):
  - `Locator { path, name, kind }`, `IndexEntry { locator, symbol, node }`,
    `SourceFile { path, source }`.
  - `buildIndex(files: SourceFile[]): SymbolIndex` — parses + binds each file and
    indexes global/namespace/class symbols only (locals in function/block scopes
    are deliberately skipped). Deterministic order (path, then start offset).
  - `SymbolIndex { entries, lookup(locator), byName(name) }`, and
    `findDefinition(index, locator): IndexEntry | null` (first exact match).
  - `Binder { rootScope, scopes, scopeOf(node) }`, `resolve(scope, name, space?)`.
  - Dotted names: namespaces join with `.` (`A.B.f`), class members prefixed
    (`C.m`, `N.K.m`). Namespaces merge across declarations (one symbol, shared
    body scope). Overloads merge into one symbol with all declarations.
  - Declaration spaces: `value` | `type` | `namespace`; enums bind both value and
    type; `import type` binds type; interfaces/type aliases bind type.
  - `kind` vocabulary: function, method, class, interface, type, variable,
    namespace, enum.
- **Index → range** for the editor: `IndexEntry.node.start/end` are code-unit
  offsets into the file named by `locator.path`; a class/interface Locator spans
  the whole declaration (including body), which the editor will replace.
- **Implementation history:** delegated in 3 bounded chunks (B1 scopes, B2 index,
  B3 corpus integration); parser corpus test made dynamic along the way.
- Verified 2026-10-16: `bun test src/utility.test.ts` 30 pass / 0 fail;
  `bunx tsc --noEmit` exit 0; `bun test` 298 pass / 0 fail; integration test
  builds an index over the real repo sources and resolves `tokenize`,
  `Lexer.next`, `reservedKeywords`, `Parser.parseProgram`.
