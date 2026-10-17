---
id: 21
title: "Loop: tolerate unparseable files instead of crashing"
status: done
priority: high
milestone: null
parent: null
deps: []
labels: [agent-loop]
created: 2026-10-17
---

## Context

`runLoop` builds the project index unguarded: `src/loop.ts:317-319`
(`discoverSourceFiles` → `buildContextYaml` → `buildIndex`); `buildIndex` parses
every discovered `.ts` file and throws on the first parse error
(`src/utility.ts:565-605`). One broken or unsupported file anywhere in the
project rejects the whole run, and `src/main.ts:69` does not catch it, so the
CLI dies with a stack trace — no selection attempt, no rollback, no
explanation. Audit 2026-10-17; pairs with #20 (which removes the common
triggers but not the failure mode).

## Goal

A file that fails to parse is skipped with a visible diagnostic instead of
aborting the run; the loop can still fix other files, and unparseable targets
fail cleanly.

## Acceptance criteria

- [ ] A project with one unparseable `.ts` file (e.g. `function broken( {`)
      plus a valid target still lets `runLoop` select/edit the valid target and
      succeed.
- [ ] Skipped files are reported: path + parse error appear in the prompt
      context (e.g. a `skipped:` section in the context YAML) and/or on
      `LoopResult`; new tests assert the report.
- [ ] Skipped files are not selectable as targets; a run whose intended target
      is unparseable fails cleanly with a diagnostic (no crash, no write).
- [ ] `runMain` on such a project does not throw an uncaught error.
- [ ] `bunx tsc --noEmit` 0; `bun test` green; `bun run accept` 5/5.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
```

plus a manual probe: temp project with `src/broken.ts` (syntax error) +
`src/ok.ts`; the loop fixes `ok` and the report names `broken`.

## Notes

- Priority `high` (Eisenhower Q1: urgent + important — fatal crash mode).
- Suggested shape: a tolerant variant that parses per file and records
  failures; keep strict `buildIndex` behavior available for callers/tests that
  want it.
- Related: #20 (parser coverage), #25 (provider error handling — same "no
  uncaught errors" theme, independent).
- Non-goals: partial-AST recovery from broken files.
