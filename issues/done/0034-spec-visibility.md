---
id: 34
title: "Spec visibility: include test files and issue-mentioned files in context"
status: done
priority: high
milestone: null
parent: 28
deps: []
labels: [harness]
created: 2026-10-17
---

## Context

R5: task issues say "The test file is the specification", but the harness has
no file-reading capability and the context YAML carries signatures only — for
minilisp that is 166 characters (one `evaluate` signature). The model must
guess hidden semantics, which shows up as the reasoning-heavy failures
(87,918/150,816 and 64,439/123,972 tokens). opencode reads the test file and
wins. User-approved scope (2026-10-17): test files + files explicitly mentioned
in the issue text.

## Goal

The context includes the full contents of spec files — test files and
issue-mentioned source files — truncated safely, so the agent stops guessing
semantics it is supposed to implement.

## Acceptance criteria

- [ ] Spec selection rule: every discovered `*.test.ts` file plus every
      existing project file whose path is mentioned in the issue text
      (normalized path tokens); duplicates collapse; non-existent mentions are
      ignored (the file may be the one to create).
- [ ] Content inclusion: a dedicated spec section in the initial user prompt
      lists each spec file path and its source, each truncated with an
      explicit marker when over the limit (limit decided at resolve, default
      ~8,000 chars head+tail per file); binary/large skips degrade gracefully.
- [ ] The signature index still lists spec files (structure remains visible);
      no other prompt regressions; unit tests cover selection, dedupe,
      truncation and prompt assembly.
- [ ] Known trade-off: input grows on every task, including json (est.
      +0.5–1k tokens). The umbrella json guard is therefore 3/3 and ≤6,900
      (pre-S 5,877 + documented allowance); the final report must attribute
      the delta to input, not retries.
- [ ] Gates green (`bunx tsc --noEmit` 0, `bun test`, `bun run accept`).

## Verification

```
bun test
```

plus: print the assembled context for the minilisp fixture and confirm the
test file body and any issue-mentioned files are present with truncation
markers when needed.

## Notes

- Non-goals: arbitrary file reading/tools, on-demand fetch (H4 horizon),
  README/doc inclusion.
- If the measured json overhead exceeds the allowance, the fallback decision
  is to scope spec bodies to tasks whose test file exceeds the signature-only
  information need — decide with the final report data.
- Validation (2026-10-17): `selectSpecFiles(issue, files)` exports the rule
  (every `*.test.ts` basename + issue-mentioned discovered paths, `./`-stripped,
  deduped, deterministic order; non-existent mentions ignored);
  `buildUserPrompt(issue, contextYaml, specFiles = [])` appends `# Spec files`
  with per-file `## <path>` + fenced source (4-backtick fallback), truncating
  > 8,000 chars to 4,000 head + `// ... [truncated N characters] ...` + 4,000
  > tail; the signature index is unchanged and two-arg callers produce the old
  > prompt byte-for-byte. Assembled minilisp prompt (3,446 chars) contains the
  > full `src/lisp.test.ts` body; `src/lisp.ts` (to be created) correctly absent;
  > marker verified on a synthetic oversized source. Measured initial-prompt
  > input deltas: json 419→2,893 (≈+619 tokens), sexp 404→1,963, minilisp
  > 425→3,446 (≈+755) — within the documented json allowance. Tests: +10
  > (selection/dedupe/truncation/assembly + runLoop integration; exact-prompt
  > and replay fixtures updated to include specs). Verified: tsc 0, 481 tests,
  > `accept` 5/5, `benchmark/check.ts` 3 PASS.
