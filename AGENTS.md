# AGENTS.md

Project: `typescript-coder` — TypeScript on Bun; tests run with `bun test`,
typecheck with `bunx tsc --noEmit`.

## Temp files

- Put every scratch/temporary file an agent creates in the repo-local `./tmp/`
  directory (gitignored). Create it if missing.
- Never write agent scratch files to `/tmp` or anywhere outside this
  repository.
- Test harnesses may sandbox throwaway workspaces under the system temp
  directory instead (`acceptance/run.ts` uses `mkdtempSync(join(tmpdir(), …))`);
  a harness-owned workspace is not an agent scratch file.
- Clean up scratch files when the task is done.

## Commands

- `bun run typecheck` — `tsc --noEmit`
- `bun test` — full test suite
- `bun run accept` — harness acceptance suite (see `acceptance/README.md`)

## Docs

- `docs/design.md` — architecture overview: components, flows, invariants.
- `docs/spec.md` — product spec and behavior; `docs/glossary.md` — loop
  vocabulary; `docs/review-guide.md` — where human review pays off (tiered by
  blast radius); `benchmark/README.md` — benchmark process, metrics, and the
  honest weak-spot list.
- `docs/subagent.md` — delegating a scoped edit to `tc` (invocation, targets,
  result schema, retry path). Delegate a scoped, verifiable edit with explicit
  `{path,symbol,kind}` targets; edit directly for docs/config or changes with no
  clear symbol target.
- `docs/feedback.md` — the critique-loop pool: the `feedback/` artifact format
  (gitignored scratch) that `triage-feedback` screens into tracked issues.

## Terminology

- Benchmark sides: `tc` = typescript-coder, `oc` = opencode. Use the short
  forms in side labels, flag values (`--side tc|oc`), tables, run names, and
  prose; spell out `opencode` only when naming its CLI/features (for example
  `opencode session export`). Never `ts` for typescript-coder.
- Historical artifacts - dated results under `benchmark/results/`, `tmp/`
  bundles, and closed issues - keep their original labels and file names.
