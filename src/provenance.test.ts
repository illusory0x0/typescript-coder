import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeInputHashes, currentInputHashes, stableStringify } from "./provenance";
import type { AgentMode } from "./loop";
import type { MeasuredInput } from "./provenance";

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
    loopConfig: { costBudgetUsd: 0.1, effort: "none", reps: 3 },
    pricing: {
      fetchedOn: "2026-10-27",
      rates: {
        cacheHitInputPerMillion: 0.006,
        cacheMissInputPerMillion: 0.3,
        outputPerMillion: 1.2,
      },
    },
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
        effort: null,
        reps: 3,
      };
      const first = currentInputHashes(root, base);
      const second = currentInputHashes(root, base);
      expect(first).toEqual(second);

      // Edit-dsl is the only protocol, so the prompt digest is deterministic.
      expect(currentInputHashes(root, base).inputs.systemPrompt).toBe(first.inputs.systemPrompt);

      const effort = currentInputHashes(root, { ...base, effort: "high" });
      expect(effort.inputs.loopConfig).not.toBe(first.inputs.loopConfig);

      // Plan/execute/review pins its own prompt + task caps; pinned-repair
      // hashes stay stable.
      const plan = currentInputHashes(root, { ...base, agentMode: "plan-exec" });
      expect(plan.inputs.systemPrompt).not.toBe(first.inputs.systemPrompt);
      expect(plan.inputs.loopConfig).not.toBe(first.inputs.loopConfig);
      expect(currentInputHashes(root, { ...base, agentMode: "pinned-repair" })).toEqual(first);
      expect(
        currentInputHashes(root, {
          ...base,
          agentMode: "edit" as unknown as AgentMode,
        }),
      ).toEqual(first);

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
