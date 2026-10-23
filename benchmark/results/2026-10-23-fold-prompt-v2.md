# Benchmark report — 2026-10-23

- mode: full
- model: deepseek-v4.1-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: edit-dsl (#119)
- concurrency: 4
- tasks: minilisp
- sides: tc
- reps: 5
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-23T00:01:36.472Z
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
| minilisp | tc | edit-dsl | 4/5 | 23,708 | 5,412 | 29,121 | $0.00690 | $0.00862 | 49.7 | 14.8 |

## Overall comparison

| Side | Protocol | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | 4/5 | 23,708 | 5,412 | 29,121 | 145,603 | $0.00690 | $0.03448 | $0.00862 | 49.7 | 14.8 |

Per success (usage-run sums divided by successful runs):

| Side | Protocol | In (no cache) | Out | Total | Cost |
| --- | --- | ---: | ---: | ---: | ---: |
| tc | edit-dsl | 29,635 | 6,766 | 36,401 | $0.00862 |

Only one side ran: tc 4/5 (80.0%).

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
| minilisp | tc | edit-dsl | 0 | 2 | 16 |

| Side | Protocol | range | matcher | whole-symbol |
| --- | --- | ---: | ---: | ---: |
| tc | edit-dsl | 0 | 2 | 16 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | Protocol | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| minilisp | tc | edit-dsl | 16 | 2 | 0 | 1 | 1 |

| Side | Protocol | whole-symbol | match | pick | snippet | regex |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | 16 | 2 | 0 | 1 | 1 |

Implicit creates (#111):

| Task | Side | Protocol | creates |
| --- | --- | --- | ---: |
| minilisp | tc | edit-dsl | 4 |

| Side | Protocol | creates |
| --- | --- | ---: |
| tc | edit-dsl | 4 |

## Anomalies

Failing runs:

- minilisp tc rep2: token-budget: accumulated 122512 tokens exceeded the 120000 token budget

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
| minilisp | tc | edit-dsl | 1 | yes | 19,120 | 3,011 | 22,131 | $0.00349 | off-peak | 9 | 28.9 |
| minilisp | tc | edit-dsl | 2 | no | 120,880 | 8,373 | 129,253 | $0.01215 | off-peak | 24 | 79.6 |
| minilisp | tc | edit-dsl | 3 | yes | 25,203 | 2,674 | 27,877 | $0.00328 | off-peak | 11 | 27.2 |
| minilisp | tc | edit-dsl | 4 | yes | 72,702 | 3,889 | 76,591 | $0.00789 | off-peak | 21 | 54.9 |
| minilisp | tc | edit-dsl | 5 | yes | 34,236 | 9,081 | 43,317 | $0.00767 | off-peak | 9 | 58.1 |

