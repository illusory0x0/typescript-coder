---
id: 53
title: "Extend structural matcher contexts and add a declaration corpus"
status: todo
priority: medium
milestone: null
parent: 51
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-26
---

## Context

`parseMatcherFragment` tries a top-level statement, a class-body member, an expression, and a contiguous run of statements. That misses several owner contexts: a `return`/`break`/`continue`/`yield` inside a function body, interface/type members, object-literal members, type positions, and decorators/static blocks. When structural matching cannot parse the fragment, regex or `pick` can still edit it, but the structural path is incomplete and the failure is sometimes diagnosed as a shape error rather than “this context is unsupported”.

The #51 contract treats structural matching as best-effort and regex/`pick` as first-class fallbacks; completeness means at least one selector path per declaration form.

## Goal

Match structural fragments in every owner context needed by the declaration coverage matrix, and prove reachability with a committed TypeScript syntax corpus.

## Acceptance criteria

- [ ] `parseMatcherFragment` (or its successor) can parse and structurally match fragments in at least these contexts: top-level statement, class member, interface/type member, object-literal member, function-body statement, and type expression. Decorator/static-block contexts are covered if the parser supports them.
- [ ] A structural match resolves exactly one span; multiple matches produce a matcher-ambiguous diagnostic with candidate locations, never a silent first match.
- [ ] A fragment that is valid only in an unsupported context fails with an actionable diagnostic naming the context, not a generic “does not form a statement” error.
- [ ] Regex and `pick` remain documented fallbacks and keep their current behavior; a structural success is not required when either one is used.
- [ ] A committed syntax corpus covers the declaration/member/module forms from #51: for each form, an edit through structural matching, regex, or `pick` reaches an inner span and passes the parse/format/gate path.
- [ ] Tests cover each matcher context, ambiguity, and the corpus failure output; docs record the context matrix.
- [ ] `just typecheck && just test` and `just accept` pass; no frozen baseline is modified.

## Verification

```sh
bun test src/matcher.test.ts
bun test src/edit-dsl.test.ts
bun test src/task-loop.test.ts
just typecheck && just test
just accept
git diff --check
```

## Notes

- The corpus is the proof of declaration-level completeness; do not add syntax forms to the matrix without a test.
- Do not turn structural matching into a hard requirement: regex and `pick` are first-class.
- JSX/`.tsx` is out of scope unless separately requested.
