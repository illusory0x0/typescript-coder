---
id: 90
title: "Allow pick ranges in files larger than the prompt fold limit"
status: done
priority: high
milestone: null
parent: null
deps: []
labels: [typescript-editor]
created: 2026-11-06
---

## Context

`resolveEditRange` rejects every range when the caller's source block is larger
than `SPEC_FILE_LIMIT` (8000 characters). Both current callers pass the whole
file (`base = 0`, `limit = source.length`), so a `pick` fails in any file over
8000 characters even when the requested span sits in a small declaration near
the top. This was hit while resolving #87.

The refusal is obsolete: prompt source blocks are folded, not truncated, and
fold markers retain file-absolute line numbers. The range resolver already
enforces the declaration span, line/column bounds, and empty/inverted ranges.

## Goal

Make range resolution depend on the requested position and declaration bounds,
not on the total size of the file.

## Acceptance criteria

- [ ] A declaration `pick` in a source file larger than 8000 characters resolves
  when the range is inside the declaration, and a file-level `pick` resolves
  when the range is inside the file.
- [ ] Out-of-bounds, outside-declaration, and empty/inverted ranges still fail
  with their existing typed `stage: range` reasons and write nothing.
- [ ] The global `limit - base > SPEC_FILE_LIMIT` refusal (and its `truncated`
  range-failure path, if no longer reachable) is removed; `SPEC_FILE_LIMIT`
  remains available for prompt/spec-file truncation.
- [ ] Regression tests use a file larger than 8000 characters with edits near
  the start and end, for both declaration and file-level picks.
- [ ] Docs no longer claim that a file over the limit makes range coordinates
  unmappable; they state the actual declaration/file bounds.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
bun test typescript-editor/src/range.test.ts typescript-editor/src/cascade.test.ts \
  typescript-editor/src/edit-dsl.test.ts typescript-editor/src/multi-editor.test.ts
just tsed-check && just typecheck && just test
```

Manual check:

```sh
tmp=$(mktemp -d)
mkdir -p "$tmp/src"
# Write a >8000-character file with a small declaration near the top.
tsed -C "$tmp" --select small --in src/big.ts --pick 2:1-2:10 \
  --replace-file /tmp/repl --dry-run
```

## Notes

Root cause is the range resolver reading a prompt-truncation constant as a
file-size limit. Do not change the 1-based inclusive range semantics or the
declaration-bounds check.
