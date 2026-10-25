---
id: 39
title: "Retire done and use end for unfenced edit-action commands"
status: done
priority: medium
milestone: null
parent: 37
deps: [38]
labels: [agent-loop, edit-protocol]
created: 2026-10-25
---

## Context

`done` currently terminates `write`, `create`, `delete`, and `read`, while
`select` already ends with `end`. The extra terminator is inconsistent and has
caused `done`/fence-close confusion. Whole-file `write` has a sentinel close
that already terminates it. The design decision is to use one visible clause
terminator, `end`, and let a fenced `write` end at
`<<<TC_EDIT_END>>>`.

## Goal

Remove `done` from the edit-action protocol: `create`, `delete`, and `read` end
with `end`; `write` ends with the sentinel close and has no trailing terminator.

## Acceptance criteria

- [ ] The canonical forms are:

      ```text
      create <path> end
      delete <path> end
      read <path> [within <selecters>] end
      write <path> [within <selecters>] with
      <<<TC_EDIT_BEGIN>>>
      <raw body>
      <<<TC_EDIT_END>>>
      ```

- [ ] `select ... end` remains unchanged.
- [ ] `replace with` uses the sentinel close, then the clause's `end`.
- [ ] `write` does not require or accept a trailing `done` or `end`; the
      sentinel close terminates the statement.
- [ ] A stray `done` or trailing `end` after a write close is rejected with a
      targeted syntax diagnostic and a hint to remove it.
- [ ] `done` is removed from the parser and serializer grammar, help text,
      error hints, tests, and acceptance fixtures.
- [ ] Parser/serializer tests cover `create`/`delete`/`read` with `end`,
      `write` without `done`, a missing close, and a stray `done`.

## Verification

- `bun test src/selection.test.ts src/multi-editor.test.ts`
- `bun test src/task-loop.test.ts src/loop.test.ts`
- `just typecheck && just test`
- `just accept`
- `rg -n '\bdone\b' src acceptance` finds no edit-action terminator uses
  (word matches in prose/tests are reviewed manually)

## Notes

- This retires `done` completely; do not leave a compatibility alias.
- Prompt and few-shot changes are handled by the prompt migration child, but
  this issue's acceptance requires the parser/serializer behavior to be final.
- Additional acceptance: reuse the existing tolerant select-clause recovery for create/delete/read. If 'end' is missing but the next statement starts (select/create/delete/read/write) or the reply ends, accept it with EDIT_MISSING_END and a warning. Missing 'end' before arbitrary text remains a hard syntax error. Prompt/few-shot examples still always include 'end' (#41).
- Resolved done retirement. Verified: create/delete/read now use end and recover a missing end at EOF/next statement with EDIT_MISSING_END; write ends at the sentinel close with targeted EDIT_RETIRED_DONE / EDIT_STRAY_END for trailing done/end. Serializer emits end for file commands and no trailing write terminator. just typecheck && just test -> 1451 pass, 0 fail; just accept -> 9 pass, 0 fail; git diff --check clean. No live benchmark run.
