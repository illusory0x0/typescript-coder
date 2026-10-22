# Benchmark report — 2026-10-22

- mode: full
- model: deepseek-v4.1-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: edit-dsl (#119)
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp, csv-parser
- sides: tc, oc
- reps: 3
- bun: 1.3.13
- opencode: opencode v2.1.2
- generated: 2026-10-22T02:22:36.594Z
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
| json-parser | tc | 1/3 | 25,447 | 12,702 | 38,149 | $0.02295 | $0.06884 | 93.4 | 18.3 |
| json-parser | oc | 3/3 | 6,115 | 2,683 | 8,798 | $0.00530 | $0.00530 | 96.3 | 4.7 |
| sexp-parser | tc | 2/3 | 11,998 | 3,543 | 15,541 | $0.00798 | $0.01197 | 72.6 | 15.3 |
| sexp-parser | oc | 3/3 | 5,215 | 1,160 | 6,375 | $0.00315 | $0.00315 | 31.1 | 4.3 |
| minilisp | tc | 0/3 | 48,138 | 19,647 | 67,785 | $0.03830 | n/a | 211.3 | 35.7 |
| minilisp | oc | 3/3 | 7,324 | 6,683 | 14,007 | $0.01080 | $0.01080 | 532.3 | 8.0 |
| csv-parser | tc | 3/3 | 4,665 | 1,359 | 6,024 | $0.00308 | $0.00308 | 34.4 | 7.7 |
| csv-parser | oc | 3/3 | 5,440 | 2,840 | 8,281 | $0.00530 | $0.00530 | 219.8 | 5.0 |

## Overall comparison

| Side | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 6/12 | 22,562 | 9,313 | 31,875 | 382,494 | $0.01808 | $0.21695 | $0.03616 | 102.9 | 19.3 |
| oc | 12/12 | 6,024 | 3,341 | 9,365 | 112,383 | $0.00613 | $0.07362 | $0.00613 | 219.9 | 5.5 |

Per success (usage-run sums divided by successful runs):

| Side | In (no cache) | Out | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 45,124 | 18,625 | 63,749 | $0.03616 |
| oc | 6,024 | 3,341 | 9,365 | $0.00613 |

Success rates differ: tc 6/12 (50.0%) vs oc 12/12 (100.0%).

Token multiplier (cache-excluded total, higher/lower): tc 3.40x oc overall; json-parser tc 4.34x oc; sexp-parser tc 2.44x oc; minilisp tc 4.84x oc; csv-parser oc 1.37x tc.

*Pricing footnote (decision-only):* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Selector adoption (#101)

Per task and side (payloads that used each selector):

| Task | Side | range | matcher | whole-symbol |
| --- | --- | ---: | ---: | ---: |
| json-parser | tc | 0 | 1 | 6 |
| json-parser | oc | 0 | 0 | 0 |
| sexp-parser | tc | 0 | 2 | 4 |
| sexp-parser | oc | 0 | 0 | 0 |
| minilisp | tc | 0 | 0 | 32 |
| minilisp | oc | 0 | 0 | 0 |
| csv-parser | tc | 0 | 1 | 6 |
| csv-parser | oc | 0 | 0 | 0 |

| Side | range | matcher | whole-symbol |
| --- | ---: | ---: | ---: |
| tc | 0 | 4 | 48 |
| oc | 0 | 0 | 0 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | whole-symbol | match | pick | snippet | regex |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | 6 | 1 | 0 | 1 | 0 |
| json-parser | oc | 0 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | 4 | 2 | 0 | 2 | 0 |
| sexp-parser | oc | 0 | 0 | 0 | 0 | 0 |
| minilisp | tc | 32 | 0 | 0 | 0 | 0 |
| minilisp | oc | 0 | 0 | 0 | 0 | 0 |
| csv-parser | tc | 6 | 1 | 0 | 1 | 0 |
| csv-parser | oc | 0 | 0 | 0 | 0 | 0 |

| Side | whole-symbol | match | pick | snippet | regex |
| --- | ---: | ---: | ---: | ---: | ---: |
| tc | 48 | 4 | 0 | 4 | 0 |
| oc | 0 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | creates |
| --- | --- | ---: |
| json-parser | tc | 39 |
| json-parser | oc | 0 |
| sexp-parser | tc | 12 |
| sexp-parser | oc | 0 |
| minilisp | tc | 27 |
| minilisp | oc | 0 |
| csv-parser | tc | 3 |
| csv-parser | oc | 0 |

| Side | creates |
| --- | ---: |
| tc | 81 |
| oc | 0 |

## Anomalies

Failing runs:

- json-parser tc rep2: src/json.test.ts: modified
- json-parser tc rep3: token-budget: accumulated 121237 tokens exceeded the 120000 token budget
- sexp-parser tc rep3: src/sexp.test.ts: modified
- minilisp tc rep1: token-budget: accumulated 120099 tokens exceeded the 120000 token budget
- minilisp tc rep2: token-budget: accumulated 120908 tokens exceeded the 120000 token budget
- minilisp tc rep3: edit-exhausted: the model replied STOP after 12 consecutive failed rounds stage: tsc elsewhere in file: src/lisp.ts(173,5): error TS2322: Type 'Fn | LispValue' ...

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
| json-parser | tc | 1 | yes | 10,627 | 2,587 | 13,214 | $0.00434 | peak | 5 | 18.8 |
| json-parser | tc | 2 | no | 10,429 | 2,695 | 13,124 | $0.00410 | peak | 5 | 22.7 |
| json-parser | tc | 3 | no | 90,997 | 32,711 | 123,708 | $0.06040 | peak | 45 | 238.6 |
| json-parser | oc | 1 | yes | 5,488 | 2,193 | 7,957 | $0.00480 | peak | 4 | 95.7 |
| json-parser | oc | 2 | yes | 7,395 | 2,708 | 10,537 | $0.00633 | peak | 6 | 176.7 |
| json-parser | oc | 3 | yes | 5,463 | 2,185 | 7,901 | $0.00476 | peak | 4 | 16.4 |
| sexp-parser | tc | 1 | yes | 14,345 | 1,265 | 15,610 | $0.00266 | peak | 8 | 79.8 |
| sexp-parser | tc | 2 | yes | 10,476 | 560 | 11,036 | $0.00144 | peak | 6 | 27.5 |
| sexp-parser | tc | 3 | no | 75,557 | 8,803 | 84,360 | $0.01983 | peak | 32 | 110.3 |
| sexp-parser | oc | 1 | yes | 5,209 | 1,058 | 6,385 | $0.00315 | peak | 4 | 12.9 |
| sexp-parser | oc | 2 | yes | 5,153 | 991 | 6,438 | $0.00326 | peak | 4 | 15.9 |
| sexp-parser | oc | 3 | yes | 5,284 | 895 | 6,302 | $0.00303 | peak | 5 | 64.4 |
| minilisp | tc | 1 | no | 95,615 | 28,577 | 124,192 | $0.04648 | peak | 31 | 226.0 |
| minilisp | tc | 2 | no | 105,918 | 18,339 | 124,257 | $0.03828 | peak | 42 | 217.4 |
| minilisp | tc | 3 | no | 86,113 | 11,893 | 98,006 | $0.03015 | peak | 34 | 190.6 |
| minilisp | oc | 1 | yes | 6,351 | 2,938 | 11,743 | $0.00876 | peak | 6 | 953.5 |
| minilisp | oc | 2 | yes | 8,339 | 4,617 | 14,495 | $0.01045 | peak | 8 | 255.8 |
| minilisp | oc | 3 | yes | 7,283 | 6,553 | 15,783 | $0.01319 | peak | 10 | 387.7 |
| csv-parser | tc | 1 | yes | 11,993 | 1,407 | 13,400 | $0.00288 | peak | 7 | 32.4 |
| csv-parser | tc | 2 | yes | 20,168 | 1,613 | 21,781 | $0.00407 | peak | 11 | 45.5 |
| csv-parser | tc | 3 | yes | 8,969 | 1,057 | 10,026 | $0.00230 | peak | 5 | 25.2 |
| csv-parser | oc | 1 | yes | 5,268 | 1,144 | 8,467 | $0.00562 | peak | 4 | 70.4 |
| csv-parser | oc | 2 | yes | 5,813 | 1,473 | 8,744 | $0.00564 | peak | 7 | 427.8 |
| csv-parser | oc | 3 | yes | 5,240 | 1,073 | 7,631 | $0.00463 | peak | 4 | 161.3 |

