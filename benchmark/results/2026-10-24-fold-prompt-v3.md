# Benchmark report — 2026-10-24

- mode: full
- model: deepseek-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: edit-dsl (#119)
- concurrency: 4
- tasks: minilisp
- sides: tc
- reps: 5
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-24T09:49:20.420Z
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

| Task | Side | Protocol | Success | Mean in (no cache) | Mean out | Mean total | Mean $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| minilisp | tc | edit-dsl | 2/5 | 36,173 | 7,545 | 43,718 | $0.01009 | $0.02522 | 34.7 | 18.8 |

## Overall comparison

| Side | Protocol | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | 2/5 | 36,173 | 7,545 | 43,718 | 218,590 | $0.01009 | $0.05044 | $0.02522 | 34.7 | 18.8 |

Per success (usage-run sums divided by successful runs):

| Side | Protocol | In (no cache) | Out | Total | Cost |
| --- | --- | ---: | ---: | ---: | ---: |
| tc | edit-dsl | 90,434 | 18,862 | 109,295 | $0.02522 |

Only one side ran: tc 2/5 (40.0%).

Token multiplier (cache-excluded): not comparable (both sides must run).

*Pricing footnote (decision-only):* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Selector adoption (#101)

Per task and side (payloads that used each selector):

| Task | Side | Protocol | range | matcher | whole-symbol |
| --- | --- | --- | ---: | ---: | ---: |
| minilisp | tc | edit-dsl | 0 | 0 | 15 |

| Side | Protocol | range | matcher | whole-symbol |
| --- | --- | ---: | ---: | ---: |
| tc | edit-dsl | 0 | 0 | 15 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | Protocol | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| minilisp | tc | edit-dsl | 15 | 0 | 0 | 0 | 0 |

| Side | Protocol | whole-symbol | match | pick | snippet | regex |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | 15 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | Protocol | creates |
| --- | --- | --- | ---: |
| minilisp | tc | edit-dsl | 5 |

| Side | Protocol | creates |
| --- | --- | ---: |
| tc | edit-dsl | 5 |

## Anomalies

Failing runs:

- minilisp tc rep1: token-budget: accumulated 125096 tokens exceeded the 120000 token budget
- minilisp tc rep2: token-budget: accumulated 122031 tokens exceeded the 120000 token budget
- minilisp tc rep4: token-budget: accumulated 122064 tokens exceeded the 120000 token budget

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

| Task | Side | Protocol | Rep | OK | Raw in | Raw out | Raw total | Cost | Rate | Steps | Dur (s) |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| minilisp | tc | edit-dsl | 1 | no | 124,156 | 8,764 | 132,920 | $0.01393 | off-peak | 28 | 44.9 |
| minilisp | tc | edit-dsl | 2 | no | 110,438 | 16,790 | 127,228 | $0.01871 | off-peak | 23 | 63.0 |
| minilisp | tc | edit-dsl | 3 | yes | 27,411 | 3,987 | 31,398 | $0.00445 | off-peak | 9 | 17.2 |
| minilisp | tc | edit-dsl | 4 | no | 121,764 | 5,093 | 126,857 | $0.01012 | off-peak | 26 | 35.3 |
| minilisp | tc | edit-dsl | 5 | yes | 24,042 | 3,071 | 27,113 | $0.00323 | off-peak | 8 | 13.2 |

