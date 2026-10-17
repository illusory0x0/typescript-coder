# Consumption ledger

Canonical before/after view for the token-efficiency series: the pre-series
baseline and each measured result side by side, with a source result file per
row. All values are tokens per success — total tokens of judge-passing runs
divided by the number of passing runs, the same definition as
`aggregates[].tokensPerSuccess.total` in the result JSON — on the ts side
unless a note says otherwise. Values are rounded to the nearest whole token;
success counts are shown as `ok/runs`.

## Row format

| Date | Change set | json-parser | sexp-parser | minilisp | Overall | Source | Notes |
| ---- | ---------- | ----------- | ----------- | -------- | ------- | ------ | ----- |

- `Date`: measurement date (the result run's date).
- `Change set`: series issue refs and/or a short description of what changed
  relative to the previous row; the baseline is `baseline (pre-series, plan v4)`.
- `json-parser` / `sexp-parser` / `minilisp`: ts-side tokens per success with
  success count, e.g. `43,293 (3/3)`, from `aggregates.byTaskSide`.
- `Overall`: ts-side totals across all three tasks, e.g. `70,799 (7/9)`, from
  `aggregates.bySide`.
- `Source`: path of the result JSON the row was copied from (report path when
  useful). Paths are relative to the repository root.
- `Notes`: caveats, cross-side reference values, or anything the numbers do not
  show on their own.

## Rows

| Date       | Change set                     | json-parser | sexp-parser  | minilisp      | Overall      | Source                                                       | Notes                                                                                                                                                    |
| ---------- | ------------------------------ | ----------- | ------------ | ------------- | ------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-17 | baseline (pre-series, plan v4) | 5,877 (3/3) | 43,293 (3/3) | 348,080 (1/3) | 70,799 (7/9) | `benchmark/results/2026-10-17.json` (report `2026-10-17.md`) | ts side. opencode reference from the same report, recorded verbatim as the comparison target: 15,517 (3/3) / 11,812 (3/3) / 23,142 (3/3) / 16,824 (9/9). |

## How to add a row

Run the ts-side matrix (`bun run benchmark/run.ts --all --side ts --reps 3`),
copy `tokensPerSuccess.total` plus `ok`/`runs` from `aggregates.byTaskSide`
(per task) and `aggregates.bySide` (overall) in the result JSON, cite the result
JSON path, and append the row below the existing rows. Rows are appended in
series order; the final row is added during the #28 close-out.
