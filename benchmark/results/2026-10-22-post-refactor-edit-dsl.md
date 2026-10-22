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
- generated: 2026-10-22T07:28:54.986Z
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
| json-parser | tc | 3/3 | 7,096 | 4,900 | 11,996 | $0.00807 | $0.00807 | 38.3 | 7.3 |
| json-parser | oc | 3/3 | 8,121 | 2,482 | 10,602 | $0.00563 | $0.00563 | 238.2 | 5.0 |
| sexp-parser | tc | 3/3 | 7,036 | 2,154 | 9,189 | $0.00474 | $0.00474 | 35.6 | 7.7 |
| sexp-parser | oc | 2/3 | 6,551 | 1,104 | 7,655 | $0.00344 | $0.00516 | 1010.9 | 3.7 |
| minilisp | tc | 3/3 | 13,842 | 3,401 | 17,243 | $0.00830 | $0.00830 | 50.3 | 9.0 |
| minilisp | oc | 1/3 | 8,585 | 3,005 | 11,590 | $0.00634 | $0.01902 | 1021.8 | 3.3 |
| csv-parser | tc | 3/3 | 4,389 | 688 | 5,077 | $0.00217 | $0.00217 | 17.3 | 5.3 |
| csv-parser | oc | 3/3 | 13,305 | 3,452 | 16,757 | $0.00829 | $0.00829 | 51.9 | 4.0 |

## Overall comparison

| Side | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 12/12 | 8,091 | 2,786 | 10,877 | 130,518 | $0.00582 | $0.06985 | $0.00582 | 35.4 | 7.3 |
| oc | 9/12 | 9,140 | 2,511 | 11,651 | 139,815 | $0.00592 | $0.07107 | $0.00790 | 580.7 | 4.0 |

Per success (usage-run sums divided by successful runs):

| Side | In (no cache) | Out | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 8,091 | 2,786 | 10,877 | $0.00582 |
| oc | 12,187 | 3,348 | 15,535 | $0.00790 |

Success rates differ: tc 12/12 (100.0%) vs oc 9/12 (75.0%).

Token multiplier (cache-excluded total, higher/lower): oc 1.07x tc overall; json-parser tc 1.13x oc; sexp-parser tc 1.20x oc; minilisp tc 1.49x oc; csv-parser oc 3.30x tc.

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
| json-parser | tc | 0 | 0 | 3 |
| json-parser | oc | 0 | 0 | 0 |
| sexp-parser | tc | 0 | 0 | 3 |
| sexp-parser | oc | 0 | 0 | 0 |
| minilisp | tc | 0 | 4 | 6 |
| minilisp | oc | 0 | 0 | 0 |
| csv-parser | tc | 0 | 1 | 3 |
| csv-parser | oc | 0 | 0 | 0 |

| Side | range | matcher | whole-symbol |
| --- | ---: | ---: | ---: |
| tc | 0 | 5 | 15 |
| oc | 0 | 0 | 0 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | whole-symbol | match | pick | snippet | regex |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | 3 | 0 | 0 | 0 | 0 |
| json-parser | oc | 0 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | 3 | 0 | 0 | 0 | 0 |
| sexp-parser | oc | 0 | 0 | 0 | 0 | 0 |
| minilisp | tc | 6 | 4 | 0 | 2 | 2 |
| minilisp | oc | 0 | 0 | 0 | 0 | 0 |
| csv-parser | tc | 3 | 1 | 0 | 1 | 0 |
| csv-parser | oc | 0 | 0 | 0 | 0 | 0 |

| Side | whole-symbol | match | pick | snippet | regex |
| --- | ---: | ---: | ---: | ---: | ---: |
| tc | 15 | 5 | 0 | 3 | 2 |
| oc | 0 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | creates |
| --- | --- | ---: |
| json-parser | tc | 7 |
| json-parser | oc | 0 |
| sexp-parser | tc | 9 |
| sexp-parser | oc | 0 |
| minilisp | tc | 3 |
| minilisp | oc | 0 |
| csv-parser | tc | 3 |
| csv-parser | oc | 0 |

| Side | creates |
| --- | ---: |
| tc | 22 |
| oc | 0 |

## Anomalies

Failing runs:

- sexp-parser oc rep1: tsc failed: error TS18003: No inputs were found in config file '/home/illu/repo/typescript-coder/tmp/benchmark/2026-10-22T07-28-55-482Z-ba8ae520/sexp-parser-oc-...
- minilisp oc rep1: tsc failed: error TS18003: No inputs were found in config file '/home/illu/repo/typescript-coder/tmp/benchmark/2026-10-22T07-28-55-482Z-ba8ae520/minilisp-oc-rep...
- minilisp oc rep3: tsc failed: src/lisp.ts(223,5): error TS2322: Type 'EvalResult' is not assignable to type 'LispValue'. Type 'Builtin' is not assignable to type 'LispValue'. src...

Runs with missing usage (`tokens.total` null):

- none

Truncation / timeouts:

- sexp-parser oc rep1: opencode run timed out after 1500000ms
- sexp-parser oc rep2: opencode run timed out after 1500000ms
- minilisp oc rep1: opencode run timed out after 1500000ms
- minilisp oc rep3: opencode run timed out after 1500000ms

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
| json-parser | tc | 1 | yes | 28,326 | 8,795 | 37,121 | $0.01454 | peak | 10 | 54.6 |
| json-parser | tc | 2 | yes | 12,427 | 2,906 | 15,333 | $0.00477 | peak | 6 | 30.6 |
| json-parser | tc | 3 | yes | 12,535 | 3,000 | 15,535 | $0.00491 | peak | 6 | 29.7 |
| json-parser | oc | 1 | yes | 4,660 | 1,940 | 7,027 | $0.00449 | peak | 6 | 341.2 |
| json-parser | oc | 2 | yes | 5,778 | 2,288 | 8,621 | $0.00539 | peak | 5 | 301.8 |
| json-parser | oc | 3 | yes | 13,924 | 2,064 | 16,159 | $0.00700 | peak | 4 | 71.7 |
| sexp-parser | tc | 1 | yes | 21,688 | 3,706 | 25,394 | $0.00817 | peak | 11 | 60.6 |
| sexp-parser | tc | 2 | yes | 6,556 | 378 | 6,934 | $0.00133 | peak | 4 | 11.5 |
| sexp-parser | tc | 3 | yes | 16,415 | 2,377 | 18,792 | $0.00473 | peak | 8 | 34.6 |
| sexp-parser | oc | 1 | no | 3,999 | 255 | 4,362 | $0.00170 | peak | 2 | 1500.0 |
| sexp-parser | oc | 2 | yes | 10,226 | 1,121 | 11,665 | $0.00494 | peak | 4 | 1500.0 |
| sexp-parser | oc | 3 | yes | 5,429 | 1,237 | 6,939 | $0.00367 | peak | 5 | 32.5 |
| minilisp | tc | 1 | yes | 28,888 | 3,002 | 31,890 | $0.00851 | peak | 11 | 45.0 |
| minilisp | tc | 2 | yes | 21,303 | 4,351 | 25,654 | $0.01007 | peak | 7 | 81.5 |
| minilisp | tc | 3 | yes | 22,696 | 2,849 | 25,545 | $0.00631 | peak | 9 | 24.5 |
| minilisp | oc | 1 | no | 3,909 | 186 | 4,186 | $0.00153 | peak | 1 | 1500.0 |
| minilisp | oc | 2 | yes | 16,304 | 3,963 | 21,483 | $0.01142 | peak | 6 | 65.4 |
| minilisp | oc | 3 | no | 5,541 | 2,768 | 9,101 | $0.00607 | peak | 3 | 1500.0 |
| csv-parser | tc | 1 | yes | 10,347 | 637 | 10,984 | $0.00304 | peak | 6 | 30.1 |
| csv-parser | tc | 2 | yes | 8,763 | 976 | 9,739 | $0.00214 | peak | 5 | 12.4 |
| csv-parser | tc | 3 | yes | 8,265 | 452 | 8,717 | $0.00133 | peak | 5 | 9.3 |
| csv-parser | oc | 1 | yes | 19,984 | 1,217 | 24,732 | $0.01182 | peak | 4 | 78.7 |
| csv-parser | oc | 2 | yes | 5,240 | 1,062 | 6,935 | $0.00379 | peak | 4 | 24.7 |
| csv-parser | oc | 3 | yes | 14,691 | 1,080 | 18,605 | $0.00925 | peak | 4 | 52.4 |

