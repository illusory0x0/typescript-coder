// Provenance pinning for benchmark result records (#66).
//
// A benchmark number is comparable only against numbers measured on the same
// fixture text, model-facing prompt text, loop configuration, and pricing
// table. This module turns each of those measured inputs into a content hash so
// a stale record is detectable mechanically, and provides the zero-API ledger
// helpers that re-derive every `benchmark/results/consumption.md` row from its
// cited source JSON.
//
// Hashing rules (documented in `benchmark/README.md`, §"Evidence and
// provenance"):
// - Per-input sha256 hex digests: `model`, `taskIssue` (the frozen task spec text,
//   keyed by task), `fixture` (the fixture's on-disk content, keyed by task and
//   relative path), `systemPrompt` (`buildSystemPrompt()`), `loopConfig`
//   (budgets/effort/reps), and `pricing` (the
//   rate table plus `PRICING_FETCHED_ON`).
// - Text pieces are newline-normalized to `\n`; object pieces are serialized
//   through a stable (recursively key-sorted) JSON encoding.
// - `inputHash` is sha256 over the stable JSON of the per-input digest object.
//
// `computeInputHashes` hashes precomputed pieces (used by `benchmark/run.ts`);
// `currentInputHashes` reads the same pieces from the current tree (used by
// `benchmark/check.ts` to flag staleness without re-running).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  OFF_PEAK_RATES_PER_MILLION,
  PEAK_RATES_PER_MILLION,
  PRICING_FETCHED_ON,
  costAtRates,
  runCost,
} from "./benchmark-pricing";
import type { TokenBuckets } from "./benchmark-pricing";
import {
  DEFAULT_TOKEN_BUDGET,
  MAX_STALLED_ROUNDS,
  buildSystemPrompt,
  canonicalAgentMode,
} from "./loop";
import type { AgentMode } from "./loop";
import { buildTaskExecutionSystemPrompt, buildTaskPlanningSystemPrompt } from "./prompts/task";

/** Frozen task names the benchmark measures. */
export const TASK_NAMES = ["json-parser", "sexp-parser", "minilisp"] as const;
export type TaskName = (typeof TASK_NAMES)[number];

/** The per-input digest set a result record pins. */
export interface InputHashes {
  readonly model: string;
  readonly taskIssue: string;
  readonly fixture: string;
  readonly systemPrompt: string;
  readonly loopConfig: string;
  readonly pricing: string;
}

/** A result record's provenance block (`provenance` in the result JSON). */
export interface Provenance {
  readonly inputs: InputHashes;
  readonly inputHash: string;
}

/** The provenance block as written into a result JSON, stamped with its date. */
export interface RecordedProvenance extends Provenance {
  readonly computedAt: string;
}

/** The measured pieces, precomputed by the caller (run-time or from the tree). */
export interface MeasuredInput {
  readonly model: string;
  readonly taskIssue: string;
  readonly fixture: string;
  readonly systemPrompt: string;
  readonly loopConfig: unknown;
  readonly pricing: unknown;
}

export interface LoopConfig {
  readonly tokenBudget: number;
  readonly maxStalledRounds: number;
  readonly effort: string;
  readonly reps: number;
  readonly multiPayload: boolean;
  /**
   * Pinned-repair termination model (#57). Pinned-repair no longer has fixed
   * exchange/round caps: it ends on success, the token budget, a repeated
   * no-progress fingerprint, or a no-progress STOP. The literal makes that
   * scheduling change visible in provenance.
   */
  readonly scheduling?: "token-budget+no-progress";
  /**
   * Hash literal for the plan/execute loop (#34). The canonical `plan-exec`
   * writes this string so recorded plan-exec provenance identifies the driver.
   * Pinned-repair omits the field, preserving the historical edit-loop hashes.
   */
  readonly agentMode?: "plan-exec";
  /**
   * The plan-exec graph protocol. `work-dag` identifies the hints-based
   * WorkNode driver, which has no fixed exchange/round caps.
   */
  readonly planExec?: "work-dag";
  /**
   * Historical pinned-repair provenance literals, retained only so plan-exec's
   * loop-config hash stays byte-identical to earlier records. They never
   * described plan-exec scheduling and are not read by any driver.
   */
  readonly maxEditExchanges?: number;
  readonly maxRunIterations?: number;
}

export interface CurrentInputOptions {
  /** Tasks measured by the report; used to key the task-text and fixture hashes. */
  readonly tasks: readonly string[];
  /** Frozen task spec text per task (`TASK_SPECS` in `benchmark/run.ts`). */
  readonly taskIssues: Readonly<Record<string, string>>;
  readonly model: string;
  /** Forced reasoning effort, or null for the default policy. */
  readonly effort: string | null;
  readonly reps: number;
  /** Token budget, or null for `DEFAULT_TOKEN_BUDGET`. */
  readonly tokenBudget?: number | null;
  /** Loop mode; absent or `pinned-repair` keeps the historical pinned-repair hashes. */
  readonly agentMode?: AgentMode;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Normalize CRLF/CR to LF so a checkout made on another platform hashes the same. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

/** Stable (recursively key-sorted) JSON, so insertion order never changes a hash. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "null";
}

/** The current rate table plus its fetch date (see `src/benchmark-pricing.ts`). */
export function pricingTable(): unknown {
  return {
    fetchedOn: PRICING_FETCHED_ON,
    rates: {
      peak: PEAK_RATES_PER_MILLION,
      offPeak: OFF_PEAK_RATES_PER_MILLION,
    },
  };
}

/** Loop budget/effort/reps (#66): the knobs that make a run comparable. */
export function loopConfigHashInput(options: {
  tokenBudget?: number | null;
  effort: string | null;
  reps: number;
  agentMode?: AgentMode;
}): LoopConfig {
  const base: LoopConfig = {
    tokenBudget: options.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    maxStalledRounds: MAX_STALLED_ROUNDS,
    effort: options.effort ?? "none",
    reps: options.reps,
    multiPayload: false,
  };
  // Canonicalize the option and write the plan-exec literal into the hash so
  // recorded provenance stays byte-identical across the rename (#34). Plan-exec
  // keeps the historical pinned cap fields only as provenance literals; they
  // are not scheduling knobs and keep old plan-exec hashes comparable.
  return canonicalAgentMode(options.agentMode) === "plan-exec"
    ? {
        ...base,
        maxEditExchanges: 3,
        maxRunIterations: 32,
        agentMode: "plan-exec",
        planExec: "work-dag",
      }
    : { ...base, scheduling: "token-budget+no-progress" };
}

/** Hash the measured pieces into per-input digests plus the derived `inputHash`. */
export function computeInputHashes(input: MeasuredInput): Provenance {
  const inputs: InputHashes = {
    model: sha256(normalizeText(input.model)),
    taskIssue: sha256(normalizeText(input.taskIssue)),
    fixture: sha256(normalizeText(input.fixture)),
    systemPrompt: sha256(normalizeText(input.systemPrompt)),
    loopConfig: sha256(stableStringify(input.loopConfig)),
    pricing: sha256(stableStringify(input.pricing)),
  };
  return { inputs, inputHash: sha256(stableStringify(inputs)) };
}

function readFixtureContents(fixtureDir: string): Record<string, string> {
  if (!existsSync(fixtureDir)) {
    throw new Error(`fixture directory not found: ${fixtureDir}`);
  }
  const files: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        files[relativePath] = normalizeText(readFileSync(join(directory, entry.name), "utf8"));
      }
    }
  };
  walk(fixtureDir, "");
  return files;
}

/**
 * Compute the same per-input hashes from the current tree: frozen task text from
 * `options.taskIssues`, fixture content from `benchmark/fixtures/<task>/`, the
 * prompt from `buildSystemPrompt`, loop config from the constants, and pricing
 * from the rate table. Used to flag stale rows without re-running.
 */
export function currentInputHashes(root: string, options: CurrentInputOptions): Provenance {
  const tasks = [...options.tasks].sort();
  const issues: Record<string, string> = {};
  const fixtures: Record<string, Record<string, string>> = {};
  for (const task of tasks) {
    issues[task] = normalizeText(options.taskIssues[task] ?? "");
    fixtures[task] = readFixtureContents(join(root, "benchmark", "fixtures", task));
  }
  const planning = canonicalAgentMode(options.agentMode) === "plan-exec";
  return computeInputHashes({
    model: options.model,
    taskIssue: stableStringify(issues),
    fixture: stableStringify(fixtures),
    systemPrompt: planning
      ? `${buildTaskPlanningSystemPrompt()}\n\n---\n\n${buildTaskExecutionSystemPrompt()}`
      : buildSystemPrompt(),
    loopConfig: loopConfigHashInput({
      tokenBudget: options.tokenBudget ?? null,
      effort: options.effort,
      reps: options.reps,
      agentMode: options.agentMode,
    }),
    pricing: pricingTable(),
  });
}

// ---------------------------------------------------------------------------
// consumption.md ledger helpers
// ---------------------------------------------------------------------------

/** One ledger cell: USD per success and the `ok/runs` success count. */
export interface ConsumptionValue {
  readonly costPerSuccess: number | null;
  readonly ok: number;
  readonly runs: number;
}

export type RowValueKey = TaskName | "overall";

/** Edit protocol named by a ledger row or result record (#16/#119). */
export type LedgerProtocol = "json" | "edit-dsl";

/**
 * Normalize a protocol name. `compact` is the deprecated alias for `edit-dsl`
 * (#15), still present in legacy reports, bundles, and ledger rows.
 */
export function normalizeProtocolFormat(value: unknown): LedgerProtocol | null {
  if (value === "json") {
    return "json";
  }
  if (value === "edit-dsl" || value === "compact") {
    return "edit-dsl";
  }
  return null;
}

export interface ConsumptionRow {
  /** 1-based line in the markdown, for naming a row in a failure. */
  readonly line: number;
  readonly date: string;
  readonly changeSet: string;
  readonly source: string;
  readonly sourceJsonPaths: readonly string[];
  /** Coder-side rows (`tc`/`ts`); the ledger's canonical series. */
  readonly side: "coder";
  /**
   * Protocol named by the row's `Protocol` column, normalized (#16); null for
   * legacy tables without that column.
   */
  readonly protocol: LedgerProtocol | null;
  readonly values: Readonly<Record<RowValueKey, ConsumptionValue>>;
}

export interface DerivedRow {
  readonly values: Readonly<Record<RowValueKey, ConsumptionValue>>;
}

const ROWS_HEADING = /^##\s+Rows\s*$/;
const CLAIM_VALUE = /^\$(\d+\.\d+)\s+\((\d+)\/(\d+)\)$/;
const CLAIM_NA = /^n\/a\s+\((\d+)\/(\d+)\)$/;
const SOURCE_JSON = /`([^`]+\.json)`/g;

function parseClaimedValue(cell: string): ConsumptionValue | null {
  const money = CLAIM_VALUE.exec(cell);
  if (money !== null) {
    return {
      costPerSuccess: Number(money[1]),
      ok: Number(money[2]),
      runs: Number(money[3]),
    };
  }
  const missing = CLAIM_NA.exec(cell);
  if (missing !== null) {
    return { costPerSuccess: null, ok: Number(missing[1]), runs: Number(missing[2]) };
  }
  return null;
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.every((cell) => /^:?-+:?$/.test(cell));
}

/**
 * Parse the canonical `## Rows` table of `consumption.md`. Cross-side baselines
 * live in a separate table with a different layout and are out of scope for
 * value re-derivation (see `benchmark/README.md`).
 */
export function parseConsumptionRows(markdown: string): ConsumptionRow[] {
  const lines = markdown.split("\n");
  const headingIndex = lines.findIndex((line) => ROWS_HEADING.test(line.trim()));
  if (headingIndex === -1) {
    return [];
  }
  // The Protocol column is newer than the original table (#16); locate it by
  // header name so legacy tables without it still parse.
  let protocolIndex: number | null = null;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim().startsWith("|")) {
      continue;
    }
    const cells = splitTableCells(line);
    if (cells.length === 0 || isSeparatorRow(cells)) {
      continue;
    }
    const found = cells.findIndex((cell) => cell.toLowerCase() === "protocol");
    protocolIndex = found === -1 ? null : found;
    break;
  }
  const rows: ConsumptionRow[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim().startsWith("|")) {
      if (rows.length > 0) {
        break;
      }
      continue;
    }
    const cells = splitTableCells(line);
    if (cells.length < 7 || isSeparatorRow(cells)) {
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cells[0] ?? "")) {
      continue;
    }
    const source = cells[6] ?? "";
    const jsonPaths = [...source.matchAll(SOURCE_JSON)].map((match) => match[1] ?? "");
    const protocol =
      protocolIndex === null ? null : normalizeProtocolFormat(cells[protocolIndex] ?? null);
    const jsonParser = parseClaimedValue(cells[2] ?? "");
    const sexpParser = parseClaimedValue(cells[3] ?? "");
    const minilisp = parseClaimedValue(cells[4] ?? "");
    const overall = parseClaimedValue(cells[5] ?? "");
    if (jsonParser === null || sexpParser === null || minilisp === null || overall === null) {
      // A malformed value cell is a row the check must name; keep it so the
      // ledger pass fails loudly instead of silently dropping it.
      rows.push({
        line: index + 1,
        date: cells[0] ?? "",
        changeSet: cells[1] ?? "",
        source,
        sourceJsonPaths: jsonPaths,
        side: "coder",
        protocol,
        values: {
          "json-parser": jsonParser ?? { costPerSuccess: null, ok: 0, runs: 0 },
          "sexp-parser": sexpParser ?? { costPerSuccess: null, ok: 0, runs: 0 },
          minilisp: minilisp ?? { costPerSuccess: null, ok: 0, runs: 0 },
          overall: overall ?? { costPerSuccess: null, ok: 0, runs: 0 },
        },
      });
      continue;
    }
    rows.push({
      line: index + 1,
      date: cells[0] ?? "",
      changeSet: cells[1] ?? "",
      source,
      sourceJsonPaths: jsonPaths,
      side: "coder",
      protocol,
      values: {
        "json-parser": jsonParser,
        "sexp-parser": sexpParser,
        minilisp: minilisp,
        overall,
      },
    });
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function coderSide(json: Record<string, unknown>): "tc" | "ts" | null {
  const sides = new Set<string>();
  const aggregates = json["aggregates"];
  if (isRecord(aggregates)) {
    const bySide = aggregates["bySide"];
    if (Array.isArray(bySide)) {
      for (const row of bySide) {
        if (isRecord(row) && typeof row["side"] === "string") {
          sides.add(row["side"]);
        }
      }
    }
  }
  const runs = json["runs"];
  if (Array.isArray(runs)) {
    for (const run of runs) {
      if (isRecord(run) && typeof run["side"] === "string") {
        sides.add(run["side"]);
      }
    }
  }
  if (sides.has("tc")) {
    return "tc";
  }
  if (sides.has("ts")) {
    return "ts";
  }
  return null;
}

function tokenBuckets(run: Record<string, unknown>): TokenBuckets | null {
  const tokens = run["tokens"];
  if (!isRecord(tokens)) {
    return null;
  }
  return tokens as unknown as TokenBuckets;
}

// Per-run USD: prefer the recorded cost; fall back to the run's pricing window
// (newer runs), then to the off-peak rate table (historical rows all ran
// off-peak and predate `startedAt`/`finishedAt`). The historical `ts` label uses
// the same token conventions as `tc`.
function runCostOf(run: Record<string, unknown>, side: "tc" | "ts"): number {
  const cost = run["cost"];
  if (typeof cost === "number" && Number.isFinite(cost)) {
    return cost;
  }
  const buckets = tokenBuckets(run);
  if (buckets === null) {
    return 0;
  }
  const pricingSide = side === "ts" ? "tc" : side;
  const startedAt = run["startedAt"];
  const finishedAt = run["finishedAt"];
  if (typeof startedAt === "string" && typeof finishedAt === "string") {
    return runCost(buckets, pricingSide, new Date(startedAt), new Date(finishedAt)).cost;
  }
  return costAtRates(buckets, pricingSide, OFF_PEAK_RATES_PER_MILLION);
}

function deriveValue(
  runs: readonly Record<string, unknown>[],
  side: "tc" | "ts",
): ConsumptionValue {
  let ok = 0;
  let total = 0;
  for (const run of runs) {
    if (run["ok"] === true) {
      ok += 1;
    }
    total += runCostOf(run, side);
  }
  return { costPerSuccess: ok === 0 ? null : total / ok, ok, runs: runs.length };
}

/** The report's scalar protocol, normalized (legacy single-variant reports). */
function reportProtocolFormat(json: Record<string, unknown>): LedgerProtocol | null {
  const scalar = normalizeProtocolFormat(json["protocolFormat"]);
  if (scalar !== null) {
    return scalar;
  }
  const formats = json["protocolFormats"];
  if (Array.isArray(formats) && formats.length === 1) {
    return normalizeProtocolFormat(formats[0]);
  }
  return null;
}

// A run's own protocol (#16); legacy records have no field, so fall back to the
// report's scalar protocol.
function runProtocolFormat(
  run: Record<string, unknown>,
  fallback: LedgerProtocol | null,
): LedgerProtocol | null {
  return normalizeProtocolFormat(run["protocol"]) ?? fallback;
}

/**
 * Re-derive a ledger row's per-task and overall values from its cited source
 * JSON. The row selects the side (the canonical table is the coder side) and,
 * when its Protocol column is present, that tc variant (#16); the JSON may be an
 * older record labelled `ts`/`opencode` or a current one labelled `tc`/`oc`.
 */
export function deriveRowFromJson(row: ConsumptionRow, json: unknown): DerivedRow {
  if (!isRecord(json)) {
    throw new Error(`ledger row ${row.date} ${row.changeSet}: source JSON is not an object`);
  }
  const side = coderSide(json);
  if (side === null) {
    throw new Error(
      `ledger row ${row.date} ${row.changeSet}: source JSON carries no coder side (tc/ts)`,
    );
  }
  const runs = Array.isArray(json["runs"]) ? (json["runs"] as unknown[]).filter(isRecord) : [];
  const fallbackProtocol = reportProtocolFormat(json);
  const sideRuns = runs.filter(
    (run) =>
      run["side"] === side &&
      (row.protocol === null || runProtocolFormat(run, fallbackProtocol) === row.protocol),
  );
  const values = {} as Record<RowValueKey, ConsumptionValue>;
  for (const task of TASK_NAMES) {
    values[task] = deriveValue(
      sideRuns.filter((run) => run["task"] === task),
      side,
    );
  }
  values.overall = deriveValue(sideRuns, side);
  return { values };
}

export interface LedgerCheckOptions {
  /** Resolve a cited source path to parsed JSON; null when the file is missing. */
  readonly loadSource: (path: string) => unknown | null;
  /**
   * Current-tree hashes for a source report (or null to skip the staleness
   * pass). Receives the parsed source JSON and the ledger row's protocol (#16),
   * or null for a legacy row without a Protocol column.
   */
  readonly currentFor?: (
    json: Record<string, unknown>,
    protocol: LedgerProtocol | null,
  ) => Provenance | null;
}

export interface LedgerCheckResult {
  readonly rows: number;
  readonly checked: number;
  readonly fresh: number;
  readonly stale: number;
  readonly failures: readonly string[];
  readonly staleFlags: readonly string[];
}

function round5(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(5));
}

function rowLabel(row: ConsumptionRow): string {
  return `${row.date} "${row.changeSet}" (line ${row.line})`;
}

// Multi-variant reports (#16) carry one provenance block per tc protocol; a
// ledger row selects its own. Legacy/single-variant reports keep the scalar
// `provenance`, which is also the fallback when the map has no matching key.
function recordedProvenanceFor(
  json: Record<string, unknown>,
  protocol: LedgerProtocol | null,
): unknown {
  const map = json["provenanceByProtocol"];
  if (protocol !== null && isRecord(map)) {
    const direct = map[protocol];
    if (isRecord(direct)) {
      return direct;
    }
    // A legacy ledger row may name the pre-rename alias.
    const alias = map[protocol === "edit-dsl" ? "compact" : protocol];
    if (isRecord(alias)) {
      return alias;
    }
  }
  return json["provenance"];
}

function sameValue(claimed: ConsumptionValue, derived: ConsumptionValue): boolean {
  return (
    claimed.ok === derived.ok &&
    claimed.runs === derived.runs &&
    round5(claimed.costPerSuccess) === round5(derived.costPerSuccess)
  );
}

function formatValue(value: ConsumptionValue): string {
  const cost = value.costPerSuccess === null ? "n/a" : `$${value.costPerSuccess.toFixed(5)}`;
  return `${cost} (${value.ok}/${value.runs})`;
}

const INPUT_KEYS: readonly (keyof InputHashes)[] = [
  "model",
  "taskIssue",
  "fixture",
  "systemPrompt",
  "loopConfig",
  "pricing",
];

/**
 * Zero-API ledger pass: re-derive each `## Rows` row from its cited source JSON
 * and compare (round to 5 decimals), naming a mismatching row. Rows whose source
 * lacks `provenance` or whose recorded hashes differ from the current tree are
 * stale-flagged, not failed. A row without exactly one `.json` source, or with a
 * missing cited file, fails.
 */
export function checkLedger(markdown: string, options: LedgerCheckOptions): LedgerCheckResult {
  const rows = parseConsumptionRows(markdown);
  const failures: string[] = [];
  const staleFlags: string[] = [];
  let checked = 0;
  let fresh = 0;
  let stale = 0;

  for (const row of rows) {
    const label = rowLabel(row);
    if (row.sourceJsonPaths.length !== 1) {
      failures.push(
        `${label}: expected exactly one .json source, found ${row.sourceJsonPaths.length} (${row.source})`,
      );
      continue;
    }
    const sourcePath = row.sourceJsonPaths[0] ?? "";
    const json = options.loadSource(sourcePath);
    if (json === null) {
      failures.push(`${label}: cited source missing: ${sourcePath}`);
      continue;
    }
    let derived: DerivedRow;
    try {
      derived = deriveRowFromJson(row, json);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    checked += 1;
    let mismatched = false;
    for (const key of [...TASK_NAMES, "overall"] as RowValueKey[]) {
      const claimed = row.values[key];
      const actual = derived.values[key];
      if (!sameValue(claimed, actual)) {
        mismatched = true;
        failures.push(
          `${label}: ${key} ${formatValue(claimed)} does not match ${sourcePath} (${formatValue(actual)})`,
        );
      }
    }
    if (mismatched) {
      continue;
    }

    if (options.currentFor === undefined) {
      continue;
    }
    if (!isRecord(json)) {
      continue;
    }
    const recorded = recordedProvenanceFor(json, row.protocol);
    const current = options.currentFor(json, row.protocol);
    if (!isRecord(recorded) || !isRecord(recorded["inputs"])) {
      stale += 1;
      staleFlags.push(`stale: ${label} (${sourcePath}): no provenance recorded (predates #66)`);
      continue;
    }
    if (current === null) {
      continue;
    }
    const recordedInputs = recorded["inputs"] as Record<string, unknown>;
    const differing = INPUT_KEYS.filter((key) => recordedInputs[key] !== current.inputs[key]);
    const hashDiffers = recorded["inputHash"] !== current.inputHash;
    if (differing.length > 0 || hashDiffers) {
      stale += 1;
      staleFlags.push(
        `stale: ${label} (${sourcePath}): current-tree input hashes differ (${differing.join(", ") || "inputHash"})`,
      );
    } else {
      fresh += 1;
    }
  }

  return { rows: rows.length, checked, fresh, stale, failures, staleFlags };
}
