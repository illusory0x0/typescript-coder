---
id: 46
title: "Harness optimization v3: agent-loop, context, structure-editor"
status: in-progress
priority: high
milestone: null
parent: null
deps: []
labels: [harness, benchmark]
created: 2026-10-18
---

## Context

v2 (edit protocol #42, agent loop #43) landed and was measured by #44's canonical
run (`benchmark/results/2026-10-18-ts.json`): json-parser 4,366 (3/3), sexp-parser
2,741 (3/3), minilisp n/a (0/3), overall 13,716 (6/9), all under the uniform
`reasoning_effort: none` policy. The 2026-10-17 opencode comparison anchor ran at
the provider-default effort, so #47 re-establishes it at effort none for a fair
cross-side comparison.

User directive (2026-10-18): run the oc side at reasoning-effort none and
record it as the baseline; then keep optimizing typescript-coder's agent loop and
context management, self-analyzing causes; the structured editor may be improved
too — but never by mixing in unified diffs as a bypass.

## Goal

After this phase the tc side beats the fair (none-effort) opencode baseline on
tokens per success per task and overall, with success at least json 3/3, sexp 3/3,
minilisp ≥2/3 — through analyzed, individually measured improvements to the agent
loop, context management, and the structured editor.

## Acceptance criteria

- [ ] All children are done or wontfix with a written reason: #47 (baseline), #48
      (repair convergence), #49 (context management), #50 (structured editor).
- [ ] A post-improvement full tc-side run is committed under
      `benchmark/results/`, compared against the #47 baseline in the report and
      `consumption.md`.
- [ ] Gates green at close: `bunx tsc --noEmit` 0, `bun test` all pass,
      `bun run accept` 5/5, `bun benchmark/check.ts` 3 PASS.

## Verification

```
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-ts.json
bunx tsc --noEmit
bun test
bun run accept
bun benchmark/check.ts
```

plus: read the new report's aggregates against the #47 baseline figures.

## Notes

- Continuation of #28 after its v2 measurement (#44); this phase's ledger rows
  cite the #47 baseline.
- Non-goals: model change, cost-in-USD comparison, unified-diff edit paths
  (directive: no mixing/bypass), oc-side code changes.
- Improvements must stay measured: each child records its before/after evidence.

## Status (2026-10-19): v3.2 cluster landed; goal not yet met

- Children state: #47/#48/#50/#54/#55/#56/#58 done; #57 holds on its live
  clause (the digest is present in continued rounds but repeat-class attempts
  did not drop); #49 holds on its raw clause. Follow-up #60 owns the residual
  minilisp rejection-cycle storms.
- Post-improvement full tc-side run: `benchmark/results/2026-10-19-ts.json`
  (+ report `2026-10-19-ts.md`), row in `benchmark/results/consumption.md`:
  json 4,587 (3/3), sexp 2,965 (3/3), minilisp 126,454 (2/3), overall 34,446
  (8/9).
- Against the #47 baseline (fair none-effort opencode: 15,963 / 11,770 /
  30,398 / 19,377 per task and overall): json 3.5x lower, sexp 4x lower;
  minilisp and overall remain above — the goal is not met until #60 removes
  the rejection-cycle burn, after which #49's re-measure and this close-out
  follow.
- Gates at this state (main-agent rerun): `bunx tsc --noEmit` 0, 622 tests
  pass, `bun run accept` 5/5, `bun benchmark/check.ts` 3 PASS.
- #28 (v2 umbrella) closed as superseded on 2026-10-19 (user decision): this
  issue now carries the end-to-end goal against the fair baseline, the series
  close-out verdict, and the final `consumption.md` row.

## Status (2026-10-19, post-#65 two-matrix verdict)

- Samples (`2026-10-19-tc-storm65-a.json` / `-b.json`; rows in
  `benchmark/results/consumption.md`): json $0.00104 / $0.00096 (both 3/3),
  sexp $0.00035 / $0.00033 (3/3), minilisp $0.03836 (1/3) / $0.01658 (2/3),
  overall $0.00607 (7/9) / $0.00463 (8/9).
- Against the oc pressure baseline ($0.00217 / $0.00195 / $0.00598; overall
  $0.00444, composite $0.00337): json/sexp far below; minilisp and overall
  still above — sample b's overall sits under the oc 6-sample mean ($0.00501)
  but above the pressure row. Goal still not met.
- Children: #57 closed (live clause met on the third re-measure); #49 holds on
  raw (39,924 / 25,248 vs the 23,357 / 13,716 readings); #60 and #65 hold on
  their outcome clauses; #71 (new) owns the post-#65 residual —
  applied-but-unverified oscillation storms. #46 closes when the storm chain
  resolves and the final row lands.

## Status (2026-10-19, post-#71 c/d two-matrix verdict)

- Samples (`2026-10-19-tc-storm71-c.json` / `-d.json`; rows in
  `benchmark/results/consumption.md`): d — json $0.00190 (3/3), sexp $0.00070
  (3/3), minilisp $0.00999 (3/3; 31,330 tokens per success), overall $0.00420
  (9/9) — the first clean sample: every storm run resolved (23,186 / 27,279 /
  43,524 tokens; 13,008 tokens per success, below the #44 canonical 13,716),
  and the overall sits under the oc pressure baseline ($0.00444). c — json
  $0.00196 (3/3), sexp $0.00069 (3/3), minilisp $0.04090 (2/3), overall
  $0.01122 (8/9), the spread driven by one bare-budget storm (125,052 tokens;
  asks at rounds 9/17/25 answered with further edits — the #65 residual).
- Against the #47 baseline (15,963 / 11,770 / 30,398 / 19,377 per task and
  overall): sample d is below on json (4,612), sexp (3,083), and overall
  (13,008), and above on minilisp only (31,330, +3%) — the goal misses on one
  task by ~930 tokens in this sample; success 9/9 (bars met).
- Children: #49 closed (raw clause met on sample d: 13,008 < 13,716); #60 and
  #71 closed with the c-rep2 residual recorded; #65 stays open on its outcome
  clause — this issue closes when that resolves and the final row lands.
- Gates at this state: green at the c/d run start (`tmp/live-71/run.log`,
  16:45:54): `bunx tsc --noEmit` 0, `bun test` pass, `bun run accept` 5/5,
  `bun benchmark/check.ts` 3 PASS. The closure package touches docs/issues
  only.

## Status (2026-10-19, post-#65 cadence + held-out baseline)

- **#65 cadence fix measured (e/f):** e clean 9/9 (overall $0.00207, minilisp
  $0.00475); f minilisp 2/3 with one bare-budget storm (125,046) where the
  round-9 first ask AND the round-13 sharpened `repeated ask 2` **did fire** but
  the model answered each with another edit and never `STOP`s. #65's criterion 3
  is still unmet; the blocker is now model compliance, filed as **#75**
  (help-wanted child of #65). #65 stays in-progress.
- **Held-out baseline landed (#67):** the four-task matrix
  (`2026-10-19-tc-holdout.json`) is 12/12 — csv-parser 3/3 $0.00300, json 3/3
  $0.00111, sexp 3/3 $0.00035, minilisp 3/3 $0.00348, overall $0.00199. The
  harness generalizes to a fixture it was never tuned on.
- **Children:** #47/#48/#49/#50/#57/#60/#71 closed; #65 open (criterion 3),
  gated by #75. This issue closes when #65 resolves (or is closed wontfix with a
  written reason) and the final row lands.
- Gates at this state: `bunx tsc --noEmit` 0, 812 tests pass, `bun run accept`
  5/5, `bun benchmark/check.ts` 4 PASS (csv frontend added).

## Status (2026-10-20, post-#75 gated decision-only turn): storm chain resolved, minilisp cost gap remains

- **#75 landed** (commit `03e9220`): the decision-only turn is generalized to fire
  on any repeat ask or an already non-converging `#71` set; the edit template is
  replaced by a forced decision (`STOP` or a re-approach carried to the next
  exchange). No hard cap, no auto-stop, guards unchanged.
- **Storm outcome.** Six generalized-gate full matrices
  (`2026-10-19-tc-compliance-{c,d,e,f}` + `2026-10-19-tc-final-{1,2}`; rows in
  `consumption.md`): c 12/12, e 12/12, final-1 12/12, f 11/12, final-2 11/12,
  d 11/12. **Five of six had zero bare-budget storms**; the storm runs in f and
  final-2 ended through the decision chain (`STOP`), and the 24-run generalized
  pressure set had 0 bare-budget storms (narrow-gate baseline 2/18). The single
  exception is **d** (minilisp rep1 127,537: the model declined `STOP` twice) —
  a model-dependent tail (~1/72 full-matrix runs). #75 and #65 close with this
  residual disclosed.
- **Goal vs the #47 baseline** (json 15,963 / sexp 11,770 / minilisp 30,398 /
  overall 19,377 tokens per success): on the clean samples the tc side is far
  below on json (~4.8k), sexp (~3.2k), and overall (final-1 17,636; c 11,638;
  e 13,287; holdout 12,381) — but **minilisp is not reliably below** (holdout
  18,425 and e 26,328 below; c 30,112 ~ par; final-1 **38,027 above**; storms
  push it to 64k-82k). The goal is therefore **not met**: minilisp tokens per
  success stays at or above the baseline on an ordinary sample. The remaining gap
  is *minilisp repair cost*, not storms.
- **Children:** #47/#48/#49/#50/#57/#60/#71 open-closed earlier; #65 and #75 now
  close. The follow-up that owns the minilisp cost gap is the opencode2
  structured-checkpoint absorption (**#76**, root). This issue stays in-progress
  until that gap closes and the final row lands.
- Gates at this state: `bunx tsc --noEmit` 0, 820 tests pass, `bun run accept`
  5/5, `bun benchmark/check.ts` 4 PASS.

## Status (2026-10-20, post-#76 verdict): close-out attempt — goal met on the clean path, not reliably

- **#76 (opencode2 checkpoint directive) is closed wontfix.** It was implemented
  (a bounded `Next move:` line in the repair digest, unit-tested, gates green),
  measured over 2 full matrices and 48 pressure runs
  (`2026-10-19-tc-checkpoint-{1,2}`, `-checkpoint-mini-{1..8}`; replays
  `tmp/replays-76-*`), and **reverted**: it produced no measurable change in
  storm rate (4/48 pressure storms vs the #75 campaign's 1/96 and 0/24) or repair
  tokens, while adding characters to every checkpoint render. Recorded per the
  series rule that improvements stay measured. (Its `checkpoint-2` did post the
  best-ever single sample — 12/12, overall $0.00184 — but on code that was then
  reverted, so it is not a final row.)
- **Final-code evidence** (committed #75 state; rows in `consumption.md`):
  json and sexp beat the #47 baseline (15,963 / 11,770) on **every** sample
  (~4.8k / ~3.2k); the overall beats it on the clean samples (c 11,638, e 13,287,
  final-1 17,636 vs 19,377); **minilisp tokens per success is 26,328 (e) / 30,112
  (c)** — at/under the 30,398 baseline — but flaps above on an ordinary sample
  (final-1 38,027) and blows up on the ~1-3% storms (d/f/final-2 64k-82k).
- **Verdict.** #46's explicit criteria are met (all children decided; the
  post-improvement runs are committed and compared; gates green), but the goal
  ("beats ... per task") is **not met reliably** because of the minilisp
  repair-cost variance. The two available levers are exhausted (#75 landed,
  #76 reverted-negative). A help-wanted child (**#77**) owns the remaining gap.
  #46 stays **in-progress** rather than close on an overclaim.
- Gates at this state: `bunx tsc --noEmit` 0, 820 tests pass, `bun run accept`
  5/5, `bun benchmark/check.ts` 4 PASS.
