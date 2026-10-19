---
id: 77
title: "Close the minilisp repair-cost gap: reliably beat the oc baseline on tokens per success (help wanted)"
status: todo
priority: medium
milestone: null
parent: 46
deps: []
labels: [help-wanted]
created: 2026-10-20
---

## Context

#46's goal is that the tc side beats the fair (none-effort) opencode baseline on
tokens per success **per task and overall**, with success json 3/3, sexp 3/3,
minilisp >=2/3. On the committed #75 code the goal is met on the clean path but
**not reliably on minilisp**:

- json ~4.8k and sexp ~3.2k tokens/success beat the #47 baseline (15,963 /
  11,770) on every sample; overall beats it on the clean samples (c 11,638,
  e 13,287, final-1 17,636 vs 19,377).
- minilisp tokens/success: e 26,328 and c 30,112 sit at/under the 30,398
  baseline, but final-1 is 38,027 (above) and the ~1-3% storms push d/f/final-2
  to 64k-82k.

Rows for all six samples are in `benchmark/results/consumption.md`. The storm
lever (#75, the gated decision-only turn) is landed and closed; the
context/checkpoint lever (#76, the opencode2 digest directive) was implemented,
measured, and **reverted** — neither moves the minilisp repair cost.

## Goal

Make minilisp tokens per success reliably below the #47 baseline (30,398) at
success >=2/3, so #46's per-task goal holds on an ordinary sample and not only
on the cleanest draw.

## Why this is help wanted

minilisp asks the model to author a whole interpreter, so its cost is dominated
by ordinary repair rounds (a large numbered source re-sent each exchange, and
churn through `tsc`/test failures), not by a breakable storm. Two levers are
already exhausted (storm decision turn; digest legibility). Candidate directions
(requester unsure):

- A bounded, windowed/anchored current-source view on repair prompts (the pinned
  declaration + its immediate context) instead of the whole file, cutting the
  per-exchange token floor — while keeping matchers exact and allowing a
  deliberate re-pin.
- Stronger per-cause corrections that cut within-round churn (the model does not
  see its own prior replies).
- A diagnostic-to-declaration map so a repair prompt names the failing
  declaration, not just the file.

## Acceptance criteria

- [ ] At least one measured mechanism lands (or a measured negative result is
      recorded with evidence).
- [ ] Live: two tc-side matrices each show json 3/3, sexp 3/3, minilisp >=2/3
      with minilisp tokens per success below the #47 baseline (30,398) and
      overall below 19,377.
- [ ] No hard cap, no auto-stop, guards unchanged; a recovering cycle can still
      succeed.
- [ ] `benchmark/results/consumption.md` rows added; #46's close-out updated.

## Verification

```
bun test
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-tc.json --replay-dir tmp/replays-<name>
bunx tsc --noEmit
bun run accept
bun benchmark/check.ts
```

## Notes

- Parent #46. Sequences after #75 (landed) and #76 (reverted with a recorded
  negative result).
- Non-goals: hard caps, auto-stops, weakening guards, unified-diff bypasses.
