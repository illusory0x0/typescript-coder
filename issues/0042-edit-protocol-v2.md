---
id: 42
title: "Edit protocol v2: composite locator × matcher, modes, syntax gate"
status: todo
priority: high
milestone: null
parent: 28
deps: []
labels: [harness]
created: 2026-10-18
---

## Context

The v2 loop redesign (settled 2026-10-18; terms in `docs/glossary.md`) merges
the locator (`{path, name, kind}`, spec §4) and the anchor protocol (#31
`edits[]`) into one composite address `path × symbol × kind × matcher`, with a
single flat payload per edit and a mandatory syntax gate. Current code still
runs the old shape: `parseLocatorResponse` / `validateLocator` and
`parseEditsResponse` in `src/loop.ts`, structural anchor matching in
`src/anchor.ts` (#31), plus the separate whole-symbol `applyEdits` in
`src/editor.ts` — two LLM-facing protocols that must collapse into one. This
issue absorbs #32 (tolerant extraction, kind diagnostics, duplicate-name
guard).

## Goal

One edit action: address `{path, symbol, kind}` (strict-AND, exact) plus an
optional `matcher` (range inside the resolved symbol) and `replacement`;
resolve → splice → syntax gate. Every failure produces diagnostics the LLM can
actually fix by correcting its parameters — suggest-only, no silent
first-match picks, kind coercion, or auto-append fallbacks, and never a disk
write on failure.

## Acceptance criteria

- [ ] Wire format: one flat object
      `{"path","symbol","kind","matcher","replacement"}` per response; exactly
      one matcher; an omitted `matcher` means a whole-symbol rewrite. The
      `edits[]` batch (#33) is removed. `symbol` is the renamed `name` field;
      `matcher` is the anchor's successor (structural matching reused from
      `src/anchor.ts`). Extraction is tolerant: first balanced `{...}` object,
      fences/prose tolerated.
- [ ] Strict-AND resolution: path, symbol and kind must all match the index;
      `kind` is required; more than one candidate for the same
      (path, symbol, kind) is an ambiguity error that lists the candidates —
      never a silent `[0]` pick.
- [ ] Matcher failures are soft: not-found / ambiguous / unparseable produce
      actionable diagnostics (line/column positions, uniqueness hint,
      extend-the-matcher wording).
- [ ] Echo check: the payload's `{path, symbol, kind}` must equal the pinned
      selection (#43); a mismatch is a soft failure; `mode` is not echoed.
- [ ] Modes drive guards: `modify` (default), `create`, `delete` are picked in
      the selection round (#43). `create` guard: the name must be absent in the
      target file under any kind and the path must be safe; a violation names
      the existing symbol and suggests `modify`. A failed create whose kept
      file parses opens repair (loop side, #43). `delete` carries no edit
      payload.
- [ ] Syntax gate (highest-priority invariant): `prev` parses ⇒ `after`
      parses. The gate parses the candidate content that would be written with
      the custom Parser; a failure discards the splice (nothing is written)
      and reports parser positions. A broken `prev` (the current source does
      not parse) implies external modification or a harness bug — terminate,
      never repair silently.
- [ ] Failure diagnostics name the actual observed parameters: an address miss
      reports the kind/path under which the name actually exists; ambiguity
      lists occurrences; matcher misses carry positions; gate failures map
      parser errors to the replacement. No heuristic rollback or coercion —
      suggest only.
- [ ] Prompts and `spec.md` §1/§4 (Locator → composite address, Edit,
      apply-edits, append/create) are updated to the v2 contract.
- [ ] Tests: resolution (hit / kind mismatch / ambiguity), matcher (not-found
      / ambiguous / whole-symbol), echo mismatch, create guard, gate discard,
      extraction tolerance; loop integration with a mock provider; offline
      replay evidence (#40); gates green.

## Verification

```
bun test
bunx tsc --noEmit
bun run accept
bun benchmark/replay.ts <bundle-with-v2-edit>
```

## Notes

- Supersedes #32 (kept as wontfix) and the protocols of #31/#33; the
  structural matcher machinery is reused, the `edits[]` batch is not.
- `src/editor.ts applyEdits` stays the internal tools path (`src/tools.ts`
  rename); share one splice primitive where practical — the loop must not
  keep a second LLM-facing protocol.
- Paired with #43 (soft-failure classes, pinning, repair transition); the
  protocol lands first (#43 depends on this issue).
- Non-goals: multiple matchers per response (serial Edit rounds instead),
  on-demand context fetching, `.tsx`.
