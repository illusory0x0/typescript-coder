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
- generated: 2026-10-19T20:16:44.197Z
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
| minilisp | tc | 2/6 | 61,771 | 4,056 | 65,827 | $0.00952 | $0.02856 | 42.0 | 22.5 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | 2/6 | 61,771 | 4,056 | 65,827 | 394,961 | $0.00952 | $0.05711 | $0.02856 | 42.0 | 22.5 |

Per success (usage-run sums divided by successful runs):

| Side | Input | Output | Total | Cost |
| --- | ---: | ---: | ---: | ---: |
| tc | 185,313 | 12,168 | 197,481 | $0.02856 |

Only one side ran: tc 2/6 (33.3%).

*Pricing footnote:* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Anomalies

Failing runs:

- minilisp tc rep1: edit-exhausted: the model replied STOP after 12 consecutive failed rounds stage: tsc elsewhere in file: src/lisp.ts(115,7): error TS18047: 'expr' is possibly 'n...
- minilisp tc rep2: edit-exhausted: the model replied STOP after 8 consecutive failed rounds stage: tsc elsewhere in file: src/lisp.ts(70,48): error TS2677: A type predicate's type...
- minilisp tc rep4: edit-exhausted: the model replied STOP after 8 consecutive failed rounds stage: tsc replacement line 1: TS2345: Argument of type 'Builtin' is not assignable to ...
- minilisp tc rep5: token-budget: accumulated 122296 tokens exceeded the 120000 token budget

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
| minilisp | tc | 1 | no | 113,603 | 3,777 | 117,380 | $0.01601 | off-peak | 36 | 65.2 |
| minilisp | tc | 2 | no | 44,761 | 3,351 | 48,112 | $0.00579 | off-peak | 19 | 31.4 |
| minilisp | tc | 3 | yes | 23,214 | 3,860 | 27,074 | $0.00521 | off-peak | 12 | 22.7 |
| minilisp | tc | 4 | no | 64,895 | 5,278 | 70,173 | $0.01018 | off-peak | 22 | 47.8 |
| minilisp | tc | 5 | no | 120,495 | 5,816 | 126,311 | $0.01853 | off-peak | 43 | 77.6 |
| minilisp | tc | 6 | yes | 3,658 | 2,253 | 5,911 | $0.00139 | off-peak | 3 | 7.2 |

