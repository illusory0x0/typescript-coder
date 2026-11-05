---
id: 69
title: "Add a typed read/apply API to typescript-editor"
status: todo
priority: medium
milestone: null
parent: 68
deps: []
labels: [typescript-editor, api]
created: 2026-11-05
---

## Context

The editing engine is split across internal modules. `resolveMultiEditor` needs
callbacks (`sourceFor`, `fileExists`, `isSafePath`, `resolveEntry`), and the
harness supplies them privately. A CLI or a function-calling tool cannot use the
engine without reimplementing that wiring, and the harness currently reaches
into `resolve-entry`, `multi-editor`, `commit`, `editor`, and `selection`
directly.

This issue creates the workspace-backed public API that the CLI and tool adapter
can share.

## Goal

`@tc/typescript-editor` exposes typed read and apply operations over a workspace
root, with no dependency on the harness.

## Acceptance criteria

- [ ] A public entrypoint (`src/index.ts` and/or `src/api.ts`) exports typed `readEditDsl` and `applyEditDsl` operations that accept edit-dsl text plus a workspace root/directory.
- [ ] Read mode resolves `read` commands and viewers, returns the inspection result in structured form, and never writes; mutation clauses are rejected with a stable diagnostic.
- [ ] Apply mode resolves and applies editors and `create`/`delete`/`write`/`rename` file commands, runs the existing format and guard pipeline, validates every clause before writing, and returns changed/created/deleted paths plus typed failures.
- [ ] A reply with any failed mutation writes nothing; a failed read is returned as read feedback and does not discard a clean mutation.
- [ ] Path safety rejects absolute paths, `..`, hidden/system directories, `human/`, and symlink escapes; no file outside the workspace root is read or written.
- [ ] Unit tests cover read-only input, apply input, mixed replies, invalid DSL, failure atomicity, no-op behavior, path traversal, and symlink escape; the package typechecks.
- [ ] `typescript-editor/` has no import from `harness/`.

## Verification

```sh
bun test typescript-editor/src/api.test.ts
cd typescript-editor && bunx tsc --noEmit
```

## Notes

- Reuse the existing resolver, cascade, format, and commit primitives; do not
  fork their semantics.
- The harness's private `safeMutablePath` logic is a reference, not an import.
  Move or reimplement the path guard in the editor package.
- Keep the current internal subpath exports available for the harness while the
  new public entrypoint is introduced.
