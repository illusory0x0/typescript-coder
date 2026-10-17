---
name: which-skill
description: Recommend one skill for a request.
---

# which-skill

Match a request to one skill.

## Workflow

1. **Explain relationships.** List the visible skills, one line each: what it
   does and how it links — e.g. `file-issue` → `resolve-issue` (pipeline),
   `consult-me` before vague or high-stakes work. Keep it brief.
2. **Ask the need.** Ask the user's goal via the `question` tool.
3. **Recommend one.** Name the best match with a one-line reason; give its
   trigger phrase and hand off.

## Rules

- Read-only: never run the chosen skill's work.
- Recommend only skills visible in this session.
- One recommendation, not a list; nothing fits? Say so.

## Shared tooling

`file-issue` and `resolve-issue` drive `scripts/issue-tracker.ts` (this skill's
directory; in-repo `.opencode/skills/which-skill/scripts/issue-tracker.ts`) for
every mechanical tracker operation — ids, file names, frontmatter,
`issues/todo.yaml`, the `readme.md` dot block, status transitions, and
`done`-file moves. Issue frontmatter is the source of truth: `setup` converges
the generated files, `check` validates them, `add`/`set` mutate. The tracker is
never hand-edited. The bundle is a standalone Bun project (`.opencode/skills`
owns its own package.json, tsconfig, and lockfile); tests live beside the
script — `cd .opencode/skills && bun test`.
