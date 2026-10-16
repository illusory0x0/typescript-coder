---
id: 10
title: CLI and main stdin entry
status: todo
priority: medium
milestone: M8
parent: 1
deps: [9]
labels: [cli]
created: 2026-10-16
---

## Context

Milestone **M8** of [spec.md](../spec.md) §11, implementing `cli.ts` and
`main.ts` (spec §5). The issue is delivered on **stdin** (spec §6, §8);
`cli.ts` currently provides only `--help` and the `--model` flag; `main.ts`
wires stdin into the loop.

## Goal

`main.ts` reads the issue from stdin and drives the loop; `cli.ts` exposes
`--help` and `--model`, and the agent passes the self-host smoke test.

## Acceptance criteria

- [ ] `main.ts` reads the issue from stdin and invokes the loop.
- [ ] `cli.ts` supports `--help` and `--model <id>` (model selection is the only
      CLI option affecting the run).
- [ ] Failure explanations are surfaced (stderr + final stdout message per spec
      §13).
- [ ] Self-host smoke: after the agent edits its own `src/`, `tsc --noEmit` and
      `bun test` still pass.

## Verification

```
echo "<issue text>" | bun run src/main.ts --model deepseek
bun run src/cli.ts --help
bunx tsc --noEmit && bun test
```

## Notes

- Depends on #9 (loop).
- Closes the umbrella #1 once the three anchor fixtures pass.
