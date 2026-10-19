---
id: 53
title: "Edit protocol: try json_object mode; document json_schema upgrade path"
status: wontfix
priority: medium
milestone: null
parent: 46
deps: [52]
labels: [harness]
created: 2026-10-18
---

## Context

The v2 edit protocol carries the edit payload as JSON text in the message content:
the system prompt asks for one flat JSON object and the harness parses it with the
tolerant extractor (`extractJsonObject`, src/anchor.ts; `parseEditResponse`,
src/loop.ts). The chat request body (src/openai.ts) sets no `response_format`; #32
recorded that `response_format` JSON mode was declined when that issue was written,
and the v2 redesign (#42) chose tolerant extraction instead.

2026-10-18 fact check (sources in Notes): strict schema-constrained output
(`json_schema` + `strict: true`) is unavailable on our model family —
cross-provider surveys and DeepSeek's docs list `deepseek-v4-flash` / `v4-pro`
(and the rest of the DeepSeek line) as `json_object`-only; `json_schema` requests
are rejected with "This response_format type is unavailable now". The only API
lever today is `response_format: {"type": "json_object"}` on the structured calls.
Expected value is small — #48 live data shows the failure modes were matcher /
echo / repeat / address stage, not invalid JSON — so this is an experiment with a
recorded keep/revert decision rather than a promised optimization.

## Goal

Measure whether `response_format: {"type": "json_object"}` on selection and edit
calls reduces protocol-stage failures or tokens, keep/revert it by the numbers,
and document the `json_schema` upgrade path for when the provider supports strict
schema output.

## Acceptance criteria

- [ ] Optional per-call plumbing: loop/provider options thread a `json_object`
      mode to `OpenAIProvider.chat`; when enabled, selection and content
      exchanges send `response_format: {"type": "json_object"}`, while the
      summary call stays unset. Unit tests assert the wire body both ways.
- [ ] A per-run switch (CLI and/or benchmark flag, default off) enables it, so
      both arms are measurable without code edits.
- [ ] One live probe records the honghong endpoint's behavior (accepted and
      honored, or ignored/rejected). If the field is not honored, the experiment
      stops with that finding recorded.
- [ ] A/B live measurement on the tc side (`--all --side tc --reps 3` per arm,
      same day and effort): protocol-stage rejections and tokens-per-success
      compared against the most recent post-#52 tc matrix row; numbers recorded
      in Notes and a row in `benchmark/results/consumption.md`.
- [ ] Decision recorded in Notes: default off (no win or a regression) or
      default on (measured win), with the numbers that justify it.
- [ ] `json_schema` upgrade path documented (one paragraph): payload schema
      shapes for selection/edit, strict-mode constraints (all fields required,
      `additionalProperties: false`), and what changes in the provider/loop when
      it becomes available.
- [ ] Docs updated for whatever ships (`spec.md` clause; glossary only if
      vocabulary changes) and gates green: `bunx tsc --noEmit` 0, `bun test` all
      pass, `bun run accept` 5/5, `bun benchmark/check.ts` 3 PASS.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
bun benchmark/check.ts
# A/B (flag name decided at implementation; example)
bun run benchmark/run.ts --all --side tc --reps 3                       # arm A
bun run benchmark/run.ts --all --side tc --reps 3 --json-object-mode    # arm B
```

plus the live probe snippet (request + raw response excerpt) and the A/B report
paths.

## Notes

- Parent #46; deps #52 (the A/B baseline must be a post-continuation matrix).
- DeepSeek JSON-mode requirements: the word "json" must appear in the prompt
  (ours does), a format example helps (ours has one), and truncation risk is
  already covered by the loop's `truncated` stage.
- Sources (checked 2026-10-18): OpenAI structured-outputs docs + announcement
  (json_schema vs json_object); Requesty "Structured Outputs Across LLM
  Providers: 244 Models Tested" (DeepSeek json_object-only); TheRouter
  cross-provider guide; DeepSeek JSON Output docs; deepseek-ai/DeepSeek-V3
  issue #302 (`json_schema` unavailable).
- Non-goals: tool use (not proposed), provider switch, replacing the tolerant
  extractor (it stays as the fallback), YAML outputs (messages already carry the
  context as YAML — see the 2026-10-18 clarification).
- Closed as `wontfix` (user decision, 2026-10-19): the experiment's premise aged
  out — live protocol failures are matcher / echo / address classes (#48/#56/#59/#60
  own that space), not JSON parsing, and strict `json_schema` output is unavailable
  on the model family (recorded above). The tolerant extractor stays as the
  fallback; kept for the record, do not implement separately.
- Wontfix (2026-10-19): Premise aged out (failures are matcher/echo/address, not JSON parse; json_schema unavailable on the model family); dropped as low expected value (user decision 2026-10-19).
