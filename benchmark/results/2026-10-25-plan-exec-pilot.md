# Benchmark report — 2026-10-25

- mode: pilot
- model: deepseek-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: edit-dsl (#119)
- agent modes: plan-exec
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp, csv-parser
- sides: tc
- reps: 1
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-25T05:34:43.225Z
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
| plan-exec | planning | 8366 | n/a | n/a | n/a | 0.7 | none |
| plan-exec | execution | 2472 | n/a | n/a | n/a | 0.8 | none |

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
| json-parser | tc | edit-dsl | plan-exec | 0/1 | 19,305 | 52.1% | 3,704 | 23,009 | $0.00518 | n/a | 22.3 | 8.0 |
| sexp-parser | tc | edit-dsl | plan-exec | 1/1 | 10,131 | 59.4% | 1,748 | 11,879 | $0.00261 | $0.00261 | 13.0 | 7.0 |
| minilisp | tc | edit-dsl | plan-exec | 0/1 | 13,854 | 49.7% | 3,595 | 17,449 | $0.00428 | n/a | 16.0 | 0.0 |
| csv-parser | tc | edit-dsl | plan-exec | 0/1 | 48,687 | 63.9% | 5,514 | 54,201 | $0.01087 | n/a | 35.2 | 15.0 |

## Overall comparison

| Side | Protocol | Agent mode | Success | Mean in (no cache) | Cache hit | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | 1/4 | 22,994 | 56.3% | 3,640 | 26,635 | 106,538 | $0.00573 | $0.02294 | $0.02294 | 21.6 | 7.5 |

Per success (usage-run sums divided by successful runs):

| Side | Protocol | Agent mode | In (no cache) | Out | Total | Cost |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | 91,977 | 14,561 | 106,538 | $0.02294 |

## Cache hit balance

Cache hit = cacheRead / raw prompt tokens (tc input includes hits; oc input excludes them).

| Side | Protocol | Agent mode | Cache hit | Cache-read tokens |
| --- | --- | --- | ---: | ---: |
| tc | edit-dsl | plan-exec | 56.3% | 33,888 |

Only one side ran: tc plan-exec 1/4 (25.0%).

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
| sexp-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 |
| minilisp | tc | edit-dsl | plan-exec | 0 | 0 | 0 |
| csv-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 |

| Side | Protocol | Agent mode | range | matcher | whole-symbol |
| --- | --- | --- | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| minilisp | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| csv-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

| Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | Protocol | Agent mode | creates |
| --- | --- | --- | --- | ---: |
| json-parser | tc | edit-dsl | plan-exec | 0 |
| sexp-parser | tc | edit-dsl | plan-exec | 0 |
| minilisp | tc | edit-dsl | plan-exec | 0 |
| csv-parser | tc | edit-dsl | plan-exec | 0 |

| Side | Protocol | Agent mode | creates |
| --- | --- | --- | ---: |
| tc | edit-dsl | plan-exec | 0 |

## Anomalies

Failing runs:

- json-parser tc rep1: task-exhausted: the review turn produced neither approve nor one valid repair patch stage: task-protocol code: PLAN_UNKNOWN_FIELD message: edit~ record on line ...
- minilisp tc rep1: task-exhausted: the planner produced no valid plan after 3 attempts stage: task-tree - the initial Stage #02-core must contain exactly one current Task, not 4; ...
- csv-parser tc rep1: token-budget: accumulated 121722 tokens exceeded the 120000 token budget

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
| json-parser | tc | edit-dsl | plan-exec | 1 | no | 40,297 | 3,492 | 43,789 | $0.00518 | off-peak | 8 | 22.3 |
| sexp-parser | tc | edit-dsl | plan-exec | 1 | yes | 24,979 | 1,748 | 26,727 | $0.00261 | off-peak | 7 | 13.0 |
| minilisp | tc | edit-dsl | plan-exec | 1 | no | 27,550 | 3,308 | 30,858 | $0.00428 | off-peak | 0 | 16.0 |
| csv-parser | tc | edit-dsl | plan-exec | 1 | no | 134,703 | 5,505 | 140,208 | $0.01087 | off-peak | 15 | 35.2 |

