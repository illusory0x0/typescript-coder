---
id: 58
title: "Final wrap-up turn: fixed structured sections for every termination path"
status: done
priority: medium
milestone: null
parent: 46
deps: []
labels: [harness]
created: 2026-10-18
---

## Context

Absorption candidate 3 from the opencode2 study (2026-10-18 directive). At its
step limit opencode2 does not crash: it appends `MAX_STEPS_PROMPT` and sends a
final request (tools disabled, definitions kept for cache-prefix stability)
demanding a fixed structure — statement that the limit was reached, what was
accomplished, what remains, recommendations
(`packages/core/src/session/runner/max-steps.ts`,
`session/runner/llm.ts:226,240-244`).

Our chain already has the right shape — `explain()` sends exactly one summary
request per termination and stores the text as `explanation`
(`src/loop.ts:1624-1640`), and `terminate()` is the single exit for cap,
exhaustion, token-budget, and stopped paths (`src/loop.ts:1861-1876`). The gap
is the demanded content: `buildSummaryPrompt` asks for "one short paragraph why
… and what the next step … is" (`src/loop.ts:376-389`) instead of a fixed,
artifact-ready structure. The failure record/analysis chain itself
(artifact + one summary call + exit) stays as-is; only the final turn's
content is structured.

## Goal

Every hard termination ends with one wrap-up turn whose reply has fixed
sections (accomplished / failed and why / remaining / next step), so the
failure artifact is self-contained and all stops look identical to the
operator.

## Acceptance criteria

- [ ] `buildSummaryPrompt` demands the fixed sections — what was accomplished,
      what failed and why, what remains, recommended next step — as terse
      bullets, keeping the existing fenced diagnostics block; wording stays
      concise and action-oriented (#55 style), no code output.
- [ ] Tests assert the sections are demanded and that every termination path
      (round cap, exchange exhaustion, token budget, #54 stalled STOP,
      provider error) makes exactly one summary call and stores its text on
      the result (`explanation`) unchanged.
- [ ] The failure artifact carries the wrap-up text verbatim for a failing
      run (asserted in the artifact unit test or a scripted run).
- [ ] `spec.md` (termination-summary wording) and `docs/glossary.md` (if
      vocabulary changes) updated; gates: `bunx tsc --noEmit` 0, `bun test`
      all pass, `bun run accept` 5/5, `bun benchmark/check.ts` 3 PASS.
- [ ] Live evidence: the next matrix's failure artifacts contain the
      structured sections (zero artifacts acceptable on a storm-free matrix,
      with the unit evidence standing).

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
bun benchmark/check.ts
```

plus failure-artifact inspection from the next matrix.

## Notes

- Parent #46. Reference: opencode2 `MAX_STEPS_PROMPT`
  (`packages/core/src/session/runner/max-steps.ts`) and the final
  tools-disabled request (`runner/llm.ts:226,240-244`).
- Interacts with #54 (the stalled STOP becomes one more path through the same
  chain) and #56 (the harness-fault fast-exit likewise).
- Non-goals: changing any caps, adding model calls, redesigning the artifact
  format.

## Notes (implementation, 2026-10-19)

- Landed: `buildSummaryPrompt` (src/loop.ts:420-438) keeps the reason line and
  the fenced Diagnostics block and now demands four labeled lines —
  `- Accomplished:`, `- Failed and why:`, `- Remaining:`, `- Next step:` —
  plus the explicit no-code instruction; the block is byte-identical for every
  reason including `provider-error` (asserted in the unit test).
- Tests: src/loop.test.ts:697-733 (unit: labels, no prose, diagnostics
  retention, identical block across all six reasons); termination paths now
  assert exactly one summary call with `explanation` stored verbatim — #52
  STOP, #54 stalled STOP, #56 harness-fault, token-budget (pick and mid-edit),
  delete-verification-failed, prev-broken, provider error (fallback string,
  one summary attempt) — plus a new outer round-cap test (~1744) that no prior
  test reached; src/failure-artifact.test.ts:112-130 renders a four-section
  explanation verbatim in `## Summary`. 606 tests total.
- Docs: spec.md:26-28, 308-311, 318-319, 404-405, 427-429; docs/glossary.md:99-104.
- Gates (main-agent rerun): tsc 0, 606 tests pass, accept 5/5, check 3 PASS.
- Live evidence (2026-10-19 matrix): the token-budget failure artifact
  `failures/2026-10-18T20-16-09-093Z-token-budget.md` carries the identical
  four-section `## Summary` (`Accomplished:` / `Failed and why:` / `Remaining:`
  / `Next step:`) with an accurate, actionable explanation (the `Func` vs
  `LispValue` mismatches, the stale `run` matcher, the fix plan). One artifact
  for the one failed run; the other eight runs produced none.
