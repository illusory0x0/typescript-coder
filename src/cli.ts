export interface CliOptions {
  help: boolean;
  model: string;
  /** Opt-in multi-payload exchanges (#69); default off. */
  multiPayload: boolean;
  /** stdout format (#80): `text` (default) or the machine-readable `json` result. */
  format: "text" | "json";
  /** Hard per-call token budget (#80); null = the loop default. */
  tokenBudget: number | null;
  /** Verify command run after an edit (#80); null = the tools default. */
  checkCommand: string[] | null;
  /** Test command run after an edit (#80); null = the tools default. */
  testCommand: string[] | null;
  /** Working directory for the run (#80); null = the process cwd. */
  cwd: string | null;
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

export function parseArgs(argv: string[]): CliOptions {
  let help = false;
  let model = DEFAULT_MODEL;
  let multiPayload = false;
  let format: "text" | "json" = "text";
  let tokenBudget: number | null = null;
  let checkCommand: string[] | null = null;
  let testCommand: string[] | null = null;
  let cwd: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--multi-payload" || arg === "--multiPayload") {
      multiPayload = true;
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
    throw new Error(`unknown argument: ${arg}`);
  }
  return { help, model, multiPayload, format, tokenBudget, checkCommand, testCommand, cwd };
}

export function helpText(): string {
  return [
    "typescript-coder — read an issue on stdin and apply a verified LLM edit",
    "",
    "Usage:",
    "  tc [--model <id>] [--format <text|json>] [--token-budget <n>] [--multi-payload] < issue.txt",
    "  bun run src/main.ts [--model <id>] [--format <text|json>] [--token-budget <n>] [--multi-payload] < issue.txt",
    "",
    "Options:",
    "  --model <id>       model id for the OpenAI-compatible provider (default: deepseek-v4.1-flash)",
    "  --format <text|json>",
    "                     stdout format (default: text); json prints exactly one",
    "                     typescript-coder-result@1 object on stdout",
    "  --token-budget <n> hard per-call token budget as a positive integer",
    "                     (default: 120000)",
    "  --check <cmd>      verify command to run after an edit; the value is split",
    "                     on whitespace into argv",
    "  --test <cmd>       test command to run after an edit; the value is split",
    "                     on whitespace into argv",
    "  --cwd <dir>        working directory for the run (default: the process cwd)",
    "  --multi-payload    opt in to multi-payload exchanges (#69): a modify reply may",
    '                     batch path-independent edits in one {"payloads": [...]} object',
    "                     (default: off, one flat payload per exchange)",
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
