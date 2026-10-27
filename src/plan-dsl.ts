/**
 * The flat work-graph DSL (`docs/plan-exec.md` §3): strict parsers and
 * serializers for the planner's replies.
 *
 * A reply is an optional `plan` header with a `goal:` label, then flat records
 * in wire order: `node` appends one work node, and `amend` revises a pending,
 * failed, or just-reviewed node. There is no patch algebra, no delete, and no
 * `finish` marker: the run completes when no node is ready and the last gate was
 * a passing `test`. The graph model and validator live in `src/tasks.ts`; this
 * module only turns the wire form into that model.
 *
 * Parsing is tolerant in the same ways as the edit DSL: a whole-reply fence, a
 * bare id, and an unambiguous missing `end` recover with warnings; structure is
 * still rejected all-or-nothing, with shared bounded diagnostics (see
 * `src/dsl-diagnostics.ts`). There is no JSON fallback and no legacy
 * Stage/Task/Edit mode.
 */
import { HINT_SPACES, NODE_ID_PATTERN, validateNodes, validatePlan, WORK_VERIFIES } from "./tasks";
import type {
  HintLoc,
  NodeAmend,
  NodeId,
  PlanParse,
  PlanReply,
  WorkNode,
  WorkVerify,
} from "./tasks";
import { renderDslIssues } from "./dsl-diagnostics";
import type { DslIssue, DslParseResult, DslStage } from "./dsl-diagnostics";
import {
  containsEditFenceEnd,
  EDIT_FENCE_BEGIN,
  EDIT_FENCE_END,
  isLegacyEditFence,
} from "./selection";
import type { SymbolSpace } from "./utility";

/**
 * Plan diagnostics use the shared `stage:` channel with work-node vocabulary
 * (`plan-protocol` and `plan-graph`).
 */
type DiagnosticStage = DslStage;

const VERIFY_SET: ReadonlySet<string> = new Set(WORK_VERIFIES);
const SPACE_SET: ReadonlySet<string> = new Set(HINT_SPACES);

/**
 * Record headers from the old Stage/Task/Edit hierarchy and the removed patch
 * algebra. They are rejected with a dedicated diagnostic instead of being
 * guessed as unknown fields.
 */
const LEGACY_KEYWORDS: ReadonlySet<string> = new Set([
  "stage",
  "task",
  "edit",
  "patch",
  "plan~",
  "node+",
  "node~",
  "node-",
  "stage+",
  "stage~",
  "stage-",
  "task+",
  "task~",
  "task-",
  "edit+",
  "edit~",
  "edit-",
]);

function isLegacyKeyword(keyword: string): boolean {
  return LEGACY_KEYWORDS.has(keyword);
}

interface Line {
  text: string;
  /** 1-based line number in the normalized reply. */
  number: number;
}

interface Cursor {
  lines: readonly Line[];
  position: number;
  /** Normalized reply; excerpts use the same line numbers as `lines`. */
  source: string;
  issues: DslIssue[];
  truncated: boolean;
}

/** A syntax abort: the issue is already recorded; the driver skips to a boundary. */
class PlanSyntaxError extends Error {
  readonly issue: DslIssue;

  constructor(issue: DslIssue) {
    super(issue.message);
    this.issue = issue;
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function cursorOf(content: string): Cursor {
  const lines = content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((text, index) => ({ text, number: index + 1 }));
  return {
    lines,
    position: 0,
    source: lines.map((line) => line.text).join("\n"),
    issues: [],
    truncated: false,
  };
}

interface IssueOptions {
  line?: number;
  column?: number;
  expected?: string[];
  found?: string;
  hint?: string;
  recordId?: string;
  stage?: DiagnosticStage;
  severity?: "error" | "warning";
}

function currentLine(cursor: Cursor): number {
  return cursor.lines[Math.min(cursor.position, Math.max(0, cursor.lines.length - 1))]?.number ?? 1;
}

function issueAt(
  cursor: Cursor,
  code: string,
  message: string,
  options: IssueOptions = {},
): DslIssue {
  const severity = options.severity ?? "error";
  return {
    severity,
    stage: (options.stage ?? "plan-protocol") as DslIssue["stage"],
    code,
    message,
    line: options.line ?? currentLine(cursor),
    column: options.column ?? 1,
    excerpt: cursor.source,
    ...(options.expected === undefined ? {} : { expected: options.expected }),
    ...(options.found === undefined ? {} : { found: options.found }),
    ...(options.hint === undefined ? {} : { hint: options.hint }),
    recovered: severity === "warning",
    ...(options.recordId === undefined ? {} : { recordId: options.recordId }),
  };
}

/** Distinguish graph validation failures from protocol failures. */
function isPlanGraphStage(stage: DslIssue["stage"]): boolean {
  return stage === "plan-graph";
}

function report(
  cursor: Cursor,
  code: string,
  message: string,
  options: IssueOptions = {},
): DslIssue {
  const issue = issueAt(cursor, code, message, options);
  cursor.issues.push(issue);
  return issue;
}

function warn(cursor: Cursor, code: string, message: string, options: IssueOptions = {}): DslIssue {
  return report(cursor, code, message, { ...options, severity: "warning" });
}

function fail(cursor: Cursor, code: string, message: string, options: IssueOptions = {}): never {
  throw new PlanSyntaxError(issueAt(cursor, code, message, options));
}

function peekNonBlank(cursor: Cursor): Line | null {
  while (cursor.position < cursor.lines.length) {
    const line = cursor.lines[cursor.position];
    if (line === undefined) {
      return null;
    }
    if (line.text.trim() !== "") {
      return line;
    }
    cursor.position += 1;
  }
  return null;
}

function tokensOf(line: Line): string[] {
  return line.text.trim().split(/\s+/);
}

function tokenColumn(line: Line, token: string): number {
  const index = line.text.indexOf(token);
  return index === -1 ? 1 : index + 1;
}

function quotedId(
  cursor: Cursor,
  token: string | undefined,
  where: string,
  line: Line,
  recordId?: string,
): NodeId {
  if (token === undefined) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `${where} must be a quoted node id like "01-main" (got nothing)`,
      { line: line.number, expected: ['"NN-slug"'], found: "nothing", recordId },
    );
  }
  if (NODE_ID_PATTERN.test(token)) {
    warn(
      cursor,
      "PLAN_BARE_ID",
      `bare node id ${quote(token)} is accepted; quote it as ${quote(`"${token}"`)}`,
      {
        line: line.number,
        column: tokenColumn(line, token),
        expected: [`"${token}"`],
        found: token,
        hint: `write ${quote(`"${token}"`)} with double quotes`,
        recordId: token,
      },
    );
    return token;
  }
  if (!token.startsWith('"') || !token.endsWith('"') || token.length < 3) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `${where} must be a quoted node id like "01-main" (got ${quote(token)})`,
      {
        line: line.number,
        column: tokenColumn(line, token),
        expected: ['"NN-slug"'],
        found: token,
        recordId,
      },
    );
  }
  const value = token.slice(1, -1);
  if (value.includes('"')) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `${where} must be a single quoted node id (got ${quote(token)})`,
      {
        line: line.number,
        column: tokenColumn(line, token),
        found: token,
        recordId,
      },
    );
  }
  if (!NODE_ID_PATTERN.test(value)) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `${where} must be a string node id "NN-slug" (two or more digits, a hyphen, then lowercase kebab words); got ${quote(value)}`,
      {
        line: line.number,
        column: tokenColumn(line, token),
        found: value,
        recordId,
        hint: 'use ids like "02-scaffold" or "03-impl"',
      },
    );
  }
  return value;
}

/** True for a line that starts a new record (or a removed legacy header). */
function isRecordBoundary(trimmed: string): boolean {
  return trimmed === "finish" || /^(plan|patch|node|amend|stage|task|edit)\b/.test(trimmed);
}

function looksLikeField(trimmed: string): boolean {
  return (
    /^[A-Za-z][\w-]*:/.test(trimmed) ||
    /^(verify|related|hint|after|approach|phase)\b/.test(trimmed)
  );
}

function warnMissingEnd(
  cursor: Cursor,
  where: string,
  recordId: string | undefined,
  next: Line | null,
): void {
  if (next === null) {
    const last = cursor.lines[cursor.lines.length - 1];
    warn(
      cursor,
      "PLAN_MISSING_END",
      `expected "end" for ${where}, but the reply ended; accepted at the end of the reply`,
      {
        line: last?.number ?? 1,
        expected: ["end"],
        found: "<eof>",
        hint: `add "end" on its own line after ${where}'s last field`,
        recordId,
      },
    );
    return;
  }
  warn(
    cursor,
    "PLAN_MISSING_END",
    `missing "end" for ${where} before ${quote(next.text.trim())} on line ${next.number}; recovered at the record boundary`,
    {
      line: next.number,
      expected: ["end"],
      found: next.text.trim(),
      hint: `close ${where} with "end" before starting the next record`,
      recordId,
    },
  );
}

type TextFieldLabel = "goal:" | "instruction:" | "approach:" | "phase:";

/**
 * Read one text field: the rest of the label line, or an empty label followed by
 * a `TC_EDIT_BEGIN` line and raw body lines closed by an exact
 * `TC_EDIT_END` line. Fenced raw lines are kept exactly as sent. A missing
 * label, empty text, or unclosed fence is an error; legacy hyphen and backtick
 * fences are rejected with a hint to use the sentinel.
 */
function readText(cursor: Cursor, label: TextFieldLabel, where: string, recordId?: string): string {
  const line = peekNonBlank(cursor);
  if (line === null) {
    cursor.truncated = true;
    fail(cursor, "PLAN_TRUNCATED", `${where} needs ${label}, but the reply ended`, {
      line: Math.max(1, cursor.lines.length),
      expected: [label],
      found: "<eof>",
      recordId,
      hint: `add ${label} before end`,
    });
  }
  cursor.position += 1;
  const trimmed = line.text.trim();
  if (!trimmed.startsWith(label)) {
    const code =
      isRecordBoundary(trimmed) || trimmed === "end"
        ? "PLAN_MISSING_FIELD"
        : looksLikeField(trimmed)
          ? "PLAN_UNKNOWN_FIELD"
          : "PLAN_MISSING_FIELD";
    fail(cursor, code, `${where} needs ${label} on line ${line.number}; got ${quote(trimmed)}`, {
      line: line.number,
      expected: [label],
      found: trimmed,
      recordId,
      hint: `add ${label} before end`,
    });
  }
  const inline = trimmed.slice(label.length).trim();
  let opener: Line;
  let inlineOpener = false;
  if (inline === EDIT_FENCE_BEGIN) {
    inlineOpener = true;
    // Allow the opener to share the label line. The raw body still starts on
    // the next line, and the close sentinel remains whole-line.
    opener = line;
  } else if (inline.startsWith(EDIT_FENCE_BEGIN) || inline.startsWith(EDIT_FENCE_END)) {
    fail(
      cursor,
      "PLAN_MALFORMED_FENCE",
      `the ${label} fence marker for ${where} on line ${line.number} must be ${EDIT_FENCE_BEGIN} on its own line`,
      {
        line: line.number,
        expected: [EDIT_FENCE_BEGIN],
        found: inline,
        recordId,
        hint: `put ${EDIT_FENCE_BEGIN} on its own line, then the raw text, then ${EDIT_FENCE_END}`,
      },
    );
  } else if (inline !== "") {
    return inline;
  } else {
    const next = peekNonBlank(cursor);
    if (next === null) {
      cursor.truncated = true;
      fail(
        cursor,
        "PLAN_TRUNCATED",
        `${label} for ${where} is empty; put the text after ${label} or open ${EDIT_FENCE_BEGIN} on a new line`,
        {
          line: line.number,
          expected: [label, EDIT_FENCE_BEGIN],
          found: "<eof>",
          recordId,
        },
      );
    }
    cursor.position += 1;
    opener = next;
  }
  const marker = inlineOpener ? EDIT_FENCE_BEGIN : opener.text.trim();
  if (
    (marker.startsWith(EDIT_FENCE_BEGIN) || marker.startsWith(EDIT_FENCE_END)) &&
    marker !== EDIT_FENCE_BEGIN
  ) {
    fail(
      cursor,
      "PLAN_MALFORMED_FENCE",
      `the ${label} fence marker for ${where} on line ${opener.number} must be ${EDIT_FENCE_BEGIN} on its own line`,
      {
        line: opener.number,
        expected: [EDIT_FENCE_BEGIN],
        found: marker,
        recordId,
        hint: `put ${EDIT_FENCE_BEGIN} on its own line, then the raw text, then ${EDIT_FENCE_END}`,
      },
    );
  }
  if (isLegacyEditFence(marker)) {
    fail(
      cursor,
      "PLAN_LEGACY_FENCE",
      `${label} for ${where} on line ${opener.number} uses the legacy fence ${marker}; edit-action fences use the ${EDIT_FENCE_BEGIN} and ${EDIT_FENCE_END} sentinels only`,
      {
        line: opener.number,
        expected: [EDIT_FENCE_BEGIN],
        found: marker,
        recordId,
        hint: `replace the legacy fence with ${EDIT_FENCE_BEGIN} … ${EDIT_FENCE_END}`,
      },
    );
  }
  if (marker !== EDIT_FENCE_BEGIN) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `${label} for ${where} is empty; put the text after ${label} or open ${EDIT_FENCE_BEGIN} on line ${opener.number}`,
      {
        line: opener.number,
        expected: ["text after the label", EDIT_FENCE_BEGIN],
        found: opener.text.trim(),
        recordId,
        hint: `write ${label} <text>, or put ${label} alone and open ${EDIT_FENCE_BEGIN} on its own line`,
      },
    );
  }
  const content: string[] = [];
  while (cursor.position < cursor.lines.length) {
    const raw = cursor.lines[cursor.position];
    if (raw === undefined) {
      break;
    }
    cursor.position += 1;
    const rawTrimmed = raw.text.trim();
    if (rawTrimmed.startsWith(EDIT_FENCE_END) && rawTrimmed !== EDIT_FENCE_END) {
      fail(
        cursor,
        "PLAN_FENCE_TRAILING_TEXT",
        `the closing sentinel ${EDIT_FENCE_END} for ${label} in ${where} must be on its own line; trailing text is not allowed`,
        {
          line: raw.number,
          expected: [EDIT_FENCE_END],
          found: rawTrimmed,
          recordId,
          hint: `put ${EDIT_FENCE_END} on its own line`,
        },
      );
    }
    if (rawTrimmed === EDIT_FENCE_END) {
      const text = content.join("\n");
      if (text.trim() === "") {
        fail(
          cursor,
          "PLAN_MISSING_FIELD",
          `${label} for ${where} is empty; the fence on line ${opener.number} must contain text`,
          {
            line: opener.number,
            expected: ["non-empty fenced text"],
            found: "empty fence",
            recordId,
          },
        );
      }
      const next = peekNonBlank(cursor);
      if (next !== null) {
        const after = next.text.trim();
        if (after !== "end" && !isRecordBoundary(after) && !looksLikeField(after)) {
          fail(
            cursor,
            "PLAN_EMBEDDED_FENCE_END",
            `${label} for ${where} contains the literal line ${EDIT_FENCE_END}; the first exact end-marker line closes the fence and no text may follow it`,
            {
              line: next.number,
              expected: ["end", EDIT_FENCE_END],
              found: after,
              recordId,
              hint: `remove the embedded ${EDIT_FENCE_END} line or rewrite the text so it does not contain the marker`,
            },
          );
        }
      }
      return text;
    }
    content.push(raw.text);
  }
  cursor.truncated = true;
  fail(
    cursor,
    "PLAN_UNCLOSED_FENCE",
    `${where} has an unclosed ${label} fence opened on line ${opener.number}; close it with ${EDIT_FENCE_END}`,
    {
      line: opener.number,
      expected: [EDIT_FENCE_END],
      found: "<eof>",
      recordId,
      hint: `close the fence with ${EDIT_FENCE_END}`,
    },
  );
}

function expectEnd(cursor: Cursor, where: string, recordId?: string): void {
  const next = peekNonBlank(cursor);
  if (next === null) {
    warnMissingEnd(cursor, where, recordId, null);
    return;
  }
  const trimmed = next.text.trim();
  if (trimmed === "end") {
    cursor.position += 1;
    return;
  }
  if (isRecordBoundary(trimmed)) {
    warnMissingEnd(cursor, where, recordId, next);
    return;
  }
  const code = looksLikeField(trimmed) ? "PLAN_UNKNOWN_FIELD" : "PLAN_MISSING_END";
  fail(
    cursor,
    code,
    `${where} must be closed with "end" on its own line; got ${quote(trimmed)} on line ${next.number}`,
    {
      line: next.number,
      expected: ["end"],
      found: trimmed,
      recordId,
      hint: `add "end" on its own line; do not start a field here`,
    },
  );
}

function claimId(
  cursor: Cursor,
  ids: Map<NodeId, Line>,
  id: NodeId,
  header: Line,
  kind: string,
): void {
  const first = ids.get(id);
  if (first === undefined) {
    ids.set(id, header);
    return;
  }
  report(
    cursor,
    "PLAN_DUPLICATE_ID",
    `${kind} #${id} reuses node id ${quote(id)} on line ${header.number}; it was first declared on line ${first.number}. Work-node ids must be globally unique`,
    {
      line: header.number,
      found: id,
      recordId: id,
      hint: "give every node a new NN-slug id",
    },
  );
}

function parseAfterLine(cursor: Cursor, line: Line, nodeId: NodeId): NodeId[] {
  const [keyword, ...rest] = tokensOf(line);
  if (keyword !== "after") {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `after line for node ${nodeId} must be "after <\"NN-slug\">…"`,
      {
        line: line.number,
        expected: ['after "NN-slug"'],
        found: line.text.trim(),
        recordId: nodeId,
      },
    );
  }
  return rest.map((token) => quotedId(cursor, token, `after ref of node ${nodeId}`, line, nodeId));
}

function parseVerifyLine(cursor: Cursor, line: Line, nodeId: NodeId): WorkVerify {
  const [keyword, token, ...extra] = tokensOf(line);
  if (keyword !== "verify" || token === undefined || extra.length > 0) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `verify line for node ${nodeId} must be "verify tsc|test"; got ${quote(line.text.trim())}`,
      {
        line: line.number,
        expected: ["verify tsc|test"],
        found: line.text.trim(),
        recordId: nodeId,
      },
    );
  }
  if (!VERIFY_SET.has(token)) {
    fail(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      `node ${nodeId} verify must be "tsc" or "test" (got ${quote(token)})`,
      {
        line: line.number,
        column: tokenColumn(line, token),
        expected: ["tsc", "test"],
        found: token,
        recordId: nodeId,
      },
    );
  }
  return token as WorkVerify;
}

/**
 * Parse one `hint` line: `hint file <path>`, or
 * `hint <value|type|namespace> <symbol> in <path>`. A file hint uses symbol "".
 */
function parseHintLine(cursor: Cursor, line: Line, nodeId: NodeId): HintLoc {
  const tokens = tokensOf(line);
  const [keyword, first, second, third, fourth, ...extra] = tokens;
  if (keyword !== "hint" || first === undefined) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `hint line for node ${nodeId} must be "hint file <path>" or "hint <space> <symbol> in <path>"`,
      {
        line: line.number,
        expected: ["hint file <path>", "hint <space> <symbol> in <path>"],
        found: line.text.trim(),
        recordId: nodeId,
      },
    );
  }
  if (first === "file") {
    if (second === undefined || third !== undefined || extra.length > 0) {
      fail(
        cursor,
        "PLAN_MISSING_FIELD",
        `file hint for node ${nodeId} must be "hint file <path>" with no symbol; got ${quote(line.text.trim())}`,
        {
          line: line.number,
          expected: ["hint file <path>"],
          found: line.text.trim(),
          recordId: nodeId,
        },
      );
    }
    return { path: second, symbol: "", kind: "file" };
  }
  if (second === undefined || third !== "in" || fourth === undefined || extra.length > 0) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `symbol hint for node ${nodeId} must be "hint <space> <symbol> in <path>"; got ${quote(line.text.trim())}`,
      {
        line: line.number,
        expected: ["hint <space> <symbol> in <path>"],
        found: line.text.trim(),
        recordId: nodeId,
      },
    );
  }
  if (!SPACE_SET.has(first)) {
    fail(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      `hint space for node ${nodeId} must be one of value, type, namespace (got ${quote(first)})`,
      {
        line: line.number,
        column: tokenColumn(line, first),
        expected: [...HINT_SPACES],
        found: first,
        recordId: nodeId,
      },
    );
  }
  return { path: fourth, symbol: second, kind: first as SymbolSpace };
}

interface NodeBodyOptions {
  /** `hint clear`, `approach clear`, and `phase clear` are amend-only. */
  allowClear: boolean;
  requireInstruction: boolean;
  /** True when the header already carried `after` or `verify`. */
  afterSeen: boolean;
  verifySeen: boolean;
}

interface NodeBody {
  after?: NodeId[];
  verify?: WorkVerify;
  instruction?: string;
  hints?: HintLoc[];
  approach?: string | null;
  phase?: string | null;
}

/**
 * Read the fields of a node or amend record before `end`. Fields may come in
 * any order; `instruction:` is required for `node`, optional for `amend`. A
 * replacement `after` line with no ids clears dependencies. `hint clear`,
 * `approach clear`, and `phase clear` are allowed only in an amend record.
 */
function parseNodeBody(cursor: Cursor, id: NodeId, options: NodeBodyOptions): NodeBody {
  const body: NodeBody = {};
  let afterSeen = options.afterSeen;
  let verifySeen = options.verifySeen;
  let instructionSeen = false;
  let hintsSeen = false;
  let approachSeen = false;
  let phaseSeen = false;

  for (;;) {
    const next = peekNonBlank(cursor);
    if (next === null) {
      break;
    }
    const trimmed = next.text.trim();

    if (trimmed === "after" || trimmed.startsWith("after ")) {
      if (afterSeen) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `node ${id} carries after more than once`, {
          line: next.number,
          recordId: id,
          hint: "keep one after line or one after clause on the node header",
        });
      }
      afterSeen = true;
      cursor.position += 1;
      body.after = parseAfterLine(cursor, next, id);
      continue;
    }

    if (trimmed === "verify" || trimmed.startsWith("verify ")) {
      if (verifySeen) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `node ${id} carries verify more than once`, {
          line: next.number,
          recordId: id,
          hint: "keep exactly one verify value",
        });
      }
      verifySeen = true;
      cursor.position += 1;
      body.verify = parseVerifyLine(cursor, next, id);
      continue;
    }

    if (trimmed.startsWith("instruction:")) {
      if (instructionSeen) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `node ${id} carries instruction more than once`, {
          line: next.number,
          recordId: id,
          hint: "keep exactly one instruction field",
        });
      }
      instructionSeen = true;
      body.instruction = readText(cursor, "instruction:", `node ${id}`, id);
      continue;
    }

    if (trimmed === "hint clear") {
      if (!options.allowClear) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `hint clear is allowed only in an amend record`, {
          line: next.number,
          recordId: id,
          hint: "drop the hint lines, or use amend to replace the hint list",
        });
      }
      if (hintsSeen) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `node ${id} mixes hint clear with other hint lines`, {
          line: next.number,
          recordId: id,
          hint: "use hint clear on its own, or list replacement hints",
        });
      }
      hintsSeen = true;
      cursor.position += 1;
      body.hints = [];
      continue;
    }

    if (trimmed === "hint" || trimmed.startsWith("hint ")) {
      if (hintsSeen && body.hints !== undefined && body.hints.length === 0) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `node ${id} mixes hint clear with other hint lines`, {
          line: next.number,
          recordId: id,
          hint: "use hint clear on its own, or list replacement hints",
        });
      }
      hintsSeen = true;
      cursor.position += 1;
      const hint = parseHintLine(cursor, next, id);
      if (body.hints === undefined) {
        body.hints = [];
      }
      body.hints.push(hint);
      continue;
    }

    if (trimmed === "approach clear") {
      if (!options.allowClear) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `approach clear is allowed only in an amend record`, {
          line: next.number,
          recordId: id,
          hint: "omit the approach field or use amend to clear it",
        });
      }
      if (approachSeen) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `node ${id} carries approach more than once`, {
          line: next.number,
          recordId: id,
          hint: "keep exactly one approach field",
        });
      }
      approachSeen = true;
      cursor.position += 1;
      body.approach = null;
      continue;
    }

    if (trimmed.startsWith("approach:")) {
      if (approachSeen) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `node ${id} carries approach more than once`, {
          line: next.number,
          recordId: id,
          hint: "keep exactly one approach field",
        });
      }
      approachSeen = true;
      body.approach = readText(cursor, "approach:", `node ${id}`, id);
      continue;
    }

    if (trimmed === "phase clear") {
      if (!options.allowClear) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `phase clear is allowed only in an amend record`, {
          line: next.number,
          recordId: id,
          hint: "omit the phase field or use amend to clear it",
        });
      }
      if (phaseSeen) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `node ${id} carries phase more than once`, {
          line: next.number,
          recordId: id,
          hint: "keep exactly one phase field",
        });
      }
      phaseSeen = true;
      cursor.position += 1;
      body.phase = null;
      continue;
    }

    if (trimmed.startsWith("phase:")) {
      if (phaseSeen) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `node ${id} carries phase more than once`, {
          line: next.number,
          recordId: id,
          hint: "keep exactly one phase field",
        });
      }
      phaseSeen = true;
      body.phase = readText(cursor, "phase:", `node ${id}`, id);
      continue;
    }

    break;
  }

  if (options.requireInstruction && body.instruction === undefined) {
    const next = peekNonBlank(cursor);
    fail(cursor, "PLAN_MISSING_FIELD", `node ${id} needs instruction: before end`, {
      line: next?.number ?? Math.max(1, cursor.lines.length),
      expected: ["instruction:"],
      found: next?.text.trim() ?? "<eof>",
      recordId: id,
      hint: "add instruction: before end",
    });
  }
  return body;
}

interface NodeHeader {
  id: NodeId;
  after?: NodeId[];
  verify: WorkVerify;
}

/** Parse `node "id" [after "…"] verify tsc|test`. */
function parseNodeHeader(cursor: Cursor, header: Line): NodeHeader {
  const tokens = tokensOf(header);
  const [actual, idToken] = tokens;
  if (actual !== "node" || idToken === undefined) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `node record on line ${header.number} must be "node \\"NN-slug\\" [after \\"NN-slug\\"…] verify tsc|test"; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ['node "NN-slug" [after "NN-slug"…] verify tsc|test'],
        found: header.text.trim(),
        hint: `write node "02-scaffold" verify tsc`,
      },
    );
  }
  const id = quotedId(cursor, idToken, `node id on line ${header.number}`, header, idToken);
  let index = 2;
  let after: NodeId[] | undefined;
  if (tokens[index] === "after") {
    index += 1;
    const ids: NodeId[] = [];
    while (index < tokens.length && tokens[index] !== "verify") {
      const token = tokens[index];
      if (token === undefined) {
        break;
      }
      ids.push(quotedId(cursor, token, `after ref of node ${id}`, header, id));
      index += 1;
    }
    if (ids.length === 0) {
      fail(cursor, "PLAN_MISSING_FIELD", `after clause on node ${id} needs at least one node id`, {
        line: header.number,
        expected: ['after "NN-slug"'],
        found: "after",
        recordId: id,
        hint: "list one or more dependency ids, or omit after",
      });
    }
    after = ids;
  }
  if (tokens[index] !== "verify") {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `node ${id} needs "verify tsc|test" on its header line; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ["verify tsc|test"],
        found: tokens[index] ?? "<eof>",
        recordId: id,
        hint: `write node "${id}" verify test`,
      },
    );
  }
  index += 1;
  const verifyToken = tokens[index];
  index += 1;
  if (verifyToken === undefined) {
    fail(cursor, "PLAN_MISSING_FIELD", `node ${id} needs a verify value after "verify"`, {
      line: header.number,
      expected: ["tsc", "test"],
      found: "<eof>",
      recordId: id,
    });
  }
  if (!VERIFY_SET.has(verifyToken)) {
    fail(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      `node ${id} verify must be "tsc" or "test" (got ${quote(verifyToken)})`,
      {
        line: header.number,
        column: tokenColumn(header, verifyToken),
        expected: ["tsc", "test"],
        found: verifyToken,
        recordId: id,
      },
    );
  }
  if (index !== tokens.length) {
    fail(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      `unexpected token ${quote(tokens[index] ?? "")} on node ${id}'s header`,
      {
        line: header.number,
        found: tokens[index] ?? "",
        recordId: id,
        hint: "put after and verify on the header, then instruction and the optional fields inside the record",
      },
    );
  }
  return { id, after, verify: verifyToken as WorkVerify };
}

function optionalText(value: string | null | undefined): { approach?: string } {
  return typeof value === "string" ? { approach: value } : {};
}

function parseNode(cursor: Cursor, header: Line, ids: Map<NodeId, Line>): WorkNode {
  const parsed = parseNodeHeader(cursor, header);
  claimId(cursor, ids, parsed.id, header, "node");
  const body = parseNodeBody(cursor, parsed.id, {
    allowClear: false,
    requireInstruction: true,
    afterSeen: parsed.after !== undefined,
    verifySeen: true,
  });
  expectEnd(cursor, `node ${parsed.id}`, parsed.id);
  const instruction = body.instruction;
  if (instruction === undefined) {
    throw new Error(`node ${parsed.id} passed validation without an instruction`);
  }
  return {
    id: parsed.id,
    after: parsed.after ?? body.after ?? [],
    verify: parsed.verify,
    instruction,
    hints: body.hints ?? [],
    ...optionalText(body.approach),
    ...(body.phase === undefined || body.phase === null ? {} : { phase: body.phase }),
  };
}

/** Parse the `amend "id"` header; fields follow in the body. */
function parseAmendHeader(cursor: Cursor, header: Line): NodeId {
  const [keyword, idToken, ...extra] = tokensOf(header);
  if (keyword !== "amend" || idToken === undefined || extra.length > 0) {
    fail(
      cursor,
      extra.length > 0 ? "PLAN_UNKNOWN_FIELD" : "PLAN_MISSING_FIELD",
      `amend record on line ${header.number} must be "amend \\"NN-slug\\""; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ['amend "NN-slug"'],
        found: extra[0] ?? header.text.trim(),
        hint: `write amend "03-impl" and put the replacement fields inside the record`,
      },
    );
  }
  return quotedId(cursor, idToken, `amend id on line ${header.number}`, header);
}

/** Parse one `amend` record: only the fields present are replaced. */
function parseAmend(cursor: Cursor, header: Line): NodeAmend {
  const id = parseAmendHeader(cursor, header);
  const body = parseNodeBody(cursor, id, {
    allowClear: true,
    requireInstruction: false,
    afterSeen: false,
    verifySeen: false,
  });
  expectEnd(cursor, `amend ${id}`, id);
  const amend: NodeAmend = {
    id,
    ...(body.after === undefined ? {} : { after: body.after }),
    ...(body.verify === undefined ? {} : { verify: body.verify }),
    ...(body.instruction === undefined ? {} : { instruction: body.instruction }),
    ...(body.hints === undefined ? {} : { hints: body.hints }),
    ...(body.approach === undefined ? {} : { approach: body.approach }),
    ...(body.phase === undefined ? {} : { phase: body.phase }),
  };
  if (Object.keys(amend).length === 1) {
    const next = peekNonBlank(cursor);
    fail(cursor, "PLAN_MISSING_FIELD", `amend #${id} needs at least one replacement field`, {
      line: next?.number ?? header.number,
      expected: ["instruction:", "verify", "after", "hint", "approach:", "phase:"],
      found: next?.text.trim() ?? "<eof>",
      recordId: id,
      hint: "change instruction, verify, dependencies, hints, approach, or phase",
    });
  }
  return amend;
}

function recoverLegacyRecord(cursor: Cursor): void {
  for (;;) {
    const line = peekNonBlank(cursor);
    if (line === null) {
      return;
    }
    const trimmed = line.text.trim();
    if (isRecordBoundary(trimmed)) {
      return;
    }
    cursor.position += 1;
  }
}

function legacyRecord(cursor: Cursor, line: Line, keyword: string): void {
  report(
    cursor,
    "PLAN_LEGACY_RECORD",
    `legacy record ${quote(keyword)} on line ${line.number} is not supported; the plan DSL uses flat "node" records and "amend" records`,
    {
      line: line.number,
      expected: ["node", "amend"],
      found: keyword,
      hint: "append work with node, or revise a pending/failed node with amend",
    },
  );
  recoverLegacyRecord(cursor);
}

function finishRecord(cursor: Cursor, line: Line): void {
  report(
    cursor,
    "PLAN_LEGACY_RECORD",
    `finish on line ${line.number} is not part of the plan protocol; the run completes when no node is ready and the last gate is a passing test`,
    {
      line: line.number,
      expected: ["node", "amend"],
      found: "finish",
      hint: "remove finish; a final test node is enough",
    },
  );
  recoverLegacyRecord(cursor);
}

function recoverRecord(cursor: Cursor): void {
  for (;;) {
    const line = peekNonBlank(cursor);
    if (line === null) {
      return;
    }
    if (isRecordBoundary(line.text.trim())) {
      return;
    }
    cursor.position += 1;
  }
}

function parseRecords(
  cursor: Cursor,
  ids: Map<NodeId, Line>,
): { nodes: WorkNode[]; amends: NodeAmend[] } {
  const nodes: WorkNode[] = [];
  const amends: NodeAmend[] = [];

  for (;;) {
    const line = peekNonBlank(cursor);
    if (line === null) {
      break;
    }
    cursor.position += 1;
    const trimmed = line.text.trim();

    if (trimmed === "finish") {
      finishRecord(cursor, line);
      continue;
    }
    if (trimmed === "end") {
      report(
        cursor,
        "PLAN_UNKNOWN_FIELD",
        `unexpected "end" on line ${line.number}; no node record is open`,
        {
          line: line.number,
          expected: ["node", "amend"],
          found: "end",
          hint: "remove the stray end",
        },
      );
      continue;
    }
    if (trimmed.startsWith("{")) {
      report(
        cursor,
        "PLAN_MISSING_FIELD",
        "JSON plan objects are not accepted; reply with the flat plan DSL using node and amend records",
        {
          line: line.number,
          expected: ["node", "amend"],
          found: "{",
          hint: "send the flat plan DSL, not JSON",
        },
      );
      recoverRecord(cursor);
      continue;
    }

    const keyword = trimmed.split(/\s+/)[0] ?? "";
    if (keyword === "plan") {
      report(
        cursor,
        "PLAN_UNKNOWN_FIELD",
        `the plan header is a singleton and must be the first line; found one on line ${line.number}`,
        {
          line: line.number,
          expected: ["node", "amend"],
          found: keyword,
          hint: "keep exactly one plan header at the top",
        },
      );
      recoverRecord(cursor);
      continue;
    }
    if (keyword === "node") {
      try {
        const node = parseNode(cursor, line, ids);
        if (!nodes.some((candidate) => candidate.id === node.id)) {
          nodes.push(node);
        }
      } catch (error) {
        if (!(error instanceof PlanSyntaxError)) {
          throw error;
        }
        cursor.issues.push(error.issue);
        recoverRecord(cursor);
      }
      continue;
    }
    if (keyword === "amend") {
      try {
        amends.push(parseAmend(cursor, line));
      } catch (error) {
        if (!(error instanceof PlanSyntaxError)) {
          throw error;
        }
        cursor.issues.push(error.issue);
        recoverRecord(cursor);
      }
      continue;
    }
    if (isLegacyKeyword(keyword)) {
      legacyRecord(cursor, line, keyword);
      continue;
    }
    report(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      `unknown record header ${quote(keyword)} on line ${line.number}; expected "node" or "amend"`,
      {
        line: line.number,
        expected: ["node", "amend"],
        found: keyword,
        hint: "use node to append work or amend to revise a pending/failed node",
      },
    );
    recoverRecord(cursor);
  }
  return { nodes, amends };
}

/**
 * Strip one markdown fence that wraps the complete reply. The fence lines are
 * blanked rather than removed so every diagnostic keeps the raw reply's line
 * numbers. A fence that does not wrap the whole reply is left untouched.
 */
function stripWholeReplyFence(content: string): { text: string; stripped: boolean; line: number } {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let first = 0;
  while (first < lines.length && (lines[first] ?? "").trim() === "") {
    first += 1;
  }
  let last = lines.length - 1;
  while (last >= 0 && (lines[last] ?? "").trim() === "") {
    last -= 1;
  }
  if (first >= last) {
    return { text: lines.join("\n"), stripped: false, line: first + 1 };
  }
  const open = /^(`{3,})(?:\s*[A-Za-z0-9_-]+)?\s*$/.exec((lines[first] ?? "").trim());
  const close = /^(`{3,})\s*$/.exec((lines[last] ?? "").trim());
  if (open === null || close === null) {
    return { text: lines.join("\n"), stripped: false, line: first + 1 };
  }
  const openRun = open[1] ?? "";
  const closeRun = close[1] ?? "";
  if (closeRun.length < openRun.length) {
    return { text: lines.join("\n"), stripped: false, line: first + 1 };
  }
  const innerFirst = lines.slice(first + 1, last).find((line) => line.trim() !== "");
  if (innerFirst === undefined) {
    return { text: lines.join("\n"), stripped: false, line: first + 1 };
  }
  const inner = innerFirst.trim();
  if (!/^(plan|patch|node|amend|finish|select|create|delete|read|write)\b/.test(inner)) {
    return { text: lines.join("\n"), stripped: false, line: first + 1 };
  }
  lines[first] = "";
  lines[last] = "";
  return { text: lines.join("\n"), stripped: true, line: first + 1 };
}

/**
 * Parse the optional `plan` header and its `goal:` label. A legacy quoted plan
 * id after `plan` is accepted and ignored: the run has no plan-root id. The
 * goal is required only on the initial reply, which the apply layer enforces.
 */
function parsePlanHeader(cursor: Cursor): { goal: string | null; line: Line | null } {
  const line = peekNonBlank(cursor);
  if (line === null) {
    return { goal: null, line: null };
  }
  const trimmed = line.text.trim();
  if (trimmed.startsWith("{")) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      "JSON plan objects are not accepted; reply with the flat plan DSL using node records",
      {
        line: line.number,
        expected: ["plan", "node"],
        found: "{",
        hint: "send the flat plan DSL, not JSON",
      },
    );
  }
  const tokens = tokensOf(line);
  if (tokens[0] !== "plan") {
    return { goal: null, line: null };
  }
  cursor.position += 1;
  if (tokens.length > 2) {
    fail(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      `unexpected token ${quote(tokens[2] ?? "")} on the plan header line ${line.number}`,
      {
        line: line.number,
        expected: ["plan", 'plan "NN-slug"'],
        found: tokens[2] ?? "",
        hint: "put the goal on its own goal: line",
      },
    );
  }
  if (tokens[1] !== undefined) {
    // Legacy plan-root id: tolerated and ignored so older replies still parse.
    quotedId(cursor, tokens[1], "plan.id", line, "plan");
  }
  const goalLine = peekNonBlank(cursor);
  if (goalLine !== null && goalLine.text.trim().startsWith("goal:")) {
    const goal = readText(cursor, "goal:", "plan", "plan");
    return { goal, line };
  }
  return { goal: null, line };
}

function codeForProblem(message: string): string {
  if (message.includes("reuses node id")) {
    return "PLAN_DUPLICATE_ID";
  }
  if (message.includes("cycle")) {
    return "PLAN_CYCLE";
  }
  if (message.includes("not in the plan")) {
    return "PLAN_UNKNOWN_PARENT";
  }
  if (message.includes("verify must be")) {
    return "PLAN_UNKNOWN_FIELD";
  }
  return "PLAN_STRUCTURE";
}

function reportGraphProblems(
  cursor: Cursor,
  problems: string | null,
  idLines: Map<NodeId, Line>,
): void {
  if (problems === null) {
    return;
  }
  for (const problemLine of problems.split("\n").filter((line) => line.startsWith("- "))) {
    const message = problemLine.slice(2);
    const idMatch = /#([0-9]{2,}-[a-z0-9]+(?:-[a-z0-9]+)*)/.exec(message);
    const recordId = idMatch?.[1];
    const line = recordId === undefined ? 1 : (idLines.get(recordId)?.number ?? 1);
    const code = codeForProblem(message);
    cursor.issues.push(
      issueAt(cursor, code, message, {
        line,
        stage: "plan-graph",
        ...(recordId === undefined ? {} : { recordId }),
        ...(code === "PLAN_CYCLE"
          ? { hint: "break the cycle by removing one after edge and re-planning" }
          : {}),
      }),
    );
  }
}

export interface ParseOptions {
  /**
   * Validate this reply as a complete initial graph. Incremental replies are
   * validated after they merge into the run state, because their `after` edges
   * may name existing nodes that are not in the reply.
   */
  initial?: boolean;
}

function parsePlanDslDetailedUnchecked(
  content: string,
  options: ParseOptions,
): DslParseResult<PlanReply> {
  const stripped = stripWholeReplyFence(content);
  const cursor = cursorOf(stripped.text);
  if (stripped.stripped) {
    warn(
      cursor,
      "PLAN_WHOLE_REPLY_FENCE",
      "the reply is wrapped in a markdown fence; stripped the fence and parsed the bare plan DSL",
      {
        line: stripped.line,
        expected: ["bare plan DSL"],
        found: "```",
        hint: "send the bare plan DSL without a surrounding fence",
      },
    );
  }
  if (stripped.text.trim() === "") {
    report(cursor, "PLAN_MISSING_FIELD", "the reply is empty; expected node or amend records", {
      line: 1,
      expected: ["node", "amend"],
      found: "<eof>",
      hint: "start the reply with node or amend",
    });
    return { ok: false, issues: cursor.issues, truncated: false };
  }
  if (stripped.text.trimStart().startsWith("```")) {
    report(
      cursor,
      "PLAN_UNCLOSED_FENCE",
      "the reply starts with a markdown fence that does not wrap the whole reply; send the bare plan DSL without a surrounding fence",
      {
        line: 1,
        expected: ["bare plan DSL"],
        found: "```",
        hint: "remove the markdown fence",
      },
    );
    return { ok: false, issues: cursor.issues, truncated: false };
  }

  const idLines = new Map<NodeId, Line>();
  let header: { goal: string | null; line: Line | null };
  let records: { nodes: WorkNode[]; amends: NodeAmend[] };
  try {
    header = parsePlanHeader(cursor);
    records = parseRecords(cursor, idLines);
  } catch (error) {
    if (!(error instanceof PlanSyntaxError)) {
      throw error;
    }
    cursor.issues.push(error.issue);
    return { ok: false, issues: cursor.issues, truncated: cursor.truncated };
  }

  const initial = options.initial ?? true;
  const goal = header.goal;
  if (records.nodes.length === 0 && records.amends.length === 0) {
    report(cursor, "PLAN_MISSING_FIELD", "the reply contains no node or amend record", {
      line: header.line?.number ?? 1,
      expected: ["node", "amend"],
      found: "<eof>",
      hint: "append at least one node or amend a pending/failed node",
    });
  }
  if (initial && goal === null) {
    report(cursor, "PLAN_MISSING_FIELD", "the initial plan needs a non-empty goal: field", {
      line: header.line?.number ?? 1,
      expected: ["goal:"],
      found: "<missing>",
      hint: "add goal: <one-line goal> under the plan header",
    });
  }
  if (initial && records.amends.length > 0) {
    report(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      "the initial plan may not amend nodes; amend is for later turns",
      {
        line: header.line?.number ?? 1,
        expected: ["node"],
        found: "amend",
        hint: "declare every initial node with a node record",
      },
    );
  }

  if (initial) {
    const problems =
      goal === null ? validateNodes(records.nodes) : validatePlan(goal, records.nodes);
    reportGraphProblems(cursor, problems, idLines);
  }

  const reply: PlanReply = {
    ...(goal === null ? {} : { goal }),
    nodes: records.nodes,
    amends: records.amends,
  };
  const hasErrors = cursor.issues.some((issue) => issue.severity === "error");
  return {
    ok: !hasErrors,
    value: reply,
    issues: cursor.issues,
    truncated: cursor.truncated,
  };
}

/** The detailed plan parse; `value` is best-effort when `ok` is false. */
export function parsePlanDslDetailed(
  content: string,
  options: ParseOptions = {},
): DslParseResult<PlanReply> {
  return parsePlanDslDetailedUnchecked(content, options);
}

/** Parse one tolerant plan reply, rejecting on any error but returning warnings. */
export function parsePlanDsl(content: string, options: ParseOptions = {}): PlanParse {
  const result = parsePlanDslDetailed(content, options);
  const errors = result.issues.filter((issue) => issue.severity === "error");
  if (!result.ok || errors.length > 0) {
    return {
      ok: false,
      stage: errors.some((issue) => isPlanGraphStage(issue.stage)) ? "plan-graph" : "plan-protocol",
      diagnostics: renderDslIssues([...result.issues]),
    };
  }
  const value = result.value;
  if (value === undefined) {
    return {
      ok: false,
      stage: "plan-protocol",
      diagnostics:
        "stage: plan-protocol\ncode: PLAN_MISSING_FIELD\nmessage: the reply produced no plan",
    };
  }
  return { ok: true, reply: value };
}

/** The initial-plan parser name used by the driver; the DSL is the only form. */
export const parsePlan = parsePlanDsl;
/** The plan parser, kept for tests; the driver reuses the same entry point. */
export const readPlan = parsePlanDsl;

// ---------------------------------------------------------------------------
// Serialization

function pushText(lines: string[], label: TextFieldLabel, text: string): void {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized !== "" && !normalized.includes("\n") && normalized === normalized.trim()) {
    lines.push(`${label} ${normalized}`);
    return;
  }
  if (containsEditFenceEnd(normalized)) {
    throw new Error(
      `cannot serialize Plan text containing the literal line ${EDIT_FENCE_END}; the sentinel is the only close and has no escape form`,
    );
  }
  lines.push(label, EDIT_FENCE_BEGIN, ...normalized.split("\n"), EDIT_FENCE_END);
}

function hintWire(hint: HintLoc): string {
  return hint.kind === "file"
    ? `hint file ${hint.path}`
    : `hint ${hint.kind} ${hint.symbol} in ${hint.path}`;
}

function pushHints(lines: string[], hints: readonly HintLoc[]): void {
  for (const hint of hints) {
    lines.push(hintWire(hint));
  }
}

function nodeHeaderWire(id: NodeId, after: readonly NodeId[], verify: WorkVerify): string {
  const edges = after.length === 0 ? "" : ` after ${after.map(quote).join(" ")}`;
  return `node ${quote(id)}${edges} verify ${verify}`;
}

/** The wire form of a reply; `goal` is present on the initial reply. */
export interface PlanWire {
  goal?: string;
  nodes: readonly WorkNode[];
  amends?: readonly NodeAmend[];
}

function pushAmend(lines: string[], amend: NodeAmend): void {
  lines.push(`amend ${quote(amend.id)}`);
  if (amend.after !== undefined) {
    lines.push(amend.after.length === 0 ? "after" : `after ${amend.after.map(quote).join(" ")}`);
  }
  if (amend.verify !== undefined) {
    lines.push(`verify ${amend.verify}`);
  }
  if (amend.instruction !== undefined) {
    pushText(lines, "instruction:", amend.instruction);
  }
  if (amend.hints !== undefined) {
    if (amend.hints.length === 0) {
      lines.push("hint clear");
    } else {
      pushHints(lines, amend.hints);
    }
  }
  if (amend.approach !== undefined) {
    if (amend.approach === null) {
      lines.push("approach clear");
    } else {
      pushText(lines, "approach:", amend.approach);
    }
  }
  if (amend.phase !== undefined) {
    if (amend.phase === null) {
      lines.push("phase clear");
    } else {
      pushText(lines, "phase:", amend.phase);
    }
  }
  lines.push("end");
}

/**
 * Serialize a reply into the flat DSL. Text is emitted on the label line when
 * that round-trips exactly, otherwise in the sentinel fence. There is no
 * `finish`: completion is derived from the scheduler and the last gate.
 */
export function serializePlanDsl(plan: PlanWire): string {
  const lines: string[] = ["plan"];
  if (plan.goal !== undefined) {
    pushText(lines, "goal:", plan.goal);
  }
  for (const node of plan.nodes) {
    lines.push("", nodeHeaderWire(node.id, node.after, node.verify));
    pushText(lines, "instruction:", node.instruction);
    pushHints(lines, node.hints);
    if (node.approach !== undefined) {
      pushText(lines, "approach:", node.approach);
    }
    if (node.phase !== undefined) {
      pushText(lines, "phase:", node.phase);
    }
    lines.push("end");
  }
  for (const amend of plan.amends ?? []) {
    lines.push("");
    pushAmend(lines, amend);
  }
  return lines.join("\n");
}
