#!/usr/bin/env bun
import { helpText, parseArgs } from "./cli";
import { writeFailureArtifact } from "./failure-artifact";
import { runLoop } from "./loop";
import { RESULT_FORMAT, buildSubagentResult, serializeSubagentResult } from "./result";
import { OpenAIProvider, readConfigFromEnv } from "./openai";
import type { CliOptions } from "./cli";
import type { AgentMode, LoopResult, ProviderLike, ProtocolFormat } from "./loop";
import type { SubagentResult } from "./result";
import type { Locator } from "./utility";

export interface MainIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface RunMainOptions {
  issue: string;
  cwd: string;
  provider: ProviderLike;
  io?: MainIo;
  /** Opt-in multi-payload exchanges (#69); default off. */
  multiPayload?: boolean;
  /** Loop shape (`--mode`); default "pinned-repair". */
  agentMode?: AgentMode;
  /** Edit protocol format (#119); default "json". */
  protocolFormat?: ProtocolFormat;
  /** Explicit addresses to edit (#81); absent = the default discovery path. */
  targets?: Locator[];
  /** stdout format (#80); default "text". */
  format?: "text" | "json";
  /** Hard raw provider-token budget (#80); defaults to the loop's own default. */
  tokenBudget?: number;
  /** Verify command run after an edit (#80). */
  checkCommand?: string[];
  /** Test command run after an edit (#80). */
  testCommand?: string[];
  /** Timeout in ms for each check/test command; absent = the tools default. */
  commandTimeoutMs?: number;
}

const NO_EXPLANATION = "the model did not provide an explanation";

/** The `status:"failed"` result an empty issue or a thrown loop emits (#80). */
function emptyFailureResult(diagnostics: string): SubagentResult {
  return {
    format: RESULT_FORMAT,
    status: "failed",
    verified: false,
    files: [],
    targets: [],
    records: 0,
    tokens: { input: 0, output: 0, total: 0, cacheRead: 0 },
    terminationReason: null,
    diagnostics,
  };
}

/** Count the distinct files named by applied exchange rows. */
function appliedFileCount(result: LoopResult): number {
  const files = new Set<string>();
  for (const record of result.records) {
    if (record.kind !== "exchange" || record.outcome !== "applied") {
      continue;
    }
    for (const locator of record.appliedLocators ?? [record.locator]) {
      if (locator.path !== "") {
        files.add(locator.path);
      }
    }
  }
  return files.size;
}

function emitTextResult(io: MainIo, cwd: string, result: LoopResult): number {
  if (result.ok) {
    if (result.nodes !== undefined) {
      const passed = result.nodes.filter((node) => node.status === "passed").length;
      const failed = result.nodes.filter((node) => node.status === "failed").length;
      const failedText = failed === 0 ? "" : `, ${failed} failed`;
      io.out(
        `applied ${appliedFileCount(result)} file(s); ${passed}/${result.nodes.length} work node(s) passed${failedText} after ${result.records.length} record(s)`,
      );
      return 0;
    }
    const kind = result.locator?.kind ?? "symbol";
    const name = result.locator?.name ?? "unknown";
    const path = result.filePath ?? result.locator?.path ?? "unknown";
    io.out(`applied ${kind} ${name} to ${path} after ${result.records.length} record(s)`);
    return 0;
  }
  const artifactPath = writeFailureArtifact({ rootDir: cwd, result });
  if (artifactPath !== null) {
    io.out(`failure artifact: ${artifactPath}`);
  }
  const explanation = result.explanation ?? NO_EXPLANATION;
  io.err(result.diagnostics ?? "verification failed");
  io.out(explanation);
  return 1;
}

// JSON path (#80): exactly one result object on stdout; every other line
// (failure artifact, diagnostics, explanation) goes to stderr.
function emitJsonResult(io: MainIo, cwd: string, result: LoopResult, targets?: Locator[]): number {
  if (!result.ok) {
    const artifactPath = writeFailureArtifact({ rootDir: cwd, result });
    if (artifactPath !== null) {
      io.err(`failure artifact: ${artifactPath}`);
    }
    io.err(result.diagnostics ?? "verification failed");
    io.err(result.explanation ?? NO_EXPLANATION);
  }
  io.out(
    serializeSubagentResult(
      buildSubagentResult({
        result,
        // `typescript-coder-result@3` keeps its four-field token shape (#47):
        // the loop's internal `reasoning` counter is not part of the contract.
        tokens: {
          input: result.tokens.input,
          output: result.tokens.output,
          total: result.tokens.total,
          cacheRead: result.tokens.cacheRead,
        },
        targets: targets?.map((target) => ({
          path: target.path,
          symbol: target.name,
          kind: target.kind,
        })),
      }),
    ),
  );
  return result.ok ? 0 : 1;
}

export async function runMain(options: RunMainOptions): Promise<number> {
  const io = options.io ?? { out: console.log, err: console.error };
  const format = options.format ?? "text";
  const issue = options.issue.trim();
  if (issue === "") {
    const message = "error: no issue provided on stdin";
    if (format === "json") {
      io.err(message);
      io.out(serializeSubagentResult(emptyFailureResult(message)));
    } else {
      io.err(message);
    }
    return 1;
  }
  let result: LoopResult;
  try {
    result = await runLoop({
      cwd: options.cwd,
      issue,
      provider: options.provider,
      multiPayload: options.multiPayload === true,
      agentMode: options.agentMode,
      protocolFormat: options.protocolFormat,
      targets: options.targets,
      tokenBudget: options.tokenBudget,
      checkCommand: options.checkCommand,
      testCommand: options.testCommand,
      commandTimeoutMs: options.commandTimeoutMs,
    });
  } catch (error) {
    const message = `error: ${error instanceof Error ? error.message : String(error)}`;
    if (format === "json") {
      io.err(message);
      io.out(serializeSubagentResult(emptyFailureResult(message)));
    } else {
      io.err(message);
    }
    return 1;
  }
  return format === "json"
    ? emitJsonResult(io, options.cwd, result, options.targets)
    : emitTextResult(io, options.cwd, result);
}

/** True when argv requests JSON output (#86). Scans the whole argv so a
 * JSON request placed after the offending flag is still honored. */
export function argvRequestsJson(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--format" && argv[i + 1] === "json") {
      return true;
    }
    if (arg === "--format=json") {
      return true;
    }
  }
  return false;
}

/** Report a CLI usage error (#86). When JSON output was requested, stdout
 * carries exactly one result object; the error and help always go to stderr.
 * Returns the exit code; never calls process.exit itself. */
export function reportUsageError(io: MainIo, argv: readonly string[], message: string): number {
  if (argvRequestsJson(argv)) {
    io.out(serializeSubagentResult(emptyFailureResult(message)));
  }
  io.err(`error: ${message}`);
  io.err(helpText());
  return 1;
}

function parseCliOptions(argv: string[], io: MainIo): CliOptions {
  try {
    return parseArgs(argv);
  } catch (error) {
    process.exit(
      reportUsageError(io, argv, error instanceof Error ? error.message : String(error)),
    );
  }
}

if (import.meta.main) {
  const io: MainIo = { out: console.log, err: console.error };
  const cli = parseCliOptions(process.argv.slice(2), io);
  if (cli.help) {
    console.log(helpText());
    process.exit(0);
  }
  // A TTY stdin means "show help"; a pipe/file reads the issue to EOF and runs
  // one loop, preserving the documented `tc < task.txt` contract.
  if (process.stdin.isTTY) {
    console.log(helpText());
    process.exit(0);
  }
  const issue = await Bun.stdin.text();
  let provider: OpenAIProvider;
  try {
    provider = new OpenAIProvider(readConfigFromEnv(cli.model));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const code = await runMain({
    issue,
    cwd: cli.cwd ?? process.cwd(),
    provider,
    io,
    multiPayload: cli.multiPayload,
    agentMode: cli.agentMode,
    protocolFormat: cli.protocolFormat,
    targets: cli.targets ?? undefined,
    format: cli.format,
    tokenBudget: cli.tokenBudget ?? undefined,
    checkCommand: cli.checkCommand ?? undefined,
    testCommand: cli.testCommand ?? undefined,
    commandTimeoutMs: cli.commandTimeoutMs ?? undefined,
  });
  process.exit(code);
}
