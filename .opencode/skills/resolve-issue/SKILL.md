---
name: resolve-issue
description: Take tracked issues to done.
---

# resolve-issue

Take a tracked issue to done. This is the execution counterpart to `file-issue`:
`file-issue` writes issue files, the tree in `issues/readme.md`, and the
picking order in `issues/todo.yaml`; `resolve-issue` consumes them, does the
work, and moves them through the status lifecycle. When an issue reaches
`done`, its file is **physically moved** to `issues/done/` and its `todo.yaml`
entry is removed.

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
- `done`: signed off / accepted. The issue file is moved to `issues/done/` (see
  "On `done`: move the file").
- `wontfix`: deliberately abandoned, with a reason appended to Notes. The file
  stays where it is — only `done` issues move.

## Workflow

1. **Select — ask, never pick silently.** If the user named an id, use it.
   Otherwise read `issues/todo.yaml`, build the list of eligible work items, and —
   for **every** invocation where the user did not name an id — **ask via the
   `question` tool** which to resolve. Never auto-pick.

   An eligible work item is a `todo` **leaf** (no children) whose `deps` are all
   `done`; an umbrella is not eligible while it has open children. Order
   candidates by the tracker's picking order. The question must offer, in
   order:

   - the top candidate, labeled `(Recommended)`;
   - the other eligible leaves, one option each;
   - `All eligible, in order` — a batch (see "Batch mode" below).

   If no issue is eligible, report what is blocking (unmet `deps`, unfinished
   children) and stop — do not ask an empty question.
2. **Load.** Read the issue file fully — Context, Goal, Acceptance criteria,
   Verification, Notes — plus its full ancestor chain (`parent` up to the root)
   for context, and every issue in its `deps` that is not yet `done`. Look files
   up under `issues/NNNN-*.md` first, then `issues/done/NNNN-*.md`: done
   ancestors and deps have been moved into `issues/done/`. Read the referenced
   code before changing anything.
3. **Mark `in-progress`.** Update the frontmatter and the issue's `todo.yaml`
   entry before the first edit. This is the signal that the issue is claimed.
4. **Locate the work.** Find the real files and symbols the issue touches. If
   the issue's premises are wrong (missing file, already implemented, blocked by
   an unlisted dependency), stop and report to the user instead of improvising.
5. **Delegate the implementation to a sub-agent.** Do **not** write the code in
   this context. Launch a sub-agent via the `subagent` tool (`agent: general`)
   and pass it a self-contained brief — see "Sub-agent brief" below.
   The sub-agent makes the edits; the main agent stays the orchestrator that
   owns selection, the tracker, and final verification.
6. **Review, then Verify.** Read the sub-agent's diff before trusting it — reject
   scope creep and out-of-tree changes. Then run the exact commands in the
   issue's Verification section **yourself**; do not accept the sub-agent's word
   that they passed. Every acceptance criterion must map to an observed,
   passing result. If the sub-agent reports failure or the diff is wrong,
   re-delegate with the failure output appended (at most two re-delegations),
   or stop and report.
7. **Move to `review`.** Report: issue id, what changed (file:line), the
   verification output, and any criterion you could **not** confirm. If the
   project requires human sign-off, hold at `review` and let the user promote to
   `done`. If the user's request was "resolve and close", and all criteria pass
   with no ambiguity, move straight to `done` — and perform the file move
   described in "On `done`: move the file".
8. **Propagate up the tree.** After a child reaches `done`, check its siblings
   and its parent's own acceptance criteria. If every child of a parent is now
   `done` and the parent's criteria are satisfied, surface the parent as ready to
   close (or close it if the user asked to auto-close) — moving the umbrella's
   file to `issues/done/` as well. Never auto-close an umbrella whose own
   criteria are unmet.
9. **If verification still fails.** After two failed re-delegations, if you
   cannot satisfy the criteria, leave the issue `in-progress`, append the
   blocker to Notes, and report — never mark `done` on a failing check.

## Sub-agent brief

The sub-agent starts with a fresh context, so the brief must be self-contained.
Include:

- The issue verbatim: id, title, Goal, Acceptance criteria, Verification, Notes.
- Ancestor context: the umbrella goal(s) up the `parent` chain, and the outcome
  of any `deps` that already landed.
- The concrete target files/symbols you located in step 4, with paths.
- Project conventions and stack the change must follow.
- Scope fence: solve **only** this issue; no unrelated refactors, no changes
  outside the issue's files without saying so; report extra findings instead of
  acting on them.
- The exact commands to run to self-check, and a request to return: a summary of
  changes (`file:line`), the raw command output, and any blocker.

The sub-agent is a worker, not the owner. It must not touch `issues/` — the main
agent alone updates the tracker.

## Batch mode

Only when the user's answer to the selection question is `All eligible, in
order` (or they explicitly ask for a batch):

- Process issues **sequentially**, one at a time, re-reading `issues/todo.yaml`
  before each pick — finishing one issue can make the next eligible (a leaf whose
  `deps` were waiting on it).
- Take issues in the tracker's picking order.
- After each issue, re-evaluate eligibility and propagate up the tree (step 8).
  If a parent becomes fully `done`, include it.
- **Stop on the first issue that cannot be closed** (failed verification or a
  blocker) and report the remaining queue — do not skip ahead, because the
  blocked issue may gate the rest.
- The user may pick a subset instead of "all"; honor their list and order.

## Updating the tracker

Update the frontmatter and the issue's `todo.yaml` entry together, and re-sort
`todo.yaml` when the change moves it (rule and format: see `file-issue`). When
closing as `wontfix`, append a short reason under `## Notes`. Leave the tree in
`issues/readme.md` unchanged unless the user asks to restructure.

## On `done`: move the file

The moment an issue becomes `done`, move its file into `issues/done/` and drop
its `todo.yaml` entry — this is part of the status transition, not an optional
cleanup:

1. `mkdir -p issues/done` if needed.
2. Move the file without changing its name: `git mv issues/0007-slug.md
   issues/done/0007-slug.md` in a git repo, plain `mv` otherwise. Never rename,
   renumber, or re-slug.
3. Fix relative links inside the moved file: references that used to resolve
   from `issues/` need one more `../` (e.g. `../spec.md` → `../../spec.md`).
   Check links to the spec and any sibling issue files.
4. Mark `status: done` in the frontmatter and remove the issue's entry from
   `issues/todo.yaml`.
5. If the project is a git repo, include the move and the tracker update in the
   commit that closes the issue (do not leave the move uncommitted).

Moving the file is only for `done`. `wontfix` and every in-flight status keep
the file under `issues/`.

## Rules

- Always confirm the target with the user via the `question` tool when no id is
  named; never start work on a guessed issue.
- One issue per invocation unless the user's answer selects a batch. In batch
  mode, process sequentially and stop on the first issue that cannot be closed.
- Never edit implementation files from the main context: all code changes go
  through the `subagent` tool. The main agent owns selection, the tracker, and
  verification.
- Work leaves first; never mark an umbrella `done` while it has an open child.
- Never edit an issue's Goal or Acceptance criteria to make it pass. If the
  criteria are wrong, raise it with the user and fix the issue first.
- Never renumber, re-slug, or delete issues.
- When an issue becomes `done`, move its file to `issues/done/` (step order and
  link fixes per "On `done`: move the file") and remove its `todo.yaml` entry.
  Never move a file for any other status.
- Never mark `done` while any acceptance criterion is unverified.
- Stay within the issue's scope; new discoveries become new `file-issue` items or
  a note on the current issue, not silent extra changes.
- Report honestly: state exactly which commands you ran and what they printed.
