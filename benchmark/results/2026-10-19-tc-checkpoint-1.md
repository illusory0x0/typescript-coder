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
- generated: 2026-10-19T20:10:20.470Z
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
| json-parser | tc | 3/3 | 3,205 | 1,625 | 4,830 | $0.00103 | $0.00103 | 6.5 | 3.0 |
| sexp-parser | tc | 3/3 | 2,672 | 536 | 3,209 | $0.00035 | $0.00035 | 4.8 | 3.0 |
| minilisp | tc | 2/3 | 59,446 | 4,260 | 63,706 | $0.00981 | $0.01471 | 36.8 | 19.3 |
| csv-parser | tc | 2/3 | 18,839 | 1,572 | 20,411 | $0.00236 | $0.00354 | 18.6 | 13.7 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 10/12 | 21,041 | 1,999 | 23,039 | 276,470 | $0.00339 | $0.04065 | $0.00406 | 16.7 | 9.8 |

Per success (usage-run sums divided by successful runs):

| Side | Input | Output | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 25,249 | 2,398 | 27,647 | $0.00406 |

Only one side ran: tc 10/12 (83.3%).

*Pricing footnote:* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Anomalies

Failing runs:

- minilisp tc rep3: edit-exhausted: the model replied STOP after 12 consecutive failed rounds stage: tsc elsewhere in file: src/lisp.ts(100,44): error TS2322: Type 'Expr' is not as...
- csv-parser tc rep3: edit-exhausted: the model replied STOP after 8 consecutive failed rounds stage: tsc replacement line 1: TS2304: Cannot find name 'justClosedQuote'. 49 | 50 | if...

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
| json-parser | tc | 1 | yes | 3,205 | 1,639 | 4,844 | $0.00105 | off-peak | 3 | 6.7 |
| json-parser | tc | 2 | yes | 3,205 | 1,624 | 4,829 | $0.00102 | off-peak | 3 | 6.3 |
| json-parser | tc | 3 | yes | 3,205 | 1,613 | 4,818 | $0.00102 | off-peak | 3 | 6.7 |
| sexp-parser | tc | 1 | yes | 2,673 | 525 | 3,198 | $0.00034 | off-peak | 3 | 5.2 |
| sexp-parser | tc | 2 | yes | 2,671 | 525 | 3,196 | $0.00036 | off-peak | 3 | 4.5 |
| sexp-parser | tc | 3 | yes | 2,673 | 559 | 3,232 | $0.00036 | off-peak | 3 | 4.7 |
| minilisp | tc | 1 | yes | 7,120 | 2,056 | 9,176 | $0.00179 | off-peak | 5 | 10.4 |
| minilisp | tc | 2 | yes | 61,482 | 3,390 | 64,872 | $0.00973 | off-peak | 21 | 33.8 |
| minilisp | tc | 3 | no | 109,736 | 7,335 | 117,071 | $0.01790 | off-peak | 32 | 66.3 |
| csv-parser | tc | 1 | yes | 5,261 | 701 | 5,962 | $0.00063 | off-peak | 5 | 6.7 |
| csv-parser | tc | 2 | yes | 24,742 | 2,207 | 26,949 | $0.00351 | off-peak | 18 | 26.1 |
| csv-parser | tc | 3 | no | 26,515 | 1,808 | 28,323 | $0.00294 | off-peak | 18 | 22.9 |

