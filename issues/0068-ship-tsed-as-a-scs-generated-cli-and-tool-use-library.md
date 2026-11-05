---
id: 68
title: "Ship tsed as a scs-generated CLI and tool-use library"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli, tooling]
created: 2026-11-05
---

## Context

`typescript-editor/` is the reusable editing engine, but it has no public
entrypoint and no standalone command. The harness imports internal modules
directly (`resolve-entry`, `multi-editor`, `commit`, `editor`, `selection`), so
there is no stable surface for another consumer, a CLI, or a model tool call.

The request is to ship `tsed`: an scs-generated CLI with a read-only stdin mode,
an explicit file-modification mode, and a typed library/tool interface for
harness tool use and function calling.

## Goal

`typescript-editor` ships a committed `tsed` CLI generated from an `.scs`
declaration plus a typed library and function-calling surface, with read-only
and write modes sharing one implementation.

## Acceptance criteria

- [ ] `tsed` is a package binary whose argument surface, help, completions, and parser are generated from `typescript-editor/scs/tsed.scs`; the generated artifacts are committed and `scs generate ... --check` passes.
- [ ] `tsed --stdin` reads an edit-dsl reply, resolves `read`/viewer clauses, prints the inspection result, and writes nothing; mutation clauses are rejected in this mode.
- [ ] `tsed --stdin --write` applies editor/file mutations atomically with workspace path safety; a failed clause writes nothing.
- [ ] `@tc/typescript-editor` exports a typed read/apply API and an OpenAI-compatible tool definition plus dispatcher for harness tool use and function calling, without spawning the CLI.
- [ ] Docs, package exports, tests, and offline verification cover both CLI modes and the library surface; `just typecheck && just test` and `just accept` pass.
- [ ] Every child issue is done or `wontfix`.

## Verification

```sh
just typecheck && just test
just accept
scs generate typescript-editor/scs/tsed.scs --out typescript-editor/scs/generated --targets ts,bash,zsh,fish,elvish,pwsh,nu,runtime --check
printf 'read src/helper.ts end\n' | bun run typescript-editor/src/cli.ts --stdin
```

The generated artifacts are committed, so a clone does not need the global
`scs` command to build or test; `scs` is needed only to regenerate the surface.

## Notes

- `--stdin` alone is read-only. `--write` is the explicit opt-in for file
  modification; there is no implicit write mode.
- `typescript-editor/` must never import `harness/`.
- Do not change edit-dsl prompt text or benchmark behavior in this work.
- Priorities default to `medium`; no milestone is set.
