---
id: 76
title: "Add a dry-run preview to tsed mutations"
status: done
priority: medium
milestone: null
parent: 73
deps: []
labels: [typescript-editor, cli]
created: 2026-11-05
---

## Context

Every mutation is immediate once `--write` is passed, and read-only mode rejects
mutations. There is no way to run the same resolve/format/gate/preflight pipeline
and inspect what would change before committing it.

## Goal

`--dry-run` previews mutations through the full apply pipeline without touching
the workspace, for all three input formats.

## Acceptance criteria

- [ ] Add `--dry-run` to `typescript-editor/scs/tsed.scs`, regenerate the
  committed artifacts, and document it in `--help` and `typescript-editor/README.md`.
- [ ] `--dry-run` and `--write` are mutually exclusive (`usage` exit `2`).
- [ ] Flag mutations are accepted with `--dry-run`; `dsl` and `json` mutations
  are previewed with the same option.
- [ ] `applyEditDsl` supports a dry-run option that runs resolution,
  formatting/gating, and preflight, then returns planned `changed`, `created`,
  and `deleted` paths without calling any write/create/delete filesystem method.
- [ ] The CLI prints `would change:`, `would create:`, and `would delete:` lines
  in dry-run mode; it never prints `changed:`/`created:`/`deleted:` for a
  preview. Files remain byte-identical after the command.
- [ ] Failed edits and failed reads in dry-run return the same failure exit
  codes and diagnostics as apply.
- [ ] Tests cover flag, dsl, and json dry-runs, the `--write` conflict, a failed
  dry-run leaving files unchanged, and `applyEditDsl` dry-run behavior.
- [ ] `just tsed-check`, `just typecheck && just test`, and `just accept` pass.

## Verification

```sh
just tsed-generate && just tsed-check
bun test typescript-editor/src/cli.test.ts typescript-editor/src/api.test.ts
just typecheck && just test
just accept
```

## Notes

- Dry-run is a preview, not a full unified diff renderer. Rich diff/TUI output
  remains out of scope.
- No prompt, loop, or benchmark behavior changes.
- Added EditDslOptions.dryRun; applyEditDsl now builds the final changed/created/deleted plan after resolution, format/gate, preflight, and the pre-write snapshot, then returns before any write/create/delete/rollback call when dryRun is true. Added --dry-run to scs/tsed.scs and regenerated all 8 committed artifacts. CLI rejects --write with --dry-run for every format, allows mutating flag sets with --dry-run, and previews flag/dsl/json through reportResult with would change/create/delete lines while suppressing the plan on failed runs. Tests cover API plan/no-mutation, flag replace, flag create/delete, dsl, json, mutual exclusion, and a failed dsl dry-run. Docs explain the mode and that it is a path preview, not a unified diff. Verified: just tsed-check (8 up to date), targeted tests 44 pass, just typecheck, just test (editor 880, harness 703, scripts 16, acceptance 9/9), just accept (9/9), and a global tsed smoke test from /tmp confirmed dry-run leaves files unchanged and --write --dry-run exits 2.
