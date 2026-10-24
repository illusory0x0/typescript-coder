import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLedger,
  computeInputHashes,
  currentInputHashes,
  deriveRowFromJson,
  parseConsumptionRows,
  stableStringify,
} from "./provenance";
import type { ConsumptionValue, MeasuredInput } from "./provenance";

// Build a minimal `benchmark/fixtures/<task>/` tree under a temp root so the
// current-tree hashing tests stay self-contained (the suite is copied without
// `benchmark/` during the self-host smoke test).
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tsprov-"));
  for (const task of ["json-parser", "sexp-parser", "minilisp"]) {
    const dir = join(root, "benchmark", "fixtures", task, "src");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, "benchmark", "fixtures", task, "tsconfig.json"), "{}\n");
    writeFileSync(join(dir, `${task}.test.ts`), `// ${task}\n`);
  }
  return root;
}

function measured(overrides: Partial<MeasuredInput> = {}): MeasuredInput {
  return {
    model: "deepseek-v4.1-flash",
    taskIssue: stableStringify({ "json-parser": "do it" }),
    fixture: stableStringify({ "json-parser": { "tsconfig.json": "{}\n" } }),
    systemPrompt: "system\n",
    loopConfig: { tokenBudget: 120000, effort: "none", reps: 3, multiPayload: false },
    pricing: { fetchedOn: "2026-10-19", rates: {} },
    ...overrides,
  };
}

describe("computeInputHashes", () => {
  test("is deterministic for identical input", () => {
    expect(computeInputHashes(measured())).toEqual(computeInputHashes(measured()));
  });

  test("derives inputHash from the canonical JSON of the per-input hashes", () => {
    const result = computeInputHashes(measured());
    // Re-derive with the same primitive: sha256 of stableStringify over the
    // per-input digest object. The keys are emitted in a fixed order.
    expect(result.inputHash).toHaveLength(64);
    expect(result.inputs.model).toHaveLength(64);
    expect(Object.keys(result.inputs).sort()).toEqual([
      "fixture",
      "loopConfig",
      "model",
      "pricing",
      "systemPrompt",
      "taskIssue",
    ]);
    // Changing any single piece changes that digest and the derived hash.
    const changed = computeInputHashes(measured({ model: "other-model" }));
    expect(changed.inputs.model).not.toBe(result.inputs.model);
    expect(changed.inputs.taskIssue).toBe(result.inputs.taskIssue);
    expect(changed.inputHash).not.toBe(result.inputHash);
  });

  test("stable key order: loop-config insertion order does not change the hash", () => {
    const first = computeInputHashes(measured({ loopConfig: { a: 1, b: { d: 4, c: 3 } } }));
    const second = computeInputHashes(measured({ loopConfig: { b: { c: 3, d: 4 }, a: 1 } }));
    expect(first.inputs.loopConfig).toBe(second.inputs.loopConfig);
    expect(first.inputHash).toBe(second.inputHash);
  });
});

describe("currentInputHashes", () => {
  test("is deterministic and sensitive to the loop config", () => {
    const root = fixtureRoot();
    try {
      const base = {
        tasks: ["json-parser", "sexp-parser", "minilisp"],
        taskIssues: {
          "json-parser": "json issue",
          "sexp-parser": "sexp issue",
          minilisp: "lisp issue",
        },
        model: "deepseek-v4.1-flash",
        multiPayload: false,
        effort: null,
        reps: 3,
      };
      const first = currentInputHashes(root, base);
      const second = currentInputHashes(root, base);
      expect(first).toEqual(second);

      const multipayload = currentInputHashes(root, { ...base, multiPayload: true });
      expect(multipayload.inputs.systemPrompt).not.toBe(first.inputs.systemPrompt);
      expect(multipayload.inputs.loopConfig).not.toBe(first.inputs.loopConfig);

      // #119/B1: edit-dsl is the default system-prompt digest; selecting json
      // changes it without changing the loop config hash.
      const editDsl = currentInputHashes(root, { ...base, protocolFormat: "edit-dsl" });
      expect(editDsl.inputs.systemPrompt).toBe(first.inputs.systemPrompt);
      const json = currentInputHashes(root, { ...base, protocolFormat: "json" });
      expect(json.inputs.systemPrompt).not.toBe(first.inputs.systemPrompt);
      expect(json.inputs.loopConfig).toBe(first.inputs.loopConfig);

      const effort = currentInputHashes(root, { ...base, effort: "high" });
      expect(effort.inputs.loopConfig).not.toBe(first.inputs.loopConfig);

      // Plan/execute pins its own prompt + task caps; edit hashes stay stable.
      const plan = currentInputHashes(root, { ...base, agentMode: "plan-exec" });
      expect(plan.inputs.systemPrompt).not.toBe(first.inputs.systemPrompt);
      expect(plan.inputs.loopConfig).not.toBe(first.inputs.loopConfig);
      expect(currentInputHashes(root, { ...base, agentMode: "edit" })).toEqual(first);

      // Changing a fixture's on-disk content changes the fixture digest.
      writeFileSync(
        join(root, "benchmark", "fixtures", "json-parser", "tsconfig.json"),
        '{ "changed": true }\n',
      );
      const changed = currentInputHashes(root, base);
      expect(changed.inputs.fixture).not.toBe(first.inputs.fixture);
      expect(changed.inputs.model).toBe(first.inputs.model);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseConsumptionRows", () => {
  test("parses the canonical Rows table", () => {
    const markdown = [
      "# Consumption ledger",
      "",
      "## Rows",
      "",
      "| Date | Change set | json-parser | sexp-parser | minilisp | Overall | Source | Notes |",
      "| ---- | --- | --- | --- | --- | --- | --- | --- |",
      "| 2026-10-19 | v1 test | $0.00104 (3/3) | n/a (0/3) | $0.00999 (3/3) | $0.00420 (9/9) | `benchmark/results/row.json` (report `row.md`) | none |",
      "",
      "### oc comparison baselines",
      "",
      "| Date | Effort | json-parser | sexp-parser | minilisp | Overall | Source |",
      "| ---- | --- | --- | --- | --- | --- | --- |",
      "| 2026-10-19 | none | $0.00335 (6/6) | $0.00227 (6/6) | $0.00942 (6/6) | $0.00501 (18/18) | `a.json` + `b.json` |",
    ].join("\n");
    const rows = parseConsumptionRows(markdown);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.date).toBe("2026-10-19");
    expect(row.changeSet).toBe("v1 test");
    expect(row.sourceJsonPaths).toEqual(["benchmark/results/row.json"]);
    expect(row.values["json-parser"]).toEqual({ costPerSuccess: 0.00104, ok: 3, runs: 3 });
    expect(row.values["sexp-parser"]).toEqual({ costPerSuccess: null, ok: 0, runs: 3 });
    expect(row.values.overall).toEqual({ costPerSuccess: 0.0042, ok: 9, runs: 9 });
  });
});

// A small synthetic report: 3 tasks × 3 runs, the coder side labelled `tc`.
function syntheticReport(): Record<string, unknown> {
  const tasks = ["json-parser", "sexp-parser", "minilisp"];
  const runs: Record<string, unknown>[] = [];
  for (const task of tasks) {
    for (let rep = 1; rep <= 3; rep += 1) {
      runs.push({
        task,
        side: "tc",
        rep,
        ok: rep <= 2,
        // Two passing runs at 0.002 and one failing run at 0.001 per task.
        cost: rep <= 2 ? 0.002 : 0.001,
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: null, reasoning: 0 },
      });
    }
  }
  return { tasks, model: "m", multiPayload: false, effort: null, reps: 3, runs };
}

function formatValue(value: ConsumptionValue): string {
  const cost = value.costPerSuccess === null ? "n/a" : `$${value.costPerSuccess.toFixed(5)}`;
  return `${cost} (${value.ok}/${value.runs})`;
}

function ledgerRowMarkdown(values: Record<string, ConsumptionValue>): string {
  return [
    "## Rows",
    "",
    "| Date | Change set | json-parser | sexp-parser | minilisp | Overall | Source | Notes |",
    "| ---- | --- | --- | --- | --- | --- | --- | --- |",
    `| 2026-10-19 | synthetic | ${formatValue(values["json-parser"]!)} | ${formatValue(values["sexp-parser"]!)} | ${formatValue(values.minilisp!)} | ${formatValue(values.overall!)} | \`benchmark/results/synth.json\` | none |`,
  ].join("\n");
}

describe("deriveRowFromJson", () => {
  test("re-derives per-task and overall cost-per-success and success counts", () => {
    const markdown = ledgerRowMarkdown({
      "json-parser": { costPerSuccess: 0.0025, ok: 2, runs: 3 },
      "sexp-parser": { costPerSuccess: 0.0025, ok: 2, runs: 3 },
      minilisp: { costPerSuccess: 0.0025, ok: 2, runs: 3 },
      overall: { costPerSuccess: 0.0025, ok: 6, runs: 9 },
    });
    const row = parseConsumptionRows(markdown)[0]!;
    const derived = deriveRowFromJson(row, syntheticReport());
    expect(derived.values["json-parser"]).toEqual({ costPerSuccess: 0.0025, ok: 2, runs: 3 });
    expect(derived.values.overall!.ok).toBe(6);
    expect(derived.values.overall!.runs).toBe(9);
    expect(derived.values.overall!.costPerSuccess).toBeCloseTo(0.0025, 10);
  });

  test("falls back to the off-peak rate table for a cost-less historical run", () => {
    const json = {
      tasks: ["json-parser"],
      runs: [
        {
          task: "json-parser",
          side: "ts",
          ok: true,
          // (1000 * 0.15 + 500 * 0.6) / 1e6 = 0.00045.
          tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: null, reasoning: 0 },
        },
      ],
    };
    const markdown = ledgerRowMarkdown({
      "json-parser": { costPerSuccess: 0.00045, ok: 1, runs: 1 },
      "sexp-parser": { costPerSuccess: null, ok: 0, runs: 0 },
      minilisp: { costPerSuccess: null, ok: 0, runs: 0 },
      overall: { costPerSuccess: 0.00045, ok: 1, runs: 1 },
    });
    const row = parseConsumptionRows(markdown)[0]!;
    const derived = deriveRowFromJson(row, json);
    expect(derived.values["json-parser"]!.costPerSuccess).toBeCloseTo(0.00045, 10);
  });
});

// #16: the ledger's Protocol column selects one tc variant of a multi-variant
// report; a table without the column keeps the legacy pooled behavior.
function ledgerRowsWithProtocol(
  entries: { protocol: string; jsonParser: ConsumptionValue; overall: ConsumptionValue }[],
): string {
  const empty = formatValue({ costPerSuccess: null, ok: 0, runs: 0 });
  return [
    "## Rows",
    "",
    "| Date | Change set | json-parser | sexp-parser | minilisp | Overall | Source | Notes | Protocol |",
    "| ---- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...entries.map(
      (entry) =>
        `| 2026-10-22 | multi ${entry.protocol} | ${formatValue(entry.jsonParser)} | ${empty} | ${empty} | ${formatValue(entry.overall)} | \`benchmark/results/multi.json\` | none | ${entry.protocol} |`,
    ),
  ].join("\n");
}

function multiProtocolReport(): Record<string, unknown> {
  const runs: Record<string, unknown>[] = [];
  for (const [protocol, costs] of [
    ["json", [0.002, 0.001]],
    ["edit-dsl", [0.004, 0.004]],
  ] as const) {
    for (const cost of costs) {
      runs.push({
        task: "json-parser",
        side: "tc",
        protocol,
        ok: cost > 0.001,
        cost,
        tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: null, reasoning: 0 },
      });
    }
  }
  return {
    tasks: ["json-parser"],
    model: "m",
    multiPayload: false,
    effort: null,
    reps: 2,
    protocolFormat: null,
    protocolFormats: ["json", "edit-dsl"],
    runs,
  };
}

describe("per-protocol ledger rows (#16)", () => {
  test("parses the Protocol column and normalizes the compact alias", () => {
    const markdown = ledgerRowsWithProtocol([
      {
        protocol: "edit-dsl",
        jsonParser: { costPerSuccess: 0.004, ok: 2, runs: 2 },
        overall: { costPerSuccess: 0.004, ok: 2, runs: 2 },
      },
    ]).replace("| edit-dsl |", "| compact |");
    const rows = parseConsumptionRows(markdown);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.protocol).toBe("edit-dsl");
  });

  test("legacy tables without a Protocol column parse with protocol null", () => {
    const markdown = [
      "## Rows",
      "",
      "| Date | Change set | json-parser | sexp-parser | minilisp | Overall | Source | Notes |",
      "| ---- | --- | --- | --- | --- | --- | --- | --- |",
      "| 2026-10-20 | legacy | n/a (0/1) | n/a (0/1) | n/a (0/1) | $0.00100 (1/1) | `a.json` | none |",
    ].join("\n");
    expect(parseConsumptionRows(markdown)[0]!.protocol).toBeNull();
  });

  test("deriveRowFromJson filters runs by the row's protocol", () => {
    const report = multiProtocolReport();
    const markdown = ledgerRowsWithProtocol([
      {
        protocol: "json",
        jsonParser: { costPerSuccess: 0.003, ok: 1, runs: 2 },
        overall: { costPerSuccess: 0.003, ok: 1, runs: 2 },
      },
      {
        protocol: "edit-dsl",
        jsonParser: { costPerSuccess: 0.004, ok: 2, runs: 2 },
        overall: { costPerSuccess: 0.004, ok: 2, runs: 2 },
      },
    ]);
    const [jsonRow, dslRow] = parseConsumptionRows(markdown);
    expect(deriveRowFromJson(jsonRow!, report).values["json-parser"]).toEqual({
      costPerSuccess: 0.003,
      ok: 1,
      runs: 2,
    });
    expect(deriveRowFromJson(dslRow!, report).values["json-parser"]).toEqual({
      costPerSuccess: 0.004,
      ok: 2,
      runs: 2,
    });
  });

  test("checkLedger selects provenanceByProtocol by the row's protocol", () => {
    const report = {
      ...multiProtocolReport(),
      provenance: { inputs: { model: "pooled" }, inputHash: "pooled" },
      provenanceByProtocol: {
        json: { inputs: { model: "json" }, inputHash: "json" },
        "edit-dsl": { inputs: { model: "dsl" }, inputHash: "dsl" },
      },
    };
    const markdown = ledgerRowsWithProtocol([
      {
        protocol: "json",
        jsonParser: { costPerSuccess: 0.003, ok: 1, runs: 2 },
        overall: { costPerSuccess: 0.003, ok: 1, runs: 2 },
      },
      {
        protocol: "edit-dsl",
        jsonParser: { costPerSuccess: 0.004, ok: 2, runs: 2 },
        overall: { costPerSuccess: 0.004, ok: 2, runs: 2 },
      },
    ]);
    const seen: (string | null)[] = [];
    const result = checkLedger(markdown, {
      loadSource: () => report,
      currentFor: (_json, protocol) => {
        seen.push(protocol);
        return protocol === "json"
          ? { inputs: { model: "json" } as never, inputHash: "json" }
          : { inputs: { model: "dsl" } as never, inputHash: "dsl" };
      },
    });
    expect(result.failures).toEqual([]);
    expect(result.fresh).toBe(2);
    // The scalar pooled `provenance` was never used for these rows.
    expect(result.staleFlags).toEqual([]);
    expect(seen).toEqual(["json", "edit-dsl"]);
  });

  test("accepts a legacy scalar protocol report and legacy compact row", () => {
    const scalar = { inputs: { model: "old" }, inputHash: "old" };
    const report = {
      tasks: ["json-parser"],
      model: "m",
      protocolFormat: "compact",
      runs: [
        {
          task: "json-parser",
          side: "tc",
          ok: true,
          cost: 0.002,
          tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: null, reasoning: 0 },
        },
      ],
      provenance: scalar,
    };
    const markdown = ledgerRowsWithProtocol([
      {
        protocol: "compact",
        jsonParser: { costPerSuccess: 0.002, ok: 1, runs: 1 },
        overall: { costPerSuccess: 0.002, ok: 1, runs: 1 },
      },
    ]);
    const seen: (string | null)[] = [];
    const result = checkLedger(markdown, {
      loadSource: () => report,
      currentFor: (_json, protocol) => {
        seen.push(protocol);
        return scalar as never;
      },
    });
    expect(result.failures).toEqual([]);
    expect(result.fresh).toBe(1);
    expect(seen).toEqual(["edit-dsl"]);
  });
});

describe("checkLedger", () => {
  const report = syntheticReport();
  const goodValues: Record<string, ConsumptionValue> = {
    "json-parser": { costPerSuccess: 0.0025, ok: 2, runs: 3 },
    "sexp-parser": { costPerSuccess: 0.0025, ok: 2, runs: 3 },
    minilisp: { costPerSuccess: 0.0025, ok: 2, runs: 3 },
    overall: { costPerSuccess: 0.0025, ok: 6, runs: 9 },
  };

  test("passes when every row re-derives", () => {
    const result = checkLedger(ledgerRowMarkdown(goodValues), {
      loadSource: () => report,
    });
    expect(result.failures).toEqual([]);
    expect(result.checked).toBe(1);
  });

  test("fails on a corrupted row and names it", () => {
    const corrupted: Record<string, ConsumptionValue> = {
      ...goodValues,
      overall: { costPerSuccess: 0.00251, ok: 6, runs: 9 },
    };
    const result = checkLedger(ledgerRowMarkdown(corrupted), {
      loadSource: () => report,
    });
    expect(result.failures).toHaveLength(1);
    const message = result.failures[0]!;
    expect(message).toContain("2026-10-19");
    expect(message).toContain("synthetic");
    expect(message).toContain("overall");
    expect(message).toContain("$0.00251 (6/9)");
  });

  test("fails when the cited source is missing", () => {
    const result = checkLedger(ledgerRowMarkdown(goodValues), {
      loadSource: () => null,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("cited source missing");
  });

  test("flags a provenance-less row as stale without failing", () => {
    const result = checkLedger(ledgerRowMarkdown(goodValues), {
      loadSource: () => report,
      currentFor: () => null,
    });
    expect(result.failures).toEqual([]);
    expect(result.stale).toBe(1);
    expect(result.staleFlags[0]).toContain("no provenance recorded");
  });

  test("flags a recorded hash that differs from the current tree as stale", () => {
    const withProvenance = {
      ...report,
      provenance: { inputs: { model: "old" }, inputHash: "old" },
    };
    const result = checkLedger(ledgerRowMarkdown(goodValues), {
      loadSource: () => withProvenance,
      currentFor: () => ({
        inputs: {
          model: "new",
          taskIssue: "x",
          fixture: "y",
          systemPrompt: "z",
          loopConfig: "l",
          pricing: "p",
        },
        inputHash: "new",
      }),
    });
    expect(result.failures).toEqual([]);
    expect(result.stale).toBe(1);
    expect(result.staleFlags[0]).toContain("input hashes differ");
    expect(result.staleFlags[0]).toContain("model");
  });
});
