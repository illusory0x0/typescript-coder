---
name: hone-skill
description: Improve a skill itself or skills relationships.
---

# hone-skill

Target: `SKILL.md` files — one skill, or several when the goal is how they
relate. Edit only after the user confirms.

Style: concise, precise text; verbs and nouns carry the meaning, adjectives
and adverbs only at key points.

No skill execution, no issue filing — report findings that need more than
text.

## Workflow

1. **Pick the target.** Ask the user with the `question` tool:
   - one skill — named, or inferred then asked;
   - all skills — coordination, pairings, consistency across the set.
     Never pick without asking.
2. **Load it.** Search in order: repo `.opencode/skills/<id>/SKILL.md`, then
   `~/.config/opencode/skill(s)`, `~/.claude/skills`, `~/.agents/skills`.
   Several copies? Ask which. None? Stop and report — never substitute.
3. **Ask for usage feedback.** Ask how the skill worked: misfires, gaps,
   noise. Use the answers as evidence — skip sessions and git history. No
   usage yet? Move on.
4. **Review.** Fix misfires; cut what earns no place. Watch for: vague verbs;
   missing or unclear triggers; fuzzy object, steps, decisions;
   unenforceable rules; overlap with sibling skills; stale references;
   duplicated content; filler adjectives and adverbs; length beyond need.
5. **Propose and apply.** List issues (one line each) and the new shape —
   rewriting is fine; keep trigger phrases and safety rules. Ask via the
   `question` tool: apply / adjust / cancel.

## Rules

- Cut first: short and sharp beats long and exact.
- Edit only skills in scope — never project code or the issue tracker.
- Never invent capabilities or weaken safety rules — report such findings.
- Already sharp? Say so and stop — do not manufacture findings.
