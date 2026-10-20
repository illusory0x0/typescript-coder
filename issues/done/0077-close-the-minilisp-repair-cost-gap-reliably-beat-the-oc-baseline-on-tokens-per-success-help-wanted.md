---
id: 77
title: "Close the minilisp repair-cost gap: reliably beat the oc baseline on tokens per success (help wanted)"
status: done
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
- 2026-10-20 main-agent recon: live runs work (minilisp tc rep1 clean, 26,253 tokens, 23.8s). Replay tmp/replays-scope shows 7 calls; 5 repair calls each re-send the WHOLE file (7,682 chars, 252 lines) as the numbered current-source block (src/loop.ts:4003 sets wholeFile=repair||create; rangeFileRelative=repair at 4358/4402). That source block is ~67% of each repair prompt (11.5k chars; diagnostics 0.6-2.2k). Candidate mechanism under test: bounded anchored repair-source view = pinned declaration in full (declaration-relative, as the non-repair modify path already does) + a signatures-only outline of the other top-level declarations, with the self-check {"request":"read"} still offering the whole file. Target: cut ~1.5k tokens/exchange to bring a clean minilisp run from ~23.5k toward ~16k, below the 30,398 baseline.
- 2026-10-20 bounded-repair-source-view mechanism measured NEGATIVE, reverted. Implemented: repair rounds show the pinned declaration in full + a signatures-only outline of the other declarations (declaration-relative range) instead of the whole file; unit tests green, tsc 0. Two live tc matrices: Matrix 1 (benchmark/results/2026-10-20-tc-bounded-1.json; replays tmp/replays-77-1): json 3/3 (4,880 tps), sexp 3/3 (3,217), minilisp 2/3 (53,256 tps: rep1 13,203, rep2 23,738, rep3 edit-exhausted 69,572); 3-task overall 16,351 (below 19,377). Matrix 2 (benchmark/results/2026-10-20-tc-bounded-2.json; replays tmp/replays-77-2): json 3/3, sexp 3/3, minilisp 1/3 (171,154 tps: rep2 success 38,542; rep1/rep3 edit-exhausted 73,691/58,921); 3-task overall 27,895. Criterion 2 unmet on both (minilisp tps > 30,398; matrix 2 below the >=2/3 success bar). Clean-path repairs got much cheaper (~13k/~24k vs ~26k-38k) but the storm rate rose to 3/6 minilisp reps (committed #75 campaign: ~0-1 per matrix), so the per-task bar fails. Likely cause: hiding other declarations' bodies worsens the coordinated-type-change whack-a-mole that #78 targets. Reverted to HEAD (no code change). Negative result recorded per criterion 1; #77 stays in-progress, next lever #78.
- 2026-10-20 #87 landed: two tc-side matrices (`benchmark/results/2026-10-20-tc-diagdecl-{1,2}.json`, replays `tmp/replays-87-{1,2}/`) are 12/12 with minilisp 3/3 at 16,269 and 25,497 tokens/success (below the #47 baseline 30,398) and overall below 19,377. Criterion 2 met on two matrices; criterion 3 holds (rendering-only change, no guard/cap). Rows added to `benchmark/results/consumption.md`. The sibling lever #88 still gates this issue's close-out (all children must be decided).
- 2026-10-20: children decided — #87 landed (minilisp 3/3 below baseline on two matrices) and #88 reverted-negative (two matrices above baseline, each with a storm). Criterion 1 met (a mechanism lands: #87); criterion 2 met on #87's two matrices (json 3/3, sexp 3/3, minilisp 3/3 at 16,269 / 25,497 tps; overall below 19,377 on both reads); criterion 3 met (rendering-only change, no guard/cap/auto-stop); criterion 4 met (rows added; #46 close-out updated). Closing #77.
