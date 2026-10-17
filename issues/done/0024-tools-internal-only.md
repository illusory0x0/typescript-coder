---
id: 24
title: "Spec: declare tools internal-only for v1 (remove loop tools plumbing)"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [spec, agent-loop]
created: 2026-10-17
---

## Context

`src/tools.ts:176-256` exports five `ToolDefinition`s (find-definition, scroll,
rename, check, test) with per-tool unit tests, and `LoopOptions.tools` is
forwarded to every provider call (`src/loop.ts:330,374,389,461`). But no
production path ever passes tools (`src/main.ts:30-36`,
`acceptance/run.ts:299-308`), and the loop has no tool-execution branch — a
non-locator tool call would be JSON-parsed as a locator
(`src/loop.ts:249-261`). Decision from the 2026-10-17 consult: v1 does not offer
tools to the model; they remain internal library APIs.

## Goal

Remove the illusion that the loop is tool-capable in v1: tighten the spec to
internal-only tools and drop the unused loop plumbing, with zero production
behavior change.

## Acceptance criteria

- [ ] `spec.md` §7 and §11 (M6) state that tools are internal library APIs in
      v1, with no agentic tool-execution loop; provider-level `tools`
      parameter support (spec §8) stays.
- [ ] `LoopOptions.tools` and its forwarding are removed from `src/loop.ts`;
      provider chat calls no longer accept a loop-level tools list; the
      locator-via-tool-call parsing (`locatorFromResponse`) and its test stay.
- [ ] `src/openai.ts` provider retains `tools` support and
      `src/openai.test.ts` is unchanged.
- [ ] No behavior change for production runs (same messages, no tools sent).
- [ ] `bunx tsc --noEmit` 0; `bun test` green; `bun run accept` 5/5.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
```

## Notes

- Priority `medium` (Eisenhower Q2: spec/implementation drift, no crash).
- An agentic tool-execution loop is explicitly a future feature; not filed
  here.
- `explain()` receives the tools list only because `runLoop` forwards it;
  update its signature accordingly.
- Validation (2026-10-17): the loop now calls
  `provider.chat(messages, undefined, ...)`; a new witness test asserts the
  provider's tools argument is `undefined` on every call ("sends no tools to
  the provider"); the locator tool-call parsing test is kept; `src/openai.ts`
  untouched. Supersedes the #23 tool-call echo edge: with no tools offered, a
  tool-call locator can no longer arise in loop runs.
