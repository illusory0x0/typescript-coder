// Shared scenario contract, scripted provider, and assertions. Scenarios
// themselves live in `offline/` or `live/`; this module does not pick a lane.
import { cpSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMode, LoopResult, ProviderLike } from "@tc/harness/loop";
import { serializeSelections } from "@tc/typescript-editor/selection";
import type { Selection } from "@tc/typescript-editor/selection";
import type { ChatMessage, ChatResponse, ToolDefinition } from "@tc/harness/openai";

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
  /** Loop shape; omitted means the single-target pinned-repair loop. */
  agentMode?: AgentMode;
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

export const ADDRESS = { path: "src/helper.ts", symbol: "answer", kind: "function" };

export function selection(
  locator: { path: string; symbol: string; kind: string },
  replacement: string | null,
  matcher: string | null = null,
): Selection {
  return {
    locator: { path: locator.path, name: locator.symbol, kind: locator.kind },
    space: null,
    matcher: matcher === null ? null : { kind: "snippet", value: matcher },
    pick: null,
    replacement,
  };
}

export function editDslReply(
  matcher: string | null,
  replacement: string,
  address: { path: string; symbol: string; kind: string } = ADDRESS,
): string {
  return serializeSelections([selection(address, replacement, matcher)]);
}

export const TEST_ISSUE = "make the failing test pass";

export const EDIT_DSL_VIEWER = serializeSelections([selection(ADDRESS, null)]);
export const EDIT_DSL_PICK_EDIT = editDslReply("return 1;", "return 2;");
export const EDIT_DSL_CONFIRMATION = "Great! I resolve this problem!";
export const EDIT_DSL_RENAME_SELECT = serializeSelections([selection(ADDRESS, null)]);
export const EDIT_DSL_RENAME_EDIT = serializeSelections([
  {
    ...selection(ADDRESS, null),
    rename: { from: "answer", to: "result" },
  },
]);
