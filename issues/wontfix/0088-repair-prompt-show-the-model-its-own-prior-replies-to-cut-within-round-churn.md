---
id: 88
title: "Repair prompt: show the model its own prior replies to cut within-round churn"
status: wontfix
priority: medium
milestone: null
parent: 77
deps: []
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

Every exchange rebuilds the provider messages as `[system, round issue, {role: "assistant", content: <pinned address>}, {role: "user", content: <prompt>}]` (`src/loop.ts:4447`). The model's own prior edit and retry replies are dropped: across a repair round it sees the current source, the diagnostics, the `#57` attempt digest (a count of ruled-out causes), the `#56` per-class correction lead, and (on a stall) the `#71` failure-history note — but never the text of what it just tried.

`LoopRecord.replacement` already stores each attempt's replacement (`src/loop.ts:1644`), so the material to show exists; only the render is missing. #77 names this absence as a cause of within-round churn ("the model does not see its own prior replies", leading to "same-class errors repeatedly changed"). #76, which reworked the digest's rendering, was measured and reverted; this is a different lever — the model's own verbatim prior attempt, not a restructured cause list.

## Goal

A repair exchange carries a bounded record of the model's own prior attempts in the round (at least the immediately preceding edit reply), so it can see what it already tried, vary it, and cut within-round churn.

## Acceptance criteria

- [ ] A repair/retry prompt includes a bounded, deterministic rendering of the model's own prior attempt(s) in the round (the preceding edit reply, or a short list), under an explicit character cap.
- [ ] Only assistant edit/retry replies that carry the round's work are included; the pinned-address echo and any prior-round text are not re-sent; the added characters are accounted for against the token budget.
- [ ] No new guard, cap, or auto-stop; the default single-payload protocol and json/sexp happy paths behave as before.
- [ ] Unit tests cover: the prior reply appears on the second repair exchange; the render is bounded and deterministic; the first edit prompt of a round carries none.
- [ ] Live: two tc-side matrices each show json 3/3, sexp 3/3, minilisp >=2/3 with minilisp tokens per success below the #47 baseline (30,398) and overall below 19,377 — or an argued negative result (with evidence) that showing prior replies does not reduce repair tokens.
- [ ] `benchmark/results/consumption.md` rows added; #77 updated.

## Verification

```
bun test
bunx tsc --noEmit
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-tc-priorreplies.json --replay-dir tmp/replays-<name>
bun run accept
bun benchmark/check.ts
```

plus replay inspection that the prior reply is present in the repair prompt.

## Notes

- Parent #77; one of #77's listed candidate directions ("stronger per-cause corrections that cut within-round churn (the model does not see its own prior replies)").
- Distinct from #76 (reverted): #76 changed the digest headings; this surfaces the model's own verbatim prior attempt.
- Non-goals: replaying the full conversation history or re-sending all messages; weakening guards; unified-diff bypass.
- Open question: how many prior attempts to show, and whether to show the rejected reply verbatim or its replacement text only.
- Priority defaulted to medium; no milestone.
- Negative result (2026-10-20). Implemented `renderPriorAttempts` plus the retry/continuation "Your previous attempts (most recent last):" section and wired it from `runLoop`; gates were green (tsc 0, 872 tests, accept 5/5, benchmark/check 4 PASS) and the section rendered live. Two tc-side matrices (`benchmark/results/2026-10-20-tc-priorattempts-{1,2}.json`; replays `tmp/replays-88-{1,2}/`) each came back 11/12 with minilisp 2/3 at **31,081** and **30,624** tokens/success — above the #47 baseline (30,398) — each losing a run to a storm (matrix 1 rep1 bare token budget 132,743; matrix 2 rep3 STOP -> edit-exhausted 53,397). The section fired in the storm replays (9x / 5x), so it is not inert; it produced no measured benefit and the samples did not clear the bar. Reverted to the landed #87 state (tsc 0, 865 tests) per the series rule that improvements stay measured. Criterion 5's negative clause met.
- Wontfix (2026-10-20): Implemented and measured; the prior-attempts section fired but produced no benefit — two live matrices were minilisp 2/3 at 31,081 and 30,624 tokens/success (above the 30,398 baseline), each with a storm; reverted per the series rule that improvements stay measured.
