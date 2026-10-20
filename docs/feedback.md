# Feedback pool

`feedback/` is local scratch for the opencode-to-`tc` critique loop: `opencode`
uses `tc` on real work, then writes atomic observations about what `tc` did
poorly. `triage-feedback` screens the pool and `file-issue` turns only the
confirmed, well-scoped points into tracked issues. The pool is never committed;
handled files move to `feedback/archive/`, so the pool shows only what still
needs triage.

The loop, end to end: `opencode` delegates → `tc` returns a result → `opencode`
critiques and writes `feedback/` → `triage-feedback` screens the pool and
`file-issue` files `issues/` → `resolve-issue` fixes `tc` → back to `opencode`.

## Artifact format

One file per source: `feedback/<YYYY-MM-DD>-<topic>.md`. Any format is accepted,
but triage expects one atomic point per bullet, shaped like this:

```markdown
# feedback — <topic> (<date>)

- **Point:** <what tc did poorly>.
  **Evidence:** benchmark/results/<run>.json, tmp/replays-.../<bundle>.json,
  failures/<stamp>-<reason>.md, or the delegation's result JSON.
  **Concern:** <the single observable outcome>.
  **Suggested scope:** <file/symbol a fix would touch>.
```

## Rules

- One concern per point; split unrelated observations into separate points.
- Evidence is a reproducible path, not prose. `opencode` already has the result
  JSON, replay bundles (`--replay-dir`), `failures/` artifacts, the
  `exchangeStats` line, and the consumption ledger.
- Splitting, merging, and rejecting stay with `triage-feedback`; priorities and
  pick order stay with `file-issue` / `reorder-issue`.
