#!/usr/bin/env bun
import { helpText, parseArgs } from "./cli";
import { writeFailureArtifact } from "./failure-artifact";
import { runLoop } from "./loop";
import { RESULT_FORMAT, buildSubagentResult, serializeSubagentResult } from "./result";
import { OpenAIProvider, readConfigFromEnv } from "./openai";
import type { CliOptions } from "./cli";
import type { LoopResult, ProviderLike } from "./loop";
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
  /** Explicit addresses to edit (#81); absent = the default discovery path. */
  targets?: Locator[];
  /** stdout format (#80); default "text". */
  format?: "text" | "json";
  /** Hard per-call token budget (#80); defaults to the loop's own default. */
  tokenBudget?: number;
  /** Verify command run after an edit (#80). */
  checkCommand?: string[];
  /** Test command run after an edit (#80). */
  testCommand?: string[];
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

function emitTextResult(io: MainIo, cwd: string, result: LoopResult): number {
  if (result.ok) {
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
function emitJsonResult(
  io: MainIo,
  cwd: string,
  result: LoopResult,
  targets?: Locator[],
): number {
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
        tokens: result.tokens,
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
      targets: options.targets,
      tokenBudget: options.tokenBudget,
      checkCommand: options.checkCommand,
      testCommand: options.testCommand,
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

function parseCliOptions(argv: string[]): CliOptions {
  try {
    return parseArgs(argv);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    console.error(helpText());
    process.exit(1);
  }
}

if (import.meta.main) {
  const cli = parseCliOptions(process.argv.slice(2));
  if (cli.help) {
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
    io: { out: console.log, err: console.error },
    multiPayload: cli.multiPayload,
    targets: cli.targets ?? undefined,
    format: cli.format,
    tokenBudget: cli.tokenBudget ?? undefined,
    checkCommand: cli.checkCommand ?? undefined,
    testCommand: cli.testCommand ?? undefined,
  });
  process.exit(code);
}
