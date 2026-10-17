---
id: 31
title: "Anchor splice protocol: edits JSON with structural anchor matching"
status: todo
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
