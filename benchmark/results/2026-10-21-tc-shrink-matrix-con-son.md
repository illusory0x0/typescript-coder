# Benchmark report — 2026-10-21

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
- generated: 2026-10-21T00:32:22.417Z
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
| json-parser | tc | 3/3 | 1,393 | 1,912 | 3,305 | $0.00136 | $0.00136 | 10.8 | 3.3 |
| sexp-parser | tc | 3/3 | 692 | 394 | 1,086 | $0.00035 | $0.00035 | 5.2 | 3.0 |
| minilisp | tc | 0/3 | 52,149 | 5,986 | 58,135 | $0.01162 | n/a | 83.9 | 33.0 |
| csv-parser | tc | 3/3 | 6,764 | 1,407 | 8,171 | $0.00189 | $0.00189 | 17.1 | 11.0 |

## Overall comparison

| Side | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 9/12 | 15,250 | 2,425 | 17,674 | 212,092 | $0.00380 | $0.04566 | $0.00507 | 29.3 | 12.6 |

Per success (usage-run sums divided by successful runs):

| Side | In (no cache) | Out | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 20,333 | 3,233 | 23,566 | $0.00507 |

Only one side ran: tc 9/12 (75.0%).

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
| minilisp | tc | 0 | 10 | 8 |
| csv-parser | tc | 0 | 7 | 5 |

| Side | range | matcher | whole-symbol |
| --- | ---: | ---: | ---: |
| tc | 0 | 17 | 19 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | whole-symbol | match | pick | snippet | regex |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | 3 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | 3 | 0 | 0 | 0 | 0 |
| minilisp | tc | 8 | 10 | 0 | 10 | 0 |
| csv-parser | tc | 5 | 7 | 0 | 7 | 0 |

| Side | whole-symbol | match | pick | snippet | regex |
| --- | ---: | ---: | ---: | ---: | ---: |
| tc | 19 | 17 | 0 | 17 | 0 |

Implicit creates (#111):

| Task | Side | creates |
| --- | --- | ---: |
| json-parser | tc | 3 |
| sexp-parser | tc | 3 |
| minilisp | tc | 3 |
| csv-parser | tc | 3 |

| Side | creates |
| --- | ---: |
| tc | 12 |

## Anomalies

Failing runs:

- minilisp tc rep1: token-budget: accumulated 122944 tokens exceeded the 120000 token budget
- minilisp tc rep2: token-budget: accumulated 123870 tokens exceeded the 120000 token budget
- minilisp tc rep3: edit-exhausted: the model replied STOP after 12 consecutive failed rounds stage: tsc elsewhere in file: src/lisp.ts(209,15): error TS2345: Argument of type '(a:...

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
| json-parser | tc | 1 | yes | 3,485 | 1,391 | 4,876 | $0.00094 | off-peak | 3 | 8.5 |
| json-parser | tc | 2 | yes | 5,658 | 2,769 | 8,427 | $0.00189 | off-peak | 4 | 14.7 |
| json-parser | tc | 3 | yes | 3,485 | 1,575 | 5,060 | $0.00126 | off-peak | 3 | 9.1 |
| sexp-parser | tc | 1 | yes | 2,953 | 394 | 3,347 | $0.00034 | off-peak | 3 | 5.5 |
| sexp-parser | tc | 2 | yes | 2,953 | 394 | 3,347 | $0.00043 | off-peak | 3 | 5.0 |
| sexp-parser | tc | 3 | yes | 2,953 | 394 | 3,347 | $0.00027 | off-peak | 3 | 5.3 |
| minilisp | tc | 1 | no | 121,157 | 5,868 | 127,025 | $0.01099 | off-peak | 32 | 90.6 |
| minilisp | tc | 2 | no | 124,589 | 5,192 | 129,781 | $0.01193 | off-peak | 31 | 79.8 |
| minilisp | tc | 3 | no | 112,813 | 6,165 | 118,978 | $0.01194 | off-peak | 36 | 81.3 |
| csv-parser | tc | 1 | yes | 35,890 | 2,075 | 37,965 | $0.00392 | off-peak | 19 | 28.1 |
| csv-parser | tc | 2 | yes | 8,441 | 1,024 | 9,465 | $0.00085 | off-peak | 7 | 11.3 |
| csv-parser | tc | 3 | yes | 8,474 | 1,122 | 9,596 | $0.00091 | off-peak | 7 | 11.8 |

