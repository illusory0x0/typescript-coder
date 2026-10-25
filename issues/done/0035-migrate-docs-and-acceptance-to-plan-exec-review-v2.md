---
id: 35
title: "Migrate docs and acceptance to plan-exec-review V2"
status: done
priority: medium
milestone: null
parent: 26
deps: [27, 28, 29, 30, 31, 32, 33, 34]
labels: [agent-loop, edit-protocol, docs, benchmark]
created: 2026-10-25
---

## Context

`docs/spec.md` is the design target for V2; the old docs and acceptance scenario still describe `plan-exec`, JSON plans, numeric ids, and the pre-review flow. The implementation is complete only when the docs and acceptance harness match the shipped behavior.

## Goal

Migrate the human-facing docs and acceptance harness to `plan-exec-review` V2, mark the spec as as-built, and run the full offline integration suite.

## Acceptance criteria

- [ ] `docs/spec.md` status changes from design target to implemented/as-built and its contract matches the code (IDs, flat DSL, patch/finish, incremental loop, review, tolerant diagnostics, caps).
- [ ] `docs/agent-loop.md`, `AGENTS.md`, and any touched glossary/edit-protocol text use `pinned-repair` / `plan-exec-review` and the V2 flow; legacy aliases and historical labels are clearly marked.
- [ ] `acceptance/scenarios.ts` contains a flat-DSL `plan-exec-review-fix-answer` scenario and the acceptance suite passes.
- [ ] No stale canonical `--mode edit` / `--mode plan-exec` strings or JSON plan examples remain outside aliases, historical artifacts, and migration notes.
- [ ] `typescript-coder-result@2` and review/planning/execution usage documentation are reflected where the result contract is described.
- [ ] `just typecheck && just test` passes.
- [ ] `just accept` passes (8/8 or the updated scenario count).
- [ ] No benchmark or live model run is required.

## Verification

- `just typecheck && just test`
- `just accept`
- `grep` the repo for stale canonical mode names and JSON plan examples.
- Review the final spec status and acceptance report.

## Notes

- Depends on #27-#34.
- `#25` may remain in review; this issue does not claim its folded-source live criterion.
- Do not run `just accept --live` or the benchmark.
- Resolved: docs/spec marked implemented/as-built and aligned to shipped IDs/BNF, flat Plan/patch DSL, incremental loop/review, finish/finalTaskId, tolerant diagnostics/codes, usage buckets/warnings, caps, and benchmark-only both; docs/agent-loop, AGENTS.md, glossary, and benchmark README updated to canonical pinned-repair/plan-exec-review with aliases/historical labels marked; acceptance scenario renamed plan-exec-review-fix-answer with flat DSL/review; external grep only shows canonical plan-exec-review prefixes and historical @1/JSON-plan caveats. Verification: just typecheck && just test -> 1430 pass, 0 fail (320.24s); just accept -> 8 passed.
