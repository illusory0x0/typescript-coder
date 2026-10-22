---
id: 22
title: "Fix edit-dsl variable targeting and the minilisp token-budget storm"
status: todo
priority: high
milestone: null
parent: null
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-22
---

## Context

The 2026-10-22 semantic-rename benchmark ran `minilisp` tc at
`benchmark/results/2026-10-22-semantic-rename.json`: 1/3 passed, while the other
three tc fixtures passed 3/3. Two runs hit the 120k token budget after 19 and 23
steps.

Both failures had 15 of 16 tests passing and were blocked on the `car`/`cdr`
arity fix. The model tried to edit the `builtins` variable with
`select const builtins in src/lisp.ts`, but the symbol index labels that
declaration kind `variable`, the selection grammar only accepts
`const`/`let`/`var`, and `SymbolIndex.lookup` matches the kind exactly. The
address diagnostic then suggested changing the kind to `variable`, which the
parser rejects. The model looped between an address miss and a syntax error,
never reached a raw `write`, and exhausted the token budget.

This is a pre-existing edit-dsl repair-loop failure, not a rename-engine
failure: neither failing run contains a `rename` clause, and an earlier compact
baseline also recorded a `minilisp` token-budget run. The renamer prompt change
is a confound only; the concrete cause is the unaddressable variable target and
the unusable repair advice.

## Goal

Make edit-dsl variable targets addressable with the grammar the model is
taught, and make repeated address failures recover with a concrete valid action
instead of looping to the token budget.

## Acceptance criteria

- [ ] A top-level `const`/`let`/`var` declaration can be selected and edited
      with its declared kind and with a bare `select <name>`.
- [ ] Address diagnostics never recommend a kind that the selection grammar
      rejects.
- [ ] A repeated address failure for an unaddressable target offers a valid
      bare select or raw `write` fallback.
- [ ] Offline regression tests cover the variable-kind mismatch and the
      recovery path.
- [ ] `just typecheck && just test` pass.

## Verification

```sh
just typecheck
just test
```

After both leaves land, the motivating shape can be checked with a targeted
live run:

```sh
bun run benchmark/run.ts --task minilisp --side tc --reps 5 \
  --json benchmark/results/2026-10-22-minilisp-kind-fix.json
```

The live run is evidence for the storm, not a CI gate.

## Notes

Children: #TBD-kind and #TBD-recovery. Local function/block scope indexing is
out of scope for this umbrella; the failing `builtins` target was indexed as a
top-level `variable`. If local edit-dsl targets are needed later, file a
separate issue.
- Child ids: #23 (align variable kinds) and #24 (address-failure recovery). The body's #TBD placeholders refer to these.
