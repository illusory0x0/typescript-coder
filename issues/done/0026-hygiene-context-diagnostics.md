---
id: 26
title: "Hygiene pack: context perf/dedup, tmp skip, diagnostics edges"
status: done
priority: low
milestone: null
parent: null
deps: []
labels: [hygiene]
created: 2026-10-17
---

## Context

Low-severity findings from the 2026-10-17 audit, each independently verifiable:

- **F6 — context build re-parses**: `src/loop.ts:94` calls
  `buildSignatureView` per symbol; `scroll.resolveEntry`
  (`src/scroll.ts:50-56`) builds a fresh index (full file parse) per call, up
  to `CONTEXT_SYMBOL_LIMIT = 500`; `buildContextYaml` builds its own index
  (`src/loop.ts:57-105`) and `runLoop` builds another for the same files
  (`src/loop.ts:319`).
- **F7 — duplicate index entries**: class/enum symbols declared in both value
  and type spaces (`src/utility.ts:150-153,300-311`) collapse to the same
  `kind` (`src/utility.ts:483-514`) and produce duplicate context entries —
  the golden expectation lists `Widget` twice (`src/loop.test.ts:75-80`).
  Imported names are indexed as `variable` (`src/utility.ts:507-510`).
- **F8 — `tmp` not skipped**: `discoverSourceFiles` skips only
  `node_modules/.git/dist` and dot-dirs (`src/loop.ts:11,22-35`); once the
  benchmark creates `./tmp/benchmark/*` workspaces (#17–#19), self-host runs
  would index them.
- **F9 — double explanation output**: `runMain` prints the failure explanation
  to both stdout and stderr (`src/main.ts:46-47`), pinned by
  `src/cli.test.ts:188-189`.
- **F10 — diagnostics edges**: `parseDiagnostics` only captures the first
  line of a message and relies on a located regex (`src/tools.ts:131-153`);
  paths containing parentheses can misparse; `formatDiagnostics` truncates
  keeping the tail, dropping the earliest (root-cause) tsc errors first
  (`src/loop.ts:293-296`).

## Goal

Close the five low-severity hygiene findings without changing public behavior
beyond the listed fixes.

## Acceptance criteria

- [ ] F6: context building parses each file at most once per run (shared
      index/signatures); golden context outputs unchanged.
- [ ] F7: no duplicate entries for the same (path, name, kind, node); golden
      expectations updated; the imported-name policy is decided and documented
      (keep with a note, or exclude).
- [ ] F8: `tmp` is skipped by `discoverSourceFiles`; test updated.
- [ ] F9: the explanation is printed exactly once; `cli.test.ts` updated.
- [ ] F10: diagnostics prefer the head of tsc output (or head+tail), tolerate
      multi-line messages and paths with parentheses; unit tests added.
- [ ] `bunx tsc --noEmit` 0; `bun test` green; `bun run accept` 5/5.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
```

## Notes

- Priority `low` (Eisenhower Q4: neither urgent nor important; batch after
  Q1/Q2).
- May be split into separate issues at resolve time if the F6/F7 refactors
  grow.
- F7 changes golden fixtures intentionally; if it lands together with #21,
  coordinate the context-format test updates in a single resolve.
- F9 is behavior pinned by tests — choose the intended channel deliberately
  (stdout for the planner agent, stderr for humans).
- Resolved policies (2026-10-17): F7 **excludes imported names from the
  index** (aliases, not editable declarations; `variable` was misleading) —
  binder scope behavior unchanged; coverage includes top-level imports,
  `export import`, and namespace/module-nested `import x = ...`; duplicates
  collapse by `(node, name, kind)` so class/enum value+type pairs emit one
  entry. F9 keeps the explanation **on stdout only** (planner agents read
  stdout; diagnostics stay on stderr). F8 also rejects `tmp/` append targets
  via `safeAppendPath` — consistent side effect.
- Validation (2026-10-17): F6 renders signatures from the shared `IndexEntry`
  (`buildSignatureViewFromEntry`); a spy test proves `buildContextYaml(files,
  build)` performs zero extra parses. `parseDiagnostics` merges indented
  continuation lines and keeps parenthesized paths; `formatDiagnostics`
  truncates head+tail with an explicit marker. Verified: tsc 0, 446 tests,
  `accept` 5/5, `accept --all` 6/6 (test suite runtime dropped ~80s → ~54s).
