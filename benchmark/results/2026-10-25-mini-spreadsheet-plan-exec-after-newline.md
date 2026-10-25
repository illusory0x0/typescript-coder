# Benchmark report — 2026-10-25

- mode: pilot
- model: deepseek-flash
- effort: none (default)
- multi-payload: off (default)
- protocol-format: edit-dsl (#119)
- agent modes: plan-exec
- concurrency: 1
- tasks: mini-spreadsheet
- sides: tc
- reps: 1
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-25T14:08:23.735Z
- pilot reference: none

## Frozen task specs

### mini-spreadsheet

Spec (verbatim, identical for both sides):

````
# Task: Mini spreadsheet formula engine

Create `src/workbook.ts` with an in-memory spreadsheet formula engine. The
engine is deterministic and self-contained: no dependencies, I/O, network,
timers, UI, or global mutable state. A complete implementation is expected to
be roughly 2,000 lines (about 1,800-2,200 is the intended size); the visible
acceptance suite is the contract, not a line count.

## Public API

```ts
export type CellValue = number | string | boolean | null;
export type CellError = "#DIV/0!" | "#VALUE!" | "#REF!" | "#CYCLE!" | "#NAME?" | "#PARSE!";
export type CellResult = CellValue | CellError;

export class Workbook {
  setCell(address: string, input: string | number | boolean | null): void;
  getValue(address: string): CellResult;
  getDisplay(address: string): string;
  recalculate(): void;
}
```

`getValue` returns the evaluated value, or the error string for an error cell.
`getDisplay` returns the displayed text: numbers via `String`, booleans as
`TRUE`/`FALSE`, a blank cell as the empty string, errors verbatim, and strings
unchanged. A literal string that happens to look like an error (for example
`"#DIV/0!"`) is still a string, not an error value.

## Cells and addresses

- Addresses are A1-style: one or more ASCII letters (column) followed by a row
  number in `1..1048576` with no leading zero. Columns are `A..XFD` (1..16384).
  Addresses are case-insensitive; `a1`, `A1`, and `aa10` are normalized before
  lookup.
- `setCell` throws an `Error` for an address outside that grammar or range.
  `getValue` and `getDisplay` also throw for such an address.
- `setCell` with `null` clears the cell. A string beginning with `=` is a
  formula (everything after the leading `=` is parsed). Every other string is a
  literal string, including `""`. Numbers and booleans are literal values.
- Reading a valid blank cell returns `null` from `getValue` and `""` from
  `getDisplay`.
- A formula may refer to cells that are set later (forward references), and to
  cells that are themselves formulas.
- A reference inside a formula must be a valid in-bounds address. A malformed
  reference token, row `0`, a leading-zero row, or an out-of-bounds row/column
  evaluates to `#REF!`; it does not throw.
- `setCell`, including replacing a value with a formula or a formula with a
  literal, must invalidate affected results. `recalculate()` clears memoized
  results and recomputes every formula; reads after it must be consistent with
  reads after ordinary `setCell` calls.

## Formula grammar

Whitespace (spaces, tabs, LF, CR) may appear between tokens. A formula is the
text after `=`, parsed as one complete expression followed by end of input.

```
expression      := comparison
comparison      := concat (("=" | "<>" | "<" | "<=" | ">" | ">=") concat)*
concat          := additive ("&" additive)*
additive        := multiplicative (("+" | "-") multiplicative)*
multiplicative  := unary (("*" | "/") unary)*
unary           := ("+" | "-") unary | power
power           := primary ("^" unary)?
primary         := number | string | boolean | cell | function-call
                 | "(" expression ")"
function-call   := identifier "(" [argument ("," argument)*] ")"
argument        := expression [":" cell]
```

- Binary operators at the same precedence are left-associative, except `^`,
  which is right-associative (`2^3^2` is `2^(3^2) = 512`). A unary sign applies
  to the whole power that follows, so `-2^2` is `-(2^2) = -4`, while `2^-2` is
  `2^(-2) = 0.25`.
- Comparisons may be chained left-to-right; a normal implementation only needs
  one comparison for the tests, but chaining must not be a parse error.
- Numbers match digits with an optional fraction and exponent. A leading or
  trailing dot is allowed when at least one digit is present: `.5`, `1.`, `1e3`,
  and `2.5E-2` are all numbers. A sign is a unary operator, not part of the
  literal.
- Strings are double-quoted. The only escapes are `\"`, `\\`, `\n`, and `\t`.
  Any other backslash sequence, an unterminated string, or a missing closing
  parenthesis is a parse error.
- `TRUE` and `FALSE` are boolean literals, case-insensitive. They are booleans
  only when they are not followed by `(`.
- An identifier is a letter or `_`, followed by letters, digits, or `_`.
  Identifiers followed by `(` are function calls (case-insensitive). A bare
  identifier that is not a boolean literal or a cell reference has the value
  `#NAME?`.
- A cell reference token is one or more letters immediately followed by digits.
  A valid reference identifies a cell; an invalid one yields `#REF!` when
  evaluated.
- A range is `cell ":" cell` and is recognized only as one complete function
  argument. `A1:B3` and the reversed `B3:A1` both cover the same rectangle.
  Ranges are not general values: `=A1:B3`, `=SUM((A1:B3))`, and `=SUM(1:A2)` are
  parse errors.
- Any other character or a leftover token after the expression is a parse
  error.

## Values, operators, and errors

Internally, a blank cell is distinct from the empty string and from `0`.

- Arithmetic (`+`, `-`, `*`, `/`, `^`) and unary `+`/`-` require numbers.
  A blank, string, or boolean operand yields `#VALUE!`. Division by zero and a
  negative power of zero yield `#DIV/0!`. A non-finite numeric result (overflow,
  `NaN`, or `Infinity`) yields `#VALUE!`.
- `&` concatenates: a blank becomes `""`, strings stay unchanged, numbers become
  `String(number)`, and booleans become `TRUE`/`FALSE`.
- Comparisons support number-number, string-string, and boolean-boolean.
  Strings compare lexicographically by UTF-16 code unit; booleans order
  `FALSE < TRUE`. `=` and `<>` additionally support blank-blank equality
  (`blank = blank` is true). A blank against a non-blank, or any other mixed
  type pair, yields `#VALUE!`. Ordering (`<`, `<=`, `>`, `>=`) never accepts a
  blank.
- Error values propagate through every operator and through evaluated function
  arguments, except that `IF` does not evaluate its unselected branch. The first
  error encountered (left operand, earlier argument, earlier range cell in
  row-major order) is the result.
- Error codes:
  - `#DIV/0!` - division by zero (including `0` raised to a negative power).
  - `#VALUE!` - wrong type, bad arity, invalid function argument, arithmetic on
    a blank, mixed-type comparison, or a range where a scalar is required.
  - `#REF!` - a formula references a malformed or out-of-bounds cell address.
  - `#CYCLE!` - a dependency cycle.
  - `#NAME?` - an unknown function or bare identifier.
  - `#PARSE!` - the formula does not match the grammar. A syntactically invalid
    formula is stored as an error cell; `setCell` does not throw for it.

## Functions

Function names are case-insensitive. Wrong arity yields `#VALUE!`. Unknown
functions yield `#NAME?` without evaluating their arguments. Except for lazy
`IF`, an error in an evaluated argument or referenced range cell propagates.

- `SUM(args...)`, `AVERAGE(args...)`, `MIN(args...)`, `MAX(args...)`: at least
  one argument. Each argument is a scalar or a range; ranges are flattened.
  A scalar argument must be a number or blank (blank is ignored); a string or
  boolean scalar is `#VALUE!`. Inside a range, numbers count and blanks, strings,
  and booleans are ignored; an error cell propagates. `SUM` of no numeric values
  is `0`; `AVERAGE` of no numeric values is `#DIV/0!`; `MIN`/`MAX` of no numeric
  values are `#VALUE!`.
- `COUNT(args...)`: at least one argument. Counts numeric scalar arguments and
  numeric range cells. Blanks, strings, and booleans are ignored (not counted);
  an error in any evaluated argument or range cell propagates.
- `IF(condition, thenValue, elseValue)`: exactly three arguments. The condition
  is evaluated first and must be a boolean; a non-boolean (including blank)
  yields `#VALUE!`, and an error condition propagates. Only the selected branch
  is evaluated. The selected branch must be a scalar; a range branch is
  `#VALUE!`.
- `ABS(number)`: exactly one numeric argument; anything else is `#VALUE!`.
- `ROUND(number, digits)`: exactly two arguments. `number` must be a number and
  `digits` must be an integer in `0..8`; otherwise `#VALUE!`. Rounding is
  half-away-from-zero (`ROUND(2.5, 0) = 3`, `ROUND(-2.5, 0) = -3`).

Ranges are passed to functions as ranges, never silently coerced: `ABS(A1:B2)`
is `#VALUE!`, and `COUNT(A1:B2)` counts the numeric cells in the rectangle.

## Dependencies, cycles, and recalculation

- Evaluation follows references as needed. A dependency cycle marks every cell
  on the cycle as `#CYCLE!`; cells that depend on the cycle also evaluate to
  `#CYCLE!`. Breaking a cycle by replacing one cell must make the remaining
  cells readable again.
- `setCell` must invalidate cached values so a changed precedent immediately
  changes its dependents. `recalculate()` may clear and eagerly recompute every
  formula, or use an equivalent cached strategy, but its observable results must
  match ordinary evaluation.
- Evaluation is deterministic: the same sequence of calls always produces the
  same values and displays.

## Constraints

- Create and edit only `src/workbook.ts`; do not change `src/workbook.test.ts`
  or `tsconfig.json`, and do not create scratch files.
- No external packages and no ambient I/O.
- The visible suite is the acceptance check: `bun test` and
  `bunx tsc --noEmit` must pass with strict TypeScript.
````

- fixture: benchmark/fixtures/mini-spreadsheet/
- reference: benchmark/references/workbook.ts

## Cache warm-up

Only the cache-stable system prefixes were warmed; task-specific user prompts were not. These calls are excluded from every measured token/cost table.

| Agent mode | Prefix | Prompt chars | Raw in | Cache read | Cache hit | Duration (s) | Error |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| plan-exec | planning | 10387 | n/a | n/a | n/a | 1.9 | none |
| plan-exec | execution | 2900 | n/a | n/a | n/a | 0.9 | none |

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
| mini-spreadsheet | tc | edit-dsl | plan-exec | 0/1 | 152,211 | 72.9% | 14,766 | 166,977 | $0.03292 | n/a | 101.6 | 46.0 |

## Overall comparison

| Side | Protocol | Agent mode | Success | Mean in (no cache) | Cache hit | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | 0/1 | 152,211 | 72.9% | 14,766 | 166,977 | 166,977 | $0.03292 | $0.03292 | n/a | 101.6 | 46.0 |

Per success (usage-run sums divided by successful runs):

| Side | Protocol | Agent mode | In (no cache) | Out | Total | Cost |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | n/a | n/a | n/a | n/a |

## Cache hit balance

Cache hit = cacheRead / raw prompt tokens (tc input includes hits; oc input excludes them).

| Side | Protocol | Agent mode | Cache hit | Cache-read tokens |
| --- | --- | --- | ---: | ---: |
| tc | edit-dsl | plan-exec | 72.9% | 408,448 |

Only one side ran: tc plan-exec 0/1 (0.0%).

Token multiplier (cache-excluded): not comparable (both sides must run).

## Four-way comparison (oc / tc json / tc pinned-repair / tc plan-exec)

Baselines: oc `benchmark/results/oc-baseline.json` (deepseek/deepseek-flash, 3 reps, 2026-10-25); tc json `benchmark/results/json-format-baseline.json` (deepseek-flash, 3 reps, 2026-10-25).
Factor = baseline mean / variant mean; above 1 means the variant used that many times fewer cache-excluded tokens.

| Task | Variant | Mean total | Cache hit | vs oc baseline | vs tc json baseline |
| --- | --- | ---: | ---: | ---: | ---: |
| mini-spreadsheet | tc plan-exec | 166,977 | 72.9% | n/a | n/a |
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
| mini-spreadsheet | tc | edit-dsl | plan-exec | 0 | 0 | 0 |

| Side | Protocol | Agent mode | range | matcher | whole-symbol |
| --- | --- | --- | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 |

Resolved cascade stages and matcher kinds (#110):

Per task and side (payloads that resolved at each stage / used each matcher):

| Task | Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| mini-spreadsheet | tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

| Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| tc | edit-dsl | plan-exec | 0 | 0 | 0 | 0 | 0 |

Implicit creates (#111):

| Task | Side | Protocol | Agent mode | creates |
| --- | --- | --- | --- | ---: |
| mini-spreadsheet | tc | edit-dsl | plan-exec | 0 |

| Side | Protocol | Agent mode | creates |
| --- | --- | --- | ---: |
| tc | edit-dsl | plan-exec | 0 |

## Anomalies

Failing runs:

- mini-spreadsheet tc rep1: token-budget: accumulated 123495 cache-excluded tokens exceeded the 120000 token budget

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
| mini-spreadsheet | tc | edit-dsl | plan-exec | 1 | no | 560,659 | 14,576 | 575,235 | $0.03292 | off-peak | 46 | 101.6 |

