---
id: 81
title: "Reject or honor match with rename"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli]
created: 2026-11-05
---

## Context

The edit grammar accepts `match` before a `rename`, but the rename engine treats
renames as semantic and never uses the matcher. A non-matching matcher is
silently ignored and the rename still succeeds:

```text
tsed -C . --select helper --in src/b.ts \
  --match 'THIS DOES NOT EXIST' --rename helper2 --dry-run
# would change: src/b.ts   (exit 0)
```

The same happens through DSL. `selection.test.ts` has a parse/serialize test for
"a rename after a match", and `multi-editor.ts` says renames are semantic, not
matcher edits, so the accepted syntax and runtime behavior disagree.

## Goal

`match` plus `rename` is either enforced or rejected; it is never silently
ignored.

## Acceptance criteria

- [ ] A `match` that does not match the rename target fails with a clear
  matcher/address diagnostic and changes nothing, or the parser/CLI rejects
  `match` with `rename` as an unsupported combination.
- [ ] A matching `match` + `rename` behaves consistently with the chosen rule
  and is covered by a test.
- [ ] `tsed --match ... --rename ...` does not return success when the matcher
  cannot resolve.
- [ ] The DSL grammar, diagnostics, and docs agree on the chosen behavior.
- [ ] Existing parse/serialize tests are updated to the new contract.
- [ ] `just typecheck && just test` passes.

## Verification

```sh
tsed -C /tmp/tsed-review --select helper --in src/b.ts \
  --match 'THIS DOES NOT EXIST' --rename helper2 --dry-run   # must not succeed
printf 'select helper in src/b.ts\nmatch `THIS DOES NOT EXIST`\nrename helper to helper2\nend\n' \
  | tsed --protocol-format dsl --dry-run                     # same rule
bun test typescript-editor/src/selection.test.ts typescript-editor/src/multi-editor.test.ts
just typecheck && just test
```

## Notes

- `multi-editor.ts` explicitly skips matcher resolution for renames; decide
  whether to reject the combination in `selection.ts` or validate the matcher
  before resolving the rename. Rejecting is the smaller, safer change.
- If rejection is chosen, remove or rewrite the parse-only test that currently
  blesses a rename after a match.
- This is a semantic no-op bug; do not broaden it into the cross-file rename
  issue.
- - Chose rejection: the edit-dsl reader throws EDIT_RENAME_MATCHED for match + rename, the native/JSON protocol rejects it as a usage error, the serializer refuses to emit the combination, and resolveMultiEditor has a defensive address-stage guard for direct callers. Both matching and non-matching matchers are rejected, and docs now show rename as a separate grammar line.
- - Verification: native --match ... --rename exits 2 and the DSL form exits 1 with stage: syntax / EDIT_RENAME_MATCHED; neither changes the file. Targeted selection/protocol/cli/multi-editor tests 255 pass. just tsed-check up to date; just typecheck && just test green (editor 913, harness 703, scripts 16, acceptance 9/9). Prompt text was left untouched.
