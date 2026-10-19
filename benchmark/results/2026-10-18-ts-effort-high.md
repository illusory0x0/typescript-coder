# Benchmark report — 2026-10-18

- mode: full
- model: deepseek-v4.1-flash
- effort: high
- concurrency: 4
- tasks: json-parser, sexp-parser, minilisp
- sides: ts
- reps: 3
- bun: 1.3.13
- opencode: n/a
- generated: 2026-10-18T06:59:38.477Z
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

| Task | Side | Success | Mean in | Mean out | Mean total | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| json-parser | ts | 3/3 | 2,772 | 11,498 | 14,270 | 55.9 | 3.0 |
| sexp-parser | ts | 3/3 | 2,232 | 9,352 | 11,584 | 54.7 | 3.0 |
| minilisp | ts | 2/3 | 9,838 | 38,688 | 48,525 | 203.3 | 4.3 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ts | 8/9 | 4,947 | 19,846 | 24,793 | 223,137 | 104.6 | 3.4 |

Tokens per success (usage-run token sums divided by successful runs):

| Side | Input | Output | Total |
| --- | ---: | ---: | ---: |
| ts | 5,566 | 22,327 | 27,892 |

Only one side ran: ts 8/9 (88.9%).

## Anomalies

Failing runs:

- minilisp ts rep2: edit-exhausted: the 3-exchange Edit budget was exhausted without a valid edit stage: tests tests failed: failing tests: - minilisp pairs > car and cdr select pa...

Runs with missing usage (`tokens.total` null):

- none

Truncation / timeouts:

- none

Infrastructure errors:

- none

Reruns:

- reruns: none

## Raw runs

| Task | Side | Rep | OK | Input | Output | Total | Steps | Dur (s) |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| json-parser | ts | 1 | yes | 2,772 | 5,176 | 7,948 | 3 | 31.2 |
| json-parser | ts | 2 | yes | 2,772 | 11,558 | 14,330 | 3 | 48.6 |
| json-parser | ts | 3 | yes | 2,772 | 17,759 | 20,531 | 3 | 87.9 |
| sexp-parser | ts | 1 | yes | 2,232 | 6,341 | 8,573 | 3 | 38.0 |
| sexp-parser | ts | 2 | yes | 2,232 | 10,773 | 13,005 | 3 | 65.9 |
| sexp-parser | ts | 3 | yes | 2,232 | 10,942 | 13,174 | 3 | 60.3 |
| minilisp | ts | 1 | yes | 3,221 | 12,343 | 15,564 | 3 | 62.2 |
| minilisp | ts | 2 | no | 23,071 | 80,337 | 103,408 | 7 | 425.3 |
| minilisp | ts | 3 | yes | 3,221 | 23,383 | 26,604 | 3 | 122.4 |

