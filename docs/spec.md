# typescript-coder — Specification

## 1. Goal

A self-contained TypeScript coding agent. It reads an issue from **stdin**, uses a
hand-written TypeScript frontend plus a symbol index to select a target
(**address**: `path × symbol × kind`) and a **mode** (`modify`, `create`, or
`delete`), asks an OpenAI-compatible LLM for **one flat edit payload**
(`{"path","symbol","kind","matcher"?,"range"?,"replacement"}`) for that target,
resolves the address with a strict AND (never a silent first match), splices the
replacement over the structurally-matched range (or an explicit `(line,column)`
`range`, or the whole symbol when both selectors are omitted), and accepts the
result only after the mandatory **syntax
gate** plus `tsc --noEmit` and `bun test` pass. The loop is two nested levels:
**Run** iterates **Edit → Verification**; each Run iteration grants a fresh Edit
budget of **≤3 model exchanges** shared by target picking and content revision,
and the run is capped at **32 Run iterations**. On failure it keeps the attempted
state and re-asks with a per-cause correction (escalating when the same cause
repeats; a splice-caused duplicate-modifier format failure exits immediately as
a harness fault); a round that exhausts its exchanges below the cap continues
through a **continuation prompt** (the model replies `STOP` to end the run, or a
corrected edit/selection opens a fresh round), a round that opens on 8
consecutive no-progress rounds (failed verifications plus rounds that end with
no applied edit, e.g. rejection-exhausted ones) asks the model to decide through
the **no-progress ask** when a target is pinned (a selection-only storm keeps
the selection continuation's own `STOP` framing; reply `STOP`, or continue with
a materially different approach; its second and later occurrences name the
unchanged/cycling failing set and demand the reply address it or `STOP`), while
a token-budget overrun, a
failed delete verification, a target
that stops parsing, a harness fault, or the 32-round cap ends the run, and the
LLM writes exactly one summary in the four labeled sections (accomplished /
failed and why / remaining / next step) for the planning main agent.

## 2. Language & runtime

- Language: TypeScript (ESM, strict).
- Runtime / package manager / test runner: **Bun** (`bun test`).
- External dependencies: `oxfmt`, `tsc`, `bun`.

## 3. Design premise

TypeScript symbol resolution depends on:

- lexical scope,
- a few overloading rules,
- runtime symbols vs type symbols (declaration spaces),
- namespaces,
- types.

The frontend must model these explicitly rather than deferring to `tsc`.

## 4. Core abstractions

### Address (composite locator)

| field    | type   | description                      | example        |
| -------- | ------ | -------------------------------- | -------------- |
| `path`   | string | repo-relative filesystem path    | `src/lexer.ts` |
| `symbol` | string | dotted member path of the symbol | `lexer.make`   |
| `kind`   | string | disambiguator / declaration kind | `function`     |

The wire field is `symbol` (v2; renamed from `name`); the internal `Locator`
type keeps the `name` field for the index. Resolution is a strict AND of all
three fields: zero matches list the candidates the name does exist at, multiple
matches list every declaration, and the harness **never** picks one silently.

`kind` vocabulary: `function`, `method`, `class`, `interface`, `type`,
`variable`, `namespace`, `enum`, and other declaration kinds as the binder adds
them.

### Modes

A selection carries one of three modes (default `modify`):

- **`modify`** — the address must resolve to exactly one declaration; an edit
  payload then rewrites part or all of it.
- **`create`** — the target file must be a safe, parseable path and the name must
  be absent from it under any kind; the replacement is the complete declaration
  and is appended to the file (creating it and missing parent directories).
  Reusing an existing name is rejected with a hint to use `modify`.
- **`delete`** — the selection is the whole model exchange; the harness splices
  the resolved declaration out (range expanded to a wrapping `export`) and runs
  the syntax gate, `oxfmt`, and verification once. No edit payload is requested.
  A post-pick failure ends the run as `delete-verification-failed` (the written
  deletion is kept on disk; gate/format failures write nothing), except a target
  that stops parsing, which ends as `prev-broken`.

### Edit

| field         | type    | description                                                                                                             |
| ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `path`        | string  | address echo, must equal the pinned selection                                                                           |
| `symbol`      | string  | address echo, must equal the pinned selection                                                                           |
| `kind`        | string  | address echo, must equal the pinned selection                                                                           |
| `matcher`     | string? | optional snippet copied from the current source, structurally matched inside the symbol; omitted = whole-symbol rewrite |
| `range`       | object? | optional position selector `{line, column, endLine, endColumn}` (#72): all 1-based, end inclusive, against the numbered current-source block shown in the prompt; an alternative to `matcher`, must sit inside the declaration; takes precedence over `matcher` when both are sent |
| `replacement` | string  | the text spliced over exactly the matched (or whole-symbol) range                                                       |

One flat payload per edit. The address is echoed back (`mode` is never echoed)
and any mismatch fails the exchange with `stage: echo`, with one exception: in a
verification-repair iteration (a round opened by failing verification) the pin
may move to a different declaration in the same file — the payload carries that
declaration's own {path, symbol, kind}, which must resolve to exactly one
declaration in the current source, and the pin (with its echoed label) then
points at it. A payload path outside the pinned file fails with `stage:
address`. `create` rejects a present `matcher` or `range`.

**Multi-payload exchanges (#69/#78, opt-in, default off):** with the
`--multi-payload` flag (benchmark: `--multi-payload`; loop option
`multiPayload`) a `modify` reply may instead carry
`{"payloads": [ {…}, {…} ]}` — a batch of flat payloads. Entries may be
path-independent (one per file) or name the same file more than once
(**bounded same-file multi-region**, #78): the regions they address must be
non-overlapping, and an overlapping pair is rejected as `multi-duplicate`
before any splice, naming both. The first entry carries the pinned address (or
the verification-repair re-pin) exactly as the flat payload does; each further
entry names its own declaration in its own file, which must resolve to exactly
one declaration in the current source. Each entry runs the full per-payload
chain — echo/address, splice, syntax gate, duplicate-name guard, `oxfmt` no-op
check — and a file's regions are combined in one pass. The exchange applies
**atomically**: if any entry fails its own guard, or two same-file regions
overlap, nothing is written and the exchange is rejected with `stage: multi`
naming every failing entry's position, file, and cause (the record's outcome
and typed cause stay those of the first failing entry). `create`/`delete`
selections never batch — a batch reply to a `create` round is a
`multi-protocol` rejection. With the flag off, a `{"payloads": …}` reply is a
classic `stage: protocol` rejection and behavior is byte-identical to the
single-payload path.

### apply-edit

```ts
findAnchor(source: string, symbol: SymbolRange, anchor: string): AnchorResult
applyAnchorSplice(source: string, start: number, end: number, replacement: string): string
```

`findAnchor` matches the matcher structurally (AST equivalence: trivia and
comments ignored, identifiers compared exactly) inside the resolved
declaration. A matcher is one copied statement, one class member, one
expression, or a contiguous run of ≥2 statements copied from one block. A run
matches only consecutive siblings inside the symbol (same container, adjacent
slots) and reports the source span from the first to the last matched sibling.
Exactly one match is required: zero or multiple matches fail the
exchange with `stage: matcher` (`not found` / `N places`, both naming kind, name,
path, line, column); a run that matches more than once is ambiguous with the run
count. With `matcher` omitted the whole declaration node's range
is used. The indexed range starts after a wrapping `export`, so a leading
`export` (or `export default`) on the matcher or on a replacement that splices
the whole declaration range (whole-symbol rewrite, or a matcher matching the
declaration itself), repeating the declaration's existing modifier, is stripped
and keeps exactly one copy of it; any whitespace after `export` is tolerated
(`export\nfunction …`), while comment text between `export` and the declaration
is not recognized and still duplicates the modifier (harness-fault class). A
not-found matcher also searches the file's
other declarations: when a candidate matches, the diagnostic names it with the
payload address that would re-pin to it (up to two candidates are listed). A
splice whose result is byte-identical to the source before the edit is rejected
with `stage: no-op` before the gate, and one whose formatted result equals the
formatted source is rejected at the format gate; either way nothing is written,
verification never runs, and the retry carries the cause's correction. The
splice is then gated: if the resulting source does not parse, the exchange fails
with `stage: gate` and **nothing is written**; otherwise `oxfmt` formats the
whole file before the write (a formatting failure is `stage: format`). Two
pre-write guards stop self-inflicted spirals. A modify payload byte-identical to
the previous modify payload (locator as sent, `matcher`, `range`,
`replacement`) fails with `stage: repeat` before any resolution or splice —
nothing is written, the guard spans iterations, and the diagnostic distinguishes
an already-applied edit from a just-rejected one. After the parse gate, a
candidate that raises the file's top-level count of a bodyful function, class,
or type-alias name fails with `stage: duplicate`, naming the existing
declaration and its line; overload signatures (bodyless functions) and
interfaces/namespaces are exempt.

**Range selector (#72):** a `modify` payload may carry `range` —
`{line, column, endLine, endColumn}`, all positive integers and 1-based, end
inclusive — as an alternative to `matcher` for the ambiguity class the
structural matcher cannot resolve. The coordinates address the current-source
block the prompt shows: the pinned declaration for an ordinary modify round
(the indexed range, starting after a wrapping `export`), or the whole file in a
create→repair round. The prompt renders that block with 1-based line numbers
(`N | source`; columns count the source characters after the prefix), so the
positions are copied from the prompt. The resolved span must sit inside the
resolved declaration; it is spliced exactly like a matcher match, and a range
that starts at the declaration's first character gets the same leading-`export`
tolerance as a whole-symbol rewrite (a body-level range does not). A `range` is
rejected with `stage: range` — the single `range-invalid` typed cause — for an
out-of-bounds position (a line/column that does not exist in the shown block,
including an inclusive end that runs past its last character), a span outside
the declaration, an empty range, or an end before its start; a block the prompt
would elide (over the 8000-character prompt limit) is refused too, because its
shown line numbers no longer map back to the file. The diagnostic
names the current bounds (the declaration's line/column span in the shown
source). Because a `range` addresses only the declaration the prompt showed, a
payload that re-pins to another declaration (outside a create→repair round,
whose whole file is shown), or a further multi-payload entry in another file, is
refused the same way — its coordinates would have no shown block to address.
`range` takes precedence over `matcher` when both are sent, and a
missing `range` leaves the matcher/whole-symbol path byte-identical.

### create (missing symbol)

`mode: "create"` requires a safe path — relative, no `..` segment, resolves
inside `cwd`, not under `node_modules`, `.git`, `dist`, `tmp`, or a hidden directory —
and a file that parses. The replacement is the complete code declaring the
symbol, appended to the file (created with any missing parent directories when
absent) newline-normalized and separated from existing content by one blank
line, then `oxfmt`-formatted and verified by the same check + test gate. On
failure the attempted state stays on disk (keep-progress): a kept file that
parses continues as a `modify` repair round against that file (the pin switches
to `modify`, including the echoed `{mode, path, symbol, kind}` label); an absent
or unparseable kept file is removed and the create re-runs.

## 5. Source layout

| file                   | responsibility                                                  |
| ---------------------- | --------------------------------------------------------------- |
| `lexer.ts`             | full TypeScript lexer, **no error tolerance** (throws with loc) |
| `parser.ts`            | full TypeScript grammar parser, recursive descent → AST + spans |
| `utility.ts`           | shared helpers + binder / symbol index                          |
| `anchor.ts`            | matcher fragment parse, structural match, splice                |
| `editor.ts`            | `oxfmt` formatting for the write path (`formatSource`)          |
| `tools.ts`             | bounded `check`/`test` commands + located diagnostics           |
| `failure-artifact.ts`  | renders + writes `failures/` artifacts for terminated runs      |
| `openai.ts`            | OpenAI-compatible provider, `tools` param                       |
| `loop.ts`              | main agent loop                                                 |
| `scroll.ts`            | signature view + on-demand expand                               |
| `replay-format.ts`     | replay bundle format (`typescript-coder-replay@1`) + recorder   |
| `replay-runner.ts`     | offline replay provider + run comparison                        |
| `benchmark-pricing.ts` | official rate card + per-run USD cost                           |
| `cli.ts`               | entry point (currently `--help` only)                           |
| `main.ts`              | wires stdin → loop                                              |
| `index.ts`             | scaffold placeholder (`greet`), self-host acceptance target     |

## 6. Agent loop

**Input:** the planning main agent's issue, delivered on **stdin** (free text).

The loop nests two levels (#43): **Run** repeats **Edit → Verification** until the
task succeeds or the run terminates; each Run iteration grants Edit a fresh budget
of at most **3 model exchanges** shared by target picking and content revision. A
round that exhausts its 3 exchanges below the run cap opens a **continuation
round** (see budget), and the whole run is capped at **32 Run iterations** (#52).

```
harness:
  - parse project TypeScript files into AST
  - build symbol index
  - combine context

model (Edit, ≤3 exchanges per Run iteration):
  - LLM reads context                          # yaml
  - LLM selects target + mode                  # json {mode, path, symbol, kind}
  - LLM outputs one flat edit payload          # {"path","symbol","kind","matcher"?,"range"?,"replacement"}
                                               # or, with --multi-payload on, {"payloads":[…]} (one or more per file, #69/#78)
  - LLM (repair exchange only, once per round) # {"request":"read"|"check"|"test"}, harness returns a bounded result

harness:
  - resolve address (strict AND)   # 0 or >1 matches = staged diagnostic, never a silent pick
  - echo-check + range/matcher splice  # omitted selectors = whole-symbol rewrite
  - syntax gate                    # unparseable after = discard, nothing written
  - format with oxfmt
  - write the edit (keep-progress, no rollback)
  - run TypeScript checker   (tsc --noEmit)    # Verification, once per iteration
  - run TypeScript tests     (bun test)
```

- **budget:** every Run iteration starts a fresh ≤3-exchange Edit budget shared by
  target picking and content revision. Soft failures (`protocol`, `address`,
  `echo`, `matcher`, `range`, `no-op`, `repeat`, `duplicate`, `gate`, `format`,
  `truncated`)
  consume one exchange and re-ask with staged diagnostics; a rejection repeated
  byte-identically inside the iteration prefixes the retry with a `failed
  identically` note. A valid edit leaves Edit and enters Verification.
- **records (#69/#73):** every record row carries the number of payload objects
  the exchange submitted (`payloads`: 1 classic, N for a batch, 0 when none) and
  the provider tool calls in the reply (`toolCalls`); an executed self-check
  request records a `self-check` exchange row (#73). `exchangeStats(records)`
  folds a run's rows into per-run diagnostics — `turns`, `payloads`, `toolCalls`,
  `applied`, `rejected`, `selected`, `stopped`, `selfChecks` — so the rejected-vs-applied
  exchange counts and the command/tool-call volume are readable from the
  benchmark record (and the tc side log's `exchangeStats:` line) without replay
  parsing.
- **rejection policy (#56/#65):** every soft failure is classified into a typed
  cause — `protocol`, `echo`, `address`, the three matcher sub-causes
  (`matcher-unparseable`, `matcher-not-found`, `matcher-ambiguous`),
  `range-invalid`, `no-op`,
  `repeat`, `duplicate`, `gate`, `format`, or `truncated` — carried on the record
  row, and the retry prompt's lead sentence is that cause's concrete correction
  instead of the generic "make minimal corrective changes" (matcher causes ask
  for a verbatim matcher or an omitted `matcher`; `range-invalid` asks for the
  1-based positions copied from the numbered current-source block, or omitting
  `range`; no-op states the intended
  change is already in the file and points at the round's pending failures;
  address/echo ask to echo the pin;
  gate asks for a complete declaration; format asks to keep the declaration
  shape; truncated asks for a compact replacement; `repeat`/`duplicate` state
  that the file already reflects the submission — the change is in place or the
  rejection stands, or the declaration already exists — so a resend cannot
  change anything and the next attempt must differ in target, matcher, or
  replacement; the rejected replacement text is never re-echoed). Consecutive
  same-cause rejections accumulate in a run-scope streak that spans iterations
  and #52 continuations and is reset only by an applied edit; from the second
  one the prompt carries the cause's escalation (for every matcher cause: this
  attempt MUST omit `matcher` and return the complete declaration; for
  `repeat`/`duplicate`: this attempt MUST differ from the previous attempts and
  address the diagnostics). An `address` rejection
  whose name the current source does not declare uses the missing symbol's own
  wording instead of the pin-echo correction: the lead and its escalation name
  the undeclared symbol, keep the add path open (carry its declaration inside
  the replacement of an address that resolves; mode `create` applies only while
  the run is still choosing a target), and never weaken the address guard. The
  #54 no-progress ask still overrides
  the correction when both would apply. A `format` failure whose formatter
  message carries the duplicate-modifier signature (`'export' modifier already
  seen`) is a harness fault: the rejection row is recorded, then the run exits
  through the termination matrix as `harness-fault` with the full diagnostics and
  exactly one summary call — it is never retried.
- **continuation (#52):** a round that exhausts its 3 exchanges without a valid
  edit does not end the run below the **32-iteration cap**: the next Run iteration
  opens with a **continuation prompt** that keeps the retry shape (current source,
  the diagnostics that opened the round, the latest rejection) plus the STOP
  framing and the **attempt digest** (#57); this prompt offers `STOP` (the
  no-progress ask below offers it too),
  and its reply is processed as the first
  exchange of the fresh ≤3 budget with every guard still in force (an identical
  modify resend is `stage: repeat` and consumes that exchange). A reply that trims,
  case-insensitively, to `STOP` ends the run through the termination chain and is
  recorded as a `stopped` row; entering a Run iteration beyond 32 (ordinary
  verification-repair rounds count) terminates as `edit-exhausted` naming the cap.
- **no-progress ask (#54/#60):** a round that opens after
  `MAX_STALLED_ROUNDS` (8) consecutive no-progress rounds — failed verifications
  and rounds that end with no applied edit (all exchanges rejected, truncated, or
  the budget spent picking) both advance the run-scope streak — with a pinned
  target opens with its first content prompt in retry shape (pinned selection,
  current source, diagnostics, JSON payload shape) but replaces the exchange
  header with the no-progress framing: the count of consecutive failed rounds,
  the current round (N of 32), `STOP` ("reply exactly `STOP` to end the run now",
  biased to continue — only when the failures cannot be resolved), and a request
  for a materially different approach naming concrete alternatives (change the
  matcher shape, re-pin to a declaration the diagnostics name, restructure the
  declaration); the ask round may re-pin like a verification-opened one. After
  the first ask the decision point recurs every `MAX_STALLED_ROUNDS / 2` (4)
  further failed rounds — 8, 12, 16, 20, … — with the updated count (#65); the
  shorter interval keeps the later ask reachable in a fast-burning storm that
  would otherwise exhaust the token budget before it. Each ask carries the
  **attempt digest** (#57). The **first** ask uses exactly that
  wording; from the **second** decision point on the ask is sharpened (#65): it
  states how many consecutive failed rounds have passed since the previous ask,
  names the unchanged/cycling fact the `#71 Failure history` note carries (the
  failing set is unchanged across the last N verification rounds, or cycling
  between two states), and requires the reply to either directly address that
  unchanged failing set — the diagnostics below name it, not another minimal
  edit at the same spot — or reply exactly `STOP`. This sharpens the framing
  only: the first ask stays byte-identical, `STOP`'s meaning and the decision
  point are unchanged, and no cap or auto-stop is added. A round that opens through a #52
  continuation prompt keeps that prompt's framing, except that a continuation
  directly following a milestone no-progress round carries the no-progress ask
  instead (rejection-exhausted cycles open every round through a continuation,
  so the decision point reaches them this way); a selection continuation has no
  pinned target and keeps its own `STOP` framing. A reply that trims,
  case-insensitively, to `STOP` ends the run through the termination chain — a
  `stopped` row whose diagnostics name the consecutive failed rounds, exactly
  one summary — while any other reply is processed as a normal first exchange
  with every guard still in force (an identical modify resend is `stage: repeat`
  and consumes that exchange).
- **attempt digest (#57):** the #52 continuation prompts (both the edit and the
  selection variant) and the #54 no-progress ask carry a bounded `Prior attempts`
  checkpoint appended after the diagnostics: one line per failed attempt
  (`- #<n> <class>: <first informative diagnostics line>`), where the class is
  the #56 rejection cause (or the verification outcome `tsc`/`tests`). It is
  built incrementally from the record rows beyond a run-scope cursor — later
  continuations keep the earlier lines and raise the counts, and only the chosen
  diagnostics line enters it, never a code frame or a raw replacement. The
  rendered text is capped at 1,200 characters: the header, the omitted-entries
  line, and the ruled-out block are reserved first, then the oldest entries are
  evicted (the omitted count stays accurate; per-class counts keep every
  attempt). A class repeated three or more times earns a
  `Ruled out after <n> repeats: <class> — <action>` line (most-repeated first),
  reusing the #56 escalation text for rejection causes and a fixed concrete
  sentence for `tsc`/`tests` (change the declaration structure instead of
  re-editing the same spot). Ordinary retries and every other prompt are
  unchanged.
- **failure history (#71):** a repair chain that is not converging appends a
  bounded `Failure history` note between the diagnostics and the digest: the
  same failing set across ≥3 consecutive failed verifications, or two states
  cycling over ≥4. It derives from the mapped diagnostics only (normalized error
  code + first sentence; positions stripped), rides ordinary retries, #52
  continuations and the #54 ask alike, and a passing verification resets it.
- **pinning:** the first successful pick fixes `{mode, path, symbol, kind}`.
  Later exchanges revise content only and fail with `stage: echo` unless the
  payload echoes the pinned address. A verification-repair iteration (a round
  opened by failing verification) may instead re-pin to a different declaration
  in the same file: the payload carries that declaration's own
  {path, symbol, kind}, which must resolve uniquely in the current source, and
  the pin label (rebuilt with `mode`) moves to it, while the payload echoes only
  `{path, symbol, kind}`; a different path fails with `stage: address`.
- **matcher:** one optional structural matcher per edit; it is one copied
  statement, class member, expression, or contiguous run of statements from one
  block (a run matches only consecutive siblings inside the symbol). Zero matches
  fail with `matcher` (not-found) and multiple matches with `matcher` (ambiguous),
  each naming kind, name, path, line, and column. A leading `export`/`export default`
  repeating the declaration's existing modifier is accepted, with any whitespace
  after `export` (a matcher and a replacement splicing the declaration range keep
  exactly one copy), and a
  not-found matcher names a matching declaration of the same file together with
  its re-pin address when one exists. Omitting it is a whole-symbol rewrite; by
  default multiple changes happen across edit rounds (the old `edits[]` batch is
  gone), the opt-in `--multi-payload` batch (#69/#78) being the exception.
- **range (#72):** an alternative selector, `range` `{line, column, endLine,
  endColumn}`, all 1-based and end inclusive, addresses the span against the
  numbered current-source block shown in the prompt (the pinned declaration for
  an ordinary modify round, the whole file in a create→repair round). The span
  must sit inside the declaration; an out-of-bounds, outside-declaration, empty,
  or end-before-start range is a single `range-invalid` rejection naming the
  declaration's current bounds. `range` wins over `matcher` when both are sent;
  omitting it keeps the matcher/whole-symbol path byte-identical.
- **prompt support:** the edit and retry prompts render the current-source block
  with 1-based line numbers (`N | source`; columns count the characters after
  the prefix) so a `range` can be derived; this is a deliberate prompt-text
  change and its token cost is part of the measurement.
- **self-verification request (#73):** a repair exchange may reply with the
  distinct request object `{"request":"read"|"check"|"test"}` instead of an
  edit payload (§7 holds the shape, whitelist, bounds, and at-most-one rule).
  The harness executes the one request and returns a bounded `Self-check result:`
  block in the next repair prompt; every other exchange treats a `{"request":…}`
  reply as an ordinary (protocol) rejection. Requests add no provider calls or
  local commands on a round that makes none, and all guards stay unchanged.
- **selection:** the address must be a strict AND of `path`, `symbol`, `kind`;
  a miss lists the candidates the name does exist at, and an ambiguity lists
  every declaration. `create` requires a safe, parseable path whose name is
  absent under any kind (reusing a name is rejected with a hint to `modify`);
  `delete` needs no edit payload at all.
- **append/create:** the payload's replacement is the complete declaration of
  the missing symbol; the harness appends it to the target's file (creating file
  and parent directories when absent), formats with `oxfmt`, and runs the same
  check + test gate. Keep-progress: an existing file keeps the failed attempt's
  content. A failed create whose kept file parses continues as a `modify` repair
  round (the pin is relabeled `modify`, current-file prompt + diagnostics); an
  absent or unparseable kept file is removed and the create re-runs.
- **delete:** the pick is the whole exchange; the harness deletes the resolved
  declaration and verifies once. A deletion that fails verification ends the run
  as `delete-verification-failed`.
- **on-failure:** report staged diagnostics (`protocol`, `address`, `echo`,
  `matcher`, `range`, `no-op`, `repeat`, `duplicate`, `gate`, `format`, `tsc`,
  `tests`; plus
  `truncated` and `prev-broken`) → classify the rejection by typed cause and
  pick the per-cause correction for the re-ask (see rejection policy) → keep the
  attempted state → re-ask within the same Edit budget. A verification failure
  starts the next Run iteration with a fresh budget; an exhausted round continues
  through the continuation prompt below the cap (#52), and the run is capped at
  32 Run iterations (the token budget remains a separate bound).
- **termination matrix:** a run ends through exactly one of `token-budget`,
  `edit-exhausted` (the model replied `STOP` to a continuation prompt or to the
  no-progress ask, or the 32-round cap was reached without a valid edit),
  `delete-verification-failed`, `harness-fault` (the format gate rejected a
  splice with the duplicate-modifier signature; see rejection policy),
  `prev-broken` (the target itself stops parsing before an edit), or
  `output-limit` (three consecutive `finish_reason == "length"` replies burned
  without a usable edit). Each ends
  with exactly one LLM summary call — not an Edit exchange — whose reply carries
  the four labeled sections (accomplished / failed and why / remaining / next
  step) for the planner.
- **syntax gate:** highest-priority invariant — if the current source parses,
  the edited source must too; a gate failure is a soft failure (nothing is
  written). If the target file itself stops parsing between exchanges (for
  example after an external modification), the run ends with `prev-broken`.
- **truncation:** `finishReason: "length"` is classified as `truncated`, never
  applied, and the re-ask requests a more compact replacement.
- **diagnostics shaping:** the failing-diagnostics block a prompt carries is
  bounded. The assembled text is capped at 4,000 characters, keeping the head
  (the earliest `tsc` errors, i.e. the root causes) and the tail (the test
  summary) with an explicit `... [N characters truncated] ...` marker between
  them; at most 10 replacement-mapped diagnostics render, followed by
  `... N more in the replacement` inside the shown block; and the test-output
  tail is capped at 2,000 characters with an
  `[N earlier characters omitted]` marker. The caps shape the prompt only —
  they change nothing about what is written or which exchange outcome is
  recorded.
- **exit:** success ends the run; every termination-matrix failure ends with the
  four-section LLM summary as the final action.
- **failure artifacts:** the outer layer (CLI, benchmark runner) writes
  `failures/<ISO-stamp>-<reason>.md` — termination reason, pinned target, staged
  diagnostics, and summary — for each termination-matrix failure. Provider errors
  keep their own path and write no artifact; the harness itself never commits or
  mutates git.
- **optimization:** stable system + issue/context prefix (cache-friendly); re-asks
  rebuild a bounded history (system + issue/context + pinned selection + prompt
  with the current source) and do not re-echo previous replacements. A round
  opened by a `tsc`-stage verification failure omits the spec-file section from
  every content prompt of that round (its repair is driven by the diagnostics and
  the current source) and its #52 continuations stay lean; every other round —
  selection, first, `tests`-stage, and edit-soft-failure rounds — keeps the
  section.

## 7. Tools

Tools are **internal library APIs** in v1 (`src/tools.ts`): `rename`, `scroll`,
`find-definition`, `check`, `test`. The harness uses them directly; they are
covered by per-tool unit tests and are **never offered to the model as provider
tool calls**. v1 has no general agentic tool-execution loop: the loop sends no
`tools` to the provider, and a provider tool-call response is only ever parsed
as a selection. Provider-level `tools` parameter support stays (§8).

**Bounded self-verification exception (#73).** A *repair exchange* — a content
exchange whose prompt carries prior diagnostics (an intra-round retry) or is a
`#52` continuation, never the fresh post-pick edit prompt — may instead carry a
single self-verification request, a distinct reply object `{"request": …}` with
`…` one of three whitelisted kinds:

- `"read"` — the pinned file's current on-disk source, rendered with 1-based
  line numbers (`numberedSourceBlock`) and truncated at the prompt limit
  (`SPEC_FILE_LIMIT`; `truncateSource`). No path argument: the harness never
  reads an arbitrary path;
- `"check"` — the task's check command, run through the existing `checkTool`
  (default `bunx tsc --noEmit`);
- `"test"` — the task's test command, run through the existing `testTool`
  (default `bun test`).

The model names a **kind**, never a command string: the harness maps each kind
to the same commands Verification runs. The bounded result is returned once, in
the model's next prompt (a `Self-check result:` block appended after the
Diagnostics block and before the `Failure history`/`Prior attempts` sections):
the numbered source for `read`, or `exit <code>` plus the combined
stdout/stderr clamped to a fixed output limit (with a truncation marker) for
`check`/`test`.

The exception is deliberately narrow. A request is honored only on a repair
exchange and only at most **once per Run iteration**; it consumes one of the
round's ≤3 model exchanges (so a no-request round adds zero provider calls and
zero local commands, and its prompt path is byte-identical). A second request in
the same round, a request at the final exchange (no successor exists to return
the result), an unknown kind, an extra key, or a non-string value is **not
executed** — it is refused as a `protocol` rejection that consumes the exchange
and cannot extend the round. The three kinds are the complete whitelist; no
other command, no write access, and no additional provider `tools` are offered.
The request rides the ordinary repair-prompt shape, so the `#52`
continuation/`#54` stalled headers and the `#71` failure-history note are
unchanged.

## 8. Provider

- type: openai-compatible
- tool-call format: `tools` param
- models: `deepseek-v4.1-flash`, `deepseek-v4-pro-0813`, `glm-5.3`, `zoe/glm-5.3`
  (the gateway's key-permitted chat ids; the earlier `deepseek`/`qwen` shorthand
  was inaccurate — `deepseek` is rejected and `qwen` has no chat model there,
  embedding only)
- credentials: `OPENAI_API_KEY`, `OPENAI_BASE_URL` (standard env vars)
- model selection: `--model` flag only
- timeout / retries: the per-attempt HTTP timeout defaults to 120 s
  (`DEFAULT_TIMEOUT_MS`) and is overridden by `OPENAI_TIMEOUT_MS`; `retries`
  (default 2) re-sends on a network error or a retryable HTTP status (429, 5xx),
  honoring `Retry-After` when present, while a per-attempt timeout is re-sent
  under its own `timeoutRetries` budget (default 5, overridden by
  `OPENAI_TIMEOUT_RETRIES`) and never consumes `retries` (#74). Backoff is
  exponential (1 s base) with the two budgets tracked independently.
- entry: issue via stdin; `cli.ts` currently provides `--help` only

## 9. Frontend decisions

- Grammar surface: modern app TS — ES2024 syntax, full TS type grammar,
  decorators, namespaces, `.d.ts`, declaration merging, overloads.
  **Excludes** `.tsx` / JSX.
- Representation: **AST + source spans** (not a lossless CST). Edits splice the
  replacement over the matched range (or whole-symbol range) inside a symbol;
  `oxfmt` reprints. Comments inside the spliced range come from the LLM output.

## 10. Verification & done criteria

Edit is accepted only if both pass:

- `tsc --noEmit`
- `bun test`

The test leg runs the target's **sibling test file** first for fast feedback:
when the pinned path is `foo.ts` and a `foo.test.ts` sits beside it, `bun test
foo.test.ts` runs before the full suite. A targeted failure is the round's test
verdict and the full suite is skipped; a targeted pass still runs the full
`bun test`, so the gate is unchanged and only a round that would fail anyway
returns sooner.

**End-to-end fixtures:**

1. On a fixture repo with a failing `bun test`, the agent applies an edit that
   turns tests green and keeps `tsc --noEmit` clean.
2. A deliberately type/test-bad edit keeps its state on disk and the next Run
   iteration builds on it; a run that exhausts a round's Edit budget and replies
   `STOP` (or reaches the 32-round cap) ends with one LLM summary, and an edit
   that fails the syntax gate is discarded and nothing is written.
3. Frontend passes the fixture corpus and a self-host smoke (after the agent
   edits its own `src/`, `tsc` / `bun test` still pass).

### Testing doctrine

Tests assert external behavior only: the loop's recorded rows and result, the
judge's verdicts, the replay runner's summaries — never helper internals. The
named seams are:

- the syntax gate and splice (an invalid or unparseable edit is discarded and
  nothing is written);
- the judge invocation (`tsc --noEmit`, `bun test`, and the fixture
  byte-equality `judgeWorkspace` computes);
- the replay runner, which replays a recorded bundle with no network calls and
  compares the run record by record.

Judge verdicts are pinned by a table-driven golden corpus, and the fixture
frontends by parse/print round-trip tests (canonical printed output re-parses
to an equal AST) — both tracked by #68. These nets make zero API calls and run
in `bun test`: a judge change that flips a verdict or a frontend that stops
round-tripping must fail the suite before any measured number can move.

## 11. Milestones (work backwards, gated)

**Status: all landed (M0–M8).** The gates below are the tests that pin each one.

- **M0 · Scaffold** — `package.json` (bun, oxfmt, typescript), `tsconfig.json`
  (strict, ESM), `src/`, `bun test` wired. _Gate:_ clean `tsc --noEmit`.
- **M1 · `lexer.ts`** — full token set, trivia/comment capture, strict errors.
  _Gate:_ tokenizer snapshot tests over fixture corpus.
- **M2 · `parser.ts`** — recursive descent → AST + spans; app TS, no JSX.
  _Gate:_ AST snapshots; malformed input errors.
- **M3 · `utility.ts` + binder/index** — lexical scopes, overloads,
  runtime/type namespaces, namespaces; `Locator` → node map. _Gate:_ symbol
  lookup + find-definition tests.
- **M4 · `editor.ts`** — `applyEdits` span replacement (bottom-up) + `oxfmt`.
  _Gate:_ before/after unit tests.
- **M5 · `openai.ts`** — OpenAI-compatible chat + `tools`, env creds, model arg.
  _Gate:_ mocked-HTTP tests; optional live smoke.
- **M6 · Tools** — internal library APIs (`find-definition`, `check`, `test`,
  `scroll`, `rename`), not offered to the model in v1.
  _Gate:_ per-tool unit tests.
- **M7 · `loop.ts`** — context YAML → target/mode JSON → one flat
  matcher/whole-symbol edit → syntax gate + `oxfmt` → verify → keep-progress
  next iteration (fresh ≤3-exchange Edit budget; an exhausted round continues
  below the 32-iteration cap through the STOP continuation prompt) → termination
  matrix with one four-section LLM summary (accomplished / failed and why /
  remaining / next step); bounded rebuilt re-ask context.
  _Gate:_ end-to-end fix-a-failing-test fixture; bad-edit keep-progress test.
- **M8 · `cli.ts` + `main.ts`** — stdin issue reader, `--model`, `--help`.
  _Gate:_ self-host smoke test.

## 12. Risks & mitigations

| #   | risk                                                   | mitigation                                                                                                             |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| R1  | Full TS grammar + binder is enormous                   | freeze an app-TS subset via fixtures; gate per milestone                                                               |
| R2  | `oxfmt` native `@oxfmt/binding` may not load under Bun | spike in M0; fall back to `bunx oxfmt` subprocess / prettier                                                           |
| R3  | LLM tool-call / JSON flakiness (gateway models)        | strict JSON schema, low temperature, bounded re-asks                                                                   |
| R4  | whole-project `tsc` per iteration is slow              | incremental / changed-files scope; check/test commands bounded at 120s by default (`commandTimeoutMs`)                 |
| R5  | overload / namespace address ambiguity                 | strict-AND `path × symbol × kind` lookup; ambiguity diagnostics list every candidate instead of picking one            |
| R6  | repeated / ambiguous matchers inside a symbol          | one matcher per edit with an exactly-one-match rule and an extend-the-matcher hint; omit it for a whole-symbol rewrite, or address the span with the optional `range` `(line,column)` selector (#72; the matcher-ambiguous re-ask does not yet name it — #102) |
| R7  | re-ask context growth / prompt drift                   | stable system + issue/context prefix; bounded rebuilt context                                                          |

## 13. Open items (defaults)

- Failure handling: keep-progress (attempted state stays on disk); ≤3 model
  exchanges per Run iteration shared by picking and revision, and a 32-iteration
  cap; an exhausted round continues through the STOP continuation prompt below
  the cap; failed runs end through the termination matrix with one four-section
  LLM summary (accomplished / failed and why / remaining / next step) and a
  `failures/` artifact written by the outer layer.
- One symbol per iteration in v1.
- `scroll` = signatures + N-line on-demand expand.
- Context/token budget: bounded — context caps (500 symbols, 200-char
  signatures, 8000-char spec section; overflow marked `truncated`) and a 120k
  run token budget.
- Distribution: `bun run` (no build step).
- Test discovery: repo-wide `bun test`.
- Formatting: default `oxfmt` config, TypeScript.
- Failure explanation surfaced on stderr + final stdout message.
