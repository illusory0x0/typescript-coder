---
id: 50
title: "Allow dotted create to insert class and namespace members"
status: todo
priority: medium
milestone: null
parent: null
deps: [49]
labels: [agent-loop, edit-protocol]
created: 2026-10-26
---

## Context

`create` currently adds a top-level declaration only. A dotted target such as `Parser.parseValue` is rejected as `PLAN_CREATE_MEMBER`, so adding one method to an existing class or one function to an existing namespace requires rewriting the whole owner declaration. In a large file that is exactly the expensive whole-declaration/whole-file path the executor should be able to avoid.

The gray-zone review decided to allow dotted member creation as an explicit capability, while keeping top-level `create` unchanged and keeping the one-declaration-per-reply application guardrail. Member insert is a different operation from top-level append: it must locate the owner body, insert inside the correct class/namespace, and validate the member shape.

## Goal

Make `create` accept a dotted member address and insert exactly one member into an existing class or namespace body, with the same atomic parse/format/verify path and no whole-owner rewrite.

## Acceptance criteria

- [ ] A dotted `create` resolves an existing class or namespace owner plus one member path, and inserts exactly one member into the owner body. A dotted create whose owner is missing or ambiguous is rejected with a diagnostic naming the owner.
- [ ] The operation supports at least a class method and a class property, plus a function/declaration inside an existing namespace. Static/private/protected modifiers on the created member are preserved.
- [ ] A duplicate member name, an invalid member declaration shape, an unsafe path, or a dotted create whose owner is not a class/namespace is rejected without writing anything.
- [ ] A dotted create cannot create the owner itself; creating a new top-level class/namespace still uses ordinary top-level `create`, and `delete`/`rename` keep their existing member support.
- [ ] The inserted member goes through the same parse gate, formatter, write, task/node gate, and atomic apply behavior as other edits; a failed gate leaves no partial file.
- [ ] The existing hard guardrail remains: each reply resolves at most one clause per declaration `(path, symbol, kind)`; multiple edits to one declaration are split across replies.
- [ ] Tests cover class method insert, class property insert, namespace declaration insert, duplicate member rejection, missing/ambiguous owner rejection, and a whole-file/no-write failure case.
- [ ] `docs/edit-protocol.md` and the plan-exec docs describe dotted member create and its limits.
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

- Depends on #49 for the executor-autonomy/hints model, where the executor chooses `create` from the source rather than receiving it from the planner.
- Out of scope: creating a new owner class/namespace via a dotted create, and allowing multiple same-declaration clauses in one reply.
- Member lookup should reuse the existing symbol index’s dotted-member entries rather than inventing a second address vocabulary.
