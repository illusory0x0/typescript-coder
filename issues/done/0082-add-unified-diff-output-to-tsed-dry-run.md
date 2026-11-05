---
id: 82
title: "Add unified diff output to tsed dry-run"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli]
created: 2026-11-06
---

## Context

`tsed --dry-run` runs the full resolve/format/gate/preflight pipeline but only
prints `would change:`/`would create:`/`would delete:` path lists. An agent that
wants to inspect the actual edit must run `git diff` afterwards or re-read the
file, which adds a completely separate step and can race with other writes.

The API already knows the planned source for every write in `writePlan` and the
pre-reply snapshot in `originals`, so the preview can produce the diff itself.

## Goal

A dry run can show the exact per-file unified diff without touching the
workspace.

## Acceptance criteria

- [ ] `EditDslOptions` accepts an opt-in `diff?: boolean`, and a dry-run result
  carries a sorted `diffs: { path: string; diff: string }[]`; without the option
  the array is empty.
- [ ] `tsed --dry-run --diff` prints the existing planned-path lines and then a
  standard unified diff for every changed, created, or deleted path (`---` /
  `+++` / `@@` hunks; `/dev/null` for a missing side).
- [ ] The diff is generated internally from the planned source and the
  pre-reply snapshot; it does not shell out to `git`, `diff`, or a new package.
- [ ] Modify, create, delete, multi-file, multi-hunk, and a file without a
  trailing newline are covered by tests; the workspace remains byte-identical.
- [ ] `--diff` without `--dry-run` is a usage error. Apply output and existing
  path-list output stay unchanged.
- [ ] `typescript-editor/README.md` and `docs/edit-protocol.md` document the
  preview option and show the output shape.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
tmp=$(mktemp -d)
printf 'export function answer(): number { return 1; }\n' > "$tmp/a.ts"
printf 'select answer in a.ts\nreplace with\nTC_EDIT_BEGIN\nexport function answer(): number { return 2; }\nTC_EDIT_END\n' \
  | tsed -C "$tmp" --protocol-format dsl --dry-run --diff
git -C "$tmp" status --short   # empty/untracked-free expectation: no file changes
bun test typescript-editor/src/api.test.ts typescript-editor/src/cli.test.ts
just tsed-check && just typecheck && just test
```

## Notes

Keep `would change:` lines for scripts. The flag is preview-only so it cannot
silently turn an apply into a read-only run. Prefer a small line-diff helper over
a dependency; the repository already avoids new runtime dependencies for this
kind of utility.
