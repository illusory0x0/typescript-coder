import type { LoopResult, TerminationReason } from "./loop";

/**
 * Versioned contract of the machine-readable sub-agent result (#80, #28).
 * `@3` carries WorkNode summaries on plan/execute runs; the removed `@2`
 * carried per-edit Stage/Task/Edit summaries.
 */
export const RESULT_FORMAT = "typescript-coder-result@3";

export interface ResultTokens {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
}

/** Reserved target list in the result schema; always empty now. */
export interface ResultTarget {
  path: string;
  symbol: string;
  kind: string;
}

/** One declaration the run applied an edit to. */
export interface ResultFile {
  path: string;
  symbol: string;
  kind: string;
  outcome: string;
}

/** Plan/execute per-node summary; its `id` is a string graph node id. */
export type ResultNode = NonNullable<LoopResult["nodes"]>[number];

/** The `typescript-coder-result@3` object `--format json` prints on stdout (#80, #28). */
export interface SubagentResult {
  format: typeof RESULT_FORMAT;
  status: "ok" | "failed";
  verified: boolean;
  files: ResultFile[];
  targets: ResultTarget[];
  records: number;
  tokens: ResultTokens;
  terminationReason: TerminationReason | null;
  diagnostics: string | null;
  /** Plan/execute runs: one entry per WorkNode, in record order; absent in edit mode. */
  nodes?: ResultNode[];
}

function zeroResultTokens(): ResultTokens {
  return { input: 0, output: 0, total: 0, cacheRead: 0 };
}

/**
 * Build the sub-agent result from a finished run (#80): `verified` mirrors
 * `result.ok`; `files` is the de-duplicated set of declarations an applied
 * exchange addressed (a plan-exec row may cover several); `records` is the raw
 * record count. `targets` stays an empty schema field and `tokens` defaults to
 * zeros.
 * A plan/execute run also carries `nodes`, whose ids are string graph node ids
 * in `typescript-coder-result@3` (#28).
 */
export function buildSubagentResult(input: {
  result: LoopResult;
  tokens?: ResultTokens;
}): SubagentResult {
  const { result } = input;
  const seen = new Set<string>();
  const files: ResultFile[] = [];
  for (const record of result.records) {
    if (record.kind !== "exchange" || record.outcome !== "applied") {
      continue;
    }
    // A plan-exec applied row can cover several addresses; fall back to the
    // row's own locator for the single-target driver.
    for (const locator of record.appliedLocators ?? [record.locator]) {
      const { path, name, kind } = locator;
      const key = `${path}\u0000${name}\u0000${kind}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      files.push({ path, symbol: name, kind, outcome: "applied" });
    }
  }
  return {
    format: RESULT_FORMAT,
    status: result.ok ? "ok" : "failed",
    verified: result.ok,
    files,
    targets: [],
    records: result.records.length,
    tokens: input.tokens ?? zeroResultTokens(),
    terminationReason: result.terminationReason ?? null,
    diagnostics: result.diagnostics,
    ...(result.nodes === undefined ? {} : { nodes: result.nodes }),
  };
}

/** Serialize one result as the single stdout line `--format json` carries (#80). */
export function serializeSubagentResult(result: SubagentResult): string {
  return JSON.stringify(result);
}
