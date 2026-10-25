# Benchmark report — 2026-10-25

- mode: pilot
- model: deepseek-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: edit-dsl (#119)
- agent modes: plan-exec
- concurrency: 1
- tasks: json-parser
- sides: tc
- reps: 1
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-25T05:47:23.972Z
- pilot reference: none

## Frozen task specs

### json-parser

Spec (verbatim, identical for both sides):

````
# Task: JSON parser

Create `src/json.ts` with a small, dependency-free JSON parser.

## Public API

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function parseJson(text: string): JsonValue;
```

`parseJson` parses exactly one JSON value from the whole input. Leading and
trailing whitespace (`space`, tab, LF, CR) is allowed. If the input is empty,
contains anything other than one complete value, or has trailing non-whitespace,
throw a `SyntaxError`.

## Values and grammar

- Literals: `null`, `true`, `false`.
- Numbers: an optional leading `-`, then either `0` or a non-zero digit followed
  by digits; an optional fractional part `.` followed by at least one digit; an
  optional exponent `e`/`E`, an optional sign, and at least one digit. Do not
  accept leading zeroes such as `01`. Examples that must parse:
  `42`, `-3.5`, `1e3`, `2.5E-2`.
- Strings: double-quoted. Support the escapes `\"`, `\\`, `\/`, `\b`, `\f`,
  `\n`, `\r`, `\t`, and `\uXXXX` with exactly four hex digits. Reject an
  unterminated string or invalid escape.
- Arrays: `[value, value, ...]`. Empty arrays and nested arrays are valid.
  Trailing commas are invalid.
- Objects: `{ "key": value, ... }`. Keys are strings. Empty objects, nested
  objects, and arbitrary whitespace between tokens are valid. A missing value
  or trailing comma is invalid.
- Whitespace may appear between any tokens, but not inside a number, literal,
  or string.

Malformed input must throw `SyntaxError`. This includes, at minimum, empty
input, truncated literals, leading zeroes, trailing commas, missing object
values, unterminated strings, and trailing input.

## Constraints

- Edit only `src/json.ts`; do not change `src/json.test.ts` or `tsconfig.json`.
- The fixture contains only those files. Do not create scratch files.
- The visible tests are the acceptance check: `bun test` and
  `bunx tsc --noEmit` must pass.
````

- fixture: benchmark/fixtures/json-parser/
- reference: benchmark/references/json.ts

## Cache warm-up

Only the cache-stable system prefixes were warmed; task-specific user prompts were not. These calls are excluded from every measured token/cost table.

| Agent mode | Prefix | Prompt chars | Raw in | Cache read | Cache hit | Duration (s) | Error |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| plan-exec | planning | 8366 | n/a | n/a | n/a | 0.8 | none |
| plan-exec | execution | 2472 | n/a | n/a | n/a | 0.9 | none |

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

| Task | Side | Protocol | Agent mode | Success | Mean in (no cache) | Cache hit | Mean out | Mean total | Mean $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | edit-dsl | plan-exec | 0/1 | 9,271 | 65.4% | 3,358 | 12,629 | $0.00346 | n/a | 14.3 | 0.0 |

## Overall comparison

| Side | Protocol | Agent mode | Success | Mean in (no cache) | Cache hit | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | 0/1 | 9,271 | 65.4% | 3,358 | 12,629 | 12,629 | $0.00346 | $0.00346 | n/a | 14.3 | 0.0 |

Per success (usage-run sums divided by successful runs):

| Side | Protocol | Agent mode | In (no cache) | Out | Total | Cost |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | n/a | n/a | n/a | n/a |

## Cache hit balance

Cache hit = cacheRead / raw prompt tokens (tc input includes hits; oc input excludes them).

| Side | Protocol | Agent mode | Cache hit | Cache-read tokens |
| --- | --- | --- | ---: | ---: |
| tc | edit-dsl | plan-exec | 65.4% | 17,536 |

Only one side ran: tc plan-exec 0/1 (0.0%).

Token multiplier (cache-excluded): not comparable (both sides must run).

## Baseline comparison unavailable

The frozen oc/tc-json baselines were measured with a different task-spec text and are not token-comparable to these spec runs. Re-freeze the baselines against `benchmark/specs/` before using the four-way table.

*Pricing footnote (decision-only):* USD costs use the official DeepSeek V4.1-Flash peak/off-peak
rates (fetched 2026-10-19 from https://api-docs.deepseek.com/quick_start/pricing; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
excluding Chinese public holidays; every other hour is off-peak. A run straddling
a boundary splits its cost by elapsed-time share.

## Selector adoption (#101)

Per task and side (payloads that used each selector):

| Task | Side | Protocol | Agent mode | range | matcher | whole-symbol |
| --- | --- | --- | --- | ---: | ---: | ---: |
| json-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 |

| Side | Protocol | Agent mode | range | matcher | whole-symbol |
| --- | --- | --- | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

| Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | Protocol | Agent mode | creates |
| --- | --- | --- | --- | ---: |
| json-parser | tc | edit-dsl | plan-exec | 0 |

| Side | Protocol | Agent mode | creates |
| --- | --- | --- | ---: |
| tc | edit-dsl | plan-exec | 0 |

## Anomalies

Failing runs:

- json-parser tc rep1: task-exhausted: the planner produced no valid plan after 3 attempts stage: task-protocol code: PLAN_UNKNOWN_FIELD message: task records must come before edit re...

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

| Task | Side | Protocol | Agent mode | Rep | OK | Raw in | Raw out | Raw total | Cost | Rate | Steps | Dur (s) |
| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| json-parser | tc | edit-dsl | plan-exec | 1 | no | 26,807 | 3,255 | 30,062 | $0.00346 | off-peak | 0 | 14.3 |

