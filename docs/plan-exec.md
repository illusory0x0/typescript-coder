# Plan → execute loop

Status: **implemented.** This document describes the plan-exec loop.
[`src/tasks.ts`](../src/tasks.ts), [`src/plan-dsl.ts`](../src/plan-dsl.ts), and
[`src/task-loop.ts`](../src/task-loop.ts) are the source of truth for the model,
wire grammar, and driver; prompts are [`src/prompts/task.ts`](../src/prompts/task.ts).

Canonical ownership: this document owns the WorkNode DAG model, target and
approach hints, the flat plan DSL and `amend` records, planning, validation and
apply, scheduling, plan-exec execution context, gates, plan-exec-specific
limits, the plan-exec CLI, result, limitations, implementation, and
verification. [`feedback-loop.md`](feedback-loop.md) owns the shared loop
lifecycle, AgentMode routing, round/exchange policy, retry/termination, shared
caps, and records/result. [`edit-protocol.md`](edit-protocol.md) owns the
edit-action reply language, select clause/file command grammar, resolution
cascade, application/gating, and the declaration coverage matrix. Vocabulary is
canonical in [`README.md`](README.md).

The loop is **additive**. `--mode pinned-repair` (default) keeps the
single-target Edit → Verify driver byte-identical
([`feedback-loop.md`](feedback-loop.md)). `--mode plan-exec` runs a task-level
work graph:

- the planner appends **WorkNode** records and revises unsettled ones with
  `amend`;
- the executor carries out one node with edit-dsl clauses or file commands;
- the harness schedules, gates, reviews, and derives completion.

## 1. Core model

The model is a task-level DAG, not a Stage/Task/Edit hierarchy:

```text
Run
└── WorkNode[]   (edges: WorkNode.after)
```

```ts
type PlanRunState = {
  goal: string;
  nodes: WorkNode[]; // record order is the readiness tie-break
  nodeStatus: Map<NodeId, NodeStatus>;
  lastGate: GateSnapshot | null; // { nodeId, verify, ok }
};

type WorkNode = {
  id: NodeId;
  after: NodeId[]; // dependency ids; empty means ready at the start
  verify: "tsc" | "test";
  instruction: string; // self-contained local goal for the executor
  hints: HintLoc[]; // advisory target hints; never a hard allowlist
  approach?: string; // advisory strategy
  phase?: string; // optional workflow label; not a scheduling input
};

type HintLoc = {
  path: string; // repo-relative, writable
  symbol: string; // declared name; empty for a file hint
  kind: "value" | "type" | "namespace" | "file";
};

type NodeId = string; // "02-answer", "03-scaffold", "04-impl", ...
```

Work-node ids are globally unique and match
`/^[0-9]{2,}-[a-z0-9]+(?:-[a-z0-9]+)*$/`. The `NN-` prefix is for readability
only; readiness is decided by `after` edges, with record order as the
deterministic tie-break. A node may depend on an existing node or one declared
later in the same reply, as long as the graph stays acyclic.

The harness owns status:

```ts
type NodeStatus = "pending" | "passed" | "failed";
```

`review` is a **driver phase**, not a graph status: a node stays `pending` while
the executor holds it and while the review turn decides, then settles as
`passed` or `failed`. Blocked is derived from status and edges, not stored.
There is no `deferred` status; deferred work is simply not appended.

`lastGate` records the most recent gate (`tsc` or `test`, pass/fail). Run
success is derived from it:

```ts
complete =
  nextReadyNode(state) === undefined &&
  state.lastGate?.verify === "test" &&
  state.lastGate.ok;
```

Only the executor writes source, and every applied reply runs the node gate.
So "nothing runnable + the last gate was a passing test" means the current
workspace is green. Earlier failed nodes and blocked pending nodes are
superseded/abandoned by a later green test; they do not keep the run open. This
replaces the old `finish` / `finalNodeId` protocol and its "final node must be
last and verify test" invariant.

### 1.1 Hints are guidance

A hint names a likely path and symbol. It is not a target guard and not an
allowlist: the executor may edit outside the hinted paths when the instruction
requires it, and review sees those edits. A file hint uses `symbol: ""` and
`kind: "file"`; a symbol hint uses `value`, `type`, or `namespace`:

```text
hint file src/workbook.ts
hint value evaluate in src/workbook.ts
hint type CellResult in src/workbook.ts
```

`phase` is an optional workflow label such as `scaffold` or `implement`. It is
planning/review context only; it never changes scheduling.

### 1.2 Approach is advice

`approach` carries the planner's programming experience as an optional strategy
hint. The executor may override it from the current source. Validation and
review do not require adherence. Canonical examples:

- a small requirement on a small file may justify one whole-file write;
- a new large greenfield module is often cheapest as one whole-file `write`
  scaffold of top-level declarations and stub bodies, then targeted edits or
  `create` for later additions;
- an existing large file often needs targeted edits, though a whole-file
  rewrite remains valid when the change is broad or a targeted edit would be
  riskier.

The planner recommends a workflow (inspect → contract → scaffold → implement →
verify) but does not impose it. A single node, a linear chain, and a branching
DAG are all valid shapes.

### 1.3 Editing decision guide

The executor owns the action and granularity. The full grammar and coverage
matrix are owned by [`edit-protocol.md`](edit-protocol.md); the decision guide
is repeated in the execution prompt. `write` is always valid. No edit is
rejected merely for its size or shape.

### 1.4 Functional style

Planner and executor prefer ML-style functional TypeScript:

- data + functions over classes and prototypes;
- top-level functions with explicit parameter and return types;
- tagged unions with a string-literal `tag`, tuples, and plain records;
- small, named helper functions; a thin orchestrator calling them;
- no new `class`, inheritance, `super`, implicit `this`, private state,
  getters/setters, or class-based state machines;
- existing classes: minimal targeted edits; a named member `create` is valid
  when it is the smallest change.

The planner decides helper decomposition. A single-file change does **not** need
several nodes; one node is valid when its gate can pass. Do not split work just
to make the graph look more parallel.

The prompt style block is:

```text
Prefer ML-style functional TypeScript:
- Data + functions over classes and prototypes.
- Model data with tagged unions (string-literal tag), tuples, and plain records.
- Implement behavior as top-level functions with explicit parameter and return
  types.
- Extract small helpers when they make the code clearer; do not force an extra
  work node.
- Do not create new classes, inheritance, `super`, implicit `this`, private
  state, getters/setters, or class-based state machines.
- If an existing class must change, modify it minimally.
```

### 1.5 Limits

| Limit              | Value       |
| ------------------ | ----------- |
| Plan goal length   | 1,000 chars |
| Instruction length | 4,000 chars |
| Approach length    | 2,000 chars |
| Phase length       | 200 chars   |
| USD cost budget    | $0.10       |

There is no WorkNode count cap and no fixed per-turn node cap. Growth is bounded
by the USD cost budget and the driver's no-progress detection. The driver has no
fixed exchange, viewer, review, or planning-round cap.

## 2. Protocol

Planning, review, and execution are separate turns. There is one reply grammar:
the initial reply carries a goal, and every later reply appends nodes or amends
unsettled work.

```text
1. Initial plan: `plan` + `goal:` + one or more `node` records.
2. Apply and validate the graph.
3. The harness picks the first ready node in record order and executes it.
4. After each applied executor reply, the node gate runs.
5. On a passing gate:
   - the fast path approves an in-hint, untruncated change without a model call;
   - otherwise one review turn returns `approve` or one `amend` for this node.
6. If review amends the node, it re-executes and gates again.
7. If the node settles passed and the run is green, success.
8. Otherwise, when no node is ready, the planner appends work or amends a
   pending/failed node; repeat from step 3.
```

A planning turn may append one or more nodes. There is no fixed batch cap; the
USD cost budget and no-progress detection bound growth. New nodes may be ready
immediately or depend on existing or newly appended nodes.

The planner may make read-only edit-protocol viewer requests before a plan
reply: `select ... end` (optionally with `within <selecters>`), or `read ... end`
(optionally with `within`). A viewer writes nothing; the harness returns the
indentation-folded source or exact slice in a `# Source view` message, then asks
for the plan reply again. There is no arbitrary request count: each viewer
consumes the USD cost budget, and a repeated identical view or no-progress cycle
forces the plan reply. Planner viewer requests are not work records and do not
create, edit, or delete files.

The recommended workflow is **inspect → contract → scaffold → implement →
verify**:

- inspect the requirement, index, and source;
- settle the public contract (types, signatures, data shapes);
- scaffold declarations and stub bodies for a large module when useful;
- when a visible test suite exists, consider an early `verify test` checkpoint
  after the scaffold/contract phase, once a compiling skeleton exists;
- implement behavior in node-sized work;
- finish with a `test` node that depends on the work it verifies.

This is guidance. A one-node plan is valid when its gate can pass; a branching
DAG is valid when two pieces of work are genuinely independent. There is no
`finish` record: the driver completes from the scheduler and the last gate.

### 2.1 Amending a node

`amend "<id>"` revises a node that has not settled:

- allowed when the node is `pending`, `failed`, or the current review target;
- forbidden for a `passed` node (it is immutable);
- fields present replace their values; omitted fields are preserved;
- `after` with no ids clears dependencies; `hint clear`, `approach clear`, and
  `phase clear` clear the list/optional field;
- at least one field must change, otherwise the amend is rejected;
- the merged graph is validated again (ids, dangling edges, cycles, hints,
  lengths).

A failed node reopens to `pending` when amended. A pending node stays pending.
A review amend reopens the reviewed node. A passed node is never rewritten; add
a new node instead.

There is no node-delete operation. A blocked or unwanted node is either amended
into useful work, superseded by later work, or left pending: a green last test
completes the run whether or not abandoned nodes remain.

### 2.2 Post-execution review

A review turn runs in the same planner conversation after a node's gate passes.
It receives the gate verdict, the node instruction/hints/approach/phase, the
out-of-hint changed paths, and the concise cumulative diff. It returns:

- `approve` — the node settles `passed`;
- one `amend "<current>"` record — the node reopens and executes again.

A review reply may not add nodes or amend other nodes; follow-up work belongs to
the next planning turn. The review is a verdict, not a second planning pass.

The **fast path** skips the review model call when the gate passed, the node has
hints, every changed path is hinted, the diff is not truncated, and the diff is
non-empty. It is enabled by default and can be disabled with `--review always`
when every passing node should get a review turn.

Review uses the same planner conversation, so the reviewer already has the
requirement and graph. A malformed reply gets its diagnostics back; the loop
stops on approve, a repeated rejected reply, a repeated amend/diff, or the USD
cost budget. Review calls count toward the USD cost budget and are tracked
separately from planning turns.

## 3. Plan DSL

The fence-form rationale is owned by [`edit-protocol.md`](edit-protocol.md) §2
“Syntax-form design notes”; the plan DSL uses the same bare `TC_EDIT_BEGIN` /
`TC_EDIT_END` line markers.

The planner emits a flat block DSL, not JSON. Every record is independent: no
nesting, no JSON fallback, and no legacy Stage/Task/Edit mode.

```bnf
<reply>       ::= [ <header> ] <record>*
<header>      ::= "plan" [ <id> ] NL [ "goal:" <text> NL ]
<record>      ::= <node> | <amend>

<node>        ::= "node" <id> [ "after" <id>+ ] "verify" <verify> NL
                  "instruction:" <text> NL
                  <node-field>*
                  "end" NL

<amend>       ::= "amend" <id> NL
                  <amend-field>*
                  "end" NL

<node-field>  ::= <hint>
                | "after" ( <id>+ )? NL
                | "approach:" <text> NL
                | "phase:" <text> NL

<amend-field> ::= "after" ( <id>+ )? NL
                | "verify" <verify> NL
                | "instruction:" <text> NL
                | <hint>
                | "hint clear" NL
                | "approach:" <text> NL | "approach clear" NL
                | "phase:" <text> NL | "phase clear" NL

<hint>        ::= "hint file" <path> NL
                | "hint" <space> <symbol> "in" <path> NL

<id>          ::= '"' DIGIT DIGIT DIGIT* "-" (LOWER | DIGIT)+ ( "-" (LOWER | DIGIT)+ )* '"'
<verify>      ::= "tsc" | "test"
<space>       ::= "value" | "type" | "namespace"
<path>        ::= NONSPACE+
<symbol>      ::= NONSPACE+
<line-text>   ::= { any character except newline }+
<fence>       ::= "TC_EDIT_BEGIN" NL <raw-lines> NL "TC_EDIT_END"
<raw-lines>   ::= ? raw text; each sentinel marker is a whole line with optional
                    leading/trailing whitespace; no raw line may trim to exactly
                    TC_EDIT_END; the first exact close line ends the fence ?
<text>        ::= <line-text> | NL <fence> | <fence> ? inline opener after the
                    label ?
```

Rules:

- The `plan` header is optional on later replies and required only in the sense
  that the initial reply must carry `goal:`. The header has no `end`. A legacy
  quoted plan-root id after `plan` is accepted and ignored; the run has no
  plan-root id. The run goal is fixed by the initial reply; a later `goal:` is
  ignored.
- `NodeId` matches `/^[0-9]{2,}-[a-z0-9]+(?:-[a-z0-9]+)*$/`. Work-node ids are
  globally unique.
- `after` may appear on the node header or as a body field, not both. On the
  header it takes one or more quoted ids; as a body field it may be empty.
- `verify` is required on a `node` header and is `tsc` or `test`.
- `instruction:` is required once in a `node`. `approach:` and `phase:` are
  optional and may appear at most once. Fields may appear in any order after
  `instruction:`.
- `goal:`, `instruction:`, `approach:`, and `phase:` accept one-line text or a
  following sentinel fence. The opener may also share the label line when it is
  the last token; the raw body still starts on the next line. The fence body is
  raw, so hyphen runs, backtick runs, `done`, and `end` are ordinary lines; it
  must be non-empty after trimming, and only an exact `TC_EDIT_END` line closes
  it (there is no escape).
- `hint file <path>` creates `{path, symbol: "", kind: "file"}`;
  `hint <space> <symbol> in <path>` creates a symbol hint. Duplicate hints are
  rejected. Hints are advisory.
- `amend` has no header `verify`; any replacement field may appear in the body.
  At least one field is required.
- Legacy `stage`, `task`, `edit`, `patch`, `node+`, `node~`, `node-`, and
  `finish` are rejected with `PLAN_LEGACY_RECORD`. There is no dual mode.

### 3.1 Initial plan example

```text
plan
goal: Make the failing test pass.

node "02-answer" verify test
instruction: Make the failing test green.
hint value answer in src/helper.ts
end
```

A greenfield module can start with a compiling skeleton and a later
implementation node. The approach hint recommends scaffold-then-fill; the
executor may follow or override it:

```text
plan
goal: Implement the workbook module.

node "02-scaffold" verify tsc
instruction: Create a compiling skeleton for src/workbook.ts with the exported types and stub bodies.
hint file src/workbook.ts
approach: Write the top-level declarations and stub bodies first; fill bodies later with targeted edits.
phase: scaffold
end

node "03-impl" after "02-scaffold" verify test
instruction: Implement evaluate and keep the suite green.
hint value evaluate in src/workbook.ts
hint type CellResult in src/workbook.ts
phase: implement
end
```

### 3.2 Branching DAG

Independent work may be ready at the same time. Record order is the tie-break:

```text
plan
goal: Add the parser and its formatter.

node "02-contract" verify tsc
instruction: Define the parser and formatter types and stub bodies.
hint file src/parser.ts
hint file src/format.ts
end

node "03-parser" after "02-contract" verify tsc
instruction: Implement the parser functions.
hint value parseValue in src/parser.ts
end

node "04-format" after "02-contract" verify tsc
instruction: Implement the formatter functions.
hint value formatValue in src/format.ts
end

node "05-final" after "03-parser" "04-format" verify test
instruction: Wire the entry point and keep the suite green.
hint value parseFile in src/parser.ts
end
```

### 3.3 Append and amend examples

A later planning turn appends work:

```text
node "05-final" after "03-impl" verify test
instruction: Wire the final entry point and keep the suite green.
hint value parseFile in src/parser.ts
end
```

It repairs a failed node in place:

```text
amend "03-impl"
instruction: Repair the return path the last gate reported; keep the module surface unchanged.
end
```

It can clear advisory fields:

```text
amend "03-impl"
after
hint clear
approach clear
phase clear
end
```

A review reply is only a verdict:

```text
approve
```

or one amend for the reviewed node:

```text
amend "03-impl"
instruction: Apply the review repair; do not add work.
end
```

## 4. Validation, tolerant parsing, and diagnostics

### 4.1 Validation and apply

Both initial plans and later replies pass through one apply layer:

- ids are `NN-slug` strings and globally unique;
- `after` edges are duplicate-free, non-self, non-dangling, and acyclic; cycle
  diagnostics name every node in the cycle;
- `verify` is `tsc` or `test`;
- instructions are non-empty (≤4,000 chars); `approach` (≤2,000) and `phase`
  (≤200) are non-empty when present;
- the run goal is non-empty (≤1,000 chars);
- hint paths are safe: no absolute path, `..`, hidden/build segment, or `human/`;
- hints are duplicate-free; a file hint uses `symbol: ""` and `kind: "file"`;
  a symbol hint uses `value`, `type`, or `namespace` and a non-empty symbol;
- append ids are unused; a passed node is immutable; a review reply may amend
  only the reviewed node and may not append;
- an amend must change at least one field;
- a reply is all-or-nothing: a rejected reply leaves the previous state and
  workspace untouched.

There is no fixed node-count cap and no per-turn node cap. Growth is bounded by
the USD cost budget and the driver's no-progress detection.

Status is harness-owned. The planner never emits `todo`, `pending`, `passed`,
`blocked`, or a status map.

### 4.2 Tolerant parsing contract

Both DSLs use the same parser discipline: **recover structure to diagnose, but
never apply a partial destructive result**.

```ts
type DslIssue = {
  severity: "error" | "warning";
  code: string; // PLAN_MISSING_END, EDIT_MATCHER_MISSING, ...
  stage:
    | "syntax"
    | "structure"
    | "protocol"
    | "plan-protocol"
    | "plan-graph"
    | "address"
    | "matcher"
    | "range";
  message: string;
  line: number;
  column: number;
  excerpt?: string;
  expected?: string[];
  found?: string;
  hint?: string;
  recovered: boolean;
  recordId?: string;
  clauseIndex?: number;
};

type DslParseResult<T> = {
  ok: boolean;
  value?: T; // best-effort parse, for diagnostics only when ok=false
  issues: DslIssue[]; // errors and warnings, bounded by the renderer
  truncated: boolean; // reply ended mid-record/fence
};
```

Rules shared by the plan DSL and the edit-action reply language:

- CRLF, blank lines, and indentation are ignored where the grammar is line
  oriented.
- A whole-reply Markdown fence is stripped when it unambiguously wraps the
  entire reply and its first content line is a plan/record/edit keyword; this
  produces a warning (`PLAN_WHOLE_REPLY_FENCE` or `EDIT_WHOLE_REPLY_FENCE`),
  not a silent success. This **outer wrapper** is separate from the edit-action
  sentinel fence ([`edit-protocol.md`](edit-protocol.md) §2).
- A missing closing `end` is recovered at EOF or before the next sibling
  record/statement header, but only when the boundary is unambiguous; it is a
  warning, not a rejection, when the remaining fields are valid.
- An unclosed sentinel fence is recovered at EOF for diagnostics; the reply is
  rejected.
- Truncation is reported as `truncated`; the reply is rejected.
- Unknown fields/parameters are reported with the nearest valid alternatives;
  they are not silently ignored.
- Duplicate ids are reported with the duplicate location.
- Case/whitespace normalization is limited to unambiguous keywords; never guess
  a different action, target, path, symbol, or dependency.
- A reply is all-or-nothing; valid records are still parsed so the diagnostic
  can list every problem.

Plan-specific recovery:

- Accept a bare `NN-slug` id where the grammar expects a quoted id, with a
  warning; quote it internally.
- Accept the outer Markdown wrapper around a complete reply.
- A missing `goal:` on the initial reply or a missing `instruction:` on a node
  is an error.
- A legacy Stage/Task/Edit record, `patch`, `node+~-`, or `finish` gets
  `PLAN_LEGACY_RECORD` with a hint to use `node`/`amend`; it is never translated.

### 4.3 Diagnostics format

Every plan or edit-action diagnostic rendered to the model has:

- a `stage:` header using the parser vocabulary: `plan-protocol` or `plan-graph`
  for the plan DSL, and `syntax`, `address`, `matcher`, or `range` for the
  edit-action reply language;
- a stable `code:` line;
- `severity: warning` for a recovered issue (errors omit the line);
- a `message:` line;
- `at line <line>:<column>` plus a short numbered excerpt with a caret;
- `expected:` alternatives and `found:` token when useful;
- one-line `hint:` with the minimal repair;
- the record id / clause index when known;
- a bounded list (default: first 8 issues plus a count), never the full reply.

Shipped `PLAN_*` error codes: `MISSING_END`, `MISSING_FIELD`, `UNKNOWN_FIELD`,
`UNKNOWN_PARENT`, `DUPLICATE_ID`, `CYCLE`, `STRUCTURE`, `LEGACY_RECORD`,
`BARE_ID`, `WHOLE_REPLY_FENCE`, `UNCLOSED_FENCE`, `MALFORMED_FENCE`,
`LEGACY_FENCE`, `FENCE_TRAILING_TEXT`, `EMBEDDED_FENCE_END`, `TRUNCATED`. The
edit-action `EDIT_*` family is owned by [`edit-protocol.md`](edit-protocol.md)
§2 and §5.

The same renderer is used for plan and edit-action diagnostics so the model sees
one stable shape. Warnings are surfaced on `LoopResult.warnings`; only errors
block application.

## 5. Scheduling

The harness schedules WorkNodes; the model never chooses the next node from a
status map.

1. If the run has no plan: ask for the initial plan.
2. Apply and validate the reply.
3. Compute ready nodes: status `pending`, not blocked, and every `after`
   dependency `passed`. Record order is the deterministic tie-break.
4. Execute one node: the executor applies its chosen edits; the node gate runs
   after every applied reply. A passing gate finishes execution; a failing gate
   returns diagnostics for another attempt. A repeated fingerprint or the USD
   cost budget ends the node as `failed`.
5. On a passing gate, the fast path or one review turn decides:
   - `approve`: finalize the node as `passed`;
   - `amend`: validate, reopen the node, execute again, gate again.
6. If no node is ready and the last gate is a passing `test` → success.
7. Otherwise the planner appends work or amends pending/failed work; repeat.

A failed dependency blocks its dependents. Blocked is derived; the scheduler
reports blocked nodes without inventing a status. A blocked dependent never runs
while the failure stands; the planner either amends the dependency or appends
independent work. Cycles are rejected during validation, so the scheduler cannot
hang on one.

Run success requires:

- no node is ready;
- the most recent gate is a passing `test`.

Earlier failed nodes and blocked pending nodes do not keep the run open once the
suite is green. A node that is still executing or in review keeps the run open
because the driver has not settled it yet.

## 6. Mode contexts

### 6.1 Planning

1. system: role, functional style, recommended workflow, read-only viewer
   grammar, flat plan DSL, and approach guidance;
2. user: `# Requirement`, `# Symbol index`, spec files;
3. incremental turns: the current work graph, statuses, failed-node diagnostics,
   blocked reason, and a fresh symbol index;
4. the planner emits an initial plan or one reply with `node`/`amend` records.

The planning conversation persists across incremental turns. A planner may make
read-only `select`/`read` viewer requests before every plan reply. There is no
arbitrary per-turn viewer count: each view consumes the USD cost budget, and a
repeated identical view or no-progress cycle forces the plan reply. Viewers never
write.

The planner owns the decomposition, `after` edges, `verify`, `instruction`,
`hints`, and optional `approach`/`phase`. It does not choose a preselected edit;
the executor owns the concrete actions.

### 6.2 Review

A review turn runs in the same planner conversation after a node's gate passes.
It receives the passing gate, the current node instruction/hints/approach/phase,
the paths changed outside the hints, and the cumulative applied diff. It returns
`approve` or one `amend` for the current node.

There is no fixed review-turn or format-retry cap. A malformed review reply gets
its diagnostics back; the loop stops on approve, a repeated rejected reply, a
repeated amend/diff, or the USD cost budget. The review prompt stays short: it
does not repeat the full requirement, full source, or full plan grammar.

Call usage is recorded in three `LoopTokens` buckets — `planning`, `review`, and
`execution` — and exposed as `LoopResult.usage`. Their sum is
`LoopResult.tokens`, and all three count toward the run USD cost budget. The
`typescript-coder-result@3` subagent result keeps its single `tokens` object and
does not expose the per-bucket split or recovered warnings.

### 6.3 Execution

1. system: role, functional style, the advisory editing-technique knowledge
   base, and the edit-action grammar (stable for the node);
2. user: `# Work node` with the instruction, hints, optional approach/phase,
   prior diagnostics, and the current source views;
3. per attempt: the same node prompt is re-issued with the latest gate or
   rejection diagnostics, read/viewer feedback, and refreshed source views.

Each node starts a fresh execution conversation. Source views show the hinted
files and declarations, numbered by file-absolute lines. The executor may use
`read` to inspect more source. Execution deliberately does not receive the
requirement or test files (knowledge isolation); the node instruction must be
self-contained.

## 7. Execution details

### 7.1 Execution reply surface

The executor owns the concrete actions and granularity. The grammar, coverage
matrix, and resolution cascade are owned by
[`edit-protocol.md`](edit-protocol.md). One reply may carry one or more edit-dsl
clauses and/or file commands. Hints and `approach` are advice, not an allowlist.

After an applied reply the driver tracks whole-file `write`s per work node. On
the next executor turn it adds a separate `# Edit strategy advisory` when the
write replaced an existing file of at least 120 lines (a soft heuristic) or when
the node writes the same file as a whole file again without an intervening
targeted edit. The advisory is guidance only: it does not change records,
status, gate results, or termination. It does not fire for a new file's first
write or for a targeted `modify`/`create`/`delete`/`rename` edit. A targeted edit
resets the repeat tracking, and there is no fixed cap.

The hard application guardrail stays: each clause in one reply must resolve to a
different declaration `(path, symbol, kind)`. Multiple edits to one declaration
are split across replies, even with different `match`/`pick` spans.

### 7.2 Applying a reply

1. Parse the reply with the edit-action parser. A parse failure writes nothing.
2. Resolve every clause against the pre-reply source snapshot with
   `resolveMultiEditor`; any non-`no-op` resolution failure rejects the whole
   reply. A `no-op` clause is inert: when another clause still applies, the
   reply applies the rest and surfaces an ignored-clause warning in the next
   prompt's feedback and the run warnings; an all-inert reply is a `no-op`
   rejection.
3. Apply editor regions with `applyResolvedRegions` (overlap, prev-broken, parse
   gate, duplicate-declaration guard, formatter, no-op guard).
4. Prepare whole-file `write` commands separately: parse and format the
   replacement, then include it in the atomic write set.
5. Write all changed files, create empty files, apply declaration/member and
   module-boundary insertions, and delete files only after every guard passed.
   Nothing is written on a rejection.
6. A variable edit is addressed at its declarator; a whole-symbol edit on a
   multi-declarator statement or destructuring binding is rejected rather than
   rewriting a sibling.

A reply that carries only viewers or reads writes nothing; its feedback becomes
the next attempt's prompt. A reply that produces no source change is a no-op
rejection, not an applied exchange.

### 7.3 Node gates

Every node has a gate that runs after **every applied reply**:

- `verify: "tsc"` runs the check command (default `bunx tsc --noEmit`);
- `verify: "test"` runs the check command and then the test suite.

A passing gate finishes node execution and enters review. A failing gate returns
its formatted diagnostics to the next execution attempt; the node stays
`pending`. The gate is the only place a type/test failure becomes executor
diagnostics. There is no separate advisory check and no implicit whole-graph test
outside node gates.

### 7.4 Progress and termination

There is no fixed exchange, read, review, viewer, planning-round, or per-turn
node cap. A node stops in one of these ways:

- its gate passes;
- a repeated reply/source/diagnostics fingerprint shows no progress;
- the run USD cost budget is exceeded;
- the provider errors.

Each stage keeps one repeat fingerprint over the reply, workspace, and
diagnostics. Read-only replies are exempt from the ordinary fingerprint: `read`
is an inspection tool and may be repeated until the budget runs out, except that
an identical viewer against an unchanged workspace is a protocol rejection.
Rejected and applied replies participate in the fingerprint.

The driver also keeps one run-level fingerprint of the graph, statuses, gate
history, and workspace. Returning to the same fingerprint after a full driver
cycle is `task-exhausted`. A planner reply that leaves the graph, statuses, and
gate history unchanged is rejected as no progress.

### 7.5 Applied diff

The harness snapshots the workspace source files when a node first starts and
keeps that baseline keyed by **node id** across amend/retry. Review receives only
changed files and changed hunks with a few lines of context, capped so a large
rewrite cannot flood the prompt. Deleted and newly created files are visible.
Out-of-hint changed paths are named explicitly so review can confirm the
instruction required them. Because the baseline persists, review sees the
node's whole history, not only the latest attempt. There is no rollback: applied
writes stay, and the gate decides whether the node settles.

## 8. Termination and caps

The planner is re-invoked when:

- a node cannot progress (repeated fingerprint, so it is marked `failed`);
- no node is ready and the last gate is not a passing `test`;
- a reply is structurally rejected and the retry repeats;
- the graph needs final work.

Caps:

| Limit                     | Value                    |
| ------------------------- | ------------------------ |
| Plan goal length          | 1,000 chars              |
| Instruction length        | 4,000 chars              |
| Approach length           | 2,000 chars              |
| Phase length              | 200 chars                |
| USD cost budget           | $0.10 default            |
| Node/exchange/review caps | none (budget + progress) |

Failure paths use the existing termination matrix plus `task-exhausted`; plan-exec
does not make a termination-summary model call. `task-exhausted` covers a node
that stops making progress, a planning turn whose repeated reply cannot produce
usable work, a review that cannot approve or produce a new amend, and a run that
returns to an earlier graph/workspace fingerprint. Provider errors keep their own
path. Plan-exec does not use the pinned-repair output-limit cap; a truncated reply
is handled by the parser and retried with diagnostics.

## 9. CLI and result

```sh
tc --mode plan-exec < issue.txt
tc --agent-mode plan-exec < issue.txt
tc --mode plan-exec --review always < issue.txt
```

`--mode` / `--agent-mode` and the `AgentMode` vocabulary are defined in
[`feedback-loop.md`](feedback-loop.md). Plan-exec-specific constraints:

- Plan-exec execution replies are edit-dsl statements.
- Text stdout names the work-node summary and applied files; `--format json`
  prints `typescript-coder-result@3`.
- `LoopResult.nodes` carries one `NodeSummary` per node in record order:
  `id`, `verify`, `status`, and optional `phase`/`approach`. `status` is
  `pending`, `passed`, or `failed`; a node stays `pending` while it executes and
  `review` is a driver phase, not a result status.
  `terminationReason` can be `task-exhausted`.
- `LoopResult.usage` splits a plan-exec run's spend into `planning`, `review`,
  and `execution` `LoopTokens` buckets; their sum is `LoopResult.tokens`, and
  all three count toward the budget.
- `LoopResult.turns` adds model-call telemetry (`planning`, `execution`,
  `review`, `total`) without changing `records`/`steps`.
- `LoopResult.executionMessages` carries optional per-attempt executor
  transcripts; it is not embedded in the benchmark Markdown report.
- `LoopResult.warnings` carries recovered parser warnings.
- `LoopResult.explanation` is `null` for plan-exec termination; the diagnostics
  are the explanation and no extra model call is made.

The node-summary change is a breaking result-schema change;
`typescript-coder-result@3` is shipped. `@2` carried per-edit Stage/Task/Edit
summaries; the historical `@1` schema used numeric task/edit ids.

## 10. Limitations

- **No JSON plan fallback.** The flat plan DSL replaces the JSON plan parser.
  Old plan-exec replay bundles containing JSON plan replies or `finish`/patch
  records will not replay; there are no committed bundles, but historical ones
  need manual conversion.
- **Result schema @3.** `LoopResult.nodes` replaces `LoopResult.tasks`.
  Consumers of `@2` task/edit summaries must migrate; the status union is now
  `pending`/`passed`/`failed`.
- **No node delete and no finish.** Work is appended or amended; abandoned
  pending nodes are ignored once the last test is green. A planner that needs to
  cancel ready work should amend that node into useful work.
- **Review is a verdict.** It cannot add follow-up work; the next planning turn
  owns new nodes.
- **Anonymous and object-literal member creates are deferred.** Named
  class/interface/namespace/enum members are created with the kind-aware
  `create` statement; call/construct/index signatures and object-literal members
  are not.
- **Imports/exports use a file-level owner.** `select file … replace` edits one
  existing import/export statement or specifier, and `create import|export`
  inserts one statement after the shebang, directives, and existing imports.
- **Rename is same-file.** Cross-file renames need caller edits first, or
  escalation.
- **Planner inspection is budget-bounded.** The planner sees the signature index
  and spec files, and may make read-only `select`/`read` viewer requests.
- **Passed nodes are immutable.** Later work goes in a new node.
- **Intermediate type errors are expected between replies.** An applied reply may
  leave the file type-broken; the node gate is the type-correct boundary, and the
  next attempt receives its diagnostics.
- **Test-file edits are allowed but discouraged.** The planner prompt treats
  `*.test.ts` as specification; a requirement that asks for test changes still
  needs them.
- **Incremental planning is not free.** Each node has planning/review overhead;
  the per-node cost must be weighed against the reduced full-tree output and
  better recovery.
- **Hints are advisory.** The executor may edit outside them; review sees the
  diff and the explicit out-of-hint list instead of a hard target guard.

## 11. As-built implementation notes

1. **Three statuses, derived completion:** `pending`/`passed`/`failed`;
   `review` is a driver phase. Success is "no ready node + last gate is a passing
   `test`", not a `finish` marker.
2. **One mutation:** `amend` a pending, failed, or just-reviewed node; append
   otherwise. Passed nodes are immutable; there is no delete.
3. **Review model:** post-gate verdict in the same planner conversation;
   `approve` or one `amend` for the current node; a changed node reopens and goes
   through the gate/review again. An in-hint, untruncated diff is auto-approved
   without a model call.
4. **Single provider wrapper:** one `ask` checks the budget before and after the
   call, accounts one bucket, and turns provider errors into a tagged stop.
   Termination never makes a summary call.
5. **Persistent diff baseline:** keyed by node id, so review sees the node's
   whole history across an amend or retry.
6. **Progress:** one stage-repeat fingerprint plus one run-level graph/workspace
   fingerprint; no fixed cap.
7. **Result schema:** `typescript-coder-result@3`, with `nodes` summaries.
8. **Functional policy:** hard prompt ban on new classes; existing classes are
   minimal targeted edits, and a named member `create` is valid when it is the
   smallest change.
9. **Execution application:** edit-dsl clauses and file commands apply
   atomically through the shared resolver/commit pipeline; the
   one-declaration-per-reply guardrail is hard.
10. **Driver modules:** `src/task-loop.ts` owns scheduling, node execution,
    gates, review, and the final result; `src/prompts/task.ts` owns all
    planner/executor/review prompt text.

## 12. Verification

- `bun test src/tasks.test.ts` — contract, ids, refs, edges, hint paths,
  scheduling, completion, amend application, and immutability.
- `bun test src/plan-dsl.test.ts` — grammar, fences, node/amend replies,
  tolerant recovery, issue codes, and all-or-nothing parsing.
- `bun test src/prompts/task.test.ts` — planning, execution, and review prompt
  shape; workflow and editing-technique guidance; WorkNode examples; no fixed
  caps.
- `bun test src/edit-dsl.test.ts` / `src/selection.test.ts` — tolerant statement
  boundaries, unclosed fences, matcher/pick/rename diagnostics, per-statement
  issues, no partial writes.
- `bun test src/task-loop.test.ts` — initial/replan scheduling, ready order,
  blocked dependents, executor autonomy, out-of-hint diff, gates and retries,
  review auto-approval and amend reopen, no-progress, USD cost budget, planner
  inspection, multi-node append, and completion.
- `bun test src/result.test.ts src/main.test.ts src/cli.test.ts` —
  `typescript-coder-result@3` node summaries and text/JSON output.
- `just typecheck && just test`.
- `just accept` (offline), including the `plan-exec-fix-answer` and
  `plan-exec-write-fix-answer` scenarios driven by the WorkNode DSL.
- This verification is offline; it makes no benchmark or live-model claim.
