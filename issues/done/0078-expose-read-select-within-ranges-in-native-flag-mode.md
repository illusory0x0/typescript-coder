---
id: 78
title: "Expose read/select within ranges in native flag mode"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli]
created: 2026-11-05
---

## Context

Large `read` and viewer results are folded by indentation. The fold marker tells
the caller to expand with a protocol command such as:

```text
... // content folded, src/a.ts: 4-7L; expand with read src/a.ts within 4-7 end
```

The edit protocol and JSON operation model support `within`, but the native flag
surface does not expose it. `tsed --read src/a.ts --within 4-7` is rejected as an
unexpected argument, so a flag-mode user has to switch to `--protocol-format dsl`
just to see the hidden lines. The same gap applies to a folded `--select`
viewer.

## Goal

Native flag mode can expand folded read and viewer ranges without falling back to
a stdin protocol.

## Acceptance criteria

- [ ] Add `--within <RANGES>` to `typescript-editor/scs/tsed.scs` and regenerate
  the committed artifacts with `just tsed-generate`.
- [ ] `tsed --read PATH --within RANGES` passes the range through the existing
  `read` operation and prints the selected lines unfolded.
- [ ] `tsed --select SYMBOL --in PATH --within RANGES` does the same for a
  viewer slice.
- [ ] `--within` combined with a mutation (`--replace-file`, `--rename`,
  `--create`, `--delete`, or `--rewrite`) is rejected with a usage error or the
  protocol's documented `within`-is-viewer-only diagnostic; it must never be
  silently ignored.
- [ ] Help and `typescript-editor/README.md` show the new native-flag form.
- [ ] Tests cover read and select expansion plus the mutation rejection.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
tsed --read typescript-editor/src/api.ts --within 15-22
tsed --select applyEditDsl --in typescript-editor/src/api.ts --within 266-280
tsed --select applyEditDsl --in typescript-editor/src/api.ts \
  --within 266-280 --replace-file patch.txt   # usage/protocol error
just tsed-check
bun test typescript-editor/src/cli.test.ts
just typecheck && just test
```

## Notes

- The engine already supports `within` for `read` and viewer `select`; this is a
  CLI/scs surface change, not a new selector implementation.
- `within` is viewer-only; a mutation uses `pick` for a narrowed rewrite.
- Keep the fold hint pointing at the same command so the message stays
  actionable from either format.
- Added native --within <RANGES> to the scs surface and regenerated all committed artifacts. CLI attaches the range to repeated reads and to a select viewer; mutation flags are rejected as viewer-only; stdin protocols reject --within as a native flag. Extended the JSON/native select operation model with within (validate/render/parse), and documented the flag and JSON field in typescript-editor/README.md. Tests cover read expansion, select expansion, all mutation rejections, missing read/select, select+match parser rejection, and stdin-format rejection. Verification: just tsed-check up to date; targeted cli+protocol 60 pass; just typecheck && just test green (editor 891, harness 703, scripts 16, acceptance 9); manual read/select expansion and mutation rejection checked.
