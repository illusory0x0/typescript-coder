---
id: 94
title: "Allow disjoint file-level select clauses and fix duplicate diagnostics"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli, docs]
created: 2026-11-06
---

## Context

`select file` claims a file-level owner with `{ path, name: "", kind: "file" }` and `partial=false` (`typescript-editor/src/edit-dsl.ts:757-761`). As a result, a second file-level select on the same file is rejected at `stage: duplicate` before any matcher runs, even when the resolved spans are pairwise disjoint.

This is the shape used by the `scheme-tsed` model prompt: `scheme-tsed/llm.txt:75-90` shows two `select file src/reader.ts` clauses in one reply. `docs/edit-protocol.md:913-916`, however, says a file-level select claims the file's owner once per reply. The conflict appeared in the recorded session as 9 duplicate-related calls and 21 duplicate diagnostics; it forced split replies and extra exchanges.

The diagnostic is also misleading. `typescript-editor/src/edit-dsl.ts:543-544` formats `address.name`, which is empty for file-level nodes, so the error says `file ""` and `select "" once` instead of naming the path.

## Goal

A single atomic reply can apply multiple file-level `match`/`pick` editor clauses on one file when every resolved span is pairwise disjoint, and a real duplicate names the file path.

## Acceptance criteria

- [ ] Two or more disjoint file-level `match` clauses on the same file apply in one `--dry-run`/`--write` reply with different replacement fences.
- [ ] Disjoint `pick` + `match`, and disjoint `pick` + `pick`, on the same file also apply in one reply.
- [ ] Overlapping spans, touching zero-width insertions, and duplicate resolved spans still fail before any write with `stage: duplicate` or `stage: range` and name both clauses.
- [ ] Viewer + editor, rename + editor, whole-file write/delete/create conflicts, and module-boundary create conflicts remain failures; declaration-level behavior from #92 is unchanged.
- [ ] File-level duplicate diagnostics print the path (for example, `file "src/a.ts"`) and the hint names the path; they never print `file ""` or `select ""`.
- [ ] `docs/edit-protocol.md` and the model-facing multi-statement example describe the same contract, including the `scheme-tsed/llm.txt` shape; add a regression fixture for two disjoint clauses on one file.
- [ ] Tests cover disjoint match/match, pick/pick, match/pick, overlap, touching zero-width, duplicate resolved span, and a CLI dry-run proving the whole reply is atomic.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
bun test typescript-editor/src/edit-dsl.test.ts typescript-editor/src/multi-editor.test.ts \
  typescript-editor/src/cli.test.ts
just tsed-check && just typecheck && just test
```

Manual reproduction:

```sh
tmp=$(mktemp -d); mkdir -p "$tmp/src"
printf 'export const x = 1;\nexport const y = 2;\n' > "$tmp/src/a.ts"
tsed -C "$tmp" --protocol-format dsl --dry-run --diff <<'EOF'
select file src/a.ts
match `export const x = 1;`
replace with
TC_EDIT_BEGIN
export const x = 10;
TC_EDIT_END

select file src/a.ts
match `export const y = 2;`
replace with
TC_EDIT_BEGIN
export const y = 20;
TC_EDIT_END
EOF
```

Expected after the fix: both changes appear in the diff. Current behavior: `stage: duplicate`, `file "" in "src/a.ts"`, no write.

## Notes

- Assumption: the intended UX is the multi-statement example, so this issue extends the disjoint-region exception to file-level selects rather than only correcting the consumer prompt. If protocol owners decide file-level selects must stay unique, close this by aligning the example and docs; the path-in-diagnostic acceptance still applies.
- This is a follow-up to #83 (file-level select scope) and #92 (disjoint regions for one declaration).
- No live/API/benchmark run is required for acceptance.
