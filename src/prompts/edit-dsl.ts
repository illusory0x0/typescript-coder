import { END_OF_LINE_COLUMN, serializeSelections } from "../selection";
import type { Selection as EditDslSelection } from "../selection";
import { declarationSpaces } from "../utility";
import type { SourceFile, SymbolIndex } from "../utility";
import {
  appendSpecSection,
  assembleSystemPrompt,
  CONTEXT_SYMBOL_LIMIT,
  MAX_EDIT_EXCHANGES,
  numberLinesFrom,
  numberedSourceBlock,
  TEST_FILE_SUFFIX,
} from "./shared";

// #119 edit-dsl protocol (`--protocol-format=edit-dsl`, formerly the #117 forced
// mode): the system prompt teaches `select … end` clauses in place of the JSON
// edit rule, and the pick turn itself is a single select clause. The `json`
// format never uses these paragraphs.
export const EDIT_DSL_SELECT_SYSTEM_PARAGRAPH =
  "First you will be asked to select the target. Reply with ONLY one `select <symbol> in <path> [ resolve <value|type|namespace> ] end` clause naming one symbol-index entry; the clause is a viewer unless it carries `replace`, and a viewer leads to a `# details` prompt before the edit. Keep the reply to that one clause with no prose and no JSON.";
export const EDIT_DSL_EDIT_SYSTEM_PARAGRAPH =
  "Then you will be asked to edit the selected symbol. Reply with ONLY one or more `select … end` clauses: `select <symbol> in <path> [ resolve <value|type|namespace> ] [ match (<snippet> | /regex/) ] [ [ pick <range> ] replace with <fence> ] end` (an optional declaration `kind` may precede the symbol). Clauses apply in document order and independently; a clause that stops before `replace` is a viewer that locates and writes nothing unless it contains `pick`; `pick` requires `replace` and is not a viewer form. `resolve value`, `resolve type`, or `resolve namespace` selects the TypeScript symbol space when the same name is declared in more than one, and a space miss names the available spaces instead of falling back. `match` locates a span inside the named declaration (narrow a tie with `pick <range>`, whose coordinates are the 1-based file-absolute positions of the numbered current-source block); a viewer renders the numbered declaration with `⁉️` on the matched lines. `replace with <fence>` rewrites the target, and the fence opens with 6 or more backticks and closes with the same run. A bare `select … replace with … end` with no `match` rewrites the whole declaration; an empty fence deletes it. Keep the same declaration kind and name unless the task requires otherwise. No markdown fences around the reply and no explanations, and no JSON edit payload — it is rejected.";
export const EDIT_DSL_CREATE_DELETE_SYSTEM_PARAGRAPH =
  'A "create" selection asks for the COMPLETE declaration in the fence, which opens with 6 or more backticks; the harness appends it to the target file as a new top-level declaration, creating the file and any parent directories when needed. A complete top-level declaration is appended verbatim; otherwise the clause\'s `resolve` picks the wrapper: no `resolve` or `resolve value` wraps the body as `let <symbol> = <body>;`, `resolve type` as `type <symbol> = <body>;`, and `resolve namespace` as a `namespace <symbol> { … }` block. A "delete" selection carries no clause: the harness removes the declaration. To remove only part of a declaration, use `match` with an empty fence. The syntax gate discards any clause that leaves the file unparseable and writes nothing; the clauses that resolve apply independently.';
export const EDIT_DSL_ROUNDS_SYSTEM_PARAGRAPH =
  "A round allows at most 3 exchanges: picking the target, writing the edit, and re-asking after a rejected edit share that budget. When an edit verifies, the run is done; when verification fails, the next round shows the current source and the failing diagnostics, and it may either revise the pinned declaration or re-pin to a different declaration in the same file by naming it in the clause's own `select` (the new address must resolve uniquely in the current source). A round that exhausts its 3 exchanges without a valid edit continues through a continuation prompt: reply `STOP` to end the run, or return a corrected edit (or, when no target is pinned, a corrected selection) to open a fresh round with a new 3-exchange budget; the run is capped at 32 rounds, after which it ends with the failure summary.";

export function buildEditDslSystemPrompt(multiPayload = false): string {
  return assembleSystemPrompt(
    {
      select: EDIT_DSL_SELECT_SYSTEM_PARAGRAPH,
      edit: EDIT_DSL_EDIT_SYSTEM_PARAGRAPH,
      createDelete: EDIT_DSL_CREATE_DELETE_SYSTEM_PARAGRAPH,
      rounds: EDIT_DSL_ROUNDS_SYSTEM_PARAGRAPH,
    },
    multiPayload,
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
    preRenderedSource ?? numberLinesFrom(currentSource, context.startLine ?? 1);
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

export function buildEditDslUserPrompt(
  issue: string,
  indexText: string,
  specFiles: readonly SourceFile[] = [],
): string {
  return appendEditDslSpecFiles(editDslGoal(issue, indexText), specFiles);
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
  const numbered = numberLinesFrom(symbolSource, startLine, markedLines);
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

// EditDsl confirmation turn (#B3): the verified declaration, then the one-line
// success offer. Deliberately concise — no few-shot examples here.
export function buildEditDslModifiedPrompt(
  issue: string,
  indexText: string,
  symbolSource: string,
  startLine: number,
  specFiles: readonly SourceFile[] = [],
): string {
  const numbered = numberLinesFrom(symbolSource, startLine);
  const prompt = `${editDslGoal(issue, indexText)}\n# modified text\n\n\`\`\`text\n${numbered}\n\`\`\`\n\nReply \`Great! I resolve this problem!\` if the goal is met; otherwise return one or more \`select … end\` edit clauses.\n`;
  return appendEditDslSpecFiles(prompt, specFiles);
}

// #111: the few-shot examples the fresh edit and modify-retry prompts carry
// under the edit-dsl protocol (`--protocol-format=edit-dsl`). They show the §8
// forms of `docs/edit-protocol.md` — a `resolve value` viewer, a bare
// declaration replace, a `match` + `pick` edit, a `match` + `replace` rewrite,
// a create (#117), and a viewer-then-editor multi-clause reply (#117) — built
// with `serializeSelections` so the grammar stays the single source of truth.
// Each form is labelled so the examples are unambiguously separate. The block
// never appears under the `json` format.
export const EDIT_DSL_EXAMPLE_FORMS: { label: string; selections: EditDslSelection[] }[] = [
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
      "6. Viewer then editor: locate a span in one clause, then edit it in a second clause of the same reply.",
    selections: [
      {
        locator: { path: "src/x.ts", name: "parse", kind: "function" },
        space: null,
        matcher: { kind: "snippet", value: "return null;" },
        pick: null,
        replacement: null,
      },
      {
        locator: { path: "src/x.ts", name: "parse", kind: "function" },
        space: null,
        matcher: { kind: "snippet", value: "return null;" },
        pick: null,
        replacement: "return undefined;",
      },
    ],
  },
];

// Render the labelled forms with the grammar's own serializer, one blank line
// apart so the examples read as separate replies.
export function renderEditDslExamples(): string {
  return EDIT_DSL_EXAMPLE_FORMS.map(
    (form) => `${form.label}\n\n${serializeSelections(form.selections)}`,
  ).join("\n\n");
}

/**
 * The edit-dsl edit instruction (#111): replaces the JSON instruction in the
 * fresh edit prompt and the modify retry prompt under the edit-dsl format. It
 * states the reply shape, the document-order/independent application, and the
 * viewer semantics, then shows the §8 examples (#117 adds the create and the
 * viewer-then-editor forms).
 */
export function editDslInstruction(): string {
  return [
    "A reply is one or more `select … end` clauses (see the examples below), with no markdown fences around the reply and no explanations. Clauses apply in document order and independently; a clause that stops before `replace` is a viewer that writes nothing unless it contains `pick`; `pick` requires `replace` and is not a viewer form.",
    "",
    "Each clause: `select <symbol> in <path>` names the declaration (an optional `kind` may precede the symbol), and `resolve <value|type|namespace>` selects the TypeScript symbol space when the name is declared in more than one. `match <snippet | /regex/>` locates a span inside it (narrow a tie with `pick <range>`, which requires `replace`); `replace with <fence>` rewrites the target, where the fence opens with 6 or more backticks and closes with the same run. Omit `match` for a whole-declaration rewrite; use an empty fence to delete. Coordinates are the 1-based file-absolute positions of the numbered source block.",
    "",
    "A viewer's next prompt carries one numbered declaration block per clause with `⁉️` in the gutter on the matched lines.",
    "",
    "Examples:",
    "",
    "```````",
    renderEditDslExamples(),
    "```````",
  ].join("\n");
}

/**
 * The edit-dsl create instruction (#111): the create-mode counterpart of
 * `editDslInstruction()`. It teaches that a whole-declaration
 * `select … replace with <fence> end` clause becomes an *append* when the
 * symbol — or the whole file — is absent, and that such a create clause takes
 * neither `match` nor `pick`. A complete declaration is appended verbatim; any
 * other body is wrapped by the clause's `resolve` space (`let` by default).
 */
export function editDslCreateInstruction(): string {
  return [
    'The pinned selection uses mode "create", so reply with a create clause. A whole-declaration `select <symbol> in <path> [ resolve <value|type|namespace> ] replace with <fence> end` clause with a non-empty fence creates the declaration, where the fence opens with 6 or more backticks: when the symbol — or the whole file — is absent the harness appends the COMPLETE declaration in the fence as a new top-level declaration, creating the file and its parent directories if needed.',
    "",
    "A complete top-level declaration in the fence is appended verbatim. Any other body is wrapped by the clause's symbol space: no `resolve` or `resolve value` wraps it as `let <symbol> = <body>;`, `resolve type` as `type <symbol> = <body>;`, and `resolve namespace` as a `namespace <symbol> { … }` block.",
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

/** EditDsl selection continuation (#B4): STOP or one select clause, same shape. */
export function buildEditDslSelectionContinuationPrompt(input: {
  round: number;
  maxRounds: number;
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
  return `Round ${input.round} of ${input.maxRounds} exhausted its ${MAX_EDIT_EXCHANGES}-exchange selection budget without a valid selection. Reply STOP to end the run, or return one \`select … end\` clause naming a symbol-index entry.

${editDslGoal(input.issue, input.indexText)}
Diagnostics:

\`\`\`
${input.diagnostics}
\`\`\`
${failureHistorySection}${digestSection}`;
}
