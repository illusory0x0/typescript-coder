import { describe, expect, test } from "bun:test";
import { RESULT_FORMAT, buildSubagentResult, serializeSubagentResult } from "./result";
import type { LoopRecord, LoopResult } from "./loop";

const LOCATOR = { path: "src/helper.ts", name: "answer", kind: "function" };

function recordOf(overrides: Partial<LoopRecord> = {}): LoopRecord {
  return {
    row: 1,
    iteration: 1,
    kind: "exchange",
    exchange: 1,
    outcome: "selected",
    locator: LOCATOR,
    replacement: null,
    diagnostics: null,
    diagnosticsHead: null,
    replacementChars: null,
    finishReason: "stop",
    signature: null,
    ...overrides,
  };
}

function resultOf(overrides: Partial<LoopResult> = {}): LoopResult {
  return {
    ok: true,
    locator: LOCATOR,
    filePath: "src/helper.ts",
    editedSource: null,
    records: [],
    diagnostics: null,
    explanation: null,
    messages: [],
    tokens: { input: 0, output: 0, total: 0, cacheRead: 0, reasoning: 0 },
    ...overrides,
  };
}

describe("RESULT_FORMAT", () => {
  test("is the @3 WorkNode-summary contract", () => {
    expect(RESULT_FORMAT).toBe("typescript-coder-result@3");
  });
});

describe("buildSubagentResult", () => {
  test("maps an ok run to ok/verified with the default empty targets and zero tokens", () => {
    const result = buildSubagentResult({ result: resultOf({ records: [recordOf()] }) });
    expect(result).toEqual({
      format: RESULT_FORMAT,
      status: "ok",
      verified: true,
      files: [],
      targets: [],
      records: 1,
      tokens: { input: 0, output: 0, total: 0, cacheRead: 0 },
      terminationReason: null,
      diagnostics: null,
    });
  });

  test("maps a failed run to failed/verified:false and carries diagnostics/termination", () => {
    const result = buildSubagentResult({
      result: resultOf({
        ok: false,
        diagnostics: "stage: tsc\nerror TS2322",
        terminationReason: "edit-exhausted",
        records: [
          recordOf({ outcome: "protocol" }),
          recordOf({ kind: "verification", outcome: "tsc" }),
        ],
      }),
    });
    expect(result.status).toBe("failed");
    expect(result.verified).toBe(false);
    expect(result.records).toBe(2);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.diagnostics).toBe("stage: tsc\nerror TS2322");
  });

  test("collects applied exchange rows as files, deduped by path/symbol/kind", () => {
    const other = { path: "src/other.ts", name: "greet", kind: "function" };
    const result = buildSubagentResult({
      result: resultOf({
        records: [
          recordOf({ outcome: "applied" }),
          // duplicate of the first: same address, different exchange row
          recordOf({ row: 2, outcome: "applied" }),
          recordOf({ row: 3, locator: other, outcome: "applied" }),
          // non-applied exchange and a verification row are ignored
          recordOf({ row: 4, outcome: "protocol" }),
          recordOf({ row: 5, kind: "verification", outcome: "tsc" }),
        ],
      }),
    });
    expect(result.files).toEqual([
      { path: "src/helper.ts", symbol: "answer", kind: "function", outcome: "applied" },
      { path: "src/other.ts", symbol: "greet", kind: "function", outcome: "applied" },
    ]);
  });

  test("names every address an applied row covered", () => {
    const other = { path: "src/other.ts", name: "greet", kind: "function" };
    const result = buildSubagentResult({
      result: resultOf({
        records: [recordOf({ outcome: "applied", appliedLocators: [LOCATOR, other] })],
      }),
    });
    expect(result.files).toEqual([
      { path: "src/helper.ts", symbol: "answer", kind: "function", outcome: "applied" },
      { path: "src/other.ts", symbol: "greet", kind: "function", outcome: "applied" },
    ]);
  });

  test("keeps the empty targets schema and echoes tokens", () => {
    const tokens = { input: 10, output: 4, total: 14, cacheRead: 2 };
    const result = buildSubagentResult({ result: resultOf(), tokens });
    expect(result.targets).toEqual([]);
    expect(result.tokens).toBe(tokens);
  });

  test("carries additive plan/execute turn telemetry", () => {
    const result = buildSubagentResult({
      result: resultOf({
        turns: { planning: 1, execution: 2, review: 1, total: 4 },
      }),
    });
    expect(result.turns).toEqual({ planning: 1, execution: 2, review: 1, total: 4 });
  });

  test("carries plan/execute WorkNode summaries with string node ids (#49)", () => {
    const result = buildSubagentResult({
      result: resultOf({
        nodes: [
          {
            id: "02-answer",
            verify: "test",
            status: "passed",
            phase: "implement",
          },
          {
            id: "03-final",
            verify: "test",
            status: "passed",
          },
        ],
      }),
    });
    expect(result.nodes?.[0]).toMatchObject({
      id: "02-answer",
      verify: "test",
      status: "passed",
      phase: "implement",
    });
    expect(result.nodes?.[1]?.id).toBe("03-final");
    expect(typeof result.nodes?.[0]?.id).toBe("string");
  });
});

describe("serializeSubagentResult", () => {
  test("round-trips through JSON.stringify as one object", () => {
    const built = buildSubagentResult({
      result: resultOf({
        ok: false,
        diagnostics: "verification failed",
        terminationReason: "delete-verification-failed",
        records: [recordOf({ outcome: "applied" })],
      }),
      tokens: { input: 1, output: 2, total: 3, cacheRead: 0 },
    });
    const text = serializeSubagentResult(built);
    expect(text).toBe(JSON.stringify(built));
    expect(JSON.parse(text)).toEqual({
      format: "typescript-coder-result@3",
      status: "failed",
      verified: false,
      files: [{ path: "src/helper.ts", symbol: "answer", kind: "function", outcome: "applied" }],
      targets: [],
      records: 1,
      tokens: { input: 1, output: 2, total: 3, cacheRead: 0 },
      terminationReason: "delete-verification-failed",
      diagnostics: "verification failed",
    });
  });
});
