---
id: 2
title: "Parse and serialize the resolve header and six-tick fences"
status: todo
priority: medium
milestone: null
parent: 1
deps: []
labels: [agent-loop]
created: 2026-10-21
---

## Context

`human/edit.md` specifies the header `select symbol in path [resolve kind]`,
where `kind` is `value`, `type`, or `namespace`, and a replacement fence of
**6+** backticks whose body cannot contain ``` and whose opening and closing
runs match (`human/edit.md:11`, `:38-48`).

The shipped reader in `src/selection.ts` expects `select [declKind] <symbol> in
<path>` (`parseEditor`, ~:164-227) and accepts 3+ backtick fences whose body
longest run is shorter than the opening (`parseFence`, ~:368-419);
`renderFence` emits `max(3, longest + 1)` (`~:496`). Nothing downstream can
use the new form until the single grammar reader accepts it.

## Goal

`parseSelection` and `serializeSelection` accept and emit the `human/edit.md`
header and fence forms, while retaining the shipped declaration-kind prefix as
a compatible superset.

## Acceptance criteria

- [ ] `select answer in main.ts resolve value end` parses to a selection with
      `space: "value"` and no declaration kind.
- [ ] `resolve` admits only `value`, `type`, `namespace`; any other token is a
      `stage: syntax` error that names the token and the admitted set.
- [ ] A clause without `resolve` keeps `space: null` and serializes without a
      `resolve` clause.
- [ ] The legacy `select <declKind> <symbol> in <path>` form still parses and
      serializes.
- [ ] A fence opens with at least 6 backticks on its own line, closes with a
      run of exactly the same length, and its body contains no run of 3+
      backticks; each violation is a `stage: syntax` error naming the fence.
- [ ] `serializeSelection` emits `resolve <space>` after the path and a 6+
      backtick fence; `parseSelection(serializeSelection(s))` round-trips a
      selection with a space, matcher, pick, and replacement.
- [ ] `src/selection.test.ts` covers every accepted form and every rejection
      above.

## Verification

```
bun test src/selection.test.ts
bunx tsc --noEmit
```

## Notes

- Add `space: SymbolSpace | null` to `Selection` in `src/selection.ts` and
  import the `SymbolSpace` type from `src/utility.ts`. Do not add a field to
  `Locator`; the JSON payload has no space key.
- `toEditPayload` returns `null` when `space !== null`, like a regex matcher or
  a viewer, because the JSON payload cannot carry the disambiguator.
- Keep `END_OF_LINE_COLUMN` and every existing range form unchanged; the
  human range selecters are already a subset of the shipped grammar.
- Update in-repo 3-tick compact fixtures (including `src/compact.test.ts`,
  `src/cascade.test.ts`, and the compact blocks in `src/loop.test.ts`) to the
  6-tick form so `just test` stays green.
- No prompt changes here; the model-facing examples are the last child.
- Serializer edge case: a replacement body containing a run of 3+ backticks cannot be represented in the human fence. `serializeSelection` should throw a clear error naming the body instead of emitting an unparseable fence.
