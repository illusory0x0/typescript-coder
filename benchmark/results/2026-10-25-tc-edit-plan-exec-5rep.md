# Benchmark report — 2026-10-24

- mode: full
- model: deepseek-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: edit-dsl (#119)
- agent modes: edit, plan-exec
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp, csv-parser
- sides: tc
- reps: 5
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-24T22:03:27.217Z
- pilot reference: benchmark/results/pilot-2026-10-24.json

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
| edit | edit | 6401 | n/a | n/a | n/a | 0.9 | none |
| plan-exec | planning | 3616 | n/a | n/a | n/a | 0.7 | none |
| plan-exec | execution | 1881 | n/a | n/a | n/a | 0.4 | none |

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
| json-parser | tc | edit-dsl | edit | 5/5 | 3,762 | 70.8% | 1,735 | 5,497 | $0.00163 | $0.00163 | 9.9 | 6.0 |
| json-parser | tc | edit-dsl | plan-exec | 1/5 | 30,114 | 64.2% | 9,908 | 40,021 | $0.01063 | $0.05314 | 69.1 | 14.8 |
| sexp-parser | tc | edit-dsl | edit | 5/5 | 1,880 | 82.0% | 432 | 2,311 | $0.00057 | $0.00057 | 3.7 | 5.6 |
| sexp-parser | tc | edit-dsl | plan-exec | 5/5 | 6,953 | 66.4% | 2,307 | 9,261 | $0.00247 | $0.00247 | 15.3 | 11.8 |
| minilisp | tc | edit-dsl | edit | 5/5 | 3,816 | 76.2% | 2,295 | 6,111 | $0.00199 | $0.00199 | 13.6 | 4.4 |
| minilisp | tc | edit-dsl | plan-exec | 0/5 | 31,373 | 64.9% | 11,432 | 42,805 | $0.01174 | n/a | 63.1 | 11.6 |
| csv-parser | tc | edit-dsl | edit | 5/5 | 2,555 | 76.4% | 532 | 3,088 | $0.00073 | $0.00073 | 8.8 | 6.0 |
| csv-parser | tc | edit-dsl | plan-exec | 5/5 | 10,091 | 62.7% | 3,295 | 13,386 | $0.00355 | $0.00355 | 23.7 | 11.4 |

## Overall comparison

| Side | Protocol | Agent mode | Success | Mean in (no cache) | Cache hit | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | edit | 20/20 | 3,003 | 76.3% | 1,249 | 4,252 | 85,033 | $0.00123 | $0.02457 | $0.00123 | 9.0 | 5.5 |
| tc | edit-dsl | plan-exec | 11/20 | 19,633 | 64.5% | 6,736 | 26,368 | 527,365 | $0.00710 | $0.14192 | $0.01290 | 42.8 | 12.4 |

Per success (usage-run sums divided by successful runs):

| Side | Protocol | Agent mode | In (no cache) | Out | Total | Cost |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| tc | edit-dsl | edit | 3,003 | 1,249 | 4,252 | $0.00123 |
| tc | edit-dsl | plan-exec | 35,696 | 12,247 | 47,942 | $0.01290 |

## Cache hit balance

Cache hit = cacheRead / raw prompt tokens (tc input includes hits; oc input excludes them).

| Side | Protocol | Agent mode | Cache hit | Cache-read tokens |
| --- | --- | --- | ---: | ---: |
| tc | edit-dsl | edit | 76.3% | 9,574 |
| tc | edit-dsl | plan-exec | 64.5% | 36,512 |

Success rates differ: tc edit 20/20 (100.0%) vs tc plan-exec 11/20 (55.0%).

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
| json-parser | tc | edit-dsl | edit | 0 | 0 | 5 |
| json-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 |
| sexp-parser | tc | edit-dsl | edit | 0 | 0 | 5 |
| sexp-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 |
| minilisp | tc | edit-dsl | edit | 0 | 0 | 5 |
| minilisp | tc | edit-dsl | plan-exec | 0 | 0 | 0 |
| csv-parser | tc | edit-dsl | edit | 0 | 0 | 5 |
| csv-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 |

| Side | Protocol | Agent mode | range | matcher | whole-symbol |
| --- | --- | --- | ---: | ---: | ---: |
| tc | edit-dsl | edit | 0 | 0 | 20 |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | tc | edit-dsl | edit | 5 | 0 | 0 | 0 | 0 |
| json-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | edit-dsl | edit | 5 | 0 | 0 | 0 | 0 |
| sexp-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| minilisp | tc | edit-dsl | edit | 5 | 0 | 0 | 0 | 0 |
| minilisp | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |
| csv-parser | tc | edit-dsl | edit | 5 | 0 | 0 | 0 | 0 |
| csv-parser | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

| Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | edit | 20 | 0 | 0 | 0 | 0 |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | Protocol | Agent mode | creates |
| --- | --- | --- | --- | ---: |
| json-parser | tc | edit-dsl | edit | 5 |
| json-parser | tc | edit-dsl | plan-exec | 0 |
| sexp-parser | tc | edit-dsl | edit | 5 |
| sexp-parser | tc | edit-dsl | plan-exec | 0 |
| minilisp | tc | edit-dsl | edit | 5 |
| minilisp | tc | edit-dsl | plan-exec | 0 |
| csv-parser | tc | edit-dsl | edit | 5 |
| csv-parser | tc | edit-dsl | plan-exec | 0 |

| Side | Protocol | Agent mode | creates |
| --- | --- | --- | ---: |
| tc | edit-dsl | edit | 20 |
| tc | edit-dsl | plan-exec | 0 |

## Anomalies

Failing runs:

- json-parser tc rep1: task-exhausted: the planner returned the same tree after a failure or a failing suite; no progress is possible
- json-parser tc rep2: task-exhausted: the planner produced no valid plan after 3 attempts stage: task-tree - the final task #26 must verify "test" so the run ends with the test suite...
- json-parser tc rep4: token-budget: accumulated 121395 tokens exceeded the 120000 token budget
- json-parser tc rep5: task-exhausted: the planner produced no valid plan after 3 attempts stage: task-tree - the final task #21 must verify "test" so the run ends with the test suite...
- minilisp tc rep1: token-budget: accumulated 121976 tokens exceeded the 120000 token budget
- minilisp tc rep2: task-exhausted: the planner returned the same tree after a failure or a failing suite; no progress is possible
- minilisp tc rep3: task-exhausted: the planner produced no valid plan after 3 attempts stage: task-tree - the final task #27 must verify "test" so the run ends with the test suite...
- minilisp tc rep4: task-exhausted: the planner produced no valid plan after 3 attempts stage: task-tree - done edit #6 is immutable - done edit #7 is immutable
- minilisp tc rep5: task-exhausted: the planner produced no valid plan after 3 attempts stage: task-tree - the final task #26 must verify "test" so the run ends with the test suite...

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
| json-parser | tc | edit-dsl | edit | 1 | yes | 12,959 | 1,819 | 14,778 | $0.00174 | off-peak | 6 | 8.1 |
| json-parser | tc | edit-dsl | plan-exec | 1 | no | 118,565 | 11,471 | 130,036 | $0.01374 | off-peak | 16 | 87.2 |
| json-parser | tc | edit-dsl | edit | 2 | yes | 12,881 | 1,741 | 14,622 | $0.00168 | off-peak | 6 | 8.6 |
| json-parser | tc | edit-dsl | plan-exec | 2 | no | 62,514 | 9,647 | 72,161 | $0.00981 | off-peak | 8 | 60.8 |
| json-parser | tc | edit-dsl | edit | 3 | yes | 12,875 | 1,735 | 14,610 | $0.00164 | off-peak | 6 | 6.9 |
| json-parser | tc | edit-dsl | plan-exec | 3 | yes | 77,888 | 8,663 | 86,551 | $0.00924 | off-peak | 23 | 77.6 |
| json-parser | tc | edit-dsl | edit | 4 | yes | 12,777 | 1,637 | 14,414 | $0.00154 | off-peak | 6 | 7.6 |
| json-parser | tc | edit-dsl | plan-exec | 4 | no | 125,890 | 12,010 | 137,900 | $0.01340 | off-peak | 24 | 89.6 |
| json-parser | tc | edit-dsl | edit | 5 | yes | 12,884 | 1,744 | 14,628 | $0.00157 | off-peak | 6 | 18.2 |
| json-parser | tc | edit-dsl | plan-exec | 5 | no | 43,087 | 7,189 | 50,276 | $0.00696 | off-peak | 3 | 30.2 |
| sexp-parser | tc | edit-dsl | edit | 1 | yes | 10,378 | 428 | 10,806 | $0.00068 | off-peak | 6 | 4.3 |
| sexp-parser | tc | edit-dsl | plan-exec | 1 | yes | 35,295 | 4,592 | 39,887 | $0.00468 | off-peak | 15 | 25.1 |
| sexp-parser | tc | edit-dsl | edit | 2 | yes | 10,371 | 421 | 10,792 | $0.00055 | off-peak | 6 | 3.6 |
| sexp-parser | tc | edit-dsl | plan-exec | 2 | yes | 19,845 | 1,904 | 21,749 | $0.00226 | off-peak | 12 | 13.8 |
| sexp-parser | tc | edit-dsl | edit | 3 | yes | 10,371 | 421 | 10,792 | $0.00055 | off-peak | 6 | 3.9 |
| sexp-parser | tc | edit-dsl | plan-exec | 3 | yes | 16,940 | 1,767 | 18,707 | $0.00193 | off-peak | 11 | 12.4 |
| sexp-parser | tc | edit-dsl | edit | 4 | yes | 10,885 | 437 | 11,322 | $0.00039 | off-peak | 4 | 3.2 |
| sexp-parser | tc | edit-dsl | plan-exec | 4 | yes | 16,612 | 1,703 | 18,315 | $0.00186 | off-peak | 11 | 13.5 |
| sexp-parser | tc | edit-dsl | edit | 5 | yes | 10,401 | 451 | 10,852 | $0.00066 | off-peak | 6 | 3.3 |
| sexp-parser | tc | edit-dsl | plan-exec | 5 | yes | 13,659 | 1,571 | 15,230 | $0.00162 | off-peak | 10 | 11.6 |
| minilisp | tc | edit-dsl | edit | 1 | yes | 16,375 | 2,337 | 18,712 | $0.00196 | off-peak | 4 | 9.8 |
| minilisp | tc | edit-dsl | plan-exec | 1 | no | 128,014 | 14,750 | 142,764 | $0.01680 | off-peak | 16 | 79.3 |
| minilisp | tc | edit-dsl | edit | 2 | yes | 16,343 | 2,305 | 18,648 | $0.00190 | off-peak | 4 | 9.5 |
| minilisp | tc | edit-dsl | plan-exec | 2 | no | 117,190 | 10,441 | 127,631 | $0.01176 | off-peak | 20 | 68.2 |
| minilisp | tc | edit-dsl | edit | 3 | yes | 16,172 | 2,129 | 18,301 | $0.00182 | off-peak | 4 | 9.4 |
| minilisp | tc | edit-dsl | plan-exec | 3 | no | 71,353 | 10,817 | 82,170 | $0.01058 | off-peak | 8 | 45.4 |
| minilisp | tc | edit-dsl | edit | 4 | yes | 15,629 | 2,615 | 18,244 | $0.00246 | off-peak | 6 | 11.3 |
| minilisp | tc | edit-dsl | plan-exec | 4 | no | 63,996 | 9,646 | 73,642 | $0.00922 | off-peak | 7 | 56.9 |
| minilisp | tc | edit-dsl | edit | 5 | yes | 16,130 | 2,088 | 18,218 | $0.00179 | off-peak | 4 | 27.8 |
| minilisp | tc | edit-dsl | plan-exec | 5 | no | 66,103 | 10,984 | 77,087 | $0.01033 | off-peak | 7 | 65.5 |
| csv-parser | tc | edit-dsl | edit | 1 | yes | 10,821 | 530 | 11,351 | $0.00070 | off-peak | 6 | 11.1 |
| csv-parser | tc | edit-dsl | plan-exec | 1 | yes | 15,770 | 1,988 | 17,758 | $0.00241 | off-peak | 8 | 15.4 |
| csv-parser | tc | edit-dsl | edit | 2 | yes | 10,821 | 530 | 11,351 | $0.00074 | off-peak | 6 | 8.8 |
| csv-parser | tc | edit-dsl | plan-exec | 2 | yes | 28,321 | 4,044 | 32,365 | $0.00387 | off-peak | 12 | 27.0 |
| csv-parser | tc | edit-dsl | edit | 3 | yes | 10,831 | 539 | 11,370 | $0.00076 | off-peak | 6 | 5.8 |
| csv-parser | tc | edit-dsl | plan-exec | 3 | yes | 24,605 | 2,953 | 27,558 | $0.00317 | off-peak | 9 | 19.7 |
| csv-parser | tc | edit-dsl | edit | 4 | yes | 10,821 | 530 | 11,351 | $0.00070 | off-peak | 6 | 9.6 |
| csv-parser | tc | edit-dsl | plan-exec | 4 | yes | 59,707 | 5,553 | 65,260 | $0.00612 | off-peak | 19 | 41.1 |
| csv-parser | tc | edit-dsl | edit | 5 | yes | 10,826 | 533 | 11,359 | $0.00074 | off-peak | 6 | 8.8 |
| csv-parser | tc | edit-dsl | plan-exec | 5 | yes | 17,539 | 1,939 | 19,478 | $0.00218 | off-peak | 9 | 15.3 |

