import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLedger, currentInputHashes } from "../src/provenance";
import { TASK_ISSUES } from "./run";

interface FixtureTask {
  readonly name: string;
  readonly module: string;
}

interface CommandResult {
  readonly ok: boolean;
  readonly output: string;
}

interface CheckOutcome {
  readonly ok: boolean;
  readonly detail: string | null;
}

interface LedgerOutcome {
  readonly ok: boolean;
  readonly summary: string;
  readonly lines: string[];
}

const TASKS: FixtureTask[] = [
  { name: "json-parser", module: "json" },
  { name: "sexp-parser", module: "sexp" },
  { name: "minilisp", module: "lisp" },
  { name: "csv-parser", module: "csv" },
];

const OUTPUT_LIMIT = 500;

function summarize(output: string): string {
  const text = output.trim();
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}...` : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function run(command: string[], cwd: string): CommandResult {
  const result = Bun.spawnSync(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 240_000,
  });
  return {
    ok: result.exitCode === 0,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

function checkTask(
  task: FixtureTask,
  repoRoot: string,
  workspace: string,
  tscBin: string,
): CheckOutcome {
  const red = run(["bun", "test"], workspace);
  const missingModule = `Cannot find module './${task.module}'`;
  if (red.ok) {
    return { ok: false, detail: "initial bun test unexpectedly passed without an implementation" };
  }
  if (!red.output.includes(missingModule)) {
    return {
      ok: false,
      detail: `initial bun test did not report a module-resolution error for './${task.module}': ${summarize(red.output)}`,
    };
  }

  const reference = join(repoRoot, "benchmark", "references", `${task.module}.ts`);
  cpSync(reference, join(workspace, "src", `${task.module}.ts`));

  const green = run(["bun", "test"], workspace);
  if (!green.ok) {
    return {
      ok: false,
      detail: `bun test failed after applying benchmark/references/${task.module}.ts: ${summarize(green.output)}`,
    };
  }

  const typecheck = run(["bun", tscBin, "--noEmit"], workspace);
  if (!typecheck.ok) {
    return {
      ok: false,
      detail: `tsc failed after applying benchmark/references/${task.module}.ts: ${summarize(typecheck.output)}`,
    };
  }

  return { ok: true, detail: null };
}

// Zero-API ledger pass (#66): re-derive every `## Rows` entry of
// `benchmark/results/consumption.md` from its cited source JSON, and flag
// (without failing) rows whose recorded input hashes no longer match the tree.
function checkLedgerFile(ledgerPath: string, repoRoot: string): LedgerOutcome {
  if (!existsSync(ledgerPath)) {
    return { ok: false, summary: `ledger: ${ledgerPath} missing`, lines: [] };
  }
  const markdown = readFileSync(ledgerPath, "utf8");
  const result = checkLedger(markdown, {
    loadSource: (path) => {
      const absolute = join(repoRoot, path);
      if (!existsSync(absolute)) {
        return null;
      }
      try {
        return JSON.parse(readFileSync(absolute, "utf8"));
      } catch {
        return null;
      }
    },
    currentFor: (json) => {
      const tasks = Array.isArray(json["tasks"])
        ? (json["tasks"] as unknown[]).filter((task): task is string => typeof task === "string")
        : [];
      const model = typeof json["model"] === "string" ? json["model"] : "";
      const reps = typeof json["reps"] === "number" ? json["reps"] : 1;
      const effort = typeof json["effort"] === "string" ? json["effort"] : null;
      const multiPayload = json["multiPayload"] === true;
      const protocolFormat = json["protocolFormat"] === "compact" ? "compact" : "json";
      const tokenBudget = typeof json["tokenBudget"] === "number" ? json["tokenBudget"] : null;
      try {
        return currentInputHashes(repoRoot, {
          tasks,
          taskIssues: TASK_ISSUES,
          model,
          multiPayload,
          protocolFormat,
          effort,
          reps,
          tokenBudget,
        });
      } catch {
        return null;
      }
    },
  });
  const lines: string[] = [];
  for (const failure of result.failures) {
    lines.push(`FAIL ${failure}`);
  }
  for (const stale of result.staleFlags) {
    lines.push(stale);
  }
  const failed = result.failures.length;
  return {
    ok: failed === 0,
    summary: `ledger: ${result.rows} rows, ${result.checked} checked, ${result.fresh} fresh, ${result.stale} stale, ${failed} failed`,
    lines,
  };
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  let ledgerOverride: string | null = null;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === "--keep") {
      continue;
    }
    if (argument === "--ledger") {
      const value = process.argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        process.stderr.write("missing value for --ledger\n");
        process.exitCode = 2;
        return;
      }
      ledgerOverride = value;
      index += 1;
      continue;
    }
    process.stderr.write(`unknown argument: ${argument}\n`);
    process.exitCode = 2;
    return;
  }

  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const ledgerPath =
    ledgerOverride === null
      ? join(repoRoot, "benchmark", "results", "consumption.md")
      : isAbsolute(ledgerOverride)
        ? ledgerOverride
        : resolve(process.cwd(), ledgerOverride);
  const tscBin = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const workspaceRoot = join(repoRoot, "tmp", "benchmark-check");

  rmSync(workspaceRoot, { recursive: true, force: true });
  mkdirSync(workspaceRoot, { recursive: true });

  let passed = 0;
  for (const task of TASKS) {
    const started = performance.now();
    const workspace = join(workspaceRoot, task.name);
    let outcome: CheckOutcome;
    try {
      cpSync(join(repoRoot, "benchmark", "fixtures", task.name), workspace, { recursive: true });
      outcome = checkTask(task, repoRoot, workspace, tscBin);
    } catch (error) {
      outcome = { ok: false, detail: errorMessage(error) };
    }
    const durationMs = Math.round(performance.now() - started);
    process.stdout.write(`${outcome.ok ? "PASS" : "FAIL"} ${task.name} (${durationMs}ms)\n`);
    if (!outcome.ok && outcome.detail !== null) {
      process.stdout.write(`  - ${outcome.detail}\n`);
    }
    if (outcome.ok) {
      passed += 1;
    }
    if (keep) {
      process.stdout.write(`kept: ${workspace}\n`);
    }
  }

  const failed = TASKS.length - passed;
  const ledger = checkLedgerFile(ledgerPath, repoRoot);
  for (const line of ledger.lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(`${ledger.summary}\n`);
  process.stdout.write(`benchmark-check: ${passed} passed, ${failed} failed\n`);
  if (!keep) {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
  process.exitCode = failed === 0 && ledger.ok ? 0 : 1;
}

await main();
