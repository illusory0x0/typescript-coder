---
id: 109
title: "Add a regex selector to the selection cascade"
status: todo
priority: medium
milestone: null
parent: 105
deps: [106]
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

The cascade's selector union includes `regex`, but today only `matcher` (a
structurally matched AST snippet) and `range` (coordinates) exist. A regex
matches text inside the target span; it must define anchoring, uniqueness, and
ambiguity behavior consistent with the existing matcher-ambiguity guard
(`docs/spec.md:145-147`).

## Goal

A `regex` selector resolves a pattern to a unique span inside the target, with
typed diagnostics; ambiguity behaves like the matcher-ambiguity guard.

## Acceptance criteria

- [ ] A `regex` selector (syntax defined in `#106`) matches inside the target;
      exactly one match is required, else a typed ambiguous/not-found cause.
- [ ] Zero-width matches, flags, and escaping are defined; the benchmark
      fixtures show no catastrophic backtracking.
- [ ] Unit tests cover: a hit, a miss, an ambiguous pattern, and a malformed
      pattern.
- [ ] Guards, caps, and the ambiguity policy are unchanged.

## Verification

```
bunx tsc --noEmit
bun test
```

## Notes

- Depends on the specification (`#106`) for the selector syntax and types.
