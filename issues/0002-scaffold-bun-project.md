---
id: 2
title: Scaffold Bun/TypeScript project
status: done
priority: medium
milestone: M0
parent: 1
deps: []
labels: [scaffold]
created: 2026-10-16
---

## Context

Milestone **M0** of [spec.md](../spec.md) §11. The project is greenfield; the
frontend, tools, and loop all need a Bun/TS skeleton with a strict, ESM
`tsconfig` and a working test runner. `oxfmt` is a native NAPI package
(`@oxfmt/binding`) whose Bun compatibility is an open risk (spec.md R2), so it is
spiked here.

## Goal

A buildable Bun/TypeScript project skeleton with dependencies, strict ESM config,
test wiring, and a proven `oxfmt` invocation path.

## Acceptance criteria

- [x] `package.json` declares deps (`oxfmt`, `typescript`) and scripts, and sets
      `"type": "module"`.
- [x] `tsconfig.json` is `strict` and ESM-oriented; `src/` exists.
- [x] `bunx tsc --noEmit` exits 0.
- [x] `bun test` runs and exits 0 (zero tests is acceptable at this stage).
- [x] An `oxfmt` formatting call succeeds from Bun; if the native binding fails
      under Bun, the documented fallback (`bunx oxfmt` subprocess / prettier) is
      chosen and recorded.

## Verification

```
bun install
bunx tsc --noEmit
bun test
# oxfmt spike: format a sample file and diff the output
```

## Notes

- **R2 spike outcome (resolved 2026-10-16):** the native `oxfmt` binding loads
  and works under Bun 1.3.13 (linux x64, `@oxfmt/binding-linux-x64-gnu@0.73.0`).
  Preferred path for M4 `editor.ts`: in-process API
  `await format(fileName, sourceText, options) -> { code, errors }` from the
  `oxfmt` npm package (**async**, returns a Promise). Verified:
  `format("t.ts", "const   y:string = \"hi\"\n", {})` →
  `"const y: string = \"hi\";\n"`, 0 errors. Documented fallback (also verified):
  `bunx oxfmt <file>` subprocess (stdout/rewrite), works standalone. No prettier
  fallback needed.
- Stack: Bun 1.3.13, TypeScript 7.0.2, oxfmt 0.73.0, @types/bun 1.4.3.
  `tsconfig` strict + ESM, `noEmit`, `types: ["bun"]`; scripts
  `typecheck`/`test`/`format`; one trivial test proves the runner.
- Blocks #3, #4, #5, #6, #7, #8, #9, #10.
