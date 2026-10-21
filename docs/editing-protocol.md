# The editing protocol

`tc` splices edits the model describes, never edits or commands it chooses. The
model replies with a **payload** that names a declaration, locates a span
inside it, and supplies replacement text; the harness resolves the address,
proves the locator unique, splices, gates, and formats. This document describes
that payload: what the model may send, how each field resolves, and the checks
that run before a byte reaches disk. The Edit → Verify loop around it is
[`agent-loop.md`](agent-loop.md).

Two reply formats exist, selected by `--protocol-format` (default `json`):

- **json**: one flat object per exchange. The shipped format; explicit-targets
  mode (`--targets`) always uses it.
- **compact**: one or more `select … end` clauses, on the same resolver but with
  richer locators (regex, multi-range `pick`) and non-atomic multi-clause
  replies. A JSON edit payload in this mode is a protocol rejection.

Implementation: `parseEditResponse` and `resolveEditRange` in `src/loop.ts`, the
clause grammar in `src/selection.ts`, the cascade in `src/cascade.ts`, the reply
resolver in `src/compact.ts`, structural/regex matching in `src/matcher.ts`, the
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
and every failing payload is named. The compact format does not use this
wrapper; it batches by sending more clauses.

## 2. The compact clause

```text
select [kind] <symbol> in <path> [ resolve (value|type|namespace) ] [ match (<snippet> | /regex/) [ pick <range-or-set> ] ] [ replace with <fence> ] end
```

A reply is one or more clauses, with no markdown fences around the reply (a
fenced _reply_ is tolerated) and no prose. The grammar is read by a hand-written
recursive-descent reader in which whitespace between tokens is
insignificant, except inside a fence body and a `/regex/`. Any malformed input
throws a `stage: syntax` diagnostic naming the offending field, and a partial
selection is never returned.

- **Header**: `select`, then one or two bare tokens, then `in <path>`. One token
  is the symbol; two are `<kind> <symbol>`. The admitted kinds are `function`,
  `const`, `let`, `var`, `class`, `type`, `interface`, `enum`, and `namespace`,
  so any other leading token is a syntax error rather than a symbol name. The
  declaration kind is the legacy disambiguator; omitted, it means any kind.
- **`resolve`**: optional, after the path. `resolve value`, `resolve type`, or
  `resolve namespace` filters the address to that TypeScript symbol space; it is
  the disambiguator when the same name is declared more than once. Omitted, any
  space is accepted; the json path has no space form.
- **`match`**: exactly one of two locators.
  - a `` `snippet` `` in backticks, where only `` \` `` and `\\` are escapes and
    every other backslash is literal;
  - a `/regex/` in slashes, where only `\/` decodes to `/` and every other
    backslash passes through to the engine.
- **`pick`**: one range or a `{a, b, …}` set, legal only after `match` (a
  `pick` without one is a syntax error; a braced set needs at least one range).
- **`replace with <fence>`**: 6 or more backticks on their own line, a raw body,
  and a closing line of the same backtick run. The body may not contain a run of
  3 or more backticks; the serializer always opens exactly 6. An empty fence
  deletes the target.
- **`end`** terminates the clause.

A clause that stops before `replace` is a **viewer**: it locates and writes
nothing (§4).

### Grammar

ISO/IEC 14977 EBNF (originally drafted in `human/edit.md`):

```ebnf
multiEditor = { editor } ;

editor      = 'select', [ kind ], symbol, 'in', path,
              [ 'resolve', space ],
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
space       = 'value' | 'type' | 'namespace' ;
path        = ? file path token ? ;
symbol      = ? declared identifier ? ;
snippet     = ? '`' , verbatim source, '`' ? ;
regex       = ? '/' , ECMA-262 pattern, no flags, '/' ? ;
fence       = ? 6+ backticks; body free of a run >= 3; closing run matches ? ;
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

## 3. Resolution: the cascade

Both formats reduce to the same narrowing, one stage at a time.

1. **Address.** `select` (or the json `path`/`symbol`/`kind`) must land on
   exactly one declaration. In compact, the optional `resolve
   value|type|namespace` filters the index to that TypeScript symbol space; an
   omitted space accepts every space, and an empty `kind` is a path + name
   wildcard. A `class` or `enum` occupies both the value and type spaces (its
   declaration kind is authoritative); a function or variable occupies value,
   an interface or type alias occupies type, and a namespace declaration
   occupies the namespace space. A space miss names the available spaces and
   never falls back to another one; the json path passes no space. Re-pinning is
   expressed, in compact, by naming a different declaration in the clause's own
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
   inclusiveness, declaration containment), and the candidate set is filtered to
   spans contained in the union of the picked ranges. `pick` only ever removes
   candidates.
4. **Rewrite.** With no `match` the target is the whole declaration; otherwise
   it is the resolved span. A rewrite that starts at the declaration's start
   gets the **`export` tolerance**: an indexed node range excludes a wrapping
   `export`, so a replacement that still carries it keeps exactly one copy. A
   body-level target is never stripped.

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

A compact clause with no `replace` writes nothing and reports one numbered
declaration block per clause as the next prompt's feedback: each candidate's
exact file-absolute `path:line:col` position precedes the block, and every line
intersected by a matched span carries `⁉️` in the gutter. A bare viewer (no
`match`) renders the whole declaration once and marks nothing. Where an editor
treats ambiguity as failure, a viewer treats it as **information**: a `match`
viewer returns all occurrences (optionally filtered by `pick`) so the model can
see the candidates, then add a `pick` or lengthen the snippet. A malformed
matcher or an unresolvable `pick` still fails with its typed cause.

A locate turn is recorded as a `viewer` row, not an edit failure. A mixed reply
applies its editors and carries the viewer results alongside the next
diagnostics. The feedback ends by asking for an edit clause: add `replace`, or
narrow a viewer with `pick`.

## 5. Failure stages

Every rejection carries a `stage:` tag and costs one exchange. Both formats share
the vocabulary so metrics compare.

| Stage                  | Cause                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `syntax`               | Compact only: the reply does not parse as `select … end`.                                         |
| `protocol`             | The json object is malformed, carries an unexpected key, or a JSON payload arrives under compact. |
| `echo` / `address`     | The address does not echo the pinned selection, or does not resolve uniquely.                     |
| `matcher`              | `matcher-unparseable`, `matcher-not-found`, `matcher-ambiguous`, or `regex-invalid`.              |
| `range`                | A `range`/`pick` that is out of bounds, empty, inverted, or outside the declaration.              |
| `no-op`                | The replacement equals the text it replaces.                                                      |
| `repeat` / `duplicate` | A byte-identical resubmission; a duplicate top-level declaration.                                 |
| `gate`                 | The file parsed before and does not parse after.                                                  |
| `format`               | oxfmt rejected the result, or the formatted source equals the pre-edit source.                    |

When a compact clause fails, its diagnostic names the clause, its position in
the reply (`clause N of M`), its locator and path, and, when other clauses
applied, the applied list, so the model resends only the failing clauses.

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
- **Compact replies are non-atomic.** Clauses apply per file in document order,
  each guarded on its own: an applied clause stands even when a later clause
  fails. Every clause keeps its original offsets, mapped onto the evolving
  source with a running offset delta, and the file is formatted once at the end.
  A clause overlapping an applied one is skipped, the earlier winning. A reply
  with failures is still a retry-driving rejection, but the successful writes
  persist and are listed as "already applied (do not resend)"; a resend of an
  applied clause now fails as `matcher-not-found`.

A reply whose clauses all fail writes nothing; one whose clauses all apply goes
to verification. A failed verification does **not** roll back: the attempted
state stays on disk and its diagnostics open the next round (see
`agent-loop.md`).

**Implicit create (compact only).** A whole-declaration editor (no `match`, no
`pick`, a non-empty fence) whose symbol is absent appends the fence body as a
new top-level declaration, creating the file and its parent directories as
needed, spliced at the file's current end behind a separating newline. A
complete top-level declaration in the fence is appended verbatim; any other body
is wrapped by the clause's symbol space: no `resolve` or `resolve value` wraps
it as `let <symbol> = <body>;`, `resolve type` as `type <symbol> = <body>;`, and
`resolve namespace` as a `namespace <symbol> { … }` block. A name that is
declared, a space miss, and every other miss (a matcher, an empty fence, a
viewer), keep the address failure and create nothing. The json path creates
only through a `create` selection and deletes only through a `delete` selection;
the compact path creates implicitly and deletes with an empty fence.

## 7. Repair feedback

A rejection is never a give-up; it is a retry with better information. The next
prompt carries the stage-tagged diagnostic, and from the second consecutive
rejection of the same cause, an escalation. Two corrections are
format-specific:

- Under compact, a `protocol` rejection re-teaches the `select … end` form.
  Restating the JSON edit rule would drive the model back to the payload this
  mode rejects.
- A viewer's occurrences ride the next prompt as located candidates, so the
  model can disambiguate instead of guessing.

An applied-clause list or a viewer's candidates are placed beside the rejection
text, keeping "what already happened" apart from "what still fails".

## 8. Skeleton

The essential resolver, stripped of diagnostics and metric plumbing:

```ts
// One parsed clause: both formats reduce to this shape.
interface Selection {
  locator: Locator; // {path, name, kind}; empty kind = wildcard
  space: SymbolSpace | null; // `resolve value|type|namespace`; null = any
  matcher: { kind: "snippet" | "regex"; value: string } | null;
  pick: EditRange[] | null; // legal only below `match`
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
    span = declaration; // whole declaration
    stage = "whole-symbol";
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
      spans = spans.filter((candidate) => ranges.spans.some((r) => contains(r, candidate)));
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

- **Per-file application policy.** The compact reply's document-order,
  independently-guarded splice with an offset delta, versus the json batch's
  all-or-nothing splice (§6).
- **Wrapper priority.** A snippet is tried as a statement, a class member, an
  expression, then a statement run; the first wrapper with a structural hit
  wins and later ones are not tried (§3).
- **Implicit create.** The absent-symbol append, parent-directory creation, and
  its separating newline (§6).
- **Metric rows.** The per-clause `stage`, `matcherKind`, and `selector` fields
  the benchmark harnesses read (§3).
- **Repair prompt assembly.** Format-specific corrections, escalations, and the
  applied/viewer feedback (§7).
