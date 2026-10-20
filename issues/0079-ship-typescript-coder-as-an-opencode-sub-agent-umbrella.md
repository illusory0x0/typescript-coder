---
id: 79
title: "Ship typescript-coder as an opencode sub-agent (umbrella)"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [harness, integration, umbrella]
created: 2026-10-20
---

## Context

Design plan: `/home/illu/.opencode/plan/typescript-coder-subagent.md` (draft,
2026-10-20). Today `typescript-coder` (`tc`) is a standalone one-shot CLI:
`src/main.ts` reads an issue on stdin, edits `cwd`, and prints a human sentence.
The goal is to make it a **sub-agent** driven by `opencode` (`oc`): explicit
targets in, a versioned JSON result out, `tc` owning its own `tsc`/`test`
verification, proven by a real self-host run. A parallel loop has `oc` critique
`tc` into a `feedback/` pool that `triage-feedback` / `file-issue` convert into
tracked work.

## Goal

A working, documented `oc`→`tc` delegation: `tc` implements the JSON sub-agent
contract with a hard per-call budget and explicit-target multi-file edits, `oc`
can call it per a documented recipe, and one real self-host run lands green in a
reviewed worktree.

## Acceptance criteria

- [ ] C1: `tc` speaks the `typescript-coder-result@1` contract on stdout with
      `--format json`, `--token-budget`, `--check`, `--test`, `--cwd`, and a
      `tc` bin; the default `--format text` output is unchanged.
- [ ] C2: a modify call can carry explicit `{path,symbol,kind}` targets and
      apply path-independent edits across those files (via #69), sequencing
      same-file targets and reporting misses.
- [ ] C3: the `oc` delegation recipe is documented (`docs/subagent.md` +
      `AGENTS.md`).
- [ ] C4: one real self-host task run in an isolated worktree/branch is green on
      `tsc`/`test`/`accept`/`benchmark/check`, reviewed, with cost recorded.
- [ ] C5: the `feedback/` pool + critique→triage convention is documented and
      gitignored; a dry-run triage files at most one well-scoped issue per point.
- [ ] All children are `done` or `wontfix` with a written reason.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
bun benchmark/check.ts
```

plus the C4 self-host branch and its recorded report.

## Notes

- Plan: `/home/illu/.opencode/plan/typescript-coder-subagent.md`.
- Depends on reconciling the parked #77 change (uncommitted bounded-repair-source
  view in `src/loop.ts` + `src/loop.test.ts`): keep+commit or stash to get a clean tree.
- Non-goals: publishing to a registry, an `opencode` plugin/tool, unified-diff
  bypasses.
- Priorities defaulted to `medium`; no milestone (per file-issue defaults).
