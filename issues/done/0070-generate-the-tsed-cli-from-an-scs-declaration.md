---
id: 70
title: "Generate the tsed CLI from an scs declaration"
status: done
priority: medium
milestone: null
parent: 68
deps: [69]
labels: [typescript-editor, cli, codegen]
created: 2026-11-05
---

## Context

There is no `tsed` command. The requested CLI needs one read-only inspection
surface and one explicit file-modification mode, with the payload encoding chosen
by `--protocol-format dsl|json|flag` (default `flag`). Hand-writing the argument
surface would drift from the rest of the scs-generated tooling, so the CLI
surface must be declared in `.scs` and its parser/help/completions generated.

## Goal

`tsed` is a committed, scs-generated CLI with three input formats: native flags
(default), edit-dsl on stdin, and a typed JSON operation list on stdin. All
formats are read-only by default; `--write` applies a resolved reply atomically.

## Acceptance criteria

- [ ] `typescript-editor/scs/tsed.scs` declares `--protocol-format dsl|json|flag` (default `flag`), `--write`, `-C/--directory`, the native flag protocol, help, and version.
- [ ] Generated runtime, TypeScript declaration, and shell completions are committed under `typescript-editor/scs/generated/`; regeneration and `--check` commands are documented and runnable.
- [ ] `typescript-editor/package.json` exposes a `tsed` binary and the public API export; `tsed --help` and `tsed --version` work.
- [ ] `flag` mode accepts native operations: `--read <PATH>` (repeatable), `--select <SYMBOL> --in <PATH>` with optional `--kind`, `--resolve`, `--match`, `--pick`, `--replace-file`, and `--rename`, plus `--create <PATH>`, `--delete <PATH>`, and `--rewrite <PATH> --content-file <FILE>`. Mutating groups require `--write`; missing or conflicting groups are usage errors.
- [ ] `dsl` mode reads an edit-dsl reply from stdin; `json` mode reads `{"operations":[...]}` (or a bare operation array) from stdin. Without `--write`, read/viewer clauses print their results and mutation clauses fail with `stage: protocol`; with `--write`, the reply applies through the library API.
- [ ] JSON operation shape is documented: `read`, `select`, `create`, `delete`, and `rewrite`, mirroring the native flag protocol; `replace`/`rename` are select editors; JSON syntax and shape errors are usage errors.
- [ ] Exit codes are stable: `0` success, `1` edit-dsl/application failure, `2` usage/input/generation error. Unknown flags and missing input fail as usage errors.
- [ ] The generated parser is the only argument parser; no hand-rolled flag parsing remains. Flag/JSON builders only validate native operation combinations and render edit-dsl for the shared API.
- [ ] CLI tests spawn the binary with stdin and assert stdout, stderr, exit code, and unchanged files after failures; `just typecheck && just test` passes.

## Verification

```sh
scs generate typescript-editor/scs/tsed.scs --out typescript-editor/scs/generated --targets ts,runtime,bash,zsh,fish,elvish,pwsh,nu --check
bun run typescript-editor/src/cli.ts --protocol-format flag --read src/helper.ts
printf 'read src/helper.ts end\n' | bun run typescript-editor/src/cli.ts --protocol-format dsl
printf '{"operations":[{"op":"read","path":"src/helper.ts"}]}\n' | bun run typescript-editor/src/cli.ts --protocol-format json
printf 'select answer in src/helper.ts resolve value\nreplace with\nTC_EDIT_BEGIN\nexport function answer(): number {\n  return 2;\n}\nTC_EDIT_END\n' | bun run typescript-editor/src/cli.ts --protocol-format dsl --write
bun run typescript-editor/src/cli.ts --protocol-format flag --select answer --in src/helper.ts --replace-file patch.txt --write
just typecheck && just test
```

## Notes

- `flag` is the default because it is the native CLI shape; `dsl` and `json`
  read stdin. There is no raw-source stdin mode; use the library API for
  in-memory operations.
- `--write` is the explicit modification mode. There is no implicit write.
- The native flag protocol covers one `--select` group per invocation; batch
  replies use `dsl` or `json`.
- Do not add verification/check commands to the CLI in this issue; it applies
  edits and reports engine results only.
- Keep prompt text and benchmark behavior unchanged.
- Implemented the scs-generated tsed surface and CLI. Added typescript-editor/scs/tsed.scs with --protocol-format dsl|json|flag (default flag), --write, -C/--directory, and the native flag protocol; committed generated runtime, tsd declaration, and shell completions. Added src/protocol.ts (edit operation renderer plus JSON parser) and src/cli.ts (generated parser only, stdin formats, usage/exit-code handling, read-only default). Added protocol/CLI tests: 42 pass. Verified scs generate --check, tsc, just typecheck, and just test (editor 862, harness 702, scripts 15, acceptance 9/9).
