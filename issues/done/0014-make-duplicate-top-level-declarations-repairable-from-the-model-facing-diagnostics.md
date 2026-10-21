---
id: 14
title: "Make duplicate top-level declarations repairable from the model-facing diagnostics"
status: done
priority: medium
milestone: null
parent: 12
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-22
---

## Context

When a file already contains two top-level declarations with the same name, TypeScript reports a duplicate identifier but the loop gives the model no repair path. `Scope.add` (`src/utility.ts:52`) merges same-name declarations into one symbol, and `indexEntriesForFile` (`src/utility.ts:715`) emits only `symbol.declarations[0]`. Therefore:

- `lookup` returns one match, so the ambiguity branch in `resolveCurrentEntry` (`src/loop.ts:3504`) is never reached for this case;
- `select type JsonValue` always addresses the first declaration;
- rewriting it with the same text is rejected as `no-op` (`src/loop.ts:3535`) while the second copy keeps tsc red.

Issue #11's json-parser run hit exactly this and looped for 40+ exchanges to the token budget.

## Goal

Make a duplicate top-level declaration repairable by the model without selecting it by name, or expose the duplicates as an explicit ambiguous address.

## Acceptance criteria

- [ ] Given a file with two same-name top-level declarations, the model-facing retry diagnostics identify the duplicate location(s) and give a repair that does not rely on selecting it by name (for example a `range`-based delete/rewrite with an empty or targeted fence), or address resolution reports ambiguity naming both declarations.
- [ ] A loop-level test drives that path end to end: the reply using the prescribed repair removes the duplicate and verification can proceed.
- [ ] Single-declaration behavior, existing address diagnostics, and the normal no-op guard stay unchanged.

## Verification

```
bun test src/loop.test.ts src/utility.test.ts
bunx tsc --noEmit
```

Add a fixture with two same-name declarations and assert the diagnostic text plus the successful repair turn.

## Notes

- Either implementation is acceptable (range-based hint or duplicate-preserving index with ambiguity); pick one and state it in the Notes when resolving.
- Do not tune prompts or code against the held-out `csv-parser` fixture.
- The #11 baseline remains the reference for the reproduced failure; this issue fixes repair, not measurement.
- Resolved by making duplicates visible and giving a grammar-valid repair, while keeping the index merge. `src/utility.ts` adds `duplicateDeclarations(symbol)`: it returns the merged declarations only for the kinds tsc rejects on redeclaration (bodyful function, class, type alias), so overloads/interfaces/enums/namespaces stay unflagged. `src/compact.ts` adds `duplicateDeclarationNote` naming every `path:line`, plus `CompactViewer.duplicates`/`duplicateNote`; `renderViewerFeedback` now renders every copy instead of hiding the merged-out declarations, and the note is attached to no-op diagnostics too. The prescribed repair uses the existing grammar: the address edits the first (indexed) copy, an identical whole-declaration replacement is a no-op, and an empty fence deletes the indexed copy, which removes one duplicate and exposes the remaining declaration for the next turn. Loop details receive the note via `buildCompactDetailsPrompt` (`src/loop.ts`). Also fixed the empty-fence whole-declaration delete to include a leading `export`/`export default` modifier so no dangling keyword is left behind (`src/cascade.ts` `resolveCascade`, `src/loop.ts` `resolveEntrySplice`). Tests: compact unit tests for the duplicate viewer/note (`src/compact.test.ts`), and a loop-level fixture with two `answer` declarations that goes select (details name both copies and the repair) -> identical rewrite (no-op retry still carries the note) -> empty-fence delete -> verification passes (`src/loop.test.ts` `a duplicate top-level declaration is named in retry diagnostics and repairable by deletion`). Observed: `bun test src/loop.test.ts src/utility.test.ts` 390 pass / 0 fail; `bun test src/compact.test.ts` 60 pass / 0 fail; `bunx tsc --noEmit` clean.
