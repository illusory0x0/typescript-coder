# Plan → execute → review loop

Status: **implemented.** This document describes the plan-exec loop.
[`src/tasks.ts`](../src/tasks.ts) and [`src/plan-dsl.ts`](../src/plan-dsl.ts)
are the source of truth for the core model and wire grammar; the driver and
prompts are [`src/task-loop.ts`](../src/task-loop.ts) and
[`src/prompts/task.ts`](../src/prompts/task.ts).

Canonical ownership: this document owns the Plan/WorkNode DAG model, target and
approach hints, the flat Plan DSL and patch DSL, planning, validation/merge,
scheduling, plan-exec execution context, gates, plan-exec-specific limits, and the
plan-exec CLI, result, limitations, implementation, and verification.
[`feedback-loop.md`](feedback-loop.md) owns the shared loop lifecycle, AgentMode
routing, round/exchange policy, retry/termination, shared caps, and
records/result. [`edit-protocol.md`](edit-protocol.md) owns the edit-action reply
language, select clause/file command grammar, resolution cascade,
application/gating, and repair feedback. Vocabulary is canonical in
[`README.md`](README.md).

The loop is **additive**. `--mode pinned-repair` (default) keeps the single-target
Edit → Verify driver byte-identical ([`feedback-loop.md`](feedback-loop.md)).
`--mode plan-exec` runs the Plan → Execute → Review flow over a task-level work
graph:

- **Plan** — the root: `id`, `goal`, and flat `nodes`;
- **WorkNode** — the planning and execution unit: `id`, `after` dependency ids,
  `verify`, `instruction`, target `hints`, and optional `approach` / `phase`
  guidance.

The planner owns the decomposition, dependency edges, verification boundaries,
instructions, and hints. The executor owns the concrete edit actions and their
granularity: it sees the current source, may choose `modify` / `create` /
`delete` / `rename` / `write`, `match` / `pick` / range / whole-declaration, and
multiple clauses per reply. The harness owns status, scheduling, gates, and
review. Hints and `approach` are guidance, not hard constraints.

Implementation map:

| Concern                                       | File                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Plan/WorkNode contract, validator, scheduler  | `src/tasks.ts`                                                                                   |
| Flat Plan DSL and patch DSL parser/serializer | `src/plan-dsl.ts`                                                                                |
| Planning/execution/review prompt text         | `src/prompts/task.ts`                                                                            |
| Driver, scheduling, apply/verify, review      | `src/task-loop.ts`                                                                               |
| Dispatch (`--mode`)                           | `src/loop.ts`                                                                                    |
| CLI flag                                      | `src/cli.ts`, `src/main.ts`                                                                      |
| Tests                                         | `src/tasks.test.ts`, `src/plan-dsl.test.ts`, `src/prompts/task.test.ts`, `src/task-loop.test.ts` |

## 1. Core model

The model is a task-level DAG, not a Stage/Task/Edit hierarchy:

```text
Plan
└── WorkNode[]   (edges: WorkNode.after)
```

```ts
type Plan = {
  id: NodeId; // globally unique string id
  goal: string; // root goal
  nodes: WorkNode[]; // record order is the readiness tie-break
};

type WorkNode = {
  id: NodeId;
  after: NodeId[]; // dependency node ids; empty means ready at the start
  verify: "tsc" | "test"; // the node gate
  instruction: string; // self-contained local goal for the executor
  hints: HintLoc[]; // advisory target hints; never a hard allowlist
  approach?: string; // advisory strategy, e.g. scaffold then fill bodies
  phase?: string; // optional workflow label; not a scheduling input
};

type HintLoc = {
  path: string; // repo-relative, writable
  symbol: string; // declared name; empty for a file hint
  kind: "value" | "type" | "namespace" | "file"; // symbol space, or file
};

type NodeId = string; // "01-main", "02-scaffold", "03-impl", ...
```

All node ids — Plan and WorkNode — share one namespace and are globally unique.
The `NN-` prefix is for readability only; readiness is decided by `after` edges,
with record order as the deterministic tie-break. A node may depend on a node
declared later in the same reply; validation only requires that the id exists.

The harness tracks node status internally:

```ts
type NodeStatus = "pending" | "in-progress" | "review" | "passed" | "failed";
```

`review` means the node's gate has finished, but the planner's post-execution
review has not approved the result yet. `in-progress` means the executor holds
the node. Neither is terminal. A failed dependency blocks its dependents; blocked
is **derived** from status and edges, not stored as a sixth status. There is no
`deferred` status because deferred work is simply not inserted into the graph.

`finalNodeId: NodeId | null` is harness state. It is set by the `finish` control
and must point at the last node in record order. That node must verify `test`.
Run success requires `finalNodeId` to be passed and every node to be terminal
(`passed` or `failed`). Earlier failed nodes are allowed when later work
supersedes them.

`kind` is a **symbol space**, not a declaration keyword. It matches the edit-dsl
`resolve` vocabulary; the declaration keyword (`function`, `const`, …) is
discovered from the index.

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
hint. The executor may override it from the current source. Validation and review
do not require adherence. Canonical examples:

- a small requirement on a small file may justify one whole-file write;
- a large greenfield module should scaffold top-level declarations and stub
  bodies first, then fill bodies with targeted edits;
- an existing large file often needs targeted edits, though a whole-file rewrite
  remains valid when the change is broad or a targeted edit would be riskier.

The planner recommends a workflow (inspect → contract → scaffold → implement →
verify) but does not impose it. A single node, a linear chain, and a branching DAG
are all valid shapes.

### 1.3 Editing decision guide

The executor owns the action and granularity. It chooses from the source it sees;
the guidance below is advisory, and `write` is always valid. No edit is rejected
merely for its size or shape.

- **New file or skeleton:** write the whole file, or create it and add the
  top-level declarations with `create <kind> <name> in <path> with <fence> end`.
- **Local edit in an existing file:** prefer a `match`/`pick` or a
  single-declaration `select … replace`; a whole-file rewrite discards unchanged
  code.
- **Several related declarations in one file:** edit each declaration, splitting
  replies when one declaration would repeat; a small, tightly coupled file may
  still be clearest as one whole-file write.
- **Large declaration rewrite:** rewrite only that declaration and leave the
  file's other declarations untouched.
- **Import/export statement:** use `create import|export in <path> with <fence> end`
  to add one, or `select file <path> [ match … ] [ pick … ] replace with <fence>
  end` to edit or delete an existing statement or specifier. No whole-file write
  is required; a file-level rename is unsupported.
- **Whole-file rewrite of an existing file:** valid when the change touches most
  of the file or a targeted edit would be riskier than the rewrite; there is no
  hard size or shape rejection.
- **Recovery after a failed or unhelpful whole-file write:** read the diagnostics
  first and repair the named declarations with a targeted edit; repeat the
  whole-file write only when the diagnostics show broad structural breakage.

The executor carries a small, growing knowledge base of techniques: a whole-file
write for a simple small file; scaffold a large module, then fill bodies; a
parallel `xxV1` refactor, test, swap call sites, then clean up. Techniques are
composable advice, not gates. A planner `approach` may name one, and the executor
may override it.

### 1.4 Functional style

Planner and executor prefer ML-style functional TypeScript:

- data + functions over classes and prototypes;
- top-level functions with explicit parameters and return types;
- tagged unions with a string-literal `tag`, tuples, and plain records;
- small, named helper functions; a thin orchestrator calling them;
- no new `class`, inheritance, `super`, implicit `this`, private state,
  getters/setters, or class-based state machines;
- existing classes: minimal targeted edits; a named member `create` is valid
  when it is the smallest change.

The planner decides helper decomposition. A single-file change does **not** need
several nodes; one node is valid when its gate can pass. Do not split work just to
make the graph look more parallel.

The prompt style block is:

```text
Prefer ML-style functional TypeScript:
- Data + functions over classes and prototypes.
- Model data with type aliases, tagged unions (string-literal tag), tuples, and
  plain records.
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
| Token budget       | 120,000     |

There is no WorkNode count cap in the DSL parser or graph validator, and no
fixed per-turn node cap. Plan growth is bounded by the model's token budget and
the driver's repeated/no-progress detection, not by an arbitrary node count. The
driver has no fixed exchange, viewer, review, or planning-round cap; the token
budget and repeated fingerprints bound a run.

## 2. Incremental planning protocol

Planning, review, and execution are separate turns:

```text
1. Initial Plan: Plan + one or more ready WorkNodes (a node may depend on a node
   declared later in the same reply, as long as the graph stays acyclic).
2. Structural validation by the harness.
3. The harness picks ready nodes in record order and executes one node. After
   each applied executor reply, the node gate runs; the node enters review once
   its gate result is known.
4. Planner post-execution review runs only after a passing gate and receives the
   gate result and a concise diff of the applied work.
   -> approve
   -> or a patch.
5. If the review returns a patch: validate it; if it changes the current node,
   the node reopens and executes again, then passes through review again. The
   loop stops on approve, the token budget, or a repeated patch/diff
   fingerprint. If it approves: finalize the node as `passed`.
6. If finalNodeId passed and every node is terminal: success.
7. Otherwise the planner emits a patch for the remaining work:
     - node+ for any number of new ready nodes;
     - node~ to repair/redefine a pending, failed, or review node;
     - node- to remove pending/failed work that is no longer wanted;
     - a final test node followed by finish.
8. Repeat from step 2.
```

A planning turn may add one or more new nodes. There is no fixed node count or
per-turn batch cap; the token budget and no-progress detection bound growth. New
nodes may be ready immediately or depend on existing or newly added nodes. The
initial Plan may declare the whole DAG or only the work that is ready now; neither
shape is preferred by the contract.

The planner may make read-only edit-protocol viewer requests before a Plan/patch:
`select ... end` (optionally with `within <selecters>`), or `read ... end`
(optionally with `within`). A viewer writes nothing; the harness returns the
indentation-folded source or exact slice in a `# Source view` message, then asks
for the Plan/patch again. There is no arbitrary request count: each viewer
consumes the token budget, and a repeated identical view or no-progress cycle
forces the Plan/patch reply. Planner viewer requests are not Plan records and do
not create, edit, or delete files.

The recommended workflow is **inspect → contract → scaffold → implement →
verify**:

- inspect the requirement, index, and source;
- settle the public contract (types, signatures, data shapes);
- scaffold declarations and stub bodies for a large module;
- implement behavior in node-sized work;
- finish with a `test` node marked by `finish`.

This is guidance. A one-node plan is valid when its gate can pass; a branching
DAG is valid when two pieces of work are genuinely independent.

The planner may end the run by planning a final `test` node and emitting
`finish`. `finish` marks the last node as `finalNodeId`; that node must verify
`test`. When the final test fails, both in-place repair and a new final node are
allowed:

- **in-place repair (default):** `node~` the final node while it remains last;
  `finish` and `finalNodeId` stay unchanged;
- **new final:** append a repair/final test node and emit `finish` again; the
  previous final node becomes an earlier failed node.

Any node appended after `finalNodeId` requires a new `finish` on the new last
node. A passed node remains immutable.

### 2.1 Post-execution review

Review runs only after a node's gate passes. The node enters `review` and a
review turn in the same planner conversation checks the result. It receives:

- the passing gate (`tsc` / `test`) and its diagnostics (normally empty);
- a concise diff of the applied work, not full files;
- the current node instruction, hints, approach, and phase;
- any changed paths outside the hints.

The review checks:

- the diff implements the node instruction and contains no unrelated edits;
- edits outside the hinted paths are justified by the instruction and visible;
- no new class, no heavy OOP; named member creates are valid;
- helper decomposition is reasonable and symbols resolve;
- after a failed gate, prefer a targeted repair of the named declarations;
  repeat a whole-file write only for broad structural breakage (advice, not a
  gate);
- if `finish` is present, the final node is last and verifies `test`.

The review reply is either `approve` or a patch. Review uses the same planner
conversation in its own turn, not a fresh reviewer. There is no fixed review-turn
or format-retry cap: a malformed reply gets its diagnostics back, and the loop
stops on approve, the token budget, or a repeated patch/diff fingerprint. A
review patch may repair the current node, its hints, or its dependencies, add
follow-up work, or carry `finish` for the current final node. The harness
structurally validates the patch; if it changes the current node, the node
reopens and executes again and goes through review again. If the current node is
unchanged, its passing gate stands. Review calls count toward the token budget
and are tracked separately from planning turns.

## 3. Flat Plan DSL

The planner emits a flat block DSL, not JSON. Every record is independent. No
nesting, no JSON fallback, and no legacy Stage/Task/Edit mode.

```bnf
<plan-reply>  ::= "plan" <id> NL
                  "goal:" <text> NL
                  <node>*
                  [ "finish" NL ]

<node>        ::= "node" <id> [ "after" <id>+ ] "verify" <verify> NL
                  "instruction:" <text> NL
                  <node-field>*
                  "end" NL

<node-field>  ::= <hint>
                | "after" ( <id>+ )? NL
                | "approach:" <text> NL
                | "phase:" <text> NL

<hint>        ::= "hint file" <path> NL
                | "hint" <space> <symbol> "in" <path> NL

<id>          ::= '"' DIGIT DIGIT DIGIT* "-" (LOWER | DIGIT)+ ( "-" (LOWER | DIGIT)+ )* '"'
<verify>      ::= "tsc" | "test"
<space>       ::= "value" | "type" | "namespace"
<path>        ::= NONSPACE+
<symbol>      ::= NONSPACE+
<line-text>   ::= { any character except newline }+
<fence>       ::= "<<<TC_EDIT_BEGIN>>>" NL <raw-lines> NL "<<<TC_EDIT_END>>>"
<raw-lines>   ::= ? raw text; each sentinel marker is a whole line with optional
                    leading/trailing whitespace; no raw line may trim to exactly
                    <<<TC_EDIT_END>>>; the first exact close line ends the
                    fence ?
<text>        ::= <line-text> | NL <fence> | <fence> ? inline opener after the label ?
```

Rules:

- The Plan header is a singleton; it has no `end`. Every `node` record ends with
  `end`.
- `NodeId` matches `/^[0-9]{2,}-[a-z0-9]+(?:-[a-z0-9]+)*$/`: two or more digits,
  a hyphen, then a lowercase kebab slug (`"01-main"`, `"03-impl"`). The Plan root
  and every WorkNode share one namespace.
- `after` may appear on the node header or as a body field, not both. On the
  header it takes one or more quoted ids; as a body field it may be empty (no
  dependencies). Ids may refer to nodes declared later in the same reply, as long
  as the graph stays acyclic.
- `verify` is required on a `node` header and is `tsc` or `test`.
- `instruction:` is required once. `approach:` and `phase:` are optional and may
  appear at most once. Fields may appear in any order after `instruction:`.
- `goal:`, `instruction:`, `approach:`, and `phase:` accept one-line text or a
  following sentinel fence. The opener may also share the label line when it is
  the last token; the raw body still starts on the next line. The fence body is
  raw, so hyphen runs, backtick runs, `done`, and `end` are ordinary lines; it
  must be non-empty after trimming, and only an exact `<<<TC_EDIT_END>>>` line
  closes it (there is no escape). The same sentinel `<fence>` production is used
  by the edit-action reply; [`edit-protocol.md`](edit-protocol.md) §2 owns the
  canonical fence rules. Legacy hyphen/backtick fences are rejected
  (`PLAN_LEGACY_FENCE`).
- `hint file <path>` creates `{path, symbol: "", kind: "file"}`;
  `hint <space> <symbol> in <path>` creates a symbol hint. Duplicate hints are
  rejected. Hints are advisory.
- `finish`, when present, must be the last line and marks the last node final;
  that node must verify `test`.
- Legacy `stage`, `task`, `edit`, and their `+` / `~` / `-` patch forms are
  rejected with `PLAN_LEGACY_RECORD`. There is no dual mode.

### 3.1 Initial Plan example

```text
plan "01-main"
goal: Make the failing test pass.

node "02-answer" verify test
instruction: Make the failing test green.
hint value answer in src/helper.ts
end

finish
```

A greenfield module can start with a compiling skeleton and a later
implementation node. The approach hint recommends scaffold-then-fill; the
executor may follow or override it:

```text
plan "01-main"
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

finish
```

### 3.2 Branching DAG

Independent work may be ready at the same time. Record order is the tie-break:

```text
plan "01-main"
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

finish
```

## 4. Patch DSL

A patch is the only re-plan / incremental planning output. It is applied to a
clone of the current graph, then validated by the same merge rules.

```bnf
<patch-file>   ::= "patch" NL <patch-op>*
<patch-op>     ::= <node-add> | <node-update> | <node-remove> | "finish" NL

<node-add>     ::= "node+" <id> [ "after" <id>+ ] "verify" <verify> NL
                   "instruction:" <text> NL
                   <node-field>*
                   "end" NL

<node-update>  ::= "node~" <id> NL
                   <update-field>*
                   "end" NL

<update-field> ::= "after" ( <id>+ )? NL
                 | "verify" <verify> NL
                 | "instruction:" <text> NL
                 | <hint>
                 | "hint clear" NL
                 | "approach:" <text> NL
                 | "approach clear" NL
                 | "phase:" <text> NL
                 | "phase clear" NL

<node-remove>  ::= "node-" <id> NL "end" NL
```

Semantics:

- `node+` appends a new node; `after` may be on the header or a body field.
  `instruction:` is required, `verify` is required, hints/approach/phase are
  optional. A patch may add any number of nodes; the token budget and run
  no-progress detection bound growth.
- `node~` replaces only the fields present and preserves omitted fields.
  `after` present replaces the whole dependency list; `after` with no ids clears
  it. One or more `hint` lines replace the whole hint list; `hint clear` clears
  it. `approach:` / `phase:` replace the text; `approach clear` / `phase clear`
  clear the optional field. `instruction:` and `verify` replace their values.
- `node-` removes a node only when its status is `pending` or `failed`. A blocked
  node is pending and may be removed. A `passed`, `review`, or `in-progress`
  node cannot be removed.
- A passed node is immutable. A failed node reopens only when its definition
  changes; otherwise it stays closed so later work can supersede it. A review
  node reopens pending when a review patch changes it. An in-progress node is
  held until it finishes.
- Existing nodes keep their record order; new nodes are appended. Removing a
  node that another node still names in `after` leaves a dangling edge and is
  rejected; update or remove the dependent first.
- `finish` may appear at the end of a patch and sets `finalNodeId` to the last
  merged node, which must verify `test`. If a patch adds work after the old final
  node, it must emit a new `finish` for the new last node.
- A patch is all-or-nothing: a malformed op rejects the whole patch, and a
  rejected merge leaves the previous state untouched.
- Before a patch is applied, the graph must still satisfy id uniqueness,
  target-hint path rules, and the acyclic `after` rule.

### 4.1 Repair patch

```text
patch
node~ "03-impl"
instruction: Keep the final test node; repair only the parser return expression.
hint value parseValue in src/parser.ts
end
```

### 4.2 Add branching work

```text
patch
node+ "06-formatter" after "02-contract" verify tsc
instruction: Add the formatter as an independent branch.
hint value formatValue in src/format.ts
approach: Reuse the existing formatter helpers; this file is small.
end
```

### 4.3 Remove pending work

```text
patch
node- "07-unused"
end
```

### 4.4 Clear advisory fields

```text
patch
node~ "03-impl"
after
hint clear
approach clear
phase clear
end
```

## 5. Validation, tolerant parsing, and diagnostics

### 5.1 Validation and merge

Both initial Plan replies and patches pass through one graph validator:

- ids are `NN-slug` strings and globally unique across the Plan and WorkNodes;
- `after` edges are duplicate-free, non-self, non-dangling, and acyclic; cycle
  diagnostics name every node in the cycle;
- `verify` is `tsc` or `test`;
- instructions are non-empty (≤4,000 chars); `approach` (≤2,000) and `phase`
  (≤200) are non-empty when present;
- the Plan goal is non-empty (≤1,000 chars);
- hint paths are safe: no absolute path, `..`, hidden/build segment, or `human/`;
- hints are duplicate-free; a file hint uses `symbol: ""` and `kind: "file"`;
  a symbol hint uses `value`, `type`, or `namespace` and a non-empty symbol;
- `finish`, when present, marks the last node, and that node verifies `test`;
- passed nodes are immutable; removed nodes must be pending or failed; new nodes
  append after existing nodes; record order is preserved;
- a node may not change identity: repair it with `node~` or add a new id.

The graph validator imposes no fixed node-count cap and no per-turn node cap.
The token budget and the driver's repeated/no-progress detection bound plan
growth.

Status is harness-owned. The planner never emits `todo`, `pending`, `passed`,
`blocked`, or a status map.

### 5.2 Tolerant parsing contract

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

Rules shared by the Plan DSL and the edit-action reply language:

- CRLF, blank lines, and indentation are ignored where the grammar is line
  oriented.
- A whole-reply Markdown fence is stripped when it unambiguously wraps the
  entire reply and its first content line is a Plan, patch, or edit-action
  statement keyword; this produces a warning (`PLAN_WHOLE_REPLY_FENCE` or
  `EDIT_WHOLE_REPLY_FENCE`), not a silent success. This **outer wrapper** is
  separate from the edit-action sentinel fence
  ([`edit-protocol.md`](edit-protocol.md) §2): it wraps the whole reply and is
  not part of a statement or a replacement body.
- A missing closing `end` is recovered at EOF or before the next sibling
  record/statement header, but only when the record/statement boundary is
  unambiguous; it is a warning, not a rejection, when the remaining fields are
  valid. The per-form edit-action rules are owned by
  [`edit-protocol.md`](edit-protocol.md) §2.
- An unclosed sentinel fence is recovered at EOF for diagnostics; the reply is
  rejected.
- Truncation is reported as `truncated`; the reply is rejected.
- Unknown fields/parameters are reported with the nearest valid alternatives;
  they are not silently ignored.
- Duplicate ids are reported with the duplicate location.
- Case/whitespace normalization is limited to unambiguous keywords; never
  guess a different action, target, path, symbol, or dependency.
- Invalid view-only statements may still produce feedback; invalid
  editor/write statements reject the whole reply and write nothing. The
  edit-action split is owned by [`edit-protocol.md`](edit-protocol.md) §2 and
  §4.
- A patch is all-or-nothing: a malformed op rejects the whole patch. Valid ops
  are still parsed so the diagnostic can list every problem.
- An initial Plan reply is all-or-nothing: a malformed record rejects the plan.
  Incremental planning still does not insert a partial plan.
- A review reply is all-or-nothing: `approve`, or one fully valid patch. A
  malformed review reply returns its diagnostics and is retried until the token
  budget or a repeated patch/diff fingerprint ends the turn.

Plan-specific recovery:

- Accept a bare `NN-slug` id where the grammar expects a quoted id, with a
  warning; quote it internally.
- Accept `plan`/`patch` headers surrounded by the outer wrapper (the rule
  above).
- A missing `goal:` or `instruction:` is an error; the plan/patch is rejected.
- A `finish` without a last `test` node is an error with the exact last node and
  its verify value; a line after `finish` is an error.
- A legacy Stage/Task/Edit record gets `PLAN_LEGACY_RECORD` with a hint to use
  flat node records; it is never translated.

Edit-action recovery and its `EDIT_*` codes are owned by
[`edit-protocol.md`](edit-protocol.md) §2 and §5.

### 5.3 Diagnostics format

Every Plan or edit-action diagnostic rendered to the model has:

- a `stage:` header using the parser vocabulary: `plan-protocol` or `plan-graph`
  for the Plan DSL, and `syntax`, `address`, `matcher`, or `range` for the
  edit-action reply language;
- a stable `code:` line;
- `severity: warning` for a recovered issue (errors omit the line);
- a `message:` line;
- `at line <line>:<column>` plus a short numbered excerpt with a caret;
- `expected:` alternatives and `found:` token when useful;
- one-line `hint:` with the minimal repair;
- the record id / clause index when known;
- a bounded list (default: first 8 issues plus a count), never the full reply.

Plan recovery warning example (the missing `end` was recovered, not rejected):

```text
stage: plan-protocol
code: PLAN_MISSING_END
severity: warning
message: missing "end" for node "03-impl" before the next record; recovered at the record boundary
at line 12:1
  11 | node "03-impl" verify test
  12 | node "04-final" after "03-impl" verify test
   | ^
expected: end
hint: close node "03-impl" with end before starting node "04-final"
```

This warning does not reject the reply: the parser repairs the unambiguous
record boundary and records the warning on `LoopResult.warnings`. The `message:`
prose is representative, while the `stage`/`code`/`severity` shape is stable.

Cycle example:

```text
stage: plan-graph
code: PLAN_CYCLE
message: after edges form a cycle: #02-a -> #03-b -> #04-c -> #02-a
at line 4:1
expected: an acyclic after graph
hint: break the cycle by removing one after edge and re-planning
```

The Plan parser reports syntax/protocol failures as `stage: plan-protocol` and
graph validator failures as `stage: plan-graph`; the edit-action reply language
reports `stage: syntax` for clause syntax and `address`, `matcher`, or `range`
for the matching cascade stage. Both use the same `renderDslIssues` renderer in
`src/dsl-diagnostics.ts`.

Shipped `PLAN_*` error codes: `MISSING_END`, `MISSING_FIELD`, `UNKNOWN_FIELD`,
`UNKNOWN_PARENT`, `DUPLICATE_ID`, `CYCLE`, `FINISH_NOT_LAST`, `STRUCTURE`,
`LEGACY_RECORD`, `BARE_ID`, `WHOLE_REPLY_FENCE`, `UNCLOSED_FENCE`,
`MALFORMED_FENCE`, `LEGACY_FENCE`, `FENCE_TRAILING_TEXT`,
`EMBEDDED_FENCE_END`, `TRUNCATED`. The edit-action `EDIT_*` family is owned by
[`edit-protocol.md`](edit-protocol.md) §2 and §5.

The same renderer is used for plan and edit-action diagnostics so the model sees
one stable shape. Warnings are surfaced on `LoopResult.warnings`; only errors
block application.

## 6. Scheduling

The harness schedules WorkNodes; the model never chooses the next node from a
status map.

1. If the Plan is empty: ask for the initial Plan.
2. Validate the reply.
3. Compute ready nodes: status `pending`, not blocked, and every `after`
   dependency `passed`. Record order is the deterministic tie-break. If several
   nodes are ready, the first in record order runs first.
4. Execute one node: the executor applies its chosen edits; the node gate runs
   after every applied reply. A passing gate finishes execution; a failing gate
   returns diagnostics for another attempt. A repeated fingerprint or the token
   budget ends the node as `failed`.
5. Planner post-execution review receives the passing gate and concise diff:
   - `approve`: finalize the node as `passed`;
   - a patch: validate it; if it changes the current node, reopen and execute it
     again, then review again.
6. If `finalNodeId` passed and every node is terminal → success.
7. Otherwise the planner emits a patch:
   - `node+` any number of new ready nodes;
   - `node~` a repair/redefinition of a pending, failed, or review node;
   - `node-` pending/failed work that is no longer wanted;
   - a final test node + `finish`.
8. Repeat from step 3.

A failed dependency blocks its dependents. Blocked is derived, so the scheduler
reports blocked nodes without inventing a status for them. A blocked dependent
never runs while the failure stands; the planner either repairs the dependency,
repoints the edge with `node~`, or removes the dependent or dependency with
`node-` as the merge rules allow. Cycles are rejected during validation, so the
scheduler cannot hang on one.

Run success requires:

- `finalNodeId` is set;
- the final node is last in record order and verifies `test`;
- the final node passed;
- every node is terminal (`passed` or `failed`).

Earlier failed nodes are allowed when later work supersedes them and the final
test passes. A node in `review` or `in-progress`, or a still-pending blocked node,
keeps the run open.

A patch may add any number of nodes. Run growth is bounded by the token budget and
the driver's repeated/no-progress detection, not by a fixed node count.
Patches may update or remove multiple existing nodes.

## 7. Mode contexts

### 7.1 Planning

1. system: role, functional style, recommended workflow, read-only viewer
   grammar, flat Plan/patch DSL, and approach guidance;
2. user: `# Requirement`, `# Symbol index`, spec files;
3. incremental turns: the current work graph, statuses, failed-node diagnostics,
   blocked reason, and a fresh symbol index;
4. the planner emits an initial Plan or one incremental patch. A patch may add
   any number of nodes, update/remove pending or failed nodes, adjust any node
   field, and mark the final test node with `finish`.

The planning conversation persists across incremental turns. A planner may make
read-only `select`/`read` viewer requests before every Plan/patch. There is no
arbitrary per-turn viewer count: each view consumes the token budget, and a
repeated identical view or no-progress cycle forces the Plan/patch reply. Viewers
never write.

The planner owns the decomposition, `after` edges, `verify`, `instruction`,
`hints`, and optional `approach`/`phase`. It does not choose a preselected edit;
the executor owns the concrete actions.

### 7.2 Review

A review turn runs in the same planner conversation after a node's gate passes.
It receives the passing gate, the current node instruction/hints/approach/phase,
the paths changed outside the hints, and the concise applied diff. It returns
`approve` or a patch.

There is no fixed review-turn or format-retry cap. A malformed review reply gets
its diagnostics back; the loop stops on approve, the token budget, or a repeated
patch/diff fingerprint. A review patch may repair the current node, its hints, or
its dependencies, add follow-up work, or carry `finish` for the current final
node. If it changes the current node, the node reopens, executes again, and goes
through review again. If the current node is unchanged, its passing gate stands.
The review prompt stays short: it does not repeat the full requirement, full
source, or full Plan grammar.

Call usage is recorded in three `LoopTokens` buckets — `planning`, `review`, and
`execution` — and exposed as `LoopResult.usage`. Their sum is
`LoopResult.tokens`, and all three count toward the run token budget. The
`typescript-coder-result@3` subagent result keeps its single `tokens` object and
does not expose the per-bucket split or recovered warnings.

### 7.3 Execution

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

## 8. Execution details

### 8.1 Execution reply surface

The executor owns the concrete actions and granularity. One reply may carry one
or more edit-dsl clauses and/or file commands:

- `select … end` with `replace`, `rename`, `match`, `pick`, or a viewer slice;
- `select file <path> [ match … ] [ pick … ] replace with <fence> end` for one
  existing import/export statement or specifier (a file-level editor, not a
  viewer or rename);
- `create <path> end`, `delete <path> end`, `read <path> [within …] end`;
- `create [static] <kind> <name> in <path> with <fence> end` for one named
  top-level declaration or one member of an existing class/interface/namespace/
  enum (a dotted `Owner.name`; the owner must already exist);
- `create import|export in <path> with <fence> end` for one module-boundary
  statement, inserted after the shebang, directives, and existing imports;
- `write <path> with <fence>` for a whole-file replacement.

Hints and `approach` are advice, not an allowlist. The executor may edit outside
the hinted paths when the instruction requires it, may choose a whole-file write
or a targeted declaration edit, and may override the approach. Review receives
the full changed-path diff and an explicit out-of-hint list.

After an applied reply the driver tracks whole-file `write`s per work node. On
the next executor turn it adds a separate `# Edit strategy advisory` when the
write replaced an existing file of at least 120 lines (a soft heuristic) or when
the node writes the same file as a whole file again without an intervening
targeted edit. The advisory names the observed line counts and suggests a
targeted `match`/`pick` or a single-declaration rewrite. It is guidance only: it
does not change records, status, gate results, or termination. It does not fire
for a new file's first write or for a targeted
`modify`/`create`/`delete`/`rename` edit. A targeted edit resets the repeat
tracking, and there is no fixed cap.

The hard application guardrail stays: each clause in one reply must resolve to a
different declaration `(path, symbol, kind)`. Multiple edits to one declaration
are split across replies, even with different `match`/`pick` spans. Kind-aware
creates are separate statements: several creates for distinct declarations may
share a reply, a member create inserts into an existing owner, and a dotted
create never creates its owner. Module-boundary creates are separate statements
too; several distinct import/export statements may share a reply, but a module
create cannot share a path with a file-level select, write, delete, or empty-file
create.

Addresses are declaration-level and may be dotted: namespace and class members
as before, interface/type-literal members (`Cell.getValue`), enum members
(`Color.Red`), object-literal members owned by a declared variable or class field
(`config.timeout`, `config.server.port`), and named default exports by their
declared name. Anonymous default exports, computed member names, class static
blocks, class index signatures, and constructor parameter properties have no
synthetic name and are owner + `match`/`pick`/regex targets; call/construct/index
signatures on interfaces and type literals work the same way. Object-literal
methods are named (`config.run`); a getter/setter pair shares `config.value` and
needs the object owner plus `match`/`pick` for one accessor. A top-level `using`
binding is addressed with an omitted kind because `using` is not a `select` kind
token. A class auto-accessor is not structurally modeled; use the class owner
with `/regex/` or `pick` for its text. Overloads,
declaration merges, and duplicates never resolve to a silent first declaration:
the address is rejected with each candidate named, unless an explicit `kind`
disambiguates a cross-space merge. A whole-symbol edit on a multi-declarator or
destructuring binding is rejected because it would rewrite siblings; use a
per-binding `match`/`pick` span instead.

Structural `match` is best-effort across the owner contexts documented in
[`edit-protocol.md`](edit-protocol.md) §3 (top-level statement, class member,
interface/type member, object-literal member, function/loop/switch/generator/async
body, and type expression). Ambiguous structural and regex matches list each
candidate's `line:column` and source line and never pick the first; a standalone
decorator is reached through its owner with a member snippet or with `/regex/`/
`pick`. Regex and `pick` remain first-class fallbacks, and
`src/matcher-corpus.test.ts` proves at least one selector path per covered
declaration/member/module form (with explicit expected failures for unsupported
or ambiguous forms).

Imports and exports are the exception: they have no declaration address. A
`select file` clause owns one existing statement or specifier, and a module
create adds one new statement. Both use the same parse/format/atomic-apply path;
a file-level select never falls back to a whole-file write, and a file-level
rename is rejected.

#### Declaration coverage map

The full matrix is the **Declaration coverage matrix** in
[`edit-protocol.md`](edit-protocol.md) §2; this is the compact planning view.
`whole-symbol` is the indexed declaration span, `match` is a structural snippet,
`/regex/` is a regex locator, and `pick` is a line/point/range selector. Rows
marked **expected failure** are deliberate.

| Form / owner | Address | Selectors / create |
| ------------ | ------- | ------------------ |
| Top-level function, `const`/`let`/`var`/`using`, class, interface, type alias, enum, namespace | `select [kind] NAME`; `using` uses an omitted kind | whole-symbol, `match`, `/regex/`, `pick`; kind-aware `create` (new classes stay prompt-forbidden) |
| Class method/property/getter/setter | `Widget.member` | whole-symbol, `match`, `/regex/`, `pick`; `create method`, `create property`, `create getter`, `create setter`, or `create accessor`; a getter/setter pair is ambiguous, so use the class owner + `match`/`pick` |
| Class constructor, static block, computed member, index signature, parameter property, auto-accessor | Owner: `select class Widget` | Owner + `match`/`/regex/`/`pick`; auto-accessor is `/regex/` or `pick` only (**expected failure** for structural); `create constructor` only |
| Interface/type-literal named method/property | `Cell.getValue`; `Snapshot.value` | whole-symbol, `match`, `/regex/`, `pick`; `create method` or `create property` with an interface owner; type-literal member create is deferred |
| Interface/type-literal call, construct, index signature | Owner: `select interface Cell` or `select type Fn` | Owner + `match`/`/regex/`/`pick`; create deferred |
| Namespace/enum member | `Util.helper`; `Color.Red` | whole-symbol, `match`, `/regex/`, `pick`; dotted `create <kind>` or `create enum-member` |
| Object-literal property/method/getter/setter | `config.timeout`; `config.run`; a getter/setter pair shares `config.value` | whole-symbol, `match`, `/regex/`, `pick` for a named member; accessor pair via the object owner + `match`/`pick`; create deferred |
| Named/anonymous default export | Declared name (`boot`, `App`); anonymous via `select file PATH` | whole-symbol, `match`, `/regex/`, `pick`; module `create export` |
| Imports/exports | `select file PATH` | File-level `match`/`/regex/`/`pick`; `create import` or `create export`; no file-level rename |
| Overloads/merges | `select <kind> NAME` | Overloads are rejected-with-candidates; an explicit kind disambiguates a cross-space merge; an omitted kind over a merge is rejected-with-candidates |
| Multi-declarator/destructuring binding | `select const first`; `select const a` | Per-binding `match`/`/regex/`/`pick`; whole-symbol replace/delete is **expected failure** |
| Ambiguous/unsupported structural match | Any owner above | Ambiguous `match` is rejected-with-candidates, then `pick` or a longer snippet; a standalone decorator needs a member-inclusive `match` or `/regex/`/`pick` (**expected failure**) |

### 8.2 Applying a reply

1. Parse the reply with the edit-action parser. A parse failure writes nothing.
2. Resolve every clause against the pre-reply source snapshot with
   `resolveMultiEditor`; any resolution failure rejects the whole reply.
3. Apply editor regions with `applyResolvedRegions` (overlap, prev-broken, parse
   gate, duplicate-declaration guard, formatter, no-op guard).
4. Prepare whole-file `write` commands separately: parse and format the
   replacement, then include it in the atomic write set.
5. Write all changed files, create empty files for `create <path> end`, apply
   declaration/member and module-boundary insertions, and delete files for
   `delete` only after every guard passed. Nothing is written on a rejection.
6. A variable edit is addressed at its declarator; a whole-symbol edit on a
   multi-declarator statement or destructuring binding is rejected rather than
   rewriting a sibling. A named-member edit replaces only the member span; an
   empty-fence delete also removes its `,`/`;` separator. A rename keeps its
   binding span. `export` modifier differences are tolerated in both directions.

A reply that carries only viewers or reads writes nothing; its feedback becomes
the next attempt's prompt. A reply that produces no source change is a no-op
rejection, not an applied exchange.

### 8.3 Node gates

Every node has a gate that runs after **every applied reply**:

- `verify: "tsc"` runs the check command (default `bunx tsc --noEmit`);
- `verify: "test"` runs the check command and then the test suite.

A passing gate finishes node execution and enters review. A failing gate returns
its formatted diagnostics to the next execution attempt; the node stays
`in-progress`. The gate is the only place a type/test failure becomes executor
diagnostics. There is no separate advisory check and no implicit whole-graph test
outside node gates.

### 8.4 Progress and termination

There is no fixed exchange, read, review, viewer, planning-round, or per-turn
node cap. A node stops in one of these ways:

- its gate passes;
- a repeated reply/source/diagnostics fingerprint shows no progress;
- the run token budget is exceeded;
- the provider errors.

Repeated read-only replies are exempt from the no-progress fingerprint: `read`
is an inspection tool and may be repeated until the budget runs out. Rejected and
applied replies participate in the fingerprint. A failed node's dependents are
blocked; independent ready nodes may still run before the planner is asked for a
repair.

### 8.5 Applied diff

The harness snapshots the workspace source files when a node starts. Review
receives only changed files and changed hunks with a few lines of context, capped
so a large rewrite cannot flood the prompt. Deleted and newly created files are
visible. Out-of-hint changed paths are named explicitly so review can confirm the
instruction required them.

## 9. Termination and caps

The planner is re-invoked when:

- a node cannot progress (repeated fingerprint);
- a node gate fails and no independent work remains;
- no node is runnable but the final node has not passed;
- a patch or review is structurally rejected and cannot be corrected;
- the graph needs final work or `finish`.

Caps:

| Limit                     | Value                    |
| ------------------------- | ------------------------ |
| Plan goal length          | 1,000 chars              |
| Instruction length        | 4,000 chars              |
| Approach length           | 2,000 chars              |
| Phase length              | 200 chars                |
| Token budget              | 120,000 default          |
| Node/exchange/review caps | none (budget + progress) |

Growth is bounded by the token budget, repeated/no-progress fingerprints, and the
DSL/safety validation. There is no 3-exchange, 1-viewer, 1-review, 32-round, or
3-consecutive-length cap in plan-exec. The 120-line whole-file advisory heuristic
is not a cap: it never rejects an edit or ends a node.

Failure paths use the existing termination matrix plus `task-exhausted`; the run
still makes one summary call. `task-exhausted` covers a node that stops making
progress, a planning turn whose repeated reply cannot produce a valid Plan/patch,
and a review that cannot approve or produce a new patch. Provider errors keep
their own path. Plan-exec does not use the pinned-repair output-limit cap; a
truncated reply is handled by the parser and retried with diagnostics.

## 10. CLI and result

```sh
tc --mode plan-exec < issue.txt
tc --agent-mode plan-exec < issue.txt
```

`--mode` / `--agent-mode` and the `AgentMode` vocabulary are defined in
[`feedback-loop.md`](feedback-loop.md). Plan-exec-specific constraints:

- `plan-exec` rejects `--targets` (single-target JSON loop) and
  `--protocol-format json` (execution is edit-dsl); `edit-dsl` and the default
  are accepted.
- `--multi-payload` is irrelevant in `plan-exec` (execution replies are
  edit-dsl statements).
- Text stdout names the work-node summary and applied files; `--format json`
  prints `typescript-coder-result@3`.
- `LoopResult.nodes` carries one `NodeSummary` per node in record order:
  `id`, `verify`, `status`, and optional `phase`/`approach`. `status` is
  `pending`, `in-progress`, `review`, `passed`, or `failed`.
  `terminationReason` can be `task-exhausted`.
- `LoopResult.usage` splits a `plan-exec` run's spend into `planning`,
  `review`, and `execution` `LoopTokens` buckets; their sum is
  `LoopResult.tokens`, and all three count toward the budget.
  `LoopResult.warnings` carries recovered parser warnings.

The node-summary change is a breaking result-schema change;
`typescript-coder-result@3` is shipped. `@2` carried per-edit Stage/Task/Edit
summaries; the historical `@1` schema used numeric task/edit ids.

## 11. Limitations

- **No JSON plan fallback.** The flat Plan DSL replaces the JSON plan parser.
  Old `plan-exec` replay bundles containing JSON plan replies will not replay;
  none are currently in the repo, but historical bundles need this caveat. v1
  does **not** ship a JSON-to-DSL migration tool; manual offline conversion is
  possible but out of scope.
- **Result schema @3.** `LoopResult.nodes` replaces `LoopResult.tasks`. Consumers
  of `@2` task/edit summaries must migrate.
- **Anonymous and object-literal member creates are deferred.** Named
  class/interface/namespace/enum members are created with the kind-aware
  `create` statement; call/construct/index signatures and object-literal members
  are not. New classes remain forbidden by prompt policy, not by create
  validation.
- **Imports/exports use a file-level owner.** `select file … replace` edits one
  existing import/export statement or specifier, and `create import|export`
  inserts one statement after the shebang, directives, and existing imports.
  A file-level rename is not supported: imported bindings and export aliases
  have no declaration address, so the statement text must be edited. A module
  create cannot share a reply with a file-level select, write, delete, or
  empty-file create on the same path.
- **Rename is same-file.** It inherits the existing renamer's scope (declaration
  plus same-file references). Cross-file renames need caller edits first, or
  escalation.
- **Planner inspection is budget-bounded.** The planner sees the signature index
  and spec files, and may make read-only `select`/`read` viewer requests. It does
  not have write tools or arbitrary command execution. Repeated identical views
  force the Plan/patch reply.
- **Passed nodes are immutable.** A failed node reopens only when its definition
  changes; a passed node cannot be extended, so later work goes in a new node.
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

## 12. As-built implementation notes

Shipped design decisions:

1. **No fixed driver caps:** node execution, review, planner viewers, and
   planning rounds are bounded by the token budget and repeated/no-progress
   fingerprints.
2. **Review model:** post-execution review only after a passing gate, in the same
   planner conversation; gate result + concise diff + out-of-hint paths; approve
   or a patch; a changed node reopens and goes through review again.
3. **Final test repair:** both in-place repair and a new final node are allowed;
   in-place repair is the default. Any work appended after the old final node
   requires a new `finish` on the new last test node.
4. **Result schema:** `typescript-coder-result@3`, with `nodes` summaries.
5. **Plan root:** required `plan.id` and `plan.goal`.
6. **Multi-node patches:** a patch may add any number of nodes and update/remove
   pending or failed nodes; passed nodes are immutable.
7. **JSON compatibility:** no runtime JSON fallback and no migration tool in
   v1; old plan-exec replay bundles with JSON plan replies are incompatible and
   need manual conversion if retained.
8. **Functional policy:** hard prompt ban on new classes; existing classes are
   minimal targeted edits, and a named member `create` is valid when it is the
   smallest change.
9. **Execution application:** edit-dsl clauses and file commands apply
   atomically through the shared resolver/commit pipeline; the
   one-declaration-per-reply guardrail is hard.
10. **Review token tracking:** record `planning`, `review`, and `execution`
    usage buckets; all count toward the run budget.
11. **Driver modules:** `src/task-loop.ts` owns scheduling, node execution,
    gates, review, and the final result; `src/prompts/task.ts` owns all
    planner/executor/review prompt text.
12. **Edit strategy advisory:** the executor prompt carries a situation-aware
    decision guide plus the advisory techniques; the driver adds a non-blocking
    `# Edit strategy advisory` after a large or repeated whole-file write. The
    120-line heuristic is soft, and a failed gate still returns actionable
    diagnostics without rolling back the applied write.

Implementation notes:

- **Review prompt:** `buildTaskReviewPrompt` in `src/prompts/task.ts` sends the
  gate verdict, node instruction/hints/approach, out-of-hint paths, and concise
  applied diff; the shape is pinned by `src/prompts/task.test.ts` and
  `src/task-loop.test.ts`.
- **Usage accounting:** `LoopUsage` and `totalLoopTokens` in `src/loop.ts`
  record `planning`, `review`, and `execution`; the sum drives the budget and is
  returned as `LoopResult.tokens`, with the split on `LoopResult.usage`.
  `src/task-loop.test.ts` covers the buckets and the budget.
- **Tolerant recovery:** `src/dsl-diagnostics.ts` owns the shared renderer;
  `src/plan-dsl.ts` and `src/selection.ts` recover only unambiguous warnings and
  reject a destructive partial result. Tests are `src/plan-dsl.test.ts`,
  `src/edit-dsl.test.ts`, `src/selection.test.ts`, and
  `src/dsl-diagnostics.test.ts`.

## 13. Verification

- `bun test src/tasks.test.ts` — contract, ids, refs, edges, hint paths, finish
  validation, scheduling, and merge rules.
- `bun test src/plan-dsl.test.ts` — BNF, fences, plan/patch replies, node
  operators, `finish`/`finalNodeId` cases, tolerant recovery, issue codes, and
  all-or-nothing patch/plan behavior.
- `bun test src/prompts/task.test.ts` — planning, execution, and review prompt
  shape; workflow and editing-technique guidance; WorkNode examples; no fixed
  caps.
- `bun test src/edit-dsl.test.ts` / `src/selection.test.ts` — tolerant statement
  boundaries, unclosed fences, matcher/pick/rename diagnostics, per-statement
  issues, no partial writes.
- `bun test src/task-loop.test.ts` — initial/patched DAG scheduling, ready order,
  blocked dependents, executor autonomy (multiple clauses/actions, write vs
  targeted, out-of-hint diff), the large/repeated whole-file advisory and its
  non-trigger/reset paths, gate retries, repeated/no-progress, token budget,
  planner inspection, multi-node patches, review reopen, and final test/finish.
- `bun test src/result.test.ts src/main.test.ts src/cli.test.ts` —
  `typescript-coder-result@3` node summaries and text/JSON output.
- `just typecheck && just test`.
- `just accept` (offline), including the `plan-exec-fix-answer` and
  `plan-exec-write-fix-answer` scenarios driven by the WorkNode Plan DSL.
- This verification is offline; it makes no benchmark or live-model claim.
