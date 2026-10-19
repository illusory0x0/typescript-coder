---
id: 69
title: "Measure batched path-independent edits per exchange"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [harness, benchmark]
created: 2026-10-19
---

## Context

mri-project measured that letting the model batch independent edits in one turn
cut `ast-edit` tokens ≈19% (337k → 272k over 21 tasks; commands/turn 1.07 →
1.67) — directional, n = 2, and its `multi`-cell saving is explicitly "not
robust" (`mri-project/docs/spec/findings.md` §"Batched edits cut `ast-edit`
cost"). tc removed the old `edits[]` batch and sends exactly one payload per
exchange; its minilisp storms are retry-dominated at ~125k tokens. Batching is
a hypothesis to measure, not a target to assume.

Source survey: `/home/illu/repo/mri` absorption study (2026-10-19), insight 5.

## Goal

Records expose per-turn tool/command counts, and an opt-in variant allows
multiple path-independent payloads per exchange, measured on USD per success
and on storm spend.

## Acceptance criteria

- [ ] Benchmark records carry commands/tool-calls per turn, and per-run
      diagnostics expose rejected-vs-applied exchange counts.
- [ ] An opt-in multi-payload-per-exchange variant (flag, default off):
      path-independent payloads only, per-payload pin echo and gate semantics
      defined, no unified diffs, guards unchanged.
- [ ] Measured against the current `consumption.md` row: USD per success not
      worse and minilisp storm spend down — or the hypothesis is recorded as
      rejected with the numbers.
- [ ] Tests and gates green.

## Verification

`bun run benchmark/run.ts --all --side tc --reps 3 --json
benchmark/results/<date>-tc-batch.json` with the flag on vs off, priced per
window; both rows noted in `consumption.md`.

## Notes

- Source: mri-project `docs/spec/findings.md`; `eval/arms/ast-edit.json` prompt
  wording.
- Open design question: how N payloads echo their pins under the composite
  address, and whether the syntax gate applies per payload or per exchange.
- Non-goals: weakening matcher/echo guards; trading success for tokens.
- Priority defaulted to medium; no milestone.
- User directive (2026-10-19): multi-edit is needed — let the model change
  multiple places in one exchange; this issue is the vehicle (opt-in flag +
  measured before/after stays). Fronted in the picking order; starts after
  #71's live evidence.
- Consult (2026-10-19): sequence — this issue lands first and #72 follows; the
  first cut keeps path-independent payloads only (distinct declaration paths).
  #72's design must reserve an interface for same-symbol multi-range batching
  (extension filed separately when needed).
