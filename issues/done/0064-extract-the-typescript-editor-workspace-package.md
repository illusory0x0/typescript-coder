---
id: 64
title: "Extract the typescript-editor workspace package"
status: done
priority: high
milestone: null
parent: 63
deps: []
labels: [monorepo, typescript-editor]
created: 2026-11-05
---

## Context

All runtime code currently lives in one flat `src/`. The editing engine is
almost standalone, but `selection.ts`, `cascade.ts`, `module-boundary.ts`,
`multi-editor.ts`, and `edit-dsl.ts` import `EditRange`/`resolveEditRange` from
`loop.ts`, and `matcher-corpus.test.ts` imports `resolveCurrentEntry` from
`loop.ts`. `selection.test.ts` also imports model-facing prompt examples. This
issue establishes the workspace root and extracts the editor package so it has
no harness dependency.

## Goal

`typescript-editor/` is an independently typecheckable and testable Bun
workspace package that owns the TypeScript editing engine and imports nothing
from the agent harness.

## Acceptance criteria

- [ ] Root `package.json` declares the Bun workspace, root `tsconfig.json` provides shared compiler options, and `bun.lock` reflects the workspace.
- [ ] `typescript-editor/package.json` and `typescript-editor/tsconfig.json` exist; the package exposes modules by subpath, declares no harness dependency, and has its own test scoping.
- [ ] `lexer`, `parser`, `matcher`, `utility`, `dsl-diagnostics`, `selection`, `export-modifier`, `cascade`, `editor`, `commit`, `create-declaration`, `module-boundary`, `multi-editor`, `rename`, `scroll`, and `edit-dsl` and their tests live under `typescript-editor/src/`.
- [ ] `EditRange`, `RangeResolutionFailure`, `resolveEditRange`, `CurrentEntryResolution`, and `resolveCurrentEntry` are extracted from `loop.ts` into editor-owned modules; no editor module imports `./loop`.
- [ ] The prompt-example tests that depend on `prompts/edit-dsl.ts` are moved to the harness side; the editor suite runs without harness code.
- [ ] The `greet` scaffold (`index.ts`/`index.test.ts`) stays with the harness for the self-host smoke; it does not move into the editor package.
- [ ] The editor package typechecks and tests pass.

## Verification

```
cd typescript-editor && bunx tsc --noEmit
cd typescript-editor && bun test
grep -rn 'from "\./loop"\|from "\.\./harness\|from "\.\./src' typescript-editor/src
```

The final grep must print nothing.

## Notes

- Preserve the uncommitted #62 changes; this issue does not own them.
- The harness remains temporarily broken until the child issue that moves it;
  verify this package in isolation.
- Keep behavior byte-identical: this is a move plus import-boundary extraction,
  not a rewrite. Do not change prompt text, protocol semantics, or fixtures.
- No live model run.
- Extracted the editor package under typescript-editor/src (16 modules, 14 colocated tests), added root workspace metadata and package subpath exports, and moved EditRange/resolveEditRange plus resolveCurrentEntry/addressJson into editor-owned range.ts and resolve-entry.ts. Moved the prompt-example tests to src/prompts/edit-dsl-examples.test.ts. Verified: `cd typescript-editor && bunx tsc --noEmit` clean; `bun test` 804 pass / 0 fail; boundary grep clean. Root typecheck is intentionally red until #65 rewires the harness.
