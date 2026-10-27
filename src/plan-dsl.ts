/**
 * The flat Plan DSL (`docs/plan-exec.md` §3) and patch DSL (§4): strict parsers
 * and serializers for the planner's initial reply and incremental re-plans.
 * Records are independent: a `plan` header, then flat `node` records in record
 * order, then an optional trailing `finish`. A patch applies `node+` / `node~` /
 * `node-` operators and `finish` to a clone of the current graph. The graph
 * validator lives in `src/tasks.ts`; this module only turns the wire form into
 * that graph and runs the merge.
 *
 * Both parsers are tolerant in the same ways as before: a whole-reply fence, a
 * bare id, and an unambiguous missing `end` recover with warnings; structure is
 * still rejected all-or-nothing, with shared bounded diagnostics (see
 * `src/dsl-diagnostics.ts`). There is no JSON fallback and no legacy
 * Stage/Task/Edit mode.
 */
import {
  finalNode,
  HINT_SPACES,
  mergeReplan,
  NODE_ID_PATTERN,
  validateFinalNode,
  validatePlan,
  WORK_VERIFIES,
} from "./tasks";
import { renderDslIssues } from "./dsl-diagnostics";
import type { DslIssue, DslParseResult, DslStage } from "./dsl-diagnostics";
import {
  containsEditFenceEnd,
  EDIT_FENCE_BEGIN,
  EDIT_FENCE_END,
  isLegacyEditFence,
} from "./selection";
import type {
  HintLoc,
  NodeId,
  Plan,
  PlanMerge,
  PlanParse,
  PlanRunState,
  WorkNode,
  WorkVerify,
} from "./tasks";
import type { SymbolSpace } from "./utility";

/**
 * Plan diagnostics use the shared `stage:` channel with WorkNode vocabulary
 * (`plan-protocol` and `plan-graph`).
 */
type DiagnosticStage = DslStage;

const VERIFY_SET: ReadonlySet<string> = new Set(WORK_VERIFIES);
const SPACE_SET: ReadonlySet<string> = new Set(HINT_SPACES);

/**
 * Record headers from the old Stage/Task/Edit hierarchy. They are rejected with
 * a dedicated diagnostic instead of being guessed as unknown fields.
 */
const LEGACY_KEYWORDS: ReadonlySet<string> = new Set([
  "stage",
  "task",
  "edit",
  "plan~",
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

type ParseMode = "plan" | "patch";

interface Cursor {
  lines: readonly Line[];
  position: number;
  mode: ParseMode;
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

/** A successfully parsed initial Plan; `finalNodeId` is null without `finish`. */
export interface ParsedPlan {
  plan: Plan;
  finalNodeId: NodeId | null;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function cursorOf(content: string, mode: ParseMode): Cursor {
  const lines = content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((text, index) => ({ text, number: index + 1 }));
  return {
    lines,
    position: 0,
    mode,
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

function takeNonBlank(
  cursor: Cursor,
  expected: string,
  code = "PLAN_MISSING_FIELD",
  recordId?: string,
): Line {
  const line = peekNonBlank(cursor);
  if (line === null) {
    cursor.truncated = true;
    fail(cursor, code, `expected ${expected}, but the reply ended`, {
      line: Math.max(1, cursor.lines.length),
      found: "<eof>",
      expected: [expected],
      recordId,
      hint: "send the complete reply; do not stop mid-record",
    });
  }
  cursor.position += 1;
  return line;
}

function tokensOf(line: Line): string[] {
  return line.text.trim().split(/\s+/);
}

function tokenColumn(line: Line, token: string): number {
  const index = line.text.indexOf(token);
  return index === -1 ? 1 : index + 1;
}

function nearestId(reference: string, ids: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    if (id === reference) {
      return id;
    }
    const width = Math.max(reference.length, id.length);
    let distance = 0;
    for (let index = 0; index < width; index += 1) {
      if ((reference[index] ?? "") !== (id[index] ?? "")) {
        distance += 1;
      }
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      best = id;
    }
  }
  return best;
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

function isPlanBoundary(trimmed: string): boolean {
  return trimmed === "finish" || /^(plan|node|stage|task|edit)\b/.test(trimmed);
}

function isPatchBoundary(trimmed: string): boolean {
  return (
    trimmed === "finish" ||
    /^(patch\b|node[+~-]|plan~|stage[+~-]|task[+~-]|edit[+~-])/.test(trimmed)
  );
}

function isRecordBoundary(cursor: Cursor, trimmed: string): boolean {
  return cursor.mode === "plan" ? isPlanBoundary(trimmed) : isPatchBoundary(trimmed);
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
      isRecordBoundary(cursor, trimmed) || trimmed === "end"
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
        if (after !== "end" && !isRecordBoundary(cursor, after) && !looksLikeField(after)) {
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
  if (isRecordBoundary(cursor, trimmed)) {
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
    `${kind} #${id} reuses node id ${quote(id)} on line ${header.number}; it was first declared on line ${first.number}. Plan and work-node ids must be globally unique`,
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
  /** `hint clear`, `approach clear`, and `phase clear` are patch-update only. */
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
 * Read the fields of a node record before `end`. Fields may come in any order;
 * `instruction:` is required for `node`/`node+`, optional for `node~`. A
 * replacement `after` line with no ids clears dependencies. `hint clear`,
 * `approach clear`, and `phase clear` are allowed only in a patch update.
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
        fail(cursor, "PLAN_UNKNOWN_FIELD", `hint clear is allowed only in a node~ patch`, {
          line: next.number,
          recordId: id,
          hint: "drop the hint lines, or use node~ to replace the hint list",
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
        fail(cursor, "PLAN_UNKNOWN_FIELD", `approach clear is allowed only in a node~ patch`, {
          line: next.number,
          recordId: id,
          hint: "omit the approach field or use node~ to clear it",
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
        fail(cursor, "PLAN_UNKNOWN_FIELD", `phase clear is allowed only in a node~ patch`, {
          line: next.number,
          recordId: id,
          hint: "omit the phase field or use node~ to clear it",
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

/** Parse `node "id" [after "…"] verify tsc|test`, also used for `node+`. */
function parseNodeHeader(cursor: Cursor, header: Line, keyword: "node" | "node+"): NodeHeader {
  const tokens = tokensOf(header);
  const [actual, idToken] = tokens;
  if (actual !== keyword || idToken === undefined) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `${keyword} record on line ${header.number} must be "${keyword} \\"NN-slug\\" [after \\"NN-slug\\"…] verify tsc|test"; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: [`${keyword} "NN-slug" [after "NN-slug"…] verify tsc|test`],
        found: header.text.trim(),
        hint: `write ${keyword} "02-scaffold" verify tsc`,
      },
    );
  }
  const id = quotedId(cursor, idToken, `${keyword} id on line ${header.number}`, header, idToken);
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
      fail(
        cursor,
        "PLAN_MISSING_FIELD",
        `after clause on ${keyword} ${id} needs at least one node id`,
        {
          line: header.number,
          expected: ['after "NN-slug"'],
          found: "after",
          recordId: id,
          hint: "list one or more dependency ids, or omit after",
        },
      );
    }
    after = ids;
  }
  if (tokens[index] !== "verify") {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `${keyword} ${id} needs "verify tsc|test" on its header line; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ["verify tsc|test"],
        found: tokens[index] ?? "<eof>",
        recordId: id,
        hint: `write ${keyword} "${id}" verify test`,
      },
    );
  }
  index += 1;
  const verifyToken = tokens[index];
  index += 1;
  if (verifyToken === undefined) {
    fail(cursor, "PLAN_MISSING_FIELD", `${keyword} ${id} needs a verify value after "verify"`, {
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
      `unexpected token ${quote(tokens[index] ?? "")} on ${keyword} ${id}'s header`,
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
  const parsed = parseNodeHeader(cursor, header, "node");
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

function finishPlan(
  cursor: Cursor,
  line: Line,
  nodes: readonly WorkNode[],
): { nodes: WorkNode[]; finalNodeId: NodeId | null } {
  const last = finalNode({ nodes });
  if (last === undefined) {
    report(cursor, "PLAN_FINISH_NOT_LAST", "finish must follow at least one work node", {
      line: line.number,
      expected: ["one node before finish"],
      found: "finish",
      hint: "plan at least one node and mark the final test node",
    });
    return { nodes: [...nodes], finalNodeId: null };
  }
  const trailing = peekNonBlank(cursor);
  if (trailing !== null) {
    report(
      cursor,
      "PLAN_FINISH_NOT_LAST",
      `finish must be the last line; found ${quote(trailing.text.trim())} after it`,
      {
        line: trailing.number,
        expected: ["end of reply after finish"],
        found: trailing.text.trim(),
        recordId: last.id,
        hint: "put finish on the last line",
      },
    );
    return { nodes: [...nodes], finalNodeId: null };
  }
  if (last.verify !== "test") {
    report(
      cursor,
      "PLAN_FINISH_NOT_LAST",
      `finish marks node ${quote(last.id)}, which verifies ${last.verify}; the last node must verify "test"`,
      {
        line: line.number,
        expected: ["test"],
        found: last.verify,
        recordId: last.id,
        hint: "append a final test node and mark it with finish",
      },
    );
    return { nodes: [...nodes], finalNodeId: null };
  }
  return { nodes: [...nodes], finalNodeId: last.id };
}

function recoverLegacyRecord(cursor: Cursor): void {
  for (;;) {
    const line = peekNonBlank(cursor);
    if (line === null) {
      return;
    }
    const trimmed = line.text.trim();
    if (trimmed === "finish" || /^(plan|node)\b/.test(trimmed)) {
      return;
    }
    cursor.position += 1;
  }
}

function legacyRecord(cursor: Cursor, line: Line, keyword: string): void {
  report(
    cursor,
    "PLAN_LEGACY_RECORD",
    `legacy Stage/Task/Edit record ${quote(keyword)} on line ${line.number} is not supported; the plan DSL uses flat "node" records with after/verify/instruction/hint/approach/phase fields`,
    {
      line: line.number,
      expected: ["node", "finish"],
      found: keyword,
      hint: "replace stage/task/edit records with one node record, or restart the plan with a node DAG",
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
    if (isRecordBoundary(cursor, line.text.trim())) {
      return;
    }
    cursor.position += 1;
  }
}

function parseRecords(
  cursor: Cursor,
  ids: Map<NodeId, Line>,
): { planNodes: WorkNode[]; finalNodeId: NodeId | null } {
  const nodes: WorkNode[] = [];

  for (;;) {
    const line = peekNonBlank(cursor);
    if (line === null) {
      break;
    }
    cursor.position += 1;
    const trimmed = line.text.trim();

    if (trimmed === "finish") {
      const finished = finishPlan(cursor, line, nodes);
      return { planNodes: finished.nodes, finalNodeId: finished.finalNodeId };
    }
    if (trimmed === "end") {
      report(
        cursor,
        "PLAN_UNKNOWN_FIELD",
        `unexpected "end" on line ${line.number}; no node record is open`,
        {
          line: line.number,
          expected: ["node", "finish"],
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
        'JSON plan objects are not accepted; reply with the flat Plan DSL starting with plan "01-main"',
        {
          line: line.number,
          expected: ['plan "NN-slug"'],
          found: "{",
          hint: "send the flat Plan DSL, not JSON",
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
          expected: ["node", "finish"],
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
    if (isLegacyKeyword(keyword)) {
      legacyRecord(cursor, line, keyword);
      continue;
    }
    report(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      `unknown record header ${quote(keyword)} on line ${line.number}; expected "node" or a trailing "finish"`,
      {
        line: line.number,
        expected: ["node", "finish"],
        found: keyword,
        hint: "use one of the Plan DSL record headers",
      },
    );
    recoverRecord(cursor);
  }
  return { planNodes: nodes, finalNodeId: null };
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
  if (!/^(plan|patch|select|create|delete|read|write)\b/.test(inner)) {
    return { text: lines.join("\n"), stripped: false, line: first + 1 };
  }
  lines[first] = "";
  lines[last] = "";
  return { text: lines.join("\n"), stripped: true, line: first + 1 };
}

function parsePlanHeader(cursor: Cursor): { id: NodeId; goal: string; line: Line } {
  const line = takeNonBlank(cursor, 'the plan header "plan \\"NN-slug\\""', "PLAN_MISSING_FIELD");
  if (line.text.trim().startsWith("{")) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      'JSON plan objects are not accepted; reply with the flat Plan DSL starting with plan "01-main"',
      {
        line: line.number,
        expected: ['plan "NN-slug"'],
        found: "{",
        hint: "send the flat Plan DSL, not JSON",
      },
    );
  }
  const [keyword, idToken, ...extra] = tokensOf(line);
  if (keyword !== "plan" && keyword !== undefined && isLegacyKeyword(keyword)) {
    fail(
      cursor,
      "PLAN_LEGACY_RECORD",
      `legacy Stage/Task/Edit record ${quote(keyword)} is not supported; start with plan "01-main" and flat node records`,
      {
        line: line.number,
        expected: ['plan "NN-slug"'],
        found: keyword,
        hint: "replace the old hierarchy with a node DAG",
      },
    );
  }
  if (keyword !== "plan" || idToken === undefined || extra.length > 0) {
    fail(
      cursor,
      extra.length > 0 ? "PLAN_UNKNOWN_FIELD" : "PLAN_MISSING_FIELD",
      `expected the plan header "plan \\"NN-slug\\"" on line ${line.number}; got ${quote(line.text.trim())}`,
      {
        line: line.number,
        expected: ['plan "NN-slug"'],
        found: extra[0] ?? line.text.trim(),
        hint: 'start the reply with plan "01-main"',
      },
    );
  }
  const id = quotedId(cursor, idToken, "plan.id", line, idToken);
  const goal = readText(cursor, "goal:", `plan ${id}`, id);
  return { id, goal, line };
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
  plan: Plan,
  finalNodeId: NodeId | null,
  idLines: Map<NodeId, Line>,
): void {
  const problems = validatePlan(plan);
  const lines: string[] = [];
  if (problems !== null) {
    lines.push(...problems.split("\n").filter((line) => line.startsWith("- ")));
  }
  if (finalNodeId !== null) {
    const finalProblem = validateFinalNode(plan, finalNodeId);
    if (finalProblem !== null) {
      lines.push(`- ${finalProblem}`);
    }
  }
  for (const problemLine of lines) {
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

function parsePlanDslDetailedUnchecked(content: string): DslParseResult<ParsedPlan> {
  const stripped = stripWholeReplyFence(content);
  const cursor = cursorOf(stripped.text, "plan");
  if (stripped.stripped) {
    warn(
      cursor,
      "PLAN_WHOLE_REPLY_FENCE",
      "the reply is wrapped in a markdown fence; stripped the fence and parsed the bare Plan DSL",
      {
        line: stripped.line,
        expected: ["bare Plan DSL"],
        found: "```",
        hint: "send the bare Plan DSL without a surrounding fence",
      },
    );
  }
  if (stripped.text.trim() === "") {
    report(
      cursor,
      "PLAN_MISSING_FIELD",
      'the reply is empty; expected the Plan DSL starting with plan "NN-slug"',
      {
        line: 1,
        expected: ['plan "NN-slug"'],
        found: "<eof>",
        hint: 'start the reply with plan "01-main"',
      },
    );
    return { ok: false, issues: cursor.issues, truncated: false };
  }
  if (stripped.text.trimStart().startsWith("```")) {
    report(
      cursor,
      "PLAN_UNCLOSED_FENCE",
      "the reply starts with a markdown fence that does not wrap the whole reply; send the bare Plan DSL without a surrounding fence",
      {
        line: 1,
        expected: ["bare Plan DSL"],
        found: "```",
        hint: "remove the markdown fence",
      },
    );
    return { ok: false, issues: cursor.issues, truncated: false };
  }
  let plan: Plan;
  let finalNodeId: NodeId | null = null;
  const idLines = new Map<NodeId, Line>();
  try {
    const header = parsePlanHeader(cursor);
    idLines.set(header.id, header.line);
    const records = parseRecords(cursor, idLines);
    plan = { id: header.id, goal: header.goal, nodes: records.planNodes };
    finalNodeId = records.finalNodeId;
  } catch (error) {
    if (!(error instanceof PlanSyntaxError)) {
      throw error;
    }
    cursor.issues.push(error.issue);
    return { ok: false, issues: cursor.issues, truncated: cursor.truncated };
  }

  reportGraphProblems(cursor, plan, finalNodeId, idLines);
  const hasErrors = cursor.issues.some((issue) => issue.severity === "error");
  return {
    ok: !hasErrors,
    value: { plan, finalNodeId },
    issues: cursor.issues,
    truncated: cursor.truncated,
  };
}

/** The detailed initial-Plan parse; `value` is best-effort when `ok` is false. */
export function parsePlanDslDetailed(content: string): DslParseResult<ParsedPlan> {
  return parsePlanDslDetailedUnchecked(content);
}

/** Parse one tolerant Plan DSL reply, rejecting on any error but returning warnings. */
export function parsePlanDsl(content: string): PlanParse {
  const result = parsePlanDslDetailed(content);
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
        "stage: plan-protocol\ncode: PLAN_MISSING_FIELD\nmessage: the reply produced no Plan",
    };
  }
  return { ok: true, plan: value.plan, finalNodeId: value.finalNodeId };
}

/** The initial-plan parser name used by the driver; the DSL is the only form. */
export const parsePlan = parsePlanDsl;
/** The full-graph Plan parser, kept for tests; the driver plans patches after the initial turn. */
export const readPlan = parsePlanDsl;

// ---------------------------------------------------------------------------
// Patch DSL (`docs/plan-exec.md` §4)

/** One strict patch operation; `+` appends, `~` replaces present fields, `-` removes. */
export type PlanPatchOp =
  | {
      kind: "node-add";
      id: NodeId;
      after: NodeId[];
      verify: WorkVerify;
      instruction: string;
      hints: HintLoc[];
      approach?: string;
      phase?: string;
    }
  | {
      kind: "node-update";
      id: NodeId;
      /** Present replaces the dependency list; an empty list clears it. */
      after?: NodeId[];
      verify?: WorkVerify;
      instruction?: string;
      /** Present replaces the whole hint list; an empty list clears it. */
      hints?: HintLoc[];
      /** Present replaces; `null` clears the optional field. */
      approach?: string | null;
      phase?: string | null;
    }
  | { kind: "node-remove"; id: NodeId };

/** One parsed patch reply; ops are applied in wire order. */
export interface PlanPatch {
  ops: PlanPatchOp[];
  /** True when the reply ended with `finish`. */
  finish: boolean;
}

/** A patch rejection; parse failures are `plan-protocol`, apply/merge failures are `plan-graph`. */
export type PatchParse =
  | { ok: true; patch: PlanPatch }
  | { ok: false; stage: "plan-protocol" | "plan-graph"; diagnostics: string };

interface UpdateHeader {
  id: NodeId;
  /** `node~` accepts an inline `verify tsc|test`; the strict body form still works. */
  verify?: WorkVerify;
}

function parseUpdateHeader(cursor: Cursor, header: Line, keyword: "node~" | "node-"): UpdateHeader {
  const [actual, idToken, ...rest] = tokensOf(header);
  let extra = rest;
  let verify: WorkVerify | undefined;
  if (keyword === "node~" && extra[0] === "verify") {
    const value = extra[1];
    if (value !== undefined && VERIFY_SET.has(value) && extra.length === 2) {
      verify = value as WorkVerify;
      extra = [];
    }
  }
  if (actual !== keyword || extra.length > 0 || idToken === undefined) {
    fail(
      cursor,
      extra.length > 0 ? "PLAN_UNKNOWN_FIELD" : "PLAN_MISSING_FIELD",
      `${keyword} record on line ${header.number} must be "${keyword} \\"NN-slug\\""; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: [`${keyword} "NN-slug"`],
        found: extra[0] ?? header.text.trim(),
        hint: `write ${keyword} ${idToken ?? `"03-impl"`}`,
      },
    );
  }
  return {
    id: quotedId(cursor, idToken, `${keyword} id on line ${header.number}`, header, idToken),
    ...(verify === undefined ? {} : { verify }),
  };
}

function parseNodeAdd(cursor: Cursor, header: Line, ids: Map<NodeId, Line>): PlanPatchOp {
  const parsed = parseNodeHeader(cursor, header, "node+");
  claimId(cursor, ids, parsed.id, header, "node+");
  const body = parseNodeBody(cursor, parsed.id, {
    allowClear: false,
    requireInstruction: true,
    afterSeen: parsed.after !== undefined,
    verifySeen: true,
  });
  expectEnd(cursor, `node ${parsed.id}`, parsed.id);
  const instruction = body.instruction;
  if (instruction === undefined) {
    throw new Error(`node+ ${parsed.id} passed validation without an instruction`);
  }
  return {
    kind: "node-add",
    id: parsed.id,
    after: parsed.after ?? body.after ?? [],
    verify: parsed.verify,
    instruction,
    hints: body.hints ?? [],
    ...optionalText(body.approach),
    ...(body.phase === undefined || body.phase === null ? {} : { phase: body.phase }),
  };
}

function parseNodeUpdate(cursor: Cursor, header: Line): PlanPatchOp {
  const parsed = parseUpdateHeader(cursor, header, "node~");
  const id = parsed.id;
  const body = parseNodeBody(cursor, id, {
    allowClear: true,
    requireInstruction: false,
    afterSeen: false,
    verifySeen: parsed.verify !== undefined,
  });
  expectEnd(cursor, `node ${id}`, id);
  const verify = parsed.verify ?? body.verify;
  return {
    kind: "node-update",
    id,
    ...(body.after === undefined ? {} : { after: body.after }),
    ...(verify === undefined ? {} : { verify }),
    ...(body.instruction === undefined ? {} : { instruction: body.instruction }),
    ...(body.hints === undefined ? {} : { hints: body.hints }),
    ...(body.approach === undefined ? {} : { approach: body.approach }),
    ...(body.phase === undefined ? {} : { phase: body.phase }),
  };
}

function parseNodeRemove(cursor: Cursor, header: Line): PlanPatchOp {
  const id = parseUpdateHeader(cursor, header, "node-").id;
  expectEnd(cursor, `node ${id}`, id);
  return { kind: "node-remove", id };
}

function parsePatchOps(cursor: Cursor): { ops: PlanPatchOp[]; finish: boolean } {
  const ops: PlanPatchOp[] = [];
  let finish = false;
  const ids = new Map<NodeId, Line>();

  for (;;) {
    const line = peekNonBlank(cursor);
    if (line === null) {
      break;
    }
    cursor.position += 1;
    const trimmed = line.text.trim();

    if (trimmed === "finish") {
      finish = true;
      const trailing = peekNonBlank(cursor);
      if (trailing !== null) {
        report(
          cursor,
          "PLAN_FINISH_NOT_LAST",
          `finish must be the last line; found ${quote(trailing.text.trim())} after it`,
          {
            line: trailing.number,
            expected: ["end of reply after finish"],
            found: trailing.text.trim(),
            hint: "put finish on the last line",
          },
        );
      }
      break;
    }
    if (trimmed === "end") {
      report(
        cursor,
        "PLAN_UNKNOWN_FIELD",
        `unexpected "end" on line ${line.number}; no patch record is open`,
        {
          line: line.number,
          expected: ["node+", "node~", "node-", "finish"],
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
        'JSON patch objects are not accepted; reply with the patch DSL starting with "patch"',
        {
          line: line.number,
          expected: ["patch"],
          found: "{",
          hint: "send the patch DSL, not JSON",
        },
      );
      recoverRecord(cursor);
      continue;
    }

    const keyword = trimmed.split(/\s+/)[0] ?? "";
    if (keyword === "patch") {
      report(
        cursor,
        "PLAN_UNKNOWN_FIELD",
        `the patch header is a singleton and must be the first line; found one on line ${line.number}`,
        {
          line: line.number,
          expected: ["node+", "node~", "node-", "finish"],
          found: keyword,
          hint: "keep exactly one patch header at the top",
        },
      );
      recoverRecord(cursor);
      continue;
    }
    if (isLegacyKeyword(keyword)) {
      legacyRecord(cursor, line, keyword);
      continue;
    }
    try {
      switch (keyword) {
        case "node+":
          ops.push(parseNodeAdd(cursor, line, ids));
          continue;
        case "node~":
          ops.push(parseNodeUpdate(cursor, line));
          continue;
        case "node-":
          ops.push(parseNodeRemove(cursor, line));
          continue;
        default:
          report(
            cursor,
            "PLAN_UNKNOWN_FIELD",
            `unknown patch record ${quote(keyword)} on line ${line.number}; expected node+|~|-, or a trailing finish`,
            {
              line: line.number,
              expected: ["node+", "node~", "node-", "finish"],
              found: keyword,
              hint: "use one of the patch record operators",
            },
          );
          recoverRecord(cursor);
      }
    } catch (error) {
      if (!(error instanceof PlanSyntaxError)) {
        throw error;
      }
      cursor.issues.push(error.issue);
      recoverRecord(cursor);
    }
  }
  return { ops, finish };
}

function parsePatchHeader(cursor: Cursor): void {
  const line = takeNonBlank(cursor, 'the patch header "patch"', "PLAN_MISSING_FIELD");
  const trimmed = line.text.trim();
  if (trimmed.startsWith("{")) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      'JSON patch objects are not accepted; reply with the patch DSL starting with "patch"',
      {
        line: line.number,
        expected: ["patch"],
        found: "{",
        hint: "send the patch DSL, not JSON",
      },
    );
  }
  if (trimmed !== "patch") {
    const keyword = trimmed.split(/\s+/)[0] ?? "";
    if (isLegacyKeyword(keyword)) {
      fail(
        cursor,
        "PLAN_LEGACY_RECORD",
        `legacy Stage/Task/Edit patch record ${quote(keyword)} is not supported; the patch DSL uses node+, node~, and node-`,
        {
          line: line.number,
          expected: ["patch"],
          found: keyword,
          hint: "start with patch and replace the old records with node operators",
        },
      );
    }
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `expected the patch header "patch" on line ${line.number}; got ${quote(trimmed)}`,
      {
        line: line.number,
        expected: ["patch"],
        found: trimmed,
        hint: 'start the reply with "patch"',
      },
    );
  }
}

function parsePlanPatchDetailedUnchecked(content: string): DslParseResult<PlanPatch> {
  const stripped = stripWholeReplyFence(content);
  const cursor = cursorOf(stripped.text, "patch");
  if (stripped.stripped) {
    warn(
      cursor,
      "PLAN_WHOLE_REPLY_FENCE",
      "the reply is wrapped in a markdown fence; stripped the fence and parsed the bare patch DSL",
      {
        line: stripped.line,
        expected: ["bare patch DSL"],
        found: "```",
        hint: "send the bare patch DSL without a surrounding fence",
      },
    );
  }
  if (stripped.text.trim() === "") {
    report(
      cursor,
      "PLAN_MISSING_FIELD",
      'the reply is empty; expected the patch DSL starting with "patch"',
      {
        line: 1,
        expected: ["patch"],
        found: "<eof>",
        hint: 'start the reply with "patch"',
      },
    );
    return { ok: false, issues: cursor.issues, truncated: false };
  }
  if (stripped.text.trimStart().startsWith("```")) {
    report(
      cursor,
      "PLAN_UNCLOSED_FENCE",
      "the reply starts with a markdown fence that does not wrap the whole reply; send the bare patch DSL without a surrounding fence",
      {
        line: 1,
        expected: ["bare patch DSL"],
        found: "```",
        hint: "remove the markdown fence",
      },
    );
    return { ok: false, issues: cursor.issues, truncated: false };
  }
  try {
    parsePatchHeader(cursor);
  } catch (error) {
    if (!(error instanceof PlanSyntaxError)) {
      throw error;
    }
    cursor.issues.push(error.issue);
    return { ok: false, issues: cursor.issues, truncated: cursor.truncated };
  }
  const { ops, finish } = parsePatchOps(cursor);
  const patch: PlanPatch = { ops, finish };
  const ok = !cursor.issues.some((issue) => issue.severity === "error");
  return {
    ok,
    value: patch,
    issues: cursor.issues,
    truncated: cursor.truncated,
  };
}

/** The detailed Plan-patch parse; `value` is best-effort when `ok` is false. */
export function parsePlanPatchDetailed(content: string): DslParseResult<PlanPatch> {
  return parsePlanPatchDetailedUnchecked(content);
}

/** Parse one tolerant Plan patch reply, rejecting on any error but returning warnings. */
export function parsePlanPatch(content: string): PatchParse {
  const result = parsePlanPatchDetailed(content);
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
        "stage: plan-protocol\ncode: PLAN_MISSING_FIELD\nmessage: the reply produced no patch",
    };
  }
  return { ok: true, patch: value };
}

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

function nodeHeaderWire(
  id: NodeId,
  after: readonly NodeId[],
  verify: WorkVerify,
  keyword: "node" | "node+" = "node",
): string {
  const edges = after.length === 0 ? "" : ` after ${after.map(quote).join(" ")}`;
  return `${keyword} ${quote(id)}${edges} verify ${verify}`;
}

/**
 * Serialize a Plan into the flat DSL. Text is emitted on the label line when
 * that round-trips exactly, otherwise in the sentinel fence. The serializer does
 * not emit `finish`; the run-state marker is separate from the plan graph.
 */
export function serializePlanDsl(plan: Plan): string {
  const lines: string[] = [`plan ${quote(plan.id)}`];
  pushText(lines, "goal:", plan.goal);
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
  return lines.join("\n");
}

/** Serialize a patch in the strict wire form (`docs/plan-exec.md` §4). */
export function serializePlanPatch(patch: PlanPatch): string {
  const lines: string[] = ["patch"];
  for (const op of patch.ops) {
    switch (op.kind) {
      case "node-add":
        lines.push(nodeHeaderWire(op.id, op.after, op.verify, "node+"));
        pushText(lines, "instruction:", op.instruction);
        pushHints(lines, op.hints);
        if (op.approach !== undefined) {
          pushText(lines, "approach:", op.approach);
        }
        if (op.phase !== undefined) {
          pushText(lines, "phase:", op.phase);
        }
        lines.push("end");
        break;
      case "node-update":
        lines.push(`node~ ${quote(op.id)}`);
        if (op.after !== undefined) {
          lines.push(op.after.length === 0 ? "after" : `after ${op.after.map(quote).join(" ")}`);
        }
        if (op.verify !== undefined) {
          lines.push(`verify ${op.verify}`);
        }
        if (op.instruction !== undefined) {
          pushText(lines, "instruction:", op.instruction);
        }
        if (op.hints !== undefined) {
          if (op.hints.length === 0) {
            lines.push("hint clear");
          } else {
            pushHints(lines, op.hints);
          }
        }
        if (op.approach !== undefined) {
          if (op.approach === null) {
            lines.push("approach clear");
          } else {
            pushText(lines, "approach:", op.approach);
          }
        }
        if (op.phase !== undefined) {
          if (op.phase === null) {
            lines.push("phase clear");
          } else {
            pushText(lines, "phase:", op.phase);
          }
        }
        lines.push("end");
        break;
      case "node-remove":
        lines.push(`node- ${quote(op.id)}`);
        lines.push("end");
        break;
    }
  }
  if (patch.finish) {
    lines.push("finish");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Patch application

function clonePlan(plan: Plan): Plan {
  return {
    id: plan.id,
    goal: plan.goal,
    nodes: plan.nodes.map((node) => ({
      id: node.id,
      after: [...node.after],
      verify: node.verify,
      instruction: node.instruction,
      hints: node.hints.map((hint) => ({ ...hint })),
      ...(node.approach === undefined ? {} : { approach: node.approach }),
      ...(node.phase === undefined ? {} : { phase: node.phase }),
    })),
  };
}

function findNodeIndex(plan: Plan, id: NodeId): number {
  return plan.nodes.findIndex((node) => node.id === id);
}

function patchTreeFailure(message: string): PlanMerge {
  const code = /does not exist|not in the plan/.test(message)
    ? "PLAN_UNKNOWN_PARENT"
    : /reuses node id/.test(message)
      ? "PLAN_DUPLICATE_ID"
      : /cycle/.test(message)
        ? "PLAN_CYCLE"
        : /final node|finish/.test(message)
          ? "PLAN_FINISH_NOT_LAST"
          : "PLAN_STRUCTURE";
  return { ok: false, diagnostics: `stage: plan-graph\ncode: ${code}\n- ${message}` };
}

function applyPatchOp(plan: Plan, op: PlanPatchOp): { ok: false; problem: string } | { ok: true } {
  switch (op.kind) {
    case "node-add": {
      if (findNodeIndex(plan, op.id) !== -1) {
        return {
          ok: false,
          problem: `node+ #${op.id} reuses node id "${op.id}"; ids must be globally unique`,
        };
      }
      plan.nodes.push({
        id: op.id,
        after: [...op.after],
        verify: op.verify,
        instruction: op.instruction,
        hints: op.hints.map((hint) => ({ ...hint })),
        ...(op.approach === undefined ? {} : { approach: op.approach }),
        ...(op.phase === undefined ? {} : { phase: op.phase }),
      });
      return { ok: true };
    }
    case "node-update": {
      const index = findNodeIndex(plan, op.id);
      const node = plan.nodes[index];
      if (node === undefined) {
        return { ok: false, problem: `node~ names node #${op.id}, which does not exist` };
      }
      const approach =
        op.approach === undefined ? node.approach : op.approach === null ? undefined : op.approach;
      const phase = op.phase === undefined ? node.phase : op.phase === null ? undefined : op.phase;
      plan.nodes[index] = {
        id: node.id,
        after: op.after === undefined ? node.after : [...op.after],
        verify: op.verify ?? node.verify,
        instruction: op.instruction ?? node.instruction,
        hints: op.hints === undefined ? node.hints : op.hints.map((hint) => ({ ...hint })),
        ...(approach === undefined ? {} : { approach }),
        ...(phase === undefined ? {} : { phase }),
      };
      return { ok: true };
    }
    case "node-remove": {
      const index = findNodeIndex(plan, op.id);
      if (index === -1) {
        return { ok: false, problem: `node- names node #${op.id}, which does not exist` };
      }
      plan.nodes.splice(index, 1);
      return { ok: true };
    }
  }
}

/**
 * Apply a parsed patch to a clone of the current graph, then run the same merge
 * validation as a full re-plan. The clone is local, so a rejected op or merge
 * leaves `previous` untouched.
 *
 * `finish` moves `finalNodeId` to the new last node; without `finish` the
 * previous final node must remain last (an in-place repair). Appending work
 * after it therefore needs a new `finish` on the new final test node.
 */
export function applyPlanPatch(previous: PlanRunState, patch: PlanPatch): PlanMerge {
  const nextPlan = clonePlan(previous.plan);
  for (const op of patch.ops) {
    const applied = applyPatchOp(nextPlan, op);
    if (!applied.ok) {
      return patchTreeFailure(applied.problem);
    }
  }

  const merged = mergeReplan(previous, nextPlan);
  if (!merged.ok) {
    return merged;
  }

  const last = finalNode(nextPlan);
  let finalNodeId: NodeId | null;
  if (patch.finish) {
    if (last === undefined) {
      return patchTreeFailure("finish needs at least one work node in the merged graph");
    }
    if (last.verify !== "test") {
      return patchTreeFailure(
        `finish marks node #${last.id}, but it verifies "${last.verify}"; the final node must verify "test"`,
      );
    }
    finalNodeId = last.id;
  } else if (previous.finalNodeId !== null) {
    if (last === undefined || last.id !== previous.finalNodeId) {
      const now =
        last === undefined ? "the merged graph has no nodes" : `the new last node is #${last.id}`;
      return patchTreeFailure(
        `the final node #${previous.finalNodeId} is no longer last (${now}); append a final "test" node and emit finish so finalNodeId moves`,
      );
    }
    finalNodeId = previous.finalNodeId;
  } else {
    finalNodeId = null;
  }

  return { ok: true, state: { ...merged.state, finalNodeId } };
}
