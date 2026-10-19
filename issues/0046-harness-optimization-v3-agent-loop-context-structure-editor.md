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
