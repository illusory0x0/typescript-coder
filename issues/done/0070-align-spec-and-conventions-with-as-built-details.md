---
id: 70
title: "Align spec and conventions with as-built details"
status: done
priority: low
milestone: null
parent: null
deps: []
labels: [harness]
created: 2026-10-19
---

## Context

Follow-up from the 2026-10-19 design-survey reconciliation of `docs/design.md`
(now code-accurate). The obvious factual errors were already fixed in place:
spec §4 `findAnchor` signature, spec §5 source layout, spec §13 budget line,
spec §4 create-safety list, `benchmark/README.md` no-op, `scripts/openai-smoke.ts`
default model. The items below need a decision or a small implementation step.

## Goal

Close the remaining distance between as-built behavior and the documents /
conventions that describe it, without changing measured loop behavior:

- **Temp-dir policy vs acceptance.** `AGENTS.md` forbids temp files outside
  `./tmp/`, while `acceptance/run.ts:274` uses `mkdtempSync(join(tmpdir(), …))`
  (the system temp dir). Decide: narrow the policy (it governs agent scratch
  files; test harnesses may sandbox under the system temp) or move acceptance
  workspaces under the repo `tmp/`.
- **Dead `LoopOptions.model`.** `src/loop.ts` accepts `model` but never reads
  it; the provider owns the model. `src/main.ts:35` and `acceptance/run.ts:302`
  still pass it. Remove the option or wire it.
- **Stall milestone without a pin.** The no-progress ask requires a pinned
  target (`src/loop.ts:2610-2614`); a selection-only storm crosses the
  8-streak milestone without the ask (the selection continuation keeps its own
  STOP framing). Spec/glossary say the ask "recurs at every further multiple of
  8" — align the wording or the condition.
- **Undocumented as-built behaviors** (candidates for spec text): sibling-test-
  first verification (`src/loop.ts:2019-2035`); the formatter-normalized no-op
  that reformats the current source at the gate (`:1505-1518`); diagnostics
  truncation (4000 chars) and ≤10 mapped diagnostics (`:2123-2125`,
  `:2210-2222`); `OPENAI_TIMEOUT_MS` override and the 2-retry policy
  (`src/openai.ts:10-14`, `:66-84`); `failures/` rotation only before benchmark
  matrices (`benchmark/run.ts:1709-1716`), never in CLI runs.
- **Milestone/expiry drift.** `docs/spec.md` §11 M0–M8 are all landed but
  unmarked; the CN holiday list in `src/benchmark-pricing.ts:69-106` is
  2026-only and expires.

## Acceptance criteria

- [ ] Temp-dir policy mismatch decided and applied (policy wording or
      acceptance workspace location).
- [ ] `LoopOptions.model` removed or wired.
- [ ] Stall-milestone wording aligned between spec/glossary and code (or the
      condition adjusted).
- [ ] Undocumented behaviors written into the spec or explicitly marked as
      intentionally undocumented.
- [ ] §11 milestones marked landed; holiday-list expiry handled or noted.
- [ ] Gates green for any landed change.

## Verification

`bun run typecheck`, `bun test`, `bun run accept`, `bun benchmark/check.ts`;
doc-only changes verify by re-reading against the cited `src` locations.
`issue-tracker check` stays green.

## Notes

- Source: 2026-10-19 design survey during the `docs/design.md` reconciliation.
- Standalone follow-up; no umbrella. Priority low: none of these change
  measured behavior today.
