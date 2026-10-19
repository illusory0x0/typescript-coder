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
- generated: 2026-10-19T19:46:59.802Z
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
| json-parser | tc | 3/3 | 3,205 | 1,596 | 4,801 | $0.00101 | $0.00101 | 7.2 | 3.0 |
| sexp-parser | tc | 3/3 | 2,672 | 559 | 3,231 | $0.00037 | $0.00037 | 5.1 | 3.0 |
| minilisp | tc | 2/3 | 39,203 | 3,706 | 42,909 | $0.00707 | $0.01060 | 28.7 | 16.7 |
| csv-parser | tc | 3/3 | 14,050 | 2,247 | 16,297 | $0.00237 | $0.00237 | 17.3 | 10.0 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 11/12 | 14,783 | 2,027 | 16,810 | 201,714 | $0.00270 | $0.03245 | $0.00295 | 14.5 | 8.2 |

Per success (usage-run sums divided by successful runs):

| Side | Input | Output | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 16,126 | 2,211 | 18,338 | $0.00295 |

Only one side ran: tc 11/12 (91.7%).

*Pricing footnote:* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Anomalies

Failing runs:

- minilisp tc rep3: edit-exhausted: the model replied STOP after 8 consecutive failed rounds stage: tsc elsewhere in file: src/lisp.ts(82,44): error TS2322: Type 'Expr' is not assi...

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
| json-parser | tc | 1 | yes | 3,205 | 1,525 | 4,730 | $0.00096 | off-peak | 3 | 6.1 |
| json-parser | tc | 2 | yes | 3,205 | 1,636 | 4,841 | $0.00105 | off-peak | 3 | 7.9 |
| json-parser | tc | 3 | yes | 3,205 | 1,628 | 4,833 | $0.00102 | off-peak | 3 | 7.5 |
| sexp-parser | tc | 1 | yes | 2,673 | 559 | 3,232 | $0.00036 | off-peak | 3 | 5.2 |
| sexp-parser | tc | 2 | yes | 2,671 | 559 | 3,230 | $0.00038 | off-peak | 3 | 5.2 |
| sexp-parser | tc | 3 | yes | 2,673 | 559 | 3,232 | $0.00036 | off-peak | 3 | 5.0 |
| minilisp | tc | 1 | yes | 57,222 | 4,202 | 61,424 | $0.01022 | off-peak | 23 | 34.9 |
| minilisp | tc | 2 | yes | 10,655 | 2,257 | 12,912 | $0.00244 | off-peak | 6 | 11.1 |
| minilisp | tc | 3 | no | 49,731 | 4,659 | 54,390 | $0.00854 | off-peak | 21 | 40.0 |
| csv-parser | tc | 1 | yes | 14,005 | 2,206 | 16,211 | $0.00224 | off-peak | 10 | 18.5 |
| csv-parser | tc | 2 | yes | 14,093 | 2,286 | 16,379 | $0.00253 | off-peak | 10 | 16.2 |
| csv-parser | tc | 3 | yes | 14,052 | 2,248 | 16,300 | $0.00235 | off-peak | 10 | 17.0 |

