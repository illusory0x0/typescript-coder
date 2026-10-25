---
id: 34
title: "Rename modes to pinned-repair and plan-exec-review with aliases"
status: done
priority: medium
milestone: null
parent: 26
deps: [31]
labels: [agent-loop, benchmark, docs]
created: 2026-10-25
---

## Context

The naming discussion found `edit` too broad and `direct-edit` inaccurate. The pinned-repair loop is defined by one pinned selection, bounded repair context, repair-context shrink, attempt digest, and failure history. The new plan loop is defined by Plan -> Execute -> Review. Canonical names are therefore `pinned-repair` and `plan-exec-review`.

## Goal

Rename the modes to `pinned-repair` / `plan-exec-review` across the CLI, loop dispatch, benchmark/replay values, and help text, while keeping `edit` / `plan-exec` as deprecated aliases and preserving historical rows.

## Acceptance criteria

- [ ] `--mode` and `--agent-mode` accept canonical `pinned-repair`, `plan-exec-review`, and `both`.
- [ ] `edit` maps to `pinned-repair`; `plan-exec` maps to `plan-exec-review`; invalid values still reject with a clear message.
- [ ] `--mode pinned-repair` keeps the existing single-target Edit -> Verify behavior byte-identical; `--mode plan-exec-review` dispatches to the incremental V2 loop.
- [ ] `both` measures both canonical modes.
- [ ] `agentMode` types, benchmark rows, replay bundles, and result/CLI diagnostics use canonical values; historical `edit`/`plan-exec` rows are read through the alias mapping.
- [ ] CLI help, error text, and docs in code are updated; `plan-exec`/`edit` remain only as aliases or historical labels.
- [ ] Tests cover parseArgs, dispatch, alias mapping, benchmark parsing, and help text.
- [ ] `just typecheck && just test` passes.
- [ ] No benchmark or live model run is required.

## Verification

- `bun test src/cli.test.ts src/benchmark-run.test.ts src/replay-runner.test.ts`
- `just typecheck && just test`
- Parse `--mode pinned-repair`, `--mode plan-exec-review`, `--agent-mode both`, and the two aliases.

## Notes

- Depends on #31 for the new loop.
- Full documentation sync is #35; this issue covers code/CLI/benchmark values and their tests.
- Do not rename historical result files or rewrite old rows.
- Resolved: AgentMode is canonical pinned-repair|plan-exec-review; canonicalAgentMode maps edit/plan-exec; CLI dispatch/help/restrictions and acceptance use canonical; benchmark parser accepts canonical, aliases, and both (both expands to both modes), run/aggregate rows canonical, historical baseline rows normalized; replay bundles write canonical and read legacy; provenance keeps the historical plan-exec loop-config literal for hash stability. Single-run CLI rejects --mode both with a benchmark-only message (one process runs one loop); benchmark --agent-mode both is accepted. Verification: just typecheck && just test -> 1430 pass, 0 fail (317.27s); just accept -> 8 passed.
- Postscript 2026-10-25: the canonical loop mode is renamed back to `plan-exec`; the follow-up removed the `plan-exec-review` alias entirely, so only `edit` remains deprecated. The acceptance scenario is now `plan-exec-fix-answer`. Verification after both changes: `just typecheck`; `just test` -> 1430 pass, 0 fail; `just accept` -> 8 passed.
