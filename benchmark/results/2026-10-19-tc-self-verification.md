# Benchmark report — 2026-10-19

- mode: full
- model: deepseek-v4.1-flash
- effort: none (default)
- multi-payload: off (default)
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp
- sides: tc
- reps: 3
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-19T17:07:21.340Z
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
| json-parser | tc | 3/3 | 4,423 | 2,256 | 6,679 | $0.00151 | $0.00151 | 14.3 | 3.3 |
| sexp-parser | tc | 3/3 | 2,673 | 548 | 3,221 | $0.00035 | $0.00035 | 5.2 | 3.0 |
| minilisp | tc | 2/3 | 66,890 | 5,421 | 72,310 | $0.01102 | $0.01652 | 57.1 | 22.3 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 8/9 | 24,662 | 2,741 | 27,403 | 246,631 | $0.00429 | $0.03863 | $0.00483 | 25.6 | 9.6 |

Per success (usage-run sums divided by successful runs):

| Side | Input | Output | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 27,745 | 3,084 | 30,829 | $0.00483 |

Only one side ran: tc 8/9 (88.9%).

*Pricing footnote:* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Anomalies

Failing runs:

- minilisp tc rep3: token-budget: accumulated 122847 tokens exceeded the 120000 token budget

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
| json-parser | tc | 1 | yes | 3,205 | 1,612 | 4,817 | $0.00100 | off-peak | 3 | 11.5 |
| json-parser | tc | 2 | yes | 6,860 | 3,518 | 10,378 | $0.00252 | off-peak | 4 | 20.0 |
| json-parser | tc | 3 | yes | 3,205 | 1,638 | 4,843 | $0.00101 | off-peak | 3 | 11.4 |
| sexp-parser | tc | 1 | yes | 2,673 | 559 | 3,232 | $0.00036 | off-peak | 3 | 5.6 |
| sexp-parser | tc | 2 | yes | 2,673 | 525 | 3,198 | $0.00034 | off-peak | 3 | 5.1 |
| sexp-parser | tc | 3 | yes | 2,673 | 559 | 3,232 | $0.00036 | off-peak | 3 | 5.0 |
| minilisp | tc | 1 | yes | 55,848 | 4,394 | 60,242 | $0.00956 | off-peak | 21 | 44.4 |
| minilisp | tc | 2 | yes | 26,485 | 2,656 | 29,141 | $0.00434 | off-peak | 13 | 29.0 |
| minilisp | tc | 3 | no | 118,336 | 9,212 | 127,548 | $0.01914 | off-peak | 33 | 98.0 |

