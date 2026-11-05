---
id: 66
title: "Rewire root tooling and top-level harnesses onto the workspace packages"
status: done
priority: high
milestone: null
parent: 63
deps: [65]
labels: [monorepo, benchmark, acceptance]
created: 2026-11-05
---

## Context

After the two packages exist, repo-level tooling and the top-level evaluation
harnesses still point at the old `src/` tree: `acceptance/run.ts`,
`acceptance/scenarios.ts`, `benchmark/run.ts`, `benchmark/replay.ts`,
`scripts/openai-smoke.ts`, the root tsconfig, bunfig, package metadata, and the
justfile. The self-host and bin tests also read root metadata that has moved.

## Goal

Root commands and the top-level acceptance, benchmark, and script entrypoints
run against the workspace packages, with the same offline results as before the
refactor.

## Acceptance criteria

- [ ] `acceptance/`, `benchmark/`, and `scripts/` import through `@tc/harness` and `@tc/typescript-editor`; no `../src/` imports remain.
- [ ] Root `justfile` `typecheck`, `test`, `test-parallel`, and `accept` recipes operate on both packages and keep the serial default.
- [ ] Root `package.json` bin/scripts, `bunfig.toml`, and `tsconfig.json` are consistent with the workspace; `bun.lock` is updated.
- [ ] Test discovery does not pick up benchmark or acceptance fixture `*.test.ts` files.
- [ ] The bin and self-host tests read the new package metadata and pass.
- [ ] The full offline gate passes.

## Verification

```
just typecheck
just test
just accept
```

Also confirm no stale runtime imports:

```
grep -rn 'from "\.\./src\|from "\./src' acceptance benchmark scripts harness/src typescript-editor/src
```

## Notes

- Preserve the uncommitted #62 acceptance/docs changes.
- Do not change benchmark fixtures, test assertions, or prompt text.
- Do not run `just accept --live` or any benchmark with `--reps >= 1`; those are
  human-gated and cost money.
- Work stays uncommitted for human review.
- Rewired acceptance/, benchmark/, and scripts/ onto @tc/harness and @tc/typescript-editor, added the harness exports map, updated root package metadata/lockfile, narrowed tsconfig include to the top-level harnesses, switched the root bunfig to workspace-wide discovery with fixture/tmp ignores, and updated the justfile to typecheck and test both packages serially with the same bounded parallel option. Deleted the temporary benchmark-compat bridge; benchmark tests load benchmark/run.ts directly again. Verified: just typecheck clean, just test 804 + 702 pass, just accept 9 passed, bare root bun test 1506 pass across 35 files, stale-import grep empty.
