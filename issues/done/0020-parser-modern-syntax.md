---
id: 20
title: "Parser: #private fields, using declarations, import attributes, const type parameters"
status: done
priority: high
milestone: null
parent: null
deps: []
labels: [parser]
created: 2026-10-17
---

## Context

Audit (2026-10-17 consult session): `buildIndex` throws on several modern TS
constructs, so any project using them kills the whole run (the resilience side
is #21). Probe evidence, running `buildIndex` (src/utility.ts) over one-file
samples:

- `class A { #x = 1; }` → `unexpected token "#"`
- `function f<const T>(x: T) { return x; }` → `unexpected token "const"`
- `using x = resource();` → `expected ;`
- `import data from "./d.json" with { type: "json" };` → `expected ;`

spec.md §9 promises "modern app TS — ES2024 syntax, full TS type grammar":
ES2022 private fields, ES2024 `using`, import attributes (TS 5.3) and `const`
type parameters (TS 5.0) are within that promise. The lexer already emits a `#`
token (`src/lexer.ts:203`); the gaps are on the parser/AST/binder side.

## Goal

`Parser`/`Binder`/`buildIndex` accept the four constructs above, with regression
tests, without regressing any currently supported syntax.

## Acceptance criteria

- [ ] Parse + bind succeed for: instance/static private fields (`#x = 1`),
      private methods (`#m() {}`), private access (`this.#x`), `using` /
      `await using` declarations in blocks, `import ... with { type: "json" }`
      (and `with` attributes on `export ... from`), `const` type parameters on
      functions (classes/methods if cheap).
- [ ] Binder binds `using` names as value symbols in the enclosing block;
      `#`-members do not crash and are either indexed with their `#` name or
      explicitly excluded (document the choice).
- [ ] AST types updated (e.g. private-name member variant, using declaration,
      import attributes field, type-parameter const modifier) and
      `bunx tsc --noEmit` is clean.
- [ ] New parser tests cover each construct; all existing `bun test` tests stay
      green.
- [ ] The audit probe (the four samples above) is captured as a regression test.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
```

## Notes

- Priority `high` (Eisenhower Q1: urgent + important — currently a fatal crash
  for real projects).
- Do not regress the modern syntax the same probe confirmed as working:
  `satisfies`, legacy decorators, `accessor` fields, template literal types,
  mapped/conditional types, overloads, abstract classes, `declare module`,
  dotted namespaces, getters/setters, static blocks, `export =`, generic
  arrows.
- Related: #21 (loop-side tolerance; independent).
- Non-goals: full semantic checking; `.tsx`/JSX stays excluded; deprecated
  `assert`-style attributes are not required.
