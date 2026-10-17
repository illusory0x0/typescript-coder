---
id: 31
title: "Anchor splice protocol: edits JSON with structural anchor matching"
status: done
priority: high
milestone: null
parent: 28
deps: [30]
labels: [harness]
created: 2026-10-17
---

## Context

R1: the replace phase re-emits the whole symbol (src/loop.ts
`buildReplacementPrompt`), so output scales with the symbol, retries re-emit
everything, and failures are expensive. User-proposed design (2026-10-17):
under the top-level locator, the model sends a code snippet it wants to
change; the harness parses it and structurally finds it in the symbol. This
replaces the three-way protocol selection (text anchor vs diff vs op list).

## Goal

The replace phase accepts `{"edits":[{"anchor","replacement"}]}` where the
anchor is matched structurally inside the located symbol and only that range
is replaced, with the whole-symbol anchor as the natural full-replacement
fallback.

## Acceptance criteria

- [ ] Wire format: replace-phase responses are a JSON object with an `edits`
      array; exactly one edit is accepted for now (#33 lifts the cap);
      parsing is tolerant of markdown fences and surrounding prose; invalid
      shapes produce a bounded, actionable diagnostic (`edits-invalid`).
- [ ] Structural matching: the anchor is parsed as a TypeScript fragment
      (statement/member/expression wrapping as needed) and matched by AST
      structural equivalence (trivia/comments ignored, identifiers exact)
      against nodes inside the located symbol's range; exactly one match is
      required — zero matches yields `anchor-not-found`, several yield
      `anchor-ambiguous` (diagnostic asks to extend the anchor); all
      diagnostics keep the current source available for the next attempt.
- [ ] Apply: the matched range is spliced with the replacement text and the
      file is formatted (oxfmt) as today; an anchor equal to the whole symbol
      is equivalent to the current full replacement, preserving the fallback.
- [ ] Prompt updates: system/replacement prompts describe the anchor
      contract (smallest complete snippet covering the change; whole symbol
      allowed for rewrites; no fences/prose; single edit).
- [ ] Unit tests: matcher cases (exact nested node, whole symbol,
      whitespace/comment insensitivity, identifier mismatch, duplicate →
      ambiguous, no match, sub-expression fragment, unparseable fragment),
      parser tolerance, and a loop integration test with a mock provider
      emitting the new format; gates green.
- [ ] Evidence: at least one offline replay (#40) and the mid-series smoke run
      exercise the new protocol end to end.

## Verification

```
bun test
```

plus: with a recorded bundle, `bun benchmark/replay.ts <bundle>` shows the
edits protocol path executing offline.

## Notes

- Depends on #30 (fresh-reset retry context; retries re-emit only small
  corrections once anchors are in play).
- The tolerant JSON extractor introduced here should be shared with #32.
- Open item (resolve): fragment-wrapping heuristics and the exact
  normalization used for structural comparison.
- Non-goals: multi-edit (#33), on-demand context fetching, protocol
  negotiation/versioning.
- Validation (2026-10-18): implemented in `src/anchor.ts` (+30 unit tests).
  Protocol: `parseEditsResponse` accepts a single-edit object, tolerates
  fences/prose through the shared `extractJsonObject` (string-aware brace scan;
  #32 reuses it), rejects `edits.length !== 1` as `edits-invalid`. Matching:
  fallback fragment wrappers statement → class member → expression (first
  strategy with matches wins), candidates = every node inside the re-resolved
  symbol range in the current source, structural equality ignores
  `start`/`end`/`raw`/`source` so trivia/comments/quoting normalize while
  identifiers and literals compare exactly; 0 → `anchor-not-found`, >1 →
  `anchor-ambiguous` with extend-the-anchor diagnostics; unparseable →
  `edits-invalid`. Apply: `applyAnchorSplice` + oxfmt; a whole-symbol anchor
  reproduces the old full-replacement fallback. Loop: three new outcomes with
  `stage:` labels routed through the #30 retry machinery; empty output keeps
  `empty-output` + `stage: format`; append mode is unchanged; the retry prompt
  gained `mode` and asks for a single-edit JSON in replace mode; the recorded
  `replacement` is the edit's replacement text. Prompts: system + replacement
  prompts describe the contract with a concrete example
  (`{"edits":[{"anchor":"return 1;","replacement":"return 2;"}]}`).
- Test/doc migration: all replace-mode scripted responses across
  `src/loop.test.ts`, `src/cli.test.ts`, `src/replay-runner.test.ts`, and
  `acceptance/scenarios.ts` now use the edits protocol (anchors chosen against
  the current on-disk state so retries still splice); `benchmark/README.md`
  outcome list and `spec.md` (§1, Edit table, §6 pipeline) updated.
- Evidence: offline `tmp/replays-31/fix-answer-anchor.json` (scripted nested
  anchor → `replacement line 1: TS2322` → corrective anchor; replay
  `prompt mismatches: none`, exit 0) and live `bun run tmp/smoke-31.ts`
  (replace-mode fixture, real model: attempt 1 `format` — replacement re-added
  a modifier the anchor omitted ("'export' modifier already seen") — then
  retry spliced `return 1;` → `return 2;` and passed; 1,884 tokens total;
  replayed offline with `prompt mismatches: none`). Append-path smoke:
  sexp-parser ×1 PASS step 1, 4,835 tokens. Known edge: modifier
  inconsistencies between anchor and replacement fail formatting once and are
  recovered by the retry contract; benchmark tasks are append mode, so the KPI
  matrix does not exercise it.
- Validation gates: tsc 0, 514 → 550 tests, `accept` 5/5,
  `benchmark/check.ts` 3 PASS.
