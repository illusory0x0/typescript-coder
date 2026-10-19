---
id: 56
title: "Edit-apply rejections: per-cause retry policy; harness-bug classes exit with diagnostics + summary"
status: done
priority: medium
milestone: null
parent: 46
deps: []
labels: [harness]
created: 2026-10-18
---

## Context

User directive (2026-10-18): distinguish the causes of "LLM output produced
but edit apply failed"; use different retry strategies per cause; when the
failure is clearly a harness/editor bug, print diagnostics + LLM evaluation
and exit immediately instead of retrying.

Live evidence: the minilisp storm of `2026-10-18-ts-context` burned the full
120k token budget in one run within 42 model calls — 18 `matcher` rejections,
20 applied edits whose verification kept failing (`tsc`), 1 `repeat` — because
every rejection got the identical treatment: rebuild the corrective prompt, up
to 3 exchanges per round, up to 32 rounds. Rejection texts across all recorded
matrices (`2026-10-18-ts*`, see `tmp/analysis-50-evidence.json`):

- `matcher` not found inside the pinned symbol (17; mostly anchors that wrap
  the pinned declaration's own header, which lies outside the symbol range),
- `matcher` unparseable as a single statement/member/expression (19; sliced
  or partial fragments — structural matching needs a complete unit),
- `format` oxfmt failure `'export' modifier already seen` (7; the splice
  pipeline duplicating a keyword — harness-side),
- plus the #48 guards (`repeat` 2, `duplicate` 1, `address` 1, `gate` 2,
  `protocol` 4).

## Goal

Every edit-apply rejection is classified by cause with an explicit retry
policy per class instead of the uniform grind: model-fault classes retry with
a class-specific correction (escalating after repeats), harness-fault classes
terminate immediately through the existing failure chain (diagnostics artifact

- one summary call + exit).

## Acceptance criteria

- [ ] A rejection-cause classifier covers every stage the loop can produce
      (`protocol`, `matcher` not-found, `matcher` unparseable, `format`,
      `address`, `gate`, `repeat`, `duplicate`, truncation/output-limit,
      provider/transport) and the cause travels in the loop's typed result
      (not string-sniffing at the call site).
- [ ] Per-cause policy table implemented and tested:
      model-fault retryable (protocol, stale matcher, unparseable anchor,
      address mismatch, truncation): retry, with a class-specific correction
      in the prompt; after N same-class rejections within a chain the strategy
      escalates (e.g. instruct a whole-symbol rewrite with no `matcher`; hand
      the decision to the #54 stall question) instead of repeating the ask;
      harness-fault (format-gate `export` duplication, internal editor
      inconsistency): no retry — terminate through the failure chain with a
      distinct termination reason and the full diagnostics;
      guards (repeat/duplicate) stay as in #48.
- [ ] Tests: classifier routing per class + one scripted run per policy
      branch (retry / escalate / fast-exit).
- [ ] Live evidence: replay the recorded storm bundle
      (`tmp/replays-49-context/minilisp-ts-rep2.json`) through the updated
      loop and show the policy fires (harness-fault exits without retry;
      model-fault escalation triggers); the next ts-side matrix shows no
      success regression (json 3/3, sexp 3/3, minilisp ≥2/3).
- [ ] Gates: `bunx tsc --noEmit`, `bun test`, `bun run accept`,
      `bun benchmark/check.ts` all green.

## Verification

```
bun test
bun run benchmark/run.ts --all --side ts --reps 3 --json benchmark/results/<date>-ts.json
```

plus bundle replay for the policy evidence.

## Notes

- Parent #46. Coordinate with #50 (matcher/format taxonomy + editor fixes: if
  #50 repairs the `export` splice, that class leaves the fast-exit set) and
  #54 (the stall question consumes the same cause data).
- Reference design (opencode2 study 2026-10-18): step outcomes are typed
  (`packages/core/src/session/runner/step.ts` Outcome) and retryability is
  decided per typed reason (`runner/retry.ts`), with truncation handled as a
  `continue` prompt rather than a failure (`runner/llm.ts:35-39,290-319`).
- Non-goals: unified-diff fallback (#50 forbids it); changing the guards.

## Notes (implementation, 2026-10-19)

- Landed: typed `RejectionCause` + `classifyRejection` (src/loop.ts:686-736),
  `rejectionPolicy` per-cause correction/escalation table (src/loop.ts:744+),
  `spliceEntryEdit` failure causes (src/loop.ts:1253-1276), run-scope streak +
  correction state (src/loop.ts:2049-2073) reset after an applied edit
  (src/loop.ts:2752), `buildRetryPrompt` correction lead (src/loop.ts:282-314),
  new termination reason `harness-fault` (src/loop.ts:396-403, 863) with the
  fast exit before any retry (src/loop.ts:2725-2731); rejection rows carry the
  typed cause.
- Tests src/loop.test.ts:640, 3344-3609: classifier routing, policy table,
  scripted retry / escalation / reset runs, ambiguous + unparseable sub-causes,
  and a deterministic duplicate-modifier repro (`"export\nfunction ..."`) that
  exits `harness-fault` with exactly one summary call and an untouched file.
- Replay evidence: the two storm bundles re-run by the main agent end
  `token-budget` (121,729 / 122,934 tokens) with mechanics stable; rebuilt-prompt
  capture over 18 recorded bundles (subagent) shows matcher retries carrying
  the class correction and consecutive matcher rejections escalating to the
  whole-symbol fallback (context rep2 calls 19/37); repeat/duplicate keep the
  #48 lead. Bundles predate #49/#54/#56, so model behavior is not measurable
  there.
- Gates (main-agent rerun): tsc 0, 593 tests pass, accept 5/5, check 3 PASS.
- For #50: the fast exit is defense-in-depth; #50's wider `stripLeadingExport`
  tolerance removed the original repro path, so the scripted repro was reworked
  onto the comment-glued trigger (`export/* keep */function`,
  src/loop.test.ts:4221-4260); the `export\n` variant now applies via the
  whitespace tolerance.
- Live evidence (2026-10-19 matrix, `benchmark/results/2026-10-19-ts.json`):
  no success regression (json 3/3, sexp 3/3, minilisp 2/3). Live rejection
  causes show the policy classes at work — `no-op` (18 across the minilisp
  reps), `repeat`/`duplicate` guard rejections, `matcher-not-found` (9); no
  harness-fault fast exits were needed live. The rejection-cycle cost is owned
  by #60. Bundles: `tmp/replays-59-final/`.
