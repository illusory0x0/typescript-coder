# Benchmark report — 2026-10-25

- mode: pilot
- model: deepseek-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: edit-dsl (#119)
- agent modes: plan-exec
- concurrency: 1
- tasks: minilisp
- sides: tc
- reps: 1
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-25T06:19:06.539Z
- pilot reference: none

## Frozen task specs

### minilisp

Spec (verbatim, identical for both sides):

````
# Task: Mini Lisp interpreter

Create `src/lisp.ts` implementing a small Lisp parser and evaluator.

## Public API

```ts
export type LispValue = number | boolean | LispValue[];

export function run(program: string): LispValue;
```

`run` parses all top-level forms, evaluates them in order in one fresh global
environment, and returns the value of the last form. Function values are
internal and must not escape as the final result. An empty program throws.

## Reading

- Whitespace (`space`, tab, LF, CR) separates forms and may appear anywhere
  between tokens.
- Numbers match an optional leading `-`, digits, and an optional `.` followed by
  digits. Convert them with `Number`.
- The atoms `true` and `false` are booleans. Every other non-numeric atom is a
  symbol string.
- Lists are parenthesized forms and may nest. A stray `)` or an unterminated
  list is a syntax error.

## Evaluation

- A number or boolean evaluates to itself.
- A symbol evaluates to its binding; an unknown symbol throws.
- A non-empty list is a call: evaluate the head and each argument, then apply
  the callable.
- An empty list at evaluation time throws.
- The environment is lexically scoped. A closure captures the environment in
  which it was created.

## Special forms

- `(if test then else)` evaluates `test`; only `false` is falsy (in particular,
  `0` is truthy). It evaluates and returns exactly one branch and requires
  exactly three operands.
- `(define name value)` evaluates `value`, binds it in the current environment,
  and returns the value. A later reference resolves it.
- `(define (name params...) body...)` is function-definition shorthand: it
  creates a closure with the given parameters and body and binds it to `name`.
- `(lambda (params...) body...)` creates a closure. Applying it binds arguments
  in a fresh child environment and evaluates the body forms in order, returning
  the last value.

## Builtins

The global environment contains these builtins:

- `+`, `-`, `*`, `/`: exactly two numeric arguments; arithmetic result.
- `=`: exactly two arguments; true when they are equal, otherwise false.
- `cons`: exactly two arguments; returns a pair as a two-element array
  `[head, tail]`.
- `car`: exactly one argument; returns element 0 of a non-empty pair.
- `cdr`: exactly one argument; returns element 1 of a pair that has a second
  element.

Pairs are represented as nested two-element arrays. For example:

```text
(cons 1 (cons 2 3)) -> [1, [2, 3]]
(car (cons 1 (cons 2 3))) -> 1
(cdr (cons 1 2)) -> 2
(cdr (cons 1 (cons 2 3))) -> [2, 3]
```

The evaluator must support recursive functions and closures, including a
closure that returns another closure. Calling a non-function, using a non-number
with arithmetic, wrong builtin arity, and malformed syntax all throw.

## Constraints

- Edit only `src/lisp.ts`; do not change `src/lisp.test.ts` or `tsconfig.json`.
- The fixture contains only those files. Do not create scratch files.
- The visible tests are the acceptance check: `bun test` and
  `bunx tsc --noEmit` must pass.
````

- fixture: benchmark/fixtures/minilisp/
- reference: benchmark/references/lisp.ts

## Cache warm-up

Only the cache-stable system prefixes were warmed; task-specific user prompts were not. These calls are excluded from every measured token/cost table.

| Agent mode | Prefix | Prompt chars | Raw in | Cache read | Cache hit | Duration (s) | Error |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| plan-exec | planning | 8845 | n/a | n/a | n/a | 1.1 | none |
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
| minilisp | tc | edit-dsl | plan-exec | 0/1 | 29,020 | 78.5% | 4,825 | 33,845 | $0.00757 | n/a | 35.3 | 14.0 |

## Overall comparison

| Side | Protocol | Agent mode | Success | Mean in (no cache) | Cache hit | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | 0/1 | 29,020 | 78.5% | 4,825 | 33,845 | 33,845 | $0.00757 | $0.00757 | n/a | 35.3 | 14.0 |

Per success (usage-run sums divided by successful runs):

| Side | Protocol | Agent mode | In (no cache) | Out | Total | Cost |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | n/a | n/a | n/a | n/a |

## Cache hit balance

Cache hit = cacheRead / raw prompt tokens (tc input includes hits; oc input excludes them).

| Side | Protocol | Agent mode | Cache hit | Cache-read tokens |
| --- | --- | --- | ---: | ---: |
| tc | edit-dsl | plan-exec | 78.5% | 105,728 |

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
| minilisp | tc | edit-dsl | plan-exec | 0 | 0 | 0 |

| Side | Protocol | Agent mode | range | matcher | whole-symbol |
| --- | --- | --- | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| minilisp | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

| Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | Protocol | Agent mode | creates |
| --- | --- | --- | --- | ---: |
| minilisp | tc | edit-dsl | plan-exec | 0 |

| Side | Protocol | Agent mode | creates |
| --- | --- | --- | ---: |
| tc | edit-dsl | plan-exec | 0 |

## Anomalies

Failing runs:

- minilisp tc rep1: token-budget: accumulated 125224 tokens exceeded the 120000 token budget

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
| minilisp | tc | edit-dsl | plan-exec | 1 | no | 134,748 | 4,323 | 139,071 | $0.00757 | off-peak | 14 | 35.3 |

