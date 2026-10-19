---
id: 76
title: "Structure the attempt digest as a bounded update-in-place repair checkpoint (opencode2 absorption)"
status: wontfix
priority: medium
milestone: null
parent: null
deps: []
labels: [harness]
created: 2026-10-20
---

## Context

#64's opencode2 study ranked the top storm-mitigation absorption: opencode2 keeps
a bounded, **fixed-heading** checkpoint that is **updated in place** rather than
regenerated, pins it as the first history message, and keeps the newest exchange
verbatim beside it (all citations in #64's Notes). The tc harness's `#57`
attempt digest (`src/loop.ts:1755-1909`) is an append-only cause list whose only
guidance is `Ruled out after N repeats: <class> — <alternative>`; it reports
cause counts but presents no bounded `Work State` / `Next Move` the model must
act on, and no verbatim newest exchange beside it.

Live storm evidence (#65/#75): the residual minilisp shape is
applied-but-unverified oscillation — the model repeats a ruled-out shape at the
same spot across many rounds and never converges. #75's decision turn forces
`STOP`-or-re-approach at that point; this issue makes the checkpoint it carries a
structured, low-noise one, so the forced decision is informed by what was
already tried rather than by a flat cause list.

## Goal

Render the repair digest as a bounded, fixed-heading checkpoint — attempted
(recent) attempts, ruled-out shapes, and an explicit next-move directive — so a
stalled model sees what it already tried and what to change, not just counts.

## Acceptance criteria

- [ ] The digest renders under stable section headings with a hard character
      bound; rendering stays deterministic (no timestamps / order noise) and
      unit-tested by shape.
- [ ] The ruled-out-shapes block and the next-move directive are present and
      unit-tested.
- [ ] No new guard, cap, auto-stop, or rejection behavior: the checkpoint stays
      advisory and passable.
- [ ] json/sexp/csv happy paths are unaffected (they rarely reach a stalled
      round); gates stay green.
- [ ] Live: the minilisp pressure set shows no new bare-budget storm versus the
      #75 baseline, and a fired decision turn carries the new headings.
- [ ] `benchmark/results/consumption.md` rows added; #65/#75 notes updated.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
bun benchmark/check.ts
bun run benchmark/run.ts --task minilisp --side tc --reps 6 --json benchmark/results/<date>-tc-checkpoint-<n>.json --replay-dir tmp/replays-<name>
```

plus replay inspection of the rendered checkpoint headings.

## Notes

- Root issue (like #64) so #46's close-out is not gated on it.
- Uses #64 shortlist candidate 1; complements #75 (decision turn) and #57
  (digest).
- Non-goals: a model-generated compaction request (no extra LLM call), any guard
  or cap change, weakening match tolerance.

### Verdict (2026-10-20): implemented, measured, **reverted** — no measured benefit

**Implementation.** `renderAttemptDigest` gained a `Next move:` directive after
the ruled-out block, naming the most-repeated ruled-out class
(`most-repeated: <class> x<count>`) or the bare directive when none; the
existing headings stayed, and the directive was reserved in the
`DIGEST_MAX_CHARS` eviction loop. Three shape assertions added; gates green
(`bunx tsc --noEmit` 0, `bun test` 820 pass, `bun run accept` 5/5,
`bun benchmark/check.ts` 4 PASS).

**Measurement.** Two full matrices (`2026-10-19-tc-checkpoint-{1,2}`) and eight
minilisp pressure matrices (`-checkpoint-mini-{1..8}`, 48 runs), replays under
`tmp/replays-76-*`.

- Full: checkpoint-1 10/12 (minilisp rep3 and csv rep3 ended `edit-exhausted`
  via `STOP`, 0 bare budget); checkpoint-2 **12/12**, overall $0.00184 (a new
  series best), minilisp 26,075 tokens/success (below the 30,398 baseline).
- Pressure: 39/48 ok with **4/48 bare-budget storms** (mini-1 rep6, mini-2
  rep1, mini-5 rep1, mini-8 rep5); several further runs ended `edit-exhausted`
  via `STOP`.

**Verdict.** Criterion 5 ("no new bare-budget storm versus the #75 baseline")
is **not met**: 4/48 pressure storms against the #75 generalized campaign's
1/96 (and 0/24 on its own pressure sample, which `final-2` under identical #75
code did not reproduce). The storm rate is dominated by model variance, not the
digest directive, and the directive adds characters to every checkpoint render
with no measured reduction in storms or repair tokens. Per the series rule
("improvements must stay measured"), the change is **reverted**; the finding is
recorded here (cf. the #69 rejected-hypothesis row) rather than landed
unmeasured. The minilisp repair-cost gap stays owned by #46.
- Wontfix (2026-10-20): Implemented and measured; the bounded Next move directive produced no measurable change in storm rate (4/48 vs the #75 campaign's 1/96 and 0/24) or repair tokens, while adding characters to every checkpoint render. Reverted per the series rule that improvements stay measured.
