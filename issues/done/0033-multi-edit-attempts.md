---
id: 33
title: "Multi-edit attempts: serial application of N anchored edits"
status: done
priority: high
milestone: null
parent: 28
deps: [31]
labels: [harness]
created: 2026-10-17
---

## Context

R7: one attempt can touch exactly one symbol/range, so real tasks with several
change points need several round trips (and the benchmark's minilisp repairs
would re-emit per error). The anchor protocol (#31) defines an `edits` array
with exactly one entry; this issue lifts that to N entries applied serially.
The editor already supports multiple whole-symbol replacements with overlap
detection (src/editor.ts `applyEdits`), but the loop and the anchor matcher do
not yet.

## Goal

A single response may carry N anchored edits (bounded), applied in order with
the existing keep-progress semantics, verified once per attempt.

## Acceptance criteria

- [ ] `edits` accepts 1..N entries (cap decided at resolve, default 8);
      entries are applied serially in listed order, each anchor matched
      against the evolving file state (re-index between edits).
- [ ] Failure semantics: if an edit fails to match (not-found/ambiguous) the
      already-applied prefix is kept (#30 keep-progress); the diagnostic names
      the failing edit index and reason; the retry operates on the current
      state.
- [ ] Whole-attempt verification runs once after all edits are applied (tsc +
      tests as today); outcome and per-edit summary recorded via #29 fields.
- [ ] Prompts describe the multi-edit contract (fewest edits that cover the
      change, top-to-bottom order, unique anchors); the single-edit cap note
      from #31 is removed.
- [ ] Unit tests: two disjoint edits both apply; second-edit failure keeps the
      first; overlapping/duplicate anchors rejected; cap enforcement; loop
      integration test with a mock provider; gates green.
- [ ] Evidence: at least one offline replay (#40) exercising a multi-edit
      attempt.

## Verification

```
bun test
bun benchmark/replay.ts <bundle-with-multi-edit>
```

## Notes

- Depends on #31 (edits protocol + matcher).
- Multi-file orchestration stays out of scope (H4 horizon).
- Open item (resolve): per-edit max count and whether same-anchor duplicates
  are rejected up front.
- Validation (2026-10-18): cap fixed at `MAX_EDITS_PER_ATTEMPT = 8`
  (`LoopOptions.maxEditsPerAttempt` overrides; exported from `src/loop.ts`);
  exact duplicate anchors (trimmed string equality) are rejected up front, so
  both open items resolved. `parseEditsResponse` now accepts 1..N entries
  (shape-validates every entry; the `edits.length !== 1` rejection and its loop
  duplicate were removed).
- Serial application: `working` starts from `sourceBefore`; per edit the
  selected symbol is re-indexed in the evolved source (tolerant index +
  `findDefinition`) and `findAnchor` matches against it, so later anchors apply
  to the state shaped by earlier edits and stale offsets cannot overlap. Every
  replacement splices into the in-memory source; `formatSource` + the single
  verification (tsc + tests) run only after every edit applies. Over-cap
  responses and duplicate anchors fail before anything is applied; an edit that
  does not resolve/parse/match stops the sequence with
  `edits-invalid`/`anchor-not-found`/`anchor-ambiguous`.
- Failure diagnostics name the failing entry (`edit i of n: <reason>`, prefix
  only when n > 1 so single-edit wording from #31 is unchanged). Keep-progress:
  when a prefix was applied, it is formatted and written before the retry
  prompt is rebuilt (so the prompt shows the evolved state); if the prefix
  cannot be formatted it is discarded and the diagnostic says so. Records:
  `LoopAttempt.edits` / `appliedEdits` (replace mode only; equals `edits` on
  success), `replacement` = replacement texts joined with `\n`;
  `benchmark/run.ts` `AttemptSummary` carries both fields (null for the
  opencode side), documented in `benchmark/README.md`.
- Prompts (system, `buildReplacementPrompt`, `buildRetryPrompt`) now describe
  the multi-edit contract: 1..8 edits, fewest edits covering the change,
  ordered top-to-bottom, unique anchors matched against the evolving source,
  replacements are drop-in (keep leading keywords/modifiers — e.g. do not
  re-add `export` the anchor omitted); a two-edit example replaces the old
  single-edit one. Append mode wording unchanged. `spec.md` §1/§3/§6/M7/R6
  updated (edit set, serial re-indexed application, prefix kept, verify once).
- Tests: 550 → 557 (`src/loop.test.ts` "multi-edit attempts": two disjoint
  edits with a single verification, prefix kept when edit 2 of 2 fails and the
  retry prompt/disk show it, duplicate anchors rejected with nothing applied,
  later anchors matched against the evolved source (whole-symbol anchor after
  an inner edit → `edit 2 of 2` not-found), default cap 9 → rejected,
  `maxEditsPerAttempt: 2` override; `src/anchor.test.ts` multi-edit parsing and
  per-entry shape rejection; retry-prompt wording test updated).
- Evidence: `tmp/evidence-33.ts` recorded two bundles. A
  (`tmp/replays-33/multi-edit-ok.json`): one response with two disjoint edits,
  attempt `ok` (`edits=2, appliedEdits=2`), replay `prompt mismatches: none`.
  B (`tmp/replays-33/multi-edit-prefix.json`): edit 2 of 2 not found →
  diagnostic names it, the first edit stayed on disk, the retry saw the evolved
  source and passed (`edits=1`); replay `prompt mismatches: none`.
- Validation gates: tsc 0, `bun test` 557 pass, `accept` 5/5,
  `benchmark/check.ts` 3 PASS.
