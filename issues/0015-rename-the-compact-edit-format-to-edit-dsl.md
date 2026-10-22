---
id: 15
title: "Rename the compact edit format to edit-dsl"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop, edit-protocol, docs]
created: 2026-10-22
---

## Context

The two edit-protocol formats are currently called `compact` (the default `select … end` syntax) and `json` (the flat JSON payload). "Compact" describes the reply's size, not its role: it is the domain-specific edit DSL the agent speaks. Calling it `edit-dsl` names the thing and pairs cleanly with `json`.

The term is spread across the public interface (`--protocol-format`, replay bundles), the resolver module (`src/compact.ts`), model-facing prompt builders (`buildCompact*`, `compactContext`), docs, and the acceptance/benchmark harnesses.

## Goal

Rename the `compact` edit format to `edit-dsl` throughout the codebase and its docs, while keeping existing recorded bundles and scripts readable.

## Acceptance criteria

- [ ] `--protocol-format edit-dsl` selects the `select … end` protocol and is the default; `--help` and the invalid-value error show `json|edit-dsl`.
- [ ] The `json` format keeps its name and behavior unchanged.
- [ ] `ProtocolFormat` and `ReplayProtocolFormat` use `"json" | "edit-dsl"`; code identifiers follow (`src/edit-dsl.ts`, `EditDsl*` types, `editDsl*` functions, `editDslContext`).
- [ ] New replay bundles are written with `protocolFormat: "edit-dsl"`.
- [ ] `compact` remains accepted as a legacy input alias for the CLI flag and for parsing existing replay bundles, and is normalized to `edit-dsl`; the alias is documented as deprecated.
- [ ] No non-historical `compact` naming remains in `src/`, `acceptance/`, `benchmark/`, or `docs/`; historical artifacts (`benchmark/results/2026-10-21-compact-baseline.*`, `issues/done/`) are left unchanged.
- [ ] Renaming does not change prompt text or parsing behavior: the compact-era replay fixtures still replay green.

## Verification

```
grep -rn -i "compact" src acceptance benchmark docs
just typecheck
just test
just accept --all
bun run benchmark/run.ts --help   # only if the benchmark help is touched; no live run
```

The `grep` output is limited to the legacy-alias implementation, deprecation comments, and historical result filenames.

## Notes

- Backward compatibility is the main design call: tracked benchmark results record `"compact"`, so the replay parser and `benchmark/check.ts` must still read it. The alias is input-only; output always writes `edit-dsl`.
- `human/` is read-only and contains no occurrence of the term.
- Do not rewrite `issues/done/` titles or bodies; they record history under the old name.
- No prompt-text change: `buildSystemPrompt` content and the model-facing `select … end` instructions stay byte-identical.
