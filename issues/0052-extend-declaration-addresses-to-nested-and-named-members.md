---
id: 52
title: "Extend declaration addresses to nested and named members"
status: todo
priority: medium
milestone: null
parent: 51
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-26
---

## Context

`indexEntriesForFile` walks binder scopes. The binder creates scopes for functions, classes, and namespaces, but not for interface/type members, enum members, or object-literal members. It also keeps only the first declaration for overloaded/merged symbols, and multiple declarators/destructuring bindings can share one `VariableStatement` node. `select` currently resolves `(path, symbol, value|type|namespace)`, which cannot address those forms or tell which overload/declarator is meant.

The #51 contract is declaration-level completeness: every named declaration/member gets a stable address; anonymous or ambiguous forms require an explicit disambiguator rather than a silent first match.

## Goal

Give every named nested declaration and member a stable address, and make overloaded, merged, multi-declarator, and destructured targets explicit instead of silently picking the first node.

## Acceptance criteria

- [ ] Interface and type-literal named members are addressable with a dotted path (for example `select Cell.getValue in src/types.ts`); `modify` and `delete` work, and `rename` works where the existing rename semantics allow.
- [ ] Enum members are addressable for `modify`, `delete`, and `rename` without falling back to whole-enum replacement.
- [ ] Object-literal named members are addressable when the owner is a declared variable (for example `select config.timeout in src/config.ts`); `modify`/`delete` work. Creating new object members stays in #50.
- [ ] Named default-export declarations are addressable; anonymous default exports use owner + matcher/pick from #53.
- [ ] Overloaded or declaration-merged symbols never resolve silently to the first declaration: the address either includes a structural/range/occurrence disambiguator or is rejected with the candidate declarations named.
- [ ] A multi-declarator or destructuring edit changes only the addressed binding; if that cannot be represented safely, it is rejected with a diagnostic that suggests a range or a smaller target instead of rewriting siblings.
- [ ] Computed member names and static blocks are documented as owner + matcher/pick targets, not name-addressable.
- [ ] Tests cover each form and the ambiguity/rejection paths; `docs/edit-protocol.md` and `docs/plan-exec.md` record the address rules.
- [ ] `just typecheck && just test` and `just accept` pass; no frozen baseline is modified.

## Verification

```sh
bun test src/utility.test.ts
bun test src/edit-dsl.test.ts
bun test src/rename.test.ts
bun test src/loop.test.ts
just typecheck && just test
just accept
git diff --check
```

## Notes

- Import/export statements are #54; kind-aware create is #50; structural matcher contexts are #53.
- This issue does not add new strategy constraints: multiple candidates are an application-safety error, not a style preference.
- Keep the existing rename limitations documented rather than silently expanding them.
