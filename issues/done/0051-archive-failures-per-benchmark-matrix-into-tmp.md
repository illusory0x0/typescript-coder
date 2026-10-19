---
id: 51
title: "Archive failures/ per benchmark matrix into ./tmp/"
status: done
priority: medium
milestone: null
parent: 46
deps: []
labels: [harness]
created: 2026-10-18
---

## Context

Failure artifacts (`failures/<timestamp>-<reason>.md`, #43) accumulate at the repo
root across benchmark matrices: 16+ files today, covering the #48 sweep and live
rounds, and the directory is not gitignored. The user decision (2026-10-18
consult): rotate the previous round's `failures/` into `./tmp/` before each
benchmark matrix, so `failures/` always holds only the latest round; CLI single
runs keep writing as today.

## Goal

Every benchmark invocation with runs to execute rotates a non-empty repo-root
`failures/` into `./tmp/failures-archive/<UTC timestamp>/` before running, logs
the move, and leaves `failures/` for the new round's artifacts only.

## Acceptance criteria

- [ ] A reusable archive helper (src/failure-artifact.ts unless a better home exists) moves every file from `<rootDir>/failures/` into `<rootDir>/tmp/failures-archive/<timestamp>/`; it is a no-op when `failures/` is absent or empty and returns the archive path and moved count.
- [ ] benchmark/run.ts calls the helper after argument validation and before executing any run, and logs the rotation (path + count).
- [ ] CLI single runs keep the current behavior (write artifacts, no archiving).
- [ ] Unit tests cover: moves all artifacts (source emptied, files intact at destination), no-op when the directory is missing/empty, destination directory created, returns count/path.
- [ ] Gates: `bunx tsc --noEmit` 0 errors; `bun test` all pass; `bun run accept` 5/5; `bun benchmark/check.ts` 3 PASS.
- [ ] Smoke: with a seeded marker file in `failures/`, one cheap benchmark invocation (`--task sexp-parser --side ts --reps 1`) archives the marker into `tmp/failures-archive/<stamp>/` and `failures/` afterwards contains only that run's artifacts (or is empty).

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
bun benchmark/check.ts
# smoke
touch failures/zz-smoke-marker.md && bun run benchmark/run.ts --task sexp-parser --side ts --reps 1
ls tmp/failures-archive/ failures/
```

## Notes

- Parent #46. Retention only — the record/analysis chain (failure artifact +
  one summary call at termination + exit) was confirmed to stay as-is.
- Implementation ordered after #48 round-3 releases src/loop.ts (no file overlap;
  ordering keeps the gates clean).
- Implemented 2026-10-18: archive helper `archiveFailureArtifacts`
  (src/failure-artifact.ts) rotates a non-empty `failures/` into
  `tmp/failures-archive/<stamp>/` (same stamp convention as artifacts; an
  existing same-stamp directory is suffixed, never merged); `benchmark/run.ts`
  calls it after the infra preflight and before the worker pool and prints
  `archived N failure artifact(s) to <path>`; CLI runs are untouched. Unit tests
  cover moves / no-op-missing / no-op-empty / count+path / suffix collision.
  Gates green (tsc 0 / 575 tests / accept 5/5 / check 3 PASS).
- Smoke (re-run by the main agent after review, 2026-10-18): seeded
  `failures/zz-smoke-marker.md`, ran
  `bun run benchmark/run.ts --task sexp-parser --side ts --reps 1 --json tmp/archive-smoke.json`
  → log line `archived 1 failure artifact(s) to tmp/failures-archive/2026-10-18T12-55-41-287Z`,
  the marker intact in the new archive directory, `failures/` empty afterwards
  (the run passed, 2,953 tokens / 6.4 s). The first rotation archived the
  accumulated 22 files (the #48-era artifacts plus the first smoke marker) into
  `tmp/failures-archive/2026-10-18T11-24-54-666Z/`.
