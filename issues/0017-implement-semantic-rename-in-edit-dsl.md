---
id: 17
title: "Implement semantic rename in edit-dsl"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-22
---

## Context

`human/edit.md` adds a `renamer` production to the edit-dsl grammar:

```text
editor = 'select', symbol, 'in', path, [resolve kind], [match ...], replacer | renamer 'end';
renamer = [ 'rename', identifier, 'to', identifier ];
```

The intent is semantic renaming — local variables, fields, namespaces, and enum
members — without requiring the agent to call the existing `rename` tool.
`src/tools.ts` currently has a `renameTool` that changes only the declaration
name and leaves references untouched; the edit-dsl path has no rename form at
all.

This umbrella covers the whole feature. The tracked work is split into a parser
leaf, a lexical-scope engine leaf, a dotted/member target leaf, and a loop
integration leaf.

## Goal

An edit-dsl reply can select a symbol and rename it to a new identifier, with
the declaration and every semantically resolved reference updated atomically
through the existing parse/format gates, without a tool call.

## Acceptance criteria

- [ ] A `select … rename <old> to <new> end` clause parses, serializes, and is
      applied by `runLoop`.
- [ ] Local variables and parameters rename their declaration and references in
      the correct lexical scope; shadowed names are untouched.
- [ ] Dotted targets — namespace segments, enum members, and class fields —
      update the intended declaration and qualified references, not unrelated
      suffixes.
- [ ] An unresolvable, ambiguous, or colliding rename is rejected with a staged
      diagnostic and writes nothing; a clean multi-statement reply applies
      atomically.
- [ ] The system prompt, `docs/editing-protocol.md`, `docs/agent-loop.md`, and
      an offline acceptance scenario agree with the implementation.
- [ ] `just typecheck && just test` pass.
- [ ] Every child issue is done or wontfix.

## Verification

```sh
just typecheck
just test
just accept --all
rg -n "rename|renamer" src docs acceptance human/edit.md
```

## Notes

- No full TypeScript checker is required. Use the existing `Binder`/`Scope`
  machinery in `src/utility.ts` and the project parser; type inference is out of
  scope.
- The existing `rename` tool stays for now; the new path must not invoke it.
- `human/edit.md` is human-authored and read-only for agents; it is the source
  of truth, not an edit target.
- Priority is left at the tracker default (medium) because the request did not
  name one.
