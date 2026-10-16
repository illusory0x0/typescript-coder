import { cpSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoopResult, ProviderLike } from "../src/loop";
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
  issue: string;
  maxRetries?: number;
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

export function hasAttempts(expectedCount: number): ScenarioAssertion {
  return {
    name: `attempts count is ${expectedCount}`,
    check: ({ result }) =>
      result.attempts.length === expectedCount
        ? { ok: true }
        : {
            ok: false,
            detail: `expected ${expectedCount} attempts but got ${result.attempts.length}`,
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

const LOCATOR_JSON = '{"path":"src/helper.ts","name":"answer","kind":"function"}';
const BAD_REPLACEMENT = 'function answer(): number {\n  return "no";\n}';
const GOOD_REPLACEMENT = "function answer(): number {\n  return 2;\n}";
const TEST_ISSUE = "make the failing test pass";

export const scenarios: Scenario[] = [
  {
    id: "fix-answer",
    title: "failing test becomes green",
    fixture: "fix-answer",
    issue: TEST_ISSUE,
    responses: [LOCATOR_JSON, GOOD_REPLACEMENT],
    assertions: [
      hasOk(true),
      hasAttempts(1),
      fileContains("src/helper.ts", "return 2;"),
      fileEqualsOriginal("src/helper.test.ts"),
    ],
  },
  {
    id: "live-fix-answer",
    title: "real model makes the failing test pass",
    fixture: "fix-answer",
    live: true,
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
    id: "rollback-retry",
    title: "type-invalid replacement rolls back and retries",
    fixture: "rollback-retry",
    issue: TEST_ISSUE,
    responses: [LOCATOR_JSON, BAD_REPLACEMENT, GOOD_REPLACEMENT],
    assertions: [
      hasOk(true),
      hasAttempts(2),
      hasCallCount(3),
      messageContains(2, "not assignable"),
      fileContains("src/helper.ts", "return 2;"),
    ],
  },
  {
    id: "persistent-failure",
    title: "exhausted retries restore the file and explain",
    fixture: "persistent-failure",
    issue: TEST_ISSUE,
    responses: [
      LOCATOR_JSON,
      BAD_REPLACEMENT,
      BAD_REPLACEMENT,
      BAD_REPLACEMENT,
      "The replacement could not satisfy the type checker; the next step is to review the return type.",
    ],
    assertions: [
      hasOk(false),
      hasAttempts(3),
      hasCallCount(5),
      explanationEquals(
        "The replacement could not satisfy the type checker; the next step is to review the return type.",
      ),
      fileEqualsOriginal("src/helper.ts"),
      diagnosticsContains("not assignable"),
    ],
  },
  {
    id: "context-correctness",
    title: "context YAML exposes dotted signatures",
    fixture: "context-correctness",
    issue: TEST_ISSUE,
    responses: [
      '{"path":"src/lexer.ts","name":"lexer.make","kind":"function"}',
      "function make(): number {\n  return 10;\n}",
    ],
    assertions: [
      hasOk(true),
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
    issue: TEST_ISSUE,
    responses: [LOCATOR_JSON, "function answer(): number {\n  return 3;\n}", GOOD_REPLACEMENT],
    assertions: [
      hasOk(true),
      hasAttempts(2),
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
    issue:
      "Rewrite greet to store the greeting in a local variable, keeping its behavior identical.",
    prepare: (dir: string, repoRoot: string) => {
      cpSync(join(repoRoot, "src"), join(dir, "src"), { recursive: true });
      cpSync(join(repoRoot, "tsconfig.json"), join(dir, "tsconfig.json"));
      symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
      writeFileSync(join(dir, ".nested-smoke"), "acceptance self-host copy\n");
    },
    responses: [
      '{"path":"src/index.ts","name":"greet","kind":"function"}',
      "function greet(subject: string): string {\n  const greeting = `hello, ${subject}`;\n  return greeting;\n}",
    ],
    assertions: [hasOk(true), fileContains("src/index.ts", "const greeting")],
  },
];
