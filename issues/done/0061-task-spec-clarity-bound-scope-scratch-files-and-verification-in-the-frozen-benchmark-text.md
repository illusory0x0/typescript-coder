---
id: 61
title: "Task-spec clarity: bound scope, scratch files, and verification in the frozen benchmark text"
status: done
priority: medium
milestone: null
parent: 46
deps: []
labels: [benchmark]
created: 2026-10-19
---

## Context

The frozen task text (`TASK_ISSUES` in `benchmark/run.ts`, ~line 211) is the *entire* prompt for the oc side and is embedded at the head of the user message in *every* tc-side model call (replay evidence: `tmp/replays-49-context2/json-parser-ts-rep1.json` -> `.issue` and `calls[*].messages[1]`). It currently says only: implement `src/<file>.ts`, pass the test file, keep tsc clean, do not modify test/tsconfig.

User report (2026-10-19): opencode burns usage on aimless exploration of the fixture folder; the task requirements must be stated explicitly. Evidence from the 2026-10-18 opencode-none baseline (9/9; kept bundle `tmp/benchmark/2026-10-18T08-26-46-841Z-9b0813ff/logs/*/side.log`; report `benchmark/results/2026-10-18-opencode-none.{json,md}`):

- Orientation probes before the first edit: json rep1 ran `ls -la src/` then `ls -la; cat package.json; cat tsconfig.json` (no package.json exists in the fixture); minilisp rep2 ran `ls src/ && which bun && bun --version`.
- Scratch/extra verification: minilisp rep1 (16 steps, 31,206 tok) had 12 shell calls - 4 tmp-script probes (`cat > tmp/check.ts`, one retried after `mkdir -p tmp`), 3 `tsc` runs, 3 `bun test`; sexp rep2 (10 steps, 14,836 tok) spent 5 `execute` steps that ended in environment/tool-catalog probing (`Object.keys(tools.browser)`).
- Contrast: minilisp rep2 finished in 5 steps / 19,493 tok; minilisp rep3's 19 steps / 40,495 tok are a genuine 9-edit repair loop, not exploration - the text targets orientation/scratch/extra-verification overhead only.
- The fixture is literally `src/<file>.test.ts` + `tsconfig.json`, but the text never says so.

Editing the text changes the measurement instrument: comparisons in `benchmark/results/consumption.md` and the goals of #28/#46 must use same-text runs; the pre-clarification opencode baseline is refreshed under the follow-up issue (deps this one).

## Goal

The frozen task text (identical verbatim for both sides) states scope, non-goals, and the exact checks explicitly, so runs stop spending steps on orientation probes, scratch scripts, and extra verification.

## Acceptance criteria

- [ ] All three `TASK_ISSUES` texts state concisely: (a) create or modify only `src/<file>.ts`; `src/<file>.test.ts` and `tsconfig.json` are read-only; (b) no other files - explicitly no scratch files; (c) the fixture contains only those files - nothing else to explore; (d) verification is exactly `bun test` and `bunx tsc --noEmit` - no other commands, scripts, or probes; (e) the test file is the specification - implement what it requires, nothing more.
- [ ] Each text stays within 700 characters (current: 210-220; it is repeated in every tc-side call, see #49) and the verbatim-one-source design is kept: both sides read the same `TASK_ISSUES` constant, no second copy anywhere.
- [ ] `benchmark/README.md` states that the frozen spec is the single `TASK_ISSUES` source rendered into reports (only if it does not already).
- [ ] Gates green: `bun run typecheck`, `bun test`, `bun run accept`; tracker `check` passes; dated files under `benchmark/results/` stay untouched.

## Verification

- Read the three texts side by side; walk (a)-(e) against each; check each length is <= 700 chars.
- `grep -n "Implement src/" benchmark/run.ts` -> exactly one copy per task; the report renderer (run.ts ~line 1361) reads the same constant.
- Run the gates above; the next benchmark run (the follow-up baseline refresh, or any smoke run) must show the new text in its "Frozen task specs" section.

## Notes

- Draft starting wording (json; keep the parallel shape for sexp/minilisp; refine freely but keep (a)-(e) and the length bound):

  ```
  Implement src/json.ts exporting JsonValue and parseJson(text: string): JsonValue
  so that src/json.test.ts passes. Keep tsc --noEmit clean.
  Create or modify only src/json.ts - no other files, no scratch files;
  src/json.test.ts and tsconfig.json are read-only.
  The fixture contains only those files - nothing else to explore.
  The test file is the specification; implement what it requires, nothing more.
  Verify with `bun test` and `bunx tsc --noEmit` only.
  ```
  (~500 chars)
- `bunx tsc --noEmit` is verified working inside the fixture workspace (opencode used it successfully in the baseline runs).
- Protocol-neutral: the tc side cannot explore or run commands; the constraints are task requirements, not harness instructions.
- Nothing in the codebase parses the issue text (grep: only prompt construction and report rendering consume it), so the edit is low-risk.
- Priority defaulted to medium; no milestone. Parented under #46 as benchmark-instrument hygiene.

### Closure evidence (2026-10-19)

- Implemented via subagent `ses_eaf065df2ffei3fDnGEl1FP0OG`; verified by the main agent.
- Texts: json 465 / sexp 455 / minilisp 462 chars (limit 700), 7 lines each, covering (a)-(e). Single source `TASK_ISSUES`: prompt construction (run.ts:1103) and the report renderer (run.ts:1376) consume the same constant; README line 8 states the frozen-spec single source.
- `--help` shows `--side tc|oc|both`; `--side ts` rejected with exit 2; legacy replay bundle `tmp/replays-49-context2/json-parser-ts-rep1.json` still parses (side normalized to "tc", 2 calls).
- Gates (main-agent rerun): tsc 0, 623 tests pass, accept 5/5, tracker check ok; dated results untouched (only the living `consumption.md` changed under `benchmark/results/`).
- Same change set carries the user-mandated `tc`/`oc` terminology rename: AGENTS.md "Terminology" section, flags/labels/run names, replay format (writer "tc"; reader accepts legacy "ts"), docs, and open issues #46/#49/#53/#57/#60/#62; historical artifacts keep old labels.
- Render corroboration lands with the #62 report's "Frozen task specs" section.
