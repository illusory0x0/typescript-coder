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
- generated: 2026-10-19T19:44:07.473Z
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
| json-parser | tc | 3/3 | 3,205 | 1,627 | 4,832 | $0.00103 | $0.00103 | 6.6 | 3.0 |
| sexp-parser | tc | 3/3 | 2,673 | 548 | 3,221 | $0.00035 | $0.00035 | 5.0 | 3.0 |
| minilisp | tc | 2/3 | 49,776 | 4,490 | 54,266 | $0.00829 | $0.01244 | 36.3 | 17.0 |
| csv-parser | tc | 3/3 | 13,191 | 1,454 | 14,645 | $0.00174 | $0.00174 | 14.1 | 10.3 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 11/12 | 17,211 | 2,030 | 19,241 | 230,891 | $0.00285 | $0.03426 | $0.00311 | 15.5 | 8.3 |

Per success (usage-run sums divided by successful runs):

| Side | Input | Output | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 18,776 | 2,214 | 20,990 | $0.00311 |

Only one side ran: tc 11/12 (91.7%).

*Pricing footnote:* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Anomalies

Failing runs:

- minilisp tc rep1: token-budget: accumulated 122316 tokens exceeded the 120000 token budget

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
| json-parser | tc | 1 | yes | 3,205 | 1,635 | 4,840 | $0.00103 | off-peak | 3 | 6.2 |
| json-parser | tc | 2 | yes | 3,205 | 1,623 | 4,828 | $0.00102 | off-peak | 3 | 5.8 |
| json-parser | tc | 3 | yes | 3,205 | 1,624 | 4,829 | $0.00104 | off-peak | 3 | 7.9 |
| sexp-parser | tc | 1 | yes | 2,673 | 559 | 3,232 | $0.00036 | off-peak | 3 | 5.8 |
| sexp-parser | tc | 2 | yes | 2,673 | 559 | 3,232 | $0.00036 | off-peak | 3 | 4.7 |
| sexp-parser | tc | 3 | yes | 2,673 | 525 | 3,198 | $0.00034 | off-peak | 3 | 4.4 |
| minilisp | tc | 1 | no | 120,482 | 7,055 | 127,537 | $0.01772 | off-peak | 34 | 75.2 |
| minilisp | tc | 2 | yes | 7,109 | 2,093 | 9,202 | $0.00181 | off-peak | 5 | 8.5 |
| minilisp | tc | 3 | yes | 21,737 | 4,321 | 26,058 | $0.00535 | off-peak | 12 | 25.4 |
| csv-parser | tc | 1 | yes | 8,102 | 1,335 | 9,437 | $0.00124 | off-peak | 7 | 11.1 |
| csv-parser | tc | 2 | yes | 5,232 | 677 | 5,909 | $0.00046 | off-peak | 5 | 6.1 |
| csv-parser | tc | 3 | yes | 26,238 | 2,351 | 28,589 | $0.00352 | off-peak | 19 | 25.2 |

