---
id: 79
title: "Use declared value names in tsed help synopsis"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [typescript-editor, cli, tooling]
created: 2026-11-05
---

## Context

`tsed --help` renders internal field identifiers instead of the `valueName`
metavars declared in the scs source:

```text
--read <read>
--select <select>
--in <input>
-C, --directory <directory>
--replace-file <replace_file>
--content-file <content_file>
```

The declaration says `PATH`, `SYMBOL`, `DIR`, `FILE`, and so on, but the generated
runtime metadata does not carry `valueName`, so the help renderer falls back to
the snake_case ident. The zsh completion emitter already honors `valueName`,
which makes the surfaces inconsistent.

## Goal

`tsed --help` shows the declared value names in the synopsis and option lines.

## Acceptance criteria

- [ ] Help shows declared metavars, at minimum `--read <PATH>`,
  `--select <SYMBOL>`, `--in <PATH>`, `-C/--directory <DIR>`,
  `--replace-file <FILE>`, and `--content-file <FILE>`.
- [ ] `typescript-editor/scs/tsed.scs` stays the source of truth; generated
  artifacts are regenerated with `just tsed-generate` and never hand-edited.
- [ ] The fix either updates the scs runtime emitter to carry `valueName` into
  the generated metadata/help and pins that scs version, or removes the
  currently unsupported `valueName` declarations and records the follow-up;
  the chosen path is documented in the issue notes.
- [ ] A test asserts the help synopsis preserves the declared metavars.
- [ ] `just tsed-check`, `just typecheck && just test` pass.

## Verification

```sh
tsed --help | sed -n '/Usage:/,/Options:/p'
tsed --help | grep -E -- '--read|--replace-file|--content-file|-C,'
just tsed-check
bun test typescript-editor/src/cli.test.ts
just typecheck && just test
```

## Notes

- Root cause is in the scs runtime/help emitter: `valueName` is resolved but the
  TypeScript runtime emitter uses a snake_case ident as the metavar; the zsh
  emitter uses `field.valueName.toLowerCase()`.
- If the scs fix belongs upstream, file/link the scs issue and pin or vendor the
  fixed generator before regenerating. Do not patch `scs/generated/` by hand.
- This is a display-only issue; the parser already accepts the options.
- Fixed at the scs emitter: RuntimeField now carries valueName, describeField emits it, and the runtime template FieldSpec/help hint uses valueName ?? ident. scs spec 8.3 updated; runtime goldens and the bootstrapped scs runtime regenerated. Upstream fix committed locally in /home/illu/repo/scs as e2d7634. Regenerated tsed artifacts with just tsed-generate; help now shows --read <PATH>, --select <SYMBOL>, --in <PATH>, -C/--directory <DIR>, --replace-file <FILE>, --content-file <FILE>, --within <RANGES>, etc. Added a tsed help metavar assertion. Verification: scs typecheck, bun test 320 pass/1 skip, fmt:check, check, full bun run verify green; just tsed-check up to date; targeted cli test 35 pass; just typecheck && just test green (editor 891, harness 703, scripts 16, acceptance 9).
