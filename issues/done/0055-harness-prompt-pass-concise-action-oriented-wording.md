---
id: 55
title: "Harness prompt pass: concise, action-oriented wording"
status: done
priority: medium
milestone: null
parent: 46
deps: []
labels: [harness]
created: 2026-10-18
---

## Context

User directive (2026-10-18): optimize the harness prompts to be as concise and
clear as possible and to describe concrete execution actions. The current
prompt templates grew organically across #41/#43/#48/#52 and duplicate each
other: `buildSystemPrompt` (src/loop.ts:159) restates the address/matcher rules
that `buildEditPrompt`/`buildRetryPrompt` also carry, several sentences explain
harness internals instead of telling the model what to do, and the same wording
is re-sent on every exchange (every prompt is paid input tokens on each call).

## Goal

Every model-facing prompt template in src/loop.ts is rewritten to state the
required action(s) directly and concretely — exact output shape, concrete
options when a choice exists — with filler and duplication removed, so the whole
prompt set is shorter and every sentence is actionable.

## Acceptance criteria

- [ ] Inventory recorded in Notes: every model-facing prompt (system, issue,
      initial edit, initial create, edit retry, round continuation, stall
      (#54) when landed, selection retry, selection continuation, summary) with
      pre-pass and post-pass rendered character counts, measured with fixed
      sample inputs by a scratch script kept in `./tmp/` during the pass (the
      numbers transcribed into Notes; the script is not committed).
- [ ] Each prompt: (a) states its required action and exact output shape in the
      first sentence(s); (b) when a choice exists, names the concrete options
      (e.g., `matcher` vs whole-symbol rewrite; re-pin vs revise; STOP vs
      continue where the prompt offers STOP); (c) contains no sentence that
      only explains harness internals; (d) drops text that repeats verbatim a
      rule the same prompt already states.
- [ ] Behavior contracts unchanged: same JSON key sets, `STOP` offered only
      where it already is, "no fences / no prose" where it already applies,
      same truncation and length semantics; the loop still sends
      system + issue + pinned address + one user message per exchange, so
      prompts stay understandable with the system prompt in context.
- [ ] Total rendered prompt characters (sum over the inventory with the fixed
      sample inputs) do not increase by more than 10%.
- [ ] `spec.md` and `docs/glossary.md` updated where they quote prompt wording;
      gates: `bunx tsc --noEmit` 0, `bun test` all pass, `bun run accept` 5/5,
      `bun benchmark/check.ts` 3 PASS.
- [ ] Live evidence: the next live ts-side matrix after the pass shows json
      3/3, sexp 3/3, minilisp ≥2/3, tokens recorded in Notes and a row in
      `benchmark/results/consumption.md` (shared with #54's or the #46
      close-out matrix when those land in the same batch).

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
bun benchmark/check.ts
```

plus the pre/post character table in Notes and the post-pass live matrix.

## Notes

- Parent #46. Touches the prompt builders in src/loop.ts (159-420) and the
  tests that assert prompt text; coordinate with #54 (adds the stall prompt).
- The prompts are re-sent per exchange while system + issue stay in context, so
  condensing means removing stale explanations and within-prompt repetition,
  not context the model still needs.
- Model-facing rejection notes (`IDENTICAL_RETRY_NOTE`, repeat/gate/address
  diagnostics) are out of scope except where they overlap a prompt verbatim.
- Non-goals: no behavior changes, no new prompt variants, no benchmark-side
  changes.

## Notes (implementation, 2026-10-19)

- Prompt pass landed: every model-facing template now opens with its required
  action + exact output shape, names the concrete options, and drops
  harness-internals text and duplication; the #52 STOP framing, #54 stall
  framing, #56 corrections, #57 digest, and #58 four labels stay byte-identical.
- System prompt regression and revert: the pass's system-prompt rewrite
  (2407 -> 1978) broke the two-step framing; in the first live matrix after the
  pass (`tmp/matrix-regression/2026-10-19-ts.json`) all 9 runs answered the
  FIRST (selection) request with an edit-shaped payload (protocol:
  `unexpected key(s) "replacement"`), one wasted call per run (json runs ~9.2k
  vs ~4.5k tokens). Reverted verbatim: `buildSystemPrompt` is byte-identical to
  the recorded pre-pass text (2407 chars; checked against
  `tmp/replays-49-context2/json-parser-ts-rep1.json` calls[0].messages[0]) and
  src/loop.test.ts:510-511 pins the `First you will be asked to select the
  target` / `Then you will be asked to edit the selected symbol` framing.
- Inventory (fixed samples, scratch script in `./tmp/`, not committed; rendered
  chars pre -> post): system 2407 -> 2407 (reverted, see above); issue 605 ->
  605 (data wrapper, untouched); initial edit 912 -> 758; initial create 721 ->
  539; edit retry 994 -> 828; verification retry 1234 -> 1061; round
  continuation (edit) 1808 -> 1636; round continuation (selection) 968 -> 883;
  stall ask 1939 -> 1767; selection retry 339 -> 253; summary 506 -> 506 (owned
  by #58). Total 12433 -> 11243 (-9.6%).
- Test adaptations (src/loop.test.ts): system prompt framing + restored wording
  (498-516);
  edit prompt "Current source:" (565-578); create "COMPLETE declaration" /
  `omit "matcher"` (580-589); retry modifier note + capitalized no-fences
  (591-623, 625-645); repair re-pin sentence (2793-2826). All contract
  assertions (key sets, STOP placement, no-fence requirement, stall /
  continuation / digest / summary byte-identities) kept passing unchanged.
- Docs: the pass found no verbatim prompt quotes in spec.md /
  docs/glossary.md (grep-verified), so no doc edits were required.
- Gates (main-agent rerun): tsc 0, 606 tests pass, accept 5/5, check 3 PASS.
- Live evidence (2026-10-19 matrix, `benchmark/results/2026-10-19-ts.json`,
  post-revert state): json 3/3 (4,587), sexp 3/3 (2,965), minilisp 2/3; json
  and sexp are back to the 3-step happy path (the pre-revert sample had a
  wasted protocol step and ~9.2k json tokens). Row added to
  `benchmark/results/consumption.md`.
