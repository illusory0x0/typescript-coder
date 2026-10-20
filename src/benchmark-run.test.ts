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
  tokens: { in: TokenStatsLike; out: TokenStatsLike; total: TokenStatsLike };
  tokensPerSuccess: { in: number | null; out: number | null; total: number | null };
  selectors: { range: number; matcher: number; wholeSymbol: number };
}

interface AggregatesLike {
  bySide: AggregateLike[];
  byTaskSide: AggregateLike[];
  overall: AggregateLike;
}

interface RunModule {
  aggregateRuns(runs: readonly unknown[], task: string | null, side: string | null): AggregateLike;
  computeAggregates(
    runs: readonly unknown[],
    tasks: readonly string[],
    sides: readonly string[],
  ): AggregatesLike;
  tokenMultiplierSentence(
    bySide: readonly AggregateLike[],
    byTaskSide: readonly AggregateLike[],
  ): string;
  writeMarkdownReport(path: string, report: unknown): void;
  parseArgs(argv: string[]): { model: string; ocModel: string | null };
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
        // json-parser tc: in 200, out 500, total 700.
        expect(markdown).toContain("| json-parser | tc | 1/1 | 200 | 500 | 700 |");
        expect(markdown).toContain("oc 1.56x tc overall");
        expect(markdown).toContain("json-parser oc 1.86x tc");
        // #101: adoption surfaces per task/side and per side.
        expect(markdown).toContain("## Selector adoption (#101)");
        expect(markdown).toContain("| Task | Side | range | matcher | whole-symbol |");
        expect(markdown).toContain("| Side | range | matcher | whole-symbol |");
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

describe("oc model override (--oc-model)", () => {
  test.skipIf(!runModulePresent)("parses --oc-model and defaults to null", async () => {
    const { parseArgs } = await loadRunModule();
    expect(parseArgs([]).ocModel).toBeNull();
    expect(parseArgs(["--model", "base"]).ocModel).toBeNull();
    expect(parseArgs(["--model", "base", "--oc-model", "base#none"]).ocModel).toBe("base#none");
    expect(parseArgs(["--oc-model", "base#none"]).model).toBe("deepseek-v4.1-flash");
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
