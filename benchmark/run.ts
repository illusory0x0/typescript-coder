import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveFailureArtifacts, writeFailureArtifact } from "../src/failure-artifact";
import { exchangeStats, runLoop } from "../src/loop";
import { OpenAIProvider, readConfigFromEnv } from "../src/openai";
import type { ProviderLike, ProtocolFormat, RejectionCause } from "../src/loop";
import { ReplayRecorder, usageFromRaw } from "../src/replay-format";
import {
  PRICING_FETCHED_ON,
  PRICING_SOURCE_URL,
  billableTokens,
  runCost,
} from "../src/benchmark-pricing";
import { currentInputHashes } from "../src/provenance";
import type { BillableTokens, RateClass } from "../src/benchmark-pricing";
import type { RecordedProvenance } from "../src/provenance";
import type { ChatMessage, ChatResponse, ReasoningEffort, ToolDefinition } from "../src/openai";

export type TaskName = "json-parser" | "sexp-parser" | "minilisp" | "csv-parser";
export type Side = "tc" | "oc";
type SideSelection = Side | "both";

interface TaskSpec {
  readonly name: TaskName;
}

interface CliArgs {
  task: TaskName | null;
  all: boolean;
  reps: number;
  concurrency: number;
  pilot: boolean;
  side: SideSelection;
  model: string;
  ocModel: string | null;
  keep: boolean;
  json: string | null;
  replayDir: string | null;
  tokenBudget: number | null;
  effort: ReasoningEffort | null;
  multiPayload: boolean;
  /** Edit protocols (#119) to measure on the tc side; `edit-dsl` is the default. */
  protocolFormats: ProtocolFormat[];
  help: boolean;
}

interface TokenUsage {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly reasoning: number | null;
  readonly total: number | null;
}

/**
 * Cache-excluded, like-for-like token triple (#89): `in` is cache-miss input,
 * `out` is output (reasoning included), and `total = in + out`. Cache-hit input
 * is deliberately excluded so the two sides compare on the same basis.
 */
export interface RunTokens extends TokenUsage {
  readonly billable: BillableTokens;
}

interface CommandOutcome {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error: string | null;
}

interface RecordSummary {
  readonly row: number;
  readonly iteration: number;
  readonly kind: "exchange" | "verification";
  readonly exchange: number | null;
  readonly outcome: string;
  readonly diagnosticsHead: string | null;
  readonly replacementChars: number | null;
  readonly finishReason: string | null;
  /** Typed edit-rejection cause (#56); null on success and verification rows. */
  readonly cause: RejectionCause | null;
  /** Payload objects the exchange carried (#69): 1 classic, N batch, 0 none. */
  readonly payloads: number;
  /** Provider tool calls in the reply that produced this row (#69). */
  readonly toolCalls: number;
  /** Selectors the exchange's payloads used (#101); null when it carried none. */
  readonly selectors: string[] | null;
  /** Resolved cascade stages the exchange's payloads used (#110); null when none. */
  readonly stages: string[] | null;
  /** Matcher kinds the exchange's payloads used (#110); null when none. */
  readonly matcherKinds: (string | null)[] | null;
}

/**
 * Per-run exchange diagnostics (#69): rejected-vs-applied exchange counts plus
 * the command/tool-call volume the run's turns carried, so a benchmark record
 * exposes them without replay parsing.
 */
export interface RecordExchangeStats {
  readonly turns: number;
  readonly payloads: number;
  readonly toolCalls: number;
  readonly applied: number;
  readonly rejected: number;
  readonly selected: number;
  readonly stopped: number;
  /** Selector adoption across the run's payloads (#101). */
  readonly range: number;
  readonly matcher: number;
  readonly wholeSymbol: number;
  /** Resolved cascade-stage adoption across the run's payloads (#110). */
  readonly stageWholeSymbol: number;
  readonly stageMatch: number;
  readonly stagePick: number;
  /** Matcher-kind adoption across the run's payloads (#110). */
  readonly snippet: number;
  readonly regex: number;
  /** Edit-dsl implicit-create clauses the run's replies carried (#111). */
  readonly creates: number;
}

interface SideOutcome {
  readonly sideOk: boolean;
  readonly error: string | null;
  readonly infraError: string | null;
  readonly steps: number | null;
  readonly durationMs: number;
  /** Wall clock of the side's model work (what `durationMs` measures). */
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly tokens: TokenUsage;
  readonly usageAvailable: boolean;
  readonly usageSource: string;
  readonly rawUsage: unknown;
  readonly recordSummaries: readonly RecordSummary[] | null;
  /** Per-run rejected-vs-applied exchange counts (#69); null when no records. */
  readonly exchangeStats: RecordExchangeStats | null;
  readonly loopDiagnostics: string | null;
  readonly terminationReason: string | null;
  readonly logText: string;
  readonly sessionExportJson: string | null;
  readonly statsJson: string | null;
}

interface JudgeRecord {
  readonly testsOk: boolean;
  readonly tscOk: boolean;
  readonly fixtureOk: boolean;
  readonly detail: string | null;
}

interface LogPaths {
  readonly side: string;
  readonly judge: string;
  readonly session: string | null;
  readonly stats: string | null;
}

export interface RunRecord {
  readonly task: TaskName;
  readonly side: Side;
  /** Edit protocol used by a tc run (#119); null for the oc side. */
  readonly protocol: ProtocolFormat | null;
  readonly rep: number;
  readonly ok: boolean;
  readonly sideOk: boolean;
  readonly tokens: RunTokens;
  readonly usageAvailable: boolean;
  readonly usageSource: string;
  readonly rawUsage: unknown;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly cost: number | null;
  readonly rateClass: RateClass | null;
  readonly steps: number | null;
  readonly records: readonly RecordSummary[] | null;
  /** Per-run rejected-vs-applied exchange counts (#69); null when no records. */
  readonly exchangeStats: RecordExchangeStats | null;
  readonly loopDiagnostics: string | null;
  readonly terminationReason: string | null;
  readonly model: string;
  readonly workspace: string;
  readonly logs: LogPaths;
  readonly versions: { readonly bun: string; readonly opencode: string | null };
  readonly judge: JudgeRecord | null;
  readonly error: string | null;
  readonly infraError: string | null;
}

interface TokenStats {
  mean: number | null;
  total: number | null;
}

export interface AggregateRow {
  task: TaskName | null;
  side: Side | null;
  /** Edit protocol of a tc row (#119); null for the oc side and legacy rows. */
  protocol: ProtocolFormat | null;
  runs: number;
  ok: number;
  failed: number;
  successRate: number;
  usageRuns: number;
  /** Cache-excluded token stats (#89): `in` = cache-miss input, `out` = output. */
  tokens: { in: TokenStats; out: TokenStats; total: TokenStats };
  /** USD cost stats over runs that carry a cost (same shape as tokens). */
  cost: TokenStats;
  durationMsMean: number | null;
  stepsMean: number | null;
  tokensPerSuccess: { in: number | null; out: number | null; total: number | null };
  costPerSuccess: number | null;
  /** Selector adoption summed over the selected runs' exchanges (#101). */
  selectors: { range: number; matcher: number; wholeSymbol: number };
  /** Resolved cascade-stage adoption summed over the selected runs (#110). */
  stages: { wholeSymbol: number; match: number; pick: number };
  /** Matcher-kind adoption summed over the selected runs (#110). */
  matcherKinds: { snippet: number; regex: number };
  /** Edit-dsl implicit-create clauses summed over the selected runs (#111). */
  creates: number;
}

export interface Aggregates {
  byTaskSide: AggregateRow[];
  bySide: AggregateRow[];
  /**
   * One row per side and tc protocol (#16): never a single row that pools two
   * tc protocols into one comparison.
   */
  overall: AggregateRow[];
}

export interface Report {
  generatedAt: string;
  date: string;
  mode: "pilot" | "full";
  tasks: TaskName[];
  sides: Side[];
  reps: number;
  concurrency: number;
  model: string;
  /** oc-side model override (`--oc-model`); null when the oc side uses `model`. */
  ocModel: string | null;
  effort: ReasoningEffort | null;
  /** Opt-in multi-payload exchanges (#69): whether the tc side batched edits. */
  multiPayload: boolean;
  /**
   * Edit protocol (#119) the tc side used; scalar for single-protocol and
   * legacy reports, null when more than one variant was selected (#16).
   */
  protocolFormat: ProtocolFormat | null;
  /**
   * Selected tc protocol variants (#16), in canonical order. New reports always
   * write it; absent on legacy single-protocol reports.
   */
  protocolFormats?: ProtocolFormat[];
  /** Token budget forwarded to the tc side; null means `DEFAULT_TOKEN_BUDGET`. */
  tokenBudget: number | null;
  bunVersion: string;
  opencodeVersion: string | null;
  pilotReference: string | null;
  infraErrors: string[];
  runs: RunRecord[];
  aggregates: Aggregates;
  /**
   * Content hashes of the measured inputs (#66); scalar for single-protocol and
   * legacy reports, null when `provenanceByProtocol` carries one block per tc
   * variant (#16).
   */
  provenance: RecordedProvenance | null;
  /** Per-protocol provenance for a multi-variant report (#16). */
  provenanceByProtocol?: Partial<Record<ProtocolFormat, RecordedProvenance>>;
}

interface RunContext {
  readonly repoRoot: string;
  readonly tscBin: string;
  readonly model: string;
  readonly effort: ReasoningEffort | null;
  readonly opencodeModel: string;
  readonly opencode: OpencodeContext | null;
  readonly runRoot: string;
  readonly replayDir: string | null;
  readonly tokenBudget: number | null;
  /** Opt-in multi-payload exchanges (#69) forwarded to the tc side; off by default. */
  readonly multiPayload: boolean;
  /** Selected tc protocol variants (#16); used to keep multi-variant run names unique. */
  readonly protocols: readonly ProtocolFormat[];
}

interface BenchmarkJob {
  readonly task: TaskName;
  readonly side: Side;
  readonly rep: number;
  /** Edit protocol for a tc job (#119); null for the oc side. */
  readonly protocol: ProtocolFormat | null;
}

interface OpencodeContext {
  readonly bin: string;
  readonly version: string;
}

interface JudgeResult extends JudgeRecord {
  readonly ok: boolean;
  readonly log: string;
}

const TASKS: readonly TaskSpec[] = [
  { name: "json-parser" },
  { name: "sexp-parser" },
  { name: "minilisp" },
  { name: "csv-parser" },
];

// One issue string per task, used verbatim by both sides (G1 is quoted from
// the benchmark issue; G2/G3 are analogous with their exported names).
export const TASK_ISSUES: Record<TaskName, string> = {
  "json-parser": [
    "Implement src/json.ts exporting JsonValue and parseJson(text: string): JsonValue",
    "so that src/json.test.ts passes and `bunx tsc --noEmit` stays clean.",
    "Create or modify only src/json.ts - no other files, no scratch files;",
    "src/json.test.ts and tsconfig.json are read-only.",
    "The fixture contains only those files - nothing else to explore.",
    "The test file is the specification; implement what it requires, nothing more.",
    "Verify with `bun test` and `bunx tsc --noEmit` only.",
  ].join("\n"),
  "sexp-parser": [
    "Implement src/sexp.ts exporting Sexp and parseSexp(text: string): Sexp",
    "so that src/sexp.test.ts passes and `bunx tsc --noEmit` stays clean.",
    "Create or modify only src/sexp.ts - no other files, no scratch files;",
    "src/sexp.test.ts and tsconfig.json are read-only.",
    "The fixture contains only those files - nothing else to explore.",
    "The test file is the specification; implement what it requires, nothing more.",
    "Verify with `bun test` and `bunx tsc --noEmit` only.",
  ].join("\n"),
  minilisp: [
    "Implement src/lisp.ts exporting LispValue and run(program: string): LispValue",
    "so that src/lisp.test.ts passes and `bunx tsc --noEmit` stays clean.",
    "Create or modify only src/lisp.ts - no other files, no scratch files;",
    "src/lisp.test.ts and tsconfig.json are read-only.",
    "The fixture contains only those files - nothing else to explore.",
    "The test file is the specification; implement what it requires, nothing more.",
    "Verify with `bun test` and `bunx tsc --noEmit` only.",
  ].join("\n"),
  // Held-out task (#67): never a target of prompt or loop iteration.
  "csv-parser": [
    "Implement src/csv.ts exporting parseCsv(text: string): string[][]",
    "so that src/csv.test.ts passes and `bunx tsc --noEmit` stays clean.",
    "Create or modify only src/csv.ts - no other files, no scratch files;",
    "src/csv.test.ts and tsconfig.json are read-only.",
    "The fixture contains only those files - nothing else to explore.",
    "The test file is the specification; implement what it requires, nothing more.",
    "Verify with `bun test` and `bunx tsc --noEmit` only.",
  ].join("\n"),
};

// Reference implementations live in benchmark/references/ under short names
// rather than task names (json.ts, sexp.ts, lisp.ts today).
const TASK_REFERENCE_BASENAMES: Record<TaskName, string> = {
  "json-parser": "json",
  "sexp-parser": "sexp",
  minilisp: "lisp",
  "csv-parser": "csv",
};

const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_REPS = 3;
const DEFAULT_CONCURRENCY = 4;
const PILOT_REPS = 1;
const OPENCODE_PROVIDER = "honghong";
// The fixed opencode reference point: the oc side is measured once against
// the official DeepSeek endpoint, then tc-only reports compare their
// cache-excluded totals against this file instead of re-running oc.
const OC_BASELINE_RELATIVE_PATH = "benchmark/results/oc-baseline.json";
const OPENCODE_FALLBACK_BIN = "/home/illu/.opencode/bin/opencode";
// Parallel runs multiplex one gateway, so the caps get headroom beyond the
// serial pilot's slowest opencode run (821 s of the previous 900 s cap).
const OPENCODE_TIMEOUT_MS = 25 * 60_000;
const CHAT_TIMEOUT_MS = 10 * 60_000;
const JUDGE_TIMEOUT_MS = 240_000;
const PROBE_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 400;

const NULL_USAGE: TokenUsage = {
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  reasoning: null,
  total: null,
};

class InfraError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function failUsage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function printUsage(): void {
  process.stdout.write(`Usage: bun run benchmark/run.ts [options]

Options:
  --task <json-parser|sexp-parser|minilisp|csv-parser>  run a single task (default: all)
  --all                                      run all tasks (default)
  --reps <n>                                 repetitions per task and side (default: 3)
  --concurrency <n>                          max parallel runs (default: ${DEFAULT_CONCURRENCY})
  --pilot                                    force 1 rep per task and side and write
                                             benchmark/results/pilot-<date>.json
  --side tc                                  only tc is measured; oc is frozen at
                                             benchmark/results/oc-baseline.json
  --model <id>                               gateway model id (default: ${DEFAULT_MODEL})
  --oc-model <id>                            frozen oc model id (accepted for compatibility;
                                             the oc side cannot run)
  --keep                                     keep workspaces and logs under ./tmp/benchmark/
  --json <path>                              report output path (default: benchmark/results/)
  --replay-dir <path>                        write per-run tc-side replay bundles to <path>
  --token-budget <n>                         abort a tc-side run once accumulated provider
                                             tokens exceed n (default: 120000)
  --effort <none|low|high|max>               force this reasoning_effort on every tc-side
                                             model call (default: none)
  --multi-payload                            opt in to multi-payload exchanges (#69) on the
                                             tc side: a modify reply may batch path-independent
                                             edits in one {"payloads": [...]} object
                                             (default: off, one flat payload per exchange)
  --protocol-format edit-dsl                 edit protocol for the tc side (only edit-dsl;
                                             json is frozen at
                                             benchmark/results/json-format-baseline.json).
                                             compact is a deprecated alias for edit-dsl
  --help, -h                                 print this help and exit
`);
}

function parseReps(value: string): number {
  if (!/^\d+$/.test(value)) {
    failUsage(`invalid --reps value: ${value}`);
  }
  const reps = Number(value);
  if (!Number.isSafeInteger(reps) || reps < 1) {
    failUsage(`invalid --reps value: ${value}`);
  }
  return reps;
}

function parseConcurrency(value: string): number {
  if (!/^\d+$/.test(value)) {
    failUsage(`invalid --concurrency value: ${value}`);
  }
  const concurrency = Number(value);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    failUsage(`invalid --concurrency value: ${value}`);
  }
  return concurrency;
}

function parseTokenBudget(value: string): number {
  if (!/^\d+$/.test(value)) {
    failUsage(`invalid --token-budget value: ${value}`);
  }
  const budget = Number(value);
  if (!Number.isSafeInteger(budget) || budget < 1) {
    failUsage(`invalid --token-budget value: ${value}`);
  }
  return budget;
}

function parseEffort(value: string): ReasoningEffort {
  if (value === "none" || value === "low" || value === "high" || value === "max") {
    return value;
  }
  failUsage(`invalid --effort value: ${value}`);
}

// Canonical display/iteration order: `json` before `edit-dsl`, so
// `edit-dsl,json` and `json,edit-dsl` select the same matrix and report.
const PROTOCOL_ORDER: readonly ProtocolFormat[] = ["json", "edit-dsl"];

/**
 * Parse `--protocol-format`: one value or a comma-separated list (#16). Each
 * element accepts the deprecated `compact` alias, duplicates collapse, and the
 * result is canonicalized so input order never changes the matrix.
 */
export function parseProtocolFormats(value: string): ProtocolFormat[] {
  const selected = new Set<ProtocolFormat>();
  for (const raw of value.split(",")) {
    const element = raw.trim();
    if (element === "json" || element === "edit-dsl") {
      selected.add(element);
    } else if (element === "compact") {
      // `compact` is the deprecated input alias for `edit-dsl`; normalize it so
      // reports and recorded bundles only ever carry `edit-dsl`.
      selected.add("edit-dsl");
    } else {
      // Throw (rather than exit) so the parser stays unit-testable; `parseArgs`
      // turns it into the same usage error.
      throw new Error(`invalid --protocol-format value: ${element === "" ? raw : element}`);
    }
  }
  if (selected.size === 0) {
    throw new Error("missing value for --protocol-format");
  }
  return PROTOCOL_ORDER.filter((protocol) => selected.has(protocol));
}

function parseSide(value: string): SideSelection {
  if (value === "tc" || value === "oc" || value === "both") {
    return value;
  }
  failUsage(`invalid --side value: ${value}`);
}

/**
 * Frozen dimensions: the oc side and the legacy json protocol were measured
 * once and stored under benchmark/results/. Re-running either would move the
 * reference point, so the benchmark refuses both outright (see AGENTS.md).
 * Returned as a message rather than thrown so tests can cover it without the
 * process-exiting usage path.
 */
export function frozenDimensionError(
  side: SideSelection,
  protocolFormats: readonly ProtocolFormat[],
): string | null {
  if (side !== "tc") {
    return "the oc side is frozen (benchmark/results/oc-baseline.json); benchmark only runs --side tc";
  }
  if (protocolFormats.includes("json")) {
    return "the json protocol is frozen (benchmark/results/json-format-baseline.json); benchmark only runs --protocol-format edit-dsl";
  }
  return null;
}

function parseTask(value: string): TaskName {
  const match = TASKS.find((task) => task.name === value);
  if (match === undefined) {
    failUsage(`invalid --task value: ${value}`);
  }
  return match.name;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    task: null,
    all: false,
    reps: DEFAULT_REPS,
    concurrency: DEFAULT_CONCURRENCY,
    pilot: false,
    side: "tc",
    model: DEFAULT_MODEL,
    ocModel: null,
    keep: false,
    json: null,
    replayDir: null,
    tokenBudget: null,
    effort: null,
    multiPayload: false,
    protocolFormats: ["edit-dsl"],
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    switch (arg) {
      case "--all": {
        args.all = true;
        break;
      }
      case "--pilot": {
        args.pilot = true;
        break;
      }
      case "--keep": {
        args.keep = true;
        break;
      }
      case "--help":
      case "-h": {
        args.help = true;
        break;
      }
      case "--task": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --task");
        }
        args.task = parseTask(value);
        index += 1;
        break;
      }
      case "--reps": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --reps");
        }
        args.reps = parseReps(value);
        index += 1;
        break;
      }
      case "--concurrency": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --concurrency");
        }
        args.concurrency = parseConcurrency(value);
        index += 1;
        break;
      }
      case "--side": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --side");
        }
        args.side = parseSide(value);
        index += 1;
        break;
      }
      case "--model": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --model");
        }
        args.model = value;
        index += 1;
        break;
      }
      case "--oc-model": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --oc-model");
        }
        args.ocModel = value;
        index += 1;
        break;
      }
      case "--json": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --json");
        }
        args.json = value;
        index += 1;
        break;
      }
      case "--replay-dir": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --replay-dir");
        }
        args.replayDir = value;
        index += 1;
        break;
      }
      case "--token-budget": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --token-budget");
        }
        args.tokenBudget = parseTokenBudget(value);
        index += 1;
        break;
      }
      case "--effort": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --effort");
        }
        args.effort = parseEffort(value);
        index += 1;
        break;
      }
      case "--multi-payload": {
        args.multiPayload = true;
        break;
      }
      case "--protocol-format": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --protocol-format");
        }
        try {
          args.protocolFormats = parseProtocolFormats(value);
        } catch (error) {
          failUsage(errorMessage(error));
        }
        index += 1;
        break;
      }
      default: {
        failUsage(`unknown argument: ${arg}`);
      }
    }
  }
  if (args.task !== null && args.all) {
    failUsage("--task and --all are mutually exclusive");
  }
  if (args.model === "") {
    failUsage("--model must not be empty");
  }
  if (args.ocModel === "") {
    failUsage("--oc-model must not be empty");
  }
  // Frozen dimensions: the oc side and the legacy json protocol are measured
  // once and stored under benchmark/results/. Re-running either would move the
  // reference point, so the benchmark refuses both outright (see AGENTS.md).
  if (!args.help) {
    const frozen = frozenDimensionError(args.side, args.protocolFormats);
    if (frozen !== null) {
      failUsage(frozen);
    }
  }
  return args;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nestedNumber(record: Record<string, unknown>, parent: string, key: string): number | null {
  const child = record[parent];
  return isRecord(child) ? numberField(child, key) : null;
}

function tokenUsageFromOpenAi(raw: unknown): TokenUsage {
  if (!isRecord(raw)) {
    return NULL_USAGE;
  }
  return {
    input: numberField(raw, "prompt_tokens") ?? numberField(raw, "input_tokens"),
    output: numberField(raw, "completion_tokens") ?? numberField(raw, "output_tokens"),
    cacheRead:
      nestedNumber(raw, "prompt_tokens_details", "cached_tokens") ??
      numberField(raw, "cache_read_input_tokens"),
    cacheWrite:
      nestedNumber(raw, "prompt_tokens_details", "cache_creation_tokens") ??
      numberField(raw, "cache_creation_input_tokens"),
    reasoning:
      nestedNumber(raw, "completion_tokens_details", "reasoning_tokens") ??
      numberField(raw, "reasoning_tokens"),
    total: numberField(raw, "total_tokens"),
  };
}

function tokenUsageFromOpencode(raw: unknown): TokenUsage {
  if (!isRecord(raw)) {
    return NULL_USAGE;
  }
  const cache = raw["cache"];
  return {
    input: numberField(raw, "input"),
    output: numberField(raw, "output"),
    cacheRead: isRecord(cache) ? numberField(cache, "read") : null,
    cacheWrite: isRecord(cache) ? numberField(cache, "write") : null,
    reasoning: numberField(raw, "reasoning"),
    total: null,
  };
}

function sumTokenUsages(usages: readonly TokenUsage[]): TokenUsage {
  const sum = (pick: (usage: TokenUsage) => number | null): number | null => {
    let total: number | null = null;
    for (const usage of usages) {
      const value = pick(usage);
      if (value !== null) {
        total = (total ?? 0) + value;
      }
    }
    return total;
  };
  return {
    input: sum((usage) => usage.input),
    output: sum((usage) => usage.output),
    cacheRead: sum((usage) => usage.cacheRead),
    cacheWrite: sum((usage) => usage.cacheWrite),
    reasoning: sum((usage) => usage.reasoning),
    total: sum((usage) => usage.total),
  };
}

// total: prefer the side-reported total; otherwise sum the reported component
// counters (cache hits stay out: they are input subsets on the OpenAI side).
function withDerivedTotal(usage: TokenUsage): TokenUsage {
  if (usage.total !== null) {
    return usage;
  }
  const parts = [usage.input, usage.output, usage.reasoning].filter(
    (value): value is number => value !== null,
  );
  if (parts.length === 0) {
    return usage;
  }
  return { ...usage, total: parts.reduce((left, right) => left + right, 0) };
}

function usageReported(usage: TokenUsage): boolean {
  return (
    usage.input !== null ||
    usage.output !== null ||
    usage.cacheRead !== null ||
    usage.cacheWrite !== null ||
    usage.reasoning !== null ||
    usage.total !== null
  );
}

// Per-run USD cost from the recorded window and buckets (see
// src/benchmark-pricing.ts for the rate table and bucket normalization); null
// when the side reported no usage, mirroring a null `tokens.total`.
function costForOutcome(
  outcome: SideOutcome,
  side: Side,
): { cost: number | null; rateClass: RateClass | null } {
  if (!outcome.usageAvailable) {
    return { cost: null, rateClass: null };
  }
  const result = runCost(
    outcome.tokens,
    side,
    new Date(outcome.startedAt),
    new Date(outcome.finishedAt),
  );
  return { cost: result.cost, rateClass: result.rateClass };
}

function summarizeOutput(text: string, limit = OUTPUT_LIMIT): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function runCommand(
  command: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandOutcome> {
  let timedOut = false;
  try {
    const proc = Bun.spawn(command, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Bun.spawn({cwd}) does not update the inherited PWD; opencode derives
      // its session directory from PWD, so keep them consistent.
      env: { ...process.env, PWD: cwd },
    });
    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      setTimeout(() => proc.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return {
      ok: exitCode === 0 && !timedOut,
      exitCode,
      stdout: await stdout,
      stderr: await stderr,
      timedOut,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut,
      error: errorMessage(error),
    };
  }
}

// Bun types `fetch` with an extra `preconnect` method (see bun-types docs);
// OpenAIProvider never calls it, so a direct cast is the documented pattern
// for fetch wrappers (same as acceptance/run.ts).
function fetchWithTimeout(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(CHAT_TIMEOUT_MS) });
}

class RecordingProvider implements ProviderLike {
  readonly rawUsages: unknown[] = [];
  readonly #inner: OpenAIProvider;
  readonly #recorder: ReplayRecorder | null;

  constructor(inner: OpenAIProvider, recorder: ReplayRecorder | null = null) {
    this.#inner = inner;
    this.#recorder = recorder;
  }

  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: { temperature?: number },
  ): Promise<ChatResponse> {
    const response = await this.#inner.chat(messages, tools, options);
    this.rawUsages.push(usageFromRaw(response.raw));
    this.#recorder?.record(messages, response);
    return response;
  }
}

async function runTypescriptCoderSide(options: {
  workspace: string;
  issue: string;
  model: string;
  tscBin: string;
  task: TaskName;
  rep: number;
  fixture: string;
  replayPath: string | null;
  tokenBudget: number | null;
  effort: ReasoningEffort | null;
  /** Opt-in multi-payload exchanges (#69); forwarded to the loop. */
  multiPayload: boolean;
  /** Edit protocol (#119); forwarded to the loop. */
  protocolFormat: ProtocolFormat;
  /** Repo root receiving failure artifacts under `failures/` (#43). */
  failureRoot: string;
}): Promise<SideOutcome> {
  const recorder = options.replayPath === null ? null : new ReplayRecorder();
  const provider = new RecordingProvider(
    new OpenAIProvider(
      // Match the harness's own 10-minute chat deadline; the provider default
      // (120 s) would otherwise fire first and abort long generations.
      { ...readConfigFromEnv(options.model), timeoutMs: CHAT_TIMEOUT_MS },
      fetchWithTimeout as typeof fetch,
    ),
    recorder,
  );
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let error: string | null = null;
  let result: Awaited<ReturnType<typeof runLoop>> | null = null;
  try {
    result = await runLoop({
      cwd: options.workspace,
      issue: options.issue,
      provider,
      temperature: 0,
      checkCommand: ["bun", options.tscBin, "--noEmit"],
      testCommand: ["bun", "test"],
      tokenBudget: options.tokenBudget ?? undefined,
      effortOverride: options.effort ?? undefined,
      multiPayload: options.multiPayload,
      protocolFormat: options.protocolFormat,
    });
  } catch (caught) {
    error = errorMessage(caught);
  }
  const durationMs = Math.round(performance.now() - started);
  const finishedAt = new Date().toISOString();
  const usages = provider.rawUsages.map((raw) => tokenUsageFromOpenAi(raw));
  const tokens = withDerivedTotal(sumTokenUsages(usages));
  const usageAvailable = usages.some((usage) => usageReported(usage));

  const lines: string[] = [
    "side: tc",
    `model: ${options.model}`,
    `startedAt: ${startedAt}`,
    `finishedAt: ${finishedAt}`,
    `durationMs: ${durationMs}`,
    `issue:\n${options.issue}`,
    `result: ${result === null ? "error" : result.ok ? "ok" : "failed"}`,
    `error: ${error ?? "none"}`,
  ];
  if (result !== null) {
    lines.push(`mode: ${result.mode ?? "none"}`);
    lines.push(`filePath: ${result.filePath ?? "none"}`);
    lines.push(`terminationReason: ${result.terminationReason ?? "none"}`);
    lines.push(`records: ${result.records.length}`);
    for (const record of result.records) {
      lines.push(
        `  record ${record.row}: kind=${record.kind} iteration=${record.iteration} exchange=${
          record.exchange ?? "-"
        } outcome=${record.outcome} locator=${JSON.stringify(record.locator)} diagnostics=${
          record.diagnostics === null ? "none" : summarizeOutput(record.diagnostics)
        }`,
      );
    }
    const stats = exchangeStats(result.records);
    lines.push(
      `exchangeStats: turns=${stats.turns} applied=${stats.applied} rejected=${stats.rejected} selected=${stats.selected} stopped=${stats.stopped} payloads=${stats.payloads} toolCalls=${stats.toolCalls} range=${stats.range} matcher=${stats.matcher} wholeSymbol=${stats.wholeSymbol}`,
    );
    lines.push(`diagnostics: ${result.diagnostics ?? "none"}`);
    lines.push(`explanation: ${result.explanation ?? "none"}`);
  }
  lines.push(`usageAvailable: ${usageAvailable}`);
  lines.push(`rawUsage: ${JSON.stringify(provider.rawUsages, null, 2)}`);

  // Failure artifacts land in the repo (#43); the harness writes them, the
  // outer layer never runs git.
  let failureArtifact: string | null = null;
  if (result !== null) {
    failureArtifact = writeFailureArtifact({
      rootDir: options.failureRoot,
      result,
      context: `benchmark ${options.task} tc rep${options.rep}`,
    });
    if (failureArtifact !== null) {
      lines.push(`failureArtifact: ${relative(options.failureRoot, failureArtifact)}`);
    }
  }

  const recordSummaries =
    result === null
      ? null
      : result.records.map((record) => ({
          row: record.row,
          iteration: record.iteration,
          kind: record.kind,
          exchange: record.exchange,
          outcome: record.outcome,
          diagnosticsHead: record.diagnosticsHead,
          replacementChars: record.replacementChars,
          finishReason: record.finishReason,
          cause: record.cause ?? null,
          payloads: record.payloads ?? 0,
          toolCalls: record.toolCalls ?? 0,
          selectors: record.selectors ?? null,
          stages: record.stages ?? null,
          matcherKinds: record.matcherKinds ?? null,
        }));
  const recordsExchangeStats =
    result === null ? null : (exchangeStats(result.records) as RecordExchangeStats);

  if (recorder !== null && options.replayPath !== null) {
    const bundle = recorder.bundle({
      task: options.task,
      rep: options.rep,
      model: options.model,
      issue: options.issue,
      fixture: options.fixture,
      protocolFormat: options.protocolFormat,
    });
    writeFile(options.replayPath, `${JSON.stringify(bundle, null, 2)}\n`);
  }

  return {
    sideOk: result?.ok === true,
    error,
    infraError: null,
    steps: result?.records.length ?? null,
    durationMs,
    startedAt,
    finishedAt,
    tokens,
    usageAvailable,
    usageSource: usageAvailable ? "chat-completions" : "unavailable",
    rawUsage: provider.rawUsages,
    recordSummaries,
    exchangeStats: recordsExchangeStats,
    loopDiagnostics: result?.diagnostics ?? null,
    terminationReason: result?.terminationReason ?? null,
    logText: `${lines.join("\n")}\n`,
    sessionExportJson: null,
    statsJson: null,
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function runOpencodeSide(options: {
  bin: string;
  workspace: string;
  issue: string;
  model: string;
}): Promise<SideOutcome> {
  const sessionId = `ses_bench${randomUUID().replaceAll("-", "")}`;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const run = await runCommand(
    [
      options.bin,
      "run",
      "--auto",
      "--format",
      "json",
      "--session",
      sessionId,
      "--model",
      options.model,
      options.issue,
    ],
    options.workspace,
    OPENCODE_TIMEOUT_MS,
  );
  const durationMs = Math.round(performance.now() - started);
  const finishedAt = new Date().toISOString();

  let tokens: TokenUsage = NULL_USAGE;
  let usageAvailable = false;
  let usageSource = "unavailable";
  let rawUsage: unknown = null;
  let steps: number | null = null;
  let sessionExportJson: string | null = null;
  let statsJson: string | null = null;
  let infraError: string | null = null;

  const exported = await runCommand(
    [options.bin, "session", "export", sessionId],
    options.workspace,
    PROBE_TIMEOUT_MS,
  );
  const exportedJson = exported.ok ? tryParseJson(exported.stdout) : null;
  if (exportedJson !== null && isRecord(exportedJson)) {
    sessionExportJson = exported.stdout;
    const info = exportedJson["info"];
    const infoTokens = isRecord(info) ? info["tokens"] : null;
    if (isRecord(infoTokens)) {
      tokens = withDerivedTotal(tokenUsageFromOpencode(infoTokens));
      usageAvailable = true;
      usageSource = "session-export";
      rawUsage = {
        tokens: infoTokens,
        cost: isRecord(info) ? info["cost"] : null,
        projectID: isRecord(info) ? info["projectID"] : null,
      };
      const messages = exportedJson["messages"];
      if (Array.isArray(messages)) {
        steps = messages.filter(
          (message) => isRecord(message) && message["type"] === "assistant",
        ).length;
      }
    }
  }

  if (!usageAvailable) {
    const stats = await runCommand(
      [options.bin, "stats", "--json", "--days", "0", "--project", options.workspace],
      options.workspace,
      PROBE_TIMEOUT_MS,
    );
    const statsJsonValue = stats.ok ? tryParseJson(stats.stdout) : null;
    if (isRecord(statsJsonValue)) {
      statsJson = stats.stdout;
      const statsTokens = statsJsonValue["tokens"];
      if (isRecord(statsTokens)) {
        tokens = withDerivedTotal(tokenUsageFromOpencode(statsTokens));
        usageAvailable = true;
        usageSource = "stats-project";
        rawUsage = {
          tokens: statsTokens,
          sessions: statsJsonValue["sessions"],
          range: statsJsonValue["range"],
        };
      }
    }
  }

  if (!usageAvailable) {
    infraError = `cannot read usage for opencode session ${sessionId} (session export and stats both failed)`;
  }

  let error: string | null = run.error;
  if (run.timedOut) {
    error = `opencode run timed out after ${OPENCODE_TIMEOUT_MS}ms`;
  } else if (error === null && !run.ok) {
    error = `opencode run exited with code ${run.exitCode ?? "unknown"}`;
  }

  const lines: string[] = [
    "side: oc",
    `command: ${options.bin} run --auto --format json --session ${sessionId} --model ${options.model} <issue>`,
    `model: ${options.model}`,
    `sessionId: ${sessionId}`,
    `startedAt: ${startedAt}`,
    `finishedAt: ${finishedAt}`,
    `durationMs: ${durationMs}`,
    `exitCode: ${run.exitCode ?? "unknown"}`,
    `timedOut: ${run.timedOut}`,
    `error: ${error ?? "none"}`,
    `issue:\n${options.issue}`,
    "stdout:",
    run.stdout,
    "stderr:",
    run.stderr,
    `usageAvailable: ${usageAvailable}`,
    `usageSource: ${usageSource}`,
    `rawUsage: ${JSON.stringify(rawUsage, null, 2)}`,
  ];

  return {
    sideOk: run.ok,
    error,
    infraError,
    steps,
    durationMs,
    startedAt,
    finishedAt,
    tokens,
    usageAvailable,
    usageSource,
    rawUsage,
    recordSummaries: null,
    exchangeStats: null,
    loopDiagnostics: null,
    terminationReason: null,
    logText: `${lines.join("\n")}\n`,
    sessionExportJson,
    statsJson,
  };
}

function fixtureTrackedFiles(fixtureDir: string): string[] {
  const files = ["tsconfig.json"];
  const sourceDir = join(fixtureDir, "src");
  if (existsSync(sourceDir)) {
    for (const entry of readdirSync(sourceDir)) {
      if (entry.endsWith(".test.ts")) {
        files.push(`src/${entry}`);
      }
    }
  }
  return files.sort();
}

export async function judgeWorkspace(
  workspace: string,
  fixtureDir: string,
  tscBin: string,
): Promise<JudgeResult> {
  const fixtureFiles = fixtureTrackedFiles(fixtureDir);
  const details: string[] = [];
  const lines: string[] = [`workspace: ${workspace}`, `fixture: ${fixtureDir}`];

  let fixtureOk = true;
  for (const relativePath of fixtureFiles) {
    const candidate = join(workspace, relativePath);
    const stats = statSync(candidate, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isFile()) {
      fixtureOk = false;
      details.push(`${relativePath}: missing`);
      lines.push(`${relativePath}: MISSING`);
      continue;
    }
    const identical = readFileSync(join(fixtureDir, relativePath)).equals(readFileSync(candidate));
    if (identical) {
      lines.push(`${relativePath}: identical`);
    } else {
      fixtureOk = false;
      details.push(`${relativePath}: modified`);
      lines.push(`${relativePath}: MODIFIED`);
    }
  }

  const typecheck = await runCommand(["bun", tscBin, "--noEmit"], workspace, JUDGE_TIMEOUT_MS);
  const tscOk = typecheck.ok;
  lines.push(`tsc exit=${typecheck.exitCode ?? "unknown"} timedOut=${typecheck.timedOut}`);
  lines.push(typecheck.stdout + typecheck.stderr);

  const tests = await runCommand(["bun", "test"], workspace, JUDGE_TIMEOUT_MS);
  const testsOk = tests.ok;
  lines.push(`bun test exit=${tests.exitCode ?? "unknown"} timedOut=${tests.timedOut}`);
  lines.push(tests.stdout + tests.stderr);

  const ok = fixtureOk && tscOk && testsOk;
  let detail: string | null = null;
  if (!ok) {
    const parts = [...details];
    if (!tscOk) {
      parts.push(`tsc failed: ${summarizeOutput(typecheck.stdout + typecheck.stderr)}`);
    }
    if (!testsOk) {
      parts.push(`bun test failed: ${summarizeOutput(tests.stdout + tests.stderr)}`);
    }
    detail = parts.length > 0 ? parts.join("; ") : "judge failed";
  }
  return { ok, testsOk, tscOk, fixtureOk, detail, log: `${lines.join("\n")}\n` };
}

function resolveOpencodeBin(): string {
  const override = process.env["OPENCODE_BIN"];
  if (override !== undefined && override !== "") {
    return override;
  }
  const fromPath = Bun.which("opencode");
  if (fromPath !== null) {
    return fromPath;
  }
  if (statSync(OPENCODE_FALLBACK_BIN, { throwIfNoEntry: false })?.isFile() === true) {
    return OPENCODE_FALLBACK_BIN;
  }
  throw new InfraError("opencode binary not found: set OPENCODE_BIN or put opencode on PATH");
}

async function probeOpencodeCli(repoRoot: string): Promise<OpencodeContext> {
  const bin = resolveOpencodeBin();
  const version = await runCommand([bin, "--version"], repoRoot, PROBE_TIMEOUT_MS);
  if (!version.ok) {
    const detail = version.error ?? summarizeOutput(version.stdout + version.stderr);
    throw new InfraError(`cannot run opencode --version: ${detail}`);
  }
  const runHelp = await runCommand([bin, "run", "--help"], repoRoot, PROBE_TIMEOUT_MS);
  if (!runHelp.ok || !runHelp.stdout.includes("--model")) {
    throw new InfraError("opencode run --help did not advertise --model");
  }
  const exportHelp = await runCommand(
    [bin, "session", "export", "--help"],
    repoRoot,
    PROBE_TIMEOUT_MS,
  );
  if (!exportHelp.ok) {
    throw new InfraError("opencode session export --help failed");
  }
  const statsHelp = await runCommand([bin, "stats", "--help"], repoRoot, PROBE_TIMEOUT_MS);
  if (!statsHelp.ok || !statsHelp.stdout.includes("--json")) {
    throw new InfraError("opencode stats --help did not advertise --json");
  }
  return { bin, version: version.stdout.trim().split("\n")[0] ?? "" };
}

function opencodeModelId(model: string): string {
  return model.includes("/") ? model : `${OPENCODE_PROVIDER}/${model}`;
}

/** Model id for the oc side: `--oc-model` overrides `--model` when present. */
export function opencodeModelFor(model: string, ocModel: string | null): string {
  return opencodeModelId(ocModel ?? model);
}

// Give every workspace its own git repo so an agent cannot reach the enclosing
// typescript-coder repository (and benchmark/references/) through git.
function initWorkspaceGit(workspace: string): void {
  const env = { ...process.env, PWD: workspace };
  const commands = [
    ["git", "init", "--quiet"],
    ["git", "config", "user.email", "benchmark@localhost"],
    ["git", "config", "user.name", "benchmark"],
  ];
  for (const command of commands) {
    const result = Bun.spawnSync(command, {
      cwd: workspace,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new InfraError(
        `workspace git setup failed (${command.join(" ")}): ${result.stderr.toString().slice(0, 200)}`,
      );
    }
  }
}

async function runOnce(job: BenchmarkJob, context: RunContext): Promise<RunRecord> {
  const { task, side, rep, protocol } = job;
  const fixtureDir = join(context.repoRoot, "benchmark", "fixtures", task);
  // Keep today's `task-side-repN` names for single-protocol runs; only a
  // multi-variant matrix needs the protocol in the name to stay unique (#16).
  const protocolSuffix = protocol !== null && context.protocols.length > 1 ? `-${protocol}` : "";
  const runName = `${task}-${side}${protocolSuffix}-rep${rep}`;
  const workspace = join(context.runRoot, runName);
  const logsDir = join(context.runRoot, "logs", runName);
  mkdirSync(logsDir, { recursive: true });
  cpSync(fixtureDir, workspace, { recursive: true });
  initWorkspaceGit(workspace);

  const issue = TASK_ISSUES[task];
  const replayPath =
    side === "tc" && context.replayDir !== null ? join(context.replayDir, `${runName}.json`) : null;
  let outcome: SideOutcome;
  if (side === "tc") {
    if (protocol === null) {
      throw new InfraError("tc job is missing its edit protocol");
    }
    outcome = await runTypescriptCoderSide({
      workspace,
      issue,
      model: context.model,
      tscBin: context.tscBin,
      task,
      rep,
      fixture: ["benchmark", "fixtures", task].join("/"),
      replayPath,
      tokenBudget: context.tokenBudget,
      effort: context.effort,
      multiPayload: context.multiPayload,
      protocolFormat: protocol,
      failureRoot: context.repoRoot,
    });
  } else {
    if (context.opencode === null) {
      throw new InfraError("oc side requested but the CLI was not probed");
    }
    outcome = await runOpencodeSide({
      bin: context.opencode.bin,
      workspace,
      issue,
      model: context.opencodeModel,
    });
  }

  const judge = await judgeWorkspace(workspace, fixtureDir, context.tscBin);
  const sideLogPath = join(logsDir, "side.log");
  const judgeLogPath = join(logsDir, "judge.log");
  const sessionPath = outcome.sessionExportJson === null ? null : join(logsDir, "session.json");
  const statsPath = outcome.statsJson === null ? null : join(logsDir, "stats.json");
  writeFile(sideLogPath, outcome.logText);
  writeFile(judgeLogPath, judge.log);
  if (sessionPath !== null && outcome.sessionExportJson !== null) {
    writeFile(sessionPath, outcome.sessionExportJson);
  }
  if (statsPath !== null && outcome.statsJson !== null) {
    writeFile(statsPath, outcome.statsJson);
  }

  const asRelative = (path: string): string => relative(context.repoRoot, path);
  const { cost, rateClass } = costForOutcome(outcome, side);
  return {
    task,
    side,
    protocol,
    rep,
    // A termination-matrix ending is a run failure even when the judge passes
    // on the state left on disk (#43); judge fields stay as recorded.
    ok: outcome.terminationReason === null && judge.ok,
    sideOk: outcome.sideOk,
    tokens: { ...outcome.tokens, billable: billableTokens(outcome.tokens, side) },
    usageAvailable: outcome.usageAvailable,
    usageSource: outcome.usageSource,
    rawUsage: outcome.rawUsage,
    durationMs: outcome.durationMs,
    startedAt: outcome.startedAt,
    finishedAt: outcome.finishedAt,
    cost,
    rateClass,
    steps: outcome.steps,
    records: outcome.recordSummaries,
    exchangeStats: outcome.exchangeStats,
    loopDiagnostics: outcome.loopDiagnostics,
    terminationReason: outcome.terminationReason,
    model: side === "tc" ? context.model : context.opencodeModel,
    workspace: asRelative(workspace),
    logs: {
      side: asRelative(sideLogPath),
      judge: asRelative(judgeLogPath),
      session: sessionPath === null ? null : asRelative(sessionPath),
      stats: statsPath === null ? null : asRelative(statsPath),
    },
    versions: { bun: Bun.version, opencode: context.opencode?.version ?? null },
    judge: {
      testsOk: judge.testsOk,
      tscOk: judge.tscOk,
      fixtureOk: judge.fixtureOk,
      detail: judge.detail,
    },
    error: outcome.error,
    infraError: outcome.infraError,
  };
}

function printRecord(record: RunRecord, showProtocol: boolean): void {
  const seconds = (record.durationMs / 1000).toFixed(1);
  const label = record.ok ? "PASS" : "FAIL";
  const variant = showProtocol && record.protocol !== null ? ` ${record.protocol}` : "";
  process.stdout.write(
    `${label} ${record.task} ${record.side}${variant} rep${record.rep} (${seconds}s, tokens=${
      record.tokens.total ?? "unavailable"
    }, cost=${formatUsd(record.cost)}, steps=${record.steps ?? "n/a"})\n`,
  );
  if (!record.ok) {
    if (record.judge !== null && record.judge.detail !== null) {
      process.stdout.write(`  - judge: ${record.judge.detail}\n`);
    }
    if (record.error !== null) {
      process.stdout.write(`  - error: ${record.error}\n`);
    } else if (record.loopDiagnostics !== null) {
      process.stdout.write(`  - loop: ${summarizeOutput(record.loopDiagnostics, 200)}\n`);
    }
  }
}

function writeReport(path: string, report: Report): void {
  writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

// Aggregates are computed from the final `runs` array (matrix order) so reruns
// never leak in: only final records are listed. Token means/totals are the
// cache-excluded triple (#89): `in` = cache-miss input, `out` = output
// (reasoning included), `total = in + out`, normalized per side through
// `src/benchmark-pricing.ts`. Stats cover runs whose `tokens.total` is non-null.
// `tokensPerSuccess` and `costPerSuccess` divide those sums by the number of
// passing runs (judge-passing and not aborted at the token budget; null when
// there were no successes). `cost` (USD, decision-only) stats cover runs that
// carry a USD cost.
export function aggregateRuns(
  runs: readonly RunRecord[],
  task: TaskName | null,
  side: Side | null,
  /** Omitted = no protocol filter (legacy callers); null = runs without one (oc). */
  protocol: ProtocolFormat | null | undefined = undefined,
): AggregateRow {
  const selected = runs.filter(
    (run) =>
      (task === null || run.task === task) &&
      (side === null || run.side === side) &&
      (protocol === undefined || (run.protocol ?? null) === protocol),
  );
  const usageRuns = selected.filter((run) => run.tokens.total !== null);
  const ok = selected.filter((run) => run.ok).length;
  const tokenStats = (pick: (triple: BillableTokens) => number): TokenStats => {
    const values = usageRuns.map((run) => pick(billableTokens(run.tokens, run.side)));
    if (values.length === 0) {
      return { mean: null, total: null };
    }
    const total = values.reduce((left, right) => left + right, 0);
    return { mean: total / values.length, total };
  };
  const steps = selected.map((run) => run.steps).filter((value): value is number => value !== null);
  const tokens = {
    in: tokenStats((triple) => triple.in),
    out: tokenStats((triple) => triple.out),
    total: tokenStats((triple) => triple.total),
  };
  const costValues = selected
    .map((run) => run.cost)
    .filter((value): value is number => value !== null);
  const costTotal = costValues.reduce((left, right) => left + right, 0);
  const cost: TokenStats =
    costValues.length === 0
      ? { mean: null, total: null }
      : { mean: costTotal / costValues.length, total: costTotal };
  const perSuccess = (stats: TokenStats): number | null =>
    ok === 0 || stats.total === null ? null : stats.total / ok;
  // Selector adoption: sum the per-run exchange counts (#101); runs without
  // records contribute zero, so an aggregate row with no recorded selector
  // adoption reports all-zero counts rather than null.
  const selectors = selected.reduce(
    (sum, run) => ({
      range: sum.range + (run.exchangeStats?.range ?? 0),
      matcher: sum.matcher + (run.exchangeStats?.matcher ?? 0),
      wholeSymbol: sum.wholeSymbol + (run.exchangeStats?.wholeSymbol ?? 0),
    }),
    { range: 0, matcher: 0, wholeSymbol: 0 },
  );
  // Resolved cascade-stage and matcher-kind adoption (#110), summed the same way
  // so the aggregate row is the A/B total #111 needs.
  const stages = selected.reduce(
    (sum, run) => ({
      wholeSymbol: sum.wholeSymbol + (run.exchangeStats?.stageWholeSymbol ?? 0),
      match: sum.match + (run.exchangeStats?.stageMatch ?? 0),
      pick: sum.pick + (run.exchangeStats?.stagePick ?? 0),
    }),
    { wholeSymbol: 0, match: 0, pick: 0 },
  );
  const matcherKinds = selected.reduce(
    (sum, run) => ({
      snippet: sum.snippet + (run.exchangeStats?.snippet ?? 0),
      regex: sum.regex + (run.exchangeStats?.regex ?? 0),
    }),
    { snippet: 0, regex: 0 },
  );
  // Edit-dsl implicit-create clauses (#111), summed over the selected runs.
  const creates = selected.reduce((sum, run) => sum + (run.exchangeStats?.creates ?? 0), 0);
  return {
    task,
    side,
    protocol:
      protocol === undefined ? (side === "oc" ? null : (selected[0]?.protocol ?? null)) : protocol,
    runs: selected.length,
    ok,
    failed: selected.length - ok,
    successRate: selected.length === 0 ? 0 : ok / selected.length,
    usageRuns: usageRuns.length,
    tokens,
    cost,
    durationMsMean:
      selected.length === 0
        ? null
        : selected.reduce((left, run) => left + run.durationMs, 0) / selected.length,
    stepsMean:
      steps.length === 0 ? null : steps.reduce((left, right) => left + right, 0) / steps.length,
    tokensPerSuccess: {
      in: perSuccess(tokens.in),
      out: perSuccess(tokens.out),
      total: perSuccess(tokens.total),
    },
    costPerSuccess: perSuccess(cost),
    selectors,
    stages,
    matcherKinds,
    creates,
  };
}

// Protocols present among tc runs; a legacy run without the field reads as
// null so old callers still get exactly one tc row set.
function protocolsFromRuns(runs: readonly RunRecord[]): (ProtocolFormat | null)[] {
  const protocols = new Set<ProtocolFormat | null>();
  for (const run of runs) {
    if (run.side === "tc") {
      protocols.add(run.protocol ?? null);
    }
  }
  return protocols.size === 0 ? [null] : [...protocols];
}

function aggregatesForSide(
  runs: readonly RunRecord[],
  task: TaskName | null,
  side: Side,
  protocols: readonly (ProtocolFormat | null)[],
): AggregateRow[] {
  // `oc` has no protocol dimension: exactly one row however many tc variants
  // were selected (#16).
  if (side === "oc") {
    return [aggregateRuns(runs, task, side, null)];
  }
  return protocols.map((protocol) => aggregateRuns(runs, task, side, protocol));
}

/**
 * Group runs by task, side, and (for tc) edit protocol (#16). Two tc variants
 * never share a row, and `overall` is a row list rather than one pooled tc row.
 * Callers that omit `protocols` get the variants observed among the tc runs, so
 * legacy single-protocol inputs keep one tc row set.
 */
export function computeAggregates(
  runs: readonly RunRecord[],
  tasks: readonly TaskName[],
  sides: readonly Side[],
  protocols: readonly (ProtocolFormat | null)[] = protocolsFromRuns(runs),
): Aggregates {
  const byTaskSide: AggregateRow[] = [];
  for (const task of tasks) {
    for (const side of sides) {
      byTaskSide.push(...aggregatesForSide(runs, task, side, protocols));
    }
  }
  const bySide = sides.flatMap((side) => aggregatesForSide(runs, null, side, protocols));
  return {
    byTaskSide,
    bySide,
    overall: bySide,
  };
}

function markdownPathFor(jsonPath: string): string {
  return jsonPath.endsWith(".json") ? `${jsonPath.slice(0, -".json".length)}.md` : `${jsonPath}.md`;
}

function formatTokenCount(value: number | null): string {
  return value === null ? "n/a" : Math.round(value).toLocaleString("en-US");
}

// USD values print with five decimals (#63); `n/a` when nothing was recorded.
function formatUsd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(5)}`;
}

function formatSeconds(durationMs: number | null): string {
  return durationMs === null ? "n/a" : (durationMs / 1000).toFixed(1);
}

function formatSteps(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatOneLine(text: string, limit = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

// A tc row is named by side and protocol when the report has several variants;
// a single-protocol report keeps the historical bare side label.
function hasMultipleProtocols(rows: readonly AggregateRow[]): boolean {
  const protocols = new Set<ProtocolFormat>();
  for (const row of rows) {
    if (row.side === "tc" && row.protocol !== null) {
      protocols.add(row.protocol);
    }
  }
  return protocols.size > 1;
}

function sideLabel(row: AggregateRow, showProtocol: boolean): string {
  const side = row.side ?? "all";
  return showProtocol && row.protocol !== null ? `${side} ${row.protocol}` : side;
}

// The multiplier sentence names the variant first (`json tc 1.38x oc`) so a
// tc protocol is never mistaken for the side itself.
function multiplierSideLabel(row: AggregateRow, showProtocol: boolean): string {
  const side = row.side ?? "all";
  return showProtocol && row.protocol !== null ? `${row.protocol} ${side}` : side;
}

function successSummary(row: AggregateRow, showProtocol: boolean): string {
  return `${sideLabel(row, showProtocol)} ${row.ok}/${row.runs} (${formatPercent(
    row.successRate,
  )})`;
}

function successRateSentence(rows: readonly AggregateRow[]): string {
  const first = rows[0];
  if (first === undefined) {
    return "No side ran; success rates are not comparable.";
  }
  const showProtocol = hasMultipleProtocols(rows);
  if (rows.length === 1) {
    return `Only one side ran: ${successSummary(first, showProtocol)}.`;
  }
  const summaries = rows.map((row) => successSummary(row, showProtocol)).join(" vs ");
  const equal = rows.every((row) => row.successRate === first.successRate);
  return equal ? `Success rates are equal: ${summaries}.` : `Success rates differ: ${summaries}.`;
}

// `higher X.XXx lower` for a two-side pair, or null when the pair cannot be
// compared (a missing total or a zero lower side).
function multiplierLabel(rows: readonly AggregateRow[], showProtocol: boolean): string | null {
  const [first, second] = rows;
  if (first === undefined || second === undefined) {
    return null;
  }
  const firstTotal = first.tokens.total.total;
  const secondTotal = second.tokens.total.total;
  if (firstTotal === null || secondTotal === null) {
    return null;
  }
  const higher = firstTotal >= secondTotal ? first : second;
  const lower = firstTotal >= secondTotal ? second : first;
  const high = Math.max(firstTotal, secondTotal);
  const low = Math.min(firstTotal, secondTotal);
  if (low <= 0) {
    return null;
  }
  return `${multiplierSideLabel(higher, showProtocol)} ${(high / low).toFixed(2)}x ${multiplierSideLabel(
    lower,
    showProtocol,
  )}`;
}

// One comparison per tc row against the oc row (#16): with two tc variants the
// first two rows must never be paired with each other.
function multiplierLabels(rows: readonly AggregateRow[], showProtocol: boolean): string[] {
  const oc = rows.find((row) => row.side === "oc");
  if (oc === undefined) {
    return [];
  }
  const labels: string[] = [];
  for (const row of rows) {
    if (row.side !== "tc") {
      continue;
    }
    const label = multiplierLabel([row, oc], showProtocol);
    if (label !== null) {
      labels.push(label);
    }
  }
  return labels;
}

/**
 * Token multiplier summary (#89): the cache-excluded total of the higher side
 * over the lower side, overall and per task. Says so plainly when both sides
 * did not run (no comparable pair).
 */
export function tokenMultiplierSentence(
  bySide: readonly AggregateRow[],
  byTaskSide: readonly AggregateRow[],
): string {
  const showProtocol = hasMultipleProtocols([...bySide, ...byTaskSide]);
  const overallLabels = multiplierLabels(
    bySide.filter((row) => row.side !== null),
    showProtocol,
  );
  const taskParts: string[] = [];
  const taskNames = [
    ...new Set(byTaskSide.map((row) => row.task).filter((task): task is TaskName => task !== null)),
  ];
  for (const task of taskNames) {
    for (const label of multiplierLabels(
      byTaskSide.filter((row) => row.task === task && row.side !== null),
      showProtocol,
    )) {
      taskParts.push(`${task} ${label}`);
    }
  }
  if (overallLabels.length === 0 && taskParts.length === 0) {
    return "Token multiplier (cache-excluded): not comparable (both sides must run).";
  }
  const parts = overallLabels.map((label) => `${label} overall`);
  parts.push(...taskParts);
  return `Token multiplier (cache-excluded total, higher/lower): ${parts.join("; ")}.`;
}

export interface BaselineSavingsRow {
  readonly task: TaskName;
  readonly protocol: ProtocolFormat | null;
  readonly baselineMean: number;
  readonly currentMean: number;
  /** Baseline mean over the current mean: how many times fewer tokens tc uses. */
  readonly factor: number;
}

interface BaselineOverall {
  readonly protocol: ProtocolFormat | null;
  readonly baselineSum: number;
  readonly currentSum: number;
  readonly factor: number;
  readonly tasks: number;
}

export interface BaselineSavings {
  readonly rows: BaselineSavingsRow[];
  readonly overall: BaselineOverall[];
}

/**
 * Savings against the fixed oc baseline: per task and overall, `factor` is the
 * oc baseline's mean cache-excluded total divided by the current tc mean, so
 * `2.5` reads as "tc uses 2.5x fewer tokens". Tasks absent from either side are
 * skipped instead of treated as zero, and a zero current mean never divides.
 */
export function savingsVsOcBaseline(
  currentByTaskSide: readonly AggregateRow[],
  baselineByTaskSide: readonly AggregateRow[],
): BaselineSavings {
  const baseline = new Map<TaskName, number>();
  for (const row of baselineByTaskSide) {
    const mean = row.tokens.total.mean;
    if (row.side === "oc" && row.task !== null && mean !== null && mean > 0) {
      baseline.set(row.task, mean);
    }
  }
  const rows: BaselineSavingsRow[] = [];
  for (const row of currentByTaskSide) {
    if (row.side !== "tc" || row.task === null) {
      continue;
    }
    const baselineMean = baseline.get(row.task);
    const currentMean = row.tokens.total.mean;
    if (baselineMean === undefined || currentMean === null || currentMean <= 0) {
      continue;
    }
    rows.push({
      task: row.task,
      protocol: row.protocol,
      baselineMean,
      currentMean,
      factor: baselineMean / currentMean,
    });
  }
  const byProtocol = new Map<
    ProtocolFormat | null,
    { baselineSum: number; currentSum: number; tasks: number }
  >();
  for (const row of rows) {
    const accrued = byProtocol.get(row.protocol) ?? { baselineSum: 0, currentSum: 0, tasks: 0 };
    accrued.baselineSum += row.baselineMean;
    accrued.currentSum += row.currentMean;
    accrued.tasks += 1;
    byProtocol.set(row.protocol, accrued);
  }
  const overall: BaselineOverall[] = [...byProtocol.entries()].map(([protocol, value]) => ({
    protocol,
    baselineSum: value.baselineSum,
    currentSum: value.currentSum,
    factor: value.baselineSum / value.currentSum,
    tasks: value.tasks,
  }));
  return { rows, overall };
}

export function ocBaselineSavingsSentence(savings: BaselineSavings): string {
  if (savings.overall.length === 0) {
    return "Savings vs oc baseline: not comparable (no shared task reports a token total).";
  }
  const parts = savings.overall.map((entry) => {
    const label = entry.protocol === null ? "" : `${entry.protocol} `;
    return `${label}${entry.factor.toFixed(2)}x fewer tokens across ${entry.tasks} task${
      entry.tasks === 1 ? "" : "s"
    }`;
  });
  return `Savings vs oc baseline (cache-excluded total, oc/tc): ${parts.join("; ")}.`;
}

interface OcBaseline {
  readonly path: string;
  readonly date: string | null;
  readonly model: string | null;
  readonly reps: number | null;
  readonly byTaskSide: AggregateRow[];
}
/** Read the fixed oc baseline report, or null when it is missing/unreadable. */
function loadOcBaseline(repoRoot: string): OcBaseline | null {
  const path = join(repoRoot, OC_BASELINE_RELATIVE_PATH);
  if (!existsSync(path)) {
    return null;
  }
  const parsed = tryParseJson(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    return null;
  }
  const aggregates = parsed["aggregates"];
  if (!isRecord(aggregates)) {
    return null;
  }
  const rows = aggregates["byTaskSide"];
  if (!Array.isArray(rows)) {
    return null;
  }
  const date = parsed["date"];
  const model = parsed["model"];
  const ocModel = parsed["ocModel"];
  const reps = parsed["reps"];
  const label = typeof ocModel === "string" ? ocModel : model;
  return {
    path: OC_BASELINE_RELATIVE_PATH,
    date: typeof date === "string" ? date : null,
    model: typeof label === "string" ? label : null,
    reps: typeof reps === "number" ? reps : null,
    byTaskSide: rows as AggregateRow[],
  };
}

// The references tree names one file per task (json/sexp/lisp today); probe the
// variants so the report prints a path that actually exists in the checkout.
function resolveReferencePath(repoRoot: string, task: TaskName): string {
  const base = TASK_REFERENCE_BASENAMES[task];
  const candidates = [
    `benchmark/references/${task}`,
    `benchmark/references/${task}-solution`,
    `benchmark/references/${base}`,
    `benchmark/references/${base}.ts`,
    `benchmark/references/${base}-solution`,
  ];
  for (const candidate of candidates) {
    if (existsSync(join(repoRoot, candidate))) {
      return candidate;
    }
  }
  return candidates[0] ?? "benchmark/references";
}

export function writeMarkdownReport(mdPath: string, report: Report): void {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const { aggregates } = report;
  const protocolFormats =
    report.protocolFormats ?? (report.protocolFormat == null ? [] : [report.protocolFormat]);
  const protocolLine =
    protocolFormats.length > 1
      ? `- protocol-formats: ${protocolFormats.join(", ")} (#119)`
      : `- protocol-format: ${protocolFormats[0] ?? report.protocolFormat ?? "json"} (#119)`;
  const lines: string[] = [];
  lines.push(`# Benchmark report — ${report.date}`, "");
  lines.push(
    `- mode: ${report.mode}`,
    `- model: ${report.model}`,
    ...(report.ocModel === null || report.ocModel === undefined
      ? []
      : [`- oc model: ${report.ocModel}`]),
    `- effort: ${report.effort ?? "none (default)"}`,
    `- multi-payload: ${report.multiPayload ? "on (#69)" : "off (default)"}`,
    protocolLine,
    `- concurrency: ${report.concurrency}`,
    `- tasks: ${report.tasks.join(", ")}`,
    `- sides: ${report.sides.join(", ")}`,
    `- reps: ${report.reps}`,
    `- bun: ${report.bunVersion}`,
    `- opencode: ${report.opencodeVersion ?? "n/a"}`,
    `- generated: ${report.generatedAt}`,
    `- pilot reference: ${report.pilotReference ?? "none"}`,
    "",
  );

  lines.push("## Frozen task specs", "");
  for (const task of report.tasks) {
    lines.push(`### ${task}`, "");
    lines.push(
      "Issue (verbatim, identical for both sides):",
      "",
      "```",
      TASK_ISSUES[task],
      "```",
      "",
    );
    lines.push(
      `- fixture: benchmark/fixtures/${task}/`,
      `- reference: ${resolveReferencePath(repoRoot, task)}`,
      "",
    );
  }

  lines.push("## Token and cost accounting", "");
  lines.push(
    "Like-for-like tokens (#89): the comparison total is cache-excluded — total =",
    "cache-miss input (`in`) + output, with reasoning counted as output — normalized for",
    "both sides by the single bucket normalization in `src/benchmark-pricing.ts`.",
    "Cache-hit input stays in each run's raw buckets but is excluded from the total, so",
    "the two sides compare on the same basis.",
    "",
    "tc: OpenAI-compatible `usage` from the provider, summed over every chat request",
    "(input/prompt, output/completion, total; cache and reasoning counters are kept per",
    "record).",
    "",
    "oc: usage read from `opencode session export` (`info.tokens`), falling back to",
    "`opencode stats --json`; input/output come from the reported session usage and total",
    "is derived from input + output + reasoning when the export reports none; the export's",
    "own `cost` stays verbatim in `rawUsage`.",
    "",
    "Cost: USD per run, computed from the recorded buckets and the run's",
    "`startedAt`/`finishedAt` window with the official DeepSeek V4.1-Flash peak/off-peak",
    "prices (see `src/benchmark-pricing.ts`). Buckets: tc `input` includes cache hits",
    "(miss = input - cacheRead); oc `input` excludes them (miss = input, hit = cacheRead);",
    "output is priced together with reasoning; `cacheWrite` is priced at the cache-miss",
    "rate. A run that crosses a peak/off-peak boundary splits by elapsed-time share",
    "(uniform-spend approximation). USD columns are decision-only: cost is recorded in the",
    "result JSON and `consumption.md` for decisions, but the headline comparison metric is",
    "the cache-excluded token total above.",
    "",
  );

  lines.push("## Per-task results", "");
  lines.push(
    "| Task | Side | Protocol | Success | Mean in (no cache) | Mean out | Mean total | Mean $ | $/success | Mean dur (s) | Mean steps |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const row of aggregates.byTaskSide) {
    lines.push(
      `| ${row.task ?? "all"} | ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.ok}/${row.runs} | ${formatTokenCount(
        row.tokens.in.mean,
      )} | ${formatTokenCount(row.tokens.out.mean)} | ${formatTokenCount(
        row.tokens.total.mean,
      )} | ${formatUsd(row.cost?.mean ?? null)} | ${formatUsd(row.costPerSuccess)} | ${formatSeconds(
        row.durationMsMean,
      )} | ${formatSteps(row.stepsMean)} |`,
    );
  }
  lines.push("");

  lines.push("## Overall comparison", "");
  lines.push(
    "| Side | Protocol | Success | Mean in (no cache) | Mean out | Mean total | Total tokens | Mean $ | Total $ | $/success | Mean dur (s) | Mean steps |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const row of aggregates.bySide) {
    lines.push(
      `| ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.ok}/${row.runs} | ${formatTokenCount(
        row.tokens.in.mean,
      )} | ${formatTokenCount(row.tokens.out.mean)} | ${formatTokenCount(
        row.tokens.total.mean,
      )} | ${formatTokenCount(row.tokens.total.total)} | ${formatUsd(
        row.cost?.mean ?? null,
      )} | ${formatUsd(row.cost?.total ?? null)} | ${formatUsd(
        row.costPerSuccess,
      )} | ${formatSeconds(row.durationMsMean)} | ${formatSteps(row.stepsMean)} |`,
    );
  }
  lines.push("");
  lines.push("Per success (usage-run sums divided by successful runs):", "");
  lines.push(
    "| Side | Protocol | In (no cache) | Out | Total | Cost |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  );
  for (const row of aggregates.bySide) {
    lines.push(
      `| ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${formatTokenCount(
        row.tokensPerSuccess.in,
      )} | ${formatTokenCount(
        row.tokensPerSuccess.out,
      )} | ${formatTokenCount(row.tokensPerSuccess.total)} | ${formatUsd(row.costPerSuccess)} |`,
    );
  }
  lines.push("");
  lines.push(successRateSentence(aggregates.bySide), "");
  lines.push(tokenMultiplierSentence(aggregates.bySide, aggregates.byTaskSide), "");
  // The oc side is measured once; later tc-only reports compare against that
  // fixed baseline instead of re-running opencode.
  const ranOpencode = aggregates.bySide.some((row) => row.side === "oc");
  const baseline = ranOpencode ? null : loadOcBaseline(repoRoot);
  if (baseline !== null) {
    const savings = savingsVsOcBaseline(aggregates.byTaskSide, baseline.byTaskSide);
    if (savings.rows.length > 0) {
      const baselineModel = baseline.model ?? "oc";
      const baselineReps = baseline.reps === null ? "n/a" : `${baseline.reps} reps`;
      lines.push("## Savings vs oc baseline", "");
      lines.push(
        `Baseline: \`${baseline.path}\` (${baselineModel}, ${baselineReps}, ${
          baseline.date ?? "date n/a"
        }). A factor above 1 means tc uses that many times fewer cache-excluded tokens.`,
        "",
      );
      lines.push(
        "| Task | Protocol | oc baseline mean total | tc mean total | Savings (oc/tc) |",
        "| --- | --- | ---: | ---: | ---: |",
      );
      for (const row of savings.rows) {
        lines.push(
          `| ${row.task} | ${row.protocol ?? "n/a"} | ${formatTokenCount(
            row.baselineMean,
          )} | ${formatTokenCount(row.currentMean)} | ${row.factor.toFixed(2)}x |`,
        );
      }
      for (const row of savings.overall) {
        lines.push(
          `| **all ${row.tasks} task${row.tasks === 1 ? "" : "s"}** | ${
            row.protocol ?? "n/a"
          } | ${formatTokenCount(row.baselineSum)} | ${formatTokenCount(
            row.currentSum,
          )} | **${row.factor.toFixed(2)}x** |`,
        );
      }
      lines.push("", ocBaselineSavingsSentence(savings), "");
    }
  }
  lines.push(
    `*Pricing footnote (decision-only):* USD costs use the official DeepSeek V4.1-Flash peak/off-peak`,
    `rates (fetched ${PRICING_FETCHED_ON} from ${PRICING_SOURCE_URL}; USD per 1M tokens):`,
    "cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;",
    "output $1.20 / $0.60. Peak hours are Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,",
    "excluding Chinese public holidays; every other hour is off-peak. A run straddling",
    "a boundary splits its cost by elapsed-time share.",
    "",
  );

  lines.push("## Selector adoption (#101)", "");
  lines.push("Per task and side (payloads that used each selector):", "");
  lines.push(
    "| Task | Side | Protocol | range | matcher | whole-symbol |",
    "| --- | --- | --- | ---: | ---: | ---: |",
  );
  for (const row of aggregates.byTaskSide) {
    lines.push(
      `| ${row.task ?? "all"} | ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${
        row.selectors.range
      } | ${row.selectors.matcher} | ${row.selectors.wholeSymbol} |`,
    );
  }
  lines.push("");
  lines.push(
    "| Side | Protocol | range | matcher | whole-symbol |",
    "| --- | --- | ---: | ---: | ---: |",
  );
  for (const row of aggregates.bySide) {
    lines.push(
      `| ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.selectors.range} | ${
        row.selectors.matcher
      } | ${row.selectors.wholeSymbol} |`,
    );
  }
  lines.push("");
  lines.push("Resolved cascade stages and matcher kinds (#110):", "");
  lines.push("Per task and side (payloads that resolved at each stage / used each matcher):", "");
  lines.push(
    "| Task | Side | Protocol | whole-symbol | match | pick | snippet | regex |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const row of aggregates.byTaskSide) {
    lines.push(
      `| ${row.task ?? "all"} | ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${
        row.stages.wholeSymbol
      } | ${row.stages.match} | ${row.stages.pick} | ${row.matcherKinds.snippet} | ${
        row.matcherKinds.regex
      } |`,
    );
  }
  lines.push("");
  lines.push(
    "| Side | Protocol | whole-symbol | match | pick | snippet | regex |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const row of aggregates.bySide) {
    lines.push(
      `| ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.stages.wholeSymbol} | ${
        row.stages.match
      } | ${row.stages.pick} | ${row.matcherKinds.snippet} | ${row.matcherKinds.regex} |`,
    );
  }
  lines.push("");
  // #111: edit-dsl implicit-create clauses the replies carried.
  lines.push("Implicit creates (#111):", "");
  lines.push("| Task | Side | Protocol | creates |", "| --- | --- | --- | ---: |");
  for (const row of aggregates.byTaskSide) {
    lines.push(
      `| ${row.task ?? "all"} | ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.creates} |`,
    );
  }
  lines.push("");
  lines.push("| Side | Protocol | creates |", "| --- | --- | ---: |");
  for (const row of aggregates.bySide) {
    lines.push(`| ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.creates} |`);
  }
  lines.push("");

  lines.push("## Anomalies", "");
  const failures = report.runs.filter((run) => !run.ok);
  lines.push("Failing runs:", "");
  if (failures.length === 0) {
    lines.push("- none", "");
  } else {
    for (const run of failures) {
      const reason =
        run.terminationReason === null
          ? (run.judge?.detail ??
            run.error ??
            run.infraError ??
            "no judge or error detail recorded")
          : (run.loopDiagnostics ?? run.terminationReason);
      lines.push(`- ${run.task} ${run.side} rep${run.rep}: ${formatOneLine(reason)}`);
    }
    lines.push("");
  }

  const missingUsage = report.runs.filter((run) => run.tokens.total === null);
  lines.push("Runs with missing usage (`tokens.total` null):", "");
  if (missingUsage.length === 0) {
    lines.push("- none", "");
  } else {
    for (const run of missingUsage) {
      lines.push(`- ${run.task} ${run.side} rep${run.rep} (usageSource=${run.usageSource})`);
    }
    lines.push("");
  }

  const timedOut = report.runs.filter((run) =>
    [run.error, run.infraError].some((text) => text !== null && /timed out|timeout/i.test(text)),
  );
  lines.push("Truncation / timeouts:", "");
  if (timedOut.length === 0) {
    lines.push("- none", "");
  } else {
    for (const run of timedOut) {
      lines.push(
        `- ${run.task} ${run.side} rep${run.rep}: ${formatOneLine(run.error ?? run.infraError ?? "")}`,
      );
    }
    lines.push("");
  }

  lines.push("Infrastructure errors:", "");
  if (report.infraErrors.length === 0) {
    lines.push("- none", "");
  } else {
    for (const entry of report.infraErrors) {
      lines.push(`- ${formatOneLine(entry)}`);
    }
    lines.push("");
  }

  const rerunNotes = [
    ...report.infraErrors.filter((entry) => /rerun|re-run/i.test(entry)),
    ...report.runs
      .filter((run) =>
        [run.error, run.infraError].some((text) => text !== null && /rerun|re-run/i.test(text)),
      )
      .map((run) => `${run.task} ${run.side} rep${run.rep}`),
  ];
  lines.push("Reruns:", "");
  if (rerunNotes.length === 0) {
    lines.push("- reruns: none");
  } else {
    for (const note of rerunNotes) {
      lines.push(`- rerun recorded: ${formatOneLine(note)}`);
    }
  }
  lines.push("");

  lines.push("## Raw runs", "");
  lines.push(
    "Provider-reported buckets, verbatim: tc `Raw in`/`Raw total` include cache hits;",
    "oc `Raw in` excludes them. The cache-excluded comparison total is in the tables",
    "above (and each row's `tokens.billable`), not here.",
    "",
    "| Task | Side | Protocol | Rep | OK | Raw in | Raw out | Raw total | Cost | Rate | Steps | Dur (s) |",
    "| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |",
  );
  for (const run of report.runs) {
    lines.push(
      `| ${run.task} | ${run.side} | ${run.protocol ?? "n/a"} | ${run.rep} | ${
        run.ok ? "yes" : "no"
      } | ${formatTokenCount(
        run.tokens.input,
      )} | ${formatTokenCount(run.tokens.output)} | ${formatTokenCount(run.tokens.total)} | ${formatUsd(
        run.cost ?? null,
      )} | ${run.rateClass ?? "n/a"} | ${formatTokenCount(run.steps)} | ${formatSeconds(
        run.durationMs,
      )} |`,
    );
  }
  lines.push("");

  writeFile(mdPath, `${lines.join("\n")}\n`);
}

/**
 * Bounded worker pool over one job array (#16): workers claim jobs by index, so
 * every side/protocol variant competes for the same slots. Results keep job
 * order even though completion order is arbitrary.
 */
export async function runPool<Job, Result>(
  jobs: readonly Job[],
  concurrency: number,
  run: (job: Job, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(jobs.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, jobs.length) },
    async (): Promise<void> => {
      for (;;) {
        const index = next++;
        const job = jobs[index];
        if (job === undefined) {
          return;
        }
        results[index] = await run(job, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Expand the task × side × rep matrix with the tc protocol dimension (#16).
 * `oc` has no protocol: it gets exactly one job per task/rep however many tc
 * variants are selected. The pool in `main` claims all jobs from one array, so
 * variants run concurrently rather than in a serial per-protocol phase.
 */
export function buildJobs(
  tasks: readonly TaskName[],
  sides: readonly Side[],
  reps: number,
  protocols: readonly ProtocolFormat[],
): BenchmarkJob[] {
  const jobs: BenchmarkJob[] = [];
  for (const task of tasks) {
    for (const side of sides) {
      for (let rep = 1; rep <= reps; rep += 1) {
        if (side === "tc") {
          for (const protocol of protocols) {
            jobs.push({ task, side, rep, protocol });
          }
        } else {
          jobs.push({ task, side, rep, protocol: null });
        }
      }
    }
  }
  return jobs;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }

  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const tscBin = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const generatedAt = new Date().toISOString();
  const date = generatedAt.slice(0, 10);
  const defaultJson = args.pilot
    ? join(repoRoot, "benchmark", "results", `pilot-${date}.json`)
    : join(repoRoot, "benchmark", "results", `${date}.json`);
  const jsonPath =
    args.json === null
      ? defaultJson
      : isAbsolute(args.json)
        ? args.json
        : resolve(process.cwd(), args.json);
  const replayDir =
    args.replayDir === null
      ? null
      : isAbsolute(args.replayDir)
        ? args.replayDir
        : resolve(process.cwd(), args.replayDir);
  const tasks = args.task === null ? TASKS.map((task) => task.name) : [args.task];
  const sides: Side[] = args.side === "both" ? ["tc", "oc"] : [args.side];
  const reps = args.pilot ? PILOT_REPS : args.reps;
  const protocols = args.protocolFormats;

  const jobs = buildJobs(tasks, sides, reps, protocols);

  // The full run on the pilot's date references the pilot report when it has
  // already been written; other days (and missing files) stay null.
  const pilotCandidate = join(repoRoot, "benchmark", "results", `pilot-${date}.json`);

  // #66/#16: pin the measured inputs per tc protocol, so a multi-variant report
  // can be checked against the prompt each ledger row actually measured.
  const provenanceFor = (protocol: ProtocolFormat): RecordedProvenance => ({
    ...currentInputHashes(repoRoot, {
      tasks,
      taskIssues: TASK_ISSUES,
      model: args.model,
      multiPayload: args.multiPayload,
      protocolFormat: protocol,
      effort: args.effort,
      reps,
      tokenBudget: args.tokenBudget,
    }),
    computedAt: generatedAt,
  });
  const provenanceByProtocol: Partial<Record<ProtocolFormat, RecordedProvenance>> = {};
  for (const protocol of protocols) {
    provenanceByProtocol[protocol] = provenanceFor(protocol);
  }
  const singleProtocol = protocols.length === 1 ? protocols[0] : undefined;
  const scalarProvenance =
    singleProtocol === undefined ? null : (provenanceByProtocol[singleProtocol] ?? null);

  const report: Report = {
    generatedAt,
    date,
    mode: args.pilot ? "pilot" : "full",
    tasks,
    sides,
    reps,
    concurrency: Math.min(args.concurrency, jobs.length),
    model: args.model,
    ocModel: args.ocModel === null || args.ocModel === args.model ? null : args.ocModel,
    effort: args.effort,
    multiPayload: args.multiPayload,
    // Scalar for today's single-protocol shape; null when variants are pooled
    // into no row, with the full selection in `protocolFormats` (#16).
    protocolFormat: singleProtocol ?? null,
    protocolFormats: protocols,
    tokenBudget: args.tokenBudget,
    bunVersion: Bun.version,
    opencodeVersion: null,
    pilotReference: existsSync(pilotCandidate) ? relative(repoRoot, pilotCandidate) : null,
    infraErrors: [],
    runs: [],
    // Preflight errors write this zeroed aggregate set; the normal path
    // recomputes it from the final runs after the pool.
    aggregates: computeAggregates([], tasks, sides, protocols),
    // #66: pin the measured inputs from the same tree the runs read, so the
    // record is self-describing and the ledger check can flag staleness.
    provenance: scalarProvenance,
    ...(singleProtocol === undefined ? { provenanceByProtocol } : {}),
  };

  let opencode: OpencodeContext | null = null;
  if (sides.includes("oc")) {
    try {
      opencode = await probeOpencodeCli(repoRoot);
      report.opencodeVersion = opencode.version;
    } catch (error) {
      report.infraErrors.push(errorMessage(error));
    }
  }
  if (sides.includes("tc")) {
    try {
      readConfigFromEnv(args.model);
    } catch (error) {
      report.infraErrors.push(`typescript side cannot start: ${errorMessage(error)}`);
    }
  }
  if (report.infraErrors.length > 0) {
    writeReport(jsonPath, report);
    process.stderr.write(`infrastructure error: ${report.infraErrors.join("; ")}\n`);
    process.stdout.write(`report: ${jsonPath}\n`);
    return 2;
  }

  // Rotate the previous round's artifacts (#51) once runs are certain to
  // execute; CLI single runs keep writing into `failures/` without rotating.
  const archived = archiveFailureArtifacts({ rootDir: repoRoot });
  if (archived !== null) {
    process.stdout.write(
      `archived ${archived.moved} failure artifact(s) to ${relative(repoRoot, archived.archiveDir)}\n`,
    );
  }

  const trimStamp = (value: string): string => value.replace(/[:.]/g, "-");
  const runStamp = `${trimStamp(new Date().toISOString())}-${randomUUID().slice(0, 8)}`;
  const runRoot = join(repoRoot, "tmp", "benchmark", runStamp);
  mkdirSync(runRoot, { recursive: true });

  const context: RunContext = {
    repoRoot,
    tscBin,
    model: args.model,
    effort: args.effort,
    opencodeModel: opencodeModelFor(args.model, args.ocModel),
    opencode,
    runRoot,
    replayDir,
    tokenBudget: args.tokenBudget,
    multiPayload: args.multiPayload,
    protocols,
  };

  // Bounded worker pool: workers claim jobs by index so each run keeps its own
  // workspace, session, and logs. Completion order only affects the interleaved
  // prints; `records` stays in job order. A single protocol keeps today's
  // `task side repN` console shape (#16); variants are named only when the
  // matrix measures more than one.
  const showProtocol = protocols.length > 1;
  const records = await runPool(jobs, Math.min(args.concurrency, jobs.length), async (job, i) => {
    const variant = showProtocol && job.protocol !== null ? ` ${job.protocol}` : "";
    process.stdout.write(
      `starting ${job.task} ${job.side}${variant} rep${job.rep} (${i + 1}/${jobs.length})\n`,
    );
    const record = await runOnce(job, context);
    printRecord(record, showProtocol);
    return record;
  });

  for (const record of records) {
    report.runs.push(record);
    if (record.infraError !== null) {
      report.infraErrors.push(record.infraError);
    }
  }

  if (args.keep) {
    process.stdout.write(`kept: ${runRoot}\n`);
  } else {
    rmSync(runRoot, { recursive: true, force: true });
  }

  report.aggregates = computeAggregates(report.runs, tasks, sides, protocols);
  writeReport(jsonPath, report);
  writeMarkdownReport(markdownPathFor(jsonPath), report);
  const ranOpencode = report.aggregates.bySide.some((row) => row.side === "oc");
  if (!ranOpencode) {
    const baseline = loadOcBaseline(repoRoot);
    if (baseline !== null) {
      const savings = savingsVsOcBaseline(report.aggregates.byTaskSide, baseline.byTaskSide);
      if (savings.rows.length > 0) {
        process.stdout.write(`${ocBaselineSavingsSentence(savings)}\n`);
      }
    }
  }
  const passed = report.runs.filter((run) => run.ok).length;
  process.stdout.write(`benchmark: ${passed} passed, ${report.runs.length - passed} failed\n`);
  process.stdout.write(`report: ${jsonPath}\n`);
  if (report.infraErrors.length > 0) {
    process.stderr.write(`infrastructure error: ${report.infraErrors.join("; ")}\n`);
    return 2;
  }
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`benchmark failed: ${errorMessage(error)}\n`);
    process.exitCode = 2;
  }
}
