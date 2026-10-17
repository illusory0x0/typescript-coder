import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReplayBundle, runReplay, summarizeReplay } from "../src/replay-runner";
import type { ReplayBundle } from "../src/replay-format";

interface CliArgs {
  bundle: string | null;
  keep: boolean;
  help: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failUsage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function printUsage(): void {
  process.stdout.write(`Usage: bun run benchmark/replay.ts <bundle.json> [--keep]

Replay a recorded bundle through the current loop with no network calls.
The fixture is copied to a scratch workspace under tmp/replay/ and removed
afterwards unless --keep is given.

Options:
  --keep      keep the replay workspace for inspection
  --help, -h  print this help and exit

Exit codes: 0 loop ok, 1 loop failed, 2 usage or IO error
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { bundle: null, keep: false, help: false };
  for (const arg of argv) {
    if (arg === "--keep") {
      args.keep = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg.startsWith("-")) {
      failUsage(`unknown argument: ${arg}`);
    }
    if (args.bundle !== null) {
      failUsage(`unexpected argument: ${arg}`);
    }
    args.bundle = arg;
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }
  if (args.bundle === null) {
    failUsage("missing <bundle.json>");
  }
  const bundlePath = args.bundle;
  let text: string;
  try {
    text = readFileSync(bundlePath, "utf8");
  } catch (error) {
    failUsage(`cannot read bundle ${bundlePath}: ${errorMessage(error)}`);
  }
  let bundle: ReplayBundle;
  try {
    bundle = parseReplayBundle(text);
  } catch (error) {
    failUsage(`invalid bundle ${bundlePath}: ${errorMessage(error)}`);
  }

  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const tscBin = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  try {
    const run = await runReplay({ bundle, bundlePath, repoRoot, tscBin, keep: args.keep });
    process.stdout.write(summarizeReplay(run));
    if (run.kept) {
      process.stdout.write(`kept: ${run.workspace}\n`);
    }
    return run.result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`replay failed: ${errorMessage(error)}\n`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
