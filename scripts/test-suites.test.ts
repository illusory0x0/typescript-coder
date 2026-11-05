import { describe, expect, test } from "bun:test";
import { TEST_SUITES, parseRunnerArgs, selectSuites } from "./test-suites";
import type { SelectOptions } from "./test-suites";

const OFFLINE: SelectOptions = {
  api: "none",
  owners: [],
  only: [],
  includeSlow: false,
};

describe("test suite registry", () => {
  test("ids are unique and every suite has an owner and a command", () => {
    const ids = TEST_SUITES.map((suite) => suite.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const suite of TEST_SUITES) {
      expect(suite.owner.length).toBeGreaterThan(0);
      expect(suite.command.length).toBeGreaterThan(0);
      expect(suite.description.length).toBeGreaterThan(0);
    }
  });

  test("every api=llm suite is explicit about the live lane", () => {
    for (const suite of TEST_SUITES) {
      if (suite.api === "llm") {
        expect(suite.command).toContain("--live-only");
      }
    }
  });
});

describe("parseRunnerArgs", () => {
  test("defaults to the offline lane, one api job, and no slow suites", () => {
    expect(parseRunnerArgs([], 2)).toEqual({
      api: "none",
      jobs: 2,
      apiJobs: 1,
      owners: [],
      only: [],
      includeSlow: false,
      list: false,
      help: false,
    });
  });

  test("reads the lane and worker flags in both value forms", () => {
    const parsed = parseRunnerArgs(
      [
        "--api=all",
        "--jobs",
        "3",
        "--api-jobs=2",
        "--owner",
        "harness,scripts",
        "--only",
        "harness",
      ],
      2,
    );
    expect(parsed.api).toBe("all");
    expect(parsed.jobs).toBe(3);
    expect(parsed.apiJobs).toBe(2);
    expect(parsed.owners).toEqual(["harness", "scripts"]);
    expect(parsed.only).toEqual(["harness"]);
  });

  test("reads boolean flags", () => {
    const parsed = parseRunnerArgs(["--include-slow", "--list", "--help"], 2);
    expect(parsed.includeSlow).toBe(true);
    expect(parsed.list).toBe(true);
    expect(parsed.help).toBe(true);
  });

  test("rejects a bad lane, a bad worker count, and unknown arguments", () => {
    expect(() => parseRunnerArgs(["--api", "sometimes"], 2)).toThrow(/--api must be/);
    expect(() => parseRunnerArgs(["--jobs", "0"], 2)).toThrow(/positive integer/);
    expect(() => parseRunnerArgs(["--api-jobs", "x"], 2)).toThrow(/positive integer/);
    expect(() => parseRunnerArgs(["--verbose"], 2)).toThrow(/unknown option/);
    expect(() => parseRunnerArgs(["harness"], 2)).toThrow(/unexpected argument/);
  });

  test("rejects a value on a boolean flag", () => {
    expect(() => parseRunnerArgs(["--include-slow=yes"], 2)).toThrow(/does not take a value/);
  });
});

describe("selectSuites", () => {
  test("the default lane never selects an api=llm or slow suite", () => {
    const ids = selectSuites(OFFLINE).map((suite) => suite.id);
    expect(ids).toEqual(["editor", "harness", "scripts", "acceptance"]);
    expect(ids).not.toContain("acceptance-live");
    expect(ids).not.toContain("acceptance-self-host");
  });

  test("api=llm selects only real-model suites", () => {
    const ids = selectSuites({ ...OFFLINE, api: "llm" }).map((suite) => suite.id);
    expect(ids).toEqual(["acceptance-live"]);
  });

  test("api=all includes both lanes but still excludes slow suites", () => {
    const ids = selectSuites({ ...OFFLINE, api: "all" }).map((suite) => suite.id);
    expect(ids).toContain("acceptance");
    expect(ids).toContain("acceptance-live");
    expect(ids).not.toContain("acceptance-self-host");
  });

  test("--owner filters suites without crossing lanes", () => {
    const offline = selectSuites({ ...OFFLINE, owners: ["acceptance"] }).map((suite) => suite.id);
    expect(offline).toEqual(["acceptance"]);
    const all = selectSuites({ ...OFFLINE, api: "all", owners: ["acceptance"] }).map(
      (suite) => suite.id,
    );
    expect(all).toEqual(["acceptance", "acceptance-live"]);
  });

  test("--include-slow adds the self-host suite", () => {
    const ids = selectSuites({ ...OFFLINE, includeSlow: true }).map((suite) => suite.id);
    expect(ids).toContain("acceptance-self-host");
  });

  test("an explicit --only runs a slow suite without --include-slow", () => {
    const ids = selectSuites({ ...OFFLINE, only: ["acceptance-self-host"] }).map(
      (suite) => suite.id,
    );
    expect(ids).toEqual(["acceptance-self-host"]);
  });

  test("--only cannot override the API lane", () => {
    expect(() => selectSuites({ ...OFFLINE, only: ["acceptance-live"] })).toThrow(
      /--api llm or --api all/,
    );
    expect(() => selectSuites({ ...OFFLINE, api: "llm", only: ["acceptance"] })).toThrow(
      /api=none; use --api none or --api all/,
    );
  });

  test("unknown owners and suite ids are rejected", () => {
    expect(() => selectSuites({ ...OFFLINE, owners: ["nope"] })).toThrow(/unknown owner/);
    expect(() => selectSuites({ ...OFFLINE, only: ["nope"] })).toThrow(/unknown suite/);
  });
});
