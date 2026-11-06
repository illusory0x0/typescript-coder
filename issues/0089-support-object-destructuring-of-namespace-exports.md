---
id: 89
title: "Support object destructuring of namespace exports"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli]
created: 2026-11-06
---

## Context

Renaming a namespace export currently rejects every object destructuring of the
namespace. Plain static keys are provably renameable and common:
`const { helper } = ns` reads the namespace property `helper`, but the local
binding is also named `helper`, so the edit must change the property while
keeping the local binding stable.

## Goal

Rewrite static object-destructuring keys that read a renamed namespace export,
without renaming the local bindings or their uses.

## Acceptance criteria

- [ ] `const { helper } = ns` becomes `const { helper2: helper } = ns`; uses of
  the local `helper` stay unchanged.
- [ ] `const { helper: local } = ns` becomes `const { helper2: local } = ns`.
- [ ] `const { "helper": local } = ns` changes the key to `"helper2"` and
  preserves quote style; string keys with escapes remain unsupported.
- [ ] A default (`const { helper = fallback } = ns`) and a nested binding
  (`const { helper: { value } } = ns`) update the property key while preserving
  the local binding/default semantics.
- [ ] Static computed string keys (`const { ["helper"]: local } = ns`) are
  updated; dynamic computed keys (`const { [key]: local } = ns`) and rest
  (`const { ...rest } = ns`) still fail at `address`, because they may read the
  renamed property.
- [ ] An unrelated destructuring (`const { other } = ns`) is left untouched and
  does not fail; namespace imports and direct `import = require` locals both
  work.
- [ ] Tests cover shorthand, alias, string key, default, nested binding,
  static/dynamic computed keys, rest, unrelated keys, and both import forms;
  docs update the destructuring limitation.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
tmp=$(mktemp -d)
mkdir -p "$tmp/src"
printf 'export function helper(): number { return 1; }\n' > "$tmp/src/b.ts"
printf 'import * as ns from "./b";\nconst { helper } = ns;\nexport const n = helper();\n' > "$tmp/src/a.ts"
tsed -C "$tmp" --select helper --in src/b.ts --rename helper2 --dry-run
bun test typescript-editor/src/rename.test.ts typescript-editor/src/cli.test.ts
just tsed-check && just typecheck && just test
```

## Notes

Only top-level object destructuring initialized from the namespace local is in
scope. Do not rename local bindings; a shorthand key becomes an explicit
`property: local` pair so the local name and its references stay stable. This is
a follow-up to #85 and #86.
