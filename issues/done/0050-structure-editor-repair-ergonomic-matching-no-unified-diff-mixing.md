---
id: 50
title: "Structure-editor: repair-ergonomic matching (no unified-diff mixing)"
status: done
priority: medium
milestone: null
parent: 46
deps: []
labels: [harness]
created: 2026-10-18
---

## Context

Repair attempts fail predominantly in the editor's matcher/format stages (e.g.
`(1,'matcher', 71 chars)` outcomes in the canonical minilisp failures, see
`benchmark/results/2026-10-18-ts.json` anomalies). Directive (2026-10-18): the
structured editor may be improved — but never by mixing in unified diffs as a
bypass.

## Goal

The structured editor converts more repairs and localizes failures precisely: the
recorded matcher/format failure classes are diagnosed, fixed with tests, and shown
improved on the recorded evidence.

## Acceptance criteria

- [ ] A failure taxonomy for the recorded matcher/format failures (stale snippets
      vs indentation drift vs ambiguous anchors vs format-gate issues), each with
      bundle evidence, written into this issue's Notes.
- [ ] Editor changes + unit tests covering the diagnosed classes land; the edit
      protocol keeps the structured locator × matcher shape (no unified-diff
      path).
- [ ] Replay evidence over the recorded bundles shows the covered failure classes
      resolved or advanced, and the full ts-side run shows no success regression.

## Verification

```
bun test
bun run benchmark/run.ts --all --side ts --reps 3 --json benchmark/results/<date>-ts.json
```

plus: replay commands over the recorded bundles; review that no unified-diff code
path was added.

## Notes

- Coordinate with #48; if the diagnosis shows the failures are prompt-side rather
  than editor-side, this issue may close wontfix with that evidence (#48 then owns
  the fix).
- Non-goals: unified-diff fallback; tolerant matching that accepts ambiguous
  anchors (uniqueness stays a requirement).

## Notes (implementation, 2026-10-19)

- Taxonomy: all 43 recorded rows were replay-reproducible (bundles exist for
  every report). Buckets: `format` has-export 7 (ts / effort-none / repin — all
  whole-symbol rewrites of `export function run(...)`, literal `export `; 0
  whitespace variants in 138 bundles); matcher own-declaration with header 10
  (ts x4, effort-none, effort-low x2, effort-high, repin x2); wrong pin (other
  declaration) 5 (ts LispValue + Closure, effort-none Closure, repin makeLambda,
  repin3 Closure); unparseable model-side 15; inside-own partial 4;
  not-attributable stale 2.
- Current-code replay: the 7 format rows and 9/10 own-header rows now APPLY (1
  own-header row hits the repeat guard on an identical resend); the 5 wrong-pin
  rows reject with the relocation note firing 5/5; the remaining 21 are
  model-side (stale text / concatenated declarations / malformed fragments) and
  cannot be fixed without tolerant or ambiguous matching.
- Implemented: whitespace-tolerant leading-`export` strip
  (src/loop.ts:1367-1389 stripLeadingExport, 1393-1409 findAnchorWithModifier)
  covering both the matcher and the whole-declaration replacement paths;
  comment-glued `export` stays unrecognized on purpose and remains the #56
  fast-exit trigger (defense-in-depth).
- Tests (src/loop.test.ts): 2756 whole-symbol `export\n`; 2777 whole-declaration
  matchers (export / export-newline / plain); 2811 body-level negative (no
  strip); 2878 wrong-pin export-newline with the per-candidate note; the #56
  scripted repro (:4221) was adapted to `export/* keep */function`, the only
  remaining constructible duplicate-modifier trigger. No unified-diff path was
  added; ambiguity handling unchanged (tests at 2860+, 2900+).
- Docs: spec.md:114-119 (tolerance paragraph), 274-280 (matcher bullet);
  docs/glossary.md unchanged (no vocabulary change).
- Gates (main-agent rerun): tsc 0, 610 tests pass, accept 5/5, check 3 PASS.
- Live evidence (2026-10-19 matrix, `benchmark/results/2026-10-19-ts.json`):
  no success regression — json 3/3, sexp 3/3, minilisp 2/3 (8/9). json 4,587 /
  sexp 2,965 tokens per success (series best, 3-step happy path). The remaining
  live minilisp rejections are `matcher-not-found` (9 total) — no re-broken
  export/own-header cases appeared live. Bundles: `tmp/replays-59-final/`.
