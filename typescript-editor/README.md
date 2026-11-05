# `@tc/typescript-editor`

The editing engine behind `tc`, packaged as a reusable library and the `tsed`
CLI. It owns the lexer/parser, symbol index, matcher, selection, edit-dsl,
cascade, and the splice/format/commit gate. It never imports `harness/`.

## `tsed`

### Install globally

The package is private and is not published. `just tsed-install` adds the local
`typescript-editor` package with `bun add -g` so `tsed` resolves on `PATH` from
any directory:

```sh
just tsed-install
tsed --version
tsed --help
```

The global entry points at this checkout, so rerun `just tsed-install` after
moving the checkout; the target replaces the previous entry rather than
duplicating it.

To run from the repository root without installing:

```sh
bun run typescript-editor/src/cli.ts --help
bun run typescript-editor/src/cli.ts --read typescript-editor/src/index.ts
```

The examples below use `tsed`; install it globally or substitute
`bun run typescript-editor/src/cli.ts`.

`tsed` reads edit-dsl replies, the same language the agent loop uses. Every
format is **read-only by default**; `--write` is the only file-modification
opt-in, and `--dry-run` previews a mutation through the full resolve/format/
gate/preflight pipeline without writing.

### What it is good at

`tsed` is not a replacement for an IDE or for quick `grep`/`sed` navigation. It
is at its best when an agent needs a small, auditable edit against a known
workspace:

- **Semantic renames.** A top-level named export rename follows relative named
  imports and re-exports, preserves aliases, and rejects duplicate-export
  collisions instead of guessing from text.
- **Preview/apply parity.** `--dry-run` runs the same resolve/format/gate/
  preflight pipeline as `--write`, lists every affected path, and leaves the
  workspace byte-identical. Add `--diff` to render a per-file unified diff from
  the same plan.
- **Repair-oriented failures.** Failures identify the stage; syntax failures add
  a code, line, column, source excerpt, expected/found values, and a hint. A
  failed reply writes nothing.
- **Atomic multi-file applies.** A reply resolves as a unit; if a later write
  fails, earlier writes are rolled back. Rollback only rewrites files whose
  contents actually changed.
- **One contract across formats.** Native flags, edit-dsl, and JSON operations
  share the same validation and output behavior, so a mutation that works in
  one entry point does not quietly behave differently in another.

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
tsed --read src/helper.ts --within 4-7          # unfold selected lines
tsed --select answer --in src/helper.ts         # viewer
tsed --select answer --in src/helper.ts \
  --within 5-7                                  # unfold a viewer slice
tsed --select answer --in src/helper.ts \
  --replace-file patch.txt --write              # editor
tsed --select-file src/helper.ts \
  --match 'if (value === 1) {' \
  --replace-file patch.txt --write              # unique file-level span
tsed --unify src/helper.ts                       # read-only block marker view
tsed --unify src/helper.ts --unify-min-lines 4   # lower the marker threshold
tsed --select answer --in src/helper.ts \
  --rename result --write                       # rename
tsed --create src/new.ts --write                # empty file
tsed --delete src/old.ts --write
tsed --rewrite src/helper.ts \
  --content-file content.txt --write            # whole file
tsed --create src/new.ts --dry-run              # preview only
tsed --create src/new.ts --dry-run --diff       # preview with a unified diff
tsed --select answer --in src/helper.ts \
  --rename result --dry-run                     # preview a rename
```

`--dry-run` runs the same pipeline as `--write` and then stops before any
write, create, or delete. It prints `would change:`, `would create:`, and
`would delete:` lines for the planned paths, and the workspace stays
byte-identical. Add `--diff` to follow those lines with a standard unified diff
for each planned file, generated from the pre-reply snapshot and the planned
source:

```text
would change: src/helper.ts

--- a/src/helper.ts
+++ b/src/helper.ts
@@ -5,3 +5,3 @@
 export function answer(): number {
-  return 1;
+  return 2;
 }
```

Create and delete diffs use `/dev/null` for the missing side. `--diff` is
preview-only: it requires `--dry-run` and is rejected with `--write`. `--dry-run`
is mutually exclusive with `--write`; a mutation needs one of them. The mode
works with all three formats: add it to a flag command or to a `dsl`/`json`
stdin command.

`--select` supports optional `--kind`, `--resolve value|type|namespace`,
`--match <snippet>`, and `--pick <range>`. Without `--match`/`--pick`, the
replacement is the whole selected declaration. `--match` narrows the
replacement to the matched snippet; `--pick` narrows it to a line/column range
and requires a replacement. One `--select` group is allowed per invocation; use
`dsl` or `json` for batch replies. `--replace-file` and `--rename` are mutually
exclusive. Relative `--replace-file` and `--content-file` paths resolve against
the `--directory` workspace root (the process cwd when `--directory` is
omitted); absolute paths are used as-is.

`--select-file <PATH>` is the file-level editor: the owner is the file, not a
declaration. It accepts the same `--match` and `--pick` selectors and
`--replace-file`, and resolves a **unique span anywhere in the file** — an
import/export statement, a statement inside a function body or test callback, an
object literal, or a template-literal body. A snippet that is not valid
TypeScript on its own (for example an incomplete block header such as
`if (value === 1) {`) is treated as an exact source span. The match or pick must
still resolve to exactly one candidate. `--select-file` is mutually exclusive
with `--select`, `--kind`, `--resolve`, `--rename`, and `--within`; a missing
`--replace-file` is not a usage error but reaches resolution and reports the
replacement hint. Use `--pick` for a precise line range, and `--within` only for
`--read`/`--select` viewers.

`--read` accepts `--within <RANGES>` to print only those file lines, unfolded;
the same range applies to every repeated `--read` path. Read and viewer output
is numbered by default with 1-based, file-absolute line numbers; there is no
opt-in flag. `--select` accepts
`--within <RANGES>` for a bare viewer slice, using the same range syntax as
`--pick` and the fold markers. `within` is viewer-only: it requires `--read` or
`--select`, and it is rejected with `--replace-file`, `--rename`, `--create`,
`--delete`, or `--rewrite`. Use `--pick` for a narrowed rewrite.

The stdin formats:

```sh
printf 'read src/helper.ts end\n' | tsed --protocol-format dsl

printf 'select answer in src/helper.ts\nreplace with\nTC_EDIT_BEGIN\nexport function answer(): number {\n  return 2;\n}\nTC_EDIT_END\n' \
  | tsed --protocol-format dsl --write

printf 'select answer in src/helper.ts\nreplace with\nTC_EDIT_BEGIN\nexport function answer(): number {\n  return 2;\n}\nTC_EDIT_END\n' \
  | tsed --protocol-format dsl --dry-run

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

A file-level span edit has no symbol; `match`/`pick` select the unique span:

```json
{
  "operations": [
    {
      "op": "select-file",
      "path": "src/helper.test.ts",
      "match": "if (value === 1) {",
      "replace": "if (value === 2) {"
    }
  ]
}
```

Operation fields:

| Operation     | Fields                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `read`        | `path` (required), `within` (optional)                                                                    |
| `select`      | `symbol`, `path` (required); `kind`, `resolve`, `within`, `match`, `pick`, `replace`, `rename` (optional) |
| `select-file` | `path` (required); `match`, `pick`, `replace` (optional)                                                  |
| `create`      | `path` (required)                                                                                         |
| `delete`      | `path` (required)                                                                                         |
| `rewrite`     | `path`, `content` (required)                                                                              |

A `select` is a viewer without `replace`/`rename`; `within` slices a bare viewer
and is rejected with `match`, `pick`, `replace`, or `rename`. `replace` and
`rename` are mutually exclusive, and `match` is rejected with `rename` (a
rename resolves the symbol semantically). `match` narrows a viewer or
replacement to the matched snippet; `pick` requires a replacement and narrows
it to a line/column range. A `select-file` is the file-level editor equivalent:
it takes `path` plus an optional `match`/`pick`/`replace` and renders to
`select file <path> …`. It never carries `symbol`, `kind`, `resolve`, `within`,
or `rename`.
Unknown fields and malformed JSON are usage errors. The operation list only
expresses operations; `--write` still controls whether mutations are applied.

### Exit codes and output

| Code | Meaning                                                |
| ---- | ------------------------------------------------------ |
| `0`  | Success                                                |
| `1`  | Edit-dsl/application failure (including a failed read) |
| `2`  | Usage, input, or generation error                      |

Successful inspection text goes to stdout. Failure diagnostics go to stderr.
Apply runs also print `changed:`, `created:`, and `deleted:` lines for the paths
that were written; dry runs print `would change:`, `would create:`, and
`would delete:` instead and write nothing. A dry run with `--diff` adds a blank
line and the per-file unified diff after those path lines; apply output never
includes a diff. A failed reply writes nothing; a failed read is reported but
does not discard a clean mutation.

### Block markers and block select

`--unify <PATH>` is a standalone **read-only viewer**: it prints the numbered
source with `// <symbol-id>:<node-id>` appended to the opening line of each
qualifying block, and it never writes. A block qualifies when its inclusive
`{` … `}` span is at least 8 lines; `--unify-min-lines N` overrides the
threshold, and `0` marks every block. Line numbers stay 1-based and
file-absolute, the printed line count matches the source, and a block that
already ends in a line comment gets its marker after that comment, so the
output stays parseable:

```text
 1 | export function outer(): number { // outer:1
 2 |   let total = 0;
 3 |   if (true) { // outer:2
```

The symbol ID is the nearest declaration address (`Parser.parse`), or
`<module>` when no declaration contains the block. The node ID is the block's
1-based preorder index within that symbol. IDs are recomputed from the current
AST on every call, so they cannot go stale. `--unify` is a viewer only:
`--write`, `--dry-run`, `--protocol-format dsl|json`, and all operation flags
are usage errors, and `--unify-min-lines` requires `--unify`.

The edit-dsl block editor addresses the same marker:

```text
select block <symbol-id>:<node-id> in <path> [ match <snippet> | match /<regex>/ ] [ pick <selecters> ] replace with <fence>
```

Without `match`/`pick` the target is the block's brace span. `match` and `pick`
narrow inside it using the normal rules and intersect when both are present;
exactly one span must remain. An empty fence deletes exactly that span. An
unknown or ambiguous block ID fails at `address`, and `resolve`, `within`, and
`rename` are rejected. `select block in <path>` still selects a declaration
literally named `block`; a token after `block` that is not `in` starts the
block-select form. `tsed --unify` is the intended way to discover an ID.

### Renames

`--rename` rewrites the selected declaration and every same-file reference. A
rename is semantic: `match` and `pick` are rejected rather than ignored. A
top-level declaration that the target file exports as a named export also
updates workspace files that import or re-export it through a relative
specifier: unaliased named imports (and their local uses), aliased imports (only
the imported name), and named re-exports (the source-side name; an alias keeps
its public name). The rename is rejected if the target or an affected importer
would export the new name twice, and a dry run lists every affected file.

Cross-file renames do not follow default or namespace imports, `import =`, or
dynamic imports, and do not resolve path aliases or traverse barrel/re-export
chains. The target file's public export name must change for importers to be
updated, so a binding exported only under an alias stays a same-file rename.

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

const preview = await applyEditDsl(reply, { cwd: process.cwd(), dryRun: true, diff: true });
console.log(preview.changed, preview.created, preview.deleted, preview.diffs);
```

`readEditDsl` resolves reads/viewers and rejects mutation clauses with
`stage: protocol`; it never writes. `applyEditDsl` resolves and applies the
whole reply through the shared format/gate pipeline atomically. With
`dryRun: true` it runs the same pipeline and returns the planned
`changed`/`created`/`deleted` arrays without calling a mutation method. Both
return `ok`, `text`, `reads`, `viewers`, `failures`, and `readFailures`; the
apply result also has sorted `changed`, `created`, and `deleted` arrays and a
`diffs` array. Set `diff: true` together with `dryRun: true` to fill `diffs`
with sorted `{ path, diff }` entries; otherwise it stays empty. `diff` is
preview-only, so `applyEditDsl` rejects it without `dryRun`. Diffs are rendered
in-process from the pre-reply snapshot and the planned source. A failed read is
returned in `readFailures` and does not discard a clean mutation.

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
on `PATH`; `just tsed-check` always runs it. The generated TypeScript is
committed as raw `scs` output; do not run a formatter over `scs/generated/`, or
`just tsed-check` will report the formatted files as stale.

## Tests

```sh
bun test typescript-editor/src
just typecheck && just test
```

The `src/cli.test.ts` suite covers flag reads, read/select `--within`
expansion, flag/dsl/json dry runs, dsl read-only/dsl `--write`, JSON
reads/writes, usage errors, the `--write`/`--dry-run` conflict, `--dry-run
--diff`, and failed writes that leave files unchanged. `src/api.test.ts`
covers the API plan and `diffs` results, and `src/unified-diff.test.ts` covers
the renderer's hunk, `/dev/null`, and missing-newline cases.
