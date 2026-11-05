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

The request is to ship `tsed`: an scs-generated CLI with explicit input formats
(`--protocol-format dsl|json|flag`, default `flag`), an explicit file-modification
flag (`--write`), and a typed library/tool interface for harness tool use and
function calling.

## Goal

`typescript-editor` ships a committed `tsed` CLI generated from an `.scs`
declaration plus a typed library and function-calling surface, with read-only
and write modes sharing one implementation.

## Acceptance criteria

- [ ] `tsed` is a package binary whose argument surface, help, completions, and parser are generated from `typescript-editor/scs/tsed.scs`; the generated artifacts are committed and `scs generate ... --check` passes.
- [ ] `--protocol-format dsl|json|flag` selects the input encoding; `flag` is the default and uses the CLI's native flags, while `dsl` and `json` read their payload from stdin.
- [ ] Every format is read-only unless `--write` is present; `--write` is the only file-modification opt-in.
- [ ] `@tc/typescript-editor` exports a typed read/apply API and an OpenAI-compatible tool definition plus dispatcher for harness tool use and function calling, without spawning the CLI.
- [ ] Docs, package exports, tests, and offline verification cover all three formats and the library surface; `just typecheck && just test` and `just accept` pass.
- [ ] Every child issue is done or `wontfix`.

## Verification

```sh
just typecheck && just test
just accept
just tsed-check
printf 'read src/helper.ts end\n' | bun run typescript-editor/src/cli.ts --protocol-format dsl
bun run typescript-editor/src/cli.ts --protocol-format flag --read src/helper.ts
printf '{"operations":[{"op":"read","path":"src/helper.ts"}]}\n' | bun run typescript-editor/src/cli.ts --protocol-format json
```

The generated artifacts are committed, so a clone does not need the global
`scs` command to build or test; `scs` is needed only to regenerate the surface.

## Notes

- `--protocol-format` names the input encoding. `dsl` is the edit-dsl reply
  language; `json` is the typed operation list; `flag` is the native
  command-line shape (default).
- `--stdin` is not a mode in v1: it did not distinguish raw source text from an
  edit-dsl reply. Raw-file/in-memory operations stay in the library API.
- `--write` is the explicit opt-in for file modification; there is no implicit
  write mode.
- `typescript-editor/` must never import `harness/`.
- Do not change edit-dsl prompt text or benchmark behavior in this work.
- Priorities default to `medium`; no milestone is set.
