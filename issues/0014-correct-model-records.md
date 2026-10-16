---
id: 14
title: Correct model records in spec and closed issues
status: todo
priority: medium
milestone: null
parent: 11
deps: [13]
labels: [docs]
created: 2026-10-17
---

## Context

The spec and issue notes record provider models as `deepseek` and `qwen`, which
do not exist on the configured gateway (`deepseek` → 403; `qwen` has no chat
model, only `qwen3-embedding-8b`). The real, key-permitted chat ids verified by
smoke and by #13 are needed in the records so future runs and readers are not
misled.

## Goal

`spec.md` §8 and the relevant closed-issue notes state the real gateway model
ids and the live-run evidence.

## Acceptance criteria

- [ ] `spec.md` §8 `models` line lists `deepseek-v4.1-flash`,
      `deepseek-v4-pro-0813`, `glm-5.3`, `zoe/glm-5.3`, with a note that
      `qwen` has no chat model on this gateway (embedding only) and that the
      original `deepseek`/`qwen` shorthand was inaccurate. No other spec section
      is changed.
- [ ] `issues/done/0007-provider-openai.md` gets a dated correction note
      replacing/clarifying the "403 key permission" reading with the actual
      cause (unknown model ids) and the working ids.
- [ ] `issues/done/0001-typescript-coder-agent.md` gets a dated note recording
      the #13 live evidence summary (result, attempts, duration).
- [ ] Records are consistent with `acceptance/README.md`'s Live checks section
      (#12); docs-only change keeps `bunx tsc --noEmit` 0 and
      `bun run accept` 5/5.

## Verification

```
grep -n "deepseek-v4.1-flash" spec.md issues/done/0007-provider-openai.md issues/done/0001-typescript-coder-agent.md
bunx tsc --noEmit
bun run accept
```

## Notes

- Depends on #13 (the evidence summary comes from the live run).
- Appending corrected notes to closed issues is intentional and allowed;
  their Goal/Acceptance sections must not be altered.
- Do not edit `issues/todo.md` history or renumber anything.
