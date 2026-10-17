---
id: 32
title: "Locator robustness: tolerant extraction, kind fallback, append guard"
status: todo
priority: high
milestone: null
parent: 28
deps: [29]
labels: [harness]
created: 2026-10-17
---

## Context

R7: the selection phase is brittle. `parseLocatorResponse` (src/loop.ts:231)
only strips fences then JSON.parses, so prose around the object breaks
selection; a kind mismatch (name exists as another kind) falls through to
append and can duplicate an existing symbol; diagnostics rarely say what the
actual kind/path was. D4 (`response_format` JSON mode) was declined by the
user; this issue is pure harness-side robustness.

## Goal

Selection tolerates malformed-but-recoverable responses and never appends a
duplicate symbol, with diagnostics that name the actual symbol when it exists
under another kind.

## Acceptance criteria

- [ ] Tolerant extraction: the locator JSON is extracted from responses with
      fences, prose before/after, or a nested object (first balanced `{...}`
      containing path/name/kind); a clear `invalid locator` diagnostic is
      still produced when nothing usable exists. Shared extractor with #31.
- [ ] Kind fallback diagnostics: when (path, name, kind) misses but the name
      exists in that file under another kind (or elsewhere with a matching
      name), the diagnostic names the actual kind/path instead of a bare
      "no symbol".
- [ ] Duplicate-append guard: append mode is refused (with a diagnostic)
      whenever the name already exists in the target file under any kind;
      appending can no longer create a duplicate declaration.
- [ ] Unit tests for extraction cases, kind fallback messages, and the append
      guard; gates green (`bunx tsc --noEmit` 0, `bun test`, `bun run accept`).

## Verification

```
bun test
```

plus a mocked-selection scenario where prose-wrapped JSON is accepted and a
kind-mismatch produces the improved diagnostic.

## Notes

- Depends on #29 for selection-failure recording.
- Non-goals: `response_format` JSON mode (declined), selection assist /
  candidate shortlists (H4 horizon), multi-locator selection.
