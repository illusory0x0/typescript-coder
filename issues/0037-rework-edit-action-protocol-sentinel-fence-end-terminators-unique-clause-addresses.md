---
id: 37
title: "Rework edit-action protocol: sentinel fence, end terminators, unique clause addresses"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop, edit-protocol, docs]
created: 2026-10-25
---

## Context

The current 3-rep tc benchmark passes 24/24, but plan-exec produced 12
`EDIT_UNCLOSED_FENCE` rejections across 12 runs. The legacy 5+ hyphen / 6+
backtick fence and the `done` terminator are ambiguous, and multi-clause replies
currently detect duplicate edits only after matcher resolution (or by
overlapping regions), producing diagnostics such as
`regions overlap at offsets 131..161`.

The protocol will keep multi-clause support, but each clause must address a
distinct declaration. `docs/spec.md` also lacks the edit-action BNF, so the wire
contract is split between prose and `docs/editing-protocol.md`.

Decisions from the design discussion:

- keep one new sentinel fence format only; remove legacy fences;
- retire `done`; `create` / `delete` / `read` use `end`, matching `select`;
- whole-file `write` is terminated by `<<<TC_EDIT_END>>>`, with no `done` or
  trailing `end`;
- every `select` clause in one reply must have a unique resolved
  `(path, symbol, kind)`, including viewers;
- the viewer-then-editor same-declaration example is no longer valid;
- update prompts, few-shots, and the spec; no code fallback to legacy.

## Goal

Ship one canonical edit-action wire format and a deterministic unique-address
rule, with the model-facing examples and `docs/spec.md` BNF in sync.

## Acceptance criteria

- [ ] The sentinel-only fence child issue is done.
- [ ] The end-terminator child issue is done.
- [ ] The unique-clause-address child issue is done.
- [ ] The prompt/few-shot migration child issue is done.
- [ ] The `docs/spec.md` edit-action BNF child issue is done.
- [ ] Offline typecheck, unit tests, and acceptance pass.
- [ ] No current prompt, docs, or acceptance example uses a legacy fence or
      `done`.

## Verification

- `just typecheck && just test`
- `just accept`
- `rg -n '^-{5,}$|^`{6,}$' src docs acceptance` returns no edit-fence examples
  (table separators and historical artifacts are out of scope)
- The final live 3-rep both-modes benchmark is run only after explicit human
  approval; it is evidence, not a development-loop requirement.

## Notes

- Historical `benchmark/results/`, `issues/`, `human/`, and generated replay
  bundles are not migrated.
- Open tracker issue #25 is unrelated to this umbrella.
- A future metrics change can record statement and file-command counts; it is
  not part of this protocol migration.
- Parser tolerance decision: a missing 'end' after select/create/delete/read is recovered with an EDIT_MISSING_END warning when the next statement boundary or EOF is unambiguous. The prompt and few-shot examples always emit 'end'; the tolerance is recovery only, never taught as the canonical form. The tolerant path is covered by #39; #41 keeps examples canonical; #42 documents the warning.
