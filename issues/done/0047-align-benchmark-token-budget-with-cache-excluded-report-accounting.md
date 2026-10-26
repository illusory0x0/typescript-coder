---
id: 47
title: "Align benchmark token-budget with cache-excluded report accounting"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [benchmark, docs]
created: 2026-10-26
---

## Context

`--token-budget` is not the same metric as the benchmark report's
cache-excluded total, despite the earlier claim that they were aligned.

The latest mini-spreadsheet run reports:

```text
loopDiagnostics: 123,495 cache-excluded (earlier run)
report billable: 166,977
```

Two differences explain the gap:

- `budgetTokensFromResponse` uses cache-miss input + completion tokens and does
  not add `completion_tokens_details.reasoning_tokens`; the report's
  `normalizeBuckets` adds reasoning to output.
- The benchmark report sums every provider call, including the final
  `explain()` summary call made after a termination decision; `usageState` and
  the loop budget stop before that call.

The frozen oc baseline uses the report's cache-excluded billable metric, so the
current budget diagnostic and the oc/report headline are not directly
comparable.

## Goal

Make the token-budget stop and the report use one explicitly documented
accounting model, or expose separate loop and post-termination totals so no
claim of identity is false.

## Acceptance criteria

- [ ] `budgetTokensFromResponse` includes reasoning tokens when the basis is
      `cache-excluded`.
- [ ] The report exposes `billable.loop` (loop budget basis) and
      `billable.total` (including the final explanation), or explicitly
      excludes explanation from the headline with documented rationale.
- [ ] `--token-budget` documentation and benchmark README no longer claim the
      budget is exactly the report/oc cache-excluded total.
- [ ] Add deterministic tests for a reasoning-bearing response and for the
      post-termination explanation effect.
- [ ] The core CLI's historical raw budget basis remains unchanged.
- [ ] No frozen baseline files are regenerated or modified.
- [ ] `just typecheck && just test` passes.

## Verification

```sh
bun test src/loop.test.ts -t "budget"
bun test src/task-loop.test.ts -t "budget"
just typecheck && just test
```

## Notes

This issue is independent of the plan-exec code-generation failures. It is
filed because the accounting mismatch makes benchmark token comparisons and
budget diagnostics misleading.
- Starting work: align cache-excluded budget basis with report accounting; expose loop vs total billable; update docs; add deterministic tests. No baseline regeneration.
- Resolved: cache-excluded loop budget now includes reasoning; LoopTokens carries reasoning; tc report rows expose billable.loop (loop-only budget basis) alongside billable.total (all calls, including the termination summary); docs and CLI help state the distinction. Deterministic tests cover reasoning, the post-termination summary, plan-exec, and report rendering. just typecheck + just test: 1503 pass, 0 fail. No baseline changes.
