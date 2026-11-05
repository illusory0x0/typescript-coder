---
id: 70
title: "Generate the tsed CLI from an scs declaration"
status: todo
priority: medium
milestone: null
parent: 68
deps: [69]
labels: [typescript-editor, cli, codegen]
created: 2026-11-05
---

## Context

There is no `tsed` command. The requested CLI needs two distinct modes: reading
an edit-dsl reply from stdin without writing, and an explicit flag that applies
the reply to files. Hand-writing the argument surface would drift from the rest
of the scs-generated tooling, so the CLI surface must be declared in `.scs` and
its parser/help/completions generated.

## Goal

`tsed` is a committed, scs-generated CLI whose `--stdin` mode is read-only and
whose `--write` mode applies the same reply to the workspace.

## Acceptance criteria

- [ ] `typescript-editor/scs/tsed.scs` declares the `tsed` surface: `--stdin`, `--write`, a workspace directory option (`-C, --directory`), help, and version.
- [ ] Generated runtime, TypeScript declaration, and shell completions are committed under `typescript-editor/scs/generated/`; regeneration and `--check` commands are documented and runnable.
- [ ] `typescript-editor/package.json` exposes a `tsed` binary and the public API export; `tsed --help` and `tsed --version` work.
- [ ] `tsed --stdin` reads the edit-dsl reply from stdin, prints read/viewer results, and writes nothing; any mutation clause fails with a clear diagnostic.
- [ ] `tsed --stdin --write` applies the reply through the library API; without `--stdin` it is a usage error; without `--write` it never modifies files.
- [ ] Exit codes are stable: `0` success, `1` edit-dsl/application failure, `2` usage/generation error. Unknown flags and missing input fail as usage errors.
- [ ] The generated parser is the only argument parser; no hand-rolled flag parsing remains.
- [ ] CLI tests spawn the binary with stdin and assert stdout, stderr, exit code, and unchanged files after failures; `just typecheck && just test` passes.

## Verification

```sh
scs generate typescript-editor/scs/tsed.scs --out typescript-editor/scs/generated --targets ts,bash,zsh,fish,elvish,pwsh,nu,runtime --check
printf 'read src/helper.ts end\n' | bun run typescript-editor/src/cli.ts --stdin
printf 'select answer in src/helper.ts resolve value\nreplace with\nTC_EDIT_BEGIN\nexport function answer(): number {\n  return 2;\n}\nTC_EDIT_END\n' | bun run typescript-editor/src/cli.ts --stdin --write
just typecheck && just test
```

## Notes

- `--write` is the proposed flag name for the explicit modification mode; the
  semantics (read-only default, explicit write opt-in) are the requirement.
- Do not add verification/check commands to the CLI in this issue; it applies
  edit-dsl and reports engine results only.
- Keep prompt text and benchmark behavior unchanged.
