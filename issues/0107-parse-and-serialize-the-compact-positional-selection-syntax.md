---
id: 107
title: "Parse and serialize the compact positional selection syntax"
status: todo
priority: medium
milestone: null
parent: 105
deps: [106]
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

The model must emit the compact syntax (grammar in `docs/edit-protocol.md`), and
the prompts must render a selection in it; today the wire form is JSON
(`docs/spec.md:89-98`). A parser maps the clauses onto the existing payload model
(`{path,symbol,kind,matcher,range,replacement}`), and a serializer renders a
selection back into prompt text. Malformed lines need typed parse diagnostics
in the existing `stage:` style.

## Goal

A parser accepts the compact syntax and emits the payload-equivalent selection
(or a typed parse error naming the malformed stage), and a serializer renders a
selection in the syntax.

## Acceptance criteria

- [ ] `parseSelection(text)` accepts the `docs/edit-protocol.md` grammar
      (`select [kind] <symbol> in <path> [ match (<snippet> | /regex/) [ pick
      <multiRange> ] ] [ replace with <fence> ] end`, one or more clauses) and
      returns the payload-equivalent selection; it round-trips with the
      serializer.
- [ ] Malformed input fails with a typed cause (new `stage: syntax`) naming the
      offending field; no partial selection is ever produced.
- [ ] Escaping for a backtick in a `snippet` and a colon in a `path` is defined
      and tested.
- [ ] Unit tests cover each optional clause and each failure mode.
- [ ] `bunx tsc --noEmit` clean; the existing JSON path is untouched or
      explicitly bridged.

## Verification

```
bunx tsc --noEmit
bun test
```

## Notes

- Depends on the specification (`#106`) for the grammar and types; the grammar
  lives in `docs/edit-protocol.md`.
- Open question: whether the parser is the only accepted input or JSON remains
  accepted alongside it (settle with the specification).
