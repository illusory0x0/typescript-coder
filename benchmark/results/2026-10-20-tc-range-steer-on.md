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
- generated: 2026-10-20T09:34:30.486Z
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
| json-parser | tc | 3/3 | 133 | 1,677 | 1,810 | $0.00207 | $0.00207 | 14.2 | 3.0 |
| sexp-parser | tc | 3/3 | 113 | 548 | 661 | $0.00071 | $0.00071 | 6.2 | 3.0 |
| minilisp | tc | 3/3 | 17,494 | 2,541 | 20,035 | $0.00832 | $0.00832 | 27.8 | 10.7 |
| csv-parser | tc | 3/3 | 10,115 | 2,516 | 12,631 | $0.00616 | $0.00616 | 39.0 | 21.3 |

## Overall comparison

| Side | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 12/12 | 6,964 | 1,821 | 8,784 | 105,409 | $0.00431 | $0.05178 | $0.00431 | 21.8 | 9.5 |

Per success (usage-run sums divided by successful runs):

| Side | In (no cache) | Out | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 6,964 | 1,821 | 8,784 | $0.00431 |

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
| sexp-parser | tc | 0 | 0 | 3 |
| minilisp | tc | 0 | 12 | 5 |
| csv-parser | tc | 0 | 23 | 8 |

| Side | range | matcher | whole-symbol |
| --- | ---: | ---: | ---: |
| tc | 0 | 35 | 19 |

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
| json-parser | tc | 1 | yes | 3,205 | 1,623 | 4,828 | $0.00201 | peak | 3 | 18.6 |
| json-parser | tc | 2 | yes | 3,205 | 1,613 | 4,818 | $0.00199 | peak | 3 | 11.9 |
| json-parser | tc | 3 | yes | 3,205 | 1,794 | 4,999 | $0.00221 | peak | 3 | 12.3 |
| sexp-parser | tc | 1 | yes | 2,673 | 525 | 3,198 | $0.00068 | peak | 3 | 6.4 |
| sexp-parser | tc | 2 | yes | 2,673 | 559 | 3,232 | $0.00072 | peak | 3 | 5.9 |
| sexp-parser | tc | 3 | yes | 2,673 | 559 | 3,232 | $0.00072 | peak | 3 | 6.4 |
| minilisp | tc | 1 | yes | 32,186 | 3,040 | 35,226 | $0.01206 | peak | 16 | 38.0 |
| minilisp | tc | 2 | yes | 21,382 | 2,427 | 23,809 | $0.00801 | peak | 9 | 26.2 |
| minilisp | tc | 3 | yes | 11,073 | 2,157 | 13,230 | $0.00489 | peak | 7 | 19.1 |
| csv-parser | tc | 1 | yes | 5,236 | 676 | 5,912 | $0.00099 | peak | 5 | 13.9 |
| csv-parser | tc | 2 | yes | 56,263 | 4,795 | 61,058 | $0.01228 | peak | 43 | 75.2 |
| csv-parser | tc | 3 | yes | 21,837 | 2,078 | 23,915 | $0.00521 | peak | 16 | 27.9 |

