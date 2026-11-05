---
id: 71
title: "Expose edit-dsl as a harness tool/function"
status: done
priority: medium
milestone: null
parent: 68
deps: [69]
labels: [typescript-editor, harness, tool-use]
created: 2026-11-05
---

## Context

The harness has an OpenAI-compatible `ToolDefinition` type and a `tools` array,
but no editor tool. A harness or another caller that supports tool use/function
calling cannot perform an edit-dsl read or apply through a stable typed
function; it would have to spawn `tsed` or import internals.

This issue adds the function-calling adapter over the API from #69. It does not
change the existing text edit-dsl protocol or its prompt.

## Goal

`@tc/typescript-editor` exports a typed, JSON-schema-compatible editor tool and
dispatcher that the harness can call for read or write operations without
spawning the CLI.

## Acceptance criteria

- [ ] A public `src/tool.ts` exports an OpenAI-compatible `ToolDefinition` for the editor (one tool with a `write` flag or separate read/apply tools; the shape is documented).
- [ ] The tool parameters accept the edit-dsl `reply` and an explicit write opt-in, defaulting to read-only; the workspace root is supplied by the caller, not taken from the model.
- [ ] A typed dispatcher returns a structured result containing `ok`, inspection text/results, changed/created/deleted paths, and failures/diagnostics; read mode never writes.
- [ ] `harness/src/tools.ts` registers or re-exports the definition and dispatcher; harness code uses the public editor surface rather than duplicating resolver/commit wiring for this path.
- [ ] The default text edit-dsl loop and its prompts are unchanged unless a caller explicitly enables the tool.
- [ ] Tests use a fake provider or direct dispatcher call to prove read and write behavior, failure results, and that no CLI process is spawned.
- [ ] `just typecheck && just test` passes and the package-boundary rule remains clean.

## Verification

```sh
bun test typescript-editor/src/tool.test.ts harness/src/tools.test.ts
cd typescript-editor && bunx tsc --noEmit
just typecheck && just test
```

## Notes

- "Tool use/function calling" means the OpenAI-compatible `ToolDefinition`
  contract already used by `harness/src/openai.ts`, not a new text protocol.
- Do not tune or alter edit-dsl prompts or benchmark behavior.
- If the current loop cannot pass tools to the provider without a larger
  refactor, expose the tool and dispatcher and add harness registration now;
  leave loop integration to a separate issue and report the limitation.
- Added typescript-editor/src/tool.ts: editorTool (OpenAI-compatible tsed function with reply and write:false-default schema) and dispatchEditorTool (object/JSON-string args, caller-supplied cwd only, structured read/apply result, ok false on readFailures, no spawn). Re-exported both and the result/option types from harness/src/tools.ts and appended editorTool to the harness tools array without changing loop/provider behavior. Added 13 tool tests plus harness registration/dispatch coverage: 43 tests pass. Verified just typecheck && just test (editor 871, harness 703, scripts 15, acceptance 9/9).
