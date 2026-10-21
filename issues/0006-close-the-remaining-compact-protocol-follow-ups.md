---
id: 6
title: "Close the remaining compact protocol follow-ups"
status: todo
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
