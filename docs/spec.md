# Plan → execute agent loop

Status: implemented (`--mode plan-exec`). This document is the as-built contract;
the human-facing summaries live in [`human/edit-task.md`](../human/edit-task.md),
[`human/agent-mode.yaml`](../human/agent-mode.yaml), and
[`human/edit-action.md`](../human/edit-action.md).

The new loop is **additive**. `--mode edit` (default) keeps the single-target
Edit → Verify driver byte-identical. `--mode plan-exec` runs two modes:

- **planning** decomposes the requirement into an edit-task DAG;
- **execution** carries out one task at a time with edit-dsl clauses.

The harness owns status, scheduling, gates, and verification. The model never
chooses files or commands; it answers structured prompts.

Implementation map:

| Concern                                              | File                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Task contract, JSON parser, DAG validator, scheduler | `src/tasks.ts`                                                           |
| Planning/execution prompt text                       | `src/prompts/task.ts`                                                    |
| Driver, target guards, apply/verify                  | `src/task-loop.ts`                                                       |
| Dispatch (`--mode`)                                  | `src/loop.ts`                                                            |
| CLI flag                                             | `src/cli.ts`, `src/main.ts`                                              |
| Tests                                                | `src/tasks.test.ts`, `src/prompts/task.test.ts`, `src/task-loop.test.ts` |

## 1. Task contract

The planner replies with one JSON object, no markdown fences, no prose:

```json
{
  "tasks": [
    {
      "id": 1,
      "root": 1,
      "verify": "test",
      "loc": { "path": "src/helper.ts", "symbol": "answer", "kind": "value" },
      "deps": [],
      "action": "modify",
      "instruction": "Change answer so it returns 2."
    }
  ],
  "todo": [1],
  "status": { "1": "todo" }
}
```

```ts
type Task = {
  id: number;
  root: number; // root task id; a root task names itself
  verify?: "tsc" | "test"; // required exactly on a root task
  related?: Loc[]; // optional same-file migration targets (modify only)
  loc: Loc;
  deps: number[]; // execution order
  action: "modify" | "create" | "delete" | "rename";
  instruction: string; // self-contained; the executor sees no requirement text
  renameTo?: string; // required iff action === "rename"
};

type Loc = {
  path: string; // repo-relative, writable
  symbol: string; // declared name (or the name a create adds)
  kind: "value" | "type" | "namespace"; // TypeScript symbol space
};

type LLM_Output = {
  tasks: Task[];
  todo: number[]; // ordered ready frontier
  status: Map<number, Status>; // wire {"<id>":"todo"}; harness-owned
};

type Status = "todo" | "in-progress" | "done" | "failed";
type RootStatus = "pending" | "passed" | "failed";
```

`kind` is a **symbol space**, not a declaration keyword. It matches the
edit-dsl `resolve` vocabulary and the index's space filter; the declaration
keyword (`function`, `const`, …) is discovered from the index. The plan parser
rejects `kind: "function"` and points at the space.

JSON is the current stage. A dedicated edit-task syntax is a later revision; the
parser boundary (`parseTaskPlan` / `readPlan` in `src/tasks.ts`) is where it
lands so the driver does not change.

### 1.1 Parse and validation

`parseTaskPlan` is used for the **first** plan and enforces "every task starts
todo". `readPlan` parses a re-plan reply (done/failed echoes are legitimate);
`mergeReplan` then applies the amendment rules. Both reject, never partially
accept:

- top-level keys other than `tasks`, `todo`, `status`; task keys other than
  `id`, `root`, `verify`, `related`, `loc`, `deps`, `action`, `instruction`,
  `renameTo`; loc keys other than `path`, `symbol`, `kind`;
- non-positive/duplicate ids, more than 64 tasks, empty instruction or one over
  4,000 characters;
- a symbol space other than `value|type|namespace`; empty path/symbol;
- unsafe paths (absolute, `..`, empty/`.` segments, hidden/build directories,
  `human/`);
- unknown `root`/`deps`, self references, duplicate deps, a dependency cycle,
  a root task without `verify`, a non-root task with `verify`, a root whose
  final gate is not `test`, or a dependency on a task in a later root;
- `related` on a non-modify task, a related loc outside the task's file, or a
  duplicate related target;
- `renameTo` on a non-rename, missing/unchanged/invalid `renameTo` on a rename;
- status keys that are not exactly the task ids, unknown status values, a
  planning reply claiming `in-progress`, or a `done` task with pending deps;
- `todo` entries that are not ids, are duplicated, or are not `todo`; the
  harness normalizes `todo` to the active root's ready frontier.

Initial-plan-only rules:

- every task is `todo`;
- `todo` is normalized to the ready frontier of the first root.

Re-plan rules (`mergeReplan`):

- the reply re-emits the **full** task list; ids are stable;
- a `done` task is immutable and cannot be removed; the harness keeps it `done`
  even when the planner's echo is stale;
- a `todo` task may be amended or removed if nothing still depends on it;
- a `failed` task may be kept failed unchanged, or reset to `todo` only when its
  definition changed (root/verify/related/loc/action/instruction/deps/renameTo).
  Re-emitting the same failing task as `todo` is rejected: "retrying it requires
  a changed definition";
- a new task starts `todo` and uses an id unused by the current DAG;
- a passed root is closed; a failed root reopens when repair tasks are added or
  amended, and its gate reruns after they finish;
- `todo` is recomputed by the harness after the merge. A stale entry (an
  already-done task, or an omitted newly-ready task) is corrected; a **blocked**
  entry (deps not done) is a rejection.

### 1.2 Scheduling

Roots run in plan order. `readyFrontier` returns the `todo` tasks of the first
**pending** root whose deps are done, in task order. The driver:

1. runs the active root's frontier in order;
2. after each micro-task, appends newly ready tasks in that root;
3. a failed micro-task ends the wave and triggers a re-plan;
4. when every micro-task in the root is done, runs the root gate: `tsc` runs the
   check; `test` runs the check and then the test suite;
5. gate pass → root `passed`; move to the next pending root;
6. gate fail → root `failed`; re-plan with the gate diagnostics. The planner may
   add repair micro-tasks to that root (reopening it) or add a new root;
7. the final root must be a `test` gate, so success means the test suite passed;
8. a root with no ready micro-task is a blocked plan and is re-planned with the
   blocking chain named.

`todo` in a plan is an ordering hint; the harness normalizes it to this
frontier and never trusts the planner's list as scheduler truth.

## 2. Mode contexts

The context manager follows `human/agent-mode.yaml`: stable content first,
volatile content last, per-mode roots.

### Planning

1. system role + output contract + rules + examples;
2. user: `# Requirement`, `# Symbol index` (signature-bearing YAML from
   `buildContextYaml`), spec files;
3. re-plan: append `# Edit-task DAG`, `# Status`, `# Failed tasks and
   diagnostics`, `# Failed root gates and diagnostics`, `# Gate results` /
   `# Blocked`, then the amendment delta.

The planning conversation persists across re-plans: the previous plan and the
rejection diagnostics stay in history, so the planner sees what it tried.

### Execution

1. system: role + action rules + edit-action grammar and examples (stable for
   the DAG);
2. user: `# Edit-task DAG` in wire JSON, once per DAG;
3. per task turn: `# Task`, `# Project status`, optional `# Context`,
   `# Diagnostics`, `# Content view` (numbered declaration), then the reply
   instruction. The executor lands the edit and stops; it does not run tsc or
   tests.

Every task turn is seeded from the stable system + DAG messages; the task,
status, diagnostics, and content view are the volatile tail. The DAG block is
never rewritten within a DAG, and a re-plan starts a fresh execution context.

Execution deliberately does not receive the requirement or the test files
(knowledge isolation); the planner's `instruction` must be self-contained. It
also does not receive algorithm explanations or typing lessons.

## 3. Execution

### 3.1 Target guard

A task owns one main address plus an optional same-file `related` list. Before
the reply is applied:

- the path must be safe and writable (`human/` and ignored directories are
  rejected);
- an existing target must parse (`prev-broken` otherwise);
- `modify`, `delete`, `rename` need the declaration to resolve in the task's
  symbol space;
- `create` needs the symbol absent in that space (existing → "use modify");
- every editor clause that writes must name the task's target or a related loc;
  off-target writes reject the whole reply;
- writing file commands (`create`/`delete`/`write`) are rejected; `read` and
  viewer clauses are allowed and only produce feedback.

### 3.2 Action forms

| Action   | Required reply                                                                                                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modify` | At least one `replace with <fence>` clause on the target or a related loc (a viewer alone is rejected).                                                                                                                                                                                  |
| `create` | A whole-declaration `replace with <fence>` with no `match`/`pick`; the fence must contain exactly one top-level declaration, the target. Any other body is wrapped by the task's space (`value` → `let`, `type` → `type`, `namespace` → `namespace`); the created name/space must match. |
| `delete` | A whole-declaration empty fence, no `match`/`pick`.                                                                                                                                                                                                                                      |
| `rename` | `rename <current> to <renameTo>`, no `replace`; the new name must equal `renameTo`.                                                                                                                                                                                                      |

A caller update is its own task. The one exception is a `modify` task's
`related` list, which exists for atomic type/representation migrations.

Variable entries point at their `VariableDeclarator`, so a whole-symbol rewrite
or delete is expanded to the enclosing `VariableStatement` (including an
`export` wrapper) before the splice. A multi-declarator statement is rejected:
replace it with one binding per statement first. A rename keeps the binding
span and does not expand.

The task driver tolerates a leading `export` the source omitted or the reply
re-added, matching the edit-dsl #48 rule, so a whole-declaration rewrite keeps
the exported shape.

### 3.3 Apply and verify

1. Parse with `parseMultiEditor`; a syntax error is a `protocol` rejection.
2. Resolve with `resolveMultiEditor` against the current sources.
3. Apply with `applyResolvedRegions`: overlap, parse gate, duplicate guard,
   formatter, post-format no-op.
4. Write only after every guard passes; nothing is written on a rejection.
5. An applied edit marks the micro-task `done` immediately; there is no per-task
   type check.
6. After every micro-task in the root is done, run the root gate. A gate fail
   records diagnostics and triggers a re-plan; the planner may reopen the root with repair tasks.

A rejected reply or a read-only viewer costs one exchange. Per task: at most 3
exchanges. Exhaustion marks the task `failed` and triggers a re-plan.

The executor may make **one** bounded self-check per task:
`{"request":"read"}` returns the numbered target source; any other request is
refused. This mirrors the existing bounded self-check without opening a file
command surface.

### 3.4 Root gates and tests

Every root has a gate that runs **once**, after all micro-tasks in that root are
done:

- `verify: "tsc"` runs the check command (default `bunx tsc --noEmit`);
- `verify: "test"` runs the check command and then the test suite.

A gate failure records its diagnostics and closes the root; the planner gets
`# Failed root gates and diagnostics` and adds repair work to that root or a new root. The
final root must be a `test` gate, so a successful run ends with the suite green.
There is no implicit whole-DAG test outside the root gates.

This cadence is deliberate: micro-tasks may leave the file temporarily
type-broken, but a root's gate sees the completed batch.

## 4. Re-planning and termination

The planner is re-invoked when:

- a micro-task fails after its exchange budget;
- a root gate fails (tsc or tests);
- no micro-task is ready (blocked graph).

Each re-plan gets the full DAG, root/task status, failed-task diagnostics,
failed-root gate diagnostics, and the symbol index or blocked chain. The
amendment delta states the rules: done tasks immutable, failed tasks changed
before retry, new ids for new work, failed roots reopen for repair, passed roots closed, new roots for
repairs, final root `test`, `todo` is the active root's ready frontier.

Caps:

| Cap                         | Value              |
| --------------------------- | ------------------ |
| Tasks per DAG               | 64                 |
| Instruction length          | 4,000 chars        |
| Related locs per task       | 16                 |
| Exchanges per task          | 3                  |
| Planning DAGs per run       | 8                  |
| Planning attempts per turn  | 3                  |
| Consecutive length finishes | 3 (`output-limit`) |
| Token budget                | 120,000 default    |

A run ends `ok` only when every root is closed, the final root's `test` gate
passed, and every task is `done`. Failure paths use the existing termination
matrix plus `task-exhausted`; the run still makes one summary call. Provider
errors keep their own path.

## 5. CLI and result

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
- Text stdout names the completed task/file summary; `--format json` keeps the
  `typescript-coder-result@1` contract, and `files` aggregates the applied
  locators from the records.
- `LoopResult.tasks` carries the final per-task summary (`id`, `root`, optional
  `verify`, `action`, path, symbol, space, status). `terminationReason` can be
  `task-exhausted`.

## 6. Limitations (v1)

- **Multi-declarator variables.** `const a = 1, b = 2;` cannot be a whole-symbol
  task target; split the statement first (a matcher edit on one binding is
  still possible).
- **One file per task.** A task's main target plus `related` must share a file;
  cross-file changes are multiple tasks. Micro-task boundaries need not
  type-check; the enclosing root gate does.
- **Rename is same-file.** It inherits the existing renamer's scope (declaration
  plus same-file references). Cross-file renames need caller tasks first, or
  escalation.
- **No planning tools.** The planner sees the signature index and spec files,
  not declaration bodies. A requirement that needs inspection must be expressed
  as a coarse task the executor can inspect (a viewer/read is available there).
- **Passed roots are immutable.** A failed root reopens for repair; a passed
  root cannot be extended, so later work goes in a new root.
- **Intermediate type errors are expected.** A micro-task boundary may leave
  the file type-broken; the enclosing root gate is the type-correct boundary.
- **Test-file edits are allowed but discouraged.** The planner prompt treats
  `*.test.ts` as specification; a requirement that asks for test changes still
  needs them.

## 7. Verification

- `bun test src/tasks.test.ts` — every contract/DAG invariant.
- `bun test src/prompts/task.test.ts` — prompt shape and examples.
- `bun test src/task-loop.test.ts` — scripted end-to-end:
  one-task success, dependency chain, invalid-plan retry, failed-task re-plan,
  test-failure re-plan, create, delete, off-target reject, `TASK_DONE` guard,
  repeated-plan exhaustion, dispatcher routing, default-mode invariance.
- `just typecheck && just test`.
- `just accept` (offline), including `plan-exec-fix-answer`, which drives the
  real `runLoop` through a scripted planning turn and execution turn. No live
  run is part of this change.
