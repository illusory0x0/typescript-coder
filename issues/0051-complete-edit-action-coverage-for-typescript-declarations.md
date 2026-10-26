---
id: 51
title: "Complete edit-action coverage for TypeScript declarations"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop, edit-protocol]
created: 2026-10-26
---

## Context

The edit-action protocol is strong for named top-level declarations and many class/namespace members, but it is not complete at the declaration level. The binder does not index interface/type members, enum members, or object-literal members; imports/exports are excluded from the index; anonymous signatures, default-export expressions, overloads, declaration merging, and multi-declarator statements are not uniformly addressable. Structural matching also lacks several owner contexts, so some inner spans are reachable only by regex or `pick`.

The agreed contract is declaration-level completeness: locate a declaration, member, or module-boundary statement, then reach any inner span with at least one of structural matcher, regex matcher, or `pick`. This is not a requirement that every AST expression node has its own address.

## Goal

Make every TypeScript declaration, member, and module-boundary form locatable and editable through a declaration-level address plus a structural/regex/pick selector, with no silent first-match and a corpus proving at least one reachable selector path per form.

## Acceptance criteria

- [ ] The child issues are complete: #50 (kind-aware create), #52 (nested/named declaration addresses), #53 (structural matcher contexts and corpus), #54 (file-level select for imports/exports).
- [ ] `docs/edit-protocol.md` and `docs/plan-exec.md` contain a coverage matrix mapping TypeScript declaration/member/module-boundary forms to their address and supported selectors.
- [ ] A committed syntax corpus proves, for each covered form, that at least one selector path edits it and the parse/format/gate path verifies; unsupported forms fail with a clear diagnostic, never a silent first match.
- [ ] Only parse and safe-application correctness are hard guardrails; address/strategy choices remain advisory and are not rejected for style or granularity.
- [ ] `just typecheck && just test` and `just accept` pass; no frozen baseline or historical result JSON is modified.

## Verification

```sh
bun test src/utility.test.ts
bun test src/edit-dsl.test.ts
bun test src/task-loop.test.ts
bun test src/loop.test.ts
just typecheck && just test
just accept
git diff --check
```

No live benchmark is required for acceptance; a measured comparison needs explicit human approval.

## Notes

- Scope is declaration-level, not every syntax node. JSX/`.tsx` is out of scope unless separately requested.
- Import/export addressing uses a file-level owner (`select file ...`), not synthetic declaration names and not a zoo of import/export actions.
- Inside a declaration, structural matching is best-effort; regex and `pick` are first-class fallbacks.
- Anonymous member create (call/construct/index signature) is deferred; named create is handled by #50.
- Do not tune against the held-out `csv-parser` fixture, regenerate frozen baselines, or run live benchmarks without approval.
