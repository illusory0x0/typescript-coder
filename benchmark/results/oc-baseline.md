# Benchmark report — 2026-10-24

- mode: full
- model: deepseek-flash
- oc model: deepseek/deepseek-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: edit-dsl (#119)
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp, csv-parser
- sides: oc
- reps: 3
- bun: 1.3.13
- opencode: opencode v2.1.2
- generated: 2026-10-24T09:57:09.151Z
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
| json-parser | oc | n/a | 3/3 | 5,550 | 2,579 | 8,129 | $0.00249 | $0.00249 | 12.3 | 4.3 |
| sexp-parser | oc | n/a | 3/3 | 6,170 | 1,461 | 7,631 | $0.00191 | $0.00191 | 9.9 | 4.7 |
| minilisp | oc | n/a | 3/3 | 6,913 | 5,894 | 12,807 | $0.00487 | $0.00487 | 33.2 | 8.3 |
| csv-parser | oc | n/a | 3/3 | 5,230 | 1,871 | 7,101 | $0.00200 | $0.00200 | 12.3 | 4.0 |

## Overall comparison

| Side | Protocol | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| oc | n/a | 12/12 | 5,966 | 2,951 | 8,917 | 107,003 | $0.00282 | $0.03382 | $0.00282 | 16.9 | 5.3 |

Per success (usage-run sums divided by successful runs):

| Side | Protocol | In (no cache) | Out | Total | Cost |
| --- | --- | ---: | ---: | ---: | ---: |
| oc | n/a | 5,966 | 2,951 | 8,917 | $0.00282 |

Only one side ran: oc 12/12 (100.0%).

Token multiplier (cache-excluded): not comparable (both sides must run).

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
| json-parser | oc | n/a | 0 | 0 | 0 |
| sexp-parser | oc | n/a | 0 | 0 | 0 |
| minilisp | oc | n/a | 0 | 0 | 0 |
| csv-parser | oc | n/a | 0 | 0 | 0 |

| Side | Protocol | range | matcher | whole-symbol |
| --- | --- | ---: | ---: | ---: |
| oc | n/a | 0 | 0 | 0 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | Protocol | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | oc | n/a | 0 | 0 | 0 | 0 | 0 |
| sexp-parser | oc | n/a | 0 | 0 | 0 | 0 | 0 |
| minilisp | oc | n/a | 0 | 0 | 0 | 0 | 0 |
| csv-parser | oc | n/a | 0 | 0 | 0 | 0 | 0 |

| Side | Protocol | whole-symbol | match | pick | snippet | regex |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| oc | n/a | 0 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | Protocol | creates |
| --- | --- | --- | ---: |
| json-parser | oc | n/a | 0 |
| sexp-parser | oc | n/a | 0 |
| minilisp | oc | n/a | 0 |
| csv-parser | oc | n/a | 0 |

| Side | Protocol | creates |
| --- | --- | ---: |
| oc | n/a | 0 |

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
| json-parser | oc | n/a | 1 | yes | 5,682 | 2,191 | 8,570 | $0.00271 | off-peak | 5 | 13.5 |
| json-parser | oc | n/a | 2 | yes | 5,533 | 2,066 | 7,900 | $0.00235 | off-peak | 4 | 11.5 |
| json-parser | oc | n/a | 3 | yes | 5,434 | 2,144 | 7,916 | $0.00240 | off-peak | 4 | 12.0 |
| sexp-parser | oc | n/a | 1 | yes | 8,269 | 1,363 | 10,095 | $0.00250 | off-peak | 6 | 13.7 |
| sexp-parser | oc | n/a | 2 | yes | 5,097 | 1,038 | 6,411 | $0.00164 | off-peak | 4 | 7.9 |
| sexp-parser | oc | n/a | 3 | yes | 5,144 | 1,033 | 6,386 | $0.00161 | off-peak | 4 | 8.2 |
| minilisp | oc | n/a | 1 | yes | 5,974 | 4,004 | 11,590 | $0.00445 | off-peak | 6 | 29.2 |
| minilisp | oc | n/a | 2 | yes | 6,298 | 2,363 | 10,436 | $0.00360 | off-peak | 6 | 24.9 |
| minilisp | oc | n/a | 3 | yes | 8,467 | 4,328 | 16,396 | $0.00656 | off-peak | 13 | 45.5 |
| csv-parser | oc | n/a | 1 | yes | 5,191 | 1,040 | 6,891 | $0.00189 | off-peak | 4 | 11.5 |
| csv-parser | oc | n/a | 2 | yes | 5,280 | 1,189 | 8,024 | $0.00254 | off-peak | 4 | 16.0 |
| csv-parser | oc | n/a | 3 | yes | 5,220 | 944 | 6,388 | $0.00157 | off-peak | 4 | 9.3 |

