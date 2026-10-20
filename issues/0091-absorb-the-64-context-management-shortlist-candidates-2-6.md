---
id: 91
title: "Absorb the #64 context-management shortlist (candidates 2-6)"
status: todo
priority: low
milestone: null
parent: null
deps: []
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

#64 studied opencode2's context management and produced a ranked absorption
shortlist. Candidate 1 was filed as #65; **candidates 2-6 were each marked
"new issue to file" and were never filed**:

2. Carry the newest exchange verbatim beside the attempt digest (`recent-context`
   analogue) — storm mitigation + failure-mode coverage.
3. Graded shrink ladder for repair context on repeated rejection — context size +
   failure-mode coverage.
4. Anchor context-size decisions to provider-reported usage; skip when a
   checkpoint just landed — context size + failure-mode coverage.
5. Classify provider context-overflow / payload-too-large separately from terminal
   errors — failure-mode coverage (sibling of #74).
6. Bound output-limit continuations to a three-strike — failure-mode coverage
   (sibling of #74).

This umbrella tracks filing and deciding those five candidates.

## Goal

Every #64 absorption candidate 2-6 is filed as a child and decided (landed with
evidence, or a written negative/wontfix), so the study's shortlist is fully
consumed.

## Acceptance criteria

- [ ] Candidates 2-6 are each filed as a child of this umbrella and decided.
- [ ] Any landed mechanism carries unit tests and live benchmark evidence per the
      series rule (rows in `benchmark/results/consumption.md`).
- [ ] No candidate is left un-filed.

## Verification

Every child is decided with its evidence recorded; `bun test`, `bunx tsc --noEmit`,
`bun benchmark/check.ts` green at close.

## Notes

- Source: `issues/done/0064-study-opencode2-context-management-e-g-compaction-for-absorption-candidates.md`.
- Non-goals: candidate 1 (already landed as #65); re-opening #64.
- Children: #94 carry newest exchange verbatim beside the digest, #95 repair-context shrink ladder, #96 anchor context-size decisions to provider usage, #97 classify context-overflow / payload-too-large, #98 bound output-limit continuations to a three-strike. Umbrella closes when all five are decided.
