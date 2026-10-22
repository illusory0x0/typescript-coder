# Benchmark report — 2026-10-22

- mode: full
- model: deepseek-v4.1-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: json (#119)
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp, csv-parser
- sides: tc
- reps: 3
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-22T08:02:32.721Z
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
| json-parser | tc | 3/3 | 858 | 1,628 | 2,487 | $0.00223 | $0.00223 | 234.5 | 3.0 |
| sexp-parser | tc | 3/3 | 2,432 | 741 | 3,173 | $0.00163 | $0.00163 | 87.7 | 4.0 |
| minilisp | tc | 3/3 | 30,630 | 6,885 | 37,515 | $0.01751 | $0.01751 | 87.7 | 11.3 |
| csv-parser | tc | 3/3 | 4,143 | 1,274 | 5,418 | $0.00279 | $0.00279 | 38.3 | 5.3 |

## Overall comparison

| Side | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 12/12 | 9,516 | 2,632 | 12,148 | 145,776 | $0.00604 | $0.07248 | $0.00604 | 112.0 | 5.9 |

Per success (usage-run sums divided by successful runs):

| Side | In (no cache) | Out | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 9,516 | 2,632 | 12,148 | $0.00604 |

Only one side ran: tc 12/12 (100.0%).

Token multiplier (cache-excluded): not comparable (both sides must run).

*Pricing footnote (decision-only):* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Selector adoption (#101)

Per task and side (payloads that used each selector):

| Task | Side | range | matcher | whole-symbol |
| --- | --- | ---: | ---: | ---: |
| json-parser | tc | 0 | 0 | 3 |
| sexp-parser | tc | 0 | 1 | 3 |
| minilisp | tc | 4 | 8 | 8 |
| csv-parser | tc | 1 | 1 | 5 |

| Side | range | matcher | whole-symbol |
| --- | ---: | ---: | ---: |
| tc | 5 | 10 | 19 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | whole-symbol | match | pick | snippet | regex |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | 3 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | 3 | 1 | 0 | 1 | 0 |
| minilisp | tc | 8 | 8 | 4 | 8 | 0 |
| csv-parser | tc | 5 | 1 | 1 | 1 | 0 |

| Side | whole-symbol | match | pick | snippet | regex |
| --- | ---: | ---: | ---: | ---: | ---: |
| tc | 19 | 10 | 5 | 10 | 0 |

Implicit creates (#111):

| Task | Side | creates |
| --- | --- | ---: |
| json-parser | tc | 0 |
| sexp-parser | tc | 0 |
| minilisp | tc | 0 |
| csv-parser | tc | 0 |

| Side | creates |
| --- | ---: |
| tc | 0 |

## Anomalies

Failing runs:

- none

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
| json-parser | tc | 1 | yes | 3,205 | 1,668 | 4,873 | $0.00255 | peak | 3 | 234.6 |
| json-parser | tc | 2 | yes | 3,205 | 1,599 | 4,804 | $0.00205 | peak | 3 | 234.4 |
| json-parser | tc | 3 | yes | 3,205 | 1,618 | 4,823 | $0.00208 | peak | 3 | 234.4 |
| sexp-parser | tc | 1 | yes | 4,743 | 1,096 | 5,839 | $0.00225 | peak | 4 | 238.6 |
| sexp-parser | tc | 2 | yes | 2,673 | 490 | 3,163 | $0.00105 | peak | 3 | 11.5 |
| sexp-parser | tc | 3 | yes | 4,489 | 636 | 5,125 | $0.00158 | peak | 5 | 12.9 |
| minilisp | tc | 1 | yes | 94,965 | 9,962 | 104,927 | $0.03375 | peak | 20 | 145.6 |
| minilisp | tc | 2 | yes | 3,658 | 1,978 | 5,636 | $0.00298 | peak | 3 | 14.7 |
| minilisp | tc | 3 | yes | 25,138 | 8,715 | 33,853 | $0.01582 | peak | 11 | 102.7 |
| csv-parser | tc | 1 | yes | 2,750 | 598 | 3,348 | $0.00075 | peak | 3 | 18.6 |
| csv-parser | tc | 2 | yes | 2,750 | 610 | 3,360 | $0.00077 | peak | 3 | 11.9 |
| csv-parser | tc | 3 | yes | 17,298 | 2,615 | 19,913 | $0.00686 | peak | 10 | 84.5 |

