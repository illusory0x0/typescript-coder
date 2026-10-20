# Position and range formats across toolchains

How compilers and runtimes spell a source **position** (`path:line:col`) and a
source **range** (start → end), captured live on 2026-10-20. This is the
reference input to the selection grammar in issue #106 (the LLM-friendly
cascading selection protocol); it is a survey, not a spec.

Versions: gcc 15.2.0, clang 21.1.8, rustc 1.96.0, Python 3.14.4, Node 22.17.1,
Bun 1.3.13, tsc 7.0.2.

## The common shape

Every tool puts `path:line:col` (or TypeScript's parenthesised `(line,col)`)
first, then the message. A **range** beyond a single point is rare: only clang
spells one in text (`path:l:c:{l:c-l:c}:`), and rustc spells one only in its
JSON span. For humans, all of them render a `N | ...` gutter with a caret or
tilde run under the span.

## gcc

Point form; no textual range. `-fdiagnostics-print-source-range-info` does not
exist in gcc.

```
tmp2.c: In function ‘h’:
tmp2.c:2:16: error: too few arguments to function ‘g’; expected 1, have 0
    2 | void h(void) { g(); }
      |                ^
```

`-fdiagnostics-format=json` is point-only: each `locations[]` entry carries
`{file, line, column, byte-column, display-column}` (a caret, no end).

## clang

Point form, plus an explicit brace-wrapped range under
`-fdiagnostics-print-source-range-info`, plus fix-its under
`-fdiagnostics-parseable-fixits`.

```
tmp2.c:2:18: error: too few arguments to function call, single argument 'x' was not specified
    2 |  void h(void) { g(); }
      |                 ~ ^
```

```
tmp2.c:2:18:{2:16-2:17}: error: too few arguments to function call, single argument 'x' was not specified
```

So the range shape is `file:l:c:{l1:c1-l2:c2}: message`. Fix-its are
`fix-it:"file":{l:c-l:c}:"replacement"`.

## rustc

The default is an arrow header (` --> path:l:c`), not a colon header; short form
is the colon form; JSON carries the full range.

```
error: expected expression, found `;`
 --> tmp.rs:2:13
  |
2 |     let x = ;
  |             ^ expected expression
```

`--error-format=short`:

```
tmp.rs:2:13: error: expected expression, found `;`: expected expression
```

`--error-format=json` carries `spans[]` with `byte_start`, `byte_end`,
`line_start`, `line_end`, `column_start`, `column_end`, `is_primary`, `label`,
and `suggested_replacement` — a full start/end range, the cleanest structured
range of any tool here.

## Python

Traceback text, no colon form; 3.11+ adds a tilde/caret span. The AST carries
`end_lineno` and `end_col_offset`.

```
  File "tmp.py", line 2, in f
    return 1 / 0
           ~~^~~
ZeroDivisionError: division by zero
```

## Node

Module syntax errors print `path:line` (no column); runtime stack frames print
`path:line:col`.

```
file:///abs/tmp.js:2
SyntaxError: Unexpected end of input
    at compileSourceTextModule (node:internal/modules/esm/utils:344:16)
```

Runtime frames: `at f (file:1:21)`.

## Bun

A `N | ...` gutter with a caret, then the message, then `at path:line:col`. Bun
erases types and does not typecheck, so a type error passes silently; this is a
syntax/runtime position only.

```
1 | const = 1
          ^
error: Expected identifier but found "="
    at /abs/bun-bad.ts:1:7
```

## tsc

Machine form is parenthesised and point-only; the TTY "pretty" form uses the
colon form and prints the source with a tilde span.

```
tmp.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
```

```
tmp.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.
  ~
```

## Synthesis

| tool   | path                    | point                        | range in text | structured range |
| ------ | ----------------------- | ---------------------------- | ------------- | ---------------- |
| gcc    | `path`                  | `path:l:c:`                  | —             | json caret (pt)  |
| clang  | `path`                  | `path:l:c:`                  | `path:l:c:{l:c-l:c}:` | fix-its |
| rustc  | `path`                  | `--> path:l:c` / `path:l:c:` | —             | json `line_start…column_end` |
| python | `"path"`                | `line N` + caret             | `~~~^~~`      | AST `end_*`      |
| node   | `path` / `file://`      | `path:l:c`                   | —             | —                |
| bun    | `path`                  | `path:l:c`                   | —             | —                |
| tsc    | `path`                  | `path(l,c)` / `path:l:c`     | —             | —                |

Takeaways for the tc grammar:

- `path:line:col` is the lingua franca — adopt it as the primary form.
- A range is native only to clang (`{l:c-l:c}`) and rustc (JSON
  `line_start`+`column_start` → `line_end`+`column_end`). A `l:c-l:c` suffix is the
  clean merge: clang's shape without the braces, spelled as rustc's start → end.
- The `N | ...` gutter plus a caret is universal and tc already renders the
  gutter (`numberedSourceBlock` in `src/loop.ts`).
- Python's traceback form (no colon, no column before 3.11) is the outlier; do
  not adopt it.
- tsc's `(line,col)` is machine-only; accept it leniently at most.

## Adopted form (2026-10-20)

tc adopts `path:line:col` as the primary position with an optional `-line:col`
range suffix, i.e. `<path>[:<line>[:<col>[-<line>[:<col>]]]]: [`<anchor>`]`.
This is clang's `{l:c-l:c}` range without the braces, spelled start → end the way
rustc's JSON span is. The point-only tools (gcc, tsc, node, bun) and Python's
traceback form are not adopted. The `N | ` gutter plus caret is kept for the
viewer affordance.
