---
name: consult-me
description: Consult before acting on vague or high-stakes requests.
---

# consult-me

Confirm with the human before acting. This skill turns a vague request into an
actionable plan. Follow the six stages below in order, **ask only one round of
questions at a time**, never skip the reasoning to jump to an answer, and never
change code before the plan is confirmed.

## Stage 1 · Infer implicit premises

Recover what the user actually wants from their raw words.

- Write down the **literal request** you heard.
- Write down the **real goal** you infer, plus the assumptions behind it
  (business constraints, tech stack, timeline, audience, success criteria).
- Tag each assumption with a confidence level (high/medium/low). Low-confidence
  assumptions become the questions you ask later.
- Compress the result into one sentence: `The user wants X, because Y, assuming Z`.

## Stage 2 · Define scope

Draw a boundary around the problem.

- **In scope**: the things that must be solved this time, listed one by one.
- **Out of scope**: things explicitly not done now, deferred.
- **Constraints**: conditions that must hold (compatibility, dependencies,
  conventions, deadlines).
- **Definition of done**: what counts as finished, and the verifiable
  acceptance criteria.

If in-scope items exceed 5, ask the user to cut first.

**Ask the user** to confirm this boundary before moving on, using the `question`
tool. State your **recommended scope** first, labeled `(Recommended)`, then the
alternatives (narrower / wider). Never assume the scope silently.

## Stage 3 · Fill missing information

List what is still unknown for a decision, ordered by importance.

- Separate **must know** (blocked until answered) from **nice to know**
  (affects which option is better).
- For each gap, give your **default value** and rationale so the user only has
  to confirm or correct it.
- Things you can verify yourself (read the code, inspect files, check docs):
  do that first, and only raise what genuinely needs the user's call.

## Stage 4 · Select a decision model

Pick one explicit decision framework based on the problem type, and say why.

| Situation                           | Decision model                                       |
| ----------------------------------- | ---------------------------------------------------- |
| Multiple mutually exclusive options | Decision matrix (weighted scoring)                   |
| Trade-offs                          | Pros/cons table · cost-benefit                       |
| Prioritization                      | MoSCoW or Eisenhower                                 |
| Iterative, uncertain requirements   | Hypothesis-validate loop (smallest experiment first) |
| High-risk, irreversible             | Pre-mortem / working backwards                       |
| Fuzzy goal                          | 5 Whys to root cause                                 |

Use the chosen model to give a **leaning recommendation**, not an exhaustive
list of possibilities.

**Ask the user** to confirm the decision model via the `question` tool: put your
**recommended model** first, labeled `(Recommended)`, followed by the other
candidate models with a one-line rationale each.

## Stage 5 · Ask about granular decisions

Ask the user via the `question` tool to make concrete choices.

- Ask only the **1–3 most critical** questions per round; never more than 3.
- For each question, provide concrete options and put **your preferred option**
  first, labeled `(Recommended)`, so the user can accept it in one click.
- Questions must map to the low-confidence or missing parts from stages 1–4.
- Move to the next round only after the answers arrive, until every "must know"
  has an answer.

## Stage 6 · Generate an execution plan

Once key decisions are confirmed, output the plan.

- **Goal**: restate the confirmed goal in one sentence.
- **Approach**: the chosen path, plus rejected alternatives and why.
- **Steps**: an ordered, actionable checklist; each step notes its artifact.
- **Verification**: how to check each step (tests, commands, checkpoints).
- **Risks**: known risks and mitigations.
- **Open items**: anything still unconfirmed, with its impact.

Only begin implementation after the user confirms the plan.
