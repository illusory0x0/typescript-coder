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
- generated: 2026-10-24T13:19:47.066Z
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
| edit | edit | 6401 | n/a | n/a | n/a | 1.0 | none |
| plan-exec | planning | 1900 | n/a | n/a | n/a | 1.1 | none |
| plan-exec | execution | 1721 | n/a | n/a | n/a | 0.9 | none |

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
| json-parser | tc | edit-dsl | edit | 5/5 | 1,633 | 85.6% | 1,506 | 3,139 | $0.00118 | $0.00118 | 6.8 | 4.0 |
| json-parser | tc | edit-dsl | plan-exec | 5/5 | 1,551 | 64.3% | 2,016 | 3,567 | $0.00145 | $0.00145 | 9.1 | 5.0 |
| sexp-parser | tc | edit-dsl | edit | 5/5 | 2,281 | 74.0% | 518 | 2,798 | $0.00067 | $0.00067 | 4.2 | 6.0 |
| sexp-parser | tc | edit-dsl | plan-exec | 5/5 | 1,578 | 61.6% | 942 | 2,520 | $0.00081 | $0.00081 | 6.4 | 5.0 |
| minilisp | tc | edit-dsl | edit | 4/5 | 15,949 | 64.6% | 2,570 | 18,519 | $0.00401 | $0.00501 | 16.8 | 11.0 |
| minilisp | tc | edit-dsl | plan-exec | 1/5 | 32,796 | 72.4% | 11,869 | 44,665 | $0.01229 | $0.06146 | 58.6 | 18.4 |
| csv-parser | tc | edit-dsl | edit | 5/5 | 2,120 | 86.0% | 502 | 2,623 | $0.00065 | $0.00065 | 5.2 | 5.2 |
| csv-parser | tc | edit-dsl | plan-exec | 5/5 | 1,189 | 54.3% | 939 | 2,128 | $0.00075 | $0.00075 | 5.4 | 3.0 |

## Overall comparison

| Side | Protocol | Agent mode | Success | Mean in (no cache) | Cache hit | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | edit | 19/20 | 5,496 | 77.5% | 1,274 | 6,770 | 135,391 | $0.00163 | $0.03255 | $0.00171 | 8.3 | 6.5 |
| tc | edit-dsl | plan-exec | 16/20 | 9,279 | 63.2% | 3,942 | 13,220 | 264,405 | $0.00382 | $0.07650 | $0.00478 | 19.9 | 7.8 |

Per success (usage-run sums divided by successful runs):

| Side | Protocol | Agent mode | In (no cache) | Out | Total | Cost |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| tc | edit-dsl | edit | 5,785 | 1,341 | 7,126 | $0.00171 |
| tc | edit-dsl | plan-exec | 11,598 | 4,927 | 16,525 | $0.00478 |

## Cache hit balance

Cache hit = cacheRead / raw prompt tokens (tc input includes hits; oc input excludes them).

| Side | Protocol | Agent mode | Cache hit | Cache-read tokens |
| --- | --- | --- | ---: | ---: |
| tc | edit-dsl | edit | 77.5% | 13,018 |
| tc | edit-dsl | plan-exec | 63.2% | 22,694 |

> **Cache warning:** cache hit rates span json-parser: 64.3%–85.6% (21 points); csv-parser: 54.3%–86.0% (32 points) across variants; billable token means may be distorted by cold-cache runs. Warm the stable prefix and repeat before comparing.

Success rates differ: tc edit 19/20 (95.0%) vs tc plan-exec 16/20 (80.0%).

Token multiplier (cache-excluded): not comparable (both sides must run).

## Four-way comparison (oc / tc json / tc edit / tc plan-exec)

Baselines: oc `benchmark/results/oc-baseline.json` (deepseek/deepseek-flash, 3 reps, 2026-10-24); tc json `benchmark/results/json-format-baseline.json` (deepseek-flash, 3 reps, 2026-10-24).
Factor = baseline mean / variant mean; above 1 means the variant used that many times fewer cache-excluded tokens.

| Task | Variant | Mean total | Cache hit | vs oc baseline | vs tc json baseline |
| --- | --- | ---: | ---: | ---: | ---: |
| json-parser | oc baseline | 8,129 | n/a | 1.00x | 0.43x |
| json-parser | tc json baseline | 3,494 | n/a | 2.33x | 1.00x |
| json-parser | tc edit | 3,139 | 85.6% | 2.59x | 1.11x |
| json-parser | tc plan-exec | 3,567 | 64.3% | 2.28x | 0.98x |
| sexp-parser | oc baseline | 7,631 | n/a | 1.00x | 0.16x |
| sexp-parser | tc json baseline | 1,220 | n/a | 6.25x | 1.00x |
| sexp-parser | tc edit | 2,798 | 74.0% | 2.73x | 0.44x |
| sexp-parser | tc plan-exec | 2,520 | 61.6% | 3.03x | 0.48x |
| minilisp | oc baseline | 12,807 | n/a | 1.00x | 0.56x |
| minilisp | tc json baseline | 7,139 | n/a | 1.79x | 1.00x |
| minilisp | tc edit | 18,519 | 64.6% | 0.69x | 0.39x |
| minilisp | tc plan-exec | 44,665 | 72.4% | 0.29x | 0.16x |
| csv-parser | oc baseline | 7,101 | n/a | 1.00x | 0.42x |
| csv-parser | tc json baseline | 2,981 | n/a | 2.38x | 1.00x |
| csv-parser | tc edit | 2,623 | 86.0% | 2.71x | 1.14x |
| csv-parser | tc plan-exec | 2,128 | 54.3% | 3.34x | 1.40x |
| **all 4 tasks** | oc baseline | 35,668 | n/a | 1.00x | 0.42x |
| **all 4 tasks** | tc json baseline | 14,835 | n/a | 2.40x | 1.00x |
| **all 4 tasks** | tc edit | 27,078 | 77.5% | 1.32x | 0.55x |
| **all 4 tasks** | tc plan-exec | 52,881 | 63.2% | 0.67x | 0.28x |

Four-way savings (cache-excluded total): vs oc — tc edit 1.32x, tc plan-exec 0.67x; vs tc json — tc edit 0.55x, tc plan-exec 0.28x.

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
| minilisp | tc | edit-dsl | edit | 0 | 6 | 8 |
| minilisp | tc | edit-dsl | plan-exec | 0 | 0 | 0 |
| csv-parser | tc | edit-dsl | edit | 0 | 2 | 5 |
| csv-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 |

| Side | Protocol | Agent mode | range | matcher | whole-symbol |
| --- | --- | --- | ---: | ---: | ---: |
| tc | edit-dsl | edit | 0 | 8 | 23 |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | edit-dsl | edit | 5 | 0 | 0 | 0 | 0 |
| json-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | edit-dsl | edit | 5 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| minilisp | tc | edit-dsl | edit | 8 | 6 | 0 | 6 | 0 |
| minilisp | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| csv-parser | tc | edit-dsl | edit | 5 | 2 | 0 | 2 | 0 |
| csv-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

| Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | edit | 23 | 8 | 0 | 8 | 0 |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | Protocol | Agent mode | creates |
| --- | --- | --- | --- | ---: |
| json-parser | tc | edit-dsl | edit | 5 |
| json-parser | tc | edit-dsl | plan-exec | 0 |
| sexp-parser | tc | edit-dsl | edit | 5 |
| sexp-parser | tc | edit-dsl | plan-exec | 0 |
| minilisp | tc | edit-dsl | edit | 6 |
| minilisp | tc | edit-dsl | plan-exec | 0 |
| csv-parser | tc | edit-dsl | edit | 5 |
| csv-parser | tc | edit-dsl | plan-exec | 0 |

| Side | Protocol | Agent mode | creates |
| --- | --- | --- | ---: |
| tc | edit-dsl | edit | 21 |
| tc | edit-dsl | plan-exec | 0 |

## Anomalies

Failing runs:

- minilisp tc rep1: token-budget: accumulated 120145 tokens exceeded the 120000 token budget
- minilisp tc rep2: token-budget: accumulated 125742 tokens exceeded the 120000 token budget
- minilisp tc rep4: token-budget: accumulated 122803 tokens exceeded the 120000 token budget
- minilisp tc rep5: token-budget: accumulated 121491 tokens exceeded the 120000 token budget
- minilisp tc rep5: token-budget: accumulated 121918 tokens exceeded the 120000 token budget

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
| json-parser | tc | edit-dsl | edit | 1 | yes | 11,376 | 1,584 | 12,960 | $0.00115 | off-peak | 4 | 6.7 |
| json-parser | tc | edit-dsl | plan-exec | 1 | yes | 4,454 | 1,927 | 6,381 | $0.00139 | off-peak | 5 | 8.8 |
| json-parser | tc | edit-dsl | edit | 2 | yes | 11,313 | 1,521 | 12,834 | $0.00116 | off-peak | 4 | 6.9 |
| json-parser | tc | edit-dsl | plan-exec | 2 | yes | 4,027 | 1,917 | 5,944 | $0.00136 | off-peak | 5 | 8.8 |
| json-parser | tc | edit-dsl | edit | 3 | yes | 11,445 | 1,653 | 13,098 | $0.00135 | off-peak | 4 | 7.1 |
| json-parser | tc | edit-dsl | plan-exec | 3 | yes | 4,198 | 2,052 | 6,250 | $0.00148 | off-peak | 5 | 9.1 |
| json-parser | tc | edit-dsl | edit | 4 | yes | 11,083 | 1,234 | 12,317 | $0.00105 | off-peak | 4 | 6.1 |
| json-parser | tc | edit-dsl | plan-exec | 4 | yes | 4,552 | 2,112 | 6,664 | $0.00152 | off-peak | 5 | 10.1 |
| json-parser | tc | edit-dsl | edit | 5 | yes | 11,330 | 1,538 | 12,868 | $0.00117 | off-peak | 4 | 7.4 |
| json-parser | tc | edit-dsl | plan-exec | 5 | yes | 4,478 | 2,072 | 6,550 | $0.00150 | off-peak | 5 | 8.8 |
| sexp-parser | tc | edit-dsl | edit | 1 | yes | 8,764 | 499 | 9,263 | $0.00067 | off-peak | 6 | 4.5 |
| sexp-parser | tc | edit-dsl | plan-exec | 1 | yes | 3,956 | 889 | 4,845 | $0.00077 | off-peak | 5 | 5.9 |
| sexp-parser | tc | edit-dsl | edit | 2 | yes | 8,763 | 498 | 9,261 | $0.00065 | off-peak | 6 | 3.6 |
| sexp-parser | tc | edit-dsl | plan-exec | 2 | yes | 4,141 | 949 | 5,090 | $0.00081 | off-peak | 5 | 7.5 |
| sexp-parser | tc | edit-dsl | edit | 3 | yes | 8,850 | 584 | 9,434 | $0.00072 | off-peak | 6 | 4.3 |
| sexp-parser | tc | edit-dsl | plan-exec | 3 | yes | 3,985 | 931 | 4,916 | $0.00080 | off-peak | 5 | 6.3 |
| sexp-parser | tc | edit-dsl | edit | 4 | yes | 8,762 | 497 | 9,259 | $0.00065 | off-peak | 6 | 4.5 |
| sexp-parser | tc | edit-dsl | plan-exec | 4 | yes | 4,223 | 974 | 5,197 | $0.00084 | off-peak | 5 | 6.5 |
| sexp-parser | tc | edit-dsl | edit | 5 | yes | 8,776 | 511 | 9,287 | $0.00066 | off-peak | 6 | 4.1 |
| sexp-parser | tc | edit-dsl | plan-exec | 5 | yes | 4,257 | 967 | 5,224 | $0.00082 | off-peak | 5 | 5.6 |
| minilisp | tc | edit-dsl | edit | 1 | yes | 18,377 | 1,670 | 20,047 | $0.00193 | off-peak | 7 | 9.8 |
| minilisp | tc | edit-dsl | plan-exec | 1 | no | 111,506 | 19,084 | 130,590 | $0.01558 | off-peak | 14 | 74.9 |
| minilisp | tc | edit-dsl | edit | 2 | yes | 18,433 | 1,687 | 20,120 | $0.00193 | off-peak | 7 | 10.2 |
| minilisp | tc | edit-dsl | plan-exec | 2 | no | 126,843 | 10,031 | 136,874 | $0.01314 | off-peak | 15 | 48.4 |
| minilisp | tc | edit-dsl | edit | 3 | yes | 18,339 | 1,647 | 19,986 | $0.00191 | off-peak | 7 | 9.4 |
| minilisp | tc | edit-dsl | plan-exec | 3 | yes | 94,056 | 13,542 | 107,598 | $0.01134 | off-peak | 20 | 57.5 |
| minilisp | tc | edit-dsl | edit | 4 | yes | 27,279 | 3,026 | 30,305 | $0.00346 | off-peak | 8 | 15.1 |
| minilisp | tc | edit-dsl | plan-exec | 4 | no | 124,572 | 8,871 | 133,443 | $0.01097 | off-peak | 20 | 55.0 |
| minilisp | tc | edit-dsl | edit | 5 | no | 123,909 | 4,664 | 128,573 | $0.01081 | off-peak | 26 | 39.7 |
| minilisp | tc | edit-dsl | plan-exec | 5 | no | 127,229 | 7,532 | 134,761 | $0.01043 | off-peak | 23 | 57.2 |
| csv-parser | tc | edit-dsl | edit | 1 | yes | 17,500 | 560 | 18,060 | $0.00102 | off-peak | 7 | 6.6 |
| csv-parser | tc | edit-dsl | plan-exec | 1 | yes | 2,735 | 1,034 | 3,769 | $0.00082 | off-peak | 3 | 5.6 |
| csv-parser | tc | edit-dsl | edit | 2 | yes | 9,488 | 458 | 9,946 | $0.00040 | off-peak | 4 | 4.2 |
| csv-parser | tc | edit-dsl | plan-exec | 2 | yes | 2,427 | 859 | 3,286 | $0.00067 | off-peak | 3 | 4.5 |
| csv-parser | tc | edit-dsl | edit | 3 | yes | 9,488 | 458 | 9,946 | $0.00040 | off-peak | 4 | 3.6 |
| csv-parser | tc | edit-dsl | plan-exec | 3 | yes | 2,653 | 1,009 | 3,662 | $0.00080 | off-peak | 3 | 6.1 |
| csv-parser | tc | edit-dsl | edit | 4 | yes | 9,488 | 458 | 9,946 | $0.00040 | off-peak | 4 | 4.1 |
| csv-parser | tc | edit-dsl | plan-exec | 4 | yes | 2,585 | 956 | 3,541 | $0.00075 | off-peak | 3 | 5.8 |
| csv-parser | tc | edit-dsl | edit | 5 | yes | 17,502 | 577 | 18,079 | $0.00103 | off-peak | 7 | 7.5 |
| csv-parser | tc | edit-dsl | plan-exec | 5 | yes | 2,585 | 838 | 3,423 | $0.00068 | off-peak | 3 | 5.0 |

