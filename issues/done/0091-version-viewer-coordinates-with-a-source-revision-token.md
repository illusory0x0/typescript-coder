---
id: 91
title: "Version viewer coordinates with a source revision token"
status: done
priority: high
milestone: null
parent: null
deps: []
labels: [typescript-editor, harness, cli]
created: 2026-11-06
---

## Context

An edit clause's `pick` coordinates are line/column positions copied from a
numbered source block. When the source changes between the viewer/read turn and
the edit turn, the old coordinates can still be in bounds and silently splice a
different span. There is no freshness check today.

## Goal

Attach a deterministic source revision to every viewer/read source block and let
an edit clause prove that its coordinates were copied from that exact revision;
a stale revision fails typed before anything is written.

## Acceptance criteria

- [ ] `sourceRevision(source)` returns a deterministic 8-character lowercase hex
  token, has no new dependency, and changes when a single source character
  changes.
- [ ] Viewer feedback, `read` feedback, and the `# details` block of the
  main edit-dsl prompts print `rev <token>` for the full file source.
- [ ] The edit-dsl accepts an optional `rev <token>` after the path on
  declaration, file-level, and block selects, before `resolve`/`within`/`match`/
  `pick`: `select ... in <path> rev <token> ... end`.
- [ ] The native CLI accepts `--rev <TOKEN>` with `--select`/`--select-file`,
  and the JSON operation surface accepts `rev`; both render the same DSL token.
- [ ] A matching token resolves normally. Omitting the token preserves current
  behavior. A mismatched token fails with `stage: range`, names the expected
  refreshed revision workflow, and writes nothing; a malformed token is a
  syntax error.
- [ ] `serializeSelection` round-trips the revision, and a viewer header emitted
  by the renderer can be copied into the next edit clause.
- [ ] Prompt text and `docs/edit-protocol.md` teach the optional token without
  turning it into a mandatory field.
- [ ] Tests cover token stability, viewer/read rendering, fresh/stale/missing/
  malformed tokens, CLI dry-run, and serializer round-trip.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
bun test typescript-editor/src/range.test.ts typescript-editor/src/selection.test.ts \
  typescript-editor/src/edit-dsl.test.ts typescript-editor/src/multi-editor.test.ts \
  typescript-editor/src/cli.test.ts harness/src/loop.test.ts
just tsed-check && just typecheck && just test
```

Manual check:

```sh
tmp=$(mktemp -d); mkdir -p "$tmp/src"
printf 'export function f(): number {\n  return 1;\n}\n' > "$tmp/src/a.ts"
tsed -C "$tmp" --select f --in src/a.ts   # print rev
# Edit with the printed rev and a wrong rev; only the matching one may write.
```

## Notes

The revision is an integrity check, not a lock: concurrent writers are out of
scope. Keep the token optional for compatibility, but render it prominently so
the prompt can use it. Do not hash the folded/truncated display text; hash the
full source snapshot used by the resolver.
