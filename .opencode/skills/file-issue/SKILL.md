---
name: file-issue
description: Turn requests into tracked issues under issues/.
---

# file-issue

Convert intent into tracked, actionable issues arranged as a **tree**. One issue
= one independently verifiable unit of work. This skill only files issues; it
never edits the surrounding project's code.

Every mechanical tracker write goes through the shared script (owned by
`which-skill`; referenced as `../which-skill/scripts/issue-tracker.ts` from this
skill's directory):

    bun .opencode/skills/which-skill/scripts/issue-tracker.ts <cmd>

Never hand-edit `issues/todo.yaml`, the dot block in `issues/readme.md`, or issue
frontmatter — the script owns them.

## Issue tree

Issues form a forest of hierarchies, plus cross-cutting dependency edges:

- **`parent`** — the umbrella/epic this issue belongs to, or `null` for a root.
  Children are _derived_ by scanning other issues' `parent` fields; never store a
  `children` list (it drifts). Hierarchy is structural.
- **`deps`** — blocking edges between any two issues, independent of the tree.
  `deps: [7]` means "7 must be `done` before this starts".
- An issue **with children** is an umbrella. Its acceptance criteria describe
  the whole and it is only `done` when **all** its children are done or
  formally superseded (`wontfix`). Umbrella issues usually hold no direct
  implementation work; the leaves do.
- The structure must stay a **DAG**: no issue may be its own ancestor, and
  `deps` must not form a cycle. `add` and `set` reject violations.

Open issues live at `issues/NNNN-slug.md`; `done` issues are moved to
`issues/done/` by `resolve-issue`. Never create, rename, renumber, or delete
issue files by hand — `add` allocates `max(id) + 1` across both directories and
derives the slug from the title.

## Workflow

1. **Gather source.** Read the user's request plus any referenced plan, spec, or
   code. If a planning document exists, mine its goals, risks, and acceptance
   criteria. Run the tracker's `list` first so you never duplicate an existing
   issue.
2. **Build the tree.** Split by _independently shippable and verifiable_ work.
   Group related leaves under an umbrella parent when they serve one goal.
   Attach cross-cutting prerequisites via `deps`, not by inventing a parent.
   Collapse anything that cannot be verified on its own into its parent. If the
   request is one atomic change, produce a single root issue. If the total new
   issue count exceeds 5, confirm the shape with the user via the `question`
   tool before writing.
3. **Draft each body** using the template below and write it to a scratch file
   (e.g. `tmp/body-<slug>.md`): plain markdown, no frontmatter. Every issue
   needs at least one checkable acceptance criterion and the exact command or
   observable step that verifies it. No vague goals ("improve", "refactor"
   alone) — state the outcome.
4. **Add the issues** in pre-order — a parent before its children — one call per
   issue, taking the parent id from the previous call's output:

       bun .opencode/skills/which-skill/scripts/issue-tracker.ts add \
         --title "Short imperative title" --body tmp/body-my-slug.md \
         [--parent 28] [--deps 42,43] [--priority high] \
         [--milestone M9] [--labels harness,benchmark]

   `--title` and `--body` are required; `--deps`/`--labels` are
   comma-separated; `--priority` defaults to `medium`. New issues are always
   created `todo`. Each call replies with `{"id": …, "file": …}`.
5. **Check.** Run `check`; `{"ok":true}` means the tracker is consistent. Fix and
   re-run until clean, then delete the scratch body files.
6. **Report** the created ids, the tree shape, and the tracker path. State any
   assumption you made about scope, priority, or structure.

## Issue template

```markdown
---
id: 7
title: Short imperative title
status: todo # todo | in-progress | review | done | wontfix
priority: high # high | medium | low
milestone: null # optional grouping label
parent: null # umbrella issue id, or null for a root
deps: [] # ids that must be done first
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

The script fills in every frontmatter field from its flags and the body file;
only the body sections are yours to author.

## Tracker files

- `issues/NNNN-slug.md` — one issue per file; its **frontmatter is the source
  of truth** for every derived view.
- `issues/todo.yaml` — generated index of open issues in **picking order**
  (repeatedly take the highest-priority available leaf, then the highest-
  priority available umbrella; available = deps done; tie-break by id), with
  `wontfix` entries kept at the bottom.
- `issues/readme.md` — generated `dot` block: node per issue (`#id title`),
  solid parent edges, dashed `blocks` dependency edges. Preserve any prose
  around it.

Run `setup` once if `issues/` does not exist; it bootstraps the tracker and
converges these files, and `check` detects any drift. Never hand-edit them.

## Rules

- Do not close, delete, renumber, or re-slug existing issues.
- Do not create or edit anything under `issues/done/`; that directory is owned by
  `resolve-issue`, which moves issues there when they become `done`.
- Do not invent milestones or priorities the source does not support; use `null`
  (milestone/parent) or `medium` (priority) and flag the assumption.
- One concern per issue. If a draft covers two unrelated changes, split it.
- Keep the structure acyclic and every `parent`/`deps` id pointing at a real
  issue — `check` proves it.
- Keep issue bodies self-contained: a reader must not need to open another
  document to understand the goal and how to verify it.
- Never hand-edit tracker files (`todo.yaml`, the dot block, frontmatter); all
  writes go through the script.
