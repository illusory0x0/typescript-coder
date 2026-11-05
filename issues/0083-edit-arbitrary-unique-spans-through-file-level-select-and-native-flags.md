---
id: 83
title: "Edit arbitrary unique spans through file-level select and native flags"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli]
created: 2026-11-06
---

## Context

`select file <path> …` is the only existing file-level editor, and its resolver
requires the target span to sit inside one import/export statement. Editing a
test callback, a large template literal, or one statement inside a function body
therefore requires a whole-file `--rewrite` even though the matcher and pick
grammar already describe the exact span.

The native flag surface also has no file-level select. An agent must build a DSL
payload or use `--rewrite` for a small span edit.

## Goal

A unique `match`/`pick` span can be edited directly, through the DSL and through
native flags, while whole-file writes remain explicit.

## Acceptance criteria

- [ ] `select file <path> [match …] [pick …] replace with <fence> end` accepts a
  unique span anywhere in the file, including a function body, a test callback,
  an object literal, or a template-literal body. A clause without `match` or
  `pick` is still rejected, and a multi-candidate match still fails as ambiguous.
- [ ] The existing parse/format/gate pipeline validates the replacement; an
  invalid replacement fails without writing.
- [ ] Native `--select-file <PATH>` works with `--match`, `--pick`, and
  `--replace-file`; JSON supports an equivalent `{ "op": "select-file", "path",
  "match"?, "pick"?, "replace" }` operation.
- [ ] `--select-file` with `--rename` is a usage error; a missing replacement is
  an address failure with a clear hint to use `--replace-file`; `--within` stays
  viewer-only.
- [ ] Numbered read and viewer output remains the default (1-based file-absolute
  line numbers) and has an explicit regression test; no opt-in flag is added.
- [ ] Tests cover a callback, a nested statement, a template literal, ambiguity,
  dry-run, and an apply failure; docs describe the wider file-level scope and the
  native/JSON forms.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
tmp=$(mktemp -d)
cat > "$tmp/a.test.ts" <<'TS'
import { test } from "bun:test";
test("answer", () => {
  const value = 1;
  if (value === 1) {
    console.log("ok");
  }
});
TS
tsed -C "$tmp" --select-file a.test.ts \
  --match 'if (value === 1) {' --replace-file patch.txt --dry-run
tsed -C "$tmp" --protocol-format json --dry-run <<'JSON'
{"operations":[{"op":"select-file","path":"a.test.ts","match":"if (value === 1) {","replace":"if (value === 2) {"}]}
JSON
bun test typescript-editor/src/module-boundary.test.ts typescript-editor/src/cli.test.ts
just tsed-check && just typecheck && just test
```

## Notes

`select file` keeps its name; the owner is still the file, not a declaration.
`create import|export` remains module-boundary-only. The native flag should render
to the same operation the DSL uses rather than bypassing validation.
