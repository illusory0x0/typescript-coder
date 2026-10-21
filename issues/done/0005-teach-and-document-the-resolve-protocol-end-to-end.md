---
id: 5
title: "Teach and document the resolve protocol end to end"
status: done
priority: medium
milestone: null
parent: 1
deps: [2, 3, 4]
labels: [agent-loop, docs]
created: 2026-10-21
---

## Context

The grammar, resolver, and viewer changes are invisible to the model and to
readers unless the model-facing prompts and the as-built docs change with them.
The compact system paragraph (`src/loop.ts:175-177`), the `compactInstruction()`
examples (`:300-430`), the create instruction, the protocol correction/escalation
text (`:193-196`), `docs/editing-protocol.md`, and `docs/agent-loop.md` all still
teach `select [kind]`, 3-tick fences, and the occurrence-list viewer. Prompt text
is benchmark-sensitive, so this issue owns the whole text surface and proves the
result with one offline end-to-end scenario.

## Goal

Every model-facing and human-facing description of the compact protocol matches
the implemented `resolve` header, creation defaults, 6-tick fence, and viewer
rendering, and an offline acceptance scenario proves the viewer → edit → verify
sequence.

## Acceptance criteria

- [ ] `buildSystemPrompt`'s compact paragraph, `compactInstruction()`,
      `compactCreateInstruction()`, `COMPACT_FORCE_DIAGNOSTICS`,
      `COMPACT_PROTOCOL_CORRECTION`, and `COMPACT_PROTOCOL_ESCALATION` spell
      `select <symbol> in <path> [resolve <value|type|namespace>] … end` and a
      6+ backtick fence; no `select [kind]` or 3-tick protocol example remains.
- [ ] `COMPACT_EXAMPLE_FORMS` contains a `resolve value` viewer and a `match` +
      `pick 2` + `replace with` edit with a 6-tick fence, rendered through
      `serializeSelections`, so the examples cannot drift from the grammar.
- [ ] `compactCreateInstruction` states both create rules: no `resolve` wraps a
      non-declaration body as `let`; a complete declaration is appended
      verbatim; `resolve type|namespace` wraps by space.
- [ ] `docs/editing-protocol.md` §2 (grammar), §3 (space resolution), §4
      (viewer), §6 (implicit create), and §8 (skeleton) match the
      implementation, and `docs/agent-loop.md` §4 names the `resolve` header
      and viewer feedback.
- [ ] A new offline acceptance scenario `compact-viewer-edit` (fixture
      `fix-answer`) scripts a JSON pick, a `match` viewer, a `pick 2` edit, and
      the verification pass; it asserts the viewer feedback contains the
      numbered block and `⁉️`, and the final `src/helper.ts` contains
      `return 2;`.
- [ ] `acceptance/README.md` lists the scenario, and the `Scenario` interface /
      `run.ts` pass `protocolFormat: "compact"` to `runLoop`.
- [ ] `just format && just typecheck && just test` pass.

## Verification

```
just accept --only compact-viewer-edit
bun test src/loop.test.ts -t "compact"
just format
just typecheck
just test
rg -n "select \\[kind\\]|3\\+ backticks|Located occurrences" src docs
```

The last command should only find historical prose, if anything; protocol
examples must use the `resolve` header and 6-tick fences.

## Notes

- Depends on the grammar, address, and viewer issues.
- Do not run `just accept --live` or the benchmark: this child is offline
  evidence only. Never tune the prompt against the held-out `csv-parser`
  fixture.
- The scenario runs the shipped JSON pick first, then the compact viewer and
  edit; re-expressing the pick phase / symbol index as `select` clauses (the
  human example's first turn) and the post-edit confirmation turn are
  explicitly out of scope.
- `src/helper.ts` in `fix-answer` already matches the example shape
  (`export function answer(): number { return 1; }` and a test expecting `2`).
