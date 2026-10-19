---
id: 66
title: "Pin benchmark record provenance and verify the ledger against its sources"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [benchmark]
created: 2026-10-19
---

## Context

mri-project keeps committed compact eval snapshots that carry content hashes
of the experiment inputs, so a stale record is detectable and pruning is safe
(`mri-project/docs/adr/0010-commit-compact-eval-summaries.md`). tc does the
opposite: `benchmark/results/consumption.md` rows are hand-copied from result
JSONs, most intermediate results are untracked (4 tracked vs ~34 on disk as of
2026-10-19), and nothing pins which fixture text, prompt text, loop
configuration, or pricing table produced a number — the #55 prompt regression
was caught only because a human noticed the tokens move. If the fixture,
prompt, config, or pricing changes silently, no recorded row is invalidated
automatically.

Source survey: `/home/illu/repo/mri` absorption study (2026-10-19), insight 2.

## Goal

Every result record pins the exact inputs it measured, and a zero-API check
verifies each `consumption.md` row against its source JSON.

## Acceptance criteria

- [ ] Result JSONs carry content hashes for the measured inputs: fixture/task
      text, model-facing prompt text (system + protocol), loop config (budgets,
      caps, effort), and the pricing table; the definitions and computation
      points are documented in `benchmark/README.md`.
- [ ] A zero-API check (`benchmark/check.ts` or a sibling script) re-derives
      each `consumption.md` row's values from its cited source JSON; a mismatch
      fails and names the row.
- [ ] The check flags a row whose recorded input hash differs from the current
      tree's (stale after a prompt/fixture/config change) without re-running.
- [ ] Tests cover hash computation and the ledger check; gates green.
- [ ] Decision landed: the durable set under `benchmark/results/` is declared
      (which files are tracked, which may be pruned) — needed before any
      staleness/pruning rule is meaningful.

## Verification

`bun benchmark/check.ts` (extended) on the current ledger; plus a deliberately
corrupted copy of one row must fail the check.

## Notes

- Source: mri-project ADR 0010 and `docs/spec/harness.md` "Reports and
  snapshots".
- Extends #63 (USD reporting, done). Folds in the "snapshot-pin or revision
  list for the model-facing protocol block" idea: a prompt change should
  explicitly invalidate comparability of earlier rows.
- Durability decision (2026-10-19): **cited = durable** — a result file
  (`<name>.json` + its `.md` report) is durable once a `consumption.md` row or
  an issue cites it as evidence; unreferenced one-off artifacts may be pruned;
  replay bundles stay under `tmp/`. Recorded in `benchmark/README.md`
  §"Evidence and provenance".
- Priority defaulted to medium; no milestone.

### Implementation (2026-10-19)

Landed in `src/provenance.ts` (+ `src/provenance.test.ts`), `benchmark/run.ts`,
`benchmark/check.ts`, `benchmark/README.md` §"Input provenance hashes (#66)".

- **Criterion 1:** every result JSON now carries a top-level `provenance` block
  with per-input sha256 digests (`model`, `taskIssue`, `fixture`,
  `systemPrompt`, `loopConfig`, `pricing`) plus a derived `inputHash` and
  `computedAt`; computed from the same tree the runs read
  (`currentInputHashes`), so a fixture/prompt/config/pricing change moves a
  digest and invalidates earlier rows. Additive; no existing field changed.
- **Criterion 2:** `benchmark/check.ts` gained a zero-API ledger pass over the
  canonical `## Rows` table: it re-derives each row's per-task/overall USD per
  success and `ok/runs` from the cited source JSON (5-decimal rounding) and
  **fails**, naming the row, on mismatch or a missing source. A corrupted-copy
  probe failed as required (`$0.01850` -> `$0.01851` named the #69 "on" row).
- **Criterion 3:** the pass prints a `stale:` line for any row whose recorded
  hashes differ from the current tree; today all 13 rows are stale because they
  predate #66. Stale is a warning, not a failure.
- **Criterion 4:** `src/provenance.test.ts` covers hash determinism/stability,
  the derived hash, ledger parsing, row re-derivation, and the corrupted-row
  failure; `bunx tsc --noEmit` 0, `bun test` 702 pass, accept 5/5,
  `bun benchmark/check.ts` 3 PASS + `ledger: 13 rows, 13 checked, 0 failed`.
- **Criterion 5:** the durable-set declaration ("cited = durable") is landed in
  `benchmark/README.md` §"Evidence and provenance"; the check stands on it.

Decision recorded: the `### oc comparison baselines` table is intentionally
**not** row-checked — its values are means/minima across multiple files (and
the older `2026-10-19-oc-none.json` has no `cost` fields), so no single-JSON
re-derivation exists; this exclusion is documented in the README and the check
summary. Cross-side baseline durability remains the cited-file rule.
