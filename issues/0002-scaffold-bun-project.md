---
id: 2
title: Scaffold Bun/TypeScript project
status: todo
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

- [ ] `package.json` declares deps (`oxfmt`, `typescript`) and scripts, and sets
      `"type": "module"`.
- [ ] `tsconfig.json` is `strict` and ESM-oriented; `src/` exists.
- [ ] `bunx tsc --noEmit` exits 0.
- [ ] `bun test` runs and exits 0 (zero tests is acceptable at this stage).
- [ ] An `oxfmt` formatting call succeeds from Bun; if the native binding fails
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

- R2 spike outcome must be recorded here (native binding vs fallback).
- Blocks #3, #4, #5, #6, #7, #8, #9, #10.
