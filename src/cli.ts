import { readFileSync } from "node:fs";
import type { AgentMode, ProtocolFormat } from "./loop";
import type { Locator } from "./utility";

export interface CliOptions {
  help: boolean;
  model: string;
  /** Loop shape: the single-target edit loop (default) or plan/execute. */
  agentMode?: AgentMode;
  /** Opt-in multi-payload exchanges (#69); default off. */
  multiPayload: boolean;
  /** Edit protocol format (#119): `json` or the `edit-dsl` syntax (default). */
  protocolFormat: ProtocolFormat;
  /** Explicit addresses to edit (#81); null = the default discovery path. */
  targets: Locator[] | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// One `--targets` entry: a non-empty string triple, mapped to a Locator with
// `symbol` renamed to `name` (#81). Never silently drops an entry.
function locatorFromTarget(value: unknown, index: number, file: string): Locator {
  const where = `--targets entry ${index + 1} of ${JSON.stringify(file)}`;
  if (!isRecord(value)) {
    throw new Error(`${where} must be an object {"path": ..., "symbol": ..., "kind": ...}`);
  }
  const fields: readonly [string, unknown][] = [
    ["path", value["path"]],
    ["symbol", value["symbol"]],
    ["kind", value["kind"]],
  ];
  for (const [key, field] of fields) {
    if (typeof field !== "string" || field.trim() === "") {
      throw new Error(`${where} must carry a non-empty string "${key}"`);
    }
  }
  return {
    path: value["path"] as string,
    name: value["symbol"] as string,
    kind: value["kind"] as string,
  };
}

/**
 * Read the `--targets <file.json>` address list (#81): either a top-level array
 * or `{"targets": [...]}`, each entry a `{path, symbol, kind}` string triple.
 * Throws a clear error for a missing file, invalid JSON, or a malformed entry.
 */
export function readTargetsFile(file: string): Locator[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(
      `--targets could not read ${JSON.stringify(file)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `--targets file ${JSON.stringify(file)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed["targets"])
      ? (parsed["targets"] as unknown[])
      : null;
  if (entries === null) {
    throw new Error(
      `--targets file ${JSON.stringify(file)} must be a JSON array or an object with a "targets" array`,
    );
  }
  if (entries.length === 0) {
    throw new Error(`--targets file ${JSON.stringify(file)} lists no targets`);
  }
  const locators = entries.map((entry, index) => locatorFromTarget(entry, index, file));
  const seen = new Set<string>();
  for (const locator of locators) {
    const key = `${locator.path}\u0000${locator.name}\u0000${locator.kind}`;
    if (seen.has(key)) {
      throw new Error(
        `--targets file ${JSON.stringify(file)} lists {path: ${JSON.stringify(locator.path)}, symbol: ${JSON.stringify(locator.name)}, kind: ${JSON.stringify(locator.kind)}} more than once`,
      );
    }
    seen.add(key);
  }
  return locators;
}

export function parseArgs(argv: string[]): CliOptions {
  let help = false;
  let model = DEFAULT_MODEL;
  let agentMode: AgentMode = "edit";
  let multiPayload = false;
  let protocolFormat: ProtocolFormat = "edit-dsl";
  let targets: Locator[] | null = null;
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
    if (arg === "--multi-payload" || arg === "--multiPayload") {
      multiPayload = true;
      continue;
    }
    if (arg === "--protocol-format" || arg.startsWith("--protocol-format=")) {
      const { value, next } = flagValue(argv, index, "--protocol-format");
      if (value !== "json" && value !== "edit-dsl" && value !== "compact") {
        throw new Error(
          `--protocol-format must be "json" or "edit-dsl" (got ${JSON.stringify(value)})`,
        );
      }
      // `compact` is the deprecated input alias for `edit-dsl`; output and
      // internals only use `edit-dsl`.
      protocolFormat = value === "compact" ? "edit-dsl" : value;
      index = next;
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
      if (value !== "edit" && value !== "plan-exec") {
        throw new Error(`--mode must be "edit" or "plan-exec" (got ${JSON.stringify(value)})`);
      }
      agentMode = value;
      index = next;
      continue;
    }
    if (arg === "--model" || arg.startsWith("--model=")) {
      const { value, next } = flagValue(argv, index, "--model");
      model = value;
      index = next;
      continue;
    }
    if (arg === "--targets" || arg.startsWith("--targets=")) {
      const { value, next } = flagValue(argv, index, "--targets");
      targets = readTargetsFile(value);
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
  if (agentMode === "plan-exec") {
    if (targets !== null) {
      throw new Error(
        "--targets edits explicit addresses through the single-target edit loop; it cannot be combined with --mode plan-exec",
      );
    }
    if (protocolFormat === "json") {
      throw new Error(
        "--mode plan-exec executes tasks with the edit-dsl protocol; --protocol-format json cannot be combined with it",
      );
    }
  }
  return {
    help,
    model,
    agentMode,
    multiPayload,
    protocolFormat,
    targets,
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
    "  tc [--model <id>] [--mode <edit|plan-exec>] [--format <text|json>] [--protocol-format <json|edit-dsl>] [--token-budget <n>] [--multi-payload] [--targets <file>] < issue.txt",
    "  bun run src/main.ts [--model <id>] [--mode <edit|plan-exec>] [--format <text|json>] [--protocol-format <json|edit-dsl>] [--token-budget <n>] [--multi-payload] [--targets <file>] < issue.txt",
    "",
    "Options:",
    "  --model <id>       model id for the OpenAI-compatible provider (default: deepseek-v4.1-flash)",
    "  --mode <edit|plan-exec>",
    "                     loop shape (default: edit); plan-exec plans a",
    "                     Plan -> Stage -> Task -> edit tree and executes",
    "                     one micro edit at a time",
    "                     (alias --agent-mode)",
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
    "  --timeout <ms>     timeout for each check/test command in milliseconds",
    "                     (default: 120000)",
    "  --multi-payload    opt in to multi-payload exchanges (#69): a modify reply may",
    '                     batch path-independent edits in one {"payloads": [...]} object',
    "                     (default: off, one flat payload per exchange)",
    "  --protocol-format <json|edit-dsl>",
    "                     edit protocol (default: edit-dsl); json keeps the flat",
    "                     JSON payload, edit-dsl requires the `select … end` syntax",
    "                     (#119; explicit-targets mode stays json); `compact` is a",
    "                     deprecated alias for edit-dsl",
    "  --targets <file>   edit an explicit address list from a JSON file (#81); the",
    '                     file is an array or {"targets": [...]} of {"path","symbol",',
    '                     "kind"} entries; each file is edited once per exchange and',
    "                     same-file targets are sequenced across exchanges",
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
