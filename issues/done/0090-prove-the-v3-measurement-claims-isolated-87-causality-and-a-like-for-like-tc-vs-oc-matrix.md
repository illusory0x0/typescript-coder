---
id: 90
title: "Prove the v3 measurement claims: isolated #87 causality and a like-for-like tc-vs-oc matrix"
status: done
priority: high
milestone: null
parent: null
deps: []
labels: [benchmark, harness]
created: 2026-10-20
---

## Context

The v3 close-out (#46) and the tc-vs-oc comparison rest on measurements that are
either single-shot or not like-for-like:

- #46's close-out disclosed that **#87's causal share is unmeasured** (no isolated
  A/B); the minilisp win rests on two matrices.
- The committed tc-vs-oc comparison (`benchmark/results/2026-10-20-tc-vs-oc`)
  ran oc with **reasoning ON** (14,268 reasoning tokens), so it is not the
  canonical uniform-`none` comparison; and both committed comparison reports
  (`2026-10-20-tc-vs-oc`, `2026-10-20-oc-none`) were rendered under the **pre-#89**
  accounting (tc `input` included cache hits).

This umbrella covers the two measurement gaps: prove #87's causality on minilisp,
and produce/refresh a canonical none-vs-none tc-vs-oc comparison under the #89
cache-excluded accounting.

## Goal

The claims behind #46 and the tc-vs-oc comparison are backed by an isolated
causal measurement and a like-for-like, canonically-effort-matched comparison
rendered under the #89 accounting.

## Acceptance criteria

- [ ] Every child is `done` or `wontfix` with a recorded verdict.
- [ ] A causal #87 on/off A/B exists for minilisp (or a confounded verdict is
      argued with evidence).
- [ ] A canonical uniform-`none` tc-vs-oc matrix exists under the #89
      accounting, or the committed comparison reports are re-rendered under it
      with a note.
- [ ] `benchmark/check.ts` is green at close.

## Verification

See the children; the umbrella closes when every child is decided and
`bunx tsc --noEmit`, `bun test`, and `bun benchmark/check.ts` are green.

## Notes

- Parent for the two measurement children filed alongside this umbrella.
- Non-goals: changing the #89 accounting; re-litigating #46's explicit criteria.
- Children: #92 (minilisp isolated A/B for #87's causal share), #93 (canonical none-vs-none tc-vs-oc matrix under the #89 accounting). Umbrella closes when both are decided.
- Closed 2026-10-20 with both children decided. #92: isolated #87 on/off minilisp A/B via a new `TC_DIAG_DECL_NAMING` opt-out — verdict **confounded** (35,254 vs 33,533 tokens per success, within-arm spread ~5x), so #87's causal share is unproven but the metric holds. #93: canonical uniform-`none` tc-vs-oc matrix under the #89 accounting (new `--oc-model` flag) — oc 1.28x tc overall, json 9.02x, sexp 9.60x, csv 1.39x, but tc minilisp 1/3 and 1.40x oc, reproducing the #46 caveat. Both results are recorded in consumption.md (35 rows) and benchmark/check.ts is green; neither child changed behavior beyond its toggle/flag.
