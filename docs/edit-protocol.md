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

Implementation: `resolveEditRange` in `typescript-editor/src/range.ts`, the
clause grammar in `typescript-editor/src/selection.ts`, the cascade in
`typescript-editor/src/cascade.ts`, the reply resolver in
`typescript-editor/src/edit-dsl.ts`, structural/regex matching in
`typescript-editor/src/matcher.ts`, the splice and format gate in
`typescript-editor/src/editor.ts`.

## 2. The edit-dsl statement grammar

The edit-dsl is the default wire format. A reply is zero or more **statements**;
a statement is one **select clause** or one **file command**. A useful reply
carries at least one. There is no prose. A Markdown fence around the whole reply
is tolerated as a separate **outer wrapper** rule (below), not as part of
`<fence>`. The grammar is read by a hand-written recursive-descent reader
(`multiEditor` in `typescript-editor/src/selection.ts`) in which whitespace between tokens is
insignificant, except inside a `<fence>` body and a `/regex/`. The reader
accepts an empty reply as zero statements. Any malformed input throws a
`stage: syntax` diagnostic naming the offending field; the loop renders it with
the failing line, column, and a short excerpt so the retry can see exactly
where the reply stopped. A partial selection is never returned.

```text
select [kind] <symbol> in <path> [ resolve (value|type|namespace) ] [ within <selecters> ] [ match <snippet> | match /<regex>/ ] [ [ pick <selecters> ] replace with <fence> | end ]
select [kind] <symbol> in <path> [ resolve (value|type|namespace) ] pick (before|after) <matcher> replace with <fence>
select [kind] <symbol> in <path> [ resolve (value|type|namespace) ] rename <old> to <new> end
```

The file-level editor edits a unique span anywhere in the file:

```text
select file <path> [ match <snippet> | match /<regex>/ ] [ pick <selecters> ] replace with <fence>
select file <path> pick (before|after) <matcher> replace with <fence>
select file <path> [ match <snippet> | match /<regex>/ ] [ pick <selecters> ] end
```

The third form is the protocol renderer's missing-replacement shape; it
resolves to an `address` failure with the replacement hint rather than a
whole-file write. An insertion anchor always requires `replace`.

The block editor names a brace span by the marker ID printed by `tsed --unify`:

```text
select block <symbol-id>:<node-id> in <path> [ match <snippet> | match /<regex>/ ] [ pick <selecters> ] replace with <fence>
select block <symbol-id>:<node-id> in <path> pick (before|after) <matcher> replace with <fence>
select block <symbol-id>:<node-id> in <path> [ match <snippet> | match /<regex>/ ] [ pick <selecters> ] end
```

The third form is likewise an `address` failure with the replacement hint.
A declaration literally named `block` keeps the ordinary symbol form
(`select block in <path>`); a token after `block` that is not `in` starts the
block-select form.

A select clause is never a file command. A select clause with `replace` or
`rename` is an **editor**; with neither it is a **viewer**. `match` narrows a
viewer or replacement; it is not part of a rename, and `rename` also cannot
carry `within`.

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
- **`rev`**: optional, immediately after the path on a declaration, file-level,
  or block select. It is the 8-character lowercase hex token printed by a
  viewer or `read` header for the full file source. When present, it must match
  the source the resolver reads; a stale token fails at `stage: range` and
  writes nothing, naming the refreshed viewer/read workflow. Omitting `rev`
  preserves the old behavior. The token is an integrity check, not a lock:
  concurrent writers are out of scope.
- **`resolve`**: optional, after the path (`rev` when present). `resolve value`, `resolve type`, or
  `resolve namespace` filters the address to that TypeScript symbol space; it is
  the disambiguator when the same name is declared more than once. Omitted, any
  space is accepted.
- **`within`**: optional viewer-only slice, after `resolve`. It uses the same
  1-based inclusive file-absolute ranges as `read ... within`. The viewer returns
  exactly those lines from the declaration, unfolded. It cannot be combined with
  `match`, `pick`, a `pick before|after` anchor, `replace`, or `rename`;
  editors use `pick` for a narrowed rewrite.
- **`match`**: exactly one of two locators: `match` followed by a backtick
  snippet, or `match` followed by a slash regex. The prompt writes both forms
  without parentheses; a parenthesized matcher or unquoted code is not a
  matcher and reports `EDIT_MATCHER_MISSING`.
  - a `` `snippet` `` in backticks, where only `` \` `` and `\\` are escapes and
    every other backslash is literal;
  - a `/regex/` in slashes, where only a backslash-escaped slash decodes to `/`
    and every other backslash passes through to the engine.
- **`pick before <matcher>` / `pick after <matcher>`**: a **zero-width
  insertion** selector. `pick after \`return value;\``places the fence body
  immediately after the one unique occurrence of`return value;`inside the
  selected declaration, file, or block;`pick before`places it immediately
  before that occurrence. The snippet is matched **literally** — every
  occurrence wholly inside the owner span is a candidate, not a structural
  parse of the snippet. A`/regex/`anchor is accepted in the DSL and uses the
  same regex engine as`match`(the`g`and`m`flags, no user flags), including
  zero-width matches. Exactly one occurrence is required: zero is a`stage: matcher`not-found failure, and several is an ambiguity failure that
  lists each candidate's`path:line:column`; both write nothing. An anchor
  cannot be combined with `match`, a range `pick`, or `rename`, and it requires
  `replace`; an empty fence is a `no-op`failure. Because the anchor is a
  zero-width splice point, the existing formatter and parse gate still run, so
  an insertion that would break the file is rejected. Prefer an anchor over
  line/column`pick` for insertions that do not move existing text.
- **`pick <selecters>`**: a line/point/range selector, one range or a
  `{a, b, …}` set. `pick` requires a following
  `replace`; a clause that stops at `pick` is a syntax error, not a viewer
  (a braced set needs at least one range). With a `match`, a point selecter
  (`line:column`) picks the match candidates whose span **contains the point**,
  while a line or range selecter keeps the "candidate contained in the picked
  range" rule. Without a `match`, the pick is the target itself: a line selects
  the whole line, a point selects one character, and a range selects that text
  range. A pick-only `{a, b, …}` set is supported as separate regions: the same
  fence replacement is applied to every resolved range (all-or-none at
  resolution; overlapping ranges are a `stage: range` failure).
- **`replace with <fence>`**: the sentinel-only fence shared with the Plan DSL.
  The prompt teaches a line-sensitive layout: both markers occupy their own
  lines and the raw body starts on the next line. The parser's inline-opener
  and one-trailing-`end` forms are compatibility recovery only; prompts and
  examples never teach them.
  ([`plan-exec.md`](plan-exec.md) §3). `TC_EDIT_BEGIN` and
  `TC_EDIT_END` are exact whole lines, optionally indented or with
  trailing whitespace. The opener may share the `with` line when it is the last
  non-whitespace token; the raw body still starts on the next line. The body is
  raw, so hyphen runs, six-backtick runs, `done`, and `end` are ordinary body
  lines. Only an exact close-marker line closes the fence. Trailing text on the
  close-marker line is rejected, and a body cannot contain an exact close-marker
  line: the first exact line closes it and later content is rejected, with no
  escape form. An empty fence deletes the target.
- **`rename <old> to <new>`**: the other editor form. It rewrites the selected
  declaration name and every same-file reference that lexically resolves to it.
  When the selected declaration is top-level and the file exports it under the
  new public name, the edit also updates named imports and named re-exports in
  workspace files whose relative specifier resolves back to the file: unaliased
  imports rename the local binding and its uses, aliased imports update only the
  imported name, and re-export aliases keep their public name. Shadowed bindings
  and out-of-scope names are untouched; dotted targets rename the final segment
  for namespaces, enum members, and class fields (`this.field` plus same-class
  static accesses). A collision with an existing binding at the same scope or
  qualified path, or a duplicate public export name, is an `address` failure,
  and a rename cannot be combined with `match`, `pick`, a `pick before|after`
  anchor, or `replace`. A `match` on a rename is an `EDIT_RENAME_MATCHED`
  syntax error: remove the matcher, or use `pick … replace with …` for a
  matcher-scoped rewrite.
- **`end`** terminates a viewer or rename select clause. `create <path> end`,
  `delete <path> end`, and `read <path> end` use it too. A `replace with`,
  `create … with`, or `write … with` body ends at its `TC_EDIT_END` close, not
  at `end`; one trailing `end` after a body close is accepted only as a
  compatibility normalization.

A select clause with neither `replace` nor `rename` is a **viewer**: it locates
and writes nothing (§4). A select clause with `replace` is an editor (after
`pick` when present); `pick` requires `replace`. A `rename` is always an editor,
never a viewer. A `pick before|after` anchor is likewise always an editor and
requires `replace`.

A typical insertion:

```text
select function answer in src/helper.ts
pick after `return 1;`
replace with
TC_EDIT_BEGIN
  return 2;
TC_EDIT_END
```

The anchor resolves to the zero-width point immediately after `return 1;`, so
the fence body is spliced there. The body lands on the same line unless it
starts with a newline; write a leading newline when the insertion should occupy
its own line. The parse gate and formatter then validate the spliced file as
usual.

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

### Syntax-form design notes

The fence is a **control delimiter embedded in text that may itself be arbitrary
TypeScript**. A syntax form is not good because it is readable to a human or
valid in Markdown; it is good when the model copies it exactly, cannot confuse it
with a format it was trained to close or escape, and the parser can still reject
ambiguity.

`tc` uses bare line markers:

```text
TC_EDIT_BEGIN
... raw body ...
TC_EDIT_END
```

The markers are uppercase words with underscores, must be exactly one line
(leading/trailing whitespace allowed), and contain no `<`, `>`, backticks,
braces, brackets, quotes, or whitespace between words. The prompt shows this
canonical form and one counterexample; the body close is the only delimiter for
a code block. The old `<<<TC_EDIT_BEGIN>>>` / `<<<TC_EDIT_END>>>` form was
hard-switched away: it resembles too many control formats and produced repeated
fence/terminator errors in live runs.

#### Known conflict surfaces

| Form                           | Examples                                    | Why it is dangerous as a body delimiter                                                                                                         | Verdict                                                                        |
| ------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| XML / HTML / JSX tags          | `<edit>…</edit>`, `<tc:begin>`              | Models auto-close tags, nest them, or confuse them with UI/JSX; closing tags look like tool markup                                              | Avoid                                                                          |
| Tool-use / DSML special tokens | `<\|...\|>`, `<\|tool_call\|>`, `<｜...｜>` | These are control-token shapes, not ordinary text; tokenizers/servers may interpret or filter them, and models may emit them despite “no tools” | Never use as a literal fence                                                   |
| Markdown fences                | ` ``` `, `~~~`                              | The most overfit code format; bodies often contain backticks; models wrap replies unprompted; nesting is ambiguous                              | Use only as an explicitly tolerated outer wrapper, never as the body delimiter |
| JSON / JSON5                   | `{"body": "..."}`                           | Quotes and escaping multiply with real code; models overfit JSON and may truncate or “repair” it; a code body is not a string                   | Avoid for raw bodies                                                           |
| YAML                           | `body: &#124;` / indentation                | Indentation and `:` are both code and YAML; invisible whitespace errors are costly                                                              | Avoid                                                                          |
| Heredoc / shell                | `<<EOF`, `EOF`, `<<'EOF'`                   | Looks like shell; terminator is a short word that can occur in code; models may add shell semantics                                             | Avoid                                                                          |
| Merge-conflict / diff markers  | `<<<<<<<`, `=======`, `>>>>>>>`, `@@`       | Models see these in diffs and conflict resolution; confuses “ours/theirs” framing                                                               | Avoid                                                                          |
| Comment sentinels              | `// BEGIN`, `/* END */`, `# end`            | Comments are legal code and models may drop, normalize, or duplicate them; a comment line can occur in the body                                 | Avoid unless no punctuation-free marker is possible                            |
| String delimiters              | triple quotes, backticks, `"""`             | The body itself may contain the same delimiter; escaping/trimming rules become another failure mode                                             | Avoid                                                                          |
| Wiki/array brackets            | `[[BEGIN]]`, `[[END]]`                      | Looks like nested arrays or wiki links; model may balance brackets                                                                              | Avoid                                                                          |
| Template/percent markers       | `%%BEGIN%%`, `{{BEGIN}}`                    | Common templating syntax; models may substitute or escape                                                                                       | Avoid                                                                          |
| Markdown heading/rule markers  | `===`, `---`, `## BEGIN`                    | Common Markdown/setext/diff syntax; models may treat them as formatting                                                                         | Avoid                                                                          |
| Unicode box drawing / emoji    | `━━`, `🔒`, zero-width characters           | Tokenization/normalization varies; invisible characters are unreviewable                                                                        | Avoid                                                                          |
| Fixed random nonce             | `BEGIN_7F3A`                                | Safer against body collision, but adds a copy burden and a new failure mode: model copies the wrong nonce                                       | Optional hardening, not default                                                |
| Length-prefixed body           | `BEGIN 1234`                                | Unambiguous in principle, but models cannot reliably count characters                                                                           | Avoid in model-facing syntax                                                   |

#### Common design mistakes

1. **Assuming “common” means “easy for the model.”** Markdown, XML, JSON,
   YAML, and diff syntax are common because models were trained on them; a
   delimiter in one of those families invites completion/normalization rather
   than exact copying.
2. **Using code punctuation as a control boundary.** Backticks, quotes,
   brackets, braces, comments, and `end` are legal in the body; without an
   escape/nonce the first matching line becomes a semantic boundary.
3. **Confusing a tool call with text.** `<|...|>` and DSML shapes are not safe
   plain text; a model may emit them from training, and an API may treat them as
   control tokens. The protocol explicitly says “no tools,” but that does not
   make the tokens safe.
4. **Using paired nesting syntax.** XML/HTML/JSX and Markdown fences require
   matching open/close; models can mismatch, nest, or auto-close them.
5. **Two terminators for one statement.** A sentinel close plus a separate
   `end` gives the model two chances to terminate and two chances to disagree.
   For a code body, the close should be the terminator; only statements without
   a body need `end`.
6. **Depending on indentation or significant whitespace.** YAML-like and
   heredoc-like forms hide errors that are invisible in a diff.
7. **Making the delimiter a prefix of valid code.** A bare word can collide with
   an identifier; exact-line matching and uppercase underscores reduce this, but
   any fixed marker needs a collision policy.
8. **Adding a random nonce for every call.** It helps against collisions but
   makes copying harder; use it only when the body can contain the fixed marker.
9. **Making the parser permissive to hide syntax errors.** Recovery aliases are
   useful (for example one trailing `end` after a write close), but arbitrary
   trailing text makes the boundary meaningless.
10. **Testing readability instead of model behavior.** A human can read XML;
    that does not mean an LLM will copy it exactly. Measure protocol errors on
    actual model families.
11. **Not providing a canonical example and a counterexample.** The prompt
    should show the exact lines, not only describe them in prose.
12. **Using Unicode/invisible characters.** Tokenization and normalization can
    change them; diffs cannot reveal them reliably.

#### Rules for a new delimiter

- One short, stable, punctuation-free line marker; no Markdown/XML/JSON/tool
  special-token family.
- Exact whole-line match; trim only whitespace; no inline body.
- One terminator for a body; do not require a second `end` after it.
- Fixed marker by default; add a nonce/length only for a real collision problem.
- Canonical prompt example plus a “do not add `end` after the close” example.
- Explicit recovery policy: at most one compatibility alias, and a hard error
  for a second terminator or trailing text.
- Tests must include code containing the candidate marker, nested code, CRLF,
  leading indentation, and real model-family runs.

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
`typescript-editor/src/matcher-corpus.test.ts`; its `FORMS` list is authoritative, and a row marked
**expected failure** is a deliberate unsupported or ambiguous case rather than a
missing feature. In the selector column, **whole-symbol** means no `match` and no
`pick` (the indexed declaration span), **`match`** is the structural snippet,
**`/regex/`** is the regex locator, and **`pick`** is a line/point/range
selector. **Owner + selector** means select the class/interface/type-alias/
object/enum owner first; **rejected-with-candidates** means the address or
matcher fails and names every candidate, never the first. Every selector path
that lists `pick` also accepts `pick before|after <matcher>` for a zero-width
insertion of a `replace` fence (the anchor form requires `replace`).

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

### File-level span select

`select file <path> … replace with <fence>` edits any unique span in a file
without a synthetic declaration name. The owner is the file source; no
symbol-index entry is resolved. The path must be safe, inside the workspace, and
an existing regular file. The span may be inside an import/export statement, a
function body, a test callback, an object literal, or a template-literal body;
`create import|export` remains module-boundary-only.

- `match` (a structural snippet or `/regex/`) or `pick` locates the target.
- `pick before|after <matcher>` is the insertion form: the literal snippet (or
  a `/regex/` in the DSL) must occur exactly once in the file, and the fence
  body is spliced immediately before/after that occurrence. It cannot be
  combined with `match` or a range `pick`, and it requires `replace`; an empty
  fence is a `no-op` failure.
- `rev <token>` is the optional freshness guard from a viewer/read header,
  placed after the path and before `match`/`pick`.
  A snippet that is not valid TypeScript on its own (for example an incomplete
  block header such as `if (value === 1) {`) is treated as an exact literal
  source span. A candidate is labelled with its module statement kind when it
  lies inside an import/export statement, and as declaration/other source
  otherwise.
- Exactly one candidate is required. Multiple candidates are rejected with each
  `path:line:column` and its statement/declaration label; the harness never
  picks the first. A `pick` with a `match` filters candidates with the normal
  point/contained rules; without a `match`, the one resolved pick range is the
  target. File-level `pick` coordinates are the same 1-based, inclusive,
  file-absolute coordinates as the numbered source block. A file-level range is
  bounded by the file, and a declaration range is additionally bounded by the
  declaration span; neither depends on the total file size. Prompt source blocks
  are folded, not truncated, and fold markers keep file-absolute line numbers.
- `replace with <fence>` rewrites the matched/picked span. An empty fence
  deletes it: when the span is an import/export statement, deletion removes its
  line; when it is a named specifier, deletion also removes its `,` separator.
  Outside a module statement an empty fence deletes exactly the matched or
  picked span, with no line expansion. The parse gate, formatter, duplicate
  guard, atomic apply, and task/node gate are unchanged.
- A file-level select is an **editor only** and requires `replace` at
  resolution. The DSL reader accepts the no-replacement shape so the native
  `--select-file` form can report an `address` failure with the
  `--replace-file` hint instead of a usage error. `resolve`, `within`, and
  rename are rejected. Use `read <path> end` to view file lines, or
  `write <path> with <fence>` for a deliberate whole-file rewrite. A file-level
  `rename` is not supported because a unique text span has no declaration
  address; edit the span text instead rather than silently renaming a symbol.

### Block markers and block select

`tsed --unify <path>` is a read-only CLI viewer, not an edit-dsl statement. It
prints the numbered source with ` // <symbol-id>:<node-id>` appended to the
opening line of each qualifying `BlockStatement`; it never writes, and it
rejects `--write`, `--dry-run`, non-default `--protocol-format`, and every
operation flag as a usage error. Output keeps 1-based, file-absolute line numbers and the source
line count. A block qualifies when its inclusive span satisfies
`endLine - startLine + 1 >= 8`; `--unify-min-lines <N>` replaces the threshold,
where `0` marks every block. A marker is appended after an existing line
comment, so the annotated view stays syntactically valid.

- The symbol ID is the nearest enclosing indexed declaration address
  (`Parser.parse`), or `<module>` when no declaration contains the block. The
  node ID is the block's 1-based preorder index among `BlockStatement` nodes
  grouped under that symbol. IDs are recomputed from the current AST whenever
  the viewer or resolver runs, so they are never persisted or stale. When two
  declarations share a display name, the symbol ID is suffixed with the
  declaration's start line (and column if needed) to stay unique.
- `select block <symbol-id>:<node-id> in <path> …` resolves that block's half-open
  brace span (`{` through `}` inclusive). An optional `rev <token>` after the
  path guards those coordinates like every other select. `match` (structural snippet or
  `/regex/`) narrows structurally inside the span, and `pick` narrows by
  1-based file-absolute coordinates; with both, the match candidates are
  filtered by the pick. `pick before|after <matcher>` instead splices at the
  unique literal (or `/regex/`) occurrence inside the block; it cannot combine
  with `match` or a range `pick`, and it requires `replace`. The block span is
  the whole target when neither is present. Exactly one candidate is required;
  `address` reports an unknown or ambiguous ID with the available markers, and
  `matcher` reports zero, ambiguous, or non-intersecting candidates.
- A block select is an **editor only** and needs `replace with <fence>`; the
  DSL reader accepts the `end` shape so resolution can report the missing
  replacement. An empty fence deletes exactly the resolved span. `resolve`,
  `within`, and `rename` are rejected. A repeated block target in one reply is
  a `duplicate`.
- The declaration named `block` is not shadowed: `select block in <path>` still
  resolves the symbol, because only a non-`in` token after `block` enters the
  block grammar.

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

For a top-level declaration the file exports under the renamed name, the rename
also reaches workspace files: every named import and named re-export whose
relative or tsconfig-`paths` aliased specifier resolves to the declaration,
directly or through a named/`export *` re-export chain, is updated atomically
with the declaration. The workspace root `tsconfig.json` `baseUrl`/`paths`
mapping is read once per rename, following local relative `extends` entries (a
string or an array; later parents and the child override earlier values). A
declared `baseUrl` is relative to its config file, inherited `paths` use the
effective `baseUrl`, and package-name `extends` entries are skipped. A
re-export chain is followed cycle-safely and only when the renamed name is
actually visible through it. An unaliased import renames its local binding and
same-file uses;
an aliased import changes only the imported name; a re-export changes the
source-side name and preserves its alias, so an aliased public name stays
stable. A namespace import (`import * as ns from "@/b"`) and a direct
`import lib = require("@/b")` also contribute static member accesses
(`ns.member`, `ns?.member`, `ns["member"]`, `ns?.["member"]`, `lib["member"]`)
and static object-destructuring keys (`const { helper } = ns`,
`const { helper: local } = ns`, `const { ["helper"]: local } = ns`);
only the member property is renamed (a static string key keeps its original
quote, and a shorthand destructuring key expands to `helper2: helper` so the
local binding and its uses stay stable), a static key naming another property is
left untouched, and a base that resolves to a shadowing local or parameter is
skipped. Dynamic computed access (`ns[key]`, `ns["member" + suffix]`, template
literals or string keys with escapes), escaped member spellings, dynamic
computed destructuring keys, rest properties, destructuring string keys with
escapes, and non-direct `import =` shapes fail at `address` instead of leaving a
stale reference; a destructuring without a matching key or an unsupported
dynamic/rest property, or an `import =` edge that does not mention the renamed
member, stays untouched. An ambiguous alias, an unresolved relative/alias barrel
edge, and conflicting `export *` sources that could hide the renamed name fail
at `address` with the file and specifier.

Object-literal member targets are **not renameable** (an `address` failure);
computed member names and static blocks have no name-addressable declaration to
rename. A same-file rename of an ordinary binding, namespace, class, enum,
interface, type alias, enum member, class field/method, or interface/type-literal
member is supported. A cross-file rename follows relative and tsconfig-`paths`
aliased named import/re-export edges plus named and `export *` re-export chains,
namespace-import member accesses, and direct `import = require` member accesses;
it does not follow default or dynamic imports, dynamic member access,
`export * as ns` member propagation, or non-direct `import =` shapes. The target
must be an unqualified top-level declaration whose export name changes; nested
and alias-only exports stay same-file. A rename is not a full type-checker
rename.

A rename failure (unresolved or ambiguous address, invalid new name, or a
collision at the same scope/qualified path) is reported at the `address` stage
and discards the entire reply. A rename mixed with other editor or file
commands applies all regions or none, through the same atomic apply pipeline.

### Grammar

ISO/IEC 14977 EBNF (originally drafted in `human/edit.md`):

```ebnf
edit-reply   = { statement } ;

statement    = select-clause | file-select-clause | block-select-clause | file-command ;

file-command = 'create', path, 'end'
             | 'create', [ 'static' ], create-kind, create-name, 'in', path,
               [ 'with' ], fence
             | 'create', module-kind, 'in', path, [ 'with' ], fence
             | 'delete', path, 'end'
             | 'read', path, [ 'within', selecters ], 'end'
             | 'write', path, [ 'within', selecters ], 'with', fence
             (* body commands: the sentinel close terminates; no trailing 'end' *) ;

create-kind  = declaration-kind | member-kind ;
declaration-kind = 'function' | 'class' | 'interface' | 'type' | 'enum'
                 | 'namespace' | 'const' | 'let' | 'var' | 'using' ;
member-kind  = 'method' | 'property' | 'getter' | 'setter'
             | 'accessor' | 'constructor' | 'enum-member' ;
module-kind  = 'import' | 'export' ;
create-name  = symbol | dotted-symbol | owner ;  (* constructor names only its owner *)

select-clause = 'select', [ kind ], symbol, 'in', path,
                [ 'rev', revision ],
                [ 'resolve', space ],
                [ 'within', selecters ],
                [ 'match', ( snippet | regex ) ],
                select-tail ;

select-tail  = replacer | renamer | 'end' ;

file-select-clause = 'select', 'file', path,
                     [ 'rev', revision ],
                     ( [ 'match', ( snippet | regex ) ],
                       [ 'pick', selecters ],
                       ( 'replace', 'with', fence | 'end' )
                     | 'pick', anchor-side, ( snippet | regex ),
                       'replace', 'with', fence ) ;
                     (* the end form is accepted so resolution can report the
                        missing replacement; validate it as an address failure.
                        The anchor form always requires 'replace'. *)

block-select-clause = 'select', 'block', block-id, 'in', path,
                      [ 'rev', revision ],
                      ( [ 'match', ( snippet | regex ) ],
                        [ 'pick', selecters ],
                        ( 'replace', 'with', fence | 'end' )
                      | 'pick', anchor-side, ( snippet | regex ),
                        'replace', 'with', fence ) ;
                      (* the end form is an address failure, like file-select;
                         `select block in path` stays the symbol form *)

replacer     = [ 'pick', selecters ], 'replace', 'with', fence
             | 'pick', anchor-side, ( snippet | regex ), 'replace', 'with', fence ;
             (* the anchor form rejects a preceding 'match' or rename *)
anchor-side  = 'before' | 'after' ;
renamer      = 'rename', identifier, 'to', identifier, 'end' ;

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
revision     = ? exactly 8 lowercase hexadecimal characters, as printed by
                 a viewer or read header, e.g. 1a2b3c4d ? ;
symbol       = ? declared identifier ? ;
block-id     = ? '<symbol-id>:<positive node id>' printed by `tsed --unify` ? ;
dotted-symbol = symbol, '.', symbol, { '.', symbol } ;
owner        = symbol, { '.', symbol } ;
identifier   = ? TypeScript identifier ? ;
snippet      = ? '`' , verbatim source, '`' ; only \` and \\ are escapes ? ;
regex        = ? '/' , ECMA-262 pattern, no flags, '/' ? ;
fence        = ? a line exactly TC_EDIT_BEGIN, or an opener at the end
                 of the `with` line, then raw body lines, then a line exactly
                 TC_EDIT_END; each marker may have leading or trailing
                 whitespace; the first exact close line terminates and nothing
                 may follow it on that line (a later statement may start on the
                 next line); the body may be empty ? ;
```

A select clause is never a file command. A coordinate is digits only: `0`
parses as a `line`/`column` but is rejected as not positive, and `selecters`
braces cannot be empty. `end` is required by the grammar for a viewer or rename select clause,
for a file-level or block-level select without a replacement (an `address`
failure at resolution), and for `create <path> end`, `delete`, and `read`. For those forms,
the tolerant reader may warn `EDIT_MISSING_END` and recover at EOF or before an
unambiguous next statement (`select`, `create`, `delete`, `read`, or `write`);
arbitrary following text is a hard error. A `select … replace with`, `create … with`, or
`write … with` has no `end` in the canonical grammar: its `TC_EDIT_END` close
terminates it. One trailing `end` after any body close is accepted as a
compatibility normalization; a second one is an error. Prompts and examples
always emit the canonical form; the compatibility form is not taught.

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

`create <kind> <name> in <path> with <fence>` is the precise create form.
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
  nothing. Each `(path, symbol, kind)` is claimed once per reply except for
  pairwise-disjoint `match`/`pick` editor regions (see the target rule below).

The declaration is appended at the file's end (creating the file and parent
directories when absent); a member is inserted before the owner body's closing
brace, with indentation the formatter normalizes. Both forms then go through
the same parse gate, duplicate guard, formatter, write, and node gate as any
other edit. Several creates for distinct declarations may share a reply;
same-file creates and edits apply atomically. Anonymous call/construct/index
signature create and object-literal member create are out of scope.

### Module-boundary create

`create import in <path> with <fence>` and
`create export in <path> with <fence>` add one module statement without a
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
[`plan-exec.md`](plan-exec.md) §4.2: recover structure to diagnose, never apply
a partial destructive result. In particular:

- Clause splitting recognizes `select` … `end` and respects sentinel bodies, so
  `select` inside a replacement body is not a boundary.
- A missing `end` after a viewer/rename select clause or a bodyless
  `create`/`delete`/`read` is recovered with an `EDIT_MISSING_END` warning at EOF
  or before an unambiguous next statement (`select`, `create`, `delete`, `read`,
  or `write`); the reply is not rejected solely for this. Arbitrary following
  text is a hard `EDIT_MISSING_END`. A `select … replace with`, `create … with`,
  or `write … with` has no `end` to recover: the sentinel close terminates it.
  A truncated fence or mid-clause EOF still rejects.
- Legacy hyphen/backtick fences report `EDIT_LEGACY_FENCE`; a misplaced or
  malformed sentinel reports `EDIT_MALFORMED_FENCE`, trailing text on a
  close-marker line reports `EDIT_FENCE_TRAILING_TEXT`, and content after a
  closed fence that is not a new statement reports `EDIT_EMBEDDED_FENCE_END`
  (there is no escape for a body containing the close marker). An opener sharing
  the `with` line is recovered with an `EDIT_INLINE_FENCE_OPEN` warning; it is
  not a rejection.
- The retired `done` terminator reports `EDIT_RETIRED_DONE`; one trailing `end`
  after a `write` close is accepted as compatibility, and a second one is an
  error.
- `match` without a snippet/regex reports `EDIT_MATCHER_MISSING` with the
  accepted forms and an example. A missing `pick before`/`pick after` matcher
  reports the same code and names the anchor form.
- `pick` without `replace`, `rename` mixed with `replace`, unknown `resolve`
  space, and a malformed fence each get a dedicated code and a one-line hint.
  An insertion anchor reports `EDIT_ANCHOR_MATCHED`,
  `EDIT_ANCHOR_PICK_MIXED`, `EDIT_ANCHOR_RENAME_MIXED`, or
  `EDIT_ANCHOR_WITHOUT_REPLACE` for its forbidden combinations.
- Multiple statements are all parsed before any application. One bad editor
  statement rejects all writes; good view-only statements may still return
  feedback.

Shipped `EDIT_*` error codes: `MISSING_END`, `MISSING_FIELD`, `UNKNOWN_FIELD`,
`UNCLOSED_FENCE`, `WHOLE_REPLY_FENCE`, `MALFORMED_FENCE`, `LEGACY_FENCE`,
`FENCE_TRAILING_TEXT`, `EMBEDDED_FENCE_END`, `RETIRED_DONE`, `STRAY_END`,
`MATCHER_MISSING`, `FILE_RENAME_UNSUPPORTED`, `FILE_VIEWER_UNSUPPORTED`,
`PICK_WITHOUT_REPLACE`, `RENAME_MIXED`, `UNKNOWN_SPACE`, `TARGET_MISMATCH`,
`ANCHOR_MATCHED`, `ANCHOR_PICK_MIXED`, `ANCHOR_RENAME_MIXED`,
`ANCHOR_WITHOUT_REPLACE`, `TRUNCATED`.

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
TC_EDIT_BEGIN
<declaration or member>
TC_EDIT_END
create import|export in <path> with
TC_EDIT_BEGIN
<module-boundary statement>
TC_EDIT_END

delete <path> end
read   <path> [ within <selecters> ] end
write  <path> [ within <selecters> ] with
TC_EDIT_BEGIN
<raw body>
TC_EDIT_END
```

- **`create … with`** bodies end at the `TC_EDIT_END` close; no `end` follows. **`create <path> end`** creates an empty file; use `write <path> with <fence>` for file content. An existing path is an `address` failure; parent directories are created. It does not run the parse/format gate. A path literally named like a create kind (for example `create function end`) remains this empty-file form because it has no `in` header.
- **`create [static] <kind> <name> in <path> with <fence>`** adds exactly one named declaration or member (§2.1). The descriptor is authoritative; a fence that declares a different name/kind, an invalid modifier, an unsafe path, or a duplicate name is rejected without writing.
- **`create import|export in <path> with <fence>`** adds exactly one module-boundary statement (§2.1). The fence must parse as one matching import/export form; the statement is inserted after the shebang, directives, and existing imports. A wrong-kind, malformed, duplicate, or unsafe path is rejected without writing.
- **`delete`** removes an existing regular file inside the workspace. A missing
  path is an `address` failure; directories and paths outside the workspace are
  rejected. `human/` is read-only for agents.
- **`read`** is a viewer: it returns the file (or the selected lines) and writes
  nothing. A missing path is an `address` failure. A `read` always sees the
  source as it was before the current reply, even when the same reply also
  writes that file. A failed `read` reports its error as feedback and does not
  discard the reply's editing statements. Its block header prints
  `rev <token>` for the full file source, so a following clause can quote it. A
  whole-file result is folded (§4):
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

**One target per reply, except disjoint editor regions.** Every select clause in
one reply — viewer, editor, or rename — plus every create (implicit or explicit)
must resolve to a distinct `(path, symbol, kind)`. `resolve`, `match`, and `pick`
do not make a new target. The exception is multiple `match`/`pick` editor clauses
on one declaration, and multiple file-level editor clauses on one file: they may
share the target only when every resolved region is pairwise disjoint. Regions
are half-open spans; two ordinary spans overlap when they intersect, two
zero-width insertions overlap only at the same offset, and a zero-width insertion
at a non-zero span's boundary is disjoint. An overlap, a duplicate resolved span,
a viewer+editor, a rename+editor, a whole-symbol+partial mix, or a file-level
hard/partial mix fails at `stage: duplicate` before any write, naming both
statement numbers and the resolved address or file path; nothing from the
rejected clause is queued and the whole reply writes nothing. A file-level
viewer (a `select file` without `replace`) and any file-level clause without a
`match`/`pick`/anchor is a hard claim; a module create is unique by `(path,
statement text)`. Split conflicting edits to one declaration or file across
exchanges.

Canonical examples:

A viewer for one declaration and an editor for another in one reply:

```text
select function answer in src/helper.ts
end

select function parse in src/helper.ts
match `return input;`
replace with
TC_EDIT_BEGIN
return input.trim();
TC_EDIT_END
```

Two disjoint editors on one declaration in one reply:

```text
select function answer in src/helper.ts
match `const value = 1;`
replace with
TC_EDIT_BEGIN
const value = 2;
TC_EDIT_END

select function answer in src/helper.ts
match `return value;`
replace with
TC_EDIT_BEGIN
return value + 1;
TC_EDIT_END
```

The resolved spans are disjoint, so both edits apply atomically. An overlapping
span, a repeated resolved span, a second whole-declaration edit, or a
viewer/rename on the same declaration still fails at `stage: duplicate`.

Two disjoint file-level editors on one file in one reply:

```text
select file src/reader.ts
match `type Datum =`
replace with
TC_EDIT_BEGIN
export type Datum =
TC_EDIT_END

select file src/reader.ts
match `const MAX_DEPTH = 100;`
replace with
TC_EDIT_BEGIN
const MAX_DEPTH = 1000;
TC_EDIT_END
```

The file-level spans are also disjoint, so both edits apply atomically. An
overlapping span, a duplicate span, or two insertions at one offset still fails
at `stage: duplicate`, naming both clauses and the file path.

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
TC_EDIT_BEGIN
TC_EDIT_END
```

A viewer or rename ends with `end`; a body command ends at its sentinel close.
Bodyless file commands use `end`:

```text
create src/parser.ts end
delete src/legacy-parser.ts end
read src/helper.ts within 1-12 end
```

A kind-aware create adds one top-level declaration or one member of an existing
owner:

```text
create function parseJson in src/json.ts with
TC_EDIT_BEGIN
export function parseJson(text: string): unknown {
  return JSON.parse(text);
}
TC_EDIT_END

create static method Parser.parse in src/parser.ts with
TC_EDIT_BEGIN
static parse(text: string): Parser {
  return new Parser(text);
}
TC_EDIT_END
```

A file-level select edits one unique span, such as an import/export statement
or specifier, or a statement inside a callback; several file-level editors may
share one file in a reply when their spans are pairwise disjoint. A module
create adds one statement at the module boundary:

```text
select file src/parser.ts
match `import { trim } from "./strings";`
replace with
TC_EDIT_BEGIN
import { trimEnd } from "./strings";
TC_EDIT_END

select file src/parser.test.ts
match `if (value === 1) {`
replace with
TC_EDIT_BEGIN
if (value === 2) {
TC_EDIT_END

create import in src/parser.ts with
TC_EDIT_BEGIN
import type { ParserOptions } from "./options";
TC_EDIT_END
```

A whole-file write:

```text
write src/parser.ts with
TC_EDIT_BEGIN
export function parse(input: string): string {
  return input.trim();
}
TC_EDIT_END
```

A ranged write:

```text
write src/parser.ts within 2-4 with
TC_EDIT_BEGIN
export function parse(input: string): string {
  return input.trim();
}
TC_EDIT_END
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

   **Corpus policy.** `typescript-editor/src/matcher-corpus.test.ts` is the committed proof of
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
   inclusiveness, declaration containment). A declaration range must sit inside
   the declaration span; a file-level range must sit inside the file. The total
   file size does not bound resolution: oversized prompt blocks are folded with
   file-absolute line numbers, not truncated. With a `match`, the candidate set
   is filtered by the selecter kind: a **point** keeps candidates whose span
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
file-absolute lines. Its header carries `rev <token>` for the full file source,
and `read` output carries the same token in its block header. Copying that token
into the next clause as `rev <token>` proves the coordinates came from this
revision; omitting it edits the current source. The token is deterministic and
changes when a single source character changes. A declaration or file block is folded by indentation when
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

| Stage       | Cause                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syntax`    | Edit-dsl only: the reply does not parse as a statement (`select …` or a file command), including a fence or terminator error.                                  |
| `protocol`  | The reply is not edit-dsl, including a JSON edit payload.                                                                                                      |
| `address`   | The address does not resolve uniquely.                                                                                                                         |
| `matcher`   | `matcher-unparseable`, `matcher-not-found`, `matcher-ambiguous`, or `regex-invalid`; an insertion anchor resolves through the same causes.                     |
| `range`     | A `range`/`pick` that is out of bounds, empty, inverted, outside the declaration, or copied from a stale `rev` token.                                          |
| `no-op`     | The replacement equals the text it replaces, or an insertion anchor's fence is empty; ignored when another clause in the reply applies, otherwise a rejection. |
| `duplicate` | A repeated resolved target; a duplicate top-level declaration or create.                                                                                       |
| `gate`      | The file parsed before and does not parse after.                                                                                                               |
| `format`    | oxfmt rejected the result, or the formatted source equals the pre-edit source.                                                                                 |

When an edit-dsl statement fails at any stage other than `no-op`, its
diagnostic names the statement, its position in the reply (`clause N of M`), its
locator and path, and states that the whole reply was discarded, so the model
must resend the full corrected reply. A `no-op` clause is the per-clause
exception above: it is reported and ignored only when another clause applies;
an all-inert reply still rejects. The `EDIT_*` parser codes are listed in §2;
the Plan DSL's `PLAN_*` codes are owned by [`plan-exec.md`](plan-exec.md) §4.3.
Retry policy around a rejection is owned by
[`feedback-loop.md`](feedback-loop.md).

## 6. Application and gating

Nothing is written until the candidate passes, in order: address resolution,
the **revision guard** (a claimed `rev` must equal the source read for the
clause), the **unique-target claim** (every `select`, `rename`, and implicit create in
one reply resolves to a distinct `(path, symbol, kind)`, except pairwise-disjoint
`match`/`pick` editor regions on one declaration or one file), matcher/range resolution, then the splice, the **parse gate** (a file that parsed must still
parse), the **duplicate-declaration guard** (a top-level `function`, `class`, or
`type` name may not be added twice), the **formatter**, and the **post-format
no-op check** (a candidate that differs only by formatting is rejected as a
no-op). A failing gate writes nothing and reports its stage.

Edit-dsl replies are **atomic across the editing statements**. Every statement
resolves against its file's current source. Before any matcher runs, each
select clause (viewer, editor, or rename) and each implicit create claims its
resolved target; a repeated hard `(path, symbol, kind)` — viewer, rename,
whole-symbol editor, create, or a hard/partial mix — is a `stage: duplicate`
rejection that names both statements and the address and discards the reply.
Multiple `match`/`pick` editor clauses may share a declaration, and multiple
file-level editors may share a file, only when their resolved spans are pairwise
disjoint; an overlap or duplicate span is also a `stage: duplicate` rejection
naming both clauses, and nothing from the rejected clause is queued.
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

### Dry-run diff preview

`tsed --dry-run` runs the same resolution, gate, and preflight pipeline but
stops before the first write/create/delete method. It reports the planned paths
as `would change:`, `would create:`, and `would delete:` lines. Add `--diff` to
also print a standard unified diff for each planned path, rendered in-process
from the pre-reply snapshot and the planned source; the workspace stays
byte-identical. A create uses `/dev/null` on the old side, a delete uses it on
the new side, and a source without a trailing newline carries the usual
`\ No newline at end of file` marker. `--diff` is preview-only: `tsed` rejects
it without `--dry-run` and with `--write`. The library equivalent is
`applyEditDsl(reply, { cwd, dryRun: true, diff: true })`, whose sorted `diffs`
array contains `{ path, diff }` entries (empty unless requested).

**Implicit create (edit-dsl only).** Any editor select clause (a non-empty
`replace`) whose symbol is absent, or is declared only in another symbol space,
appends the fence body as a new top-level declaration, creating the file and its
parent directories as needed, spliced at the file's current end behind a
separating newline. `match` and `pick` do not change creation; they are ignored
when the symbol is missing. Viewers never create. The kind-aware
`create <kind> <name> in <path> with <fence>` statement (§2.1) is the
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

- A `protocol` rejection re-teaches the `select` form (`end` for a viewer or
  rename, fence close for a replacement).
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
