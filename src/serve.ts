import { runMain } from "./main";
import { buildSubagentResult, serializeSubagentResult } from "./result";
import type { MainIo } from "./main";
import type { LoopResult, ProviderLike, ProtocolFormat } from "./loop";
import type { SubagentResult } from "./result";
import type { Locator } from "./utility";

/**
 * Interactive mode (#104): a persistent process speaks one line-delimited JSON
 * request per stdin line and answers each run with exactly one
 * `typescript-coder-result@1` result line on stdout. Diagnostics and progress
 * go to stderr; stdout carries only result/ack lines.
 */

/** Versioned contract of the `--serve` ack line. */
export const SERVE_FORMAT = "typescript-coder-serve@1";

/** Defaults taken from the CLI flags; a request field overrides its default. */
export interface ServeDefaults {
  cwd: string;
  tokenBudget?: number;
  checkCommand?: string[];
  testCommand?: string[];
  commandTimeoutMs?: number;
  multiPayload?: boolean;
  protocolFormat?: ProtocolFormat;
  targets?: Locator[];
}

export interface ServeOptions {
  /** The request lines, one per element (blank lines are skipped). */
  lines: AsyncIterable<string>;
  /** Response sink: one result/ack line per request. */
  out: (line: string) => void;
  /** Diagnostics/progress sink; never carries the result. */
  err: (line: string) => void;
  /** One provider for the whole process, built once by the caller. */
  provider: ProviderLike;
  defaults: ServeDefaults;
}

/** A malformed or invalid request, reported as a failed result, not a crash. */
export class RequestError extends Error {}

interface RunRequest {
  issue: string;
  cwd?: string;
  targets?: Locator[];
  tokenBudget?: number;
  checkCommand?: string[];
  testCommand?: string[];
  commandTimeoutMs?: number;
  multiPayload?: boolean;
  protocolFormat?: ProtocolFormat;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Synthesize the `status:"failed"` result for a rejected request, reusing the
 * one-shot result contract (#80) so both modes share one response shape.
 */
function failureResult(diagnostics: string): SubagentResult {
  const result: LoopResult = {
    ok: false,
    locator: null,
    filePath: null,
    editedSource: null,
    records: [],
    diagnostics,
    explanation: null,
    messages: [],
    tokens: { input: 0, output: 0, total: 0, cacheRead: 0 },
  };
  return buildSubagentResult({ result });
}

function emitFailure(out: (line: string) => void, diagnostics: string): void {
  out(serializeSubagentResult(failureResult(diagnostics)));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RequestError(`"${field}" must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, field);
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RequestError(`"${field}" must be a positive integer`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return positiveInt(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new RequestError(`"${field}" must be a boolean`);
  }
  return value;
}

function optionalProtocolFormat(value: unknown): ProtocolFormat | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "json" && value !== "compact") {
    throw new RequestError(`"protocolFormat" must be "json" or "compact"`);
  }
  return value;
}

// A command is either a whitespace string (split into argv) or an array of
// strings; both must yield at least one non-empty token.
function optionalCommand(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  let argv: string[];
  if (typeof value === "string") {
    argv = value.split(/\s+/).filter((part) => part !== "");
  } else if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    argv = (value as string[]).filter((part) => part !== "");
  } else {
    throw new RequestError(`"${field}" must be a string or an array of strings`);
  }
  if (argv.length === 0) {
    throw new RequestError(`"${field}" must not be empty`);
  }
  return argv;
}

// `targets` uses the same `{path,symbol,kind}` shape as `--targets` (#81), but
// arrives as request JSON — no file is read.
function optionalTargets(value: unknown): Locator[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new RequestError(`"targets" must be a non-empty array`);
  }
  return value.map((entry, index) => {
    const where = `"targets" entry ${index + 1}`;
    if (!isRecord(entry)) {
      throw new RequestError(`${where} must be an object {"path","symbol","kind"}`);
    }
    const path = requireString(entry["path"], `${where}.path`);
    const symbol = requireString(entry["symbol"], `${where}.symbol`);
    const kind = requireString(entry["kind"], `${where}.kind`);
    return { path, name: symbol, kind };
  });
}

function parseRunRequest(request: Record<string, unknown>): RunRequest {
  const issue = requireString(request["issue"], "issue");
  const cwd = optionalString(request["cwd"], "cwd");
  const targets = optionalTargets(request["targets"]);
  const tokenBudget = optionalPositiveInt(request["tokenBudget"], "tokenBudget");
  const checkCommand = optionalCommand(request["check"], "check");
  const testCommand = optionalCommand(request["test"], "test");
  const commandTimeoutMs = optionalPositiveInt(request["timeout"], "timeout");
  const multiPayload = optionalBoolean(request["multiPayload"], "multiPayload");
  const protocolFormat = optionalProtocolFormat(request["protocolFormat"]);
  const parsed: RunRequest = { issue };
  if (cwd !== undefined) parsed.cwd = cwd;
  if (targets !== undefined) parsed.targets = targets;
  if (tokenBudget !== undefined) parsed.tokenBudget = tokenBudget;
  if (checkCommand !== undefined) parsed.checkCommand = checkCommand;
  if (testCommand !== undefined) parsed.testCommand = testCommand;
  if (commandTimeoutMs !== undefined) parsed.commandTimeoutMs = commandTimeoutMs;
  if (multiPayload !== undefined) parsed.multiPayload = multiPayload;
  if (protocolFormat !== undefined) parsed.protocolFormat = protocolFormat;
  return parsed;
}

/** The one ack line a `shutdown` request writes before the loop ends. */
export function shutdownAck(): string {
  return JSON.stringify({ format: SERVE_FORMAT, shutdown: true });
}

/**
 * Run the persistent line-delimited JSON loop (#104). Each input line is one
 * request: a `run` (default) delegates to the existing `runMain` with
 * `format:"json"`, so stdout gets exactly one result line and everything else
 * goes to stderr; `shutdown` writes an ack and ends the loop. A malformed line
 * or invalid request is answered with one failed result line — the process
 * survives and keeps serving. EOF ends the loop. Always returns 0.
 */
export async function runServe(options: ServeOptions): Promise<number> {
  const { lines, out, err, provider, defaults } = options;
  const io: MainIo = { out, err };
  for await (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      emitFailure(out, `malformed JSON request: ${errorMessage(error)}`);
      continue;
    }
    if (!isRecord(parsed)) {
      emitFailure(out, "request must be a JSON object");
      continue;
    }
    const op = parsed["op"];
    if (parsed["shutdown"] === true || op === "shutdown") {
      out(shutdownAck());
      return 0;
    }
    if (op !== undefined && op !== "run") {
      emitFailure(out, `unknown op ${JSON.stringify(op)}`);
      continue;
    }
    let request: RunRequest;
    try {
      request = parseRunRequest(parsed);
    } catch (error) {
      const message = error instanceof RequestError ? error.message : errorMessage(error);
      emitFailure(out, message);
      continue;
    }
    try {
      await runMain({
        issue: request.issue,
        cwd: request.cwd ?? defaults.cwd,
        provider,
        io,
        multiPayload: request.multiPayload ?? defaults.multiPayload,
        protocolFormat: request.protocolFormat ?? defaults.protocolFormat,
        targets: request.targets ?? defaults.targets,
        format: "json",
        tokenBudget: request.tokenBudget ?? defaults.tokenBudget,
        checkCommand: request.checkCommand ?? defaults.checkCommand,
        testCommand: request.testCommand ?? defaults.testCommand,
        commandTimeoutMs: request.commandTimeoutMs ?? defaults.commandTimeoutMs,
      });
    } catch (error) {
      const message = `error: ${errorMessage(error)}`;
      err(message);
      emitFailure(out, message);
    }
  }
  return 0;
}
