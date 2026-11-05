---
id: 74
title: "Install tsed globally and document the install path"
status: done
priority: medium
milestone: null
parent: 73
deps: []
labels: [typescript-editor, cli, tooling]
created: 2026-11-05
---

## Context

`typescript-editor/package.json` declares `"bin": {"tsed": "./src/cli.ts"}`, but
`node_modules/.bin/tsed` does not exist after the workspace install, so every
use currently spells out `bun run typescript-editor/src/cli.ts`. The user wants
`tsed` available globally.

## Goal

A documented repository command installs/link the local private package globally
so `tsed` is on `PATH`.

## Acceptance criteria

- [ ] Add a `just tsed-install` target that runs a Bun global install of the
  absolute `typescript-editor` package path, so it works from the repository
  root without changing the caller's directory.
- [ ] Running `just tsed-install` in this checkout makes `tsed` resolve on
  `PATH`; `cd /tmp && tsed --version` and `tsed --help` work.
- [ ] The target is idempotent and fails loudly if Bun or the package path is
  missing.
- [ ] Root `README.md`, `typescript-editor/README.md`, and `AGENTS.md` document
  the install command, and the existing examples no longer imply the bin is
  already linked.
- [ ] `just typecheck && just test` passes.

## Verification

```sh
just tsed-install
cd /tmp
command -v tsed
tsed --version
tsed --help | head -3
just typecheck && just test
```

## Notes

- Use Bun's local global add/link (`bun add -g <absolute path>`); do not publish
  the private package to a registry.
- The global entry points at this checkout. Re-run the target after moving the
  checkout; document that.
- Added just tsed-install, a bash recipe that removes the previous global entry then runs bun add -g on the absolute local typescript-editor path; this avoids the duplicate-key corruption bun add -g produces on repeat installs. Verified twice: the global package keeps one @tc/typescript-editor dependency, tsed resolves from /tmp, tsed --version/--help work, and just typecheck && just test pass (editor 871, harness 703, scripts 16, acceptance 9/9). Updated README, typescript-editor/README, and AGENTS install documentation; no registry publish.
