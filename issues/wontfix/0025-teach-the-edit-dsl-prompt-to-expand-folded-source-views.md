---
id: 25
title: "Teach the edit-dsl prompt to expand folded source views"
status: wontfix
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-23
---

## Context

The 2026-10-22 post-24 benchmark (`benchmark/results/2026-10-22-post-24.json`,
report in `.md`) ran `minilisp` tc at 0/3. All three runs burned 35-39 steps
and 20-29 whole-file `read`s, with only 3-4 applied edits: rep1 hit
`token-budget` at 123,958 tokens, rep2 stopped after 12 failed rounds at 120,523
(9/16 tests), and rep3 hit `token-budget` at 125,244 (12/16 tests, an explicit
`nested depth unsupported` parser). The failure summaries themselves recommend
rewriting `src/lisp.ts` wholesale, but the runs never got there.

Since `494fa60` ("edit-dsl: fold huge source views"), any source view longer
than six lines is folded to the first three and last three lines:
`FOLD_HEAD_LINES`/`FOLD_TAIL_LINES` in `src/edit-dsl.ts`, `renderReadFeedback`
for `read` results in `src/multi-editor.ts`, and `fold=true` for `# details` in
`src/prompts/edit-dsl.ts`. The failure log shows the exact effect on the
338-line target: `src/lisp.ts (whole file): ... content folded, source range:
4-335`. The model sees 6 of 338 lines, issues another whole-file `read`, sees
the same 6 lines, and never uses `read ... within`; each exchange still costs
about 3.1k input tokens, so the 120k budget is exhausted before the repair
converges.

The fold is intentional: the prompt should teach the model to work with the
folded protocol. This issue is not a request to change the fold policy or its
thresholds. #22/#24 removed the old `const builtins` address loop; this read
loop is the new repair bottleneck.

## Goal

The edit-dsl model-facing prompts make the fold protocol self-explanatory: the
model can tell that a view is truncated, knows the exact command that returns
the hidden range, and knows when to switch to a whole-file `write`, so a repair
run does not burn its budget on repeated whole-file reads.

## Acceptance criteria

- [ ] The fold notice or its adjacent read/details prompt names the exact
      expansion form (`read <path> within <start>-<end> done`) and states that
      a whole-file `read` is also folded.
- [ ] The edit-dsl system/retry prompt teaches the strategy: inspect a folded
      block with `read ... within`, and use a raw `write <path> with ... done`
      when a repair spans multiple declarations or repeated localized edits
      keep introducing new tsc/test errors.
- [ ] Prompt-text tests assert the expansion and fallback guidance is present
      in the edit-dsl read/details prompt and that the prompt explains the
      existing fold marker; the JSON protocol text stays unchanged.
- [ ] A targeted `minilisp` tc run of 5 reps has zero `token-budget`
      terminations and shows at least one `read ... within` expansion or
      whole-file `write` repair in the run records; the result JSON is
      recorded.
- [ ] `just typecheck && just test` passes.

## Verification

- `just typecheck && just test`
- Live run (costs tokens):
  `bun run benchmark/run.ts --task minilisp --side tc --reps 5 --protocol-format edit-dsl --json benchmark/results/<date>-fold-prompt.json`.
  Check every run's `terminationReason`, and compare `viewer` records whose
  `diagnosticsHead` starts with `Read results` (whole file vs selected lines)
  and `applied` records.
- Confirm `benchmark/results/<date>-fold-prompt.json` contains no
  `token-budget` termination and record the per-run whole-file read counts
  beside the 29/24/20 baseline from `2026-10-22-post-24`.

## Notes

- Baseline evidence: rep1 123,958 tokens / 39 steps / 29 whole-file reads /
  3 applied edits; rep2 120,523 / 35 / 24 / 3, STOP after 12 failed rounds;
  rep3 125,244 / 36 / 20 reads + 1 select viewer / 4.
- n=3 and `minilisp` is historically flaky (0/1 compact baseline, 1/3
  semantic-rename, 3/3 in an earlier sample); the bar is "stop the storm", not
  "guarantee 5/5 passes".
- If prompt adaptation alone still storms because an explicit whole-file
  `read` is unexpandable, open a separate tool-policy issue rather than
  widening this one.
- Do not tune against the held-out `csv-parser` fixture.
- Refactored the edit-dsl prompt loading (JSON protocol untouched, hashes byte-identical): system prompt now leads with the TypeScript-expert role, motivation, tools mapping, detailed fold explanation, and a workflow summary; editDslInstruction carries 8 few-shot forms (new: folded-view expansion and whole-file write) then an ordered micro-operation workflow with triggers and an autonomous-exploration fallback. Fold markers are now self-describing: '... // content folded, source range: 4-335 (332 of 338 lines hidden); expand with read <path>/<actual path> within 4-335 done', and read headers show total lines/showing 6. Tests: just typecheck && just test -> 1245 pass. Pending acceptance criterion 4: the 5-rep minilisp live run was not executed (user requested refactor only).
- Live minilisp regression (tc/edit-dsl, 5 reps) exposed a protocol bug: selected-range reads were folded too, so the marker's 'read ... within' expansion returned the same six lines. Fixed: renderReadFeedback folds only whole-file reads; an explicit 'read within' now returns the selected lines unfolded. Docs/tests/prompts updated. Full suite: 1245 pass. Benchmark before fix: 3/5 pass (2 token-budget). After fix: 4/5 pass, 1 token-budget (rep2 still loops on a hard pair/car-cdr repair). Criterion 4 (no token-budget termination) not met yet; issue stays in review.
- Follow-up analysis of the v2 rep2 failure: 19 model calls against a ~19-call budget; 6 of 12 edit payloads rejected (3 pure syntax), and a `read` range failure discarded a valid edit in the same reply. Two harness fixes landed: (1) `read` failures are now a non-fatal `readFailures` channel rendered as feedback, so they never discard the reply's writes; (2) syntax rejections now carry line/column plus a short excerpt, and a fence body may contain a delimiter run shorter than the opener (e.g. `---`). `just typecheck && bun test` -> 1252 pass. Criterion 4 still needs a fresh 5-rep run; issue remains in review.
- Offline verification 2026-10-24: just typecheck clean; just test -> 1252 pass, 0 fail. Only criterion 4 (fresh 5-rep minilisp live run after the read-failure/syntax-diagnostic fixes) remains; user chose to defer the live run, so the issue stays in review pending sign-off.
- Live run 2026-10-24 (benchmark/results/2026-10-24-fold-prompt-v3.json): minilisp tc edit-dsl 5 reps against the official DeepSeek endpoint with --model deepseek-flash (gateway id deepseek-v4.1-flash does not exist on api.deepseek.com), 2/5 pass. rep1 token-budget 125,096/28 steps (6 protocol rejections), rep2 token-budget 122,031/23 steps (4 no-ops), rep4 token-budget 122,064/26 steps (10 protocol rejections); rep3 31,398/9 and rep5 27,113/8 pass. Criterion 4 NOT met. The fold loop itself is gone: failing reps used 7-10 selected-range viewers (read...within) and only 1-2 whole-file views, so the new storm is repeated 'expected end to terminate the clause' syntax rejections (6 in rep1, 10 in rep4), often on a replacement body containing a template literal with a backtick. Diagnostic excerpts point into the second reply line at the body text. Needs a replay-captured raw reply to pin the parser/format mismatch; this is a distinct finding from the fold-read storm. Endpoint/model changed vs the 2026-10-23 v2 baseline, so the pass-rate drop is not a clean prompt comparison.
- Wontfix (2026-10-25): stale: folded-view prompt issue; the fold loop was replaced by the edit-action protocol rework and no longer blocks the current queue
