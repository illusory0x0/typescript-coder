# Plan → execute → review agent loop

Status: **implemented, as-built.** This document describes the shipped
`plan-exec` loop; the code and its tests are the source of truth. It
describes the V3 soft-guidance design and is kept in step with the
implementation.

The loop is **additive**. `--mode pinned-repair` (default) keeps the single-target
Edit → Verify driver byte-identical. `--mode plan-exec` runs the
Plan → Execute → Review flow over this hierarchy:

- **Plan** — the root: `id`, `goal`, and ordered stages;
- **Stage** — a coherent phase: `id`, `plan`, `goal`, and ordered tasks;
- **Task** — the planning and execution unit: `id`, `stage`, `verify`,
  `instruction`, and ordered edits;
- **Edit** — one declaration-level action, or one whole-file write: `id`,
  `task`, loc, action, instruction, optional related targets / rename target.

The harness owns status, scheduling, gates, and verification. The model never
chooses files or commands; it answers structured prompts. Array/record order is
execution order: there are no dependency edges, `todo` lists, or planner-owned
status maps.

Implementation map (as built):

| Concern                                               | File                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Plan contract, tree validator, scheduler              | `src/tasks.ts`                                                                                   |
| Flat Plan DSL and patch DSL parser/serializer         | `src/plan-dsl.ts`                                                                                |
| Planning/execution/review prompt text                 | `src/prompts/task.ts`                                                                            |
| Driver, target guards, apply/verify, incremental loop | `src/task-loop.ts`                                                                               |
| Dispatch (`--mode`)                                   | `src/loop.ts`                                                                                    |
| CLI flag                                              | `src/cli.ts`, `src/main.ts`                                                                      |
| Tests                                                 | `src/tasks.test.ts`, `src/plan-dsl.test.ts`, `src/prompts/task.test.ts`, `src/task-loop.test.ts` |

## 1. Core model

The hierarchy is fixed:

```text
Plan
└── Stage[]
    └── Task[]
        └── Edit[]
```

The Plan is a living tree. The planner does **not** pre-plan all future tasks:
the current Task is planned, executed, and reviewed; only then is the next Task
planned. Stages are also incremental: a new Stage is appended only after the
current Stage has no pending or `review` Task.

```ts
type Plan = {
  id: NodeId; // globally unique string id
  goal: string; // root goal
  stages: Stage[]; // current + completed stages
};

type Stage = {
  id: NodeId;
  goal: string; // planning context for the executor
  tasks: Task[]; // planned tasks only; no deferred placeholders
};

type Task = {
  id: NodeId;
  verify: "tsc" | "test"; // task gate
  instruction: string; // local goal for the whole task
  edits: Edit[]; // one or more, execution order
};

type Edit = {
  id: NodeId;
  loc: Loc;
  action: "modify" | "create" | "delete" | "rename" | "write";
  instruction: string; // self-contained; executor sees no requirement text
  related?: Loc[]; // same-file atomic migration targets (modify only)
  renameTo?: string; // required iff action === "rename"
};

type Loc = {
  path: string; // repo-relative, writable
  symbol: string; // declared name (or the top-level name a create adds); empty for write
  kind: "value" | "type" | "namespace" | "file"; // symbol space, or file for write
};

type NodeId = string; // "01-main", "02-stage-parser", ...
```

All node ids — Plan, Stage, Task, Edit — share one namespace and are globally
unique. The `NN-` prefix is for readability only; execution order is record
order, not lexical id order.

The harness tracks edit and task status internally:

```ts
type EditStatus = "todo" | "in-progress" | "done" | "failed";
type TaskStatus = "pending" | "review" | "passed" | "failed";
```

`review` means the Task's edits and gate have finished, but the planner's
post-execution review has not approved the result yet. A Task in `review` is
not runnable and not terminal; stage closure waits for it. There is no
`deferred` task status because deferred tasks are not inserted into the tree. A
future Task exists only in the planner's next patch.

`finalTaskId: NodeId | null` is harness state. It is set by the `finish` control
and must point at the last task in the Plan. That task must have `verify: "test"`.
Run success requires `finalTaskId` to be passed and every stage closed.

`kind` is a **symbol space**, not a declaration keyword. It matches the
edit-dsl `resolve` vocabulary; the declaration keyword (`function`, `const`, …)
is discovered from the index.

### 1.1 Create and class-member rule

`create` adds a **top-level declaration** only. A dotted `create` such as
`Parser.parseValue` is rejected during plan validation:

```text
stage: task-tree
- create adds a top-level declaration; "Parser.parseValue" is a class member.
  Modify the class with all needed stubs, then modify the member, or use a
  top-level function.
```

Existing class members may still be targeted by `modify`, `delete`, or `rename`
when they already exist. New code is functional-first: new classes are
forbidden; existing classes are extended only when unavoidable, preferably by
one whole-class `modify` that adds stubs, followed by member `modify` edits.

### 1.2 Functional style

Planner and executor prefer ML-style functional TypeScript:

- data + functions over classes and prototypes;
- top-level functions with explicit parameters and return types;
- tagged unions with a string-literal `tag`, tuples, and plain records;
- small, named helper functions; a thin orchestrator calling them;
- no new `class`, inheritance, `super`, implicit `this`, private state,
  getters/setters, or class-based state machines;
- existing classes: minimal `modify` only, never a dotted `create`.

The planner decides helper decomposition. A single-file change does **not**
need multiple stages or tasks; one Task is valid when its gate can pass. Do not
split work just to make the tree look more parallel.

The prompt style block is:

```text
Prefer ML-style functional TypeScript:
- Data + functions over classes and prototypes.
- Model data with type aliases, tagged unions (string-literal tag), tuples, and
  plain records.
- Implement behavior as top-level functions with explicit parameter and return
  types.
- Extract small helpers when they make the code clearer; do not force a
  stage/task split.
- Do not create new classes, inheritance, `super`, implicit `this`, private
  state, getters/setters, or class-based state machines.
- If an existing class must change, modify it minimally; never create a dotted
  member with `create`.
```

## 2. Incremental planning protocol

Planning, review, and execution are separate turns:

```text
1. Initial Plan: Plan + current Stage + current Task + its edits.
2. Structural validation by the harness.
3. Executor consumes exactly one Task: its edits, then the Task gate. The Task
   enters `review`.
4. Planner post-execution review receives the gate result and a concise diff of
   the applied edits.
   -> approve
   -> or one patch.
5. If the review returns a patch: validate it, reopen the current Task, execute
   it again. There is no second review for that Task.
   If it approves: finalize the Task as `passed` or `failed` from the gate.
6. If finalTaskId passed and all stages are closed: success.
7. Otherwise the planner emits a patch for one next unit:
     - another Task in the current Stage, but only while that Stage is not
       fully passed; a fully passed Stage requires a new Stage with its first
       Task;
     - a new Stage (only after the current Stage has no pending/review Task)
       followed by its first Task;
     - a repair Task/Stage after a failure;
     - a final test Task followed by finish.
8. Repeat from step 2.
```

Only one new Task is planned per planning turn. The planner may plan a repair
Task or the first Task of a new Stage, but not a whole future Task list.

A Stage is **closed** when all of its Tasks are terminal (`passed` or `failed`).
The planner may append the next Stage only when the current Stage is closed. A
new Task may still be added to a non-fully-passed Stage as a repair.

The planner may instead end the run by planning a final Task and emitting
`finish`. `finish` marks the last Task as `finalTaskId`; that Task must verify
`test`. When the final test fails, two repairs are allowed:

- **in-place repair (default):** reopen/repair the final Task while it remains
  last; `finish` and `finalTaskId` stay unchanged;
- **new final:** append a repair Task/Stage and a new final test Task, then
  emit `finish` again; the previous final Task becomes an earlier failed Task.

Any Task appended after `finalTaskId` requires a new `finish` on the new last
Task. A passed Task and a done Edit remain immutable in both paths.

### 2.1 Post-execution review

After every Task's edits and gate, the Task enters `review` and a separate
review turn in the same planner conversation checks the result. It receives:

- the gate result (`tsc` / `test`) and diagnostics;
- a concise diff of the applied edits, not full files;
- the current Task instruction and plan segment.

The review checks:

- the diff implements the Task instruction and contains no unrelated edits;
- a failing gate has an actionable repair;
- no dotted `create`, no new class, no heavy OOP;
- helper decomposition is reasonable and symbols resolve;
- if `finish` is present, the final Task is last and verifies `test`.

The review reply is either `approve` or a patch. Review uses the same planner
conversation in its own turn, not a fresh reviewer. A syntactically malformed
review reply gets one bounded format retry with its diagnostics; a scope or
merge violation still terminates. A review patch may only repair the current
Task (`task~`, `edit+`, `edit~`, `edit-`) and may not add a future Stage/Task.
A done edit is immutable; after a gate failure, append a new repair edit with
`edit+` rather than changing the landed edit.
A review patch may carry `finish` for the current final Task, but may not add
future work. The harness structurally validates the patch; if it returns a
patch, the current Task reopens and executes again, with no second review for
that Task. If it approves, the Task is finalized as `passed` or `failed` from
the gate. Further changes go through the normal repair/replan path. Review
calls count toward the token budget but are additional to the planning-turn
cap.

## 3. Flat Plan DSL

The planner emits a flat block DSL, not JSON. Every record is independent and
references its parent by id. No nesting, no JSON fallback.

```bnf
<plan-reply>  ::= <plan-file> [ "finish" NL ]
<patch-reply> ::= <patch-file> [ "finish" NL ]

<plan-file>   ::= "plan" <id> NL
                  "goal:" <text> NL
                  <stage>*
                  <task>*
                  <edit>*

<stage>       ::= "stage" <id> "plan" <id> NL
                  "goal:" <text> NL
                  "end" NL

<task>        ::= "task" <id> "stage" <id> "verify" <verify> NL
                  "instruction:" <text> NL
                  "end" NL

<edit>        ::= "edit" <id> "task" <id>
                  ( <action> <space> <symbol> "in" <path> | "write" <path> ) NL
                  <related>*
                  [ "renameTo:" <symbol> NL ]
                  "instruction:" <text> NL
                  "end" NL

<related>     ::= "related" <space> <symbol> "in" <path> NL

<id>          ::= '"' DIGIT DIGIT DIGIT* "-" (LOWER | DIGIT)+ ( "-" (LOWER | DIGIT)+ )* '"'
<verify>      ::= "tsc" | "test"
<space>       ::= "value" | "type" | "namespace"
<action>      ::= "modify" | "create" | "delete" | "rename"
<write>       ::= "write" <path>
<path>        ::= NONSPACE+
<symbol>      ::= NONSPACE+
<line-text>   ::= { any character except newline }+
<fence>       ::= <5+ hyphens> NL <raw-lines> NL <same-run-of-hyphens>
                | <6+ backticks> NL <raw-lines> NL <same-run-of-backticks>
<text>        ::= <line-text> | NL <fence>
```

Rules:

- The Plan header is a singleton; it has no `end`. `stage`, `task`, and `edit`
  records each end with `end`.
- `NodeId` matches `/^[0-9]{2,}-[a-z0-9]+(?:-[a-z0-9]+)*$/`: two or more digits,
  a hyphen, then a lowercase kebab slug (`"01-main"`, `"03-task-reader"`). The
  Plan root, stages, tasks, and edits share one namespace.
- The initial Plan reply contains exactly one current Stage and one current
  Task. Later Tasks/Stages are added by patches, one new Task per planning
  turn. The initial planning prompt asks for one or more edits, all task
  records before edit records, and no `finish`; later patches add the
  remaining work. Plan shape is guidance, not a fixed count: a cohesive change
  may be one Stage, one Task, and one edit.
- All stage records come before task records; all task records come before edit
  records. A parent must be declared earlier in the reply or already exist.
- Stage order is stage-record order; task order within a stage is task-record
  order; edit order within a task is edit-record order.
- `goal:` / `instruction:` may be one-line text or a following fence.
- `create` is top-level only; dotted create is rejected.
- `write` targets one whole file: `<path>` only, no space or symbol. Its edit
  loc is `{path, symbol: "", kind: "file"}`; `related` and `renameTo` are
  rejected.
- `related` is allowed only with `modify`; `renameTo` only with `rename`.
- `finish`, when present, must be the last line and marks the last task final.

### 3.1 Initial Plan example

```text
plan "01-main"
goal: Make the failing test pass.

stage "02-current" plan "01-main"
goal: Fix the answer behavior.
end

task "03-first" stage "02-current" verify test
instruction: Make the failing test green.
end

edit "04-change" task "03-first" modify value answer in src/helper.ts
instruction: Change answer to return 2.
end
```

This is the only current Stage and current Task. No future task exists yet.

A cohesive module can use one whole-file edit instead of several declaration
edits:

```text
plan "01-main"
goal: Implement the JSON parser module.

stage "02-current" plan "01-main"
goal: Implement the parser.
end

task "03-parser" stage "02-current" verify test
instruction: Implement src/json.ts so the parser tests pass.
end

edit "04-file" task "03-parser" write src/json.ts
instruction: Write the complete parser module.
end
```

The edit loc is `file "src/json.ts"`; the executor replies with
`write src/json.ts with <fence> done`.

### 3.2 Next Task patch

```text
patch
task+ "05-next" stage "02-current" verify tsc
instruction: Add the next helper and wire it in.
end
edit+ "06-helper" task "05-next" create value parseLiteral in src/helper.ts
instruction: Add a small top-level helper; no class.
end
```

The patch appends to `"02-current"` only while that Stage is not fully passed
(it may still have pending or failed work). Once every Task in the current Stage
has passed, the next unit must be a new Stage with its first Task (§3.3). The
validator enforces the same merge rule.

### 3.3 Next Stage and final test

```text
patch
stage+ "07-next" plan "01-main"
goal: Finish the remaining behavior.
end
task+ "08-final" stage "07-next" verify test
instruction: Run the full behavior and keep the suite green.
end
edit+ "09-final" task "08-final" modify value parseJson in src/helper.ts
instruction: Wire the final entry point; no new class.
end
finish
```

The `finish` marks task `"08-final"` as final; it must be last and verify
`test`.

## 4. Patch DSL

A patch is the only re-plan / incremental planning output. It is applied to a
clone of the current tree, then validated by the same merge rules.

```bnf
<patch-file>  ::= "patch" NL <patch-op>*

<patch-op>    ::= <plan-update>
                | <stage-add> | <stage-update> | <stage-remove>
                | <task-add>  | <task-update>  | <task-remove>
                | <edit-add>  | <edit-update>  | <edit-remove>

<plan-update> ::= "plan~" <id> NL
                  "goal:" <text> NL
                  "end" NL

<stage-add>   ::= "stage+" <id> "plan" <id> NL
                  "goal:" <text> NL
                  "end" NL

<stage-update>::= "stage~" <id> NL
                  [ "goal:" <text> NL ]
                  "end" NL

<stage-remove>::= "stage-" <id> NL "end" NL

<task-add>    ::= "task+" <id> "stage" <id> "verify" <verify> NL
                  "instruction:" <text> NL
                  "end" NL

<task-update> ::= "task~" <id> NL
                  [ "verify" <verify> NL ]
                  [ "instruction:" <text> NL ]
                  "end" NL

<task-remove> ::= "task-" <id> NL "end" NL

<edit-add>    ::= "edit+" <id> "task" <id>
                  ( <action> <space> <symbol> "in" <path> | "write" <path> ) NL
                  <related>*
                  [ "renameTo:" <symbol> NL ]
                  "instruction:" <text> NL
                  "end" NL

<edit-update> ::= "edit~" <id> NL
                  [ ( <action> <space> <symbol> "in" <path> | "write" <path> ) NL ]
                  <related>*
                  [ "renameTo:" <symbol> NL ]
                  [ "instruction:" <text> NL ]
                  "end" NL

<edit-remove> ::= "edit-" <id> NL "end" NL
```

Semantics:

- `+` appends to its parent; `~` replaces present fields and preserves omitted
  fields; `-` removes pending/failed work.
- `stage-` cascades to its tasks/edits; `task-` cascades to its edits. A
  done edit or passed task cannot be removed.
- A task/edit cannot move to a different parent; remove and add with new ids if
  the merge rules allow it.
- `edit~` may be instruction-only for a failed-edit retry, or carry a full
  header to replace its action/loc.
- `finish` may appear at the end of a patch and updates `finalTaskId` to the
  last task. If a patch adds work after the old final task, it must emit a new
  `finish` for the new last task.
- The result must still satisfy the append-order, immutability, node cap, and
  final `test` rules.

### 4.1 Repair patch

```text
patch
task~ "03-answer"
instruction: Keep the final test task; repair only the return expression.
end
edit~ "04-change"
instruction: Replace only the return statement with `return 2;`.
end
```

### 4.2 Remove pending work

```text
patch
edit- "07-object"
end
task- "06-object"
end
stage- "05-repair"
end
```

## 5. Validation, tolerant parsing, and diagnostics

### 5.1 Validation and merge

Both initial Plan replies and patches pass through one validator:

- ids are `NN-slug` strings and globally unique across Plan/Stage/Task/Edit;
- parent refs exist and are declared earlier;
- record order gives sibling order;
- the tree has at most 96 task/edit nodes; stage, task, and edit counts are
  chosen by the planner (no per-stage/task/edit count cap);
- non-empty goals (≤1,000 chars) and instructions (≤4,000 chars);
- safe paths (no absolute path, `..`, hidden/build segment, or `human/`);
- `related` same-file, `modify` only, no duplicates, at most 16;
- `renameTo` only on rename, valid, and different;
- `create` is top-level only; dotted create is rejected;
- `write` uses `kind: "file"`, an empty symbol, a safe path, no `related`, and
  no `renameTo`; every other action uses a `value|type|namespace` loc;
- `finish` marks the last task, and that task verifies `test`;
- done edits and passed tasks are immutable; failed tasks/edits reopen only
  when changed or given new edits; a Task in `review` may be patched by its one
  review turn before it is finalized;
- a new task appends to its stage; a new stage appends after existing stages;
  a new edit appends to its task; a fully passed stage cannot accept new work;
- a task/edit cannot move parents.

Status is harness-owned. The planner never emits `todo`, `pending`, `passed`,
or a status map.

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
    | "task-protocol"
    | "task-tree"
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

Rules shared by the Plan DSL and edit-action DSL:

- CRLF, blank lines, and indentation are ignored where the grammar is line
  oriented.
- A whole-reply markdown fence is stripped when it unambiguously wraps the
  entire reply; this produces a warning, not a silent success.
- A missing closing `end` is recovered at EOF or before the next sibling
  record/clause header, but only when the record/clause boundary is
  unambiguous; it is a warning, not a rejection, when the remaining fields are
  valid.
- An unclosed fence is recovered at EOF for diagnostics; the reply is rejected.
- Truncation is reported as `truncated`; the reply is rejected.
- Unknown fields/parameters are reported with the nearest valid alternatives;
  they are not silently ignored.
- Duplicate ids, missing parents, and unknown parents are reported with the
  duplicate location or nearest id suggestions.
- Case/whitespace normalization is limited to unambiguous keywords; never
  guess a different action, target, path, symbol, or parent.
- Invalid view-only clauses may still produce feedback; invalid editor/write
  clauses reject the whole reply and write nothing.
- A patch is all-or-nothing: a malformed op rejects the whole patch. Valid ops
  are still parsed so the diagnostic can list every problem.
- An initial Plan reply is all-or-nothing: a malformed record rejects the plan.
  Incremental planning still does not insert a partial plan.
- A review reply is all-or-nothing: `approve`, or one fully valid patch. A
  malformed review reply gets one format retry before termination.

Plan-specific recovery:

- Accept a bare `NN-slug` id where the grammar expects a quoted id, with a
  warning; quote it internally.
- Accept `plan`/`patch` headers surrounded by a whole-reply text fence.
- A missing `goal:` or `instruction:` is an error; the plan/patch is rejected.
- A record whose parent is missing gets a nearest-id hint; no partial tree.
- A `finish` without a last `test` task is an error with the exact last task
  and its verify value.
- Dotted `create` gets a dedicated code (`PLAN_CREATE_MEMBER`) and a hint:
  modify the class with stubs, then modify the member.

Edit-action recovery:

- Clause splitting recognizes `select` … `end` and respects fenced bodies, so
  `select` inside a replacement fence is not a boundary.
- A missing `end` before the next `select`/EOF is recovered with a warning when
  the clause boundary is unambiguous; the reply is not rejected solely for
  this. A truncated fence or mid-clause EOF still rejects.
- `match` without a snippet/regex reports `EDIT_MATCHER_MISSING` with the
  accepted forms and an example.
- `pick` without `replace`, `rename` mixed with `replace`, unknown
  `resolve` space, and an empty/malformed fence each get a dedicated code and a
  one-line hint.
- Multiple clauses are all parsed before any application. One bad editor clause
  rejects all writes; good view-only clauses may still return feedback.

### 5.3 Diagnostics format

Every Plan/edit diagnostic rendered to the model has:

- a `stage:` header using the parser vocabulary: `task-protocol` or `task-tree`
  for the Plan DSL, and `syntax`, `address`, `matcher`, or `range` for the
  edit-action DSL;
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
stage: task-protocol
code: PLAN_MISSING_END
severity: warning
message: missing "end" for task "03-answer" before the next record; recovered at the record boundary
at line 12:1
  11 | task "03-answer" stage "02-current" verify test
  12 | edit "04-change" task "03-answer" modify value answer in src/helper.ts
   | ^
expected: end
hint: close task "03-answer" with end before starting edit "04-change"
```

This warning does not reject the reply: the parser repairs the unambiguous
record boundary and records the warning on `LoopResult.warnings`. The `message:`
prose is representative, while the `stage`/`code`/`severity` shape is stable.

Action example:

```text
stage: syntax
code: EDIT_MATCHER_MISSING
message: expected a `snippet` or `/regex/` after `match`
at line 4:7
  3 | select value answer in src/helper.ts
  4 | match
  |       ^
expected: `snippet` | /regex/
hint: use `match \`return 1;\`` or omit match to rewrite the whole declaration
```

The Plan parser reports syntax/protocol failures as `stage: task-protocol` and
Plan/tree validator failures as `stage: task-tree`; the edit-action DSL reports
`stage: syntax` for clause syntax and `address`, `matcher`, or `range` for the
matching cascade stage. Both use the same `renderDslIssues` renderer in
`src/dsl-diagnostics.ts`.

Shipped error-code families:

- `PLAN_*`: `MISSING_END`, `MISSING_FIELD`, `UNKNOWN_FIELD`, `UNKNOWN_PARENT`,
  `DUPLICATE_ID`, `CREATE_MEMBER`, `FINISH_NOT_LAST`, `STRUCTURE`, `BARE_ID`,
  `WHOLE_REPLY_FENCE`, `UNCLOSED_FENCE`, `TRUNCATED`;
- `EDIT_*`: `MISSING_END`, `MISSING_FIELD`, `UNKNOWN_FIELD`, `UNCLOSED_FENCE`,
  `WHOLE_REPLY_FENCE`, `MATCHER_MISSING`, `PICK_WITHOUT_REPLACE`,
  `RENAME_MIXED`, `UNKNOWN_SPACE`, `TARGET_MISMATCH`, `TRUNCATED`.

The same renderer is used for plan and action diagnostics so the model sees one
stable shape. Warnings are surfaced on `LoopResult.warnings`; only errors block
application.

## 6. Scheduling

The executor consumes exactly one Task at a time. The driver:

1. If the Plan is empty: ask for the initial Plan + current Stage + current Task.
2. Validate the reply.
3. Execute the current Task:
   - run its `todo` edits in order;
   - a failed edit ends the Task immediately and triggers a repair patch;
   - otherwise run the Task gate after every edit settles;
   - the Task enters `review`.
4. Planner post-execution review receives the gate result and concise diff:
   - `approve`: finalize the Task as `passed` or `failed` from the gate;
   - one patch: validate, reopen the current Task, execute it again; no second
     review for that Task.
5. If `finalTaskId` is passed and every stage is closed → success.
6. Otherwise the planner emits one patch:
   - another Task in the current Stage, but only while that Stage is not fully
     passed; a fully passed Stage requires a new Stage with its first Task;
   - a new Stage only when the current Stage has no pending/review Task, plus
     its first Task;
   - a repair Task/Stage after a failure;
   - a final Task + `finish`.
7. Repeat from step 2.

Each planning turn adds at most one new Task; adding a new Stage includes its
first Task in the same turn. Patches may update or remove multiple existing
nodes, but never introduce a future Task list.

Stage closure is **implicit**: there is no `stage-end` control. A new Stage can
only be appended when the current Stage has no pending or `review` Task. A
failed Task is terminal; it does not block adding a repair Task to the same
Stage, and it does not block appending a new Stage. A fully passed Stage is
closed, so later work goes in a new Stage.

Default repair policy: after a failed Task, try a repair Task in the current
Stage first. Append a new Stage only when the current Stage is fully passed or
the repair is clearly a new phase.

Run success requires:

- `finalTaskId` is set;
- the final Task verifies `test`;
- the final Task passed;
- every stage is closed (all Tasks passed or failed).

Earlier failed Tasks are allowed when later work supersedes them and the final
test passes.

## 7. Mode contexts

### 7.1 Planning

1. system: role, flat Plan DSL grammar, functional style, workflow, create/
   class rules, finish semantics;
2. user: `# Requirement`, `# Symbol index`, spec files;
3. incremental turns: current Plan/Stage/Task, latest gate result, failed
   diagnostics, current symbol index;
4. the planner emits one new Task or one new Stage + Task, not a future task list.

The planning conversation persists across incremental turns. A re-plan receives
the current flat tree, statuses, failed edit/task diagnostics, and the symbol
index.

### 7.2 Review

A separate compact review turn in the same planner conversation receives the
gate result, the concise applied diff, and the current Task checklist. It
returns `approve` or a patch. Review is per executed Task and counts toward the
token budget but not the planning-turn cap. There is one review turn per
executed Task, with at most one format retry for a malformed reply; its patch
may only repair the current Task (no future Stage/Task). The review prompt must
be short; it should not repeat the full requirement, full source, or full Plan
grammar.

Call usage is recorded in three `LoopTokens` buckets — `planning`, `review`, and
`execution` — and exposed as `LoopResult.usage`. Their sum is
`LoopResult.tokens`, and all three count toward the run token budget. The
`typescript-coder-result@2` subagent result keeps its single `tokens` object and
does not expose the per-bucket split or recovered warnings.

### 7.3 Execution

1. system: role + functional style + edit-action grammar (stable per Task);
2. user: current Stage/Task plan in flat DSL (no future tasks);
3. per edit turn: `# Micro edit`, optional `# Context`, `# Diagnostics`,
   `# Format help`, then `# Content view` (numbered), then the reply
   instruction.

Every edit turn is seeded from the stable system + current Task prefix; stage/
task/edit context, diagnostics, and content view are the volatile tail. A new
Task starts a fresh execution context.

Execution deliberately does not receive the requirement or test files
(knowledge isolation); the planner's instructions must be self-contained.

## 8. Execution details

### 8.1 Target guard

An edit owns one main address plus an optional same-file `related` list. Before
the reply is applied:

- the path must be safe and writable (`human/` and ignored directories are
  rejected);
- an existing target must parse (`prev-broken` otherwise);
- `modify`, `delete`, `rename` need the declaration to resolve in the edit's
  symbol space;
- `create` needs the symbol absent in that space and must be top-level;
- a `write` edit needs one safe file path; its previous parse is irrelevant
  because the reply replaces the whole file;
- every editor clause that writes must name the edit's target or a related loc;
  off-target writes reject the whole reply. A `write` action accepts exactly one
  whole-file `write <path> with <fence> done` and no other statement;
- other writing file commands (`create`/`delete`/`write`) are rejected;
  `read` and viewer clauses are allowed and only produce feedback.

### 8.2 Action forms

| Action   | Required reply                                                                                                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modify` | At least one `replace with <fence>` clause on the target or a related loc (a viewer alone is rejected).                                                                                                                                                                                  |
| `create` | A whole-declaration `replace with <fence>` with no `match`/`pick`; the fence must contain exactly one top-level declaration, the target. Any other body is wrapped by the edit's space (`value` → `let`, `type` → `type`, `namespace` → `namespace`); the created name/space must match. |
| `delete` | A whole-declaration empty fence, no `match`/`pick`.                                                                                                                                                                                                                                      |
| `rename` | `rename <current> to <renameTo>`, no `replace`; the new name must equal `renameTo`.                                                                                                                                                                                                      |
| `write`  | Exactly one `write <path> with <fence> done`, no `within`; the fence carries the complete file.                                                                                                                                                                                         |

A caller update is its own edit. The one exception is a `modify` edit's
`related` list, which exists for atomic type/representation migrations.

Variable entries point at their `VariableDeclarator`, so a whole-symbol rewrite
or delete is expanded to the enclosing `VariableStatement` (including an
`export` wrapper) before the splice. A multi-declarator statement is rejected:
split it into one binding per statement first. A rename keeps the binding span
and does not expand.

The driver tolerates a leading `export` the source omitted or the reply re-added,
matching the edit-dsl #48 rule.

### 8.3 Apply and verify

1. Parse with the tolerant edit-action parser. If `ok=false` or any editor
   clause is invalid, reject the whole reply and write nothing; warnings alone
   do not block. Diagnostics list every parsed clause issue.
2. A `write` edit accepts exactly one `write <path> with <fence> done`
   statement with no `within`; the new source runs through the parse gate and
   formatter, then replaces the file. The previous parse is irrelevant because
   the reply replaces the whole file.
3. Other edits resolve with `resolveMultiEditor` against the current sources.
4. Apply with `applyResolvedRegions`: overlap, parse gate, duplicate guard,
   formatter, post-format no-op.
5. Write only after every guard passes; nothing is written on a rejection.
6. An applied edit marks the edit `done` immediately; there is no per-edit type
   check.
7. After every edit in the task is `done` or `failed`, run the task gate.

A rejected reply or a read-only viewer costs one exchange. Per edit: at most 3
exchanges. Two consecutive `EDIT_TARGET_MISMATCH` replies end the edit with
`ADDRESS_RETRY_LIMIT` and trigger a repair patch instead of retrying the same
address. Exhaustion marks the edit and task `failed` and triggers a patch
re-plan.

The executor may make **one** bounded self-check per edit:
`{"request":"read"}` returns the numbered target source; any other request is
refused.

### 8.4 Task gates and tests

Every task has a gate that runs **once**, after every edit in that task settles:

- `verify: "tsc"` runs the check command (default `bunx tsc --noEmit`);
- `verify: "test"` runs the check command and then the test suite.

A gate failure records its diagnostics and marks the task `failed`; the planner
gets `# Failed task gates and diagnostics` and adds a repair edit or later task.
The Task marked by `finish` must verify `test`, so a successful run ends with
the suite green; a work-in-progress tree may end in a `tsc` Task. There is no
implicit whole-Plan test outside the task gates.

Edits inside one task may leave the file temporarily type-broken, but the task
gate sees the completed small batch. Tasks are sized so that failures surface
early instead of after a whole intermediate program has been written.

## 9. Termination and caps

The planner is re-invoked when:

- an edit fails after its exchange budget;
- a task gate fails;
- no task is runnable but the final task has not passed;
- a patch or review is structurally rejected;
- a new Stage is requested while the current Stage has pending or `review`
  tasks.

Caps:

| Cap                              | Value              |
| -------------------------------- | ------------------ |
| Task/edit nodes per Plan         | 96                 |
| Instruction length               | 4,000 chars        |
| Stage/Plan goal length           | 1,000 chars        |
| Related locs per edit            | 16                 |
| Exchanges per edit               | 3                  |
| Planning attempts per turn       | 3                  |
| Planning turns per run           | 32                 |
| Review turns per executed Task   | 1                  |
| Review patches per executed Task | 1                  |
| Consecutive length finishes      | 3 (`output-limit`) |
| Token budget                     | 120,000 default    |

The 32-turn cap counts planning replies, including initial planning, next
Task/Stage planning, and repair planning. Review turns are additional and are
bounded by one per executed Task. Stage, task, and edit counts are not capped
individually; the 96-node limit and token budget bound runaway plans.

Failure paths use the existing termination matrix plus `task-exhausted`; the
run still makes one summary call. Provider errors keep their own path.

## 10. CLI and result

```sh
tc --mode pinned-repair < issue.txt       # default
tc --mode plan-exec < issue.txt
tc --agent-mode plan-exec < issue.txt
```

- `--mode` and its alias `--agent-mode` accept the two canonical loop modes:
  `pinned-repair` (default) and `plan-exec`.
- Deprecated alias: `edit` → `pinned-repair`. Historical benchmark/replay
  rows keep their old `edit` strings and are read through this mapping.
- `both` is the benchmark's multi-mode selector, not a single-run CLI mode:
  `bun run benchmark/run.ts --agent-mode both` measures `pinned-repair` and
  `plan-exec`, while `tc --mode both` is rejected with a clear
  benchmark-only message because one CLI process runs one loop.
- `pinned-repair` is the default and is unchanged.
- `plan-exec` rejects `--targets` (single-target JSON loop) and
  `--protocol-format json` (execution is edit-dsl); `edit-dsl` and the default
  are accepted.
- `--multi-payload` is irrelevant in `plan-exec` (execution replies are
  edit-dsl clauses).
- Text stdout names the completed edit/file summary; `--format json` prints
  `typescript-coder-result@2`.
- `LoopResult.tasks` carries one entry per edit (`id`, `stage`, `task`,
  `verify`, `action`, `path`, `symbol`, `kind`, `status`). All three node-id
  fields are strings (`"01-main"` etc.). `terminationReason` can be
  `task-exhausted`.
- `LoopResult.usage` splits a `plan-exec` run's spend into `planning`,
  `review`, and `execution` `LoopTokens` buckets; their sum is
  `LoopResult.tokens`, and all three count toward the budget.
  `LoopResult.warnings` carries recovered parser warnings.

The string-id change is a breaking result-schema change;
`typescript-coder-result@2` is shipped. The historical `@1` schema used numeric
task/edit ids.

## 11. Limitations

- **No JSON plan fallback.** The flat Plan DSL replaces the JSON plan parser.
  Old `plan-exec` replay bundles containing JSON plan replies will not replay;
  none are currently in the repo, but historical bundles need this caveat. v1
  does **not** ship a JSON-to-DSL migration tool; manual offline conversion is
  possible but out of scope.
- **Result schema @2.** `LoopResult.tasks[].id`, `.stage`, and `.task` are
  strings. Consumers of the old numeric `@1` fields must migrate.
- **Class members are not first-class creates.** New classes are forbidden;
  existing classes are extended with a whole-class `modify` (optionally with
  stubs) and then member `modify` edits. Dotted `create` is rejected.
- **One file per edit.** An edit's main target plus `related` must share a file;
  cross-file changes are separate edits in the same task.
- **Rename is same-file.** It inherits the existing renamer's scope (declaration
  plus same-file references). Cross-file renames need caller edits first, or
  escalation.
- **No planning tools.** The planner sees the signature index and spec files,
  not declaration bodies. A requirement that needs inspection must be expressed
  as an edit the executor can inspect (a viewer/read is available there).
- **Passed tasks are immutable.** A failed task reopens for repair; a passed
  task cannot be extended, so later work goes in a new Stage (a fully passed
  Stage cannot accept a new Task).
- **Intermediate type errors are expected inside a task.** An edit boundary may
  leave the file type-broken; the enclosing task gate is the type-correct
  boundary.
- **Test-file edits are allowed but discouraged.** The planner prompt treats
  `*.test.ts` as specification; a requirement that asks for test changes still
  needs them.
- **Incremental planning is not free.** Each Task has a planning turn and a
  review turn; the per-task overhead must be weighed against the reduced
  full-tree output and better recovery.

## 12. As-built implementation notes

Shipped design decisions:

1. **Planning turn cap:** 32 planning replies per run, with one review turn per
   executed Task outside that cap.
2. **Review model:** post-execution review in the same planner conversation;
   gate result + concise diff; one format retry for a malformed reply; one
   review patch per executed Task, no second review; a review patch may only
   repair the current Task and may carry `finish` for the current final Task.
3. **Stage closure:** implicit; append a new Stage only when the current Stage
   has no pending or `review` Task. No `stage-end` control.
4. **Final test repair:** both in-place repair and a new final Task are allowed;
   in-place repair is the default. Any work appended after the old final task
   requires a new `finish` on the new last task.
5. **Result schema:** string IDs plus `typescript-coder-result@2`.
6. **Plan root:** required `plan.id` and `plan.goal`.
7. **One-unit rule:** at most one new Task per planning turn; a new Stage
   includes its first Task in the same turn.
8. **JSON compatibility:** no runtime JSON fallback and no migration tool in
   v1; old plan-exec replay bundles with JSON plan replies are incompatible and
   need manual conversion if retained.
9. **Functional policy:** hard prompt ban on new classes; dotted `create` is
   rejected by validation; existing classes are minimal `modify` only.
10. **Stage repair default:** after a failed Task, prefer a repair Task in the
    current Stage; append a new Stage only when the current Stage is fully
    passed or the repair is clearly a new phase.
11. **Review token tracking:** record `planning`, `review`, and `execution`
    usage buckets; all count toward the run budget.

Implementation notes:

- **Review prompt:** `buildTaskReviewPrompt` in `src/prompts/task.ts` sends only
  the gate verdict, current Task, and concise applied diff; the review prompt
  shape and its current-Task-only patch scope are pinned by
  `src/prompts/task.test.ts` and `src/task-loop.test.ts`.
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

- `bun test src/tasks.test.ts` — contract, ids, refs, write loc validation,
  node cap, merge rules.
- `bun test src/plan-dsl.test.ts` — BNF, fences, plan/patch/review replies,
  whole-file write records, `finish`/`finalTaskId` cases, tolerant recovery,
  issue codes, all-or-nothing patch/plan behavior.
- `bun test src/prompts/task.test.ts` — planning, review, execution prompt shape,
  workflow guidance, one-stage/task/write example, functional-style and
  dotted-create rules.
- `bun test src/edit-dsl.test.ts` / `src/selection.test.ts` — tolerant clause
  boundaries, unclosed fences, matcher/pick/rename diagnostics, per-clause
  issues, no partial writes.
- `bun test src/task-loop.test.ts` — incremental Task loop, one-unit planning,
  whole-file write execution, address-failure escalation, post-execution review
  approve/patch (scope limited to the current Task), review status,
  gate+concise-diff context, implicit stage closure, final-test in-place vs
  new-final repair, 32-turn cap, repair patches, dotted-create rejection.
- `bun test src/result.test.ts` — `typescript-coder-result@2` string ids.
- `just typecheck && just test`.
- `just accept` (offline), including a `plan-exec-fix-answer` scenario
  driven by the flat Plan DSL.
- This verification is offline; it makes no benchmark or live-model claim.
