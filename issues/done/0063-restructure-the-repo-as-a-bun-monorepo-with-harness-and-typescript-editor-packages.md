---
id: 63
title: "Restructure the repo as a Bun monorepo with harness and typescript-editor packages"
status: done
priority: high
milestone: null
parent: null
deps: []
labels: [monorepo, refactor, docs]
created: 2026-11-05
---

## Context

The repository is a single flat `src/` project. Pure TypeScript editing code
(parser, symbol index, edit-dsl, cascade, splice/format/gate) and the agent
harness (loop, plan-exec, prompts, provider, CLI, pricing, replay) share one
namespace and one TypeScript project. The editor layer reaches into `loop.ts`
for `EditRange`, `resolveEditRange`, and `resolveCurrentEntry`, so the editing
engine cannot be built, tested, or consumed without the agent harness. There is
also no root README and no roadmap document.

The repo should become a Bun monorepo with two packages: `typescript-editor/`
for the editing engine and `harness/` for the agent. `acceptance/`, `benchmark/`,
`docs/`, `issues/`, and `scripts/` stay top-level harnesses and supporting
folders. This umbrella covers that restructuring.

## Goal

The repository is a Bun workspace with an independently typecheckable and
testable `typescript-editor` package, a `harness` package that depends on it,
root documentation, and no behavior change to `tc`.

## Acceptance criteria

- [ ] The root is a Bun workspace with `typescript-editor/` and `harness/` packages; root package metadata, lockfile, tsconfig, bunfig, and justfile are consistent.
- [ ] `typescript-editor/` owns the editing engine and imports no harness module; `harness/` owns the agent and depends on `@tc/typescript-editor`.
- [ ] `acceptance/`, `benchmark/`, and `scripts/` run against the workspace packages; no runtime code imports the old `src/` tree.
- [ ] A root `README.md` explains the project, layout, and commands; `docs/roadmap.md` records the monorepo direction; existing docs use the new paths and links resolve.
- [ ] `just typecheck`, `just test`, and `just accept` pass offline.
- [ ] Every child issue is done or wontfix.

## Verification

```
just typecheck
just test
just accept
docs check
docs xref
```

No live model run is part of this umbrella. Ask the human before any
`just accept --live` or benchmark run.

## Notes

- The tree already contains uncommitted slice-gate work for #62. Preserve it;
  do not revert, rewrite, or commit it as part of this refactor.
- No behavior, prompt-text, benchmark-fixture, or protocol change is intended.
- Work lands uncommitted for human review; do not create a commit.
- Generated artifacts (`acceptance/report.json`, `failures/`, `tmp/`) stay
  generated and uncommitted.
- All children are done: #64 extracted typescript-editor, #65 moved the harness, #66 rewired root tooling and the top-level harnesses, #67 documented the monorepo and roadmap. Final verification: just typecheck clean across the root harnesses and both packages; just test passes 804 + 702; just accept passes 9 offline scenarios; docs check and docs check --strict are ok; scoped docs xref over README.md, AGENTS.md, docs/, acceptance/README.md, and benchmark/README.md resolves; stale ../src import grep is empty. Repo-wide docs xref still reports 18 references confined to frozen benchmark/specs/* target-project examples and generated benchmark/results/* reports, which cannot be fixed without changing benchmark inputs; editable documentation is clean. The tree is left uncommitted for human review, including the preserved #62 slice-gate work; no live model run was performed.
