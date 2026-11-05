---
id: 72
title: "Document and verify the tsed CLI and library surface"
status: todo
priority: medium
milestone: null
parent: 68
deps: [69, 70, 71]
labels: [typescript-editor, docs, tooling]
created: 2026-11-05
---

## Context

Once `tsed` and its library surface exist, users need one place that explains
the three input formats, the exit codes, the path-safety boundary, the library
entrypoint, and how to regenerate the scs artifacts. Without that, the generated
parser and the handwritten API will drift or be used as an implicit write tool.

## Goal

The CLI and library are documented, discoverable, and covered by offline
verification, with the `.scs` file as the single source of truth for the CLI
surface.

## Acceptance criteria

- [ ] `typescript-editor/README.md` documents `tsed` installation/invocation, `--protocol-format flag|dsl|json` (default `flag`), `--write`, `-C/--directory`, exit codes, path safety, the library read/apply API, the JSON operation shape, and the tool definition.
- [ ] Root `README.md`, `docs/README.md`, and `docs/roadmap.md` mention the `tsed` binary and the reusable editor API without changing their ownership claims.
- [ ] The regeneration command and the committed-generated-file policy are documented; `just tsed-check` runs `scs generate --check`, and an offline test skips cleanly when `scs` is unavailable.
- [ ] An offline test or shell smoke covers flag-mode read, dsl read-only, dsl `--write`, json `--write`, and a failed write that leaves files unchanged; `just accept` still passes.
- [ ] `just typecheck && just test` and `just accept` pass.
- [ ] No edit-dsl prompt text or benchmark behavior changes; generated completions are not hand-edited.

## Verification

```sh
just typecheck && just test
just accept
just tsed-check
bun run typescript-editor/src/cli.ts --protocol-format flag --read src/helper.ts
printf 'read src/helper.ts end\n' | bun run typescript-editor/src/cli.ts --protocol-format dsl
printf '{"operations":[{"op":"read","path":"src/helper.ts"}]}\n' | bun run typescript-editor/src/cli.ts --protocol-format json
```

## Notes

- The `.scs` declaration is the source of truth; README examples must match the
  generated `--help` output.
- `flag` is the default native shape; `dsl` and `json` read stdin.
- Keep the generated artifacts committed so a clone does not need `scs` to
  typecheck or test; the offline check skips when `scs` is absent.
