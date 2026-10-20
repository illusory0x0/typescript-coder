# Benchmark report — 2026-10-20

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
- generated: 2026-10-20T03:32:58.498Z
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
| json-parser | tc | 3/3 | 3,205 | 1,583 | 4,788 | $0.00196 | $0.00196 | 12.1 | 3.0 |
| sexp-parser | tc | 3/3 | 2,673 | 520 | 3,193 | $0.00067 | $0.00067 | 5.7 | 3.0 |
| minilisp | tc | 2/3 | 60,146 | 4,823 | 64,968 | $0.01976 | $0.02963 | 51.6 | 19.0 |
| csv-parser | tc | 3/3 | 10,758 | 1,128 | 11,886 | $0.00280 | $0.00280 | 15.8 | 8.7 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 11/12 | 19,195 | 2,013 | 21,209 | 254,504 | $0.00630 | $0.07556 | $0.00687 | 21.3 | 8.4 |

Per success (usage-run sums divided by successful runs):

| Side | Input | Output | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 20,940 | 2,196 | 23,137 | $0.00687 |

Only one side ran: tc 11/12 (91.7%).

*Pricing footnote:* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Anomalies

Failing runs:

- minilisp tc rep1: token-budget: accumulated 124847 tokens exceeded the 120000 token budget

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
| json-parser | tc | 1 | yes | 3,205 | 1,524 | 4,729 | $0.00189 | peak | 3 | 13.1 |
| json-parser | tc | 2 | yes | 3,205 | 1,612 | 4,817 | $0.00199 | peak | 3 | 12.0 |
| json-parser | tc | 3 | yes | 3,205 | 1,612 | 4,817 | $0.00199 | peak | 3 | 11.3 |
| sexp-parser | tc | 1 | yes | 2,673 | 525 | 3,198 | $0.00068 | peak | 3 | 6.5 |
| sexp-parser | tc | 2 | yes | 2,673 | 525 | 3,198 | $0.00068 | peak | 3 | 5.8 |
| sexp-parser | tc | 3 | yes | 2,673 | 510 | 3,183 | $0.00066 | peak | 3 | 4.9 |
| minilisp | tc | 1 | no | 125,422 | 7,321 | 132,743 | $0.03645 | peak | 29 | 86.9 |
| minilisp | tc | 2 | yes | 19,232 | 5,066 | 24,298 | $0.01083 | peak | 10 | 36.9 |
| minilisp | tc | 3 | yes | 35,783 | 2,081 | 37,864 | $0.01199 | peak | 18 | 31.0 |
| csv-parser | tc | 1 | yes | 10,399 | 905 | 11,304 | $0.00232 | peak | 9 | 15.2 |
| csv-parser | tc | 2 | yes | 5,237 | 679 | 5,916 | $0.00122 | peak | 5 | 8.8 |
| csv-parser | tc | 3 | yes | 16,637 | 1,800 | 18,437 | $0.00486 | peak | 12 | 23.5 |

