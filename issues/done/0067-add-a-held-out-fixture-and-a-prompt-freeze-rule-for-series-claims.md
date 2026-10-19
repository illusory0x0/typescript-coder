---
id: 67
title: "Add a held-out fixture and a prompt-freeze rule for series claims"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [benchmark]
created: 2026-10-19
---

## Context

Every tc series row is measured on the same three frozen fixtures with one
model, and the prompt set was already tuned once against them (the #55
regression and revert). mri-project requires held-out tasks and
unseen-repo generalization in its acceptance precisely to avoid winning
against a strawman (`mri-domain/research-tmp.md` §1.8;
`.scratch/test-suite-improvements/spec.md` directions 9/12). Without a
held-out fixture, a "prompt-shaped win" on json/sexp/minilisp cannot be
distinguished from overfit.

Source survey: `/home/illu/repo/mri` absorption study (2026-10-19), insight 6.

## Goal

One benchmark fixture is never used for prompt or loop iteration; prompt/loop
changes must show a held-out result before a series row cites a generalization
gain.

## Acceptance criteria

- [ ] A new task is added with frozen text per #61's discipline (same 3-rep
      protocol, same checker) and designated held-out in `benchmark/README.md`;
      the rule states it is never the target of prompt-iteration runs.
- [ ] `consumption.md` records the rule: held-out results are never a
      change-set's evidence of prompt fit; they gate "generalizes beyond the
      tuned fixtures" claims.
- [ ] A first held-out baseline row (tc side, 3 reps) is recorded in
      `consumption.md`.
- [ ] Gates green.

## Verification

`bun run benchmark/run.ts --all --side tc --reps 3 --json
benchmark/results/<date>-tc-holdout.json` with the held-out task included; the
ledger row is appended with its window.

## Notes

- Source: mri-project `docs/spec/findings.md` ("one model, one temperature,
  n = 1") and `docs/review-guide.md` gap list; mri-domain held-out criteria.
- The held-out task's model-facing text must be frozen exactly like the
  existing three (compare only same-text runs).
- Priority defaulted to medium; no milestone.

### Implementation and baseline (2026-10-19)

- **Held-out task:** `csv-parser` added with frozen text (same 7-line shape as
  the others) in `benchmark/run.ts` (`TASK_ISSUES`, `TaskName`,
  `TASK_REFERENCE_BASENAMES`) and wired into `benchmark/check.ts`
  (`benchmark-check` 3 -> **4 PASS**). Frozen fixture at
  `benchmark/fixtures/csv-parser/` (`tsconfig.json` + `src/csv.test.ts`,
  12 tests) with reference `benchmark/references/csv.ts`.
- **Rule:** `benchmark/README.md` §"Fixtures and the held-out task" and
  `benchmark/results/consumption.md` §"Held-out task rule (#67)" state that
  `csv-parser` is never the target of prompt/loop iteration, gates only
  "generalizes beyond the tuned fixtures" claims, and is not a change-set's
  evidence of prompt fit. The per-task ledger columns stay the three tuned
  fixtures; the held-out value is recorded in each row's `Notes`, and `Overall`
  now spans four tasks.
- **First held-out baseline** (`benchmark/results/2026-10-19-tc-holdout.json`;
  replays `tmp/replays-67-tc-holdout/`; runs 17:50:15-17:51:12 UTC; row added to
  `consumption.md`): 12/12, **csv-parser 3/3 at $0.00300** (23,022 tokens per
  success), json 3/3 $0.00111, sexp 3/3 $0.00035, minilisp 3/3 $0.00348, overall
  $0.00199.
- Gates: `bunx tsc --noEmit` 0, `bun test` all pass, accept 5/5,
  `bun benchmark/check.ts` **4 PASS** + ledger 0 failed.
