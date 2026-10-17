import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLoop } from "../src/loop";
import { OpenAIProvider, readConfigFromEnv } from "../src/openai";
import type { ProviderLike } from "../src/loop";
import type { ChatMessage, ChatResponse, ToolDefinition } from "../src/openai";

type TaskName = "json-parser" | "sexp-parser" | "minilisp";
type Side = "ts" | "opencode";
type SideSelection = Side | "both";

interface TaskSpec {
  readonly name: TaskName;
}

interface CliArgs {
  task: TaskName | null;
  all: boolean;
  reps: number;
  pilot: boolean;
  side: SideSelection;
  model: string;
  keep: boolean;
  json: string | null;
  help: boolean;
}

interface TokenUsage {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly reasoning: number | null;
  readonly total: number | null;
}

interface CommandOutcome {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error: string | null;
}

interface SideOutcome {
  readonly sideOk: boolean;
  readonly error: string | null;
  readonly infraError: string | null;
  readonly steps: number | null;
  readonly durationMs: number;
  readonly tokens: TokenUsage;
  readonly usageAvailable: boolean;
  readonly usageSource: string;
  readonly rawUsage: unknown;
  readonly logText: string;
  readonly sessionExportJson: string | null;
  readonly statsJson: string | null;
}

interface JudgeRecord {
  readonly testsOk: boolean;
  readonly tscOk: boolean;
  readonly fixtureOk: boolean;
  readonly detail: string | null;
}

interface LogPaths {
  readonly side: string;
  readonly judge: string;
  readonly session: string | null;
  readonly stats: string | null;
}

interface RunRecord {
  readonly task: TaskName;
  readonly side: Side;
  readonly rep: number;
  readonly ok: boolean;
  readonly sideOk: boolean;
  readonly tokens: TokenUsage;
  readonly usageAvailable: boolean;
  readonly usageSource: string;
  readonly rawUsage: unknown;
  readonly durationMs: number;
  readonly steps: number | null;
  readonly model: string;
  readonly workspace: string;
  readonly logs: LogPaths;
  readonly versions: { readonly bun: string; readonly opencode: string | null };
  readonly judge: JudgeRecord | null;
  readonly error: string | null;
  readonly infraError: string | null;
}

interface Report {
  generatedAt: string;
  mode: "pilot" | "full";
  tasks: TaskName[];
  sides: Side[];
  reps: number;
  model: string;
  bunVersion: string;
  opencodeVersion: string | null;
  infraErrors: string[];
  runs: RunRecord[];
}

interface RunContext {
  readonly repoRoot: string;
  readonly tscBin: string;
  readonly model: string;
  readonly opencodeModel: string;
  readonly opencode: OpencodeContext | null;
  readonly runRoot: string;
}

interface OpencodeContext {
  readonly bin: string;
  readonly version: string;
}

interface JudgeResult extends JudgeRecord {
  readonly ok: boolean;
  readonly log: string;
}

const TASKS: readonly TaskSpec[] = [
  { name: "json-parser" },
  { name: "sexp-parser" },
  { name: "minilisp" },
];

// One issue string per task, used verbatim by both sides (G1 is quoted from
// the benchmark issue; G2/G3 are analogous with their exported names).
const TASK_ISSUES: Record<TaskName, string> = {
  "json-parser": [
    "Implement src/json.ts exporting JsonValue and parseJson(text: string): JsonValue",
    "so that src/json.test.ts passes. Keep tsc --noEmit clean. Do not modify the test",
    "file or tsconfig.json. The test file is the specification.",
  ].join("\n"),
  "sexp-parser": [
    "Implement src/sexp.ts exporting Sexp and parseSexp(text: string): Sexp",
    "so that src/sexp.test.ts passes. Keep tsc --noEmit clean. Do not modify the test",
    "file or tsconfig.json. The test file is the specification.",
  ].join("\n"),
  minilisp: [
    "Implement src/lisp.ts exporting LispValue and run(program: string): LispValue",
    "so that src/lisp.test.ts passes. Keep tsc --noEmit clean. Do not modify the test",
    "file or tsconfig.json. The test file is the specification.",
  ].join("\n"),
};

const DEFAULT_MODEL = "deepseek-v4.1-flash";
const DEFAULT_REPS = 3;
const PILOT_REPS = 1;
const OPENCODE_PROVIDER = "honghong";
const OPENCODE_FALLBACK_BIN = "/home/illu/.opencode/bin/opencode";
const OPENCODE_TIMEOUT_MS = 15 * 60_000;
const CHAT_TIMEOUT_MS = 5 * 60_000;
const JUDGE_TIMEOUT_MS = 240_000;
const PROBE_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 400;

const NULL_USAGE: TokenUsage = {
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  reasoning: null,
  total: null,
};

class InfraError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function failUsage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function printUsage(): void {
  process.stdout.write(`Usage: bun run benchmark/run.ts [options]

Options:
  --task <json-parser|sexp-parser|minilisp>  run a single task (default: all)
  --all                                      run all tasks (default)
  --reps <n>                                 repetitions per task and side (default: 3)
  --pilot                                    force 1 rep per task and side and write
                                             benchmark/results/pilot-<date>.json
  --side ts|opencode|both                    which side(s) to run (default: both)
  --model <id>                               gateway model id (default: ${DEFAULT_MODEL})
  --keep                                     keep workspaces and logs under ./tmp/benchmark/
  --json <path>                              report output path (default: benchmark/results/)
  --help, -h                                 print this help and exit
`);
}

function parseReps(value: string): number {
  if (!/^\d+$/.test(value)) {
    failUsage(`invalid --reps value: ${value}`);
  }
  const reps = Number(value);
  if (!Number.isSafeInteger(reps) || reps < 1) {
    failUsage(`invalid --reps value: ${value}`);
  }
  return reps;
}

function parseSide(value: string): SideSelection {
  if (value === "ts" || value === "opencode" || value === "both") {
    return value;
  }
  failUsage(`invalid --side value: ${value}`);
}

function parseTask(value: string): TaskName {
  const match = TASKS.find((task) => task.name === value);
  if (match === undefined) {
    failUsage(`invalid --task value: ${value}`);
  }
  return match.name;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    task: null,
    all: false,
    reps: DEFAULT_REPS,
    pilot: false,
    side: "both",
    model: DEFAULT_MODEL,
    keep: false,
    json: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    switch (arg) {
      case "--all": {
        args.all = true;
        break;
      }
      case "--pilot": {
        args.pilot = true;
        break;
      }
      case "--keep": {
        args.keep = true;
        break;
      }
      case "--help":
      case "-h": {
        args.help = true;
        break;
      }
      case "--task": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --task");
        }
        args.task = parseTask(value);
        index += 1;
        break;
      }
      case "--reps": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --reps");
        }
        args.reps = parseReps(value);
        index += 1;
        break;
      }
      case "--side": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --side");
        }
        args.side = parseSide(value);
        index += 1;
        break;
      }
      case "--model": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --model");
        }
        args.model = value;
        index += 1;
        break;
      }
      case "--json": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --json");
        }
        args.json = value;
        index += 1;
        break;
      }
      default: {
        failUsage(`unknown argument: ${arg}`);
      }
    }
  }
  if (args.task !== null && args.all) {
    failUsage("--task and --all are mutually exclusive");
  }
  if (args.model === "") {
    failUsage("--model must not be empty");
  }
  return args;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nestedNumber(record: Record<string, unknown>, parent: string, key: string): number | null {
  const child = record[parent];
  return isRecord(child) ? numberField(child, key) : null;
}

function tokenUsageFromOpenAi(raw: unknown): TokenUsage {
  if (!isRecord(raw)) {
    return NULL_USAGE;
  }
  return {
    input: numberField(raw, "prompt_tokens") ?? numberField(raw, "input_tokens"),
    output: numberField(raw, "completion_tokens") ?? numberField(raw, "output_tokens"),
    cacheRead:
      nestedNumber(raw, "prompt_tokens_details", "cached_tokens") ??
      numberField(raw, "cache_read_input_tokens"),
    cacheWrite:
      nestedNumber(raw, "prompt_tokens_details", "cache_creation_tokens") ??
      numberField(raw, "cache_creation_input_tokens"),
    reasoning:
      nestedNumber(raw, "completion_tokens_details", "reasoning_tokens") ??
      numberField(raw, "reasoning_tokens"),
    total: numberField(raw, "total_tokens"),
  };
}

function tokenUsageFromOpencode(raw: unknown): TokenUsage {
  if (!isRecord(raw)) {
    return NULL_USAGE;
  }
  const cache = raw["cache"];
  return {
    input: numberField(raw, "input"),
    output: numberField(raw, "output"),
    cacheRead: isRecord(cache) ? numberField(cache, "read") : null,
    cacheWrite: isRecord(cache) ? numberField(cache, "write") : null,
    reasoning: numberField(raw, "reasoning"),
    total: null,
  };
}

function sumTokenUsages(usages: readonly TokenUsage[]): TokenUsage {
  const sum = (pick: (usage: TokenUsage) => number | null): number | null => {
    let total: number | null = null;
    for (const usage of usages) {
      const value = pick(usage);
      if (value !== null) {
        total = (total ?? 0) + value;
      }
    }
    return total;
  };
  return {
    input: sum((usage) => usage.input),
    output: sum((usage) => usage.output),
    cacheRead: sum((usage) => usage.cacheRead),
    cacheWrite: sum((usage) => usage.cacheWrite),
    reasoning: sum((usage) => usage.reasoning),
    total: sum((usage) => usage.total),
  };
}

// total: prefer the side-reported total; otherwise sum the reported component
// counters (cache hits stay out: they are input subsets on the OpenAI side).
function withDerivedTotal(usage: TokenUsage): TokenUsage {
  if (usage.total !== null) {
    return usage;
  }
  const parts = [usage.input, usage.output, usage.reasoning].filter(
    (value): value is number => value !== null,
  );
  if (parts.length === 0) {
    return usage;
  }
  return { ...usage, total: parts.reduce((left, right) => left + right, 0) };
}

function usageReported(usage: TokenUsage): boolean {
  return (
    usage.input !== null ||
    usage.output !== null ||
    usage.cacheRead !== null ||
    usage.cacheWrite !== null ||
    usage.reasoning !== null ||
    usage.total !== null
  );
}

function usageFromResponse(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return null;
  }
  const usage = raw["usage"];
  return usage === undefined ? null : usage;
}

function summarizeOutput(text: string, limit = OUTPUT_LIMIT): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function runCommand(
  command: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandOutcome> {
  let timedOut = false;
  try {
    const proc = Bun.spawn(command, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Bun.spawn({cwd}) does not update the inherited PWD; opencode derives
      // its session directory from PWD, so keep them consistent.
      env: { ...process.env, PWD: cwd },
    });
    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      setTimeout(() => proc.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return {
      ok: exitCode === 0 && !timedOut,
      exitCode,
      stdout: await stdout,
      stderr: await stderr,
      timedOut,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut,
      error: errorMessage(error),
    };
  }
}

// Bun types `fetch` with an extra `preconnect` method (see bun-types docs);
// OpenAIProvider never calls it, so a direct cast is the documented pattern
// for fetch wrappers (same as acceptance/run.ts).
function fetchWithTimeout(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(CHAT_TIMEOUT_MS) });
}

class RecordingProvider implements ProviderLike {
  readonly rawUsages: unknown[] = [];
  readonly #inner: OpenAIProvider;

  constructor(inner: OpenAIProvider) {
    this.#inner = inner;
  }

  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: { temperature?: number },
  ): Promise<ChatResponse> {
    const response = await this.#inner.chat(messages, tools, options);
    this.rawUsages.push(usageFromResponse(response.raw));
    return response;
  }
}

async function runTypescriptSide(options: {
  workspace: string;
  issue: string;
  model: string;
  tscBin: string;
}): Promise<SideOutcome> {
  const provider = new RecordingProvider(
    new OpenAIProvider(
      // Match the harness's own 5-minute chat deadline; the provider default
      // (120 s) would otherwise fire first and abort long generations.
      { ...readConfigFromEnv(options.model), timeoutMs: CHAT_TIMEOUT_MS },
      fetchWithTimeout as typeof fetch,
    ),
  );
  const started = performance.now();
  let error: string | null = null;
  let result: Awaited<ReturnType<typeof runLoop>> | null = null;
  try {
    result = await runLoop({
      cwd: options.workspace,
      issue: options.issue,
      model: options.model,
      provider,
      temperature: 0,
      checkCommand: ["bun", options.tscBin, "--noEmit"],
      testCommand: ["bun", "test"],
    });
  } catch (caught) {
    error = errorMessage(caught);
  }
  const durationMs = Math.round(performance.now() - started);
  const usages = provider.rawUsages.map((raw) => tokenUsageFromOpenAi(raw));
  const tokens = withDerivedTotal(sumTokenUsages(usages));
  const usageAvailable = usages.some((usage) => usageReported(usage));

  const lines: string[] = [
    "side: ts",
    `model: ${options.model}`,
    `durationMs: ${durationMs}`,
    `issue:\n${options.issue}`,
    `result: ${result === null ? "error" : result.ok ? "ok" : "failed"}`,
    `error: ${error ?? "none"}`,
  ];
  if (result !== null) {
    lines.push(`mode: ${result.mode ?? "none"}`);
    lines.push(`filePath: ${result.filePath ?? "none"}`);
    lines.push(`attempts: ${result.attempts.length}`);
    for (const attempt of result.attempts) {
      lines.push(
        `  attempt ${attempt.attempt}: locator=${JSON.stringify(attempt.locator)} diagnostics=${
          attempt.diagnostics === null ? "none" : summarizeOutput(attempt.diagnostics)
        }`,
      );
    }
    lines.push(`diagnostics: ${result.diagnostics ?? "none"}`);
    lines.push(`explanation: ${result.explanation ?? "none"}`);
  }
  lines.push(`usageAvailable: ${usageAvailable}`);
  lines.push(`rawUsage: ${JSON.stringify(provider.rawUsages, null, 2)}`);

  return {
    sideOk: result?.ok === true,
    error,
    infraError: null,
    steps: result?.attempts.length ?? null,
    durationMs,
    tokens,
    usageAvailable,
    usageSource: usageAvailable ? "chat-completions" : "unavailable",
    rawUsage: provider.rawUsages,
    logText: `${lines.join("\n")}\n`,
    sessionExportJson: null,
    statsJson: null,
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function runOpencodeSide(options: {
  bin: string;
  workspace: string;
  issue: string;
  model: string;
}): Promise<SideOutcome> {
  const sessionId = `ses_bench${randomUUID().replaceAll("-", "")}`;
  const started = performance.now();
  const run = await runCommand(
    [
      options.bin,
      "run",
      "--auto",
      "--format",
      "json",
      "--session",
      sessionId,
      "--model",
      options.model,
      options.issue,
    ],
    options.workspace,
    OPENCODE_TIMEOUT_MS,
  );
  const durationMs = Math.round(performance.now() - started);

  let tokens: TokenUsage = NULL_USAGE;
  let usageAvailable = false;
  let usageSource = "unavailable";
  let rawUsage: unknown = null;
  let steps: number | null = null;
  let sessionExportJson: string | null = null;
  let statsJson: string | null = null;
  let infraError: string | null = null;

  const exported = await runCommand(
    [options.bin, "session", "export", sessionId],
    options.workspace,
    PROBE_TIMEOUT_MS,
  );
  const exportedJson = exported.ok ? tryParseJson(exported.stdout) : null;
  if (exportedJson !== null && isRecord(exportedJson)) {
    sessionExportJson = exported.stdout;
    const info = exportedJson["info"];
    const infoTokens = isRecord(info) ? info["tokens"] : null;
    if (isRecord(infoTokens)) {
      tokens = withDerivedTotal(tokenUsageFromOpencode(infoTokens));
      usageAvailable = true;
      usageSource = "session-export";
      rawUsage = {
        tokens: infoTokens,
        cost: isRecord(info) ? info["cost"] : null,
        projectID: isRecord(info) ? info["projectID"] : null,
      };
      const messages = exportedJson["messages"];
      if (Array.isArray(messages)) {
        steps = messages.filter((message) => isRecord(message) && message["type"] === "assistant")
          .length;
      }
    }
  }

  if (!usageAvailable) {
    const stats = await runCommand(
      [options.bin, "stats", "--json", "--days", "0", "--project", options.workspace],
      options.workspace,
      PROBE_TIMEOUT_MS,
    );
    const statsJsonValue = stats.ok ? tryParseJson(stats.stdout) : null;
    if (isRecord(statsJsonValue)) {
      statsJson = stats.stdout;
      const statsTokens = statsJsonValue["tokens"];
      if (isRecord(statsTokens)) {
        tokens = withDerivedTotal(tokenUsageFromOpencode(statsTokens));
        usageAvailable = true;
        usageSource = "stats-project";
        rawUsage = {
          tokens: statsTokens,
          sessions: statsJsonValue["sessions"],
          range: statsJsonValue["range"],
        };
      }
    }
  }

  if (!usageAvailable) {
    infraError = `cannot read usage for opencode session ${sessionId} (session export and stats both failed)`;
  }

  let error: string | null = run.error;
  if (run.timedOut) {
    error = `opencode run timed out after ${OPENCODE_TIMEOUT_MS}ms`;
  } else if (error === null && !run.ok) {
    error = `opencode run exited with code ${run.exitCode ?? "unknown"}`;
  }

  const lines: string[] = [
    "side: opencode",
    `command: ${options.bin} run --auto --format json --session ${sessionId} --model ${options.model} <issue>`,
    `model: ${options.model}`,
    `sessionId: ${sessionId}`,
    `durationMs: ${durationMs}`,
    `exitCode: ${run.exitCode ?? "unknown"}`,
    `timedOut: ${run.timedOut}`,
    `error: ${error ?? "none"}`,
    `issue:\n${options.issue}`,
    "stdout:",
    run.stdout,
    "stderr:",
    run.stderr,
    `usageAvailable: ${usageAvailable}`,
    `usageSource: ${usageSource}`,
    `rawUsage: ${JSON.stringify(rawUsage, null, 2)}`,
  ];

  return {
    sideOk: run.ok,
    error,
    infraError,
    steps,
    durationMs,
    tokens,
    usageAvailable,
    usageSource,
    rawUsage,
    logText: `${lines.join("\n")}\n`,
    sessionExportJson,
    statsJson,
  };
}

function fixtureTrackedFiles(fixtureDir: string): string[] {
  const files = ["tsconfig.json"];
  const sourceDir = join(fixtureDir, "src");
  if (existsSync(sourceDir)) {
    for (const entry of readdirSync(sourceDir)) {
      if (entry.endsWith(".test.ts")) {
        files.push(`src/${entry}`);
      }
    }
  }
  return files.sort();
}

export async function judgeWorkspace(
  workspace: string,
  fixtureDir: string,
  tscBin: string,
): Promise<JudgeResult> {
  const fixtureFiles = fixtureTrackedFiles(fixtureDir);
  const details: string[] = [];
  const lines: string[] = [`workspace: ${workspace}`, `fixture: ${fixtureDir}`];

  let fixtureOk = true;
  for (const relativePath of fixtureFiles) {
    const candidate = join(workspace, relativePath);
    const stats = statSync(candidate, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isFile()) {
      fixtureOk = false;
      details.push(`${relativePath}: missing`);
      lines.push(`${relativePath}: MISSING`);
      continue;
    }
    const identical = readFileSync(join(fixtureDir, relativePath)).equals(readFileSync(candidate));
    if (identical) {
      lines.push(`${relativePath}: identical`);
    } else {
      fixtureOk = false;
      details.push(`${relativePath}: modified`);
      lines.push(`${relativePath}: MODIFIED`);
    }
  }

  const typecheck = await runCommand(["bun", tscBin, "--noEmit"], workspace, JUDGE_TIMEOUT_MS);
  const tscOk = typecheck.ok;
  lines.push(`tsc exit=${typecheck.exitCode ?? "unknown"} timedOut=${typecheck.timedOut}`);
  lines.push(typecheck.stdout + typecheck.stderr);

  const tests = await runCommand(["bun", "test"], workspace, JUDGE_TIMEOUT_MS);
  const testsOk = tests.ok;
  lines.push(`bun test exit=${tests.exitCode ?? "unknown"} timedOut=${tests.timedOut}`);
  lines.push(tests.stdout + tests.stderr);

  const ok = fixtureOk && tscOk && testsOk;
  let detail: string | null = null;
  if (!ok) {
    const parts = [...details];
    if (!tscOk) {
      parts.push(`tsc failed: ${summarizeOutput(typecheck.stdout + typecheck.stderr)}`);
    }
    if (!testsOk) {
      parts.push(`bun test failed: ${summarizeOutput(tests.stdout + tests.stderr)}`);
    }
    detail = parts.length > 0 ? parts.join("; ") : "judge failed";
  }
  return { ok, testsOk, tscOk, fixtureOk, detail, log: `${lines.join("\n")}\n` };
}

function resolveOpencodeBin(): string {
  const override = process.env["OPENCODE_BIN"];
  if (override !== undefined && override !== "") {
    return override;
  }
  const fromPath = Bun.which("opencode");
  if (fromPath !== null) {
    return fromPath;
  }
  if (statSync(OPENCODE_FALLBACK_BIN, { throwIfNoEntry: false })?.isFile() === true) {
    return OPENCODE_FALLBACK_BIN;
  }
  throw new InfraError(
    "opencode binary not found: set OPENCODE_BIN or put opencode on PATH",
  );
}

async function probeOpencodeCli(repoRoot: string): Promise<OpencodeContext> {
  const bin = resolveOpencodeBin();
  const version = await runCommand([bin, "--version"], repoRoot, PROBE_TIMEOUT_MS);
  if (!version.ok) {
    const detail = version.error ?? summarizeOutput(version.stdout + version.stderr);
    throw new InfraError(`cannot run opencode --version: ${detail}`);
  }
  const runHelp = await runCommand([bin, "run", "--help"], repoRoot, PROBE_TIMEOUT_MS);
  if (!runHelp.ok || !runHelp.stdout.includes("--model")) {
    throw new InfraError("opencode run --help did not advertise --model");
  }
  const exportHelp = await runCommand(
    [bin, "session", "export", "--help"],
    repoRoot,
    PROBE_TIMEOUT_MS,
  );
  if (!exportHelp.ok) {
    throw new InfraError("opencode session export --help failed");
  }
  const statsHelp = await runCommand([bin, "stats", "--help"], repoRoot, PROBE_TIMEOUT_MS);
  if (!statsHelp.ok || !statsHelp.stdout.includes("--json")) {
    throw new InfraError("opencode stats --help did not advertise --json");
  }
  return { bin, version: version.stdout.trim().split("\n")[0] ?? "" };
}

function opencodeModelId(model: string): string {
  return model.includes("/") ? model : `${OPENCODE_PROVIDER}/${model}`;
}

// Give every workspace its own git repo so an agent cannot reach the enclosing
// typescript-coder repository (and benchmark/references/) through git.
function initWorkspaceGit(workspace: string): void {
  const env = { ...process.env, PWD: workspace };
  const commands = [
    ["git", "init", "--quiet"],
    ["git", "config", "user.email", "benchmark@localhost"],
    ["git", "config", "user.name", "benchmark"],
  ];
  for (const command of commands) {
    const result = Bun.spawnSync(command, {
      cwd: workspace,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new InfraError(
        `workspace git setup failed (${command.join(" ")}): ${result.stderr.toString().slice(0, 200)}`,
      );
    }
  }
}

async function runOnce(
  task: TaskName,
  side: Side,
  rep: number,
  context: RunContext,
): Promise<RunRecord> {
  const fixtureDir = join(context.repoRoot, "benchmark", "fixtures", task);
  const runName = `${task}-${side}-rep${rep}`;
  const workspace = join(context.runRoot, runName);
  const logsDir = join(context.runRoot, "logs", runName);
  mkdirSync(logsDir, { recursive: true });
  cpSync(fixtureDir, workspace, { recursive: true });
  initWorkspaceGit(workspace);

  const issue = TASK_ISSUES[task];
  let outcome: SideOutcome;
  if (side === "ts") {
    outcome = await runTypescriptSide({
      workspace,
      issue,
      model: context.model,
      tscBin: context.tscBin,
    });
  } else {
    if (context.opencode === null) {
      throw new InfraError("opencode side requested but the CLI was not probed");
    }
    outcome = await runOpencodeSide({
      bin: context.opencode.bin,
      workspace,
      issue,
      model: context.opencodeModel,
    });
  }

  const judge = await judgeWorkspace(workspace, fixtureDir, context.tscBin);
  const sideLogPath = join(logsDir, "side.log");
  const judgeLogPath = join(logsDir, "judge.log");
  const sessionPath = outcome.sessionExportJson === null ? null : join(logsDir, "session.json");
  const statsPath = outcome.statsJson === null ? null : join(logsDir, "stats.json");
  writeFile(sideLogPath, outcome.logText);
  writeFile(judgeLogPath, judge.log);
  if (sessionPath !== null && outcome.sessionExportJson !== null) {
    writeFile(sessionPath, outcome.sessionExportJson);
  }
  if (statsPath !== null && outcome.statsJson !== null) {
    writeFile(statsPath, outcome.statsJson);
  }

  const asRelative = (path: string): string => relative(context.repoRoot, path);
  return {
    task,
    side,
    rep,
    ok: judge.ok,
    sideOk: outcome.sideOk,
    tokens: outcome.tokens,
    usageAvailable: outcome.usageAvailable,
    usageSource: outcome.usageSource,
    rawUsage: outcome.rawUsage,
    durationMs: outcome.durationMs,
    steps: outcome.steps,
    model: side === "ts" ? context.model : context.opencodeModel,
    workspace: asRelative(workspace),
    logs: {
      side: asRelative(sideLogPath),
      judge: asRelative(judgeLogPath),
      session: sessionPath === null ? null : asRelative(sessionPath),
      stats: statsPath === null ? null : asRelative(statsPath),
    },
    versions: { bun: Bun.version, opencode: context.opencode?.version ?? null },
    judge: {
      testsOk: judge.testsOk,
      tscOk: judge.tscOk,
      fixtureOk: judge.fixtureOk,
      detail: judge.detail,
    },
    error: outcome.error,
    infraError: outcome.infraError,
  };
}

function printRecord(record: RunRecord): void {
  const seconds = (record.durationMs / 1000).toFixed(1);
  const label = record.ok ? "PASS" : "FAIL";
  process.stdout.write(
    `${label} ${record.task} ${record.side} rep${record.rep} (${seconds}s, tokens=${
      record.tokens.total ?? "unavailable"
    }, steps=${record.steps ?? "n/a"})\n`,
  );
  if (!record.ok) {
    if (record.judge !== null && record.judge.detail !== null) {
      process.stdout.write(`  - judge: ${record.judge.detail}\n`);
    }
    if (record.error !== null) {
      process.stdout.write(`  - error: ${record.error}\n`);
    }
  }
}

function writeReport(path: string, report: Report): void {
  writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }

  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const tscBin = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const date = new Date().toISOString().slice(0, 10);
  const defaultJson = args.pilot
    ? join(repoRoot, "benchmark", "results", `pilot-${date}.json`)
    : join(repoRoot, "benchmark", "results", `${date}.json`);
  const jsonPath =
    args.json === null
      ? defaultJson
      : isAbsolute(args.json)
        ? args.json
        : resolve(process.cwd(), args.json);
  const tasks = args.task === null ? TASKS.map((task) => task.name) : [args.task];
  const sides: Side[] = args.side === "both" ? ["ts", "opencode"] : [args.side];
  const reps = args.pilot ? PILOT_REPS : args.reps;

  const report: Report = {
    generatedAt: new Date().toISOString(),
    mode: args.pilot ? "pilot" : "full",
    tasks,
    sides,
    reps,
    model: args.model,
    bunVersion: Bun.version,
    opencodeVersion: null,
    infraErrors: [],
    runs: [],
  };

  let opencode: OpencodeContext | null = null;
  if (sides.includes("opencode")) {
    try {
      opencode = await probeOpencodeCli(repoRoot);
      report.opencodeVersion = opencode.version;
    } catch (error) {
      report.infraErrors.push(errorMessage(error));
    }
  }
  if (sides.includes("ts")) {
    try {
      readConfigFromEnv(args.model);
    } catch (error) {
      report.infraErrors.push(`typescript side cannot start: ${errorMessage(error)}`);
    }
  }
  if (report.infraErrors.length > 0) {
    writeReport(jsonPath, report);
    process.stderr.write(`infrastructure error: ${report.infraErrors.join("; ")}\n`);
    process.stdout.write(`report: ${jsonPath}\n`);
    return 2;
  }

  const trimStamp = (value: string): string => value.replace(/[:.]/g, "-");
  const runStamp = `${trimStamp(new Date().toISOString())}-${randomUUID().slice(0, 8)}`;
  const runRoot = join(repoRoot, "tmp", "benchmark", runStamp);
  mkdirSync(runRoot, { recursive: true });

  const context: RunContext = {
    repoRoot,
    tscBin,
    model: args.model,
    opencodeModel: opencodeModelId(args.model),
    opencode,
    runRoot,
  };

  for (const task of tasks) {
    for (const side of sides) {
      for (let rep = 1; rep <= reps; rep += 1) {
        const record = await runOnce(task, side, rep, context);
        report.runs.push(record);
        printRecord(record);
        if (record.infraError !== null) {
          report.infraErrors.push(record.infraError);
        }
      }
    }
  }

  if (args.keep) {
    process.stdout.write(`kept: ${runRoot}\n`);
  } else {
    rmSync(runRoot, { recursive: true, force: true });
  }

  writeReport(jsonPath, report);
  const passed = report.runs.filter((run) => run.ok).length;
  process.stdout.write(`benchmark: ${passed} passed, ${report.runs.length - passed} failed\n`);
  process.stdout.write(`report: ${jsonPath}\n`);
  if (report.infraErrors.length > 0) {
    process.stderr.write(`infrastructure error: ${report.infraErrors.join("; ")}\n`);
    return 2;
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`benchmark failed: ${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
