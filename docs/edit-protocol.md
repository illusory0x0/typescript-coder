# The edit protocol

Canonical ownership: this document owns the edit-action reply language
(edit-dsl). It also owns the sentinel fence,
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

## 1. Reply format

The only reply format is **edit-dsl**: one or more statements on one resolver,
with regex matchers, multi-range `pick`, and atomic multi-clause replies. The
same reply language also carries file commands (`create`, `delete`, `read`,
`write`). After a target is pinned, a reply may instead be the standalone control
turn `check end` or `test end`: it runs the task's configured check/test
command, writes nothing, and returns bounded output. A JSON edit payload is a
protocol rejection.

Implementation: `resolveEditRange` in `src/loop.ts`, the clause grammar in
`src/selection.ts`, the cascade in `src/cascade.ts`, the reply resolver in
`src/edit-dsl.ts`, structural/regex matching in `src/matcher.ts`, the splice and
format gate in `src/editor.ts`.

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

The module-boundary form is the separate file-level editor:

```text
select file <path> [ match (<snippet> | /regex/) ] [ pick <selecters> ] replace with <fence> end
```

A select clause is never a file command. A select clause with `replace` or
`rename` is an **editor**; with neither it is a **viewer**.

- **Header**: `select`, then one or two bare tokens, then `in <path>`. One token
  is the symbol; two are `<kind> <symbol>`. The admitted kinds are `function`,
  `const`, `let`, `var`, `class`, `type`, `interface`, `enum`, and `namespace`,
  so any other leading token is a syntax error rather than a symbol name. The
  declaration kind is the legacy disambiguator; omitted, it means any kind. A
  variable declaration resolves under its `const`, `let`, or `var` keyword; the
  index's internal `variable` label is not a grammar kind. A top-level `using`
  declaration is indexed as a variable binding and is addressed with an omitted
  kind (`select resource in …`); `using` is not a `select` kind token, so
  `select using resource in …` is a syntax error. `create using` is supported.
- **`resolve`**: optional, after the path. `resolve value`, `resolve type`, or
  `resolve namespace` filters the address to that TypeScript symbol space; it is
  the disambiguator when the same name is declared more than once. Omitted, any
  space is accepted.
- **`within`**: optional viewer-only slice, after `resolve`. It uses the same
  1-based inclusive file-absolute ranges as `read ... within`. The viewer returns
  exactly those lines from the declaration, unfolded. It cannot be combined with
  `match`, `pick`, `replace`, or `rename`; editors use `pick` for a narrowed
  rewrite.
- **`match`**: exactly one of two locators. A bare `match (` or unquoted code
  is not a matcher; it reports `EDIT_MATCHER_MISSING`.
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
  trailing whitespace. The opener may share the `with` line when it is the last
  non-whitespace token; the raw body still starts on the next line. The body is
  raw, so hyphen runs, six-backtick runs, `done`, and `end` are ordinary body
  lines. Only an exact close-marker line closes the fence. Trailing text on the
  close-marker line is rejected, and a body cannot contain an exact close-marker
  line: the first exact line closes it and later content is rejected, with no
  escape form. An empty fence deletes the target.
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

### Address rules for declarations and members

An address is `(path, symbol, kind)`. `symbol` is dotted when the declaration is
nested; `kind` is a grammar kind or the omitted wildcard. The index emits:

- top-level, namespace, and class declarations/members as before;
- interface and type-literal methods and properties as `Interface.member`,
  `Alias.member`, and nested literal members as `Interface.property.member`. A
  type literal is reached from a declared type alias or an interface property's
  type (including parenthesized and union/intersection literals); its members
  keep that owner path. Call, construct, and index signatures have no name;
  select the interface or type-alias owner and use `match`/`pick`/regex;
- enum members as `Enum.Member` with kind `enum-member`;
- object-literal properties, methods, and getters/setters owned by a declared
  variable or class field, recursively: `config.timeout`, `config.run`,
  `config.server.port`, `Service.config.retries`. A getter/setter pair shares
  `config.value` and is therefore ambiguous by name; select the object owner and
  `match`/`pick` the individual accessor. Only a literal assigned to that
  binding is indexed; an anonymous literal (a call argument, return value, or
  function-local variable) has no address and stays a `match`/`pick` target;
- named default exports by their declared name (`export default function boot`
  is `boot`, `export default class App` is `App`). An anonymous default export
  has no synthetic name and is an owner + `match`/`pick` target.

A member's indexed span is the parser's member span, so `modify` and `rename`
touch only that member. An empty-fence whole-member delete also removes the
member's following `,`/`;`, or its preceding separator for the last member; the
parse/format gate is the final check. Computed member names (`[expression]`),
class static blocks, class index signatures, and constructor parameter
properties are **not name-addressable**: select the class owner and use
`match`/`pick`/regex. A class auto-accessor (`accessor value = 1;`) is not
modeled by the parser, so a structural or named member edit is unsupported;
select the class owner and use `/regex/` or `pick` for its text.

Overload signatures and declaration merges never resolve to a silent first
declaration. Every declaration is an index candidate, and an address that
matches more than one is rejected with each candidate's line/column. A `kind`
can disambiguate a merge across symbol spaces (`class` vs `interface`,
`enum` vs `namespace`); overload signatures share a kind and are rejected until
a narrower target exists. Duplicate declarations are rejected the same way.

A multi-declarator statement (`const a = 1, b = 2`) or destructuring binding
(`const { a, b } = pair`) remains addressable per binding, and `match`/`pick`
inside one binding is supported. A whole-symbol `replace` or empty-fence delete
on one of those bindings is rejected because it would silently rewrite a
sibling binding; target a narrower span or a different declaration instead.

### Declaration coverage matrix

The table maps every covered declaration, member, and module-boundary category
to its address and selector paths. The committed proof is
`src/matcher-corpus.test.ts`; its `FORMS` list is authoritative, and a row marked
**expected failure** is a deliberate unsupported or ambiguous case rather than a
missing feature. In the selector column, **whole-symbol** means no `match` and no
`pick` (the indexed declaration span), **`match`** is the structural snippet,
**`/regex/`** is the regex locator, and **`pick`** is a line/point/range
selector. **Owner + selector** means select the class/interface/type-alias/
object/enum owner first; **rejected-with-candidates** means the address or
matcher fails and names every candidate, never the first.

| Form/owner                                                                           | Address                                                                                                                              | Supported selectors/create                                                                                                                                                          | Notes/limits                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top-level function                                                                   | `select function NAME in PATH` (kind optional)                                                                                       | whole-symbol; `match`; `/regex/`; `pick`; `create function NAME`                                                                                                                    | The declaration is appended at the file end; a body-level edit needs a selector.                                                                                                                |
| Top-level `const`/`let`/`var`/`using`                                                | `select const NAME`, `select let NAME`, or `select var NAME`; `using` uses an omitted kind (`select NAME`)                           | whole-symbol; `match`; `/regex/`; `pick`; `create const`, `create let`, `create var`, or `create using`                                                                             | `const`/`let`/`var` are the grammar's variable kinds; `select using NAME` is an **expected syntax failure**. Body-only create is accepted for these kinds.                                      |
| Top-level class, interface, type alias, enum, namespace                              | `select <kind> NAME` with `class`, `interface`, `type`, `enum`, or `namespace` (kind optional)                                       | whole-symbol; `match`; `/regex/`; `pick`; `create` the same declaration kind                                                                                                        | Class and enum occupy value and type spaces, interface/type alias type, namespace namespace. Create appends exactly one declaration.                                                            |
| Class method/property                                                                | `select Widget.render`; `select Widget.count` (omitted kind)                                                                         | whole-symbol; `match`; `/regex/`; `pick`; `create method Widget.render`; `create property Widget.count` (optional `static`)                                                         | The indexed span is the member; an empty-fence delete also removes its separator.                                                                                                               |
| Class getter/setter                                                                  | `select Widget.value` when only one accessor exists                                                                                  | whole-symbol; `match`; `/regex/`; `pick`; `create getter`, `create setter`, or `create accessor Widget.value`                                                                       | A getter/setter **pair shares the name**, so the address is ambiguous; select the class owner and `match`/`pick` one accessor. `accessor` create accepts a get or set fence; the pair is legal. |
| Class constructor                                                                    | Owner only: `select class Widget`                                                                                                    | Owner + `match`/`/regex/`/`pick`; `create constructor Widget`                                                                                                                       | No name address: the constructor has no index entry.                                                                                                                                            |
| Class static block, computed member, index signature, constructor parameter property | Owner only: `select class Widget`                                                                                                    | Owner + `match`/`/regex/`/`pick`; no create                                                                                                                                         | Not name-addressable. Static blocks and computed names are reached through the class-member context; index signatures and parameter properties are anonymous.                                   |
| Class auto-accessor (`accessor value = 1`)                                           | Owner only: `select class Widget`                                                                                                    | Owner + `/regex/` or `pick`; no create                                                                                                                                              | **Expected failure** for a structural or named-member edit: the parser does not model the form. `create accessor` emits a get/set pair, not this syntax.                                        |
| Interface or type-literal named method/property                                      | `select Cell.getValue`; `select Snapshot.value`; nested literal members keep the owner path (`Interface.property.member`)            | whole-symbol; `match`; `/regex/`; `pick`; `create method` or `create property` with an interface owner                                                                              | Type-literal member create is deferred. Interface/type-literal named members are renameable.                                                                                                    |
| Interface or type-literal call/construct/index signature                             | Owner only: `select interface Cell` or `select type Fn`                                                                              | Owner + `match`/`/regex/`/`pick`; create deferred                                                                                                                                   | Anonymous signatures have no name address; anonymous signature create is out of scope.                                                                                                          |
| Namespace member                                                                     | `select function Util.helper`; nested `A.B.member` with the declared kind                                                            | whole-symbol; `match`; `/regex/`; `pick`; `create <declaration-kind> Util.helper`                                                                                                   | The owner must already exist; a dotted create never creates its owner.                                                                                                                          |
| Enum member                                                                          | `select Color.Red` (omitted kind)                                                                                                    | whole-symbol; `match`; `/regex/`; `pick`; `create enum-member Color.Red`                                                                                                            | Enum-member create requires an existing enum owner.                                                                                                                                             |
| Object-literal property/method                                                       | `select config.timeout`; `select config.run`                                                                                         | whole-symbol; `match`; `/regex/`; `pick`; create deferred                                                                                                                           | Indexed only when the literal is assigned to a declared variable or class field; an anonymous literal stays owner + selector. Object-literal members are not renameable.                        |
| Object-literal getter/setter                                                         | A pair shares `select config.value` and is ambiguous; a single accessor may resolve                                                  | Owner + `match`/`/regex/`/`pick` (for example `select const config`); create deferred                                                                                               | **Expected address ambiguity** for the pair; pick one accessor through the owner.                                                                                                               |
| Named default export                                                                 | Declared name: `select function boot`; `select class App`                                                                            | whole-symbol; `match`; `/regex/`; `pick`; `create export` for a new statement                                                                                                       | Only a named default export has a declaration address.                                                                                                                                          |
| Anonymous default export                                                             | File owner: `select file PATH`                                                                                                       | File-level `match`/`/regex/`/`pick`; `create export`                                                                                                                                | File-level editor only; no declaration address and no file-level rename.                                                                                                                        |
| Imports: named, default, namespace, type-only, side-effect, `import = require`       | File owner: `select file PATH`                                                                                                       | File-level `match`/`/regex/`/`pick`; `create import`                                                                                                                                | One candidate is required; a whole statement or one specifier can be deleted; file-level rename is rejected.                                                                                    |
| Exports: named, star, re-export, `export =`, export declaration                      | File owner: `select file PATH`; a declaration export also keeps its declaration address (`export function f` is `select function f`) | File-level `match`/`/regex/`/`pick`; `create export`                                                                                                                                | An anonymous default export is file-level only; file-level rename is rejected.                                                                                                                  |
| Overloads                                                                            | `select function parse` (or another kind)                                                                                            | rejected-with-candidates; no whole-symbol target                                                                                                                                    | Every overload declaration is a candidate. Overloads share a kind, so no kind token disambiguates; never a silent first match.                                                                  |
| Declaration merges                                                                   | `select class Owner` or `select interface Owner`; an omitted kind is ambiguous                                                       | whole-symbol; `match`; `/regex/`; `pick` on the kind-disambiguated declaration                                                                                                      | An omitted kind over a merge is rejected-with-candidates; an explicit kind disambiguates a cross-space merge.                                                                                   |
| Multi-declarator or destructuring binding                                            | `select const first`; `select const a`                                                                                               | Per-binding `match`/`/regex/`/`pick`; whole-symbol replace/delete **rejected**                                                                                                      | **Expected failure** for a whole-symbol edit: it would rewrite a sibling binding. Target a narrower span.                                                                                       |
| Ambiguous or unsupported structural match                                            | Any declaration or owner above                                                                                                       | Ambiguous `match` is rejected-with-candidates, then `pick` or a longer snippet; a bare decorator is reached through its owner with a member-inclusive `match`, `/regex/`, or `pick` | **Expected failure** for an ambiguous `match` and for a standalone decorator; the diagnostic lists the candidates or attempted owner contexts.                                                  |

**Create limits.** `create` covers named top-level declaration kinds and named
members of an existing class, interface, namespace, or enum, plus `create import`
and `create export` at the module boundary. It does not create anonymous
call/construct/index signatures, type-literal or object-literal members,
computed members, static blocks, constructor parameter properties, or TypeScript
auto-accessors. A dotted create never creates its owner. See §2.1 for the
descriptor and modifier validation.

### File-level module-boundary select

`select file <path> … replace with <fence> end` gives imports and exports an
owner without a synthetic declaration name. The owner is the file source; no
symbol-index entry is resolved. The path must be safe, inside the workspace, and
an existing regular file.

- `match` (a structural snippet or `/regex/`) or `pick` locates the target. The
  candidate must lie inside exactly one top-level import/export statement:
  `import`/`import =` (including `import fs = require("fs")`), `export { … }`,
  `export … from`, `export *`, a default export, an export declaration
  (`export function …`), or `export =`. A match that lands outside one is an
  `address` rejection that names its location.
- Exactly one candidate is required. Multiple candidates are rejected with each
  `path:line:column` and its statement kind; the harness never picks the first.
  A `pick` with a `match` filters candidates with the normal point/contained
  rules; without a `match`, the one resolved pick range is the target. File-level
  `pick` coordinates are the same 1-based, inclusive, file-absolute coordinates
  as the numbered source block.
- `replace with <fence>` rewrites the matched/picked span. An empty fence
  deletes it: a whole statement deletion removes its line, and deleting a
  named specifier also removes its `,` separator. The parse gate, formatter,
  duplicate guard, atomic apply, and task/node gate are unchanged.
- A file-level select is an **editor only**: it requires `replace`, and
  `resolve`, `within`, and rename are rejected. Use `read <path> end` to view
  file lines, or `write <path> with <fence>` for a deliberate whole-file
  rewrite. A file-level `rename` is not supported because imported bindings and
  export aliases have no declaration address; edit the statement or specifier
  text instead rather than silently renaming an import.

### Rename semantics

A rename is resolved against the whole file before any splice is queued. The
engine parses the file, builds lexical scopes, and rewrites the declaration
identifier plus every reference with the same binding identity. Renaming a
parameter does not touch an outer variable with that name; renaming an outer
binding does not touch an inner shadow; references inside nested closures are
included. Function, class, interface, and type-alias declarations rename their
same-file references by value/type space.

Dotted targets use the full locator path (`Color.Red`, `Widget.field`, `A.B`)
and rename only the final segment. Interface and type-literal members are
qualified type bindings, so `Cell.value` and `Snapshot.nested.flag` rename their
declaration and same-file qualified type references. Qualified references are
matched structurally: `X.A.B` and `A.B.Z` do not match target `A.B`, and a
same-named member on another enum/class is untouched. Class field references are
limited to `this.field` and same-class static accesses; arbitrary receiver-typed
`obj.field` accesses are not rewritten.

Object-literal member targets are **not renameable** (an `address` failure);
computed member names and static blocks have no name-addressable declaration to
rename. A same-file rename of an ordinary binding, namespace, class, enum,
interface, type alias, enum member, class field/method, or interface/type-literal
member is supported. A rename is still not a cross-file/type-checker rename.

A rename failure (unresolved or ambiguous address, invalid new name, or a
collision at the same scope/qualified path) is reported at the `address` stage
and discards the entire reply. A rename mixed with other editor or file
commands applies all regions or none, through the same atomic apply pipeline.

### Grammar

ISO/IEC 14977 EBNF (originally drafted in `human/edit.md`):

```ebnf
edit-reply   = { statement } ;

statement    = select-clause | file-select-clause | file-command ;

file-command = 'create', path, 'end'
             | 'create', [ 'static' ], create-kind, create-name, 'in', path,
               [ 'with' ], fence, 'end'
             | 'create', module-kind, 'in', path, [ 'with' ], fence, 'end'
             | 'delete', path, 'end'
             | 'read', path, [ 'within', selecters ], 'end'
             | 'write', path, [ 'within', selecters ], 'with', fence
             (* sentinel close terminates; no trailing 'end' *) ;

create-kind  = declaration-kind | member-kind ;
declaration-kind = 'function' | 'class' | 'interface' | 'type' | 'enum'
                 | 'namespace' | 'const' | 'let' | 'var' | 'using' ;
member-kind  = 'method' | 'property' | 'getter' | 'setter'
             | 'accessor' | 'constructor' | 'enum-member' ;
module-kind  = 'import' | 'export' ;
create-name  = symbol | dotted-symbol | owner ;  (* constructor names only its owner *)

select-clause = 'select', [ kind ], symbol, 'in', path,
                [ 'resolve', space ],
                [ 'within', selecters ],
                [ 'match', ( snippet | regex ) ],
                [ replacer | renamer ],
                'end' ;

file-select-clause = 'select', 'file', path,
                     [ 'match', ( snippet | regex ) ],
                     [ 'pick', selecters ],
                     'replace', 'with', fence, 'end' ;
                     (* editor only: no viewer, resolve, within, or rename *)

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
dotted-symbol = symbol, '.', symbol, { '.', symbol } ;
owner        = symbol, { '.', symbol } ;
identifier   = ? TypeScript identifier ? ;
snippet      = ? '`' , verbatim source, '`' ; only \` and \\ are escapes ? ;
regex        = ? '/' , ECMA-262 pattern, no flags, '/' ? ;
fence        = ? a line exactly <<<TC_EDIT_BEGIN>>>, or an opener at the end
                 of the `with` line, then raw body lines, then a line exactly
                 <<<TC_EDIT_END>>>; each marker may have leading or trailing
                 whitespace; the first exact close line terminates and nothing
                 may follow it on that line (a later statement may start on the
                 next line); the body may be empty ? ;
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

### Self-check control turn

After pinning, the edit-dsl loop recognizes one additional reply shape before
the `multiEditor` parser:

```text
control-turn = 'check' 'end' | 'test' 'end' ;
```

It must be the whole reply: no arguments, edit, read, select, JSON, or prose.
`check end` runs the configured check command (default `bunx tsc --noEmit`);
`test end` runs the configured test command (default `bun test`). The command
result is bounded and returned in the next prompt; the control turn writes
nothing. It is repeatable, with no fixed self-check count: the USD cost budget and
the repeated/no-progress policy are the bounds. The final edit still passes the
ordinary automatic verification and judge.

### Declaration and member create

`create <kind> <name> in <path> with <fence> end` is the precise create form.
The kind token and the `in` header dispatch it; without `in`, the token is a
path and the statement is the empty-file command. `with` is the canonical
spelling but may be omitted, with the fence following the header directly. The
admitted kinds are:

| Owner     | Kinds                                                                                         |
| --------- | --------------------------------------------------------------------------------------------- |
| top level | `function`, `class`, `interface`, `type`, `enum`, `namespace`, `const`, `let`, `var`, `using` |
| class     | `method`, `property`, `getter`, `setter`, `accessor`, `constructor`                           |
| interface | `method`, `property`                                                                          |
| namespace | the top-level declaration kinds with a dotted owner                                           |
| enum      | `enum-member`                                                                                 |

A member address is dotted (`Parser.parseValue`, `Cell.value`,
`Util.helper`); `constructor` names only its owner (`create constructor Parser
in …`). `method` and `property` may target a class or an interface; `getter`,
`setter`, `accessor`, and `constructor` require a class; `enum-member` requires
an enum; a declaration kind with a dotted name requires a namespace owner.
`accessor` accepts a getter or a setter in the fence; a getter/setter pair is
the one legal same-name member pair. Optional `static` is admitted only before
a class member kind and must match the fence member's own `static` exactly. A
static descriptor on an interface method/property, enum member, namespace
declaration, or constructor is rejected; only class methods, properties,
getters, setters, and accessors can be static.

The fence is validated before anything is written:

- A top-level create must contain exactly one top-level declaration with the
  descriptor's name and kind, occupying a compatible TypeScript symbol space.
  A body-only fence is wrapped only for `const`, `let`, `var`, and `using`
  (`const NAME = <body>;` and so on); every other top-level kind requires the
  complete declaration.
- A member create parses the fence in a synthetic owner wrapper and requires
  exactly one member or declaration with the requested name and actual kind.
  The owner must resolve to exactly one existing class, interface, namespace,
  or enum. A missing owner, a merged/ambiguous owner with candidates, or a
  wrong-kind owner is an `address` failure. A dotted create never creates its
  owner; create the top-level declaration in a separate statement.
- Modifiers carried by the fence (`export`, `default`, `declare`, `abstract`,
  `static`, `readonly`, access modifiers, `override`, `async`, generator) are
  validated against the descriptor and owner. A static/instance identity
  mismatch is rejected rather than silently accepted.
- A duplicate top-level name, a duplicate member name (respecting static vs
  instance and getter/setter identity), an unsafe path, a malformed fence, or
  an empty fence is a `stage: address` or `stage: duplicate` failure and writes
  nothing. Each `(path, symbol, kind)` is claimed once per reply.

The declaration is appended at the file's end (creating the file and parent
directories when absent); a member is inserted before the owner body's closing
brace, with indentation the formatter normalizes. Both forms then go through
the same parse gate, duplicate guard, formatter, write, and node gate as any
other edit. Several creates for distinct declarations may share a reply;
same-file creates and edits apply atomically. Anonymous call/construct/index
signature create and object-literal member create are out of scope.

### Module-boundary create

`create import in <path> with <fence> end` and
`create export in <path> with <fence> end` add one module statement without a
synthetic declaration name. The fence must parse as exactly one matching
statement:

- `import` accepts an `ImportDeclaration` (named, default, namespace, type-only,
  side-effect, or combined forms the parser supports) and `import =`; an
  `export` fence is rejected.
- `export` accepts `ExportNamedDeclaration` (with or without a declaration or a
  `from` source), `ExportDefaultDeclaration`, `ExportAllDeclaration`, and
  `ExportAssignment`; an `import` fence is rejected.

The statement is inserted at the module boundary: after a shebang, leading
string directives, and the contiguous existing import block, and before other
code. That keeps imports together and puts a new export above executable code.
The insertion, create file, and parent directories go through the same atomic
parse/format/write/gate path as every other edit.

A malformed, empty, or multi-statement fence, a wrong-kind fence, an unsafe
path, and a statement the parser cannot represent are `address` failures.
An identical existing statement, a repeated import binding name, a second
default export, or a second `export =` is a `duplicate` failure. A module create
may share a file with a declaration create or a declaration edit, but not with a
file-level `select`, a whole-file `write`, a `delete`, or an empty-file `create`
on the same path in one reply.

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
  (there is no escape for a body containing the close marker). An opener sharing
  the `with` line is recovered with an `EDIT_INLINE_FENCE_OPEN` warning; it is
  not a rejection.
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
`MATCHER_MISSING`, `FILE_RENAME_UNSUPPORTED`, `FILE_VIEWER_UNSUPPORTED`,
`PICK_WITHOUT_REPLACE`, `RENAME_MIXED`, `UNKNOWN_SPACE`, `TARGET_MISMATCH`,
`TRUNCATED`.

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

The reply grammar also admits four file-command families:

```text
create <path> end
create [static] <kind> <name> in <path> with
<<<TC_EDIT_BEGIN>>>
<declaration or member>
<<<TC_EDIT_END>>>
end
create import|export in <path> with
<<<TC_EDIT_BEGIN>>>
<module-boundary statement>
<<<TC_EDIT_END>>>
end

delete <path> end
read   <path> [ within <selecters> ] end
write  <path> [ within <selecters> ] with
<<<TC_EDIT_BEGIN>>>
<raw body>
<<<TC_EDIT_END>>>
```

- **`create <path> end`** creates an empty file. An existing path is an `address` failure; parent directories are created. It does not run the parse/format gate. A path literally named like a create kind (for example `create function end`) remains this empty-file form because it has no `in` header.
- **`create [static] <kind> <name> in <path> with <fence> end`** adds exactly one named declaration or member (§2.1). The descriptor is authoritative; a fence that declares a different name/kind, an invalid modifier, an unsafe path, or a duplicate name is rejected without writing.
- **`create import|export in <path> with <fence> end`** adds exactly one module-boundary statement (§2.1). The fence must parse as one matching import/export form; the statement is inserted after the shebang, directives, and existing imports. A wrong-kind, malformed, duplicate, or unsafe path is rejected without writing.
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
  sentinel close terminates the statement; no `end` follows. The opener may
  share the `with` line when it is the last token. The replacement goes through
  the same parse gate, duplicate guard, formatter, and no-op check as an editor
  region.

`within` uses the same 1-based, inclusive `selecters` syntax as `pick`
(`12`, `12:3`, `12:3-14`, `12:3-14:5`, or a `{…}` set). Multiple selecters are
separate regions and must not overlap. A reply may mix select clauses and file
commands after the first target is pinned; the first reply is either exactly one
select clause or file commands, not both. The editing statements apply
atomically; a failed `read`, which writes nothing, is feedback rather than a
rejection. Two creates that append at the same offset are applied in statement
order; two creates of the same declaration still fail at the duplicate guard.
Same-owner member creates insert in statement order. Create or delete a path at
most once per reply; a create/delete combined with a write or select clause on
that path is a path-conflict rejection (a declaration create may share a file
with an edit of a different declaration, but not with a whole-file `write`, a
`delete`, or an empty-file `create`).

**One target per reply.** Every select clause in one reply — viewer, editor, or
rename — plus every create (implicit or explicit) must resolve to a distinct
`(path, symbol, kind)`. `resolve`, `match`, and `pick` do not make a new target.
A file-level select claims the file's module-boundary owner once per reply; a
module create is unique by `(path, statement text)`. A repeat fails at
`stage: duplicate` before any matcher or write runs, naming both statement
numbers and the resolved address; the whole reply writes nothing. Split edits to
one declaration across exchanges.

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

A kind-aware create adds one top-level declaration or one member of an existing
owner:

```text
create function parseJson in src/json.ts with
<<<TC_EDIT_BEGIN>>>
export function parseJson(text: string): unknown {
  return JSON.parse(text);
}
<<<TC_EDIT_END>>>
end

create static method Parser.parse in src/parser.ts with
<<<TC_EDIT_BEGIN>>>
static parse(text: string): Parser {
  return new Parser(text);
}
<<<TC_EDIT_END>>>
end
```

A file-level select edits one import/export statement or specifier; a module
create adds one statement at the module boundary:

```text
select file src/parser.ts
match `import { trim } from "./strings";`
replace with
<<<TC_EDIT_BEGIN>>>
import { trimEnd } from "./strings";
<<<TC_EDIT_END>>>
end

create import in src/parser.ts with
<<<TC_EDIT_BEGIN>>>
import type { ParserOptions } from "./options";
<<<TC_EDIT_END>>>
end
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

The edit-dsl reply reduces to the same narrowing, one stage at a time.

1. **Address.** `select` must land on exactly one declaration. The optional
   `resolve value|type|namespace` filters the index to that TypeScript symbol
   space; an omitted space accepts every space, and an empty `kind` is a path +
   name wildcard. A `class` or `enum` occupies both the value and type spaces (its
   declaration kind is authoritative); a function or variable occupies value,
   an interface or type alias occupies type, and a namespace declaration
   occupies the namespace space. A space miss names the available spaces and
   never falls back to another one. Dotted member addresses follow the rules above (`Cell.getValue`,
   `Color.Red`, `config.timeout`, a named default export's name). Overloaded,
   merged, or duplicate declarations stay separate candidates; an address
   matching more than one is rejected with every candidate named.
   Re-pinning is expressed by naming a different declaration in the clause's own
   `select`; the new address faces the same unique-resolution rule against the
   current source.
2. **Match.** The locator matches _inside_ the declaration's span only.
   - A **snippet** is parsed as TypeScript and compared **structurally**: its
     AST must equal a candidate's AST, ignoring spans, raw text, and trivia. The
     owner-context wrappers are tried in priority order: a top-level statement,
     a class-body member, an interface/type-literal member, an object-literal
     member, a function-body statement, a loop body, a switch case, a generator
     body, an async body, a type expression, an expression, and finally a
     contiguous run of two or more top-level statements against consecutive
     sibling slots. Each successful single-node wrapper is a candidate; a run
     becomes one span covering it. Identical AST nodes reached through more than
     one wrapper or more than one object field are deduplicated by source span,
     so a shorthand destructuring identifier is one candidate, not an ambiguity.
     The first context (in that order) with at least one match supplies the
     candidate set; every match in that context is kept. `findMatcherMatches`
     never silently returns the first of several matches.
   - A **regex** compiles with the `g` and `m` flags and **no user-supplied
     flags**. `m` anchors `^` and `$` at line boundaries _inside the
     declaration_; `.` does not cross newlines (there is no `s`). Only fully
     contained matches count, and a zero-width match is a valid insertion-point
     span.

   **Owner-context matrix.** These wrappers are syntactic owner contexts, not
   semantic validation; the parser is permissive, so several wrappers may yield
   the same node kind. The matrix records what each wrapper can reach:

   | Owner context            | Wrapper                                     | Typical forms                                                                               |
   | ------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
   | top-level statement      | the fragment as a program                   | function, `const`/`let`/`var`, class, interface, type alias, enum, namespace, import/export |
   | class member             | `class __Matcher { <fragment> }`            | method, property, getter, setter, constructor, decorated member, static block               |
   | interface/type member    | `interface __Matcher { <fragment> }`        | interface and type-literal methods/properties, call/construct/index signatures              |
   | object-literal member    | `const __matcher = { <fragment> };`         | property, method, getter/setter                                                             |
   | function-body statement  | `function __matcher() { <fragment> }`       | `return`, `throw`, `if`, `for`, `while`, `try`, local declarations                          |
   | loop body                | `while (true) { <fragment> }`               | standalone `break`/`continue`                                                               |
   | switch case              | `switch (0) { case 0: <fragment> }`         | `break`/`continue` in a case                                                                |
   | generator body           | `function* __matcher() { <fragment> }`      | `yield`/`yield*`                                                                            |
   | async body               | `async function __matcher() { <fragment> }` | `await`                                                                                     |
   | type expression          | `type __Matcher = <fragment>;`              | union/intersection, type literal, type reference, function/constructor type                 |
   | expression               | `const __matcher = <fragment>;`             | a sub-expression                                                                            |
   | contiguous statement run | two or more top-level statements            | a run of consecutive sibling statements                                                     |

   **Decorators, static blocks, and computed names.** A decorated class or member
   is reachable as one class-member fragment that includes its decorators. A
   **standalone** `@decorator` is not an owner context: select its class/member
   owner and use a snippet that includes the member, or edit the decorator text
   with `/regex/` or `pick`. A static block is reached through the class-member
   wrapper (or an inner statement). Computed member names (`[expression]`) are
   not name-addressable, so select the owner and use `match`/`pick`/regex.
   Overload signatures, declaration merges, and duplicate declarations remain
   separate address candidates; an explicit `kind` disambiguates a cross-space
   merge, and an address that still matches more than one is rejected. A
   whole-symbol edit on a multi-declarator or destructuring binding is rejected
   because it would rewrite a sibling; a `match`/`pick` inside one binding is
   supported.

   **Ambiguity diagnostics.** A structural match with more than one span is
   `matcher-ambiguous` and lists up to eight candidates as `line:column` plus
   the copied source line, so the model can add a `pick` point/range or extend
   the snippet. It never picks the first. `/regex/` ambiguity uses the same
   candidate list while keeping its resolution behavior, and `pick` filtering
   runs before the ambiguity check; when the picked ranges still leave more than
   one candidate, the diagnostic says so. A viewer is the information-gathering
   exception: it returns every occurrence and writes nothing (§4).

   **Regex and `pick` are first-class fallbacks.** A structural success is not
   required. When no owner context parses the fragment, the failure is
   `matcher-unparseable` and names every attempted owner context (top-level
   statement, class member, interface/type member, object-literal member,
   function-body/loop/switch/generator/async body, type expression, expression,
   contiguous run) and points at `/regex/` or `pick`. An unsupported form is
   never silently skipped.

   **Corpus policy.** `src/matcher-corpus.test.ts` is the committed proof of
   declaration-level completeness. Its `FORMS` matrix lists every covered
   declaration/member/module form; each form has a success case through
   structural matching, `/regex/`, or `pick`, or an explicit expected-failure
   case. The matrix includes declaration/owner forms, object-literal methods and
   accessors, type-literal signatures, class index signatures and constructor
   parameter properties, `import = require`, the omitted-kind `using` address,
   and the explicit `using`-kind/auto-accessor rejections. Success cases run the
   real `parseMultiEditor` + `resolveMultiEditor` +
   `applyResolvedRegions`/`parseCheck` path and assert the applied source and a
   passing parse/format gate. Failure cases assert a clear diagnostic and no
   queued write (overloads/merges, computed names, decorators, and
   multi-declarator/destructuring whole-symbol edits). The corpus is
   self-contained and must not depend on `benchmark/fixtures` or `human/`; add a
   new form to the matrix only with its case.

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
   exactly one copy. A body-level target is never stripped. A whole-symbol
   target on a multi-declarator or destructuring binding is rejected before the
   splice because it would rewrite a sibling binding.

The policy is total, and nothing is guessed: exactly one candidate at the finest
supplied stage is the target, zero is `matcher-not-found`, and more than one is
`matcher-ambiguous` (after a `pick`, the diagnostic says the ranges still leave
more than one). Each applied clause records its stage (`whole-symbol`, `match`, or `pick`).

These guards run before any gate:

- **No-op, per region.** A replacement byte-identical to the text it replaces
  is a `no-op` failure. A reply whose only failures are `no-op` clauses keeps
  its other changes: when at least one resolved region, create, delete, or
  whole-file write still applies, the inert clause(s) are ignored and
  `ignored N inert edit-dsl clause(s) whose replacement was identical to the
  selected text; do not resend them` is surfaced as feedback and a run warning.
  A reply whose changes are all inert is a `no-op` rejection, and any
  non-`no-op` failure keeps the whole-reply rejection.
- **Regex bounds.** A pattern over 1024 characters, one that fails to compile,
  or one matching over 1000 times inside the declaration is `regex-invalid`, a
  `matcher`-stage cause. A single catastrophic-backtracking `exec` cannot be
  interrupted in-process, so the length cap plus the bounded target are the
  practical limit.
- **Snippet parse.** A snippet must parse even when it is structurally
  ambiguous; an unparseable fragment is `matcher-unparseable` with the parser's
  position and the attempted owner contexts, and points at `/regex/` or `pick`
  for a span no structural owner context can describe.

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

Every rejection carries a `stage:` tag and costs one exchange. The vocabulary is
shared by every reply path so metrics compare.

| Stage       | Cause                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `syntax`    | Edit-dsl only: the reply does not parse as a statement (`select … end` or a file command), including a fence or terminator error. |
| `protocol`  | The reply is not edit-dsl, including a JSON edit payload.                                                                         |
| `address`   | The address does not resolve uniquely.                                                                                            |
| `matcher`   | `matcher-unparseable`, `matcher-not-found`, `matcher-ambiguous`, or `regex-invalid`.                                              |
| `range`     | A `range`/`pick` that is out of bounds, empty, inverted, or outside the declaration.                                              |
| `no-op`     | The replacement equals the text it replaces; ignored when another clause in the reply applies, otherwise a rejection.             |
| `duplicate` | A repeated resolved target; a duplicate top-level declaration or create.                                                          |
| `gate`      | The file parsed before and does not parse after.                                                                                  |
| `format`    | oxfmt rejected the result, or the formatted source equals the pre-edit source.                                                    |

When an edit-dsl statement fails at any stage other than `no-op`, its
diagnostic names the statement, its position in the reply (`clause N of M`), its
locator and path, and states that the whole reply was discarded, so the model
must resend the full corrected reply. A `no-op` clause is the per-clause
exception above: it is reported and ignored only when another clause applies;
an all-inert reply still rejects. The `EDIT_*` parser codes are listed in §2;
the Plan DSL's `PLAN_*` codes are owned by [`plan-exec.md`](plan-exec.md) §5.3.
Retry policy around a rejection is owned by
[`feedback-loop.md`](feedback-loop.md).

## 6. Application and gating

Nothing is written until the candidate passes, in order: address resolution,
the **unique-target claim** (every `select`, `rename`, and implicit create in
one reply resolves to a distinct `(path, symbol, kind)`), matcher/range
resolution, then the splice, the **parse gate** (a file that parsed must still
parse), the **duplicate-declaration guard** (a top-level `function`, `class`, or
`type` name may not be added twice), the **formatter**, and the **post-format
no-op check** (a candidate that differs only by formatting is rejected as a
no-op). A failing gate writes nothing and reports its stage.

Edit-dsl replies are **atomic across the editing statements**. Every statement
resolves against its file's current source. Before any matcher runs, each
select clause (viewer, editor, or rename) and each implicit create claims its
resolved target; a repeated `(path, symbol, kind)` is a `stage: duplicate`
rejection that names both statements and the address and discards the reply.
If any editing statement fails resolution at a non-`no-op` stage, or the apply
pipeline reports any non-`no-op` guard/overlap failure, the whole reply is
discarded and nothing is written — no file, including creates, deletes, and
writes. A reply whose only failures are `no-op` clauses keeps its other
changes: when at least one region, create, delete, or write still applies, the
inert clause(s) are ignored (with a warning) and the rest write every resolved
region and file command. A reply whose changes are all inert is a `no-op`
rejection. Multiple creates that append at the same end offset are applied in
statement order; duplicate creates of the same declaration still fail at the
duplicate guard. A failed `read` is the one exception: it writes nothing by
construction, so its error rides the next prompt without discarding the other
statements. A mixed viewer+editor reply that fails writes nothing but still
carries the viewer feedback. A failing reply is a retry-driving rejection, and
the retry must carry the full corrected reply (there is no "already applied"
list).

A reply whose statements all fail writes nothing; one whose statements all apply
goes to verification. A failed verification does **not** roll back: the attempted
state stays on disk and its diagnostics open the next round (see
[`feedback-loop.md`](feedback-loop.md)).

**Implicit create (edit-dsl only).** Any editor select clause (a non-empty
`replace`) whose symbol is absent, or is declared only in another symbol space,
appends the fence body as a new top-level declaration, creating the file and its
parent directories as needed, spliced at the file's current end behind a
separating newline. `match` and `pick` do not change creation; they are ignored
when the symbol is missing. Viewers never create. The kind-aware
`create <kind> <name> in <path> with <fence> end` statement (§2.1) is the
precise form when the fence is not a complete declaration or when a member is
the target; the implicit path remains for a whole-declaration `select … replace`.

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
The edit-dsl path creates implicitly and deletes with an empty fence.

**Edit-dsl confirmation.** When an edit-dsl edit passes verification, the harness
sends one `# modified text` prompt containing the goal, the symbol index, and
the edited declaration with file-absolute line numbers. A reply that parses as
at least one editor select clause (a clause with `replace`) continues the
exchange loop and is applied without another model call; every other reply —
`Great! I resolve this problem!`, prose, a malformed clause, or a viewer —
confirms success and ends the run. If the verified edit consumed the last exchange of the round, an
editor reply still ends successfully rather than losing the verified state. The
confirmation itself records a `confirmed` row, not an applied or rejected
exchange.

## 7. Repair feedback

A rejection is never a give-up; it is a retry with better information. The next
prompt carries the stage-tagged diagnostic, and from the second consecutive
rejection of the same cause, an escalation. The corrections are:

- A `protocol` rejection re-teaches the `select … end` form.
- Edit-dsl edit retries and round continuations keep the select-first shape:
  `# Goal`, the select-line `# Symbol index`, and `# details` with the numbered
  current declaration. A rejected selection retry or selection continuation asks
  for exactly one `select … end` clause naming a symbol-index entry.
- A viewer's occurrences ride the next prompt as located candidates, so the
  model can disambiguate instead of guessing.

A viewer's candidates are placed beside the rejection text, keeping "what still
fails" apart from what the model can pick next.

## 8. Skeleton

The essential resolver, stripped of diagnostics and metric plumbing:

```ts
// One parsed select clause.
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
  independently-guarded splice with an offset delta (§6).
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
