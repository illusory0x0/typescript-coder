---
id: 41
title: "Create-mode repair: keep partial files and iterate with anchors"
status: wontfix
priority: high
milestone: null
parent: 28
deps: [30, 31]
labels: [harness]
created: 2026-10-17
---

## Context

R1/R3 on create tasks: when a new file (e.g. minilisp `src/lisp.ts`) fails
verification, the append-mode attempt is discarded and every retry re-emits
the whole file from scratch — the most expensive failure mode in the 2026-10-17
matrix. User-approved (2026-10-17, "A-1"): keep the partial file when it is
parseable and let subsequent retries repair it with anchored edits.

## Goal

Failed create attempts switch to anchored repair on the kept file when it
parses, and only fall back to full re-emission when no parseable state exists.

## Acceptance criteria

- [ ] After a failed append-mode attempt whose resulting file parses
      (`formatSource`/`buildIndexTolerant` succeeds), the file stays on disk
      and the next attempt uses the anchor-edit protocol (#31/#33) against
      the current file content instead of the append contract.
- [ ] Repair-mode prompts show the current file (fresh-reset, #30) and the
      failed verification diagnostics; an anchor equal to the whole file
      declaration set is a valid full rewrite.
- [ ] Guard: if the kept file is absent or unparseable, the harness removes
      the partial state and falls back to full re-emission (append mode), as
      before.
- [ ] Unit tests for both paths (parseable partial → repair prompt/edits
      path; unparseable → removal + append), loop integration test with a
      mock provider; evidence in the series smoke/final run.
- [ ] Gates green (`bunx tsc --noEmit` 0, `bun test`, `bun run accept`).

## Verification

```
bun test
```

plus: mocked create-mode sequence — attempt 1 fails verification with a
parseable file, attempt 2 emits anchored edits and is verified against the
kept content.

## Notes

- Depends on #30 (keep-progress/fresh-reset) and #31 (anchor edits).
- Failure semantics change is intended: failed create runs no longer leave a
  pristine workspace; the benchmark report wording is updated in #30/#28.
- Non-goals: multi-file orchestration (H4 horizon), partial-section
  generation for very large files (parked).
- Superseded (2026-10-18) by the v2 redesign (#42/#43): the create guard and
  the create→repair transition move into the v2 protocol/loop, keeping the
  kept-parseable-file behavior. Kept for the record; do not implement
  separately.
