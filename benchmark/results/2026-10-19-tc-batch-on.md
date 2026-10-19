# Benchmark report — 2026-10-19

- mode: full
- model: deepseek-v4.1-flash
- effort: none (default)
- multi-payload: on (#69)
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp
- sides: tc
- reps: 3
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-19T16:00:29.594Z
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
| json-parser | tc | 3/3 | 3,347 | 1,606 | 4,953 | $0.00116 | $0.00116 | 10.5 | 3.0 |
| sexp-parser | tc | 3/3 | 2,815 | 536 | 3,351 | $0.00042 | $0.00042 | 5.7 | 3.0 |
| minilisp | tc | 0/3 | 69,128 | 56,562 | 125,690 | $0.03543 | n/a | 368.9 | 30.0 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 6/9 | 25,097 | 19,568 | 44,665 | 401,983 | $0.01234 | $0.11103 | $0.01850 | 128.4 | 12.0 |

Per success (usage-run sums divided by successful runs):

| Side | Input | Output | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 37,645 | 29,352 | 66,997 | $0.01850 |

Only one side ran: tc 6/9 (66.7%).

*Pricing footnote:* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Anomalies

Failing runs:

- minilisp tc rep1: token-budget: accumulated 123859 tokens exceeded the 120000 token budget
- minilisp tc rep2: token-budget: accumulated 121110 tokens exceeded the 120000 token budget
- minilisp tc rep3: token-budget: accumulated 122006 tokens exceeded the 120000 token budget

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
| json-parser | tc | 1 | yes | 3,347 | 1,541 | 4,888 | $0.00120 | off-peak | 3 | 10.5 |
| json-parser | tc | 2 | yes | 3,347 | 1,546 | 4,893 | $0.00098 | off-peak | 3 | 10.1 |
| json-parser | tc | 3 | yes | 3,347 | 1,730 | 5,077 | $0.00131 | off-peak | 3 | 10.8 |
| sexp-parser | tc | 1 | yes | 2,815 | 525 | 3,340 | $0.00055 | off-peak | 3 | 5.7 |
| sexp-parser | tc | 2 | yes | 2,815 | 559 | 3,374 | $0.00036 | off-peak | 3 | 6.0 |
| sexp-parser | tc | 3 | yes | 2,815 | 525 | 3,340 | $0.00034 | off-peak | 3 | 5.6 |
| minilisp | tc | 1 | no | 69,137 | 58,503 | 127,640 | $0.03659 | off-peak | 30 | 337.4 |
| minilisp | tc | 2 | no | 69,137 | 55,124 | 124,261 | $0.03409 | off-peak | 30 | 463.3 |
| minilisp | tc | 3 | no | 69,110 | 56,060 | 125,170 | $0.03561 | off-peak | 30 | 306.1 |

