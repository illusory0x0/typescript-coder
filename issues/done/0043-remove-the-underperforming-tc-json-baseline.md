---
id: 43
title: "Remove the underperforming tc json baseline"
status: done
priority: low
milestone: null
parent: null
deps: []
labels: [benchmark, docs]
created: 2026-10-25
---

## Context

The frozen `tc` JSON baseline is not a useful comparison point anymore. The
2026-10-25 baseline finished **11/12** with a mean of **12,274 cache-excluded
tokens** across four tasks, versus the oc baseline's **12/12 / 8,904**. Its
`minilisp` row dominates the average: **42,732 mean tokens** and one
`token-budget` failure, while the other tasks are much smaller.

The benchmark now rejects `--protocol-format json` and runs `edit-dsl` only.
Keeping the JSON baseline forces every report to carry a second, noisy factor
(`vs tc json`) and keeps stale-hash/provenance maintenance for data that is no
longer actionable. The current `mini-spreadsheet` work also has no JSON
baseline and is intentionally outside the frozen four-task hash.

Requested disposition: record this finding, make the cleanup low priority, and
remove the JSON baseline from the active benchmark surface.

## Goal

Retire the underperforming tc JSON baseline while preserving historical result
artifacts and the JSON replay/frozen-protocol compatibility path.

## Acceptance criteria

- [ ] Delete `benchmark/results/json-format-baseline.json` and
      `benchmark/results/json-format-baseline.md` from the active tree; git
      history remains the archive.
- [ ] Remove JSON-baseline loading and the `vs tc json` factor from the active
      benchmark report path; reports compare tc modes against the oc baseline
      only.
- [ ] Update `AGENTS.md`, `benchmark/README.md`, and
      `benchmark/results/consumption.md` so they no longer present the JSON
      baseline as an active frozen reference.
- [ ] Preserve the `json` protocol's frozen/rejected guard and replay parsing;
      this issue removes the comparison baseline, not historical compatibility.
- [ ] Update or remove tests that stage `json-format-baseline.json` for the
      four-way report; add/adjust coverage for the oc-only comparison.
- [ ] Leave dated files under `benchmark/results/` that merely cite the old
      baseline untouched.
- [ ] `just typecheck && just test` passes.
- [ ] `bun run benchmark/check.ts` passes.
- [ ] No live benchmark or baseline re-freeze is required.

## Verification

```sh
just typecheck && just test
bun run benchmark/check.ts
rg -n 'json-format-baseline|vs tc json|tc json baseline' \
  AGENTS.md benchmark/README.md benchmark/run.ts src benchmark/results/consumption.md
```

The `rg` must report no live references; historical dated reports are excluded.

## Notes

Low priority: this is a cleanup of a weak comparison point, not a correctness
or active-run blocker. The JSON protocol itself remains frozen for old replay
bundles and flags; deleting historical reports is out of scope.
- Resolved 2026-10-26: removed the JSON baseline loader and the four-way/vs tc json report path; tc reports now compare against the oc baseline only. Deleted the two baseline artifacts and updated AGENTS.md, benchmark/README.md, and consumption.md; the json protocol guard and replay compatibility are unchanged. Verified: bun test src/benchmark-run.test.ts (28 pass), just typecheck && just test (1490 pass), bun run benchmark/check.ts (5 passed, 0 failed ledger failures), and the live-reference rg is clean.
