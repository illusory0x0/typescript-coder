---
id: 57
title: "Repair-chain attempt digest: bounded updated checkpoint for continued rounds"
status: done
priority: medium
milestone: null
parent: 46
deps: []
labels: [harness]
created: 2026-10-18
---

## Context

Absorption candidate from the opencode2 study (2026-10-18 directive). In
opencode2, context pressure is handled by compaction: before a step the
session may generate a structured checkpoint summary and keep only a small
recent tail verbatim (`packages/core/src/session/compaction.ts:41-47,153-160`);
repeated provider overflow shrinks the target (SHRINK_STEPS 0.7/0.5/0.35,
compaction.ts:94-95); a later compaction *updates* the existing checkpoint
instead of re-summarizing (`runner/llm.ts:220-225,263-271`).

Our repair chains fail the opposite way: attempts are dropped entirely
(messages are rebuilt as system + issue + pinned + one prompt), so a storming
model re-derives already-rejected edits — the context matrix storm produced 18
matcher rejections + 20 applied-but-failed edits, largely repeating classes,
and burned the 120k budget with zero progress.

## Goal

Long repair chains carry a bounded, updated digest of prior attempts (what was
tried, the failure class, the error) so the model does not repeat ruled-out
edits; the digest is built once per chain and updated per continuation, never
re-echoing raw replacements.

## Acceptance criteria

- [ ] Continuation prompts (and the #54 stall prompt once it has landed)
      include a `Prior attempts` digest: per attempt, the failure class + the
      first line of diagnostics (no replacement text), plus a one-line
      "ruled out" note when one class has repeated N times.
- [ ] The digest is bounded (≤ ~1,200 chars), built from `records`, and
      updated per continuation rather than regenerated from scratch.
- [ ] Tests: digest content, bounds, and update semantics; raw replacement
      text never appears in the digest.
- [ ] Live evidence: the next tc-side matrix replay bundles are inspected to
      confirm the digest appears in continued rounds and that repeat-class
      attempts drop in storm-like runs; no success regression.
- [ ] Gates: `bunx tsc --noEmit`, `bun test`, `bun run accept`,
      `bun benchmark/check.ts` all green.

## Verification

```
bun test
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-ts.json
```

plus replay-bundle inspection for digest presence and repeat-class counts.

## Notes

- Parent #46. Reference: opencode2 `SessionCompaction` (structured checkpoint,
  keep-recent verbatim, update-in-place).
- Interacts with #49 (lean prompts), #54 (stall ask), #56 (per-cause retry
  policy — the digest consumes the same cause labels).
- Non-goals: replaying raw previous replacements (spec: re-asks do not re-echo
  replacements); unbounded history.

## Notes (implementation, 2026-10-19)

- Landed: bounded `Prior attempts` digest (src/loop.ts:983-1140: state + cursor
  updates, per-class counts, ruled-out lines, 1200-char hard bound with the
  ruled-out block reserved and oldest entries evicted first);
  `digestDetail` selection (error-TS line > label/code-frame-excluded line >
  previous fallback) at src/loop.ts:1040-1096; threading via
  `RetryPromptInput.digest` / `ContinuationPromptInput.digest` and
  `buildSelectionContinuationPrompt`, passed at exactly three sites — the edit
  and selection continuation prompts and the #54 stall ask; ordinary retries
  stay digest-free.
- Tests src/loop.test.ts:771-914 (state/update, bound + eviction accounting,
  ruled-out ordering, tsc error-line preference, mapped-diagnostic + code-frame
  safety, tests-failure labels) and 1893-2160 (continuation content, update
  across rounds, ruled-out at 3 repeats, selection continuation, stall ask vs
  ordinary retry, replacement-marker non-leak). 604 tests total.
- Offline replay evidence (storm bundle `tmp/replays-49-context/minilisp-ts-rep2`):
  digest rendered at the stall asks (lengths 1141 / 1093 <= 1200), tsc entries
  carry `src/lisp.ts(92,46): error TS2322: …`, ruled-out lines for tsc (8x) and
  matcher-unparseable (4x) with the #56 escalation alternatives.
- Gates (main-agent rerun): tsc 0, 604 tests pass, accept 5/5, check 3 PASS.
- Live evidence (2026-10-19 matrix, `benchmark/results/2026-10-19-ts.json`,
  bundles `tmp/replays-59-final/`): the digest is present in every continued
  round — `Prior attempts` rendered 6 / 2 / 7 times (minilisp reps), with
  18 / 2 / 23 ruled-out lines; no success regression (json 3/3, sexp 3/3,
  minilisp 2/3). The second half of this criterion is NOT met: repeat-class
  attempts did not drop — the reps recorded 13 / 0 / 6 `repeat` and 5 / 1 / 0
  `duplicate` rejections, i.e. the model resent already-ruled-out payloads
  through the whole chain (rep1 rows 10-32; rep3 rows 18-34 cycle the same
  three payloads with the digest in context). The digest's content, bounds and
  tests are verified; the live effect is superseded by #60 (rejection-cycle
  storms), where this clause re-measures. Issue stays open on this clause.
- Re-measure (2026-10-19 stormfix sample,
  `benchmark/results/2026-10-19-tc-stormfix.json`, bundles
  `tmp/replays-60-tc-matrix/`): digest presence holds — every ask carries it
  (rep1 rounds 9/17, rep2 round 9, rep3 rounds 9/17; 1,085-1,142 chars, within
  the 1,200 bound) and non-ask continuations render it too (6 / 2 / 6, each
  with `Prior attempts`). Repeat-class attempts still do NOT drop: the storms
  recorded 6 + 0 + 11 = 17 `repeat` and 0 + 0 + 5 = 5 `duplicate` rejections
  (rep3's storm rose to 16 repeat+duplicate versus 6 in the 2026-10-19-ts
  baseline) and both storm reps burned to the 120k token budget with the digest
  in context; the rep that resolved (rep2) recorded no repeat/duplicate. Clause
  still NOT met; the residual is tracked by #65, where this clause re-measures.

- Re-measure 3 (2026-10-19 #65 matrices, `benchmark/results/2026-10-19-tc-storm65-a.json` /
  `-b.json`, bundles `tmp/replays-65-tc-matrix-{a,b}/`): clause MET. Digest
  presence holds in both samples — a: rep1 asks rounds 9/17 (2/2 with digest) +
  5 continuation headers (5/5 with digest), rep2 asks 9/17/25 (3/3) + 1 header;
  b: rep1 asks 9/17/25 (3/3), rep3 1 continuation header with digest
  (`tmp/live-65/forensics.log`). Repeat-class attempts collapsed: `repeat` +
  `duplicate` 17 + 5 in the pre-#65 sample -> 3 + 1 (a) and 1 + 1 (b); the
  `address` class (5 in the pre-#65 rep3) no longer appears. Digest renders
  1,098-1,176 chars (<= 1,200). Success did not regress (7/9, 8/9 vs 7/9).
  Closed on this re-measure.

- Re-measure 4 (2026-10-19 #71 matrices, `benchmark/results/2026-10-19-tc-storm71-c.json` /
  `-d.json`, bundles `tmp/replays-71-tc-matrix-{c,d}/`): clause holds.
  repeat + duplicate: 17 + 5 in the pre-#65 sample -> c rep1 2 + 8, c rep2
  2 + 1, c rep3 0; d rep2 0 + 2, d reps 1/3 0; `address` still absent. Repeat
  alone: 4 total (0-2 per run). Noted wobble: c rep1's 8 `duplicate` rejections
  are the highest single-run count since #59, still far below the pre-change
  sample.
