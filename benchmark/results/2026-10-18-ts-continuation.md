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
- generated: 2026-10-18T12:56:22.853Z
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
| json-parser | ts | 3/3 | 2,982 | 1,667 | 4,649 | 9.3 | 3.0 |
| sexp-parser | ts | 3/3 | 2,442 | 529 | 2,971 | 10.0 | 3.0 |
| minilisp | ts | 2/3 | 51,615 | 3,051 | 54,666 | 82.1 | 25.0 |

## Overall comparison

| Side | Success | Mean in | Mean out | Mean total | Total tokens | Mean dur (s) | Mean steps |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ts | 8/9 | 19,013 | 1,749 | 20,762 | 186,858 | 33.8 | 10.3 |

Tokens per success (usage-run token sums divided by successful runs):

| Side | Input | Output | Total |
| --- | ---: | ---: | ---: |
| ts | 21,390 | 1,968 | 23,357 |

Only one side ran: ts 8/9 (88.9%).

## Anomalies

Failing runs:

- minilisp ts rep2: token-budget: accumulated 122211 tokens exceeded the 120000 token budget

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
| json-parser | ts | 1 | yes | 2,982 | 1,766 | 4,748 | 3 | 8.6 |
| json-parser | ts | 2 | yes | 2,982 | 1,623 | 4,605 | 3 | 10.4 |
| json-parser | ts | 3 | yes | 2,982 | 1,612 | 4,594 | 3 | 8.9 |
| sexp-parser | ts | 1 | yes | 2,442 | 516 | 2,958 | 3 | 19.3 |
| sexp-parser | ts | 2 | yes | 2,442 | 520 | 2,962 | 3 | 5.6 |
| sexp-parser | ts | 3 | yes | 2,442 | 550 | 2,992 | 3 | 5.0 |
| minilisp | ts | 1 | yes | 11,015 | 2,432 | 13,447 | 7 | 35.7 |
| minilisp | ts | 2 | no | 123,534 | 3,780 | 127,314 | 58 | 97.3 |
| minilisp | ts | 3 | yes | 20,296 | 2,942 | 23,238 | 10 | 113.4 |

