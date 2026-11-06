---
id: 93
title: "Add content-anchored before/after insertion selectors"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, harness, cli]
created: 2026-11-06
---

## Context

Line/column `pick` is heavy for the common local edits that add a line after a
unique statement or before a closing brace: the model must count lines and
columns, and the coordinates go stale when earlier clauses or exchanges move the
text. Existing `match` replaces an existing span but cannot express an
insertion point.

## Goal

Add content-anchored insertion selectors: `pick before <matcher>` and
`pick after <matcher>` place the replacement immediately before/after the unique
anchor occurrence inside the selected declaration or file.

## Acceptance criteria

- [ ] `pick after \`return value;\` replace with <fence>` inserts the fence body
  immediately after the unique literal occurrence inside the selected
  declaration; `pick before` inserts immediately before it.
- [ ] Exact text anchors are matched literally inside the declaration/file, not
  through the structural matcher. `/regex/` anchors are accepted in the DSL and
  resolve the same way.
- [ ] Zero matches fail as `stage: matcher` not-found; multiple matches fail as
  ambiguous with candidate line/column positions; both write nothing.
- [ ] Anchors work for declaration, file-level, and block selects.
- [ ] `pick before|after` cannot combine with `match`, range `pick`, or
  `rename`; it requires `replace`. An empty fence is a no-op failure.
- [ ] The native CLI exposes `--pick-before <SNIPPET>` and
  `--pick-after <SNIPPET>` (mutually exclusive with `--pick`/`--match`), and the
  JSON operation surface exposes matching literal-anchor fields.
- [ ] Parser/serializer round-trip the anchor form; prompts and
  `docs/edit-protocol.md` teach it as the preferred insertion locator.
- [ ] Tests cover before/after, literal and regex, zero/multiple matches,
  declaration/file/block, insertion at declaration boundaries, parse/format
  gate, CLI dry-run, and serializer round-trip.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
bun test typescript-editor/src/selection.test.ts typescript-editor/src/cascade.test.ts \
  typescript-editor/src/edit-dsl.test.ts typescript-editor/src/multi-editor.test.ts \
  typescript-editor/src/cli.test.ts
just tsed-check && just typecheck && just test
```

Manual check:

```sh
tmp=$(mktemp -d); mkdir -p "$tmp/src"
printf 'export function f(): number {\n  return 1;\n}\n' > "$tmp/src/a.ts"
printf '  // inserted\n' > "$tmp/repl"
tsed -C "$tmp" --select f --in src/a.ts --pick-after 'return 1;' --replace-file "$tmp/repl" --dry-run
```

## Notes

The anchor is a zero-width splice point, so the existing formatter and parse
gate still run. Do not add a second command verb; `replace with` remains the only
replacement syntax. This is a follow-up to the range ergonomics work; dynamic
search or AST-based anchoring is out of scope.
