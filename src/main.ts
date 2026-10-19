import { helpText, parseArgs } from "./cli";
import { writeFailureArtifact } from "./failure-artifact";
import { runLoop } from "./loop";
import { OpenAIProvider, readConfigFromEnv } from "./openai";
import type { CliOptions } from "./cli";
import type { LoopResult, ProviderLike } from "./loop";

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
}

const NO_EXPLANATION = "the model did not provide an explanation";

export async function runMain(options: RunMainOptions): Promise<number> {
  const io = options.io ?? { out: console.log, err: console.error };
  const issue = options.issue.trim();
  if (issue === "") {
    io.err("error: no issue provided on stdin");
    return 1;
  }
  let result: LoopResult;
  try {
    result = await runLoop({
      cwd: options.cwd,
      issue,
      provider: options.provider,
      multiPayload: options.multiPayload === true,
    });
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (result.ok) {
    const kind = result.locator?.kind ?? "symbol";
    const name = result.locator?.name ?? "unknown";
    const path = result.filePath ?? result.locator?.path ?? "unknown";
    io.out(`applied ${kind} ${name} to ${path} after ${result.records.length} record(s)`);
    return 0;
  }
  const artifactPath = writeFailureArtifact({ rootDir: options.cwd, result });
  if (artifactPath !== null) {
    io.out(`failure artifact: ${artifactPath}`);
  }
  const explanation = result.explanation ?? NO_EXPLANATION;
  io.err(result.diagnostics ?? "verification failed");
  io.out(explanation);
  return 1;
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
    cwd: process.cwd(),
    provider,
    io: { out: console.log, err: console.error },
    multiPayload: cli.multiPayload,
  });
  process.exit(code);
}
