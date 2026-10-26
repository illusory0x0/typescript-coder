---
id: 46
title: "Make large-edit tsc advisories actionable in plan-exec"
status: done
priority: medium
milestone: null
parent: 44
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-26
---

## Context

The latest mini-spreadsheet pilot still applies large edits that remove a
helper or leave call arity inconsistent. The final tsc errors were:

```text
src/workbook.ts(574,17): error TS2554: Expected 3 arguments, but got 2.
src/workbook.ts(741,8): error TS2304: Cannot find name 'isValidAddress'.
```

The declaration shape guard rejects an invalid whole-declaration replace, and
the advisory tsc path runs after a large edit when another edit remains. That
did not prevent the next large edit from continuing the damaged state, and the
run hit the token budget before the final tsc gate could be repaired.

The final Task gate must stay hard; intermediate type errors must remain legal
for multi-edit Tasks.

## Goal

Make large-edit tsc advisories actionable before another large edit can consume
the remaining budget, while preserving the non-blocking intermediate-type-error
contract.

## Acceptance criteria

- [ ] A deterministic task-loop test reproduces a large write or
      whole-declaration modify that leaves a missing helper or call-arity error.
- [ ] The next executor prompt receives the advisory tsc diagnostics with
      file/line and a clear "not a gate failure" label.
- [ ] A follow-up large edit is not applied blindly while the prior advisory is
      unresolved; the implementation either forces a targeted repair or makes
      the advisory constraint explicit in the next edit instruction.
- [ ] The final Task gate remains the hard success boundary; advisory failures
      do not mark an edit failed or roll back intermediate work.
- [ ] Tests cover both: an advisory that is followed by a successful repair,
      and one that reaches the final gate.
- [ ] `just typecheck && just test` passes.

## Verification

```sh
bun test src/task-loop.test.ts -t "advisory|large edit|declaration"
just typecheck && just test
```

## Notes

This is not a request to run tsc after every small `match`/`pick` edit. The
existing scope is whole-file write and whole-declaration modify, with a later
edit in the same Task. The exact "force a targeted repair" policy is to be
settled during implementation if the test shows the advisory alone is ignored.
- Resolved 2026-10-26: the next edit prompt after a large-edit tsc failure now carries a dedicated "# Post-edit type diagnostics" block with the raw file/line diagnostics, an explicit not-a-gate-failure label, and a repair-first constraint (targeted match/pick, create for a missing declaration, or a genuine whole-declaration/file repair). The advisory stays non-blocking and never rolls back the applied edit; the final Task gate remains hard. Tests cover a missing-helper whole-declaration repair that succeeds and an arity error that reaches the final gate. Verified: task-loop advisory/declaration tests (9 pass), prompts tests (26 pass), just typecheck && just test (1497 pass).
