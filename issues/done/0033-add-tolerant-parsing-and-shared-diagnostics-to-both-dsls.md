---
id: 33
title: "Add tolerant parsing and shared diagnostics to both DSLs"
status: done
priority: medium
milestone: null
parent: 26
deps: [29, 30]
labels: [agent-loop, edit-protocol]
created: 2026-10-25
---

## Context

Both DSLs currently reject on the first syntax error and the edit-action parser has recurring `match`/`end`/fence failures in plan-exec. The target in `docs/spec.md` §5.2-5.3 is a shared tolerant-parser discipline: recover structure for diagnosis, emit stable codes with line excerpts and hints, and never partially apply destructive results.

## Goal

Add tolerant parsing and a shared diagnostic renderer to the Plan DSL and edit-action DSL, with all-or-nothing application and complete per-record/per-clause issues.

## Acceptance criteria

- [ ] Shared `DslIssue` / `DslParseResult` types and one diagnostic renderer produce `stage`, stable `code`, `at line:column`, a short numbered excerpt with caret, `expected`, `found`, `hint`, and record/clause identity.
- [ ] Plan DSL tolerates a missing `end` at an unambiguous boundary, bare `NN-slug` ids, and a whole-reply markdown fence; unclosed fences/truncation reject; unknown fields/parents and duplicate ids get exact diagnostics.
- [ ] A dotted `create` reports `PLAN_CREATE_MEMBER`; a `finish` without a last `test` task reports the exact last task/verify.
- [ ] edit-action DSL recovers clause boundaries across fences, tolerates an unambiguous missing `end` with a warning, and gives dedicated codes for missing matcher, pick without replace, rename mixed with replace, unknown resolve space, unclosed fence, and target mismatch.
- [ ] All clauses/records are parsed before application. An invalid editor/write or patch rejects the whole reply; valid view-only clauses may still return feedback; warnings are logged, errors block.
- [ ] Diagnostics are bounded (default first 8 issues plus a count).
- [ ] Tests cover plan and action recovery, all-or-nothing behavior, codes, caret/excerpt output, and no partial writes.
- [ ] `just typecheck && just test` passes.
- [ ] No benchmark or live model run is required.

## Verification

- `bun test src/plan-dsl.test.ts src/edit-dsl.test.ts src/selection.test.ts src/task-loop.test.ts`
- `just typecheck && just test`
- Replay representative malformed plan/action strings and assert the rendered diagnostics and absence of writes.

## Notes

- Depends on #29 and #30.
- Related to #25's residual edit-dsl syntax rejection analysis, but not a duplicate: #25 is folded-source prompt acceptance, not the shared tolerant parser.
- Do not silently guess a different action, target, path, symbol, or parent.
- Resolved: shared DslIssue/DslParseResult + bounded renderer (stage, code, line/column, caret excerpt, expected/found/hint, record/clause, 8-issue cap); Plan/patch tolerate missing end at unambiguous boundaries, bare ids, and whole-reply fences with warnings; unclosed fences/truncation reject; coded unknown-field/parent/duplicate/create-member/finish diagnostics; edit DSL recovers clause boundaries across fences and missing end, adds dedicated matcher/pick/rename/space/fence/target codes; detailed parsers parse all clauses before application and invalid replies write nothing; warnings surface on LoopResult. Verification: just typecheck && just test -> 1425 pass, 0 fail (317.39s); just accept -> 8 passed.
