---
id: 99
title: "Hygiene: gitignore the failures/ artifact directory"
status: todo
priority: low
milestone: null
parent: null
deps: []
labels: [hygiene]
created: 2026-10-20
---

## Context

`src/failure-artifact.ts` writes failure artifacts to `<rootDir>/failures/` (the
repo root; `src/failure-artifact.ts:86-95`). `.gitignore` has no `failures/` rule.
#51 rotates the directory into `./tmp/` at the start of a benchmark matrix, but an
ad-hoc live run that produces an artifact leaves untracked files in `git status`.

## Goal

The `failures/` artifact directory is gitignored, so arbitrary runs cannot pollute
`git status`.

## Acceptance criteria

- [ ] `.gitignore` contains a `failures/` rule.
- [ ] After creating `failures/scratch.json`, `git status --porcelain` shows
      nothing for it.
- [ ] `bunx tsc --noEmit` and `bun test` stay green.

## Verification

```
printf '{}' > failures/scratch.json
git status --porcelain   # no failures/ entry
rm -rf failures
bun test
```

## Notes

- Root issue; independent of the umbrella DAG.
- Complements #51 (archive `failures/` per matrix); non-goals: changing the
  artifact-writing code or its path.
