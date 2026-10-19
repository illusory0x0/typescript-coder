---
id: 64
title: "Study opencode2 context management (e.g. compaction) for absorption candidates"
status: todo
priority: low
milestone: null
parent: null
deps: []
labels: [harness]
created: 2026-10-19
---

## Context

User directive (2026-10-19, low priority): study opencode2's context
relationships/management — e.g. its Compaction pipeline — and distill concrete
absorption candidates for the tc harness.

#57 already absorbed one compaction-derived idea (a bounded attempt digest /
updated checkpoint for continued repair rounds). The wider context pipeline has
not been surveyed: context assembly order, compaction trigger conditions and
thresholds, checkpoint generation and update-in-place semantics, the shrink
ladder on repeated provider overflow, and the discard rules for older messages.

## Goal

A written study of opencode2's context management (with file/line citations)
and a ranked shortlist of absorption candidates, each scoped to a concrete
follow-up (an existing issue ref or a new issue to be filed).

## Acceptance criteria

- [ ] Study notes in this issue's Notes cover at least: context assembly order
      (system / pinned / verbatim tail), compaction trigger conditions and
      thresholds, checkpoint generation and update-in-place semantics, the
      shrink ladder on repeated provider overflow, and the discard rules for
      older messages — each claim carrying an opencode2 file/line citation.
- [ ] A ranked absorption shortlist: every candidate names its expected effect
      (context size / storm mitigation / failure-mode coverage), its cost, and
      its target (an existing issue ref or a new issue to file).
- [ ] Findings only: no harness code changes land under this issue.
- [ ] Tracker `check` passes.

## Verification

Review the notes and the shortlist in this issue: every opencode2 claim cites
a file/line, every candidate maps to an issue ref, and no code diff is
attributable to this issue. `bun .opencode/scripts/issue-tracker.ts check`
is green.

## Notes

- Low priority by user directive (2026-10-19); filed 2026-10-19.
- Related: #57 (compaction-derived digest already landed), #49 (context audit
  and cut, tc side), #46 (v3 batch — this study deliberately does not gate it).
- Reference sources from the 2026-10-18 opencode2 study:
  `packages/core/src/session/compaction.ts` and `runner/llm.ts` (see #57's
  context for exact ranges), plus whatever else the survey finds.
- Assumption: filed as a root issue (no parent) so the v3 close-out (#46) is
  not gated on this low-priority study; re-parent on request.
- Consult (2026-10-19, oc survey A-group triage): A4 (compaction trim/discard
  rules) and A5 (overflow/truncation recovery — the shrink ladder is already
  in the Context list) are absorbed into this study's scope. A3 (bounded
  trajectory) is deferred until #71's c/d matrix data lands; it will then be
  absorbed here or filed as its own issue.
