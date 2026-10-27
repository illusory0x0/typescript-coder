import { END_OF_LINE_COLUMN, serializeSelections } from "../selection";
import type { Selection as EditDslSelection } from "../selection";
import { declarationSpaces } from "../utility";
import type { SourceFile, SymbolIndex } from "../utility";
import {
  appendSpecSection,
  assembleSystemPrompt,
  CONTEXT_SYMBOL_LIMIT,
  numberLinesFrom,
  numberedSourceBlock,
  TEST_FILE_SUFFIX,
} from "./shared";

// The edit-dsl protocol (formerly the #117/#119 opt-in mode): the system prompt
// teaches `select … end` clauses and the pick turn itself is a single select
// clause. It is the only model reply protocol.
export const EDIT_DSL_SELECT_SYSTEM_PARAGRAPH =
  "First you will be asked to select the target or act on files directly. Reply with ONLY one `select <symbol> in <path> [ resolve <value|type|namespace> ] end` clause naming one symbol-index entry, or with one file-level `select file <path> … replace with <fence>` clause for an import/export statement, or with one or more raw file commands (`create`, `delete`, `read`, `write`). A select clause is a viewer unless it carries `replace` or `rename`, and a viewer leads to a `# details` prompt before the edit. Do not mix a select clause and file commands in this first reply. Keep the reply to those statements with no prose and no JSON.";
export const EDIT_DSL_EDIT_SYSTEM_PARAGRAPH =
  "Then you will be asked to edit the selected symbol. Reply with ONLY one or more `select` clauses: `select <symbol> in <path> [ resolve <value|type|namespace> ] [ match (<snippet> | /regex/) ] [ [ pick <range> ] replace with <fence> | rename <old> to <new> end | end ]` (an optional declaration `kind` may precede the symbol). A replacement clause ends at the fence close; a viewer or rename ends with `end`. Clauses apply in document order and independently; every clause in one reply must resolve to a different declaration `(path, symbol, kind)` — target one declaration at most once per reply, even with different `match` or `pick` spans, and split edits to one declaration across exchanges; a clause with neither `replace` nor `rename` is a viewer that locates and writes nothing unless it contains `pick`; `pick` requires `replace` and is not a viewer form. `rename <old> to <new>` renames the selected declaration and every same-file reference that resolves to it, including dotted namespace/member targets, and cannot be combined with `pick` or `replace`. `resolve value`, `resolve type`, or `resolve namespace` selects the TypeScript symbol space when the same name is declared in more than one, and a space miss names the available spaces instead of falling back. `match` locates a span inside the named declaration (narrow a tie with `pick <range>`, whose coordinates are the 1-based file-absolute positions of the numbered current-source block); a viewer renders the numbered declaration with `⁉️` on the matched lines. `replace with <fence>` rewrites the target: open the body with `TC_EDIT_BEGIN` on its own line and close it with `TC_EDIT_END` on its own line. The body is raw text, so `-----`, six backticks, `done`, and `end` are ordinary body lines. The fence close terminates the replacement; do not add `end` after it. A bare `select … replace with <fence>` with no `match` rewrites the whole declaration; an empty body deletes it. Keep the same declaration kind and name unless the task requires otherwise. Imports and exports have no declaration address: use the file-level form `select file <path> [ match (<snippet> | /regex/) ] [ pick <range> ] replace with <fence>`, whose target must resolve to exactly one import/export statement or a span inside one; an empty body deletes the statement or specifier. A file-level `rename` is rejected because imported bindings and export aliases have no declaration address, so edit the statement text instead. No markdown fences around the reply and no explanations, and no JSON edit payload — it is rejected.";
export const EDIT_DSL_CREATE_DELETE_SYSTEM_PARAGRAPH =
  'A kind-aware create adds one named declaration or member: `create [static] <kind> <name> in <path> with TC_EDIT_BEGIN … TC_EDIT_END`; the close terminates the create, so do not add `end` after it. Top-level kinds are `function`, `class`, `interface`, `type`, `enum`, `namespace`, `const`, `let`, `var`, and `using`; member kinds are `method`, `property`, `getter`, `setter`, `accessor`, `constructor`, and `enum-member`. Use a dotted `Owner.name` for a member (or `create constructor Owner …`); the owner must already be a class/interface/namespace/enum, because a dotted create never creates its owner. The fence must declare exactly the descriptor name and kind; `static` is valid only on a class member and must match the fence member exactly. A module-boundary create is nameless: `create import in <path> with <fence>` or `create export in <path> with <fence>` adds exactly one import/export statement at the top of the file, after any shebang, directives, and existing imports; the fence must parse as one matching module statement, and an identical statement, a repeated import binding, or a second default export is rejected. An implicit create remains available: a whole-declaration `select … replace with <fence>` clause whose symbol is absent appends the fence as a new top-level declaration, creating the file and parent directories; a complete declaration is appended verbatim, otherwise the clause\'s `resolve` picks the wrapper (no `resolve`/`resolve value` as `let <symbol> = <body>;`, `resolve type` as `type <symbol> = <body>;`, `resolve namespace` as `namespace <symbol> { … }`). A "delete" selection carries no clause: the harness removes the declaration. To remove only part of a declaration, use `match` with an empty body. The syntax gate discards any clause that leaves the file unparseable and writes nothing; the clauses that resolve apply independently.';
export const EDIT_DSL_FS_SYSTEM_PARAGRAPH =
  "Raw file commands may accompany or replace the select workflow: `create <path> end` creates an empty file (it must not already exist), `create [static] <kind> <name> in <path> with <fence>` adds one declaration or member, `create import|export in <path> with <fence>` adds one module-boundary statement, `delete <path> end` removes it, `read <path> [within <selecters>] end` shows the file or selected lines without writing, and `write <path> [within <selecters>] with <fence>` writes the whole file or replaces the selected lines (creating the file when absent). A path that does not exist is created by `write`; a missing symbol in an editor still appends. A reply may carry several statements; the editing statements apply atomically, while a failed `read` only reports its error and never discards them. A `read` sees the source as it was before the reply. File commands and a `select` may not be mixed in the first reply; after the first target is pinned they may be mixed. After a target is pinned, `check end` runs the task's check command and `test end` runs its test command; each is a standalone self-check, writes nothing, and returns a bounded result. A self-check reply must contain exactly one of those commands and no edit, read, select, JSON, or prose; it may be repeated as needed.";

// The first thing the model reads: name the protocol and show the reply shape
// before the motivation paragraphs. The detailed grammar still follows below;
// this block is the anchor a small model can copy on the first turn.
export const EDIT_DSL_AT_A_GLANCE =
  "This is the Edit-action DSL. Reply with one or more `select` clauses or file commands, never JSON or prose; a replacement ends at its fence close, while a viewer or rename ends with `end`. At a glance: a bare `select <symbol> in <path> end` is a viewer; `select <symbol> in <path> [ match … ] [ pick … ] replace with <fence>` edits; `select file <path> [ match … ] [ pick … ] replace with <fence>` edits an import/export statement; `select <symbol> in <path> rename <old> to <new> end` renames; `create [static] <kind> <name> in <path> with <fence>` adds one declaration or member; `create import|export in <path> with <fence>` adds one module-boundary statement; `create <path> end` creates an empty file. After a target is pinned, a standalone `check end` runs the task's check command and `test end` runs its test command; neither writes.";

// #25: why this protocol, then a one-line map from intent to tool. The clause
// syntax follows in the four paragraphs; few-shot examples stay in
// `editDslInstruction()` so read turns do not pay for them.
export const EDIT_DSL_ROLE =
  "You are a TypeScript expert using the Edit-action DSL to modify source code.";
export const EDIT_DSL_MOTIVATION =
  "Edits are small and addressable: a clause names one declaration or span instead of resending a whole file. Editing clauses in one reply apply atomically; a failed read writes nothing. Every write passes the parse gate, formatter, and verification.";

// #56: the pinned-repair turn gets no tool definitions. This names that absence
// and the literal text form up front, mirroring the plan-exec executor contract
// without any node/DAG language.
export const EDIT_DSL_OUTPUT_CONTRACT =
  "Output contract (binding): No tools are available on this turn; `read`, `select`, `write`, `create`, `delete`, `check`, and `test` are literal edit-dsl text commands, not function calls. Never emit `<|...|>`, `<｜...｜>`, or any DSML/tool-call markup. The block opened by `TC_EDIT_BEGIN` and closed by `TC_EDIT_END` is plain text: it is not a Markdown code fence and not a tool-call boundary. Reply with edit-dsl only: no prose preamble, no Markdown fence around the reply, no JSON.";

// The one detailed fold explanation (system prompt). The read/command prompts
// carry only the short hint below; the edit instruction teaches the workflow.
export const EDIT_DSL_FOLD_DETAIL =
  "A source block longer than 6 lines folds by indentation when it has nested blocks, otherwise it keeps only its first 3 and last 3 lines. The folded line is `... // content folded, <path>: N-ML (H of T lines hidden); expand with read <path> within N-M end`: it names the hidden file-absolute lines, how many of the block's lines are hidden, and the command that expands exactly that range. A whole-file `read` is folded the same way, so repeating it returns the same outline; a `read within` is the expansion and returns the selected lines unfolded (`within {a-b, c-d}` expands several ranges). When a repair spans several declarations, or repeated localized edits keep introducing new tsc/test errors, use a whole-file `write <path> with <fence>` instead of more local edits.";

export const EDIT_DSL_WORKFLOW_SUMMARY =
  "Workflow: pin one target with `select` (or a raw command), inspect it, then edit the smallest span with `match`/`pick`; on a verification failure repair the same declaration; escalate to a whole-file `write` when the repair outgrows one declaration or localized edits keep adding errors; if no operation fits, explore with `read`/`select` viewers first. After a target is pinned, use a standalone `check end` or `test end` when a compile/test result would change the next edit; these are inspection turns, not edits. For a new large file or module, one whole-file `write` scaffold of the public types, signatures, and stub bodies is often cheapest, with later additions as targeted edits or `create`, because dozens of separate initial `create` clauses usually cost more and are easier to break. A large `write` remains valid: this is advice, not a size or clause-count cap.";

// #25: read turns are the token storm, so they carry only this terse hint.
export const EDIT_DSL_FOLD_HINT =
  "A folded block names its hidden range and line counts; a whole-file `read` is folded the same way. Expand it with `read <path> within <start>-<end> end`, which returns those lines unfolded, instead of repeating the read; when a repair outgrows one declaration, use `write <path> with <fence>`.";

export const EDIT_DSL_ROUNDS_SYSTEM_PARAGRAPH =
  "There is no fixed exchange or round cap: the run continues while it makes progress and ends when an edit verifies, when the USD cost budget is spent, or when the same reply/source/diagnostics repeats with no progress. When verification fails, the next attempt shows the current source and the failing diagnostics, and it may either revise the pinned declaration or re-pin to a different declaration in the same file by naming it in the clause's own `select` (the new address must resolve uniquely in the current source). A rejected or failing attempt is retried with its diagnostics and a correction; at a no-progress milestone the next attempt asks you to change the failing cause, or to reply `STOP` to end the run.";

export function buildEditDslSystemPrompt(): string {
  return assembleSystemPrompt(
    {
      select: EDIT_DSL_SELECT_SYSTEM_PARAGRAPH,
      edit: EDIT_DSL_EDIT_SYSTEM_PARAGRAPH,
      createDelete: `${EDIT_DSL_CREATE_DELETE_SYSTEM_PARAGRAPH}\n\n${EDIT_DSL_FS_SYSTEM_PARAGRAPH}\n\n${EDIT_DSL_FOLD_DETAIL}\n\n${EDIT_DSL_WORKFLOW_SUMMARY}`,
      rounds: EDIT_DSL_ROUNDS_SYSTEM_PARAGRAPH,
    },
    EDIT_DSL_ROLE,
    [EDIT_DSL_AT_A_GLANCE, EDIT_DSL_MOTIVATION, EDIT_DSL_OUTPUT_CONTRACT],
  );
}

// EditDsl select-first index: one `select <name> in <path>` line per top-level
// declaration, deduped by path+name, with a `resolve` space only when the
// declaration occupies exactly one space (class/enum dual-space entries omit it).
// Test files are omitted: they are specifications, and a from-scratch fixture
// often contains only its test, whose helpers would otherwise be the sole anchor.
// Capped like the YAML context; a truncation note is a plain comment line.
export function buildEditDslSymbolIndex(index: SymbolIndex): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  let truncated = false;
  for (const entry of index.entries) {
    if (entry.locator.name.includes(".")) {
      continue;
    }
    // Tests are specifications, not edit targets: a from-scratch fixture often
    // contains only its test file, and advertising that file's helpers would
    // anchor the first select on the wrong file. Explicit test addresses still
    // resolve through the full index.
    if (entry.locator.path.endsWith(TEST_FILE_SUFFIX)) {
      continue;
    }
    const key = `${entry.locator.path}\u0000${entry.locator.name}`;
    if (seen.has(key)) {
      continue;
    }
    if (seen.size >= CONTEXT_SYMBOL_LIMIT) {
      truncated = true;
      break;
    }
    seen.add(key);
    const spaces = declarationSpaces(entry);
    const first = spaces[0];
    const resolve = spaces.length === 1 && first !== undefined ? ` resolve ${first}` : "";
    lines.push(`select ${entry.locator.name} in ${entry.locator.path}${resolve}`);
  }
  if (truncated) {
    lines.push(`# symbol index truncated at ${CONTEXT_SYMBOL_LIMIT} entries`);
  }
  return lines.join("\n");
}

export function editDslGoal(issue: string, indexText: string): string {
  return `# Goal\n\n${issue}\n\n# Symbol index\n\n${indexText}\n`;
}

// The Goal/index/details block shared by the edit-dsl retry and decision turns
// (#B4/#9). `preRenderedSource` keeps the repair-context shrink's partial,
// original-line-numbered view; otherwise `startLine` anchors the numbering.
export function editDslContextBlock(
  context: { issue: string; indexText: string; startLine?: number },
  currentSource: string,
  preRenderedSource: string | undefined,
): string {
  const editDslNumbered =
    preRenderedSource ?? numberLinesFrom(currentSource, context.startLine ?? 1, null, true);
  return `# Goal

${context.issue}

# Symbol index

${context.indexText}

# details

\`\`\`text
${editDslNumbered}
\`\`\``;
}

export function appendEditDslSpecFiles(prompt: string, specFiles: readonly SourceFile[]): string {
  return appendSpecSection(prompt, specFiles);
}

export const EDIT_DSL_FIRST_TURN_GUIDE = `Reply with exactly one \`select … end\` clause (a viewer, or a direct editor when you already know the change), or one or more raw file commands. Do not reply with prose or JSON.

For example, to inspect the declaration named "answer" in src/a.ts:

select answer in src/a.ts resolve value
end`;

export function buildEditDslUserPrompt(
  issue: string,
  indexText: string,
  specFiles: readonly SourceFile[] = [],
): string {
  return appendEditDslSpecFiles(
    `${editDslGoal(issue, indexText)}\n${EDIT_DSL_FIRST_TURN_GUIDE}\n`,
    specFiles,
  );
}

// The first-turn content prompt pins the selected declaration. A match viewer
// additionally passes the file-absolute lines its spans intersect, so the
// `# details` block marks them exactly like the edit-phase viewer feedback; a
// bare select viewer passes null and keeps the unmarked rendering.
export function buildEditDslDetailsPrompt(
  issue: string,
  indexText: string,
  symbolSource: string,
  specFiles: readonly SourceFile[] = [],
  startLine = 1,
  markedLines: ReadonlySet<number> | null = null,
  duplicateNote: string | null = null,
): string {
  const numbered = numberLinesFrom(symbolSource, startLine, markedLines, true);
  const note = duplicateNote === null ? "" : `\n${duplicateNote}\n`;
  const prompt = `${editDslGoal(issue, indexText)}\n# details\n\n\`\`\`text\n${numbered}\n\`\`\`\n${note}\n${editDslInstruction()}\n`;
  return appendEditDslSpecFiles(prompt, specFiles);
}

export function buildEditDslCreatePrompt(
  issue: string,
  indexText: string,
  path: string,
  specFiles: readonly SourceFile[] = [],
): string {
  const prompt = `${editDslGoal(issue, indexText)}\nTarget file:\n\n\`\`\`\n${path}\n\`\`\`\n\n${editDslCreateInstruction()}\n`;
  return appendEditDslSpecFiles(prompt, specFiles);
}

/** First content prompt after a first-turn raw file command pinned `path`. */
export function buildEditDslCommandPrompt(
  issue: string,
  indexText: string,
  path: string,
  source: string,
  specFiles: readonly SourceFile[] = [],
): string {
  const body =
    source === "" ? "(empty file)" : numberLinesFrom(source, 1, null, true, path, "file");
  const prompt = `${editDslGoal(issue, indexText)}\n# Target file\n\n\`\`\`\n${path}\n\`\`\`\n\n\`\`\`text\n${body}\n\`\`\`\n\n${EDIT_DSL_FOLD_HINT}\n\nReply with the next \`select … end\` clause or file command.\n`;
  return appendEditDslSpecFiles(prompt, specFiles);
}

/** Feedback after a read-only reply: show what was read, then ask for the next command. */
export function buildEditDslReadPrompt(
  issue: string,
  indexText: string,
  feedback: string,
  specFiles: readonly SourceFile[] = [],
): string {
  const prompt = `${editDslGoal(issue, indexText)}\n# read\n\n${feedback}\n\n${EDIT_DSL_FOLD_HINT}\n\nReply with the next \`select … end\` clause or file command.\n`;
  return appendEditDslSpecFiles(prompt, specFiles);
}

/** Retry prompt for a rejected raw file command (first turn or no pinned target). */
export function buildEditDslCommandRetryPrompt(
  issue: string,
  indexText: string,
  diagnostics: string,
): string {
  return `${editDslGoal(issue, indexText)}
The previous reply was rejected.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`

Reply with one \`select … end\` clause or one or more file commands (\`create\`, \`delete\`, \`read\`, \`write\`).
`;
}

// EditDsl confirmation turn (#B3): the verified declaration, then the one-line
// success offer. Deliberately concise — no few-shot examples here.
export function buildEditDslModifiedPrompt(
  issue: string,
  indexText: string,
  symbolSource: string,
  startLine: number,
  specFiles: readonly SourceFile[] = [],
): string {
  const numbered = numberLinesFrom(symbolSource, startLine, null, true);
  const prompt = `${editDslGoal(issue, indexText)}\n# modified text\n\n\`\`\`text\n${numbered}\n\`\`\`\n\nReply \`Great! I resolve this problem!\` if the goal is met; otherwise return one or more \`select … end\` edit clauses.\n`;
  return appendEditDslSpecFiles(prompt, specFiles);
}

// #111: the few-shot examples the fresh edit and modify-retry prompts carry.
// They show the §2 forms of `docs/edit-protocol.md` — a `resolve value` viewer, a bare
// declaration replace, a `match` + `pick` edit, a `match` + `replace` rewrite,
// a create (#117), and a viewer-then-editor multi-clause reply whose clauses
// target different declarations (#117/#41) — built with `serializeSelections`
// so the grammar stays the single source of truth.
// Each form is labelled so the examples are unambiguously separate.
export type EditDslExampleForm =
  | { label: string; selections: EditDslSelection[] }
  | { label: string; raw: string };

export const EDIT_DSL_EXAMPLE_FORMS: EditDslExampleForm[] = [
  {
    label: "1. Viewer: locates a matched span with `resolve value` and writes nothing.",
    selections: [
      {
        locator: { path: "src/x.ts", name: "f", kind: "function" },
        space: "value",
        matcher: { kind: "snippet", value: "Number.isNaN" },
        pick: null,
        replacement: null,
      },
    ],
  },
  {
    label: "2. Bare declaration replace: no `match` rewrites the whole declaration.",
    selections: [
      {
        locator: { path: "src/x.ts", name: "MAX_TOKENS", kind: "const" },
        space: null,
        matcher: null,
        pick: null,
        replacement: "const MAX_TOKENS = 8192;",
      },
    ],
  },
  {
    label: "3. `match` + `pick`: locate the candidates, then pick all of line 2 and edit it.",
    selections: [
      {
        locator: { path: "src/x.ts", name: "answer", kind: "function" },
        space: null,
        matcher: { kind: "snippet", value: "return 1;" },
        pick: [{ line: 2, column: 1, endLine: 2, endColumn: END_OF_LINE_COLUMN }],
        replacement: "return 2;",
      },
    ],
  },
  {
    label: "4. `match` + `replace`: rewrite the matched span inside the declaration.",
    selections: [
      {
        locator: { path: "src/x.ts", name: "clamp", kind: "function" },
        space: null,
        matcher: { kind: "snippet", value: "Number.isNaN" },
        pick: null,
        replacement: "Number.isFinite",
      },
    ],
  },
  {
    label:
      "5. Create: a whole-declaration replace with no `match` appends the declaration when the symbol (or the file) is absent.",
    selections: [
      {
        locator: { path: "src/new.ts", name: "make", kind: "function" },
        space: null,
        matcher: null,
        pick: null,
        replacement: "export function make(): number {\n  return 1;\n}",
      },
    ],
  },
  {
    label:
      "6. Viewer then editor: locate a span in one declaration, then edit a different declaration in the same reply.",
    selections: [
      {
        locator: { path: "src/x.ts", name: "parse", kind: "function" },
        space: null,
        matcher: { kind: "snippet", value: "return null;" },
        pick: null,
        replacement: null,
      },
      {
        locator: { path: "src/x.ts", name: "format", kind: "function" },
        space: null,
        matcher: { kind: "snippet", value: "return null;" },
        pick: null,
        replacement: "return undefined;",
      },
    ],
  },
  {
    label:
      "7. Folded view: a large block becomes an indentation outline or a six-line fallback; the marker names the exact range, and `read … within …` returns those lines unfolded.",
    raw: [
      "... // content folded, src/lisp.ts: 4-335L (332 of 338 lines hidden); expand with read src/lisp.ts within 4-335 end",
      "",
      "read src/lisp.ts within 4-335 end",
    ].join("\n"),
  },
  {
    label:
      "8. Whole-file repair: when a repair spans several declarations, send one whole-file write instead of more local edits.",
    raw: [
      "write src/lisp.ts with",
      "TC_EDIT_BEGIN",
      "// ... the complete repaired file ...",
      "TC_EDIT_END",
    ].join("\n"),
  },
  {
    label:
      "9. Kind-aware create: add one declaration or one member of an existing owner without rewriting the file.",
    raw: [
      "create method Parser.parseValue in src/parser.ts with",
      "TC_EDIT_BEGIN",
      "parseValue(): number {",
      "  return Number(this.value);",
      "}",
      "TC_EDIT_END",
      "",
      "create function parseJson in src/json.ts with",
      "TC_EDIT_BEGIN",
      "export function parseJson(text: string): unknown {",
      "  return JSON.parse(text);",
      "}",
      "TC_EDIT_END",
    ].join("\n"),
  },
  {
    label:
      "10. File-level select: edit an import/export statement or a specifier without a whole-file write.",
    selections: [
      {
        locator: { path: "src/parser.ts", name: "", kind: "file" },
        space: null,
        matcher: { kind: "snippet", value: 'import { trim } from "./strings";' },
        pick: null,
        replacement: 'import { trimEnd } from "./strings";',
      },
    ],
  },
  {
    label:
      "11. Module-boundary create: add one import or export statement at the top of an existing or new file.",
    raw: [
      "create import in src/parser.ts with",
      "TC_EDIT_BEGIN",
      'import { trimEnd } from "./strings";',
      "TC_EDIT_END",
      "",
      "create export in src/index.ts with",
      "TC_EDIT_BEGIN",
      'export * from "./parser";',
      "TC_EDIT_END",
    ].join("\n"),
  },
];

// Render the labelled forms with the grammar's own serializer, one blank line
// apart so the examples read as separate replies. Raw commands are shown with
// their own text, since the serializer only renders select clauses (viewers/renames still end with `end`).
export function renderEditDslExamples(): string {
  return EDIT_DSL_EXAMPLE_FORMS.map((form) =>
    "raw" in form
      ? `${form.label}\n\n${form.raw}`
      : `${form.label}\n\n${serializeSelections(form.selections)}`,
  ).join("\n\n");
}

/**
 * The edit-dsl edit instruction (#111): used by the fresh edit prompt and the
 * modify retry prompt. It
 * states the reply shape and clause semantics, shows the §2 examples (#117 adds
 * the create and viewer-then-editor forms; #25 adds fold expansion and the
 * whole-file `write` fallback), then teaches the ordered micro-operation
 * workflow. The fold explanation itself stays in the system prompt so read
 * turns do not repeat it.
 */
export function editDslInstruction(): string {
  return [
    "A reply is one or more `select` clauses (see the examples below; a replacement ends at its fence close, while a viewer or rename ends with `end`), optionally mixed with raw file commands (`create <path> end`, `create [static] <kind> <name> in <path> with <fence>`, `create import|export in <path> with <fence>`, `delete <path> end`, `read <path> [within <selecters>] end`, `write <path> [within <selecters>] with <fence>`), with no markdown fences around the reply and no explanations. Statements apply in document order and independently, and every clause in one reply must resolve to a different declaration `(path, symbol, kind)`; target one declaration at most once per reply, even with different `match` or `pick` spans, and split edits to one declaration across exchanges. A clause with neither `replace` nor `rename` is a viewer that writes nothing unless it contains `pick`; `pick` requires `replace` and is not a viewer form. `rename <old> to <new>` is the other editor form: it renames the selected declaration and its same-file references and cannot be combined with `pick` or `replace`.",
    "",
    "Each clause: `select <symbol> in <path>` names the declaration (an optional `kind` may precede the symbol), and `resolve <value|type|namespace>` selects the TypeScript symbol space when the name is declared in more than one. `match <snippet | /regex/>` locates a span inside it (narrow a tie with `pick <range>`, which requires `replace`); `replace with <fence>` rewrites the target: open the body with `TC_EDIT_BEGIN` on its own line and close it with `TC_EDIT_END` on its own line. The body is raw, so hyphen runs, backticks, `done`, and `end` are ordinary body lines. The `TC_EDIT_END` close terminates the replacement; do not add `end` after it. Alternatively, `rename <old> to <new>` renames the target declaration and every reference that resolves to it, including dotted namespace and member targets. Omit `match` for a whole-declaration rewrite; use an empty body to delete. Coordinates are the 1-based file-absolute positions of the numbered source block.",
    "",
    "Imports and exports have no declaration address. Use `select file <path> [ match (<snippet> | /regex/) ] [ pick <range> ] replace with <fence>`: the target must resolve to exactly one import/export statement or a specifier span inside one, multiple matches are rejected with candidates, a match outside an import/export statement is rejected, and an empty body deletes the selected statement or specifier. A file-level `rename` is rejected; edit the statement text instead. A file-level select is an editor, so it requires `replace`.",
    "",
    "To add one declaration without rewriting the file, use `create [static] <kind> <name> in <path> with <fence>`. Top-level kinds: `function`, `class`, `interface`, `type`, `enum`, `namespace`, `const`, `let`, `var`, `using`. Member kinds: `method`, `property`, `getter`, `setter`, `accessor`, `constructor`, `enum-member`. A member uses a dotted `Owner.name` (or `create constructor Owner …`), and the owner must already be a class/interface/namespace/enum; a dotted create never creates its owner. Declaration kinds with a dotted namespace owner add that namespace member. The fence must contain exactly that name and kind; `static` is valid only on a class member and must match the fence member. To add one import or export statement without a name, use `create import in <path> with <fence>` or `create export in <path> with <fence>`; the statement is inserted after the shebang, directives, and existing imports, and identical statements or repeated import bindings are rejected. A whole-declaration `select … replace` on an absent symbol still creates implicitly.",
    "",
    "A viewer's next prompt carries one numbered declaration block per clause with `⁉️` in the gutter on the matched lines.",
    "",
    "Examples (each block is a complete reply; the blank lines between blocks are not part of a reply):",
    "",
    renderEditDslExamples(),
    "",
    "End of examples. Do not wrap your own reply in those separators.",
    "",
    "Workflow — choose the smallest micro-operation that fits:",
    "",
    "1. Pin one target with `select … end` (or pin a file with a raw command).",
    "2. Inspect before editing: a block that shows `... // content folded ...` is large, and a whole-file `read` is folded the same way. Expand the hidden range with `read <path> within <start>-<end> end`, whose selected lines come back unfolded; never repeat the same whole-file `read`, because it returns the same folded view.",
    "3. Localized repair: use `match` (add `pick` when a tie remains) to change the smallest span; use a bare declaration `replace` only when rewriting the whole declaration.",
    "4. Verification failure: use the diagnostics to repair the same declaration; do not resend an identical edit.",
    "5. Escalation: when a repair spans several declarations, or repeated localized edits keep introducing new tsc/test errors, switch to a whole-file `write <path> with <fence>`.",
    "6. No listed micro-operation fits: explore autonomously with `read`/`select` viewers (narrow reads first), then edit; do not burn exchanges repeating a read you already made.",
  ].join("\n");
}

/**
 * The edit-dsl create instruction (#111): the create-mode counterpart of
 * `editDslInstruction()`. It teaches that a whole-declaration
 * `select … replace with <fence>` clause becomes an *append* when the
 * symbol — or the whole file — is absent, and that such a create clause takes
 * neither `match` nor `pick`. A complete declaration is appended verbatim; any
 * other body is wrapped by the clause's `resolve` space (`let` by default).
 */
export function editDslCreateInstruction(): string {
  return [
    'The pinned selection uses mode "create", so reply with a create statement or a whole-declaration `select … replace with <fence>` clause. To add exactly one named declaration or member, use `create [static] <kind> <name> in <path> with <fence>`: top-level kinds are `function`, `class`, `interface`, `type`, `enum`, `namespace`, `const`, `let`, `var`, and `using`; member kinds are `method`, `property`, `getter`, `setter`, `accessor`, `constructor`, and `enum-member`. A member uses a dotted `Owner.name` (or `create constructor Owner …`), and the owner must already be a class/interface/namespace/enum; a dotted create never creates its owner. The fence must contain exactly the descriptor name and kind, and the descriptor `static` must match the fence member. To add one import or export statement, use the nameless module form `create import in <path> with <fence>` or `create export in <path> with <fence>`: the fence must be exactly one matching module statement, inserted after the shebang, directives, and existing imports; an identical statement or repeated import binding is rejected. `create <path> end` still creates an empty file.',
    "",
    "An implicit create remains available: a whole-declaration `select <symbol> in <path> [ resolve <value|type|namespace> ] replace with <fence>` clause with a non-empty body creates the declaration when the symbol — or the whole file — is absent, creating the file and its parent directories if needed. A complete top-level declaration in the fence is appended verbatim; any other body is wrapped by the clause's symbol space: no `resolve` or `resolve value` wraps it as `let <symbol> = <body>;`, `resolve type` as `type <symbol> = <body>;`, and `resolve namespace` as a `namespace <symbol> { … }` block.",
    "",
    "A create clause does not take `match` or `pick`. The replacement must keep the file parseable.",
    "",
    editDslInstruction(),
  ].join("\n");
}

/** Edit-dsl edit prompt for the pinned declaration. */
export function buildEditDslEditPrompt(addressJson: string, symbolSource: string): string {
  const numbered = numberedSourceBlock(symbolSource);
  return `${editDslInstruction()}

Pinned selection:

\`\`\`json
${addressJson}
\`\`\`

Current source:

Each line below is prefixed with its 1-based line number (the optional "range" coordinates; columns count the source text after the \`N | \` prefix).

\`\`\`ts
${numbered}\n\`\`\`
`;
}

/** Edit-dsl create prompt for the pinned create selection. */
export function buildEditDslPinnedCreatePrompt(addressJson: string, path: string): string {
  return `${editDslCreateInstruction()}

Target file:

\`\`\`
${path}
\`\`\`

Pinned selection:

\`\`\`json
${addressJson}
\`\`\`
`;
}

/** EditDsl selection retry (#B4): Goal + symbol index, then the rejection. */
export function buildEditDslSelectionRetryPrompt(
  issue: string,
  indexText: string,
  diagnostics: string,
): string {
  return `${editDslGoal(issue, indexText)}
The previous selection was rejected.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`

Reply with ONLY one \`select … end\` clause naming one symbol-index entry.
`;
}

/**
 * EditDsl selection no-progress ask (#B4/#57): a repeated selection failure
 * milestone offers `STOP` or one corrected select clause. It names a
 * no-progress cadence, never a fixed selection budget: a run that keeps making
 * progress is bounded by the USD cost budget, not by this prompt.
 */
export function buildEditDslSelectionContinuationPrompt(input: {
  failedAttempts: number;
  issue: string;
  indexText: string;
  diagnostics: string;
  digest?: string;
  failureHistory?: string;
}): string {
  const digestSection =
    input.digest === undefined || input.digest.trim() === "" ? "" : `\n${input.digest}\n`;
  const failureHistorySection =
    input.failureHistory === undefined || input.failureHistory.trim() === ""
      ? ""
      : `\n${input.failureHistory}\n`;
  return `No progress: ${input.failedAttempts} consecutive failed selection attempts; no fixed selection budget applies. Reply STOP to end the run, or return one \`select … end\` clause naming a symbol-index entry or a raw file command.

${editDslGoal(input.issue, input.indexText)}
Diagnostics:

\`\`\`
${input.diagnostics}
\`\`\`
${failureHistorySection}${digestSection}`;
}
