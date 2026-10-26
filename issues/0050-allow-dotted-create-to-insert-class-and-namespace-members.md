---
id: 50
title: "Make create targets kind-aware for declarations and members"
status: todo
priority: medium
milestone: null
parent: 51
deps: [49]
labels: [agent-loop, edit-protocol]
created: 2026-10-26
---

## Context

`select` resolves an existing symbol with `value|type|namespace`, because the index already knows the declaration node. `create` is different: there is no existing node, so a space alone cannot say whether the fence will add a function or a const, an interface or a type alias, a class method or a property. The current `create value <symbol>` target is too coarse and dotted create is rejected as `PLAN_CREATE_MEMBER`, so adding one method to a class still requires rewriting the whole owner declaration.

The gray-zone review confirmed a kind-aware create descriptor for named declarations and members. Anonymous signatures (call/construct/index) are deferred to a separate future issue.

## Goal

Make `create` use a precise descriptor (`declarationKind` or `memberKind` + owner/name) and insert exactly one named top-level declaration or class/interface/namespace/enum member with the same atomic parse/format/gate path.

## Acceptance criteria

- [ ] Top-level create accepts an explicit declaration kind: `function`, `class`, `interface`, `type`, `enum`, `namespace`, `const`, `let`, `var`, and `using`. A fence whose declaration kind/name/space does not match the descriptor is rejected without writing.
- [ ] Member create accepts an explicit member kind and an existing owner: `method`, `property`, `getter`, `setter`, `accessor`, `constructor`, and `enum-member`, with a dotted address such as `create method Parser.parseValue in src/parser.ts`. The owner must resolve to exactly one class/interface/namespace/enum.
- [ ] A duplicate member name, a missing/ambiguous owner, a dotted create whose owner is not a class/interface/namespace/enum, an unsafe path, or an invalid fence shape is rejected with a diagnostic naming the owner/kind.
- [ ] Modifiers carried by the fence (`export`, `default`, `declare`, `abstract`, `static`, `readonly`, access modifiers, `override`, `async`, generator) are validated against the descriptor and owner; modifiers that affect member identity (at least `static`) are unambiguous.
- [ ] A dotted create cannot create the owner itself; creating a new top-level class/namespace still uses top-level create. Object-literal member create and anonymous signature create are out of scope.
- [ ] The inserted declaration/member goes through the same parse gate, formatter, write, task/node gate, and atomic apply behavior as other edits; a failed gate leaves no partial file.
- [ ] The existing hard guardrail remains: each reply resolves at most one clause per declaration `(path, symbol, kind)`; multiple creates are separate clauses/replies.
- [ ] Tests cover top-level kind mismatches, class method/property/accessor creates, interface member create, namespace declaration create, enum-member create, duplicate member rejection, missing/ambiguous owner rejection, and no-write failure.
- [ ] `docs/edit-protocol.md` and `docs/plan-exec.md` describe the create descriptor and limits.
- [ ] `just typecheck && just test` and `just accept` pass; no frozen baseline is modified.

## Verification

```sh
bun test src/edit-dsl.test.ts
bun test src/task-loop.test.ts
bun test src/loop.test.ts
just typecheck && just test
just accept
git diff --check
```

No live benchmark is required for acceptance; a measured comparison needs explicit human approval.

## Notes

- Depends on #49 for the executor-autonomy/hints model, where the executor chooses `create` from the source.
- Parent #51: this is the create-target child of the declaration-coverage epic.
- `select` keeps `value|type|namespace`; create gets its own descriptor rather than overloading symbol-space resolution.
- Object-literal member create, anonymous signatures, and module-boundary import/export create are separate (#52/#54 or future work).
- Member lookup should reuse the existing symbol index’s dotted-member entries rather than inventing a second address vocabulary.
