# coding-skills

Coding workflow skills for OpenCode, plus their shared tooling.

This directory is a standalone Bun project: it owns its `package.json`,
`tsconfig.json`, `bunfig.toml`, and lockfile, and is not part of the
surrounding repository's TypeScript project.

## Structure

| Path | Skill |
| --- | --- |
| `consult-me/` | Turn vague or high-stakes requests into a confirmed plan. |
| `file-issue/` | Turn requests into tracked issues under `issues/`. |
| `resolve-issue/` | Take tracked issues to done. |
| `hone-skill/` | Improve a skill or the relationships between skills. |
| `which-skill/` | Recommend one skill for a request; hosts `scripts/issue-tracker.ts`. |

## issue-tracker

`which-skill/scripts/issue-tracker.ts` is the dependency-free CLI shared by
`file-issue` and `resolve-issue`. It runs with plain Bun — no install needed:

    bun .opencode/skills/which-skill/scripts/issue-tracker.ts <cmd>

## Development

From this directory:

    bun install     # dev deps only: typescript, @types/bun
    bun test        # issue-tracker tests
    bun run typecheck

…or from the repository root:

    cd .opencode/skills && bun test
    cd .opencode/skills && bun run typecheck
