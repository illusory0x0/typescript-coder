# Plan → execute agent loop

Status: implemented (`--mode plan-exec`). This document is the as-built contract.

The loop is **additive**. `--mode edit` (default) keeps the single-target
Edit → Verify driver byte-identical. `--mode plan-exec` runs two modes:

- **planning** decomposes the requirement into a `Plan → Stage → Task → edit`
  tree;
- **execution** carries out one edit at a time with edit-dsl clauses, then runs
  the enclosing task's gate.

The harness owns status, scheduling, gates, and verification. The model never
chooses files or commands; it answers structured prompts. Array order is
execution order: there are no dependency edges, `todo` lists, or planner-owned
status maps.

Implementation map:

| Concern                                              | File                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Plan contract, JSON parser, tree validator, scheduler | `src/tasks.ts`                                                          |
| Planning/execution prompt text                       | `src/prompts/task.ts`                                                    |
| Driver, target guards, apply/verify                  | `src/task-loop.ts`                                                       |
| Dispatch (`--mode`)                                  | `src/loop.ts`                                                            |
| CLI flag                                             | `src/cli.ts`, `src/main.ts`                                              |
| Tests                                                | `src/tasks.test.ts`, `src/prompts/task.test.ts`, `src/task-loop.test.ts` |

## 1. Plan contract

The planner replies with one JSON object, no markdown fences, no prose. The
root object is the **Plan**; it contains ordered stages.

```json
{
  "stages": [
    {
      "id": 1,
      "goal": "Add a formatting helper and make the report use it.",
      "tasks": [
        {
          "id": 2,
          "verify": "test",
          "instruction": "Add formatNumber and call it from printTotal.",
          "edits": [
            {
              "id": 3,
              "loc": { "path": "src/format.ts", "symbol": "formatNumber", "kind": "value" },
              "action": "create",
              "instruction": "Add a small exported formatNumber(value: number): string helper."
            },
            {
              "id": 4,
              "loc": { "path": "src/report.ts", "symbol": "printTotal", "kind": "value" },
              "action": "modify",
              "instruction": "Call formatNumber(total) instead of String(total)."
            }
          ]
        }
      ]
    }
  ]
}
```

```ts
type Plan = {
  stages: Stage[]; // 1-12, execution order
};

type Stage = {
  id: number;
  goal: string; // planning context for the executor
  tasks: Task[]; // 1-8, execution order
};

type Task = {
  id: number;
  verify: "tsc" | "test"; // the task gate; final task must be "test"
  instruction: string; // the local goal for the whole task
  edits: Edit[]; // 1-6, execution order
};

type Edit = {
  id: number;
  loc: Loc;
  action: "modify" | "create" | "delete" | "rename";
  instruction: string; // self-contained; the executor sees no requirement text
  related?: Loc[]; // same-file atomic migration targets (modify only)
  renameTo?: string; // required iff action === "rename"
};

type Loc = {
  path: string; // repo-relative, writable
  symbol: string; // declared name (or the name a create adds)
  kind: "value" | "type" | "namespace"; // TypeScript symbol space
};
```

Task and edit ids share one namespace and are unique across the whole Plan.
The harness tracks status internally:

```ts
type EditStatus = "todo" | "in-progress" | "done" | "failed";
type GateStatus = "pending" | "passed" | "failed";
```

`kind` is a **symbol space**, not a declaration keyword. It matches the
edit-dsl `resolve` vocabulary; the declaration keyword (`function`, `const`, …)
is discovered from the index.

JSON is the current stage. The parser boundary (`parsePlan` / `readPlan` in
`src/tasks.ts`) is where a dedicated syntax would land.

### 1.1 Parse and validation

Both the initial plan and a re-plan go through `readPlan`; neither accepts
status from the model. `parsePlan` is the initial-plan entry point. The
parser rejects, never partially accepts:

- top-level keys other than `stages`; stage keys other than `id`, `goal`,
  `tasks`; task keys other than `id`, `verify`, `instruction`, `edits`; edit
  keys other than `id`, `related`, `loc`, `action`, `instruction`, `renameTo`;
  loc keys other than `path`, `symbol`, `kind`;
- empty stages/tasks/edits, non-positive/duplicate stage ids, duplicate
  task/edit node ids, more than 12 stages, 8 tasks per stage, 6 edits per task,
  or 96 task/edit nodes in total;
- empty or over-long stage goals (1,000 chars), task/edit instructions
  (4,000 chars);
- a symbol space other than `value|type|namespace`; empty path/symbol;
- unsafe paths (absolute, `..`, empty/`.` segments, hidden/build directories,
  `human/`);
- `related` on a non-modify edit, a related loc outside the edit's file, or a
  duplicate related target;
- `renameTo` on a non-rename, missing/unchanged/invalid `renameTo` on a rename;
- a missing/invalid task `verify`, or a final task whose gate is not `test`.

### 1.2 Re-planning

The planner re-emits the full tree; ids and array order are stable:

- a done edit and a passed task are immutable and cannot be removed;
- a failed edit retries only with a changed definition;
- a failed task reopens when its definition changes or it gains edits;
- a failed task left unchanged stays failed, so a later task can supersede it;
- a pending task may be amended or removed if it has no done edits;
- a new task starts pending and is appended to its stage; a new stage is
  appended after existing stages; a new edit is appended to its task;
- a fully passed stage is closed, so later work goes in a new stage;
- a task/edit may not move to another stage/task;
- the merged tree must still end with a `test` task.

The harness computes status; the planner never emits `todo` or a status map.

## 2. Scheduling

Stages, tasks, and edits run in array order. The driver:

1. selects the first stage with a pending task;
2. selects the first pending task in that stage;
3. runs its `todo` edits in order; a failed edit ends the task immediately,
   otherwise the task reaches its gate when every edit is `done` or `failed`;
4. runs the task gate: `tsc` runs the check command; `test` runs the check and
   then the test suite;
5. gate pass → task `passed`; move to the next pending task;
6. gate fail → task `failed`; if a later task in the same stage is still
   pending, continue with it (it may repair the failure) and pass the failed
   gate diagnostics as coordination context; otherwise re-plan;
7. a failed edit ends the task immediately and triggers a re-plan;
8. a blocked tree (no pending task/edit, but the final task has not passed)
   triggers a re-plan.

A run ends `ok` only when every stage is closed and the final task's `test`
gate passed. Earlier failed tasks are allowed when later work supersedes them.

## 3. Mode contexts

The context manager follows the repository's stability-descending rule: stable
content first, volatile content last, per-mode roots.

### Planning

1. system role + output contract + Plan example + rules;
2. user: `# Requirement`, `# Symbol index` (signature-bearing YAML from
   `buildContextYaml`), spec files;
3. re-plan: append `# Plan tree`, `# Status`, `# Failed edits and
   diagnostics`, `# Failed task gates and diagnostics`, `# Gate results` /
   `# Blocked`, then the amendment delta.

The planning conversation persists across re-plans: the previous Plan and the
rejection diagnostics stay in history.

Planning preference: write like a normal TypeScript engineer — small
single-purpose functions, helpers extracted, a thin orchestrator calling them,
and tasks small enough that their own gate passes. This is a general rule, not
a task-specific split.

### Execution

1. system: role + action rules + edit-action grammar (stable for the Plan);
2. user: `# Plan tree` in wire JSON, once per Plan;
3. per edit turn: `# Stage` (id + goal), `# Task` (id, verify, status, goal),
   `# Micro edit` (id, action, target, instruction), optional `# Context`,
   `# Diagnostics`, `# Format help`, then `# Content view` (numbered), then the
   reply instruction.

Every edit turn is seeded from the stable system + Plan messages; stage/task/
edit context, diagnostics, and content view are the volatile tail. A re-plan
starts a fresh execution context.

Execution deliberately does not receive the requirement or test files
(knowledge isolation); the planner's instructions must be self-contained.

## 4. Execution details

### 4.1 Target guard

An edit owns one main address plus an optional same-file `related` list. Before
the reply is applied:

- the path must be safe and writable (`human/` and ignored directories are
  rejected);
- an existing target must parse (`prev-broken` otherwise);
- `modify`, `delete`, `rename` need the declaration to resolve in the edit's
  symbol space;
- `create` needs the symbol absent in that space (existing → "use modify");
- every editor clause that writes must name the edit's target or a related loc;
  off-target writes reject the whole reply;
- writing file commands (`create`/`delete`/`write`) are rejected; `read` and
  viewer clauses are allowed and only produce feedback.

### 4.2 Action forms

| Action   | Required reply                                                                                                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modify` | At least one `replace with <fence>` clause on the target or a related loc (a viewer alone is rejected).                                                                                                                                                                                  |
| `create` | A whole-declaration `replace with <fence>` with no `match`/`pick`; the fence must contain exactly one top-level declaration, the target. Any other body is wrapped by the edit's space (`value` → `let`, `type` → `type`, `namespace` → `namespace`); the created name/space must match. |
| `delete` | A whole-declaration empty fence, no `match`/`pick`.                                                                                                                                                                                                                                      |
| `rename` | `rename <current> to <renameTo>`, no `replace`; the new name must equal `renameTo`.                                                                                                                                                                                                      |

A caller update is its own edit. The one exception is a `modify` edit's
`related` list, which exists for atomic type/representation migrations.

Variable entries point at their `VariableDeclarator`, so a whole-symbol rewrite
or delete is expanded to the enclosing `VariableStatement` (including an
`export` wrapper) before the splice. A multi-declarator statement is rejected:
split it into one binding per statement first. A rename keeps the binding span
and does not expand.

The driver tolerates a leading `export` the source omitted or the reply re-added,
matching the edit-dsl #48 rule.

### 4.3 Apply and verify

1. Parse with `parseMultiEditor`; a syntax error is a `protocol` rejection.
2. Resolve with `resolveMultiEditor` against the current sources.
3. Apply with `applyResolvedRegions`: overlap, parse gate, duplicate guard,
   formatter, post-format no-op.
4. Write only after every guard passes; nothing is written on a rejection.
5. An applied edit marks the edit `done` immediately; there is no per-edit type
   check.
6. After every edit in the task is `done` or `failed`, run the task gate.

A rejected reply or a read-only viewer costs one exchange. Per edit: at most 3
exchanges. Exhaustion marks the edit and task `failed` and triggers a re-plan.

The executor may make **one** bounded self-check per edit:
`{"request":"read"}` returns the numbered target source; any other request is
refused.

### 4.4 Task gates and tests

Every task has a gate that runs **once**, after every edit in that task settles:

- `verify: "tsc"` runs the check command (default `bunx tsc --noEmit`);
- `verify: "test"` runs the check command and then the test suite.

A gate failure records its diagnostics and marks the task `failed`; the planner
gets `# Failed task gates and diagnostics` and adds a repair edit or later task.
The final task must be a `test` gate, so a successful run ends with the suite
green. There is no implicit whole-Plan test outside the task gates.

This cadence is deliberate: edits inside one task may leave the file
temporarily type-broken, but the task gate sees the completed small batch.
Tasks are sized so that failures surface early instead of after a whole
intermediate program has been written.

## 5. Termination

The planner is re-invoked when:

- an edit fails after its exchange budget;
- a task gate fails and no later task in the same stage is pending;
- no task is runnable.

Each re-plan gets the full Plan tree, task/edit status, failed-edit
diagnostics, failed-task gate diagnostics, and the symbol index or blocked
chain. The amendment delta states the rules above.

Caps:

| Cap                          | Value              |
| ---------------------------- | ------------------ |
| Stages per Plan              | 12                 |
| Tasks per stage              | 8                  |
| Edits per task               | 6                  |
| Task/edit nodes per Plan     | 96                 |
| Instruction length           | 4,000 chars        |
| Stage goal length            | 1,000 chars         |
| Related locs per edit        | 16                 |
| Exchanges per edit           | 3                  |
| Planning rounds per run      | 8                  |
| Planning attempts per turn   | 3                  |
| Consecutive length finishes  | 3 (`output-limit`) |
| Token budget                 | 120,000 default    |

Failure paths use the existing termination matrix plus `task-exhausted`; the
run still makes one summary call. Provider errors keep their own path.

## 6. CLI and result

```sh
tc --mode plan-exec < issue.txt
tc --agent-mode plan-exec < issue.txt   # alias
```

- `--mode edit` is the default and is unchanged.
- `plan-exec` rejects `--targets` (single-target JSON loop) and
  `--protocol-format json` (execution is edit-dsl); `edit-dsl` and the default
  are accepted.
- `--multi-payload` is irrelevant in plan-exec (execution replies are edit-dsl
  clauses).
- Text stdout names the completed edit/file summary; `--format json` keeps the
  `typescript-coder-result@1` contract, and `files` aggregates the applied
  locators from the records.
- `LoopResult.tasks` carries one entry per edit (`id`, `stage`, `task`,
  `verify`, `action`, path, symbol, space, status). `terminationReason` can be
  `task-exhausted`.

## 7. Limitations (v1)

- **Multi-declarator variables.** `const a = 1, b = 2;` cannot be a whole-symbol
  edit target; split the statement first (a matcher edit on one binding is
  still possible).
- **One file per edit.** An edit's main target plus `related` must share a file;
  cross-file changes are separate edits in the same task.
- **Rename is same-file.** It inherits the existing renamer's scope (declaration
  plus same-file references). Cross-file renames need caller edits first, or
  escalation.
- **No planning tools.** The planner sees the signature index and spec files,
  not declaration bodies. A requirement that needs inspection must be expressed
  as an edit the executor can inspect (a viewer/read is available there).
- **Passed tasks are immutable.** A failed task reopens for repair; a passed
  task cannot be extended, so later work goes in a new task.
- **Intermediate type errors are expected inside a task.** An edit boundary may
  leave the file type-broken; the enclosing task gate is the type-correct
  boundary.
- **Test-file edits are allowed but discouraged.** The planner prompt treats
  `*.test.ts` as specification; a requirement that asks for test changes still
  needs them.

## 8. Verification

- `bun test src/tasks.test.ts` — every contract/tree invariant.
- `bun test src/prompts/task.test.ts` — prompt shape and examples.
- `bun test src/task-loop.test.ts` — scripted end-to-end:
  one-edit success, multi-edit task gate, stage/task order, later-task repair,
  task-gate re-plan, edit-failure re-plan, create, related migration, delete,
  off-target reject, `TASK_DONE` guard, repeated-plan exhaustion, dispatcher
  routing, default-mode invariance.
- `just typecheck && just test`.
- `just accept` (offline), including `plan-exec-fix-answer`, which drives the
  real `runLoop` through a scripted planning turn and execution turn.
