import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyMatcherSplice, extractJsonObject, findMatcher, stripCodeFences } from "./matcher";
import type { MatcherResult } from "./matcher";
import {
  END_OF_LINE_COLUMN,
  parseSelection,
  serializeSelections,
  SelectionSyntaxError,
} from "./selection";
import type { Selection as EditDslSelection } from "./selection";
import {
  duplicateDeclarationNote,
  markedViewerLines,
  markerGutter,
  renderViewerFeedback,
  resolveEditDslReply,
} from "./edit-dsl";
import type { EditDslFailure, EditDslRegion, EditDslResolution, EditDslViewer } from "./edit-dsl";
import { formatSource } from "./editor";
import { LexError } from "./lexer";
import { ParseError, Parser } from "./parser";
import { buildIndexTolerant, declarationSpaces } from "./utility";
import { buildSignatureViewFromEntry } from "./scroll";
import { checkTool, testTool } from "./tools";
import { usageFromRaw } from "./replay-format";
import { ChatContextOverflowError, ChatPayloadTooLargeError } from "./openai";
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ReasoningEffort,
  ToolDefinition,
} from "./openai";
import type { Expression, Node, Program, Statement } from "./parser";
import type { SelectionStage } from "./cascade";
import type { CheckDiagnostic, CommandResult } from "./tools";
import type {
  IndexEntry,
  Locator,
  SkippedFile,
  SourceFile,
  SymbolIndex,
  SymbolSpace,
  TolerantIndex,
} from "./utility";

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "tmp"]);
const CONTEXT_SYMBOL_LIMIT = 500;
const SIGNATURE_LIMIT = 200;
export const SPEC_FILE_LIMIT = 8000;
const TEST_FILE_SUFFIX = ".test.ts";
// Path-like tokens in the issue text, e.g. `src/lisp.ts` inside backticks.
const ISSUE_PATH_PATTERN = /[\w./-]+\.ts\b/g;

function comparePaths(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function collectSourcePaths(directory: string, paths: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      collectSourcePaths(join(directory, entry.name), paths);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      paths.push(join(directory, entry.name));
    }
  }
}

export function discoverSourceFiles(cwd: string): SourceFile[] {
  const paths: string[] = [];
  collectSourcePaths(cwd, paths);
  return paths
    .map((path) => relative(cwd, path).split(sep).join("/"))
    .sort(comparePaths)
    .map((path) => ({ path, source: readFileSync(join(cwd, path), "utf8") }));
}

export function selectSpecFiles(issue: string, files: readonly SourceFile[]): SourceFile[] {
  const mentioned = new Set<string>();
  for (const token of issue.match(ISSUE_PATH_PATTERN) ?? []) {
    mentioned.add(token.startsWith("./") ? token.slice(2) : token);
  }
  const selected = new Map<string, SourceFile>();
  for (const file of files) {
    if (basename(file.path).endsWith(TEST_FILE_SUFFIX) || mentioned.has(file.path)) {
      selected.set(file.path, file);
    }
  }
  return [...selected.values()].sort((left, right) => comparePaths(left.path, right.path));
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlSignature(signature: string): string {
  const collapsed = signature.replace(/\s*\n\s*/g, " ").trim();
  const shown =
    collapsed.length > SIGNATURE_LIMIT ? `${collapsed.slice(0, SIGNATURE_LIMIT)}...` : collapsed;
  return yamlString(shown);
}

export function buildContextYaml(files: SourceFile[], build?: TolerantIndex): string {
  const { index, skipped } = build ?? buildIndexTolerant(files);
  const groups = new Map<string, IndexEntry[]>();
  for (const entry of index.entries) {
    const group = groups.get(entry.locator.path);
    if (group === undefined) {
      groups.set(entry.locator.path, [entry]);
    } else {
      group.push(entry);
    }
  }
  const sourceByPath = new Map(files.map((file) => [file.path, file.source]));
  const ordered = [...files].sort((left, right) => comparePaths(left.path, right.path));
  const lines = ["files:"];
  let emitted = 0;
  let truncated = false;
  for (const file of ordered) {
    if (truncated) {
      break;
    }
    const entries = groups.get(file.path) ?? [];
    if (entries.length > 0 && emitted >= CONTEXT_SYMBOL_LIMIT) {
      truncated = true;
      break;
    }
    lines.push(`  - path: ${yamlString(file.path)}`);
    if (entries.length === 0) {
      lines.push("    symbols: []");
      continue;
    }
    lines.push("    symbols:");
    for (const entry of entries) {
      if (emitted >= CONTEXT_SYMBOL_LIMIT) {
        truncated = true;
        break;
      }
      const source = sourceByPath.get(file.path) ?? "";
      const signature = buildSignatureViewFromEntry(source, entry);
      lines.push(`      - name: ${yamlString(entry.locator.name)}`);
      lines.push(`        kind: ${yamlString(entry.locator.kind)}`);
      lines.push(`        signature: ${yamlSignature(signature)}`);
      emitted += 1;
    }
  }
  if (skipped.length > 0) {
    lines.push("skipped:");
    for (const file of skipped) {
      lines.push(`  - path: ${yamlString(file.path)}`);
      lines.push(`    message: ${yamlString(file.message)}`);
    }
  }
  if (truncated) {
    lines.push("truncated: true");
  }
  return `${lines.join("\n")}\n`;
}

// EditDsl select-first index: one `select <name> in <path>` line per top-level
// declaration, deduped by path+name, with a `resolve` space only when the
// declaration occupies exactly one space (class/enum dual-space entries omit it).
// Capped like the YAML context; a truncation note is a plain comment line.
export function buildEditDslSymbolIndex(index: SymbolIndex): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  let truncated = false;
  for (const entry of index.entries) {
    if (entry.locator.name.includes(".")) {
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

// Opt-in multi-payload protocol (#69): appended to the system prompt when the
// variant is enabled, so the default prompt stays byte-identical.
const MULTI_PAYLOAD_SYSTEM_PARAGRAPH =
  'The multi-payload protocol is enabled: one edit reply may instead carry several edits as {"payloads": [{"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}, ...]} — different files and/or several non-overlapping regions of one file. The first entry echoes the pinned selection exactly, and every other entry names its own declaration (it must resolve uniquely in its file). Same-file entries must address non-overlapping regions; overlapping regions reject the exchange. The exchange applies atomically: if any entry fails its own guard or two same-file entries overlap, nothing is written and the exchange is rejected naming every failing entry\'s cause. A single edit may still be sent as one flat object, and "create"/"delete" selections never batch.';

// #119 edit-dsl protocol (`--protocol-format=edit-dsl`, formerly the #117 forced
// mode): the system prompt teaches `select … end` clauses in place of the JSON
// edit rule, and the pick turn itself is a single select clause. The `json`
// format never uses these paragraphs.
const EDIT_DSL_SELECT_SYSTEM_PARAGRAPH =
  "First you will be asked to select the target. Reply with ONLY one `select <symbol> in <path> [ resolve <value|type|namespace> ] end` clause naming one symbol-index entry; the clause is a viewer unless it carries `replace`, and a viewer leads to a `# details` prompt before the edit. Keep the reply to that one clause with no prose and no JSON.";
const EDIT_DSL_EDIT_SYSTEM_PARAGRAPH =
  "Then you will be asked to edit the selected symbol. Reply with ONLY one or more `select … end` clauses: `select <symbol> in <path> [ resolve <value|type|namespace> ] [ match (<snippet> | /regex/) ] [ [ pick <range> ] replace with <fence> ] end` (an optional declaration `kind` may precede the symbol). Clauses apply in document order and independently; a clause that stops before `replace` is a viewer that locates and writes nothing unless it contains `pick`; `pick` requires `replace` and is not a viewer form. `resolve value`, `resolve type`, or `resolve namespace` selects the TypeScript symbol space when the same name is declared in more than one, and a space miss names the available spaces instead of falling back. `match` locates a span inside the named declaration (narrow a tie with `pick <range>`, whose coordinates are the 1-based file-absolute positions of the numbered current-source block); a viewer renders the numbered declaration with `⁉️` on the matched lines. `replace with <fence>` rewrites the target, and the fence opens with 6 or more backticks and closes with the same run. A bare `select … replace with … end` with no `match` rewrites the whole declaration; an empty fence deletes it. Keep the same declaration kind and name unless the task requires otherwise. No markdown fences around the reply and no explanations, and no JSON edit payload — it is rejected.";
const EDIT_DSL_CREATE_DELETE_SYSTEM_PARAGRAPH =
  'A "create" selection asks for the COMPLETE declaration in the fence, which opens with 6 or more backticks; the harness appends it to the target file as a new top-level declaration, creating the file and any parent directories when needed. A complete top-level declaration is appended verbatim; otherwise the clause\'s `resolve` picks the wrapper: no `resolve` or `resolve value` wraps the body as `let <symbol> = <body>;`, `resolve type` as `type <symbol> = <body>;`, and `resolve namespace` as a `namespace <symbol> { … }` block. A "delete" selection carries no clause: the harness removes the declaration. To remove only part of a declaration, use `match` with an empty fence. The syntax gate discards any clause that leaves the file unparseable and writes nothing; the clauses that resolve apply independently.';
const EDIT_DSL_ROUNDS_SYSTEM_PARAGRAPH =
  "A round allows at most 3 exchanges: picking the target, writing the edit, and re-asking after a rejected edit share that budget. When an edit verifies, the run is done; when verification fails, the next round shows the current source and the failing diagnostics, and it may either revise the pinned declaration or re-pin to a different declaration in the same file by naming it in the clause's own `select` (the new address must resolve uniquely in the current source). A round that exhausts its 3 exchanges without a valid edit continues through a continuation prompt: reply `STOP` to end the run, or return a corrected edit (or, when no target is pinned, a corrected selection) to open a fresh round with a new 3-exchange budget; the run is capped at 32 rounds, after which it ends with the failure summary.";

// #119: the protocol failure an edit-dsl round returns when the reply is not
// a `select … end` clause. A JSON edit payload never matches the edit-dsl grammar,
// so it is rejected here too.
export const EDIT_DSL_FORCE_DIAGNOSTICS =
  "stage: protocol\nthe reply must be one or more `select … end` clauses; a JSON edit payload is not accepted in this mode";

// #117/#119: under the edit-dsl protocol a `protocol` rejection means the reply
// was not `select … end` (usually a JSON edit payload). The retry must re-teach
// the edit-dsl form; the JSON-flavored #56 correction would drive the model
// straight back to the payload this mode rejects (the observed rep1
// `address ↔ protocol` loop).
const EDIT_DSL_PROTOCOL_CORRECTION =
  "Reply with one or more `select … end` clauses as the entire response (`select <symbol> in <path> [ resolve <value|type|namespace> ] [ match (<snippet> | /regex/) ] [ [ pick <range> ] replace with <fence> ] end`, where the fence opens with 6 or more backticks; a `pick` requires `replace`); a JSON edit payload is not accepted in this mode.";
const EDIT_DSL_PROTOCOL_ESCALATION =
  "This attempt MUST reply with only `select … end` clauses — one or more, with no prose, no markdown fences, and no JSON edit payload.";

export function buildSystemPrompt(multiPayload = false, format: ProtocolFormat = "json"): string {
  const lines = [
    "You are a TypeScript coding agent.",
    "",
    'First you will be asked to select the target. Reply with ONLY a JSON object {"mode": "modify", "path": ..., "symbol": ..., "kind": ...}: "mode" is "modify" (default), "create", or "delete"; the composite address {path, symbol, kind} must all match the symbol index exactly and "kind" is required.',
    "",
    'Then you will be asked to edit the selected symbol. Reply with ONLY one flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}: the address {path, symbol, kind} must echo the pinned selection (a verification-repair round may re-pin to another declaration in the same file), and the optional "matcher" is a complete snippet copied from the current source that is structurally matched inside the symbol (omit it for a whole-symbol rewrite). As an alternative to "matcher", an optional "range" {line, column, endLine, endColumn} addresses the span by 1-based inclusive positions relative to the numbered current-source block shown in the prompt (the range must sit inside the declaration; when both are sent "range" wins). The replacement is a drop-in for the addressed range: keep leading keywords and modifiers consistent (do not re-add `export` the declaration omitted). Keep the same declaration kind and name unless the task requires otherwise. At most one matcher or range per response; multiple changes happen across edit rounds. No markdown fences and no explanations.',
    "",
    'A "create" selection asks for the COMPLETE declaration in "replacement"; the harness appends it to the target file, creating the file and any parent directories when needed. A "delete" selection carries no edit payload: the harness removes the declaration. To remove only part of a declaration, use "modify" with an empty "replacement". The syntax gate discards any edit that leaves the file unparseable and writes nothing.',
    "",
    "A round allows at most 3 exchanges: picking the target, writing the edit, and re-asking after a rejected edit share that budget. When an edit verifies, the run is done; when verification fails, the next round shows the current source and the failing diagnostics, and it may either revise the pinned declaration or re-pin to a different declaration in the same file by returning that declaration's own {path, symbol, kind} (the new address must resolve uniquely in the current source). A round that exhausts its 3 exchanges without a valid edit continues through a continuation prompt: reply `STOP` to end the run, or return a corrected edit (or, when no target is pinned, a corrected selection) to open a fresh round with a new 3-exchange budget; the run is capped at 32 rounds, after which it ends with the failure summary.",
    "",
  ];
  // #119 the edit-dsl format teaches the select-first turn and the edit-dsl edit
  // rule in place of the JSON rule; the json format never uses these paragraphs.
  if (format === "edit-dsl") {
    lines[2] = EDIT_DSL_SELECT_SYSTEM_PARAGRAPH;
    lines[4] = EDIT_DSL_EDIT_SYSTEM_PARAGRAPH;
    lines[6] = EDIT_DSL_CREATE_DELETE_SYSTEM_PARAGRAPH;
    lines[8] = EDIT_DSL_ROUNDS_SYSTEM_PARAGRAPH;
  }
  if (multiPayload) {
    lines.splice(lines.length - 1, 0, MULTI_PAYLOAD_SYSTEM_PARAGRAPH, "");
  }
  return lines.join("\n");
}

// Keep the head (declarations and early cases) and the tail (final assertions,
// or the current source of the edited region) of an oversized source with an
// explicit marker in between.
function truncateSource(source: string): string {
  if (source.length <= SPEC_FILE_LIMIT) {
    return source;
  }
  const half = SPEC_FILE_LIMIT / 2;
  const head = source.slice(0, half);
  const tail = source.slice(source.length - half);
  const truncated = source.length - SPEC_FILE_LIMIT;
  return `${head}\n// ... [truncated ${truncated} characters] ...\n${tail}`;
}

function buildSpecSection(specFiles: readonly SourceFile[]): string {
  const lines = [
    "# Spec files",
    "",
    "These files are part of the specification; do not modify them.",
  ];
  for (const file of specFiles) {
    const source = truncateSource(file.source);
    const sourceLines = source.split("\n");
    const fence = sourceLines.some((line) => line.startsWith("```")) ? "````" : "```";
    lines.push("", `## ${file.path}`, "", `${fence}ts`, ...sourceLines, fence);
  }
  return lines.join("\n");
}

export function buildUserPrompt(
  issue: string,
  contextYaml: string,
  specFiles: readonly SourceFile[] = [],
): string {
  const body = contextYaml === "" || contextYaml.endsWith("\n") ? contextYaml : `${contextYaml}\n`;
  const prompt = `# Issue\n\n${issue}\n\n# Project context\n\n\`\`\`yaml\n${body}\`\`\`\n`;
  if (specFiles.length === 0) {
    return prompt;
  }
  return `${prompt}\n${buildSpecSection(specFiles)}\n`;
}

// Split a source into lines for rendering (a trailing newline does not add an
// empty final line, so an empty source has no lines).
function splitSourceLines(source: string): string[] {
  const lines = source.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

// Render the current-source block with 1-based line numbers so the optional
// `range` selector (#72) can be derived from the prompt. Columns count the
// source text after the `N | ` prefix.
export function numberedSourceBlock(source: string): string {
  const lines = splitSourceLines(source);
  const width = String(lines.length).length;
  return lines
    .map((line, index) => `${String(index + 1).padStart(width, " ")} | ${line}`)
    .join("\n");
}

// Render `source` with its file-absolute line numbers. `marked` is the set of
// file-absolute lines intersected by a matched span; when it is null the output
// carries no gutter at all (the bare viewer path), otherwise every line gets the
// shared `⁉️  `/blank gutter.
function numberLinesFrom(
  source: string,
  startLine: number,
  marked: ReadonlySet<number> | null = null,
): string {
  const lines = splitSourceLines(source);
  if (lines.length === 0) {
    return "";
  }
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, index) => {
      const lineNumber = startLine + index;
      const gutter = marked === null ? "" : markerGutter(marked.has(lineNumber));
      return `${gutter}${String(lineNumber).padStart(width, " ")} | ${line}`;
    })
    .join("\n");
}

// Render the declaration range with its FILE-absolute 1-based line numbers.
export function numberedSourceRange(source: string, start: number, end: number): string {
  const safeStart = Math.max(0, Math.min(start, source.length));
  const safeEnd = Math.max(safeStart, Math.min(end, source.length));
  const startLine = source.slice(0, safeStart).split("\n").length;
  return numberLinesFrom(source.slice(safeStart, safeEnd), startLine);
}

function editDslGoal(issue: string, indexText: string): string {
  return `# Goal\n\n${issue}\n\n# Symbol index\n\n${indexText}\n`;
}

// The Goal/index/details block shared by the edit-dsl retry and decision turns
// (#B4/#9). `preRenderedSource` keeps the repair-context shrink's partial,
// original-line-numbered view; otherwise `startLine` anchors the numbering.
function editDslContextBlock(
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

function appendEditDslSpecFiles(prompt: string, specFiles: readonly SourceFile[]): string {
  if (specFiles.length === 0) {
    return prompt;
  }
  return `${prompt}\n${buildSpecSection(specFiles)}\n`;
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

// The optional `(line,column)` selector offered alongside `matcher` (#72).
export const RANGE_SELECTOR_NOTE =
  'Optionally locate the span by its 1-based inclusive "range" ({line, column, endLine, endColumn}) copied from the numbered current-source lines; when both are sent "range" takes precedence over "matcher".';

// The bounded self-verification offer, added only to repair prompts (#73); the
// fresh post-pick edit prompt never carries it, so the no-repair path is
// byte-identical.
export const SELF_CHECK_OFFER =
  'Before editing, you may make at most one bounded self-verification request this round: reply with exactly {"request":"read"} (the pinned file\'s current source), {"request":"check"} (run the task\'s check command), or {"request":"test"} (run the task\'s test command); the harness runs it and returns a bounded result, then asks again.';

// #111: the few-shot examples the fresh edit and modify-retry prompts carry
// under the edit-dsl protocol (`--protocol-format=edit-dsl`). They show the §8
// forms of `docs/edit-protocol.md` — a `resolve value` viewer, a bare
// declaration replace, a `match` + `pick` edit, a `match` + `replace` rewrite,
// a create (#117), and a viewer-then-editor multi-clause reply (#117) — built
// with `serializeSelections` so the grammar stays the single source of truth.
// Each form is labelled so the examples are unambiguously separate. The block
// never appears under the `json` format.
const EDIT_DSL_EXAMPLE_FORMS: { label: string; selections: EditDslSelection[] }[] = [
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
function renderEditDslExamples(): string {
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
function editDslInstruction(): string {
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
function editDslCreateInstruction(): string {
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

export function buildEditPrompt(
  addressJson: string,
  symbolSource: string,
  multiPayload = false,
  format: ProtocolFormat = "json",
): string {
  const numbered = numberedSourceBlock(symbolSource);
  // #111: under the edit-dsl format the JSON instruction is replaced with the
  // clause instruction and its few-shot examples. Under `json` this is exactly
  // the pre-#111 string.
  const instruction =
    format === "edit-dsl"
      ? editDslInstruction()
      : multiPayload
        ? `Output ONE flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...} for the pinned symbol, or a multi-payload object {"payloads": [ ... ]} that batches edits — different files and/or several non-overlapping regions of one file — with no markdown fences and no explanations.

The first payload echoes the pinned address {path, symbol, kind}; every further payload names its own declaration, which must resolve to exactly one declaration in its file's current source. Same-file payloads must address non-overlapping regions. "matcher" is optional per payload: a complete snippet copied from the current source below; "replacement" replaces exactly the matched range. Omit "matcher" for a whole-symbol rewrite: "replacement" then replaces the whole declaration. ${RANGE_SELECTOR_NOTE} Keep leading keywords and modifiers consistent (do not re-add \`export\` the declaration omitted). Every replacement must keep its file parseable. The exchange applies atomically: if any payload fails its own guard or two same-file regions overlap, nothing is written and the exchange is rejected naming every failing payload.`
        : `Output ONE flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...} for the pinned symbol, with no markdown fences and no explanations.

Echo the pinned address {path, symbol, kind}. "matcher" is optional: a complete snippet copied from the current source below; "replacement" replaces exactly the matched range. Omit "matcher" for a whole-symbol rewrite: "replacement" then replaces the whole declaration. ${RANGE_SELECTOR_NOTE} Keep leading keywords and modifiers consistent (do not re-add \`export\` the declaration omitted). The replacement must keep the file parseable.`;
  return `${instruction}

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

// Explicit-targets mode (#81): names the pending target addresses the model must
// cover with a batch, one flat payload per file. Same-file targets are named one
// at a time because they are sequenced across exchanges. The same lead is
// repeated on a retry so a non-batch reply cannot pass.
export function buildTargetsEditPrompt(
  pinnedAddressJson: string,
  symbolSource: string,
  pending: readonly Locator[],
): string {
  const numbered = numberedSourceBlock(symbolSource);
  const listed = pending
    .map(
      (target) =>
        `- {"path": ${JSON.stringify(target.path)}, "symbol": ${JSON.stringify(target.name)}, "kind": ${JSON.stringify(target.kind)}}`,
    )
    .join("\n");
  return `Output the edit(s) for the requested targets, with no markdown fences and no explanations. Reply with a {"payloads": [ ... ]} object carrying exactly one flat edit payload per file: the first payload echoes the pinned address below, and each further payload names one of the other requested addresses (a different file). A single target may still be sent as one flat object. Every payload's address must be one of the requested targets, and at most one target per file may appear in one exchange — same-file targets are addressed in successive exchanges.

Requested targets:
${listed}

"matcher" is optional per payload: a complete snippet copied from the current source; omit it for a whole-symbol rewrite. ${RANGE_SELECTOR_NOTE} Keep leading keywords and modifiers consistent (do not re-add \`export\` the declaration omitted). Every replacement must keep its file parseable.

Pinned selection:

\`\`\`json
${pinnedAddressJson}
\`\`\`

Current source:

Each line below is prefixed with its 1-based line number (the optional "range" coordinates; columns count the source text after the \`N | \` prefix).

\`\`\`ts
${numbered}\n\`\`\`
`;
}

export function buildCreatePrompt(
  addressJson: string,
  path: string,
  format: ProtocolFormat = "json",
): string {
  const instruction =
    format === "edit-dsl"
      ? editDslCreateInstruction()
      : `The pinned selection uses mode "create". Output ONE flat JSON object {"path": ..., "symbol": ..., "kind": ..., "replacement": ...} with no markdown fences and no explanations: echo the pinned address {path, symbol, kind}, put the COMPLETE declaration in "replacement", and omit "matcher" and "range". The target file may not exist yet; the declaration is appended to it. The replacement must keep the file parseable.`;
  return `${instruction}

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

/**
 * The no-progress ask (#54/#60) facts the retry and continuation headers render.
 * The first ask is byte-identical to the original wording; from the second
 * decision point on the header is sharpened (#65) with the `history` fact.
 */
export interface StalledAsk {
  failedRounds: number;
  round: number;
  maxRounds: number;
  /**
   * 1-based decision-point number (`failedRounds / MAX_STALLED_ROUNDS`): 1 is the
   * first ask; 2+ fold in the unchanged/cycling fact and demand address-or-STOP.
   * Absent is treated as the first ask.
   */
  askNumber?: number;
  /** The `#71` failure pattern the sharpened ask names; null while still changing. */
  history?: FailurePattern | null;
}

export interface RetryPromptInput {
  /** 1-based exchange number the prompt requests inside the current Run iteration. */
  exchangeNumber: number;
  maxExchanges: number;
  /** `create` asks for the complete declaration; `modify` for the flat edit payload. */
  mode: "modify" | "create";
  /** Canonical pinned selection, `{mode, path, symbol, kind}`. */
  locatorJson: string;
  /** Current on-disk source of the selected region (whole file in create mode). */
  currentSource: string;
  /**
   * Optional pre-rendered `Current source:` block that replaces
   * `numberedSourceBlock(currentSource)`. The repair-context shrink supplies a
   * partial, original-line-numbered view here. Undefined keeps the prompt
   * byte-identical to the whole-file path.
   */
  preRenderedSource?: string;
  diagnostics: string;
  /** Verification retries say "failed verification"; edit retries say "failed". */
  failure: "edit" | "verification";
  /** True in a verification-repair iteration, where the pin may move to another declaration. */
  repin: boolean;
  /**
   * Round-level continuation (#52): replaces the exchange header with the
   * round-exhausted / STOP framing; this prompt and the no-progress ask (#54)
   * are the only ones that offer `STOP`.
   */
  continuation?: { round: number; maxRounds: number };
  /**
   * No-progress ask (#54): replaces the exchange header (and the corrective
   * action sentence) with the consecutive-failed-rounds framing; only the
   * first exchange of a stalled round sets it. From the second ask (#65) the
   * header names the unchanged/cycling failing set.
   */
  stalled?: StalledAsk;
  /**
   * Per-cause rejection correction (#56): replaces the default corrective lead
   * sentence with the class-specific action (or its escalation); `stalled`
   * takes precedence when both are present.
   */
  correction?: string;
  /**
   * Prior-attempts digest (#57): the bounded checkpoint appended after the
   * Diagnostics block. Only the #52 round-continuation prompts and the #54
   * no-progress ask carry it; ordinary retries stay unchanged.
   */
  digest?: string;
  /**
   * Failure history (#71): the bounded non-convergence note (unchanged failing
   * set or a two-state cycle), appended after the Diagnostics block and before
   * the digest; ordinary retries carry it too.
   */
  failureHistory?: string;
  /**
   * Stated re-approach (#75): the reply the model gave to the preceding
   * decision-only turn, rendered as an `Approach to apply:` block after the
   * Diagnostics block so the edit must follow it. Undefined/empty renders
   * nothing; the next exchange after a decision turn sets it.
   */
  approach?: string;
  /**
   * Opt-in multi-payload variant (#69): modify retries offer the
   * `{"payloads": [...]}` batch shape alongside the flat payload; off (the
   * default) keeps the exact single-payload instructions.
   */
  multiPayload?: boolean;
  /**
   * Edit protocol format (#119): `edit-dsl` renders the `select … end` clause
   * instruction; `json` (default) keeps the JSON templates.
   */
  protocolFormat?: ProtocolFormat;
  /**
   * EditDsl retry context (#B4): Goal + symbol index for the edit-dsl prompt
   * shape, plus the file-absolute start line of `currentSource`. Absent keeps
   * the JSON prompt byte-identical.
   */
  editDslContext?: { issue: string; indexText: string; startLine?: number };
  /**
   * Bounded self-verification result (#73), appended after the Diagnostics
   * block as a `Self-check result:` section. Rendered only on the prompt that
   * immediately follows the executed request; ordinary retries set nothing.
   */
  selfCheck?: string;
}

/** Multi-payload modify instruction (#69/#78): one flat payload or a same-file-or-cross-file batch. */
function multiModifyInstruction(
  lead: string,
  status: string,
  repin: boolean,
  modifierNote: string,
): string {
  const address = repin
    ? 'return the full address of the declaration you are fixing — either the pinned selection or a different declaration in the same file to re-pin and edit it (it must resolve uniquely in the current source) — or a {"payloads": [...]} object batching edits whose first entry carries that pinned-or-re-pinned address and each further entry names its own declaration, in the same or another file'
    : 'echo the pinned selection in the first payload\'s address — or, to batch edits, return a {"payloads": [...]} object whose first entry echoes the pinned selection and each further entry names its own declaration, in the same or another file';
  return `${lead} ${status}Output either ONE flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...} (${address}), or exactly that {"payloads": [ ... ]} batch shape. Same-file payloads must address non-overlapping regions. "matcher" is optional per payload: a snippet copied from the current source, or omit it for a whole-symbol rewrite; "replacement" replaces the matched range (empty removes it). ${RANGE_SELECTOR_NOTE} The exchange applies atomically: if any payload fails its own guard or two same-file regions overlap, nothing is written and the rejection names every failing payload. ${modifierNote} No markdown fences and no explanations.`;
}

/**
 * The no-progress ask header (#54). The first decision point renders the original
 * wording byte-for-byte; from the second on (#65) it names the unchanged/cycling
 * failing set the `#71 Failure history` note carries and requires the reply to
 * address it or `STOP`. STOP's meaning is unchanged and no cap or auto-stop is
 * added — the ask stays passable so a recovering cycle can continue.
 */
function stalledAskHeader(stalled: StalledAsk): string {
  const base = `No progress: ${stalled.failedRounds} consecutive failed rounds. This is round ${stalled.round} of ${stalled.maxRounds}.`;
  const askNumber = stalled.askNumber ?? 1;
  if (askNumber <= 1) {
    return `${base} Reply exactly \`STOP\` to end the run now, but only if the failures cannot be resolved; otherwise take a materially different approach rather than another minimal attempt.`;
  }
  const history =
    stalled.history?.kind === "unchanged"
      ? `the failing set is unchanged across the last ${stalled.history.rounds} verification rounds`
      : stalled.history?.kind === "alternating"
        ? `the failing set has cycled between two states across the last ${stalled.history.rounds} verification rounds`
        : "the failing set has not converged";
  return `${base} This is repeated ask ${askNumber} and the previous ask did not resolve it: ${history}, so another minimal edit at the same spot cannot help. This reply MUST either directly address that unchanged failing set — change the cause the diagnostics below name — or, only if it cannot be resolved, reply exactly \`STOP\` to end the run now.`;
}

/**
 * Decision-only turn instruction (#75), shown in place of the edit template on a
 * repeated no-progress ask whose `#71` pattern is non-converging. It keeps the
 * sharpened ask header, the failing diagnostics, and the failure history, and
 * offers only two replies: `STOP`, or a re-approach statement the next exchange
 * carries. No cap or auto-stop: a real edit reply is still a valid attempt.
 */
const DECISION_INSTRUCTION =
  "This is a decision turn: reply with a short re-approach statement — name what you will change (the cause) and where — instead of another edit payload. Reply exactly `STOP` to end the run now, but only if the failing set cannot be resolved. Do not send a JSON edit payload on this turn.";

/**
 * EditDsl decision-only instruction (#75/#9): the select-first counterpart of
 * `DECISION_INSTRUCTION`. It keeps the decision framing and STOP semantics but
 * names the clause reply shape instead of a JSON payload, so no bare JSON edit
 * teaching leaks into an edit-dsl turn.
 */
const DECISION_INSTRUCTION_EDIT_DSL =
  "This is a decision turn: reply with a short re-approach statement — name what you will change (the cause) and where — instead of another edit clause. Reply exactly `STOP` to end the run now, but only if the failing set cannot be resolved. Do not send an edit clause on this turn.";

/** Bound on the carried re-approach statement (#75); clamped like the digest states. */
export const APPROACH_LIMIT = 600;

/**
 * True when a decision-turn reply still carries a structurally valid edit
 * payload (#75): such a reply is a real attempt and flows through the unchanged
 * guards; any other reply is the stated re-approach. Mirrors the exchange
 * parser's opt-in multi-payload shape.
 */
function isEditPayloadReply(
  content: string,
  multiPayload: boolean,
  format: ProtocolFormat,
): boolean {
  if (multiPayload) {
    if (parseEditResponseList(content).ok) {
      return true;
    }
  } else {
    try {
      parseEditResponse(content);
      return true;
    } catch {
      // Fall through to the edit-dsl form under the edit-dsl format.
    }
  }
  // #111: under the edit-dsl format a reply of `select … end` clauses is also a
  // real attempt (an editor or a viewer locate turn).
  if (format === "edit-dsl") {
    try {
      return parseSelection(content).length > 0;
    } catch {
      return false;
    }
  }
  return false;
}

export function buildRetryPrompt(input: RetryPromptInput): string {
  const {
    exchangeNumber,
    maxExchanges,
    mode,
    locatorJson,
    currentSource,
    diagnostics,
    failure,
    repin,
  } = input;
  const remaining = Math.max(0, maxExchanges - exchangeNumber);
  const label = failure === "verification" ? "failed verification" : "failed";
  const numbered = input.preRenderedSource ?? numberedSourceBlock(currentSource);
  const sourceNote =
    input.preRenderedSource !== undefined
      ? "Each line below carries its ORIGINAL 1-based file line number; `// … [omitted: …] …` marks declarations left out of this partial view (their names are listed above)."
      : 'Each line below is prefixed with its 1-based line number (the optional "range" coordinates; columns count the source text after the `N | ` prefix).';
  // The splice tolerates a leading `export` that repeats the declaration's
  // existing modifier, so no re-add warning is needed (#48).
  const modifierNote =
    "A leading `export` matching the declaration's existing modifier is accepted.";
  const stalled = input.stalled;
  // No-progress ask (#54): the corrective lead is replaced by concrete
  // alternatives when the model has failed the same verification repeatedly.
  const stalledLead =
    mode === "modify"
      ? "Concretely: change the matcher shape, re-pin to a declaration the diagnostics name, or restructure the declaration."
      : "Concretely: restructure the declaration rather than repeating a minimal correction.";
  // Per-cause rejection correction (#56): replaces the default lead sentence;
  // the no-progress ask still wins when both are present.
  const modifyLead =
    stalled !== undefined
      ? stalledLead
      : (input.correction ?? "Make minimal corrective changes to the current source below.");
  const createLead =
    stalled !== undefined
      ? stalledLead
      : (input.correction ?? "Make minimal corrective changes to the complete declaration.");
  // Only an ordinary retry states where it sits in the exchange budget; the
  // #52 continuation and #54 stalled headers already frame the round.
  const status =
    stalled !== undefined || input.continuation !== undefined
      ? ""
      : `Edit exchange ${exchangeNumber} of ${maxExchanges} ${label}. ${remaining} exchange(s) remain in this iteration. `;
  const modifyInstruction =
    input.protocolFormat === "edit-dsl"
      ? `${modifyLead} ${status}${editDslInstruction()}`
      : input.multiPayload === true
        ? multiModifyInstruction(modifyLead, status, repin, modifierNote)
        : repin
          ? `${modifyLead} ${status}Output ONLY one flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}: return the full address of the declaration you are fixing — either the pinned selection or a different declaration in the same file to re-pin and edit it (it must resolve uniquely in the current source). "matcher" is optional: a snippet copied from the current source, or omit it for a whole-symbol rewrite; "replacement" replaces the matched range (empty removes it). ${RANGE_SELECTOR_NOTE} ${modifierNote} No markdown fences and no explanations.`
          : `${modifyLead} ${status}Output ONLY one flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}: echo the pinned selection in the address. "matcher" is optional: a snippet copied from the current source, or omit it for a whole-symbol rewrite; "replacement" replaces the matched range (empty removes it). ${RANGE_SELECTOR_NOTE} ${modifierNote} No markdown fences and no explanations.`;
  const createInstruction =
    input.protocolFormat === "edit-dsl"
      ? `${createLead} ${status}${editDslCreateInstruction()}`
      : `${createLead} ${status}Output ONLY one flat JSON object {"path": ..., "symbol": ..., "kind": ..., "replacement": ...}: echo the pinned selection in the address, put the COMPLETE corrected declaration in "replacement", and omit "matcher" and "range". No markdown fences and no explanations.`;
  const instruction = mode === "modify" ? modifyInstruction : createInstruction;
  const header =
    stalled !== undefined
      ? stalledAskHeader(stalled)
      : input.continuation === undefined
        ? ""
        : `Round ${input.continuation.round} of ${input.continuation.maxRounds} exhausted its ${maxExchanges}-exchange edit budget without a valid edit. Reply STOP to end the run, or return a corrected edit to continue with a fresh round.`;
  const digestSection =
    input.digest === undefined || input.digest.trim() === "" ? "" : `\n${input.digest}\n`;
  const failureHistorySection =
    input.failureHistory === undefined || input.failureHistory.trim() === ""
      ? ""
      : `\n${input.failureHistory}\n`;
  const selfCheckSection =
    input.selfCheck === undefined || input.selfCheck.trim() === ""
      ? ""
      : `\nSelf-check result:\n\n\`\`\`\n${input.selfCheck}\n\`\`\`\n`;
  const approachSection =
    input.approach === undefined || input.approach.trim() === ""
      ? ""
      : `\nApproach to apply:\n\n${input.approach}\n`;
  // Decision-only turn (#75): a repeated non-converging ask drops the edit
  // template (instruction, self-check offer, pinned selection, current source)
  // and keeps the sharpened header plus the failing diagnostics and history.
  if (stalled !== undefined && isDecisionAsk(stalled)) {
    // EditDsl decision-only turn (#9): keep the decision framing and STOP
    // semantics but render the Goal/index/details context and the clause shape.
    // The JSON decision turn below stays byte-identical.
    if (input.protocolFormat === "edit-dsl" && input.editDslContext !== undefined) {
      return `${header}

${editDslContextBlock(input.editDslContext, currentSource, input.preRenderedSource)}

${DECISION_INSTRUCTION_EDIT_DSL}

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`
${failureHistorySection}${digestSection}`;
    }
    return `${header}\n\n${DECISION_INSTRUCTION}\n\nDiagnostics:\n\n\`\`\`\n${diagnostics}\n\`\`\`\n${failureHistorySection}${digestSection}`;
  }
  // EditDsl retry/continuation (#B4): Goal + select-line symbol index + the
  // declaration details, with no JSON pinned-selection block. The edit-dsl
  // instruction already carries the clause rules, including create mode.
  // The self-check offer is JSON-only and is deliberately absent here (#9).
  if (input.protocolFormat === "edit-dsl" && input.editDslContext !== undefined) {
    return `${header === "" ? "" : `${header}\n\n`}${editDslContextBlock(input.editDslContext, currentSource, input.preRenderedSource)}

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`
${selfCheckSection}${approachSection}${failureHistorySection}${digestSection}
${instruction}`;
  }
  return `${header === "" ? "" : `${header}\n\n`}${instruction}

${SELF_CHECK_OFFER}

Pinned selection:

\`\`\`json
${locatorJson}
\`\`\`

Current source:

${sourceNote}

\`\`\`ts
${numbered}\n\`\`\`

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`
${selfCheckSection}${approachSection}${failureHistorySection}${digestSection}`;
}

export interface ContinuationPromptInput {
  /** Round that exhausted its exchange budget (1-based). */
  round: number;
  maxRounds: number;
  /** `create` asks for the complete declaration; `modify` for the flat edit payload. */
  mode: "modify" | "create";
  /** Canonical pinned selection, `{mode, path, symbol, kind}`. */
  locatorJson: string;
  /** Current on-disk source of the selected region (whole file in create mode). */
  currentSource: string;
  /** Optional pre-rendered `Current source:` block (repair-context shrink). */
  preRenderedSource?: string;
  /** The diagnostics that opened the round plus the latest rejection. */
  diagnostics: string;
  /** True when the continued round may still re-pin to another declaration. */
  repin: boolean;
  /** Prior-attempts digest (#57), appended after the Diagnostics block. */
  digest?: string;
  /** Failure history (#71), appended after the Diagnostics block before the digest. */
  failureHistory?: string;
  /**
   * No-progress ask (#60): a continuation that directly follows a milestone
   * no-progress round carries the stalled decision framing (and its STOP
   * semantics) instead of the round-exhausted header; the retry shape is kept.
   * The #65 sharpened framing rides the same field.
   */
  stalled?: StalledAsk;
  /** Opt-in multi-payload variant (#69); forwarded to the retry prompt. */
  multiPayload?: boolean;
  /** Edit protocol format (#119); forwarded to the retry prompt. */
  protocolFormat?: ProtocolFormat;
  /** EditDsl Goal/index context (#B4); forwarded to the retry prompt. */
  editDslContext?: { issue: string; indexText: string; startLine?: number };
}

/**
 * Round-level continuation (#52): shown as the first message of the round that
 * follows an exhausted one. It keeps the retry shape (instruction, pinned
 * selection, current source, diagnostics) and adds the STOP framing; this
 * prompt and the no-progress ask (#54/#60) are the only ones that offer `STOP`.
 */
export function buildContinuationPrompt(input: ContinuationPromptInput): string {
  return buildRetryPrompt({
    exchangeNumber: 1,
    maxExchanges: MAX_EDIT_EXCHANGES,
    mode: input.mode,
    locatorJson: input.locatorJson,
    currentSource: input.currentSource,
    preRenderedSource: input.preRenderedSource,
    diagnostics: input.diagnostics,
    failure: "edit",
    repin: input.repin,
    continuation: { round: input.round, maxRounds: input.maxRounds },
    stalled: input.stalled,
    digest: input.digest,
    failureHistory: input.failureHistory,
    multiPayload: input.multiPayload,
    protocolFormat: input.protocolFormat,
    editDslContext: input.editDslContext,
  });
}

const TERMINATION_SUMMARY: Record<TerminationReason | "provider-error", string> = {
  "token-budget": "the token budget was exceeded",
  "edit-exhausted": "the edit budget was exhausted without a valid edit",
  "delete-verification-failed": "the deletion could not be verified",
  "prev-broken": "the current source of the target no longer parses",
  "provider-error": "the provider call failed",
  "harness-fault": "the harness produced an invalid edit candidate at the format gate",
  "output-limit": "the completion hit the output limit three times in a row without a usable edit",
};

/**
 * Termination step (#43): the summary prompt is the final user message of a
 * failed run, not an Edit exchange — it does not count against the ≤3 budget.
 */
export function buildSummaryPrompt(
  reason: TerminationReason | "provider-error",
  diagnostics: string | null,
): string {
  const lines = [`The run is over: ${TERMINATION_SUMMARY[reason]}.`];
  if (diagnostics !== null && diagnostics.trim() !== "") {
    lines.push("", "Diagnostics:", "", "```", diagnostics, "```");
  }
  lines.push(
    "",
    "Reply with exactly these four labeled lines, in this order and nothing else:",
    "- Accomplished: what was completed before the stop.",
    "- Failed and why: what could not be completed and the reason.",
    "- Remaining: what is still to do.",
    "- Next step: one concrete recommendation for the planner.",
    "Do not output code.",
  );
  return lines.join("\n");
}

function selectionRetryBody(diagnostics: string): string {
  return `Output ONLY a corrected selection JSON object {"mode": ..., "path": ..., "symbol": ..., "kind": ...}, with no markdown fences and no prose.

Diagnostics:

\`\`\`
${diagnostics}
\`\`\`
`;
}

export function buildSelectionRetryPrompt(diagnostics: string): string {
  return `The previous selection was rejected. ${selectionRetryBody(diagnostics)}`;
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
 * Selection-side round continuation (#52): the exhausted round never pinned a
 * target, so the fresh round re-asks for the selection (or `STOP`); the
 * prior-attempts digest (#57) is appended after the diagnostics.
 */
export function buildSelectionContinuationPrompt(input: {
  round: number;
  maxRounds: number;
  diagnostics: string;
  digest?: string;
  /** Failure history (#71), appended after the diagnostics before the digest. */
  failureHistory?: string;
}): string {
  const digestSection =
    input.digest === undefined || input.digest.trim() === "" ? "" : `\n${input.digest}\n`;
  const failureHistorySection =
    input.failureHistory === undefined || input.failureHistory.trim() === ""
      ? ""
      : `\n${input.failureHistory}\n`;
  return `Round ${input.round} of ${input.maxRounds} exhausted its ${MAX_EDIT_EXCHANGES}-exchange selection budget without a valid pick. Reply STOP to end the run, or return a corrected selection to continue with a fresh round.

${selectionRetryBody(input.diagnostics)}${failureHistorySection}${digestSection}`;
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

export { stripCodeFences };

export type SelectionMode = "modify" | "create" | "delete";

export interface SelectionResponse {
  mode: SelectionMode;
  locator: Locator;
}

/**
 * Optional `(line, column)` selector (#72): a 1-based, inclusive-end position
 * range relative to the current source block shown in the prompt (the pinned
 * declaration for a modify round). It is an alternative to `matcher` for the
 * ambiguity class the structural matcher cannot resolve, and when both are sent
 * `range` takes precedence.
 */
export interface EditRange {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface EditPayload {
  locator: Locator;
  /** Structural snippet copied from the current source; null = whole-symbol rewrite. */
  matcher: string | null;
  /** Optional `(line, column)` selector (#72); takes precedence over `matcher` when present. */
  range: EditRange | null;
  replacement: string;
}

/** Which selector an applied edit used (#101): range, matcher, or whole-symbol. */
export type EditSelector = "range" | "matcher" | "whole-symbol";

/**
 * The form of matcher a `match`-stage edit used (#110): a structural snippet
 * copied from the source, or a `/regex/` locator. Regex only arises on the
 * edit-dsl cascade path (#111); the JSON path sends snippets only.
 */
export type MatcherKind = "snippet" | "regex";

/**
 * Classify one payload's selector (#101): `range` takes precedence over `matcher`
 * when both are sent, and a payload with neither is a whole-symbol rewrite.
 */
export function selectorOf(payload: EditPayload): EditSelector {
  if (payload.range !== null) {
    return "range";
  }
  return payload.matcher !== null ? "matcher" : "whole-symbol";
}

/**
 * The #101 selector vocabulary for a resolved cascade stage (#111), so a
 * edit-dsl clause's selector metric reads the same as the JSON path's:
 * `pick`→`range`, `match`→`matcher`, `whole-symbol`→`whole-symbol`.
 */
export function selectorFromStage(stage: SelectionStage): EditSelector {
  if (stage === "pick") {
    return "range";
  }
  return stage === "match" ? "matcher" : "whole-symbol";
}

/**
 * Classify one payload's resolved cascade stage (#110): a `range` pins a
 * contiguous run inside the declaration (`pick`, and wins over `matcher`), a
 * `matcher` locates a candidate set (`match`), and neither falls back to the
 * declaration itself (`whole-symbol`). This mirrors `resolveCascade`'s `stage`
 * so the metric reads the same vocabulary on both paths.
 */
export function stageOf(payload: EditPayload): SelectionStage {
  if (payload.range !== null) {
    return "pick";
  }
  return payload.matcher !== null ? "match" : "whole-symbol";
}

/**
 * The matcher form an edit used (#110), or `null` when no matcher resolved it:
 * `"snippet"` when the payload's `matcher` is the resolving locator (stage
 * `"match"`), else `null` (a range/whole-symbol edit names no matcher; `regex`
 * arrives with the edit-dsl cascade, #111).
 */
export function matcherKindOf(payload: EditPayload): MatcherKind | null {
  return stageOf(payload) === "match" ? "snippet" : null;
}

/**
 * Selectors of an exchange's parsed payloads (#101), in order: every entry of a
 * `{"payloads": [...]}` batch, else the single flat payload's selector, else
 * `undefined` when the exchange carried no payload.
 */
export function selectorsOf(
  payload: EditPayload | null,
  batch: readonly EditPayload[] | null,
): EditSelector[] | undefined {
  if (batch !== null) {
    return batch.map(selectorOf);
  }
  return payload === null ? undefined : [selectorOf(payload)];
}

/**
 * Resolved cascade stages of an exchange's parsed payloads (#110), in the same
 * order and with the same batch-or-flat-or-undefined shape as `selectorsOf`.
 */
export function stagesOf(
  payload: EditPayload | null,
  batch: readonly EditPayload[] | null,
): SelectionStage[] | undefined {
  if (batch !== null) {
    return batch.map(stageOf);
  }
  return payload === null ? undefined : [stageOf(payload)];
}

/**
 * Matcher kinds of an exchange's parsed payloads (#110), parallel to `stagesOf`:
 * one entry per payload (`null` when no matcher resolved it).
 */
export function matcherKindsOf(
  payload: EditPayload | null,
  batch: readonly EditPayload[] | null,
): (MatcherKind | null)[] | undefined {
  if (batch !== null) {
    return batch.map(matcherKindOf);
  }
  return payload === null ? undefined : [matcherKindOf(payload)];
}

const SELECTION_EXPECTED =
  'expected {"mode":"modify"|"create"|"delete","path": ..., "symbol": ..., "kind": ...}';
const EDIT_EXPECTED =
  'expected {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}';
const SELECTION_MODES: ReadonlySet<string> = new Set(["modify", "create", "delete"]);
const SELECTION_KEYS: ReadonlySet<string> = new Set(["mode", "path", "symbol", "kind"]);
const EDIT_KEYS: ReadonlySet<string> = new Set([
  "path",
  "symbol",
  "kind",
  "matcher",
  "range",
  "replacement",
]);

/** Keys of the optional `(line,column)` selector (#72). */
const RANGE_KEYS: ReadonlySet<string> = new Set(["line", "column", "endLine", "endColumn"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tolerant object reader: whole-text fences and surrounding prose are tolerated. */
function readJsonObject(content: string, expected: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(content);
  } catch (error) {
    throw new Error(`${expected}; ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${expected}; got a JSON value that is not an object`);
  }
  return parsed;
}

// v2 protocol errors name the unexpected keys the model actually sent; `name`
// and `edits` get targeted hints because they are the v1 shapes.
function parseAddressFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  expected: string,
): Locator {
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    const hints: string[] = [];
    if (extra.includes("name") && !("symbol" in record)) {
      hints.push('the address field is "symbol" (renamed from "name")');
    }
    if (extra.includes("edits")) {
      hints.push('v2 carries one flat edit object, not an "edits" array');
    }
    const hint = hints.length === 0 ? "" : ` (${hints.join("; ")})`;
    throw new Error(
      `${expected}; unexpected key(s) ${extra.map((key) => JSON.stringify(key)).join(", ")}${hint}`,
    );
  }
  const path = record["path"];
  const symbol = record["symbol"];
  const kind = record["kind"];
  if (typeof path !== "string" || path === "") {
    throw new Error(`${expected}; "path" must be a non-empty string`);
  }
  if (typeof symbol !== "string" || symbol === "") {
    throw new Error(`${expected}; "symbol" must be a non-empty string`);
  }
  if (typeof kind !== "string" || kind === "") {
    throw new Error(`${expected}; "kind" must be a non-empty string`);
  }
  return { path, name: symbol, kind };
}

function selectionFromValue(parsed: unknown): SelectionResponse {
  if (!isRecord(parsed)) {
    throw new Error(`${SELECTION_EXPECTED}; got a JSON value that is not an object`);
  }
  const locator = parseAddressFields(parsed, SELECTION_KEYS, SELECTION_EXPECTED);
  const mode = parsed["mode"];
  if (mode === undefined) {
    return { mode: "modify", locator };
  }
  if (typeof mode !== "string" || !SELECTION_MODES.has(mode)) {
    throw new Error(
      `${SELECTION_EXPECTED}; "mode" must be one of "modify", "create", "delete" (got ${JSON.stringify(mode)})`,
    );
  }
  return { mode: mode as SelectionMode, locator };
}

export function parseSelectionResponse(content: string): SelectionResponse {
  return selectionFromValue(readJsonObject(content, SELECTION_EXPECTED));
}

// Optional `(line,column)` selector (#72): shape errors are protocol rejections
// (like a malformed `matcher`); resolution errors are `range-invalid`.
function parseRangeField(record: Record<string, unknown>, expected: string): EditRange | null {
  const raw = record["range"];
  if (raw === undefined) {
    return null;
  }
  if (!isRecord(raw)) {
    throw new Error(
      `${expected}; "range" must be an object {"line": ..., "column": ..., "endLine": ..., "endColumn": ...} of positive integers (omit it to keep the matcher/whole-symbol path)`,
    );
  }
  const extra = Object.keys(raw).filter((key) => !RANGE_KEYS.has(key));
  if (extra.length > 0) {
    throw new Error(
      `${expected}; "range" carries unexpected key(s) ${extra.map((key) => JSON.stringify(key)).join(", ")}`,
    );
  }
  const fields: readonly (keyof EditRange)[] = ["line", "column", "endLine", "endColumn"];
  const parsed: EditRange = { line: 0, column: 0, endLine: 0, endColumn: 0 };
  for (const key of fields) {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`${expected}; "range.${key}" must be a positive integer (1-based)`);
    }
    parsed[key] = value;
  }
  return parsed;
}

// One flat edit payload from an already-parsed record; shared by the classic
// single-payload reply and each entry of an opt-in `{"payloads": [...]}` batch
// (#69).
function payloadFromRecord(record: Record<string, unknown>, expected: string): EditPayload {
  const locator = parseAddressFields(record, EDIT_KEYS, expected);
  const matcher = record["matcher"];
  if (matcher !== undefined && (typeof matcher !== "string" || matcher === "")) {
    throw new Error(
      `${expected}; "matcher" must be a non-empty string when present (omit it for a whole-symbol rewrite)`,
    );
  }
  const range = parseRangeField(record, expected);
  const replacement = record["replacement"];
  if (typeof replacement !== "string") {
    throw new Error(`${expected}; "replacement" must be a string`);
  }
  return {
    locator,
    matcher: matcher === undefined ? null : matcher,
    range,
    replacement,
  };
}

export function parseEditResponse(content: string): EditPayload {
  return payloadFromRecord(readJsonObject(content, EDIT_EXPECTED), EDIT_EXPECTED);
}

/** Batch wrapper key of the opt-in multi-payload protocol (#69). */
export const MULTI_PAYLOAD_KEY = "payloads";

/**
 * Result of parsing a reply under the opt-in multi-payload protocol (#69): a
 * classic flat payload (`batch: false`) or a `{"payloads": [...]}` batch, or a
 * rejection carrying the payloads that did parse plus the batch-level cause
 * (`multi-protocol` for a malformed wrapper/entry, null for a classic protocol
 * failure). Same-file payloads parse cleanly (#78); their regions are checked
 * for overlap when the batch is applied.
 */
export type EditPayloadList =
  | { ok: true; batch: boolean; payloads: EditPayload[] }
  | {
      ok: false;
      cause: "multi-protocol" | null;
      diagnostics: string;
      payloads: EditPayload[];
    };

// `stage: multi` header for every batch-level rejection (#69); the payloads'
// own diagnostics follow, so a retry can name each failing payload's cause.
export function multiDiagnostics(message: string): string {
  return `stage: multi\nthe multi-payload exchange was rejected: ${message}; nothing is written`;
}

/**
 * Parse one edit reply under the opt-in multi-payload protocol (#69): a flat
 * object stays the classic single payload; an object carrying `payloads` is a
 * batch whose entries are flat payloads. Repeated `path`s are allowed (#78):
 * same-file entries are applied together and their regions checked for overlap
 * at application time. Batch-level errors are typed (`multi-protocol`) and
 * never silently repaired.
 */
export function parseEditResponseList(content: string): EditPayloadList {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(content);
  } catch (error) {
    return {
      ok: false,
      cause: null,
      diagnostics: `stage: protocol\n${EDIT_EXPECTED}; ${errorMessage(error)}`,
      payloads: [],
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      cause: null,
      diagnostics: `stage: protocol\n${EDIT_EXPECTED}; got a JSON value that is not an object`,
      payloads: [],
    };
  }
  if (!(MULTI_PAYLOAD_KEY in parsed)) {
    try {
      return { ok: true, batch: false, payloads: [parseEditResponse(content)] };
    } catch (error) {
      return {
        ok: false,
        cause: null,
        diagnostics: `stage: protocol\n${errorMessage(error)}`,
        payloads: [],
      };
    }
  }
  const extra = Object.keys(parsed).filter((key) => key !== MULTI_PAYLOAD_KEY);
  if (extra.length > 0) {
    return {
      ok: false,
      cause: "multi-protocol",
      diagnostics: multiDiagnostics(
        `the batch object carries unexpected key(s) ${extra.map((key) => JSON.stringify(key)).join(", ")}; send only "payloads"`,
      ),
      payloads: [],
    };
  }
  const entries = parsed[MULTI_PAYLOAD_KEY];
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      ok: false,
      cause: "multi-protocol",
      diagnostics: multiDiagnostics('"payloads" must be a non-empty array of flat edit objects'),
      payloads: [],
    };
  }
  const payloads: EditPayload[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry)) {
      return {
        ok: false,
        cause: "multi-protocol",
        diagnostics: multiDiagnostics(`payload ${index + 1} is not a flat edit object`),
        payloads,
      };
    }
    try {
      payloads.push(payloadFromRecord(entry, EDIT_EXPECTED));
    } catch (error) {
      return {
        ok: false,
        cause: "multi-protocol",
        diagnostics: multiDiagnostics(`payload ${index + 1}: ${errorMessage(error)}`),
        payloads,
      };
    }
  }
  return { ok: true, batch: true, payloads };
}

// ---------------------------------------------------------------------------
// Bounded self-verification request (#73)

/** The whitelisted self-check kinds; the model names a kind, never a command. */
export type SelfCheckKind = "read" | "check" | "test";

/** The one key of the repair-only self-verification request object (#73). */
const SELF_CHECK_KEY = "request";
const SELF_CHECK_KINDS: ReadonlySet<string> = new Set(["read", "check", "test"]);
const SELF_CHECK_EXPECTED = 'expected {"request":"read"|"check"|"test"}';

/** Result of parsing a reply as a self-verification request (#73). */
export type SelfCheckParse =
  // Not request-shaped: the caller falls through to the ordinary edit parser.
  | { kind: "none" }
  | { kind: "ok"; request: SelfCheckKind }
  // Request-shaped but malformed or outside the whitelist: a `protocol` rejection.
  | { kind: "error"; diagnostics: string };

/**
 * Parse a reply as a self-verification request (#73): the distinct object
 * `{"request":"read"|"check"|"test"}` carrying exactly that one key. Anything
 * that is not request-shaped returns `none`, so the caller falls through to the
 * ordinary edit parser; a request-shaped object with an unknown kind or an extra
 * key returns `error`.
 */
export function parseSelfCheckRequest(content: string): SelfCheckParse {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(content);
  } catch {
    return { kind: "none" };
  }
  if (!isRecord(parsed) || !(SELF_CHECK_KEY in parsed)) {
    return { kind: "none" };
  }
  const extra = Object.keys(parsed).filter((key) => key !== SELF_CHECK_KEY);
  if (extra.length > 0) {
    return {
      kind: "error",
      diagnostics: `stage: protocol\n${SELF_CHECK_EXPECTED}; unexpected key(s) ${extra.map((key) => JSON.stringify(key)).join(", ")} (a request carries only "request")`,
    };
  }
  const value = parsed[SELF_CHECK_KEY];
  if (typeof value !== "string" || !SELF_CHECK_KINDS.has(value)) {
    return {
      kind: "error",
      diagnostics: `stage: protocol\n${SELF_CHECK_EXPECTED}; "request" must be one of "read", "check", "test" (got ${JSON.stringify(value)})`,
    };
  }
  return { kind: "ok", request: value as SelfCheckKind };
}

/** Shared stdout+stderr budget for one self-check command result (#73). */
export const SELF_CHECK_OUTPUT_LIMIT = 4_000;

// Clamp command output to the self-check bound, naming how much was dropped; an
// empty result stays explicit so the model can tell "no output" from "failed".
function clampSelfCheckOutput(output: string): string {
  const trimmed = output.trimEnd();
  if (trimmed === "") {
    return "(no output)";
  }
  return trimmed.length > SELF_CHECK_OUTPUT_LIMIT
    ? `${trimmed.slice(0, SELF_CHECK_OUTPUT_LIMIT)}\n… [truncated ${trimmed.length - SELF_CHECK_OUTPUT_LIMIT} characters]`
    : trimmed;
}

/** Bounded current-source rendering for a `read` request (#73). */
export function renderSelfCheckRead(target: string, source: string): string {
  if (source === "") {
    return `Self-check (read): ${target} is empty or does not exist.`;
  }
  const lines = splitSourceLines(source).length;
  return `Self-check (read): ${target} (${lines} line(s), truncated at ${SPEC_FILE_LIMIT} characters).\n\n${numberedSourceBlock(truncateSource(source))}`;
}

/** Bounded command-result rendering for a `check`/`test` request (#73). */
export function renderSelfCheckCommand(
  kind: "check" | "test",
  label: string,
  result: CommandResult,
): string {
  const status = result.ok ? "passed" : "failed";
  return `Self-check (${kind}): ${label} ${status} (exit ${result.exitCode}).\n\n\`\`\`\n${clampSelfCheckOutput(result.output)}\n\`\`\``;
}

function addressJson(locator: Locator): string {
  return JSON.stringify({ path: locator.path, symbol: locator.name, kind: locator.kind });
}

function addressEquals(left: Locator, right: Locator): boolean {
  return left.path === right.path && left.name === right.name && left.kind === right.kind;
}

// Canonical pinned-selection label, `{mode, path, symbol, kind}`; rebuilt
// whenever the pin moves or its mode changes (#48).
function pinJson(pinned: { mode: SelectionMode; locator: Locator }): string {
  return JSON.stringify({
    mode: pinned.mode,
    path: pinned.locator.path,
    symbol: pinned.locator.name,
    kind: pinned.locator.kind,
  });
}

function echoDiagnostics(pinned: Locator, payload: Locator): string {
  return [
    "stage: echo",
    'the payload address does not match the pinned selection; echo the selection exactly in {path, symbol, kind} and do not echo "mode"',
    `pinned: ${addressJson(pinned)}`,
    `payload: ${addressJson(payload)}`,
  ].join("\n");
}

/**
 * Validate one explicit-targets reply (#81): the first payload must echo the
 * pinned address, every payload must address one of the pending targets, and at
 * most one payload may appear per file (same-file targets are sequenced across
 * exchanges). Returns the covered addresses or a staged diagnostic — never a
 * silent pick.
 */
function validateTargetsReply(
  payloads: readonly { locator: Locator }[],
  pinnedLocator: Locator,
  queue: readonly Locator[],
): { ok: true; covered: Locator[] } | { ok: false; diagnostics: string } {
  const first = payloads[0];
  if (first === undefined) {
    return { ok: false, diagnostics: "stage: protocol\nthe reply carried no edit payloads" };
  }
  if (!addressEquals(pinnedLocator, first.locator)) {
    return { ok: false, diagnostics: echoDiagnostics(pinnedLocator, first.locator) };
  }
  const pendingJson = new Set(queue.map((target) => addressJson(target)));
  const activePaths = new Set<string>();
  const activeJson = new Set<string>();
  for (const target of queue) {
    if (activePaths.has(target.path)) {
      continue;
    }
    activePaths.add(target.path);
    activeJson.add(addressJson(target));
  }
  const paths = new Set<string>();
  const covered: Locator[] = [];
  for (const payload of payloads) {
    const key = addressJson(payload.locator);
    if (!pendingJson.has(key)) {
      return {
        ok: false,
        diagnostics: `stage: address\nthe payload ${key} is not one of the requested pending targets; address only the named targets`,
      };
    }
    if (!activeJson.has(key)) {
      return {
        ok: false,
        diagnostics: `stage: address\nthe payload ${key} is not an active target; address only the first pending target of each file, one per file, and sequence the rest across exchanges`,
      };
    }
    if (paths.has(payload.locator.path)) {
      return {
        ok: false,
        diagnostics: `stage: address\nthis exchange carries two payloads for ${JSON.stringify(payload.locator.path)}; allow at most one target per file per exchange and sequence same-file targets across exchanges`,
      };
    }
    paths.add(payload.locator.path);
    covered.push(payload.locator);
  }
  return { ok: true, covered };
}

function selectionFromResponse(response: ChatResponse): SelectionResponse {
  const toolCall = response.toolCalls[0];
  if (toolCall === undefined) {
    return parseSelectionResponse(response.content ?? "");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new Error(SELECTION_EXPECTED);
  }
  return selectionFromValue(parsed);
}

export interface ProviderLike {
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatResponse>;
}

export const DEFAULT_TOKEN_BUDGET = 120_000;
/** Model exchanges per Run iteration, shared by target picking and content revision (#43). */
export const MAX_EDIT_EXCHANGES = 3;
/**
 * Hard cap on Run iterations (#52): a round that exhausts its ≤3 exchanges
 * below the cap continues through a continuation prompt; entering an iteration
 * beyond the cap terminates as `edit-exhausted` naming the cap.
 */
export const MAX_RUN_ITERATIONS = 32;
/**
 * No-progress decision point (#54): after this many consecutive
 * verification-failed rounds, the first content prompt of the next round asks
 * the model to decide (reply `STOP` or take a materially different approach).
 */
export const MAX_STALLED_ROUNDS = 8;
/**
 * Output-limit strike cap (#98): consecutive `finish_reason == "length"`
 * replies are counted from `records`; the third in a row ends the run through
 * the summary/stop path instead of continuing to burn budget.
 */
export const MAX_CONSECUTIVE_LENGTH = 3;

/**
 * No-progress ask cadence after the first decision point (#65): the first ask
 * stays at `MAX_STALLED_ROUNDS`; later asks recur this many failed rounds apart
 * (4), so a fast-burning storm reaches the sharpened repeated ask before the
 * token budget can end the run.
 */
export const STALLED_ASK_INTERVAL = Math.max(1, Math.floor(MAX_STALLED_ROUNDS / 2));

/**
 * True when `failedRounds` is a no-progress decision point (#54/#60/#65): the
 * first at `MAX_STALLED_ROUNDS` (8), then every `STALLED_ASK_INTERVAL` (4) —
 * 8, 12, 16, 20, …
 */
export function isStalledAskMilestone(failedRounds: number): boolean {
  return (
    failedRounds >= MAX_STALLED_ROUNDS &&
    (failedRounds - MAX_STALLED_ROUNDS) % STALLED_ASK_INTERVAL === 0
  );
}

/** 1-based decision-point index for a milestone failed-round count (#65). */
export function stalledAskNumber(failedRounds: number): number {
  return 1 + Math.floor((failedRounds - MAX_STALLED_ROUNDS) / STALLED_ASK_INTERVAL);
}

/**
 * True when a no-progress ask escalates to a decision-only turn (#75): either
 * signal says another minimal same-spot edit cannot help. A repeat ask
 * (`askNumber >= 2`) escalates even while the `#71` pattern is still changing
 * (`history` null), because a still-changing set at a repeat ask can still be a
 * non-converging oscillation. A first ask escalates too once the failing set is
 * already non-converging (`history` `unchanged`/`alternating`), because that
 * already means another minimal edit cannot help. Only a first ask with a
 * still-changing pattern (`history` null) keeps the exact edit prompt, so
 * json/sexp and a recovering cycle are untouched at the first decision point.
 */
export function isDecisionAsk(stalled: StalledAsk): boolean {
  const askNumber = stalled.askNumber ?? 1;
  return askNumber >= 2 || (stalled.history !== undefined && stalled.history !== null);
}

// Shown on the retry after the same rejection repeats verbatim (#48).
const IDENTICAL_RETRY_NOTE =
  'the previous attempt failed identically; change the shape of the edit (omit "matcher" for a whole-symbol rewrite, adjust the replacement, or re-pin to a different declaration)';

export interface LoopOptions {
  cwd: string;
  issue: string;
  provider: ProviderLike;
  /** Abort the run once accumulated provider tokens exceed this (#36). */
  tokenBudget?: number;
  temperature?: number;
  checkCommand?: string[];
  testCommand?: string[];
  /** Check/test command timeout in ms; defaults to 120_000 (#45). */
  commandTimeoutMs?: number;
  /** Benchmark override: forces this effort on every Edit-loop call, bypassing the default policy (#35). */
  effortOverride?: ReasoningEffort;
  /**
   * Opt-in multi-payload exchanges (#69/#78): a modify reply may carry
   * `{"payloads": [...]}` — flat payloads addressing different files and/or
   * several non-overlapping regions of one file — applied atomically. Default
   * off keeps the exact single-payload behavior.
   */
  multiPayload?: boolean;
  /**
   * Edit protocol format (#119): `edit-dsl` (default) makes the `select … end`
   * syntax the required reply form and the first turn a select clause; `json`
   * keeps the flat JSON payload. Absent is `edit-dsl`. Explicit-targets mode
   * (#81) is JSON-only.
   */
  protocolFormat?: ProtocolFormat;
  /**
   * Explicit-targets mode (#81): the addresses to edit, one entry per desired
   * declaration. When non-empty the run skips model selection, forces the
   * batch shape, names the pending addresses in each edit prompt, and sequences
   * same-file targets across exchanges. Absent/empty keeps the discovery path.
   */
  targets?: readonly Locator[];
}

/** Outcome of one model exchange inside Edit. */
export type ExchangeOutcome =
  | "selected"
  | "applied"
  | "stopped"
  // A repair exchange that carried one bounded self-verification request (#73).
  | "self-check"
  // An edit-dsl viewer clause that located candidates and wrote nothing (#111).
  | "viewer"
  // An edit-dsl `# modified text` confirmation reply (#B3): the verified edit
  // stands; the row is neither an apply nor a rejection.
  | "confirmed"
  | "protocol"
  | "address"
  | "echo"
  | "matcher"
  | "range"
  | "no-op"
  | "repeat"
  | "duplicate"
  | "gate"
  | "format"
  | "truncated"
  | "prev-broken";

/** Outcome of one harness-side application/verification step. */
export type VerificationOutcome = "ok" | "tsc" | "tests" | "gate" | "format" | "prev-broken";

export type AttemptOutcome = ExchangeOutcome | VerificationOutcome;

/** Matcher-check failures, produced by `spliceEntryEdit` (#56), plus the edit-dsl cascade's `regex-invalid` (#109/#111). */
type MatcherCause =
  | "matcher-unparseable"
  | "matcher-not-found"
  | "matcher-ambiguous"
  | "regex-invalid";

/**
 * Typed edit-rejection cause (#56): every exchange rejection maps to exactly
 * one class so the retry policy and the record rows never string-sniff the
 * diagnostics text.
 */
export type RejectionCause =
  | "protocol"
  | "echo"
  | "address"
  | MatcherCause
  | "range-invalid"
  | "no-op"
  | "repeat"
  | "duplicate"
  | "gate"
  | "format"
  | "format-export-duplication"
  | "truncated"
  | "multi-protocol"
  | "multi-duplicate";

/** Stage of one rejected content exchange, as recorded and classified (#43/#69). */
type EditFailureStage =
  | "protocol"
  | "echo"
  | "address"
  | "matcher"
  | "range"
  | "no-op"
  | "repeat"
  | "duplicate"
  | "gate"
  | "format";

/** oxfmt's duplicate-modifier parse error (e.g. `'export' modifier already seen`). */
const FORMAT_DUPLICATE_MODIFIER_SIGNATURE = "modifier already seen";

/**
 * Classify one rejection from its structured origin: the stage the loop set
 * while rejecting, the splice's matcher sub-cause, and the caught formatter
 * message. The diagnostics text is never parsed here.
 */
export function classifyRejection(input: {
  stage:
    | "protocol"
    | "echo"
    | "address"
    | "matcher"
    | "range"
    | "no-op"
    | "repeat"
    | "duplicate"
    | "gate"
    | "format"
    | "truncated";
  matcherCause?: MatcherCause;
  formatMessage?: string;
}): RejectionCause {
  switch (input.stage) {
    case "matcher":
      if (input.matcherCause === undefined) {
        // Unreachable: every matcher rejection site passes the splice cause.
        throw new Error('classifyRejection: stage "matcher" requires a matcherCause');
      }
      return input.matcherCause;
    case "range":
      // A single `range-invalid` class for out-of-bounds, outside-declaration,
      // and empty/end-before-start ranges (#72); the diagnostic names which.
      return "range-invalid";
    case "format":
      // The splice duplicated a modifier the declaration already carried:
      // harness-side, not a model mistake (#56, defense-in-depth behind #48).
      return input.formatMessage?.includes(FORMAT_DUPLICATE_MODIFIER_SIGNATURE) === true
        ? "format-export-duplication"
        : "format";
    default:
      return input.stage;
  }
}

/**
 * Per-cause retry policy (#56): the correction sentence the next edit retry
 * carries, its escalation once the same cause repeats, or the terminal
 * harness-fault verdict. `repeat`/`duplicate` state that the resend cannot
 * change the file; `rejectionLead` renders the sentence and adds the #65
 * context (a no-op's pending failures, an undeclared address name).
 */
export type RejectionPolicy =
  | { action: "retry"; correction: string | null; escalation: string | null }
  | { action: "terminate"; reason: "harness-fault" };

const MATCHER_ESCALATION =
  'This attempt MUST omit "matcher" and return the complete declaration in "replacement".';

// #102: a matcher failure can also be escaped with the #72 `range` selector,
// whose coordinates pin a contiguous run without a verbatim copy. Off by
// default — opt in with TC_MATCHER_RANGE_HINT=on (trimmed, lowercased; only
// on/1/true enable) so the harness keeps the pre-#102 text unless explicitly
// steered. Read once per rejectionPolicy call so tests can flip it in-process.
const MATCHER_RANGE_HINT =
  'When the target is a contiguous run you can pin exactly, you may instead send the optional "range" {"line","column","endLine","endColumn"} selector (all 1-based, end inclusive, inside the declaration): it takes precedence over "matcher" and needs no verbatim copy.';

function matcherRangeHint(): string {
  const setting = (process.env.TC_MATCHER_RANGE_HINT ?? "").trim().toLowerCase();
  const enabled = setting === "on" || setting === "1" || setting === "true";
  return enabled ? MATCHER_RANGE_HINT : "";
}

// The edit protocol format (#119), replacing the #111/#117 opt-in env var.
// `json` (default) is the shipped flat
// `{path, symbol, kind, matcher, replacement}` payload and keeps every prompt and
// code path byte-identical to the pre-edit-dsl protocol. `edit-dsl` makes the
// `select … end` syntax (`docs/edit-protocol.md`) the required reply form: the
// system prompt teaches it, edit-dsl is parsed first, and a JSON edit payload is
// rejected as a protocol violation. Explicit-targets mode (#81) stays JSON.
export type ProtocolFormat = "json" | "edit-dsl";

// Repair-context shrink is opt-in: after a create fails verification the loop
// enters create→repair mode and re-sends the whole target file on every repair
// exchange, which can exhaust the token budget on a large file. With
// TC_REPAIR_CONTEXT_SHRINK=on the repair prompt instead renders only the
// declarations that matter. Off by default keeps every prompt byte-identical.
// Read once per call so tests can flip it in-process; only on/1/true enable.
export function repairContextShrinkEnabled(): boolean {
  const setting = (process.env.TC_REPAIR_CONTEXT_SHRINK ?? "").trim().toLowerCase();
  return setting === "on" || setting === "1" || setting === "true";
}

// Declarations whose presence the shrink always keeps: type-level declarations
// cross-reference one another, and a type error can name a value declaration
// while the fix lives in a type alias the diagnostics never mention (e.g.
// minilisp's `LispValue`).
const SHRINK_TYPE_LEVEL_KINDS = new Set(["type", "interface", "enum", "namespace"]);
// The diagnostics render each failure as `… — in declaration \`name\` (kind)`.
const DIAGNOSTIC_DECLARATION = /in declaration `([^`]+)`/g;

/**
 * Build a partial, original-line-numbered view of a repaired file (#create→repair).
 * Keeps the pinned declaration, every declaration named in the diagnostics, and
 * every type-level declaration; drops the rest behind an omission marker. Returns
 * `null` to mean "show the whole file" when the file does not parse, is small, or
 * the shrunk view would not actually be shorter.
 */
export function shrinkRepairSource(
  path: string,
  source: string,
  locator: Locator,
  diagnostics: string,
): string | null {
  if (source.length <= SPEC_FILE_LIMIT / 2) {
    return null;
  }
  const build = buildIndexTolerant([{ path, source }]);
  if (build.skipped.length > 0) {
    return null;
  }
  const kept: IndexEntry[] = [];
  const keptStarts = new Set<number>();
  const keep = (entry: IndexEntry): void => {
    if (keptStarts.has(entry.node.start)) {
      return;
    }
    keptStarts.add(entry.node.start);
    kept.push(entry);
  };
  const pinned = build.index.lookup(locator);
  if (pinned.length === 1 && pinned[0] !== undefined) {
    keep(pinned[0]);
  }
  for (const match of diagnostics.matchAll(DIAGNOSTIC_DECLARATION)) {
    const name = match[1];
    if (name === undefined) {
      continue;
    }
    for (const entry of build.index.byName(name)) {
      keep(entry);
    }
  }
  for (const entry of build.index.entries) {
    if (SHRINK_TYPE_LEVEL_KINDS.has(entry.locator.kind)) {
      keep(entry);
    }
  }
  // Nothing to keep (no resolvable pin, no named declaration, no type) means the
  // partial view would hide the whole file: fall back to the whole file.
  if (kept.length === 0) {
    return null;
  }
  kept.sort((left, right) => left.node.start - right.node.start);
  const sourceLines = splitSourceLines(source);
  const width = String(sourceLines.length).length;
  const rendered: string[] = [];
  // Line number just past the previously rendered declaration, so the next
  // declaration's first line reveals how many lines were skipped.
  let previousEndLine: number | null = null;
  let previousNodeEnd = 0;
  for (const entry of kept) {
    const firstLine = source.slice(0, entry.node.start).split("\n").length;
    if (previousEndLine !== null && firstLine > previousEndLine) {
      rendered.push(
        omissionMarker(
          build.index.entries,
          previousNodeEnd,
          entry.node.start,
          firstLine - previousEndLine,
        ),
      );
    }
    const raw = source.slice(entry.node.start, entry.node.end);
    const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    const lines = body.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      rendered.push(`${String(firstLine + index).padStart(width, " ")} | ${lines[index]}`);
    }
    previousEndLine = firstLine + lines.length;
    previousNodeEnd = entry.node.end;
  }
  const text = rendered.join("\n");
  return text.length < source.length ? text : null;
}

// One marker line for the declarations skipped between two kept declarations.
function omissionMarker(
  entries: readonly IndexEntry[],
  gapStart: number,
  gapEnd: number,
  gapLines: number,
): string {
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.node.start <= gapStart || entry.node.start >= gapEnd) {
      continue;
    }
    if (!names.includes(entry.locator.name)) {
      names.push(entry.locator.name);
    }
  }
  return names.length > 0
    ? `// … [omitted: ${names.join(", ")}] …`
    : `// … [${gapLines} lines omitted] …`;
}

// #65 resend classes: `repeat` means the byte-identical payload was already
// submitted (applied and still failing, or rejected), `duplicate` means the
// candidate would add a second top-level copy of a declaration the file
// already carries. Either way the file already reflects the outcome, so the
// lead states that and forces the next attempt to differ — the rejected
// replacements themselves are never re-echoed into the prompt.
const REPEAT_CORRECTION =
  "That exact submission was already sent, and the file already reflects its outcome — the change is in place or nothing was written — so resending it cannot change anything. Change the target, the matcher, or the replacement so the next attempt actually differs and addresses the diagnostics below.";
const REPEAT_ESCALATION =
  "That exact submission has now been rejected repeatedly, and resending it cannot change the file. This attempt MUST differ from the previous attempts — a different target, matcher, or replacement form — and must address the diagnostics below.";
const DUPLICATE_CORRECTION =
  "The file already declares that symbol, so adding a second top-level copy cannot succeed. Change the replacement so it edits the existing declaration instead of adding another copy, and address the diagnostics below.";
const DUPLICATE_ESCALATION =
  "This edit keeps adding another top-level copy of a symbol the file already declares. This attempt MUST return a replacement that differs from the current source and edits the existing declaration instead of re-declaring it.";

// #65 no-op: the replacement equals the text it replaces, i.e. the intended
// change is already in the file. The sharpened lead says so and directs the
// next change at the pending failures; `rejectionLead` appends where they
// point when the round was opened by a failed verification.
const NOOP_CORRECTION =
  "The change you intend is already in the file: the replacement is identical to the text it replaces, so resending it would change nothing. Change a different part of the declaration — or a different declaration the diagnostics name — so the next edit actually differs from the current source.";
const NOOP_ESCALATION =
  "This attempt MUST stop re-proposing that change: it is already in the file, so nothing would change. Return a replacement that differs from the current source and directly addresses the diagnostics below.";
const NOOP_PENDING_POINTER = "The remaining failures still point at ";

// #65 address: a re-pin to a name the current source does not declare can never
// resolve. The wording keeps the add path open — the declaration must ride
// inside the replacement of an address that resolves, while mode "create"
// applies only while the run is still choosing a target — and never weakens the
// address guard.
function addressUndeclaredCorrection(name: string): string {
  const quoted = JSON.stringify(name);
  return `The current source declares no symbol named ${quoted}, so a re-pin to it can never resolve. Echo the pinned selection, or re-pin to a declaration the diagnostics name; to add that declaration, carry it inside the replacement of an address that resolves — mode "create" applies only while the run is still choosing a target.`;
}

function addressUndeclaredEscalation(name: string): string {
  const quoted = JSON.stringify(name);
  return `This attempt MUST return an address the current source resolves: echo the pinned address exactly as shown, or re-pin to a declaration the diagnostics name — ${quoted} is not declared, so re-pinning to it cannot succeed. To add that declaration, carry it inside the replacement of an address that resolves; mode "create" applies only while the run is still choosing a target.`;
}

/**
 * Context the dynamic #65 lead needs beyond the cause and its streak: the
 * verification diagnostics that opened the round (the no-op pointer) and the
 * name of an `address` rejection the current source does not declare.
 */
export interface RejectionLeadContext {
  /** Diagnostics that opened the round when a failed verification did (#65). */
  pendingDiagnostics?: string | null;
  /** The rejected address names a declaration the current source lacks (#65). */
  undeclaredName?: string;
  /**
   * The edit protocol the run uses (#117/#119): an edit-dsl run re-teaches the
   * `select … end` form on a `protocol` rejection instead of the JSON payload
   * the mode rejects. Defaults to `json`.
   */
  protocolFormat?: ProtocolFormat;
}

/**
 * The lead sentence the next edit retry carries after a rejection (#56): the
 * cause's correction, or its escalation from the second consecutive rejection
 * of the same cause. `repeat`/`duplicate` stop resends (#65); a `no-op` names
 * the already-present effect and points at the pending failures; an undeclared
 * `address` keeps the add path open (#65). Null keeps the generic lead.
 */
export function rejectionLead(
  cause: RejectionCause,
  streak: number,
  context: RejectionLeadContext = {},
): string | null {
  const escalated = streak >= 2;
  const format = context.protocolFormat ?? "json";
  if (cause === "no-op") {
    const policy = rejectionPolicy(cause, format);
    if (policy.action !== "retry") {
      return null;
    }
    const base = escalated ? policy.escalation : policy.correction;
    if (base === null) {
      return null;
    }
    const pending = context.pendingDiagnostics ?? null;
    return pending === null ? base : `${base} ${NOOP_PENDING_POINTER}${digestDetail(pending)}.`;
  }
  if (cause === "address" && context.undeclaredName !== undefined) {
    return escalated
      ? addressUndeclaredEscalation(context.undeclaredName)
      : addressUndeclaredCorrection(context.undeclaredName);
  }
  const policy = rejectionPolicy(cause, format);
  if (policy.action !== "retry" || policy.correction === null) {
    return null;
  }
  return escalated && policy.escalation !== null ? policy.escalation : policy.correction;
}

export function rejectionPolicy(
  cause: RejectionCause,
  format: ProtocolFormat = "json",
): RejectionPolicy {
  // #102: read the toggle once per call; `withRangeHint` no-ops when disabled
  // so the off render stays byte-identical to the pre-#102 strings.
  const rangeHint = matcherRangeHint();
  const withRangeHint = (text: string): string =>
    rangeHint === "" ? text : `${text} ${rangeHint}`;
  switch (cause) {
    case "format-export-duplication":
      return { action: "terminate", reason: "harness-fault" };
    case "repeat":
      return { action: "retry", correction: REPEAT_CORRECTION, escalation: REPEAT_ESCALATION };
    case "duplicate":
      return {
        action: "retry",
        correction: DUPLICATE_CORRECTION,
        escalation: DUPLICATE_ESCALATION,
      };
    case "protocol":
      return format === "edit-dsl"
        ? {
            action: "retry",
            correction: EDIT_DSL_PROTOCOL_CORRECTION,
            escalation: EDIT_DSL_PROTOCOL_ESCALATION,
          }
        : {
            action: "retry",
            correction:
              'Return exactly one flat JSON object with the keys "path", "symbol", "kind", "matcher", "range", "replacement" ("matcher" and "range" optional), and no fences.',
            escalation:
              'This attempt MUST reply with exactly one flat JSON object carrying "path", "symbol", "kind", "matcher", "range", "replacement" as the entire response: no prose, no markdown fences, no nesting.',
          };
    case "echo":
      return {
        action: "retry",
        correction:
          "Echo the pinned address exactly as shown; re-pin only when the diagnostics name another declaration.",
        escalation:
          'This attempt MUST echo the pinned address exactly as shown — the same "path", "symbol", and "kind" values.',
      };
    case "address":
      return {
        action: "retry",
        correction:
          "Use an address that resolves to exactly one declaration: echo the pinned selection, or re-pin only to a declaration the diagnostics name.",
        escalation:
          "This attempt MUST echo the pinned address exactly as shown; the diagnostics name no other declaration to re-pin to.",
      };
    case "matcher-unparseable":
      return {
        action: "retry",
        correction: withRangeHint(
          'Copy "matcher" verbatim from the current source as one complete statement, expression, or contiguous run of statements, or omit "matcher" for a whole-symbol rewrite.',
        ),
        escalation: withRangeHint(MATCHER_ESCALATION),
      };
    case "matcher-not-found":
      return {
        action: "retry",
        correction: withRangeHint(
          'Copy "matcher" verbatim from the current source, or omit "matcher" for a whole-symbol rewrite.',
        ),
        escalation: withRangeHint(MATCHER_ESCALATION),
      };
    case "matcher-ambiguous":
      return {
        action: "retry",
        correction: withRangeHint(
          'Extend "matcher" with more surrounding context copied from the current source, or omit "matcher" for a whole-symbol rewrite.',
        ),
        escalation: withRangeHint(MATCHER_ESCALATION),
      };
    case "regex-invalid":
      return {
        action: "retry",
        correction:
          "Write a valid ECMA-262 `/regex/` matcher with no flags — escape any literal slash — or copy a verbatim backtick `snippet` from the current source.",
        escalation: MATCHER_ESCALATION,
      };
    case "range-invalid":
      return {
        action: "retry",
        correction:
          'The "range" is invalid for the current source: copy the 1-based line and column positions from the numbered current-source block, keep the end inclusive, and keep the range inside the pinned declaration — or omit "range" and use "matcher"/a whole-symbol rewrite.',
        escalation:
          'This attempt MUST address the current source: omit "range" and return the complete declaration (or a verbatim "matcher") rather than repeating invalid coordinates.',
      };
    case "no-op":
      return {
        action: "retry",
        correction: NOOP_CORRECTION,
        escalation: NOOP_ESCALATION,
      };
    case "gate":
      return {
        action: "retry",
        correction:
          "Return a syntactically complete declaration so the file still parses after the splice.",
        escalation:
          "This attempt MUST return one syntactically complete declaration: no truncated bodies, no unbalanced delimiters, no stray fragments.",
      };
    case "format":
      return {
        action: "retry",
        correction:
          "Keep the declaration shape of the current source, including its existing leading modifiers.",
        escalation:
          "This attempt MUST reuse the current source's declaration shape exactly (the same leading modifiers) and change only the needed declaration text.",
      };
    case "truncated":
      return {
        action: "retry",
        correction: "Emit a shorter, more compact replacement that fits the output limit.",
        escalation:
          "This attempt MUST emit the smallest complete replacement: drop comments, collapse bodies, and keep it short.",
      };
    case "multi-protocol":
      return {
        action: "retry",
        correction:
          'Return either one flat edit object, or a {"payloads": [...]} object whose entries are flat edit objects addressing different files or non-overlapping regions of one file.',
        escalation:
          'This attempt MUST return either exactly one flat {"path", "symbol", "kind", "matcher", "range", "replacement"} object or a well-formed {"payloads": [ ... ]} batch: no other keys, no nesting beyond one array level.',
      };
    case "multi-duplicate":
      return {
        action: "retry",
        correction:
          "Two payloads of the multi-payload exchange addressed overlapping regions of the same file, so none of them was written. Make every same-file payload address a distinct, non-overlapping declaration or span, or split the edits across exchanges.",
        escalation:
          "This attempt MUST give the same file's payloads non-overlapping regions: address distinct declarations or disjoint spans, or batch one edit per file and edit the rest in later exchanges.",
      };
  }
}

/**
 * One v2 record row: a model exchange (pick, applied edit, or soft failure) or
 * a harness verification step (#43). Replaces the v1 `LoopAttempt`.
 */
export interface LoopRecord {
  /** 1-based row number in run order. */
  row: number;
  /** 1-based Run iteration this row belongs to. */
  iteration: number;
  kind: "exchange" | "verification";
  /** Exchange index inside the Run iteration (shared ≤3 budget); null for verification rows. */
  exchange: number | null;
  outcome: AttemptOutcome;
  locator: Locator;
  replacement: string | null;
  diagnostics: string | null;
  diagnosticsHead: string | null;
  replacementChars: number | null;
  finishReason: string | null;
  /** Payload objects the exchange carried (#69): 1 for a classic edit, N for a batch, 0 when none. */
  payloads?: number;
  /** Provider tool calls in the reply that produced this row (#69); 0 on verification rows. */
  toolCalls?: number;
  /**
   * Addresses this applied exchange covered (#81): one per batch payload in
   * explicit-targets mode, so the result can name every file the exchange wrote.
   */
  appliedLocators?: Locator[];
  /**
   * Selectors used by the exchange's parsed payloads (#101): one entry per
   * payload in order (a batch contributes one per entry); omitted when the
   * exchange carried no payload.
   */
  selectors?: EditSelector[];
  /**
   * Resolved cascade stages used by the exchange's parsed payloads (#110): one
   * entry per payload in order, mirroring `selectors`; omitted when the exchange
   * carried no payload.
   */
  stages?: SelectionStage[];
  /**
   * Matcher kinds used by the exchange's parsed payloads (#110), parallel to
   * `stages`: one entry per payload, `null` when no matcher resolved it.
   */
  matcherKinds?: (MatcherKind | null)[];
  /**
   * EditDsl implicit-create clauses the reply carried (#111): create clauses
   * resolve at the `whole-symbol` stage, so this is a subset of `stages`.
   * Omitted when the exchange was not an edit-dsl reply.
   */
  creates?: number;
  /** Verification rows: failure signature (tsc diagnostics + failing tests) observation (#36). */
  signature: number | null;
  /** Typed edit-rejection cause (#56); absent on success and verification rows. */
  cause?: RejectionCause;
}

/**
 * Per-run exchange diagnostics (#69): how many exchanges were rejected versus
 * applied, and how many payloads/tool calls the run's exchanges carried.
 */
export interface ExchangeStats {
  /** Exchange rows in the run. */
  turns: number;
  /** Payload objects carried across all exchange rows. */
  payloads: number;
  /** Provider tool calls across all exchange rows. */
  toolCalls: number;
  /** Exchange rows that applied an edit (`applied`). */
  applied: number;
  /** Exchange rows rejected before an apply, including `prev-broken`. */
  rejected: number;
  /** Exchange rows that pinned a target (`selected`). */
  selected: number;
  /** Exchange rows that ended the run with a `STOP` reply (`stopped`). */
  stopped: number;
  /** Exchange rows that executed a self-verification request (`self-check`, #73). */
  selfChecks: number;
  /** Applied/parsed payloads that used the `range` selector (#101). */
  range: number;
  /** Applied/parsed payloads that used the `matcher` selector (#101). */
  matcher: number;
  /** Applied/parsed payloads that rewrote the whole symbol (#101). */
  wholeSymbol: number;
  /** Applied/parsed payloads resolved by the cascade's `whole-symbol` stage (#110). */
  stageWholeSymbol: number;
  /** Applied/parsed payloads resolved by the cascade's `match` stage (#110). */
  stageMatch: number;
  /** Applied/parsed payloads resolved by the cascade's `pick` stage (#110). */
  stagePick: number;
  /** Applied/parsed payloads whose matcher was a structural snippet (#110). */
  snippet: number;
  /** Applied/parsed payloads whose matcher was a `/regex/` (#110). */
  regex: number;
  /** EditDsl implicit-create clauses carried per reply (#111). */
  creates: number;
}

/**
 * Fold a run's record rows into the rejected-vs-applied exchange counts (#69):
 * only exchange rows count; verification rows are harness steps.
 */
export function exchangeStats(records: readonly LoopRecord[]): ExchangeStats {
  const stats: ExchangeStats = {
    turns: 0,
    payloads: 0,
    toolCalls: 0,
    applied: 0,
    rejected: 0,
    selected: 0,
    stopped: 0,
    selfChecks: 0,
    range: 0,
    matcher: 0,
    wholeSymbol: 0,
    stageWholeSymbol: 0,
    stageMatch: 0,
    stagePick: 0,
    snippet: 0,
    regex: 0,
    creates: 0,
  };
  for (const record of records) {
    if (record.kind !== "exchange") {
      continue;
    }
    stats.turns += 1;
    stats.payloads += record.payloads ?? 0;
    stats.toolCalls += record.toolCalls ?? 0;
    stats.creates += record.creates ?? 0;
    for (const selector of record.selectors ?? []) {
      if (selector === "range") {
        stats.range += 1;
      } else if (selector === "matcher") {
        stats.matcher += 1;
      } else {
        stats.wholeSymbol += 1;
      }
    }
    for (const stage of record.stages ?? []) {
      if (stage === "whole-symbol") {
        stats.stageWholeSymbol += 1;
      } else if (stage === "match") {
        stats.stageMatch += 1;
      } else {
        stats.stagePick += 1;
      }
    }
    for (const kind of record.matcherKinds ?? []) {
      if (kind === "snippet") {
        stats.snippet += 1;
      } else if (kind === "regex") {
        stats.regex += 1;
      }
    }
    if (record.outcome === "applied") {
      stats.applied += 1;
    } else if (record.outcome === "selected") {
      stats.selected += 1;
    } else if (record.outcome === "stopped") {
      stats.stopped += 1;
    } else if (record.outcome === "self-check") {
      stats.selfChecks += 1;
    } else if (record.outcome === "viewer") {
      // An edit-dsl viewer locate turn (#111): neither applied nor a rejection.
    } else if (record.outcome === "confirmed") {
      // An edit-dsl `# modified text` confirmation (#B3): the verified apply
      // stands, so this row is neither applied nor rejected.
    } else {
      stats.rejected += 1;
    }
  }
  return stats;
}

/**
 * Output-limit strike counter (#98): walk `records` from the end while the row's
 * `finishReason` is `"length"` and return that trailing run's length. Returns 0
 * when the most recent row is not a length finish, which resets the strike.
 */
export function consecutiveLengthFinishes(records: readonly LoopRecord[]): number {
  let count = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.finishReason !== "length") {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * v2 termination matrix (#43): a run ends through one of these, and each ends
 * with exactly one LLM-written summary as its final action.
 */
export type TerminationReason =
  | "token-budget"
  | "edit-exhausted"
  | "delete-verification-failed"
  | "prev-broken"
  | "harness-fault"
  | "output-limit";

/**
 * Token spend of one run (#80): the component breakdown of every provider
 * response's raw usage, threaded onto the result so a sub-agent caller can
 * account for the call. The `total` still drives the hard budget.
 */
export interface LoopTokens {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
}

/** A fresh all-zero token tally (#80); safe to return and never mutate. */
function zeroLoopTokens(): LoopTokens {
  return { input: 0, output: 0, total: 0, cacheRead: 0 };
}

export interface LoopResult {
  ok: boolean;
  mode?: SelectionMode;
  locator: Locator | null;
  filePath: string | null;
  editedSource: string | null;
  records: LoopRecord[];
  diagnostics: string | null;
  explanation: string | null;
  messages: ChatMessage[];
  skipped?: SkippedFile[];
  /** Set when the run ended through the termination matrix; absent on success and provider errors. */
  terminationReason?: TerminationReason;
  /** Provider token spend of the run (#80); zeros when no provider usage was seen. */
  tokens: LoopTokens;
  /**
   * Explicit-targets mode (#81): every requested address that was applied, in
   * order. Absent on the default discovery path.
   */
  appliedTargets?: Locator[];
}

type Selection =
  | { mode: "modify"; locator: Locator; entry: IndexEntry }
  | { mode: "create"; locator: Locator; path: string }
  | { mode: "delete"; locator: Locator; entry: IndexEntry };

const EMPTY_LOCATOR: Locator = { path: "", name: "", kind: "" };
const DIAGNOSTICS_LIMIT = 4000;
const DIAGNOSTICS_HEAD_LIMIT = 200;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Render a provider failure for diagnostics (#97): a context-overflow or
// payload-too-large classification gets its own label so the run's defined
// summary path names the cause; everything else keeps the generic text.
function providerErrorDiagnostics(error: unknown): string {
  if (error instanceof ChatContextOverflowError) {
    return `provider context-overflow: ${errorMessage(error)}`;
  }
  if (error instanceof ChatPayloadTooLargeError) {
    return `provider payload-too-large: ${errorMessage(error)}`;
  }
  return `provider error: ${errorMessage(error)}`;
}

// Tolerant provider usage reader (#36): prefer the reported total, fall back to
// prompt + completion when both are reported; unknown shapes count as zero.
function tokensFromResponse(response: ChatResponse): number {
  const usage = usageFromRaw(response.raw);
  if (typeof usage !== "object" || usage === null) {
    return 0;
  }
  const record = usage as Record<string, unknown>;
  const total = record["total_tokens"];
  if (typeof total === "number" && Number.isFinite(total)) {
    return total;
  }
  const prompt = record["prompt_tokens"];
  const completion = record["completion_tokens"];
  if (
    typeof prompt !== "number" ||
    !Number.isFinite(prompt) ||
    typeof completion !== "number" ||
    !Number.isFinite(completion)
  ) {
    return 0;
  }
  return prompt + completion;
}

/** Tolerant component reader (#80): a finite number or 0. */
function finiteTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Component breakdown of one provider response's raw usage (#80), read from the
 * same shape `tokensFromResponse` consumes: `input`/`output` prefer
 * `prompt_tokens`/`completion_tokens` and fall back to
 * `input_tokens`/`output_tokens`; `cacheRead` reads
 * `prompt_tokens_details.cached_tokens` or `cache_read_input_tokens`; `total`
 * prefers `total_tokens` and falls back to input+output. Unknown shapes count
 * as zero.
 */
function loopTokensFromResponse(response: ChatResponse): LoopTokens {
  const usage = usageFromRaw(response.raw);
  if (typeof usage !== "object" || usage === null) {
    return zeroLoopTokens();
  }
  const record = usage as Record<string, unknown>;
  const input = finiteTokenCount(record["prompt_tokens"] ?? record["input_tokens"]);
  const output = finiteTokenCount(record["completion_tokens"] ?? record["output_tokens"]);
  let cacheRead = 0;
  const details = record["prompt_tokens_details"];
  if (typeof details === "object" && details !== null) {
    cacheRead = finiteTokenCount((details as Record<string, unknown>)["cached_tokens"]);
  }
  if (cacheRead === 0) {
    cacheRead = finiteTokenCount(record["cache_read_input_tokens"]);
  }
  const reportedTotal = finiteTokenCount(record["total_tokens"]);
  return {
    input,
    output,
    total: reportedTotal !== 0 ? reportedTotal : input + output,
    cacheRead,
  };
}

function tokenBudgetDiagnostics(consumedTokens: number, tokenBudget: number): string {
  return `token-budget: accumulated ${consumedTokens} tokens exceeded the ${tokenBudget} token budget`;
}

function diagnosticsHeadOf(diagnostics: string | null): string | null {
  if (diagnostics === null) {
    return null;
  }
  const collapsed = diagnostics.replace(/\s+/g, " ").trim();
  return collapsed.length > DIAGNOSTICS_HEAD_LIMIT
    ? collapsed.slice(0, DIAGNOSTICS_HEAD_LIMIT)
    : collapsed;
}

function recordRow(input: {
  row: number;
  iteration: number;
  kind: "exchange" | "verification";
  exchange: number | null;
  locator: Locator;
  replacement: string | null;
  diagnostics: string | null;
  outcome: AttemptOutcome;
  finishReason: string | null;
  signature?: number | null;
  cause?: RejectionCause;
  /** Payload objects the exchange carried (#69); defaults 0. */
  payloads?: number;
  /** Provider tool calls in the reply (#69); defaults 0. */
  toolCalls?: number;
  /** Explicit addresses covered by an applied exchange (#81); omitted by default. */
  appliedLocators?: Locator[];
  /** Selectors used by the exchange's parsed payloads (#101); omitted when none. */
  selectors?: EditSelector[];
  /** Resolved cascade stages (#110); parallel to `selectors`; omitted when none. */
  stages?: SelectionStage[];
  /** Matcher kinds (#110); parallel to `stages`; omitted when none. */
  matcherKinds?: (MatcherKind | null)[];
  /** EditDsl implicit-create clauses the reply carried (#111); omitted when none. */
  creates?: number;
  /** Exact replacement size when it differs from `replacement.length` (batch sum, #69). */
  replacementChars?: number;
}): LoopRecord {
  return {
    row: input.row,
    iteration: input.iteration,
    kind: input.kind,
    exchange: input.exchange,
    outcome: input.outcome,
    locator: input.locator,
    replacement: input.replacement,
    diagnostics: input.diagnostics,
    diagnosticsHead: diagnosticsHeadOf(input.diagnostics),
    replacementChars:
      input.replacementChars ?? (input.replacement === null ? null : input.replacement.length),
    finishReason: input.finishReason,
    payloads: input.payloads ?? 0,
    toolCalls: input.toolCalls ?? 0,
    signature: input.signature ?? null,
    cause: input.cause,
    appliedLocators: input.appliedLocators,
    selectors: input.selectors,
    stages: input.stages,
    matcherKinds: input.matcherKinds,
    creates: input.creates,
  };
}

/**
 * Bounded, incrementally-updated prior-attempts digest (#57): the repair
 * chain's checkpoint. `updateAttemptDigest` reads only the records beyond the
 * cursor, and the rendered text goes to the #52 round-continuation prompts
 * and the #54 no-progress ask only — never to ordinary retries.
 */
export interface AttemptDigestState {
  /** Rendered entry lines retained under the bound, oldest first. */
  entries: string[];
  /** Per-class attempt counts; evicted attempts still count. */
  counts: Map<string, number>;
  /** Index into `records` of the next unprocessed row. */
  cursor: number;
  /** Failure attempts processed so far (attempt numbers are 1-based). */
  attempts: number;
  /** Entry lines evicted by the character bound. */
  dropped: number;
  /** Edit protocol the run uses, so a `protocol` alternative re-teaches the right form (#117/#119). */
  format: ProtocolFormat;
}

export function createAttemptDigestState(format: ProtocolFormat = "json"): AttemptDigestState {
  return { entries: [], counts: new Map(), cursor: 0, attempts: 0, dropped: 0, format };
}

/** One digest detail line is truncated to this many characters, `…` included. */
const DIGEST_DETAIL_LIMIT = 90;
/** A class repeated this often earns a `Ruled out` line (#57). */
export const DIGEST_RULED_OUT_REPEATS = 3;
/** Hard cap on the rendered digest text (#57). */
export const DIGEST_MAX_CHARS = 1_200;
/** Concrete alternative for the tsc/tests verification classes (#57). */
const DIGEST_VERIFICATION_ALTERNATIVE =
  "change the declaration structure instead of re-editing the same spot";
/** Alternative for a class whose #56 policy offers no escalation text (#57). */
const DIGEST_FALLBACK_ALTERNATIVE =
  "take a materially different approach instead of repeating the same attempt";

/** Every typed rejection cause, for the runtime escalation lookup (#57). */
const REJECTION_CAUSES: ReadonlySet<string> = new Set<RejectionCause>([
  "protocol",
  "echo",
  "address",
  "matcher-unparseable",
  "matcher-not-found",
  "matcher-ambiguous",
  "regex-invalid",
  "range-invalid",
  "no-op",
  "repeat",
  "duplicate",
  "gate",
  "format",
  "format-export-duplication",
  "truncated",
  "multi-protocol",
  "multi-duplicate",
]);

/**
 * Outcomes that are not failed attempts: successes and the terminating
 * `stopped` row never enter the digest (#57).
 */
const DIGEST_NON_FAILURES: ReadonlySet<AttemptOutcome> = new Set<AttemptOutcome>([
  "selected",
  "applied",
  "ok",
  "stopped",
  "self-check",
  "viewer",
  "confirmed",
]);

/**
 * Section labels name a bucket (or the position of a mapped diagnostic)
 * rather than a failure, so they are skipped when choosing the digest detail
 * (#57 follow-up). `codeFrame()` emits `  N | source` lines that quote the
 * replacement, so they must never win either.
 */
const DIGEST_SECTION_LABELS: ReadonlySet<string> = new Set([
  "elsewhere in file:",
  "typecheck failed:",
  "tests failed:",
  "failing tests:",
  "test output:",
]);
const DIGEST_REPLACEMENT_LABEL = /^replacement line \d+(?:, column \d+)?:$/;
const DIGEST_CODE_FRAME = /^\d+ \| /;

/** Collapse whitespace, trim, and truncate to `limit` characters (`…` included). */
function clampText(line: string, limit: number): string {
  const collapsed = line.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

function clampDigestDetail(line: string): string {
  return clampText(line, DIGEST_DETAIL_LIMIT);
}

// The digest keeps the most informative diagnostics line: the `stage: X`
// header names the rejection stage, section labels and code frames carry no
// failure text, and quoted replacement source must never leak into the
// checkpoint (#57; detail selection refined in the follow-up).
function digestDetail(diagnostics: string): string {
  const lines = diagnostics.split("\n").map((line) => line.trim());
  // (a) A tsc error line is always the most informative: raw
  // `file(line,column): error TSxxxx:` lines and mapped diagnostics whose
  // message spells out `error TS`. Code frames stay excluded so a source
  // line that happens to quote an error never wins.
  for (const line of lines) {
    if (line.includes("error TS") && !DIGEST_CODE_FRAME.test(line)) {
      return clampDigestDetail(line);
    }
  }
  // (b) Otherwise the first line that is neither a label nor a code frame.
  for (const line of lines) {
    if (line === "" || line.startsWith("stage: ") || DIGEST_CODE_FRAME.test(line)) {
      continue;
    }
    if (DIGEST_SECTION_LABELS.has(line) || DIGEST_REPLACEMENT_LABEL.test(line)) {
      continue;
    }
    return clampDigestDetail(line);
  }
  // (c) Diagnostics made only of labels and code frames keep the previous
  // behavior: the first non-`stage: ` line, else the raw first line.
  for (const line of lines) {
    if (line !== "" && !line.startsWith("stage: ")) {
      return clampDigestDetail(line);
    }
  }
  return clampDigestDetail(lines[0] ?? "");
}

// Reuse the #56 escalation text for rejection causes; tsc/tests get a fixed
// concrete sentence (#57).
function digestAlternative(className: string, format: ProtocolFormat): string {
  if (className === "tsc" || className === "tests") {
    return DIGEST_VERIFICATION_ALTERNATIVE;
  }
  if (REJECTION_CAUSES.has(className)) {
    const policy = rejectionPolicy(className as RejectionCause, format);
    if (policy.action === "retry" && policy.escalation !== null) {
      return policy.escalation;
    }
  }
  return DIGEST_FALLBACK_ALTERNATIVE;
}

// One `Ruled out` line per class repeated at least DIGEST_RULED_OUT_REPEATS
// times (#57): most-repeated first, then by class name, so the block is
// deterministic.
function digestRuledOutLines(
  counts: ReadonlyMap<string, number>,
  format: ProtocolFormat,
): string[] {
  return [...counts.entries()]
    .filter(([, count]) => count >= DIGEST_RULED_OUT_REPEATS)
    .sort((left, right) => right[1] - left[1] || comparePaths(left[0], right[0]))
    .map(
      ([className, count]) =>
        `Ruled out after ${count} repeats: ${className} — ${digestAlternative(className, format)}`,
    );
}

/**
 * Advance the digest over the records beyond its cursor (#57): each failure
 * row appends `- #<attempt> <class>: <detail>` and bumps its class count.
 * Success rows and the terminating `stopped` row are skipped.
 */
export function updateAttemptDigest(
  state: AttemptDigestState,
  records: readonly LoopRecord[],
): void {
  while (state.cursor < records.length) {
    const record = records[state.cursor];
    state.cursor += 1;
    if (
      record === undefined ||
      record.diagnostics === null ||
      DIGEST_NON_FAILURES.has(record.outcome)
    ) {
      continue;
    }
    state.attempts += 1;
    const className = record.cause ?? record.outcome;
    state.entries.push(`- #${state.attempts} ${className}: ${digestDetail(record.diagnostics)}`);
    state.counts.set(className, (state.counts.get(className) ?? 0) + 1);
  }
}

/**
 * Render the bounded digest (#57). The header, the omitted-entries line, and
 * the ruled-out block are reserved first; the oldest retained entries are then
 * evicted (bumping `dropped` and keeping the omitted line accurate) until the
 * text fits `DIGEST_MAX_CHARS`. Class counts keep every processed attempt,
 * including evicted ones.
 */
export function renderAttemptDigest(state: AttemptDigestState): string {
  const header = `Prior attempts (${state.attempts}):`;
  const ruledOut = digestRuledOutLines(state.counts, state.format);
  for (;;) {
    const omitted = state.dropped === 0 ? [] : [`- (${state.dropped} earlier attempts omitted)`];
    const text = [header, ...omitted, ...state.entries, ...ruledOut].join("\n");
    if (text.length <= DIGEST_MAX_CHARS) {
      return text;
    }
    if (state.entries.length > 0) {
      state.entries.shift();
      state.dropped += 1;
      continue;
    }
    // Defensive: a pathological chain can make the reserved ruled-out block
    // alone exceed the bound; drop the least-repeated classes until it fits.
    if (ruledOut.length > 0) {
      ruledOut.pop();
      continue;
    }
    return text;
  }
}

/** Failed verifications the failure-history walk looks back over (#71). */
export const FAILURE_HISTORY_LOOKBACK = 8;
/** One named state in the alternating note is clamped to this many characters. */
export const FAILURE_STATE_LIMIT = 110;

/** One `TSxxxx` error sentence, kept to the first `[^.]*` sentence (#71). */
const TS_ERROR_SENTENCE = /TS\d+:\s*[^.]*\./g;

/** Non-convergence of the trailing failed verifications (#71). */
export type FailurePattern =
  | { kind: "unchanged"; rounds: number }
  | { kind: "alternating"; rounds: number; a: string; b: string };

/**
 * The normalized identity of one failed verification (#71): every `TSxxxx`
 * error code with its first message sentence, whitespace collapsed, position
 * fragments (`(12,5)`) and `line 12` fragments stripped, de-duplicated and
 * sorted so the fingerprint is order-insensitive. Diagnostics without a
 * `TSxxxx` match fall back to the digest's detail selection (clamped); `""`
 * means nothing informative. Never throws.
 */
export function verificationFingerprint(diagnostics: string): string {
  try {
    const matches = diagnostics.match(TS_ERROR_SENTENCE);
    if (matches === null || matches.length === 0) {
      return clampDigestDetail(digestDetail(diagnostics));
    }
    const sentences = new Set<string>();
    for (const match of matches) {
      sentences.add(
        match
          .replace(/\(\d+,\d+\)/g, "")
          .replace(/line \d+/g, "line")
          .replace(/\s+/g, " ")
          .trim(),
      );
    }
    return [...sentences].sort().join(" | ");
  } catch {
    return "";
  }
}

/**
 * Detect a non-converging failing set in the trailing failed verifications
 * (#71): `unchanged` when the newest fingerprint repeats across >= 3
 * consecutive rounds, `alternating` when the newest fingerprints form a strict
 * ABAB cycle of >= 4 rounds (counted maximally back). The walk stops at the
 * first passed verification (chain reset) and looks back at most
 * `FAILURE_HISTORY_LOOKBACK` fingerprints; empty fingerprints never match and
 * are skipped. Returns null while failures still change.
 */
export function detectFailurePattern(records: readonly LoopRecord[]): FailurePattern | null {
  const fingerprints: string[] = [];
  for (
    let index = records.length - 1;
    index >= 0 && fingerprints.length < FAILURE_HISTORY_LOOKBACK;
    index -= 1
  ) {
    const record = records[index];
    if (record === undefined || record.kind !== "verification") {
      continue;
    }
    if (record.outcome === "ok") {
      break;
    }
    if (record.diagnostics === null) {
      continue;
    }
    const fingerprint = verificationFingerprint(record.diagnostics);
    if (fingerprint === "") {
      continue;
    }
    fingerprints.push(fingerprint);
  }
  const newest = fingerprints[0];
  if (newest === undefined) {
    return null;
  }
  let unchangedRounds = 0;
  while (unchangedRounds < fingerprints.length && fingerprints[unchangedRounds] === newest) {
    unchangedRounds += 1;
  }
  if (unchangedRounds >= 3) {
    return { kind: "unchanged", rounds: unchangedRounds };
  }
  const previous = fingerprints[1];
  if (previous === undefined || previous === newest) {
    return null;
  }
  let alternatingRounds = 0;
  while (
    alternatingRounds < fingerprints.length &&
    fingerprints[alternatingRounds] === (alternatingRounds % 2 === 0 ? newest : previous)
  ) {
    alternatingRounds += 1;
  }
  return alternatingRounds >= 4
    ? { kind: "alternating", rounds: alternatingRounds, a: newest, b: previous }
    : null;
}

/**
 * Render the bounded `Failure history` note (#71) for a detected pattern: one
 * line when the failing set is unchanged, or the two alternating states
 * (clamped to `FAILURE_STATE_LIMIT`) when the chain is cycling. Null renders
 * nothing. The states derive from `verificationFingerprint` (diagnostics
 * only), so no replacement source can leak into the note.
 */
export function renderFailureHistoryNote(pattern: FailurePattern | null): string {
  if (pattern === null) {
    return "";
  }
  if (pattern.kind === "unchanged") {
    return `Failure history: the failing set is unchanged across the last ${pattern.rounds} verification rounds.`;
  }
  return [
    `Failure history: the failing set has cycled between two states across the last ${pattern.rounds} verification rounds; local edits have flipped between them instead of converging:`,
    `- ${clampText(pattern.a, FAILURE_STATE_LIMIT)}`,
    `- ${clampText(pattern.b, FAILURE_STATE_LIMIT)}`,
  ].join("\n");
}

function sourceFileFor(files: SourceFile[], path: string): SourceFile {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw new Error(`no source file ${path}`);
  }
  return file;
}

function safeAppendPath(cwd: string, path: string): string | null {
  if (path === "" || isAbsolute(path)) {
    return null;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "..")) {
    return null;
  }
  const directories = segments.slice(0, -1).filter((segment) => segment !== ".");
  if (directories.some((segment) => segment.startsWith(".") || SKIPPED_DIRECTORIES.has(segment))) {
    return null;
  }
  const root = resolve(cwd);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return null;
  }
  const stats = statSync(target, { throwIfNoEntry: false });
  if (stats !== undefined && !stats.isFile()) {
    return null;
  }
  return path;
}

function readFileIfExists(path: string): string | null {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile()) {
    return null;
  }
  return readFileSync(path, "utf8");
}

function appendText(existing: string, replacement: string): string {
  const body = replacement.trim();
  if (existing.trim() === "") {
    return `${body}\n`;
  }
  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${base}\n${body}\n`;
}

function writeTarget(cwd: string, path: string, source: string): void {
  const target = join(cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

const ADDRESS_CANDIDATE_LIMIT = 5;

function lineColumnAt(source: string, offset: number): { line: number; column: number } {
  const limit = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < limit; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: limit - lineStart + 1 };
}

// Map a 1-based (line, column) to an absolute offset inside `source`, walking
// from `base` (the first character of the coordinate space) up to `limit` (one
// past its last character). Returns null when the position does not exist in
// that space; a position exactly at `limit` (one past the last character) is
// returned as `limit`.
function positionOffset(
  source: string,
  base: number,
  limit: number,
  line: number,
  column: number,
): number | null {
  let currentLine = 1;
  let currentColumn = 1;
  for (let index = base; index < limit; index += 1) {
    if (currentLine === line && currentColumn === column) {
      return index;
    }
    if (source[index] === "\n") {
      currentLine += 1;
      currentColumn = 1;
    } else {
      currentColumn += 1;
    }
  }
  if (currentLine === line && currentColumn === column) {
    return limit;
  }
  return null;
}

/** Why a `range` selector did not resolve to a spliceable span (#72). */
export type RangeResolutionFailure =
  | "out-of-bounds"
  | "outside-declaration"
  | "empty"
  | "truncated";

export type RangeResolution =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: RangeResolutionFailure; detail: string };

// Resolve one 1-based inclusive `(line,column)` range (#72) against the current
// source block shown in the prompt: `base`/`limit` bound that block and
// `declaration` is the absolute span the range must sit inside. The reported
// span is half-open (`[start, end)`) for the splice.
export function resolveEditRange(
  source: string,
  range: EditRange,
  base: number,
  limit: number,
  declaration: { start: number; end: number },
): RangeResolution {
  // A block larger than the prompt limit is elided on the way to the model, so
  // its shown line numbers no longer map back to the source; refuse rather than
  // splice at a wrong offset.
  if (limit - base > SPEC_FILE_LIMIT) {
    return {
      ok: false,
      reason: "truncated",
      detail: `the shown current source was truncated (it exceeds ${SPEC_FILE_LIMIT} characters), so its numbered lines do not map back to the file`,
    };
  }
  const start = positionOffset(source, base, limit, range.line, range.column);
  if (start === null || start >= limit) {
    return {
      ok: false,
      reason: "out-of-bounds",
      detail: `the start position (line ${range.line}, column ${range.column}) is outside the shown current source`,
    };
  }
  const endOffset = positionOffset(source, base, limit, range.endLine, range.endColumn);
  if (endOffset === null) {
    return {
      ok: false,
      reason: "out-of-bounds",
      detail: `the end position (line ${range.endLine}, column ${range.endColumn}) is outside the shown current source`,
    };
  }
  const end = endOffset + 1; // inclusive end
  if (end > limit) {
    return {
      ok: false,
      reason: "out-of-bounds",
      detail: `the end position (line ${range.endLine}, column ${range.endColumn}) is the last character of the shown current source, so the inclusive range extends past it`,
    };
  }
  if (end <= start) {
    return {
      ok: false,
      reason: "empty",
      detail: `the range is empty or ends before it starts: (line ${range.line}, column ${range.column}) to (line ${range.endLine}, column ${range.endColumn})`,
    };
  }
  if (start < declaration.start || end > declaration.end) {
    return {
      ok: false,
      reason: "outside-declaration",
      detail: "the range does not sit inside the pinned declaration",
    };
  }
  return { ok: true, start, end };
}

// The staged `range-invalid` diagnostic (#72): names the offending range and the
// declaration's current bounds in the same 1-based coordinate space.
function rangeInvalidDiagnostics(
  locator: Locator,
  target: string,
  sourceBefore: string,
  base: number,
  limit: number,
  declaration: { start: number; end: number },
  range: EditRange,
  detail: string,
): string {
  const blockText = sourceBefore.slice(base, limit);
  const startPos = lineColumnAt(blockText, declaration.start - base);
  const endPos = lineColumnAt(blockText, declaration.end - base);
  return [
    "stage: range",
    `the "range" (line ${range.line}, column ${range.column} to line ${range.endLine}, column ${range.endColumn}) is invalid for ${locator.kind} ${JSON.stringify(locator.name)} in ${target}: ${detail}`,
    `the pinned declaration currently spans line ${startPos.line}, column ${startPos.column} to line ${endPos.line}, column ${endPos.column} of the shown current source`,
    'copy the 1-based line and column positions from the numbered current-source block, keep the end inclusive, and keep the range inside the pinned declaration; or omit "range" and use "matcher"/a whole-symbol rewrite',
  ].join("\n");
}

// A `range` is defined against the numbered block the prompt showed, which (for
// an ordinary modify round) is the pinned declaration alone. A payload that
// re-pins to another declaration, or a further multi-payload entry in another
// file, has no shown block of its own, so its coordinates are undefined: refuse
// rather than splice at a guessed offset inside the target declaration (#72).
function rangeUnshownDiagnostics(
  shownLocator: Locator,
  payloadLocator: Locator,
  range: EditRange,
): string {
  return [
    "stage: range",
    `the "range" (line ${range.line}, column ${range.column} to line ${range.endLine}, column ${range.endColumn}) for ${payloadLocator.kind} ${JSON.stringify(payloadLocator.name)} in ${payloadLocator.path} cannot be used: the numbered current-source block shows only ${shownLocator.kind} ${JSON.stringify(shownLocator.name)} in ${shownLocator.path}`,
    'omit "range" for this payload and use "matcher" or a whole-symbol rewrite, or echo the pinned selection',
  ].join("\n");
}

function describeEntry(entry: IndexEntry, sourceByPath: ReadonlyMap<string, string>): string {
  const source = sourceByPath.get(entry.locator.path) ?? "";
  const { line, column } = lineColumnAt(source, entry.node.start);
  return `${entry.locator.path}: ${entry.locator.kind} ${JSON.stringify(entry.locator.name)} (line ${line}, column ${column})`;
}

function candidateLines(
  entries: readonly IndexEntry[],
  sourceByPath: ReadonlyMap<string, string>,
): string[] {
  const lines = entries
    .slice(0, ADDRESS_CANDIDATE_LIMIT)
    .map((entry) => `  - ${describeEntry(entry, sourceByPath)}`);
  if (entries.length > ADDRESS_CANDIDATE_LIMIT) {
    lines.push(`  ... ${entries.length - ADDRESS_CANDIDATE_LIMIT} more`);
  }
  return lines;
}

// Address diagnostics name where the symbol actually exists (path + kind +
// position) and, for a same-path kind mismatch, say which kind to use. A
// `resolve` space mismatch names the spaces the name is actually declared in
// and never suggests another path's candidate as a fallback.
function addressMissDiagnostics(
  locator: Locator,
  byName: readonly IndexEntry[],
  sourceByPath: ReadonlyMap<string, string>,
  space: SymbolSpace | null = null,
): string {
  const spaceSuffix = space === null ? "" : ` in the ${space} space`;
  const lines = [
    "stage: address",
    locator.kind === ""
      ? `no symbol named ${JSON.stringify(locator.name)} in ${JSON.stringify(locator.path)}${spaceSuffix}`
      : `no symbol with kind ${JSON.stringify(locator.kind)} named ${JSON.stringify(locator.name)} in ${JSON.stringify(locator.path)}${spaceSuffix}`,
  ];
  if (byName.length === 0) {
    lines.push(
      `the name ${JSON.stringify(locator.name)} is not declared in the indexed source; correct the address or use mode "create" to add it`,
    );
    return lines.join("\n");
  }
  lines.push(`the name ${JSON.stringify(locator.name)} exists at:`);
  lines.push(...candidateLines(byName, sourceByPath));
  const kinds = [
    ...new Set(
      byName
        .filter((entry) => entry.locator.path === locator.path)
        .map((entry) => entry.locator.kind),
    ),
  ];
  if (kinds.length > 0) {
    lines.push(
      `in ${JSON.stringify(locator.path)} the name exists as ${kinds.map((kind) => JSON.stringify(kind)).join(", ")}; change "kind" to match`,
    );
  }
  if (space !== null) {
    const samePath = byName.filter((entry) => entry.locator.path === locator.path);
    const samePathSpaces = [...new Set(samePath.flatMap((entry) => declarationSpaces(entry)))];
    if (samePathSpaces.length > 0 && !samePathSpaces.includes(space)) {
      lines.push(
        `in ${JSON.stringify(locator.path)} the name is declared in the ${samePathSpaces.map((candidate) => JSON.stringify(candidate)).join(", ")} space${samePathSpaces.length === 1 ? "" : "s"}; change "resolve" to match`,
      );
    } else if (samePathSpaces.length === 0) {
      const spaces = [...new Set(byName.flatMap((entry) => declarationSpaces(entry)))];
      lines.push(
        `the name ${JSON.stringify(locator.name)} is declared in the ${spaces.map((candidate) => JSON.stringify(candidate)).join(", ")} space${spaces.length === 1 ? "" : "s"}; the requested ${JSON.stringify(space)} space does not match this path`,
      );
    }
  }
  return lines.join("\n");
}

function addressAmbiguousDiagnostics(
  locator: Locator,
  matches: readonly IndexEntry[],
  sourceByPath: ReadonlyMap<string, string>,
  space: SymbolSpace | null = null,
): string {
  return [
    "stage: address",
    `the address ${addressJson(locator)}${space === null ? "" : ` in the ${space} space`} matches ${matches.length} declarations; the harness never picks one silently`,
    ...candidateLines(matches, sourceByPath),
    "correct the address (path/symbol/kind) so it matches exactly one declaration",
  ].join("\n");
}

type CurrentEntryResolution =
  | { ok: true; entry: IndexEntry }
  | { ok: false; diagnostics: string; undeclared: boolean; spaceMiss: boolean };

// Strict-AND resolution of one locator against the current source that would be
// spliced: no silent first-match pick, no kind coercion, no auto-append. An
// empty locator kind is the edit-dsl wildcard (path + name only); `space` is the
// edit-dsl `resolve value|type|namespace` filter and is `null` on the JSON path.
function resolveCurrentEntry(
  sourceBefore: string,
  target: string,
  locator: Locator,
  space: SymbolSpace | null = null,
): CurrentEntryResolution {
  const currentBuild = buildIndexTolerant([{ path: target, source: sourceBefore }]);
  const matches = currentBuild.index.lookup(locator, space);
  const sources = new Map([[target, sourceBefore]]);
  if (matches.length === 0) {
    // `undeclared` (#65): the name is absent under every kind, so the
    // diagnostics suggest mode "create" — the retry lead keeps that add path
    // open instead of demanding an impossible re-pin. A name declared only in
    // another symbol space is a `spaceMiss`: it is a creation candidate for the
    // requested space, but is not "undeclared" everywhere. A kind miss is
    // neither: the name occupies the requested space and must be re-addressed.
    const byName = currentBuild.index.byName(locator.name);
    const spaceMiss =
      space !== null &&
      byName.length > 0 &&
      byName.every((entry) => !declarationSpaces(entry).includes(space));
    return {
      ok: false,
      diagnostics: addressMissDiagnostics(locator, byName, sources, space),
      undeclared: byName.length === 0,
      spaceMiss,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      diagnostics: addressAmbiguousDiagnostics(locator, matches, sources, space),
      undeclared: false,
      spaceMiss: false,
    };
  }
  const entry = matches[0];
  if (entry === undefined) {
    // Unreachable: matches.length is exactly one here.
    return {
      ok: false,
      diagnostics: addressMissDiagnostics(locator, [], sources, space),
      undeclared: true,
      spaceMiss: false,
    };
  }
  return { ok: true, entry };
}

type EntrySpliceCause = MatcherCause | "no-op" | "range-invalid";

type EntrySplice =
  | { ok: true; candidate: string; gateStart: number }
  | { ok: false; cause: EntrySpliceCause; diagnostics: string };

// #59: an edit whose final spliced candidate is byte-identical to the current
// source cannot change anything; it is rejected before the syntax/format gate
// and verification instead of consuming a verification round-trip.
const NOOP_DIAGNOSTICS =
  "stage: no-op\nthe edit does not change the file: the replacement is identical to the text it replaces; change the code so the diagnostics are actually addressed";

// Formatter-normalized no-op (#59 follow-up): the byte comparison in
// `spliceEntryEdit` cannot see a replacement that re-includes the matched
// span's copied leading indentation, which the format gate normalizes away.
// `formattedCandidate` is the format gate's output; the on-disk source is not
// assumed canonical (a run can start from an unformatted file), so a
// non-byte-equal candidate formats the source once and compares canonical
// forms. Only a provable match rejects; an unformattable baseline applies.
async function sameAfterFormatting(
  target: string,
  sourceBefore: string,
  formattedCandidate: string,
): Promise<boolean> {
  if (formattedCandidate === sourceBefore) {
    return true;
  }
  try {
    return (await formatSource(target, sourceBefore)) === formattedCandidate;
  } catch {
    return false;
  }
}

// The indexed node range excludes a wrapping `export`; a matcher or a
// whole-symbol replacement that still carries the declaration's existing
// modifier is tolerated, with any whitespace after `export`, and keeps exactly
// one copy (#48, #50). Comment text between `export` and the declaration is
// deliberately not recognized: that shape still duplicates the modifier, is
// classified as a harness-side format fault, and exits through the fast path.
const EXPORT_PATTERN = /^export\s+/;
const EXPORT_DEFAULT_PATTERN = /^export\s+default\s+/;
const EXPORT_DEFAULT_MODIFIER_PATTERN = /^export\s+default\s+$/;
const RELOCATION_CANDIDATE_LIMIT = 2;

function precedingExportModifier(sourceBefore: string, entry: IndexEntry): string | null {
  return (
    /(export\s+default\s+|export\s+)$/.exec(sourceBefore.slice(0, entry.node.start))?.[0] ?? null
  );
}

function stripLeadingExport(replacement: string, modifier: string | null): string {
  if (modifier === null) {
    return replacement;
  }
  if (EXPORT_DEFAULT_MODIFIER_PATTERN.test(modifier)) {
    const stripped = replacement.replace(EXPORT_DEFAULT_PATTERN, "");
    if (stripped !== replacement) {
      return stripped;
    }
  }
  return replacement.replace(EXPORT_PATTERN, "");
}

// One matcher attempt with the leading-`export` tolerance: strip once, only at
// the very start, and only when the declaration already has a modifier.
function findMatcherWithModifier(
  sourceBefore: string,
  node: Node,
  matcher: string,
  modifier: string | null,
): MatcherResult {
  const matched = findMatcher(sourceBefore, node, matcher);
  if ((matched.kind === "not-found" || matched.kind === "unparseable") && modifier !== null) {
    if (EXPORT_DEFAULT_MODIFIER_PATTERN.test(modifier) && EXPORT_DEFAULT_PATTERN.test(matcher)) {
      return findMatcher(sourceBefore, node, matcher.replace(EXPORT_DEFAULT_PATTERN, ""));
    }
    if (EXPORT_PATTERN.test(matcher)) {
      return findMatcher(sourceBefore, node, matcher.replace(EXPORT_PATTERN, ""));
    }
  }
  return matched;
}

// A not-found matcher may actually belong to a different declaration of the
// same file; when a candidate matches (up to two are named), the diagnostic
// says which address would re-pin to it (#48).
function relocationNote(
  sourceBefore: string,
  target: string,
  entry: IndexEntry,
  matcher: string,
): string | null {
  const index = buildIndexTolerant([{ path: target, source: sourceBefore }]).index;
  const matches: IndexEntry[] = [];
  for (const candidate of index.entries) {
    const overlaps = candidate.node.start < entry.node.end && entry.node.start < candidate.node.end;
    if (overlaps) {
      continue;
    }
    // Each candidate carries its own preceding modifier, not the pinned one.
    const matched = findMatcherWithModifier(
      sourceBefore,
      candidate.node,
      matcher,
      precedingExportModifier(sourceBefore, candidate),
    );
    if (matched.kind !== "match") {
      continue;
    }
    matches.push(candidate);
    if (matches.length >= RELOCATION_CANDIDATE_LIMIT) {
      break;
    }
  }
  if (matches.length === 0) {
    return null;
  }
  if (matches.length === 1) {
    const candidate = matches[0];
    if (candidate === undefined) {
      return null; // Unreachable: matches.length is exactly one here.
    }
    return `note: the same snippet matches inside ${candidate.locator.kind} ${JSON.stringify(candidate.locator.name)} in ${candidate.locator.path} — if that is the intended target, return ${addressJson(candidate.locator)} to re-pin`;
  }
  const described = matches.map(
    (candidate) =>
      `${candidate.locator.kind} ${JSON.stringify(candidate.locator.name)} in ${candidate.locator.path}`,
  );
  return `note: the same snippet matches inside ${described.join(" and ")} — return the intended declaration's own {path, symbol, kind} to re-pin`;
}

// Resolve one edit against an already-resolved entry into the half-open splice
// span it addresses: a `range` selector when present, otherwise an omitted
// matcher = whole-symbol rewrite, otherwise the single structural match inside
// the entry. The per-region no-op guard lives here so every region is checked
// before a same-file batch is combined (#48, #72, #78).
type EntrySpliceResolution =
  | {
      ok: true;
      /** Half-open offsets into `sourceBefore`. */
      start: number;
      end: number;
      /** Replacement text (a whole-declaration span strips a duplicate `export`). */
      text: string;
      gateStart: number;
    }
  | { ok: false; cause: EntrySpliceCause; diagnostics: string };

function resolveEntrySplice(
  sourceBefore: string,
  target: string,
  locator: Locator,
  entry: IndexEntry,
  matcher: string | null,
  replacement: string,
  range: EditRange | null = null,
  rangeFileRelative = false,
): EntrySpliceResolution {
  const modifier = precedingExportModifier(sourceBefore, entry);
  let start: number;
  let end: number;
  let text: string;
  if (range !== null) {
    // Coordinate base (#72): the current source block shown in the prompt. A
    // declaration-relative block starts at the indexed node (after a wrapping
    // `export`); a whole-file block (create→repair rounds) starts at offset 0.
    const base = rangeFileRelative ? 0 : entry.node.start;
    const limit = rangeFileRelative ? sourceBefore.length : entry.node.end;
    const declaration = { start: entry.node.start, end: entry.node.end };
    const located = resolveEditRange(sourceBefore, range, base, limit, declaration);
    if (!located.ok) {
      return {
        ok: false,
        cause: "range-invalid",
        diagnostics: rangeInvalidDiagnostics(
          locator,
          target,
          sourceBefore,
          base,
          limit,
          declaration,
          range,
          located.detail,
        ),
      };
    }
    // A range covering the whole indexed declaration gets the same modifier
    // tolerance as a whole-symbol rewrite; a body-level range must not strip.
    text =
      modifier !== null && located.start === entry.node.start
        ? stripLeadingExport(replacement, modifier)
        : replacement;
    start = located.start;
    end = located.end;
  } else if (matcher === null) {
    start = entry.node.start;
    end = entry.node.end;
    text = stripLeadingExport(replacement, modifier);
  } else {
    const matched = findMatcherWithModifier(sourceBefore, entry.node, matcher, modifier);
    if (matched.kind === "unparseable") {
      return {
        ok: false,
        cause: "matcher-unparseable",
        diagnostics: `stage: matcher\nthe matcher could not be parsed as TypeScript: ${matched.message}; a matcher must be a single copied statement or expression, or a contiguous run of statements copied from one block; omitting "matcher" gives a whole-symbol rewrite`,
      };
    }
    if (matched.kind === "not-found") {
      const { line, column } = lineColumnAt(sourceBefore, entry.node.start);
      const base = `stage: matcher\nthe matcher was not found inside ${locator.kind} ${JSON.stringify(locator.name)} in ${target} (line ${line}, column ${column}); copy a complete snippet from the current source, or omit "matcher" for a whole-symbol rewrite`;
      const note = relocationNote(sourceBefore, target, entry, matcher);
      return {
        ok: false,
        cause: "matcher-not-found",
        diagnostics: note === null ? base : `${base}\n${note}`,
      };
    }
    if (matched.kind === "ambiguous") {
      const { line, column } = lineColumnAt(sourceBefore, entry.node.start);
      return {
        ok: false,
        cause: "matcher-ambiguous",
        diagnostics: `stage: matcher\nthe matcher matches ${matched.matches} places inside ${locator.kind} ${JSON.stringify(locator.name)} in ${target} (line ${line}, column ${column}); extend it with more surrounding context`,
      };
    }
    // A match over the whole declaration gets the same modifier tolerance as a
    // whole-symbol rewrite; a body-level match must not strip (#48).
    text =
      modifier !== null && matched.start === entry.node.start
        ? stripLeadingExport(replacement, modifier)
        : replacement;
    start = matched.start;
    end = matched.end;
  }
  // A whole-declaration empty fence deletes the declaration (#14): include the
  // leading `export`/`export default` modifier so the deletion does not leave a
  // dangling keyword behind. The edit-dsl protocol documents this as the delete
  // form, and a duplicate is repaired by deleting the indexed copy this way.
  if (matcher === null && range === null && text.trim() === "" && modifier !== null) {
    start = entry.node.start - modifier.length;
  }
  // Per-region no-op guard (#59): the replacement equals the exact text it
  // replaces, so this region alone would change nothing.
  if (text === sourceBefore.slice(start, end)) {
    return { ok: false, cause: "no-op", diagnostics: NOOP_DIAGNOSTICS };
  }
  return { ok: true, start, end, text, gateStart: start };
}

// Apply one edit to an already-resolved entry and build the whole-file
// candidate. Shared by the pinned modify branch and verification-repair re-pins
// (#48); a multi-payload region uses `resolveEntrySplice` directly (#78).
function spliceEntryEdit(
  sourceBefore: string,
  target: string,
  locator: Locator,
  entry: IndexEntry,
  matcher: string | null,
  replacement: string,
  range: EditRange | null = null,
  rangeFileRelative = false,
): EntrySplice {
  const resolved = resolveEntrySplice(
    sourceBefore,
    target,
    locator,
    entry,
    matcher,
    replacement,
    range,
    rangeFileRelative,
  );
  if (!resolved.ok) {
    return resolved;
  }
  return {
    ok: true,
    candidate: applyMatcherSplice(sourceBefore, resolved.start, resolved.end, resolved.text),
    gateStart: resolved.gateStart,
  };
}

/** One modify payload resolved to its addressed region against its own file. */
type PayloadSpan =
  | { ok: true; entry: IndexEntry; start: number; end: number; text: string; gateStart: number }
  | {
      ok: false;
      stage: "address" | "matcher" | "range" | "no-op";
      diagnostics: string;
      matcherCause?: MatcherCause;
      undeclaredName?: string | null;
    };

// Resolve one modify payload against the source that would be spliced:
// strict-AND address resolution, then the range/matcher/no-op rules. Shared by
// the pinned first payload and each self-addressed batch payload (#69/#78); the
// caller owns the echo/re-pin policy.
function resolvePayloadSpan(
  sourceBefore: string,
  target: string,
  payload: EditPayload,
  rangeFileRelative = false,
): PayloadSpan {
  const resolved = resolveCurrentEntry(sourceBefore, target, payload.locator);
  if (!resolved.ok) {
    return {
      ok: false,
      stage: "address",
      diagnostics: resolved.diagnostics,
      undeclaredName: resolved.undeclared ? payload.locator.name : null,
    };
  }
  const spliced = resolveEntrySplice(
    sourceBefore,
    target,
    payload.locator,
    resolved.entry,
    payload.matcher,
    payload.replacement,
    payload.range,
    rangeFileRelative,
  );
  if (spliced.ok) {
    return {
      ok: true,
      entry: resolved.entry,
      start: spliced.start,
      end: spliced.end,
      text: spliced.text,
      gateStart: spliced.gateStart,
    };
  }
  if (spliced.cause === "no-op") {
    return { ok: false, stage: "no-op", diagnostics: spliced.diagnostics };
  }
  if (spliced.cause === "range-invalid") {
    return { ok: false, stage: "range", diagnostics: spliced.diagnostics };
  }
  return {
    ok: false,
    stage: "matcher",
    diagnostics: spliced.diagnostics,
    matcherCause: spliced.cause,
  };
}

// One failing payload block inside a rejected batch (#69): names its position,
// own address, and its own staged diagnostics; the whole exchange is atomic.
function multiPayloadDiagnostics(
  index: number,
  total: number,
  path: string,
  locator: Locator,
  diagnostics: string,
): string {
  return [
    "stage: multi",
    `payload ${index} of ${total} (${addressJson(locator)} in ${JSON.stringify(path)}) failed; the whole exchange is discarded and nothing is written`,
    diagnostics,
  ].join("\n");
}

// One failing clause inside an edit-dsl reply (#111): names the clause position
// and its own staged diagnostics. EditDsl replies are atomic across the whole
// reply (§6), so the header says every clause is discarded and nothing is
// written.
function editDslClauseDiagnostics(
  index: number,
  total: number,
  path: string,
  locator: Locator,
  diagnostics: string,
): string {
  return [
    "stage: edit-dsl",
    `clause ${index} of ${total} (${addressJson(locator)} in ${JSON.stringify(path)}) failed; the whole edit-dsl reply is discarded and nothing is written`,
    diagnostics,
  ].join("\n");
}

// Overlap rejection on the edit-dsl path (#111): both clauses are named, and the
// whole reply is discarded because edit-dsl replies are atomic.
function editDslOverlapDiagnostics(
  total: number,
  path: string,
  earlier: ResolvedRegion,
  later: ResolvedRegion,
): string {
  return [
    "stage: edit-dsl",
    `clause ${earlier.index + 1} and clause ${later.index + 1} of ${total} both edit ${JSON.stringify(path)} but their regions overlap (offsets ${earlier.start}..${earlier.end} and ${later.start}..${later.end}); the whole edit-dsl reply is discarded and nothing is written`,
    `clause ${earlier.index + 1} (${addressJson(earlier.locator)}) and clause ${later.index + 1} (${addressJson(later.locator)}) must address non-overlapping regions, or be split across replies`,
  ].join("\n");
}

// Bridge a resolved edit-dsl editor clause into the shared `ResolvedRegion`
// shape; the edit-dsl path already carries the cascade stage and matcher kind
// (#110), so no reclassification is needed.
function editDslRegionToResolved(region: EditDslRegion): ResolvedRegion {
  return {
    index: region.index,
    path: region.path,
    locator: region.locator,
    start: region.start,
    end: region.end,
    text: region.text,
    replacement: region.text,
    stage: region.stage,
    matcherKind: region.matcherKind,
    create: region.create,
  };
}

interface ResolvedRegion {
  /** Clause/payload position in the reply (0-based), for diagnostics. */
  index: number;
  /** The file the region edits (a same-file batch shares it). */
  path: string;
  locator: Locator;
  /** Half-open offsets into the file's current source. */
  start: number;
  end: number;
  /** Text spliced over `[start, end)`. */
  text: string;
  /** The raw replacement, used by the gate diagnostic's code frame. */
  replacement: string;
  /** The cascade stage that resolved the region (#110). */
  stage: SelectionStage;
  /** The matcher form that resolved it (#110), or null. */
  matcherKind: MatcherKind | null;
  /** True for an edit-dsl implicit create (a new whole declaration). */
  create: boolean;
}

// Overlap rejection (#78): two same-file regions share source text, so they
// cannot both be applied in one pass. Names both positions and their spans; the
// whole exchange is discarded.
function multiOverlapDiagnostics(
  total: number,
  path: string,
  earlier: ResolvedRegion,
  later: ResolvedRegion,
): string {
  return [
    "stage: multi",
    `payload ${earlier.index + 1} and payload ${later.index + 1} of ${total} both edit ${JSON.stringify(path)} but their regions overlap (offsets ${earlier.start}..${earlier.end} and ${later.start}..${later.end}); the whole exchange is discarded and nothing is written`,
    `payload ${earlier.index + 1} (${addressJson(earlier.locator)}) and payload ${later.index + 1} (${addressJson(later.locator)}) must address non-overlapping regions, or be split across exchanges`,
  ].join("\n");
}

/** One region failed the shared per-file apply pipeline. */
interface RegionFailureNote {
  region: ResolvedRegion;
  path: string;
  stage: EditFailureStage;
  diagnostics: string;
  matcherCause?: MatcherCause;
  formatMessage?: string;
}

/** The shared apply pipeline detected an overlap between two same-file regions. */
type RegionOverlapNote = (path: string, earlier: ResolvedRegion, later: ResolvedRegion) => void;

/**
 * Apply already-resolved regions, one pass per file: overlap rejection, the
 * prev-broken/gate/duplicate/format/no-op guards, and the final formatted write.
 * Used by both the JSON batch path (#69/#78) and edit-dsl replies (#111). A
 * per-file failure is reported through `noteFailure` for every region in that
 * file (the whole file is discarded) and the file is skipped; other files still
 * produce writes here. The edit-dsl caller then treats any reported failure as
 * whole-reply atomic and discards every returned write.
 */
async function applyResolvedRegions(input: {
  regions: readonly ResolvedRegion[];
  fileSourceOf: (path: string) => string;
  target: string;
  prevCheck: ParseCheck;
  noteFailure: (note: RegionFailureNote) => void;
  noteOverlap: RegionOverlapNote;
}): Promise<{ path: string; source: string }[]> {
  // Group the resolved regions by file and apply each file in one pass.
  const groups = new Map<string, ResolvedRegion[]>();
  for (const region of input.regions) {
    const group = groups.get(region.path);
    if (group === undefined) {
      groups.set(region.path, [region]);
    } else {
      group.push(region);
    }
  }
  const writes: { path: string; source: string }[] = [];
  for (const [path, group] of groups) {
    const payloadSource = input.fileSourceOf(path);
    const ordered = [...group].sort((left, right) => left.start - right.start);
    // Overlap policy (#78): two regions share source text, so the whole
    // exchange is discarded and both regions are named.
    let overlapping: [ResolvedRegion, ResolvedRegion] | null = null;
    // Zero-width inserts do not advance the sorted interval, so track every
    // insertion offset seen: two inserts at one offset overlap even when a
    // same-start non-zero region sorts between them (#13).
    const insertsAt = new Map<number, ResolvedRegion>();
    for (let i = 0; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      if (previous !== undefined && current !== undefined && current.start < previous.end) {
        overlapping = [previous, current];
        break;
      }
      if (current === undefined || current.start !== current.end) {
        continue;
      }
      const earlierInsert = insertsAt.get(current.start);
      if (earlierInsert !== undefined) {
        overlapping = [earlierInsert, current];
        break;
      }
      insertsAt.set(current.start, current);
    }
    if (overlapping !== null) {
      input.noteOverlap(path, overlapping[0], overlapping[1]);
      continue;
    }
    // Apply the file's splices together, from the end as `applyEdits` does, so
    // earlier offsets stay valid.
    let spliced = payloadSource;
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      const region = ordered[i];
      if (region === undefined) {
        continue;
      }
      spliced = applyMatcherSplice(spliced, region.start, region.end, region.text);
    }
    const payloadCheck = path === input.target ? input.prevCheck : parseCheck(payloadSource);
    if (!payloadCheck.ok) {
      // Unreachable for extra files: a strict resolution succeeded, so the file
      // parses.
      for (const region of ordered) {
        input.noteFailure({
          region,
          path,
          stage: "address",
          diagnostics: prevBrokenDiagnostics(path, payloadCheck.failure),
        });
      }
      continue;
    }
    const gate = parseCheck(spliced);
    if (!gate.ok) {
      for (const region of ordered) {
        input.noteFailure({
          region,
          path,
          stage: "gate",
          diagnostics: gateDiagnostics(region.start, region.replacement, gate.failure),
        });
      }
      continue;
    }
    const duplicate = duplicateDeclarationDiagnostics(
      payloadSource,
      path,
      payloadCheck.program,
      gate.program,
    );
    if (duplicate !== null) {
      for (const region of ordered) {
        input.noteFailure({ region, path, stage: "duplicate", diagnostics: duplicate });
      }
      continue;
    }
    let formatted: string | null = null;
    try {
      formatted = await formatSource(path, spliced);
    } catch (error) {
      for (const region of ordered) {
        input.noteFailure({
          region,
          path,
          stage: "format",
          diagnostics: `stage: format\n${errorMessage(error)}`,
          formatMessage: errorMessage(error),
        });
      }
      continue;
    }
    if (await sameAfterFormatting(path, payloadSource, formatted)) {
      for (const region of ordered) {
        input.noteFailure({ region, path, stage: "no-op", diagnostics: NOOP_DIAGNOSTICS });
      }
      continue;
    }
    writes.push({ path, source: formatted });
  }
  return writes;
}

function createExistsDiagnostics(
  locator: Locator,
  existing: readonly IndexEntry[],
  sourceByPath: ReadonlyMap<string, string>,
): string {
  const kinds = [...new Set(existing.map((entry) => entry.locator.kind))];
  return [
    "stage: address",
    `the name ${JSON.stringify(locator.name)} already exists in ${JSON.stringify(locator.path)} as ${kinds
      .map((kind) => JSON.stringify(kind))
      .join(", ")}; use mode "modify" to change it instead of "create"`,
    ...candidateLines(existing, sourceByPath),
  ].join("\n");
}

interface ParseFailure {
  message: string;
  offset: number;
  line: number;
  column: number;
}

type ParseCheck = { ok: true; program: Program } | { ok: false; failure: ParseFailure };

function parseCheck(source: string): ParseCheck {
  try {
    return { ok: true, program: new Parser(source).parseProgram() };
  } catch (error) {
    if (error instanceof ParseError || error instanceof LexError) {
      return {
        ok: false,
        failure: {
          message: error.message,
          offset: error.offset,
          line: error.line,
          column: error.column,
        },
      };
    }
    throw error;
  }
}

function prevBrokenDiagnostics(path: string, failure: ParseFailure): string {
  return [
    "stage: prev-broken",
    `the current source of ${JSON.stringify(path)} does not parse; this is external modification or a harness bug, so the run stops instead of repairing silently`,
    `${failure.message} (line ${failure.line}, column ${failure.column})`,
  ].join("\n");
}

/** Top-level declaration kinds TypeScript rejects when duplicated (#48). */
type DuplicateKind = "function" | "class" | "type";

interface TopLevelDeclaration {
  kind: DuplicateKind;
  name: string;
  offset: number;
}

// Counts the top-level declarations TypeScript rejects on duplicates: bodyful
// functions, classes, and type aliases. Overload signatures (bodyless) and
// interfaces/namespaces are deliberately not counted (#48).
function topLevelDeclarations(program: Program): TopLevelDeclaration[] {
  const declarations: TopLevelDeclaration[] = [];
  const collect = (statement: Statement | Expression): void => {
    switch (statement.kind) {
      case "FunctionDeclaration":
        if (statement.name !== null && statement.body !== null) {
          declarations.push({
            kind: "function",
            name: statement.name.name,
            offset: statement.start,
          });
        }
        return;
      case "ClassDeclaration":
        if (statement.name !== null) {
          declarations.push({ kind: "class", name: statement.name.name, offset: statement.start });
        }
        return;
      case "TypeAliasDeclaration":
        declarations.push({ kind: "type", name: statement.name.name, offset: statement.start });
        return;
      case "ExportNamedDeclaration":
        if (statement.declaration !== null) {
          collect(statement.declaration);
        }
        return;
      case "ExportDefaultDeclaration":
        collect(statement.declaration);
        return;
      default:
        return;
    }
  };
  for (const statement of program.body) {
    collect(statement);
  }
  return declarations;
}

/**
 * Top-level declaration span used to name the declaration a diagnostic sits in
 * (#87). Unlike `topLevelDeclarations` (the #48 duplicate guard, limited to the
 * kinds TypeScript rejects on duplicates), this covers every kind a repair
 * prompt can point at, including type aliases and variable statements.
 */
interface DeclarationSpan {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
}

function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  const limit = Math.min(Math.max(offset, 0), source.length);
  for (let index = 0; index < limit; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

// Parse `source` and return its top-level declaration spans in source order.
// A parse failure yields no spans: annotation is best-effort and must never
// throw out of the diagnostics renderer.
function declarationSpans(source: string): DeclarationSpan[] {
  let program: Program;
  try {
    program = new Parser(source).parseProgram();
  } catch (error) {
    if (error instanceof ParseError || error instanceof LexError) {
      return [];
    }
    throw error;
  }
  const spans: DeclarationSpan[] = [];
  const push = (node: Node, name: string, kind: string): void => {
    spans.push({
      name,
      kind,
      startLine: lineNumberAt(source, node.start),
      // `end` is exclusive, so the last included character is `end - 1`.
      endLine: lineNumberAt(source, Math.max(node.start, node.end - 1)),
    });
  };
  // `wrapper` is the enclosing `export` statement whose span the annotation
  // should cover, so a diagnostic on the modifier still maps to the name.
  const collect = (statement: Statement | Expression, wrapper?: Node): void => {
    const node = wrapper ?? statement;
    switch (statement.kind) {
      case "FunctionDeclaration":
        if (statement.name !== null) {
          push(node, statement.name.name, "function");
        }
        return;
      case "ClassDeclaration":
        if (statement.name !== null) {
          push(node, statement.name.name, "class");
        }
        return;
      case "InterfaceDeclaration":
        push(node, statement.name.name, "interface");
        return;
      case "TypeAliasDeclaration":
        push(node, statement.name.name, "type");
        return;
      case "EnumDeclaration":
        push(node, statement.name.name, "enum");
        return;
      case "NamespaceDeclaration":
        push(node, statement.name, "namespace");
        return;
      case "VariableStatement":
        for (const declarator of statement.declarations) {
          if (declarator.name.kind === "Identifier") {
            push(node, declarator.name.name, statement.declarationKind);
          }
        }
        return;
      case "ExportNamedDeclaration":
        if (statement.declaration !== null) {
          collect(statement.declaration, statement);
        }
        return;
      case "ExportDefaultDeclaration":
        collect(statement.declaration, statement);
        return;
      default:
        return;
    }
  };
  for (const statement of program.body) {
    collect(statement);
  }
  return spans;
}

// The first top-level span covering `line` (spans do not nest at top level, so
// the order is deterministic).
function enclosingDeclaration(
  spans: readonly DeclarationSpan[],
  line: number,
): DeclarationSpan | null {
  for (const span of spans) {
    if (line >= span.startLine && line <= span.endLine) {
      return span;
    }
  }
  return null;
}

// Duplicate-declaration guard (#48): reject a candidate that raises the
// top-level count of a (kind, name) TypeScript rejects on duplicates, naming
// the existing declaration.
function duplicateDeclarationDiagnostics(
  sourceBefore: string,
  target: string,
  before: Program,
  after: Program,
): string | null {
  const existing = topLevelDeclarations(before);
  const counts = new Map<string, number>();
  for (const declaration of existing) {
    const key = `${declaration.kind}:${declaration.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const declaration of topLevelDeclarations(after)) {
    const key = `${declaration.kind}:${declaration.name}`;
    const occurrences = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrences);
    const beforeCount = counts.get(key) ?? 0;
    // A name the file did not declare is new only on its first occurrence: two
    // new declarations of the same (kind, name) in one pass are still a
    // duplicate (#13), even though `before` has no line to point at.
    if (occurrences <= Math.max(beforeCount, 1)) {
      continue;
    }
    if (beforeCount === 0) {
      return [
        "stage: duplicate",
        `the edit was discarded: it would add a second top-level ${declaration.kind} ${JSON.stringify(declaration.name)} in ${target}; a single exchange may declare a new name only once`,
      ].join("\n");
    }
    const first = existing.find(
      (candidate) => candidate.kind === declaration.kind && candidate.name === declaration.name,
    );
    const offset = first === undefined ? declaration.offset : first.offset;
    const line = lineColumnAt(sourceBefore, offset).line;
    return [
      "stage: duplicate",
      `the edit was discarded: it would add a second top-level ${declaration.kind} ${JSON.stringify(declaration.name)} (${target} already declares it at line ${line}); replace the existing declaration instead of adding another copy`,
    ].join("\n");
  }
  return null;
}

// Map a gate parse error into the replacement when it falls inside the spliced
// range, so the model can see which part of its own text broke the file.
function gateDiagnostics(spliceStart: number, replacement: string, failure: ParseFailure): string {
  const lines = [
    "stage: gate",
    "the edit was discarded because the resulting source does not parse; nothing was written",
    `${failure.message} (line ${failure.line}, column ${failure.column})`,
  ];
  if (failure.offset >= spliceStart && failure.offset <= spliceStart + replacement.length) {
    const { line, column } = lineColumnAt(replacement, failure.offset - spliceStart);
    lines.push(`replacement line ${line}, column ${column}:`);
    lines.push(...codeFrame(toLines(replacement), line));
  }
  return lines.join("\n");
}

// The index node excludes a wrapping `export`; deleting an exported
// declaration should not leave a dangling `export` keyword behind.
function deleteRange(program: Program, node: Node): { start: number; end: number } {
  for (const statement of program.body) {
    if (
      statement.kind !== "ExportNamedDeclaration" &&
      statement.kind !== "ExportDefaultDeclaration"
    ) {
      continue;
    }
    const declaration = statement.declaration;
    if (declaration !== null && declaration.start === node.start && declaration.end === node.end) {
      return { start: statement.start, end: statement.end };
    }
  }
  return { start: node.start, end: node.end };
}

interface DeletionInput {
  options: LoopOptions;
  provider: ProviderLike;
  temperature: number | undefined;
  targetPath: string;
  locator: Locator;
  node: Node;
  /** Run-start source of the target file. */
  baseSource: string;
  messages: ChatMessage[];
  records: LoopRecord[];
  skipped?: SkippedFile[];
  iteration: number;
}

// `delete` carries no edit payload: Edit only picks the target (one exchange),
// the harness splices the resolved declaration out (range expanded to a
// wrapping `export`) and runs the syntax gate, format, write, and verification
// once. Any failure ends the run through the termination matrix (#43): a broken
// `prev` is `prev-broken`, a gate/format/tsc/test failure is
// `delete-verification-failed` — each with exactly one summary call.
async function executeDeletion(input: DeletionInput): Promise<LoopResult> {
  const { cwd } = input.options;
  const { targetPath, locator, node, baseSource } = input;
  const fail = async (
    reason: TerminationReason,
    diagnostics: string,
    outcome: VerificationOutcome,
    signature: number | null = null,
  ): Promise<LoopResult> => {
    input.records.push(
      recordRow({
        row: input.records.length + 1,
        iteration: input.iteration,
        kind: "verification",
        exchange: null,
        locator,
        replacement: "",
        diagnostics,
        outcome,
        finishReason: null,
        signature,
      }),
    );
    return {
      ok: false,
      mode: "delete",
      locator,
      filePath: targetPath,
      editedSource: null,
      records: input.records,
      diagnostics,
      explanation: await explain(
        input.provider,
        input.messages,
        input.temperature,
        reason,
        diagnostics,
      ),
      messages: input.messages,
      skipped: input.skipped,
      terminationReason: reason,
      tokens: zeroLoopTokens(),
    };
  };
  const prevCheck = parseCheck(baseSource);
  if (!prevCheck.ok) {
    return await fail(
      "prev-broken",
      prevBrokenDiagnostics(targetPath, prevCheck.failure),
      "prev-broken",
    );
  }
  const range = deleteRange(prevCheck.program, node);
  const spliced = applyMatcherSplice(baseSource, range.start, range.end, "");
  const gate = parseCheck(spliced);
  if (!gate.ok) {
    return await fail(
      "delete-verification-failed",
      gateDiagnostics(range.start, "", gate.failure),
      "gate",
    );
  }
  let newSource: string;
  try {
    newSource = await formatSource(targetPath, spliced);
  } catch (error) {
    return await fail(
      "delete-verification-failed",
      `stage: format\n${errorMessage(error)}`,
      "format",
    );
  }
  writeTarget(cwd, targetPath, newSource);
  const check = await checkTool(cwd, input.options.checkCommand, input.options.commandTimeoutMs);
  const test = await runVerificationTests(cwd, targetPath, input.options);
  if (check.ok && test.ok) {
    input.records.push(
      recordRow({
        row: input.records.length + 1,
        iteration: input.iteration,
        kind: "verification",
        exchange: null,
        locator,
        replacement: "",
        diagnostics: null,
        outcome: "ok",
        finishReason: null,
      }),
    );
    return {
      ok: true,
      mode: "delete",
      locator,
      filePath: targetPath,
      editedSource: newSource,
      records: input.records,
      diagnostics: null,
      explanation: null,
      messages: input.messages,
      skipped: input.skipped,
      tokens: zeroLoopTokens(),
    };
  }
  const diagnostics = formatDiagnostics({
    check,
    test,
    targetPath,
    baseSource,
    newSource,
    sourceFor: (file) => readFileIfExists(join(cwd, file)),
  });
  const signature = check.diagnostics.length + failingTestNames(test.output).length;
  return await fail(
    "delete-verification-failed",
    diagnostics,
    check.ok ? "tests" : "tsc",
    signature,
  );
}

// Re-resolve the address against the current on-disk source so retry prompts
// show what is actually there; fall back to the whole file when it no longer
// resolves to exactly one entry (for example after a corrupting attempt).
function currentSourceForPrompt(
  mode: "modify" | "create",
  targetPath: string,
  locator: Locator,
  currentSource: string,
): string {
  if (mode === "modify") {
    const build = buildIndexTolerant([{ path: targetPath, source: currentSource }]);
    const matches = build.index.lookup(locator);
    const entry = matches.length === 1 ? matches[0] : undefined;
    if (entry !== undefined) {
      return currentSource.slice(entry.node.start, entry.node.end);
    }
  }
  return currentSource;
}

// File-absolute start line for an edit-dsl retry's `# details` block. Create
// mode and whole-file repair views start at line 1; a pinned declaration slice
// starts at its declaration's line.
function editDslPromptStartLine(
  mode: "modify" | "create",
  targetPath: string,
  locator: Locator,
  diskSource: string,
  wholeFile: boolean,
): number {
  if (mode === "create" || wholeFile) {
    return 1;
  }
  const resolved = resolveCurrentEntry(diskSource, targetPath, locator, null);
  if (!resolved.ok) {
    return 1;
  }
  return diskSource.slice(0, resolved.entry.node.start).split("\n").length;
}

// The source a retry/continuation prompt shows. A repair iteration in modify
// mode shrinks the whole file to the declarations that matter when the toggle
// is on (returning the partial block as `preRendered`); otherwise this is the
// historic whole-file / re-resolved-declaration behavior, byte-identically.
function repairContextSource(opts: {
  mode: "modify" | "create";
  repair: boolean;
  target: string;
  locator: Locator;
  diskSource: string;
  diagnostics: string;
}): { source: string; preRendered?: string } {
  const wholeFile = opts.repair || opts.mode === "create";
  if (!wholeFile) {
    return { source: currentSourceForPrompt("modify", opts.target, opts.locator, opts.diskSource) };
  }
  if (opts.repair && opts.mode !== "create" && repairContextShrinkEnabled()) {
    const shrunk = shrinkRepairSource(opts.target, opts.diskSource, opts.locator, opts.diagnostics);
    if (shrunk !== null) {
      return { source: opts.diskSource, preRendered: shrunk };
    }
  }
  return { source: opts.diskSource };
}

// Run the sibling test file first for fast feedback; a targeted failure is the
// test verdict, otherwise the full suite still gates it.
async function runVerificationTests(
  cwd: string,
  targetPath: string,
  options: LoopOptions,
): Promise<CommandResult> {
  const command = options.testCommand ?? ["bun", "test"];
  if (targetPath.endsWith(".ts") && !targetPath.endsWith(TEST_FILE_SUFFIX)) {
    const sibling = `${targetPath.slice(0, -".ts".length)}${TEST_FILE_SUFFIX}`;
    if (existsSync(join(cwd, sibling))) {
      const targeted = await testTool(cwd, [...command, sibling], options.commandTimeoutMs);
      if (!targeted.ok) {
        return targeted;
      }
    }
  }
  return testTool(cwd, command, options.commandTimeoutMs);
}

// One whitelisted self-verification request (#73): `read` renders the pinned
// file's current source; `check`/`test` run the same commands Verification runs.
// The model names a kind, never a command string, so nothing else can run.
async function executeSelfCheck(
  kind: SelfCheckKind,
  context: {
    cwd: string;
    target: string;
    checkCommand?: string[];
    testCommand?: string[];
    commandTimeoutMs?: number;
  },
): Promise<string> {
  if (kind === "read") {
    const source = readFileIfExists(join(context.cwd, context.target));
    return renderSelfCheckRead(context.target, source ?? "");
  }
  if (kind === "check") {
    const result = await checkTool(context.cwd, context.checkCommand, context.commandTimeoutMs);
    return renderSelfCheckCommand("check", "the check command", result);
  }
  const result = await testTool(context.cwd, context.testCommand, context.commandTimeoutMs);
  return renderSelfCheckCommand("test", "the test command", result);
}

export interface DiagnosticsInput {
  check: CommandResult & { diagnostics: CheckDiagnostic[] };
  test: CommandResult;
  /** Repo-relative path of the edited file. */
  targetPath: string;
  /** Content before the edit ("" when the file was created). */
  baseSource: string;
  /** Formatted content that was written. */
  newSource: string;
  /**
   * Optional resolver for a diagnostic's file source, used to name the
   * declaration a diagnostic sits in (#87). When absent or returning null, a
   * diagnostic outside the target file renders as today.
   */
  sourceFor?: (file: string) => string | null;
}

export interface LineRange {
  /** 1-based inclusive; start === 0 when nothing changed. */
  start: number;
  end: number;
}

function toLines(source: string): string[] {
  const lines = source.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

// Line-based applied range, found by comparing both ends so it is agnostic to
// whole-symbol replacements and to lines inserted or removed around the edit.
export function editedRange(baseSource: string, newSource: string): LineRange {
  const newLines = toLines(newSource);
  if (baseSource === "") {
    return newLines.length === 0 ? { start: 0, end: 0 } : { start: 1, end: newLines.length };
  }
  const baseLines = toLines(baseSource);
  let start = 0;
  while (
    start < baseLines.length &&
    start < newLines.length &&
    baseLines[start] === newLines[start]
  ) {
    start += 1;
  }
  let endFromTail = 0;
  while (
    endFromTail < baseLines.length - start &&
    endFromTail < newLines.length - start &&
    baseLines[baseLines.length - 1 - endFromTail] === newLines[newLines.length - 1 - endFromTail]
  ) {
    endFromTail += 1;
  }
  const end = newLines.length - endFromTail;
  if (start >= end) {
    return { start: 0, end: 0 };
  }
  return { start: start + 1, end };
}

function inEditedRange(range: LineRange, line: number): boolean {
  return range.start > 0 && line >= range.start && line <= range.end;
}

function codeFrame(lines: readonly string[], line: number): string[] {
  const first = Math.max(1, line - 1);
  const last = Math.min(lines.length, line + 1);
  const frame: string[] = [];
  for (let current = first; current <= last; current += 1) {
    frame.push(`  ${current} | ${lines[current - 1] ?? ""}`);
  }
  return frame;
}

function messageWithCode(diagnostic: CheckDiagnostic): string {
  return diagnostic.code === undefined
    ? diagnostic.message
    : `${diagnostic.code}: ${diagnostic.message}`;
}

function renderElsewhere(diagnostic: CheckDiagnostic): string {
  if (diagnostic.file === "") {
    return messageWithCode(diagnostic);
  }
  const location = `${diagnostic.file}(${diagnostic.line},${diagnostic.column})`;
  return diagnostic.code === undefined
    ? `${location}: ${diagnostic.message}`
    : `${location}: error ${diagnostic.code}: ${diagnostic.message}`;
}

const FAILING_TEST_LIMIT = 10;
const MAPPED_DIAGNOSTIC_LIMIT = 10;
const TEST_OUTPUT_TAIL_LIMIT = Math.floor(DIAGNOSTICS_LIMIT / 2);
const TEST_TIMING_SUFFIX = /\s+\[\d+(?:\.\d+)?m?s\]$/;

export function failingTestNames(output: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    const marker = line.startsWith("(fail) ") ? "(fail) " : line.startsWith("✗ ") ? "✗ " : null;
    if (marker === null) {
      continue;
    }
    const name = line.slice(marker.length).trim().replace(TEST_TIMING_SUFFIX, "");
    if (name === "" || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
    if (names.length >= FAILING_TEST_LIMIT) {
      break;
    }
  }
  return names;
}

function testOutputTail(output: string): string {
  const text = output.trim();
  if (text.length <= TEST_OUTPUT_TAIL_LIMIT) {
    return text;
  }
  const omitted = text.length - TEST_OUTPUT_TAIL_LIMIT;
  return `[${omitted} earlier characters omitted]\n${text.slice(omitted)}`;
}

export function formatDiagnostics(input: DiagnosticsInput): string {
  const { check, test, targetPath, baseSource, newSource, sourceFor } = input;
  // #87's declaration suffix can be toggled at runtime so a benchmark can run
  // byte-identical arms. Read once per call so tests can flip it in-process.
  // Disabled only for `off`, `0`, or `false` (trimmed, lowercased); anything
  // else, including unset, keeps today's behavior.
  const declNamingSetting = (process.env.TC_DIAG_DECL_NAMING ?? "").trim().toLowerCase();
  const declNamingEnabled =
    declNamingSetting !== "off" && declNamingSetting !== "0" && declNamingSetting !== "false";
  const lines: string[] = [];
  if (!check.ok) {
    lines.push("stage: tsc");
    const range = editedRange(baseSource, newSource);
    const replacementLines = toLines(newSource);
    // Lazily parse each diagnostic's file once so a located diagnostic can name
    // the declaration whose span contains it (#87). The target file uses the
    // content that was written; other files go through the optional resolver.
    const spanCache = new Map<string, DeclarationSpan[]>();
    const spansFor = (file: string): DeclarationSpan[] => {
      const cached = spanCache.get(file);
      if (cached !== undefined) {
        return cached;
      }
      const source = file === targetPath ? newSource : (sourceFor?.(file) ?? null);
      const spans = source === null ? [] : declarationSpans(source);
      spanCache.set(file, spans);
      return spans;
    };
    const declarationSuffix = (diagnostic: CheckDiagnostic): string => {
      if (!declNamingEnabled || diagnostic.file === "") {
        return "";
      }
      const span = enclosingDeclaration(spansFor(diagnostic.file), diagnostic.line);
      return span === null ? "" : ` — in declaration \`${span.name}\` (${span.kind})`;
    };
    const mapped: CheckDiagnostic[] = [];
    const elsewhere: CheckDiagnostic[] = [];
    for (const diagnostic of check.diagnostics) {
      if (diagnostic.file === targetPath && inEditedRange(range, diagnostic.line)) {
        mapped.push(diagnostic);
      } else {
        elsewhere.push(diagnostic);
      }
    }
    for (const diagnostic of mapped.slice(0, MAPPED_DIAGNOSTIC_LIMIT)) {
      lines.push(
        `replacement line ${diagnostic.line - range.start + 1}: ${messageWithCode(diagnostic)}${declarationSuffix(diagnostic)}`,
      );
      lines.push(...codeFrame(replacementLines, diagnostic.line));
    }
    if (mapped.length > MAPPED_DIAGNOSTIC_LIMIT) {
      lines.push(`... ${mapped.length - MAPPED_DIAGNOSTIC_LIMIT} more in the replacement`);
    }
    if (elsewhere.length > 0) {
      lines.push("elsewhere in file:");
      for (const diagnostic of elsewhere) {
        lines.push(`${renderElsewhere(diagnostic)}${declarationSuffix(diagnostic)}`);
      }
    }
    if (check.diagnostics.length === 0 && check.output.trim() !== "") {
      lines.push(check.output.trim());
    }
  }
  if (!test.ok) {
    lines.push("stage: tests");
    lines.push("tests failed:");
    const names = failingTestNames(test.output);
    if (names.length > 0) {
      lines.push("failing tests:");
      for (const name of names) {
        lines.push(`  - ${name}`);
      }
    }
    const tail = testOutputTail(test.output);
    if (tail !== "") {
      lines.push("test output:");
      lines.push(tail);
    }
  }
  const text = lines.filter((line) => line !== "").join("\n");
  if (text.length <= DIAGNOSTICS_LIMIT) {
    return text;
  }
  // Keep the head (earliest tsc errors, i.e. the root causes) and the tail
  // (bun-test summary) with an explicit marker in between.
  const headLength = Math.floor(DIAGNOSTICS_LIMIT / 2);
  const tailLength = DIAGNOSTICS_LIMIT - headLength;
  const head = text.slice(0, headLength);
  const tail = text.slice(text.length - tailLength);
  const truncated = text.length - headLength - tailLength;
  return `${head}... [${truncated} characters truncated] ...${tail}`;
}

/**
 * One termination-step summary call (#43): the summary prompt is appended to
 * the bounded history and the provider is called exactly once. Provider errors
 * keep their own path and fall back to a readable string.
 */
async function explain(
  provider: ProviderLike,
  messages: ChatMessage[],
  temperature: number | undefined,
  reason: TerminationReason | "provider-error",
  diagnostics: string | null,
): Promise<string> {
  messages.push({ role: "user", content: buildSummaryPrompt(reason, diagnostics) });
  const options = temperature === undefined ? undefined : { temperature };
  try {
    const response = await provider.chat(messages, undefined, options);
    const text = stripCodeFences(response.content ?? "");
    return text === "" ? "the model did not provide an explanation" : text;
  } catch (error) {
    return `no explanation available: ${errorMessage(error)}`;
  }
}

function withEffort(base: ChatOptions | undefined, effort: ReasoningEffort): ChatOptions {
  return { ...base, reasoningEffort: effort };
}

type SelectionResolution = { ok: true; selection: Selection } | { ok: false; diagnostic: string };

// One strict-AND resolution for every mode: no silent first-match pick, no kind
// coercion, no auto-append. `create` additionally guards the target: a safe path
// whose name is absent under any kind.
function resolveSelection(
  cwd: string,
  index: SymbolIndex,
  files: readonly SourceFile[],
  skipped: readonly SkippedFile[],
  response: SelectionResponse,
): SelectionResolution {
  const locator = response.locator;
  const sourceByPath = new Map(files.map((file) => [file.path, file.source]));
  if (response.mode === "create") {
    const path = safeAppendPath(cwd, locator.path);
    if (path === null) {
      return {
        ok: false,
        diagnostic: `stage: address\nthe path ${JSON.stringify(locator.path)} is not a safe repo-relative target; use a relative path inside the repository without "..", hidden, or build segments`,
      };
    }
    const skippedFile = skipped.find((file) => file.path === locator.path);
    if (skippedFile !== undefined) {
      return {
        ok: false,
        diagnostic: `stage: address\nthe file ${JSON.stringify(locator.path)} could not be parsed and indexed (${skippedFile.message}); the harness does not append to a file it cannot parse`,
      };
    }
    const existing = index
      .byName(locator.name)
      .filter((entry) => entry.locator.path === locator.path);
    if (existing.length > 0) {
      return { ok: false, diagnostic: createExistsDiagnostics(locator, existing, sourceByPath) };
    }
    return { ok: true, selection: { mode: "create", locator, path } };
  }
  const matches = index.lookup(locator);
  if (matches.length === 0) {
    const skippedFile = skipped.find((file) => file.path === locator.path);
    if (skippedFile !== undefined) {
      return {
        ok: false,
        diagnostic: `stage: address\nthe file ${JSON.stringify(locator.path)} could not be parsed and indexed (${skippedFile.message})`,
      };
    }
    return {
      ok: false,
      diagnostic: addressMissDiagnostics(locator, index.byName(locator.name), sourceByPath),
    };
  }
  if (matches.length > 1) {
    return { ok: false, diagnostic: addressAmbiguousDiagnostics(locator, matches, sourceByPath) };
  }
  const entry = matches[0];
  if (entry === undefined) {
    return { ok: false, diagnostic: addressMissDiagnostics(locator, [], sourceByPath) };
  }
  return { ok: true, selection: { mode: response.mode, locator, entry } };
}

function exhaustedDiagnostics(openedBy: string | null, last: string | null): string {
  const reason = `edit-exhausted: the ${MAX_EDIT_EXCHANGES}-exchange Edit budget was exhausted without a valid edit`;
  const parts = [reason];
  if (openedBy !== null) {
    parts.push(openedBy);
  }
  if (last !== null) {
    parts.push(last);
  }
  return parts.join("\n\n");
}

// Retry/continuation diagnostics (#48/#52): the failure that opened the round
// plus the latest rejection, deduplicated when they are the same text.
function combinedDiagnostics(openedBy: string | null, last: string | null): string {
  if (openedBy !== null && last !== null && last !== openedBy) {
    return `${openedBy}\n\n${last}`;
  }
  return last ?? "the previous exchange was rejected";
}

// Cap diagnostic (#52): entering a Run iteration beyond MAX_RUN_ITERATIONS.
function capDiagnostics(openedBy: string | null): string {
  const reason = `edit-exhausted: the ${MAX_RUN_ITERATIONS}-round cap was reached without a verified edit`;
  return openedBy === null ? reason : `${reason}\n\n${openedBy}`;
}

// STOP diagnostic (#52): the model ended a continuation round itself.
function stoppedDiagnostics(rounds: number, context: string | null): string {
  const reason = `edit-exhausted: the model replied STOP after ${rounds} rounds`;
  return context === null ? reason : `${reason}\n\n${context}`;
}

// Stalled-stop diagnostic (#54): the model ended the run at the no-progress ask.
function stalledStopDiagnostics(failedRounds: number, context: string | null): string {
  const reason = `edit-exhausted: the model replied STOP after ${failedRounds} consecutive failed rounds`;
  return context === null ? reason : `${reason}\n\n${context}`;
}

// `STOP` is only special as the reply to a continuation prompt (#52) or to the
// no-progress ask (#54).
function isStopReply(response: ChatResponse): boolean {
  return (response.content ?? "").trim().toUpperCase() === "STOP";
}

/** One submitted modify payload, for the resubmission guard (#48/#69). */
interface ModifySubmissionEntry {
  /** Canonical as-sent `{path, symbol, kind}`. */
  locatorJson: string;
  matcher: string | null;
  /** Canonical `(line,column)` selector (#72), or null. */
  rangeJson: string | null;
  replacement: string;
}

/**
 * Previous modify-mode submission, for the resubmission guard (#48): one entry
 * for a classic payload, N entries for a multi-payload batch (#69); the guard
 * compares the whole submission, so a byte-identical resend of either shape is
 * rejected before any resolution or splice.
 */
interface ModifySubmission {
  entries: ModifySubmissionEntry[];
  /** True when the submission was written; false when it was rejected. */
  applied: boolean;
  /** First line of the rejection diagnostic when `applied` is false. */
  rejectionFirstLine: string | null;
}

function firstDiagnosticLine(diagnostics: string): string {
  const newline = diagnostics.indexOf("\n");
  return newline === -1 ? diagnostics : diagnostics.slice(0, newline);
}

function submissionOf(
  payloads: readonly EditPayload[],
  applied: boolean,
  rejectionFirstLine: string | null,
): ModifySubmission {
  return {
    entries: payloads.map((payload) => ({
      locatorJson: addressJson(payload.locator),
      matcher: payload.matcher,
      rangeJson: payload.range === null ? null : rangeJson(payload.range),
      replacement: payload.replacement,
    })),
    applied,
    rejectionFirstLine,
  };
}

/** Canonical, comparable form of a `range` selector (#72). */
function rangeJson(range: EditRange): string {
  return `${range.line},${range.column},${range.endLine},${range.endColumn}`;
}

function sameModifySubmission(
  submission: ModifySubmission,
  payloads: readonly EditPayload[],
): boolean {
  if (submission.entries.length !== payloads.length) {
    return false;
  }
  return payloads.every((payload, index) => {
    const entry = submission.entries[index];
    return (
      entry !== undefined &&
      entry.locatorJson === addressJson(payload.locator) &&
      entry.matcher === payload.matcher &&
      entry.rangeJson === (payload.range === null ? null : rangeJson(payload.range)) &&
      entry.replacement === payload.replacement
    );
  });
}

// `stage: repeat` (#48): byte-identical resubmission cannot change anything,
// and the wording distinguishes an already-applied edit from a rejected one.
function repeatDiagnostics(submission: ModifySubmission): string {
  if (submission.applied) {
    return 'stage: repeat\nthis exact edit was already applied and the file already contains its effect; verification still fails, so resending it cannot change the outcome — adjust the replacement, omit "matcher" for a whole-symbol rewrite, or re-pin to a declaration the diagnostics name';
  }
  const rejected = submission.rejectionFirstLine ?? "the previous rejection";
  return `stage: repeat\nthis exact edit was just rejected (${rejected}); resending it verbatim cannot succeed — change the payload`;
}

export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const temperature = options.temperature;
  const chatOptions: ChatOptions | undefined =
    temperature === undefined ? undefined : { temperature };
  const cwd = options.cwd;
  const files = discoverSourceFiles(cwd);
  const build = buildIndexTolerant(files);
  const contextYaml = buildContextYaml(files, build);
  const index = build.index;
  const skipped = build.skipped;
  const specFiles = selectSpecFiles(options.issue, files);
  // Explicit-targets mode (#81): the run edits exactly these addresses and
  // forces the #69 batch shape so one exchange can cover several files.
  const targets = options.targets ?? [];
  const targetsMode = targets.length > 0;
  const multiPayload = options.multiPayload === true || targetsMode;
  // #119: the selected edit protocol. Explicit-targets mode (#81) is JSON-only,
  // so it overrides the flag to keep the batch/pick path byte-identical.
  const protocolFormat: ProtocolFormat = targetsMode
    ? "json"
    : (options.protocolFormat ?? "edit-dsl");
  // #119: edit-dsl is only required outside explicit-targets mode.
  const editDslRequired = protocolFormat === "edit-dsl" && !targetsMode;
  // B1: the edit-dsl symbol index is a select-line list, not YAML. Build it only
  // for the edit-dsl path so the explicit-json prompts stay byte-identical.
  const editDslIndexText = editDslRequired ? buildEditDslSymbolIndex(index) : "";
  // Pending targets (not yet applied), applied targets, and targets that never
  // resolved to a unique modify-able declaration.
  const targetQueue: Locator[] = [...targets];
  const targetFailures: { locator: Locator; diagnostics: string }[] = [];
  const systemMessage: ChatMessage = {
    role: "system",
    content: buildSystemPrompt(multiPayload, protocolFormat),
  };
  const issueMessage: ChatMessage = {
    role: "user",
    content: editDslRequired
      ? buildEditDslUserPrompt(options.issue, editDslIndexText, specFiles)
      : buildUserPrompt(options.issue, contextYaml, specFiles),
  };
  // Lean issue message (#49): same issue text and project context without the
  // spec-file section. Rounds opened by a `tsc`-stage verification failure
  // send it on every content exchange — their repair is driven by the
  // diagnostics and the current source; all other rounds keep the full message.
  const leanIssueMessage: ChatMessage = {
    role: "user",
    content: editDslRequired
      ? buildEditDslUserPrompt(options.issue, editDslIndexText, [])
      : buildUserPrompt(options.issue, contextYaml, []),
  };
  // Round 1 (and selection-continuation rounds, which carry no verification
  // stage) always starts from the full message; the per-round variant is chosen
  // at the top of the Run loop and applied on the content-exchange rebuild.
  const initialMessages: ChatMessage[] = [systemMessage, issueMessage];
  let messages: ChatMessage[] = initialMessages;
  const records: LoopRecord[] = [];
  let consumedTokens = 0;
  // Component token tally (#80), accumulated alongside `consumedTokens` (which
  // keeps driving the budget unchanged).
  const tokens: LoopTokens = zeroLoopTokens();
  const addTokens = (delta: LoopTokens): void => {
    tokens.input += delta.input;
    tokens.output += delta.output;
    tokens.total += delta.total;
    tokens.cacheRead += delta.cacheRead;
  };

  // Pinning (#43): the first successful pick fixes {mode, path, symbol, kind}
  // for the run; later exchanges revise content only and must echo the address.
  let pinned: { mode: SelectionMode; locator: Locator } | null = null;
  let pinnedAddressJson = "";
  // EditDsl select-first: the model's own `select … end` reply is the
  // assistant turn shown in the content exchange (JSON keeps the canonical pin).
  let pinnedAssistantContent: string | null = null;
  // A first-turn edit-dsl editor already carries its `replace`; its reply is
  // applied in the content branch without a second provider call.
  let prefetchedReply: ChatResponse | null = null;
  // #8: an edit-dsl confirmation editor that arrives on the round's last normal
  // exchange has no in-round slot. Its already-counted reply is carried into a
  // fresh round and applied as that round's first exchange (no second provider
  // call), paired with the `# modified text` prompt it answered.
  let pendingConfirmation: { reply: ChatResponse; prompt: string } | null = null;
  // Run-start source of the target file ("" when the file did not exist).
  let baseSource = "";
  // First content prompt after a pick; null once a retry prompt takes over.
  let initialContentPrompt: string | null = null;
  // Create→repair (#41): once a failed create keeps a parseable file, content
  // exchanges are modify rounds against the kept file and prompts show it whole.
  let repair = false;
  // Verification diagnostics that opened the current Run iteration.
  let pendingDiagnostics: string | null = null;
  // #111: a mixed edit-dsl reply's viewer occurrences, carried into the next
  // prompt's diagnostics when the editors applied but verification later fails.
  let carriedViewerFeedback: string | null = null;
  // Stage of the verification failure that opened the current Run iteration
  // (#49): `tsc` makes the round's content prompts lean.
  let pendingVerificationStage: "tsc" | "tests" | null = null;
  // Consecutive no-progress rounds (#54/#60): incremented once at every failed
  // verification and once at every round that ends with no applied edit
  // (rejection-exhausted, truncated, or spent picking). It survives rounds and
  // #52 continuations and is never reset (a passing verification ends the run).
  let stalledRounds = 0;
  // Per-cause retry policy (#56): the last rejection cause and the length of
  // the consecutive-same-cause streak, plus the correction sentence the next
  // edit retry must carry (the escalation once the streak reaches 2, and the
  // #65 context: the round's opening diagnostics and an undeclared address
  // name). An applied edit resets all three; verification failures and #52
  // continuations deliberately do not.
  let lastRejectionCause: RejectionCause | null = null;
  let lastRejectionStreak = 0;
  let lastCorrection: string | null = null;
  const registerRejection = (cause: RejectionCause, context: RejectionLeadContext = {}): void => {
    if (cause === lastRejectionCause) {
      lastRejectionStreak += 1;
    } else {
      lastRejectionCause = cause;
      lastRejectionStreak = 1;
    }
    lastCorrection = rejectionLead(cause, lastRejectionStreak, { ...context, protocolFormat });
  };
  const clearRejectionPolicy = (): void => {
    lastRejectionCause = null;
    lastRejectionStreak = 0;
    lastCorrection = null;
  };
  // Prior-attempts digest (#57): a bounded, incrementally-updated checkpoint of
  // the failing chain. It is rendered into the #52 round-continuation prompts
  // and the #54 no-progress ask only; `digestText` advances it over the records
  // the previous prompt has not seen yet, immediately before rendering.
  const attemptDigest = createAttemptDigestState(protocolFormat);
  const digestText = (): string => {
    updateAttemptDigest(attemptDigest, records);
    return renderAttemptDigest(attemptDigest);
  };
  // Resubmission guard (#48): the last modify-mode payload, kept across
  // iterations; a byte-identical resend is rejected as `stage: repeat`.
  let lastModifySubmission: ModifySubmission | null = null;
  // Round-level continuation (#52): a round that exhausts its ≤3 exchanges
  // below the cap does not end the run; the next iteration opens with this
  // continuation prompt and its reply is the first exchange of the fresh round.
  let continuation: {
    /** Round that exhausted its budget (the prompt names it). */
    round: number;
    /** True when the new round must re-pick the target. */
    pick: boolean;
    /** Opening + latest rejection diagnostics carried into the prompt. */
    diagnostics: string;
  } | null = null;

  // Applied targets (#81): every address an applied exchange covered, in order,
  // for the result report.
  const appliedTargets: Locator[] = [];
  // Set when a targets round passes verification but pending targets remain, so
  // the outer loop opens a fresh round instead of returning success.
  let continueTargets = false;
  // The active coverable set for one exchange (#81): the first pending target
  // per file, since same-file targets are sequenced across exchanges.
  const activeTargets = (): Locator[] => {
    const seen = new Set<string>();
    const active: Locator[] = [];
    for (const target of targetQueue) {
      if (seen.has(target.path)) {
        continue;
      }
      seen.add(target.path);
      active.push(target);
    }
    return active;
  };
  // Resolve and pin the next pending target (#81), skipping any target that
  // does not resolve to exactly one modify-able declaration — recorded as a
  // staged diagnostic, never a silent pick. Returns false when none remain.
  const seedNextTarget = (): boolean => {
    while (targetQueue.length > 0) {
      const next = targetQueue[0];
      if (next === undefined) {
        break;
      }
      const disk = readFileIfExists(join(cwd, next.path)) ?? "";
      const resolution = resolveSelection(
        cwd,
        buildIndexTolerant([{ path: next.path, source: disk }]).index,
        [{ path: next.path, source: disk }],
        [],
        { mode: "modify", locator: next },
      );
      if (!resolution.ok || resolution.selection.mode !== "modify") {
        const diagnostic = resolution.ok
          ? `stage: address\nthe target ${addressJson(next)} cannot be modified with mode "modify"`
          : resolution.diagnostic;
        targetQueue.shift();
        targetFailures.push({ locator: next, diagnostics: diagnostic });
        records.push(
          recordRow({
            row: records.length + 1,
            iteration,
            kind: "exchange",
            exchange: null,
            locator: next,
            replacement: null,
            diagnostics: diagnostic,
            outcome: "address",
            finishReason: null,
          }),
        );
        continue;
      }
      const selection = resolution.selection;
      pinned = { mode: "modify", locator: selection.locator };
      pinnedAddressJson = pinJson(pinned);
      baseSource = disk;
      const symbolSource = disk.slice(selection.entry.node.start, selection.entry.node.end);
      initialContentPrompt = buildTargetsEditPrompt(
        addressJson(selection.locator),
        symbolSource,
        activeTargets(),
      );
      return true;
    }
    return false;
  };
  // The failure report naming any requested target that was never applied (#81).
  const targetsDiagnostics = (): string | null => {
    if (targetQueue.length === 0 && targetFailures.length === 0) {
      return null;
    }
    const lines = ["requested targets not applied:"];
    for (const failure of targetFailures) {
      lines.push(`- ${addressJson(failure.locator)}: ${firstDiagnosticLine(failure.diagnostics)}`);
    }
    for (const pending of targetQueue) {
      lines.push(`- ${addressJson(pending)}: never applied`);
    }
    return lines.join("\n");
  };
  const withTargetsReport = (diagnostics: string | null): string | null => {
    if (!targetsMode) {
      return diagnostics;
    }
    const report = targetsDiagnostics();
    if (report === null) {
      return diagnostics;
    }
    if (diagnostics === null || diagnostics.trim() === "") {
      return report;
    }
    return `${diagnostics}\n\n${report}`;
  };

  const success = (editedSource: string | null): LoopResult => ({
    ok: true,
    mode: pinned?.mode,
    locator: pinned?.locator ?? null,
    filePath: pinned?.locator.path ?? null,
    editedSource,
    records,
    diagnostics: null,
    explanation: null,
    messages,
    skipped,
    tokens,
    appliedTargets: targetsMode ? [...appliedTargets] : undefined,
  });
  // Termination step (#43): record rows are already pushed; the only remaining
  // action is exactly one summary call, then the run stops.
  const terminate = async (
    reason: TerminationReason,
    diagnostics: string | null,
  ): Promise<LoopResult> => {
    const reported = withTargetsReport(diagnostics);
    return {
      ok: false,
      mode: pinned?.mode,
      locator: pinned?.locator ?? null,
      filePath: pinned?.locator.path ?? null,
      editedSource: null,
      records,
      diagnostics: reported,
      explanation: await explain(options.provider, messages, temperature, reason, reported),
      messages,
      skipped,
      terminationReason: reason,
      tokens,
      appliedTargets: targetsMode ? [...appliedTargets] : undefined,
    };
  };

  let iteration = 0;
  // STOP (#52/#54): the reply to a continuation prompt or to the no-progress
  // ask may end the run; it is recorded as an exchange row with the dedicated
  // `stopped` outcome, carrying the diagnostics builder's text.
  const stopRun = async (
    exchange: number,
    response: ChatResponse,
    diagnostics: string,
  ): Promise<LoopResult> => {
    records.push(
      recordRow({
        row: records.length + 1,
        iteration,
        kind: "exchange",
        exchange,
        locator: pinned?.locator ?? EMPTY_LOCATOR,
        replacement: response.content ?? null,
        diagnostics,
        outcome: "stopped",
        finishReason: response.finishReason,
        toolCalls: response.toolCalls.length,
      }),
    );
    return await terminate("edit-exhausted", diagnostics);
  };
  for (;;) {
    iteration += 1;
    // Hard cap (#52): rounds 1..MAX_RUN_ITERATIONS run; entering the next one
    // terminates through the existing chain naming the cap.
    if (iteration > MAX_RUN_ITERATIONS) {
      return await terminate("edit-exhausted", capDiagnostics(pendingDiagnostics));
    }
    initialContentPrompt = null;
    prefetchedReply = null;
    // #8: reopen a carried confirmation editor as this round's first content
    // exchange. The reply's tokens were counted when the confirmation call ran
    // on the previous round, so it is reused verbatim, once.
    if (pendingConfirmation !== null) {
      prefetchedReply = pendingConfirmation.reply;
      initialContentPrompt = pendingConfirmation.prompt;
      pendingConfirmation = null;
    }
    continueTargets = false;
    let verificationFailed = false;
    // True once this round writes an edit; a round that ends without one is a
    // no-progress round (#60).
    let appliedEdit = false;
    let lastDiagnostics: string | null = pendingDiagnostics;
    let lastFailure: "edit" | "verification" =
      pendingDiagnostics === null ? "edit" : "verification";
    // Verification diagnostics that opened this iteration, kept for the
    // edit-exhausted summary even after edit soft failures overwrite `last`.
    const iterationOpenedBy: string | null = lastDiagnostics;
    // Stage that opened this iteration (#49), carried with the diagnostics so a
    // #52 continuation keeps its chain's prompt variant.
    const iterationOpenedByStage: "tsc" | "tests" | null = pendingVerificationStage;
    pendingDiagnostics = null;
    pendingVerificationStage = null;
    // Content prompts of a tsc-stage repair round omit the spec-file section
    // (#49); every other round keeps the full issue message.
    const roundIssueMessage = iterationOpenedByStage === "tsc" ? leanIssueMessage : issueMessage;
    // Previous content rejection within this iteration, for the identical-
    // retry note (#48); resets every iteration.
    let lastRejection: string | null = null;
    // Bounded self-verification request (#73), per Run iteration: `selfCheckUsed`
    // enforces the at-most-one execution, `pendingSelfCheck` carries the one
    // result into the next prompt.
    let selfCheckUsed = false;
    let pendingSelfCheck: string | null = null;
    // Decision-only turn (#75), per Run iteration: `decisionTurn` is set while
    // building the first prompt of a repeated non-converging ask; a non-edit
    // reply to it is clamped into `pendingApproach` and carried into the next
    // exchange's edit prompt instead of being applied.
    let decisionTurn = false;
    let pendingApproach: string | null = null;
    const retryDiagnostics = (diagnostics: string): string => {
      const identical = lastRejection === diagnostics;
      lastRejection = diagnostics;
      return identical ? `${IDENTICAL_RETRY_NOTE}\n${diagnostics}` : diagnostics;
    };
    // Create→repair transition (#41) at the start of an iteration after a failed
    // create verification: a kept file that parses becomes a modify repair; an
    // absent or unparseable kept file is removed and create re-runs.
    if (pinned !== null && pinned.mode === "create" && lastFailure === "verification") {
      const keptPath = join(cwd, pinned.locator.path);
      const kept = readFileIfExists(keptPath);
      const keptCheck = kept === null ? null : parseCheck(kept);
      if (kept !== null && keptCheck !== null && keptCheck.ok) {
        repair = true;
        pinned.mode = "modify";
        pinnedAddressJson = pinJson(pinned);
        baseSource = kept;
      } else {
        rmSync(keptPath, { force: true });
      }
    }

    // Round-level continuation (#52): the prompt built when the previous round
    // exhausted its exchanges below the cap; the reply to it is the first
    // exchange of this round.
    const pendingContinuation = continuation;
    continuation = null;

    // No-progress ask (#54/#60): a round that opens on a stalled streak (a
    // positive multiple of MAX_STALLED_ROUNDS) asks the model to decide in its
    // first content prompt. A verification-failure cycle opens the round
    // directly; a rejection-exhausted cycle (#60) opens through the #52
    // continuation prompt, which then carries the ask framing instead of the
    // round-exhausted header. Every continuation-producing round advanced the
    // counter in the same iteration, so a milestone here is the one the
    // previous round just crossed. A selection continuation has no pinned
    // target and keeps its own STOP framing.
    const stalledAsk =
      !targetsMode &&
      pinned !== null &&
      isStalledAskMilestone(stalledRounds) &&
      (pendingContinuation !== null || iterationOpenedBy !== null);

    let continuationPrompt: string | null = null;
    let continuationDiagnostics: string | null = null;
    if (pendingContinuation !== null) {
      continuationDiagnostics = pendingContinuation.diagnostics;
      // Failure history (#71): the trailing verification failures as the
      // prompts see them (chain reset included); computed once per
      // continuation and threaded into both variants. The same pattern feeds the
      // sharpened 2nd+ ask framing (#65).
      const failurePattern = detectFailurePattern(records);
      const failureHistory = renderFailureHistoryNote(failurePattern);
      if (pendingContinuation.pick) {
        continuationPrompt = editDslRequired
          ? buildEditDslSelectionContinuationPrompt({
              round: pendingContinuation.round,
              maxRounds: MAX_RUN_ITERATIONS,
              issue: options.issue,
              indexText: editDslIndexText,
              diagnostics: pendingContinuation.diagnostics,
              digest: digestText(),
              failureHistory,
            })
          : buildSelectionContinuationPrompt({
              round: pendingContinuation.round,
              maxRounds: MAX_RUN_ITERATIONS,
              diagnostics: pendingContinuation.diagnostics,
              digest: digestText(),
              failureHistory,
            });
        messages = [systemMessage, issueMessage, { role: "user", content: continuationPrompt }];
      } else {
        const continuedTarget = pinned;
        if (continuedTarget === null) {
          // Unreachable: an edit continuation is only set after a pick.
          throw new Error("edit continuation without a pinned target");
        }
        const target = continuedTarget.locator.path;
        const diskSource = readFileIfExists(join(cwd, target)) ?? "";
        const repairSource = repairContextSource({
          mode: continuedTarget.mode === "create" ? "create" : "modify",
          repair,
          target,
          locator: continuedTarget.locator,
          diskSource,
          diagnostics: pendingContinuation.diagnostics,
        });
        const currentSource =
          repairSource.preRendered !== undefined
            ? repairSource.source
            : truncateSource(repairSource.source);
        const stalledInfo: StalledAsk | undefined = stalledAsk
          ? {
              failedRounds: stalledRounds,
              round: iteration,
              maxRounds: MAX_RUN_ITERATIONS,
              askNumber: stalledAskNumber(stalledRounds),
              history: failurePattern,
            }
          : undefined;
        decisionTurn = stalledInfo !== undefined && isDecisionAsk(stalledInfo);
        continuationPrompt = buildContinuationPrompt({
          round: pendingContinuation.round,
          maxRounds: MAX_RUN_ITERATIONS,
          mode: continuedTarget.mode === "create" ? "create" : "modify",
          locatorJson: pinnedAddressJson,
          currentSource,
          preRenderedSource: repairSource.preRendered,
          diagnostics: pendingContinuation.diagnostics,
          // The ask names re-pinning as a concrete alternative, so its round
          // may move the pin exactly like a verification-opened ask round.
          repin: (iterationOpenedBy !== null || stalledAsk) && continuedTarget.mode === "modify",
          digest: digestText(),
          failureHistory,
          stalled: stalledInfo,
          multiPayload: multiPayload,
          protocolFormat,
          editDslContext: editDslRequired
            ? {
                issue: options.issue,
                indexText: editDslIndexText,
                startLine: editDslPromptStartLine(
                  continuedTarget.mode === "create" ? "create" : "modify",
                  target,
                  continuedTarget.locator,
                  diskSource,
                  repair,
                ),
              }
            : undefined,
        });
      }
    }

    // Explicit-targets mode (#81): the target queue drives every round — there
    // is no model pick and no #52 round continuation. Seed (or advance to) the
    // next pending target and name the pending addresses in its edit prompt.
    // With no pending target left, fall through to the ordinary repair path.
    if (targetsMode && targetQueue.length > 0) {
      continuation = null;
      if (!seedNextTarget() && pendingDiagnostics === null) {
        return await terminate("edit-exhausted", null);
      }
    }

    for (let exchange = 1; exchange <= MAX_EDIT_EXCHANGES; exchange += 1) {
      const pick = pinned === null;
      // Reasoning policy (#35; revised 2026-10-18 after the effort sweep and
      // the none/none/max canonical run): every Edit-loop call runs at "none". The
      // sweep showed reasoning only added cost on the happy path (json/sexp)
      // and that escalation on verification-repair rounds converted nothing on
      // minilisp (max rewrites even broke tsc). Retries stay flat until
      // repair-round convergence improves. An effortOverride forces one effort
      // on every call for benchmark sweeps.
      const exchangeOptions =
        options.effortOverride !== undefined
          ? withEffort(chatOptions, options.effortOverride)
          : withEffort(chatOptions, "none");

      if (pick) {
        let response: ChatResponse;
        try {
          response = await options.provider.chat(messages, undefined, exchangeOptions);
        } catch (error) {
          const diagnostics = providerErrorDiagnostics(error);
          return {
            ok: false,
            mode: pinned?.mode,
            locator: null,
            filePath: null,
            editedSource: null,
            records,
            diagnostics,
            explanation: await explain(
              options.provider,
              messages,
              temperature,
              "provider-error",
              diagnostics,
            ),
            messages,
            skipped,
            tokens,
          };
        }
        consumedTokens += tokensFromResponse(response);
        addTokens(loopTokensFromResponse(response));
        if (consumedTokens > tokenBudget) {
          return await terminate(
            "token-budget",
            tokenBudgetDiagnostics(consumedTokens, tokenBudget),
          );
        }
        // Only the continuation prompt offers STOP (#52).
        if (exchange === 1 && continuationPrompt !== null && isStopReply(response)) {
          return await stopRun(
            exchange,
            response,
            stoppedDiagnostics(iteration, continuationDiagnostics),
          );
        }
        let candidate: Locator = EMPTY_LOCATOR;
        let resolution: SelectionResolution | null = null;
        let diagnostic: string | null = null;
        let selectionStage: "protocol" | "address" = "protocol";
        // EditDsl select-first (#B1): the pick reply is one `select … end`
        // clause. It pins modify when the address resolves, create when the name
        // or space is missing, and an editor clause prefetches its own reply for
        // the content exchange.
        let editDslPick: {
          selection: EditDslSelection;
          mode: "modify" | "create";
          entry: IndexEntry | null;
          source: string;
        } | null = null;
        if (editDslRequired) {
          try {
            const parsed = parseSelection(stripCodeFences(response.content ?? ""));
            if (parsed.length !== 1) {
              diagnostic = `stage: protocol\nthe first edit-dsl reply must be exactly one \`select … end\` clause; found ${parsed.length}`;
            } else {
              const selected = parsed[0];
              if (selected !== undefined) {
                candidate = selected.locator;
                const pickSource = readFileIfExists(join(cwd, selected.locator.path)) ?? "";
                const resolved = resolveCurrentEntry(
                  pickSource,
                  selected.locator.path,
                  selected.locator,
                  selected.space,
                );
                if (resolved.ok) {
                  editDslPick = {
                    selection: selected,
                    mode: "modify",
                    entry: resolved.entry,
                    source: pickSource,
                  };
                } else if (resolved.undeclared || resolved.spaceMiss) {
                  editDslPick = {
                    selection: selected,
                    mode: "create",
                    entry: null,
                    source: pickSource,
                  };
                } else {
                  diagnostic = resolved.diagnostics;
                  selectionStage = "address";
                }
              }
            }
          } catch (error) {
            if (!(error instanceof SelectionSyntaxError)) {
              throw error;
            }
            diagnostic = EDIT_DSL_FORCE_DIAGNOSTICS;
          }
        } else {
          try {
            const parsed = selectionFromResponse(response);
            candidate = parsed.locator;
            resolution = resolveSelection(cwd, index, files, skipped, parsed);
          } catch (error) {
            diagnostic = `stage: protocol\n${errorMessage(error)}`;
          }
          if (resolution !== null && !resolution.ok) {
            diagnostic = resolution.diagnostic;
            selectionStage = "address";
          }
        }
        if (diagnostic !== null) {
          const cause = classifyRejection({ stage: selectionStage });
          records.push(
            recordRow({
              row: records.length + 1,
              iteration,
              kind: "exchange",
              exchange,
              locator: candidate,
              replacement: null,
              diagnostics: diagnostic,
              outcome: selectionStage,
              finishReason: response.finishReason,
              cause,
              toolCalls: response.toolCalls.length,
            }),
          );
          registerRejection(cause);
          lastDiagnostics = diagnostic;
          lastFailure = "edit";
          if (exchange === MAX_EDIT_EXCHANGES) {
            if (iteration >= MAX_RUN_ITERATIONS) {
              return await terminate("edit-exhausted", capDiagnostics(iterationOpenedBy));
            }
            // Selection exhaustion (#52): the next round re-asks for the
            // target (or STOP) instead of ending the run.
            continuation = {
              round: iteration,
              pick: true,
              diagnostics: combinedDiagnostics(iterationOpenedBy, diagnostic),
            };
            break;
          }
          messages.push({ role: "assistant", content: response.content ?? "" });
          messages.push({
            role: "user",
            content: editDslRequired
              ? buildEditDslSelectionRetryPrompt(options.issue, editDslIndexText, diagnostic)
              : buildSelectionRetryPrompt(diagnostic),
          });
          continue;
        }
        if (editDslRequired) {
          if (editDslPick === null) {
            // Unreachable: an edit-dsl success sets `editDslPick`.
            return await terminate(
              "edit-exhausted",
              exhaustedDiagnostics(iterationOpenedBy, diagnostic),
            );
          }
          const { selection, mode, entry, source: pickSource } = editDslPick;
          pinned = { mode, locator: selection.locator };
          pinnedAddressJson = pinJson(pinned);
          pinnedAssistantContent = (response.content ?? "").trim();
          records.push(
            recordRow({
              row: records.length + 1,
              iteration,
              kind: "exchange",
              exchange,
              locator: selection.locator,
              replacement: null,
              diagnostics: null,
              outcome: "selected",
              finishReason: response.finishReason,
              toolCalls: response.toolCalls.length,
            }),
          );
          messages.push({ role: "assistant", content: pinnedAssistantContent });
          baseSource = pickSource;
          if (mode === "modify" && entry !== null) {
            const modifier = precedingExportModifier(pickSource, entry);
            const declarationStart =
              modifier === null ? entry.node.start : entry.node.start - modifier.length;
            const startLine = pickSource.slice(0, declarationStart).split("\n").length;
            // A match viewer's spans are already resolved by the same edit-dsl
            // cascade the edit-phase feedback uses; mark their file-absolute
            // lines in `# details` (a bare viewer marks nothing).
            let markedLines: ReadonlySet<number> | null = null;
            if (selection.matcher !== null) {
              const viewerResolution = resolveEditDslReply([selection], {
                sourceFor: () => pickSource,
                resolveEntry: (source, path, locator, space) =>
                  resolveCurrentEntry(source, path, locator, space),
              });
              const viewer = viewerResolution.viewers[0];
              if (viewer !== undefined) {
                const marked = markedViewerLines(viewer);
                if (marked.size > 0) {
                  markedLines = marked;
                }
              }
            }
            initialContentPrompt = buildEditDslDetailsPrompt(
              options.issue,
              editDslIndexText,
              pickSource.slice(declarationStart, entry.node.end),
              specFiles,
              startLine,
              markedLines,
              duplicateDeclarationNote(selection.locator.path, pickSource, entry),
            );
          } else {
            initialContentPrompt = buildEditDslCreatePrompt(
              options.issue,
              editDslIndexText,
              selection.locator.path,
              specFiles,
            );
          }
          // A first-turn editor already carries its `replace`; apply it in the
          // content branch without asking the provider again.
          if (selection.replacement !== null) {
            prefetchedReply = response;
          }
          continue;
        }
        const selection = resolution !== null && resolution.ok ? resolution.selection : null;
        if (selection === null) {
          // Unreachable: a non-null resolution with an ok=true branch was set.
          return await terminate(
            "edit-exhausted",
            exhaustedDiagnostics(iterationOpenedBy, diagnostic),
          );
        }
        pinned = { mode: selection.mode, locator: selection.locator };
        pinnedAddressJson = pinJson(pinned);
        records.push(
          recordRow({
            row: records.length + 1,
            iteration,
            kind: "exchange",
            exchange,
            locator: selection.locator,
            replacement: null,
            diagnostics: null,
            outcome: "selected",
            finishReason: response.finishReason,
            toolCalls: response.toolCalls.length,
          }),
        );
        messages.push({ role: "assistant", content: pinnedAddressJson });
        if (selection.mode === "delete") {
          // delete carries no edit payload: the pick exchange is the whole
          // model exchange and the harness executes the deletion directly.
          const fileEntry = sourceFileFor(files, selection.locator.path);
          return await executeDeletion({
            options,
            provider: options.provider,
            temperature,
            targetPath: selection.locator.path,
            locator: selection.locator,
            node: selection.entry.node,
            baseSource: fileEntry.source,
            messages,
            records,
            skipped,
            iteration,
          });
        }
        baseSource =
          selection.mode === "create"
            ? (readFileIfExists(join(cwd, selection.path)) ?? "")
            : sourceFileFor(files, selection.locator.path).source;
        if (selection.mode === "modify") {
          const symbolSource = baseSource.slice(
            selection.entry.node.start,
            selection.entry.node.end,
          );
          initialContentPrompt = buildEditPrompt(
            addressJson(selection.locator),
            symbolSource,
            multiPayload,
            protocolFormat,
          );
        } else {
          initialContentPrompt = buildCreatePrompt(
            addressJson(selection.locator),
            selection.path,
            protocolFormat,
          );
        }
        continue;
      }

      // Content exchange: revise the pinned target. A fresh iteration has a
      // fresh ≤3 budget; soft failures re-ask with diagnostics and consume the
      // same budget.
      let pinnedTarget: { mode: SelectionMode; locator: Locator } | null = pinned;
      if (pinnedTarget === null) {
        // Unreachable: the pick branch either pins a target or returns.
        throw new Error("content exchange without a pinned target");
      }
      const target = pinnedTarget.locator.path;
      const diskSource = readFileIfExists(join(cwd, target)) ?? "";
      let contentPrompt: string;
      // Repair exchange (#73): an intra-round retry (diagnostics present) or a
      // #52 continuation — never the fresh post-pick edit prompt. Only a repair
      // exchange accepts a self-verification request and offers it in the prompt.
      let repairExchange: boolean;
      if (targetsMode && targetQueue.length > 0) {
        // Explicit-targets mode (#81): every content prompt names the pending
        // targets (and, after a rejection, the diagnostics) so the model must
        // emit the batch covering them.
        const currentSource = currentSourceForPrompt(
          "modify",
          target,
          pinnedTarget.locator,
          diskSource,
        );
        let targetsPrompt = buildTargetsEditPrompt(
          addressJson(pinnedTarget.locator),
          truncateSource(currentSource),
          activeTargets(),
        );
        if (lastDiagnostics !== null) {
          targetsPrompt += `\nThe previous exchange was rejected. Diagnostics:\n\n\`\`\`\n${lastDiagnostics}\n\`\`\`\n`;
        }
        contentPrompt = targetsPrompt;
        repairExchange = lastDiagnostics !== null;
      } else if (exchange === 1 && continuationPrompt !== null) {
        // Round-level continuation (#52): the first exchange of a continued
        // round shows the continuation prompt instead of the echo of a pick.
        contentPrompt = continuationPrompt;
        repairExchange = true;
      } else if (lastDiagnostics === null && initialContentPrompt !== null) {
        contentPrompt = initialContentPrompt;
        repairExchange = false;
      } else {
        const promptDiagnostics = combinedDiagnostics(iterationOpenedBy, lastDiagnostics);
        const repairSource = repairContextSource({
          mode: pinnedTarget.mode === "create" ? "create" : "modify",
          repair,
          target,
          locator: pinnedTarget.locator,
          diskSource,
          diagnostics: promptDiagnostics,
        });
        const currentSource =
          repairSource.preRendered !== undefined
            ? repairSource.source
            : truncateSource(repairSource.source);
        // No-progress ask (#54): only the first content prompt of a stalled
        // round carries the decision framing and the digest (#57); every other
        // retry is unchanged.
        // Failure history (#71): unlike the digest, the note is computed for
        // every content retry — ordinary retries and the #54 ask alike. The same
        // pattern feeds the sharpened 2nd+ ask framing (#65).
        const failurePattern = detectFailurePattern(records);
        const stalled =
          exchange === 1 && stalledAsk
            ? {
                failedRounds: stalledRounds,
                round: iteration,
                maxRounds: MAX_RUN_ITERATIONS,
                askNumber: stalledAskNumber(stalledRounds),
                history: failurePattern,
              }
            : undefined;
        const failureHistory = renderFailureHistoryNote(failurePattern);
        // Decision-only turn (#75): the same repeated-non-converging gating as
        // the continuation path; only the first exchange of a stalled round.
        if (stalled !== undefined) {
          decisionTurn = isDecisionAsk(stalled);
        }
        // The self-check result is shown exactly once, in the prompt right after
        // the request was executed (#73).
        const selfCheck = pendingSelfCheck;
        pendingSelfCheck = null;
        contentPrompt = buildRetryPrompt({
          exchangeNumber: exchange,
          maxExchanges: MAX_EDIT_EXCHANGES,
          mode: pinnedTarget.mode === "create" ? "create" : "modify",
          locatorJson: pinnedAddressJson,
          currentSource,
          preRenderedSource: repairSource.preRendered,
          // A soft edit failure overwrites `lastDiagnostics`; in a repair
          // iteration keep the verification failure visible too (#48).
          diagnostics: promptDiagnostics,
          failure: lastFailure,
          repin: iterationOpenedBy !== null && pinnedTarget.mode === "modify",
          stalled,
          digest: stalled === undefined ? undefined : digestText(),
          failureHistory,
          // The decision reply's stated re-approach (#75) rides the next
          // exchange's edit prompt so the attempt must follow it.
          approach: pendingApproach ?? undefined,
          // Per-cause rejection correction (#56): only edit retries carry the
          // class-specific lead; verification-repair prompts keep the default.
          correction: lastFailure === "edit" ? (lastCorrection ?? undefined) : undefined,
          multiPayload: multiPayload,
          protocolFormat,
          selfCheck: selfCheck ?? undefined,
          editDslContext: editDslRequired
            ? {
                issue: options.issue,
                indexText: editDslIndexText,
                startLine: editDslPromptStartLine(
                  pinnedTarget.mode === "create" ? "create" : "modify",
                  target,
                  pinnedTarget.locator,
                  diskSource,
                  repair,
                ),
              }
            : undefined,
        });
        repairExchange = true;
      }
      messages = [
        systemMessage,
        roundIssueMessage,
        {
          role: "assistant",
          content:
            protocolFormat === "edit-dsl"
              ? (pinnedAssistantContent ?? pinnedAddressJson)
              : pinnedAddressJson,
        },
        { role: "user", content: contentPrompt },
      ];
      let response: ChatResponse;
      if (prefetchedReply !== null) {
        // A first-turn edit-dsl editor: its select reply already carries the
        // replacement, so apply it here without a second provider call (its
        // tokens were counted on the pick exchange).
        response = prefetchedReply;
        prefetchedReply = null;
      } else {
        try {
          response = await options.provider.chat(messages, undefined, exchangeOptions);
        } catch (error) {
          const diagnostics = withTargetsReport(providerErrorDiagnostics(error)) ?? "";
          return {
            ok: false,
            mode: pinnedTarget.mode,
            locator: pinnedTarget.locator,
            filePath: target,
            editedSource: null,
            records,
            diagnostics,
            explanation: await explain(
              options.provider,
              messages,
              temperature,
              "provider-error",
              diagnostics,
            ),
            messages,
            skipped,
            tokens,
          };
        }
        consumedTokens += tokensFromResponse(response);
        addTokens(loopTokensFromResponse(response));
        if (consumedTokens > tokenBudget) {
          return await terminate(
            "token-budget",
            tokenBudgetDiagnostics(consumedTokens, tokenBudget),
          );
        }
      }
      // The no-progress ask's STOP (#54), only at its first exchange; the
      // stalled diagnostics stay distinct from #52's exhausted-round text. A
      // milestone continuation (#60) carries the ask framing, so its STOP
      // takes precedence over the continuation's and keeps the chain context.
      if (exchange === 1 && stalledAsk && isStopReply(response)) {
        return await stopRun(
          exchange,
          response,
          stalledStopDiagnostics(
            stalledRounds,
            continuationDiagnostics ?? combinedDiagnostics(iterationOpenedBy, lastDiagnostics),
          ),
        );
      }
      // Only the continuation prompt (#52) and the no-progress ask (#54) offer
      // STOP, each at its own exchange-1 prompt.
      if (exchange === 1 && continuationPrompt !== null && isStopReply(response)) {
        return await stopRun(
          exchange,
          response,
          stoppedDiagnostics(iteration, continuationDiagnostics),
        );
      }
      // Decision-only turn (#75): STOP was handled above. A reply that still
      // carries a structurally valid edit payload is a real attempt and flows
      // through the unchanged guards below; any other reply is the stated
      // re-approach — clamped and carried into the next exchange's prompt
      // instead of being parsed as an edit (no cap, no auto-stop).
      if (
        exchange === 1 &&
        decisionTurn &&
        !isEditPayloadReply(response.content ?? "", multiPayload, protocolFormat)
      ) {
        pendingApproach = clampText(response.content ?? "", APPROACH_LIMIT);
        continue;
      }
      const sourceBefore = readFileIfExists(join(cwd, target)) ?? baseSource;
      const prevCheck = parseCheck(sourceBefore);
      if (!prevCheck.ok) {
        const broken = prevBrokenDiagnostics(target, prevCheck.failure);
        records.push(
          recordRow({
            row: records.length + 1,
            iteration,
            kind: "exchange",
            exchange,
            locator: pinnedTarget.locator,
            replacement: null,
            diagnostics: broken,
            outcome: "prev-broken",
            finishReason: response.finishReason,
            toolCalls: response.toolCalls.length,
          }),
        );
        return await terminate("prev-broken", broken);
      }
      if (response.finishReason === "length") {
        const diagnostics =
          "stage: truncated\nthe completion was cut off at the output limit; emit a shorter, more compact replacement";
        const cause = classifyRejection({ stage: "truncated" });
        records.push(
          recordRow({
            row: records.length + 1,
            iteration,
            kind: "exchange",
            exchange,
            locator: pinnedTarget.locator,
            replacement: response.content ?? null,
            diagnostics,
            outcome: "truncated",
            finishReason: response.finishReason,
            cause,
            toolCalls: response.toolCalls.length,
          }),
        );
        registerRejection(cause);
        lastDiagnostics = retryDiagnostics(diagnostics);
        lastFailure = "edit";
        // Output-limit strike cap (#98): the just-pushed row is counted, so the
        // third consecutive length finish terminates through the summary path
        // rather than continuing into another exchange or round.
        if (consecutiveLengthFinishes(records) >= MAX_CONSECUTIVE_LENGTH) {
          return await terminate(
            "output-limit",
            "stage: output-limit\nthe completion hit the output limit on 3 consecutive attempts; ending the run through the summary path",
          );
        }
        if (exchange === MAX_EDIT_EXCHANGES) {
          if (iteration >= MAX_RUN_ITERATIONS) {
            return await terminate("edit-exhausted", capDiagnostics(iterationOpenedBy));
          }
          // Round exhaustion below the cap (#52): continue with a fresh round.
          // In explicit-targets mode the queue drives the run, so exhaustion
          // ends the round and the next one re-seeds the pending target.
          if (!targetsMode) {
            continuation = {
              round: iteration,
              pick: false,
              diagnostics: combinedDiagnostics(iterationOpenedBy, lastDiagnostics),
            };
          }
          break;
        }
        continue;
      }
      const content = response.content ?? "";
      // Bounded self-verification request (#73): a repair exchange may reply
      // with the distinct request object instead of an edit payload. At most one
      // is executed per round, and only when a later exchange exists to return
      // its result; every refusal falls through to the ordinary protocol path.
      let requestFailure: string | null = null;
      if (repairExchange) {
        const parsedRequest = parseSelfCheckRequest(content);
        if (parsedRequest.kind === "error") {
          requestFailure = parsedRequest.diagnostics;
        } else if (parsedRequest.kind === "ok") {
          if (selfCheckUsed) {
            requestFailure =
              "stage: protocol\nthe round already used its one self-verification request; return an edit payload now (the harness runs at most one request per round)";
          } else if (exchange >= MAX_EDIT_EXCHANGES) {
            requestFailure =
              "stage: protocol\nthere is no exchange left in this round to return a self-check result; return an edit payload";
          } else {
            const result = await executeSelfCheck(parsedRequest.request, {
              cwd,
              target,
              checkCommand: options.checkCommand,
              testCommand: options.testCommand,
              commandTimeoutMs: options.commandTimeoutMs,
            });
            selfCheckUsed = true;
            pendingSelfCheck = result;
            records.push(
              recordRow({
                row: records.length + 1,
                iteration,
                kind: "exchange",
                exchange,
                locator: pinnedTarget.locator,
                replacement: null,
                diagnostics: result,
                outcome: "self-check",
                finishReason: response.finishReason,
                payloads: 0,
                toolCalls: response.toolCalls.length,
              }),
            );
            continue;
          }
        }
      }
      let payload: EditPayload | null = null;
      // Explicit-targets mode (#81): the pending targets this exchange covers,
      // validated before any splice. Empty outside targets mode.
      let coveredTargets: Locator[] = [];
      // Opt-in multi-payload variant (#69): the reply may carry a
      // `{"payloads": [...]}` batch. `batchCarried` keeps every payload that
      // parsed, even when the batch was rejected at parse time (duplicate
      // paths, bad entry), so the record still counts what the reply carried.
      let batch: EditPayload[] | null = null;
      let batchCarried: EditPayload[] = [];
      let batchPayloadCount = 0;
      let batchReplacementChars: number | null = null;
      // Batch-level rejection cause (#69/#78): `multi-protocol`/`multi-duplicate`
      // override the stage-derived classification; per-payload failures keep
      // the failing payload's own stage/cause.
      let failureCause: RejectionCause | null = null;
      let candidate: string | null = null;
      let newSource: string | null = null;
      let replacement: string | null = null;
      let gateStart = 0;
      let gateReplacement = "";
      let failure: string | null = null;
      let failureStage: EditFailureStage = "protocol";
      // A refused self-check request (#73) is an ordinary `protocol` rejection:
      // skip the edit parser and fall through to the shared rejection record.
      if (requestFailure !== null) {
        failure = requestFailure;
      }
      // Structured rejection origin (#56): the splice's matcher sub-cause and
      // the formatter message; never reconstructed from the diagnostics text.
      let matcherCause: MatcherCause | undefined;
      let formatMessage: string | undefined;
      // #65: set when an `address` rejection resolved against a name the
      // current source does not declare, so the retry lead keeps the add path
      // open instead of demanding a re-pin that cannot resolve.
      let addressUndeclaredName: string | null = null;
      // #119: the edit-dsl reply state. Under the edit-dsl protocol it is parsed
      // first and is the required form.
      let editDslReply = false;
      let editDslSelections: EditDslSelection[] = [];
      let editDslResolution: EditDslResolution | null = null;
      // Parse `select … end` clauses and resolve them against each file's current
      // source. Returns null when the reply carries no clause; a
      // `SelectionSyntaxError` propagates to the caller.
      const parseEditDsl = (): {
        selections: EditDslSelection[];
        resolution: EditDslResolution;
      } | null => {
        const selections = parseSelection(stripCodeFences(content));
        if (selections.length === 0) {
          return null;
        }
        const editDslSources = new Map<string, string>();
        const resolution = resolveEditDslReply(selections, {
          sourceFor: (path) => {
            if (path === target) {
              return sourceBefore;
            }
            const cached = editDslSources.get(path);
            if (cached !== undefined) {
              return cached;
            }
            const source = readFileIfExists(join(cwd, path)) ?? "";
            editDslSources.set(path, source);
            return source;
          },
          resolveEntry: (source, path, locator, space) =>
            resolveCurrentEntry(source, path, locator, space),
        });
        return { selections, resolution };
      };
      // #119: under the edit-dsl protocol the edit-dsl syntax is the required
      // reply form, so it is parsed first and a JSON edit payload (which never
      // matches the edit-dsl grammar) is rejected as a protocol failure.
      // Explicit-targets mode (#81) stays JSON, and this path is not combined
      // with it.
      const editDslRequiredReply = protocolFormat === "edit-dsl" && !targetsMode;
      if (failure !== null) {
        // Refused self-check request: no payload to parse.
      } else if (editDslRequiredReply) {
        try {
          const parsed = parseEditDsl();
          if (parsed === null) {
            failure = EDIT_DSL_FORCE_DIAGNOSTICS;
          } else {
            editDslReply = true;
            editDslSelections = parsed.selections;
            editDslResolution = parsed.resolution;
            failure = null;
            failureCause = null;
            failureStage = "protocol";
          }
        } catch (error) {
          if (!(error instanceof SelectionSyntaxError)) {
            throw error;
          }
          failure = EDIT_DSL_FORCE_DIAGNOSTICS;
        }
      } else if (multiPayload) {
        const parsed = parseEditResponseList(content);
        if (parsed.ok) {
          if (parsed.batch && pinnedTarget.mode !== "modify") {
            // Batch replies are modify-only (#69); a create round keeps its
            // flat shape and the rejection says so.
            failureCause = "multi-protocol";
            batchCarried = parsed.payloads;
            failure = multiDiagnostics(
              `mode "${pinnedTarget.mode}" carries no edit payload batch; reply with one flat ${pinnedTarget.mode} payload`,
            );
          } else if (parsed.batch) {
            batch = parsed.payloads;
          } else {
            payload = parsed.payloads[0] ?? null;
          }
        } else {
          failure = parsed.diagnostics;
          failureCause = parsed.cause;
          batchCarried = parsed.payloads;
        }
      } else {
        try {
          payload = parseEditResponse(content);
        } catch (error) {
          failure = `stage: protocol\n${errorMessage(error)}`;
        }
      }
      if (batch !== null) {
        batchCarried = batch;
      }
      if (batchCarried.length > 0) {
        batchPayloadCount = batchCarried.length;
        batchReplacementChars = batchCarried.reduce(
          (sum, entry) => sum + entry.replacement.length,
          0,
        );
        replacement = batchCarried[0]?.replacement ?? null;
      }
      // Explicit-targets mode (#81): every payload must address one of the
      // pending targets, one per file, with the first echoing the pin. A reply
      // that is not a valid batch is a staged rejection, never a silent pick.
      if (targetsMode && failure === null) {
        const replyPayloads = payload !== null ? [payload] : batch !== null ? batch : [];
        if (replyPayloads.length > 0) {
          const validated = validateTargetsReply(replyPayloads, pinnedTarget.locator, targetQueue);
          if (!validated.ok) {
            failure = validated.diagnostics;
            failureStage = validated.diagnostics.startsWith("stage: echo") ? "echo" : "address";
          } else {
            coveredTargets = validated.covered;
          }
        }
      }
      if (failure === null && payload !== null) {
        replacement = payload.replacement;
        gateReplacement = payload.replacement;
        if (
          pinnedTarget.mode === "modify" &&
          lastModifySubmission !== null &&
          sameModifySubmission(lastModifySubmission, [payload])
        ) {
          // Byte-identical resubmission (#48): reject before any resolution or
          // splice; the file is not touched.
          failure = repeatDiagnostics(lastModifySubmission);
          failureStage = "repeat";
        } else if (
          pinnedTarget.mode === "create" &&
          (payload.matcher !== null || payload.range !== null)
        ) {
          failure =
            'stage: protocol\nmode "create" does not take a "matcher" or "range"; omit them and return the complete declaration';
        } else if (!addressEquals(pinnedTarget.locator, payload.locator)) {
          if ((iterationOpenedBy !== null || stalledAsk) && pinnedTarget.mode === "modify") {
            // Verification-repair re-pin (#48): a round opened by failing
            // verification may move the pin to another declaration in the same
            // file; the new address resolves strictly against the current source.
            if (payload.locator.path !== pinnedTarget.locator.path) {
              failure = `stage: address\nthe payload may re-pin only to another declaration in the pinned file ${JSON.stringify(target)}; received path ${JSON.stringify(payload.locator.path)}`;
              failureStage = "address";
            } else if (payload.range !== null && !repair) {
              // The shown block is the pinned declaration, so a range cannot
              // address a different (re-pinned) declaration (#72).
              failure = rangeUnshownDiagnostics(
                pinnedTarget.locator,
                payload.locator,
                payload.range,
              );
              failureStage = "range";
            } else {
              const resolved = resolveCurrentEntry(sourceBefore, target, payload.locator);
              if (!resolved.ok) {
                failure = resolved.diagnostics;
                failureStage = "address";
                addressUndeclaredName = resolved.undeclared ? payload.locator.name : null;
              } else {
                pinnedTarget = { mode: "modify", locator: payload.locator };
                pinned = pinnedTarget;
                pinnedAddressJson = pinJson(pinnedTarget);
                const spliced = spliceEntryEdit(
                  sourceBefore,
                  target,
                  pinnedTarget.locator,
                  resolved.entry,
                  payload.matcher,
                  payload.replacement,
                  payload.range,
                  repair,
                );
                if (spliced.ok) {
                  candidate = spliced.candidate;
                  gateStart = spliced.gateStart;
                } else if (spliced.cause === "no-op") {
                  failure = spliced.diagnostics;
                  failureStage = "no-op";
                } else if (spliced.cause === "range-invalid") {
                  failure = spliced.diagnostics;
                  failureStage = "range";
                } else {
                  failure = spliced.diagnostics;
                  failureStage = "matcher";
                  matcherCause = spliced.cause;
                }
              }
            }
          } else {
            failure = echoDiagnostics(pinnedTarget.locator, payload.locator);
            failureStage = "echo";
          }
        } else if (pinnedTarget.mode === "create") {
          const body = payload.replacement.trim();
          candidate = appendText(sourceBefore, payload.replacement);
          gateStart = candidate.indexOf(body);
          gateReplacement = body;
        } else {
          // Strict-AND resolution against the source that would be spliced: no
          // silent first-match pick, no kind coercion, no auto-append.
          const resolved = resolveCurrentEntry(sourceBefore, target, pinnedTarget.locator);
          if (!resolved.ok) {
            failure = resolved.diagnostics;
            failureStage = "address";
            addressUndeclaredName = resolved.undeclared ? pinnedTarget.locator.name : null;
          } else {
            const spliced = spliceEntryEdit(
              sourceBefore,
              target,
              pinnedTarget.locator,
              resolved.entry,
              payload.matcher,
              payload.replacement,
              payload.range,
              repair,
            );
            if (spliced.ok) {
              candidate = spliced.candidate;
              gateStart = spliced.gateStart;
            } else if (spliced.cause === "no-op") {
              failure = spliced.diagnostics;
              failureStage = "no-op";
            } else if (spliced.cause === "range-invalid") {
              failure = spliced.diagnostics;
              failureStage = "range";
            } else {
              failure = spliced.diagnostics;
              failureStage = "matcher";
              matcherCause = spliced.cause;
            }
          }
        }
      }
      // Opt-in multi-payload exchanges (#69/#78): payloads are grouped by
      // file. Every payload runs its own address/matcher/range/no-op guard
      // against its file's current source; each file's resolved regions are
      // combined in one pass. Any failure — a per-region guard or an
      // overlapping pair — rejects the whole exchange naming each failing
      // region, and nothing is written; the record's outcome and cause stay
      // those of the first failure.
      const batchWrites: { path: string; source: string }[] = [];
      if (failure === null && batch !== null) {
        const first = batch[0];
        if (first === undefined) {
          // Unreachable: the parser guarantees a non-empty payload list.
          failure = multiDiagnostics("the payloads array carries no payload");
          failureCause = "multi-protocol";
        } else if (
          lastModifySubmission !== null &&
          sameModifySubmission(lastModifySubmission, batch)
        ) {
          // Byte-identical resubmission (#48): the whole batch, rejected before
          // any resolution or splice; no file is touched.
          failure = repeatDiagnostics(lastModifySubmission);
          failureStage = "repeat";
        } else {
          const blocks: string[] = [];
          let firstStage: EditFailureStage | null = null;
          let firstMatcherCause: MatcherCause | undefined;
          let firstFormatMessage: string | undefined;
          let firstUndeclared: string | null = null;
          const noteFailure = (
            index: number,
            path: string,
            locator: Locator,
            stage: EditFailureStage,
            diagnostics: string,
            origin: {
              matcherCause?: MatcherCause;
              formatMessage?: string;
              undeclaredName?: string | null;
            } = {},
          ): void => {
            if (firstStage === null) {
              firstStage = stage;
              firstMatcherCause = origin.matcherCause;
              firstFormatMessage = origin.formatMessage;
              firstUndeclared = origin.undeclaredName ?? null;
            }
            blocks.push(
              multiPayloadDiagnostics(index + 1, batch.length, path, locator, diagnostics),
            );
          };
          // One source per file, resolved once: the pinned file is the current
          // in-memory source and every other file is read from disk once, so
          // same-file payloads combine in one pass instead of overwriting each
          // other sequentially (#78).
          const fileSource = new Map<string, string>();
          const fileSourceOf = (path: string): string => {
            if (path === target) {
              return sourceBefore;
            }
            const cached = fileSource.get(path);
            if (cached !== undefined) {
              return cached;
            }
            const source = readFileIfExists(join(cwd, path)) ?? "";
            fileSource.set(path, source);
            return source;
          };
          // Resolve every payload to its addressed region. The first payload
          // keeps the classic echo/re-pin policy; every further payload
          // self-addresses its own declaration in its own file (same file
          // allowed), resolved strictly against that file's current source.
          const regions: ResolvedRegion[] = [];
          for (let index = 0; index < batch.length; index += 1) {
            const entryPayload = batch[index];
            if (entryPayload === undefined) {
              continue;
            }
            const path = entryPayload.locator.path;
            const payloadSource = fileSourceOf(path);
            let span: PayloadSpan | null = null;
            if (index === 0) {
              // The first payload keeps the classic pin semantics: it echoes
              // the pinned address, and only a verification-repair round may
              // move the pin to another declaration in the pinned file.
              const locator = entryPayload.locator;
              if (addressEquals(pinnedTarget.locator, locator)) {
                span = resolvePayloadSpan(sourceBefore, target, entryPayload, repair);
              } else if (iterationOpenedBy !== null || stalledAsk) {
                if (locator.path !== target) {
                  noteFailure(
                    index,
                    path,
                    locator,
                    "address",
                    `stage: address\nthe payload may re-pin only to another declaration in the pinned file ${JSON.stringify(target)}; received path ${JSON.stringify(locator.path)}`,
                  );
                } else if (entryPayload.range !== null && !repair) {
                  // The shown block is the pinned declaration, so a range cannot
                  // address a different (re-pinned) declaration (#72).
                  noteFailure(
                    index,
                    path,
                    locator,
                    "range",
                    rangeUnshownDiagnostics(pinnedTarget.locator, locator, entryPayload.range),
                  );
                } else {
                  span = resolvePayloadSpan(sourceBefore, target, entryPayload, repair);
                  if (span.ok) {
                    pinnedTarget = { mode: "modify", locator };
                    pinned = pinnedTarget;
                    pinnedAddressJson = pinJson(pinnedTarget);
                  }
                }
              } else {
                noteFailure(
                  index,
                  path,
                  locator,
                  "echo",
                  echoDiagnostics(pinnedTarget.locator, locator),
                );
              }
            } else if (entryPayload.range !== null) {
              // A further multi-payload entry addresses a declaration the
              // numbered block never showed, so a range has no block to
              // address (#72).
              noteFailure(
                index,
                path,
                entryPayload.locator,
                "range",
                rangeUnshownDiagnostics(
                  pinnedTarget.locator,
                  entryPayload.locator,
                  entryPayload.range,
                ),
              );
            } else {
              // Self-addressed payloads (#69/#78): each names its own
              // declaration, which resolves strictly in its own file.
              span = resolvePayloadSpan(payloadSource, path, entryPayload);
            }
            if (span === null) {
              continue;
            }
            if (!span.ok) {
              noteFailure(index, path, entryPayload.locator, span.stage, span.diagnostics, {
                matcherCause: span.matcherCause,
                undeclaredName: span.undeclaredName,
              });
              continue;
            }
            regions.push({
              index,
              path,
              locator: entryPayload.locator,
              start: span.start,
              end: span.end,
              text: span.text,
              replacement: entryPayload.replacement,
              stage: stageOf(entryPayload),
              matcherKind: matcherKindOf(entryPayload),
              create: false,
            });
          }
          batchWrites.push(
            ...(await applyResolvedRegions({
              regions,
              fileSourceOf,
              target,
              prevCheck,
              noteFailure: (note) => {
                noteFailure(
                  note.region.index,
                  note.path,
                  note.region.locator,
                  note.stage,
                  note.diagnostics,
                  { matcherCause: note.matcherCause, formatMessage: note.formatMessage },
                );
              },
              noteOverlap: (path, earlier, later) => {
                failureCause = "multi-duplicate";
                blocks.push(multiOverlapDiagnostics(batch.length, path, earlier, later));
              },
            })),
          );
          if (blocks.length > 0) {
            failure = blocks.join("\n\n");
            if (firstStage !== null) {
              failureStage = firstStage;
            }
            matcherCause = firstMatcherCause;
            formatMessage = firstFormatMessage;
            addressUndeclaredName = firstUndeclared;
          } else {
            newSource = batchWrites[0]?.source ?? null;
          }
        }
      }
      // #111 edit-dsl application: resolve the parsed clauses into regions,
      // viewers, and typed failures, then apply the resolved editor clauses
      // atomically across the whole reply (§6): any resolution failure or
      // apply failure discards every region, including creates and files that
      // passed their own guards. Viewers surface their occurrences as the next
      // prompt's feedback and write nothing.
      let editDslApplied = false;
      let editDslAppliedRegions: ResolvedRegion[] = [];
      let editDslCreates = 0;
      let editDslViewerFeedback: string | null = null;
      if (failure === null && editDslReply && editDslResolution !== null) {
        const totalClauses = editDslSelections.length;
        const blocks: string[] = [];
        let firstEditDslStage: EditFailureStage | null = null;
        let firstEditDslCause: MatcherCause | undefined;
        let firstEditDslUndeclared: string | null = null;
        const noteEditDslFailure = (
          failureIndex: number,
          failurePath: string,
          locator: Locator,
          stage: EditFailureStage,
          diagnostics: string,
          origin: { matcherCause?: MatcherCause; undeclaredName?: string | null } = {},
        ): void => {
          if (firstEditDslStage === null) {
            firstEditDslStage = stage;
            firstEditDslCause = origin.matcherCause;
            firstEditDslUndeclared = origin.undeclaredName ?? null;
          }
          blocks.push(
            editDslClauseDiagnostics(
              failureIndex + 1,
              totalClauses,
              failurePath,
              locator,
              diagnostics,
            ),
          );
        };
        for (const clauseFailure of editDslResolution.failures) {
          noteEditDslFailure(
            clauseFailure.index,
            clauseFailure.path,
            clauseFailure.locator,
            clauseFailure.stage,
            clauseFailure.diagnostics,
            {
              // `regex-invalid` is a matcher cause (#109/#111); the other
              // matcher failures carry theirs unchanged.
              matcherCause:
                clauseFailure.stage === "matcher"
                  ? (clauseFailure.cause as MatcherCause)
                  : undefined,
              undeclaredName: clauseFailure.undeclaredName,
            },
          );
        }
        const regions = editDslResolution.regions.map(editDslRegionToResolved);
        // #111: count the create clauses the reply resolved, applied or not, so
        // the stage/metrics instrumentation records create-form adoption.
        editDslCreates = editDslResolution.regions.filter((region) => region.create).length;
        // Whole-reply atomicity (§6): resolution failures discard every
        // resolved region, and any apply failure discards every returned write
        // (including files that passed). Nothing is written until both sets are
        // clean.
        let writes: { path: string; source: string }[] = [];
        if (editDslResolution.failures.length === 0) {
          writes = await applyResolvedRegions({
            regions,
            fileSourceOf: (path) =>
              path === target ? sourceBefore : (readFileIfExists(join(cwd, path)) ?? ""),
            target,
            prevCheck,
            noteFailure: (note) => {
              noteEditDslFailure(
                note.region.index,
                note.path,
                note.region.locator,
                note.stage,
                note.diagnostics,
                { matcherCause: note.matcherCause },
              );
            },
            noteOverlap: (path, earlier, later) => {
              failureCause = "multi-duplicate";
              if (firstEditDslStage === null) {
                firstEditDslStage = "protocol";
              }
              blocks.push(editDslOverlapDiagnostics(totalClauses, path, earlier, later));
            },
          });
        }
        if (blocks.length > 0) {
          // The whole edit-dsl reply is discarded: no file write, no create.
          failure = blocks.join("\n\n");
          if (firstEditDslStage !== null) {
            failureStage = firstEditDslStage;
          }
          matcherCause = firstEditDslCause;
          addressUndeclaredName = firstEditDslUndeclared;
        } else if (regions.length > 0) {
          editDslApplied = true;
          editDslAppliedRegions = regions;
          batchWrites.push(...writes);
          newSource = writes[0]?.source ?? null;
        }
        if (editDslResolution.viewers.length > 0) {
          editDslViewerFeedback = renderViewerFeedback(editDslResolution.viewers);
        }
      }
      // A viewer locate turn (#111): a reply that carried only viewers writes
      // nothing and is not an edit failure; its occurrences ride the next
      // prompt. A mixed reply carries viewer results alongside the diagnostics;
      // its editors apply only when the whole reply is clean.
      if (editDslViewerFeedback !== null) {
        if (failure !== null) {
          failure = `${failure}\n\n${editDslViewerFeedback}`;
        } else if (!editDslApplied) {
          records.push(
            recordRow({
              row: records.length + 1,
              iteration,
              kind: "exchange",
              exchange,
              locator: pinnedTarget.locator,
              replacement: null,
              diagnostics: editDslViewerFeedback,
              outcome: "viewer",
              finishReason: response.finishReason,
              payloads: editDslSelections.length,
              toolCalls: response.toolCalls.length,
            }),
          );
          lastDiagnostics = editDslViewerFeedback;
          lastFailure = "edit";
          if (exchange === MAX_EDIT_EXCHANGES) {
            if (iteration >= MAX_RUN_ITERATIONS) {
              return await terminate("edit-exhausted", capDiagnostics(iterationOpenedBy));
            }
            continuation = {
              round: iteration,
              pick: false,
              diagnostics: combinedDiagnostics(iterationOpenedBy, lastDiagnostics),
            };
            break;
          }
          continue;
        } else {
          carriedViewerFeedback = editDslViewerFeedback;
        }
      }
      // Syntax gate (highest-priority invariant): prev parses ⇒ after must parse.
      if (failure === null && candidate !== null) {
        const gate = parseCheck(candidate);
        if (!gate.ok) {
          failure = gateDiagnostics(gateStart, gateReplacement, gate.failure);
          failureStage = "gate";
        } else {
          // Duplicate-declaration guard (#48): adding another top-level copy
          // of a (kind, name) TypeScript rejects on duplicates is discarded.
          const duplicate = duplicateDeclarationDiagnostics(
            sourceBefore,
            target,
            prevCheck.program,
            gate.program,
          );
          if (duplicate !== null) {
            failure = duplicate;
            failureStage = "duplicate";
          }
        }
      }
      if (failure === null && candidate !== null) {
        try {
          newSource = await formatSource(target, candidate);
        } catch (error) {
          failure = `stage: format\n${errorMessage(error)}`;
          failureStage = "format";
          formatMessage = errorMessage(error);
        }
      }
      // Formatter-normalized no-op (#59 follow-up): a candidate that differs
      // only by formatting (e.g. the replacement re-included the matched
      // span's copied leading indentation) formats back to the current source.
      // Rejected with the byte-exact no-op's stage and diagnostics: no write,
      // no verification, same cause and retry policy.
      if (batch === null && !editDslApplied && failure === null && newSource !== null) {
        if (await sameAfterFormatting(target, sourceBefore, newSource)) {
          failure = NOOP_DIAGNOSTICS;
          failureStage = "no-op";
        }
      }
      if (failure !== null || newSource === null) {
        const diagnostics = failure ?? "stage: protocol\nmodel did not return replacement text";
        const cause =
          failureCause ?? classifyRejection({ stage: failureStage, matcherCause, formatMessage });
        records.push(
          recordRow({
            row: records.length + 1,
            iteration,
            kind: "exchange",
            exchange,
            locator: pinnedTarget.locator,
            replacement,
            diagnostics,
            outcome: failureStage,
            finishReason: response.finishReason,
            cause,
            payloads: editDslReply
              ? editDslSelections.length
              : batch !== null
                ? batch.length
                : payload !== null
                  ? 1
                  : batchPayloadCount,
            toolCalls: response.toolCalls.length,
            replacementChars: batchReplacementChars ?? undefined,
            // #101: a batch rejected at parse time keeps `batch` null but still
            // carries the entries that parsed; classify those so every entry is
            // counted (the `payloads` field already counts `batchCarried`).
            // #111: an edit-dsl reply records the cascade's own stages/kinds for
            // the clauses that actually applied (#110), not the resolved set.
            selectors: editDslReply
              ? editDslAppliedRegions.map((region) => selectorFromStage(region.stage))
              : (selectorsOf(payload, batch) ??
                (batchCarried.length > 0 ? batchCarried.map(selectorOf) : undefined)),
            stages: editDslReply
              ? editDslAppliedRegions.map((region) => region.stage)
              : (stagesOf(payload, batch) ??
                (batchCarried.length > 0 ? batchCarried.map(stageOf) : undefined)),
            matcherKinds: editDslReply
              ? editDslAppliedRegions.map((region) => region.matcherKind)
              : (matcherKindsOf(payload, batch) ??
                (batchCarried.length > 0 ? batchCarried.map(matcherKindOf) : undefined)),
            creates: editDslReply ? editDslCreates : undefined,
          }),
        );
        // Resubmission guard (#48): remember every modify-mode payload with its
        // outcome so a byte-identical resend is rejected before any splice. A
        // batch is remembered whole, so only an identical batch repeats (#69).
        if (batch !== null) {
          lastModifySubmission = submissionOf(batch, false, firstDiagnosticLine(diagnostics));
        } else if (payload !== null && pinnedTarget.mode === "modify") {
          lastModifySubmission = submissionOf([payload], false, firstDiagnosticLine(diagnostics));
        }
        // Harness-fault fast-exit (#56): a formatter failure whose signature is
        // the splice duplicating a modifier is not a model mistake; replying
        // with corrected instructions cannot help, so the run ends through the
        // termination matrix with the full diagnostics and one summary call.
        if (cause === "format-export-duplication") {
          return await terminate("harness-fault", diagnostics);
        }
        registerRejection(cause, {
          pendingDiagnostics: iterationOpenedBy,
          undeclaredName: addressUndeclaredName ?? undefined,
        });
        lastDiagnostics = retryDiagnostics(diagnostics);
        lastFailure = "edit";
        if (exchange === MAX_EDIT_EXCHANGES) {
          if (iteration >= MAX_RUN_ITERATIONS) {
            return await terminate("edit-exhausted", capDiagnostics(iterationOpenedBy));
          }
          // Round exhaustion below the cap (#52): continue with a fresh round.
          // In explicit-targets mode the queue drives the run, so exhaustion
          // ends the round and the next one re-seeds the pending target.
          if (!targetsMode) {
            continuation = {
              round: iteration,
              pick: false,
              diagnostics: combinedDiagnostics(iterationOpenedBy, lastDiagnostics),
            };
          }
          break;
        }
        continue;
      }
      if (batch !== null || editDslApplied) {
        // Atomic apply (#69/#111): every payload/clause passed its own guard
        // above, so the prepared sources are written together; a single failure
        // wrote nothing.
        for (const write of batchWrites) {
          writeTarget(cwd, write.path, write.source);
        }
      } else {
        writeTarget(cwd, target, newSource);
      }
      appliedEdit = true;
      // An applied edit ends the rejection chain (#56): the next rejection
      // starts a fresh streak regardless of the verification outcome below.
      clearRejectionPolicy();
      // Explicit-targets mode (#81): retire the targets this exchange covered
      // and remember them for the result.
      if (targetsMode) {
        for (const covered of coveredTargets) {
          const coveredJson = addressJson(covered);
          const index = targetQueue.findIndex((target) => addressJson(target) === coveredJson);
          if (index >= 0) {
            targetQueue.splice(index, 1);
          }
          appliedTargets.push(covered);
        }
      }
      // Resubmission guard (#48): an applied modify submission is remembered
      // so the next iteration cannot re-apply the identical payload/batch.
      if (batch !== null) {
        lastModifySubmission = submissionOf(batch, true, null);
      } else if (payload !== null && pinnedTarget.mode === "modify") {
        lastModifySubmission = submissionOf([payload], true, null);
      }
      records.push(
        recordRow({
          row: records.length + 1,
          iteration,
          kind: "exchange",
          exchange,
          locator: pinnedTarget.locator,
          replacement,
          diagnostics: null,
          outcome: "applied",
          finishReason: response.finishReason,
          payloads: editDslReply
            ? editDslSelections.length
            : batch !== null
              ? batch.length
              : payload !== null
                ? 1
                : 0,
          toolCalls: response.toolCalls.length,
          replacementChars: batchReplacementChars ?? undefined,
          appliedLocators: targetsMode ? coveredTargets : undefined,
          selectors: editDslReply
            ? editDslAppliedRegions.map((region) => selectorFromStage(region.stage))
            : selectorsOf(payload, batch),
          stages: editDslReply
            ? editDslAppliedRegions.map((region) => region.stage)
            : stagesOf(payload, batch),
          matcherKinds: editDslReply
            ? editDslAppliedRegions.map((region) => region.matcherKind)
            : matcherKindsOf(payload, batch),
          creates: editDslReply ? editDslCreates : undefined,
        }),
      );
      // Same-file sequencing (#81): a path-independent batch covers at most one
      // target per file, so apply the next pending target in the next exchange
      // of this round before verifying.
      if (targetsMode && targetQueue.length > 0 && exchange < MAX_EDIT_EXCHANGES) {
        if (seedNextTarget()) {
          continue;
        }
      }
      // Verification: tsc + test once per iteration, no model exchange.
      const check = await checkTool(cwd, options.checkCommand, options.commandTimeoutMs);
      const test = await runVerificationTests(cwd, target, options);
      if (check.ok && test.ok) {
        records.push(
          recordRow({
            row: records.length + 1,
            iteration,
            kind: "verification",
            exchange: null,
            locator: pinnedTarget.locator,
            replacement,
            diagnostics: null,
            outcome: "ok",
            finishReason: response.finishReason,
          }),
        );
        if (targetsMode && (targetQueue.length > 0 || targetFailures.length > 0)) {
          // Not every requested target was applied: do not claim success. If
          // work remains, open a fresh round for the next target; otherwise
          // report the unresolved targets through the termination step.
          if (targetQueue.length > 0) {
            continueTargets = true;
            break;
          }
          return await terminate("edit-exhausted", null);
        }
        // EditDsl confirmation (#B3): a verified edit gets one `# modified
        // text` turn. An editor clause continues the exchange loop; anything
        // else (including prose/malformed/viewer) confirms success.
        if (protocolFormat === "edit-dsl" && !targetsMode) {
          const modifiedLocator = editDslAppliedRegions[0]?.locator ?? pinnedTarget.locator;
          const modifiedPath = modifiedLocator.path;
          const modifiedSource = readFileIfExists(join(cwd, modifiedPath));
          let modifiedText = "";
          let modifiedStartLine = 1;
          if (modifiedSource !== null) {
            const modifiedEntry = resolveCurrentEntry(
              modifiedSource,
              modifiedPath,
              modifiedLocator,
              null,
            );
            if (modifiedEntry.ok) {
              const modifier = precedingExportModifier(modifiedSource, modifiedEntry.entry);
              const declarationStart =
                modifier === null
                  ? modifiedEntry.entry.node.start
                  : modifiedEntry.entry.node.start - modifier.length;
              modifiedText = modifiedSource.slice(declarationStart, modifiedEntry.entry.node.end);
              modifiedStartLine = modifiedSource.slice(0, declarationStart).split("\n").length;
            } else {
              modifiedText = truncateSource(modifiedSource);
            }
          }
          const modifiedPrompt = buildEditDslModifiedPrompt(
            options.issue,
            editDslIndexText,
            modifiedText,
            modifiedStartLine,
          );
          let confirmation: ChatResponse;
          try {
            confirmation = await options.provider.chat(
              [
                systemMessage,
                roundIssueMessage,
                { role: "assistant", content: response.content ?? "" },
                { role: "user", content: modifiedPrompt },
              ],
              undefined,
              exchangeOptions,
            );
          } catch {
            // The edit is already verified; a confirmation transport failure
            // must not turn the run into a failure.
            return success(newSource);
          }
          consumedTokens += tokensFromResponse(confirmation);
          addTokens(loopTokensFromResponse(confirmation));
          if (consumedTokens > tokenBudget) {
            // The confirmation is advisory and the verification already passed:
            // an over-budget confirmation still reports the verified success.
            return success(newSource);
          }
          records.push(
            recordRow({
              row: records.length + 1,
              iteration,
              kind: "exchange",
              exchange,
              locator: modifiedLocator,
              replacement: null,
              diagnostics: null,
              outcome: "confirmed",
              finishReason: confirmation.finishReason,
              toolCalls: confirmation.toolCalls.length,
            }),
          );
          let confirmationSelections: EditDslSelection[] = [];
          try {
            confirmationSelections = parseSelection(stripCodeFences(confirmation.content ?? ""));
          } catch (error) {
            if (!(error instanceof SelectionSyntaxError)) {
              throw error;
            }
            return success(newSource);
          }
          const continues = confirmationSelections.some(
            (selection) => selection.replacement !== null,
          );
          if (continues) {
            if (exchange < MAX_EDIT_EXCHANGES) {
              prefetchedReply = confirmation;
              initialContentPrompt = modifiedPrompt;
              continue;
            }
            // #8: the verified edit consumed the round's last normal exchange,
            // so the confirmation editor has no in-round slot. Carry the
            // already-counted reply into a fresh round (a defined continuation
            // like #52): the modified prompt and its reply stay paired, the
            // edit is applied as that round's first exchange without another
            // provider call, and the fresh round is charged against
            // MAX_RUN_ITERATIONS and the token budget like any other round.
            if (iteration >= MAX_RUN_ITERATIONS) {
              // No round left to carry the confirmation editor: keep the
              // verified state and end, exactly as the old guard did, rather
              // than report a misleading cap failure.
              return success(newSource);
            }
            pendingConfirmation = { reply: confirmation, prompt: modifiedPrompt };
            break;
          }
          return success(newSource);
        }
        return success(newSource);
      }
      // No rollback (#30): the attempted state stays on disk for the next
      // iteration to refine. A failure just starts the next iteration, which
      // gets a fresh ≤3 exchange budget.
      const diagnostics = formatDiagnostics({
        check,
        test,
        targetPath: target,
        baseSource: sourceBefore,
        newSource,
        sourceFor: (file) => readFileIfExists(join(cwd, file)),
      });
      const signature = check.diagnostics.length + failingTestNames(test.output).length;
      records.push(
        recordRow({
          row: records.length + 1,
          iteration,
          kind: "verification",
          exchange: null,
          locator: pinnedTarget.locator,
          replacement,
          diagnostics,
          outcome: check.ok ? "tests" : "tsc",
          finishReason: response.finishReason,
          signature,
        }),
      );
      // #111: a mixed edit-dsl reply's viewer occurrences ride into the next
      // round's prompt alongside the verification failure.
      pendingDiagnostics =
        carriedViewerFeedback !== null ? `${carriedViewerFeedback}\n\n${diagnostics}` : diagnostics;
      carriedViewerFeedback = null;
      pendingVerificationStage = check.ok ? "tests" : "tsc";
      // One more consecutive verification-failed round (#54): the count spans
      // rounds and #52 continuations; only a pass (which ends the run) resets it.
      stalledRounds += 1;
      verificationFailed = true;
      break;
    }

    // No-progress counting (#60): a round that ends with no applied edit (all
    // exchanges rejected, truncated, or spent picking) counts exactly like a
    // failed verification; only a pass (which ends the run) stops the chain.
    // The #54 decision point then fires in rejection cycles at the same
    // multiples of MAX_STALLED_ROUNDS.
    if (!verificationFailed && !appliedEdit) {
      stalledRounds += 1;
    }
    // Explicit-targets mode (#81): a passing partial verification with targets
    // still pending opens a fresh round for the next target.
    if (continueTargets) {
      continue;
    }
    if (verificationFailed) {
      continue;
    }
    // #8: a carried confirmation editor opens a fresh round (accounted like a
    // #52 continuation) instead of the ordinary round continuation prompt.
    if (pendingConfirmation !== null) {
      continue;
    }
    // Round-level continuation (#52): a successful pick may have consumed the
    // last exchange (no content exchange is left); below the cap the round
    // continues through a continuation prompt instead of ending the run.
    if (
      !targetsMode &&
      continuation === null &&
      pinned !== null &&
      iteration < MAX_RUN_ITERATIONS
    ) {
      continuation = {
        round: iteration,
        pick: false,
        diagnostics: combinedDiagnostics(iterationOpenedBy, lastDiagnostics),
      };
    }
    if (continuation !== null) {
      // A continued verification-repair chain keeps its opening diagnostics, so
      // the continuation (and its retries) may still re-pin (#52).
      if (iterationOpenedBy !== null) {
        pendingDiagnostics = iterationOpenedBy;
      }
      // ...and its prompt variant (#49): a tsc-repair chain stays lean.
      if (iterationOpenedByStage !== null) {
        pendingVerificationStage = iterationOpenedByStage;
      }
      continue;
    }
    if (iteration >= MAX_RUN_ITERATIONS) {
      return await terminate("edit-exhausted", capDiagnostics(iterationOpenedBy));
    }
    // Unreachable: the exchange loop only falls through after a pick or with a
    // continuation set.
    return await terminate(
      "edit-exhausted",
      exhaustedDiagnostics(iterationOpenedBy, lastDiagnostics),
    );
  }
}
