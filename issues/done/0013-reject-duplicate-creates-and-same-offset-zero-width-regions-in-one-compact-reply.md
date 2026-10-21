---
id: 13
title: "Reject duplicate creates and same-offset zero-width regions in one compact reply"
status: done
priority: medium
milestone: null
parent: 12
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-22
---

## Context

Issue #11's json-parser run (`benchmark/results/2026-10-21-compact-baseline.json`) failed at the token budget after a first compact reply carried four clauses:

```
select const JsonValue in src/json.ts          # create draft
select function parseJson in src/json.ts       # create draft
select type JsonValue in src/json.ts resolve type    # corrected duplicate
select function parseJson in src/json.ts resolve value # corrected duplicate
```

Each clause is resolved against its file's pre-reply source (`src/compact.ts` `resolveCompactReply`; creates are queued at `source.length`). With `src/json.ts` absent, all four saw an undeclared symbol, all four became implicit creates at offset `0..0`, and all four were applied. The resulting file declares `JsonValue` and `parseJson` twice (lines 1/186 and 8/193 in the replay workspace).

Two guards should have stopped this:

- `applyResolvedRegions` (`src/loop.ts:3991`) rejects overlap with `current.start < previous.end`, so equal zero-width inserts at the same offset are not overlapping.
- `duplicateDeclarationDiagnostics` (`src/loop.ts:4339`) skips any name whose pre-edit count is `0`, so adding the same brand-new name twice in one reply is not a duplicate.

## Goal

Reject atomically any compact reply that would create the same `(path, kind, name)` twice, or place two zero-width regions at the same offset, writing nothing.

## Acceptance criteria

- [ ] A reply with two implicit creates of the same `(path, kind, name)` is rejected with a typed diagnostic and writes no file.
- [ ] Two zero-width regions at the same offset are treated as overlapping and rejected.
- [ ] The rejection names the conflicting clauses (or the repeated declaration) and uses the existing stage/cause vocabulary consistently.
- [ ] Existing single-create and legitimate multi-region/batch tests stay green.

## Verification

```
bun test src/compact.test.ts src/loop.test.ts
bunx tsc --noEmit
```

Add focused tests for (a) the four-clause draft-plus-correction reply above and (b) two same-offset zero-width creates. Assert the rejection and that the workspace source is unchanged.

## Notes

- The original replay bundle is under `tmp/replay-compact/` (prunable); the durable evidence is the #11 baseline JSON.
- Do not tune prompts or code against the held-out `csv-parser` fixture.
- Resolved. Create conflicts are now rejected at compact resolution: `src/compact.ts` derives the kind/name the fence body actually creates (`createBodyText`/`CreatedDeclaration`), keys queued creates by `path × kind × name`, and turns a repeat into a `duplicate` failure naming both clauses (`createConflictDiagnostics`); `CompactFailureStage` gains `duplicate`. The shared apply pass (`src/loop.ts` `applyResolvedRegions`) now tracks zero-width insert offsets, so two inserts at one offset are an overlap even when a same-start non-zero region sorts between them; adjacent non-zero regions stay legal. `duplicateDeclarationDiagnostics` also rejects a new name added twice in one pass (`occurrences > max(beforeCount, 1)`) with a dedicated message as defense-in-depth. Tests: resolver unit test for the four-clause draft-plus-correction reply (`src/compact.test.ts`) and two loop-level tests (four-clause rejection with no file written; two same-offset zero-width creates rejected and only the retry's Alpha created) in `src/loop.test.ts`. Observed: `bun test src/compact.test.ts src/loop.test.ts` 407 pass / 0 fail; `bunx tsc --noEmit` clean.
