---
id: 47
title: "Opencode none-effort baseline run"
status: done
priority: high
milestone: null
parent: 46
deps: []
labels: [benchmark]
created: 2026-10-18
---

## Context

The ts side runs every Edit-loop exchange at `reasoning_effort: none` (v2 policy;
sweep evidence in `benchmark/results/2026-10-18-ts-effort-*.json`). The opencode
comparison reference (2026-10-17: 15,517 / 11,812 / 23,142 / 16,824, 9/9) ran at
the provider-default effort, so the cross-side comparison is not effort-fair.

Directive (2026-10-18): run the opencode side at reasoning-effort none and record
its tokens as the baseline.

Mechanism verified 2026-10-18: `opencode run --model
honghong/deepseek-v4.1-flash#none` selects the config's `none` variant
(`~/.config/opencode/opencode.jsonc` defines none/low/high/max). A single
json-parser smoke passed with `reasoning: 0`, 18,826 tokens, 8 steps, 348.3 s
(n=1 — not the baseline).

## Goal

A committed opencode-side 3×3 matrix at reasoning effort none, recorded as the
official consumption comparison baseline.

## Acceptance criteria

- [ ] A full opencode-side run at effort none is committed under
      `benchmark/results/` (JSON + MD):
      `bun run benchmark/run.ts --all --side opencode --reps 3 --model "honghong/deepseek-v4.1-flash#none" --json benchmark/results/<date>-opencode-none.json`.
- [ ] The run's usage is sane: `reasoning` 0 across runs (or every exception
      documented in the report's anomalies).
- [ ] `benchmark/results/consumption.md` cites the new baseline (note added to the
      baseline row or a new row) so later comparisons reference it.

## Verification

```
bun run benchmark/run.ts --all --side opencode --reps 3 --model "honghong/deepseek-v4.1-flash#none" --json benchmark/results/<date>-opencode-none.json
```

plus: inspect `aggregates.byTaskSide`/`bySide` in the result JSON and the ledger
note.

## Notes

- Smoke evidence (2026-10-18, n=1): json-parser PASS, reasoning 0, 18,826 tokens,
  8 steps, 348.3 s — a single sample, not the baseline.
- opencode v2.0.32 here; the report's `model` field records the `#none` variant.
- Infra failures follow the existing rerun rule; runs over the harness timeout
  are cut.
- The 2026-10-17 default-effort figures stay as the historical reference.
- Close-out (2026-10-18): baseline committed — `benchmark/results/2026-10-18-opencode-none.json` / `.md`
  (model `honghong/deepseek-v4.1-flash#none`, opencode v2.0.32, 9/9 runs).
  All runs report `reasoning: 0` (usage from session export). Tokens per
  success: json 15,963 (3/3), sexp 11,770 (3/3), minilisp 30,398 (3/3), overall
  19,377 (9/9); mean duration 193.9 s, 8.6 steps.
- Finding: dropping reasoning did not lower opencode's consumption versus its
  provider-default reference (overall 19,377 vs 16,824) — the model takes more
  steps without reasoning; the baseline is effort-fair, not favorable.
- `consumption.md` gained the "Opencode comparison baselines" table citing both
  references.
