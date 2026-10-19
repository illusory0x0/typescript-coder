---
id: 49
title: "Context management: audit and cut input tokens"
status: done
priority: high
milestone: null
parent: 46
deps: []
labels: [harness]
created: 2026-10-18
---

## Context

Input tokens dominate the spend: overall input 11,198 of 13,716 tokens per
success in #44's canonical run; per-run means are json 2,722, sexp 2,182, and
minilisp 17,491 (6 steps ≈ 2.9k/step — the fat one, dominated by repair rounds).

Directive (2026-10-18): keep optimizing context management, analyzing causes.

## Goal

The per-exchange context composition is audited with numbers, and the identified
fat is measurably reduced — overall tokens per success below the pre-change value
with success not lower.

## Acceptance criteria

- [ ] An audit of the per-exchange context composition (task/spec, current
      sources, diagnostics, edit results, repair history) with token estimates,
      written into this issue's Notes.
- [ ] At least one context reduction lands with tests; the full tc-side matrix
      re-measure shows overall tokens per success below the pre-change canonical
      value and success not lower (json 3/3 ≤6,900, sexp 3/3, minilisp not
      worse).
- [ ] The numbers are recorded (report/consumption row or #46 evidence).

## Verification

```
bun test
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-ts.json
```

plus: compare aggregates against `benchmark/results/2026-10-18-ts.json`.

## Notes

- Coordinate with #48 (repair rounds are the largest context consumer) and #50
  (diagnostic payloads come from the editor).
- Non-goals: capability changes that trade success for tokens; unified-diff
  shortcuts.

### Context audit (2026-10-18)

Per-exchange composition measured from the replay bundles of the latest
matrices (`tmp/replays-52-continuation/`, `tmp/replays-48-repin3/`); characters
converted at ≈4 chars/token:

| Segment                       | Size                            | Observation                                                                                              |
| ----------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| System prompt                 | 2,407 chars/call (≈600 tok)     | re-sent on every exchange; wording reduction is #55's scope                                              |
| Issue + project-context YAML  | ≈230 + ≈200 chars/call          | YAML already bounded (500-symbol cap); negligible on these fixtures                                      |
| Spec section (`# Spec files`) | **3,020 chars/call (≈755 tok)** | the task's spec/test source, re-sent on every exchange, untruncated below SPEC_FILE_LIMIT = 8,000        |
| Current source                | 100–6,066 chars/call            | symbol slice normally; the whole grown file in create→repair rounds                                      |
| Diagnostics                   | 100–4,000 chars/call            | capped at DIAGNOSTICS_LIMIT = 4,000                                                                      |
| Edit results / repair history | none carried                    | messages are rebuilt each exchange as [system, issue, pinned, one user prompt]; no transcript is re-sent |

Static payload (system + issue + YAML + spec) is 43–75% of all prompt
characters in the sampled runs (json 74.6%; minilisp 43–54%). The minilisp
storm re-sent 96,640 spec characters (≈24k tokens) across its 32 calls.

Reduction chosen: drop the spec section from the content prompts of rounds
opened by a `tsc`-stage verification failure (their in-round retries and their
#52 continuation included); selection, first-round, `tests`-stage, and
soft-failure rounds keep it. Expected saving ≈17% of a repair-heavy minilisp
run (≈755 tokens × repair calls), 0% on the repair-free json/sexp happy path.

### Measurement (2026-10-18, two samples)

Mechanism verified live (`tmp/replays-49-context*/`): the lean variant is sent
on every content exchange of tsc-repair rounds — e.g. the storm run has 40/42
calls lean (the 2 full calls are the selection and the first round), and each
rep shows the expected full-then-lean split (2/2, 40/2, 3/2).

| sample | report                        | success | raw overall tps | success-path tps | json        | sexp        | minilisp |
| ------ | ----------------------------- | ------- | --------------- | ---------------- | ----------- | ----------- | -------- |
| 1      | `2026-10-18-ts-context.json`  | 8/9     | 21,939          | 6,324            | 4,645 (3/3) | 2,995 (3/3) | 2/3      |
| 2      | `2026-10-18-ts-context2.json` | 7/9     | 40,836          | 4,747            | 4,594 (3/3) | 2,978 (3/3) | 1/3      |

Sample 1 carries one token-budget storm (rep2, 124,917 tokens, 42 calls: 18
matcher rejections + 20 applied-but-unverified edits + 1 repeat); sample 2
carries two (rep1 126,068 / rep2 126,554). The storm burns to the same 120k
budget as before the change — the lean prompts cut per-call burn (storm
per-call ≈2,974 vs ≈3,979 in `2026-10-18-ts-continuation`) and simply allow
more attempts before the budget stops the run.

Criterion status: the success-path reduction is confirmed in both samples
(4.7–6.3k vs canonical 13,716 and vs the continuation sample's 7,443), and
json/sexp/mechanism checks pass; the **raw "overall tokens per success"
clause is NOT yet met** (21,939 / 40,836) because the metric is dominated by
the storm defect — the post-#52 storm rate on minilisp is 4 of 9 runs, each
burning ~120k. The storm is a tracked harness defect (#54 stalled-round
decision point, #56 per-cause retry policy, #57 attempt digest), not an effect
of this change.

Disposition: implementation + gates done; the raw clause is re-measured after
#54 lands (a storm-free matrix then satisfies both readings — raw below the
pre-change 23,357 and below the canonical 13,716). Issue stays open until that
re-measure; the row lands in `benchmark/results/consumption.md` with it.

### Measurement 3 (2026-10-19, post-cluster matrix)

`benchmark/results/2026-10-19-ts.json` — json 3/3, sexp 3/3, minilisp 2/3:

| sample | report               | success | raw overall tps | success-path tps | json        | sexp        | minilisp      |
| ------ | -------------------- | ------- | --------------- | ---------------- | ----------- | ----------- | ------------- |
| 3      | `2026-10-19-ts.json` | 8/9     | 34,446          | 18,593           | 4,587 (3/3) | 2,965 (3/3) | 126,454 (2/3) |

json is at its series best and below the ≤6,900 criterion; sexp is 3/3;
minilisp is "not worse" than the canonical 0/3 (2/3; repin3's 3/3 remains the
best sample). The raw clause is still NOT met: minilisp rep1 spent 89,716
tokens on a rejection-cycle storm that recovered, and rep3 burned 126,822 to
the token budget on a stale-matcher/no-op/repeat cycle — both above the
pre-change 23,357 reading and the canonical 13,716. The storm moved from
applied-no-op waste (removed live by #59: 18 no-op rejections, zero applied
no-ops) to rejection resend cycles; ownership of the residual is #60. The
success-path reading (18,593) is also above the canonical 13,716 because of
rep1's recovery cost. Issue stays open until #60 lands and the raw value is
re-measured; the ledger row for this sample is recorded in
`benchmark/results/consumption.md` (2026-10-19 row).

### Re-measure (2026-10-19 #65 matrices, added 2026-10-19)

Raw clause still NOT met. Overall tokens per success: 39,924 (a: 35,368 in /
4,556 out) and 25,248 (b: 20,825 in / 4,423 out) — below the previous 48,960
but above both the pre-change 23,357 and the canonical 13,716; success not
lower (7/9, 8/9). The cost sits in the three storm runs (a rep1 124,369 =
106,080 in / 18,289 out over 38 calls; a rep2 120,021 = 115,406 in over 39
calls; b rep1 124,125 = 102,999 in over 41 calls) whose every-round re-send of
the growing context dominates; minilisp's 3-run token total is 256,026 (a) /
178,932 (b). Re-measures on #71's matrices.

### Measurement 4 (2026-10-19, #71 c/d matrices, added 2026-10-19)

| sample | report                         | success | raw overall tps | success-path tps | json        | sexp        | minilisp      |
| ------ | ------------------------------ | ------- | --------------- | ---------------- | ----------- | ----------- | ------------- |
| 4      | `2026-10-19-tc-storm71-d.json` | 9/9     | 13,008          | 13,008           | 4,612 (3/3) | 3,083 (3/3) | 31,330 (3/3)  |
| 5      | `2026-10-19-tc-storm71-c.json` | 8/9     | 34,586          | 18,954           | 4,662 (3/3) | 3,073 (3/3) | 126,740 (2/3) |

Sample 4 is the series' first raw reading below the canonical 13,716 — every
storm run resolved (23,186 / 27,279 / 43,524), success 9/9. Sample 5 is
dominated by one bare-budget storm (rep2, 125,052; the #65 residual); its other
two storms resolved at 92,208 / 36,219. json 3/3 <= 6,900 holds in both and
minilisp is not worse than the canonical 0/3 (3/3 / 2/3). Disposition (user
decision, 2026-10-19): closed on the sample-4 reading; the sample-5 storm is
recorded as the tracked #65 residual. Rows in
`benchmark/results/consumption.md`.
