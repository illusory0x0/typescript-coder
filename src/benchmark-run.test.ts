import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { billableCost, peakCost } from "./pricing";

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

interface TokenUsageLike {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  total: number | null;
}

interface LoopTokensLike {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  reasoning: number;
}

interface TokenStatsLike {
  mean: number | null;
  total: number | null;
}

interface AggregateLike {
  task: string | null;
  side: string | null;
  protocol: string | null;
  agentMode: string | null;
  runs: number;
  ok: number;
  tokens: { in: TokenStatsLike; out: TokenStatsLike; total: TokenStatsLike };
  billableCost: { in: TokenStatsLike; out: TokenStatsLike; total: TokenStatsLike };
  billableCostPerSuccess: number | null;
  turnsMean: number | null;
  cache?: { read: TokenStatsLike; hitRate: number | null };
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
  agentMode: string | null;
}

interface ScheduledJobLike {
  index: number;
  job: JobLike;
}

interface RunModule {
  BENCHMARK_TASKS: readonly string[];
  computeAggregates(
    runs: readonly unknown[],
    tasks: readonly string[],
    sides: readonly string[],
    protocols?: readonly string[],
    agentModes?: readonly string[],
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
    agentModes?: readonly string[],
  ): JobLike[];
  scheduleJobGroups(jobs: readonly JobLike[]): ScheduledJobLike[][];
  billableCostForRun(
    totalUsage: TokenUsageLike,
    loopTokens: LoopTokensLike | null,
    side: "tc" | "oc",
  ): BillableTriple & { loop: number | null };
  runPool<Job, Result>(
    jobs: readonly Job[],
    concurrency: number,
    run: (job: Job, index: number) => Promise<Result>,
  ): Promise<Result[]>;
  pilotCandidatePath(
    repoRoot: string,
    date: string,
    pilotJson: string | null,
    cwd?: string,
  ): string;
  parseAgentModes(value: string): string[];
  cacheBalanceWarning(rows: readonly AggregateLike[]): string | null;
  billableCostMultiplierSentence(
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
  frozenDimensionError(side: "tc" | "oc" | "both"): string | null;
  writeMarkdownReport(path: string, report: unknown, baselineRoot?: string): void;
  parseArgs(argv: string[]): {
    model: string;
    task: string | null;
    pilotJson: string | null;
    ocModel: string | null;
    side: string;
    protocolFormats: string[];
    agentModes: string[];
    reps: number;
  };
  opencodeModelFor(model: string, ocModel: string | null): string;
}

async function loadRunModule(): Promise<RunModule> {
  return (await import(runModulePath)) as RunModule;
}

// A run carries raw provider buckets plus the normalized cache-excluded USD view
// (#89); `makeRun` builds both so aggregate paths can be exercised directly.
function makeRun(
  task: string,
  side: "tc" | "oc",
  buckets: { input: number; output: number; cacheRead?: number },
  exchangeStats: Record<string, unknown> | null = null,
  protocol: string | null = null,
  agentMode: string | null = null,
): Record<string, unknown> {
  const raw = {
    input: buckets.input,
    output: buckets.output,
    cacheRead: buckets.cacheRead ?? 0,
    cacheWrite: null,
    reasoning: 0,
    total: buckets.input + buckets.output,
  };
  const billable = billableCost(raw, side);
  return {
    task,
    side,
    protocol,
    agentMode,
    rep: 1,
    ok: true,
    sideOk: true,
    // Synthetic runs have no post-termination summary: loop == total for tc,
    // and the oc side has no loop split (#47).
    tokens: raw,
    billableCost: { ...billable, loop: side === "tc" ? billable.total : null },
    usageAvailable: true,
    usageSource: "test",
    rawUsage: null,
    durationMs: 1000,
    startedAt: "2026-10-20T00:00:00.000Z",
    finishedAt: "2026-10-20T00:01:00.000Z",
    cost: peakCost(raw, side),
    steps: 1,
    turns: {
      total: side === "tc" ? 3 : 0,
      planning: side === "tc" ? 1 : null,
      execution: side === "tc" ? 1 : null,
      review: side === "tc" ? 1 : null,
    },
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
// excludes them. The cache-excluded USD triple must match on both sides.
describe("cache-excluded USD triple (#89)", () => {
  test("billableCost subtracts cache on tc but not on oc", () => {
    const tc = billableCost(
      { input: 3073, output: 1613, cacheRead: 2816, cacheWrite: null, reasoning: 0 },
      "tc",
    );
    expect(tc.in).toBeCloseTo(0.0000771, 12);
    expect(tc.out).toBeCloseTo(0.0019356, 12);
    expect(tc.total).toBeCloseTo(0.0020127, 12);
    const oc = billableCost(
      { input: 9345, output: 2160, cacheRead: 22400, cacheWrite: null, reasoning: 0 },
      "oc",
    );
    expect(oc.in).toBeCloseTo(0.0028035, 12);
    expect(oc.out).toBeCloseTo(0.002592, 12);
    expect(oc.total).toBeCloseTo(0.0053955, 12);
    for (const triple of [tc, oc] as BillableTriple[]) {
      expect(triple.total).toBeCloseTo(triple.in + triple.out, 12);
    }
  });

  test.skipIf(!runModulePresent)(
    "aggregate raw tokens and billable USD stay on the same selected runs",
    async () => {
      const { aggregateRuns, computeAggregates } = await loadRunModule();
      const runs = sampleRuns();
      const aggregates = computeAggregates(runs, ["json-parser", "sexp-parser"], ["tc", "oc"]);
      const jsonTc = aggregateRuns(runs, "json-parser", "tc");
      expect(jsonTc.tokens.in).toEqual({ mean: 1000, total: 1000 });
      expect(jsonTc.tokens.out).toEqual({ mean: 500, total: 500 });
      expect(jsonTc.tokens.total).toEqual({ mean: 1500, total: 1500 });
      expect(jsonTc.tokensPerSuccess).toEqual({ in: 1000, out: 500, total: 1500 });
      expect(jsonTc.billableCost.in.mean).toBeCloseTo(0.00006, 12);
      expect(jsonTc.billableCost.out.mean).toBeCloseTo(0.0006, 12);
      expect(jsonTc.billableCost.total.mean).toBeCloseTo(0.00066, 12);
      expect(jsonTc.billableCostPerSuccess).toBeCloseTo(0.00066, 12);

      const tcOverall = aggregates.bySide.find((row) => row.side === "tc");
      const ocOverall = aggregates.bySide.find((row) => row.side === "oc");
      // tc: 0.00066 + 0.00015; oc: 0.00075 + 0.000075. Raw totals are separate.
      expect(tcOverall?.billableCost.total.total).toBeCloseTo(0.00081, 12);
      expect(ocOverall?.billableCost.total.total).toBeCloseTo(0.000825, 12);
      expect(tcOverall?.tokens.total.total).toBe(1900);
      expect(ocOverall?.tokens.total.total).toBe(1400);
      expect(tcOverall?.turnsMean).toBe(3);
      expect(ocOverall?.turnsMean).toBe(0);
    },
  );

  test.skipIf(!runModulePresent)(
    "multiplier summary names the higher side overall and per task in USD",
    async () => {
      const { computeAggregates, billableCostMultiplierSentence } = await loadRunModule();
      const aggregates = computeAggregates(
        sampleRuns(),
        ["json-parser", "sexp-parser"],
        ["tc", "oc"],
      );
      const sentence = billableCostMultiplierSentence(aggregates.bySide, aggregates.byTaskSide);
      expect(sentence).toContain("oc 1.02x tc overall");
      expect(sentence).toContain("json-parser oc 1.14x tc");
      expect(sentence).toContain("sexp-parser tc 2.00x oc");
    },
  );

  test.skipIf(!runModulePresent)("multiplier summary says so when only one side ran", async () => {
    const { computeAggregates, billableCostMultiplierSentence } = await loadRunModule();
    const runs = [makeRun("json-parser", "tc", { input: 10, output: 5 })];
    const aggregates = computeAggregates(runs, ["json-parser"], ["tc"]);
    const sentence = billableCostMultiplierSentence(aggregates.bySide, aggregates.byTaskSide);
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
      const current = computeAggregates(sampleRuns(), tasks, ["tc"]);
      const savings = savingsVsOcBaseline(current.byTaskSide, baseline.byTaskSide);
      expect(savings.rows.map((row) => [row.task, row.factor.toFixed(2)])).toEqual([
        ["json-parser", "1.14"],
        ["sexp-parser", "2.40"],
      ]);
      expect(savings.overall).toHaveLength(1);
      expect(savings.overall[0]?.factor.toFixed(2)).toBe("1.37");
      expect(savings.overall[0]?.tasks).toBe(2);
      expect(ocBaselineSavingsSentence(savings)).toContain("1.37x fewer USD across 2 tasks");
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

describe("billable loop vs total split (#47)", () => {
  // Cache-excluded loop tally: miss = input - cacheRead, out = output + reasoning.
  const loopTokens = (): LoopTokensLike => ({
    input: 500,
    output: 20,
    total: 550,
    cacheRead: 400,
    reasoning: 30,
  });
  const totalUsage = (
    input: number,
    output: number,
    reasoning: number,
    cacheRead = 0,
  ): TokenUsageLike => ({
    input,
    output,
    cacheRead,
    cacheWrite: null,
    reasoning,
    total: input + output + reasoning,
  });

  test.skipIf(!runModulePresent)(
    "a post-termination summary raises billable total above loop",
    async () => {
      const { billableCostForRun } = await loadRunModule();
      // Loop: 100 miss * $0.30 + 50 output * $1.20 per 1M = $0.00009.
      const billable = billableCostForRun(totalUsage(1500, 120, 30, 400), loopTokens(), "tc");
      expect(billable.loop).toBeCloseTo(0.00009, 12);
      expect(billable.total).toBeCloseTo(0.00051, 12);
      expect(billable.loop).toBeLessThan(billable.total);
    },
  );

  test.skipIf(!runModulePresent)("loop equals total without a summary call", async () => {
    const { billableCostForRun } = await loadRunModule();
    const billable = billableCostForRun(totalUsage(500, 20, 30, 400), loopTokens(), "tc");
    expect(billable.loop).toBeCloseTo(0.00009, 12);
    expect(billable.total).toBeCloseTo(0.00009, 12);
  });

  test.skipIf(!runModulePresent)("the oc side has no loop split", async () => {
    const { billableCostForRun } = await loadRunModule();
    expect(billableCostForRun(totalUsage(100, 20, 0), null, "oc").loop).toBeNull();
    // Even a stray loop tally never applies to oc.
    expect(billableCostForRun(totalUsage(100, 20, 0), loopTokens(), "oc").loop).toBeNull();
  });
});

describe("rendered report (#89)", () => {
  test.skipIf(!runModulePresent)(
    "prints the cache-excluded tables and the multiplier summary",
    async () => {
      const { computeAggregates, writeMarkdownReport } = await loadRunModule();
      const runs = sampleRuns();
      const tasks = ["json-parser"];
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
        costBudgetUsd: null,
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
        expect(markdown).toContain("## USD accounting");
        expect(markdown).toContain("Mean turns");
        expect(markdown).toContain("Billable in ($)");
        expect(markdown).not.toContain("decision-only");
        // json-parser tc: billable in $0.00006, out $0.00060, total $0.00066;
        // full peak cost is $0.00066 too (the small cache hit is rounded).
        expect(markdown).toContain(
          "| json-parser | tc | n/a | pinned-repair | 1/1 | $0.00006 | 80.0% | $0.00060 | $0.00066 | $0.00066 | $0.00066 |",
        );
        expect(markdown).toContain("oc 1.02x tc overall");
        expect(markdown).toContain("json-parser oc 1.14x tc");
        // #47: the raw-runs table separates the budget basis from the all-calls
        // total; synthetic tc rows have loop == total and oc rows are n/a.
        expect(markdown).toContain("Loop billable $");
        expect(markdown).toContain(
          "| json-parser | tc | n/a | n/a | 1 | yes | 1,000 | 500 | 1,500 | $0.00066 | $0.00066 | $0.00066 | 1 | 1.0 |",
        );
        expect(markdown).toContain(
          "| json-parser | oc | n/a | n/a | 1 | yes | 900 | 400 | 1,300 | n/a | $0.00075 | $0.00078 | 1 | 1.0 |",
        );
        // #101: adoption surfaces per task/side and per side.
        expect(markdown).toContain("## Selector adoption (#101)");
        expect(markdown).toContain(
          "| Task | Side | Protocol | Agent mode | range | matcher | whole-symbol |",
        );
        expect(markdown).toContain(
          "| Side | Protocol | Agent mode | range | matcher | whole-symbol |",
        );
        // #110: resolved stages and matcher kinds surface alongside.
        expect(markdown).toContain("Resolved cascade stages and matcher kinds (#110)");
        expect(markdown).toContain(
          "| Task | Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |",
        );
        expect(markdown).toContain(
          "| Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |",
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

describe("cache balance", () => {
  test.skipIf(!runModulePresent)(
    "reports per-variant hit rates and warns on a large spread",
    async () => {
      const { computeAggregates, cacheBalanceWarning } = await loadRunModule();
      const runs = [
        makeRun(
          "json-parser",
          "tc",
          { input: 1000, output: 100, cacheRead: 900 },
          null,
          "edit-dsl",
          "pinned-repair",
        ),
        makeRun(
          "json-parser",
          "tc",
          { input: 1000, output: 100, cacheRead: 100 },
          null,
          "edit-dsl",
          "plan-exec",
        ),
      ];
      const aggregates = computeAggregates(
        runs,
        ["json-parser"],
        ["tc"],
        ["edit-dsl"],
        ["pinned-repair", "plan-exec"],
      );
      expect(aggregates.bySide.map((row) => row.cache?.hitRate)).toEqual([0.9, 0.1]);
      const warning = cacheBalanceWarning(aggregates.bySide);
      expect(warning).toContain("cache hit rates span");
      expect(warning).toContain("80 points");
    },
  );
});

describe("default task matrix", () => {
  test.skipIf(!runModulePresent)(
    "defaults to the four benchmark tasks and keeps mini-spreadsheet explicit",
    async () => {
      const { BENCHMARK_TASKS, parseArgs } = await loadRunModule();
      expect(BENCHMARK_TASKS).toEqual(["json-parser", "sexp-parser", "minilisp", "csv-parser"]);
      expect(parseArgs([]).task).toBeNull();
      expect(parseArgs(["--task", "mini-spreadsheet"]).task).toBe("mini-spreadsheet");
    },
  );
});

describe("oc model override (--oc-model)", () => {
  test.skipIf(!runModulePresent)("defaults to the tc side and rejects frozen oc runs", async () => {
    const { parseArgs, frozenDimensionError } = await loadRunModule();
    expect(parseArgs([]).side).toBe("tc");
    expect(parseArgs([]).reps).toBe(5);
    expect(parseArgs(["--side", "tc"]).side).toBe("tc");
    expect(frozenDimensionError("oc")).toContain(
      "the oc side is frozen and no oc baseline is committed",
    );
    expect(frozenDimensionError("both")).toContain(
      "the oc side is frozen and no oc baseline is committed",
    );
    expect(frozenDimensionError("tc")).toBeNull();
  });

  test.skipIf(!runModulePresent)("resolves an explicit or default pilot report path", async () => {
    const { pilotCandidatePath } = await loadRunModule();
    expect(pilotCandidatePath("/repo", "2026-10-27", null)).toBe(
      "/repo/benchmark/results/pilot-2026-10-27.json",
    );
    expect(pilotCandidatePath("/repo", "2026-10-27", "tmp/pilot.json", "/work")).toBe(
      "/work/tmp/pilot.json",
    );
  });

  test.skipIf(!runModulePresent)("parses --pilot-json for a full report", async () => {
    const { parseArgs } = await loadRunModule();
    expect(parseArgs([]).pilotJson).toBeNull();
    expect(parseArgs(["--pilot-json", "tmp/pilot.json"]).pilotJson).toBe("tmp/pilot.json");
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
      costBudgetUsd: null,
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

describe("report protocol label (#119)", () => {
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
      protocolFormat: "edit-dsl",
      costBudgetUsd: null,
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
    const dir = mkdtempSync(join(tmpdir(), "run-protocol-label-"));
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
    "scheduleJobGroups keeps each cache-stable prompt prefix together",
    async () => {
      const { buildJobs, scheduleJobGroups } = await loadRunModule();
      const jobs = buildJobs(
        ["json-parser", "sexp-parser"],
        ["tc"],
        2,
        ["edit-dsl"],
        ["pinned-repair", "plan-exec"],
      );
      const groups = scheduleJobGroups(jobs);
      expect(groups).toHaveLength(2);
      expect(groups.map((group) => group.map(({ job }) => job.agentMode))).toEqual([
        ["pinned-repair", "pinned-repair", "pinned-repair", "pinned-repair"],
        ["plan-exec", "plan-exec", "plan-exec", "plan-exec"],
      ]);
      expect(groups[0]?.map(({ job }) => `${job.task}/rep${job.rep}`)).toEqual([
        "json-parser/rep1",
        "json-parser/rep2",
        "sexp-parser/rep1",
        "sexp-parser/rep2",
      ]);
      expect(
        groups
          .flatMap((group) => group.map(({ index }) => index))
          .sort((left, right) => left - right),
      ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

      const single = scheduleJobGroups(
        buildJobs(["json-parser"], ["tc"], 1, ["edit-dsl"], ["pinned-repair"]),
      );
      expect(single).toHaveLength(1);
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
    "parses the two agent modes, alias, and both; expands tc jobs once per mode",
    async () => {
      const { parseAgentModes, buildJobs, parseArgs } = await loadRunModule();
      expect(parseArgs([]).agentModes).toEqual(["pinned-repair"]);
      expect(parseArgs(["--agent-mode", "plan-exec"]).agentModes).toEqual(["plan-exec"]);
      expect(parseArgs(["--agent-mode", "both"]).agentModes).toEqual([
        "pinned-repair",
        "plan-exec",
      ]);
      expect(parseAgentModes("both")).toEqual(["pinned-repair", "plan-exec"]);
      expect(parseAgentModes("both,edit")).toEqual(["pinned-repair", "plan-exec"]);
      // The deprecated alias maps to its canonical value; input order never matters.
      expect(parseAgentModes("plan-exec")).toEqual(["plan-exec"]);
      expect(parseAgentModes("edit")).toEqual(["pinned-repair"]);
      expect(parseAgentModes("plan-exec,edit")).toEqual(["pinned-repair", "plan-exec"]);
      expect(parseAgentModes("plan-exec,pinned-repair,plan-exec")).toEqual([
        "pinned-repair",
        "plan-exec",
      ]);
      expect(() => parseAgentModes("yaml")).toThrow("invalid --agent-mode value: yaml");
      expect(() => parseAgentModes("yaml")).toThrow(
        'expected "pinned-repair", "plan-exec", or "both"; alias: edit',
      );
      const jobs = buildJobs(
        ["json-parser"],
        ["tc", "oc"],
        2,
        ["edit-dsl"],
        ["pinned-repair", "plan-exec"],
      );
      expect(jobs).toHaveLength(6);
      expect(jobs.filter((job) => job.side === "tc").map((job) => job.agentMode)).toEqual([
        "pinned-repair",
        "plan-exec",
        "pinned-repair",
        "plan-exec",
      ]);
      expect(jobs.filter((job) => job.side === "oc").every((job) => job.agentMode === null)).toBe(
        true,
      );
    },
  );

  test.skipIf(!runModulePresent)(
    "keeps pinned-repair and plan-exec aggregates separate",
    async () => {
      const { computeAggregates } = await loadRunModule();
      const runs = [
        makeRun(
          "json-parser",
          "tc",
          { input: 400, output: 200 },
          null,
          "edit-dsl",
          "pinned-repair",
        ),
        makeRun("json-parser", "tc", { input: 100, output: 50 }, null, "edit-dsl", "plan-exec"),
      ];
      const aggregates = computeAggregates(
        runs,
        ["json-parser"],
        ["tc"],
        ["edit-dsl"],
        ["pinned-repair", "plan-exec"],
      );
      expect(aggregates.byTaskSide.map((row) => [row.agentMode, row.tokens.total.mean])).toEqual([
        ["pinned-repair", 600],
        ["plan-exec", 150],
      ]);
    },
  );

  test.skipIf(!runModulePresent)(
    "reads historical edit rows and missing modes through the alias mapping",
    async () => {
      const { computeAggregates } = await loadRunModule();
      const runs = [
        makeRun("json-parser", "tc", { input: 400, output: 200 }, null, "edit-dsl", "edit"),
        // A legacy tc row with no mode reads as pinned-repair.
        makeRun("json-parser", "tc", { input: 50, output: 50 }, null, "edit-dsl", null),
      ];
      const aggregates = computeAggregates(
        runs,
        ["json-parser"],
        ["tc"],
        ["edit-dsl"],
        ["pinned-repair", "plan-exec"],
      );
      expect(aggregates.byTaskSide.map((row) => [row.agentMode, row.tokens.total.mean])).toEqual([
        ["pinned-repair", 350],
        ["plan-exec", null],
      ]);
      // Defaults inferred from legacy runs are canonical too.
      const inferred = computeAggregates(runs.slice(0, 1), ["json-parser"], ["tc"]);
      expect(inferred.byTaskSide[0]?.agentMode).toBe("pinned-repair");
    },
  );

  test.skipIf(!runModulePresent)(
    "multiplier sentence compares each tc variant with oc, never tc with tc",
    async () => {
      const { computeAggregates, billableCostMultiplierSentence } = await loadRunModule();
      const runs = multiRuns();
      const aggregates = computeAggregates(
        runs,
        ["json-parser"],
        ["tc", "oc"],
        ["json", "edit-dsl"],
      );
      const sentence = billableCostMultiplierSentence(aggregates.bySide, aggregates.byTaskSide);
      // json $0.00108 vs oc $0.00075; edit-dsl $0.00036 vs oc $0.00075.
      expect(sentence).toContain("json tc 1.44x oc overall");
      expect(sentence).toContain("oc 2.08x edit-dsl tc overall");
      expect(sentence).toContain("json-parser json tc 1.44x oc");
      expect(sentence).toContain("json-parser oc 2.08x edit-dsl tc");
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
        protocolFormat: null,
        protocolFormats: ["json", "edit-dsl"],
        costBudgetUsd: null,
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
        expect(markdown).toContain("| json-parser | tc | json | pinned-repair | 2/2 |");
        expect(markdown).toContain("| json-parser | tc | edit-dsl | pinned-repair | 1/1 |");
        expect(markdown).toContain("| json-parser | oc | n/a | n/a | 1/1 |");
        expect(markdown).toContain("| tc | json | pinned-repair | 2/2 |");
        expect(markdown).toContain("| tc | edit-dsl | pinned-repair | 1/1 |");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
