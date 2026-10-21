---
id: 3
title: "Resolve the compact address by TS symbol space and apply creation defaults"
status: done
priority: medium
milestone: null
parent: 1
deps: [2]
labels: [agent-loop]
created: 2026-10-21
---

## Context

`human/edit.md` resolves a header with `resolve <kind>` (`:11-12`) and defines
three creation defaults (`:3-5`): create the file when the path is absent,
append a new symbol at the last position when the symbol is absent, and default
to a `let` binding when `resolve` is missing.

The shipped index already records `Symbol.space` (`value | type | namespace`,
`src/utility.ts:21`) and collapses a class/enum's dual value+type binding into
one entry, but `Locator.kind` is a declaration kind and `SymbolIndex.lookup`
filters it exactly (`src/utility.ts:~483`). `resolveCurrentEntry`
(`src/loop.ts:3177`) delegates to that lookup, and the compact implicit create
(`src/compact.ts:174-205`) only appends a complete declaration. So
`resolve value` cannot select the function in the human example, and an absent
symbol with no `resolve` cannot become a `let` binding.

## Goal

The compact address stage filters entries by the clause's TS symbol space and
creates an absent path/symbol with the `human/edit.md` defaults, including the
default-`let` binding.

## Acceptance criteria

- [ ] `select answer in src/helper.ts resolve value end` resolves
      `export function answer(): number` as exactly one declaration.
- [ ] A class resolves under both `resolve value` and `resolve type`; an enum
      likewise; an interface or type alias only under `type`; a namespace only
      under `namespace`; a function/const/let only under `value`.
- [ ] A `resolve` space with no matching declaration is an address failure that
      names the spaces the name is declared in and never falls back to another
      space. A name that exists only in another space sets `undeclared: false`,
      so implicit create is not triggered.
- [ ] Without `resolve`, a name with two declarations in different spaces still
      fails with the existing ambiguity diagnostic; `resolve` narrows the
      candidate set but never guesses.
- [ ] With the path and symbol absent, the harness creates the file and its
      parent directories and appends the declaration at the top-level end.
- [ ] With no `resolve` and a non-declaration fence body (`42`), the appended
      declaration is `let <name> = 42;`.
- [ ] With `resolve value`, a non-declaration body also becomes a `let`
      binding; `resolve type` wraps it as `type <name> = <body>;`;
      `resolve namespace` wraps it as a `namespace <name> { <body> }`.
- [ ] A fence body that is already a complete top-level declaration is appended
      verbatim for every space, preserving the shipped create path.
- [ ] Empty fences and viewer clauses still create nothing.
- [ ] Existing compact implicit-create, address, and ambiguity tests remain
      green (updated only for the new 6-tick fence form).

## Verification

```
bun test src/compact.test.ts src/cascade.test.ts
bun test src/loop.test.ts -t "address"
bunx tsc --noEmit
```

Add direct cases to `src/compact.test.ts` for each space, the class/enum dual
space, the space miss, and the four create forms.

## Notes

- Depends on the grammar issue: the `space` field and the `resolve` spelling
  come from there.
- Thread the space from `Selection` into `CompactDeps.resolveEntry` (or an
  equivalent address parameter) without changing the JSON `Locator`; the JSON
  path passes `null`.
- A space predicate is needed rather than reading `entry.symbol.space`
  directly: the index keeps one entry for a class/enum, and such a declaration
  belongs to both `value` and `type`.
- Interpretation recorded here: a body that is already a complete top-level
  declaration is appended verbatim; otherwise the harness wraps it by space,
  defaulting to `let` when `resolve` is absent. This satisfies both "append a
  new symbol" and "default create let binding" without breaking the shipped
  complete-declaration create replies.
- Non-goal: changing the JSON create mode or the symbol-index context format.
- Implementation complete; focused verification passed: utility+selection 98 pass, compact+cascade 68 pass, loop address 7 pass, just typecheck, just accept 5 pass. Full just test was interrupted twice by environment/server restarts before completion, so the full-suite criterion is unconfirmed and the issue stays in review.
- Full verification completed with `bun test --max-concurrency=1`: 1085 pass, 0 fail (226.9s). The earlier cancellations were environment concurrency/memory-related, not test failures.
