---
id: 84
title: "Feedback pool and critique-to-triage convention"
status: todo
priority: medium
milestone: null
parent: 79
deps: []
labels: [docs, process]
created: 2026-10-20
---

## Context

Per the plan §4, `opencode` critiques `tc` and drops atomic, evidence-backed
observations into `feedback/`, which the `triage-feedback` skill screens and
`file-issue` turns into tracked issues.

## Goal

A documented, gitignored `feedback/` pool with a fixed artifact format, and a
proven dry-run of `triage-feedback` over one sample file.

## Acceptance criteria

- [ ] `feedback/` (and `feedback/archive/`) are added to `.gitignore` and are
      never committed.
- [ ] the critique artifact format is documented: `feedback/<YYYY-MM-DD>-<topic>.md`
      with atomic points, each carrying evidence (result JSON, replay bundle,
      `failures/` artifact) and a single observable concern.
- [ ] a dry-run triage of one sample feedback file yields at most one
      well-scoped issue per point and archives the handled file.

## Verification

The dry-run triage output; the `.gitignore` entry; a read of the format doc.

## Notes

- Independent (no deps). Uses the `triage-feedback` and `file-issue` skills.
- Non-goal: the GitHub-issue entry (`coding-skills-triage-from-github`).
