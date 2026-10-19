# Benchmark report — 2026-10-18

- mode: full
- model: honghong/deepseek-v4.1-flash#none
- effort: none (default)
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp
- sides: opencode
- reps: 3
- bun: 1.3.13
- opencode: opencode v2.0.32
- generated: 2026-10-18T08:26:46.352Z
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

| Task        | Side     | Success | Mean in | Mean out | Mean total | Mean dur (s) | Mean steps |
| ----------- | -------- | ------: | ------: | -------: | ---------: | -----------: | ---------: |
| json-parser | opencode |     3/3 |  13,707 |    2,256 |     15,963 |         50.8 |        5.7 |
| sexp-parser | opencode |     3/3 |  10,254 |    1,516 |     11,770 |        111.8 |        6.7 |
| minilisp    | opencode |     3/3 |  24,028 |    6,370 |     30,398 |        419.0 |       13.3 |

## Overall comparison

| Side     | Success | Mean in | Mean out | Mean total | Total tokens | Mean dur (s) | Mean steps |
| -------- | ------- | ------: | -------: | ---------: | -----------: | -----------: | ---------: |
| opencode | 9/9     |  15,996 |    3,381 |     19,377 |      174,393 |        193.9 |        8.6 |

Tokens per success (usage-run token sums divided by successful runs):

| Side     |  Input | Output |  Total |
| -------- | -----: | -----: | -----: |
| opencode | 15,996 |  3,381 | 19,377 |

Only one side ran: opencode 9/9 (100.0%).

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

| Task        | Side     | Rep | OK  |  Input | Output |  Total | Steps | Dur (s) |
| ----------- | -------- | --: | --- | -----: | -----: | -----: | ----: | ------: |
| json-parser | opencode |   1 | yes | 14,316 |  2,314 | 16,630 |     6 |    28.2 |
| json-parser | opencode |   2 | yes | 14,063 |  2,222 | 16,285 |     5 |    52.7 |
| json-parser | opencode |   3 | yes | 12,742 |  2,233 | 14,975 |     6 |    71.6 |
| sexp-parser | opencode |   1 | yes |  6,227 |  1,622 |  7,849 |     5 |   222.1 |
| sexp-parser | opencode |   2 | yes | 13,096 |  1,740 | 14,836 |    10 |    42.8 |
| sexp-parser | opencode |   3 | yes | 11,438 |  1,186 | 12,624 |     5 |    70.6 |
| minilisp    | opencode |   1 | yes | 21,889 |  9,317 | 31,206 |    16 |   471.7 |
| minilisp    | opencode |   2 | yes | 16,310 |  3,183 | 19,493 |     5 |    31.3 |
| minilisp    | opencode |   3 | yes | 33,884 |  6,611 | 40,495 |    19 |   753.9 |
