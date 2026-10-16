---
name: which-skill
description: Help the user choose the right skill for their intent. Inventories available skills, matches the request to a skill, explains how skills relate and compose, and recommends a path. Use when the user says "which-skill", "which skill should I use", "what skill", "how do I do X", "what's the right skill", or is unsure which of several skills applies.
---

# which-skill

A guide, not an actor. Help the user pick the right skill and understand how the
skills they have fit together. This skill **only discusses and recommends** — it
does not perform the chosen skill's work. After the user confirms a choice, hand
off to that skill (or just tell them to invoke it).

## Workflow

1. **Clarify intent.** Restate what the user is trying to achieve in one
   sentence. If the goal is ambiguous, ask one round of questions via the
   `question` tool before recommending. Do not guess between materially
   different goals.
2. **Inventory.** List every skill actually available in this session: the ones
   advertised in the system prompt, plus any discoverable on disk
   (`**/SKILL.md` under `.opencode/skills`, `~/.config/opencode/skill(s)`,
   `~/.claude/skills`, `~/.agents/skills`). Read each `name` + `description`
   from frontmatter. Never recommend a skill you cannot see.
3. **Match.** Map the restated intent to the skill whose description best covers
   *what it does* **and** *when it triggers*. Quote the matching phrases so the
   user can see the reasoning.
4. **Explain relationships.** State how the candidates relate: which is upstream
   vs downstream, which are alternatives for the same goal, which compose into a
   pipeline. Use the relationship vocabulary below.
5. **Recommend.** Give one primary recommendation first, labeled
   `(Recommended)`, with a one-line rationale, then at most two alternatives
   with the trade-off. Offer to invoke the chosen skill.
6. **Hand off.** If the user picks one, either invoke it or tell them the exact
   trigger phrase. Do not start its work here.

## Relationship vocabulary

Describe skills in these terms so the mental model is consistent:

- **Pipeline / stages** — one skill's output is another's input. Say the order
  and what flows between them (e.g. an issue-filing skill *writes* tracked
  artifacts; a resolving skill *consumes* them).
- **Alternatives** — both solve the same intent; differ by approach, cost, or
  output. Present as a choice, not a chain.
- **Composition** — independent skills run together for a larger goal; note
  ordering constraints.
- **Specialization** — a narrow skill refines a broader one; prefer the narrow
  one when its trigger matches.
- **Prerequisite** — one must run (or be satisfied) before the other makes
  sense.
- **Meta / router** — a skill whose job is choosing among others (this one).

If a relationship is not evident from the descriptions, say so rather than
inventing one.

## Output shape

Keep it scannable:

- **Intent** — the restated goal.
- **Recommendation** — `(Recommended)` skill + one-line why.
- **Alternatives** — up to two, each with its trade-off.
- **How they relate** — one short paragraph or an arrow diagram.
- **Next** — the exact trigger phrase for the chosen skill.

## Rules

- Read-only: never edit files or run another skill's actions from here.
- Recommend only skills that exist and are visible in this session.
- If nothing fits, say so plainly and suggest what a new skill would need to
  cover — do not force a stretch match.
- When two skills are equally valid, present the trade-off and let the user
  decide rather than silently picking.
- Prefer the most specific matching skill over a broad one.
