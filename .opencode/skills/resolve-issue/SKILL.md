---
name: resolve-issue
description: Take tracked issues to done.
---

# resolve-issue

Take a tracked issue to done. This is the execution counterpart to `file-issue`:
`file-issue` files issues; `resolve-issue` consumes them, does the work, and
moves them through the status lifecycle. Every tracker write goes through the
shared script (owned by `which-skill`; referenced as
`../which-skill/scripts/issue-tracker.ts` from this skill's directory):

    bun .opencode/skills/which-skill/scripts/issue-tracker.ts <cmd>

Never hand-edit frontmatter, `issues/todo.yaml`, or the dot block in
`issues/readme.md` — the script owns them. Append findings to an issue's prose
(its `## Notes`) directly; that is not tracker bookkeeping.

An issue is only "done" when every acceptance criterion is demonstrably met —
not when the edits look right. In a tree, that also means an **umbrella is not
done until all its children are done or `wontfix`**.

## Status lifecycle

```
todo ──▶ in-progress ──▶ review ──▶ done
             │              │
             └──────────────┴──▶ wontfix
```

- `todo`: not started.
- `in-progress`: actively being worked. Move here _before_ editing code.
- `review`: implementation and verification pass, awaiting human sign-off.
- `done`: signed off / accepted. `set --status done` moves the file to
  `issues/done/`, rebases its links, and re-derives the tracker; it refuses
  while any dep is not `done` or any child is open.
- `wontfix`: deliberately abandoned; `set --status wontfix --reason "…"`
  appends the reason to Notes. The file stays under `issues/`.

## Workflow

1. **Select — ask, never pick silently.** If the user named a target — an id, a
   list, or a set — take it as given; "all" means the whole tracker. Otherwise
   run the tracker's `list` and **ask via the `question` tool** what to
   resolve. Never auto-pick.

   `list` returns the full state: `order` (picking order), `eligibleLeaves`
   (a `todo` leaf whose deps are all `done`), `eligibleUmbrellas` (an umbrella
   whose children are all decided), `sets` (topics: each open umbrella with its
   open descendants), and `blockers` (unmet deps / unfinished children). A
   picked set is fixed. Options are ranked by picking order (a set ranks as its
   highest member); the first carries `(Recommended)`. Offer, in order:

   - one **set** option per open topic, top topic first — e.g.
     `Set #28: #42 → #43 → #44`;
   - each eligible leaf as a **single** option;
   - `All open, in order` — the whole tracker (see "Batch mode" below).

   If nothing is eligible, report what is blocking and stop — do not ask an
   empty question.

2. **Load.** Read the issue file fully — Context, Goal, Acceptance criteria,
   Verification, Notes — plus its full ancestor chain (`parent` up to the root)
   for context, and every issue in its `deps` that is not yet `done`. Look files
   up under `issues/NNNN-*.md` first, then `issues/done/NNNN-*.md`: done
   ancestors and deps have been moved into `issues/done/`. Read the referenced
   code before changing anything.
3. **Mark `in-progress`.** `set <id> --status in-progress`. This is the signal
   that the issue is claimed.
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
7. **Move to `review`.** `set <id> --status review`, then report: issue id, what
   changed (file:line), the verification output, and any criterion you could
   **not** confirm. If the project requires human sign-off, hold at `review`
   and let the user promote to `done`. If the user's request was "resolve and
   close", and all criteria pass with no ambiguity, move straight to `done`:
   `set <id> --status done` performs the file move.
8. **Propagate up the tree.** After a child reaches `done` or `wontfix`, check
   its siblings and its parent's own acceptance criteria. If every child of a
   parent is now decided and the parent's criteria are satisfied, surface the
   parent as ready to close (or close it — `set <id> --status done` — if the
   user asked to auto-close). Never auto-close an umbrella whose own criteria
   are unmet.
9. **If verification still fails.** After two failed re-delegations, if you
   cannot satisfy the criteria, leave the issue `in-progress`, append the
   blocker under `## Notes` in the issue file, and report — never mark `done` on
   a failing check.

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

When the user's answer is a topic set or `All open, in order`:

- Process issues **sequentially**, one at a time, re-running `list` before each
  pick — finishing one issue can make the next eligible (a leaf whose `deps`
  were waiting on it). Take issues in `order`.
- A **set** is a fixed queue: only its members are started, and the run stops
  when the set is exhausted.
- `All open` keeps draining the tracker — picking up newly eligible issues —
  until no `todo` issue remains.
- After each issue, re-evaluate eligibility and propagate up the tree (step 8).
  If a parent becomes fully decided, close it per step 8.
- **Stop on the first issue that cannot be closed** (failed verification or a
  blocker) and report the remaining queue — do not skip ahead, because the
  blocked issue may gate the rest.

## Tracker commands

- `list` — full state plus derived selection data, as JSON.
- `set <id> --status in-progress|review|done` — drive the lifecycle; `done`
  moves the file and refuses unready issues.
- `set <id> --status wontfix --reason "…"` — formal abandonment.
- `set <id> --priority high|medium|low` (also `--title`, `--parent`, `--deps`,
  `--labels`, `--milestone`) — field edits.
- `check` — validate the tracker after a batch; `setup` — repair derived-file
  drift.

## Rules

- Always confirm the target via the `question` tool when no target is named;
  never start work on a guessed issue.
- One issue per invocation unless the answer is a set or `All open, in order`.
  In batch mode, process sequentially and stop on the first issue that cannot be
  closed.
- Never edit implementation files from the main context: all code changes go
  through the `subagent` tool. The main agent owns selection, the tracker, and
  verification.
- Work leaves first; never mark an umbrella `done` while it has an open child.
- Never edit an issue's Goal or Acceptance criteria to make it pass. If the
  criteria are wrong, raise it with the user and fix the issue first.
- Never renumber, re-slug, or delete issues.
- Never hand-edit tracker files (frontmatter, `todo.yaml`, the dot block); every
  status change and field edit goes through the script.
- Never mark `done` while any acceptance criterion is unverified.
- Stay within the issue's scope; new discoveries become new `file-issue` items or
  a note on the current issue, not silent extra changes.
- Report honestly: state exactly which commands you ran and what they printed.
