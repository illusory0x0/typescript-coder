---
id: 6
title: "Close the remaining compact protocol follow-ups"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-22
---

## Context

The compact editing protocol now matches the main `human/edit.md` behaviors: compact is the default, the first turn is a select viewer/editor, `# details` and `# modified text` exist, pick/create semantics are aligned, and compact multi-clause replies are atomic.

The follow-up review found a small set of remaining correctness, prompt-shape, viewer, and measurement gaps. This umbrella tracks them; it closes when every child is done or wontfix.

## Goal

Close the remaining compact-protocol follow-ups and record a fresh compact benchmark baseline.

## Acceptance criteria

- [ ] Every child issue is `done` or `wontfix`.
- [ ] `issue check` passes and no child is open.
- [ ] No code or docs are changed by this umbrella itself.

## Verification

```
issue check
issue list --open
```

The open list contains no issue parented to this umbrella.

## Notes

- Children: replay protocol metadata, confirmation-edit budget, compact retry/decision prompt shape, first-select match markers, compact benchmark re-baseline.
- Out of scope: `human/edit.md` wording decisions (`resolve function`, snippet verbatim, `1:` vs `N |`) — `human/` is human-authored and read-only; live compact acceptance scenarios are deferred because they cost tokens.
- Priorities default to medium and milestones to null because the request did not name them.
- All children are done: #7 replay protocol metadata, #8 confirmation-edit budget, #9 select-first retry/decision prompts, #10 first-select match markers, #11 compact benchmark baseline. #11's live baseline (4 tasks × tc × 1 rep) is recorded in `benchmark/results/2026-10-21-compact-baseline.json` with `protocol-format: compact` and a fresh `benchmark/results/consumption.md`; its residual (json-parser/minilisp token-budget storms, n=1) is noted on #11. This umbrella changed no code or docs itself; `issue check` passes with no open child.
