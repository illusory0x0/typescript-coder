# `@tc/typescript-editor`

The editing engine behind `tc`, packaged as a reusable library and the `tsed`
CLI. It owns the lexer/parser, symbol index, matcher, selection, edit-dsl,
cascade, and the splice/format/commit gate. It never imports `harness/`.

## `tsed`

From the repository root (the first read uses an existing file):

```sh
bun run typescript-editor/src/cli.ts --help
bun run typescript-editor/src/cli.ts --read typescript-editor/src/index.ts
```

The package declares a `tsed` bin; if your workspace install links it, `tsed`
runs directly. Otherwise invoke `bun run typescript-editor/src/cli.ts`. The
examples below use `tsed` as shorthand for that command.

`tsed` reads edit-dsl replies, the same language the agent loop uses. Every
format is **read-only by default**; `--write` is the only file-modification
opt-in.

The native-flag and stdin examples below assume a project workspace containing
`src/helper.ts`, `src/new.ts`, `patch.txt`, and `content.txt`; run them from
that workspace.

### Input formats

Use `--protocol-format flag|dsl|json`; `flag` is the default.

| Format | Payload                         | Use                       |
| ------ | ------------------------------- | ------------------------- |
| `flag` | Native command-line flags       | Normal CLI use            |
| `dsl`  | One edit-dsl reply on stdin     | Replaying a model reply   |
| `json` | A typed operation list on stdin | Programmatic/tool callers |

Native `flag` operations:

```sh
tsed --read src/helper.ts                       # read, repeatable
tsed --select answer --in src/helper.ts         # viewer
tsed --select answer --in src/helper.ts \
  --replace-file patch.txt --write              # editor
tsed --select answer --in src/helper.ts \
  --rename result --write                       # rename
tsed --create src/new.ts --write                # empty file
tsed --delete src/old.ts --write
tsed --rewrite src/helper.ts \
  --content-file content.txt --write            # whole file
```

`--select` supports optional `--kind`, `--resolve value|type|namespace`,
`--match <snippet>`, and `--pick <range>`. Without `--match`/`--pick`, the
replacement is the whole selected declaration. `--match` narrows the
replacement to the matched snippet; `--pick` narrows it to a line/column range
and requires a replacement. One `--select` group is allowed per invocation; use
`dsl` or `json` for batch replies. `--replace-file` and `--rename` are mutually
exclusive. `--replace-file` and `--content-file` are read from the process
working directory, not from `--directory`.

The stdin formats:

```sh
printf 'read src/helper.ts end\n' | tsed --protocol-format dsl

printf 'select answer in src/helper.ts\nreplace with\nTC_EDIT_BEGIN\nexport function answer(): number {\n  return 2;\n}\nTC_EDIT_END\n' \
  | tsed --protocol-format dsl --write

printf '{"operations":[{"op":"read","path":"src/helper.ts"}]}\n' \
  | tsed --protocol-format json
```

A JSON payload is either a bare operation array or `{"operations": [...]}`.
A read-only request:

```json
{ "operations": [{ "op": "read", "path": "src/helper.ts" }] }
```

An apply request uses the same shape; `--write` is required:

```json
{
  "operations": [
    {
      "op": "select",
      "symbol": "answer",
      "path": "src/helper.ts",
      "kind": "function",
      "replace": "export function answer(): number {\n  return 2;\n}\n"
    }
  ]
}
```

Operation fields:

| Operation | Fields                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------- |
| `read`    | `path` (required), `within` (optional)                                                          |
| `select`  | `symbol`, `path` (required); `kind`, `resolve`, `match`, `pick`, `replace`, `rename` (optional) |
| `create`  | `path` (required)                                                                               |
| `delete`  | `path` (required)                                                                               |
| `rewrite` | `path`, `content` (required)                                                                    |

A `select` is a viewer without `replace`/`rename`; `replace` and `rename` are
mutually exclusive. `match` narrows a replacement to the matched snippet;
`pick` requires a replacement and narrows it to a line/column range. Unknown
fields and malformed JSON are usage errors. The operation list only expresses
operations; `--write` still controls whether mutations are applied.

### Exit codes and output

| Code | Meaning                                                |
| ---- | ------------------------------------------------------ |
| `0`  | Success                                                |
| `1`  | Edit-dsl/application failure (including a failed read) |
| `2`  | Usage, input, or generation error                      |

Successful inspection text goes to stdout. Failure diagnostics go to stderr.
Apply runs also print `changed:`, `created:`, and `deleted:` lines for the paths
that were written. A failed reply writes nothing; a failed read is reported but
does not discard a clean mutation.

### Workspace and path safety

`-C, --directory DIR` selects the workspace root; the default is the current
directory. Edit-dsl paths are workspace-relative. Absolute paths, `..`,
hidden directories, `node_modules`, and protected prefixes (by default `human/`)
are rejected. Symlinks that resolve outside the workspace are rejected for
reads, writes, creates, and deletes. The workspace root must exist and be a
directory.

## Library API

```ts
import { applyEditDsl, readEditDsl } from "@tc/typescript-editor";

const read = await readEditDsl("read src/helper.ts end", { cwd: process.cwd() });
if (!read.ok) console.error(read.text);

const applied = await applyEditDsl(reply, { cwd: process.cwd() });
console.log(applied.changed, applied.created, applied.deleted);
```

`readEditDsl` resolves reads/viewers and rejects mutation clauses with
`stage: protocol`; it never writes. `applyEditDsl` resolves and applies the
whole reply through the shared format/gate pipeline atomically. Both return
`ok`, `text`, `reads`, `viewers`, `failures`, and `readFailures`; the apply
result also has sorted `changed`, `created`, and `deleted` arrays. A failed read
is returned in `readFailures` and does not discard a clean mutation.

`renderEditRequest` and `parseJsonEditRequest` build the edit-dsl form from the
typed operation list used by the JSON and flag formats.

## Tool use / function calling

`@tc/typescript-editor/tool` exports an OpenAI-compatible function definition
and dispatcher:

```ts
import { dispatchEditorTool, editorTool } from "@tc/typescript-editor/tool";

const result = await dispatchEditorTool(
  { reply: "read src/helper.ts end", write: false },
  { cwd: process.cwd() },
);
```

The tool is named `tsed`; its model-facing arguments are `reply` (required) and
`write` (optional, default `false`). The workspace root is supplied by the
caller in the second argument, never by the model. The dispatcher returns the
same structured result as the library API and never spawns the CLI.
`harness/src/tools.ts` re-exports the definition/dispatcher and registers it in
the harness tool list. The default text edit-dsl loop does not use it.

## Regenerating the CLI

`scs/tsed.scs` is the source of truth for the argument surface, help text, and
shell completions. Generated artifacts under `scs/generated/` are committed; do
not hand-edit them.

```sh
just tsed-generate   # rewrite scs/generated from scs/tsed.scs
just tsed-check      # scs generate ... --check
```

The raw regeneration command is:

```sh
scs generate typescript-editor/scs/tsed.scs \
  --out typescript-editor/scs/generated \
  --targets ts,runtime,bash,zsh,fish,elvish,pwsh,nu
```

A clone does not need `scs` to typecheck, test, or run `tsed`: the generated
surface is committed. The offline generated-surface test skips when `scs` is not
on `PATH`; `just tsed-check` always runs it.

## Tests

```sh
bun test typescript-editor/src
just typecheck && just test
```

The `src/cli.test.ts` suite covers flag reads, dsl read-only/dsl `--write`, JSON
reads/writes, usage errors, and failed writes that leave files unchanged.
