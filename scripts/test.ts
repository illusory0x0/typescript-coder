import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_JOBS, TEST_SUITES, parseRunnerArgs, selectSuites } from "./test-suites";
import type { RunnerOptions, TestSuite } from "./test-suites";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const HELP = `Usage: just test [options]

Run the repository test suites. The default lane is api=none: no network, no
API key. Suites are declared in scripts/test-suites.ts.

Options:
  --api none|llm|all   Lane to run (default: none; llm calls the real model)
  --jobs <n>           File-level workers per offline bun-test suite
                       (default: min(nproc, 4); capped at 4)
  --api-jobs <n>       Concurrent API suites per owner (default: 1; capped at 4)
  --owner <list>       Only suites with these owners (comma-separated)
  --only <list>        Only these suite ids (comma-separated)
  --include-slow       Include slow offline suites (acceptance-self-host)
  --list               List every suite and its lane, then exit
  -h, --help           Show this help

Examples:
  just test
  just test --jobs 2 --include-slow
  just test --api llm
  just test --api all --api-jobs 1
`;

interface RunResult {
  suite: TestSuite;
  code: number;
  durationMs: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function effectiveJobs(value: number, flag: string): number {
  if (value <= MAX_JOBS) {
    return value;
  }
  process.stdout.write(`${flag}: capping ${value} workers at ${MAX_JOBS}\n`);
  return MAX_JOBS;
}

function commandFor(suite: TestSuite, jobs: number): string[] {
  if (suite.parallel === true && jobs > 1) {
    return [...suite.command, `--parallel=${jobs}`];
  }
  return [...suite.command];
}

async function runSuite(suite: TestSuite, options: RunnerOptions): Promise<RunResult> {
  const command = commandFor(suite, options.jobs);
  process.stdout.write(
    `RUN   api=${suite.api}  ${suite.id}  [${suite.owner}]  ${command.join(" ")}\n`,
  );
  const started = performance.now();
  try {
    const child = Bun.spawn(command, {
      cwd: join(REPO_ROOT, suite.cwd),
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    const code = await child.exited;
    const durationMs = Math.round(performance.now() - started);
    process.stdout.write(
      `${code === 0 ? "PASS" : "FAIL"}  api=${suite.api}  ${suite.id}  (${durationMs}ms)\n`,
    );
    return { suite, code, durationMs };
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    process.stderr.write(`FAIL  api=${suite.api}  ${suite.id}: ${messageOf(error)}\n`);
    return { suite, code: 1, durationMs };
  }
}

async function runSequential(suites: TestSuite[], options: RunnerOptions): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const suite of suites) {
    results.push(await runSuite(suite, options));
  }
  return results;
}

async function runGroup(
  suites: TestSuite[],
  concurrency: number,
  options: RunnerOptions,
): Promise<RunResult[]> {
  const queue = [...suites];
  const results: RunResult[] = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const suite = queue.shift();
      if (suite === undefined) {
        return;
      }
      results.push(await runSuite(suite, options));
    }
  });
  await Promise.all(workers);
  return results;
}

interface ApiRun {
  results: RunResult[];
  skipped: TestSuite[];
}

/**
 * One owner is one API lane. Owners run one after another; inside an owner up
 * to `--api-jobs` suites may run at once, so the default (1) never fans out.
 * A failing owner stops later owners to avoid spending more money.
 */
async function runApi(suites: TestSuite[], options: RunnerOptions): Promise<ApiRun> {
  const groups = new Map<string, TestSuite[]>();
  for (const suite of suites) {
    const group = groups.get(suite.owner);
    if (group === undefined) {
      groups.set(suite.owner, [suite]);
    } else {
      group.push(suite);
    }
  }

  const results: RunResult[] = [];
  const skipped: TestSuite[] = [];
  let stop = false;
  for (const group of groups.values()) {
    if (stop) {
      skipped.push(...group);
      continue;
    }
    const groupResults = await runGroup(group, options.apiJobs, options);
    results.push(...groupResults);
    stop = groupResults.some((result) => result.code !== 0);
  }
  return { results, skipped };
}

function printList(): void {
  const rows = TEST_SUITES.map((suite) => ({
    api: suite.api,
    id: suite.id,
    owner: suite.owner,
    slow: suite.slow === true ? "yes" : "no",
    command: suite.command.join(" "),
  }));
  const widths = {
    api: Math.max("api".length, ...rows.map((row) => row.api.length)),
    id: Math.max("id".length, ...rows.map((row) => row.id.length)),
    owner: Math.max("owner".length, ...rows.map((row) => row.owner.length)),
    slow: Math.max("slow".length, ...rows.map((row) => row.slow.length)),
  };
  const line = (cells: { api: string; id: string; owner: string; slow: string; command: string }) =>
    `${cells.api.padEnd(widths.api)}  ${cells.id.padEnd(widths.id)}  ${cells.owner.padEnd(widths.owner)}  ${cells.slow.padEnd(widths.slow)}  ${cells.command}`;
  process.stdout.write(
    `${line({ api: "api", id: "id", owner: "owner", slow: "slow", command: "command" })}\n`,
  );
  for (const row of rows) {
    process.stdout.write(`${line(row)}\n`);
  }
}

async function main(): Promise<void> {
  let options: RunnerOptions;
  let suites: TestSuite[];
  try {
    options = parseRunnerArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }
    if (options.list) {
      printList();
      return;
    }
    suites = selectSuites(options);
  } catch (error) {
    process.stderr.write(`test: ${messageOf(error)}\n`);
    process.exitCode = 2;
    return;
  }

  options = {
    ...options,
    jobs: effectiveJobs(options.jobs, "--jobs"),
    apiJobs: effectiveJobs(options.apiJobs, "--api-jobs"),
  };

  const offline = suites.filter((suite) => suite.api === "none");
  const api = suites.filter((suite) => suite.api === "llm");
  const results: RunResult[] = [];
  let apiSkipped: TestSuite[] = [];

  if (offline.length > 0) {
    process.stdout.write(`test: api=none suites=${offline.length} jobs=${options.jobs}\n`);
    results.push(...(await runSequential(offline, options)));
  }

  if (api.length > 0) {
    if (results.some((result) => result.code !== 0)) {
      apiSkipped = api;
      process.stdout.write("test: skipping api=llm suites because offline suites failed\n");
    } else {
      process.stdout.write(
        `test: api=llm suites=${api.length} api-jobs=${options.apiJobs}; these call the real model and cost money\n`,
      );
      const apiRun = await runApi(api, options);
      results.push(...apiRun.results);
      apiSkipped = apiRun.skipped;
    }
  }

  const failed = results.filter((result) => result.code !== 0).length;
  const passed = results.length - failed;
  process.stdout.write(`test: ${passed} passed, ${failed} failed\n`);
  if (apiSkipped.length > 0) {
    process.stdout.write(
      `test: skipped ${apiSkipped.length} api suite(s): ${apiSkipped.map((suite) => suite.id).join(", ")}\n`,
    );
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
