---
id: 87
title: "Resolve local tsconfig extends chains for cross-file rename"
status: in-progress
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli]
created: 2026-11-06
---

## Context

Cross-file rename currently reads only the workspace-root `tsconfig.json` and
explicitly does not follow `extends`. Real workspaces often put `baseUrl` and
`paths` in a shared local config, so aliases in those workspaces still leave
imports stale even though #86 resolves direct mappings.

## Goal

Resolve local relative `tsconfig.json` `extends` chains for path aliases used by
cross-file rename, with deterministic merge/override behavior and cycle safety.

## Acceptance criteria

- [ ] A root `tsconfig.json` that extends a local relative parent (for example
  `./config/tsconfig.base.json`) inherits the parent's `compilerOptions.baseUrl`
  and `compilerOptions.paths`; a `@/b` import resolves to the same file as `./b`.
- [ ] Multi-level local relative chains work, and `extends` arrays are merged in
  order with later entries and the child config overriding earlier values.
- [ ] A child `baseUrl` or `paths` override replaces the inherited value; an
  inherited `baseUrl` is interpreted relative to the config file that defined
  it and inherited `paths` resolve against the effective `baseUrl`.
- [ ] Missing local parents, external package `extends` entries, malformed
  configs, and cycles do not hang or crash the rename; unsupported entries are
  skipped and relative-only resolution remains available.
- [ ] JSONC comments and trailing commas are accepted in every followed config.
- [ ] Tests cover inheritance, multi-level/array merging, child overrides,
  cycles, and missing/external extends; docs update the `tsconfig` limitations.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
tmp=$(mktemp -d)
mkdir -p "$tmp/config" "$tmp/src"
printf '{"compilerOptions":{"baseUrl":"..","paths":{"@/*":["src/*"]}}}\n' > "$tmp/config/tsconfig.base.json"
printf '{"extends":"./config/tsconfig.base.json"}\n' > "$tmp/tsconfig.json"
printf 'export function helper(): number { return 1; }\n' > "$tmp/src/b.ts"
printf 'import { helper } from "@/b";\nexport const n = helper();\n' > "$tmp/src/a.ts"
tsed -C "$tmp" --select helper --in src/b.ts --rename helper2 --dry-run
bun test typescript-editor/src/rename.test.ts typescript-editor/src/cli.test.ts
just tsed-check && just typecheck && just test
```

## Notes

Only local relative `extends` files reachable through the workspace are
followed; package-name `extends` entries are not resolved from `node_modules`.
`paths` remains a wholesale object override, matching TypeScript's shallow
`compilerOptions` merge. This issue is a follow-up to #86.
