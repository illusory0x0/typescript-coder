---
id: 77
title: "Handle non-regular paths in tsed create/delete and dry-run"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli]
created: 2026-11-05
---

## Context

`tsed` preflight treats only regular files as existing. `Workspace.fileExists()`
returns `false` for a directory, so `--create` on an existing directory passes
preflight and `--dry-run` reports a successful preview. The real apply then
fails at the filesystem operation, and `--delete` reports the directory as a
missing file.

Observed from a clean temp workspace:

```sh
mkdir dircreate
tsed -C . --create dircreate --dry-run
# would change: dircreate
# would create: dircreate   (exit 0)
tsed -C . --create dircreate --write
# stage: protocol ... cannot create "dircreate": the path already exists (exit 1)
tsed -C . --delete dircreate
# stage: address ... cannot delete "dircreate": the file does not exist (exit 1)
```

The same false-positive preview occurs through `dsl` and `json` payloads.

## Goal

Dry-run and real apply agree for non-regular paths, and create/delete/rewrite
diagnostics name a directory instead of claiming it does not exist.

## Acceptance criteria

- [ ] `--create` on an existing directory (or other non-regular path) fails in
  dry-run and apply with the same failure stage and exit code; dry-run prints no
  `would change:`/`would create:` plan for it.
- [ ] `--delete` on a directory reports that the target is not a regular file,
  not that the file does not exist.
- [ ] `--rewrite` on a directory fails with a clear regular-file diagnostic
  before any write.
- [ ] `applyEditDsl(..., { dryRun: true })` reports the same conflict as apply
  for create/rewrite/delete of a directory.
- [ ] Tests cover flag, dsl, and json paths plus the API dry-run.
- [ ] `just typecheck && just test` passes.

## Verification

```sh
tmp=$(mktemp -d)
mkdir "$tmp/dircreate"
tsed -C "$tmp" --create dircreate --dry-run   # must fail, no plan
tsed -C "$tmp" --create dircreate --write     # must fail, same diagnostic
tsed -C "$tmp" --delete dircreate             # must say not a regular file
bun test typescript-editor/src/cli.test.ts typescript-editor/src/api.test.ts
just typecheck && just test
```

## Notes

- Root cause: `Workspace.fileExists()` is regular-file-only while create
  preflight uses it as a general existence check; `createEmptyFile()` and
  `deleteFile()` already distinguish `statSync().isFile()`.
- Add a non-following or directory-aware existence check to the workspace
  interface rather than special-casing the CLI.
- This is a correctness issue in the preview pipeline, not a missing feature.
- Resolved: added lstat-based Workspace.pathExists and threaded it through MultiEditorDeps; create/delete now distinguish absent, regular file, and non-regular paths, and write/--rewrite rejects non-regular targets before sourceFor. Added flag, dsl, json, and API dry-run parity tests. Verification: targeted editor tests 103 pass; just typecheck clean; just test green (editor 883, harness 703, scripts 16, acceptance 9); manual CLI create/delete/rewrite on directories all exit 1 at stage address in both --dry-run and --write.
