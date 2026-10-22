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
- generated: 2026-10-22T11:56:27.374Z
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
| json-parser | tc | 3/3 | 5,503 | 1,603 | 7,107 | $0.00180 | $0.00180 | 10.4 | 4.7 |
| json-parser | oc | 3/3 | 5,514 | 2,510 | 8,025 | $0.00244 | $0.00244 | 170.4 | 4.3 |
| sexp-parser | tc | 3/3 | 3,623 | 505 | 4,128 | $0.00086 | $0.00086 | 6.2 | 5.3 |
| sexp-parser | oc | 3/3 | 7,628 | 1,344 | 8,972 | $0.00204 | $0.00204 | 31.4 | 4.3 |
| minilisp | tc | 1/3 | 59,027 | 9,782 | 68,809 | $0.01489 | $0.04466 | 65.5 | 20.7 |
| minilisp | oc | 1/3 | 2,895 | 2,086 | 4,980 | $0.00174 | $0.00522 | 1394.6 | 2.3 |
| csv-parser | tc | 3/3 | 5,158 | 717 | 5,875 | $0.00122 | $0.00122 | 6.9 | 6.3 |
| csv-parser | oc | 2/3 | 4,802 | 1,813 | 6,615 | $0.00188 | $0.00281 | 550.1 | 3.0 |

## Overall comparison

| Side | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 10/12 | 18,328 | 3,152 | 21,480 | 257,756 | $0.00469 | $0.05629 | $0.00563 | 22.2 | 9.3 |
| oc | 9/12 | 5,210 | 1,938 | 7,148 | 85,775 | $0.00202 | $0.02429 | $0.00270 | 536.6 | 3.5 |

Per success (usage-run sums divided by successful runs):

| Side | In (no cache) | Out | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 21,993 | 3,782 | 25,776 | $0.00563 |
| oc | 6,946 | 2,584 | 9,531 | $0.00270 |

Success rates differ: tc 10/12 (83.3%) vs oc 9/12 (75.0%).

Token multiplier (cache-excluded total, higher/lower): tc 3.01x oc overall; json-parser oc 1.13x tc; sexp-parser oc 2.17x tc; minilisp tc 13.82x oc; csv-parser oc 1.13x tc.

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
| minilisp | tc | 0 | 1 | 7 |
| minilisp | oc | 0 | 0 | 0 |
| csv-parser | tc | 0 | 0 | 4 |
| csv-parser | oc | 0 | 0 | 0 |

| Side | range | matcher | whole-symbol |
| --- | ---: | ---: | ---: |
| tc | 0 | 1 | 17 |
| oc | 0 | 0 | 0 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | whole-symbol | match | pick | snippet | regex |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | 3 | 0 | 0 | 0 | 0 |
| json-parser | oc | 0 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | 3 | 0 | 0 | 0 | 0 |
| sexp-parser | oc | 0 | 0 | 0 | 0 | 0 |
| minilisp | tc | 7 | 1 | 0 | 1 | 0 |
| minilisp | oc | 0 | 0 | 0 | 0 | 0 |
| csv-parser | tc | 4 | 0 | 0 | 0 | 0 |
| csv-parser | oc | 0 | 0 | 0 | 0 | 0 |

| Side | whole-symbol | match | pick | snippet | regex |
| --- | ---: | ---: | ---: | ---: | ---: |
| tc | 17 | 1 | 0 | 1 | 0 |
| oc | 0 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | creates |
| --- | --- | ---: |
| json-parser | tc | 3 |
| json-parser | oc | 0 |
| sexp-parser | tc | 3 |
| sexp-parser | oc | 0 |
| minilisp | tc | 2 |
| minilisp | oc | 0 |
| csv-parser | tc | 4 |
| csv-parser | oc | 0 |

| Side | creates |
| --- | ---: |
| tc | 12 |
| oc | 0 |

## Anomalies

Failing runs:

- minilisp tc rep1: token-budget: accumulated 121272 tokens exceeded the 120000 token budget
- minilisp tc rep2: token-budget: accumulated 120729 tokens exceeded the 120000 token budget
- minilisp oc rep1: tsc failed: error TS18003: No inputs were found in config file '/home/illu/repo/typescript-coder/tmp/benchmark/2026-10-22T11-56-27-895Z-98512a93/minilisp-oc-rep...
- minilisp oc rep3: tsc failed: error TS18003: No inputs were found in config file '/home/illu/repo/typescript-coder/tmp/benchmark/2026-10-22T11-56-27-895Z-98512a93/minilisp-oc-rep...
- csv-parser oc rep3: tsc failed: error TS18003: No inputs were found in config file '/home/illu/repo/typescript-coder/tmp/benchmark/2026-10-22T11-56-27-895Z-98512a93/csv-parser-oc-r...

Runs with missing usage (`tokens.total` null):

- none

Truncation / timeouts:

- minilisp oc rep1: opencode run timed out after 1500000ms
- minilisp oc rep3: opencode run timed out after 1500000ms
- csv-parser oc rep3: opencode run timed out after 1500000ms

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
| json-parser | tc | 1 | yes | 10,896 | 1,618 | 12,514 | $0.00176 | off-peak | 6 | 10.7 |
| json-parser | tc | 2 | yes | 9,513 | 1,567 | 11,080 | $0.00208 | off-peak | 4 | 10.2 |
| json-parser | tc | 3 | yes | 9,541 | 1,625 | 11,166 | $0.00156 | off-peak | 4 | 10.2 |
| json-parser | oc | 1 | yes | 5,464 | 2,105 | 7,790 | $0.00231 | off-peak | 4 | 406.4 |
| json-parser | oc | 2 | yes | 5,442 | 2,182 | 8,056 | $0.00248 | off-peak | 4 | 59.9 |
| json-parser | oc | 3 | yes | 5,637 | 2,492 | 8,228 | $0.00253 | off-peak | 5 | 45.0 |
| sexp-parser | tc | 1 | yes | 9,312 | 474 | 9,786 | $0.00104 | off-peak | 5 | 7.8 |
| sexp-parser | tc | 2 | yes | 7,026 | 344 | 7,370 | $0.00053 | off-peak | 6 | 4.3 |
| sexp-parser | tc | 3 | yes | 6,564 | 696 | 7,260 | $0.00101 | off-peak | 5 | 6.5 |
| sexp-parser | oc | 1 | yes | 12,204 | 1,111 | 13,495 | $0.00267 | off-peak | 4 | 32.3 |
| sexp-parser | oc | 2 | yes | 5,464 | 1,164 | 6,909 | $0.00180 | off-peak | 5 | 36.7 |
| sexp-parser | oc | 3 | yes | 5,217 | 1,071 | 6,512 | $0.00165 | off-peak | 4 | 25.2 |
| minilisp | tc | 1 | no | 118,558 | 9,894 | 128,452 | $0.01589 | off-peak | 19 | 69.4 |
| minilisp | tc | 2 | no | 116,697 | 11,052 | 127,749 | $0.01573 | off-peak | 23 | 72.8 |
| minilisp | tc | 3 | yes | 103,745 | 7,950 | 111,695 | $0.01303 | off-peak | 20 | 54.3 |
| minilisp | oc | 1 | no | 3,909 | 220 | 4,140 | $0.00074 | off-peak | 1 | 1500.0 |
| minilisp | oc | 2 | yes | 4,621 | 2,811 | 10,465 | $0.00435 | off-peak | 6 | 1183.7 |
| minilisp | oc | 3 | no | 154 | 10 | 336 | $0.00013 | off-peak | 0 | 1500.0 |
| csv-parser | tc | 1 | yes | 14,800 | 1,064 | 15,864 | $0.00192 | off-peak | 9 | 10.0 |
| csv-parser | tc | 2 | yes | 7,581 | 479 | 8,060 | $0.00084 | off-peak | 6 | 5.4 |
| csv-parser | tc | 3 | yes | 8,581 | 609 | 9,190 | $0.00090 | off-peak | 4 | 5.5 |
| csv-parser | oc | 1 | yes | 5,226 | 1,181 | 8,023 | $0.00256 | off-peak | 4 | 89.2 |
| csv-parser | oc | 2 | yes | 5,274 | 1,069 | 7,723 | $0.00235 | off-peak | 4 | 61.2 |
| csv-parser | oc | 3 | no | 3,905 | 174 | 4,098 | $0.00071 | off-peak | 1 | 1500.0 |

