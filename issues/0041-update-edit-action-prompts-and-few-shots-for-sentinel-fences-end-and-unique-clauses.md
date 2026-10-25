---
id: 41
title: "Update edit-action prompts and few-shots for sentinel fences, end, and unique clauses"
status: todo
priority: medium
milestone: null
parent: 37
deps: [38, 39, 40]
labels: [agent-loop, edit-protocol]
created: 2026-10-25
---

## Context

Every model-facing edit-action example currently teaches 5+ hyphen or 6+
backtick fences, `write` examples still show `done`, and file commands use
`done` instead of the unified `end`. The prompt also contains a
viewer-then-editor example that edits the same declaration twice in one reply,
which the new unique-address rule forbids.

The affected surfaces are `src/prompts/edit-dsl.ts`, `src/prompts/task.ts`,
and the write example in `src/loop.ts`; tests pin these strings.

## Goal

Teach only the sentinel fence, the `end` terminator, the no-terminator write
form, and the distinct-declaration rule in all edit-action prompts and
few-shots.

## Acceptance criteria

- [ ] All prompt/few-shot edit bodies use
      `<<<TC_EDIT_BEGIN>>>` / `<<<TC_EDIT_END>>>`; no legacy fence examples.
- [ ] `create`, `delete`, and `read` examples end with `end`.
- [ ] `write` examples end at `<<<TC_EDIT_END>>>` and show no `done` or trailing
      `end`.
- [ ] The prompt states that every clause in a multi-clause reply must target a
      different resolved `(path, symbol, kind)`.
- [ ] The viewer-then-editor same-declaration example is removed or rewritten
      so the two clauses target different declarations.
- [ ] Prompt tests and string assertions are updated.
- [ ] A repository grep finds no current prompt/few-shot legacy fence or
      `done` terminator example.

## Verification

- `bun test src/prompts/task.test.ts src/loop.test.ts`
- `bun test src/task-loop.test.ts`
- `just typecheck && just test`
- `rg -n '^-{5,}$|^`{6,}$' src/prompts src/loop.ts` returns no edit-fence
  examples
- `rg -n '\bdone\b' src/prompts src/loop.ts` is reviewed for stale terminator
  examples

## Notes

- This issue changes model-facing text only; parser and resolver behavior are
  covered by the fence, terminator, and unique-address issues.
- Do not change the outer whole-reply Markdown-fence tolerance; it is separate
  from edit-action fences.
- Canonical examples always include 'end' after select/create/delete/read; do not teach the missing-end recovery. The parser tolerance in #39 is recovery-only.
