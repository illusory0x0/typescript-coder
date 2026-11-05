---
id: 80
title: "Update named imports and exports on a cross-file rename"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli]
created: 2026-11-05
---

## Context

`--rename` is documented as same-file only. A declaration imported by another
workspace file is renamed in its own file, but importers keep the old binding and
the workspace stops compiling. This is the largest remaining semantic gap for
using `tsed` as an ordinary code-editing CLI.

Observed in a temp workspace:

```text
src/a.ts: import { helper } from "./b"; export const n = helper();
src/b.ts: export function helper(): number { return 1; }

tsed -C . --select helper --in src/b.ts --rename helper2 --dry-run
# would change: src/b.ts
```

`src/a.ts` is not reported and still imports `helper`; applying the rename would
leave a stale import. `typescript-editor/README.md` and `docs/edit-protocol.md`
explicitly call the rename same-file/not type-checker-based.

## Goal

A workspace rename updates named import and export references outside the
declaration file atomically, without text-search guessing.

## Acceptance criteria

- [ ] Renaming a declaration updates named import specifiers in other workspace
  files, including aliased imports (`import { helper as h }` becomes
  `import { helper2 as h }` while local `h` uses stay unchanged).
- [ ] Named re-export specifiers (`export { helper } from "./b"` and
  `export { helper as publicHelper }`) are updated with aliases preserved.
- [ ] Dry-run reports every affected file; apply writes them atomically and
  rolls back all files if any write fails.
- [ ] Ambiguous or colliding bindings fail with a clear address/collision
  diagnostic; files outside the workspace and protected paths are rejected.
- [ ] Tests cover named imports, aliased imports, named re-exports, a collision,
  dry-run reporting, and rollback/no-write on failure.
- [ ] Docs update the rename limitation to the supported scope.
- [ ] `just typecheck && just test` passes.

## Verification

```sh
tmp=$(mktemp -d)
mkdir -p "$tmp/src"
printf 'import { helper } from "./b";\nexport const n = helper();\n' > "$tmp/src/a.ts"
printf 'export function helper(): number { return 1; }\n' > "$tmp/src/b.ts"
tsed -C "$tmp" --select helper --in src/b.ts --rename helper2 --dry-run
tsed -C "$tmp" --select helper --in src/b.ts --rename helper2 --write
grep -R "helper2" "$tmp/src"
bun test typescript-editor/src/rename.test.ts typescript-editor/src/cli.test.ts
just typecheck && just test
```

## Notes

- The current `rename.ts` engine is a lexical, single-file resolver. Cross-file
  support needs a workspace import/export graph (or a TypeScript language-service
  path) rather than extending the lexical match in place.
- Scope this issue to named import/export specifiers. Default imports, namespace
  imports, `import = require`, dynamic imports, and barrel/re-export chains can
  be follow-ups once the core graph exists.
- Do not use a text search for the old name; only resolved import/export edges
  count.
- Prompt text and benchmark behavior must not change.
