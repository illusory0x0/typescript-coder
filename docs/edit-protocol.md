# Edit protocol — the compact selection syntax

The syntax the model emits to read or edit a TypeScript declaration. It replaces
the flat JSON edit payload with a compiler-flavoured, positional, cascading
selection: a target is named by `select`, narrowed by `match` / `pick`, and
rewritten by `replace`. One selection is a **viewer** when it stops at `match`,
and an **editor** when it carries `replace`.

Status: **specified here, not yet implemented.** The children that build it are
#107 (parse/serialize), #108 (resolve the cascade), #109 (regex selector), #110
(record the resolved stage) and #111 (few-shot examples + A/B). Until they land,
the shipped wire protocol is still the JSON payload in
[docs/spec.md](./spec.md); §9 maps the two.

Companion reading: [docs/glossary.md](./glossary.md) defines the loop
vocabulary. This file is the grammar and semantics; where a term matters it uses
**matcher** (never "anchor"). The appendix carries the toolchain survey behind
§3's position and range spelling.

## 1. The model

A reply is a `<multiEditor>`: zero or more `<editor>` clauses, each terminated
by `end`. Every clause has the same three-part shape:

```
select  →  the container (a declaration)
match   →  locate a span inside the container (optional)
replace →  rewrite the located span (optional)
```

- `select … end` is a **viewer** of the whole declaration.
- `select … match <m> end` is a **viewer** of the matched span — it returns every
  candidate occurrence and writes nothing.
- `select … replace with <fence> end` rewrites the whole declaration.
- `select … match <m> replace with <fence> end` rewrites the matched span.

Each clause is applied independently (§6). Nothing is guessed: when a stage
cannot resolve uniquely the clause fails with a typed cause (§5, §7) — there is
never a silent wrong match.

## 2. Grammar (ISO/IEC 14977 EBNF)

```
multiEditor = { editor } ;

editor      = 'select', [ kind ], symbol, 'in', path,
              [ 'match', ( snippet | regex ), [ 'pick', multiRange ] ],
              [ 'replace', 'with', fence ],
              'end' ;

multiRange  = '{', range, { ',', range }, '}'
            | range ;                                   (* single-range sugar *)

range       = line, [ ':', column, [ '-', line, [ ':', column ] ] ] ;

line        = digit, { digit } ;
column      = digit, { digit } ;
digit       = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' ;

kind        = 'function' | 'const' | 'let' | 'var' | 'class'
            | 'type' | 'interface' | 'enum' | 'namespace' ;
path        = ? file path token ? ;
symbol      = ? declared identifier ? ;
snippet     = ? '`' , verbatim source, '`' ? ;
regex       = ? '/' , ECMA-262 pattern, no flags, '/' ? ;
fence       = ? 3+ backticks; body free of a run >= opening; closing matches ? ;
```

Lexical notes:

- `kind` is optional and only disambiguates a `function` from a same-named
  `const`, `type`, and so on.
- `snippet` is verbatim source between single backticks and must copy the
  current bytes exactly.
- `regex` is an ECMA-262 pattern between slashes and takes **no flags** (`g`
  would contradict the single-match rule).
- `fence` is a Markdown-style fenced block: at least three backticks, a body
  that contains no run of that many backticks, and a closing fence of the same
  length. A body is mandatory; **an empty body means delete**.
- `pick` sugar: `pick 10` means `pick {10}`.
- Whitespace is insignificant except inside a `fence`; the multi-line layout of
  the examples is convention, not syntax.
- `;` is not used; `end` terminates every clause.

## 3. Selection cascade

Each stage narrows the one before it and is optional; omit a stage and it falls
back as stated. The cascade is `path → symbol → matcher → selector`, with
`match` producing a candidate set and `pick` filtering it.

```
select [kind] <symbol> in <path>    the container: that declaration, resolved
                                    uniquely (path x symbol x kind)
  match <snippet | regex>           the candidate set: every occurrence of the
                                    matcher inside the declaration
    pick <multiRange>               filter the set to occurrences that fall in
                                    one of these ranges (disambiguation)
  replace with <fence>              rewrite the target
```

### Precedence

- `match` is the locator; `pick` only narrows it. `pick` never names a target on
  its own — it exists to break a tie between multiple `match` occurrences.
- `pick` is only legal beneath `match`; a `pick` without `match` is a parse
  error. There is no bare-range replace: to rewrite an arbitrary span, the
  `match` snippet must span it (the model copies it from the numbered source).

### Target resolution

| clause                | target                          |
| --------------------- | ------------------------------- |
| `match` present       | the unique occurrence in scope  |
| no `match`, `replace` | the whole declaration           |
| no `match`, no `replace` | nothing — a viewer          |

For a `match`, the scope is the declaration, restricted to `pick` ranges when
present. Exactly one occurrence in scope is the target; zero is
`matcher-not-found`; more than one is `matcher-ambiguous` (the reply lists each
occurrence so the model can add `pick` or lengthen the snippet).

### Range arithmetic

`line` alone is a whole line; `line:col` is the single character at that
file-absolute position; `line:col-line:col` is a start → end span, and a missing
end column means end of line. Coordinates are **file-absolute**, 1-based, and
match the numbered source block the prompt already shows.

## 4. Viewer

A `match` without a `replace` is a read: it returns every candidate occurrence —
file-absolute `line:col` plus the numbered snippet — and writes nothing. With a
`pick`, it returns only the occurrences inside those ranges. This is the locate
step that resolves ambiguity before editing, and the prompt should say so (see
#111): a viewer selects without changing the file.

## 5. Failure causes

Each clause is classified into one typed cause, carried to the repair prompt:

`path-not-found`, `symbol-not-found`, `symbol-ambiguous`, `kind-mismatch`,
`matcher-not-found`, `matcher-ambiguous`, `regex-invalid`, `range-invalid`,
`overlap-conflict`, `parse-error`.

## 6. Application model

- A reply's clauses are processed in **document order** (the order they appear).
- Each clause is resolved and applied **independently**: a success is written
  immediately, a failure is skipped.
- Application is **not** group-atomic: the file may end up partially updated, and
  a clause that succeeded is never rolled back when a later one fails.
- Every clause resolves against the **original** (pre-reply) document; the model
  never sees coordinates shifted by its own earlier edits. The harness maps each
  original span onto the current file as it applies, in order.
- When two clauses target **overlapping** spans, the earlier in document order
  wins; the later fails with `overlap-conflict`, naming the winner.
- Within one clause, an edit that would change nothing is `no-op`.

## 7. Feedback

A failed clause is re-asked with its own text and its typed cause. When a reply
has several failures, **all** of them are fed back together. Because the model's
successful clauses have already been applied, the feedback also carries a short
list of the applied clauses so the model does not resend them (a resend would
fail as `matcher-not-found`).

## 8. Examples

Rewrite a snippet inside a declaration:

```
select function clamp in src/math.ts
match `Number.isNaN`
replace with
```
Number.isFinite
```
end
```

Delete a whole declaration (empty fence):

```
select const MAX_TOKENS in src/lexer.ts
replace with

end
```

Locate without writing (viewer), then narrow with `pick`:

```
select function tokenize in src/lexer.ts
match /^if \(/
end
```

```
select function tokenize in src/lexer.ts
match /^if \(/
pick {12}
replace with
```
if (input.length === 0) return [];
```
end
```

One reply, two independent clauses:

```
select function clamp in src/math.ts
match `Number.isNaN`
replace with
```
Number.isFinite
```
end

select function sum in src/math.ts
match `values.reduce`
replace with
```
values.reduce((acc, v) => acc + v, 0)
```
end
```

## 9. Relation to the JSON payload

The shipped payload is one flat object
`{path, symbol, kind, matcher?, range?, replacement}` (see
[docs/spec.md](./spec.md)). The compact syntax is the same selection, spelled
positionally:

| JSON                       | compact                                  |
| -------------------------- | ---------------------------------------- |
| `path` + `symbol` + `kind` | `select [kind] <symbol> in <path>`       |
| `matcher`                  | `match <snippet \| regex>`               |
| `range`                    | `pick <multiRange>`                       |
| `replacement`              | `replace with <fence>`                   |
| whole-symbol rewrite       | `replace` with no `match`                |
| delete                     | `replace with` an empty fence            |

Differences to note: the JSON `range` *takes precedence over* `matcher`; in the
compact syntax `match` is the locator and `pick` only narrows it. The JSON
protocol edits one payload per exchange (plus the opt-in multi-payload batch);
the compact syntax carries several clauses in one reply, applied per §6.

## 10. Status and non-goals

Specified by #106; built by #107–#111. This file is grammar and semantics only —
it defines no code and changes no prompt. The few-shot examples and the measured
A/B live in #111; recording the resolved stage and selector per applied edit
lives in #110.

---

## Appendix — position and range formats across toolchains

How compilers and runtimes spell a source position (`path:line:col`) and a range
(start → end), captured live on 2026-10-20. This is the evidence behind §3's
position and range spelling. Versions: gcc 15.2.0, clang 21.1.8, rustc 1.96.0,
Python 3.14.4, Node 22.17.1, Bun 1.3.13, tsc 7.0.2.

### The common shape

Every tool puts `path:line:col` (or TypeScript's parenthesised `(line,col)`)
first, then the message. A range beyond a single point is rare: only clang spells
one in text (`path:l:c:{l:c-l:c}:`), and rustc spells one only in its JSON span.
For humans, all of them render a `N | ...` gutter with a caret or tilde run under
the span.

### gcc

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

### clang

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

### rustc

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

### Python

Traceback text, no colon form; 3.11+ adds a tilde/caret span. The AST carries
`end_lineno` and `end_col_offset`.

```
  File "tmp.py", line 2, in f
    return 1 / 0
           ~~^~~
ZeroDivisionError: division by zero
```

### Node

Module syntax errors print `path:line` (no column); runtime stack frames print
`path:line:col`.

```
file:///abs/tmp.js:2
SyntaxError: Unexpected end of input
    at compileSourceTextModule (node:internal/modules/esm/utils:344:16)
```

Runtime frames: `at f (file:1:21)`.

### Bun

A `N | ...` gutter with a caret, then the message, then `at path:line:col`. Bun
erases types and does not typecheck, so a type error passes silently; this is a
syntax/runtime position only.

```
1 | const = 1
          ^
error: Expected identifier but found "="
    at /abs/bun-bad.ts:1:7
```

### tsc

Machine form is parenthesised and point-only; the TTY "pretty" form uses the
colon form and prints the source with a tilde span.

```
tmp.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
```

```
tmp.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.
  ~
```

### Synthesis

| tool   | path                    | point                        | range in text | structured range |
| ------ | ----------------------- | ---------------------------- | ------------- | ---------------- |
| gcc    | `path`                  | `path:l:c:`                  | —             | json caret (pt)  |
| clang  | `path`                  | `path:l:c:`                  | `path:l:c:{l:c-l:c}:` | fix-its |
| rustc  | `path`                  | `--> path:l:c` / `path:l:c:` | —             | json `line_start…column_end` |
| python | `"path"`                | `line N` + caret             | `~~~^~~`      | AST `end_*`      |
| node   | `path` / `file://`      | `path:l:c`                   | —             | —                |
| bun    | `path`                  | `path:l:c`                   | —             | —                |
| tsc    | `path`                  | `path(l,c)` / `path:l:c`     | —             | —                |

Into the grammar:

- `path:line:col` is the lingua franca; §3 adopts it as the primary form.
- A range is native only to clang (`{l:c-l:c}`) and rustc (JSON
  `line_start`+`column_start` → `line_end`+`column_end`); §3 takes clang's shape
  without the braces, spelled as rustc's start → end.
- The `N | ...` gutter plus a caret is universal and tc already renders the
  gutter (`numberedSourceBlock` in `src/loop.ts`).
- Python's traceback form (no colon, no column before 3.11) is the outlier and is
  not adopted.
- tsc's `(line,col)` is machine-only and at most accepted leniently.
