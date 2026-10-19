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
- generated: 2026-10-19T18:47:19.369Z
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
| json-parser | tc | 3/3 | 3,205 | 1,613 | 4,818 | $0.00102 | $0.00102 | 5.8 | 3.0 |
| sexp-parser | tc | 3/3 | 2,673 | 534 | 3,207 | $0.00036 | $0.00036 | 5.5 | 3.0 |
| minilisp | tc | 3/3 | 15,540 | 2,238 | 17,777 | $0.00309 | $0.00309 | 20.0 | 8.3 |
| csv-parser | tc | 3/3 | 10,077 | 1,473 | 11,550 | $0.00151 | $0.00151 | 37.6 | 8.0 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 12/12 | 7,874 | 1,464 | 9,338 | 112,058 | $0.00150 | $0.01796 | $0.00150 | 17.2 | 5.6 |

Per success (usage-run sums divided by successful runs):

| Side | Input | Output | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 7,874 | 1,464 | 9,338 | $0.00150 |

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
| json-parser | tc | 1 | yes | 3,205 | 1,613 | 4,818 | $0.00102 | off-peak | 3 | 6.2 |
| json-parser | tc | 2 | yes | 3,205 | 1,614 | 4,819 | $0.00104 | off-peak | 3 | 5.6 |
| json-parser | tc | 3 | yes | 3,205 | 1,613 | 4,818 | $0.00102 | off-peak | 3 | 5.6 |
| sexp-parser | tc | 1 | yes | 2,673 | 516 | 3,189 | $0.00035 | off-peak | 3 | 6.4 |
| sexp-parser | tc | 2 | yes | 2,673 | 560 | 3,233 | $0.00038 | off-peak | 3 | 5.1 |
| sexp-parser | tc | 3 | yes | 2,673 | 526 | 3,199 | $0.00036 | off-peak | 3 | 5.0 |
| minilisp | tc | 1 | yes | 14,115 | 2,207 | 16,322 | $0.00318 | off-peak | 8 | 20.0 |
| minilisp | tc | 2 | yes | 17,909 | 2,324 | 20,233 | $0.00308 | off-peak | 9 | 21.8 |
| minilisp | tc | 3 | yes | 14,595 | 2,182 | 16,777 | $0.00301 | off-peak | 8 | 18.2 |
| csv-parser | tc | 1 | yes | 8,278 | 1,375 | 9,653 | $0.00130 | off-peak | 7 | 11.1 |
| csv-parser | tc | 2 | yes | 16,690 | 2,339 | 19,029 | $0.00261 | off-peak | 12 | 18.6 |
| csv-parser | tc | 3 | yes | 5,264 | 704 | 5,968 | $0.00063 | off-peak | 5 | 83.2 |

