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
- generated: 2026-10-20T03:34:58.754Z
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
| json-parser | tc | 3/3 | 3,205 | 1,677 | 4,882 | $0.00207 | $0.00207 | 12.4 | 3.0 |
| sexp-parser | tc | 3/3 | 2,673 | 536 | 3,209 | $0.00069 | $0.00069 | 6.5 | 3.0 |
| minilisp | tc | 2/3 | 34,109 | 4,106 | 38,215 | $0.01334 | $0.02002 | 43.9 | 15.3 |
| csv-parser | tc | 3/3 | 12,781 | 1,629 | 14,410 | $0.00366 | $0.00366 | 18.9 | 10.0 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 11/12 | 13,192 | 1,987 | 15,179 | 182,149 | $0.00494 | $0.05929 | $0.00539 | 20.4 | 7.8 |

Per success (usage-run sums divided by successful runs):

| Side | Input | Output | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 14,391 | 2,168 | 16,559 | $0.00539 |

Only one side ran: tc 11/12 (91.7%).

*Pricing footnote:* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Anomalies

Failing runs:

- minilisp tc rep3: edit-exhausted: the model replied STOP after 8 consecutive failed rounds stage: tsc elsewhere in file: src/lisp.ts(131,42): error TS2322: Type 'Expr' is not ass...

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
| json-parser | tc | 1 | yes | 3,205 | 1,749 | 4,954 | $0.00216 | peak | 3 | 13.0 |
| json-parser | tc | 2 | yes | 3,205 | 1,670 | 4,875 | $0.00206 | peak | 3 | 12.5 |
| json-parser | tc | 3 | yes | 3,205 | 1,613 | 4,818 | $0.00199 | peak | 3 | 11.6 |
| sexp-parser | tc | 1 | yes | 2,673 | 525 | 3,198 | $0.00068 | peak | 3 | 6.3 |
| sexp-parser | tc | 2 | yes | 2,673 | 525 | 3,198 | $0.00068 | peak | 3 | 6.3 |
| sexp-parser | tc | 3 | yes | 2,673 | 559 | 3,232 | $0.00072 | peak | 3 | 6.8 |
| minilisp | tc | 1 | yes | 10,862 | 2,194 | 13,056 | $0.00488 | peak | 6 | 19.9 |
| minilisp | tc | 2 | yes | 42,769 | 5,423 | 48,192 | $0.01678 | peak | 18 | 54.7 |
| minilisp | tc | 3 | no | 48,697 | 4,700 | 53,397 | $0.01838 | peak | 22 | 57.0 |
| csv-parser | tc | 1 | yes | 14,139 | 2,255 | 16,394 | $0.00480 | peak | 10 | 22.8 |
| csv-parser | tc | 2 | yes | 5,231 | 677 | 5,908 | $0.00099 | peak | 5 | 8.2 |
| csv-parser | tc | 3 | yes | 18,973 | 1,954 | 20,927 | $0.00518 | peak | 15 | 25.8 |

