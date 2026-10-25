# Benchmark report — 2026-10-25

- mode: full
- model: deepseek-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: edit-dsl (#119)
- agent modes: pinned-repair, plan-exec
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp, csv-parser
- sides: tc
- reps: 5
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-25T11:05:38.084Z
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

### sexp-parser

Spec (verbatim, identical for both sides):

````
# Task: S-expression parser

Create `src/sexp.ts` with a small, dependency-free S-expression parser.

## Public API

```ts
export type Sexp = string | number | Sexp[];

export function parseSexp(text: string): Sexp;
```

`parseSexp` parses exactly one expression from the whole input. Leading and
trailing whitespace (`space`, tab, LF, CR) is allowed. If the input is empty or
whitespace-only, contains an unmatched parenthesis, or contains more than one
expression, throw a `SyntaxError`.

## Atoms

- Numeric atoms match an optional leading `-`, one or more digits, and an
  optional `.` followed by one or more digits. Convert them with `Number`.
  Examples: `42` -> `42`, `-7` -> `-7`, `3.5` -> `3.5`.
- Every other atom is a symbol and remains a string. Symbols may contain any
  characters other than whitespace, `(`, and `)`. Examples: `foo` -> `"foo"`,
  `+` -> `"+"`, `foo-bar?` -> `"foo-bar?"`.
- There are no string literals; quotes are ordinary symbol characters.

## Lists

- `()` is an empty list.
- A list is zero or more expressions between parentheses; whitespace separates
  items and may appear anywhere between tokens.
- Lists nest arbitrarily. `(a (b 1) ())` parses as
  `["a", ["b", 1], []]`.
- After the one top-level expression, only whitespace may remain. A stray or
  trailing `)` is an error, as is a second expression such as `a b` or
  `(a b) c`.

## Constraints

- Edit only `src/sexp.ts`; do not change `src/sexp.test.ts` or `tsconfig.json`.
- The fixture contains only those files. Do not create scratch files.
- The visible tests are the acceptance check: `bun test` and
  `bunx tsc --noEmit` must pass.
````

- fixture: benchmark/fixtures/sexp-parser/
- reference: benchmark/references/sexp.ts

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

### csv-parser

Spec (verbatim, identical for both sides):

````
# Task: CSV parser

Create `src/csv.ts` with a small, dependency-free CSV parser.

## Public API

```ts
export function parseCsv(text: string): string[][];
```

The result is an array of rows; each row is an array of string fields.

## Rows and fields

- Empty input returns `[]`.
- Rows are separated by LF (`\n`) or CRLF (`\r\n`). A lone `\r` is ordinary
  field data.
- A trailing row terminator does not add an empty final row. For example,
  `a,b\n` returns `[["a", "b"]]`.
- A blank line is a row containing one empty field: `a\n\nb` returns
  `[["a"], [""], ["b"]]`.
- Commas separate fields; empty fields are preserved. `a,,c` returns
  `[["a", "", "c"]]`.
- A line with no terminator still forms a row.

## Quoting

- A quote begins a quoted field only at the start of a field. A quoted field
  may contain commas, LF, and CRLF.
- Inside a quoted field, a doubled quote (`""`) represents one literal quote.
- An empty quoted field (`""`) is the empty string.
- After the closing quote, only a comma, a row terminator, or end of input may
  follow. Any other character is an error and must throw.
- A quote appearing inside an unquoted field is ordinary data, not an opening
  quote.

Examples:

```text
"a,b",c        -> [["a,b", "c"]]
"a""b",c       -> [["a\"b", "c"]]
"a\nb",c       -> [["a\nb", "c"]]
"",x           -> [["", "x"]]
"a"b           -> throws
```

## Constraints

- Edit only `src/csv.ts`; do not change `src/csv.test.ts` or `tsconfig.json`.
- The fixture contains only those files. Do not create scratch files.
- The visible tests are the acceptance check: `bun test` and
  `bunx tsc --noEmit` must pass.
````

- fixture: benchmark/fixtures/csv-parser/
- reference: benchmark/references/csv.ts

## Cache warm-up

Only the cache-stable system prefixes were warmed; task-specific user prompts were not. These calls are excluded from every measured token/cost table.

| Agent mode | Prefix | Prompt chars | Raw in | Cache read | Cache hit | Duration (s) | Error |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| pinned-repair | edit | 6667 | n/a | n/a | n/a | 0.7 | none |
| plan-exec | planning | 8903 | n/a | n/a | n/a | 0.6 | none |
| plan-exec | execution | 2816 | n/a | n/a | n/a | 0.7 | none |

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
| json-parser | tc | edit-dsl | pinned-repair | 5/5 | 7,449 | 53.9% | 2,773 | 10,222 | $0.00281 | $0.00281 | 10.5 | 6.6 |
| json-parser | tc | edit-dsl | plan-exec | 5/5 | 6,610 | 70.0% | 4,214 | 10,824 | $0.00357 | $0.00357 | 16.7 | 3.4 |
| sexp-parser | tc | edit-dsl | pinned-repair | 5/5 | 2,279 | 78.8% | 428 | 2,707 | $0.00062 | $0.00062 | 3.6 | 6.0 |
| sexp-parser | tc | edit-dsl | plan-exec | 5/5 | 4,185 | 72.7% | 1,630 | 5,815 | $0.00164 | $0.00164 | 10.0 | 3.4 |
| minilisp | tc | edit-dsl | pinned-repair | 5/5 | 13,086 | 59.2% | 4,672 | 17,758 | $0.00482 | $0.00482 | 19.2 | 9.2 |
| minilisp | tc | edit-dsl | plan-exec | 5/5 | 7,285 | 75.9% | 7,298 | 14,583 | $0.00554 | $0.00554 | 35.2 | 3.8 |
| csv-parser | tc | edit-dsl | pinned-repair | 5/5 | 3,120 | 72.2% | 541 | 3,662 | $0.00082 | $0.00082 | 4.3 | 6.0 |
| csv-parser | tc | edit-dsl | plan-exec | 5/5 | 5,064 | 79.2% | 2,591 | 7,656 | $0.00237 | $0.00237 | 13.8 | 3.6 |

## Overall comparison

| Side | Protocol | Agent mode | Success | Mean in (no cache) | Cache hit | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | pinned-repair | 20/20 | 6,484 | 66.0% | 2,103 | 8,587 | 171,746 | $0.00227 | $0.04535 | $0.00227 | 9.4 | 7.0 |
| tc | edit-dsl | plan-exec | 20/20 | 5,786 | 74.4% | 3,933 | 9,719 | 194,387 | $0.00328 | $0.06561 | $0.00328 | 18.9 | 3.5 |

Per success (usage-run sums divided by successful runs):

| Side | Protocol | Agent mode | In (no cache) | Out | Total | Cost |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| tc | edit-dsl | pinned-repair | 6,484 | 2,103 | 8,587 | $0.00227 |
| tc | edit-dsl | plan-exec | 5,786 | 3,933 | 9,719 | $0.00328 |

## Cache hit balance

Cache hit = cacheRead / raw prompt tokens (tc input includes hits; oc input excludes them).

| Side | Protocol | Agent mode | Cache hit | Cache-read tokens |
| --- | --- | --- | ---: | ---: |
| tc | edit-dsl | pinned-repair | 66.0% | 10,976 |
| tc | edit-dsl | plan-exec | 74.4% | 17,542 |

Success rates are equal: tc pinned-repair 20/20 (100.0%) vs tc plan-exec 20/20 (100.0%).

Token multiplier (cache-excluded): not comparable (both sides must run).

## Four-way comparison (oc / tc json / tc pinned-repair / tc plan-exec)

Baselines: oc `benchmark/results/oc-baseline.json` (deepseek/deepseek-flash, 3 reps, 2026-10-25); tc json `benchmark/results/json-format-baseline.json` (deepseek-flash, 3 reps, 2026-10-25).
Factor = baseline mean / variant mean; above 1 means the variant used that many times fewer cache-excluded tokens.

| Task | Variant | Mean total | Cache hit | vs oc baseline | vs tc json baseline |
| --- | --- | ---: | ---: | ---: | ---: |
| json-parser | oc baseline | 8,334 | 87.3% | 1.00x | 0.44x |
| json-parser | tc json baseline | 3,655 | 57.0% | 2.28x | 1.00x |
| json-parser | tc pinned-repair | 10,222 | 53.9% | 0.82x | 0.36x |
| json-parser | tc plan-exec | 10,824 | 70.0% | 0.77x | 0.34x |
| sexp-parser | oc baseline | 6,684 | 85.5% | 1.00x | 0.20x |
| sexp-parser | tc json baseline | 1,344 | 77.8% | 4.97x | 1.00x |
| sexp-parser | tc pinned-repair | 2,707 | 78.8% | 2.47x | 0.50x |
| sexp-parser | tc plan-exec | 5,815 | 72.7% | 1.15x | 0.23x |
| minilisp | oc baseline | 12,691 | 94.1% | 1.00x | 3.37x |
| minilisp | tc json baseline | 42,732 | 42.1% | 0.30x | 1.00x |
| minilisp | tc pinned-repair | 17,758 | 59.2% | 0.71x | 2.41x |
| minilisp | tc plan-exec | 14,583 | 75.9% | 0.87x | 2.93x |
| csv-parser | oc baseline | 7,906 | 87.8% | 1.00x | 0.17x |
| csv-parser | tc json baseline | 1,364 | 80.6% | 5.79x | 1.00x |
| csv-parser | tc pinned-repair | 3,662 | 72.2% | 2.16x | 0.37x |
| csv-parser | tc plan-exec | 7,656 | 79.2% | 1.03x | 0.18x |
| **all 4 tasks** | oc baseline | 35,615 | 88.7% | 1.00x | 1.38x |
| **all 4 tasks** | tc json baseline | 49,096 | 64.4% | 0.73x | 1.00x |
| **all 4 tasks** | tc pinned-repair | 34,349 | 66.0% | 1.04x | 1.43x |
| **all 4 tasks** | tc plan-exec | 38,877 | 74.4% | 0.92x | 1.26x |

Four-way savings (cache-excluded total): vs oc — tc pinned-repair 1.04x, tc plan-exec 0.92x; vs tc json — tc pinned-repair 1.43x, tc plan-exec 1.26x.

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
| json-parser | tc | edit-dsl | pinned-repair | 0 | 0 | 5 |
| json-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 |
| sexp-parser | tc | edit-dsl | pinned-repair | 0 | 0 | 5 |
| sexp-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 |
| minilisp | tc | edit-dsl | pinned-repair | 0 | 0 | 9 |
| minilisp | tc | edit-dsl | plan-exec | 0 | 0 | 0 |
| csv-parser | tc | edit-dsl | pinned-repair | 0 | 0 | 5 |
| csv-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 |

| Side | Protocol | Agent mode | range | matcher | whole-symbol |
| --- | --- | --- | ---: | ---: | ---: |
| tc | edit-dsl | pinned-repair | 0 | 0 | 24 |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | edit-dsl | pinned-repair | 5 | 0 | 0 | 0 | 0 |
| json-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | edit-dsl | pinned-repair | 5 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| minilisp | tc | edit-dsl | pinned-repair | 9 | 0 | 0 | 0 | 0 |
| minilisp | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| csv-parser | tc | edit-dsl | pinned-repair | 5 | 0 | 0 | 0 | 0 |
| csv-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

| Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | pinned-repair | 24 | 0 | 0 | 0 | 0 |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | Protocol | Agent mode | creates |
| --- | --- | --- | --- | ---: |
| json-parser | tc | edit-dsl | pinned-repair | 5 |
| json-parser | tc | edit-dsl | plan-exec | 0 |
| sexp-parser | tc | edit-dsl | pinned-repair | 5 |
| sexp-parser | tc | edit-dsl | plan-exec | 0 |
| minilisp | tc | edit-dsl | pinned-repair | 5 |
| minilisp | tc | edit-dsl | plan-exec | 0 |
| csv-parser | tc | edit-dsl | pinned-repair | 5 |
| csv-parser | tc | edit-dsl | plan-exec | 0 |

| Side | Protocol | Agent mode | creates |
| --- | --- | --- | ---: |
| tc | edit-dsl | pinned-repair | 20 |
| tc | edit-dsl | plan-exec | 0 |

## Anomalies

Failing runs:

- none

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
| json-parser | tc | edit-dsl | pinned-repair | 1 | yes | 18,488 | 3,444 | 21,932 | $0.00343 | off-peak | 7 | 12.5 |
| json-parser | tc | edit-dsl | plan-exec | 1 | yes | 25,888 | 4,157 | 30,045 | $0.00372 | off-peak | 3 | 17.1 |
| json-parser | tc | edit-dsl | pinned-repair | 2 | yes | 13,272 | 1,753 | 15,025 | $0.00206 | off-peak | 6 | 7.8 |
| json-parser | tc | edit-dsl | plan-exec | 2 | yes | 19,137 | 4,457 | 23,594 | $0.00368 | off-peak | 4 | 16.0 |
| json-parser | tc | edit-dsl | pinned-repair | 3 | yes | 13,272 | 1,753 | 15,025 | $0.00214 | off-peak | 6 | 7.4 |
| json-parser | tc | edit-dsl | plan-exec | 3 | yes | 18,776 | 4,372 | 23,148 | $0.00361 | off-peak | 4 | 16.6 |
| json-parser | tc | edit-dsl | pinned-repair | 4 | yes | 18,621 | 3,433 | 22,054 | $0.00342 | off-peak | 7 | 12.2 |
| json-parser | tc | edit-dsl | plan-exec | 4 | yes | 26,188 | 4,391 | 30,579 | $0.00387 | off-peak | 3 | 16.7 |
| json-parser | tc | edit-dsl | pinned-repair | 5 | yes | 18,520 | 3,481 | 22,001 | $0.00299 | off-peak | 7 | 12.5 |
| json-parser | tc | edit-dsl | plan-exec | 5 | yes | 20,628 | 3,694 | 24,322 | $0.00294 | off-peak | 3 | 17.3 |
| sexp-parser | tc | edit-dsl | pinned-repair | 1 | yes | 10,753 | 428 | 11,181 | $0.00091 | off-peak | 6 | 3.4 |
| sexp-parser | tc | edit-dsl | plan-exec | 1 | yes | 17,661 | 1,788 | 19,449 | $0.00186 | off-peak | 3 | 9.7 |
| sexp-parser | tc | edit-dsl | pinned-repair | 2 | yes | 10,753 | 428 | 11,181 | $0.00055 | off-peak | 6 | 3.8 |
| sexp-parser | tc | edit-dsl | plan-exec | 2 | yes | 17,941 | 1,678 | 19,619 | $0.00182 | off-peak | 3 | 9.1 |
| sexp-parser | tc | edit-dsl | pinned-repair | 3 | yes | 10,753 | 428 | 11,181 | $0.00055 | off-peak | 6 | 3.5 |
| sexp-parser | tc | edit-dsl | plan-exec | 3 | yes | 11,941 | 1,585 | 13,526 | $0.00158 | off-peak | 4 | 8.3 |
| sexp-parser | tc | edit-dsl | pinned-repair | 4 | yes | 10,753 | 428 | 11,181 | $0.00055 | off-peak | 6 | 3.3 |
| sexp-parser | tc | edit-dsl | plan-exec | 4 | yes | 11,939 | 1,516 | 13,455 | $0.00136 | off-peak | 4 | 11.4 |
| sexp-parser | tc | edit-dsl | pinned-repair | 5 | yes | 10,753 | 428 | 11,181 | $0.00055 | off-peak | 6 | 3.6 |
| sexp-parser | tc | edit-dsl | plan-exec | 5 | yes | 17,634 | 1,583 | 19,217 | $0.00158 | off-peak | 3 | 11.5 |
| minilisp | tc | edit-dsl | pinned-repair | 1 | yes | 15,694 | 2,298 | 17,992 | $0.00255 | off-peak | 6 | 9.6 |
| minilisp | tc | edit-dsl | plan-exec | 1 | yes | 23,657 | 5,382 | 29,039 | $0.00431 | off-peak | 3 | 29.0 |
| minilisp | tc | edit-dsl | pinned-repair | 2 | yes | 21,711 | 4,557 | 26,268 | $0.00418 | off-peak | 7 | 16.4 |
| minilisp | tc | edit-dsl | plan-exec | 2 | yes | 31,949 | 9,826 | 41,775 | $0.00768 | off-peak | 6 | 41.4 |
| minilisp | tc | edit-dsl | pinned-repair | 3 | yes | 79,134 | 11,732 | 90,866 | $0.01230 | off-peak | 18 | 47.5 |
| minilisp | tc | edit-dsl | plan-exec | 3 | yes | 33,146 | 7,839 | 40,985 | $0.00559 | off-peak | 4 | 36.5 |
| minilisp | tc | edit-dsl | pinned-repair | 4 | yes | 15,798 | 2,402 | 18,200 | $0.00225 | off-peak | 6 | 10.4 |
| minilisp | tc | edit-dsl | plan-exec | 4 | yes | 42,607 | 7,636 | 50,243 | $0.00574 | off-peak | 3 | 47.4 |
| minilisp | tc | edit-dsl | pinned-repair | 5 | yes | 24,871 | 2,370 | 27,241 | $0.00282 | off-peak | 9 | 12.2 |
| minilisp | tc | edit-dsl | plan-exec | 5 | yes | 24,746 | 5,806 | 30,552 | $0.00439 | off-peak | 3 | 21.7 |
| csv-parser | tc | edit-dsl | pinned-repair | 1 | yes | 11,204 | 534 | 11,738 | $0.00100 | off-peak | 6 | 4.3 |
| csv-parser | tc | edit-dsl | plan-exec | 1 | yes | 23,005 | 2,235 | 25,240 | $0.00220 | off-peak | 3 | 12.0 |
| csv-parser | tc | edit-dsl | pinned-repair | 2 | yes | 11,204 | 534 | 11,738 | $0.00074 | off-peak | 6 | 4.2 |
| csv-parser | tc | edit-dsl | plan-exec | 2 | yes | 22,852 | 2,047 | 24,899 | $0.00189 | off-peak | 3 | 13.5 |
| csv-parser | tc | edit-dsl | pinned-repair | 3 | yes | 11,213 | 545 | 11,758 | $0.00079 | off-peak | 6 | 4.3 |
| csv-parser | tc | edit-dsl | plan-exec | 3 | yes | 24,666 | 3,952 | 28,618 | $0.00347 | off-peak | 6 | 18.4 |
| csv-parser | tc | edit-dsl | pinned-repair | 4 | yes | 11,224 | 558 | 11,782 | $0.00080 | off-peak | 6 | 4.2 |
| csv-parser | tc | edit-dsl | plan-exec | 4 | yes | 28,853 | 2,360 | 31,213 | $0.00217 | off-peak | 3 | 13.2 |
| csv-parser | tc | edit-dsl | pinned-repair | 5 | yes | 11,205 | 535 | 11,740 | $0.00076 | off-peak | 6 | 4.6 |
| csv-parser | tc | edit-dsl | plan-exec | 5 | yes | 23,354 | 2,363 | 25,717 | $0.00214 | off-peak | 3 | 11.7 |

