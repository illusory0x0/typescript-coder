---
id: 16
title: "Run tc protocol variants in one concurrent benchmark"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [benchmark]
created: 2026-10-22
---

## Context

Comparing the tc protocol variants currently needs one benchmark invocation per variant: `--protocol-format` is a single report-level value that applies to the tc side, so `tc json`, `tc edit-dsl`, and `oc` cannot be measured in one run. Today's 2026-10-22 pilot used two sequential invocations (`--side tc --protocol-format json`, then `--side both --protocol-format edit-dsl`), which doubles wall-clock time and produces two reports that are awkward to compare.

The harness already has a bounded worker pool over a `task × side × rep` matrix (`benchmark/run.ts` `main`), so the missing piece is a protocol variant dimension in the job matrix, run record, report, and aggregates — not a second scheduler. `RunRecord` has no protocol field, `Report.protocolFormat` is scalar, `computeAggregates` keys only by task/side, and `benchmark/check.ts` reads one `protocolFormat` per report.

## Goal

A single benchmark invocation can measure `json` and `edit-dsl` (plus `oc`) concurrently and report each tc variant separately, while older single-protocol reports stay readable.

## Acceptance criteria

- [ ] `--protocol-format` accepts a comma-separated list (for example `json,edit-dsl`), order-independent and de-duplicated; a single value keeps today's behavior, and the deprecated `compact` alias is still normalized per element. `--help` documents the list form.
- [ ] `oc` jobs appear once per task/rep regardless of how many tc protocols are selected; tc jobs expand to one per selected protocol, all in the same `jobs` array and the existing bounded worker pool (no serial per-protocol phase).
- [ ] `RunRecord` carries the protocol the run used (`null` for `oc`), and the report records the selected variant list; the JSON report, the Markdown report, and the console `starting …` lines identify the variant.
- [ ] Aggregates group tc rows by protocol as well as task and side, so `json` and `edit-dsl` each get their own `$/success`, token, step, and selector/stage rows; `oc` has one row set. The overall comparison does not silently pool two tc protocols.
- [ ] Provenance is recorded and checked per tc protocol; `benchmark/check.ts` verifies a ledger row for a multi-variant report by the row's protocol, and still accepts legacy reports with scalar `protocolFormat` and legacy `"compact"` values.
- [ ] Offline unit tests cover: job-matrix expansion (both tc variants, `oc` once), list parsing including the alias and de-duplication, per-protocol aggregation, and legacy single-protocol report/check compatibility.
- [ ] No live model run is part of verification.

## Verification

```
bun run benchmark/run.ts --help
just typecheck
just test
bun test src/benchmark-run.test.ts
bun benchmark/check.ts   # or the documented ledger check command
```

A unit-level run with a stubbed runner must show `json`, `edit-dsl`, and `oc` jobs claimed from one pool; a real pilot is optional follow-up evidence, not a gate.

## Notes

- Motivating work: the 2026-10-22 three-way pilot (`benchmark/results/2026-10-22-pilot-tc-json.json`, `benchmark/results/2026-10-22-pilot-edit-dsl-oc.json`) had to be split into two invocations.
- Keep single-protocol behavior and existing report consumers (ledger, `src/benchmark-run.test.ts`, `benchmark/check.ts`) backward compatible; do not rewrite historical result files.
- Design is deliberately one atomic change: the job matrix, report schema, aggregation, and ledger check must land together or the intermediate report is ambiguous.
