import type { LoopResult, TerminationReason } from "./loop";

/** Versioned contract of the machine-readable sub-agent result (#80). */
export const RESULT_FORMAT = "typescript-coder-result@1";

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

/** The `typescript-coder-result@1` object `--format json` prints on stdout (#80). */
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
}

function zeroResultTokens(): ResultTokens {
  return { input: 0, output: 0, total: 0, cacheRead: 0 };
}

/**
 * Build the sub-agent result from a finished run (#80): `verified` mirrors
 * `result.ok`; `files` is the de-duplicated set of declarations an applied
 * exchange addressed; `records` is the raw record count. `targets` defaults to
 * an empty list (the explicit multi-file mode is a later issue) and `tokens`
 * defaults to zeros.
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
    const { path, name, kind } = record.locator;
    const key = `${path}\u0000${name}\u0000${kind}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    files.push({ path, symbol: name, kind, outcome: "applied" });
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
  };
}

/** Serialize one result as the single stdout line `--format json` carries (#80). */
export function serializeSubagentResult(result: SubagentResult): string {
  return JSON.stringify(result);
}
