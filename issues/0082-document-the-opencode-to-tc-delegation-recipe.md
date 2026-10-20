---
id: 82
title: "Document the opencode to tc delegation recipe"
status: todo
priority: medium
milestone: null
parent: 79
deps: [80]
labels: [docs, integration]
created: 2026-10-20
---

## Context

`opencode` must know how to split work, build the targets file, invoke `tc` with
a budget and verify commands, parse the result, and retry on failure.

## Goal

A documented recipe (`docs/subagent.md` plus an `AGENTS.md` pointer) that lets
`opencode` delegate scoped coding tasks to `tc` deterministically.

## Acceptance criteria

- [ ] `docs/subagent.md` documents the invocation, the stdin task, the
      `--targets` shape, the `typescript-coder-result@1` schema, exit codes,
      verification ownership, and the per-call budget.
- [ ] `AGENTS.md` points to it and states when to delegate to `tc` versus edit
      directly.
- [ ] the recipe includes the failure/retry path (refine the task text,
      re-invoke) and the same-file sequencing rule.

## Verification

A read-through against the C1/C2 implementation, then a reviewer follows the
recipe during C4.

## Notes

- Depends on C1. Non-goals: `opencode` plugin, a `/tc` command.
