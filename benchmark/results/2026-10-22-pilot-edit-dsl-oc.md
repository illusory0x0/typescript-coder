# Benchmark report — 2026-10-22

- mode: pilot
- model: deepseek-v4.1-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: edit-dsl (#119)
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp, csv-parser
- sides: tc, oc
- reps: 1
- bun: 1.3.13
- opencode: opencode v2.1.2
- generated: 2026-10-22T01:43:04.771Z
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
| json-parser | tc | 1/1 | 6,973 | 2,499 | 9,472 | $0.00512 | $0.00512 | 271.1 | 6.0 |
| json-parser | oc | 1/1 | 6,675 | 2,310 | 8,985 | $0.00496 | $0.00496 | 18.5 | 4.0 |
| sexp-parser | tc | 1/1 | 5,244 | 474 | 5,718 | $0.00216 | $0.00216 | 8.2 | 5.0 |
| sexp-parser | oc | 1/1 | 6,304 | 1,070 | 7,374 | $0.00334 | $0.00334 | 25.0 | 4.0 |
| minilisp | tc | 1/1 | 16,347 | 2,883 | 19,230 | $0.00849 | $0.00849 | 32.8 | 14.0 |
| minilisp | oc | 1/1 | 5,982 | 6,438 | 12,420 | $0.00984 | $0.00984 | 39.6 | 5.0 |
| csv-parser | tc | 1/1 | 3,359 | 417 | 3,776 | $0.00153 | $0.00153 | 6.9 | 4.0 |
| csv-parser | oc | 1/1 | 5,421 | 2,489 | 7,910 | $0.00480 | $0.00480 | 19.0 | 4.0 |

## Overall comparison

| Side | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 4/4 | 7,981 | 1,568 | 9,549 | 38,196 | $0.00432 | $0.01730 | $0.00432 | 79.8 | 7.3 |
| oc | 4/4 | 6,096 | 3,077 | 9,172 | 36,689 | $0.00573 | $0.02294 | $0.00573 | 25.5 | 4.3 |

Per success (usage-run sums divided by successful runs):

| Side | In (no cache) | Out | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 7,981 | 1,568 | 9,549 | $0.00432 |
| oc | 6,096 | 3,077 | 9,172 | $0.00573 |

Success rates are equal: tc 4/4 (100.0%) vs oc 4/4 (100.0%).

Token multiplier (cache-excluded total, higher/lower): tc 1.04x oc overall; json-parser tc 1.05x oc; sexp-parser oc 1.29x tc; minilisp tc 1.55x oc; csv-parser oc 2.09x tc.

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
| json-parser | tc | 0 | 0 | 1 |
| json-parser | oc | 0 | 0 | 0 |
| sexp-parser | tc | 0 | 0 | 1 |
| sexp-parser | oc | 0 | 0 | 0 |
| minilisp | tc | 0 | 0 | 6 |
| minilisp | oc | 0 | 0 | 0 |
| csv-parser | tc | 0 | 0 | 1 |
| csv-parser | oc | 0 | 0 | 0 |

| Side | range | matcher | whole-symbol |
| --- | ---: | ---: | ---: |
| tc | 0 | 0 | 9 |
| oc | 0 | 0 | 0 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | whole-symbol | match | pick | snippet | regex |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | 1 | 0 | 0 | 0 | 0 |
| json-parser | oc | 0 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | 1 | 0 | 0 | 0 | 0 |
| sexp-parser | oc | 0 | 0 | 0 | 0 | 0 |
| minilisp | tc | 6 | 0 | 0 | 0 | 0 |
| minilisp | oc | 0 | 0 | 0 | 0 | 0 |
| csv-parser | tc | 1 | 0 | 0 | 0 | 0 |
| csv-parser | oc | 0 | 0 | 0 | 0 | 0 |

| Side | whole-symbol | match | pick | snippet | regex |
| --- | ---: | ---: | ---: | ---: | ---: |
| tc | 9 | 0 | 0 | 0 | 0 |
| oc | 0 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | creates |
| --- | --- | ---: |
| json-parser | tc | 1 |
| json-parser | oc | 0 |
| sexp-parser | tc | 1 |
| sexp-parser | oc | 0 |
| minilisp | tc | 1 |
| minilisp | oc | 0 |
| csv-parser | tc | 1 |
| csv-parser | oc | 0 |

| Side | creates |
| --- | ---: |
| tc | 4 |
| oc | 0 |

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
| json-parser | tc | 1 | yes | 11,965 | 2,499 | 14,464 | $0.00512 | peak | 6 | 271.1 |
| json-parser | oc | 1 | yes | 6,675 | 2,011 | 8,985 | $0.00496 | peak | 4 | 18.5 |
| sexp-parser | tc | 1 | yes | 7,932 | 474 | 8,406 | $0.00216 | peak | 5 | 8.2 |
| sexp-parser | oc | 1 | yes | 6,304 | 968 | 7,374 | $0.00334 | peak | 4 | 25.0 |
| minilisp | tc | 1 | yes | 36,955 | 2,883 | 39,838 | $0.00849 | peak | 14 | 32.8 |
| minilisp | oc | 1 | yes | 5,982 | 2,555 | 12,420 | $0.00984 | peak | 5 | 39.6 |
| csv-parser | tc | 1 | yes | 6,943 | 417 | 7,360 | $0.00153 | peak | 4 | 6.9 |
| csv-parser | oc | 1 | yes | 5,421 | 1,097 | 7,910 | $0.00480 | peak | 4 | 19.0 |

