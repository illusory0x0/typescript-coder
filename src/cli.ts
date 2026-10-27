import { canonicalAgentMode, DEFAULT_AGENT_MODE } from "./loop";
import type { AgentMode } from "./loop";

export interface CliOptions {
  help: boolean;
  model: string;
  /** Loop shape: pinned-repair (default) or plan-exec. */
  agentMode?: AgentMode;
  /** stdout format (#80): `text` (default) or the machine-readable `json` result. */
  format: "text" | "json";
  /** Hard raw provider-token budget (#80); null = the loop default. */
  tokenBudget: number | null;
  /** Verify command run after an edit (#80); null = the tools default. */
  checkCommand: string[] | null;
  /** Test command run after an edit (#80); null = the tools default. */
  testCommand: string[] | null;
  /** Working directory for the run (#80); null = the process cwd. */
  cwd: string | null;
  /** Timeout in ms for each check/test command; null = the tools default. */
  commandTimeoutMs: number | null;
}

const DEFAULT_MODEL = "deepseek-v4.1-flash";

// Read `--flag value` or `--flag=value`; an absent or empty value throws. The
// returned `next` is the argv index the caller resumes from.
function flagValue(argv: string[], index: number, flag: string): { value: string; next: number } {
  const arg = argv[index] ?? "";
  const prefix = `${flag}=`;
  if (arg.startsWith(prefix)) {
    const value = arg.slice(prefix.length);
    if (value === "") {
      throw new Error(`${flag} requires a value`);
    }
    return { value, next: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value === "") {
    throw new Error(`${flag} requires a value`);
  }
  return { value, next: index + 1 };
}

// Split a command string into argv on whitespace (#80); a blank value throws.
function splitCommand(value: string, flag: string): string[] {
  const argv = value.split(/\s+/).filter((part) => part !== "");
  if (argv.length === 0) {
    throw new Error(`${flag} requires a value`);
  }
  return argv;
}

function parseTokenBudget(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--token-budget must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return parsed;
}

function parseTimeout(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--timeout must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return parsed;
}

export function parseArgs(argv: string[]): CliOptions {
  let help = false;
  let model = DEFAULT_MODEL;
  let agentMode: AgentMode = DEFAULT_AGENT_MODE;
  let format: "text" | "json" = "text";
  let tokenBudget: number | null = null;
  let checkCommand: string[] | null = null;
  let testCommand: string[] | null = null;
  let cwd: string | null = null;
  let commandTimeoutMs: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (
      arg === "--mode" ||
      arg === "--agent-mode" ||
      arg.startsWith("--mode=") ||
      arg.startsWith("--agent-mode=")
    ) {
      const flag = arg.startsWith("--agent-mode") ? "--agent-mode" : "--mode";
      const { value, next } = flagValue(argv, index, flag);
      if (value === "both") {
        // `both` is the benchmark's multi-mode selector; one CLI process runs
        // one loop, so accepting it here would silently drop a mode.
        throw new Error(
          `${flag} "both" is only valid for the benchmark's --agent-mode; use "pinned-repair" or "plan-exec"`,
        );
      }
      const mode = canonicalAgentMode(value);
      if (mode === null) {
        throw new Error(
          `${flag} must be "pinned-repair" or "plan-exec" (alias: edit; got ${JSON.stringify(value)})`,
        );
      }
      agentMode = mode;
      index = next;
      continue;
    }
    if (arg === "--model" || arg.startsWith("--model=")) {
      const { value, next } = flagValue(argv, index, "--model");
      model = value;
      index = next;
      continue;
    }
    if (arg === "--format" || arg.startsWith("--format=")) {
      const { value, next } = flagValue(argv, index, "--format");
      if (value !== "text" && value !== "json") {
        throw new Error(`--format must be "text" or "json" (got ${JSON.stringify(value)})`);
      }
      format = value;
      index = next;
      continue;
    }
    if (arg === "--token-budget" || arg.startsWith("--token-budget=")) {
      const { value, next } = flagValue(argv, index, "--token-budget");
      tokenBudget = parseTokenBudget(value);
      index = next;
      continue;
    }
    if (arg === "--check" || arg.startsWith("--check=")) {
      const { value, next } = flagValue(argv, index, "--check");
      checkCommand = splitCommand(value, "--check");
      index = next;
      continue;
    }
    if (arg === "--test" || arg.startsWith("--test=")) {
      const { value, next } = flagValue(argv, index, "--test");
      testCommand = splitCommand(value, "--test");
      index = next;
      continue;
    }
    if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const { value, next } = flagValue(argv, index, "--cwd");
      cwd = value;
      index = next;
      continue;
    }
    if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      const { value, next } = flagValue(argv, index, "--timeout");
      commandTimeoutMs = parseTimeout(value);
      index = next;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return {
    help,
    model,
    agentMode,
    format,
    tokenBudget,
    checkCommand,
    testCommand,
    cwd,
    commandTimeoutMs,
  };
}

export function helpText(): string {
  return [
    "typescript-coder — read an issue on stdin and apply a verified LLM edit",
    "",
    "Usage:",
    "  tc [--model <id>] [--mode <pinned-repair|plan-exec>] [--format <text|json>] [--token-budget <n>] < issue.txt",
    "  bun run src/main.ts [--model <id>] [--mode <pinned-repair|plan-exec>] [--format <text|json>] [--token-budget <n>] < issue.txt",
    "",
    "Options:",
    "  --model <id>       model id for the OpenAI-compatible provider (default: deepseek-v4.1-flash)",
    "  --mode <pinned-repair|plan-exec>",
    "                     loop shape (default: pinned-repair); pinned-repair",
    "                     repairs one pinned selection through Edit -> Verify;",
    "                     plan-exec plans, executes, and reviews a",
    "                     hints-based WorkNode graph",
    "                     (alias --agent-mode; deprecated alias: edit)",
    "  --format <text|json>",
    "                     stdout format (default: text); json prints exactly one",
    "                     typescript-coder-result@3 object on stdout",
    "  --token-budget <n> hard raw-token budget as a positive integer (provider",
    "                     total, or prompt+completion when total is absent;",
    "                     default: 120000)",
    "  --check <cmd>      verify command to run after an edit; the value is split",
    "                     on whitespace into argv",
    "  --test <cmd>       test command to run after an edit; the value is split",
    "                     on whitespace into argv",
    "  --cwd <dir>        working directory for the run (default: the process cwd)",
    "  --timeout <ms>     timeout for each check/test command in milliseconds",
    "                     (default: 120000)",
    "  -h, --help         show this help and exit",
    "",
    "Environment:",
    "  OPENAI_API_KEY    API key for the OpenAI-compatible provider",
    "  OPENAI_BASE_URL   base URL of the OpenAI-compatible provider",
  ].join("\n");
}

if (import.meta.main) {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    console.error(helpText());
    process.exit(1);
  }
  if (options.help) {
    console.log(helpText());
    process.exit(0);
  }
  console.error("cli.ts only implements --help; run src/main.ts with an issue on stdin");
  console.error(helpText());
  process.exit(1);
}
