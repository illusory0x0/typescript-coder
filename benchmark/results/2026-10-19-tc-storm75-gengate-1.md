# Benchmark report — 2026-10-19

- mode: full
- model: deepseek-v4.1-flash
- effort: none (default)
- multi-payload: off (default)
- concurrency: 4
- tasks: minilisp
- sides: tc
- reps: 6
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-19T19:39:38.636Z
- pilot reference: none

## Frozen task specs

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
| minilisp | tc | 5/6 | 40,418 | 3,120 | 43,538 | $0.00679 | $0.00815 | 27.9 | 15.7 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 5/6 | 40,418 | 3,120 | 43,538 | 261,226 | $0.00679 | $0.04073 | $0.00815 | 27.9 | 15.7 |

Per success (usage-run sums divided by successful runs):

| Side | Input | Output | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 48,501 | 3,744 | 52,245 | $0.00815 |

Only one side ran: tc 5/6 (83.3%).

*Pricing footnote:* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Anomalies

Failing runs:

- minilisp tc rep2: edit-exhausted: the model replied STOP after 12 consecutive failed rounds stage: tsc elsewhere in file: src/lisp.ts(117,21): error TS2345: Argument of type 'Lis...

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
| minilisp | tc | 1 | yes | 59,009 | 2,970 | 61,979 | $0.00939 | off-peak | 23 | 35.4 |
| minilisp | tc | 2 | no | 108,831 | 4,423 | 113,254 | $0.01549 | off-peak | 33 | 63.4 |
| minilisp | tc | 3 | yes | 14,620 | 3,749 | 18,369 | $0.00393 | off-peak | 7 | 19.1 |
| minilisp | tc | 4 | yes | 25,903 | 2,458 | 28,361 | $0.00485 | off-peak | 13 | 22.1 |
| minilisp | tc | 5 | yes | 19,639 | 2,922 | 22,561 | $0.00408 | off-peak | 9 | 14.9 |
| minilisp | tc | 6 | yes | 14,504 | 2,198 | 16,702 | $0.00299 | off-peak | 9 | 12.3 |

