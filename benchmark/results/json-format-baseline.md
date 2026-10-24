# Benchmark report — 2026-10-24

- mode: full
- model: deepseek-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: json (#119)
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp, csv-parser
- sides: tc
- reps: 3
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-24T10:07:26.941Z
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

| Task | Side | Protocol | Success | Mean in (no cache) | Mean out | Mean total | Mean $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | json | 3/3 | 1,754 | 1,740 | 3,494 | $0.00131 | $0.00131 | 6.4 | 3.0 |
| sexp-parser | tc | json | 3/3 | 753 | 467 | 1,220 | $0.00040 | $0.00040 | 2.9 | 3.0 |
| minilisp | tc | json | 3/3 | 4,699 | 2,441 | 7,139 | $0.00218 | $0.00218 | 9.5 | 5.0 |
| csv-parser | tc | json | 3/3 | 2,094 | 887 | 2,981 | $0.00086 | $0.00086 | 5.2 | 5.7 |

## Overall comparison

| Side | Protocol | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | json | 12/12 | 2,325 | 1,384 | 3,709 | 44,504 | $0.00119 | $0.01425 | $0.00119 | 6.0 | 4.2 |

Per success (usage-run sums divided by successful runs):

| Side | Protocol | In (no cache) | Out | Total | Cost |
| --- | --- | ---: | ---: | ---: | ---: |
| tc | json | 2,325 | 1,384 | 3,709 | $0.00119 |

Only one side ran: tc 12/12 (100.0%).

Token multiplier (cache-excluded): not comparable (both sides must run).

## Savings vs oc baseline

Baseline: `benchmark/results/oc-baseline.json` (deepseek/deepseek-flash, 3 reps, 2026-10-24). A factor above 1 means tc uses that many times fewer cache-excluded tokens.

| Task | Protocol | oc baseline mean total | tc mean total | Savings (oc/tc) |
| --- | --- | ---: | ---: | ---: |
| json-parser | json | 8,129 | 3,494 | 2.33x |
| sexp-parser | json | 7,631 | 1,220 | 6.25x |
| minilisp | json | 12,807 | 7,139 | 1.79x |
| csv-parser | json | 7,101 | 2,981 | 2.38x |
| **all 4 tasks** | json | 35,668 | 14,835 | **2.40x** |

Savings vs oc baseline (cache-excluded total, oc/tc): json 2.40x fewer tokens across 4 tasks.

*Pricing footnote (decision-only):* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Selector adoption (#101)

Per task and side (payloads that used each selector):

| Task | Side | Protocol | range | matcher | whole-symbol |
| --- | --- | --- | ---: | ---: | ---: |
| json-parser | tc | json | 0 | 0 | 3 |
| sexp-parser | tc | json | 0 | 0 | 3 |
| minilisp | tc | json | 0 | 4 | 3 |
| csv-parser | tc | json | 0 | 3 | 4 |

| Side | Protocol | range | matcher | whole-symbol |
| --- | --- | ---: | ---: | ---: |
| tc | json | 0 | 7 | 13 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | Protocol | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | json | 3 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | json | 3 | 0 | 0 | 0 | 0 |
| minilisp | tc | json | 3 | 4 | 0 | 4 | 0 |
| csv-parser | tc | json | 4 | 3 | 0 | 3 | 0 |

| Side | Protocol | whole-symbol | match | pick | snippet | regex |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| tc | json | 13 | 7 | 0 | 7 | 0 |

Implicit creates (#111):

| Task | Side | Protocol | creates |
| --- | --- | --- | ---: |
| json-parser | tc | json | 0 |
| sexp-parser | tc | json | 0 |
| minilisp | tc | json | 0 |
| csv-parser | tc | json | 0 |

| Side | Protocol | creates |
| --- | --- | ---: |
| tc | json | 0 |

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

| Task | Side | Protocol | Rep | OK | Raw in | Raw out | Raw total | Cost | Rate | Steps | Dur (s) |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| json-parser | tc | json | 1 | yes | 3,205 | 1,769 | 4,974 | $0.00132 | off-peak | 3 | 6.9 |
| json-parser | tc | json | 2 | yes | 3,205 | 1,675 | 4,880 | $0.00128 | off-peak | 3 | 5.7 |
| json-parser | tc | json | 3 | yes | 3,205 | 1,776 | 4,981 | $0.00134 | off-peak | 3 | 6.4 |
| sexp-parser | tc | json | 1 | yes | 2,673 | 467 | 3,140 | $0.00051 | off-peak | 3 | 3.4 |
| sexp-parser | tc | json | 2 | yes | 2,673 | 467 | 3,140 | $0.00034 | off-peak | 3 | 2.8 |
| sexp-parser | tc | json | 3 | yes | 2,673 | 467 | 3,140 | $0.00034 | off-peak | 3 | 2.6 |
| minilisp | tc | json | 1 | yes | 3,658 | 1,949 | 5,607 | $0.00142 | off-peak | 3 | 7.0 |
| minilisp | tc | json | 2 | yes | 16,636 | 3,018 | 19,654 | $0.00363 | off-peak | 9 | 12.9 |
| minilisp | tc | json | 3 | yes | 3,658 | 2,355 | 6,013 | $0.00149 | off-peak | 3 | 8.6 |
| csv-parser | tc | json | 1 | yes | 5,273 | 699 | 5,972 | $0.00078 | off-peak | 5 | 4.1 |
| csv-parser | tc | json | 2 | yes | 5,223 | 678 | 5,901 | $0.00061 | off-peak | 5 | 4.8 |
| csv-parser | tc | json | 3 | yes | 8,329 | 1,285 | 9,614 | $0.00119 | off-peak | 7 | 6.8 |

