---
id: 38
title: "Structured diagnostics: stages, line mapping, failure extraction"
status: done
priority: high
milestone: null
parent: 28
deps: []
labels: [harness]
created: 2026-10-17
---

## Context

R6: verification feedback is raw. `formatDiagnostics` (src/loop.ts:385) prints
tsc lines with absolute file positions and dumps bun-test output; a model that
emitted a replacement cannot tell which of its own lines are broken, failing
test names are buried in the dump, and nothing distinguishes a syntax error
from a test failure. User-approved merge (2026-10-17): D1 line mapping + T2
stage taxonomy, targeted test file, failing-test-name extraction.

## Goal

Verification failures come back as staged, bounded, mapped diagnostics the
model can act on directly.

## Acceptance criteria

- [ ] Stage taxonomy: every verification failure is labeled with a stable
      stage (syntax/format | tsc | tests) consistent with the #29 outcome
      taxonomy, in both prompts and records.
- [ ] Line mapping: tsc diagnostics whose positions fall inside the applied
      range are rendered against the emitted text ("replacement line N: TSxxxx
      ...", with a short code frame from the replacement); diagnostics outside
      the range are reported in a separate "elsewhere in file" bucket.
- [ ] Test extraction: failing test names (bounded count) are listed from bun
      test output instead of relying on the raw tail dump.
- [ ] Targeted test file: when the edited file has a sibling `*.test.ts` in the
      project, that file runs first for fast feedback; the full suite still
      gates the verdict when the targeted file passes, and a targeted failure
      short-circuits as a tests-stage failure (same semantic as the full
      suite failing).
- [ ] Unit tests for mapping, buckets, extraction and targeted selection;
      evidence from a replay (#40) or a spot run showing a mapped diagnostic;
      gates green.

## Verification

```
bun test
bun benchmark/replay.ts <bundle-with-tsc-failure>
```

## Notes

- Synergy with #31: mapping is most useful when ranges are small; keep the
  mapping range-agnostic (it works for whole-symbol replacements too).
- Non-goals: running arbitrary user-specified commands, caching tsc output,
  changing the verification verdict semantics (tsc 0 + full suite green).
- Validation (2026-10-17): `formatDiagnostics({check, test, targetPath,
  baseSource, newSource})` emits staged sections (`stage: tsc`,
  `stage: tests`; the early catch prefixes `stage: format` while the attempts
  outcome keeps the finer #29 taxonomy). `editedRange` line-diffs base vs new
  source (whole file when created, empty when unchanged) and in-range tsc
  diagnostics render as `replacement line N: TSxxxx: msg` with a 3-line code
  frame from the written file (capped at 10, `... N more`); remaining
  diagnostics go to an `elsewhere in file:` bucket.
  `parseDiagnostics` now keeps the code (`CheckDiagnostic.code?`).
  `failingTestNames` extracts `(fail) name [time]` / `✗ name` (deduped,
  capped at 10) and lists them before a bounded raw tail. Targeted tests: a
  sibling `src/<name>.test.ts` runs first via `[...testCommand, sibling]`; a
  targeted failure is the test verdict (short-circuit), a pass still requires
  the full suite (one extra test spawn on success paths).
- Evidence (spot run + replay): recorded bundle
  `tmp/replays-38/sexp-tsc-failure.json` (first replacement carries a type
  error); `bun run benchmark/replay.ts` on it prints `attempt 1: outcome=tsc
  diagnostics=stage: tsc replacement line 2: TS2322: Type 'string' is not
  assignable to type 'number'. 1 | ... 2 | ... 3 |` and `attempt 2:
  outcome=ok`, `calls: 3/3`, `prompt mismatches: none`, exit 0.
- Validation gates: tsc 0, 504 tests, `accept` 5/5, `benchmark/check.ts`
  3 PASS.
