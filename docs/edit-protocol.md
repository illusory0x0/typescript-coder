# The edit protocol

Canonical ownership: this document owns the edit-action reply language and both
wire formats — the JSON payload and edit-dsl. It also owns the sentinel fence,
the select clause and file command grammar/BNF, resolution/cascade, the
viewer/editor split, edit failure stages, application/gating, repair feedback,
and the resolver/gate skeleton. [`feedback-loop.md`](feedback-loop.md) owns the
loop lifecycle and retry policy around it; [`plan-exec.md`](plan-exec.md) owns
the Plan/Task model and plan-exec scheduling. Vocabulary is canonical in
[`README.md`](README.md).

`tc` splices edits the model describes, never edits or commands it chooses. The
model replies with an **edit-action**: a payload that names a declaration or
file, locates a span, and supplies replacement text; the harness resolves the
address, proves the locator unique, splices, gates, and formats. This document
describes that reply language: what the model may send, how each field resolves,
and the checks that run before a byte reaches disk. The Edit → Verify loop around
it is [`feedback-loop.md`](feedback-loop.md); the plan-exec execution contract is
[`plan-exec.md`](plan-exec.md).

Two reply formats exist, selected by `--protocol-format` (default `edit-dsl`):

- **edit-dsl**: the default. One or more statements, on the same resolver but
  with richer locators (regex, multi-range `pick`) and atomic multi-clause
  replies. The same reply language also carries file commands (`create`,
  `delete`, `read`, `write`). A JSON payload in this mode is a protocol
  rejection.
- **JSON payload**: opt-in, one flat object per exchange. Explicit-targets mode
  (`--targets`) always uses it.

Implementation: `parseEditResponse` and `resolveEditRange` in `src/loop.ts`, the
clause grammar in `src/selection.ts`, the cascade in `src/cascade.ts`, the reply
resolver in `src/edit-dsl.ts`, structural/regex matching in `src/matcher.ts`, the
splice and format gate in `src/editor.ts`.

## 1. The JSON payload

The JSON payload is opt-in and is one flat object per exchange:

```json
{
  "path": "src/a.ts",
  "symbol": "clamp",
  "kind": "function",
  "matcher": "return Math.min(1, x);",
  "replacement": "return Math.max(0, Math.min(1, x));"
}
```

The fields, in resolution order:

- **Address**: `path`, `symbol`, `kind`. All are strings, and `kind` is
  required, not a wildcard. The composite address must match exactly one indexed
  declaration. A name that resolves to two declarations, or that the file does
  not declare, is a staged `address` failure, never a silent first match.
- **`matcher`** (optional): a snippet copied from the current source. Absent
  (or `null`) rewrites the whole declaration. An empty string is rejected.
- **`range`** (optional): `{line, column, endLine, endColumn}`, 1-based and
  **inclusive** at both ends, in the coordinate space of the numbered
  current-source block shown in the prompt. When both `range` and `matcher` are
  sent, **`range` wins**.
- **`replacement`** (required): a string replacing exactly the addressed span,
  so `""` deletes the span.

Only these keys are admitted. An unexpected key is a `protocol` rejection that
names it, with targeted hints for the v1 spellings (`name` for `symbol`, and an
`edits` array, which v2 replaces with one flat object per exchange).

The reply is read tolerantly: a whole-text Markdown wrapper is accepted (the
outer-wrapper rule in §2 is separate from the edit-action sentinel fence), and
the first brace-matched object inside surrounding prose is found by scanning
with string-literal and escape awareness. Prose around the object is fine; no
object is not.

**Batched replies.** Under the opt-in `--multi-payload` batch, one
`{"payloads": [...]}` object carries several flat payloads, editing different
files and/or several non-overlapping regions of one file. The first payload
echoes the pinned address; every later payload names its own declaration, which
must resolve uniquely in its file's current source. Batches are `modify`-only,
the wrapper admits no key but `payloads`, and a batch is **atomic**: if any
payload fails its guards or two same-file regions overlap, nothing is written
and every failing payload is named. The edit-dsl format does not use this
wrapper; it batches by sending more statements.

## 2. The edit-dsl statement grammar

The edit-dsl is the default wire format. A reply is zero or more **statements**;
a statement is one **select clause** or one **file command**. A useful reply
carries at least one. There is no prose. A Markdown fence around the whole reply
is tolerated as a separate **outer wrapper** rule (below), not as part of
`<fence>`. The grammar is read by a hand-written recursive-descent reader
(`multiEditor` in `src/selection.ts`) in which whitespace between tokens is
insignificant, except inside a `<fence>` body and a `/regex/`. The reader
accepts an empty reply as zero statements. Any malformed input throws a
`stage: syntax` diagnostic naming the offending field; the loop renders it with
the failing line, column, and a short excerpt so the retry can see exactly
where the reply stopped. A partial selection is never returned.

```text
select [kind] <symbol> in <path> [ resolve (value|type|namespace) ] [ within <selecters> ] [ match (<snippet> | /regex/) ] [ [ pick <selecters> ] replace with <fence> | rename <old> to <new> ] end
```

A select clause is never a file command. A select clause with `replace` or
`rename` is an **editor**; with neither it is a **viewer**.

- **Header**: `select`, then one or two bare tokens, then `in <path>`. One token
  is the symbol; two are `<kind> <symbol>`. The admitted kinds are `function`,
  `const`, `let`, `var`, `class`, `type`, `interface`, `enum`, and `namespace`,
  so any other leading token is a syntax error rather than a symbol name. The
  declaration kind is the legacy disambiguator; omitted, it means any kind. A
  variable declaration resolves under its `const`, `let`, or `var` keyword; the
  index's internal `variable` label is not a grammar kind.
- **`resolve`**: optional, after the path. `resolve value`, `resolve type`, or
  `resolve namespace` filters the address to that TypeScript symbol space; it is
  the disambiguator when the same name is declared more than once. Omitted, any
  space is accepted; the JSON payload path has no space form.
- **`within`**: optional viewer-only slice, after `resolve`. It uses the same
  1-based inclusive file-absolute ranges as `read ... within`. The viewer returns
  exactly those lines from the declaration, unfolded. It cannot be combined with
  `match`, `pick`, `replace`, or `rename`; editors use `pick` for a narrowed
  rewrite.
- **`match`**: exactly one of two locators.
  - a `` `snippet` `` in backticks, where only `` \` `` and `\\` are escapes and
    every other backslash is literal;
  - a `/regex/` in slashes, where only `\/` decodes to `/` and every other
    backslash passes through to the engine.
- **`pick`**: one range or a `{a, b, …}` set. `pick` requires a following
  `replace`; a clause that stops at `pick` is a syntax error, not a viewer
  (a braced set needs at least one range). With a `match`, a point selecter
  (`line:column`) picks the match candidates whose span **contains the point**,
  while a line or range selecter keeps the "candidate contained in the picked
  range" rule. Without a `match`, the pick is the target itself: a line selects
  the whole line, a point selects one character, and a range selects that text
  range. A pick-only `{a, b, …}` set is supported as separate regions: the same
  fence replacement is applied to every resolved range (all-or-none at
  resolution; overlapping ranges are a `stage: range` failure).
- **`replace with <fence>`**: the sentinel-only fence shared with the Plan DSL
  ([`plan-exec.md`](plan-exec.md) §3). `<<<TC_EDIT_BEGIN>>>` and
  `<<<TC_EDIT_END>>>` are exact whole lines, optionally indented or with
  trailing whitespace; the body is raw, so hyphen runs, six-backtick runs,
  `done`, and `end` are ordinary body lines. Only an exact close-marker line
  closes the fence. Trailing text on the close-marker line is rejected, and a
  body cannot contain an exact close-marker line: the first exact line closes it
  and later content is rejected, with no escape form. An empty fence deletes the
  target.
- **`rename <old> to <new>`**: the other editor form. It rewrites the selected
  declaration name and every same-file reference that lexically resolves to it.
  Shadowed bindings and out-of-scope names are untouched; dotted targets rename
  the final segment for namespaces, enum members, and class fields (`this.field`
  plus same-class static accesses). A collision with an existing binding at the
  same scope or qualified path is an `address` failure, and a rename cannot be
  combined with `pick` or `replace`.
- **`end`** terminates a select clause. File commands use `end` too, except
  `write`, whose sentinel close terminates it.

A select clause with neither `replace` nor `rename` is a **viewer**: it locates
and writes nothing (§4). A select clause with `replace` is an editor (after
`pick` when present); `pick` requires `replace`. A `rename` is always an editor,
never a viewer.

**Select first.** The first edit-dsl reply is exactly one select clause or file
commands; it is never both. The harness renders its symbol index as top-level
`select <name> in <path> [resolve <space>]` lines. Test files (`*.test.ts`) are
specifications rather than edit targets, so they are not advertised in the
index; an explicit test address still resolves. A viewer (no `replace`) pins the
declaration and the harness answers with a `# details` prompt: the goal, the
symbol index, and the declaration source numbered with file-absolute lines; the
next reply carries the edit. An editor select clause (with `replace` or
`rename`) carries its own edit and is applied without a second model call. A
missing path, a missing symbol, or a space miss pins mode `create`, and the next
prompt asks for a create clause.

### Rename semantics

A rename is resolved against the whole file before any splice is queued. The
engine parses the file, builds lexical scopes, and rewrites the declaration
identifier plus every reference with the same binding identity. Renaming a
parameter does not touch an outer variable with that name; renaming an outer
binding does not touch an inner shadow; references inside nested closures are
included. Function, class, interface, and type-alias declarations rename their
same-file references by value/type space.

Dotted targets use the full locator path (`Color.Red`, `Widget.field`, `A.B`)
and rename only the final segment. Qualified references are matched
structurally: `X.A.B` and `A.B.Z` do not match target `A.B`, and a same-named
member on another enum/class is untouched. Class field references are limited
to `this.field` and same-class static accesses; arbitrary receiver-typed
`obj.field` accesses are not rewritten.

A rename failure (unresolved or ambiguous address, invalid new name, or a
collision at the same scope/qualified path) is reported at the `address` stage
and discards the entire reply. A rename mixed with other editor or file
commands applies all regions or none, through the same atomic apply pipeline.

### Grammar

ISO/IEC 14977 EBNF (originally drafted in `human/edit.md`):

```ebnf
edit-reply   = { statement } ;

statement    = select-clause | file-command ;

file-command = 'create', path, 'end'
             | 'delete', path, 'end'
             | 'read', path, [ 'within', selecters ], 'end'
             | 'write', path, [ 'within', selecters ], 'with', fence
             (* sentinel close terminates; no trailing 'end' *) ;

select-clause = 'select', [ kind ], symbol, 'in', path,
                [ 'resolve', space ],
                [ 'within', selecters ],
                [ 'match', ( snippet | regex ) ],
                [ replacer | renamer ],
                'end' ;

replacer     = [ 'pick', selecters ], 'replace', 'with', fence ;
renamer      = 'rename', identifier, 'to', identifier ;

selecters    = '{', range, { ',', range }, '}'
             | range ;                                   (* single-range sugar *)

range        = line, [ ':', column, [ '-', line, [ ':', column ] ] ] ;

line         = digit, { digit } ;
column       = digit, { digit } ;
digit        = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' ;

kind         = 'function' | 'const' | 'let' | 'var' | 'class'
             | 'type' | 'interface' | 'enum' | 'namespace' ;
space        = 'value' | 'type' | 'namespace' ;
path         = ? file path token ? ;
symbol       = ? declared identifier ? ;
identifier   = ? TypeScript identifier ? ;
snippet      = ? '`' , verbatim source, '`' ; only \` and \\ are escapes ? ;
regex        = ? '/' , ECMA-262 pattern, no flags, '/' ? ;
fence        = ? a line exactly <<<TC_EDIT_BEGIN>>>, raw body lines, then a
                 line exactly <<<TC_EDIT_END>>>; each marker may have leading
                 or trailing whitespace; the first exact close line terminates
                 and nothing may follow it on that line (a later statement may
                 start on the next line); the body may be empty ? ;
```

A select clause is never a file command. A coordinate is digits only: `0`
parses as a `line`/`column` but is rejected as not positive, and `selecters`
braces cannot be empty. `end` is required by the grammar. For `select`,
`create`, `delete`, and `read`, the tolerant reader may warn
`EDIT_MISSING_END` and recover at EOF or before an unambiguous next statement
(`select`, `create`, `delete`, `read`, or `write`); arbitrary following text is
a hard error. A `write` has no `end`: its `<<<TC_EDIT_END>>>` close terminates
it, and a trailing `end` is `EDIT_STRAY_END`. Prompts and examples always emit
the canonical terminator; recovery is not taught as a form.

### Tolerant recovery and error codes

Edit-action recovery follows the shared parser discipline in
[`plan-exec.md`](plan-exec.md) §5.2: recover structure to diagnose, never apply
a partial destructive result. In particular:

- Clause splitting recognizes `select` … `end` and respects sentinel bodies, so
  `select` inside a replacement body is not a boundary.
- A missing `end` after `select`, `create`, `delete`, or `read` is recovered
  with an `EDIT_MISSING_END` warning at EOF or before an unambiguous next
  statement (`select`, `create`, `delete`, `read`, or `write`); the reply is
  not rejected solely for this. Arbitrary following text is a hard
  `EDIT_MISSING_END`, and a `write` has no `end` to recover. A truncated fence
  or mid-clause EOF still rejects.
- Legacy hyphen/backtick fences report `EDIT_LEGACY_FENCE`; a misplaced or
  malformed sentinel reports `EDIT_MALFORMED_FENCE`, trailing text on a
  close-marker line reports `EDIT_FENCE_TRAILING_TEXT`, and content after a
  closed fence that is not a new statement reports `EDIT_EMBEDDED_FENCE_END`
  (there is no escape for a body containing the close marker).
- The retired `done` terminator reports `EDIT_RETIRED_DONE`; a trailing `end`
  after a `write` close reports `EDIT_STRAY_END`.
- `match` without a snippet/regex reports `EDIT_MATCHER_MISSING` with the
  accepted forms and an example.
- `pick` without `replace`, `rename` mixed with `replace`, unknown `resolve`
  space, and a malformed fence each get a dedicated code and a one-line hint.
- Multiple statements are all parsed before any application. One bad editor
  statement rejects all writes; good view-only statements may still return
  feedback.

Shipped `EDIT_*` error codes: `MISSING_END`, `MISSING_FIELD`, `UNKNOWN_FIELD`,
`UNCLOSED_FENCE`, `WHOLE_REPLY_FENCE`, `MALFORMED_FENCE`, `LEGACY_FENCE`,
`FENCE_TRAILING_TEXT`, `EMBEDDED_FENCE_END`, `RETIRED_DONE`, `STRAY_END`,
`MATCHER_MISSING`, `PICK_WITHOUT_REPLACE`, `RENAME_MIXED`, `UNKNOWN_SPACE`,
`TARGET_MISMATCH`, `TRUNCATED`.

### Outer wrapper (whole-reply Markdown fence)

Separate from `<fence>`, the reply reader strips one Markdown fence that wraps
the complete reply: 3+ backticks, an optional info string, a closing run at
least as long, and a first content line that starts with `select`, `create`,
`delete`, `read`, or `write`. It blanks the fence lines (diagnostic line numbers
stay stable), parses the bare reply, and records an `EDIT_WHOLE_REPLY_FENCE`
warning. This outer wrapper is not recognized inside a clause, does not delimit
a replacement body, and cannot wrap only part of the reply.

### Range arithmetic

`pick` ranges share `range`'s 1-based inclusive space and must sit inside the
declaration:

| Written      | Means                                       |
| ------------ | ------------------------------------------- |
| `12`         | all of line 12                              |
| `12:3`       | the single character at line 12, column 3   |
| `12:3-12:12` | line 12, columns 3 through 12               |
| `12:3-14`    | line 12 column 3 through the end of line 14 |

An omitted end column means "to end of its line": it is carried internally as
the sentinel `END_OF_LINE_COLUMN = 0` and translated to the end line's length
before the shared range resolver runs. Since columns are 1-based, `0` is never a
real position.

### File commands

The reply grammar also admits four file commands:

```text
create <path> end
delete <path> end
read   <path> [ within <selecters> ] end
write  <path> [ within <selecters> ] with
<<<TC_EDIT_BEGIN>>>
<raw body>
<<<TC_EDIT_END>>>
```

- **`create`** creates an empty file. An existing path is an `address` failure;
  parent directories are created. It does not run the parse/format gate.
- **`delete`** removes an existing regular file inside the workspace. A missing
  path is an `address` failure; directories and paths outside the workspace are
  rejected. `human/` is read-only for agents.
- **`read`** is a viewer: it returns the file (or the selected lines) and writes
  nothing. A missing path is an `address` failure. A `read` always sees the
  source as it was before the current reply, even when the same reply also
  writes that file. A failed `read` reports its error as feedback and does not
  discard the reply's editing statements. A whole-file result is folded (§4):
  the marker names the hidden range and line counts, and
  `read <path> within <start>-<end> end` returns that range unfolded.
- **`write`** replaces the whole file when `within` is absent, or the selected
  text when it is present, and creates the file if it does not exist. The
  sentinel close terminates the statement; no `end` follows. The replacement
  goes through the same parse gate, duplicate guard, formatter, and no-op check
  as an editor region.

`within` uses the same 1-based, inclusive `selecters` syntax as `pick`
(`12`, `12:3`, `12:3-14`, `12:3-14:5`, or a `{…}` set). Multiple selecters are
separate regions and must not overlap. A reply may mix select clauses and file
commands after the first target is pinned; the first reply is either exactly one
select clause or file commands, not both. The editing statements apply
atomically; a failed `read`, which writes nothing, is feedback rather than a
rejection. Two creates that append at the same offset are applied in statement
order; two creates of the same declaration still fail at the duplicate guard.
Create or delete a path at most once per reply; a create/delete combined with a
write or select clause on that path is a path-conflict rejection.

**One target per reply.** Every select clause in one reply — viewer, editor, or
rename — plus every implicit create must resolve to a distinct
`(path, symbol, kind)`. `resolve`, `match`, and `pick` do not make a new target.
A repeat fails at `stage: duplicate` before any matcher or write runs, naming
both statement numbers and the resolved address; the whole reply writes nothing.
Split edits to one declaration across exchanges.

Canonical examples:

A viewer for one declaration and an editor for another in one reply:

```text
select function answer in src/helper.ts
end

select function parse in src/helper.ts
match `return input;`
replace with
<<<TC_EDIT_BEGIN>>>
return input.trim();
<<<TC_EDIT_END>>>
end
```

A viewer slice returns only the selected declaration lines:

```text
select function toNumber in src/workbook.ts
within 34-60
end
```

A rename uses the same clause shape:

```text
select answer in src/helper.ts
rename answer to answerOf
end
```

An empty sentinel fence deletes the target:

```text
select function unused in src/helper.ts
replace with
<<<TC_EDIT_BEGIN>>>
<<<TC_EDIT_END>>>
end
```

File commands end with `end` except `write`, whose sentinel close terminates
it:

```text
create src/parser.ts end
delete src/legacy-parser.ts end
read src/helper.ts within 1-12 end
```

A whole-file write:

```text
write src/parser.ts with
<<<TC_EDIT_BEGIN>>>
export function parse(input: string): string {
  return input.trim();
}
<<<TC_EDIT_END>>>
```

A ranged write:

```text
write src/parser.ts within 2-4 with
<<<TC_EDIT_BEGIN>>>
export function parse(input: string): string {
  return input.trim();
}
<<<TC_EDIT_END>>>
```

## 3. Resolution: the cascade

Both formats reduce to the same narrowing, one stage at a time.

1. **Address.** `select` (or the JSON payload `path`/`symbol`/`kind`) must land
   on exactly one declaration. In edit-dsl, the optional `resolve
   value|type|namespace` filters the index to that TypeScript symbol space; an
   omitted space accepts every space, and an empty `kind` is a path + name
   wildcard. A `class` or `enum` occupies both the value and type spaces (its
   declaration kind is authoritative); a function or variable occupies value,
   an interface or type alias occupies type, and a namespace declaration
   occupies the namespace space. A space miss names the available spaces and
   never falls back to another one; the JSON payload path passes no space.
   Re-pinning is expressed, in edit-dsl, by naming a different declaration in
   the clause's own `select`; the new address faces the same unique-resolution
   rule against the current source.
2. **Match.** The locator matches _inside_ the declaration's span only.
   - A **snippet** is parsed as TypeScript and compared **structurally**: its
     AST must equal a candidate's AST, ignoring spans, raw text, and trivia. A
     wrapper heuristic tries, in priority order, a single statement, a single
     class-body member, an expression, and finally a contiguous run of two or
     more statements against consecutive sibling slots. Each successful
     single-node wrapper is a candidate; a run becomes one span covering it.
   - A **regex** compiles with the `g` and `m` flags and **no user-supplied
     flags**. `m` anchors `^` and `$` at line boundaries _inside the
     declaration_; `.` does not cross newlines (there is no `s`). Only fully
     contained matches count, and a zero-width match is a valid insertion-point
     span.
3. **Pick.** Each range resolves through the shared range resolver (bounds,
   inclusiveness, declaration containment). With a `match`, the candidate set is
   filtered by the selecter kind: a **point** keeps candidates whose span
   contains the point, while a line or range keeps candidates contained in the
   picked range. Without a `match`, the pick is not a filter: each resolved text
   span (whole line, one character, or the written range) is a target. The
   edit-dsl resolver expands a pick-only `{a, b, …}` into one single-range region
   per selecter, all carrying the same fence replacement; resolution is
   all-or-none for the clause, and overlapping resolved spans fail at the range
   stage.
4. **Rewrite.** With no `match` and no `pick` the target is the whole
   declaration — the `human/edit.md` "behavior like `str_search` in the top-level
   definition": the symbol index locates the definition, and no literal text
   search runs. With a pick-only clause the target is the picked text span;
   otherwise it is the resolved match span. A rewrite that starts at the
   declaration's start gets the **`export` tolerance**: an indexed node range
   excludes a wrapping `export`, so a replacement that still carries it keeps
   exactly one copy. A body-level target is never stripped.

The policy is total, and nothing is guessed: exactly one candidate at the finest
supplied stage is the target, zero is `matcher-not-found`, and more than one is
`matcher-ambiguous` (after a `pick`, the diagnostic says the ranges still leave
more than one). Each applied clause records its stage (`whole-symbol`, `match`,
or `pick`); the JSON payload path records the equivalent `whole-symbol` /
`matcher` / `range` selector, with `range` winning over `matcher`.

These guards run before any gate:

- **No-op, per region.** A replacement byte-identical to the text it replaces
  is a `no-op` failure. Because it is per clause, one inert clause does not
  reject a whole reply.
- **Regex bounds.** A pattern over 1024 characters, one that fails to compile,
  or one matching over 1000 times inside the declaration is `regex-invalid`, a
  `matcher`-stage cause. A single catastrophic-backtracking `exec` cannot be
  interrupted in-process, so the length cap plus the bounded target are the
  practical limit.
- **Snippet parse.** A snippet must parse even when it is structurally
  ambiguous; an unparseable fragment is `matcher-unparseable` with the parser's
  position.

## 4. Viewers

A select clause with no `replace` writes nothing and reports the declaration as
the next prompt's `# details` block: the source is numbered with its
file-absolute lines. A declaration or file block is folded by indentation when
it has nested blocks: headers, closing lines, and the first level of body lines
stay visible, while long nested bodies become a marker. A flat block with no
usable indentation structure keeps the three-head/three-tail fallback. The marker
is:

```text
... // content folded, <path>: <first>-<last>L (<hidden> of <total> lines hidden); expand with read <path> within <first>-<last> end
```

It names the hidden file-absolute range, how many of the block's lines it hides,
and the command that expands exactly that range. The same fold applies to viewer
feedback, command-pinned files, and the `# modified text` confirmation; a
whole-file `read` is folded the same way. A `read within` is the expansion and
returns its selected lines unfolded, so the marker's command shows exactly the
hidden range. A `select ... within <first>-<last> end` is the declaration-level
equivalent: it returns exactly the selected lines and does not fold them. A
`match` viewer reports its candidate positions; the declaration block itself may
be unmarked in this select-first pass. A bare viewer (no `match`) renders the
whole declaration once — the same `str_search`-like top-level default as the
editor path. Where an editor treats ambiguity as failure, a viewer treats it as
**information**: a `match` viewer returns all occurrences so the model can see
the candidates, then add `replace` (optionally with a `pick` to narrow it) or
lengthen the snippet. A `pick` requires `replace` and is not a viewer form. A
malformed matcher still fails with its typed cause.

A locate turn is recorded as a `viewer` row, not an edit failure. A mixed reply
applies its editor select clauses and carries the viewer results alongside the
next diagnostics. The feedback ends by asking for an editor select clause: add
`replace`, optionally with a `pick` to narrow it.

## 5. Failure stages

Every rejection carries a `stage:` tag and costs one exchange. Both formats share
the vocabulary so metrics compare.

| Stage                  | Cause                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `syntax`               | Edit-dsl only: the reply does not parse as a statement (`select … end` or a file command), including a fence or terminator error. |
| `protocol`             | The JSON payload object is malformed, carries an unexpected key, or a JSON payload arrives under edit-dsl. |
| `echo` / `address`     | The address does not echo the pinned selection, or does not resolve uniquely.                      |
| `matcher`              | `matcher-unparseable`, `matcher-not-found`, `matcher-ambiguous`, or `regex-invalid`.               |
| `range`                | A `range`/`pick` that is out of bounds, empty, inverted, or outside the declaration.               |
| `no-op`                | The replacement equals the text it replaces.                                                       |
| `repeat` / `duplicate` | A byte-identical resubmission; a repeated resolved target; a duplicate top-level declaration or create. |
| `gate`                 | The file parsed before and does not parse after.                                                   |
| `format`               | oxfmt rejected the result, or the formatted source equals the pre-edit source.                     |

When an edit-dsl statement fails, its diagnostic names the statement, its
position in the reply (`clause N of M`), its locator and path, and states that
the whole reply was discarded, so the model must resend the full corrected
reply. The `EDIT_*` parser codes are listed in §2; the Plan DSL's `PLAN_*` codes
are owned by [`plan-exec.md`](plan-exec.md) §5.3. Retry policy around a
rejection is owned by [`feedback-loop.md`](feedback-loop.md).

## 6. Application and gating

Nothing is written until the candidate passes, in order: address resolution,
the **unique-target claim** (every `select`, `rename`, and implicit create in
one reply resolves to a distinct `(path, symbol, kind)`), matcher/range
resolution, then the splice, the **parse gate** (a file that parsed must still
parse), the **duplicate-declaration guard** (a top-level `function`, `class`, or
`type` name may not be added twice), the **formatter**, and the **post-format
no-op check** (a candidate that differs only by formatting is rejected as a
no-op). A failing gate writes nothing and reports its stage.

The formats differ in what a batch means:

- **JSON payloads and batches are atomic.** A file's regions are spliced from
  the end so earlier offsets stay valid, and if any guard fails the whole
  exchange is discarded. Overlapping same-file regions discard the exchange and
  name both regions.
- **Edit-dsl replies are atomic across the editing statements.** Every statement
  resolves against its file's current source. Before any matcher runs, each
  select clause (viewer, editor, or rename) and each implicit create claims its
  resolved target; a repeated `(path, symbol, kind)` is a `stage: duplicate`
  rejection that names both statements and the address and discards the reply.
  If any editing statement fails resolution, or the apply pipeline reports any
  guard/overlap failure, the whole reply is discarded and nothing is written —
  no file, including creates, deletes, and writes. Only a reply with no editing
  failures writes every resolved region and file command. Multiple creates that
  append at the same end offset are applied in statement order; duplicate
  creates of the same declaration still fail at the duplicate guard. A failed
  `read` is the one exception: it writes nothing by construction, so its error
  rides the next prompt without discarding the other statements. A mixed
  viewer+editor reply that fails writes nothing but still carries the viewer
  feedback. A failing reply is a retry-driving rejection, and the retry must
  carry the full corrected reply (there is no "already applied" list).

A reply whose statements all fail writes nothing; one whose statements all apply
goes to verification. A failed verification does **not** roll back: the attempted
state stays on disk and its diagnostics open the next round (see
[`feedback-loop.md`](feedback-loop.md)).

**Implicit create (edit-dsl only).** Any editor select clause (a non-empty
`replace`) whose symbol is absent, or is declared only in another symbol space,
appends the fence body as a new top-level declaration, creating the file and its
parent directories as needed, spliced at the file's current end behind a
separating newline. `match` and `pick` do not change creation; they are ignored
when the symbol is missing. Viewers never create.

The fence body is validated before it is appended:

- If it is a list of top-level declarations, exactly one declaration must be
  named after the clause's symbol (dotted member names do not count). None or
  more than one is a `stage: address` failure; a declaration list is never
  wrapped. Multiple same-name declarations are rejected even when TypeScript
  would merge them (function overloads, class+interface merges, and value+type
  merges all count as more than one declaration). A list with exactly one such
  declaration is appended verbatim, even when it also declares other names.
- If `resolve` is present, that declaration must occupy the requested space.
  A type alias with `resolve value`, or a function with `resolve type`, is a
  `stage: address` failure naming the spaces the declaration actually occupies.
- A body that is not a declaration list is wrapped by the clause's symbol space:
  no `resolve` or `resolve value` wraps it as `let <symbol> = <body>;`,
  `resolve type` as `type <symbol> = <body>;`, and `resolve namespace` as a
  `namespace <symbol> { … }` block.

A name declared in the requested space (including a kind miss), an ambiguous
name, an empty fence, and a viewer keep the address failure and create nothing.
The JSON payload path creates only through a `create` selection and deletes only
through a `delete` selection; the edit-dsl path creates implicitly and deletes
with an empty fence.

**Edit-dsl confirmation.** When an edit-dsl edit passes verification, the harness
sends one `# modified text` prompt containing the goal, the symbol index, and
the edited declaration with file-absolute line numbers. A reply that parses as
at least one editor select clause (a clause with `replace`) continues the
exchange loop and is applied without another model call; every other reply —
`Great! I resolve this problem!`, prose, a malformed clause, or a viewer —
confirms success and ends the run. If the verified edit consumed the last exchange of the round, an
editor reply still ends successfully rather than losing the verified state. The
confirmation itself records a `confirmed` row, not an applied or rejected
exchange. The JSON payload format has no confirmation turn.

## 7. Repair feedback

A rejection is never a give-up; it is a retry with better information. The next
prompt carries the stage-tagged diagnostic, and from the second consecutive
rejection of the same cause, an escalation. The format-specific corrections are:

- Under edit-dsl, a `protocol` rejection re-teaches the `select … end` form.
  Restating the JSON payload rule would drive the model back to the JSON payload
  this mode rejects.
- Edit-dsl edit retries and round continuations keep the select-first shape:
  `# Goal`, the select-line `# Symbol index`, and `# details` with the numbered
  current declaration. They never carry the JSON `Pinned selection` block.
  A rejected selection retry or selection continuation asks for exactly one
  `select … end` clause naming a symbol-index entry.
- A viewer's occurrences ride the next prompt as located candidates, so the
  model can disambiguate instead of guessing.

A viewer's candidates are placed beside the rejection text, keeping "what still
fails" apart from what the model can pick next.

## 8. Skeleton

The essential resolver, stripped of diagnostics and metric plumbing:

```ts
// One parsed select clause: both formats reduce to this shape.
interface Selection {
  locator: Locator; // {path, name, kind}; empty kind = wildcard
  space: SymbolSpace | null; // `resolve value|type|namespace`; null = any
  matcher: { kind: "snippet" | "regex"; value: string } | null;
  pick: EditRange[] | null; // requires `replace`; with match filters, without match targets
  replacement: string | null; // null = viewer
}

// Address stage: path + name, the optional declaration kind, and the `resolve`
// space filter. A space miss names the available spaces and never falls back.
function resolveAddress(index: SymbolIndex, s: Selection): IndexEntry | "address" {
  const matches = index.lookup(s.locator, s.space);
  return matches.length === 1 ? matches[0]! : "address";
}

// Resolve one select clause against the declaration and the file's current
// source.
function resolveCascade(source: string, entry: IndexEntry, s: Selection) {
  const declaration = { start: entry.node.start, end: entry.node.end };
  let span: Span;
  let stage: "whole-symbol" | "match" | "pick";

  if (s.matcher === null) {
    if (s.pick !== null) {
      // Pick-only primitive: one selecter resolves to one text span. The
      // edit-dsl resolver expands a multi-range pick into one such clause per
      // selecter (all-or-none, overlap-checked).
      const ranges = resolvePickSpans(source, entry, s.pick);
      if (!ranges.ok || ranges.spans.length !== 1) return fail("range-invalid");
      span = ranges.spans[0]!;
      stage = "pick";
    } else {
      span = declaration; // whole declaration
      stage = "whole-symbol";
    }
  } else {
    // Candidates lie inside the declaration only.
    const found =
      s.matcher.kind === "regex"
        ? findRegexMatches(source, entry.node, s.matcher.value)
        : findMatcherMatches(source, entry.node, s.matcher.value);
    if (found.kind !== "matches") return fail("matcher-unparseable");

    let spans = found.spans;
    if (s.pick !== null) {
      const ranges = resolvePickSpans(source, entry, s.pick); // typed range failures
      if (!ranges.ok) return fail("range-invalid");
      // Point selecters keep candidates that contain the point; line/range
      // selecters keep candidates contained in the picked range.
      spans = spans.filter((candidate) => pickMatchesSpan(candidate, s.pick!, ranges.spans));
    }
    if (spans.length === 0) return fail("matcher-not-found");
    if (spans.length > 1) return fail("matcher-ambiguous");
    span = spans[0]!;
    stage = s.pick === null ? "match" : "pick";
  }

  // A viewer writes nothing: the loop renders its numbered declaration block
  // with `⁉️` in the gutter on the matched lines.
  if (s.replacement === null) return { ok: true, span, text: "", viewer: true, stage };

  // `export` tolerance only for a target that starts at the declaration.
  const text =
    span.start === declaration.start
      ? stripLeadingExport(s.replacement, precedingExportModifier(source, entry))
      : s.replacement;
  if (text === source.slice(span.start, span.end)) return fail("no-op");
  return { ok: true, span, text, viewer: false, stage };
}

// Every candidate must pass these before a write.
function gate(source: string, spliced: string): Stage | null {
  if (!parses(spliced)) return "gate"; // parsed before → parses after
  if (duplicatesTopLevelDeclaration(source, spliced)) return "duplicate";
  const formatted = format(spliced); // oxfmt
  if (formatted === source) return "no-op"; // post-format no-op
  return null; // the splice is written
}
```

### What the skeleton leaves out

- **Per-file application policy.** The edit-dsl reply's document-order,
  independently-guarded splice with an offset delta, versus the JSON payload
  batch's all-or-nothing splice (§6).
- **Unique-target claims.** The resolver's per-reply `(path, symbol, kind)` set
  across viewers, editors, renames, and implicit creates, and its `duplicate`
  diagnostic (§6).
- **Wrapper priority.** A snippet is tried as a statement, a class member, an
  expression, then a statement run; the first wrapper with a structural hit
  wins and later ones are not tried (§3).
- **Implicit create.** The absent-symbol append, parent-directory creation, and
  its separating newline (§6).
- **Pick-only multi-range expansion.** The edit-dsl resolver maps a `{a, b, …}`
  set to one single-range region per selecter, rejecting the statement on any
  range failure or overlap (§3).
- **Metric rows.** The per-statement `stage`, `matcherKind`, and `selector`
  fields the benchmark harnesses read (§3).
- **Repair prompt assembly.** Format-specific corrections, escalations, and the
  applied/viewer feedback (§7).
