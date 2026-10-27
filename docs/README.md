# Documentation

`tc` is a TypeScript coding agent built around a pinned-repair feedback loop and
an optional plan-exec loop. The documentation is split so each semantic has one
owner; this page is the map, the vocabulary, and the reading order.

## Documentation map

| Document                               | Owns                                                                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`feedback-loop.md`](feedback-loop.md) | Cross-mode lifecycle: AgentMode, rounds/exchanges, pinned-repair Edit → Verify, failure/termination policy, caps, records/result, `runLoop`.                                             |
| [`plan-exec.md`](plan-exec.md)         | Plan → Execute → Review: WorkNode DAG model, Plan/patch DSL, planning/review, validation, scheduling, executor autonomy, gates, progress bounds, CLI/result, limitations, verification.  |
| [`edit-protocol.md`](edit-protocol.md) | Edit-action reply language: edit-dsl, sentinel fence, select clause/file command grammar (BNF), cascade, viewers/editors, failure stages, application/gating, repair feedback, skeleton. |
| [`glossary.yaml`](glossary.yaml)       | Benchmark/test/evaluation terminology: harnesses, judge, metrics, ledger, replay, artifacts.                                                                                             |

Recommended reading order:

1. This page for vocabulary and ownership.
2. [`feedback-loop.md`](feedback-loop.md) for the loop every mode shares.
3. [`edit-protocol.md`](edit-protocol.md) for what the model may reply and how it
   is applied.
4. [`plan-exec.md`](plan-exec.md) for the plan-exec model and scheduling.
5. [`glossary.yaml`](glossary.yaml) when working on tests, acceptance,
   benchmarks, metrics, or the ledger.

## Canonical vocabulary

| Term               | Meaning                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **statement**      | One select clause or one file command.                                                                                  |
| **select clause**  | A statement beginning with `select`; it may be a viewer or an editor. A select clause is never a file command.          |
| **file command**   | `create`, `delete`, `read`, or `write`.                                                                                 |
| **edit-action**    | The model reply language that describes an edit: edit-dsl statements.                                                   |
| **edit-dsl**       | The only wire format for an edit-action: one or more statements.                                                        |
| **target**         | The resolved declaration or file an edit-action acts on; a file command targets by path rather than address.            |
| **address**        | The resolved `(path, symbol, kind)` triple that identifies a declaration.                                               |
| **locator**        | Pre-resolution address input: the path/name/kind a statement names before the guards run.                               |
| **region**         | The final splice range: the half-open source span a `replace` or `write` rewrites.                                      |
| **AgentMode**      | The loop shape: `pinned-repair` (default) or `plan-exec`.                                                               |
| **selection mode** | The pinned target mode: `modify`, `create`, or `delete`.                                                                |
| **WorkNode**       | One task-level unit in the plan-exec DAG: `id`, `after`, `verify`, `instruction`, `hints`, optional `approach`/`phase`. |
| **fence**          | The sentinel edit-action fence: exact `<<<TC_EDIT_BEGIN>>>` and `<<<TC_EDIT_END>>>` lines around a raw body.            |
| **outer wrapper**  | A whole-reply Markdown fence tolerated around a complete reply; it is not a `<fence>`.                                  |

## Ownership rules

- Each semantic has exactly one owner; other documents link instead of
  redefining it.
- `feedback-loop.md` may summarize plan-exec, but the Plan model, Plan DSL,
  patch DSL, and scheduling are owned by `plan-exec.md`.
- `plan-exec.md` owns the WorkNode model, scheduling, executor autonomy, review, and gates, but the edit-action grammar, resolution cascade, and generic application/gating are owned by `edit-protocol.md`.
- `feedback-loop.md` and `plan-exec.md` own retry and termination policy;
  `edit-protocol.md` owns the failure-stage vocabulary and repair-feedback
  content.
- `feedback-loop.md` owns the cross-mode `LoopRecord`/`LoopResult` contract;
  `plan-exec.md` owns the plan-exec-only `usage`, `warnings`, and `nodes` result
  fields and the WorkNode schema (`typescript-coder-result@3`).
- `glossary.yaml` is not a second protocol reference: protocol and loop
  vocabulary is canonical here and in the three loop/protocol documents.
