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
