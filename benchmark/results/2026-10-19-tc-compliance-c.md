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
- generated: 2026-10-19T19:43:25.850Z
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
| json-parser | tc | 3/3 | 3,205 | 1,656 | 4,861 | $0.00104 | $0.00104 | 7.5 | 3.0 |
| sexp-parser | tc | 3/3 | 2,673 | 525 | 3,198 | $0.00035 | $0.00035 | 5.0 | 3.0 |
| minilisp | tc | 3/3 | 26,743 | 3,369 | 30,112 | $0.00550 | $0.00550 | 22.8 | 14.0 |
| csv-parser | tc | 3/3 | 7,230 | 1,151 | 8,381 | $0.00107 | $0.00107 | 9.3 | 6.3 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 12/12 | 9,963 | 1,675 | 11,638 | 139,658 | $0.00199 | $0.02386 | $0.00199 | 11.2 | 6.6 |

Per success (usage-run sums divided by successful runs):

| Side | Input | Output | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 9,963 | 1,675 | 11,638 | $0.00199 |

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
| json-parser | tc | 1 | yes | 3,205 | 1,705 | 4,910 | $0.00107 | off-peak | 3 | 7.0 |
| json-parser | tc | 2 | yes | 3,205 | 1,650 | 4,855 | $0.00104 | off-peak | 3 | 6.9 |
| json-parser | tc | 3 | yes | 3,205 | 1,614 | 4,819 | $0.00102 | off-peak | 3 | 8.6 |
| sexp-parser | tc | 1 | yes | 2,673 | 525 | 3,198 | $0.00034 | off-peak | 3 | 5.5 |
| sexp-parser | tc | 2 | yes | 2,673 | 526 | 3,199 | $0.00036 | off-peak | 3 | 4.9 |
| sexp-parser | tc | 3 | yes | 2,673 | 525 | 3,198 | $0.00034 | off-peak | 3 | 4.5 |
| minilisp | tc | 1 | yes | 23,177 | 3,280 | 26,457 | $0.00496 | off-peak | 13 | 20.1 |
| minilisp | tc | 2 | yes | 15,850 | 3,492 | 19,342 | $0.00396 | off-peak | 8 | 17.7 |
| minilisp | tc | 3 | yes | 41,202 | 3,335 | 44,537 | $0.00758 | off-peak | 21 | 30.7 |
| csv-parser | tc | 1 | yes | 5,251 | 680 | 5,931 | $0.00061 | off-peak | 5 | 7.1 |
| csv-parser | tc | 2 | yes | 8,107 | 1,334 | 9,441 | $0.00124 | off-peak | 7 | 11.5 |
| csv-parser | tc | 3 | yes | 8,332 | 1,439 | 9,771 | $0.00134 | off-peak | 7 | 9.3 |

