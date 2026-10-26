---
id: 45
title: "Make plan-exec matcher failures recover in one bounded correction"
status: done
priority: medium
milestone: null
parent: 44
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-26
---

## Context

Plan-exec still spends many exchanges on matcher construction. The latest
mini-spreadsheet pilot contains repeated `stage: matcher` failures such as
`the matcher could not be parsed as TypeScript` and `EDIT_MATCHER_MISSING`.
The strict parser is intentional: `match (` and unquoted code are not accepted.
The added format help was shown but the run still repeated malformed matcher
replies and exhausted its budget.

This is a recovery problem, not a request to accept ambiguous snippets. Whole-
file writes remain allowed.

## Goal

Make a malformed matcher recover in one bounded correction, with an explicit
whole-declaration fallback, instead of repeatedly regenerating a large edit.

## Acceptance criteria

- [ ] A malformed matcher (`EDIT_MATCHER_MISSING` or matcher-unparseable)
      produces one dedicated format correction; the next reply must provide a
      backtick snippet, `/regex/`, or omit `match` for a whole-declaration
      replacement.
- [ ] The parser stays strict for `match (` and partial snippets; no ambiguous
      auto-parsing is introduced.
- [ ] A deterministic task-loop test covers a malformed matcher followed by a
      valid whole-declaration replacement without an extra large write and
      finishes successfully.
- [ ] Prompt/docs state that a snippet must be a complete statement/expression
      or contiguous statement run, not an unbalanced partial function body.
- [ ] The recovery is bounded and does not bypass the normal exchange/task caps.
- [ ] `just typecheck && just test` passes.

## Verification

```sh
bun test src/task-loop.test.ts -t "matcher"
bun test src/prompts/task.test.ts
just typecheck && just test
```

## Notes

Do not solve this by silently treating `match (` as a snippet or by disabling
matcher validation. The issue is to make the correction path deterministic and
cheap.
- Resolved 2026-10-26: malformed matchers (EDIT_MATCHER_MISSING or an unparseable snippet) now get one dedicated correction, then a bounded fallback that requires omitting match/pick and replacing the whole declaration; the generic matcher help still covers not-found/ambiguous/invalid-regex failures. The parser stayed strict, the system prompt and docs state the snippet-completeness rule, and the fallback stays inside MAX_TASK_EXCHANGES. Verified: matcher-scoped task-loop tests (4 pass), prompts/task tests (25 pass), just typecheck && just test (1495 pass).
