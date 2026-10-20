---
id: 87
title: "Repair prompt: name the failing declaration in the tsc diagnostics"
status: todo
priority: medium
milestone: null
parent: 77
deps: []
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

#77's remaining minilisp repair cost is dominated by ordinary repair rounds, not storms: a large numbered source is re-sent each exchange and the model churns through `tsc` failures. The verification-repair prompt (`buildRetryPrompt`, `src/loop.ts:507`) carries the current source plus `formatDiagnostics` (`src/loop.ts:3459`). That renderer splits tsc errors into two buckets:

- diagnostics inside the just-edited range, shown as `replacement line N: <code>: <message>` with a code frame;
- everything else, shown under `elsewhere in file:` as raw `src/x.ts(line,col): error TSxxxx: message`.

Neither bucket names the declaration the diagnostic sits in. Yet the prompt repeatedly instructs the model to "re-pin to a declaration the diagnostics name" (`src/loop.ts:530`, `src/loop.ts:1466`, `src/loop.ts:1555`). The diagnostics do not in fact name a declaration, so the model must infer it from raw line numbers against a large file — exactly the blind re-pin the prompt is trying to steer away from.

The symbol index already knows every declaration: `SymbolIndex` (`src/utility.ts:479`), `topLevelDeclarations` (`src/loop.ts:3021`) and the parser's node spans. Mapping each diagnostic location to its enclosing declaration is a rendering change, not a new index.

## Goal

Annotate each located tsc diagnostic in a repair prompt with the declaration (name and kind) whose span contains it, so the model is pointed at the failing declaration instead of a raw line.

## Acceptance criteria

- [ ] Every located diagnostic rendered in the repair/continuation prompt that falls inside a top-level declaration carries that declaration's name and kind (for example `in declaration \`LispValue\` (type)`); a diagnostic outside every declaration renders as today.
- [ ] The mapping reuses the existing parser/symbol index (no second TypeScript program, no new dependency); rendering is deterministic and stays inside the existing diagnostics character limit and head/tail truncation.
- [ ] The in-edited-range (`replacement line N`) rendering and the `elsewhere in file:` shape are otherwise unchanged.
- [ ] Unit tests cover: a diagnostic mapping to a declaration; one not inside any declaration; the existing replacement-line rendering still holds.
- [ ] json/sexp happy paths are unaffected (they rarely reach a repair round); gates stay green.
- [ ] Live: two tc-side matrices each show json 3/3, sexp 3/3, minilisp >=2/3 with minilisp tokens per success below the #47 baseline (30,398) and overall below 19,377 — or an argued negative result (with evidence) that naming the declaration does not reduce repair tokens.
- [ ] `benchmark/results/consumption.md` rows added; #77 updated.

## Verification

```
bun test
bunx tsc --noEmit
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-tc-diagdecl.json --replay-dir tmp/replays-<name>
bun run accept
bun benchmark/check.ts
```

plus replay inspection that a repair prompt renders the enclosing-declaration annotation.

## Notes

- Parent #77; one of #77's listed candidate directions ("a diagnostic-to-declaration map so a repair prompt names the failing declaration, not just the file").
- Makes the prompt's existing "re-pin to a declaration the diagnostics name" instruction true rather than aspirational.
- Non-goals: hard caps, auto-stops, weakening guards; no unified-diff bypass.
- Priority defaulted to medium; no milestone.
