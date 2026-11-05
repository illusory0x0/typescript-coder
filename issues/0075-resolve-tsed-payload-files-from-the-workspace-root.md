---
id: 75
title: "Resolve tsed payload files from the workspace root"
status: todo
priority: medium
milestone: null
parent: 73
deps: []
labels: [typescript-editor, cli]
created: 2026-11-05
---

## Context

`-C/--directory` selects the workspace, but `--replace-file` and
`--content-file` are passed directly to `readFileSync`, so relative paths resolve
from the process cwd. The current test even asserts that behavior. This is
surprising: a workspace command should resolve workspace input files against the
workspace root.

## Goal

Relative payload files resolve against the `-C/--directory` workspace root;
absolute paths keep working.

## Acceptance criteria

- [ ] `buildPayload`/`renderFlagRequest` receive the selected workspace root and
  resolve relative `--replace-file` and `--content-file` paths against it.
- [ ] Absolute payload paths still work unchanged.
- [ ] Missing or unreadable payload files remain exit-code `2` usage errors with
  the resolved path in the message.
- [ ] Tests spawn the CLI from a different cwd, pass `-C <workspace>`, and prove
  both `--replace-file` and `--content-file` are read from the workspace, not
  the spawn cwd; the old spawn-cwd assertion is replaced.
- [ ] README documents the resolution rule; no change to `--in`/edit-target path
  semantics.
- [ ] `just typecheck && just test` passes.

## Verification

```sh
bun test typescript-editor/src/cli.test.ts
just typecheck && just test
```

## Notes

- Payload files are read-only inputs, not mutation targets. Absolute paths and
  files outside the workspace remain allowed; workspace path-safety applies only
  to edit targets.
- `--directory` itself is still resolved from the process cwd when relative.
