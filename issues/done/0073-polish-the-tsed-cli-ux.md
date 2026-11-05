---
id: 73
title: "Polish the tsed CLI UX"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli, tooling]
created: 2026-11-05
---

## Context

`tsed` is usable as a repo-relative command, but three safe UX gaps remain:

1. The package declares a `tsed` bin, yet the workspace install does not put it
   on `PATH`; callers must type the full `bun run typescript-editor/src/cli.ts`
   path.
2. `--replace-file` and `--content-file` resolve from the process cwd instead
   of the `-C/--directory` workspace root.
3. Mutations have no preview: `--write` applies immediately, and read-only mode
   rejects the mutation.

Larger limitations (natural-language input, cross-file rename, a TUI, and
post-edit typecheck/test) are explicitly out of scope for this pass.

## Goal

`tsed` installs globally, resolves payload files consistently with its workspace
root, and can preview mutations without writing.

## Acceptance criteria

- [ ] `just tsed-install` installs/links `tsed` globally from this checkout; the
  command is documented and `tsed --version` works from an unrelated directory.
- [ ] Relative `--replace-file` and `--content-file` paths resolve against the
  `-C/--directory` workspace root; absolute paths still work.
- [ ] `--dry-run` previews flag, dsl, and json mutations without writing files,
  prints the would-be changed/created/deleted paths, and exits with the same
  failure/success shape as an apply.
- [ ] README, docs, and the CLI help describe the new behavior.
- [ ] `just typecheck && just test`, `just accept`, and `just tsed-check` pass.
- [ ] Every child issue is done or `wontfix`.

## Verification

```sh
just tsed-install
cd /tmp && tsed --version
just typecheck && just test
just accept
just tsed-check
```

## Notes

- Global installation is a local Bun global link/add of the private workspace
  package. Do not publish to a registry.
- Payload files are read-only inputs, not workspace edit targets; absolute
  paths remain allowed.
- `--dry-run` reports would-be paths; a unified diff renderer and interactive
  TUI remain out of scope.
- Do not change edit-dsl prompt text or benchmark behavior.
- All three children are done. #74 added just tsed-install (remove the previous global entry, then bun add -g the absolute local package), documented it, and verified tsed --version/--help from /tmp; repeated installs leave one global dependency. #75 resolves relative --replace-file/--content-file paths against the resolved -C/--directory root, keeps absolute paths, reports the resolved path on read failure, and is covered by tests that spawn from a different cwd with conflicting root-level payload files. #76 added EditDslOptions.dryRun, --dry-run in the scs surface, regenerated artifacts, and preview output; dry-run runs the full pipeline and returns before any write/create/delete/rollback, while --write and --dry-run are mutually exclusive. Verified: just typecheck, just test (editor 880, harness 703, scripts 16, acceptance 9/9), just accept (9/9), just tsed-check (8 targets up to date), just tsed-install twice, and a global tsed dry-run smoke test from /tmp. Out of scope and unchanged: natural-language input, cross-file rename, TUI, post-edit typecheck/test, unified diff rendering, prompts, and benchmarks.
