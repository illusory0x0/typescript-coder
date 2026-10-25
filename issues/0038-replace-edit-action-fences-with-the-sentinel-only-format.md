---
id: 38
title: "Replace edit-action fences with the sentinel-only format"
status: todo
priority: medium
milestone: null
parent: 37
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-25
---

## Context

Edit-action bodies currently use a fence of 5+ hyphens or 6+ backticks with a
matching close. The 3-rep plan-exec benchmark produced 12
`EDIT_UNCLOSED_FENCE` rejections in 12 runs; the close is easy to omit or
confuse with `done`. A body containing both backticks and hyphen runs cannot be
serialized by the current fallback.

The design decision is to keep one new fence format only:

```text
<<<TC_EDIT_BEGIN>>>
...
<<<TC_EDIT_END>>>
```

## Goal

Replace every edit-action fence with the sentinel-only format and remove legacy
hyphen/backtick fence parsing and serialization.

## Acceptance criteria

- [ ] `src/selection.ts` accepts `<<<TC_EDIT_BEGIN>>>` and
      `<<<TC_EDIT_END>>>` for `write` and `replace with`; both markers are
      whole lines and may carry leading/trailing whitespace.
- [ ] `src/plan-dsl.ts` accepts the same sentinel for `goal:` and
      `instruction:` blocks.
- [ ] The body is raw text; it may contain `-----`, six backticks, `done`, and
      `end` without escaping.
- [ ] An empty sentinel body still means delete for `replace with`.
- [ ] Legacy 5+ hyphen and 6+ backtick fences are rejected with a clear
      `EDIT_*` diagnostic and a hint to use the sentinel format.
- [ ] A body containing an exact `<<<TC_EDIT_END>>>` line is rejected with a
      clear diagnostic; there is no second escape format.
- [ ] Serializers emit only the sentinel format; remove legacy run-length
      selection and fallback logic.
- [ ] Whole-reply Markdown fence stripping remains unchanged; it wraps the
      reply and is not an edit-action fence.
- [ ] Unit and acceptance fixtures cover write, replace, goal, instruction,
      empty body, legacy rejection, embedded legacy fences, and missing close.

## Verification

- `bun test src/selection.test.ts src/plan-dsl.test.ts src/edit-dsl.test.ts`
- `bun test src/multi-editor.test.ts src/task-loop.test.ts src/loop.test.ts`
- `just typecheck && just test`
- `just accept`
- `rg -n '^-{5,}$|^`{6,}$' src acceptance` finds no current edit-fence examples

## Notes

- This is a breaking wire-format change; no dual-read fallback is retained.
- Historical benchmark reports and generated replay bundles are not migrated.
- The write `done` removal is a separate child issue.
