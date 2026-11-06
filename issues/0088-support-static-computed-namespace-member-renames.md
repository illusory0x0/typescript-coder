---
id: 88
title: "Support static computed namespace member renames"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli]
created: 2026-11-06
---

## Context

Cross-file rename rejects every computed namespace member access. A static
string key such as `ns["helper"]` or `ns['helper']` is just as provable as
`ns.helper`, so rejecting it leaves a common supported form stale or forces an
unnecessary `address` failure.

## Goal

Rename static string-keyed namespace member accesses while continuing to reject
truly dynamic computed accesses.

## Acceptance criteria

- [ ] `import * as ns from "./b"` plus `ns["helper"]` renames only the property
  to `ns["helper2"]`; double and single quotes are preserved.
- [ ] The same works for optional chaining (`ns?.["helper"]`) and a direct
  `import lib = require("./b")` local (`lib["helper"]`).
- [ ] A static key naming another property (`ns["other"]`) is left untouched and
  does not fail the rename.
- [ ] Dynamic keys (`ns[key]`, `ns["helper" + suffix]`) still fail at `address`
  with a diagnostic naming the access; escaped member spellings and
  non-string computed forms remain unsupported.
- [ ] Tests cover both quote styles, optional chaining, `import = require`,
  other static keys, and the remaining dynamic failure; docs distinguish static
  string keys from dynamic computed access.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
tmp=$(mktemp -d)
mkdir -p "$tmp/src"
printf 'export function helper(): number { return 1; }\n' > "$tmp/src/b.ts"
printf 'import * as ns from "./b";\nexport const n = ns["helper"];\n' > "$tmp/src/a.ts"
tsed -C "$tmp" --select helper --in src/b.ts --rename helper2 --dry-run
bun test typescript-editor/src/rename.test.ts typescript-editor/src/cli.test.ts
just tsed-check && just typecheck && just test
```

## Notes

Only plain string literals with no escape sequences are renamed; do not decode
or guess dynamic expressions. This is a follow-up to #85 and #86.
