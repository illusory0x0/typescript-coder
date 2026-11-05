---
id: 67
title: "Document the monorepo, package boundaries, and roadmap"
status: done
priority: medium
milestone: null
parent: 63
deps: [66]
labels: [monorepo, docs]
created: 2026-11-05
---

## Context

The repository has no root `README.md` and no roadmap. `AGENTS.md`,
`docs/*.md`, `docs/glossary.yaml`, `acceptance/README.md`, and
`benchmark/README.md` describe code paths as `src/...`, which will be wrong
after the monorepo split. The docs need one map of package ownership and the
repo direction.

## Goal

A newcomer can read the root README, understand the two packages and the
commands, read `docs/roadmap.md` for direction, and follow every documentation
cross-reference to an existing file.

## Acceptance criteria

- [ ] Root `README.md` exists with the project overview, quick start, package layout, command table, and evaluation pointers.
- [ ] `docs/roadmap.md` exists with the current monorepo state, near-term work, and the human-gated evaluation policy.
- [ ] `docs/README.md` maps the roadmap and records which package owns which semantics.
- [ ] `AGENTS.md`, `docs/*.md`, `docs/glossary.yaml`, `acceptance/README.md`, and `benchmark/README.md` use the new package paths; target-project `src/...` examples in protocol docs remain unchanged.
- [ ] No stale repository path references such as `src/loop.ts` remain in human-facing docs.
- [ ] Documentation checks pass, and the code gate remains green.

## Verification

```
docs check
docs xref
just typecheck
just test
```

## Notes

- Preserve the uncommitted #62 doc edits; update their paths without reverting
  their content.
- Documentation is human-facing: keep it concise and factual, and do not invent
  commitments. Roadmap items are direction, not promises.
- No live model run.
- Verified: docs check and docs check --strict both return ok: true with no errors or warnings; docs xref over README.md, AGENTS.md, docs/, acceptance/README.md, and benchmark/README.md resolves all 9 files; just typecheck is clean; just test passes 804 (typescript-editor) + 702 (harness); just accept passes 9 scenarios offline; oxfmt --check is clean on the changed docs; docs/glossary.yaml parses. Repo-wide docs xref alone still reports 18 references, all outside editable documentation: 16 target-project src/... examples in frozen benchmark/specs/* (benchmark inputs, must not change) and 2 src/pricing.ts mentions in generated benchmark/results/*. .docrefsignore hides references, not scanned files, so those cannot be suppressed without changing frozen or generated inputs; the editable docs themselves use the new package paths.
