# Benchmark report — 2026-10-24

- mode: full
- model: deepseek-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: edit-dsl (#119)
- agent modes: edit, plan-exec
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp, csv-parser
- sides: tc
- reps: 5
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-24T13:11:47.214Z
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

## Cache warm-up

Only the cache-stable system prefixes were warmed; task-specific user prompts were not. These calls are excluded from every measured token/cost table.

| Agent mode | Prefix | Prompt chars | Raw in | Cache read | Cache hit | Duration (s) | Error |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| edit | edit | 6401 | n/a | n/a | n/a | 1.9 | none |
| plan-exec | planning | 1900 | n/a | n/a | n/a | 0.6 | none |
| plan-exec | execution | 1721 | n/a | n/a | n/a | 0.6 | none |

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

| Task | Side | Protocol | Agent mode | Success | Mean in (no cache) | Cache hit | Mean out | Mean total | Mean $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | edit-dsl | edit | 5/5 | 3,801 | 66.5% | 1,498 | 5,299 | $0.00149 | $0.00149 | 6.8 | 4.0 |
| json-parser | tc | edit-dsl | plan-exec | 4/5 | 11,009 | 73.6% | 3,724 | 14,733 | $0.00399 | $0.00499 | 28.4 | 15.2 |
| sexp-parser | tc | edit-dsl | edit | 5/5 | 2,127 | 76.1% | 424 | 2,551 | $0.00059 | $0.00059 | 3.8 | 5.2 |
| sexp-parser | tc | edit-dsl | plan-exec | 5/5 | 6,544 | 75.2% | 2,009 | 8,553 | $0.00225 | $0.00225 | 17.2 | 12.2 |
| minilisp | tc | edit-dsl | edit | 3/5 | 35,139 | 58.0% | 7,950 | 43,089 | $0.01019 | $0.01698 | 37.8 | 19.4 |
| minilisp | tc | edit-dsl | plan-exec | 0/5 | 34,914 | 71.8% | 9,384 | 44,299 | $0.01113 | n/a | 55.1 | 21.8 |
| csv-parser | tc | edit-dsl | edit | 5/5 | 6,000 | 73.0% | 734 | 6,734 | $0.00138 | $0.00138 | 6.8 | 7.8 |
| csv-parser | tc | edit-dsl | plan-exec | 4/5 | 12,317 | 77.1% | 6,277 | 18,594 | $0.00573 | $0.00716 | 31.6 | 11.8 |

## Overall comparison

| Side | Protocol | Agent mode | Success | Mean in (no cache) | Cache hit | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | edit | 18/20 | 11,767 | 68.4% | 2,651 | 14,418 | 288,361 | $0.00341 | $0.06827 | $0.00379 | 13.8 | 9.1 |
| tc | edit-dsl | plan-exec | 13/20 | 16,196 | 74.4% | 5,349 | 21,545 | 430,893 | $0.00578 | $0.11552 | $0.00889 | 33.0 | 15.3 |

Per success (usage-run sums divided by successful runs):

| Side | Protocol | Agent mode | In (no cache) | Out | Total | Cost |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| tc | edit-dsl | edit | 13,074 | 2,946 | 16,020 | $0.00379 |
| tc | edit-dsl | plan-exec | 24,917 | 8,229 | 33,146 | $0.00889 |

## Cache hit balance

Cache hit = cacheRead / raw prompt tokens (tc input includes hits; oc input excludes them).

| Side | Protocol | Agent mode | Cache hit | Cache-read tokens |
| --- | --- | --- | ---: | ---: |
| tc | edit-dsl | edit | 68.4% | 19,213 |
| tc | edit-dsl | plan-exec | 74.4% | 45,888 |

Success rates differ: tc edit 18/20 (90.0%) vs tc plan-exec 13/20 (65.0%).

Token multiplier (cache-excluded): not comparable (both sides must run).

## Four-way comparison (oc / tc json / tc edit / tc plan-exec)

Baselines: oc `benchmark/results/oc-baseline.json` (deepseek/deepseek-flash, 3 reps, 2026-10-24); tc json `benchmark/results/json-format-baseline.json` (deepseek-flash, 3 reps, 2026-10-24).
Factor = baseline mean / variant mean; above 1 means the variant used that many times fewer cache-excluded tokens.

| Task | Variant | Mean total | Cache hit | vs oc baseline | vs tc json baseline |
| --- | --- | ---: | ---: | ---: | ---: |
| json-parser | oc baseline | 8,129 | n/a | 1.00x | 0.43x |
| json-parser | tc json baseline | 3,494 | n/a | 2.33x | 1.00x |
| json-parser | tc edit | 5,299 | 66.5% | 1.53x | 0.66x |
| json-parser | tc plan-exec | 14,733 | 73.6% | 0.55x | 0.24x |
| sexp-parser | oc baseline | 7,631 | n/a | 1.00x | 0.16x |
| sexp-parser | tc json baseline | 1,220 | n/a | 6.25x | 1.00x |
| sexp-parser | tc edit | 2,551 | 76.1% | 2.99x | 0.48x |
| sexp-parser | tc plan-exec | 8,553 | 75.2% | 0.89x | 0.14x |
| minilisp | oc baseline | 12,807 | n/a | 1.00x | 0.56x |
| minilisp | tc json baseline | 7,139 | n/a | 1.79x | 1.00x |
| minilisp | tc edit | 43,089 | 58.0% | 0.30x | 0.17x |
| minilisp | tc plan-exec | 44,299 | 71.8% | 0.29x | 0.16x |
| csv-parser | oc baseline | 7,101 | n/a | 1.00x | 0.42x |
| csv-parser | tc json baseline | 2,981 | n/a | 2.38x | 1.00x |
| csv-parser | tc edit | 6,734 | 73.0% | 1.05x | 0.44x |
| csv-parser | tc plan-exec | 18,594 | 77.1% | 0.38x | 0.16x |
| **all 4 tasks** | oc baseline | 35,668 | n/a | 1.00x | 0.42x |
| **all 4 tasks** | tc json baseline | 14,835 | n/a | 2.40x | 1.00x |
| **all 4 tasks** | tc edit | 57,672 | 68.4% | 0.62x | 0.26x |
| **all 4 tasks** | tc plan-exec | 86,179 | 74.4% | 0.41x | 0.17x |

Four-way savings (cache-excluded total): vs oc — tc edit 0.62x, tc plan-exec 0.41x; vs tc json — tc edit 0.26x, tc plan-exec 0.17x.

*Pricing footnote (decision-only):* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Selector adoption (#101)

Per task and side (payloads that used each selector):

| Task | Side | Protocol | Agent mode | range | matcher | whole-symbol |
| --- | --- | --- | --- | ---: | ---: | ---: |
| json-parser | tc | edit-dsl | edit | 0 | 0 | 5 |
| json-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 |
| sexp-parser | tc | edit-dsl | edit | 0 | 0 | 5 |
| sexp-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 |
| minilisp | tc | edit-dsl | edit | 0 | 2 | 17 |
| minilisp | tc | edit-dsl | plan-exec | 0 | 0 | 0 |
| csv-parser | tc | edit-dsl | edit | 0 | 4 | 7 |
| csv-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 |

| Side | Protocol | Agent mode | range | matcher | whole-symbol |
| --- | --- | --- | ---: | ---: | ---: |
| tc | edit-dsl | edit | 0 | 6 | 34 |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | edit-dsl | edit | 5 | 0 | 0 | 0 | 0 |
| json-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | edit-dsl | edit | 5 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| minilisp | tc | edit-dsl | edit | 17 | 2 | 0 | 2 | 0 |
| minilisp | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| csv-parser | tc | edit-dsl | edit | 7 | 4 | 0 | 4 | 0 |
| csv-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

| Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | edit | 34 | 6 | 0 | 6 | 0 |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | Protocol | Agent mode | creates |
| --- | --- | --- | --- | ---: |
| json-parser | tc | edit-dsl | edit | 5 |
| json-parser | tc | edit-dsl | plan-exec | 0 |
| sexp-parser | tc | edit-dsl | edit | 5 |
| sexp-parser | tc | edit-dsl | plan-exec | 0 |
| minilisp | tc | edit-dsl | edit | 5 |
| minilisp | tc | edit-dsl | plan-exec | 0 |
| csv-parser | tc | edit-dsl | edit | 5 |
| csv-parser | tc | edit-dsl | plan-exec | 0 |

| Side | Protocol | Agent mode | creates |
| --- | --- | --- | ---: |
| tc | edit-dsl | edit | 20 |
| tc | edit-dsl | plan-exec | 0 |

## Anomalies

Failing runs:

- json-parser tc rep4: task-exhausted: the planner produced no valid plan after 3 attempts stage: task-dag - #1 is failed; retrying it requires a changed definition (a different loc, ...
- minilisp tc rep1: task-exhausted: the planner produced no valid plan after 3 attempts stage: task-dag - #1 is failed; retrying it requires a changed definition (a different loc, ...
- minilisp tc rep2: token-budget: accumulated 120296 tokens exceeded the 120000 token budget
- minilisp tc rep2: token-budget: accumulated 123261 tokens exceeded the 120000 token budget
- minilisp tc rep3: token-budget: accumulated 126049 tokens exceeded the 120000 token budget
- minilisp tc rep4: token-budget: accumulated 122900 tokens exceeded the 120000 token budget
- minilisp tc rep4: token-budget: accumulated 128766 tokens exceeded the 120000 token budget
- minilisp tc rep5: token-budget: accumulated 120209 tokens exceeded the 120000 token budget
- csv-parser tc rep5: task-exhausted: the planner returned the same DAG after a failure or a failing suite; no progress is possible

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

| Task | Side | Protocol | Agent mode | Rep | OK | Raw in | Raw out | Raw total | Cost | Rate | Steps | Dur (s) |
| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| json-parser | tc | edit-dsl | edit | 1 | yes | 11,406 | 1,614 | 13,020 | $0.00196 | off-peak | 4 | 7.1 |
| json-parser | tc | edit-dsl | plan-exec | 1 | yes | 15,082 | 2,234 | 17,316 | $0.00210 | off-peak | 9 | 13.3 |
| json-parser | tc | edit-dsl | edit | 2 | yes | 11,362 | 1,570 | 12,932 | $0.00193 | off-peak | 4 | 7.2 |
| json-parser | tc | edit-dsl | plan-exec | 2 | yes | 39,836 | 4,593 | 44,429 | $0.00423 | off-peak | 15 | 29.3 |
| json-parser | tc | edit-dsl | edit | 3 | yes | 11,055 | 1,206 | 12,261 | $0.00103 | off-peak | 4 | 5.6 |
| json-parser | tc | edit-dsl | plan-exec | 3 | yes | 59,079 | 4,382 | 63,461 | $0.00477 | off-peak | 22 | 37.7 |
| json-parser | tc | edit-dsl | edit | 4 | yes | 11,372 | 1,580 | 12,952 | $0.00130 | off-peak | 4 | 6.6 |
| json-parser | tc | edit-dsl | plan-exec | 4 | no | 105,165 | 4,641 | 109,806 | $0.00696 | off-peak | 25 | 50.1 |
| json-parser | tc | edit-dsl | edit | 5 | yes | 11,312 | 1,520 | 12,832 | $0.00124 | off-peak | 4 | 7.3 |
| json-parser | tc | edit-dsl | plan-exec | 5 | yes | 6,764 | 2,595 | 9,359 | $0.00188 | off-peak | 5 | 11.5 |
| sexp-parser | tc | edit-dsl | edit | 1 | yes | 9,184 | 419 | 9,603 | $0.00080 | off-peak | 4 | 3.6 |
| sexp-parser | tc | edit-dsl | plan-exec | 1 | yes | 8,856 | 1,348 | 10,204 | $0.00131 | off-peak | 7 | 8.9 |
| sexp-parser | tc | edit-dsl | edit | 2 | yes | 8,665 | 408 | 9,073 | $0.00060 | off-peak | 6 | 3.8 |
| sexp-parser | tc | edit-dsl | plan-exec | 2 | yes | 17,831 | 1,153 | 18,984 | $0.00128 | off-peak | 9 | 10.5 |
| sexp-parser | tc | edit-dsl | edit | 3 | yes | 9,134 | 369 | 9,503 | $0.00039 | off-peak | 4 | 3.8 |
| sexp-parser | tc | edit-dsl | plan-exec | 3 | yes | 37,548 | 2,274 | 39,822 | $0.00261 | off-peak | 15 | 21.3 |
| sexp-parser | tc | edit-dsl | edit | 4 | yes | 8,665 | 408 | 9,073 | $0.00051 | off-peak | 6 | 3.9 |
| sexp-parser | tc | edit-dsl | plan-exec | 4 | yes | 38,785 | 2,653 | 41,438 | $0.00304 | off-peak | 15 | 23.1 |
| sexp-parser | tc | edit-dsl | edit | 5 | yes | 8,779 | 515 | 9,294 | $0.00067 | off-peak | 6 | 4.0 |
| sexp-parser | tc | edit-dsl | plan-exec | 5 | yes | 38,883 | 2,619 | 41,502 | $0.00302 | off-peak | 15 | 21.9 |
| minilisp | tc | edit-dsl | edit | 1 | yes | 81,317 | 9,731 | 91,048 | $0.01185 | off-peak | 20 | 41.2 |
| minilisp | tc | edit-dsl | plan-exec | 1 | no | 106,585 | 5,351 | 111,936 | $0.00768 | off-peak | 20 | 45.9 |
| minilisp | tc | edit-dsl | edit | 2 | no | 119,995 | 5,887 | 125,882 | $0.01085 | off-peak | 25 | 39.2 |
| minilisp | tc | edit-dsl | plan-exec | 2 | no | 127,785 | 9,579 | 137,364 | $0.01178 | off-peak | 24 | 58.5 |
| minilisp | tc | edit-dsl | edit | 3 | yes | 64,803 | 9,836 | 74,639 | $0.00986 | off-peak | 15 | 38.9 |
| minilisp | tc | edit-dsl | plan-exec | 3 | no | 132,258 | 8,900 | 141,158 | $0.01178 | off-peak | 23 | 52.0 |
| minilisp | tc | edit-dsl | edit | 4 | no | 120,190 | 8,198 | 128,388 | $0.01251 | off-peak | 27 | 46.6 |
| minilisp | tc | edit-dsl | plan-exec | 4 | no | 131,689 | 11,153 | 142,842 | $0.01274 | off-peak | 21 | 59.8 |
| minilisp | tc | edit-dsl | edit | 5 | yes | 35,789 | 5,885 | 41,674 | $0.00587 | off-peak | 10 | 23.2 |
| minilisp | tc | edit-dsl | plan-exec | 5 | no | 119,007 | 11,301 | 130,308 | $0.01169 | off-peak | 21 | 59.4 |
| csv-parser | tc | edit-dsl | edit | 1 | yes | 37,603 | 1,048 | 38,651 | $0.00296 | off-peak | 15 | 11.4 |
| csv-parser | tc | edit-dsl | plan-exec | 1 | yes | 43,391 | 5,960 | 49,351 | $0.00499 | off-peak | 13 | 30.2 |
| csv-parser | tc | edit-dsl | edit | 2 | yes | 9,488 | 458 | 9,946 | $0.00076 | off-peak | 4 | 3.9 |
| csv-parser | tc | edit-dsl | plan-exec | 2 | yes | 27,859 | 3,699 | 31,558 | $0.00318 | off-peak | 8 | 20.3 |
| csv-parser | tc | edit-dsl | edit | 3 | yes | 17,983 | 579 | 18,562 | $0.00109 | off-peak | 7 | 6.1 |
| csv-parser | tc | edit-dsl | plan-exec | 3 | yes | 57,005 | 5,902 | 62,907 | $0.00553 | off-peak | 13 | 31.9 |
| csv-parser | tc | edit-dsl | edit | 4 | yes | 9,488 | 458 | 9,946 | $0.00040 | off-peak | 4 | 3.9 |
| csv-parser | tc | edit-dsl | plan-exec | 4 | yes | 51,476 | 6,797 | 58,273 | $0.00565 | off-peak | 14 | 33.9 |
| csv-parser | tc | edit-dsl | edit | 5 | yes | 21,999 | 1,127 | 23,126 | $0.00170 | off-peak | 9 | 8.6 |
| csv-parser | tc | edit-dsl | plan-exec | 5 | no | 76,798 | 9,019 | 85,817 | $0.00931 | off-peak | 11 | 41.4 |

