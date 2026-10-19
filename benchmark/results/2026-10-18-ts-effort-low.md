# Benchmark report — 2026-10-18

- mode: full
- model: deepseek-v4.1-flash
- effort: low
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp
- sides: ts
- reps: 3
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-18T06:54:18.221Z
- pilot reference: none

## Frozen task specs

### json-parser

Issue (verbatim, identical for both sides):

```
Implement src/json.ts exporting JsonValue and parseJson(text: string): JsonValue
so that src/json.test.ts passes. Keep tsc --noEmit clean. Do not modify the test
file or tsconfig.json. The test file is the specification.
```

- fixture: benchmark/fixtures/json-parser/
- reference: benchmark/references/json.ts

### sexp-parser

Issue (verbatim, identical for both sides):

```
Implement src/sexp.ts exporting Sexp and parseSexp(text: string): Sexp
so that src/sexp.test.ts passes. Keep tsc --noEmit clean. Do not modify the test
file or tsconfig.json. The test file is the specification.
```

- fixture: benchmark/fixtures/sexp-parser/
- reference: benchmark/references/sexp.ts

### minilisp

Issue (verbatim, identical for both sides):

```
Implement src/lisp.ts exporting LispValue and run(program: string): LispValue
so that src/lisp.test.ts passes. Keep tsc --noEmit clean. Do not modify the test
file or tsconfig.json. The test file is the specification.
```

- fixture: benchmark/fixtures/minilisp/
- reference: benchmark/references/lisp.ts

## Token accounting

ts: OpenAI-compatible `usage` from the provider, summed over every chat request
(input/prompt, output/completion, total; cache and reasoning counters are kept per
record). Cost is recorded verbatim but not compared.

opencode: usage read from `opencode session export` (`info.tokens`), falling back to
`opencode stats --json`; input/output come from the reported session usage and total
is derived from input + output + reasoning when the export reports none. Cost is
recorded verbatim but not compared.

## Per-task results

| Task        | Side | Success | Mean in | Mean out | Mean total | Mean dur (s) | Mean steps |
| ----------- | ---- | ------: | ------: | -------: | ---------: | -----------: | ---------: |
| json-parser | ts   |     3/3 |   2,772 |    3,362 |      6,134 |         24.0 |        3.0 |
| sexp-parser | ts   |     3/3 |   2,801 |    3,485 |      6,287 |         22.0 |        3.3 |
| minilisp    | ts   |     1/3 |   9,824 |   25,366 |     35,190 |        181.5 |        4.0 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean dur (s) | Mean steps |
| ---- | ------- | ------: | -------: | ---------: | -----------: | -----------: | ---------: |
| ts   | 7/9     |   5,132 |   10,738 |     15,870 |      142,831 |         75.8 |        3.4 |

Tokens per success (usage-run token sums divided by successful runs):

| Side | Input | Output |  Total |
| ---- | ----: | -----: | -----: |
| ts   | 6,599 | 13,806 | 20,404 |

Only one side ran: ts 7/9 (77.8%).

## Anomalies

Failing runs:

- minilisp ts rep1: edit-exhausted: the 3-exchange Edit budget was exhausted without a valid edit stage: tests tests failed: failing tests: - minilisp pairs > car and cdr select pa...
- minilisp ts rep3: edit-exhausted: the 3-exchange Edit budget was exhausted without a valid edit stage: protocol expected {"path": ..., "symbol": ..., "kind": ..., "matcher": ...,...

Runs with missing usage (`tokens.total` null):

- none

Truncation / timeouts:

- none

Infrastructure errors:

- none

Reruns:

- reruns: none

## Raw runs

| Task        | Side | Rep | OK  |  Input | Output |  Total | Steps | Dur (s) |
| ----------- | ---- | --: | --- | -----: | -----: | -----: | ----: | ------: |
| json-parser | ts   |   1 | yes |  2,772 |  3,745 |  6,517 |     3 |    18.0 |
| json-parser | ts   |   2 | yes |  2,772 |  2,212 |  4,984 |     3 |    12.3 |
| json-parser | ts   |   3 | yes |  2,772 |  4,129 |  6,901 |     3 |    41.6 |
| sexp-parser | ts   |   1 | yes |  2,232 |  4,147 |  6,379 |     3 |    24.1 |
| sexp-parser | ts   |   2 | yes |  2,232 |  3,434 |  5,666 |     3 |    24.2 |
| sexp-parser | ts   |   3 | yes |  3,940 |  2,875 |  6,815 |     4 |    17.7 |
| minilisp    | ts   |   1 | no  | 17,587 | 23,873 | 41,460 |     6 |   295.8 |
| minilisp    | ts   |   2 | yes |  3,221 | 35,058 | 38,279 |     3 |   163.4 |
| minilisp    | ts   |   3 | no  |  8,663 | 17,167 | 25,830 |     3 |    85.5 |
