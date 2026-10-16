---
name: resolve-issue
description: Pick up a tracked issue from issues/, implement it, verify the acceptance criteria, and update its status in issues/todo.md (table and Graphviz tree). The counterpart to file-issue. Use when the user says "resolve-issue", "work on issue <id>", "pick up the next issue", "do the todo", or asks to implement and close a tracked work item.
---

# resolve-issue

Take a tracked issue to done. This is the execution counterpart to `file-issue`:
`file-issue` writes issue files and the `issues/todo.md` tracker (a Graphviz
tree plus a status table), `resolve-issue` consumes them, does the work, and
moves them through the status lifecycle.

An issue is only "done" when every acceptance criterion is demonstrably met —
not when the edits look right. In a tree, that also means an **umbrella is not
done until all its children are done**.

## Status lifecycle

```
todo ──▶ in-progress ──▶ review ──▶ done
             │              │
             └──────────────┴──▶ wontfix
```

- `todo`: not started.
- `in-progress`: actively being worked. Move here *before* editing code.
- `review`: implementation and verification pass, awaiting human sign-off.
- `done`: signed off / accepted.
- `wontfix`: deliberately abandoned, with a reason appended to Notes.

Keep the issue frontmatter, its table row, **and** its node in the Graphviz
block all in sync. The table is authoritative for scanning; the graph is
authoritative for structure.

## Workflow

1. **Select.** If the user named an id, use it. Otherwise read `issues/todo.md`
   and pick the highest-priority eligible work item: a `todo` **leaf** (no
   children) whose `deps` are all `done`. Do not pick an umbrella that still has
   unfinished children — resolve its leaves first. If none qualify, report that
   and stop. If two or more are equally eligible, ask via the `question` tool
   rather than guessing.
2. **Load.** Read the issue file fully — Context, Goal, Acceptance criteria,
   Verification, Notes — plus its full ancestor chain (`parent` up to the root)
   for context, and every issue in its `deps` that is not yet `done`. Read the
   referenced code before changing anything.
3. **Mark `in-progress`.** Update the frontmatter, the table row, and the graph
   node color before the first edit. This is the signal that the issue is
   claimed.
4. **Locate the work.** Find the real files and symbols the issue touches. If
   the issue's premises are wrong (missing file, already implemented, blocked by
   an unlisted dependency), stop and report to the user instead of improvising.
5. **Implement.** Make the smallest change that satisfies the Goal. Follow the
   project's existing conventions and stack; add tests the project uses. Do not
   fold in unrelated refactors — if you find other work, offer to file a new
   `file-issue` instead.
6. **Verify.** Run the exact commands in the issue's Verification section. Every
   acceptance criterion must map to an observed, passing result.
7. **Move to `review`.** Report: issue id, what changed (file:line), the
   verification output, and any criterion you could **not** confirm. If the
   project requires human sign-off, hold at `review` and let the user promote to
   `done`. If the user's request was "resolve and close", and all criteria pass
   with no ambiguity, move straight to `done`.
8. **Propagate up the tree.** After a child reaches `done`, check its siblings
   and its parent's own acceptance criteria. If every child of a parent is now
   `done` and the parent's criteria are satisfied, surface the parent as ready to
   close (or close it if the user asked to auto-close). Never auto-close an
   umbrella whose own criteria are unmet.
9. **If verification fails.** Fix and retry while progress is real. If you
   cannot satisfy the criteria, leave the issue `in-progress`, append the
   blocker to Notes, and report — never mark `done` on a failing check.

## Updating the tracker

Update all three places together:

1. **Frontmatter:**

   ```yaml
   status: review
   ```

2. **Table row** (only the status column changes):

   ```markdown
   | [7](0007-short-issue-title.md) | Short issue title | review | high | | | |
   ```

3. **Graph node** — recolor it by status:

   ```dot
   "7" [label="#7 Short issue title\n(review)", fillcolor="lightblue"];
   ```

Status colors: `todo`=white, `in-progress`=lightyellow, `review`=lightblue,
`done`=lightgreen, `wontfix`=lightgrey.

When closing as `wontfix`, append a short reason under `## Notes` in the issue
file. Leave the tree edges unchanged unless the user asks to restructure — and
if you do reparent, update frontmatter, table, and both old/new tree edges.

## Rules

- One issue per invocation unless the user explicitly asks for a batch.
- Work leaves first; never mark an umbrella `done` while it has an open child.
- Never edit an issue's Goal or Acceptance criteria to make it pass. If the
  criteria are wrong, raise it with the user and fix the issue first.
- Never renumber, re-slug, or delete issues.
- Never mark `done` while any acceptance criterion is unverified.
- Stay within the issue's scope; new discoveries become new `file-issue` items or
  a note on the current issue, not silent extra changes.
- Report honestly: state exactly which commands you ran and what they printed.
