import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { billableTokens } from "./benchmark-pricing";

// `benchmark/run.ts` lives outside the test root (`bunfig.toml` root = ./src).
// The self-host smoke test copies only `src/` into a scratch workspace, so this
// file must not statically import the benchmark module: it is loaded dynamically
// and the report tests skip when the module is absent from the copied tree.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const runModulePath = join(repoRoot, "benchmark", "run.ts");
const runModulePresent = existsSync(runModulePath);

interface BillableTriple {
  in: number;
  out: number;
  total: number;
}

interface TokenStatsLike {
  mean: number | null;
  total: number | null;
}

interface AggregateLike {
  task: string | null;
  side: string | null;
  protocol: string | null;
  runs: number;
  ok: number;
  tokens: { in: TokenStatsLike; out: TokenStatsLike; total: TokenStatsLike };
  tokensPerSuccess: { in: number | null; out: number | null; total: number | null };
  selectors: { range: number; matcher: number; wholeSymbol: number };
  stages: { wholeSymbol: number; match: number; pick: number };
  matcherKinds: { snippet: number; regex: number };
  creates: number;
}

interface AggregatesLike {
  bySide: AggregateLike[];
  byTaskSide: AggregateLike[];
  overall: AggregateLike[];
}

interface JobLike {
  task: string;
  side: string;
  rep: number;
  protocol: string | null;
}

interface RunModule {
  computeAggregates(
    runs: readonly unknown[],
    tasks: readonly string[],
    sides: readonly string[],
    protocols?: readonly string[],
  ): AggregatesLike;
  aggregateRuns(
    runs: readonly unknown[],
    task: string | null,
    side: string | null,
    protocol?: string | null,
  ): AggregateLike;
  buildJobs(
    tasks: readonly string[],
    sides: readonly string[],
    reps: number,
    protocols: readonly string[],
  ): JobLike[];
  runPool<Job, Result>(
    jobs: readonly Job[],
    concurrency: number,
    run: (job: Job, index: number) => Promise<Result>,
  ): Promise<Result[]>;
  parseProtocolFormats(value: string): string[];
  tokenMultiplierSentence(
    bySide: readonly AggregateLike[],
    byTaskSide: readonly AggregateLike[],
  ): string;
  savingsVsOcBaseline(
    currentByTaskSide: readonly AggregateLike[],
    baselineByTaskSide: readonly AggregateLike[],
  ): {
    rows: {
      task: string;
      protocol: string | null;
      baselineMean: number;
      currentMean: number;
      factor: number;
    }[];
    overall: {
      protocol: string | null;
      baselineSum: number;
      currentSum: number;
      factor: number;
      tasks: number;
    }[];
  };
  ocBaselineSavingsSentence(savings: unknown): string;
  frozenDimensionError(
    side: "tc" | "oc" | "both",
    protocolFormats: readonly ("json" | "edit-dsl")[],
  ): string | null;
  writeMarkdownReport(path: string, report: unknown): void;
  parseArgs(argv: string[]): {
    model: string;
    ocModel: string | null;
    side: string;
    protocolFormats: string[];
  };
  opencodeModelFor(model: string, ocModel: string | null): string;
}

async function loadRunModule(): Promise<RunModule> {
  return (await import(runModulePath)) as RunModule;
}

// A run carries raw provider buckets plus the normalized cache-excluded triple
// (#89); `makeRun` builds both so aggregate paths can be exercised directly.
function makeRun(
  task: string,
  side: "tc" | "oc",
  buckets: { input: number; output: number; cacheRead?: number },
  exchangeStats: Record<string, unknown> | null = null,
  protocol: string | null = null,
): Record<string, unknown> {
  const raw = {
    input: buckets.input,
    output: buckets.output,
    cacheRead: buckets.cacheRead ?? 0,
    cacheWrite: null,
    reasoning: 0,
    total: buckets.input + buckets.output,
  };
  return {
    task,
    side,
    protocol,
    rep: 1,
    ok: true,
    sideOk: true,
    tokens: { ...raw, billable: billableTokens(raw, side) },
    usageAvailable: true,
    usageSource: "test",
    rawUsage: null,
    durationMs: 1000,
    startedAt: "2026-10-20T00:00:00.000Z",
    finishedAt: "2026-10-20T00:01:00.000Z",
    cost: 0.001,
    rateClass: "off-peak",
    steps: 1,
    records: null,
    exchangeStats,
    loopDiagnostics: null,
    terminationReason: null,
    model: "deepseek-v4.1-flash",
    workspace: "ws",
    logs: { side: "s", judge: "j", session: null, stats: null },
    versions: { bun: "1.0.0", opencode: null },
    judge: null,
    error: null,
    infraError: null,
  };
}

const sampleRuns = (): Record<string, unknown>[] => [
  makeRun("json-parser", "tc", { input: 1000, cacheRead: 800, output: 500 }),
  makeRun("json-parser", "oc", { input: 900, cacheRead: 5000, output: 400 }),
  makeRun("sexp-parser", "tc", { input: 300, cacheRead: 200, output: 100 }),
  makeRun("sexp-parser", "oc", { input: 50, output: 50 }),
];

// tc `input` includes cache hits (miss = input - cacheRead); oc `input` already
// excludes them. The cache-excluded triple must match on both sides.
describe("cache-excluded token triple (#89)", () => {
  test("billableTokens subtracts cache on tc but not on oc", () => {
    const tc = billableTokens(
      { input: 3073, output: 1613, cacheRead: 2816, cacheWrite: null, reasoning: 0 },
      "tc",
    );
    expect(tc).toEqual({ in: 257, out: 1613, total: 1870 });
    const oc = billableTokens(
      { input: 9345, output: 2160, cacheRead: 22400, cacheWrite: null, reasoning: 0 },
      "oc",
    );
    expect(oc).toEqual({ in: 9345, out: 2160, total: 11505 });
    for (const triple of [tc, oc] as BillableTriple[]) {
      expect(triple.total).toBe(triple.in + triple.out);
    }
  });

  test.skipIf(!runModulePresent)(
    "aggregate in/out/total are cache-miss input / output / (miss + output)",
    async () => {
      const { aggregateRuns, computeAggregates } = await loadRunModule();
      const runs = sampleRuns();
      const aggregates = computeAggregates(runs, ["json-parser", "sexp-parser"], ["tc", "oc"]);
      const jsonTc = aggregateRuns(runs, "json-parser", "tc");
      expect(jsonTc.tokens.in).toEqual({ mean: 200, total: 200 });
      expect(jsonTc.tokens.out).toEqual({ mean: 500, total: 500 });
      expect(jsonTc.tokens.total).toEqual({ mean: 700, total: 700 });
      expect(jsonTc.tokensPerSuccess).toEqual({ in: 200, out: 500, total: 700 });

      const tcOverall = aggregates.bySide.find((row) => row.side === "tc");
      const ocOverall = aggregates.bySide.find((row) => row.side === "oc");
      // tc: (700 + 200) = 900; oc: (1300 + 100) = 1400.
      expect(tcOverall?.tokens.total.total).toBe(900);
      expect(ocOverall?.tokens.total.total).toBe(1400);
    },
  );

  test.skipIf(!runModulePresent)(
    "multiplier summary names the higher side overall and per task",
    async () => {
      const { computeAggregates, tokenMultiplierSentence } = await loadRunModule();
      const aggregates = computeAggregates(
        sampleRuns(),
        ["json-parser", "sexp-parser"],
        ["tc", "oc"],
      );
      const sentence = tokenMultiplierSentence(aggregates.bySide, aggregates.byTaskSide);
      expect(sentence).toContain("oc 1.56x tc overall");
      expect(sentence).toContain("json-parser oc 1.86x tc");
      expect(sentence).toContain("sexp-parser tc 2.00x oc");
    },
  );

  test.skipIf(!runModulePresent)("multiplier summary says so when only one side ran", async () => {
    const { computeAggregates, tokenMultiplierSentence } = await loadRunModule();
    const runs = [makeRun("json-parser", "tc", { input: 10, output: 5 })];
    const aggregates = computeAggregates(runs, ["json-parser"], ["tc"]);
    const sentence = tokenMultiplierSentence(aggregates.bySide, aggregates.byTaskSide);
    expect(sentence).toContain("not comparable");
  });

  test.skipIf(!runModulePresent)(
    "savings vs the oc baseline uses oc/tc per task and over the shared tasks",
    async () => {
      const { computeAggregates, savingsVsOcBaseline, ocBaselineSavingsSentence } =
        await loadRunModule();
      const tasks = ["json-parser", "sexp-parser"];
      const baseline = computeAggregates(
        [
          makeRun("json-parser", "oc", { input: 900, output: 400 }),
          makeRun("sexp-parser", "oc", { input: 400, output: 200 }),
        ],
        tasks,
        ["oc"],
      );
      // tc: json-parser 700, sexp-parser 200.
      const current = computeAggregates(sampleRuns(), tasks, ["tc"]);
      const savings = savingsVsOcBaseline(current.byTaskSide, baseline.byTaskSide);
      expect(savings.rows.map((row) => [row.task, row.factor.toFixed(2)])).toEqual([
        ["json-parser", "1.86"],
        ["sexp-parser", "3.00"],
      ]);
      expect(savings.overall).toHaveLength(1);
      expect(savings.overall[0]?.factor.toFixed(2)).toBe("2.11");
      expect(savings.overall[0]?.tasks).toBe(2);
      expect(ocBaselineSavingsSentence(savings)).toContain("2.11x fewer tokens across 2 tasks");
    },
  );

  test.skipIf(!runModulePresent)("savings skips tasks the baseline never ran", async () => {
    const { computeAggregates, savingsVsOcBaseline, ocBaselineSavingsSentence } =
      await loadRunModule();
    const baseline = computeAggregates(
      [makeRun("json-parser", "oc", { input: 900, output: 400 })],
      ["json-parser"],
      ["oc"],
    );
    const current = computeAggregates(
      [makeRun("json-parser", "tc", { input: 200, output: 100 })],
      ["json-parser"],
      ["tc"],
    );
    const savings = savingsVsOcBaseline(current.byTaskSide, baseline.byTaskSide);
    expect(savings.rows).toHaveLength(1);
    const empty = savingsVsOcBaseline(
      computeAggregates(
        [makeRun("minilisp", "tc", { input: 200, output: 100 })],
        ["minilisp"],
        ["tc"],
      ).byTaskSide,
      baseline.byTaskSide,
    );
    expect(empty.rows).toHaveLength(0);
    expect(ocBaselineSavingsSentence(empty)).toContain("not comparable");
  });
});

describe("rendered report (#89)", () => {
  test.skipIf(!runModulePresent)(
    "prints the cache-excluded tables and the multiplier summary",
    async () => {
      const { computeAggregates, writeMarkdownReport } = await loadRunModule();
      const runs = sampleRuns();
      const tasks = ["json-parser", "sexp-parser"];
      const sides = ["tc", "oc"];
      const report = {
        generatedAt: "2026-10-20T00:00:00.000Z",
        date: "2026-10-20",
        mode: "full",
        tasks,
        sides,
        reps: 1,
        concurrency: 1,
        model: "deepseek-v4.1-flash",
        effort: null,
        multiPayload: false,
        tokenBudget: null,
        bunVersion: "1.0.0",
        opencodeVersion: null,
        pilotReference: null,
        infraErrors: [],
        runs,
        aggregates: computeAggregates(runs, tasks, sides),
        provenance: {
          inputs: {
            model: "m",
            taskIssue: "t",
            fixture: "f",
            systemPrompt: "s",
            loopConfig: "l",
            pricing: "p",
          },
          inputHash: "h",
          computedAt: "2026-10-20T00:00:00.000Z",
        },
      };

      const dir = mkdtempSync(join(tmpdir(), "run-report-"));
      const mdPath = join(dir, "report.md");
      try {
        writeMarkdownReport(mdPath, report);
        const markdown = readFileSync(mdPath, "utf8");
        expect(markdown).toContain("Like-for-like tokens (#89)");
        expect(markdown).toContain("Mean in (no cache)");
        expect(markdown).toContain("decision-only");
        // json-parser tc: in 200, out 500, total 700 (no protocol on this
        // synthetic legacy record).
        expect(markdown).toContain("| json-parser | tc | n/a | 1/1 | 200 | 500 | 700 |");
        expect(markdown).toContain("oc 1.56x tc overall");
        expect(markdown).toContain("json-parser oc 1.86x tc");
        // #101: adoption surfaces per task/side and per side.
        expect(markdown).toContain("## Selector adoption (#101)");
        expect(markdown).toContain("| Task | Side | Protocol | range | matcher | whole-symbol |");
        expect(markdown).toContain("| Side | Protocol | range | matcher | whole-symbol |");
        // #110: resolved stages and matcher kinds surface alongside.
        expect(markdown).toContain("Resolved cascade stages and matcher kinds (#110)");
        expect(markdown).toContain(
          "| Task | Side | Protocol | whole-symbol | match | pick | snippet | regex |",
        );
        expect(markdown).toContain(
          "| Side | Protocol | whole-symbol | match | pick | snippet | regex |",
        );
        // #111: edit-dsl implicit-create clauses surface alongside.
        expect(markdown).toContain("Implicit creates (#111):");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("selector adoption aggregates (#101)", () => {
  const selectorStats = (range: number, matcher: number, wholeSymbol: number) => ({
    turns: 3,
    payloads: range + matcher + wholeSymbol,
    toolCalls: 1,
    applied: 2,
    rejected: 1,
    selected: 0,
    stopped: 0,
    range,
    matcher,
    wholeSymbol,
  });

  test.skipIf(!runModulePresent)(
    "sums per-run selector counts onto byTaskSide and bySide; absent stats contribute zero",
    async () => {
      const { aggregateRuns, computeAggregates } = await loadRunModule();
      const runs = [
        makeRun("json-parser", "tc", { input: 10, output: 5 }, selectorStats(2, 1, 0)),
        makeRun("json-parser", "tc", { input: 10, output: 5 }, selectorStats(0, 3, 1)),
        makeRun("json-parser", "tc", { input: 10, output: 5 }),
      ];
      const jsonTc = aggregateRuns(runs, "json-parser", "tc");
      expect(jsonTc.selectors).toEqual({ range: 2, matcher: 4, wholeSymbol: 1 });

      const aggregates = computeAggregates(runs, ["json-parser"], ["tc"]);
      const bySide = aggregates.bySide.find((row) => row.side === "tc");
      expect(bySide?.selectors).toEqual({ range: 2, matcher: 4, wholeSymbol: 1 });
    },
  );
});

describe("resolved stage and matcher-kind aggregates (#110)", () => {
  const stageStats = (over: Record<string, number> = {}) => ({
    turns: 3,
    payloads: 3,
    toolCalls: 0,
    applied: 3,
    rejected: 0,
    selected: 0,
    stopped: 0,
    range: 0,
    matcher: 0,
    wholeSymbol: 0,
    stageWholeSymbol: 0,
    stageMatch: 0,
    stagePick: 0,
    snippet: 0,
    regex: 0,
    creates: 0,
    ...over,
  });

  test.skipIf(!runModulePresent)(
    "sums per-run stage and matcher-kind counts onto byTaskSide and bySide; absent stats contribute zero",
    async () => {
      const { aggregateRuns, computeAggregates } = await loadRunModule();
      const runs = [
        makeRun(
          "json-parser",
          "tc",
          { input: 10, output: 5 },
          stageStats({ stageMatch: 1, stagePick: 1, snippet: 1 }),
        ),
        makeRun(
          "json-parser",
          "tc",
          { input: 10, output: 5 },
          stageStats({ stageWholeSymbol: 1, stageMatch: 1, snippet: 1, creates: 1 }),
        ),
        makeRun("json-parser", "tc", { input: 10, output: 5 }),
      ];
      const jsonTc = aggregateRuns(runs, "json-parser", "tc");
      expect(jsonTc.stages).toEqual({ wholeSymbol: 1, match: 2, pick: 1 });
      expect(jsonTc.matcherKinds).toEqual({ snippet: 2, regex: 0 });
      expect(jsonTc.creates).toBe(1);

      const aggregates = computeAggregates(runs, ["json-parser"], ["tc"]);
      const bySide = aggregates.bySide.find((row) => row.side === "tc");
      expect(bySide?.stages).toEqual({ wholeSymbol: 1, match: 2, pick: 1 });
      expect(bySide?.matcherKinds).toEqual({ snippet: 2, regex: 0 });
      expect(bySide?.creates).toBe(1);
    },
  );
});

describe("oc model override (--oc-model)", () => {
  test.skipIf(!runModulePresent)("defaults to the tc side and rejects frozen oc runs", async () => {
    const { parseArgs, frozenDimensionError } = await loadRunModule();
    expect(parseArgs([]).side).toBe("tc");
    expect(parseArgs(["--side", "tc"]).side).toBe("tc");
    expect(frozenDimensionError("oc", ["edit-dsl"])).toContain(
      "the oc side is frozen (benchmark/results/oc-baseline.json)",
    );
    expect(frozenDimensionError("both", ["edit-dsl"])).toContain(
      "the oc side is frozen (benchmark/results/oc-baseline.json)",
    );
    expect(frozenDimensionError("tc", ["edit-dsl"])).toBeNull();
  });

  test.skipIf(!runModulePresent)("parses --oc-model and defaults to null", async () => {
    const { parseArgs } = await loadRunModule();
    expect(parseArgs([]).ocModel).toBeNull();
    expect(parseArgs(["--model", "base"]).ocModel).toBeNull();
    expect(parseArgs(["--model", "base", "--oc-model", "base#none"]).ocModel).toBe("base#none");
    expect(parseArgs(["--oc-model", "base#none"]).model).toBe("deepseek-flash");
  });

  test.skipIf(!runModulePresent)(
    "an absent --oc-model falls back to --model for the oc side",
    async () => {
      const { opencodeModelFor, parseArgs } = await loadRunModule();
      const fallback = parseArgs(["--model", "base"]);
      expect(fallback.model).toBe("base");
      expect(fallback.ocModel).toBeNull();
      // Absent override: the oc side still qualifies the shared --model.
      expect(opencodeModelFor(fallback.model, fallback.ocModel)).toBe("honghong/base");
      // Explicit override: only the oc id changes; tc keeps `base`.
      expect(opencodeModelFor("base", "base#none")).toBe("honghong/base#none");
    },
  );

  test.skipIf(!runModulePresent)("the report carries ocModel and renders it when set", async () => {
    const { computeAggregates, writeMarkdownReport } = await loadRunModule();
    const runs = sampleRuns();
    const tasks = ["json-parser", "sexp-parser"];
    const sides = ["tc", "oc"];
    const makeReport = (ocModel: string | null): Record<string, unknown> => ({
      generatedAt: "2026-10-20T00:00:00.000Z",
      date: "2026-10-20",
      mode: "full",
      tasks,
      sides,
      reps: 1,
      concurrency: 1,
      model: "deepseek-v4.1-flash",
      ocModel,
      effort: null,
      multiPayload: false,
      tokenBudget: null,
      bunVersion: "1.0.0",
      opencodeVersion: null,
      pilotReference: null,
      infraErrors: [],
      runs,
      aggregates: computeAggregates(runs, tasks, sides),
      provenance: {
        inputs: {
          model: "m",
          taskIssue: "t",
          fixture: "f",
          systemPrompt: "s",
          loopConfig: "l",
          pricing: "p",
        },
        inputHash: "h",
        computedAt: "2026-10-20T00:00:00.000Z",
      },
    });

    const dir = mkdtempSync(join(tmpdir(), "run-oc-model-"));
    try {
      const overridden = join(dir, "overridden.md");
      writeMarkdownReport(overridden, makeReport("deepseek-v4.1-flash#none"));
      expect(readFileSync(overridden, "utf8")).toContain("- oc model: deepseek-v4.1-flash#none");

      const base = join(dir, "base.md");
      writeMarkdownReport(base, makeReport(null));
      expect(readFileSync(base, "utf8")).not.toContain("- oc model:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("edit protocol override (--protocol-format) (#119)", () => {
  test.skipIf(!runModulePresent)("parses --protocol-format and defaults to edit-dsl", async () => {
    const { parseArgs } = await loadRunModule();
    expect(parseArgs([]).protocolFormats).toEqual(["edit-dsl"]);
    expect(parseArgs(["--multi-payload"]).protocolFormats).toEqual(["edit-dsl"]);
    expect(parseArgs(["--protocol-format", "edit-dsl"]).protocolFormats).toEqual(["edit-dsl"]);
    expect(parseArgs(["--protocol-format", "compact"]).protocolFormats).toEqual(["edit-dsl"]);
    const { frozenDimensionError } = await loadRunModule();
    expect(frozenDimensionError("tc", ["json"])).toContain(
      "the json protocol is frozen (benchmark/results/json-format-baseline.json)",
    );
  });

  test.skipIf(!runModulePresent)("the report renders the selected protocol format", async () => {
    const { computeAggregates, writeMarkdownReport } = await loadRunModule();
    const runs = sampleRuns();
    const tasks = ["json-parser"];
    const sides = ["tc"];
    const report = {
      generatedAt: "2026-10-20T00:00:00.000Z",
      date: "2026-10-20",
      mode: "full",
      tasks,
      sides,
      reps: 1,
      concurrency: 1,
      model: "deepseek-v4.1-flash",
      ocModel: null,
      effort: null,
      multiPayload: false,
      protocolFormat: "edit-dsl",
      tokenBudget: null,
      bunVersion: "1.0.0",
      opencodeVersion: null,
      pilotReference: null,
      infraErrors: [],
      runs,
      aggregates: computeAggregates(runs, tasks, sides),
      provenance: {
        inputs: {
          model: "m",
          taskIssue: "t",
          fixture: "f",
          systemPrompt: "s",
          loopConfig: "l",
          pricing: "p",
        },
        inputHash: "h",
        computedAt: "2026-10-20T00:00:00.000Z",
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "run-protocol-format-"));
    try {
      const md = join(dir, "edit-dsl.md");
      writeMarkdownReport(md, report);
      expect(readFileSync(md, "utf8")).toContain("- protocol-format: edit-dsl (#119)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// #16: one invocation measures several tc protocol variants (plus oc) from the
// same worker pool, with per-protocol records, aggregates, and report rows.
describe("concurrent protocol variants (#16)", () => {
  const multiRuns = (): Record<string, unknown>[] => [
    makeRun("json-parser", "tc", { input: 1000, output: 500 }, null, "json"),
    makeRun("json-parser", "tc", { input: 200, output: 100 }, null, "json"),
    makeRun("json-parser", "tc", { input: 400, output: 200 }, null, "edit-dsl"),
    makeRun("json-parser", "oc", { input: 900, output: 400 }),
  ];

  test.skipIf(!runModulePresent)(
    "parses comma lists in either order, de-duplicates, and normalizes the compact alias",
    async () => {
      const { parseProtocolFormats, frozenDimensionError } = await loadRunModule();
      expect(parseProtocolFormats("json")).toEqual(["json"]);
      expect(parseProtocolFormats("edit-dsl")).toEqual(["edit-dsl"]);
      expect(parseProtocolFormats("json,edit-dsl")).toEqual(["json", "edit-dsl"]);
      // Order-independent: canonical order is json then edit-dsl.
      expect(parseProtocolFormats("edit-dsl,json")).toEqual(["json", "edit-dsl"]);
      expect(parseProtocolFormats("json,json,compact")).toEqual(["json", "edit-dsl"]);
      expect(frozenDimensionError("tc", ["json", "edit-dsl"])).toContain(
        "the json protocol is frozen (benchmark/results/json-format-baseline.json)",
      );
      expect(() => parseProtocolFormats("json,yaml")).toThrow(
        "invalid --protocol-format value: yaml",
      );
      expect(() => parseProtocolFormats("json,")).toThrow("invalid --protocol-format value");
    },
  );

  test.skipIf(!runModulePresent)(
    "buildJobs expands tc once per protocol and oc once per task/rep",
    async () => {
      const { buildJobs } = await loadRunModule();
      const jobs = buildJobs(["json-parser"], ["tc", "oc"], 2, ["json", "edit-dsl"]);
      expect(jobs).toHaveLength(6);
      const ocJobs = jobs.filter((job) => job.side === "oc");
      const tcJobs = jobs.filter((job) => job.side === "tc");
      // One oc job per task/rep, regardless of how many tc protocols are selected.
      expect(ocJobs).toHaveLength(2);
      expect(ocJobs.every((job) => job.protocol === null)).toBe(true);
      expect(tcJobs).toHaveLength(4);
      expect(tcJobs.map((job) => job.protocol).sort()).toEqual([
        "edit-dsl",
        "edit-dsl",
        "json",
        "json",
      ]);
      // Every job lives in the same array (one pool), not per-protocol phases.
      expect(new Set(jobs.map((job) => `${job.side}/${job.rep}/${job.protocol ?? "-"}`)).size).toBe(
        6,
      );
    },
  );

  test.skipIf(!runModulePresent)(
    "one pool claims json, edit-dsl, and oc jobs concurrently (stubbed runner)",
    async () => {
      const { buildJobs, runPool } = await loadRunModule();
      const jobs = buildJobs(["json-parser"], ["tc", "oc"], 1, ["json", "edit-dsl"]);
      const claimed: string[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const results = await runPool(jobs, 2, async (job) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        claimed.push(`${job.side}:${job.protocol ?? "-"}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return `${job.side}:${job.protocol ?? "-"}`;
      });
      // Same array, same pool: all three variants ran, with real concurrency.
      expect(claimed.sort()).toEqual(["oc:-", "tc:edit-dsl", "tc:json"]);
      expect(maxInFlight).toBeGreaterThan(1);
      // Results stay in job order, not completion order.
      expect(results).toEqual(jobs.map((job) => `${job.side}:${job.protocol ?? "-"}`));
    },
  );

  test.skipIf(!runModulePresent)(
    "aggregates keep each tc protocol separate and give oc one row set",
    async () => {
      const { aggregateRuns, computeAggregates } = await loadRunModule();
      const runs = multiRuns();
      const aggregates = computeAggregates(
        runs,
        ["json-parser"],
        ["tc", "oc"],
        ["json", "edit-dsl"],
      );
      expect(aggregates.byTaskSide).toHaveLength(3);
      const jsonRow = aggregates.byTaskSide.find(
        (row) => row.side === "tc" && row.protocol === "json",
      );
      const dslRow = aggregates.byTaskSide.find(
        (row) => row.side === "tc" && row.protocol === "edit-dsl",
      );
      const ocRow = aggregates.byTaskSide.find((row) => row.side === "oc");
      expect(jsonRow?.tokens.total.total).toBe(1800);
      expect(jsonRow?.tokens.total.mean).toBe(900);
      expect(dslRow?.tokens.total.total).toBe(600);
      expect(dslRow?.tokens.total.mean).toBe(600);
      expect(ocRow?.protocol).toBeNull();
      expect(ocRow?.tokens.total.total).toBe(1300);

      // The overall comparison is a row list: no pooled tc row.
      expect(aggregates.overall).toHaveLength(3);
      expect(aggregates.overall.filter((row) => row.side === "tc")).toHaveLength(2);
      expect(aggregates.overall.filter((row) => row.side === "oc")).toHaveLength(1);

      const direct = aggregateRuns(runs, "json-parser", "tc", "json");
      expect(direct.runs).toBe(2);
      expect(direct.protocol).toBe("json");
    },
  );

  test.skipIf(!runModulePresent)(
    "multiplier sentence compares each tc variant with oc, never tc with tc",
    async () => {
      const { computeAggregates, tokenMultiplierSentence } = await loadRunModule();
      const runs = multiRuns();
      const aggregates = computeAggregates(
        runs,
        ["json-parser"],
        ["tc", "oc"],
        ["json", "edit-dsl"],
      );
      const sentence = tokenMultiplierSentence(aggregates.bySide, aggregates.byTaskSide);
      // json 1800 vs oc 1300; edit-dsl 600 vs oc 1300.
      expect(sentence).toContain("json tc 1.38x oc overall");
      expect(sentence).toContain("oc 2.17x edit-dsl tc overall");
      expect(sentence).toContain("json-parser json tc 1.38x oc");
      expect(sentence).toContain("json-parser oc 2.17x edit-dsl tc");
      // The bug compared the first two rows (json vs edit-dsl).
      expect(sentence).not.toContain("tc 3.00x");
      expect(sentence).not.toContain("json tc 3.00x edit-dsl tc");
    },
  );

  test.skipIf(!runModulePresent)(
    "Markdown identifies every variant in the header and tables",
    async () => {
      const { computeAggregates, writeMarkdownReport } = await loadRunModule();
      const runs = multiRuns();
      const tasks = ["json-parser"];
      const sides = ["tc", "oc"];
      const report = {
        generatedAt: "2026-10-22T00:00:00.000Z",
        date: "2026-10-22",
        mode: "pilot",
        tasks,
        sides,
        reps: 1,
        concurrency: 4,
        model: "deepseek-v4.1-flash",
        ocModel: null,
        effort: null,
        multiPayload: false,
        protocolFormat: null,
        protocolFormats: ["json", "edit-dsl"],
        tokenBudget: null,
        bunVersion: "1.0.0",
        opencodeVersion: null,
        pilotReference: null,
        infraErrors: [],
        runs,
        aggregates: computeAggregates(runs, tasks, sides, ["json", "edit-dsl"]),
        provenance: null,
        provenanceByProtocol: {},
      };
      const dir = mkdtempSync(join(tmpdir(), "run-multi-protocol-"));
      try {
        // The JSON report is this object serialized: the selected list and each
        // run's protocol are part of the record itself, not only the Markdown.
        expect(report.protocolFormats).toEqual(["json", "edit-dsl"]);
        expect(report.runs.map((run) => run.protocol)).toEqual(["json", "json", "edit-dsl", null]);
        const md = join(dir, "multi.md");
        writeMarkdownReport(md, report);
        const markdown = readFileSync(md, "utf8");
        expect(markdown).toContain("- protocol-formats: json, edit-dsl (#119)");
        expect(markdown).toContain("| json-parser | tc | json | 2/2 |");
        expect(markdown).toContain("| json-parser | tc | edit-dsl | 1/1 |");
        expect(markdown).toContain("| json-parser | oc | n/a | 1/1 |");
        expect(markdown).toContain("| tc | json | 2/2 |");
        expect(markdown).toContain("| tc | edit-dsl | 1/1 |");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
