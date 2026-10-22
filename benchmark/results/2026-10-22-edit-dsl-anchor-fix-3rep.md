# Benchmark report — 2026-10-22

- mode: full
- model: deepseek-v4.1-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: edit-dsl (#119)
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp, csv-parser
- sides: tc
- reps: 3
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-22T03:03:38.808Z
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
| json-parser | tc | 3/3 | 7,254 | 4,205 | 11,459 | $0.00727 | $0.00727 | 40.1 | 6.7 |
| sexp-parser | tc | 3/3 | 3,978 | 745 | 4,723 | $0.00211 | $0.00211 | 18.8 | 4.7 |
| minilisp | tc | 1/3 | 29,280 | 17,383 | 46,663 | $0.02990 | $0.08971 | 121.8 | 21.7 |
| csv-parser | tc | 3/3 | 5,685 | 1,162 | 6,847 | $0.00315 | $0.00315 | 19.0 | 8.0 |

## Overall comparison

| Side | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 10/12 | 11,549 | 5,874 | 17,423 | 209,076 | $0.01061 | $0.12732 | $0.01273 | 49.9 | 10.3 |

Per success (usage-run sums divided by successful runs):

| Side | In (no cache) | Out | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 13,859 | 7,049 | 20,908 | $0.01273 |

Only one side ran: tc 10/12 (83.3%).

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
| json-parser | tc | 0 | 0 | 4 |
| sexp-parser | tc | 0 | 0 | 3 |
| minilisp | tc | 0 | 4 | 10 |
| csv-parser | tc | 0 | 1 | 5 |

| Side | range | matcher | whole-symbol |
| --- | ---: | ---: | ---: |
| tc | 0 | 5 | 22 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | whole-symbol | match | pick | snippet | regex |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | 4 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | 3 | 0 | 0 | 0 | 0 |
| minilisp | tc | 10 | 4 | 0 | 3 | 1 |
| csv-parser | tc | 5 | 1 | 0 | 1 | 0 |

| Side | whole-symbol | match | pick | snippet | regex |
| --- | ---: | ---: | ---: | ---: | ---: |
| tc | 22 | 5 | 0 | 4 | 1 |

Implicit creates (#111):

| Task | Side | creates |
| --- | --- | ---: |
| json-parser | tc | 8 |
| sexp-parser | tc | 7 |
| minilisp | tc | 29 |
| csv-parser | tc | 3 |

| Side | creates |
| --- | ---: |
| tc | 47 |

## Anomalies

Failing runs:

- minilisp tc rep1: token-budget: accumulated 122955 tokens exceeded the 120000 token budget
- minilisp tc rep2: token-budget: accumulated 124314 tokens exceeded the 120000 token budget

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
| json-parser | tc | 1 | yes | 13,669 | 4,138 | 17,807 | $0.00730 | peak | 6 | 37.2 |
| json-parser | tc | 2 | yes | 11,137 | 3,016 | 14,153 | $0.00549 | peak | 5 | 31.6 |
| json-parser | tc | 3 | yes | 21,020 | 5,461 | 26,481 | $0.00902 | peak | 9 | 51.4 |
| sexp-parser | tc | 1 | yes | 6,643 | 389 | 7,032 | $0.00171 | peak | 4 | 19.6 |
| sexp-parser | tc | 2 | yes | 6,233 | 435 | 6,668 | $0.00126 | peak | 4 | 15.5 |
| sexp-parser | tc | 3 | yes | 11,346 | 1,411 | 12,757 | $0.00337 | peak | 6 | 21.3 |
| minilisp | tc | 1 | no | 86,688 | 39,854 | 126,542 | $0.05733 | peak | 28 | 234.7 |
| minilisp | tc | 2 | no | 121,255 | 10,177 | 131,432 | $0.02884 | peak | 33 | 120.6 |
| minilisp | tc | 3 | yes | 9,690 | 1,848 | 11,538 | $0.00354 | peak | 4 | 9.9 |
| csv-parser | tc | 1 | yes | 17,238 | 1,572 | 18,810 | $0.00405 | peak | 9 | 23.3 |
| csv-parser | tc | 2 | yes | 17,204 | 1,336 | 18,540 | $0.00349 | peak | 9 | 21.6 |
| csv-parser | tc | 3 | yes | 10,004 | 579 | 10,583 | $0.00193 | peak | 6 | 12.2 |

