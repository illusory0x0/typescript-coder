/**
 * Shared diagnostics for the Plan DSL and the edit-action DSL (`docs/spec.md`
 * §5.2-5.3). Both parsers collect `DslIssue`s while recovering structure; one
 * renderer turns them into the bounded, model-facing shape: stage, stable code,
 * line/column, excerpt with a caret, expected/found/hint, and record/clause
 * identity.
 *
 * The module is deliberately data + functions: parsers own recovery, this
 * module owns presentation. Warnings never block application; errors do.
 */

/** The stage a diagnostic belongs to, using the parser/driver vocabulary. */
export type DslStage =
  | "syntax"
  | "structure"
  | "address"
  | "matcher"
  | "range"
  | "protocol"
  | "task-protocol"
  | "task-tree";

/** One recovered parse problem. `recovered` is true for warnings. */
export interface DslIssue {
  severity: "error" | "warning";
  stage: DslStage;
  /** Stable code, e.g. `PLAN_MISSING_END` or `EDIT_MATCHER_MISSING`. */
  code: string;
  message: string;
  /** 1-based line in the raw reply. */
  line: number;
  /** 1-based column in the raw reply. */
  column: number;
  /** Raw reply, used by the renderer to build the excerpt. */
  excerpt?: string;
  expected?: string[];
  found?: string;
  hint?: string;
  recovered: boolean;
  recordId?: string;
  /** 1-based clause position in a multi-clause edit reply. */
  clauseIndex?: number;
}

/** A detailed parse result. `value` is best-effort when `ok` is false. */
export interface DslParseResult<T> {
  ok: boolean;
  value?: T;
  issues: DslIssue[];
  /** True when the reply ended inside a record, fence, snippet, or regex. */
  truncated: boolean;
}

/** The default number of rendered issues before the count line. */
export const DSL_ISSUE_LIMIT = 8;

/**
 * Split a 1-based offset into a line/column pair without building a line table.
 * The edit-dsl reader only knows offsets, so this keeps its diagnostics in the
 * same shape as the line-oriented Plan parser.
 */
export function positionAtOffset(text: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < clamped; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

const EXCERPT_LINES_BEFORE = 2;
const EXCERPT_LINES_AFTER = 1;
const EXCERPT_WINDOW = 200;
const EXCERPT_CARET_WINDOW = 80;

/**
 * A short numbered excerpt around `line`, with a caret under `column`. Long
 * lines are windowed around the caret so a 5k-character reply line cannot
 * flood the retry prompt.
 */
export function renderExcerpt(text: string, line: number, column: number): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length === 0) {
    return [];
  }
  const target = Math.max(1, Math.min(line, lines.length));
  const from = Math.max(1, target - EXCERPT_LINES_BEFORE);
  const to = Math.min(lines.length, target + EXCERPT_LINES_AFTER);
  const width = String(to).length;
  const rendered: string[] = [];
  for (let row = from; row <= to; row += 1) {
    const value = lines[row - 1] ?? "";
    const start = row === target ? Math.max(0, column - 1 - EXCERPT_CARET_WINDOW) : 0;
    const slice = value.slice(start, start + EXCERPT_WINDOW);
    const prefix = start > 0 ? "…" : "";
    const suffix = start + EXCERPT_WINDOW < value.length ? "…" : "";
    rendered.push(`${String(row).padStart(width)} | ${prefix}${slice}${suffix}`);
    if (row === target) {
      const caret = prefix.length + Math.max(0, column - 1 - start);
      rendered.push(`${" ".repeat(width)} | ${" ".repeat(caret)}^`);
    }
  }
  return rendered;
}

function renderIssue(issue: DslIssue): string[] {
  const lines = [`stage: ${issue.stage}`, `code: ${issue.code}`];
  if (issue.severity === "warning") {
    lines.push("severity: warning");
  }
  lines.push(`message: ${issue.message}`);
  lines.push(`at line ${issue.line}:${issue.column}`);
  if (issue.excerpt !== undefined && issue.excerpt !== "") {
    lines.push(...renderExcerpt(issue.excerpt, issue.line, issue.column));
  }
  if (issue.expected !== undefined && issue.expected.length > 0) {
    lines.push(`expected: ${issue.expected.join(" | ")}`);
  }
  if (issue.found !== undefined) {
    lines.push(`found: ${issue.found}`);
  }
  if (issue.hint !== undefined) {
    lines.push(`hint: ${issue.hint}`);
  }
  if (issue.recordId !== undefined) {
    lines.push(`record: ${issue.recordId}`);
  }
  if (issue.clauseIndex !== undefined) {
    lines.push(`clause: ${issue.clauseIndex}`);
  }
  return lines;
}

/**
 * Render issues in one stable shape. The first `limit` issues are shown (8 by
 * default), then a single count line; warnings are visible but their marker
 * makes clear they do not block.
 */
export function renderDslIssues(
  issues: readonly DslIssue[],
  options: { limit?: number } = {},
): string {
  const limit = Math.max(0, options.limit ?? DSL_ISSUE_LIMIT);
  const shown = issues.slice(0, limit);
  const blocks = shown.map(renderIssue).map((lines) => lines.join("\n"));
  const hidden = issues.length - shown.length;
  if (hidden > 0) {
    blocks.push(`… ${hidden} more issue(s)`);
  }
  return blocks.join("\n\n");
}
