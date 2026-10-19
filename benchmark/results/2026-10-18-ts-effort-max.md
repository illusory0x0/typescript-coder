# Benchmark report — 2026-10-18

- mode: full
- model: deepseek-v4.1-flash
- effort: max
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp
- sides: ts
- reps: 3
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-18T07:08:12.084Z
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
| json-parser | ts   |     3/3 |   2,772 |   21,966 |     24,738 |        175.5 |        3.0 |
| sexp-parser | ts   |     3/3 |   2,631 |    4,875 |      7,507 |         29.1 |        3.3 |
| minilisp    | ts   |     3/3 |   4,393 |   79,506 |     83,899 |        427.3 |        3.7 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean dur (s) | Mean steps |
| ---- | ------- | ------: | -------: | ---------: | -----------: | -----------: | ---------: |
| ts   | 9/9     |   3,266 |   35,449 |     38,715 |      348,431 |        210.7 |        3.3 |

Tokens per success (usage-run token sums divided by successful runs):

| Side | Input | Output |  Total |
| ---- | ----: | -----: | -----: |
| ts   | 3,266 | 35,449 | 38,715 |

Only one side ran: ts 9/9 (100.0%).

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

| Task        | Side | Rep | OK  | Input | Output |   Total | Steps | Dur (s) |
| ----------- | ---- | --: | --- | ----: | -----: | ------: | ----: | ------: |
| json-parser | ts   |   1 | yes | 2,772 | 42,485 |  45,257 |     3 |   219.2 |
| json-parser | ts   |   2 | yes | 2,772 |  2,650 |   5,422 |     3 |    15.9 |
| json-parser | ts   |   3 | yes | 2,772 | 20,763 |  23,535 |     3 |   291.4 |
| sexp-parser | ts   |   1 | yes | 2,232 | 11,426 |  13,658 |     3 |    62.6 |
| sexp-parser | ts   |   2 | yes | 2,232 |  1,166 |   3,398 |     3 |    10.4 |
| sexp-parser | ts   |   3 | yes | 3,430 |  2,034 |   5,464 |     4 |    14.3 |
| minilisp    | ts   |   1 | yes | 4,975 | 85,464 |  90,439 |     4 |   406.9 |
| minilisp    | ts   |   2 | yes | 3,221 | 56,227 |  59,448 |     3 |   288.4 |
| minilisp    | ts   |   3 | yes | 4,984 | 96,826 | 101,810 |     4 |   586.7 |
