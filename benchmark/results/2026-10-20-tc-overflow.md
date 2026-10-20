# Benchmark report — 2026-10-20

- mode: full
- model: deepseek-v4.1-flash
- effort: none (default)
- multi-payload: off (default)
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp, csv-parser
- sides: tc
- reps: 3
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-20T06:38:19.318Z
- pilot reference: none

## Frozen task specs

### json-parser

Issue (verbatim, identical for both sides):

```
Implement src/json.ts exporting JsonValue and parseJson(text: string): JsonValue
so that src/json.test.ts passes and `bunx tsc --noEmit` stays clean.
Create or modify only src/json.ts - no other files, no scratch files;
src/json.test.ts and tsconfig.json are read-only.
The fixture contains only those files - nothing else to explore.
The test file is the specification; implement what it requires, nothing more.
Verify with `bun test` and `bunx tsc --noEmit` only.
```

- fixture: benchmark/fixtures/json-parser/
- reference: benchmark/references/json.ts

### sexp-parser

Issue (verbatim, identical for both sides):

```
Implement src/sexp.ts exporting Sexp and parseSexp(text: string): Sexp
so that src/sexp.test.ts passes and `bunx tsc --noEmit` stays clean.
Create or modify only src/sexp.ts - no other files, no scratch files;
src/sexp.test.ts and tsconfig.json are read-only.
The fixture contains only those files - nothing else to explore.
The test file is the specification; implement what it requires, nothing more.
Verify with `bun test` and `bunx tsc --noEmit` only.
```

- fixture: benchmark/fixtures/sexp-parser/
- reference: benchmark/references/sexp.ts

### minilisp

Issue (verbatim, identical for both sides):

```
Implement src/lisp.ts exporting LispValue and run(program: string): LispValue
so that src/lisp.test.ts passes and `bunx tsc --noEmit` stays clean.
Create or modify only src/lisp.ts - no other files, no scratch files;
src/lisp.test.ts and tsconfig.json are read-only.
The fixture contains only those files - nothing else to explore.
The test file is the specification; implement what it requires, nothing more.
Verify with `bun test` and `bunx tsc --noEmit` only.
```

- fixture: benchmark/fixtures/minilisp/
- reference: benchmark/references/lisp.ts

### csv-parser

Issue (verbatim, identical for both sides):

```
Implement src/csv.ts exporting parseCsv(text: string): string[][]
so that src/csv.test.ts passes and `bunx tsc --noEmit` stays clean.
Create or modify only src/csv.ts - no other files, no scratch files;
src/csv.test.ts and tsconfig.json are read-only.
The fixture contains only those files - nothing else to explore.
The test file is the specification; implement what it requires, nothing more.
Verify with `bun test` and `bunx tsc --noEmit` only.
```

- fixture: benchmark/fixtures/csv-parser/
- reference: benchmark/references/csv.ts

## Token and cost accounting

Like-for-like tokens (#89): the comparison total is cache-excluded — total =
cache-miss input (`in`) + output, with reasoning counted as output — normalized for
both sides by the single bucket normalization in `src/benchmark-pricing.ts`.
Cache-hit input stays in each run's raw buckets but is excluded from the total, so
the two sides compare on the same basis.

tc: OpenAI-compatible `usage` from the provider, summed over every chat request
(input/prompt, output/completion, total; cache and reasoning counters are kept per
record).

oc: usage read from `opencode session export` (`info.tokens`), falling back to
`opencode stats --json`; input/output come from the reported session usage and total
is derived from input + output + reasoning when the export reports none; the export's
own `cost` stays verbatim in `rawUsage`.

Cost: USD per run, computed from the recorded buckets and the run's
`startedAt`/`finishedAt` window with the official DeepSeek V4.1-Flash peak/off-peak
prices (see `src/benchmark-pricing.ts`). Buckets: tc `input` includes cache hits
(miss = input - cacheRead); oc `input` excludes them (miss = input, hit = cacheRead);
output is priced together with reasoning; `cacheWrite` is priced at the cache-miss
rate. A run that crosses a peak/off-peak boundary splits by elapsed-time share
(uniform-spend approximation). USD columns are decision-only: cost is recorded in the
result JSON and `consumption.md` for decisions, but the headline comparison metric is
the cache-excluded token total above.

## Per-task results

| Task | Side | Success | Mean in (no cache) | Mean out | Mean total | Mean $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | 3/3 | 133 | 1,635 | 1,768 | $0.00202 | $0.00202 | 15.0 | 3.0 |
| sexp-parser | tc | 3/3 | 539 | 545 | 1,084 | $0.00083 | $0.00083 | 7.8 | 3.0 |
| minilisp | tc | 2/3 | 36,512 | 4,469 | 40,981 | $0.01647 | $0.02471 | 71.0 | 24.0 |
| csv-parser | tc | 3/3 | 4,241 | 1,193 | 5,434 | $0.00276 | $0.00276 | 24.8 | 11.0 |

## Overall comparison

| Side | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 11/12 | 10,356 | 1,961 | 12,317 | 147,800 | $0.00552 | $0.06624 | $0.00602 | 29.6 | 10.3 |

Per success (usage-run sums divided by successful runs):

| Side | In (no cache) | Out | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 11,298 | 2,139 | 13,436 | $0.00602 |

Only one side ran: tc 11/12 (91.7%).

Token multiplier (cache-excluded): not comparable (both sides must run).

*Pricing footnote (decision-only):* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Anomalies

Failing runs:

- minilisp tc rep3: token-budget: accumulated 121014 tokens exceeded the 120000 token budget

Runs with missing usage (`tokens.total` null):

- none

Truncation / timeouts:

- none

Infrastructure errors:

- none

Reruns:

- reruns: none

## Raw runs

Provider-reported buckets, verbatim: tc `Raw in`/`Raw total` include cache hits;
oc `Raw in` excludes them. The cache-excluded comparison total is in the tables
above (and each row's `tokens.billable`), not here.

| Task | Side | Rep | OK | Raw in | Raw out | Raw total | Cost | Rate | Steps | Dur (s) |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| json-parser | tc | 1 | yes | 3,205 | 1,655 | 4,860 | $0.00204 | peak | 3 | 13.8 |
| json-parser | tc | 2 | yes | 3,205 | 1,624 | 4,829 | $0.00201 | peak | 3 | 14.7 |
| json-parser | tc | 3 | yes | 3,205 | 1,627 | 4,832 | $0.00201 | peak | 3 | 16.4 |
| sexp-parser | tc | 1 | yes | 2,673 | 515 | 3,188 | $0.00067 | peak | 3 | 9.8 |
| sexp-parser | tc | 2 | yes | 2,671 | 559 | 3,230 | $0.00106 | peak | 3 | 7.7 |
| sexp-parser | tc | 3 | yes | 2,673 | 560 | 3,233 | $0.00076 | peak | 3 | 5.8 |
| minilisp | tc | 1 | yes | 30,179 | 4,136 | 34,315 | $0.01300 | peak | 15 | 51.4 |
| minilisp | tc | 2 | yes | 38,099 | 2,859 | 40,958 | $0.01275 | peak | 18 | 43.3 |
| minilisp | tc | 3 | no | 119,977 | 6,286 | 126,263 | $0.02367 | peak | 39 | 118.4 |
| csv-parser | tc | 1 | yes | 10,385 | 924 | 11,309 | $0.00268 | peak | 9 | 20.9 |
| csv-parser | tc | 2 | yes | 5,265 | 702 | 5,967 | $0.00126 | peak | 5 | 13.3 |
| csv-parser | tc | 3 | yes | 24,337 | 1,952 | 26,289 | $0.00434 | peak | 19 | 40.1 |

