# Benchmark report — 2026-10-18

- mode: full
- model: deepseek-v4.1-flash
- effort: none (default)
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp
- sides: ts
- reps: 3
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-18T13:42:03.331Z
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
| json-parser | ts   |     3/3 |   2,982 |    1,663 |      4,645 |        138.0 |        3.0 |
| sexp-parser | ts   |     3/3 |   2,442 |      553 |      2,995 |         15.7 |        3.0 |
| minilisp    | ts   |     2/3 |  43,743 |    7,121 |     50,863 |        110.4 |       24.3 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean dur (s) | Mean steps |
| ---- | ------- | ------: | -------: | ---------: | -----------: | -----------: | ---------: |
| ts   | 8/9     |  16,389 |    3,112 |     19,501 |      175,509 |         88.1 |       10.1 |

Tokens per success (usage-run token sums divided by successful runs):

| Side |  Input | Output |  Total |
| ---- | -----: | -----: | -----: |
| ts   | 18,438 |  3,501 | 21,939 |

Only one side ran: ts 8/9 (88.9%).

## Anomalies

Failing runs:

- minilisp ts rep2: token-budget: accumulated 121729 tokens exceeded the 120000 token budget

Runs with missing usage (`tokens.total` null):

- none

Truncation / timeouts:

- none

Infrastructure errors:

- none

Reruns:

- reruns: none

## Raw runs

| Task        | Side | Rep | OK  |   Input | Output |   Total | Steps | Dur (s) |
| ----------- | ---- | --: | --- | ------: | -----: | ------: | ----: | ------: |
| json-parser | ts   |   1 | yes |   2,982 |  1,611 |   4,593 |     3 |   391.9 |
| json-parser | ts   |   2 | yes |   2,982 |  1,747 |   4,729 |     3 |    10.8 |
| json-parser | ts   |   3 | yes |   2,982 |  1,631 |   4,613 |     3 |    11.4 |
| sexp-parser | ts   |   1 | yes |   2,442 |    550 |   2,992 |     3 |    34.3 |
| sexp-parser | ts   |   2 | yes |   2,442 |    559 |   3,001 |     3 |     7.3 |
| sexp-parser | ts   |   3 | yes |   2,442 |    549 |   2,991 |     3 |     5.6 |
| minilisp    | ts   |   1 | yes |   9,068 |  2,144 |  11,212 |     6 |    15.6 |
| minilisp    | ts   |   2 | no  | 110,009 | 14,908 | 124,917 |    60 |   144.9 |
| minilisp    | ts   |   3 | yes |  12,151 |  4,310 |  16,461 |     7 |   170.8 |
