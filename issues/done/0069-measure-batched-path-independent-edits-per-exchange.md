---
id: 69
title: "Measure batched path-independent edits per exchange"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [harness, benchmark]
created: 2026-10-19
---

## Context

mri-project measured that letting the model batch independent edits in one turn
cut `ast-edit` tokens ≈19% (337k → 272k over 21 tasks; commands/turn 1.07 →
1.67) — directional, n = 2, and its `multi`-cell saving is explicitly "not
robust" (`mri-project/docs/spec/findings.md` §"Batched edits cut `ast-edit`
cost"). tc removed the old `edits[]` batch and sends exactly one payload per
exchange; its minilisp storms are retry-dominated at ~125k tokens. Batching is
a hypothesis to measure, not a target to assume.

Source survey: `/home/illu/repo/mri` absorption study (2026-10-19), insight 5.

## Goal

Records expose per-turn tool/command counts, and an opt-in variant allows
multiple path-independent payloads per exchange, measured on USD per success
and on storm spend.

## Acceptance criteria

- [ ] Benchmark records carry commands/tool-calls per turn, and per-run
      diagnostics expose rejected-vs-applied exchange counts.
- [ ] An opt-in multi-payload-per-exchange variant (flag, default off):
      path-independent payloads only, per-payload pin echo and gate semantics
      defined, no unified diffs, guards unchanged.
- [ ] Measured against the current `consumption.md` row: USD per success not
      worse and minilisp storm spend down — or the hypothesis is recorded as
      rejected with the numbers.
- [ ] Tests and gates green.

## Verification

`bun run benchmark/run.ts --all --side tc --reps 3 --json
benchmark/results/<date>-tc-batch.json` with the flag on vs off, priced per
window; both rows noted in `consumption.md`.

## Notes

- Source: mri-project `docs/spec/findings.md`; `eval/arms/ast-edit.json` prompt
  wording.
- Open design question: how N payloads echo their pins under the composite
  address, and whether the syntax gate applies per payload or per exchange.
- Non-goals: weakening matcher/echo guards; trading success for tokens.
- Priority defaulted to medium; no milestone.
- User directive (2026-10-19): multi-edit is needed — let the model change
  multiple places in one exchange; this issue is the vehicle (opt-in flag +
  measured before/after stays). Fronted in the picking order; starts after
  #71's live evidence.
- Consult (2026-10-19): sequence — this issue lands first and #72 follows; the
  first cut keeps path-independent payloads only (distinct declaration paths).
  #72's design must reserve an interface for same-symbol multi-range batching
  (extension filed separately when needed).

### Implementation (2026-10-19)

- **Records (criterion 1).** `LoopRecord` rows carry `payloads` (1 classic,
  N batch, 0 none) and `toolCalls` (provider tool calls in the reply); both
  additive/defaulted so every existing row literal stays valid. `exchangeStats`
  folds a run's exchange rows into `{turns, payloads, toolCalls, applied,
  rejected, selected, stopped}`; the benchmark record exposes it as
  `runs[].exchangeStats` and each `runs[].records[]` entry now carries
  `payloads`/`toolCalls`. The tc side log prints an `exchangeStats:` line, and
  the report header prints `- multi-payload: off (default)`.
- **Opt-in variant (criterion 2).** Flag `--multi-payload` (camelCase
  `--multiPayload` alias) end-to-end: `src/cli.ts` → `main.ts` →
  `LoopOptions.multiPayload` → `buildSystemPrompt(true)` and the retry/continuation
  prompts; the benchmark runner forwards its own `--multi-payload` to the tc side.
  Reply shape `{"payloads":[{…},…]}`, one payload per **file** (path-independent);
  the first carries the pin (or verification-repair re-pin), each further entry
  names its own uniquely-resolving declaration. Each entry runs the full
  per-payload chain (echo/address, splice, syntax gate, duplicate-name guard,
  `oxfmt` no-op check) against its own file; the exchange is **atomic** — any
  failing entry rejects the whole exchange (nothing written) with `stage: multi`
  naming every failing entry. New typed causes `multi-protocol` and
  `multi-duplicate`; `create`/`delete` never batch. No unified diffs; matcher,
  echo, address, no-op, repeat, duplicate, budget, and stage guards are unchanged.
- **Design decision (the open question).** Pin echo is **per payload** (each
  entry echoes its own address; only the first is pinned, the rest resolve
  strictly in their own file), and gates are **per payload** but the exchange
  rejects **atomically** (all-or-nothing apply). Rationale: it keeps the
  single-payload path byte-identical when the flag is off and makes the batch a
  strict superset of one edit, with no partial writes to roll back.
- **Flag off.** A `{"payloads": …}` reply is parsed as a classic payload and
  fails `stage: protocol`; behavior is byte-identical to today (test asserted).
- **Tests.** `parseEditResponseList` unit tests (flat vs batch, duplicate file,
  empty/non-array/extra-key, non-JSON), `exchangeStats` fold tests, and five
  `runLoop` integration tests (atomic apply + one verification, atomic reject
  with per-payload causes, duplicate-file reject, flag-off unchanged,
  prompt-gated batch shape).
- **Gates.** `bunx tsc --noEmit` 0 errors; `bun test` 681 pass / 0 fail (was
  670); `bun run accept` 5/5; `bun benchmark/check.ts` 3 PASS.
- **Still open (criterion 3).** The live measurement — `benchmark/run.ts --all
  --side tc --reps 3 --multi-payload` on vs off on the same frozen text,
  priced per window, with both rows in `consumption.md` — has not run yet:
  it waits on the freeze discipline (fresh gates, then the matrices).

### Measurement (2026-10-19, both flag states; recorded 2026-10-20)

Two matrices on the same frozen code, `--side tc --reps 3`, priced per run window:
`benchmark/results/2026-10-19-tc-batch-off.json` and
`benchmark/results/2026-10-19-tc-batch-on.json`; two rows added to
`benchmark/results/consumption.md`.

- **off (default):** json $0.00115 (3/3), sexp $0.00041 (3/3), minilisp
  $0.00679 (3/3), overall $0.00279 (9/9) — clean, no storm (minilisp 29,415 /
  48,101 / 42,431 tokens). The series-best overall and under the oc pressure
  baseline ($0.00444).
- **on (`--multi-payload`):** json $0.00116 (3/3), sexp $0.00042 (3/3), minilisp
  **n/a (0/3)**, overall $0.01850 (6/9). Every minilisp rep burned to the bare
  token budget (~125k; `exchangeStats` 30 turns, 29 payloads, 0 applied / 29
  rejected, all `stage: gate`).
- **Verdict (criterion 3): hypothesis rejected.** USD per success is worse on
  minilisp and overall. Replay inspection shows the model never emitted a
  `{"payloads": …}` batch in any run — it kept returning flat payloads — so the
  atomic batch-apply path was not exercised live; the regression is the added
  multi-payload system paragraph pushing minilisp into a parse-gate storm, not
  batch application. The variant stays opt-in and off by default.
- **Criterion 1** is satisfied by the records: every row carries
  `payloads`/`toolCalls`, and `runs[].exchangeStats` exposes applied-vs-rejected
  exchange counts (visible in both matrices). **Criterion 2** (the opt-in
  variant) is implemented with tests. **Criterion 4** gates re-run at close.
- Replays: `tmp/replays-69-tc-batch-off/`, `tmp/replays-69-tc-batch-on/`.
