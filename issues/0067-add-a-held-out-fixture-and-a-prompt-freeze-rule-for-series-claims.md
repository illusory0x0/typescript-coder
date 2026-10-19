---
id: 67
title: "Add a held-out fixture and a prompt-freeze rule for series claims"
status: todo
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
- [ ] A first held-out baseline row (tc side, 3 reps, off-peak) is recorded in
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
