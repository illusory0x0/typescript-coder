export interface CliOptions {
  help: boolean;
  model: string;
}

const DEFAULT_MODEL = "deepseek-v4.1-flash";

export function parseArgs(argv: string[]): CliOptions {
  let help = false;
  let model = DEFAULT_MODEL;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--model") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--model requires a value");
      }
      model = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      if (value === "") {
        throw new Error("--model requires a value");
      }
      model = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { help, model };
}

export function helpText(): string {
  return [
    "typescript-coder — read an issue on stdin and apply a verified LLM edit",
    "",
    "Usage:",
    "  bun run src/main.ts [--model <id>] < issue.txt",
    "",
    "Options:",
    "  --model <id>    model id for the OpenAI-compatible provider (default: deepseek-v4.1-flash)",
    "  -h, --help      show this help and exit",
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
