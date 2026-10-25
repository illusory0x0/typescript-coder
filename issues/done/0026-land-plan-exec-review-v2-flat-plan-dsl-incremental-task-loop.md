---
id: 26
title: "Land plan-exec-review V2: flat Plan DSL + incremental Task loop"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop, docs]
created: 2026-10-25
---

## Context

The 2026-10-25 tc-only benchmark measured `plan-exec` at 11/20 versus `tc edit` at 20/20, with 6.2x the tokens and 10.5x the cost per success. The failures clustered in the class-based `json-parser` and `minilisp` runs; the diagnosis is recorded in the conversation and the target contract is now `docs/spec.md`.

The redesign replaces the JSON `Plan -> Stage -> Task -> Edit` tree with a flat Plan DSL, plans only the current Task, adds a post-execution planner review, adds tolerant parsing and shared diagnostics, and renames the two modes.

## Goal

Ship `plan-exec-review` V2: a flat Plan/patch DSL, incremental current-Task planning, post-execution review, tolerant diagnostics, functional-first prompts, string node IDs, result schema `@2`, and canonical mode names `pinned-repair` / `plan-exec-review`.

## Acceptance criteria

- [ ] Children #27-#35 are `done` or `wontfix`.
- [ ] `--mode plan-exec-review` uses the flat Plan DSL and patch DSL; the JSON plan parser is removed.
- [ ] Planning is current-Task-only: initial Plan + one current Stage + one current Task; the next Task/Stage is planned only after the current Task is executed and reviewed.
- [ ] Post-execution review sees the gate result and a concise applied diff; it can approve or issue one current-Task patch.
- [ ] Both Plan DSL and edit-action DSL have tolerant parsing and shared, coded diagnostics, without partial destructive application.
- [ ] Canonical modes are `pinned-repair`, `plan-exec-review`, and `both`; `edit` and `plan-exec` remain readable aliases for historical rows.
- [ ] `LoopResult.tasks` uses string `id` / `stage` / `task` and the JSON result contract is `typescript-coder-result@2`.
- [ ] `docs/spec.md`, `docs/agent-loop.md`, `AGENTS.md`, and the acceptance scenario describe the shipped behavior.
- [ ] `just typecheck && just test` and `just accept` pass.
- [ ] No benchmark or live model run is required by this umbrella.

## Verification

- `just typecheck && just test`
- `just accept`
- Review the final `docs/spec.md` status and the result contract documentation.
- Check that no stale `--mode edit` / `--mode plan-exec` canonical strings remain outside aliases and historical artifacts.

## Notes

- Design source: `docs/spec.md` (status is currently `design target`).
- `#25` is related but not a dependency: it tracks the folded-source prompt, not the V2 redesign.
- No runtime JSON plan fallback and no JSON-to-DSL migration tool in v1.
- All priorities default to `medium` and milestone `null`; change them only if the tracker owner asks.
- Closed as umbrella: children #27-#35 are done. Canonical pinned-repair/plan-exec-review modes and aliases, flat Plan/patch DSL, current-Task incremental loop, post-execution review, tolerant coded diagnostics, functional-first prompts, string ids, and result @2 are shipped; docs/spec is as-built and acceptance uses plan-exec-review-fix-answer. Verification: just typecheck && just test -> 1430 pass, 0 fail (320.24s); just accept -> 8 passed.
