# Benchmark report — 2026-10-19

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
- generated: 2026-10-19T18:44:12.784Z
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
(uniform-spend approximation).

## Per-task results

| Task | Side | Success | Mean in | Mean out | Mean total | Mean $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | 3/3 | 3,205 | 1,619 | 4,824 | $0.00123 | $0.00123 | 48.1 | 3.0 |
| sexp-parser | tc | 3/3 | 2,673 | 533 | 3,206 | $0.00046 | $0.00046 | 45.7 | 3.0 |
| minilisp | tc | 3/3 | 23,915 | 2,474 | 26,389 | $0.00446 | $0.00446 | 82.6 | 11.7 |
| csv-parser | tc | 3/3 | 11,639 | 1,556 | 13,194 | $0.00193 | $0.00193 | 16.9 | 9.3 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 12/12 | 10,358 | 1,545 | 11,903 | 142,839 | $0.00202 | $0.02422 | $0.00202 | 48.3 | 6.8 |

Per success (usage-run sums divided by successful runs):

| Side | Input | Output | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 10,358 | 1,545 | 11,903 | $0.00202 |

Only one side ran: tc 12/12 (100.0%).

*Pricing footnote:* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

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

| Task | Side | Rep | OK | Input | Output | Total | Cost | Rate | Steps | Dur (s) |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| json-parser | tc | 1 | yes | 3,205 | 1,697 | 4,902 | $0.00127 | off-peak | 3 | 5.7 |
| json-parser | tc | 2 | yes | 3,205 | 1,636 | 4,841 | $0.00124 | off-peak | 3 | 68.8 |
| json-parser | tc | 3 | yes | 3,205 | 1,524 | 4,729 | $0.00117 | off-peak | 3 | 69.7 |
| sexp-parser | tc | 1 | yes | 2,673 | 560 | 3,233 | $0.00038 | off-peak | 3 | 65.8 |
| sexp-parser | tc | 2 | yes | 2,673 | 522 | 3,195 | $0.00051 | off-peak | 3 | 65.3 |
| sexp-parser | tc | 3 | yes | 2,673 | 516 | 3,189 | $0.00050 | off-peak | 3 | 5.9 |
| minilisp | tc | 1 | yes | 21,077 | 2,119 | 23,196 | $0.00417 | off-peak | 12 | 117.3 |
| minilisp | tc | 2 | yes | 11,025 | 2,363 | 13,388 | $0.00249 | off-peak | 6 | 32.3 |
| minilisp | tc | 3 | yes | 39,643 | 2,940 | 42,583 | $0.00671 | off-peak | 17 | 98.1 |
| csv-parser | tc | 1 | yes | 13,977 | 2,207 | 16,184 | $0.00265 | off-peak | 10 | 23.7 |
| csv-parser | tc | 2 | yes | 13,019 | 1,705 | 14,724 | $0.00220 | off-peak | 11 | 16.9 |
| csv-parser | tc | 3 | yes | 7,920 | 755 | 8,675 | $0.00093 | off-peak | 7 | 10.1 |

