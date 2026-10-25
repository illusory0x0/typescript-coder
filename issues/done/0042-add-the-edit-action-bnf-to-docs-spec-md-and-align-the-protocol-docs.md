---
id: 42
title: "Add the edit-action BNF to docs/spec.md and align the protocol docs"
status: done
priority: medium
milestone: null
parent: 37
deps: [38, 39, 40]
labels: [agent-loop, edit-protocol, docs]
created: 2026-10-25
---

## Context

`docs/spec.md` documents the Plan and patch DSLs but not the edit-action reply
that the plan-exec executor and pinned-repair loop use. The only edit-action
grammar is in prose and an EBNF block in `docs/editing-protocol.md`, so the
as-built spec is incomplete and the two documents can drift.

The protocol is changing to the sentinel-only fence, `end` for unfenced file
commands, no `done`, and unique resolved clause addresses.

## Goal

Add a complete edit-action BNF section to `docs/spec.md` and align
`docs/editing-protocol.md` with the shipped grammar.

## Acceptance criteria

- [ ] `docs/spec.md` has a dedicated edit-action reply BNF section covering:
      `select` / `resolve` / `match` / `pick` / `replace with` / `rename`,
      `create`, `delete`, `read`, whole-file and ranged `write`, `end`, and the
      sentinel fence.
- [ ] The BNF shows `create <path> end`, `delete <path> end`,
      `read <path> [within <selecters>] end`, and a `write` terminated by
      `<<<TC_EDIT_END>>>` with no `done` or trailing `end`.
- [ ] The section states that each `select` clause must resolve to a unique
      `(path, symbol, kind)` in a reply, including viewers.
- [ ] `docs/editing-protocol.md` uses the same grammar and examples; legacy
      hyphen/backtick fences and `done` are removed from current examples.
- [ ] The outer whole-reply Markdown fence tolerance is documented separately
      from the edit-action fence.
- [ ] `docs/spec.md` links to `docs/editing-protocol.md` for resolution,
      cascade, and application semantics; the reverse link points back.
- [ ] Examples are valid Markdown and use parser-valid current syntax.

## Verification

- `git diff --check`
- Review every new BNF production against `src/selection.ts` and
  `src/plan-dsl.ts`.
- `rg -n '^-{5,}$|^`{6,}$|\bdone\b' docs/spec.md docs/editing-protocol.md`
  finds no current edit-action fence or `done` example (historical references
  are called out explicitly).
- `just typecheck && just test` remains green; docs-only changes do not require
  a live run.

## Notes

- Historical `issues/`, `human/`, and `benchmark/results/` are not rewritten.
- The BNF expresses clause shape; the unique-address rule is a semantic
  invariant and is stated in prose immediately below the grammar.
- Document missing-end recovery separately from the BNF: the grammar still requires 'end'; the parser may warn and recover only at an unambiguous next-statement boundary or EOF, matching the current select-clause behavior.
- Resolved edit-action BNF and docs alignment. docs/spec.md §8.2 now covers select/resolve/match/pick/replace/rename, create/delete/read/write, end, sentinel fence, missing-end recovery, unique resolved targets, and links to editing-protocol.md. editing-protocol.md has the matching grammar/examples, raw command forms, outer Markdown fence rule, and unique-target/duplicate semantics; agent-loop.md and glossary.yaml no longer teach legacy fences. Verified: just typecheck && just test -> 1467 pass, 0 fail; just accept -> 9 pass, 0 fail; git diff --check clean; no legacy fence lines; remaining done hits are edit status/prose/body-text references. No live benchmark run.
