---
id: 71
title: "Repair verification-cycle storms: surface a non-converging failing set in the retry chain"
status: in-progress
priority: medium
milestone: null
parent: 46
deps: []
labels: [harness]
created: 2026-10-19
---

## Context

The 2026-10-19 #65 matrices (`benchmark/results/2026-10-19-tc-storm65-a.json` /
`-b.json`; replays `tmp/replays-65-tc-matrix-{a,b}/`) re-measured #60's live
bar: json 3/3 and sexp 3/3 in both samples, minilisp 1/3 (a) and 2/3 (b). The
rejection classes that #60/#65 targeted collapsed (`repeat` + `duplicate` 17 +
5 in the pre-#65 sample -> 3 + 1 in a, 1 + 1 in b; the `address` class
disappeared), but the storm shape moved: the failing runs are now
`applied -> verification` grinds where every edit is written and the tsc stage
keeps failing the file.

Forensics (sequences in `tmp/live-65/fail-sequences.txt`; normalized to the
error codes + first message sentence):

- a rep1 (124,369, bare token budget) ran 14 consecutive verifications on the
  identical `TS2322: Type 'Expr' is not assignable to type 'LispValue'.` set;
- b rep1 (124,125, bare token budget) ran 20 on `TS2322: Type 'Form' is not
  assignable to type 'LispValue'.`;
- a rep2 (120,021, 32-round cap, no STOP) cycled its final ~20 verifications
  between `TS18047: 'expr' is possibly 'null'.` and `TS2345: Argument of type
  'LispValue' is not assignable to parameter of type 'Expr'.`.

The #54/#65 ask fires in all three runs (rounds 9/17(/25), digest 1,098-1,176
chars, STOP offered) and is answered with another local edit: the digest lists
per-attempt one-liners and per-class `Ruled out` lines, but nothing tells the
model that the failing SET has not changed or is cycling. Each local fix clears
one error and re-introduces the other, and the run grinds to the budget.

The harness sees what the model does not: verification records carry the mapped
diagnostics (`LoopRecord.diagnostics`), so the loop can fingerprint each failed
verification and detect non-convergence. (The `signature` field is only a
count; the #57 digest renders attempts, not state identity.)

## Goal

A repair chain whose verification failures are not converging (the same
failing set for several consecutive rounds, or two states cycling) states that
fact in the retry prompt — a bounded `Failure history` note, present in the
ordinary retry and, through the same builder, in the #54 ask — so the model can
change strategy: the run converges, resolves below ~90k tokens, or reaches the
decision chain, with success floors held.

## Acceptance criteria

- [ ] The retry prompt (ordinary, continuation and #54 stalled ask) carries a
      bounded `Failure history` note when the current chain's verification
      failures are non-converging: the same normalized failing set for >=3
      consecutive verification rounds, or two states cycling over >=4
      (each state named by its normalized diagnostics). The note is absent
      while failures change and on the happy path. Unit tests cover fingerprint
      normalization (error codes + first message sentence, positions and
      `replacement line N` prefixes stripped, order-insensitive), both
      detections, the chain reset on success, the text bound, and prompt
      rendering (present/absent).
- [ ] No behavior change beyond prompt text: no hard cap, no auto-stop, guards
      and budgets untouched; a recovering chain can still succeed (scripted
      test); bounded context cost (the note only fires on detected
      non-convergence).
- [ ] Live evidence on the next two tc-side matrices: json 3/3 and sexp 3/3 in
      each; minilisp >=2/3 in each; every storm-like run resolves below ~90k
      tokens or ends through the decision chain (a STOP) instead of the bare
      token budget; the minilisp bundles show the note rendering.
- [ ] #65's criterion 3 and #60's criterion 3 re-measure on those matrices and
      are recorded in their issues; #49's raw clause re-measured too.
- [ ] `benchmark/results/consumption.md` rows added.
- [ ] Gates: `bunx tsc --noEmit` 0, `bun test` all pass, `bun run accept` 5/5,
      `bun benchmark/check.ts` 3 PASS.

## Verification

```
bun test
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-ts.json --keep --replay-dir tmp/replays-<name>
```

plus replay inspection for the note's presence and the storm endings.

## Notes

- Parent #46. Continues the #60 -> #65 chain; #65 stays in-progress and
  re-measures on these matrices.
- Non-goals: hard caps or auto-stop (#60 evidence: storms recovered), weakening
  the guards, unified-diff bypass, changing the verification stages, model
  change, cost-in-USD comparison.
- Levers considered: (L1) fingerprint + note in the retry/ask [chosen];
  (L2) a digest section for state cycling [redundant with L1]; (L3)
  prescriptive rewrite advice at asks [not factual; rejected].
