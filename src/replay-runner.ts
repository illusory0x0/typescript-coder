import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { runLoop } from "./loop";
import { REPLAY_BUNDLE_FORMAT } from "./replay-format";
import type { LoopResult, ProviderLike } from "./loop";
import type { ReplayBundle, ReplayCall } from "./replay-format";
import type { ChatMessage, ChatResponse, ToolCall, ToolDefinition } from "./openai";

const SUMMARY_LIMIT = 200;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReplayCall(value: unknown): value is ReplayCall {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Array.isArray(value["messages"]) &&
    (value["content"] === null || typeof value["content"] === "string") &&
    Array.isArray(value["toolCalls"]) &&
    (value["finishReason"] === null || typeof value["finishReason"] === "string") &&
    "usage" in value
  );
}

// Only the fields the runner relies on are validated; recorded messages are
// compared against live requests but never trusted as prompt text.
export function parseReplayBundle(json: string): ReplayBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`replay bundle is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("replay bundle is not a JSON object");
  }
  if (parsed["format"] !== REPLAY_BUNDLE_FORMAT) {
    throw new Error(
      `unsupported replay bundle format: ${JSON.stringify(parsed["format"])} (expected "${REPLAY_BUNDLE_FORMAT}")`,
    );
  }
  if (parsed["side"] !== "tc" && parsed["side"] !== "ts") {
    throw new Error(
      `unsupported replay bundle side: ${JSON.stringify(parsed["side"])} (expected "tc")`,
    );
  }
  const task = parsed["task"];
  const model = parsed["model"];
  const issue = parsed["issue"];
  const fixture = parsed["fixture"];
  const rep = parsed["rep"];
  if (
    typeof task !== "string" ||
    typeof model !== "string" ||
    typeof issue !== "string" ||
    typeof fixture !== "string"
  ) {
    throw new Error("replay bundle must carry string task, model, issue, and fixture fields");
  }
  if (typeof rep !== "number" || !Number.isFinite(rep)) {
    throw new Error("replay bundle must carry a numeric rep field");
  }
  const calls = parsed["calls"];
  if (!Array.isArray(calls) || !calls.every(isReplayCall)) {
    throw new Error("replay bundle calls must be an array of recorded calls");
  }
  // Backward compatibility: @1 bundles recorded before the protocol field are
  // JSON; `compact` is the deprecated legacy name for `edit-dsl` and is
  // normalized on read; unknown values also replay as JSON rather than failing.
  const protocolFormat: ReplayBundle["protocolFormat"] =
    parsed["protocolFormat"] === "edit-dsl" || parsed["protocolFormat"] === "compact"
      ? "edit-dsl"
      : "json";
  return {
    format: REPLAY_BUNDLE_FORMAT,
    side: "tc",
    task,
    rep,
    model,
    issue,
    fixture,
    protocolFormat,
    calls,
  };
}

function toolCallsEqual(
  left: readonly ToolCall[] | undefined,
  right: readonly ToolCall[] | undefined,
): boolean {
  const leftCalls = left ?? [];
  const rightCalls = right ?? [];
  if (leftCalls.length !== rightCalls.length) {
    return false;
  }
  for (let index = 0; index < leftCalls.length; index += 1) {
    const leftCall = leftCalls[index];
    const rightCall = rightCalls[index];
    if (leftCall === undefined || rightCall === undefined) {
      return false;
    }
    if (
      leftCall.id !== rightCall.id ||
      leftCall.type !== rightCall.type ||
      leftCall.function.name !== rightCall.function.name ||
      leftCall.function.arguments !== rightCall.function.arguments
    ) {
      return false;
    }
  }
  return true;
}

function messagesEqual(left: readonly ChatMessage[], right: readonly ChatMessage[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const message = left[index];
    const recorded = right[index];
    if (message === undefined || recorded === undefined) {
      return false;
    }
    if (
      message.role !== recorded.role ||
      message.content !== recorded.content ||
      (message.toolCallId ?? null) !== (recorded.toolCallId ?? null) ||
      (message.name ?? null) !== (recorded.name ?? null)
    ) {
      return false;
    }
    if (!toolCallsEqual(message.toolCalls, recorded.toolCalls)) {
      return false;
    }
  }
  return true;
}

export class ReplayProvider implements ProviderLike {
  callsConsumed = 0;
  readonly mismatchedCalls: number[] = [];
  exhaustion: string | null = null;
  readonly #calls: readonly ReplayCall[];

  constructor(calls: readonly ReplayCall[]) {
    this.#calls = calls;
  }

  async chat(
    messages: ChatMessage[],
    _tools?: ToolDefinition[],
    _options?: { temperature?: number },
  ): Promise<ChatResponse> {
    const call = this.#calls[this.callsConsumed];
    if (call === undefined) {
      this.exhaustion ??= `bundle exhausted after ${this.callsConsumed} call(s)`;
      throw new Error(`bundle exhausted after ${this.callsConsumed} call(s)`);
    }
    const callNumber = this.callsConsumed + 1;
    if (!messagesEqual(messages, call.messages)) {
      this.mismatchedCalls.push(callNumber);
    }
    this.callsConsumed = callNumber;
    return {
      content: call.content,
      toolCalls: call.toolCalls,
      finishReason: call.finishReason,
      raw: { usage: call.usage },
    };
  }
}

export interface ReplayRunOptions {
  readonly bundle: ReplayBundle;
  readonly bundlePath: string;
  readonly repoRoot: string;
  readonly tscBin: string;
  readonly keep?: boolean;
}

export interface ReplayRun {
  readonly bundle: ReplayBundle;
  readonly bundlePath: string;
  readonly workspace: string;
  readonly kept: boolean;
  readonly callsConsumed: number;
  readonly callsTotal: number;
  readonly exhaustion: string | null;
  readonly promptMismatches: readonly number[];
  readonly result: LoopResult;
}

function replayStamp(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export async function runReplay(options: ReplayRunOptions): Promise<ReplayRun> {
  const provider = new ReplayProvider(options.bundle.calls);
  const workspace = join(options.repoRoot, "tmp", "replay", replayStamp());
  try {
    mkdirSync(dirname(workspace), { recursive: true });
    cpSync(join(options.repoRoot, options.bundle.fixture), workspace, { recursive: true });
    const result = await runLoop({
      cwd: workspace,
      issue: options.bundle.issue,
      provider,
      temperature: 0,
      // Replay under the protocol recorded in the bundle; legacy/unknown
      // bundles normalized to JSON in `parseReplayBundle`.
      protocolFormat: options.bundle.protocolFormat,
      checkCommand: ["bun", options.tscBin, "--noEmit"],
      testCommand: ["bun", "test"],
    });
    return {
      bundle: options.bundle,
      bundlePath: options.bundlePath,
      workspace,
      kept: options.keep === true,
      callsConsumed: provider.callsConsumed,
      callsTotal: options.bundle.calls.length,
      exhaustion: provider.exhaustion,
      promptMismatches: provider.mismatchedCalls,
      result,
    };
  } finally {
    if (options.keep !== true) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}

function oneLine(text: string, limit = SUMMARY_LIMIT): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

export function summarizeReplay(run: ReplayRun): string {
  const { bundle, result } = run;
  const lines = [
    `bundle: ${run.bundlePath}`,
    `task: ${bundle.task} rep ${bundle.rep} model: ${bundle.model}`,
    `fixture: ${bundle.fixture}`,
    `result: ${result.ok ? "ok" : "fail"}`,
    `mode: ${result.mode ?? "none"}`,
    `filePath: ${result.filePath ?? "none"}`,
    `calls: ${run.callsConsumed}/${run.callsTotal}`,
  ];
  if (run.exhaustion !== null) {
    lines.push(`exhaustion: ${run.exhaustion}`);
  }
  lines.push(
    `prompt mismatches: ${
      run.promptMismatches.length === 0
        ? "none"
        : run.promptMismatches.map((callNumber) => `call ${callNumber}`).join(", ")
    }`,
  );
  if (result.terminationReason !== undefined) {
    lines.push(`termination: ${result.terminationReason}`);
  }
  if (result.records.length === 0) {
    lines.push("records: none");
  }
  for (const record of result.records) {
    lines.push(
      `record ${record.row}: kind=${record.kind} outcome=${record.outcome} exchange=${
        record.exchange ?? "-"
      } diagnostics=${record.diagnosticsHead ?? "none"}`,
    );
  }
  if (!result.ok) {
    lines.push(`stopped: ${result.diagnostics === null ? "unknown" : oneLine(result.diagnostics)}`);
  }
  return `${lines.join("\n")}\n`;
}
