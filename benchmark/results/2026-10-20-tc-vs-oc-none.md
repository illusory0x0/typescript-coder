# Benchmark report — 2026-10-20

- mode: full
- model: deepseek-v4.1-flash
- oc model: deepseek-v4.1-flash#none
- effort: none (default)
- multi-payload: off (default)
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp, csv-parser
- sides: tc, oc
- reps: 3
- bun: 1.3.13
- opencode: opencode v2.0.32
- generated: 2026-10-20T05:49:52.894Z
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
| json-parser | tc | 3/3 | 133 | 1,618 | 1,751 | $0.00100 | $0.00100 | 20.4 | 3.0 |
| json-parser | oc | 3/3 | 13,707 | 2,088 | 15,795 | $0.00337 | $0.00337 | 29.4 | 4.0 |
| sexp-parser | tc | 3/3 | 710 | 509 | 1,219 | $0.00042 | $0.00042 | 8.2 | 3.0 |
| sexp-parser | oc | 3/3 | 10,618 | 1,087 | 11,706 | $0.00231 | $0.00231 | 21.4 | 4.3 |
| minilisp | tc | 1/3 | 38,528 | 5,252 | 43,780 | $0.00900 | $0.02699 | 82.5 | 22.0 |
| minilisp | oc | 3/3 | 25,393 | 5,868 | 31,261 | $0.00772 | $0.00772 | 88.2 | 12.3 |
| csv-parser | tc | 3/3 | 8,031 | 2,198 | 10,230 | $0.00256 | $0.00256 | 38.5 | 14.7 |
| csv-parser | oc | 3/3 | 12,441 | 1,746 | 14,187 | $0.00300 | $0.00300 | 28.5 | 5.0 |

## Overall comparison

| Side | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 10/12 | 11,851 | 2,394 | 14,245 | 170,939 | $0.00324 | $0.03892 | $0.00389 | 37.4 | 10.7 |
| oc | 12/12 | 15,540 | 2,697 | 18,237 | 218,848 | $0.00410 | $0.04921 | $0.00410 | 41.9 | 6.4 |

Per success (usage-run sums divided by successful runs):

| Side | In (no cache) | Out | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 14,221 | 2,873 | 17,094 | $0.00389 |
| oc | 15,540 | 2,697 | 18,237 | $0.00410 |

Success rates differ: tc 10/12 (83.3%) vs oc 12/12 (100.0%).

Token multiplier (cache-excluded total, higher/lower): oc 1.28x tc overall; json-parser oc 9.02x tc; sexp-parser oc 9.60x tc; minilisp tc 1.40x oc; csv-parser oc 1.39x tc.

*Pricing footnote (decision-only):* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Anomalies

Failing runs:

- minilisp tc rep2: edit-exhausted: the model replied STOP after 8 consecutive failed rounds stage: tsc replacement line 1: TS2322: Type 'Form' is not assignable to type 'LispValue...
- minilisp tc rep3: edit-exhausted: the model replied STOP after 12 consecutive failed rounds stage: tsc elsewhere in file: src/lisp.ts(71,48): error TS2677: A type predicate's typ...

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
| json-parser | tc | 1 | yes | 3,205 | 1,613 | 4,818 | $0.00100 | off-peak | 3 | 21.0 |
| json-parser | tc | 2 | yes | 3,205 | 1,622 | 4,827 | $0.00100 | off-peak | 3 | 19.0 |
| json-parser | tc | 3 | yes | 3,205 | 1,618 | 4,823 | $0.00100 | off-peak | 3 | 21.3 |
| json-parser | oc | 1 | yes | 13,673 | 2,081 | 15,754 | $0.00336 | off-peak | 4 | 32.5 |
| json-parser | oc | 2 | yes | 12,671 | 1,931 | 14,602 | $0.00312 | off-peak | 4 | 25.9 |
| json-parser | oc | 3 | yes | 14,778 | 2,252 | 17,030 | $0.00363 | off-peak | 4 | 29.9 |
| sexp-parser | tc | 1 | yes | 2,673 | 525 | 3,198 | $0.00038 | off-peak | 3 | 7.3 |
| sexp-parser | tc | 2 | yes | 2,673 | 533 | 3,206 | $0.00055 | off-peak | 3 | 9.9 |
| sexp-parser | tc | 3 | yes | 2,673 | 468 | 3,141 | $0.00032 | off-peak | 3 | 7.3 |
| sexp-parser | oc | 1 | yes | 9,986 | 1,022 | 11,008 | $0.00217 | off-peak | 4 | 20.7 |
| sexp-parser | oc | 2 | yes | 10,078 | 992 | 11,070 | $0.00219 | off-peak | 5 | 24.3 |
| sexp-parser | oc | 3 | yes | 11,791 | 1,248 | 13,039 | $0.00258 | off-peak | 4 | 19.2 |
| minilisp | tc | 1 | yes | 19,424 | 2,583 | 22,007 | $0.00388 | off-peak | 10 | 37.9 |
| minilisp | tc | 2 | no | 66,514 | 7,946 | 74,460 | $0.01316 | off-peak | 24 | 98.3 |
| minilisp | tc | 3 | no | 95,950 | 4,901 | 100,851 | $0.00995 | off-peak | 32 | 111.3 |
| minilisp | oc | 1 | yes | 21,459 | 4,895 | 26,354 | $0.00640 | off-peak | 9 | 64.4 |
| minilisp | oc | 2 | yes | 35,631 | 8,804 | 44,435 | $0.01131 | off-peak | 19 | 139.3 |
| minilisp | oc | 3 | yes | 19,090 | 3,904 | 22,994 | $0.00544 | off-peak | 9 | 60.8 |
| csv-parser | tc | 1 | yes | 18,939 | 1,954 | 20,893 | $0.00208 | off-peak | 15 | 40.5 |
| csv-parser | tc | 2 | yes | 8,315 | 1,409 | 9,724 | $0.00132 | off-peak | 7 | 17.3 |
| csv-parser | tc | 3 | yes | 32,424 | 3,232 | 35,656 | $0.00428 | off-peak | 22 | 57.7 |
| csv-parser | oc | 1 | yes | 10,330 | 1,146 | 11,476 | $0.00230 | off-peak | 4 | 18.7 |
| csv-parser | oc | 2 | yes | 15,641 | 2,905 | 18,546 | $0.00423 | off-peak | 7 | 44.3 |
| csv-parser | oc | 3 | yes | 11,352 | 1,188 | 12,540 | $0.00248 | off-peak | 4 | 22.4 |

