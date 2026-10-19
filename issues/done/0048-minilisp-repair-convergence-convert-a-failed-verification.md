---
id: 48
title: "Minilisp repair convergence: convert a failed verification"
status: done
priority: high
milestone: null
parent: 46
deps: []
labels: [harness, agent-loop]
created: 2026-10-18
---

## Context

#44's canonical run and the effort sweep both show the repair path never
converting a verification failure on minilisp: across none/low/high efforts, zero
repair exchanges recovered (the first content exchange applies, verification
fails, repair exchanges die at matcher/format stages); at max the model rewrites
whole files and aborts on tsc errors / the 120k token budget (147,393 and 134,520
tokens at 805.8 s and 683.4 s). Every minilisp success so far passed verification
on the first content exchange.

Evidence: `benchmark/results/2026-10-18-ts.json` (0/3), same-policy sweep run
`benchmark/results/2026-10-18-ts-effort-none.json` (1/3), replay bundles for the
canonical failures archived under `tmp/replays-44-final2/`.

## Goal

The loop converts a failed verification into a passing one: live minilisp ≥2/3
without regressing json (3/3, ≤6,900) or sexp (3/3).

## Acceptance criteria

- [ ] The canonical three failures' repair rounds are diagnosed from their replay
      bundles, with the dominant failure mode(s) written into this issue's Notes.
- [ ] A loop/prompt/context change lands with tests, including a test where a
      verification failure is recovered on a later exchange.
- [ ] A live ts-side run shows minilisp ≥2/3, json 3/3 ≤6,900, sexp 3/3; the
      numbers are recorded (report/consumption row or #46 evidence).

## Verification

```
bun test
bun benchmark/check.ts
bun run benchmark/run.ts --all --side ts --reps 3 --json benchmark/results/<date>-ts.json
```

plus: replay commands over the recorded bundles before/after.

## Notes

- The budget guard (120k cap) stays; a fix that only raises budgets is not a fix.
- No unified-diff mixing/bypass; editor-side changes belong to #50 but must keep
  the structured protocol.
- Sweep evidence: none/low/high = 0 repair conversions; max = 3/3 minilisp but at
  83,899 minilisp tokens per success and json 24,738 — blows the json budget.
- Diagnosis (2026-10-18, from `tmp/replays-44-final2/minilisp-ts-rep{1,2,3}.json`
  - `failures/2026-10-18T07-57-*.md`): all three runs share one shape — the round-1
    create writes a multi-declaration file, verification fails (tsc type-model
    errors: `LispValue` lacks `string`; `Closure`/`Expr`/`LispValue` mismatches;
    rep2 also misses builtin dispatch), then the repair round (fresh ≤3 exchanges)
    burns all three exchanges on _mechanical_ rejections with zero applied edits:
  1. The model tries to fix a declaration outside the pinned symbol (the
     `LispValue` alias / the `Closure` type) with a matcher — `findAnchor` only
     searches inside the pinned `run` node → `stage: matcher` not-found. Repairs
     are confined to the pinned symbol, but the defects live in several top-level
     declarations, so the pin structurally prevents the needed fix.
  2. The pinned-selection JSON keeps `"mode":"create"` after the create→repair
     switch flips the loop to modify (only `pinned.mode` is updated;
     `pinnedAddressJson` is not), so the model keeps emitting create-style
     payloads (complete declaration re-adding `export`) → the splice duplicates
     the modifier → `stage: format: oxfmt failed: 'export' modifier already seen`.
  3. A soft edit failure overwrites `lastDiagnostics`, so the next retry prompt
     shows only the gate failure and loses the opening tsc/test root causes; the
     model flails on matcher mechanics instead of the type model.
- Fix direction (this issue): allow a verification-repair exchange to re-pin to
  another declaration in the same file (strict resolution against the current
  source, pin moves); repair the stale mode label; keep the opening verification
  diagnostics alongside the latest failure in retry prompts; teach the re-pin
  rule in the prompts. Editor-side tolerance stays in #50.
- Live round 1 (2026-10-18, `benchmark/results/2026-10-18-ts-repin.json` / `.md`;
  replays `tmp/replays-48-repin/`; failure artifacts
  `failures/2026-10-18T09-33-{07,10}*.md`): **7/9 — json 3/3 (4,430), sexp 3/3
  (2,807), minilisp 1/3** (rep1 pass at 22,941 tokens / 9 steps; rep2/rep3
  edit-exhausted at 25,143 / 20,454). Criterion ≥2/3 not met yet.
- What worked: rep1 proves the re-pin path end-to-end — create fails verification
  → repair exchange 1 sends a matcher for the top-level `makeLambda` under the
  `run` address (`stage: matcher`) → exchange 2 re-pins to `makeLambda` and
  applies → the next iteration repairs `makeLambda` again → passes. Symbol-scoped
  repair across fresh iterations converges when the model re-pins.
- What still blocks: rep2/rep3 never re-pinned and burned the 3-exchange budget on
  two mechanics: (1) matchers copied with the leading `export` (`export function
  run...`, `export type LispValue...`) are never found inside the node — indexed
  ranges exclude modifiers (rep2 exchanges 1/3, rep3 exchange 3); (2) whole-symbol
  rewrites that re-add `export` splice a duplicate modifier → `stage: format:
  'export' modifier already seen` (rep2/rep3 exchange 2). rep3 exchange 1 patched
  the `LispValue` alias while echoing `run` — the diagnostics pointed at the
  alias, but the echo habit won.
- Round-2 fix set (supersedes "stays in #50" for the modifier case — the evidence
  promoted it to a #48 blocker; #50 keeps the broader taxonomy/ergonomics):
  (a) tolerate a leading `export`/`export default` in matchers and whole-symbol
  replacements when the declaration already carries that modifier (shared
  splice path);
  (b) on matcher not-found, search the file's other declarations and, on a unique
  match, name it in the diagnostic together with its re-pin address;
  (c) reword the retry/system prompts with an explicit per-round `repin` flag:
  echo the pin, unless this round repairs a failed verification — then return
  the address of the declaration being fixed (a re-pin must resolve uniquely);
  (d) unit tests for (a)–(c).
- Round-3 fix set landed (2026-10-18; 567 tests): resubmission guard `stage:
  repeat` (a modify payload byte-identical to the previous modify submission is
  rejected before any splice; wording distinguishes already-applied vs
  just-rejected), duplicate guard `stage: duplicate` (a candidate raising the
  top-level count of a bodyful function / class / type alias is discarded, naming
  the existing declaration), unparseable-matcher diagnostics offer the
  whole-symbol rewrite, and a retry whose rejection is byte-identical to the
  previous one gains the "failed identically" note.
- Live round 3 (2026-10-18, `benchmark/results/2026-10-18-ts-repin3.json`;
  replays `tmp/replays-48-repin3/`): **9/9 — json 3/3 (4,492), sexp 3/3 (2,819),
  minilisp 3/3 (24,793)** per-success means; overall 10,701 (9/9).
  - minilisp rep2 converged in one repair exchange (create → verification fails →
    re-pin to `Closure`/type → passes; 8,283 tokens / 5 steps).
  - minilisp rep3 exercised the guards end-to-end: five applied `run` rewrites
    kept failing verification; the sixth identical payload was rejected as
    `stage: repeat` ("already applied … resending it cannot change the outcome"),
    the model pivoted by re-pinning to the `LispValue` and `Env` type aliases and
    passed (34,963 tokens / 16 steps). The round-2 self-amplifying resubmission no
    longer re-applies.
  - minilisp rep1 chained re-pins (`makeGlobalEnv` → `evalExpr` → `Closure`)
    across fresh rounds, one rejection in between (31,134 tokens / 13 steps); no
    duplicate rejection fired in this matrix, and json/sexp stayed at 3/3
    (~4.5k / ~2.8k) — no regressions from the guards.
- Acceptance: (1) diagnoses in Notes ✓ (rounds 1-3); (2) change + tests incl.
  recovery-on-a-later-exchange ✓ (round-1 suite extended in rounds 2/2.1/3; 567
  tests); (3) live run minilisp 3/3, json 4,492 ≤6,900, sexp 3/3 ✓; numbers
  recorded here + `benchmark/results/consumption.md` row ✓.
