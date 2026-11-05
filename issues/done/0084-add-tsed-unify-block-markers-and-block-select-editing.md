---
id: 84
title: "Add tsed --unify block markers and block-select editing"
status: done
priority: medium
milestone: null
parent: null
deps: [83]
labels: [typescript-editor, cli, docs]
created: 2026-11-06
---

## Context

Token-heavy TypeScript block bodies are hard to address without reproducing a
large replacement or hand-computing `pick` coordinates. The symbol index exposes
declarations, but not useful stable handles for nested `{}` blocks.

A read-only annotated view can expose deterministic block IDs. The model reads
the annotated source, chooses a block ID, and asks the DSL to replace that block
without re-reading the whole body.

## Goal

`tsed --unify` shows large-block IDs, and `select block <id> in <path>` edits the
selected block span.

## Acceptance criteria

- [ ] `tsed --unify <PATH>` is a viewer: it prints the numbered source with a
  marker comment on the opening line of each qualifying `BlockStatement`, and it
  never writes. `--write` with `--unify` is a usage error.
- [ ] A marker has the form `// <symbol-id>:<node-id>`, where the symbol id is
  the nearest declaration address (for example `Parser.parse` or `<module>`) and
  the node id is a deterministic 1-based preorder index of block nodes within
  that symbol. IDs are unique and stable for unchanged source.
- [ ] Only blocks whose body spans at least 8 source lines are marked by default;
  `--unify-min-lines <N>` overrides the threshold. A block that already ends in
  a line comment still gets a syntactically valid marker.
- [ ] `select block <symbol-id>:<node-id> in <path> [match …] [pick …] replace
  with <fence> end` resolves that block's brace span; `match`/`pick` narrow
  inside it. An unknown or ambiguous ID fails at `address`; `rename` and `within`
  are rejected.
- [ ] The annotated output keeps 1-based file-absolute line numbers and does not
  change source line count. Tests cover nested blocks, a class method, the
  threshold, no-write behavior, dry-run/apply, and bad IDs.
- [ ] Docs show the marker format, the read-only nature, and the block-select
  grammar.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
tmp=$(mktemp -d)
cat > "$tmp/a.ts" <<'TS'
export function outer(): number {
  let total = 0;
  if (true) {
    total += 1;
    total += 2;
    total += 3;
    total += 4;
    total += 5;
    total += 6;
  }
  return total;
}
TS
tsed -C "$tmp" --unify a.ts
tsed -C "$tmp" --protocol-format dsl --dry-run <<'DSL'
select block outer:2 in a.ts
replace with
TC_EDIT_BEGIN
{
    total += 42;
  }
TC_EDIT_END
end
DSL
bun test typescript-editor/src/edit-dsl.test.ts typescript-editor/src/cli.test.ts
just tsed-check && just typecheck && just test
```

## Notes

Markers are view-only; they are not persisted in the source. This avoids
polluting the workspace and keeps line numbers file-absolute. IDs are recomputed
from the current AST by the same code that renders the markers, so no stale
marker state exists. Persisted markers can be a follow-up if a real consumer
needs them.
