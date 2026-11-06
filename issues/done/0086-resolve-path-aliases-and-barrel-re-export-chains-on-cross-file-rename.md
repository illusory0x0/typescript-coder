---
id: 86
title: "Resolve path aliases and barrel re-export chains on cross-file rename"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli]
created: 2026-11-06
---

## Context

Cross-file rename currently resolves only `./` and `../` specifiers and only
direct named import/re-export edges. Path aliases (`@/b`) and barrel files
(`export * from "./b"`) therefore leave real workspaces stale, even when the
module graph is otherwise static.

## Goal

Cross-file rename resolves configured path aliases and follows re-export chains,
with cycle-safe traversal and explicit failures for ambiguous or unsupported
edges.

## Acceptance criteria

- [ ] A workspace-level module resolver reads the workspace `tsconfig.json`
  `baseUrl` and `paths` mappings (direct and one-level `extends` if the existing
  config helper already supports it) so `@/b` resolves to the same file as
  `./b`.
- [ ] A barrel chain `src/a.ts -> src/index.ts (export * from "./b") -> src/b.ts`
  updates the importer's binding when the renamed export is visible through the
  chain; multiple chained barrels and a cycle are handled without duplicate
  edits or infinite traversal.
- [ ] An ambiguous alias, an unresolved specifier, or an unsupported
  `export *` shape that could hide the renamed name fails at `address` with the
  file and specifier; it does not silently leave a stale import.
- [ ] Tests cover direct `paths`, a chained barrel, a cycle, an ambiguous alias,
  and a rename that must stay local because the public name is aliased; docs
  update the rename limitations.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
tmp=$(mktemp -d)
mkdir -p "$tmp/src"
printf '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n' > "$tmp/tsconfig.json"
printf 'export function helper(): number { return 1; }\n' > "$tmp/src/b.ts"
printf 'import { helper } from "@/b";\nexport const n = helper();\n' > "$tmp/src/a.ts"
tsed -C "$tmp" --select helper --in src/b.ts --rename helper2 --dry-run
bun test typescript-editor/src/rename.test.ts typescript-editor/src/cli.test.ts
just tsed-check && just typecheck && just test
```

## Notes

Keep the resolver lexical: no text search for the old name, no `any`-style
guessing. A barrel edge is followed only when the renamed name is actually
re-exported and the chain reaches the target file.
