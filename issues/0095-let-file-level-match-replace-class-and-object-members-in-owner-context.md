---
id: 95
title: "Let file-level match replace class and object members in owner context"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, docs]
created: 2026-11-06
---

## Context

A file-level `select file ... match` can resolve a class field or object-literal member, but the replacement is parsed without the matched span's owner context. Replacing a class field with a field fence therefore fails at `stage: gate` with `unexpected token ";"`, even though the replacement is valid class-member syntax.

Recorded session evidence: `tmp/edit.dsl` at 06:53:25 and 06:53:32 replaced `src/port.ts`'s `filePath` field and added `foldCase`; both attempts failed. The same insertion using `pick after` succeeded. A minimal current reproduction:

```sh
tmp=$(mktemp -d); mkdir -p "$tmp/src"
printf 'export class A {\n  field = 1;\n  other = 2;\n}\n' > "$tmp/src/a.ts"
tsed -C "$tmp" --protocol-format dsl --dry-run --diff <<'EOF'
select file src/a.ts
match `  field = 1;`
replace with
TC_EDIT_BEGIN
  field = 10;
TC_EDIT_END
EOF
```

The result is `stage: gate` / `unexpected token ";"`. Changing the clause to `pick after \`  field = 1;\`` succeeds. Object-literal properties show the same failure.

This contradicts the file-level scope promised by `scheme-tsed/llm.txt:63-64` ("object members") and the object-literal example scope in `docs/edit-protocol.md`; the parse gate treats the replacement as a non-member fragment.

## Goal

A file-level `match` replacement is parsed in the owner context of the matched span, so class fields and object-literal members can be replaced atomically, while `pick before`/`pick after` remain valid insertion forms.

## Acceptance criteria

- [ ] A file-level `match` on a class field accepts a replacement fence containing one or more class fields and applies in one atomic reply.
- [ ] A file-level `match` on an object-literal member accepts a replacement fence containing one or more object members.
- [ ] The replacement is parsed using the matched span's owner context (class body, object literal, function body, and so on). A replacement that is invalid in that context still fails at `stage: gate` before any write, with a diagnostic naming the owner/context rather than a generic top-level parse error.
- [ ] Existing top-level declarations, imports/exports, function-body statements, test callbacks, template literals, nested blocks, and `pick after`/`pick before` behavior are unchanged.
- [ ] The recorded `src/port.ts` `filePath`/`foldCase` case and object-member fixtures are covered by regression tests; docs describe the owner-context rule.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
bun test typescript-editor/src/edit-dsl.test.ts typescript-editor/src/multi-editor.test.ts \
  typescript-editor/src/cli.test.ts
just tsed-check && just typecheck && just test
```

Manual checks:

```sh
# class field match replacement
tmp=$(mktemp -d); mkdir -p "$tmp/src"
printf 'export class A {\n  field = 1;\n  other = 2;\n}\n' > "$tmp/src/a.ts"
tsed -C "$tmp" --protocol-format dsl --dry-run --diff <<'EOF'
select file src/a.ts
match `  field = 1;`
replace with
TC_EDIT_BEGIN
  field = 10;
TC_EDIT_END
EOF

# same insertion through the supported pick path
tsed -C "$tmp" --protocol-format dsl --dry-run --diff <<'EOF'
select file src/a.ts
pick after `  field = 1;`
replace with
TC_EDIT_BEGIN

  extra = 3;
TC_EDIT_END
EOF
```

The first must change the field; the second must keep working. An invalid member replacement must write nothing.

## Notes

- `pick` is a valid workaround, not a substitute for the documented `match` behavior; the issue is owner-context parsing, not a request to remove the gate.
- This is a follow-up to #83 (file-level select scope); it is distinct from #92 (multiple disjoint regions on one declaration).
- No live/API/benchmark run is required for acceptance.
