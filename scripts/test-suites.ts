import { availableParallelism } from "node:os";

/** Which API lane a suite belongs to. `none` is network-free. */
export type SuiteApi = "none" | "llm";

/** Which lanes the runner selects. */
export type ApiMode = SuiteApi | "all";

/**
 * One independently runnable test suite. `owner` groups suites that should
 * share a bounded API lane; `api` is the visible contract that decides whether
 * the suite may touch the network. `parallel` appends `--parallel=<jobs>` to a
 * `bun test` command.
 */
export interface TestSuite {
  readonly id: string;
  readonly owner: string;
  readonly api: SuiteApi;
  readonly description: string;
  readonly cwd: string;
  readonly command: readonly string[];
  readonly slow?: boolean;
  readonly parallel?: boolean;
}

export const TEST_SUITES: readonly TestSuite[] = [
  {
    id: "editor",
    owner: "typescript-editor",
    api: "none",
    description: "typescript-editor unit suite",
    cwd: "typescript-editor",
    command: ["bun", "test"],
    parallel: true,
  },
  {
    id: "harness",
    owner: "harness",
    api: "none",
    description: "harness unit suite",
    cwd: "harness",
    command: ["bun", "test"],
    parallel: true,
  },
  {
    id: "scripts",
    owner: "scripts",
    api: "none",
    description: "repository script tests, including this runner",
    cwd: ".",
    command: ["bun", "test", "scripts"],
    parallel: true,
  },
  {
    id: "acceptance",
    owner: "acceptance",
    api: "none",
    description: "fast offline acceptance scenarios",
    cwd: ".",
    command: ["bun", "run", "acceptance/run.ts"],
  },
  {
    id: "acceptance-self-host",
    owner: "acceptance",
    api: "none",
    description: "slow self-host acceptance scenario",
    cwd: ".",
    command: ["bun", "run", "acceptance/run.ts", "--only", "self-host"],
    slow: true,
  },
  {
    id: "acceptance-live",
    owner: "acceptance",
    api: "llm",
    description: "real-model acceptance scenario; costs money",
    cwd: ".",
    command: ["bun", "run", "acceptance/run.ts", "--live-only"],
  },
];

export const MAX_JOBS = 4;

export interface SelectOptions {
  readonly api: ApiMode;
  readonly owners: readonly string[];
  readonly only: readonly string[];
  readonly includeSlow: boolean;
}

export interface RunnerOptions extends SelectOptions {
  readonly jobs: number;
  readonly apiJobs: number;
  readonly list: boolean;
  readonly help: boolean;
}

export function defaultJobs(): number {
  const override = process.env["TC_TEST_JOBS"];
  if (override !== undefined && override.length > 0) {
    if (!/^[1-9][0-9]*$/.test(override)) {
      throw new Error(`TC_TEST_JOBS must be a positive integer, got ${JSON.stringify(override)}`);
    }
    return Number(override);
  }
  return Math.max(1, Math.min(availableParallelism(), MAX_JOBS));
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function positiveInteger(flag: string, value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${flag} requires a positive integer, got ${JSON.stringify(value)}`);
  }
  return Number(value);
}

function parseApi(value: string): ApiMode {
  if (value === "none" || value === "llm" || value === "all") {
    return value;
  }
  throw new Error(`--api must be none, llm, or all, got ${JSON.stringify(value)}`);
}

export function parseRunnerArgs(
  argv: readonly string[],
  jobs: number = defaultJobs(),
): RunnerOptions {
  const options: {
    api: ApiMode;
    jobs: number;
    apiJobs: number;
    owners: string[];
    only: string[];
    includeSlow: boolean;
    list: boolean;
    help: boolean;
  } = {
    api: "none",
    jobs,
    apiJobs: 1,
    owners: [],
    only: [],
    includeSlow: false,
    list: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? null : arg.slice(equals + 1);
    const take = (): string => {
      if (inline !== null) {
        return inline;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      index += 1;
      return value;
    };
    const rejectValue = (): void => {
      if (inline !== null) {
        throw new Error(`${flag} does not take a value`);
      }
    };

    switch (flag) {
      case "--api": {
        options.api = parseApi(take());
        break;
      }
      case "--jobs": {
        options.jobs = positiveInteger(flag, take());
        break;
      }
      case "--api-jobs": {
        options.apiJobs = positiveInteger(flag, take());
        break;
      }
      case "--owner": {
        options.owners.push(...splitList(take()));
        break;
      }
      case "--only": {
        options.only.push(...splitList(take()));
        break;
      }
      case "--include-slow": {
        rejectValue();
        options.includeSlow = true;
        break;
      }
      case "--list": {
        rejectValue();
        options.list = true;
        break;
      }
      case "--help":
      case "-h": {
        rejectValue();
        options.help = true;
        break;
      }
      default: {
        if (arg.startsWith("-")) {
          throw new Error(`unknown option: ${arg}`);
        }
        throw new Error(`unexpected argument: ${arg}`);
      }
    }
  }

  return options;
}

/**
 * Keep the API filter authoritative: `--only acceptance-live` without
 * `--api llm` is rejected instead of quietly calling the model.
 */
export function selectSuites(
  options: SelectOptions,
  suites: readonly TestSuite[] = TEST_SUITES,
): TestSuite[] {
  const byId = new Map(suites.map((suite) => [suite.id, suite]));
  const knownOwners = new Set(suites.map((suite) => suite.owner));

  for (const owner of options.owners) {
    if (!knownOwners.has(owner)) {
      throw new Error(
        `unknown owner ${JSON.stringify(owner)}; known owners: ${[...knownOwners].join(", ")}`,
      );
    }
  }
  for (const id of options.only) {
    if (!byId.has(id)) {
      throw new Error(
        `unknown suite ${JSON.stringify(id)}; known suites: ${[...byId.keys()].join(", ")}`,
      );
    }
  }

  const owners = new Set(options.owners);
  const only = new Set(options.only);
  const selected = suites.filter((suite) => {
    if (options.api === "none" && suite.api !== "none") {
      return false;
    }
    if (options.api === "llm" && suite.api !== "llm") {
      return false;
    }
    if (owners.size > 0 && !owners.has(suite.owner)) {
      return false;
    }
    if (only.size > 0 && !only.has(suite.id)) {
      return false;
    }
    if (!options.includeSlow && suite.slow === true && !only.has(suite.id)) {
      return false;
    }
    return true;
  });

  if (selected.length > 0) {
    return selected;
  }

  const requested = options.only
    .map((id) => byId.get(id))
    .filter((suite): suite is TestSuite => suite !== undefined);
  if (options.api === "none") {
    const liveOnly = requested.filter((suite) => suite.api === "llm");
    if (liveOnly.length > 0) {
      const names = liveOnly.map((suite) => suite.id).join(", ");
      throw new Error(
        `no suites selected: ${names} ${liveOnly.length === 1 ? "requires" : "require"} --api llm or --api all`,
      );
    }
  }
  if (options.api === "llm") {
    const offlineOnly = requested.filter((suite) => suite.api === "none");
    if (offlineOnly.length > 0) {
      const names = offlineOnly.map((suite) => suite.id).join(", ");
      throw new Error(
        `no suites selected: ${names} ${offlineOnly.length === 1 ? "is" : "are"} api=none; use --api none or --api all`,
      );
    }
  }
  throw new Error("no test suites selected");
}
