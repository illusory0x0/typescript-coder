# AGENTS.md

Project: `typescript-coder` — TypeScript on Bun; tests run with `bun test`,
typecheck with `bunx tsc --noEmit`.

## Temp files

- Put every scratch/temporary file in the repo-local `./tmp/` directory
  (gitignored). Create it if missing.
- Never write temporary files to `/tmp` or anywhere outside this repository.
- Clean up scratch files when the task is done.

## Commands

- `bun run typecheck` — `tsc --noEmit`
- `bun test` — full test suite
- `bun run accept` — harness acceptance suite (see `acceptance/README.md`)
- `cd .opencode/skills && bun test` — skills project tests (standalone Bun
  project under `.opencode/skills/`; also `bun run typecheck` there)
