# Roadmap

The near-term section is concrete work in this repository. The long-term
section is a direction, not a promise; it carries no dates or version
commitments. For the quick start and the package and command tables, see the
root [`README.md`](../README.md).

## Current state

- The repository is a Bun workspace with two packages: `typescript-editor/`
  and `harness/`.
- `typescript-editor/` has no dependency on `harness/`; `harness/` depends on
  `@tc/typescript-editor`.
- `typescript-editor/` ships the scs-generated `tsed` CLI, the typed
  `readEditDsl`/`applyEditDsl` API, and the `tsed` editor tool; the `.scs`
  declaration is the source of truth for the CLI surface. The harness registers
  the tool but the default text loop does not use it.
- `acceptance/` and `benchmark/` are top-level evaluation harnesses.
- The deterministic offline path — the `just test` offline lane (package unit
  suites, repository scripts, offline acceptance), typecheck, and the package
  layout — is in place. Remaining work is coverage and maintenance, not missing
  infrastructure.

## Near term

- Keep the package boundary clean: `typescript-editor/` never imports
  `harness/`.
- Keep `typescript-editor/scs/tsed.scs` as the source of truth for the CLI
  surface; regenerate with `just tsed-generate` and verify with
  `just tsed-check`. Keep the generated artifacts committed and never
  hand-edit them.
- Keep the public editor surface (`readEditDsl`/`applyEditDsl`,
  `editorTool`/`dispatchEditorTool`) and its README current with the code.
- Strengthen deterministic editor tests and the matcher corpus, and extend
  offline acceptance scenarios.
- Keep prompt text and protocol behavior frozen during layout and refactor
  work; prompt text is benchmark-sensitive.
- Improve diagnostics and replay coverage.
- Keep documentation ownership current in [`README.md`](README.md) and this
  roadmap.

## Evaluation policy

- Offline first: the `just test` offline lane (`--api none`, the default) and
  `just accept` are the development loop. Offline scenarios live in
  `acceptance/offline/`; nothing in that lane needs a network or an API key.
- Live acceptance lives in `acceptance/live/` and is opt-in with
  `just accept --live` or the unified lane `just test --api llm`. It costs
  money and is human-gated. Do not run it unprompted or as an iteration loop.
  API suites are grouped by `owner`; `--api-jobs` defaults to 1, so an owner
  never fans out by default.
- The oc side is frozen and has no committed baseline. A new oc reference run
  requires explicit human approval and a deliberate, temporary bypass of the
  benchmark guard.
- `csv-parser` is held out: never tune prompts or code against it.
- See [`../benchmark/README.md`](../benchmark/README.md) for the benchmark
  harness and [`../acceptance/README.md`](../acceptance/README.md) for the
  acceptance scenarios.

## Long-term direction

Treat `typescript-editor/` as a reusable standalone library with a small,
stable public surface. The read/apply API and editor tool are that surface;
publishing or consuming it outside this repository is a possibility only if a
real consumer appears; it is not a commitment.
