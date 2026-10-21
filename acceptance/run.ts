import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runLoop } from "../src/loop";
import type { LoopResult, ProviderLike } from "../src/loop";
import { OpenAIProvider, readConfigFromEnv } from "../src/openai";
import type { ChatMessage } from "../src/openai";
import { scenarios, ScriptedProvider } from "./scenarios";
import type { Scenario, ScenarioArtifacts, ScenarioAssertion } from "./scenarios";

type ScenarioStatus = "passed" | "failed" | "error";

interface AssertionRecord {
  name: string;
  ok: boolean;
  detail?: string;
}

interface ScenarioReport {
  id: string;
  title: string;
  slow: boolean;
  live?: boolean;
  model?: string;
  status: ScenarioStatus;
  durationMs: number;
  records: number;
  assertions: AssertionRecord[];
  diagnostics: string | null;
}

interface Totals {
  passed: number;
  failed: number;
  skipped: number;
}

interface Report {
  generatedAt: string;
  bunVersion: string;
  all: boolean;
  only: string | null;
  overall: "passed" | "failed";
  totals: Totals;
  scenarios: ScenarioReport[];
}

interface CliArgs {
  all: boolean;
  live: boolean;
  model: string | null;
  only: string | null;
  keep: boolean;
  json: string | null;
  induceFailureRequested: boolean;
  induceFailureId: string | null;
  help: boolean;
}

interface RunContext {
  repoRoot: string;
  checkCommand: string[];
  testCommand: string[];
  model: string;
}

const LIVE_TIMEOUT_MS = 90_000;

// Bun types `fetch` with an extra `preconnect` method (see bun-types docs);
// OpenAIProvider never calls it, so a direct cast is the documented pattern
// for fetch wrappers.
function fetchWithTimeout(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);
const DIAGNOSTICS_LIMIT = 500;
const SYNTHETIC_FAILURE: AssertionRecord = {
  name: "induced failure",
  ok: false,
  detail: "--induce-failure forced this scenario to fail",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function printUsage(): void {
  process.stdout.write(`Usage: just accept [options]

Options:
  --all                    include slow scenarios
  --live                   also run live scenarios that call the real model
                           (requires OPENAI_API_KEY and OPENAI_BASE_URL)
  --model <id>             model id for live scenarios
                           (default: $ACCEPT_MODEL or deepseek-v4.1-flash)
  --only <id>              run a single scenario by id
  --keep                   keep temporary directories
  --json <path>            report output path (default: acceptance/report.json)
  --induce-failure [id]    add a synthetic failing assertion to the given scenario
                           (or to every selected scenario when no id is given)
  --help, -h               print this help and exit
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    all: false,
    live: false,
    model: null,
    only: null,
    keep: false,
    json: null,
    induceFailureRequested: false,
    induceFailureId: null,
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
      case "--live": {
        args.live = true;
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
      case "--only": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          fail("missing value for --only");
        }
        args.only = value;
        index += 1;
        break;
      }
      case "--json": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          fail("missing value for --json");
        }
        args.json = value;
        index += 1;
        break;
      }
      case "--model": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          fail("missing value for --model");
        }
        args.model = value;
        index += 1;
        break;
      }
      case "--induce-failure": {
        args.induceFailureRequested = true;
        const value = argv[index + 1];
        if (value !== undefined && !value.startsWith("-")) {
          args.induceFailureId = value;
          index += 1;
        }
        break;
      }
      default: {
        fail(`unknown argument: ${arg}`);
      }
    }
  }
  return args;
}

function selectScenarios(args: CliArgs): Scenario[] {
  if (args.only !== null) {
    const match = scenarios.find((scenario) => scenario.id === args.only);
    if (match === undefined) {
      fail(`unknown scenario: ${args.only}`);
    }
    if (match.live === true && !args.live) {
      fail(`scenario ${match.id} is a live scenario; rerun with --live`);
    }
    return [match];
  }
  return scenarios.filter((scenario) => {
    if (scenario.live === true) {
      return args.live;
    }
    return args.all || scenario.slow !== true;
  });
}

function walkSources(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.set(relative(root, fullPath).split(sep).join("/"), readFileSync(fullPath, "utf8"));
      }
    }
  };
  visit(root);
  return files;
}

function evaluate(assertion: ScenarioAssertion, artifacts: ScenarioArtifacts): AssertionRecord {
  try {
    const outcome = assertion.check(artifacts);
    const record: AssertionRecord = { name: assertion.name, ok: outcome.ok };
    if (outcome.detail !== undefined) {
      record.detail = outcome.detail;
    }
    return record;
  } catch (error) {
    return { name: assertion.name, ok: false, detail: errorMessage(error) };
  }
}

function printScenario(report: ScenarioReport): void {
  const label = report.status === "passed" ? "PASS" : "FAIL";
  process.stdout.write(`${label} ${report.id} (${report.durationMs}ms)\n`);
  if (report.status === "error") {
    process.stdout.write(`  - error: ${report.diagnostics ?? ""}\n`);
  }
  for (const assertion of report.assertions) {
    if (!assertion.ok) {
      process.stdout.write(`  - ${assertion.name}: ${assertion.detail ?? ""}\n`);
    }
  }
}

async function runScenario(
  scenario: Scenario,
  args: CliArgs,
  context: RunContext,
): Promise<ScenarioReport> {
  const dir = mkdtempSync(join(tmpdir(), `accept-${scenario.id}-`));
  try {
    if (scenario.fixture !== null) {
      cpSync(join(context.repoRoot, "acceptance", "fixtures", scenario.fixture), dir, {
        recursive: true,
      });
    } else if (scenario.prepare !== undefined) {
      scenario.prepare(dir, context.repoRoot);
    }
    const originals = walkSources(dir);
    const live = scenario.live === true;
    let provider: ProviderLike | null = null;
    let calls: ChatMessage[][] | undefined;
    const started = performance.now();
    let result: LoopResult | null = null;
    let errorText: string | null = null;
    try {
      if (live) {
        const config = readConfigFromEnv(context.model);
        provider = new OpenAIProvider(config, fetchWithTimeout as typeof fetch);
      } else {
        const scripted = new ScriptedProvider(scenario.responses);
        provider = scripted;
        calls = scripted.calls;
      }
      result = await runLoop({
        cwd: dir,
        issue: scenario.issue,
        provider,
        temperature: live ? 0 : undefined,
        checkCommand: context.checkCommand,
        testCommand: context.testCommand,
      });
    } catch (error) {
      errorText = errorMessage(error);
    }
    const finals = walkSources(dir);
    let assertions: AssertionRecord[] = [];
    if (result !== null && provider !== null) {
      const artifacts: ScenarioArtifacts = { dir, result, provider, originals, finals };
      if (calls !== undefined) {
        artifacts.calls = calls;
      }
      assertions = scenario.assertions.map((assertion) => evaluate(assertion, artifacts));
    }
    const induced =
      args.induceFailureRequested &&
      (args.induceFailureId === null || args.induceFailureId === scenario.id);
    if (induced) {
      assertions.push({ ...SYNTHETIC_FAILURE });
    }
    const status: ScenarioStatus =
      result === null
        ? "error"
        : assertions.every((assertion) => assertion.ok)
          ? "passed"
          : "failed";
    const durationMs = Math.round(performance.now() - started);
    const diagnostics =
      result === null
        ? truncate(errorText ?? "unknown error", DIAGNOSTICS_LIMIT)
        : result.diagnostics === null
          ? null
          : truncate(result.diagnostics, DIAGNOSTICS_LIMIT);
    const report: ScenarioReport = {
      id: scenario.id,
      title: scenario.title,
      slow: scenario.slow === true,
      status,
      durationMs,
      records: result?.records.length ?? 0,
      assertions,
      diagnostics,
    };
    if (live) {
      report.live = true;
      report.model = context.model;
    }
    printScenario(report);
    return report;
  } finally {
    if (args.keep) {
      process.stdout.write(`kept: ${dir}\n`);
    } else {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function writeReport(path: string, report: Report): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const tscBin =
    process.env["ACCEPT_TSC"] ?? join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const model = args.model ?? process.env["ACCEPT_MODEL"] ?? "deepseek-v4.1-flash";
  const context: RunContext = {
    repoRoot,
    checkCommand: ["bun", tscBin, "--noEmit"],
    testCommand: ["bun", "test"],
    model,
  };
  const jsonPath = args.json ?? join(repoRoot, "acceptance", "report.json");

  const selected = selectScenarios(args);
  if (
    args.induceFailureRequested &&
    args.induceFailureId !== null &&
    !scenarios.some((scenario) => scenario.id === args.induceFailureId)
  ) {
    fail(`unknown scenario: ${args.induceFailureId}`);
  }

  const reports: ScenarioReport[] = [];
  for (const scenario of selected) {
    reports.push(await runScenario(scenario, args, context));
  }

  const passed = reports.filter((report) => report.status === "passed").length;
  const failed = reports.length - passed;
  const report: Report = {
    generatedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    all: args.all,
    only: args.only,
    overall: failed === 0 ? "passed" : "failed",
    totals: { passed, failed, skipped: scenarios.length - reports.length },
    scenarios: reports,
  };
  writeReport(jsonPath, report);

  process.stdout.write(`acceptance: ${passed} passed, ${failed} failed\n`);
  process.stdout.write(`report: ${jsonPath}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
