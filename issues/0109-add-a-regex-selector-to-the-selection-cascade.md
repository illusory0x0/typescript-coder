---
id: 109
title: "Add a regex matcher to the selection cascade"
status: todo
priority: medium
milestone: null
parent: 105
deps: [106]
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

The `match` stage is a locator that accepts either a `snippet` or a `regex`, but
today only the snippet form (a structurally matched AST snippet) exists. A regex
matches text inside the target span; it must define anchoring, uniqueness, and
ambiguity behavior consistent with the existing matcher-ambiguity guard
(`docs/spec.md:145-147`).

## Goal

A `regex` matcher resolves a pattern to a unique span inside the target, with
typed diagnostics; ambiguity behaves like the matcher-ambiguity guard.

## Acceptance criteria

- [ ] A `regex` matcher (syntax defined in `#106`) matches inside the target;
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

- Depends on the specification (`#106`) for the matcher syntax and types.
