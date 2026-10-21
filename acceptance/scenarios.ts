import { cpSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoopResult, ProtocolFormat, ProviderLike } from "../src/loop";
import type { ChatMessage, ChatResponse, ToolDefinition } from "../src/openai";

export interface ScriptedToolCall {
  toolCall: { name: string; arguments: string };
}

export type ScriptedResponse = string | ScriptedToolCall;

export class ScriptedProvider implements ProviderLike {
  readonly calls: ChatMessage[][] = [];

  constructor(private readonly responses: ScriptedResponse[]) {}

  async chat(
    messages: ChatMessage[],
    _tools?: ToolDefinition[],
    _options?: { temperature?: number },
  ): Promise<ChatResponse> {
    this.calls.push(structuredClone(messages));
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("no scripted response left");
    }
    if (typeof response === "string") {
      return { content: response, toolCalls: [], finishReason: "stop", raw: {} };
    }
    return {
      content: null,
      toolCalls: [{ id: "call-1", type: "function", function: response.toolCall }],
      finishReason: "tool_calls",
      raw: {},
    };
  }
}

export interface ScenarioArtifacts {
  dir: string;
  result: LoopResult;
  provider: ProviderLike;
  /** Captured provider calls; only recorded for scripted scenarios. */
  calls?: ChatMessage[][];
  originals: Map<string, string>;
  finals: Map<string, string>;
}

export interface ScenarioAssertion {
  name: string;
  check: (artifacts: ScenarioArtifacts) => { ok: boolean; detail?: string };
}

export interface Scenario {
  id: string;
  title: string;
  fixture: string | null;
  slow?: boolean;
  /** Live scenarios call the real model and run only with --live. */
  live?: boolean;
  /** Edit protocol the scenario drives; omitted means the shipped `json` form. */
  protocolFormat?: ProtocolFormat;
  issue: string;
  responses: ScriptedResponse[];
  prepare?: (dir: string, repoRoot: string) => void;
  assertions: ScenarioAssertion[];
}

function truncate(text: string, limit = 200): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function hasOk(expected: boolean): ScenarioAssertion {
  return {
    name: `result.ok is ${expected}`,
    check: ({ result }) =>
      result.ok === expected
        ? { ok: true }
        : { ok: false, detail: `expected ok=${expected} but got ok=${result.ok}` },
  };
}

export function hasRecords(expectedCount: number): ScenarioAssertion {
  return {
    name: `records count is ${expectedCount}`,
    check: ({ result }) =>
      result.records.length === expectedCount
        ? { ok: true }
        : {
            ok: false,
            detail: `expected ${expectedCount} records but got ${result.records.length}`,
          },
  };
}

export function recordOutcomes(expected: string[]): ScenarioAssertion {
  return {
    name: `record outcomes are ${JSON.stringify(expected)}`,
    check: ({ result }) => {
      const actual = result.records.map((record) => record.outcome);
      if (JSON.stringify(actual) === JSON.stringify(expected)) {
        return { ok: true };
      }
      return {
        ok: false,
        detail: `expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
      };
    },
  };
}

export function hasTerminationReason(expected: string): ScenarioAssertion {
  return {
    name: `termination reason is ${JSON.stringify(expected)}`,
    check: ({ result }) =>
      result.terminationReason === expected
        ? { ok: true }
        : {
            ok: false,
            detail: `expected termination reason ${JSON.stringify(expected)} but got ${JSON.stringify(result.terminationReason)}`,
          },
  };
}

export function someRecordDiagnosticsContain(needle: string): ScenarioAssertion {
  return {
    name: `some record diagnostics contain ${JSON.stringify(needle)}`,
    check: ({ result }) => {
      const match = result.records.find(
        (record) => record.diagnostics !== null && record.diagnostics.includes(needle),
      );
      if (match !== undefined) {
        return { ok: true };
      }
      return {
        ok: false,
        detail: `no record diagnostics contain ${JSON.stringify(needle)}`,
      };
    },
  };
}

export function hasCallCount(expected: number): ScenarioAssertion {
  return {
    name: `provider call count is ${expected}`,
    check: ({ calls }) => {
      if (calls === undefined) {
        return { ok: false, detail: "provider calls are not captured for this scenario" };
      }
      if (calls.length === expected) {
        return { ok: true };
      }
      return {
        ok: false,
        detail: `expected ${expected} provider calls but got ${calls.length}`,
      };
    },
  };
}

export function fileContains(relPath: string, needle: string): ScenarioAssertion {
  return {
    name: `${relPath} contains ${JSON.stringify(needle)}`,
    check: ({ finals }) => {
      const content = finals.get(relPath);
      if (content === undefined) {
        return { ok: false, detail: `no final content recorded for ${relPath}` };
      }
      if (content.includes(needle)) {
        return { ok: true };
      }
      return {
        ok: false,
        detail: `${relPath} does not contain ${JSON.stringify(needle)}; actual: ${truncate(content)}`,
      };
    },
  };
}

export function fileEqualsOriginal(relPath: string): ScenarioAssertion {
  return {
    name: `${relPath} matches its original contents`,
    check: ({ originals, finals }) => {
      const original = originals.get(relPath);
      if (original === undefined) {
        return { ok: false, detail: `no original content recorded for ${relPath}` };
      }
      const final = finals.get(relPath);
      if (final === undefined) {
        return { ok: false, detail: `no final content recorded for ${relPath}` };
      }
      if (final === original) {
        return { ok: true };
      }
      return {
        ok: false,
        detail: `${relPath} changed; expected original ${JSON.stringify(original)} but got ${JSON.stringify(final)}`,
      };
    },
  };
}

export function fileDiffersFromOriginal(relPath: string): ScenarioAssertion {
  return {
    name: `${relPath} differs from its original contents`,
    check: ({ originals, finals }) => {
      const original = originals.get(relPath);
      if (original === undefined) {
        return { ok: false, detail: `no original content recorded for ${relPath}` };
      }
      const final = finals.get(relPath);
      if (final === undefined) {
        return { ok: false, detail: `no final content recorded for ${relPath}` };
      }
      if (final !== original) {
        return { ok: true };
      }
      return { ok: false, detail: `${relPath} was not modified` };
    },
  };
}

export function fileEquals(relPath: string, expected: string): ScenarioAssertion {
  return {
    name: `${relPath} equals ${JSON.stringify(expected)}`,
    check: ({ finals }) => {
      const final = finals.get(relPath);
      if (final === undefined) {
        return { ok: false, detail: `no final content recorded for ${relPath}` };
      }
      if (final === expected) {
        return { ok: true };
      }
      return {
        ok: false,
        detail: `${relPath} is ${JSON.stringify(final)} but expected ${JSON.stringify(expected)}`,
      };
    },
  };
}

export function messageContains(callIndex: number, needle: string): ScenarioAssertion {
  return {
    name: `call ${callIndex} last message contains ${JSON.stringify(needle)}`,
    check: ({ calls }) => {
      if (calls === undefined) {
        return { ok: false, detail: "provider calls are not captured for this scenario" };
      }
      const call = calls[callIndex];
      if (call === undefined) {
        return { ok: false, detail: `no provider call at index ${callIndex}` };
      }
      const last = call[call.length - 1];
      const content = last?.content ?? "";
      if (content.includes(needle)) {
        return { ok: true };
      }
      return {
        ok: false,
        detail: `last message of call ${callIndex} does not contain ${JSON.stringify(needle)}; actual: ${truncate(content)}`,
      };
    },
  };
}

export function explanationEquals(expected: string): ScenarioAssertion {
  return {
    name: `explanation equals ${JSON.stringify(expected)}`,
    check: ({ result }) =>
      result.explanation === expected
        ? { ok: true }
        : {
            ok: false,
            detail: `expected explanation ${JSON.stringify(expected)} but got ${JSON.stringify(result.explanation)}`,
          },
  };
}

export function explanationIsNull(): ScenarioAssertion {
  return {
    name: "explanation is null",
    check: ({ result }) =>
      result.explanation === null
        ? { ok: true }
        : {
            ok: false,
            detail: `expected explanation to be null but got ${JSON.stringify(result.explanation)}`,
          },
  };
}

export function diagnosticsContains(needle: string): ScenarioAssertion {
  return {
    name: `diagnostics contain ${JSON.stringify(needle)}`,
    check: ({ result }) => {
      const diagnostics = result.diagnostics ?? "";
      if (diagnostics.includes(needle)) {
        return { ok: true };
      }
      return {
        ok: false,
        detail: `diagnostics do not contain ${JSON.stringify(needle)}; actual: ${truncate(diagnostics)}`,
      };
    },
  };
}

const ADDRESS = { path: "src/helper.ts", symbol: "answer", kind: "function" };

// A v2 edit payload: one flat object with the pinned address, an optional
// matcher, and the replacement.
function editResponse(
  matcher: string | null,
  replacement: string,
  address: { path: string; symbol: string; kind: string } = ADDRESS,
): string {
  const payload: Record<string, string> = { ...address };
  if (matcher !== null) {
    payload["matcher"] = matcher;
  }
  payload["replacement"] = replacement;
  return JSON.stringify(payload);
}

const LOCATOR_JSON = JSON.stringify(ADDRESS);
const BAD_EDIT = editResponse("return 1;", 'return "no";');
const RECOVER_EDIT = editResponse('return "no";', "return 2;");
const TEST_PROPAGATION_EDIT = editResponse("return 1;", "return 3;");
const TEST_PROPAGATION_RECOVER_EDIT = editResponse("return 3;", "return 2;");
const GOOD_EDIT = editResponse("return 1;", "return 2;");
const TEST_ISSUE = "make the failing test pass";

// A compact select-first viewer (`resolve value`, no `replace`) and a
// `match` + whole-line `pick 2` editor with a six-tick fence, mirroring the §8
// examples the model sees. Multi-line replies are assembled from arrays for
// readability.
const COMPACT_VIEWER = ["select answer in src/helper.ts resolve value", "end"].join("\n");
const COMPACT_PICK_EDIT = [
  "select answer in src/helper.ts resolve value",
  "match `return 1;`",
  "pick 2",
  "replace with",
  "``````",
  "return 2;",
  "``````",
  "end",
].join("\n");
const COMPACT_CONFIRMATION = "Great! I resolve this problem!";

export const scenarios: Scenario[] = [
  {
    id: "fix-answer",
    title: "failing test becomes green",
    fixture: "fix-answer",
    protocolFormat: "json",
    issue: TEST_ISSUE,
    responses: [LOCATOR_JSON, GOOD_EDIT],
    assertions: [
      hasOk(true),
      hasRecords(3),
      recordOutcomes(["selected", "applied", "ok"]),
      fileContains("src/helper.ts", "return 2;"),
      fileEqualsOriginal("src/helper.test.ts"),
    ],
  },
  {
    id: "compact-viewer-edit",
    title: "compact select viewer opens details then an edit lands",
    fixture: "fix-answer",
    issue: TEST_ISSUE,
    protocolFormat: "compact",
    responses: [COMPACT_VIEWER, COMPACT_PICK_EDIT, COMPACT_CONFIRMATION],
    assertions: [
      hasOk(true),
      hasRecords(4),
      recordOutcomes(["selected", "applied", "ok", "confirmed"]),
      messageContains(1, "# details"),
      messageContains(1, "1 | export function answer(): number {"),
      messageContains(2, "# modified text"),
      messageContains(2, "2 |   return 2;"),
      fileContains("src/helper.ts", "return 2;"),
      fileEqualsOriginal("src/helper.test.ts"),
    ],
  },
  {
    id: "live-fix-answer",
    title: "real model makes the failing test pass",
    fixture: "fix-answer",
    live: true,
    protocolFormat: "json",
    issue: TEST_ISSUE,
    responses: [],
    assertions: [
      hasOk(true),
      explanationIsNull(),
      fileDiffersFromOriginal("src/helper.ts"),
      fileEqualsOriginal("src/helper.test.ts"),
    ],
  },
  {
    id: "keep-progress-retry",
    title: "type-invalid replacement stays on disk and the next iteration builds on it",
    fixture: "keep-progress-retry",
    protocolFormat: "json",
    issue: TEST_ISSUE,
    responses: [LOCATOR_JSON, BAD_EDIT, RECOVER_EDIT],
    assertions: [
      hasOk(true),
      hasRecords(5),
      recordOutcomes(["selected", "applied", "tsc", "applied", "ok"]),
      hasCallCount(3),
      messageContains(2, "not assignable"),
      fileContains("src/helper.ts", "return 2;"),
    ],
  },
  {
    id: "persistent-failure",
    title: "a failed verification plus an exhausted Edit round ends with one summary after STOP",
    fixture: "persistent-failure",
    protocolFormat: "json",
    issue: TEST_ISSUE,
    responses: [
      LOCATOR_JSON,
      BAD_EDIT,
      "not json",
      "not json",
      "not json",
      "STOP",
      "The replacement could not satisfy the type checker; the next step is to review the return type.",
    ],
    assertions: [
      hasOk(false),
      hasRecords(7),
      recordOutcomes(["selected", "applied", "tsc", "protocol", "protocol", "protocol", "stopped"]),
      hasTerminationReason("edit-exhausted"),
      hasCallCount(7),
      messageContains(6, "The run is over"),
      explanationEquals(
        "The replacement could not satisfy the type checker; the next step is to review the return type.",
      ),
      fileContains("src/helper.ts", 'return "no";'),
      someRecordDiagnosticsContain("not assignable"),
      diagnosticsContains("edit-exhausted"),
    ],
  },
  {
    id: "context-correctness",
    title: "context YAML exposes dotted signatures",
    fixture: "context-correctness",
    protocolFormat: "json",
    issue: TEST_ISSUE,
    responses: [
      '{"path":"src/lexer.ts","symbol":"lexer.make","kind":"function"}',
      editResponse("return 1;", "return 10;", {
        path: "src/lexer.ts",
        symbol: "lexer.make",
        kind: "function",
      }),
    ],
    assertions: [
      hasOk(true),
      hasRecords(3),
      hasCallCount(2),
      {
        name: "context yaml exposes the dotted signature",
        check: ({ calls }) => {
          if (calls === undefined) {
            return { ok: false, detail: "provider calls are not captured for this scenario" };
          }
          const call = calls[0];
          if (call === undefined) {
            return { ok: false, detail: "no provider call at index 0" };
          }
          const message = call[1];
          if (message === undefined) {
            return { ok: false, detail: "provider call 0 has no second message" };
          }
          const content = message.content ?? "";
          const needles = [
            "```yaml",
            'name: "lexer.make"',
            'kind: "function"',
            'signature: "function make(): number"',
          ];
          const missing = needles.filter((needle) => !content.includes(needle));
          if (missing.length === 0) {
            return { ok: true };
          }
          return {
            ok: false,
            detail: `provider call 0 second message is missing ${missing
              .map((needle) => JSON.stringify(needle))
              .join(", ")}; actual: ${truncate(content)}`,
          };
        },
      },
      fileContains("src/lexer.ts", "return 10;"),
    ],
  },
  {
    id: "check-test-propagation",
    title: "test-only failure feeds back diagnostics",
    fixture: "check-test-propagation",
    protocolFormat: "json",
    issue: TEST_ISSUE,
    responses: [LOCATOR_JSON, TEST_PROPAGATION_EDIT, TEST_PROPAGATION_RECOVER_EDIT],
    assertions: [
      hasOk(true),
      hasRecords(5),
      recordOutcomes(["selected", "applied", "tests", "applied", "ok"]),
      hasCallCount(3),
      messageContains(2, "tests failed:"),
      fileContains("src/helper.ts", "return 2;"),
    ],
  },
  {
    id: "self-host",
    title: "agent edits its own sources and the copied suite stays green",
    fixture: null,
    slow: true,
    protocolFormat: "json",
    issue:
      "Rewrite greet to store the greeting in a local variable, keeping its behavior identical.",
    prepare: (dir: string, repoRoot: string) => {
      cpSync(join(repoRoot, "src"), join(dir, "src"), { recursive: true });
      cpSync(join(repoRoot, "tsconfig.json"), join(dir, "tsconfig.json"));
      symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
      writeFileSync(join(dir, ".nested-smoke"), "acceptance self-host copy\n");
    },
    responses: [
      '{"path":"src/index.ts","symbol":"greet","kind":"function"}',
      editResponse(
        "function greet(subject: string): string {\n  return `hello, ${subject}`;\n}",
        "function greet(subject: string): string {\n  const greeting = `hello, ${subject}`;\n  return greeting;\n}",
        { path: "src/index.ts", symbol: "greet", kind: "function" },
      ),
    ],
    assertions: [hasOk(true), fileContains("src/index.ts", "const greeting")],
  },
];
