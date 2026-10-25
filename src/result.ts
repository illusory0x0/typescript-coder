import type { LoopResult, TerminationReason } from "./loop";

/**
 * Versioned contract of the machine-readable sub-agent result (#80, #28).
 * `@2` carries string node ids on the plan/execute task summaries.
 */
export const RESULT_FORMAT = "typescript-coder-result@2";

export interface ResultTokens {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
}

/** One target the run was asked to address (#81, echoed as `[]` for now). */
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

/** Plan/execute per-edit summary; its `id`, `stage`, and `task` are string node ids. */
export type ResultTask = NonNullable<LoopResult["tasks"]>[number];

/** The `typescript-coder-result@2` object `--format json` prints on stdout (#80, #28). */
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
  /** Plan/execute runs: one entry per edit, in tree order; absent in edit mode. */
  tasks?: ResultTask[];
}

function zeroResultTokens(): ResultTokens {
  return { input: 0, output: 0, total: 0, cacheRead: 0 };
}

/**
 * Build the sub-agent result from a finished run (#80): `verified` mirrors
 * `result.ok`; `files` is the de-duplicated set of declarations an applied
 * exchange addressed (an explicit-targets batch row may cover several, #81);
 * `records` is the raw record count. `targets` echoes the requested addresses
 * (empty for the default path-independent mode) and `tokens` defaults to zeros.
 * A plan/execute run also carries `tasks`, whose node-id fields are strings in
 * `typescript-coder-result@2` (#28).
 */
export function buildSubagentResult(input: {
  result: LoopResult;
  targets?: ResultTarget[];
  tokens?: ResultTokens;
}): SubagentResult {
  const { result } = input;
  const seen = new Set<string>();
  const files: ResultFile[] = [];
  for (const record of result.records) {
    if (record.kind !== "exchange" || record.outcome !== "applied") {
      continue;
    }
    // Explicit-targets mode (#81): one applied row can cover several addresses;
    // fall back to the row's own locator for the classic single-payload path.
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
    targets: input.targets ?? [],
    records: result.records.length,
    tokens: input.tokens ?? zeroResultTokens(),
    terminationReason: result.terminationReason ?? null,
    diagnostics: result.diagnostics,
    ...(result.tasks === undefined ? {} : { tasks: result.tasks }),
  };
}

/** Serialize one result as the single stdout line `--format json` carries (#80). */
export function serializeSubagentResult(result: SubagentResult): string {
  return JSON.stringify(result);
}
