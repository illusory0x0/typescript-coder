/**
 * The flat Plan DSL (`docs/spec.md` §3) and patch DSL (§4): strict parsers and
 * serializers for the planner's initial reply and incremental re-plans. Records
 * are independent and name their parent by id: a `plan` header, then all
 * `stage` records, then all `task` records, then all `edit` records. A patch
 * applies the same records with `+` / `~` / `-` operators to a clone of the
 * current tree. The tree validator lives in `src/tasks.ts`; this module only
 * turns the wire form into that tree and runs the merge.
 *
 * The #33 layer makes both parsers tolerant: a whole-reply fence, a bare id,
 * and an unambiguous missing `end` recover with warnings; structure is still
 * rejected all-or-nothing, with shared bounded diagnostics (see
 * `src/dsl-diagnostics.ts`). There is no JSON fallback.
 */
import {
  finalTask,
  mergeReplan,
  NODE_ID_PATTERN,
  TASK_ACTIONS,
  TASK_SPACES,
  TASK_VERIFIES,
  validatePlanTree,
} from "./tasks";
import { renderDslIssues } from "./dsl-diagnostics";
import type { DslIssue, DslParseResult, DslStage } from "./dsl-diagnostics";
import type {
  EditNode,
  NodeId,
  Plan,
  PlanMerge,
  PlanParse,
  Stage,
  TaskAction,
  TaskLoc,
  TaskNode,
  TaskRunState,
  TaskVerify,
} from "./tasks";
import type { SymbolSpace } from "./utility";

const ACTION_SET: ReadonlySet<string> = new Set(TASK_ACTIONS);
const VERIFY_SET: ReadonlySet<string> = new Set(TASK_VERIFIES);
const SPACE_SET: ReadonlySet<string> = new Set(TASK_SPACES);

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

/** A successfully parsed initial Plan; `finalTaskId` is null without `finish`. */
export interface ParsedPlan {
  plan: Plan;
  finalTaskId: NodeId | null;
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
  stage?: DslStage;
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
    stage: options.stage ?? "task-protocol",
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
        hint: 'use ids like "02-current" or "03-task-answer"',
      },
    );
  }
  return value;
}

function fenceMarker(text: string): string | null {
  if (/^-{5,}$/.test(text) || /^`{6,}$/.test(text)) {
    return text;
  }
  return null;
}

function isRecordBoundary(cursor: Cursor, trimmed: string): boolean {
  if (trimmed === "finish") {
    return true;
  }
  if (cursor.mode === "plan") {
    return /^(plan|stage|task|edit)\b/.test(trimmed);
  }
  return /^(patch\b|plan~|stage[+~-]|task[+~-]|edit[+~-])/.test(trimmed);
}

function looksLikeField(trimmed: string): boolean {
  return /^[A-Za-z][\w-]*:/.test(trimmed) || /^(verify|related)\b/.test(trimmed);
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

/**
 * Read `goal:` / `instruction:` text: the rest of the label line, or an empty
 * label followed by a 5+ hyphen / 6+ backtick fence. Fenced raw lines are kept
 * exactly as sent. A missing label, empty text, or unclosed fence is an error.
 */
function readText(
  cursor: Cursor,
  label: "goal:" | "instruction:",
  where: string,
  recordId?: string,
): string {
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
  if (inline !== "") {
    return inline;
  }
  const opener = peekNonBlank(cursor);
  if (opener === null) {
    cursor.truncated = true;
    fail(
      cursor,
      "PLAN_TRUNCATED",
      `${label} for ${where} is empty; put the text after ${label} or open a fence of 5+ hyphens (or 6+ backticks) on a new line`,
      {
        line: line.number,
        expected: [label, "5+ hyphen fence", "6+ backtick fence"],
        found: "<eof>",
        recordId,
      },
    );
  }
  cursor.position += 1;
  const marker = fenceMarker(opener.text.trim());
  if (marker === null) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `${label} for ${where} is empty; put the text after ${label} or open a fence of 5+ hyphens (or 6+ backticks) on line ${opener.number}`,
      {
        line: opener.number,
        expected: ["text after the label", "5+ hyphen fence", "6+ backtick fence"],
        found: opener.text.trim(),
        recordId,
        hint: `write ${label} <text>, or put ${label} alone and open a ----- fence`,
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
    if (raw.text.trim() === marker) {
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
      return text;
    }
    content.push(raw.text);
  }
  cursor.truncated = true;
  fail(
    cursor,
    "PLAN_UNCLOSED_FENCE",
    `${where} has an unclosed ${label} fence opened on line ${opener.number}; close it with ${marker}`,
    {
      line: opener.number,
      expected: [marker],
      found: "<eof>",
      recordId,
      hint: `close the fence with ${marker}`,
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
  if (cursor.mode === "patch" ? isPatchBoundary(trimmed) : isPlanBoundary(trimmed)) {
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

function isPlanBoundary(trimmed: string): boolean {
  return trimmed === "finish" || /^(plan|stage|task|edit)\b/.test(trimmed);
}

function isPatchBoundary(trimmed: string): boolean {
  return trimmed === "finish" || /^(patch\b|plan~|stage[+~-]|task[+~-]|edit[+~-])/.test(trimmed);
}

interface RecordState {
  planId: NodeId;
  stages: Map<NodeId, Stage>;
  tasks: Map<NodeId, TaskNode>;
  idLines: Map<NodeId, Line>;
}

function claimId(cursor: Cursor, state: RecordState, id: NodeId, header: Line, kind: string): void {
  const first = state.idLines.get(id);
  if (first === undefined) {
    state.idLines.set(id, header);
    return;
  }
  report(
    cursor,
    "PLAN_DUPLICATE_ID",
    `${kind} #${id} reuses node id ${quote(id)} on line ${header.number}; it was first declared on line ${first.number}. Plan, stage, task, and edit ids must be globally unique`,
    {
      line: header.number,
      found: id,
      recordId: id,
      hint: "give every record a new NN-slug id",
    },
  );
}

function parseStage(cursor: Cursor, header: Line, state: RecordState): Stage {
  const [keyword, idToken, planKeyword, planToken, ...extra] = tokensOf(header);
  if (
    keyword !== "stage" ||
    planKeyword !== "plan" ||
    extra.length > 0 ||
    idToken === undefined ||
    planToken === undefined
  ) {
    const missing = idToken === undefined || planToken === undefined;
    fail(
      cursor,
      missing ? "PLAN_MISSING_FIELD" : "PLAN_UNKNOWN_FIELD",
      `stage record on line ${header.number} must be "stage \\"NN-slug\\" plan \\"NN-slug\\""; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ['stage "NN-slug" plan "NN-slug"'],
        found: extra[0] ?? header.text.trim(),
        hint: 'write stage "02-current" plan "01-main"',
      },
    );
  }
  const id = quotedId(cursor, idToken, `stage id on line ${header.number}`, header, idToken);
  claimId(cursor, state, id, header, "stage");
  const parent = quotedId(cursor, planToken, `plan ref of stage ${id}`, header, id);
  if (parent !== state.planId) {
    fail(
      cursor,
      "PLAN_UNKNOWN_PARENT",
      `stage ${id} names plan ${parent}, but the Plan id is ${state.planId}`,
      {
        line: header.number,
        expected: [state.planId],
        found: parent,
        recordId: id,
        hint: `reference plan ${quote(state.planId)}`,
      },
    );
  }
  const goal = readText(cursor, "goal:", `stage ${id}`, id);
  expectEnd(cursor, `stage ${id}`, id);
  return { id, goal, tasks: [] };
}

function parseTask(
  cursor: Cursor,
  header: Line,
  state: RecordState,
): { task: TaskNode; stageId: NodeId } {
  const [keyword, idToken, stageKeyword, stageToken, verifyKeyword, verifyToken, ...extra] =
    tokensOf(header);
  if (
    keyword !== "task" ||
    stageKeyword !== "stage" ||
    verifyKeyword !== "verify" ||
    extra.length > 0 ||
    idToken === undefined ||
    stageToken === undefined ||
    verifyToken === undefined
  ) {
    const missing = idToken === undefined || stageToken === undefined || verifyToken === undefined;
    fail(
      cursor,
      missing ? "PLAN_MISSING_FIELD" : "PLAN_UNKNOWN_FIELD",
      `task record on line ${header.number} must be "task \\"NN-slug\\" stage \\"NN-slug\\" verify tsc|test"; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ['task "NN-slug" stage "NN-slug" verify tsc|test'],
        found: extra[0] ?? header.text.trim(),
        hint: 'write task "03-first" stage "02-current" verify test',
      },
    );
  }
  const id = quotedId(cursor, idToken, `task id on line ${header.number}`, header, idToken);
  claimId(cursor, state, id, header, "task");
  const stageId = quotedId(cursor, stageToken, `stage ref of task ${id}`, header, id);
  if (!state.stages.has(stageId)) {
    const near = nearestId(stageId, state.stages.keys());
    fail(
      cursor,
      "PLAN_UNKNOWN_PARENT",
      `task ${id} names stage ${stageId}, which is not declared earlier in the Plan`,
      {
        line: header.number,
        expected: [...state.stages.keys()],
        found: stageId,
        recordId: id,
        hint:
          near === null
            ? "declare the stage before the task"
            : `did you mean stage ${quote(near)}?`,
      },
    );
  }
  if (!VERIFY_SET.has(verifyToken)) {
    fail(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      `task ${id} verify must be "tsc" or "test" (got ${quote(verifyToken)})`,
      {
        line: header.number,
        column: tokenColumn(header, verifyToken),
        expected: ["tsc", "test"],
        found: verifyToken,
        recordId: id,
      },
    );
  }
  const instruction = readText(cursor, "instruction:", `task ${id}`, id);
  expectEnd(cursor, `task ${id}`, id);
  return { task: { id, verify: verifyToken as TaskVerify, instruction, edits: [] }, stageId };
}

function parseEdit(
  cursor: Cursor,
  header: Line,
  state: RecordState,
): { edit: EditNode; taskId: NodeId } {
  const [keyword, idToken, taskKeyword, taskToken, actionToken, ...locTokens] = tokensOf(header);
  if (
    keyword !== "edit" ||
    taskKeyword !== "task" ||
    idToken === undefined ||
    taskToken === undefined ||
    actionToken === undefined
  ) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `edit record on line ${header.number} must be "edit \\"NN-slug\\" task \\"NN-slug\\" <action> <space> <symbol> in <path>" or "edit \\"NN-slug\\" task \\"NN-slug\\" write <path>"; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: [
          'edit "NN-slug" task "NN-slug" <action> <space> <symbol> in <path>',
          'edit "NN-slug" task "NN-slug" write <path>',
        ],
        found: header.text.trim(),
        hint: 'write edit "04-change" task "03-first" modify value answer in src/helper.ts',
      },
    );
  }
  const id = quotedId(cursor, idToken, `edit id on line ${header.number}`, header, idToken);
  claimId(cursor, state, id, header, "edit");
  const taskId = quotedId(cursor, taskToken, `task ref of edit ${id}`, header, id);
  if (!state.tasks.has(taskId)) {
    const near = nearestId(taskId, state.tasks.keys());
    fail(
      cursor,
      "PLAN_UNKNOWN_PARENT",
      `edit ${id} names task ${taskId}, which is not declared earlier in the Plan`,
      {
        line: header.number,
        expected: [...state.tasks.keys()],
        found: taskId,
        recordId: id,
        hint:
          near === null ? "declare the task before the edit" : `did you mean task ${quote(near)}?`,
      },
    );
  }
  if (!ACTION_SET.has(actionToken)) {
    fail(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      `edit ${id} action must be one of ${TASK_ACTIONS.map(quote).join(", ")} (got ${quote(actionToken)})`,
      {
        line: header.number,
        column: tokenColumn(header, actionToken),
        expected: [...TASK_ACTIONS],
        found: actionToken,
        recordId: id,
      },
    );
  }
  let loc: TaskLoc;
  if (actionToken === "write") {
    if (locTokens.length !== 1 || locTokens[0] === undefined) {
      fail(
        cursor,
        "PLAN_MISSING_FIELD",
        `write edit ${id} must be "write <path>" with no symbol or space; got ${quote(header.text.trim())}`,
        {
          line: header.number,
          expected: ["write <path>"],
          found: locTokens.join(" "),
          recordId: id,
          hint: `write edit "${id}" task "${taskId}" write src/module.ts`,
        },
      );
    }
    loc = { path: locTokens[0], symbol: "", kind: "file" };
  } else {
    const [spaceToken, symbolToken, inToken, pathToken, ...extra] = locTokens;
    if (
      spaceToken === undefined ||
      symbolToken === undefined ||
      inToken !== "in" ||
      pathToken === undefined ||
      extra.length > 0
    ) {
      fail(
        cursor,
        "PLAN_MISSING_FIELD",
        `edit ${id} must be "<action> <space> <symbol> in <path>"; got ${quote(header.text.trim())}`,
        {
          line: header.number,
          expected: ['edit "NN-slug" task "NN-slug" <action> <space> <symbol> in <path>'],
          found: header.text.trim(),
          recordId: id,
          hint: `write edit "${id}" task "${taskId}" modify value answer in src/helper.ts`,
        },
      );
    }
    if (!SPACE_SET.has(spaceToken)) {
      fail(
        cursor,
        "PLAN_UNKNOWN_FIELD",
        `edit ${id} space must be one of value, type, namespace (got ${quote(spaceToken)})`,
        {
          line: header.number,
          column: tokenColumn(header, spaceToken),
          expected: [...TASK_SPACES],
          found: spaceToken,
          recordId: id,
        },
      );
    }
    loc = { path: pathToken, symbol: symbolToken, kind: spaceToken as SymbolSpace };
  }

  const related: TaskLoc[] = [];
  let renameTo: string | undefined;
  for (;;) {
    const next = peekNonBlank(cursor);
    if (next === null) {
      break;
    }
    const trimmed = next.text.trim();
    if (trimmed === "related" || trimmed.startsWith("related ")) {
      cursor.position += 1;
      const [relatedKeyword, relatedSpace, relatedSymbol, relatedIn, relatedPath, ...rest] =
        tokensOf(next);
      if (
        relatedKeyword !== "related" ||
        relatedIn !== "in" ||
        rest.length > 0 ||
        relatedSpace === undefined ||
        relatedSymbol === undefined ||
        relatedPath === undefined
      ) {
        fail(
          cursor,
          "PLAN_MISSING_FIELD",
          `related line for edit ${id} must be "related <space> <symbol> in <path>"; got ${quote(trimmed)}`,
          {
            line: next.number,
            expected: ["related <space> <symbol> in <path>"],
            found: trimmed,
            recordId: id,
          },
        );
      }
      if (renameTo !== undefined) {
        fail(
          cursor,
          "PLAN_UNKNOWN_FIELD",
          `related lines for edit ${id} must come before renameTo`,
          { line: next.number, recordId: id, hint: "move related lines above renameTo" },
        );
      }
      if (!SPACE_SET.has(relatedSpace)) {
        fail(
          cursor,
          "PLAN_UNKNOWN_FIELD",
          `related space for edit ${id} must be one of value, type, namespace (got ${quote(relatedSpace)})`,
          {
            line: next.number,
            expected: [...TASK_SPACES],
            found: relatedSpace,
            recordId: id,
          },
        );
      }
      related.push({
        path: relatedPath,
        symbol: relatedSymbol,
        kind: relatedSpace as SymbolSpace,
      });
      continue;
    }
    if (trimmed.startsWith("renameTo")) {
      cursor.position += 1;
      const [label, symbol, ...rest] = tokensOf(next);
      if (label !== "renameTo:" || symbol === undefined || rest.length > 0) {
        fail(
          cursor,
          "PLAN_MISSING_FIELD",
          `renameTo line for edit ${id} must be "renameTo: <symbol>"; got ${quote(trimmed)}`,
          {
            line: next.number,
            expected: ["renameTo: <symbol>"],
            found: trimmed,
            recordId: id,
          },
        );
      }
      if (renameTo !== undefined) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `edit ${id} carries renameTo more than once`, {
          line: next.number,
          recordId: id,
          hint: "keep exactly one renameTo line",
        });
      }
      renameTo = symbol;
      continue;
    }
    break;
  }

  const instruction = readText(cursor, "instruction:", `edit ${id}`, id);
  expectEnd(cursor, `edit ${id}`, id);
  return {
    edit: {
      id,
      loc,
      ...(related.length === 0 ? {} : { related }),
      action: actionToken as TaskAction,
      instruction,
      ...(renameTo === undefined ? {} : { renameTo }),
    },
    taskId,
  };
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

function finishPlan(
  cursor: Cursor,
  line: Line,
  state: RecordState,
): { stages: Stage[]; finalTaskId: NodeId | null } {
  const stages = [...state.stages.values()];
  const final = finalTask(stages);
  if (final === undefined) {
    report(cursor, "PLAN_FINISH_NOT_LAST", "finish must follow at least one task", {
      line: line.number,
      expected: ["one task before finish"],
      found: "finish",
      hint: "plan at least one task and mark the final test task",
    });
    return { stages, finalTaskId: null };
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
        recordId: final.id,
        hint: "put finish on the last line",
      },
    );
    return { stages, finalTaskId: null };
  }
  if (final.verify !== "test") {
    report(
      cursor,
      "PLAN_FINISH_NOT_LAST",
      `finish marks task ${quote(final.id)}, which verifies ${final.verify}; the last task must verify "test"`,
      {
        line: line.number,
        expected: ["test"],
        found: final.verify,
        recordId: final.id,
        hint: "append a final test task and mark it with finish",
      },
    );
    return { stages, finalTaskId: null };
  }
  return { stages, finalTaskId: final.id };
}

function parseRecords(
  cursor: Cursor,
  planId: NodeId,
  idLines: Map<NodeId, Line>,
): { stages: Stage[]; finalTaskId: NodeId | null } {
  const state: RecordState = {
    planId,
    stages: new Map(),
    tasks: new Map(),
    idLines,
  };
  let phase: "stages" | "tasks" | "edits" = "stages";

  for (;;) {
    const line = peekNonBlank(cursor);
    if (line === null) {
      break;
    }
    cursor.position += 1;
    const trimmed = line.text.trim();

    if (trimmed === "finish") {
      return finishPlan(cursor, line, state);
    }
    if (trimmed === "end") {
      report(
        cursor,
        "PLAN_UNKNOWN_FIELD",
        `unexpected "end" on line ${line.number}; no record is open`,
        {
          line: line.number,
          expected: ["stage", "task", "edit", "finish"],
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
          expected: ["stage", "task", "edit", "finish"],
          found: keyword,
          hint: "keep exactly one plan header at the top",
        },
      );
      recoverRecord(cursor);
      continue;
    }
    if (keyword === "stage") {
      if (phase !== "stages") {
        report(
          cursor,
          "PLAN_UNKNOWN_FIELD",
          `stage records must come before task and edit records; found a stage on line ${line.number} after ${phase === "tasks" ? "a task" : "an edit"}`,
          {
            line: line.number,
            expected: ["task", "edit", "finish"],
            found: keyword,
            hint: "reorder the records: stages, then tasks, then edits",
          },
        );
        recoverRecord(cursor);
        continue;
      }
      try {
        const stage = parseStage(cursor, line, state);
        if (!state.stages.has(stage.id)) {
          state.stages.set(stage.id, stage);
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
    if (keyword === "task") {
      if (phase === "edits") {
        report(
          cursor,
          "PLAN_UNKNOWN_FIELD",
          `task records must come before edit records; found a task on line ${line.number}`,
          {
            line: line.number,
            expected: ["edit", "finish"],
            found: keyword,
            hint: "move the task above the edit records",
          },
        );
        recoverRecord(cursor);
        continue;
      }
      phase = "tasks";
      try {
        const { task, stageId } = parseTask(cursor, line, state);
        const stage = state.stages.get(stageId);
        if (stage !== undefined && !stage.tasks.some((candidate) => candidate.id === task.id)) {
          stage.tasks.push(task);
          state.tasks.set(task.id, task);
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
    if (keyword === "edit") {
      phase = "edits";
      try {
        const { edit, taskId } = parseEdit(cursor, line, state);
        const task = state.tasks.get(taskId);
        if (task !== undefined && !task.edits.some((candidate) => candidate.id === edit.id)) {
          task.edits.push(edit);
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
    report(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      `unknown record header ${quote(keyword)} on line ${line.number}; expected "stage", "task", "edit", or a trailing "finish"`,
      {
        line: line.number,
        expected: ["stage", "task", "edit", "finish"],
        found: keyword,
        hint: "use one of the Plan DSL record headers",
      },
    );
    recoverRecord(cursor);
  }
  return { stages: [...state.stages.values()], finalTaskId: null };
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
  let finalTaskId: NodeId | null = null;
  const idLines = new Map<NodeId, Line>();
  try {
    const header = parsePlanHeader(cursor);
    idLines.set(header.id, header.line);
    const records = parseRecords(cursor, header.id, idLines);
    plan = { id: header.id, goal: header.goal, stages: records.stages };
    finalTaskId = records.finalTaskId;
  } catch (error) {
    if (!(error instanceof PlanSyntaxError)) {
      throw error;
    }
    cursor.issues.push(error.issue);
    return { ok: false, issues: cursor.issues, truncated: cursor.truncated };
  }

  const hasErrors = cursor.issues.some((issue) => issue.severity === "error");
  if (hasErrors) {
    return {
      ok: false,
      value: { plan, finalTaskId },
      issues: cursor.issues,
      truncated: cursor.truncated,
    };
  }
  const problems = validatePlanTree(plan);
  if (problems !== null) {
    for (const problem of problems.split("\n").filter((line) => line.startsWith("- "))) {
      const message = problem.slice(2);
      const idMatch = /#([0-9]{2,}-[a-z0-9]+(?:-[a-z0-9]+)*)/.exec(message);
      const recordId = idMatch?.[1];
      const line = recordId === undefined ? 1 : (idLines.get(recordId)?.number ?? 1);
      const code = message.includes("PLAN_CREATE_MEMBER")
        ? "PLAN_CREATE_MEMBER"
        : message.includes("reuses node id")
          ? "PLAN_DUPLICATE_ID"
          : message.includes("must be a string node id")
            ? "PLAN_MISSING_FIELD"
            : "PLAN_STRUCTURE";
      cursor.issues.push(
        issueAt(cursor, code, message, {
          line,
          stage: "task-tree",
          ...(recordId === undefined ? {} : { recordId }),
          ...(code === "PLAN_CREATE_MEMBER"
            ? {
                hint: "modify the class with all needed stubs, then modify the member, or use a top-level function",
              }
            : {}),
        }),
      );
    }
    return {
      ok: false,
      value: { plan, finalTaskId },
      issues: cursor.issues,
      truncated: cursor.truncated,
    };
  }
  return {
    ok: true,
    value: { plan, finalTaskId },
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
      stage: errors.some((issue) => issue.stage === "task-tree") ? "task-tree" : "task-protocol",
      diagnostics: renderDslIssues([...result.issues]),
    };
  }
  const value = result.value;
  if (value === undefined) {
    return {
      ok: false,
      stage: "task-protocol",
      diagnostics:
        "stage: task-protocol\ncode: PLAN_MISSING_FIELD\nmessage: the reply produced no Plan",
    };
  }
  return { ok: true, plan: value.plan, finalTaskId: value.finalTaskId };
}

/** The initial-plan parser name used by the driver; the DSL is the only form. */
export const parsePlan = parsePlanDsl;
/** The full-tree Plan parser, kept for tests; the driver plans patches after the initial turn. */
export const readPlan = parsePlanDsl;

// ---------------------------------------------------------------------------
// Patch DSL (`docs/spec.md` §4)

/** One strict patch operation; `+` appends, `~` replaces present fields, `-` removes. */
export type PlanPatchOp =
  | { kind: "plan-update"; id: NodeId; goal: string }
  | { kind: "stage-add"; id: NodeId; plan: NodeId; goal: string }
  | { kind: "stage-update"; id: NodeId; goal?: string }
  | { kind: "stage-remove"; id: NodeId }
  | { kind: "task-add"; id: NodeId; stage: NodeId; verify: TaskVerify; instruction: string }
  | { kind: "task-update"; id: NodeId; verify?: TaskVerify; instruction?: string }
  | { kind: "task-remove"; id: NodeId }
  | {
      kind: "edit-add";
      id: NodeId;
      task: NodeId;
      loc: TaskLoc;
      action: TaskAction;
      related?: TaskLoc[];
      renameTo?: string;
      instruction: string;
    }
  | {
      kind: "edit-update";
      id: NodeId;
      loc?: TaskLoc;
      action?: TaskAction;
      related?: TaskLoc[];
      renameTo?: string;
      instruction?: string;
    }
  | { kind: "edit-remove"; id: NodeId };

/** One parsed patch reply; ops are applied in wire order. */
export interface PlanPatch {
  ops: PlanPatchOp[];
  /** True when the reply ended with `finish`. */
  finish: boolean;
}

/** A patch rejection; parse failures are `task-protocol`, apply/merge failures are `task-tree`. */
export type PatchParse =
  | { ok: true; patch: PlanPatch }
  | { ok: false; stage: "task-protocol" | "task-tree"; diagnostics: string };

function parseActionLoc(
  cursor: Cursor,
  tokens: readonly string[],
  where: string,
  header: Line,
  recordId?: string,
): { action: TaskAction; loc: TaskLoc } {
  const [actionToken, ...rest] = tokens;
  if (actionToken === undefined) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `${where} must be "<action> <space> <symbol> in <path>" or "write <path>"; got ${quote(tokens.join(" "))}`,
      {
        line: header.number,
        expected: ["<action> <space> <symbol> in <path>", "write <path>"],
        found: tokens.join(" "),
        recordId,
      },
    );
  }
  if (!ACTION_SET.has(actionToken)) {
    fail(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      `${where} action must be one of ${TASK_ACTIONS.map(quote).join(", ")} (got ${quote(actionToken)})`,
      {
        line: header.number,
        column: tokenColumn(header, actionToken),
        expected: [...TASK_ACTIONS],
        found: actionToken,
        recordId,
      },
    );
  }
  if (actionToken === "write") {
    if (rest.length !== 1 || rest[0] === undefined) {
      fail(
        cursor,
        "PLAN_MISSING_FIELD",
        `${where} write must be "write <path>"; got ${quote(tokens.join(" "))}`,
        {
          line: header.number,
          expected: ["write <path>"],
          found: tokens.join(" "),
          recordId,
        },
      );
    }
    return {
      action: "write",
      loc: { path: rest[0], symbol: "", kind: "file" },
    };
  }
  const [spaceToken, symbolToken, inToken, pathToken, ...extra] = rest;
  if (
    spaceToken === undefined ||
    symbolToken === undefined ||
    inToken !== "in" ||
    pathToken === undefined ||
    extra.length > 0
  ) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `${where} must be "<action> <space> <symbol> in <path>"; got ${quote(tokens.join(" "))}`,
      {
        line: header.number,
        expected: ["<action> <space> <symbol> in <path>"],
        found: tokens.join(" "),
        recordId,
      },
    );
  }
  if (!SPACE_SET.has(spaceToken)) {
    fail(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      `${where} space must be one of value, type, namespace (got ${quote(spaceToken)})`,
      {
        line: header.number,
        column: tokenColumn(header, spaceToken),
        expected: [...TASK_SPACES],
        found: spaceToken,
        recordId,
      },
    );
  }
  return {
    action: actionToken as TaskAction,
    loc: { path: pathToken, symbol: symbolToken, kind: spaceToken as SymbolSpace },
  };
}

function parseRelated(cursor: Cursor, line: Line, editId: NodeId): TaskLoc {
  const [keyword, spaceToken, symbolToken, inToken, pathToken, ...extra] = tokensOf(line);
  if (
    keyword !== "related" ||
    inToken !== "in" ||
    extra.length > 0 ||
    spaceToken === undefined ||
    symbolToken === undefined ||
    pathToken === undefined
  ) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `related line for edit ${editId} must be "related <space> <symbol> in <path>"; got ${quote(line.text.trim())}`,
      {
        line: line.number,
        expected: ["related <space> <symbol> in <path>"],
        found: line.text.trim(),
        recordId: editId,
      },
    );
  }
  if (!SPACE_SET.has(spaceToken)) {
    fail(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      `related space for edit ${editId} must be one of value, type, namespace (got ${quote(spaceToken)})`,
      {
        line: line.number,
        expected: [...TASK_SPACES],
        found: spaceToken,
        recordId: editId,
      },
    );
  }
  return { path: pathToken, symbol: symbolToken, kind: spaceToken as SymbolSpace };
}

interface EditTail {
  related?: TaskLoc[];
  renameTo?: string;
  instruction?: string;
}

/**
 * Read the optional `related` / `renameTo:` / `instruction:` tail of an edit
 * patch. Fields keep BNF order: related lines, then renameTo, then instruction.
 */
function parseEditTail(cursor: Cursor, id: NodeId, requireInstruction: boolean): EditTail {
  const related: TaskLoc[] = [];
  let renameTo: string | undefined;
  let instruction: string | undefined;

  for (;;) {
    const next = peekNonBlank(cursor);
    if (next === null) {
      break;
    }
    const trimmed = next.text.trim();
    if (trimmed === "related" || trimmed.startsWith("related ")) {
      if (renameTo !== undefined) {
        fail(
          cursor,
          "PLAN_UNKNOWN_FIELD",
          `related lines for edit ${id} must come before renameTo`,
          { line: next.number, recordId: id, hint: "move related lines above renameTo" },
        );
      }
      if (instruction !== undefined) {
        fail(
          cursor,
          "PLAN_UNKNOWN_FIELD",
          `related lines for edit ${id} must come before instruction`,
          { line: next.number, recordId: id, hint: "move related lines above instruction" },
        );
      }
      cursor.position += 1;
      related.push(parseRelated(cursor, next, id));
      continue;
    }
    if (trimmed.startsWith("renameTo")) {
      if (instruction !== undefined) {
        fail(
          cursor,
          "PLAN_UNKNOWN_FIELD",
          `renameTo line for edit ${id} must come before instruction`,
          { line: next.number, recordId: id, hint: "move renameTo above instruction" },
        );
      }
      cursor.position += 1;
      const [label, symbol, ...rest] = tokensOf(next);
      if (label !== "renameTo:" || symbol === undefined || rest.length > 0) {
        fail(
          cursor,
          "PLAN_MISSING_FIELD",
          `renameTo line for edit ${id} must be "renameTo: <symbol>"; got ${quote(trimmed)}`,
          {
            line: next.number,
            expected: ["renameTo: <symbol>"],
            found: trimmed,
            recordId: id,
          },
        );
      }
      if (renameTo !== undefined) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `edit ${id} carries renameTo more than once`, {
          line: next.number,
          recordId: id,
          hint: "keep exactly one renameTo line",
        });
      }
      renameTo = symbol;
      continue;
    }
    if (trimmed.startsWith("instruction:")) {
      if (instruction !== undefined) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `edit ${id} carries instruction more than once`, {
          line: next.number,
          recordId: id,
          hint: "keep exactly one instruction field",
        });
      }
      instruction = readText(cursor, "instruction:", `edit ${id}`, id);
      continue;
    }
    break;
  }

  if (requireInstruction && instruction === undefined) {
    const next = peekNonBlank(cursor);
    fail(cursor, "PLAN_MISSING_FIELD", `edit ${id} needs instruction: before end`, {
      line: next?.number ?? Math.max(1, cursor.lines.length),
      expected: ["instruction:"],
      found: next?.text.trim() ?? "<eof>",
      recordId: id,
      hint: `add instruction: before end`,
    });
  }
  return {
    ...(related.length === 0 ? {} : { related }),
    ...(renameTo === undefined ? {} : { renameTo }),
    ...(instruction === undefined ? {} : { instruction }),
  };
}

function parsePlanUpdate(cursor: Cursor, header: Line): PlanPatchOp {
  const [keyword, idToken, ...extra] = tokensOf(header);
  if (keyword !== "plan~" || extra.length > 0 || idToken === undefined) {
    fail(
      cursor,
      extra.length > 0 ? "PLAN_UNKNOWN_FIELD" : "PLAN_MISSING_FIELD",
      `plan~ record on line ${header.number} must be "plan~ \\"NN-slug\\""; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ['plan~ "NN-slug"'],
        found: extra[0] ?? header.text.trim(),
        hint: 'write plan~ "01-main"',
      },
    );
  }
  const id = quotedId(cursor, idToken, `plan id on line ${header.number}`, header, idToken);
  const goal = readText(cursor, "goal:", `plan ${id}`, id);
  expectEnd(cursor, `plan ${id}`, id);
  return { kind: "plan-update", id, goal };
}

function parseStageAdd(cursor: Cursor, header: Line): PlanPatchOp {
  const [keyword, idToken, planKeyword, planToken, ...extra] = tokensOf(header);
  if (
    keyword !== "stage+" ||
    planKeyword !== "plan" ||
    extra.length > 0 ||
    idToken === undefined ||
    planToken === undefined
  ) {
    const missing = idToken === undefined || planToken === undefined;
    fail(
      cursor,
      missing ? "PLAN_MISSING_FIELD" : "PLAN_UNKNOWN_FIELD",
      `stage+ record on line ${header.number} must be "stage+ \\"NN-slug\\" plan \\"NN-slug\\""; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ['stage+ "NN-slug" plan "NN-slug"'],
        found: extra[0] ?? header.text.trim(),
        hint: 'write stage+ "07-next" plan "01-main"',
      },
    );
  }
  const id = quotedId(cursor, idToken, `stage id on line ${header.number}`, header, idToken);
  const plan = quotedId(cursor, planToken, `plan ref of stage ${id}`, header, id);
  const goal = readText(cursor, "goal:", `stage ${id}`, id);
  expectEnd(cursor, `stage ${id}`, id);
  return { kind: "stage-add", id, plan, goal };
}

function parseStageUpdate(cursor: Cursor, header: Line): PlanPatchOp {
  const [keyword, idToken, ...extra] = tokensOf(header);
  if (keyword !== "stage~" || extra.length > 0 || idToken === undefined) {
    fail(
      cursor,
      extra.length > 0 ? "PLAN_UNKNOWN_FIELD" : "PLAN_MISSING_FIELD",
      `stage~ record on line ${header.number} must be "stage~ \\"NN-slug\\""; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ['stage~ "NN-slug"'],
        found: extra[0] ?? header.text.trim(),
        hint: 'write stage~ "02-current"',
      },
    );
  }
  const id = quotedId(cursor, idToken, `stage id on line ${header.number}`, header, idToken);
  let goal: string | undefined;
  const next = peekNonBlank(cursor);
  if (next !== null && next.text.trim().startsWith("goal:")) {
    goal = readText(cursor, "goal:", `stage ${id}`, id);
  }
  expectEnd(cursor, `stage ${id}`, id);
  return { kind: "stage-update", id, ...(goal === undefined ? {} : { goal }) };
}

function parseStageRemove(cursor: Cursor, header: Line): PlanPatchOp {
  const [keyword, idToken, ...extra] = tokensOf(header);
  if (keyword !== "stage-" || extra.length > 0 || idToken === undefined) {
    fail(
      cursor,
      extra.length > 0 ? "PLAN_UNKNOWN_FIELD" : "PLAN_MISSING_FIELD",
      `stage- record on line ${header.number} must be "stage- \\"NN-slug\\""; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ['stage- "NN-slug"'],
        found: extra[0] ?? header.text.trim(),
        hint: 'write stage- "05-repair"',
      },
    );
  }
  const id = quotedId(cursor, idToken, `stage id on line ${header.number}`, header, idToken);
  expectEnd(cursor, `stage ${id}`, id);
  return { kind: "stage-remove", id };
}

function parseTaskAdd(cursor: Cursor, header: Line): PlanPatchOp {
  const [keyword, idToken, stageKeyword, stageToken, verifyKeyword, verifyToken, ...extra] =
    tokensOf(header);
  if (
    keyword !== "task+" ||
    stageKeyword !== "stage" ||
    verifyKeyword !== "verify" ||
    extra.length > 0 ||
    idToken === undefined ||
    stageToken === undefined ||
    verifyToken === undefined
  ) {
    const missing = idToken === undefined || stageToken === undefined || verifyToken === undefined;
    fail(
      cursor,
      missing ? "PLAN_MISSING_FIELD" : "PLAN_UNKNOWN_FIELD",
      `task+ record on line ${header.number} must be "task+ \\"NN-slug\\" stage \\"NN-slug\\" verify tsc|test"; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ['task+ "NN-slug" stage "NN-slug" verify tsc|test'],
        found: extra[0] ?? header.text.trim(),
        hint: 'write task+ "08-final" stage "07-next" verify test',
      },
    );
  }
  const id = quotedId(cursor, idToken, `task id on line ${header.number}`, header, idToken);
  const stage = quotedId(cursor, stageToken, `stage ref of task ${id}`, header, id);
  if (!VERIFY_SET.has(verifyToken)) {
    fail(
      cursor,
      "PLAN_UNKNOWN_FIELD",
      `task ${id} verify must be "tsc" or "test" (got ${quote(verifyToken)})`,
      {
        line: header.number,
        column: tokenColumn(header, verifyToken),
        expected: ["tsc", "test"],
        found: verifyToken,
        recordId: id,
      },
    );
  }
  const instruction = readText(cursor, "instruction:", `task ${id}`, id);
  expectEnd(cursor, `task ${id}`, id);
  return { kind: "task-add", id, stage, verify: verifyToken as TaskVerify, instruction };
}

function parseTaskUpdate(cursor: Cursor, header: Line): PlanPatchOp {
  const [keyword, idToken, ...extra] = tokensOf(header);
  if (keyword !== "task~" || extra.length > 0 || idToken === undefined) {
    fail(
      cursor,
      extra.length > 0 ? "PLAN_UNKNOWN_FIELD" : "PLAN_MISSING_FIELD",
      `task~ record on line ${header.number} must be "task~ \\"NN-slug\\""; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ['task~ "NN-slug"'],
        found: extra[0] ?? header.text.trim(),
        hint: 'write task~ "03-answer"',
      },
    );
  }
  const id = quotedId(cursor, idToken, `task id on line ${header.number}`, header, idToken);
  let verify: TaskVerify | undefined;
  let instruction: string | undefined;

  for (;;) {
    const next = peekNonBlank(cursor);
    if (next === null) {
      break;
    }
    const trimmed = next.text.trim();
    if (trimmed === "verify" || trimmed.startsWith("verify ")) {
      cursor.position += 1;
      const [label, token, ...rest] = tokensOf(next);
      if (label !== "verify" || token === undefined || rest.length > 0) {
        fail(
          cursor,
          "PLAN_MISSING_FIELD",
          `verify line for task ${id} must be "verify tsc|test"; got ${quote(trimmed)}`,
          {
            line: next.number,
            expected: ["verify tsc|test"],
            found: trimmed,
            recordId: id,
          },
        );
      }
      if (verify !== undefined) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `task ${id} carries verify more than once`, {
          line: next.number,
          recordId: id,
          hint: "keep exactly one verify line",
        });
      }
      if (instruction !== undefined) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `task ${id} verify must come before instruction`, {
          line: next.number,
          recordId: id,
          hint: "move verify above instruction",
        });
      }
      if (!VERIFY_SET.has(token)) {
        fail(
          cursor,
          "PLAN_UNKNOWN_FIELD",
          `task ${id} verify must be "tsc" or "test" (got ${quote(token)})`,
          {
            line: next.number,
            column: tokenColumn(next, token),
            expected: ["tsc", "test"],
            found: token,
            recordId: id,
          },
        );
      }
      verify = token as TaskVerify;
      continue;
    }
    if (trimmed.startsWith("verify")) {
      fail(
        cursor,
        "PLAN_MISSING_FIELD",
        `verify line for task ${id} must be "verify tsc|test"; got ${quote(trimmed)}`,
        {
          line: next.number,
          expected: ["verify tsc|test"],
          found: trimmed,
          recordId: id,
        },
      );
    }
    if (trimmed.startsWith("instruction:")) {
      if (instruction !== undefined) {
        fail(cursor, "PLAN_UNKNOWN_FIELD", `task ${id} carries instruction more than once`, {
          line: next.number,
          recordId: id,
          hint: "keep exactly one instruction field",
        });
      }
      instruction = readText(cursor, "instruction:", `task ${id}`, id);
      continue;
    }
    break;
  }

  expectEnd(cursor, `task ${id}`, id);
  return {
    kind: "task-update",
    id,
    ...(verify === undefined ? {} : { verify }),
    ...(instruction === undefined ? {} : { instruction }),
  };
}

function parseTaskRemove(cursor: Cursor, header: Line): PlanPatchOp {
  const [keyword, idToken, ...extra] = tokensOf(header);
  if (keyword !== "task-" || extra.length > 0 || idToken === undefined) {
    fail(
      cursor,
      extra.length > 0 ? "PLAN_UNKNOWN_FIELD" : "PLAN_MISSING_FIELD",
      `task- record on line ${header.number} must be "task- \\"NN-slug\\""; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ['task- "NN-slug"'],
        found: extra[0] ?? header.text.trim(),
        hint: 'write task- "06-object"',
      },
    );
  }
  const id = quotedId(cursor, idToken, `task id on line ${header.number}`, header, idToken);
  expectEnd(cursor, `task ${id}`, id);
  return { kind: "task-remove", id };
}

function parseEditAdd(cursor: Cursor, header: Line): PlanPatchOp {
  const [keyword, idToken, taskKeyword, taskToken, ...locTokens] = tokensOf(header);
  if (
    keyword !== "edit+" ||
    taskKeyword !== "task" ||
    locTokens.length === 0 ||
    idToken === undefined ||
    taskToken === undefined
  ) {
    fail(
      cursor,
      "PLAN_MISSING_FIELD",
      `edit+ record on line ${header.number} must be "edit+ \\"NN-slug\\" task \\"NN-slug\\" <action> <space> <symbol> in <path>"; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ['edit+ "NN-slug" task "NN-slug" <action> <space> <symbol> in <path>'],
        found: header.text.trim(),
        hint: 'write edit+ "09-final" task "08-final" modify value parseJson in src/helper.ts',
      },
    );
  }
  const id = quotedId(cursor, idToken, `edit id on line ${header.number}`, header, idToken);
  const task = quotedId(cursor, taskToken, `task ref of edit ${id}`, header, id);
  const { action, loc } = parseActionLoc(
    cursor,
    locTokens,
    `edit+ ${id} header on line ${header.number}`,
    header,
    id,
  );
  const tail = parseEditTail(cursor, id, true);
  const instruction = tail.instruction;
  if (instruction === undefined) {
    fail(cursor, "PLAN_MISSING_FIELD", `edit ${id} needs instruction: before end`, {
      line: header.number,
      expected: ["instruction:"],
      recordId: id,
    });
  }
  expectEnd(cursor, `edit ${id}`, id);
  return {
    kind: "edit-add",
    id,
    task,
    loc,
    action,
    ...(tail.related === undefined ? {} : { related: tail.related }),
    ...(tail.renameTo === undefined ? {} : { renameTo: tail.renameTo }),
    instruction,
  };
}

function parseEditUpdate(cursor: Cursor, header: Line): PlanPatchOp {
  const [keyword, idToken, ...extra] = tokensOf(header);
  if (keyword !== "edit~" || extra.length > 0 || idToken === undefined) {
    fail(
      cursor,
      extra.length > 0 ? "PLAN_UNKNOWN_FIELD" : "PLAN_MISSING_FIELD",
      `edit~ record on line ${header.number} must be "edit~ \\"NN-slug\\""; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ['edit~ "NN-slug"'],
        found: extra[0] ?? header.text.trim(),
        hint: 'write edit~ "04-change"',
      },
    );
  }
  const id = quotedId(cursor, idToken, `edit id on line ${header.number}`, header, idToken);

  let action: TaskAction | undefined;
  let loc: TaskLoc | undefined;
  const next = peekNonBlank(cursor);
  if (next !== null) {
    const trimmed = next.text.trim();
    const tokens = tokensOf(next);
    const first = tokens[0] ?? "";
    const tailLine =
      first === "related" ||
      trimmed.startsWith("related ") ||
      trimmed.startsWith("renameTo") ||
      trimmed.startsWith("instruction:");
    const locLine =
      !tailLine && (ACTION_SET.has(first) || (tokens.length === 5 && tokens[3] === "in"));
    if (locLine) {
      cursor.position += 1;
      const parsed = parseActionLoc(cursor, tokens, `edit~ ${id} loc line`, next, id);
      action = parsed.action;
      loc = parsed.loc;
    }
  }

  const tail = parseEditTail(cursor, id, false);
  expectEnd(cursor, `edit ${id}`, id);
  return {
    kind: "edit-update",
    id,
    ...(action === undefined ? {} : { action }),
    ...(loc === undefined ? {} : { loc }),
    ...(tail.related === undefined ? {} : { related: tail.related }),
    ...(tail.renameTo === undefined ? {} : { renameTo: tail.renameTo }),
    ...(tail.instruction === undefined ? {} : { instruction: tail.instruction }),
  };
}

function parseEditRemove(cursor: Cursor, header: Line): PlanPatchOp {
  const [keyword, idToken, ...extra] = tokensOf(header);
  if (keyword !== "edit-" || extra.length > 0 || idToken === undefined) {
    fail(
      cursor,
      extra.length > 0 ? "PLAN_UNKNOWN_FIELD" : "PLAN_MISSING_FIELD",
      `edit- record on line ${header.number} must be "edit- \\"NN-slug\\""; got ${quote(header.text.trim())}`,
      {
        line: header.number,
        expected: ['edit- "NN-slug"'],
        found: extra[0] ?? header.text.trim(),
        hint: 'write edit- "07-object"',
      },
    );
  }
  const id = quotedId(cursor, idToken, `edit id on line ${header.number}`, header, idToken);
  expectEnd(cursor, `edit ${id}`, id);
  return { kind: "edit-remove", id };
}

function parsePatchOps(cursor: Cursor): { ops: PlanPatchOp[]; finish: boolean } {
  const ops: PlanPatchOp[] = [];
  let finish = false;

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
          expected: ["plan~", "stage+", "task+", "edit+", "finish"],
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
          expected: ["plan~", "stage+", "task+", "edit+", "finish"],
          found: keyword,
          hint: "keep exactly one patch header at the top",
        },
      );
      recoverRecord(cursor);
      continue;
    }
    try {
      switch (keyword) {
        case "plan~":
          ops.push(parsePlanUpdate(cursor, line));
          continue;
        case "stage+":
          ops.push(parseStageAdd(cursor, line));
          continue;
        case "stage~":
          ops.push(parseStageUpdate(cursor, line));
          continue;
        case "stage-":
          ops.push(parseStageRemove(cursor, line));
          continue;
        case "task+":
          ops.push(parseTaskAdd(cursor, line));
          continue;
        case "task~":
          ops.push(parseTaskUpdate(cursor, line));
          continue;
        case "task-":
          ops.push(parseTaskRemove(cursor, line));
          continue;
        case "edit+":
          ops.push(parseEditAdd(cursor, line));
          continue;
        case "edit~":
          ops.push(parseEditUpdate(cursor, line));
          continue;
        case "edit-":
          ops.push(parseEditRemove(cursor, line));
          continue;
        default:
          report(
            cursor,
            "PLAN_UNKNOWN_FIELD",
            `unknown patch record ${quote(keyword)} on line ${line.number}; expected plan~, stage+|~|-, task+|~|-, edit+|~|-, or a trailing finish`,
            {
              line: line.number,
              expected: [
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
                "finish",
              ],
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
      stage: "task-protocol",
      diagnostics: renderDslIssues([...result.issues]),
    };
  }
  const value = result.value;
  if (value === undefined) {
    return {
      ok: false,
      stage: "task-protocol",
      diagnostics:
        "stage: task-protocol\ncode: PLAN_MISSING_FIELD\nmessage: the reply produced no patch",
    };
  }
  return { ok: true, patch: value };
}
function fenceFor(text: string): string {
  let length = 5;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^-{5,}$/.test(trimmed)) {
      length = Math.max(length, trimmed.length + 1);
    }
  }
  return "-".repeat(length);
}

function pushText(lines: string[], label: string, text: string): void {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized !== "" && !normalized.includes("\n") && normalized === normalized.trim()) {
    lines.push(`${label} ${normalized}`);
    return;
  }
  const fence = fenceFor(normalized);
  lines.push(label, fence, ...normalized.split("\n"), fence);
}

/**
 * Serialize a Plan into the flat DSL. Text is emitted on the label line when
 * that round-trips exactly, otherwise in a fence long enough not to collide
 * with any hyphen-only content line.
 */
export function serializePlanDsl(plan: Plan): string {
  const lines: string[] = [`plan ${quote(plan.id)}`];
  pushText(lines, "goal:", plan.goal);

  for (const stage of plan.stages) {
    lines.push("", `stage ${quote(stage.id)} plan ${quote(plan.id)}`);
    pushText(lines, "goal:", stage.goal);
    lines.push("end");
  }
  for (const stage of plan.stages) {
    for (const task of stage.tasks) {
      lines.push("", `task ${quote(task.id)} stage ${quote(stage.id)} verify ${task.verify}`);
      pushText(lines, "instruction:", task.instruction);
      lines.push("end");
    }
  }
  for (const stage of plan.stages) {
    for (const task of stage.tasks) {
      for (const edit of task.edits) {
        lines.push(
          "",
          `edit ${quote(edit.id)} task ${quote(task.id)} ${editLocWire(edit.action, edit.loc)}`,
        );
        for (const loc of edit.related ?? []) {
          lines.push(`related ${loc.kind} ${loc.symbol} in ${loc.path}`);
        }
        if (edit.renameTo !== undefined) {
          lines.push(`renameTo: ${edit.renameTo}`);
        }
        pushText(lines, "instruction:", edit.instruction);
        lines.push("end");
      }
    }
  }
  return lines.join("\n");
}

function editLocWire(action: TaskAction, loc: TaskLoc): string {
  return action === "write"
    ? `write ${loc.path}`
    : `${action} ${loc.kind} ${loc.symbol} in ${loc.path}`;
}

function pushEditLoc(lines: string[], action: TaskAction, loc: TaskLoc): void {
  lines.push(editLocWire(action, loc));
}

function pushRelated(lines: string[], related: readonly TaskLoc[] | undefined): void {
  for (const loc of related ?? []) {
    lines.push(`related ${loc.kind} ${loc.symbol} in ${loc.path}`);
  }
}

/** Serialize a patch in the strict wire form (`docs/spec.md` §4). */
export function serializePlanPatch(patch: PlanPatch): string {
  const lines: string[] = ["patch"];
  for (const op of patch.ops) {
    switch (op.kind) {
      case "plan-update":
        lines.push(`plan~ ${quote(op.id)}`);
        pushText(lines, "goal:", op.goal);
        break;
      case "stage-add":
        lines.push(`stage+ ${quote(op.id)} plan ${quote(op.plan)}`);
        pushText(lines, "goal:", op.goal);
        break;
      case "stage-update":
        lines.push(`stage~ ${quote(op.id)}`);
        if (op.goal !== undefined) {
          pushText(lines, "goal:", op.goal);
        }
        break;
      case "stage-remove":
        lines.push(`stage- ${quote(op.id)}`);
        break;
      case "task-add":
        lines.push(`task+ ${quote(op.id)} stage ${quote(op.stage)} verify ${op.verify}`);
        pushText(lines, "instruction:", op.instruction);
        break;
      case "task-update":
        lines.push(`task~ ${quote(op.id)}`);
        if (op.verify !== undefined) {
          lines.push(`verify ${op.verify}`);
        }
        if (op.instruction !== undefined) {
          pushText(lines, "instruction:", op.instruction);
        }
        break;
      case "task-remove":
        lines.push(`task- ${quote(op.id)}`);
        break;
      case "edit-add":
        lines.push(
          `edit+ ${quote(op.id)} task ${quote(op.task)} ${editLocWire(op.action, op.loc)}`,
        );
        pushRelated(lines, op.related);
        if (op.renameTo !== undefined) {
          lines.push(`renameTo: ${op.renameTo}`);
        }
        pushText(lines, "instruction:", op.instruction);
        break;
      case "edit-update": {
        lines.push(`edit~ ${quote(op.id)}`);
        if ((op.action === undefined) !== (op.loc === undefined)) {
          throw new Error(
            `edit~ #${op.id} carries only one of action/loc; the patch DSL requires both in one header`,
          );
        }
        if (op.action !== undefined && op.loc !== undefined) {
          pushEditLoc(lines, op.action, op.loc);
        }
        pushRelated(lines, op.related);
        if (op.renameTo !== undefined) {
          lines.push(`renameTo: ${op.renameTo}`);
        }
        if (op.instruction !== undefined) {
          pushText(lines, "instruction:", op.instruction);
        }
        break;
      }
      case "edit-remove":
        lines.push(`edit- ${quote(op.id)}`);
        break;
    }
    lines.push("end");
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
    stages: plan.stages.map((stage) => ({
      id: stage.id,
      goal: stage.goal,
      tasks: stage.tasks.map((task) => ({
        id: task.id,
        verify: task.verify,
        instruction: task.instruction,
        edits: task.edits.map((edit) => ({
          id: edit.id,
          loc: { ...edit.loc },
          action: edit.action,
          instruction: edit.instruction,
          ...(edit.related === undefined
            ? {}
            : { related: edit.related.map((loc) => ({ ...loc })) }),
          ...(edit.renameTo === undefined ? {} : { renameTo: edit.renameTo }),
        })),
      })),
    })),
  };
}

interface FoundTask {
  stage: Stage;
  task: TaskNode;
  index: number;
}

function findTaskNode(plan: Plan, id: NodeId): FoundTask | undefined {
  for (const stage of plan.stages) {
    const index = stage.tasks.findIndex((task) => task.id === id);
    const task = stage.tasks[index];
    if (task !== undefined) {
      return { stage, task, index };
    }
  }
  return undefined;
}

interface FoundEdit {
  task: TaskNode;
  edit: EditNode;
  index: number;
}

function findEditNode(plan: Plan, id: NodeId): FoundEdit | undefined {
  for (const stage of plan.stages) {
    for (const task of stage.tasks) {
      const index = task.edits.findIndex((edit) => edit.id === id);
      const edit = task.edits[index];
      if (edit !== undefined) {
        return { task, edit, index };
      }
    }
  }
  return undefined;
}

function inProgressEdit(previous: TaskRunState, edits: readonly EditNode[]): EditNode | undefined {
  return edits.find((edit) => previous.editStatus.get(edit.id) === "in-progress");
}

function patchTreeFailure(message: string): PlanMerge {
  const code = /does not exist|names plan .*current Plan/.test(message)
    ? "PLAN_UNKNOWN_PARENT"
    : /final task|finish/.test(message)
      ? "PLAN_FINISH_NOT_LAST"
      : "PLAN_STRUCTURE";
  return { ok: false, diagnostics: `stage: task-tree\ncode: ${code}\n- ${message}` };
}

function applyPatchOp(
  previous: TaskRunState,
  plan: Plan,
  op: PlanPatchOp,
): { ok: false; problem: string } | { ok: true } {
  switch (op.kind) {
    case "plan-update": {
      if (op.id !== plan.id) {
        return {
          ok: false,
          problem: `plan~ names plan #${op.id}, but the current Plan is #${plan.id}`,
        };
      }
      plan.goal = op.goal;
      return { ok: true };
    }
    case "stage-add": {
      if (op.plan !== plan.id) {
        return {
          ok: false,
          problem: `stage+ #${op.id} names plan #${op.plan}, but the current Plan is #${plan.id}`,
        };
      }
      plan.stages.push({ id: op.id, goal: op.goal, tasks: [] });
      return { ok: true };
    }
    case "stage-update": {
      const stage = plan.stages.find((candidate) => candidate.id === op.id);
      if (stage === undefined) {
        return { ok: false, problem: `stage~ names stage #${op.id}, which does not exist` };
      }
      if (op.goal !== undefined) {
        stage.goal = op.goal;
      }
      return { ok: true };
    }
    case "stage-remove": {
      const index = plan.stages.findIndex((stage) => stage.id === op.id);
      const stage = plan.stages[index];
      if (stage === undefined) {
        return { ok: false, problem: `stage- names stage #${op.id}, which does not exist` };
      }
      const busy = inProgressEdit(
        previous,
        stage.tasks.flatMap((task) => task.edits),
      );
      if (busy !== undefined) {
        return {
          ok: false,
          problem: `stage- #${op.id} contains in-progress edit #${busy.id}; wait for it to finish before removing the stage`,
        };
      }
      plan.stages.splice(index, 1);
      return { ok: true };
    }
    case "task-add": {
      const stage = plan.stages.find((candidate) => candidate.id === op.stage);
      if (stage === undefined) {
        return {
          ok: false,
          problem: `task+ #${op.id} names stage #${op.stage}, which does not exist`,
        };
      }
      stage.tasks.push({ id: op.id, verify: op.verify, instruction: op.instruction, edits: [] });
      return { ok: true };
    }
    case "task-update": {
      const found = findTaskNode(plan, op.id);
      if (found === undefined) {
        return { ok: false, problem: `task~ names task #${op.id}, which does not exist` };
      }
      if (op.verify !== undefined) {
        found.task.verify = op.verify;
      }
      if (op.instruction !== undefined) {
        found.task.instruction = op.instruction;
      }
      return { ok: true };
    }
    case "task-remove": {
      const found = findTaskNode(plan, op.id);
      if (found === undefined) {
        return { ok: false, problem: `task- names task #${op.id}, which does not exist` };
      }
      const busy = inProgressEdit(previous, found.task.edits);
      if (busy !== undefined) {
        return {
          ok: false,
          problem: `task- #${op.id} contains in-progress edit #${busy.id}; wait for it to finish before removing the task`,
        };
      }
      found.stage.tasks.splice(found.index, 1);
      return { ok: true };
    }
    case "edit-add": {
      const found = findTaskNode(plan, op.task);
      if (found === undefined) {
        return {
          ok: false,
          problem: `edit+ #${op.id} names task #${op.task}, which does not exist`,
        };
      }
      found.task.edits.push({
        id: op.id,
        loc: { ...op.loc },
        action: op.action,
        instruction: op.instruction,
        ...(op.related === undefined ? {} : { related: op.related.map((loc) => ({ ...loc })) }),
        ...(op.renameTo === undefined ? {} : { renameTo: op.renameTo }),
      });
      return { ok: true };
    }
    case "edit-update": {
      const found = findEditNode(plan, op.id);
      if (found === undefined) {
        return { ok: false, problem: `edit~ names edit #${op.id}, which does not exist` };
      }
      if (op.loc !== undefined) {
        found.edit.loc = { ...op.loc };
      }
      if (op.action !== undefined) {
        found.edit.action = op.action;
      }
      if (op.related !== undefined) {
        found.edit.related = op.related.map((loc) => ({ ...loc }));
      }
      if (op.renameTo !== undefined) {
        found.edit.renameTo = op.renameTo;
      }
      if (op.instruction !== undefined) {
        found.edit.instruction = op.instruction;
      }
      return { ok: true };
    }
    case "edit-remove": {
      const found = findEditNode(plan, op.id);
      if (found === undefined) {
        return { ok: false, problem: `edit- names edit #${op.id}, which does not exist` };
      }
      if (previous.editStatus.get(op.id) === "in-progress") {
        return {
          ok: false,
          problem: `edit- #${op.id} is in-progress; wait for it to finish before removing it`,
        };
      }
      found.task.edits.splice(found.index, 1);
      return { ok: true };
    }
  }
}

/**
 * Apply a parsed patch to a clone of the current tree, then run the same merge
 * validation as a full re-plan. The clone is local, so a rejected op or merge
 * leaves `previous` untouched.
 *
 * `finish` moves `finalTaskId` to the new last task; without `finish` the
 * previous final task must remain last (an in-place repair). Appending work
 * after it therefore needs a new `finish` on the new final test task.
 */
export function applyPlanPatch(previous: TaskRunState, patch: PlanPatch): PlanMerge {
  const nextPlan = clonePlan(previous.plan);
  for (const op of patch.ops) {
    const applied = applyPatchOp(previous, nextPlan, op);
    if (!applied.ok) {
      return patchTreeFailure(applied.problem);
    }
  }

  const merged = mergeReplan(previous, nextPlan);
  if (!merged.ok) {
    return merged;
  }

  const last = finalTask(nextPlan.stages);
  let finalTaskId: NodeId | null;
  if (patch.finish) {
    if (last === undefined) {
      return patchTreeFailure("finish needs at least one task in the merged tree");
    }
    if (last.verify !== "test") {
      return patchTreeFailure(
        `finish marks task #${last.id}, but it verifies "${last.verify}"; the final task must verify "test"`,
      );
    }
    finalTaskId = last.id;
  } else if (previous.finalTaskId !== null) {
    if (last === undefined || last.id !== previous.finalTaskId) {
      const now =
        last === undefined
          ? "the merged tree has no last task"
          : `the new last task is #${last.id}`;
      return patchTreeFailure(
        `the final task #${previous.finalTaskId} is no longer last (${now}); append a final "test" task and emit finish so finalTaskId moves`,
      );
    }
    finalTaskId = previous.finalTaskId;
  } else {
    finalTaskId = null;
  }

  return { ok: true, state: { ...merged.state, finalTaskId } };
}
