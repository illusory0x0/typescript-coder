---
id: 62
title: "Opencode baseline re-run under the clarified task text"
status: done
priority: medium
milestone: null
parent: 46
deps: [61]
labels: [benchmark]
created: 2026-10-19
---

## Context

#61 rewrites the frozen task text (`TASK_ISSUES` in `benchmark/run.ts`) to state scope, the scratch-file ban, the fixture inventory, and the exact checks. The current opencode none-effort baseline (`benchmark/results/2026-10-18-opencode-none.{json,md}`, #47) was measured under the old text: 9/9, mean 19,377 tok/run (json 15,963 / sexp 11,770 / minilisp 30,398), mean 8.6 steps - carrying the pre-clarification overhead quantified in #61 (orientation probes, tmp-script probes, extra tsc/execute steps). All cross-side comparisons (`benchmark/results/consumption.md`, #28's "below the opencode baseline" clause, #46's goal) must use runs measured under the same frozen text; the tc side picks the new text up automatically, so the oc arm must be re-measured.

## Goal

A fresh 3x3 opencode none-effort baseline measured under the clarified text, with the step/token delta vs the 2026-10-18 baseline recorded and paired with a tc-side matrix under the same text.

## Acceptance criteria

- [ ] Re-run completes with the #47 invocation (same model/effort/reps): `bun run benchmark/run.ts --all --side oc --reps 3 --model "honghong/deepseek-v4.1-flash#none" --json benchmark/results/<date>-oc-none.json --keep`; the report's "Frozen task specs" section shows the clarified text.
- [ ] Delta vs 2026-10-18 reported per task and overall (success x/9, mean total, mean steps) plus before/after counts of the orientation / scratch / extra-verification step classes, citing the kept bundle.
- [ ] `benchmark/results/consumption.md` gains the refreshed baseline row; the 2026-10-18 row is retained and labeled pre-clarification.
- [ ] The ledger pairs the refreshed baseline with a tc-side matrix measured under the same clarified text (reuse the #60 verification matrix when it lands under that text; run a tc-side 3x3 matrix (`--side tc --reps 3`) if not). The pairing is named in the ledger.
- [ ] 2026-10-18 artifacts stay untouched (`benchmark/results/2026-10-18-opencode-none.*`, `tmp/benchmark/2026-10-18T08-26-46-841Z-9b0813ff/`); gates green: `bun run typecheck`, `bun test`, `bun run accept`.

## Verification

Run the command above (or the tc-side variant) and read the generated md raw-runs table plus the consumption row; append evidence to Notes: per-run steps/tokens, the delta table, and the pairing statement.

## Notes

- If the clarified text materially lowers the opencode number, re-evaluate #28's goal and #46's verdict against the refreshed baseline and state that in the Notes.
- Coordinate with #60: its verification matrix runs under the same clarified text and is the natural tc-side pair; prefer reusing it over running a second tc matrix.
- Pre-clarification evidence is kept in `tmp/benchmark/2026-10-18T08-26-46-841Z-9b0813ff/` and `benchmark/results/2026-10-18-opencode-none.*`; do not delete.
- Priority defaulted to medium; no milestone. Deps #61.

### Evidence (2026-10-19)

- Re-run (criterion 1): `bun run benchmark/run.ts --all --side oc --reps 3 --model "honghong/deepseek-v4.1-flash#none" --json benchmark/results/2026-10-19-oc-none.json --keep` -> 9/9; "Frozen task specs" shows the clarified text for all three tasks; kept bundle `tmp/benchmark/2026-10-18T22-03-54-655Z-a2efcfc6/`.
- Delta (criterion 2): json 15,963 -> 17,043 tok (+6.8%), steps 5.7 -> 4.7; sexp 11,770 -> 11,744 (-0.2%), steps 6.7 -> 4.3; minilisp 30,398 -> 42,224 (+38.9%), steps 13.3 -> 18.3; overall 19,377 -> 23,670 (+22.2%), steps 8.6 -> 9.1; success 9/9 both. Step classes (old bundle `tmp/benchmark/2026-10-18T08-26-46-841Z-9b0813ff` -> new): orientation probes 21 -> 2; scratch/tmp-script probes 6 -> 0; calls containing tsc/bun test 22 -> 16; target-file edits/writes 22 -> 39. The clarified text removed the targeted orientation/scratch overhead; this sample's heavier minilisp repair loops hold the total up.
- USD view (official deepseek-flash off-peak; see #63): mean per run $0.004648 -> $0.005587 (+20.2%); json +4.3%, sexp -11.2%, minilisp +37.5%. Cross-check: the export `cost` matches the official formula on all 18 oc runs.
- tc pairing (criterion 4): `bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/2026-10-19-tc.json --keep --replay-dir tmp/replays-62-tc-matrix` -> 7/9 (json 3/3 @ 4,679 tok/run; sexp 3/3 @ 3,062; minilisp 1/3 @ 106,883 mean; both minilisp failures are token-budget storms ~123k against the 120k budget). Overall tokens per success 49,125 (45,148 in / 3,976 out; success-only mean 12,588). Pairing: oc 23,670 (9/9) vs tc 49,125 (7/9) tok/success; USD $0.005587 vs $0.008000.
- Ledger rows (criterion 3): land in USD per success once #63 ships (user directive 2026-10-19); this issue closes with that update.
- The two minilisp storms are fresh forensics for #60; replay bundles in `tmp/replays-62-tc-matrix/`.
- Volatility analysis (2026-10-19, step-level over both kept bundles): the +22.2% is not a clean text effect. Intended: orientation+scratch tool calls 21+6 -> 2+0 (~-23k class tokens; json/sexp steps 5.7/6.7 -> 4.7/4.3). Regression: work-class tokens 56,895 (22 steps) -> 106,197 (39 steps), minilisp edits 16 -> 31, heavy minilisp runs 52,712/49,132 vs 40,495 (and the old sample had a lucky 5-step run); candidate mechanism: the clarified text bans scratch files/extra commands, so debugging moves from tmp scripts into full edit -> bun test -> edit cycles. Noise: the closing message's provider-side cache hit/miss variance swings its uncached input 362 vs 7,388/9,068 (old round 351 vs 2,330/6,999) - a +/-8-9k tok (~$0.0013) per-run swing; json +6.8% and sexp -0.2% are inside it. Track minilisp repair loops after #60; do not read the token totals as a text regression yet.

### Close-out evidence (2026-10-19, after #63 landed)

- Criterion 3/4 (USD ledger): `benchmark/results/consumption.md` now carries
  - the clarified-text baseline row (two 3x3 samples = 6 runs per task, from `2026-10-19-oc-none.json` + `2026-10-19-oc-none-2.json`: means $0.00335 / $0.00227 / $0.00942 per task, $0.00501 overall);
  - the pressure-baseline row (user directive 2026-10-19, 3 extra reps): per-task minimum over the 6 runs — json $0.00217 / sexp $0.00195 / minilisp $0.00598; overall $0.00444 (better of the two 9-run sample means); stricter composite $0.00337 (mean of the three per-task minima);
  - the tc pairing row (`2026-10-19-tc.json`: $0.00114 / $0.00052 / $0.05099; overall $0.00800, 7/9), named as paired with the refreshed baseline;
  - and the 2026-10-18 row labeled pre-clarification text.
- Sample 2 (the extra 3 reps): same invocation, `--json benchmark/results/2026-10-19-oc-none-2.json --keep`, bundle `tmp/benchmark/2026-10-18T23-04-44-109Z-1282205f/`; 9/9, all runs `off-peak`; per-run USD equal the off-peak recomputation (0 mismatches).
- Verdict vs the pressure baseline: json/sexp far below (tc $0.00114 / $0.00052 vs $0.00217 / $0.00195); minilisp and overall still above (tc $0.05099 vs $0.00598; $0.00800 vs $0.00444 / $0.00337) — the overall cross-side claim rests on removing the minilisp rejection storms (#60). Stated in the ledger row's Notes.
- Clarified-text effect on oc: 6-sample mean $0.00501 is above the pre-clarification $0.00465; the best sample $0.00444 is 4.5% below. No material drop, so #28 stays superseded by #46 and #46's verdict must use the pressure baseline — stated in the ledger.
- Criterion 5: 2026-10-18 artifacts untouched (`2026-10-18-opencode-none.*` mtime 2026-10-18 16:41:04; bundle `tmp/benchmark/2026-10-18T08-26-46-841Z-9b0813ff/` retained); gates rerun at close: `bun run typecheck` clean, `bun test` 647 pass / 0 fail, `bun run accept` 5/5; tracker `check` green.
