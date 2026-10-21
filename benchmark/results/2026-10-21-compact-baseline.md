# Benchmark report — 2026-10-21

- mode: full
- model: deepseek-v4.1-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: compact (#119)
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp, csv-parser
- sides: tc
- reps: 1
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-21T19:43:18.246Z
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
| json-parser | tc | 0/1 | 57,212 | 29,671 | 86,883 | $0.02650 | n/a | 156.5 | 48.0 |
| sexp-parser | tc | 1/1 | 3,301 | 484 | 3,785 | $0.00080 | $0.00080 | 8.9 | 5.0 |
| minilisp | tc | 0/1 | 60,882 | 24,714 | 85,596 | $0.02408 | n/a | 127.9 | 38.0 |
| csv-parser | tc | 1/1 | 6,894 | 971 | 7,865 | $0.00163 | $0.00163 | 12.0 | 5.0 |

## Overall comparison

| Side | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 2/4 | 32,072 | 13,960 | 46,032 | 184,129 | $0.01325 | $0.05300 | $0.02650 | 76.4 | 24.0 |

Per success (usage-run sums divided by successful runs):

| Side | In (no cache) | Out | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 64,145 | 27,920 | 92,065 | $0.02650 |

Only one side ran: tc 2/4 (50.0%).

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
| json-parser | tc | 0 | 0 | 16 |
| sexp-parser | tc | 0 | 0 | 1 |
| minilisp | tc | 0 | 0 | 17 |
| csv-parser | tc | 0 | 0 | 1 |

| Side | range | matcher | whole-symbol |
| --- | ---: | ---: | ---: |
| tc | 0 | 0 | 35 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | whole-symbol | match | pick | snippet | regex |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | 16 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | 1 | 0 | 0 | 0 | 0 |
| minilisp | tc | 17 | 0 | 0 | 0 | 0 |
| csv-parser | tc | 1 | 0 | 0 | 0 | 0 |

| Side | whole-symbol | match | pick | snippet | regex |
| --- | ---: | ---: | ---: | ---: | ---: |
| tc | 35 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | creates |
| --- | --- | ---: |
| json-parser | tc | 4 |
| sexp-parser | tc | 1 |
| minilisp | tc | 5 |
| csv-parser | tc | 1 |

| Side | creates |
| --- | ---: |
| tc | 11 |

## Anomalies

Failing runs:

- json-parser tc rep1: token-budget: accumulated 122840 tokens exceeded the 120000 token budget
- minilisp tc rep1: token-budget: accumulated 120862 tokens exceeded the 120000 token budget

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
| json-parser | tc | 1 | no | 96,252 | 29,653 | 125,905 | $0.02650 | off-peak | 48 | 156.5 |
| sexp-parser | tc | 1 | yes | 7,525 | 484 | 8,009 | $0.00080 | off-peak | 5 | 8.9 |
| minilisp | tc | 1 | no | 100,434 | 24,437 | 124,871 | $0.02408 | off-peak | 38 | 127.9 |
| csv-parser | tc | 1 | yes | 9,710 | 971 | 10,681 | $0.00163 | off-peak | 5 | 12.0 |

