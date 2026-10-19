# Benchmark report — 2026-10-18

- mode: full
- model: deepseek-v4.1-flash
- effort: none
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp
- sides: ts
- reps: 3
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-18T06:53:11.675Z
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
| json-parser | ts   |     3/3 |   2,722 |    1,743 |      4,465 |         28.5 |        3.0 |
| sexp-parser | ts   |     3/3 |   2,182 |      559 |      2,741 |          5.3 |        3.0 |
| minilisp    | ts   |     1/3 |  12,424 |    2,764 |     15,188 |         19.3 |        5.0 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean dur (s) | Mean steps |
| ---- | ------- | ------: | -------: | ---------: | -----------: | -----------: | ---------: |
| ts   | 7/9     |   5,776 |    1,689 |      7,465 |       67,182 |         17.7 |        3.7 |

Tokens per success (usage-run token sums divided by successful runs):

| Side | Input | Output | Total |
| ---- | ----: | -----: | ----: |
| ts   | 7,426 |  2,171 | 9,597 |

Only one side ran: ts 7/9 (77.8%).

## Anomalies

Failing runs:

- minilisp ts rep1: edit-exhausted: the 3-exchange Edit budget was exhausted without a valid edit stage: tests tests failed: failing tests: - minilisp special forms > recursion - m...
- minilisp ts rep3: edit-exhausted: the 3-exchange Edit budget was exhausted without a valid edit stage: tsc replacement line 83: TS2322: Type 'Expr' is not assignable to type 'Lis...

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
| json-parser | ts   |   1 | yes |  2,722 |  1,734 |  4,456 |     3 |    10.0 |
| json-parser | ts   |   2 | yes |  2,722 |  1,716 |  4,438 |     3 |    66.3 |
| json-parser | ts   |   3 | yes |  2,722 |  1,779 |  4,501 |     3 |     9.3 |
| sexp-parser | ts   |   1 | yes |  2,182 |    559 |  2,741 |     3 |     5.9 |
| sexp-parser | ts   |   2 | yes |  2,182 |    559 |  2,741 |     3 |     5.2 |
| sexp-parser | ts   |   3 | yes |  2,182 |    559 |  2,741 |     3 |     4.8 |
| minilisp    | ts   |   1 | no  | 18,224 |  3,484 | 21,708 |     6 |    25.7 |
| minilisp    | ts   |   2 | yes |  3,171 |  2,413 |  5,584 |     3 |    11.4 |
| minilisp    | ts   |   3 | no  | 15,878 |  2,394 | 18,272 |     6 |    20.7 |
