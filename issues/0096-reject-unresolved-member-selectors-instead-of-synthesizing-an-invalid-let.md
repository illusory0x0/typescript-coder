---
id: 96
title: "Reject unresolved member selectors instead of synthesizing an invalid let"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, docs]
created: 2026-11-06
---

## Context

When a dotted member selector does not resolve, the implicit-create path synthesizes an invalid top-level declaration. For example, `select N.newMethod` on a class without that member, with a `private newMethod()` fence, produces:

```text
replacement line 2, column 6:
  1 |
  2 | let N.newMethod = private newMethod(): void {
  3 |     return;
```

The reply then fails at `stage: gate` with `expected ;` instead of reporting an address problem or pointing at the explicit member-create syntax.

Recorded session evidence: gate output at 05:00:38 contains `let resolve = private resolve(...)`, and 05:19:49 contains `let readString = private readString(...)`. The explicit API is already clear:

```sh
create method N.newMethod in src/new.ts with
TC_EDIT_BEGIN
  private newMethod(): void {
    return;
  }
TC_EDIT_END
```

This succeeds with a dotted owner. `create method newMethod` without the owner correctly fails with an address error and the hint `use create method Owner.name in <path> with <fence>`. The implicit path should not construct invalid source before reaching that guidance.

## Goal

An unresolved member selector fails as a clear address error that names the member and points to `create method Owner.name`; the tool never synthesizes `let X.y = private ...` from a member fence. Explicit member creation continues to work.

## Acceptance criteria

- [ ] `select N.newMethod` on a class without that member, with a method fence, fails at `stage: address` (or an equivalent typed address diagnostic) and writes nothing.
- [ ] The diagnostic names `N.newMethod` and says to use `create method N.newMethod in <path> with <fence>` (or equivalent exact guidance).
- [ ] No output or synthesized replacement line contains `let N.newMethod = private ...` for this case.
- [ ] Explicit `create method N.newMethod in <path> with <fence>` still inserts the member; selecting an existing member still replaces it.
- [ ] Top-level select/implicit-create behavior and existing error stages are unchanged.
- [ ] Tests cover absent method and property selectors, explicit member create, existing member replacement, and no-write atomicity; docs state that `select Owner.name` requires an existing member and absent members use `create method`.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
bun test typescript-editor/src/edit-dsl.test.ts typescript-editor/src/selection.test.ts \
  typescript-editor/src/multi-editor.test.ts
just tsed-check && just typecheck && just test
```

Manual reproduction:

```sh
tmp=$(mktemp -d); mkdir -p "$tmp/src"
printf 'export class N {\n  value = 1;\n}\n' > "$tmp/src/new.ts"
tsed -C "$tmp" --protocol-format dsl --dry-run --diff <<'EOF'
select N.newMethod in src/new.ts
replace with
TC_EDIT_BEGIN
  private newMethod(): void {
    return;
  }
TC_EDIT_END
EOF

tsed -C "$tmp" --protocol-format dsl --dry-run --diff <<'EOF'
create method N.newMethod in src/new.ts with
TC_EDIT_BEGIN
  private newMethod(): void {
    return;
  }
TC_EDIT_END
EOF
```

The first must be a clear address failure with no `let`; the second must show the inserted method in the diff.

## Notes

- Assumption: `select Owner.name` is for existing members; adding a member is the explicit `create method Owner.name` path. If a member implicit-create syntax is intended instead, it must emit a valid member insertion, not the current `let`.
- This is a robustness/diagnostic fix; the parse gate already prevents a bad write.
- No live/API/benchmark run is required for acceptance.
