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

Companion reading: [docs/position-formats.md](./position-formats.md) is the live
survey of how gcc / clang / rustc / python / node / bun / tsc spell a position
and a range (the source of the `line:col` form), and
[docs/glossary.md](./glossary.md) defines the loop vocabulary. This file is the
grammar and semantics; where a term matters it uses **matcher** (never "anchor").

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
