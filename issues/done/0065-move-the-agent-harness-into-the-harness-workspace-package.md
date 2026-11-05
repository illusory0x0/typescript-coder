---
id: 65
title: "Move the agent harness into the harness workspace package"
status: done
priority: high
milestone: null
parent: 63
deps: [64]
labels: [monorepo, harness]
created: 2026-11-05
---

## Context

After the editor package is extracted, the agent harness still lives in the old
flat `src/` and imports moved editor modules with relative paths. The harness
owns the loop, plan-exec driver and DSL, prompts, provider, tools, CLI, result,
pricing, provenance, replay, failure artifacts, and the self-host fixture.

## Goal

`harness/` is a Bun workspace package that owns the agent, depends on
`@tc/typescript-editor`, and typechecks and tests independently.

## Acceptance criteria

- [ ] `harness/package.json` declares the package, its `tc` bin, and a workspace dependency on `@tc/typescript-editor`; `harness/tsconfig.json` exists and scopes the package.
- [ ] `loop`, `task-loop`, `tasks`, `plan-dsl`, `prompts/`, `tools`, `openai`, `result`, `pricing`, `provenance`, `failure-artifact`, `replay-format`, `replay-runner`, `cli`, `main`, and the `greet` self-host fixture and tests live under `harness/src/`.
- [ ] Harness code imports the editor through `@tc/typescript-editor/*`, not through relative escapes into `typescript-editor/` and not through the old `src/`.
- [ ] The self-host smoke remains scoped to exactly one copied target test and still passes against the moved fixture.
- [ ] Tests that depend on both packages (for example replay-runner and tools) live with the harness and pass.
- [ ] The harness package typechecks and tests pass.

## Verification

```
cd harness && bunx tsc --noEmit
cd harness && bun test
cd harness && bun test src/cli.test.ts -t "self-host smoke"
grep -rn 'from "\.\./typescript-editor\|from "\.\./src' harness/src
```

The final grep must print nothing (the self-host smoke may copy source text and
is excluded by the import-shaped pattern).

## Notes

- Preserve the uncommitted #62 changes, including `prompts/task.ts` and the
  acceptance/docs edits; move the modified files without reverting them.
- Do not change prompt text, protocol semantics, benchmark fixtures, or CLI
  behavior. This is a move plus import rewiring.
- No live model run.
- Moved all remaining agent code to harness/src (loop, task-loop, tasks, plan-dsl, prompts, tools, openai, result, pricing, provenance, failure-artifact, replay, cli, main, greet fixture and tests), added harness package metadata, and rewired editor imports to @tc/typescript-editor/*. Repo-root path calculations in cli/judge-golden/benchmark-run/reference-roundtrip tests and the tsc binary paths gained the extra parent; the self-host smoke copies harness/src and still runs exactly src/index.test.ts. Added a temporary harness/src/benchmark-compat.ts bridge because benchmark/ still imports the removed ../src; #66 deletes it. Verified: harness tsc clean, 702 pass / 0 fail, self-host smoke 1 pass, boundary grep clean; editor still 804 pass. Root tsc is red only in acceptance/ and benchmark/ (next issue).
