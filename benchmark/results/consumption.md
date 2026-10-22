# Consumption ledger

Canonical before/after view for the efficiency series: each measured result with
a source result file per row. Metric values are **USD per success** — the total
USD cost of a row's runs divided by the number of passing runs, the same
definition as `aggregates[].costPerSuccess` in the result JSON — on the tc side
unless a note says otherwise. New rows price by their own window (a calculator
estimate — run timing is not a constraint; see `benchmark/README.md`
§"Evidence and provenance"). Success counts are shown as `ok/runs`; the dated
reports keep the token columns.

**Protocol is part of the measurement.** The compact edit protocol (#119) is the
protocol measured from the compact-era baseline onward, and this ledger starts
fresh in that era. The JSON-era rows (the pre-#119 series, deleted by the
cleanup commit `a648a97`) were measured under a **different protocol**; they are
not restored here and they are **not like-for-like comparable** to a compact row.
A claim may only compare rows with the same `Protocol` value.

## Row format

| Date | Change set | json-parser | sexp-parser | minilisp | Overall | Source | Notes | Protocol |
| ---- | ---------- | ----------- | ----------- | -------- | ------- | ------ | ----- | -------- |

- `Date`: measurement date (the result run's date).
- `Change set`: series issue refs and/or a short description of what changed
  relative to the previous row.
- `json-parser` / `sexp-parser` / `minilisp`: tc-side USD per success with the
  success count, e.g. `$0.00104 (3/3)`, from
  `aggregates.byTaskSide[].costPerSuccess`. These are the three tuned fixtures;
  `csv-parser` is held out and is reported only in `Notes`.
- `Overall`: tc-side totals across **all four** tasks (the held-out task
  included), e.g. `$0.02650 (2/4)`, from `aggregates.bySide[].costPerSuccess`.
- `Source`: path of the result JSON the row was copied from (report path when
  useful). Paths are relative to the repository root.
- `Notes`: caveats, cross-side reference values, or anything the numbers do not
  show on their own.
- `Protocol`: the edit protocol the tc side used for the row (`compact` or
  `json`). Rows with different values are not comparable.

## Rows

| Date       | Change set                                                                   | json-parser | sexp-parser    | minilisp  | Overall        | Source                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Protocol |
| ---------- | ---------------------------------------------------------------------------- | ----------- | -------------- | --------- | -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 2026-10-21 | #11 compact baseline (fresh compact-era baseline after the JSON-era cleanup) | n/a (0/1)   | $0.00080 (1/1) | n/a (0/1) | $0.02650 (2/4) | `benchmark/results/2026-10-21-compact-baseline.json` (report `.md`) | tc side, compact protocol (default from #119), uniform `none`, 4 tasks × tc × 1 rep (4 runs). Held-out csv-parser **1/1, $0.00163 per success** (not a tuned column; no prompt/code tuned against it). json-parser 0/1 and minilisp 0/1 both ended `token-budget` (122,840 and 120,862 accumulated tokens, 48 and 38 steps) after compact `no-op`/`protocol` rejection loops; their USD is still in the Overall numerator. Overall spans **four** tasks. Replay bundles: `tmp/replay-compact/` (all carry `protocolFormat: compact`). | compact  |
| 2026-10-22 | #17 semantic rename full edit-dsl series | $0.00180 (3/3) | $0.00086 (3/3) | $0.04466 (1/3) | $0.00563 (10/12) | `benchmark/results/2026-10-22-semantic-rename.json` (report `.md`) | tc side, edit-dsl, uniform `none`, 4 tasks × both sides × 3 reps (24 runs). Held-out csv-parser **3/3, $0.00122 per success** (not a tuned column). minilisp 1/3 with two `token-budget` storms (121,272 and 120,729 accumulated tokens); the failure analysis is tracked by #22/#23/#24. oc was 9/12 with three 1500s timeouts; this row is tc only. The prompt hash changed with #17, so earlier rows are stale. Measured before the #23 variable-kind fix; no replay bundles recorded. | edit-dsl |

### Method

`costPerSuccess` counts a judged pass with no termination-matrix ending, and
divides the summed USD of the selected runs (failed runs included) by that
success count; `n/a` means no run passed. See `benchmark/README.md`
§"Evidence and provenance" for the full rule. Every row cites exactly one source
JSON, re-derived by `bun benchmark/check.ts`.
