# The editing protocol

`tc` splices edits the model describes, never edits or commands it chooses. The
model replies with a **payload** that names a declaration, locates a span
inside it, and supplies replacement text; the harness resolves the address,
proves the locator unique, splices, gates, and formats. This document describes
that payload: what the model may send, how each field resolves, and the checks
that run before a byte reaches disk. The Edit → Verify loop around it is
[`agent-loop.md`](agent-loop.md).

Two reply formats exist, selected by `--protocol-format` (default `edit-dsl`):

- **edit-dsl**: the default. One or more `select … end` clauses, on the same
  resolver but with richer locators (regex, multi-range `pick`) and atomic
  multi-clause replies. The same reply language also carries raw file commands
  (`create`, `delete`, `read`, `write`). A JSON edit payload in this mode is a
  protocol rejection.
- **json**: opt-in, one flat object per exchange. Explicit-targets mode
  (`--targets`) always uses it.

Implementation: `parseEditResponse` and `resolveEditRange` in `src/loop.ts`, the
clause grammar in `src/selection.ts`, the cascade in `src/cascade.ts`, the reply
resolver in `src/edit-dsl.ts`, structural/regex matching in `src/matcher.ts`, the
splice and format gate in `src/editor.ts`.

## 1. The json payload

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

The reply is read tolerantly: a whole-text markdown fence is stripped, and the
first brace-matched object inside surrounding prose is found by scanning with
string-literal and escape awareness. Prose around the object is fine; no object
is not.

**Batched replies.** Under the opt-in `--multi-payload` protocol, one
`{"payloads": [...]}` object carries several flat payloads, editing different
files and/or several non-overlapping regions of one file. The first payload
echoes the pinned address; every later payload names its own declaration, which
must resolve uniquely in its file's current source. Batches are `modify`-only,
the wrapper admits no key but `payloads`, and a batch is **atomic**: if any
payload fails its guards or two same-file regions overlap, nothing is written
and every failing payload is named. The edit-dsl format does not use this
wrapper; it batches by sending more clauses.

## 2. The edit-dsl clause

```text
select [kind] <symbol> in <path> [ resolve (value|type|namespace) ] [ match (<snippet> | /regex/) ] [ [ [ pick <range-or-set> ] replace with <fence> ] | rename <old> to <new> ] end
```

A reply is one or more statements — `select` clauses or raw file commands
(below) — with no markdown fences around the reply (a fenced _reply_ is
tolerated) and no prose. The grammar is read by a hand-written
recursive-descent reader in which whitespace between tokens is
insignificant, except inside a fence body and a `/regex/`. Any malformed input
throws a `stage: syntax` diagnostic naming the offending field, and a partial
selection is never returned.

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
  space is accepted; the json path has no space form.
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
- **`replace with <fence>`**: 5 or more hyphens (for example `-----`) or 6 or
  more backticks on their own line, a raw body, and a closing line of the same
  run. The body may not contain a run of 3 or more of the fence's own delimiter.
  The serializer prefers five hyphens and falls back to six backticks when the
  body contains a hyphen run. An empty fence deletes the target.
- **`rename <old> to <new>`**: the other editor form. It rewrites the selected
  declaration name and every same-file reference that lexically resolves to it.
  Shadowed bindings and out-of-scope names are untouched; dotted targets rename
  the final segment for namespaces, enum members, and class fields (`this.field`
  plus same-class static accesses). A collision with an existing binding at the
  same scope or qualified path is an `address` failure, and a rename cannot be
  combined with `pick` or `replace`.
- **`end`** terminates the clause.

A clause with neither `replace` nor `rename` is a **viewer**: it locates and
writes nothing (§4). A clause with `replace` is an editor (after `pick` when
present); `pick` requires `replace`. A `rename` is always an editor, never a
viewer.

**Select first.** The first edit-dsl reply is exactly one clause. The harness
renders its symbol index as top-level `select <name> in <path> [resolve <space>]`
lines. Test files (`*.test.ts`) are specifications rather than edit targets, so
they are not advertised in the index; an explicit test address still resolves.
A viewer (no `replace`) pins the declaration and the harness answers with
a `# details` prompt: the goal, the symbol index, and the declaration source
numbered with file-absolute lines; the next reply is the edit clause. An editor
clause (with `replace` or `rename`) carries its own edit and is applied without
a second model call. A missing path, a missing symbol, or a space miss pins mode
`create`, and the next prompt asks for a create clause.

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
multiEditor = { editor | fs } ;

fs          = 'create', path, 'done'
            | 'delete', path, 'done'
            | 'read', path, [ 'within', multiRange ], 'done'
            | 'write', path, [ 'within', multiRange ], 'with', fence, 'done' ;

editor      = 'select', [ kind ], symbol, 'in', path,
              [ 'resolve', space ],
              [ 'match', ( snippet | regex ) ],
              [ replacer | renamer ],
              'end' ;

replacer    = [ 'pick', multiRange ], 'replace', 'with', fence ;
renamer     = 'rename', identifier, 'to', identifier ;

multiRange  = '{', range, { ',', range }, '}'
            | range ;                                   (* single-range sugar *)

range       = line, [ ':', column, [ '-', line, [ ':', column ] ] ] ;

line        = digit, { digit } ;
column      = digit, { digit } ;
digit       = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' ;

kind        = 'function' | 'const' | 'let' | 'var' | 'class'
            | 'type' | 'interface' | 'enum' | 'namespace' ;
space       = 'value' | 'type' | 'namespace' ;
path        = ? file path token ? ;
symbol      = ? declared identifier ? ;
identifier  = ? TypeScript identifier ? ;
snippet     = ? '`' , verbatim source, '`' ? ;
regex       = ? '/' , ECMA-262 pattern, no flags, '/' ? ;
fence       = ? 5+ hyphens or 6+ backticks; body free of a run >= 3 of the
                fence's own delimiter; closing run matches ? ;
```

A coordinate is digits only: `0` parses as a `line`/`column` but is rejected as
not positive, and `multiRange` braces cannot be empty.

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

### Raw file commands

`multiEditor` also admits four file commands:

```text
create <path> done
delete <path> done
read   <path> [ within <selecters> ] done
write  <path> [ within <selecters> ] with <fence> done
```

- **`create`** creates an empty file. An existing path is an `address` failure;
  parent directories are created. It does not run the parse/format gate.
- **`delete`** removes an existing regular file inside the workspace. A missing
  path is an `address` failure; directories and paths outside the workspace are
  rejected. `human/` is read-only for agents.
- **`read`** is a viewer: it returns the file (or the selected lines) and writes
  nothing. A missing path is an `address` failure. A `read` always sees the
  source as it was before the current reply, even when the same reply also
  writes that file.
- **`write`** replaces the whole file when `within` is absent, or the selected
  text when it is present, and creates the file if it does not exist. The
  replacement goes through the same parse gate, duplicate guard, formatter, and
  no-op check as an editor region.

`within` uses the same 1-based, inclusive `selecters` syntax as `pick`
(`12`, `12:3`, `12:3-14`, `12:3-14:5`, or a `{…}` set). Multiple selecters are
separate regions and must not overlap. A reply may mix editors and file
commands after the first target is pinned; the first reply is either exactly one
`select` clause or file commands, not both. All statements apply atomically.
Two creates that append at the same offset are applied in clause order; two
creates of the same declaration still fail at the duplicate guard.

## 3. Resolution: the cascade

Both formats reduce to the same narrowing, one stage at a time.

1. **Address.** `select` (or the json `path`/`symbol`/`kind`) must land on
   exactly one declaration. In edit-dsl, the optional `resolve
   value|type|namespace` filters the index to that TypeScript symbol space; an
   omitted space accepts every space, and an empty `kind` is a path + name
   wildcard. A `class` or `enum` occupies both the value and type spaces (its
   declaration kind is authoritative); a function or variable occupies value,
   an interface or type alias occupies type, and a namespace declaration
   occupies the namespace space. A space miss names the available spaces and
   never falls back to another one; the json path passes no space. Re-pinning is
   expressed, in edit-dsl, by naming a different declaration in the clause's own
   `select`; the new address faces the same unique-resolution rule against the
   current source.
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
or `pick`); the json path records the equivalent `whole-symbol` / `matcher` /
`range` selector, with `range` winning over `matcher`.

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

An edit-dsl clause with no `replace` writes nothing and reports the declaration as
the next prompt's `# details` block: the source is numbered with its
file-absolute lines. A `match` viewer reports its candidate positions; the
declaration block itself may be unmarked in this select-first pass. A bare
viewer (no `match`) renders the whole declaration once — the same
`str_search`-like top-level default as the editor path. Where an editor treats
ambiguity as failure, a viewer treats it as **information**: a `match` viewer
returns all occurrences so the model can see the candidates, then add `replace`
(optionally with a `pick` to narrow it) or lengthen the snippet. A `pick`
requires `replace` and is not a viewer form. A malformed matcher still fails
with its typed cause.

A locate turn is recorded as a `viewer` row, not an edit failure. A mixed reply
applies its editors and carries the viewer results alongside the next
diagnostics. The feedback ends by asking for an edit clause: add `replace`,
optionally with a `pick` to narrow it.

## 5. Failure stages

Every rejection carries a `stage:` tag and costs one exchange. Both formats share
the vocabulary so metrics compare.

| Stage                  | Cause                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `syntax`               | Edit-dsl only: the reply does not parse as `select … end`.                                         |
| `protocol`             | The json object is malformed, carries an unexpected key, or a JSON payload arrives under edit-dsl. |
| `echo` / `address`     | The address does not echo the pinned selection, or does not resolve uniquely.                      |
| `matcher`              | `matcher-unparseable`, `matcher-not-found`, `matcher-ambiguous`, or `regex-invalid`.               |
| `range`                | A `range`/`pick` that is out of bounds, empty, inverted, or outside the declaration.               |
| `no-op`                | The replacement equals the text it replaces.                                                       |
| `repeat` / `duplicate` | A byte-identical resubmission; a duplicate top-level declaration.                                  |
| `gate`                 | The file parsed before and does not parse after.                                                   |
| `format`               | oxfmt rejected the result, or the formatted source equals the pre-edit source.                     |

When an edit-dsl clause fails, its diagnostic names the clause, its position in
the reply (`clause N of M`), its locator and path, and states that the whole
reply was discarded, so the model must resend the full corrected reply.

## 6. Application and gating

Nothing is written until the candidate passes, in order: address resolution,
then matcher/range resolution, then the splice, the **parse gate** (a file that
parsed must still parse), the **duplicate-declaration guard** (a top-level
`function`, `class`, or `type` name may not be added twice), the
**formatter**, and the **post-format no-op check** (a candidate that differs
only by formatting is rejected as a no-op). A failing gate writes nothing and
reports its stage.

The formats differ in what a batch means:

- **Json payloads and batches are atomic.** A file's regions are spliced from
  the end so earlier offsets stay valid, and if any guard fails the whole
  exchange is discarded. Overlapping same-file regions discard the exchange and
  name both regions.
- **Edit-dsl replies are atomic across the whole reply.** Every statement
  resolves against its file's current source; if any statement fails
  resolution, or the apply pipeline reports any guard/overlap failure, the whole
  reply is discarded and nothing is written — no file, including creates,
  deletes, and raw writes. Only a reply with no failures writes every resolved
  region and file command. Multiple creates that append at the same end offset
  are applied in clause order; duplicate creates of the same declaration still
  fail at the duplicate guard. A mixed viewer+editor reply that fails
  writes nothing but still carries the viewer feedback. A failing reply is a
  retry-driving rejection, and the retry must carry the full corrected reply
  (there is no "already applied" list).

A reply whose clauses all fail writes nothing; one whose clauses all apply goes
to verification. A failed verification does **not** roll back: the attempted
state stays on disk and its diagnostics open the next round (see
`agent-loop.md`).

**Implicit create (edit-dsl only).** Any editor clause (a non-empty `replace`)
whose symbol is absent, or is declared only in another symbol space, appends the
fence body as a new top-level declaration, creating the file and its parent
directories as needed, spliced at the file's current end behind a separating
newline. `match` and `pick` do not change creation; they are ignored when the
symbol is missing. Viewers never create.

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
The json path creates only through a `create` selection and deletes only through
a `delete` selection; the edit-dsl path creates implicitly and deletes with an
empty fence.

**Edit-dsl confirmation.** When an edit-dsl edit passes verification, the harness
sends one `# modified text` prompt containing the goal, the symbol index, and
the edited declaration with file-absolute line numbers. A reply that parses as
at least one editor clause (a clause with `replace`) continues the exchange loop
and is applied without another model call; every other reply — `Great! I resolve
this problem!`, prose, a malformed clause, or a viewer — confirms success and
ends the run. If the verified edit consumed the last exchange of the round, an
editor reply still ends successfully rather than losing the verified state. The
confirmation itself records a `confirmed` row, not an applied or rejected
exchange. The json protocol has no confirmation turn.

## 7. Repair feedback

A rejection is never a give-up; it is a retry with better information. The next
prompt carries the stage-tagged diagnostic, and from the second consecutive
rejection of the same cause, an escalation. The format-specific corrections are:

- Under edit-dsl, a `protocol` rejection re-teaches the `select … end` form.
  Restating the JSON edit rule would drive the model back to the payload this
  mode rejects.
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
// One parsed clause: both formats reduce to this shape.
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

// Resolve one clause against the declaration and the file's current source.
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
  independently-guarded splice with an offset delta, versus the json batch's
  all-or-nothing splice (§6).
- **Wrapper priority.** A snippet is tried as a statement, a class member, an
  expression, then a statement run; the first wrapper with a structural hit
  wins and later ones are not tried (§3).
- **Implicit create.** The absent-symbol append, parent-directory creation, and
  its separating newline (§6).
- **Pick-only multi-range expansion.** The edit-dsl resolver maps a `{a, b, …}`
  set to one single-range region per selecter, rejecting the clause on any
  range failure or overlap (§3).
- **Metric rows.** The per-clause `stage`, `matcherKind`, and `selector` fields
  the benchmark harnesses read (§3).
- **Repair prompt assembly.** Format-specific corrections, escalations, and the
  applied/viewer feedback (§7).
