---
id: 56
title: "Add pinned-repair output contract and scaffold guidance"
status: done
priority: medium
milestone: null
parent: 55
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-27
---

## Context

Plan-exec's executor prompt now explicitly says that no tools are available, that `read/select/write/create/delete` are literal edit-dsl commands, and that DSML/tool-call markup and sentinel blocks have specific meanings. Pinned-repair's `src/prompts/edit-dsl.ts` prompt still says only "no prose, no JSON" and lacks the scaffold/whole-file guidance added to the plan-exec execution prompt.

This child ports only the portable prompt/soft-guidance pieces. It does not port the WorkNode DAG, final-test-node requirement, or early test checkpoint.

## Goal

Give pinned-repair the same portable executor output contract and soft scaffold/whole-file guidance as plan-exec, without plan-specific constraints.

## Acceptance criteria

- [ ] The pinned-repair system prompt explicitly says no tools are available; `read`, `select`, `write`, `create`, and `delete` are literal text commands, not function calls; never emit `<|...|>` / `<｜...｜>` / DSML/tool-call markup; the `<<<TC_EDIT_BEGIN>>>` block is plain text, not a Markdown fence or tool-call boundary.
- [ ] The pinned prompt advises, softly, that a new large file/module is often cheapest as one whole-file `write` scaffold followed by targeted edits, and that dozens of initial `create` clauses are usually not the best first move.
- [ ] The guidance is advisory: `write`, `create`, and large writes remain valid; no runtime rejection or clause-count/size cap is added for not following it.
- [ ] No WorkNode DAG, final-test-node rule, or early test checkpoint is added to pinned-repair.
- [ ] Prompt tests cover the contract and scaffold guidance; prompt/parity tests and existing pinned behavior stay green.
- [ ] No live benchmark and no frozen baseline change.

## Verification

```sh
bun test src/prompts/parity.test.ts
bun test src/loop.test.ts
just typecheck && just test
just accept
git diff --check
```

## Notes

- Prefer a shared contract literal with plan-exec if that avoids prompt drift, but do not change plan-exec semantics in this child.
- Do not add hard style constraints; this is soft guidance only.
- Starting: port the portable executor output contract (no tools/DSML, literal sentinel) and soft new-file scaffold guidance to the pinned-repair prompt; no plan-specific machinery.
- Resolved: added the pinned-repair output contract (no tools; literal edit-dsl commands; no DSML/tool-call markup; sentinel is plain text; no prose/JSON/Markdown fence) and soft new-large-file whole-write scaffold guidance. No plan DAG/final-test/early-checkpoint language. Tests cover the contract and advisory nature; parity hashes updated for the pinned prompt only. Verified: typecheck, 1668 tests pass, accept 9/9, diff check. No live; no baseline change.
