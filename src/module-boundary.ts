/**
 * File-level module-boundary edits (#54).
 *
 * Imports and exports have no declaration address: the symbol index deliberately
 * excludes them. This module owns their file-level owner instead:
 *
 * - `select file <path> [match …] [pick …] replace with <fence> end` resolves
 *   one span inside an import/export statement;
 * - `create import|export in <path> with <fence> end` inserts exactly one
 *   module-boundary statement after the shebang, directives, and existing
 *   imports.
 *
 * Both paths return ordinary resolved regions, so the parse gate, formatter,
 * atomic apply, and task/node gates stay unchanged.
 */
import type { SelectionStage } from "./cascade";
import { positionAtOffset } from "./dsl-diagnostics";
import { findMatcherMatches, findRegexMatches, structurallyEqual } from "./matcher";
import { Parser } from "./parser";
import type { Node, Program, Statement } from "./parser";
import { resolveEditRange } from "./loop";
import type { EditRange } from "./loop";
import { END_OF_LINE_COLUMN, isFileSelection } from "./selection";
import type { CreateModuleStatement, ModuleCreateKind, Selection } from "./selection";
import { memberDeletionRange } from "./utility";

/** The stage a file-level clause failed at, in the edit-dsl failure vocabulary. */
export type ModuleEditFailureStage = "address" | "matcher" | "range" | "no-op";

export type FileSelectionResolution =
  | {
      ok: true;
      start: number;
      end: number;
      text: string;
      stage: SelectionStage;
      gateStart: number;
    }
  | {
      ok: false;
      stage: ModuleEditFailureStage;
      diagnostics: string;
    };

export interface ModuleCreateResolution {
  ok: true;
  path: string;
  start: number;
  end: number;
  text: string;
  kind: ModuleCreateKind;
  /** Canonical structural identity, used to reject duplicate creates in one reply. */
  signature: string;
}

export interface ModuleCreateFailure {
  ok: false;
  stage: "address" | "duplicate";
  diagnostics: string;
}

type ModuleCreateResult = ModuleCreateResolution | ModuleCreateFailure;

interface Span {
  start: number;
  end: number;
}

const CANDIDATE_LIST_LIMIT = 8;

/** True for every top-level statement whose owner is the module boundary. */
export function isModuleBoundaryStatement(statement: Statement): boolean {
  switch (statement.kind) {
    case "ImportDeclaration":
    case "ImportEqualsDeclaration":
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
    case "ExportAllDeclaration":
    case "ExportAssignment":
      return true;
    default:
      return false;
  }
}

function isImportStatement(statement: Statement): boolean {
  return statement.kind === "ImportDeclaration" || statement.kind === "ImportEqualsDeclaration";
}

function isDirective(statement: Statement): boolean {
  return statement.kind === "ExpressionStatement" && statement.expression.kind === "StringLiteral";
}

function parseProgram(source: string): Program | null {
  try {
    return new Parser(source).parseProgram();
  } catch {
    return null;
  }
}

function lineLengthAt(source: string, line: number): number | null {
  let currentLine = 1;
  let index = 0;
  while (currentLine < line) {
    const newline = source.indexOf("\n", index);
    if (newline === -1) {
      return null;
    }
    index = newline + 1;
    currentLine += 1;
  }
  const newline = source.indexOf("\n", index);
  return (newline === -1 ? source.length : newline) - index;
}

function normalizePickRange(source: string, range: EditRange): EditRange {
  if (range.endColumn !== END_OF_LINE_COLUMN) {
    return range;
  }
  const length = lineLengthAt(source, range.endLine);
  return { ...range, endColumn: length === null ? 1 : Math.max(1, length) };
}

function resolvePickSpans(
  source: string,
  pick: readonly EditRange[],
): { ok: true; spans: Span[] } | { ok: false; diagnostics: string } {
  const spans: Span[] = [];
  for (const range of pick) {
    const located = resolveEditRange(source, normalizePickRange(source, range), 0, source.length, {
      start: 0,
      end: source.length,
    });
    if (!located.ok) {
      return {
        ok: false,
        diagnostics: [
          "stage: range",
          `the file-level \`pick\` range (line ${range.line}, column ${range.column} to line ${range.endLine}, column ${range.endColumn}) is invalid (${located.reason}): ${located.detail}`,
          "copy the 1-based file-absolute line and column positions from the numbered source block, keep the end inclusive, and keep the range inside one import/export statement",
        ].join("\n"),
      };
    }
    spans.push({ start: located.start, end: located.end });
  }
  return { ok: true, spans };
}

function moduleStatementAt(program: Program, span: Span): Statement | null {
  for (const statement of program.body) {
    if (!isModuleBoundaryStatement(statement)) {
      continue;
    }
    if (statement.start <= span.start && span.end <= statement.end) {
      return statement;
    }
  }
  return null;
}

function statementLabel(statement: Statement): string {
  switch (statement.kind) {
    case "ImportDeclaration":
    case "ImportEqualsDeclaration":
      return "import statement";
    case "ExportDefaultDeclaration":
      return "default export";
    case "ExportAllDeclaration":
      return "export-all statement";
    case "ExportAssignment":
      return "export = assignment";
    case "ExportNamedDeclaration":
      if (statement.declaration !== null) {
        return "export declaration";
      }
      return statement.source === null ? "export statement" : "re-export statement";
    default:
      return "statement";
  }
}

function spanLocation(path: string, source: string, span: Span): string {
  const { line, column } = positionAtOffset(source, span.start);
  return `${path}:${line}:${column}`;
}

function candidateLine(path: string, source: string, program: Program, span: Span): string {
  const statement = moduleStatementAt(program, span);
  const location = spanLocation(path, source, span);
  return statement === null
    ? `- ${location} (outside an import/export statement)`
    : `- ${location} (${statementLabel(statement)})`;
}

function ambiguousDiagnostics(
  path: string,
  source: string,
  program: Program,
  spans: readonly Span[],
  picked: boolean,
): string {
  const listed = spans.slice(0, CANDIDATE_LIST_LIMIT);
  const more = spans.length - listed.length;
  return [
    "stage: matcher",
    `the file-level ${picked ? "match + pick" : "match"} in ${JSON.stringify(path)} resolves to ${spans.length} spans; a file-level select must resolve exactly one span inside an import/export statement`,
    "candidates:",
    ...listed.map((span) => candidateLine(path, source, program, span)),
    ...(more > 0 ? [`- ... and ${more} more`] : []),
    "hint: extend the snippet, anchor or lengthen the regex, or add a `pick` range that contains exactly one candidate",
  ].join("\n");
}

function outsideModuleDiagnostics(path: string, source: string, span: Span): string {
  return [
    "stage: address",
    `the file-level selection resolved to ${spanLocation(path, source, span)}, which is outside an import/export statement`,
    "a file-level select only edits module-boundary statements; include the full import/export statement in the snippet, or use a regex/pick inside one",
    "to edit a declaration, select its declaration address instead",
  ].join("\n");
}

function notFoundDiagnostics(path: string, matcherKind: "snippet" | "regex"): string {
  return [
    "stage: matcher",
    `the file-level ${matcherKind === "regex" ? "`/regex/`" : "snippet"} matcher matched nothing inside an import/export statement in ${JSON.stringify(path)}`,
    "copy a complete import/export statement or specifier, use a regex anchored inside one, or use `pick` with file-absolute coordinates",
  ].join("\n");
}

function pickMatchesSpan(span: Span, range: EditRange, pickSpan: Span): boolean {
  const point = range.line === range.endLine && range.column === range.endColumn;
  if (point) {
    return span.start <= pickSpan.start && pickSpan.start <= span.end;
  }
  return span.start >= pickSpan.start && span.end <= pickSpan.end;
}

function wholeLineRange(source: string, span: Span): Span {
  const lineStart = source.lastIndexOf("\n", Math.max(0, span.start - 1)) + 1;
  const lineEnd = source.indexOf("\n", span.end);
  const end = lineEnd === -1 ? source.length : lineEnd;
  const prefix = source.slice(lineStart, span.start);
  const suffix = source.slice(span.end, end);
  if (/^[ \t]*$/.test(prefix) && /^[ \t]*$/.test(suffix)) {
    return { start: lineStart, end: lineEnd === -1 ? source.length : lineEnd + 1 };
  }
  return span;
}

function namedSpecifiers(statement: Statement): readonly Node[] {
  if (statement.kind === "ImportDeclaration") {
    return statement.namedImports;
  }
  if (statement.kind === "ExportNamedDeclaration") {
    return statement.specifiers;
  }
  return [];
}

function childNodeSpans(node: Node): Span[] {
  const spans: Span[] = [];
  const record = node as unknown as Record<string, unknown>;
  for (const key of ["imported", "local", "exported"]) {
    const value = record[key];
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as Node).start === "number" &&
      typeof (value as Node).end === "number"
    ) {
      spans.push({ start: (value as Node).start, end: (value as Node).end });
    }
  }
  return spans;
}

function spansEqual(left: Span, right: Span): boolean {
  return left.start === right.start && left.end === right.end;
}

function dedupeSpans(spans: readonly Span[]): Span[] {
  const seen = new Set<string>();
  const unique: Span[] = [];
  for (const span of spans) {
    const key = `${span.start}:${span.end}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(span);
  }
  return unique;
}

/**
 * Expand an empty-fence specifier deletion to the whole named specifier and its
 * separator. Structural matching a bare `Foo` hits the identifier inside
 * `Foo as Bar`; deleting only that identifier would leave a broken import.
 */
function specifierDeletionRange(source: string, statement: Statement, target: Span): Span | null {
  for (const specifier of namedSpecifiers(statement)) {
    const full = { start: specifier.start, end: specifier.end };
    const matchesSpecifier =
      spansEqual(target, full) ||
      childNodeSpans(specifier).some((span) => spansEqual(target, span));
    if (!matchesSpecifier) {
      continue;
    }
    return memberDeletionRange(source, specifier) ?? full;
  }
  return null;
}

function moduleEditFailure(
  stage: ModuleEditFailureStage,
  diagnostics: string,
): FileSelectionResolution {
  return { ok: false, stage, diagnostics };
}

/**
 * Resolve one `select file …` clause. The file source is the owner; candidates
 * may be structural statement/specifier matches, regex matches, or pick ranges.
 * A candidate must sit inside exactly one import/export statement.
 */
export function resolveFileSelection(
  source: string,
  selection: Selection,
): FileSelectionResolution {
  if (!isFileSelection(selection)) {
    return moduleEditFailure(
      "address",
      "stage: address\nthe file-level resolver received a declaration selection",
    );
  }
  if (selection.replacement === null) {
    return moduleEditFailure(
      "address",
      "stage: address\na file-level select is an editor and requires `replace with <fence>`; use `read <path> end` to view the file",
    );
  }
  if (selection.matcher === null && selection.pick === null) {
    return moduleEditFailure(
      "address",
      [
        "stage: address",
        "a file-level select needs `match` or `pick`; without one it would rewrite the whole file",
        "add `match (<snippet> | /regex/)` or `pick <selecters>`, or use `write <path> with <fence>` for a whole-file replacement",
      ].join("\n"),
    );
  }
  const program = parseProgram(source);
  if (program === null) {
    return moduleEditFailure(
      "address",
      `stage: address\ncannot resolve a file-level select in ${JSON.stringify(selection.locator.path)}: the file does not parse`,
    );
  }

  let candidates: Span[] = [];
  let stage: SelectionStage = "match";
  const picked = selection.pick !== null;

  if (selection.matcher !== null) {
    if (selection.matcher.kind === "regex") {
      const found = findRegexMatches(
        source,
        { start: 0, end: source.length },
        selection.matcher.value,
      );
      if (found.kind === "invalid") {
        return moduleEditFailure(
          "matcher",
          `stage: matcher\nthe file-level \`/regex/\` matcher is invalid: ${found.message}; write a valid ECMA-262 pattern with no flags`,
        );
      }
      candidates = found.spans;
    } else {
      const found = findMatcherMatches(
        source,
        { start: 0, end: source.length },
        selection.matcher.value,
      );
      if (found.kind === "unparseable") {
        return moduleEditFailure(
          "matcher",
          `stage: matcher\nthe file-level snippet could not be parsed as TypeScript: ${found.message}; copy a complete statement, specifier expression, or expression`,
        );
      }
      candidates = found.spans;
    }
  } else {
    candidates = [{ start: 0, end: source.length }];
  }

  if (selection.pick !== null) {
    const picks = resolvePickSpans(source, selection.pick);
    if (!picks.ok) {
      return moduleEditFailure("range", picks.diagnostics);
    }
    if (selection.matcher === null) {
      if (selection.pick.length !== 1) {
        return moduleEditFailure(
          "range",
          [
            "stage: range",
            `a file-level select without \`match\` takes exactly one \`pick\` range; found ${selection.pick.length}`,
            "write one range, or add a `match` to filter several picked ranges",
          ].join("\n"),
        );
      }
      const only = picks.spans[0];
      candidates = only === undefined ? [] : [only];
    } else {
      const filtered = candidates.filter((span) => {
        for (let index = 0; index < selection.pick!.length; index += 1) {
          const range = selection.pick![index];
          const pickSpan = picks.spans[index];
          if (
            range !== undefined &&
            pickSpan !== undefined &&
            pickMatchesSpan(span, range, pickSpan)
          ) {
            return true;
          }
        }
        return false;
      });
      candidates = filtered;
    }
    stage = "pick";
  }

  candidates = dedupeSpans(candidates);

  if (candidates.length === 0) {
    return moduleEditFailure(
      "matcher",
      selection.matcher === null
        ? "stage: matcher\nthe file-level `pick` resolved no text span"
        : notFoundDiagnostics(selection.locator.path, selection.matcher.kind),
    );
  }
  if (candidates.length > 1) {
    return moduleEditFailure(
      "matcher",
      ambiguousDiagnostics(selection.locator.path, source, program, candidates, picked),
    );
  }
  const target = candidates[0];
  if (target === undefined) {
    return moduleEditFailure(
      "matcher",
      notFoundDiagnostics(selection.locator.path, selection.matcher?.kind ?? "snippet"),
    );
  }
  const statement = moduleStatementAt(program, target);
  if (statement === null) {
    return moduleEditFailure(
      "address",
      outsideModuleDiagnostics(selection.locator.path, source, target),
    );
  }

  let start = target.start;
  let end = target.end;
  if (selection.replacement.trim() === "") {
    if (spansEqual(target, { start: statement.start, end: statement.end })) {
      const line = wholeLineRange(source, { start, end });
      start = line.start;
      end = line.end;
    } else {
      const specifier = specifierDeletionRange(source, statement, target);
      if (specifier !== null) {
        start = specifier.start;
        end = specifier.end;
      }
    }
  }
  if (selection.replacement === source.slice(start, end)) {
    return moduleEditFailure(
      "no-op",
      "stage: no-op\nthe file-level edit does not change the file: the replacement is identical to the text it replaces",
    );
  }
  return {
    ok: true,
    start,
    end,
    text: selection.replacement,
    stage,
    gateStart: start,
  };
}

function lineStartAfter(source: string, offset: number): number {
  const newline = source.indexOf("\n", offset);
  return newline === -1 ? source.length : newline + 1;
}

function shebangEnd(source: string): number {
  if (!source.startsWith("#!")) {
    return 0;
  }
  const newline = source.indexOf("\n");
  return newline === -1 ? source.length : newline + 1;
}

/**
 * Insert after the shebang, leading string directives, and the contiguous
 * existing import block. An export create uses the same module-boundary slot so
 * it stays above executable code while remaining after imports.
 */
function moduleInsertionOffset(source: string, program: Program): number {
  let offset = shebangEnd(source);
  for (const statement of program.body) {
    if (statement.start < offset) {
      continue;
    }
    if (!isDirective(statement) && !isImportStatement(statement)) {
      break;
    }
    offset = lineStartAfter(source, statement.end);
  }
  return offset;
}

function importBindings(statement: Statement): string[] {
  if (statement.kind === "ImportEqualsDeclaration") {
    return [statement.name.name];
  }
  if (statement.kind !== "ImportDeclaration") {
    return [];
  }
  const names: string[] = [];
  if (statement.defaultImport !== null) {
    names.push(statement.defaultImport.name);
  }
  if (statement.namespaceImport !== null) {
    names.push(statement.namespaceImport.name);
  }
  for (const specifier of statement.namedImports) {
    names.push(specifier.local.name);
  }
  return names;
}

function statementBindingNames(statement: Statement): string[] {
  switch (statement.kind) {
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return statement.name === null ? [] : [statement.name.name];
    case "InterfaceDeclaration":
    case "TypeAliasDeclaration":
    case "EnumDeclaration":
      return [statement.name.name];
    case "NamespaceDeclaration":
      return [statement.name];
    case "VariableStatement": {
      const names: string[] = [];
      for (const declarator of statement.declarations) {
        const name = declarator.name;
        if (name.kind === "Identifier") {
          names.push(name.name);
        }
      }
      return names;
    }
    default:
      return [];
  }
}

function moduleName(
  node: { kind: "Identifier"; name: string } | { kind: "StringLiteral"; value: string },
): string {
  return node.kind === "Identifier" ? node.name : node.value;
}

function exportedNames(statement: Statement): string[] {
  switch (statement.kind) {
    case "ExportNamedDeclaration": {
      if (statement.declaration !== null) {
        return statementBindingNames(statement.declaration);
      }
      return statement.specifiers.map((specifier) =>
        moduleName(specifier.exported === null ? specifier.local : specifier.exported),
      );
    }
    case "ExportDefaultDeclaration":
      return ["default"];
    case "ExportAllDeclaration":
      return statement.exported === null ? [] : [statement.exported.name];
    case "ExportAssignment":
      return ["export="];
    default:
      return [];
  }
}

function canonicalNode(node: Node): string {
  return JSON.stringify(node, (key, value: unknown) => {
    if (key === "start" || key === "end" || key === "raw") {
      return undefined;
    }
    if (key === "source" && typeof value === "string") {
      return undefined;
    }
    return value;
  });
}

function moduleCreateFailure(
  statement: CreateModuleStatement,
  stage: "address" | "duplicate",
  code: string,
  detail: string,
  hint: string,
): ModuleCreateFailure {
  return {
    ok: false,
    stage,
    diagnostics: [
      `stage: ${stage}`,
      `code: ${code}`,
      `cannot create ${statement.kind} in ${JSON.stringify(statement.path)}: ${detail}`,
      `hint: ${hint}`,
    ].join("\n"),
  };
}

function moduleStatementBody(
  statement: CreateModuleStatement,
): { ok: true; node: Statement; body: string } | ModuleCreateFailure {
  const body = statement.replacement.trim();
  if (body === "") {
    return moduleCreateFailure(
      statement,
      "address",
      "EDIT_CREATE_MODULE_MALFORMED",
      "the create fence is empty",
      `send exactly one ${statement.kind} statement between the sentinel fences`,
    );
  }
  let program: Program;
  try {
    program = new Parser(body).parseProgram();
  } catch (error) {
    return moduleCreateFailure(
      statement,
      "address",
      "EDIT_CREATE_MODULE_MALFORMED",
      `the fence does not parse as TypeScript: ${error instanceof Error ? error.message : String(error)}`,
      `send exactly one ${statement.kind} statement`,
    );
  }
  if (program.body.length !== 1) {
    return moduleCreateFailure(
      statement,
      "address",
      "EDIT_CREATE_MODULE_MALFORMED",
      `the fence contains ${program.body.length} top-level statements; a module create adds exactly one`,
      `send exactly one ${statement.kind} statement`,
    );
  }
  const node = program.body[0];
  if (node === undefined) {
    return moduleCreateFailure(
      statement,
      "address",
      "EDIT_CREATE_MODULE_MALFORMED",
      "the fence contains no statement",
      `send exactly one ${statement.kind} statement`,
    );
  }
  if (statement.kind === "import") {
    if (!isImportStatement(node)) {
      return moduleCreateFailure(
        statement,
        "address",
        "EDIT_CREATE_MODULE_KIND_MISMATCH",
        `the fence declares a ${node.kind}, not an import statement`,
        "send exactly one `import …` statement, or use `create export`",
      );
    }
  } else if (!isModuleBoundaryStatement(node) || isImportStatement(node)) {
    return moduleCreateFailure(
      statement,
      "address",
      "EDIT_CREATE_MODULE_KIND_MISMATCH",
      `the fence declares a ${node.kind}, not an export statement`,
      "send exactly one `export …` statement, or use `create import`",
    );
  }
  return { ok: true, node, body };
}

/**
 * Validate and place one `create import|export` statement. The insertion is a
 * zero-width region; the caller owns path safety, reply uniqueness, and atomic
 * application.
 */
export function resolveModuleCreate(
  statement: CreateModuleStatement,
  source: string,
): ModuleCreateResult {
  let existing: Program;
  try {
    existing = new Parser(source).parseProgram();
  } catch (error) {
    return moduleCreateFailure(
      statement,
      "address",
      "EDIT_CREATE_MODULE_MALFORMED",
      `the existing file does not parse: ${error instanceof Error ? error.message : String(error)}`,
      "repair the file before adding a module-boundary statement",
    );
  }
  const prepared = moduleStatementBody(statement);
  if (!prepared.ok) {
    return prepared;
  }
  const node = prepared.node;

  const duplicate = existing.body.find(
    (candidate) =>
      isModuleBoundaryStatement(candidate) &&
      isImportStatement(candidate) === isImportStatement(node) &&
      structurallyEqual(candidate, node),
  );
  if (duplicate !== undefined) {
    return moduleCreateFailure(
      statement,
      "duplicate",
      "EDIT_CREATE_MODULE_DUPLICATE",
      `the file already contains this ${statement.kind} statement at line ${positionAtOffset(source, duplicate.start).line}`,
      "edit the existing statement instead of adding an identical copy",
    );
  }

  if (statement.kind === "import") {
    const incoming = new Set(importBindings(node));
    const conflicts: string[] = [];
    for (const candidate of existing.body) {
      for (const name of importBindings(candidate)) {
        if (incoming.has(name)) {
          conflicts.push(name);
        }
      }
    }
    if (conflicts.length > 0) {
      const names = [...new Set(conflicts)].sort().join(", ");
      return moduleCreateFailure(
        statement,
        "duplicate",
        "EDIT_CREATE_MODULE_DUPLICATE",
        `the import binding${conflicts.length === 1 ? "" : "s"} ${names} already exist in the file`,
        "import each local binding name once; edit the existing import instead",
      );
    }
  } else {
    if (
      node.kind === "ExportDefaultDeclaration" &&
      existing.body.some((candidate) => candidate.kind === "ExportDefaultDeclaration")
    ) {
      return moduleCreateFailure(
        statement,
        "duplicate",
        "EDIT_CREATE_MODULE_DUPLICATE",
        "the file already has a default export; a module may declare only one",
        "edit the existing default export instead",
      );
    }
    if (
      node.kind === "ExportAssignment" &&
      existing.body.some((candidate) => candidate.kind === "ExportAssignment")
    ) {
      return moduleCreateFailure(
        statement,
        "duplicate",
        "EDIT_CREATE_MODULE_DUPLICATE",
        "the file already has an `export =` assignment; a module may declare only one",
        "edit the existing export assignment instead",
      );
    }
    const incoming = new Set(exportedNames(node));
    const conflicts = [
      ...new Set(
        existing.body.flatMap((candidate) =>
          exportedNames(candidate).filter((name) => incoming.has(name)),
        ),
      ),
    ];
    if (conflicts.length > 0) {
      return moduleCreateFailure(
        statement,
        "duplicate",
        "EDIT_CREATE_MODULE_DUPLICATE",
        `the export name${conflicts.length === 1 ? "" : "s"} ${conflicts
          .map((name) => JSON.stringify(name))
          .join(", ")} already exist in the file`,
        "export each name once; edit the existing export instead",
      );
    }
  }

  const offset = moduleInsertionOffset(source, existing);
  const prefix = offset > 0 && source[offset - 1] !== "\n" ? "\n" : "";
  return {
    ok: true,
    path: statement.path,
    start: offset,
    end: offset,
    text: `${prefix}${prepared.body}\n`,
    kind: statement.kind,
    signature: `${statement.kind}\u0000${canonicalNode(node)}`,
  };
}
