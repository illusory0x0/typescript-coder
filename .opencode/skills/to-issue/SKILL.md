---
name: to-issue
description: Turn a request, plan, bug report, or spec section into concrete issue files under issues/ and keep issues/todo.md in sync. Use when the user says "to-issue", "file an issue", "break this into issues", "track this", or asks to capture work items.
---

# to-issue

Convert intent into tracked, actionable issues. One issue = one independently
verifiable unit of work. This skill only writes files under `issues/`; it never
edits the surrounding project's code.

## Layout

```
issues/
  todo.md          # index / tracker, the single source of truth for status
  TEMPLATE.md      # optional, copy for new issues
  0001-<slug>.md   # one file per issue
  0002-<slug>.md
```

- Issue file name: zero-padded 4-digit id + kebab-case slug, e.g.
  `0007-lexer-strict-errors.md`.
- Next id = `max(existing ids) + 1`. Never reuse, rename, or delete ids; a
  cancelled issue stays listed and marked `wontfix`.

## Workflow

1. **Gather source.** Read the user's request plus any referenced plan, spec, or
   code. If a planning document exists, mine its goals, risks, and acceptance
   criteria. Always read `issues/todo.md` and list `issues/*.md` first so you
   never duplicate an existing issue.
2. **Decide granularity.** Split by *independently shippable and verifiable*
   work. Collapse anything that cannot be verified on its own into its parent.
   If the request is one atomic change, produce one issue. If the number of new
   issues exceeds 5, confirm the split with the user via the `question` tool
   before writing.
3. **Draft each issue** using the template below. Every issue needs at least one
   checkable acceptance criterion and the exact command or observable step that
   verifies it. No vague goals ("improve", "refactor" alone) — state the outcome.
4. **Write files** to `issues/NNNN-slug.md`, newest issues appended.
5. **Update `issues/todo.md`** — add one row per new issue, leave existing rows
   and their statuses untouched, keep the table sorted by id ascending.
6. **Report** the created ids and the tracker path. If a source premise was
   ambiguous (scope, priority, milestone), state the assumption you made.

Create `issues/` and `issues/todo.md` if they do not already exist.

## Issue template

```markdown
---
id: 7
title: Short imperative title
status: todo          # todo | in-progress | review | done | wontfix
priority: high        # high | medium | low
milestone: null       # optional grouping label
labels: []
created: YYYY-MM-DD
---

## Context

Why this exists. Link the request, plan, or report that motivates it.

## Goal

One sentence: the outcome when this is done.

## Acceptance criteria

- [ ] Criterion 1 (observable, binary)
- [ ] Criterion 2

## Verification

The exact command(s) or manual steps that prove the criteria are met.

## Notes

Dependencies on other issue ids, open questions, non-goals.
```

## `issues/todo.md` format

Keep a `# Todo` header, then a single table. Preserve any prose the user added.

```markdown
# Todo

| id  | title           | status | priority | milestone | deps |
| --- | --------------- | ------ | -------- | --------- | ---- |
| 7   | Short issue title | todo | high     |           |      |
| 8   | Another issue     | todo | medium   | M2        | 7    |
```

- `id` links to the file: `[7](0007-short-issue-title.md)`.
- `deps` lists issue ids that must land first.
- **The table is authoritative for scanning.** Whenever an issue's status
  changes, update it in both the file frontmatter and the table.

## Rules

- Do not close, delete, renumber, or re-slug existing issues.
- Do not invent milestones or priorities the source does not support; use `null`
  (milestone) or `medium` (priority) and flag the assumption.
- One concern per issue. If a draft covers two unrelated changes, split it.
- Keep issue bodies self-contained: a reader must not need to open another
  document to understand the goal and how to verify it.
