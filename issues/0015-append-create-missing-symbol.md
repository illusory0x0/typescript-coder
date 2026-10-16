---
id: 15
title: Append or create files when a locator's symbol is missing
status: todo
priority: high
milestone: null
parent: null
deps: []
labels: [feature, agent-loop]
created: 2026-10-17
---

## Context

The benchmark workstream (#16) needs typescript-coder to handle true
from-scratch generation ("write a JSON parser"), but the loop can only replace
existing symbols. The user reported the gap directly: "typescript-coder 目前有
问题, 需要增加新建文件, 如果 locator 指定 symbol 不存在需要在 file append 即
可." Current behavior:

- `src/loop.ts` selection: `findDefinition` returning `null` becomes
  `invalid locator: no symbol {kind} {name} in {path}` and retries until
  `could not select a symbol` (lines ~340–343).
- `sourceFileFor` throws `no source file {path}` for a path not in the index
  (lines ~263–269), so a new file can never be targeted.
- `src/editor.ts` `applyEdits` throws `no symbol {kind} {name} in {file}`
  (line ~37), and appending is not expressible as a span replacement.

Result: from-scratch tasks fail by construction (the earlier "stub file" fixture
design was only a workaround).

## Goal

A locator whose symbol is not in the index selects the target anyway: the
complete replacement output is appended to the named file (created when absent),
then verified, and rolled back exactly like a replacement edit on failure.

## Acceptance criteria

- [ ] Missing symbol + existing file: replacement text is appended to the end of
      the file (newline-normalized, separated from existing content), formatted
      by oxfmt, then verified via the existing `check` + `test` gate.
- [ ] Missing symbol + missing file: the file is created (parent directories
      included) containing the replacement text, oxfmt-formatted.
- [ ] Selection no longer emits `invalid locator: no symbol ...` for a missing
      symbol; it enters append mode. `buildSystemPrompt` states that a symbol
      may not exist yet and the harness will append/create it.
- [ ] A dedicated replacement prompt for append mode states that the target file
      may not exist yet and asks for the complete code declaring the symbol.
- [ ] Unsafe locator paths (absolute, or containing a `..` segment) keep the
      invalid-locator diagnostic + retry flow; nothing outside `cwd` is ever
      written.
- [ ] Rollback on verification failure restores the exact pre-edit state:
      existing file → original bytes restored; created file → deleted; both on
      retry and on final failure.
- [ ] Replace-mode behavior is unchanged: all existing tests stay green,
      `bun run accept` 5/5, `bun run accept --all` 6/6.
- [ ] New `src/loop.test.ts` cases: (a) append to an existing file, (b) create a
      new file, (c) rollback restores the appended-to file, (d) rollback deletes
      the created file, (e) a path-escaping locator is rejected and nothing is
      written.
- [ ] `spec.md` §4 (`Locator` / `apply-edits`) and §6 (agent loop) document the
      append/create semantics.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
bun run accept --all
```

plus: review the new `src/loop.test.ts` cases and the `spec.md` additions.

## Notes

- Files: `src/loop.ts`, `src/editor.ts`, `src/loop.test.ts`, `spec.md`.
- Suggested shape: keep the selection loop; when `findDefinition` returns
  `null`, validate the path and remember append mode; in the edit loop branch on
  mode — replace uses `applyEdits`, append concatenates the model output and
  formats (extract the oxfmt step of `applyEdits` into a reusable helper).
  Track `original: string | null` for rollback.
- Blocks #18 and #19 (the benchmark's from-scratch tasks); see #16.
- Hardening (optional): also reject paths under `node_modules`, `.git`, `dist`,
  or hidden directories, which `discoverSourceFiles` skips.
- Optional (only if cheap): expose `mode: "replace" | "append"` on
  `LoopResult` for evidence in run records.
- Priority `high`: user-requested capability gap that blocks #16.
- Non-goals: prepending, multi-file edits, issue-text templates.
