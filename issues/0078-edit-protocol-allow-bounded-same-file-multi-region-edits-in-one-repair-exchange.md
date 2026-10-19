---
id: 78
title: "Edit protocol: allow bounded same-file multi-region edits in one repair exchange"
status: todo
priority: medium
milestone: null
parent: 46
deps: []
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

The minilisp repair storm (evidence for #77; `tmp/replays-76-mini-8/minilisp-tc-rep1.json`, 25 calls / 117,380 tokens / `edit-exhausted`) needed a **single coordinated change spanning two declarations in the same file**: widen `LispValue` (`Builtin | Closure`) and reconcile `Expr`. The repair exchange applies **one region per exchange**, so the model could only fix one declaration at a time; each single edit re-computes `tsc` and surfaces fresh errors, producing type-error whack-a-mole that ran 23 exchanges.

The protocol today is deliberately limited:

- The v2 `{"edits":[...]}` batch was **removed**; a reply now carries one flat edit object (`src/loop.ts:777-778` rejects `"edits"`).
- `#69` re-added a multi-payload variant (`{"payloads":[...]}`) but it is **path-independent — at most one payload per file** (`src/loop.ts:984-1001`), and it is **opt-in, default off** (`src/cli.ts:13`, `benchmark/run.ts:441`).
- Same-file / same-symbol multi-range batching is explicitly **reserved for later** (`src/loop.ts:984-985`; `#72` notes "extension filed separately when needed"), and that follow-up was never filed.

The low-level applier already supports it: `applyEdits` takes N replacements, sorts them, and rejects overlaps (`src/editor.ts:26-63`). Only the parse/prompt layer restricts a repair exchange to one region.

## Goal

A repair (modify) exchange can carry a bounded set of non-overlapping edits to the **same** file and apply them atomically.

## Acceptance criteria

- [ ] The repair exchange accepts a bounded batch of edits that share one file (N non-overlapping regions), reusing the `#69` multi-payload shape or an explicit same-file sibling shape; overlap semantics are defined.
- [ ] Application is atomic: if any region fails its own guard (address / matcher / range / no-op) or two regions overlap, nothing is written and the rejection names the failing region(s).
- [ ] Per-region guards are unchanged: no-op, duplicate-declaration, repeat, and symbol-pin echo still apply to every region.
- [ ] Cross-file batching (`#69`) behavior and the default single-payload protocol are unchanged unless the variant is opted in.
- [ ] Unit tests cover: same-file two-region success; overlapping-region rejection (nothing written); one bad region rolling back the whole exchange; no-op/duplicate still rejected per region.

## Verification

`bun test` and `bunx tsc --noEmit` green, with the new unit tests above. If the variant is kept opt-in, a benchmark row comparing on/off (success rate and storm spend) is recorded in `benchmark/results/consumption.md`; a non-regression is sufficient unless a gain is claimed.

## Notes

- Extends `#69` (path-independent only) and completes the interface `#72` left open for same-symbol multi-range.
- Low-level capability already exists in `src/editor.ts`; this is a parse/prompt-layer change.
- Open questions: same-symbol multi-range vs multi-symbol-same-file; region ordering and overlap policy; whether the variant stays opt-in (parity with `#69`) or becomes default.
- Non-goals: weakening the matcher/echo/duplicate guards; unified diffs; trading success rate for tokens.
- Parent: `#46`. Priority defaulted to medium; no milestone.
