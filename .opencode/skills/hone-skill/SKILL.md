---
name: hone-skill
description: Sharpen one existing agent skill by static review. Audits a SKILL.md against a rubric (frontmatter, trigger phrases, workflow, rules, boundaries, stale references), presents evidence-backed findings, and applies minimal edits after a single confirmation round. Use when the user says "hone-skill", "hone skill <id>", "sharpen this skill", "review this skill", "improve the skill", or says a skill isn't working as written.
---

# hone-skill

Sharpen **one** skill: read its `SKILL.md`, find what will misfire for a
future agent (missing triggers, ambiguous steps, broken references, blurred
boundaries), and fix the text with a minimal diff after a single confirmation
round. Static review only — judge the skill by its text and the repo it lives
in, not by mining past sessions.

`which-skill` chooses among skills; `hone-skill` improves the chosen one. It
does not execute the skill's work and does not write issues — if a finding
implies new behavior or real work, report it instead of expanding scope.

## Workflow

1. **Select one target — ask, never silently pick.**
   - If the user named a skill, use it.
   - Otherwise infer candidates from this session (skills invoked, referenced,
     or discussed) and ask via the `question` tool: top candidate labeled
     `(Recommended)`, then up to two others, plus "name another skill".
   - Never hone more than one skill per invocation unless the user explicitly
     asks for a sweep.

2. **Locate and load the file.** Search skill locations in order: repo
   `.opencode/skills/<id>/SKILL.md`, then `~/.config/opencode/skill(s)`,
   `~/.claude/skills`, `~/.agents/skills`. If several copies exist, ask which
   one. Read the whole file; note the frontmatter `name` and `description`
   verbatim.

3. **Read its neighbours.** Read the skills it references or mirrors (especially
   `which-skill` for relationship vocabulary). This is still static review: use
   other files to check consistency, never to infer usage history.

4. **Audit against the rubric below.** For each finding record: severity, a
   quoted line as evidence, and the intended change.

5. **Present and confirm once.** Print the findings (severity, evidence,
   proposed change per finding), then ask via the `question` tool what to
   apply: all findings `(Recommended)`, a selected subset, or none. Do not edit
   anything before this round.

6. **Apply minimal edits.** Use targeted edits; keep the skill's voice,
   headings, and working phrasings. Never silently change scope, promise new
   capabilities, or weaken safety rules — such findings are reported for the
   user to decide, not applied.

7. **Verify and report.** Re-read the edited file: frontmatter still valid
   (`name` matches the directory), description still covers what + when,
   referenced paths/commands resolve, no dangling cross-references. Show the
   diff for the file and summarize applied vs deferred findings. If the skill
   is already sound, say so and stop.

## Audit rubric

Frontmatter:

- `name` matches the directory name.
- `description` states *what it does* and *when it triggers*; trigger phrases
  are ones a user would actually type; no vague "helps with X".
- Description matches the body — not narrower (hidden capabilities) or wider
  (promised but absent).

Body:

- Role and boundaries are explicit: what this skill is, and what it is not
  (its siblings' jobs).
- Inputs: what the user must supply and how missing input is resolved
  (ask vs infer), with the question-tool discipline stated where relevant.
- Workflow: ordered, actionable steps; decision points say who decides; stop
  conditions exist (nothing to do, blocked, done).
- Rules: checkable, grounded in this repo's tools and conventions, and say
  what the skill must never do.
- Output shape: if the skill emits user-facing text, its expected shape is
  stated.
- Honest-failure guidance: what to do when nothing matches or evidence is
  missing — without forcing a result.

What to flag:

- Vague verbs ("improve", "handle", "make sure") with no observable outcome.
- Missing trigger phrases that users in this repo actually say (compare with
  sibling descriptions).
- References to files, paths, commands, tracker names, or issue ids that no
  longer resolve (verify in-repo references by reading the referenced
  location; flag external ones as unverifiable).
- Workflow that silently makes decisions the Rules say the user must confirm,
  or the reverse.
- Overlap with a sibling skill that is neither acknowledged nor bounded (use
  `which-skill` relationship vocabulary: pipeline, alternatives, composition,
  specialization, prerequisite, meta/router).
- Rules that cannot be enforced or contradict the workflow.
- Bloat: restating generic agent behavior, empty headers, exhaustive lists
  where a principle would do, duplicated content that will drift.
- One finding per issue; do not bundle unrelated weaknesses.

## Findings format

One block per finding, kept scannable:

```
[high|medium|low] <short title>
  Evidence: "<quoted line(s) from the skill>"
  Change: <exact intent — what will be added, removed, or reworded>
```

Severity guide: `high` = wrong or misleading instructions, broken references;
`medium` = missing triggers, ambiguity, unbounded overlap; `low` = ordering,
style, redundancy.

After the confirmation round, apply and report: a short summary plus the file
diff.

## Rules

- Edit only the selected `SKILL.md`. Never touch project code, other skills,
  or the issue tracker.
- Minimal diff, preserve voice: no wholesale rewrites unless the user asks.
- Static review only: judge by skill text and repository files; do not mine
  sessions, logs, or git history for behavioral evidence.
- Never invent capabilities, tools, or guarantees; never weaken safety
  constraints (read-only promises, confirmation rounds, "never auto-pick"
  rules).
- If a finding requires changing the skill's scope or behavior, report it as
  out of scope for a text edit.
- If the skill is already sharp, stop with a passing report — do not
  manufacture findings.
