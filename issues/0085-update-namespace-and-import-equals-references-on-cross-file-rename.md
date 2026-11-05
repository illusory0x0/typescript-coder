---
id: 85
title: "Update namespace and import-equals references on cross-file rename"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli]
created: 2026-11-06
---

## Context

The cross-file rename added in #80 follows direct relative named imports and
re-exports. Namespace imports and `import =` are still skipped, so renaming an
exported member leaves `ns.member` or `lib.member` references stale.

## Goal

A cross-file rename updates namespace-member and `import =` references that
provably resolve to the renamed export, and refuses any reference it cannot
update safely.

## Acceptance criteria

- [ ] For a workspace file with `import * as ns from "./b"`, renaming a named
  export of `./b` updates `ns.helper` to `ns.helper2` (including optional
  chaining such as `ns?.helper` if the parser represents it as member access).
- [ ] For `import lib = require("./b")`, the same member rename applies.
- [ ] Local aliases and re-export public names keep their existing behavior.
- [ ] A computed access (`ns["helper"]`), a dynamically resolved reference, or
  any namespace/import-equals shape the resolver cannot update produces an
  `address` failure that names the file and edge; the rename does not silently
  leave a stale reference.
- [ ] Tests cover both import forms, aliases, nested member expressions,
  collisions, and the unsupported-edge diagnostic; docs update the rename
  limitations list.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
tmp=$(mktemp -d)
mkdir -p "$tmp/src"
printf 'export function helper(): number { return 1; }\n' > "$tmp/src/b.ts"
printf 'import * as ns from "./b";\nexport const n = ns.helper();\n' > "$tmp/src/a.ts"
tsed -C "$tmp" --select helper --in src/b.ts --rename helper2 --dry-run
tsed -C "$tmp" --select helper --in src/b.ts --rename helper2 --write
grep -q 'ns.helper2' "$tmp/src/a.ts"
bun test typescript-editor/src/rename.test.ts typescript-editor/src/cli.test.ts
just tsed-check && just typecheck && just test
```

## Notes

Do not guess through arbitrary aliases or `any`; the resolver owns the lexical
binding. `import =` support should only follow a direct `require("./relative")`
module reference.
