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
- generated: 2026-10-19T19:46:09.459Z
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
| json-parser | tc | 3/3 | 3,205 | 1,628 | 4,833 | $0.00102 | $0.00102 | 6.1 | 3.0 |
| sexp-parser | tc | 3/3 | 2,673 | 536 | 3,209 | $0.00035 | $0.00035 | 4.9 | 3.0 |
| minilisp | tc | 3/3 | 23,683 | 2,645 | 26,328 | $0.00464 | $0.00464 | 18.4 | 11.3 |
| csv-parser | tc | 3/3 | 16,879 | 1,901 | 18,780 | $0.00249 | $0.00249 | 19.1 | 12.7 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 12/12 | 11,610 | 1,677 | 13,287 | 159,449 | $0.00213 | $0.02551 | $0.00213 | 12.2 | 7.5 |

Per success (usage-run sums divided by successful runs):

| Side | Input | Output | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 11,610 | 1,677 | 13,287 | $0.00213 |

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
| json-parser | tc | 1 | yes | 3,205 | 1,613 | 4,818 | $0.00102 | off-peak | 3 | 5.7 |
| json-parser | tc | 2 | yes | 3,205 | 1,648 | 4,853 | $0.00104 | off-peak | 3 | 5.6 |
| json-parser | tc | 3 | yes | 3,205 | 1,623 | 4,828 | $0.00102 | off-peak | 3 | 7.0 |
| sexp-parser | tc | 1 | yes | 2,673 | 559 | 3,232 | $0.00036 | off-peak | 3 | 5.3 |
| sexp-parser | tc | 2 | yes | 2,673 | 525 | 3,198 | $0.00034 | off-peak | 3 | 4.7 |
| sexp-parser | tc | 3 | yes | 2,673 | 523 | 3,196 | $0.00036 | off-peak | 3 | 4.8 |
| minilisp | tc | 1 | yes | 22,682 | 2,555 | 25,237 | $0.00443 | off-peak | 12 | 16.8 |
| minilisp | tc | 2 | yes | 11,150 | 2,477 | 13,627 | $0.00267 | off-peak | 7 | 14.8 |
| minilisp | tc | 3 | yes | 37,217 | 2,904 | 40,121 | $0.00682 | off-peak | 15 | 23.6 |
| csv-parser | tc | 1 | yes | 16,556 | 1,862 | 18,418 | $0.00245 | off-peak | 12 | 19.6 |
| csv-parser | tc | 2 | yes | 26,154 | 2,386 | 28,540 | $0.00353 | off-peak | 19 | 28.0 |
| csv-parser | tc | 3 | yes | 7,927 | 1,454 | 9,381 | $0.00148 | off-peak | 7 | 9.8 |

