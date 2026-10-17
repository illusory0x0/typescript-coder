import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

const TASKS: FixtureTask[] = [
  { name: "json-parser", module: "json" },
  { name: "sexp-parser", module: "sexp" },
  { name: "minilisp", module: "lisp" },
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

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--keep");
  if (unknown.length > 0) {
    process.stderr.write(`unknown argument: ${unknown[0]}\n`);
    process.exitCode = 2;
    return;
  }

  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
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
  process.stdout.write(`benchmark-check: ${passed} passed, ${failed} failed\n`);
  if (!keep) {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
