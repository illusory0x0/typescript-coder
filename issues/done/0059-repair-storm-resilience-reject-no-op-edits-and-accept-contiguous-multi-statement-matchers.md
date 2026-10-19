---
id: 59
title: "Repair storm resilience: reject no-op edits and accept contiguous multi-statement matchers"
status: done
priority: high
milestone: null
parent: 46
deps: []
labels: [harness]
created: 2026-10-19
---

## Context

The 2026-10-19 matrix (`benchmark/results/2026-10-19-ts.json`) shows minilisp
rep3 burning to the token budget (123,429 tokens, 58 calls, 20 rounds) and
blocking #49's raw clause and #46's overall win. The recorded bundle
`tmp/replays-opt3-final/minilisp-ts-rep3.json` was analyzed:

- Every repair round's second exchange was a **whole-symbol rewrite that
  changed nothing**: the `replacement` is byte-identical to the current source
  of the pinned declaration (15+ occurrences; verified against the "Current
  source" block of each payload's own prompt). The loop applied them, re-ran
  verification, and the same tsc error at `src/lisp.ts(130,43)` came back — 20
  rounds of no-op applies.
- The model also kept resending a 169-char **three-statement** matcher
  (`const proc: Procedure = ...; env.set(...); return ...;`) whose replacement
  equals the matcher text (a no-op as well): rejected 13 times as
  `matcher-unparseable`, although the fragment parses cleanly into three nodes
  — the anchor contract only accepts a single statement, member, or expression.
- The #54 asks fired (rounds 9 and 17: 8 and 16 consecutive failed rounds) with
  #57 digests attached; the repeat guard fired twice; the model continued.

The harness cannot fix the model's type error, but it must not spend a
verification round-trip applying an edit that changes nothing, and it should
describe the real problem when a parseable multi-statement fragment is rejected.

## Goal

A repair round that cannot make progress fails fast and honestly: no-op edits
are rejected with an accurate diagnostic (never applied, never verified), and a
contiguous multi-statement matcher copied from one block matches
deterministically.

## Acceptance criteria

- [ ] No-op edit rejection: any splice whose result equals the current source
      (byte-level, or after the format gate normalizes it away) is rejected with
      a `stage: no-op` diagnostic and a cause (`no-op`) that feeds the #56
      policy/streak and #57 digest counts; unit tests cover the whole-symbol
      no-op, a no-op through a matcher, a formatting-normalized no-op, and that
      a real edit is unaffected.
- [ ] Multi-statement matcher runs: `parseAnchorFragment`/`findAnchor` accept a
      contiguous run of >=2 statements copied from one block, matching only
      consecutive siblings inside the symbol; exactly one run matches (span
      first.start..last.end), more than one run is ambiguous with the count;
      single-statement/member/expression behavior unchanged. Unit tests cover a
      run match, a run broken by a non-matching sibling, two identical runs ->
      ambiguous, and the single-statement suite.
- [ ] Editor diagnostics/spec coherent: the unparseable diagnostic names the run
      option; `spec.md` matcher bullet + anchor paragraph updated.
- [ ] Replay evidence over `tmp/replays-opt3-final/minilisp-ts-rep3.json`: the
      no-op applies become no-op rejections and the 13 multi-statement
      rejections advance (before/after classification counts in Notes).
- [ ] Live evidence: the next ts-side matrix keeps json 3/3, sexp 3/3,
      minilisp >=2/3, with tokens recorded in `benchmark/results/consumption.md`
      (and shows the storm pattern resolved or materially cheaper).
- [ ] Gates: `bunx tsc --noEmit` 0, `bun test` all pass, `bun run accept` 5/5,
      `bun benchmark/check.ts` 3 PASS.

## Verification

```
bun test
bun run benchmark/replay.ts tmp/replays-opt3-final/minilisp-ts-rep3.json
bun run benchmark/run.ts --all --side ts --reps 3 --json benchmark/results/<date>-ts.json
```

## Notes

- Non-goals: tolerant/ambiguous matching, unified diffs, cap changes, changing
  the bias-to-continue stall policy (#54).
- The model's underlying type error is model-side; this issue only removes the
  wasted round-trips and the misleading "could not be parsed" verdict.
- Related: #49 (raw clause), #50 (taxonomy: multi-statement fragments bucketed
  model-side), #54/#56/#57 (mitigations that fired), #46 (overall win).

## Notes (implementation, 2026-10-19)

- Landed: byte-exact no-op rejection in `spliceEntryEdit` before the gate, and
  a formatter-normalized check at the format gate (`sameAfterFormatting`,
  src/loop.ts:1381-1401, call site ~2995-3005) so an edit whose formatted
  result equals the current source is rejected instead of written; the new
  `no-op` cause flows through `RejectionCause` (src/loop.ts:707-718), the
  classifier, the retry policy/correction and the record rows.
- Multi-statement matchers: `parseAnchorFragment` records a contiguous run
  alternative (src/anchor.ts:66-117); `findAnchor` matches runs only at
  consecutive sibling slots of one container, with unique/duplicate/broken
  cases classified (src/anchor.ts:277-365); unparseable diagnostics name the
  run option. `benchmark/run.ts:764` persists the typed `cause`; the
  `benchmark/README.md` records doc lists `no-op` and `cause`.
- Tests: src/anchor.test.ts:79-101, 230-297; src/loop.test.ts:3874-4100
  (whole-symbol no-op, matcher no-op, formatting-normalized no-op including an
  unformatted source, real edits unaffected). 622 tests.
- Replay evidence (`tmp/replays-opt3-final/minilisp-ts-rep3.json`): 58 -> 41
  records; `applied` 19 -> 2; verifications 19 -> 2; 29 `no-op` rejections
  replacing the wasted applies; the trajectory still ends token-budget because
  the recorded model verdicts are fixed. Clean bundle
  (`tmp/replays-opt3-final/json-parser-ts-rep1.json`) replays unchanged.
- Docs: spec.md:112, 130, 206-216, 285-286, 312.
- Gates (main-agent rerun): tsc 0, 622 tests pass, accept 5/5, check 3 PASS.
- Live evidence (2026-10-19 matrix, `benchmark/results/2026-10-19-ts.json`):
  the no-op waste class is resolved — 18 live `no-op` rejections (3 / 5 / 10
  across the minilisp reps) and no misleading `matcher-unparseable` verdicts in
  the live causes (the 9 remaining matcher rejections are
  `matcher-not-found`). The checks precede the write, so no `applied` row can
  be a no-op; the records show none. json 3/3, sexp 3/3, minilisp 2/3 — no
  success regression. The matrix did not become materially cheaper overall:
  minilisp still carried an 89,716-token recovering run and a 126,822-token
  token-budget failure, now driven by `repeat`/`duplicate`/`no-op` resend
  cycles rather than no-op applies; the residual is tracked by #60.
