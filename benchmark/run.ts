import { createHash, randomUUID } from "node:crypto";
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
import {
  buildSystemPrompt,
  canonicalAgentMode,
  DEFAULT_AGENT_MODE,
  DEFAULT_COST_BUDGET_USD,
  exchangeStats,
  runLoop,
} from "../src/loop";
import { buildTaskExecutionSystemPrompt, buildTaskPlanningSystemPrompt } from "../src/prompts/task";
import { OpenAIProvider, readConfigFromEnv } from "../src/openai";
import type {
  AgentMode,
  LoopTokens,
  ProviderLike,
  ProtocolFormat,
  RejectionCause,
} from "../src/loop";
import { ReplayRecorder, usageFromRaw } from "../src/replay-format";
import {
  PRICING_FETCHED_ON,
  PRICING_SOURCE_URL,
  billableCost,
  billableCostForLoopTokens,
  peakCost,
} from "../src/pricing";
import { currentInputHashes, normalizeText, stableStringify } from "../src/provenance";
import type { BillableCost } from "../src/pricing";
import type { RecordedProvenance } from "../src/provenance";
import type { ChatMessage, ChatResponse, ReasoningEffort, ToolDefinition } from "../src/openai";

export type TaskName =
  | "json-parser"
  | "sexp-parser"
  | "minilisp"
  | "csv-parser"
  | "mini-spreadsheet";
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
  /** Explicit pilot report path for a full run's `pilotReference`; null = default. */
  pilotJson: string | null;
  replayDir: string | null;
  costBudgetUsd: number | null;
  effort: ReasoningEffort | null;
  /** tc loop modes to measure; `pinned-repair` is the default. */
  agentModes: AgentMode[];
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
 * Cache-excluded, like-for-like USD triple (#89): `in` is cache-miss input,
 * `out` is output (reasoning included), and `total = in + out`, all priced at
 * the official peak rate. Cache-hit input is deliberately excluded so the two
 * sides compare on the same basis.
 */
export interface RunBillableCost extends BillableCost {
  /**
   * The cache-excluded USD cost over loop calls only, excluding a tc run's final
   * termination summary (#47): the `--budget-usd` basis. Null on the oc side
   * and when the side reported no usage.
   */
  readonly loop: number | null;
}

/**
 * Per-run billable split (#47): `total` covers every provider call the side
 * made (for tc that includes the final termination summary); `loop` applies the
 * same cache-excluded USD formula to the loop calls only — the `--budget-usd`
 * basis. `loopTokens` is the tc loop result's tally, passed as null on the oc
 * side or when usage is unavailable.
 */
export function billableCostForRun(
  totalUsage: TokenUsage,
  loopTokens: LoopTokens | null,
  side: Side,
): RunBillableCost {
  return {
    ...billableCost(totalUsage, side),
    loop: side === "tc" && loopTokens !== null ? billableCostForLoopTokens(loopTokens) : null,
  };
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
  /** Model calls; phase fields are present only for plan-exec. */
  readonly turns: RunTurnCounts;
  readonly durationMs: number;
  /** Wall clock of the side's model work (what `durationMs` measures). */
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly tokens: TokenUsage;
  /** tc loop-call tally (the budget basis); null on the oc side and on a tc error. */
  readonly loopTokens: LoopTokens | null;
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

/** Model-turn telemetry; old `steps` remains the execution-record count. */
export interface RunTurnCounts {
  readonly total: number;
  readonly planning: number | null;
  readonly execution: number | null;
  readonly review: number | null;
}

export interface RunRecord {
  readonly task: TaskName;
  readonly side: Side;
  /** Edit protocol used by a tc run (#119); null for the oc side. */
  readonly protocol: ProtocolFormat | null;
  /** tc loop mode; null for the oc side and legacy rows (read as `pinned-repair`). */
  readonly agentMode: AgentMode | null;
  readonly rep: number;
  readonly ok: boolean;
  readonly sideOk: boolean;
  readonly tokens: TokenUsage;
  /** Cache-excluded peak-price USD triple (all calls, plus tc loop-only); null without usage. */
  readonly billableCost: RunBillableCost | null;
  readonly usageAvailable: boolean;
  readonly usageSource: string;
  readonly rawUsage: unknown;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly cost: number | null;
  readonly steps: number | null;
  /** Model calls; additive to `steps`, which stays the record count. */
  readonly turns: RunTurnCounts;
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

/** One stable-prefix cache warm-up; excluded from the measured aggregates. */
export interface WarmupRecord {
  readonly agentMode: AgentMode;
  readonly kind: "edit" | "planning" | "execution";
  readonly promptChars: number;
  readonly tokens: TokenUsage;
  readonly usageAvailable: boolean;
  readonly durationMs: number;
  readonly error: string | null;
}

export interface AggregateRow {
  task: TaskName | null;
  side: Side | null;
  /** Edit protocol of a tc row (#119); null for the oc side and legacy rows. */
  protocol: ProtocolFormat | null;
  /** tc loop mode of the row; null for the oc side and legacy rows (read as `pinned-repair`). */
  agentMode: AgentMode | null;
  runs: number;
  ok: number;
  failed: number;
  successRate: number;
  usageRuns: number;
  /** Raw provider token stats: input, output, and total as reported. */
  tokens: { in: TokenStats; out: TokenStats; total: TokenStats };
  /** Cache-excluded peak-price USD stats: miss input, output, and their sum. */
  billableCost: { in: TokenStats; out: TokenStats; total: TokenStats };
  /** Full peak-price USD cost stats over runs that carry a cost. */
  cost: TokenStats;
  /**
   * Provider cache counters. `hitRate` is cacheRead / raw prompt tokens, where
   * tc's raw input already includes hits and oc's input excludes them. It is
   * the mean of the per-run ratios over usage runs.
   */
  cache: { read: TokenStats; hitRate: number | null };
  durationMsMean: number | null;
  stepsMean: number | null;
  /** Mean model calls per selected run; `stepsMean` remains the record mean. */
  turnsMean: number | null;
  /** Raw token sums divided by successful runs; diagnostic only. */
  tokensPerSuccess: { in: number | null; out: number | null; total: number | null };
  /** Cache-excluded USD sums divided by successful runs; budget/comparison view. */
  billableCostPerSuccess: number | null;
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
   * One row per side, tc protocol, and loop mode (#16): never a single row
   * that pools two tc variants into one comparison.
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
  /** Effective worker bound: min(requested, largest cache-stable group). */
  concurrency: number;
  model: string;
  /** oc-side model override (`--oc-model`); null when the oc side uses `model`. */
  ocModel: string | null;
  effort: ReasoningEffort | null;
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
  /** Selected tc loop modes; absent on legacy reports (read as `["pinned-repair"]`). */
  agentModes?: AgentMode[];
  /** Cache-excluded USD budget forwarded to the tc side; null means the loop default. */
  costBudgetUsd: number | null;
  bunVersion: string;
  opencodeVersion: string | null;
  pilotReference: string | null;
  infraErrors: string[];
  /** Stable-prefix warm-ups; excluded from every measured token/cost table. */
  warmups?: WarmupRecord[];
  /** Set when variant cache-hit rates are far apart. */
  cacheWarning?: string | null;
  runs: RunRecord[];
  aggregates: Aggregates;
  /**
   * Content hashes of the measured inputs (#66); scalar for single-protocol and
   * legacy reports, null when `provenanceByProtocol` carries one block per tc
   * variant (#16).
   */
  provenance: RecordedProvenance | null;
  /** Per-protocol provenance for a multi-protocol report (#16). */
  provenanceByProtocol?: Partial<Record<ProtocolFormat, RecordedProvenance>>;
  /** Per-mode provenance for a multi-mode report; absent on pinned-repair-only reports. */
  provenanceByAgentMode?: Partial<Record<AgentMode, RecordedProvenance>>;
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
  readonly costBudgetUsd: number | null;
  /** Selected tc protocol variants (#16); used to keep multi-variant run names unique. */
  readonly protocols: readonly ProtocolFormat[];
  /** Selected tc loop modes; used to keep multi-variant run names unique. */
  readonly agentModes: readonly AgentMode[];
}

interface BenchmarkJob {
  readonly task: TaskName;
  readonly side: Side;
  readonly rep: number;
  /** Edit protocol for a tc job (#119); null for the oc side. */
  readonly protocol: ProtocolFormat | null;
  /** tc loop mode; null for the oc side. */
  readonly agentMode: AgentMode | null;
}

interface OpencodeContext {
  readonly bin: string;
  readonly version: string;
}

interface JudgeResult extends JudgeRecord {
  readonly ok: boolean;
  readonly log: string;
}

/** The default four-task benchmark matrix; mini-spreadsheet is targeted-only. */
export const BENCHMARK_TASKS: readonly TaskName[] = [
  "json-parser",
  "sexp-parser",
  "minilisp",
  "csv-parser",
];

const TASKS: readonly TaskSpec[] = [
  ...BENCHMARK_TASKS.map((name) => ({ name })),
  { name: "mini-spreadsheet" },
];

/**
 * The benchmark input is a standalone spec, not a one-line issue. Keeping the
 * text in `benchmark/specs/<task>.md` makes the product contract reviewable
 * without reading the fixture tests (which remain the acceptance check).
 */
function readTaskSpec(task: TaskName): string {
  return readFileSync(fileURLToPath(new URL(`./specs/${task}.md`, import.meta.url)), "utf8").trim();
}

export const TASK_SPECS: Record<TaskName, string> = {
  "json-parser": readTaskSpec("json-parser"),
  "sexp-parser": readTaskSpec("sexp-parser"),
  minilisp: readTaskSpec("minilisp"),
  // Held-out task (#67): never a target of prompt or loop iteration.
  "csv-parser": readTaskSpec("csv-parser"),
  // Larger task kept outside the optional four-task baseline matrix.
  "mini-spreadsheet": readTaskSpec("mini-spreadsheet"),
};

/** Historical name kept for provenance/checking code; it is the spec text. */
export const TASK_ISSUES: Record<TaskName, string> = TASK_SPECS;

/**
 * Tasks covered by the optional oc baseline matrix. If a baseline is re-created,
 * its spec hash stays pinned to exactly these four tasks; `mini-spreadsheet`
 * is intentionally outside the comparison matrix.
 */
const BASELINE_TASKS: readonly TaskName[] = BENCHMARK_TASKS;

/**
 * Same text hash the provenance record uses for `taskIssue`, retained for an
 * optional baseline spec-identity check.
 */
const TASK_SPEC_HASH = createHash("sha256")
  .update(
    normalizeText(
      stableStringify(
        Object.fromEntries(
          [...BASELINE_TASKS].sort().map((task) => [task, normalizeText(TASK_SPECS[task])]),
        ),
      ),
    ),
  )
  .digest("hex");

// Reference implementations live in benchmark/references/ under short names
// rather than task names (json.ts, sexp.ts, lisp.ts, csv.ts, workbook.ts).
const TASK_REFERENCE_BASENAMES: Record<TaskName, string> = {
  "json-parser": "json",
  "sexp-parser": "sexp",
  minilisp: "lisp",
  "csv-parser": "csv",
  "mini-spreadsheet": "workbook",
};

const DEFAULT_MODEL = "deepseek-v4.1-flash";
const DEFAULT_REPS = 5;
const DEFAULT_CONCURRENCY = 4;
const PILOT_REPS = 1;
const OPENCODE_PROVIDER = "honghong";
// The fixed opencode reference point: the oc side is measured once against
// the official DeepSeek endpoint, then tc-only reports compare their
// cache-excluded USD costs against this file instead of re-running oc.
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
  --task <json-parser|sexp-parser|minilisp|csv-parser|mini-spreadsheet>
                                             run a single task (default: the four-task
                                             benchmark matrix; mini-spreadsheet is
                                             available only through this explicit flag)
  --all                                      run the four benchmark tasks (default;
                                             excludes mini-spreadsheet)
  --reps <n>                                 repetitions per task and side (default: 5; minimum 5, pilot uses 1)
  --concurrency <n>                          max parallel runs (default: ${DEFAULT_CONCURRENCY})
  --pilot                                    force 1 rep per task and side and write
                                             benchmark/results/pilot-<date>.json
  --side tc                                  only tc is measured; the oc side is frozen and
                                             no oc baseline is committed
  --model <id>                               gateway model id (default: ${DEFAULT_MODEL})
  --oc-model <id>                            frozen oc model id (accepted for compatibility;
                                             the oc side cannot run)
  --keep                                     keep workspaces and logs under ./tmp/benchmark/
  --json <path>                              report output path (default: benchmark/results/)
  --pilot-json <path>                        explicit pilot report path for pilotReference
                                             on a full run (default: pilot-<date>.json)
  --replay-dir <path>                        write per-run tc-side replay bundles to <path>
  --budget-usd <usd>                         abort a tc-side run once accumulated cache-excluded
                                             USD cost exceeds <usd>; the final termination summary
                                             is not budgeted (default: 0.10)
  --effort <none|low|high|max>               force this reasoning_effort on every tc-side
                                             model call (default: none)
  --agent-mode pinned-repair|plan-exec|both
                                             tc loop mode(s); pinned-repair is the default.
                                             Use both to measure pinned-repair and
                                             plan-exec in one report. Deprecated
                                             alias: edit (pinned-repair)
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

function parseCostBudget(value: string): number {
  const budget = Number(value);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(budget) || budget <= 0) {
    failUsage(`invalid --budget-usd value: ${value}`);
  }
  return budget;
}

function parseEffort(value: string): ReasoningEffort {
  if (value === "none" || value === "low" || value === "high" || value === "max") {
    return value;
  }
  failUsage(`invalid --effort value: ${value}`);
}

/** The single model reply protocol measured by the benchmark. */
const PROTOCOLS: readonly ProtocolFormat[] = ["edit-dsl"];

/** Canonical mode order: `pinned-repair` before `plan-exec`. */
const AGENT_MODE_ORDER: readonly AgentMode[] = ["pinned-repair", "plan-exec"];

/**
 * Parse `--agent-mode`: one value, a comma list, or `both`. Canonical names,
 * the deprecated `edit` alias, and `both` (both canonical modes) are accepted;
 * duplicates collapse and the canonical order is returned.
 */
export function parseAgentModes(value: string): AgentMode[] {
  if (value.trim() === "") {
    throw new Error("missing value for --agent-mode");
  }
  if (value === "both") {
    return [...AGENT_MODE_ORDER];
  }
  const selected = new Set<AgentMode>();
  for (const raw of value.split(",")) {
    const element = raw.trim();
    if (element === "both") {
      for (const mode of AGENT_MODE_ORDER) {
        selected.add(mode);
      }
      continue;
    }
    const mode = canonicalAgentMode(element);
    if (mode === null) {
      throw new Error(
        `invalid --agent-mode value: ${element === "" ? raw : element} (expected "pinned-repair", "plan-exec", or "both"; alias: edit)`,
      );
    }
    selected.add(mode);
  }
  return AGENT_MODE_ORDER.filter((mode) => selected.has(mode));
}

function parseSide(value: string): SideSelection {
  if (value === "tc" || value === "oc" || value === "both") {
    return value;
  }
  failUsage(`invalid --side value: ${value}`);
}

/**
 * Frozen dimensions: the oc side is a stored reference point. Re-running it
 * would move the reference point, so the benchmark refuses it outright (see
 * AGENTS.md). Returned as a message rather than thrown so tests can cover it
 * without the process-exiting usage path.
 */
export function frozenDimensionError(side: SideSelection): string | null {
  return side === "tc"
    ? null
    : "the oc side is frozen and no oc baseline is committed; benchmark only runs --side tc";
}

/** Resolve the pilot report a full run should cite (explicit path or default). */
export function pilotCandidatePath(
  repoRoot: string,
  date: string,
  pilotJson: string | null,
  cwd = process.cwd(),
): string {
  if (pilotJson === null) {
    return join(repoRoot, "benchmark", "results", `pilot-${date}.json`);
  }
  return isAbsolute(pilotJson) ? pilotJson : resolve(cwd, pilotJson);
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
    pilotJson: null,
    replayDir: null,
    costBudgetUsd: null,
    effort: null,
    agentModes: [DEFAULT_AGENT_MODE],
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
      case "--pilot-json": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --pilot-json");
        }
        args.pilotJson = value;
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
      case "--budget-usd": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --budget-usd");
        }
        args.costBudgetUsd = parseCostBudget(value);
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
      case "--agent-mode": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          failUsage("missing value for --agent-mode");
        }
        try {
          args.agentModes = parseAgentModes(value);
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
  // Frozen dimension: the oc side is measured once and stored under
  // benchmark/results/. Re-running it would move the reference point, so the
  // benchmark refuses it outright (see AGENTS.md).
  if (!args.help) {
    const frozen = frozenDimensionError(args.side);
    if (frozen !== null) {
      failUsage(frozen);
    }
    if (!args.pilot && args.reps < 5) {
      failUsage("--reps must be at least 5 for a measured run; use --pilot for one smoke rep");
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

// Per-run full USD cost from the recorded buckets at the official peak rate
// (see src/pricing.ts); null when the side reported no usage, mirroring a null
// `tokens.total`. Off-peak wall-clock windows are deliberately ignored.
function costForOutcome(outcome: SideOutcome, side: Side): number | null {
  if (!outcome.usageAvailable) {
    return null;
  }
  return peakCost(outcome.tokens, side);
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
  /** Measured model calls; used for turn telemetry, not the record count. */
  calls = 0;
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
    this.calls += 1;
    const response = await this.#inner.chat(messages, tools, options);
    this.rawUsages.push(usageFromRaw(response.raw));
    this.#recorder?.record(messages, response);
    return response;
  }
}

/**
 * Warm only the cache-stable system prefixes: the pinned-repair system prompt,
 * or the planning and execution system prompts for plan-exec. Task-specific user
 * prompts are deliberately not warmed. These calls are recorded separately and
 * never enter the measured aggregates.
 */
async function warmStablePrefixes(options: {
  model: string;
  protocols: readonly ProtocolFormat[];
  agentModes: readonly AgentMode[];
}): Promise<WarmupRecord[]> {
  const entries: { agentMode: AgentMode; kind: WarmupRecord["kind"]; prompt: string }[] = [];
  for (const agentMode of options.agentModes) {
    if (agentMode === "pinned-repair") {
      for (const protocol of options.protocols) {
        entries.push({
          agentMode,
          kind: "edit",
          prompt: buildSystemPrompt(),
        });
      }
      continue;
    }
    entries.push({
      agentMode,
      kind: "planning",
      prompt: buildTaskPlanningSystemPrompt(),
    });
    entries.push({
      agentMode,
      kind: "execution",
      prompt: buildTaskExecutionSystemPrompt(),
    });
  }

  const records: WarmupRecord[] = [];
  for (const entry of entries) {
    const started = performance.now();
    let error: string | null = null;
    let usage: TokenUsage = NULL_USAGE;
    try {
      const provider = new OpenAIProvider(
        { ...readConfigFromEnv(options.model), timeoutMs: CHAT_TIMEOUT_MS },
        fetchWithTimeout as typeof fetch,
      );
      const response = await provider.chat(
        [
          { role: "system", content: entry.prompt },
          { role: "user", content: "Reply with exactly OK." },
        ],
        undefined,
        { temperature: 0 },
      );
      usage = withDerivedTotal(tokenUsageFromOpenAi(response.raw));
    } catch (caught) {
      error = errorMessage(caught);
    }
    const record: WarmupRecord = {
      agentMode: entry.agentMode,
      kind: entry.kind,
      promptChars: entry.prompt.length,
      tokens: usage,
      usageAvailable: usageReported(usage),
      durationMs: Math.round(performance.now() - started),
      error,
    };
    records.push(record);
    process.stdout.write(
      `warm ${entry.agentMode}/${entry.kind}: ${entry.prompt.length} chars${
        error === null ? "" : ` (error: ${error})`
      }\n`,
    );
  }
  return records;
}

/** Set when cache-hit rates across variants differ by 20+ points. */
export function cacheBalanceWarning(rows: readonly AggregateRow[]): string | null {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    if (row.runs === 0 || row.cache.hitRate === null) {
      continue;
    }
    const key = row.task ?? "all tasks";
    const rates = groups.get(key) ?? [];
    rates.push(row.cache.hitRate);
    groups.set(key, rates);
  }
  const warnings: string[] = [];
  for (const [task, rates] of groups) {
    if (rates.length < 2) {
      continue;
    }
    const min = Math.min(...rates);
    const max = Math.max(...rates);
    if (max - min < 0.2) {
      continue;
    }
    warnings.push(
      `${task}: ${formatPercent(min)}–${formatPercent(max)} (${Math.round(
        (max - min) * 100,
      )} points)`,
    );
  }
  return warnings.length === 0
    ? null
    : `cache hit rates span ${warnings.join(
        "; ",
      )} across variants; billable USD means may be distorted by cold-cache runs. Warm the stable prefix and repeat before comparing.`;
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
  costBudgetUsd: number | null;
  effort: ReasoningEffort | null;
  /** Loop mode (`--agent-mode`); forwarded to the loop. */
  agentMode: AgentMode;
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
      costBudgetUsd: options.costBudgetUsd ?? undefined,
      effortOverride: options.effort ?? undefined,
      agentMode: options.agentMode,
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
      agentMode: options.agentMode,
    });
    writeFile(options.replayPath, `${JSON.stringify(bundle, null, 2)}\n`);
  }

  return {
    sideOk: result?.ok === true,
    error,
    infraError: null,
    steps: result?.records.length ?? null,
    turns: {
      total: provider.calls,
      planning: result?.turns?.planning ?? null,
      execution: result?.turns?.execution ?? null,
      review: result?.turns?.review ?? null,
    },
    durationMs,
    startedAt,
    finishedAt,
    tokens,
    loopTokens: result?.tokens ?? null,
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
    turns: { total: 0, planning: null, execution: null, review: null },
    durationMs,
    startedAt,
    finishedAt,
    tokens,
    loopTokens: null,
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
  const { task, side, rep, protocol, agentMode } = job;
  const fixtureDir = join(context.repoRoot, "benchmark", "fixtures", task);
  // Keep today's `task-side-repN` names for single-protocol runs; only a
  // multi-variant matrix needs the protocol in the name to stay unique (#16).
  const protocolSuffix = protocol !== null && context.protocols.length > 1 ? `-${protocol}` : "";
  // Name the mode only when it is not the default pinned-repair mode or when the
  // matrix measures both modes, so existing log paths stay stable.
  const modeSuffix =
    agentMode !== null && (context.agentModes.length > 1 || agentMode !== DEFAULT_AGENT_MODE)
      ? `-${agentMode}`
      : "";
  const runName = `${task}-${side}${protocolSuffix}${modeSuffix}-rep${rep}`;
  const workspace = join(context.runRoot, runName);
  const logsDir = join(context.runRoot, "logs", runName);
  mkdirSync(logsDir, { recursive: true });
  cpSync(fixtureDir, workspace, { recursive: true });
  initWorkspaceGit(workspace);

  const issue = TASK_SPECS[task];
  const replayPath =
    side === "tc" && context.replayDir !== null ? join(context.replayDir, `${runName}.json`) : null;
  let outcome: SideOutcome;
  if (side === "tc") {
    if (protocol === null) {
      throw new InfraError("tc job is missing its edit protocol");
    }
    if (agentMode === null) {
      throw new InfraError("tc job is missing its agent mode");
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
      costBudgetUsd: context.costBudgetUsd,
      effort: context.effort,
      agentMode,
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
  const cost = costForOutcome(outcome, side);
  return {
    task,
    side,
    protocol,
    agentMode,
    rep,
    // A termination-matrix ending is a run failure even when the judge passes
    // on the state left on disk (#43); judge fields stay as recorded.
    ok: outcome.terminationReason === null && judge.ok,
    sideOk: outcome.sideOk,
    tokens: outcome.tokens,
    billableCost: outcome.usageAvailable
      ? billableCostForRun(outcome.tokens, outcome.loopTokens, side)
      : null,
    usageAvailable: outcome.usageAvailable,
    usageSource: outcome.usageSource,
    rawUsage: outcome.rawUsage,
    durationMs: outcome.durationMs,
    startedAt: outcome.startedAt,
    finishedAt: outcome.finishedAt,
    cost,
    steps: outcome.steps,
    turns: outcome.turns,
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

function printRecord(record: RunRecord, showProtocol: boolean, showMode = false): void {
  const seconds = (record.durationMs / 1000).toFixed(1);
  const label = record.ok ? "PASS" : "FAIL";
  const mode = canonicalAgentMode(record.agentMode) ?? DEFAULT_AGENT_MODE;
  const variant =
    (showProtocol && record.protocol !== null ? ` ${record.protocol}` : "") +
    (record.agentMode !== null && (showMode || mode !== DEFAULT_AGENT_MODE) ? ` ${mode}` : "");
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
// never leak in: only final records are listed. `tokens` is the raw provider
// total. `billableCost` is the cache-excluded peak-price USD view (#89): `in` =
// cache-miss input, `out` = output (reasoning included), `total = in + out`;
// `cost` is full peak-price USD including cache hits. Stats cover runs whose
// usage was available. `billableCostPerSuccess` and `costPerSuccess` divide
// those sums by the number of passing runs (judge-passing and not aborted at
// the USD budget; null when there were no successes).
/**
 * Cache-hit share of a run's raw prompt tokens. tc's `input` already includes
 * cached tokens; oc's export reports `input` as misses and `cacheRead`
 * separately. Unknown usage stays null.
 */
function cacheHitRateForRun(run: RunRecord): number | null {
  const read = run.tokens.cacheRead;
  const input = run.tokens.input;
  if (read === null || input === null) {
    return null;
  }
  const raw = run.side === "tc" ? input : input + read;
  return raw > 0 ? Math.min(1, read / raw) : null;
}

function numberStats(values: readonly number[]): TokenStats {
  if (values.length === 0) {
    return { mean: null, total: null };
  }
  const total = values.reduce((left, right) => left + right, 0);
  return { mean: total / values.length, total };
}

/** A tc row/run's mode, mapped through the legacy alias; missing reads as pinned-repair. */
function modeOf(value: unknown): AgentMode {
  return canonicalAgentMode(value) ?? DEFAULT_AGENT_MODE;
}

export function aggregateRuns(
  runs: readonly RunRecord[],
  task: TaskName | null,
  side: Side | null,
  /** Omitted = no protocol filter (legacy callers); null = runs without one (oc). */
  protocol: ProtocolFormat | null | undefined = undefined,
  /** Omitted = no mode filter; null = runs without one (oc). */
  agentMode: AgentMode | null | undefined = undefined,
): AggregateRow {
  const selected = runs.filter(
    (run) =>
      (task === null || run.task === task) &&
      (side === null || run.side === side) &&
      (protocol === undefined ||
        (protocol === null
          ? run.side !== "tc" || run.protocol === null || run.protocol === undefined
          : run.side === "tc" && (run.protocol ?? "edit-dsl") === protocol)) &&
      (agentMode === undefined || (run.side === "tc" ? modeOf(run.agentMode) : null) === agentMode),
  );
  const usageRuns = selected.filter((run) => run.tokens.total !== null);
  const ok = selected.filter((run) => run.ok).length;
  const rawStats = (pick: (run: RunRecord) => number | null): TokenStats =>
    numberStats(
      selected.map((run) => pick(run)).filter((value): value is number => value !== null),
    );
  const steps = selected.map((run) => run.steps).filter((value): value is number => value !== null);
  const tokens = {
    in: rawStats((run) => run.tokens.input),
    out: rawStats((run) => run.tokens.output),
    total: rawStats((run) => run.tokens.total),
  };
  const billableRuns = selected
    .map((run) => run.billableCost)
    .filter((value): value is RunBillableCost => value !== null);
  const billableCostStats = {
    in: numberStats(billableRuns.map((run) => run.in)),
    out: numberStats(billableRuns.map((run) => run.out)),
    total: numberStats(billableRuns.map((run) => run.total)),
  };
  const costValues = selected
    .map((run) => run.cost)
    .filter((value): value is number => value !== null);
  const costTotal = costValues.reduce((left, right) => left + right, 0);
  const cost: TokenStats =
    costValues.length === 0
      ? { mean: null, total: null }
      : { mean: costTotal / costValues.length, total: costTotal };
  const cacheReadValues = selected
    .map((run) => run.tokens.cacheRead)
    .filter((value): value is number => value !== null);
  const cacheHitRates = selected
    .map((run) => cacheHitRateForRun(run))
    .filter((value): value is number => value !== null);
  const cache = {
    read: numberStats(cacheReadValues),
    hitRate:
      cacheHitRates.length === 0
        ? null
        : cacheHitRates.reduce((left, right) => left + right, 0) / cacheHitRates.length,
  };
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
    agentMode:
      agentMode === undefined ? (side === "oc" ? null : modeOf(selected[0]?.agentMode)) : agentMode,
    runs: selected.length,
    ok,
    failed: selected.length - ok,
    successRate: selected.length === 0 ? 0 : ok / selected.length,
    usageRuns: usageRuns.length,
    tokens,
    billableCost: billableCostStats,
    cost,
    cache,
    durationMsMean:
      selected.length === 0
        ? null
        : selected.reduce((left, run) => left + run.durationMs, 0) / selected.length,
    stepsMean:
      steps.length === 0 ? null : steps.reduce((left, right) => left + right, 0) / steps.length,
    turnsMean: (() => {
      const values = selected
        .map((run) => run.turns.total)
        .filter((value): value is number => typeof value === "number");
      return values.length === 0
        ? null
        : values.reduce((left, right) => left + right, 0) / values.length;
    })(),
    tokensPerSuccess: {
      in: perSuccess(tokens.in),
      out: perSuccess(tokens.out),
      total: perSuccess(tokens.total),
    },
    billableCostPerSuccess: perSuccess(billableCostStats.total),
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

// Modes present among tc runs; a legacy run without the field reads as
// pinned-repair, and legacy `edit` values map to canonical modes.
function agentModesFromRuns(runs: readonly RunRecord[]): AgentMode[] {
  const modes = new Set<AgentMode>();
  for (const run of runs) {
    if (run.side === "tc") {
      modes.add(modeOf(run.agentMode));
    }
  }
  return modes.size === 0
    ? [DEFAULT_AGENT_MODE]
    : AGENT_MODE_ORDER.filter((mode) => modes.has(mode));
}

/** Canonical mode list for report metadata, reading legacy labels and absent defaults. */
function canonicalModeList(modes: readonly AgentMode[] | undefined): AgentMode[] {
  const selected = new Set<AgentMode>();
  for (const mode of modes ?? [DEFAULT_AGENT_MODE]) {
    const canonical = canonicalAgentMode(mode);
    if (canonical !== null) {
      selected.add(canonical);
    }
  }
  return selected.size === 0
    ? [DEFAULT_AGENT_MODE]
    : AGENT_MODE_ORDER.filter((mode) => selected.has(mode));
}

function aggregatesForSide(
  runs: readonly RunRecord[],
  task: TaskName | null,
  side: Side,
  protocols: readonly (ProtocolFormat | null)[],
  agentModes: readonly AgentMode[],
): AggregateRow[] {
  // `oc` has no protocol or mode dimension: exactly one row however many tc
  // variants were selected (#16).
  if (side === "oc") {
    return [aggregateRuns(runs, task, side, null, null)];
  }
  const rows: AggregateRow[] = [];
  for (const agentMode of agentModes) {
    for (const protocol of protocols) {
      rows.push(aggregateRuns(runs, task, side, protocol, agentMode));
    }
  }
  return rows;
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
  agentModes: readonly AgentMode[] = agentModesFromRuns(runs),
): Aggregates {
  const byTaskSide: AggregateRow[] = [];
  for (const task of tasks) {
    for (const side of sides) {
      byTaskSide.push(...aggregatesForSide(runs, task, side, protocols, agentModes));
    }
  }
  const bySide = sides.flatMap((side) =>
    aggregatesForSide(runs, null, side, protocols, agentModes),
  );
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

function formatCacheHit(value: number | null): string {
  return value === null ? "n/a" : formatPercent(value);
}

function formatOneLine(text: string, limit = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

// A tc row is named by side, protocol, and mode when the report has several
// variants; a single edit-dsl/edit report keeps the historical bare side label.
function hasMultipleProtocols(rows: readonly AggregateRow[]): boolean {
  const protocols = new Set<ProtocolFormat>();
  for (const row of rows) {
    if (row.side === "tc" && row.protocol !== null) {
      protocols.add(row.protocol);
    }
  }
  return protocols.size > 1;
}

function hasMultipleModes(rows: readonly AggregateRow[]): boolean {
  const modes = new Set<AgentMode>();
  for (const row of rows) {
    if (row.side === "tc") {
      modes.add(modeOf(row.agentMode));
    }
  }
  return modes.size > 1;
}

function sideLabel(row: AggregateRow, showProtocol: boolean, showMode: boolean): string {
  const parts = [row.side ?? "all"];
  if (showProtocol && row.protocol !== null) {
    parts.push(row.protocol);
  }
  if (
    row.side === "tc" &&
    row.agentMode !== null &&
    (showMode || modeOf(row.agentMode) !== DEFAULT_AGENT_MODE)
  ) {
    parts.push(modeOf(row.agentMode));
  }
  return parts.join(" ");
}

// The multiplier sentence names the variant first (`json tc 1.38x oc`) so a
// tc protocol is never mistaken for the side itself.
function multiplierSideLabel(row: AggregateRow, showProtocol: boolean, showMode: boolean): string {
  const parts: string[] = [];
  if (showProtocol && row.protocol !== null) {
    parts.push(row.protocol);
  }
  if (
    row.side === "tc" &&
    row.agentMode !== null &&
    (showMode || modeOf(row.agentMode) !== DEFAULT_AGENT_MODE)
  ) {
    parts.push(modeOf(row.agentMode));
  }
  parts.push(row.side ?? "all");
  return parts.join(" ");
}

function successSummary(row: AggregateRow, showProtocol: boolean, showMode: boolean): string {
  return `${sideLabel(row, showProtocol, showMode)} ${row.ok}/${row.runs} (${formatPercent(
    row.successRate,
  )})`;
}

function successRateSentence(rows: readonly AggregateRow[]): string {
  const first = rows[0];
  if (first === undefined) {
    return "No side ran; success rates are not comparable.";
  }
  const showProtocol = hasMultipleProtocols(rows);
  const showMode = hasMultipleModes(rows);
  if (rows.length === 1) {
    return `Only one side ran: ${successSummary(first, showProtocol, showMode)}.`;
  }
  const summaries = rows.map((row) => successSummary(row, showProtocol, showMode)).join(" vs ");
  const equal = rows.every((row) => row.successRate === first.successRate);
  return equal ? `Success rates are equal: ${summaries}.` : `Success rates differ: ${summaries}.`;
}

// `higher X.XXx lower` for a two-side pair, or null when the pair cannot be
// compared (a missing total or a zero lower side).
function multiplierLabel(
  rows: readonly AggregateRow[],
  showProtocol: boolean,
  showMode: boolean,
): string | null {
  const [first, second] = rows;
  if (first === undefined || second === undefined) {
    return null;
  }
  const firstTotal = first.billableCost.total.total;
  const secondTotal = second.billableCost.total.total;
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
  return `${multiplierSideLabel(higher, showProtocol, showMode)} ${(high / low).toFixed(2)}x ${multiplierSideLabel(
    lower,
    showProtocol,
    showMode,
  )}`;
}

// One comparison per tc row against the oc row (#16): with two tc variants the
// first two rows must never be paired with each other.
function multiplierLabels(
  rows: readonly AggregateRow[],
  showProtocol: boolean,
  showMode: boolean,
): string[] {
  const oc = rows.find((row) => row.side === "oc");
  if (oc === undefined) {
    return [];
  }
  const labels: string[] = [];
  for (const row of rows) {
    if (row.side !== "tc") {
      continue;
    }
    const label = multiplierLabel([row, oc], showProtocol, showMode);
    if (label !== null) {
      labels.push(label);
    }
  }
  return labels;
}

/**
 * Cache-excluded USD multiplier summary (#89): the higher side's billable cost
 * over the lower side, overall and per task. Says so plainly when both sides did
 * not run (no comparable pair).
 */
export function billableCostMultiplierSentence(
  bySide: readonly AggregateRow[],
  byTaskSide: readonly AggregateRow[],
): string {
  const combined = [...bySide, ...byTaskSide];
  const showProtocol = hasMultipleProtocols(combined);
  const showMode = hasMultipleModes(combined);
  const overallLabels = multiplierLabels(
    bySide.filter((row) => row.side !== null),
    showProtocol,
    showMode,
  );
  const taskParts: string[] = [];
  const taskNames = [
    ...new Set(byTaskSide.map((row) => row.task).filter((task): task is TaskName => task !== null)),
  ];
  for (const task of taskNames) {
    for (const label of multiplierLabels(
      byTaskSide.filter((row) => row.task === task && row.side !== null),
      showProtocol,
      showMode,
    )) {
      taskParts.push(`${task} ${label}`);
    }
  }
  if (overallLabels.length === 0 && taskParts.length === 0) {
    return "Cache-excluded USD multiplier: not comparable (both sides must run).";
  }
  const parts = overallLabels.map((label) => `${label} overall`);
  parts.push(...taskParts);
  return `Cache-excluded USD multiplier (higher/lower): ${parts.join("; ")}.`;
}

export interface BaselineSavingsRow {
  readonly task: TaskName;
  readonly protocol: ProtocolFormat | null;
  readonly agentMode: AgentMode | null;
  readonly baselineMean: number;
  readonly currentMean: number;
  /** Baseline mean over the current mean: how many times fewer USD tc uses. */
  readonly factor: number;
}

interface BaselineOverall {
  readonly protocol: ProtocolFormat | null;
  readonly agentMode: AgentMode | null;
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
 * oc baseline's mean cache-excluded USD cost divided by the current tc mean, so
 * `2.5` reads as "tc uses 2.5x fewer dollars". Tasks absent from either side are
 * skipped instead of treated as zero, and a zero current mean never divides.
 */
export function savingsVsOcBaseline(
  currentByTaskSide: readonly AggregateRow[],
  baselineByTaskSide: readonly AggregateRow[],
): BaselineSavings {
  const baseline = new Map<TaskName, number>();
  for (const row of baselineByTaskSide) {
    const mean = row.billableCost.total.mean;
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
    const currentMean = row.billableCost.total.mean;
    if (baselineMean === undefined || currentMean === null || currentMean <= 0) {
      continue;
    }
    rows.push({
      task: row.task,
      protocol: row.protocol,
      agentMode: row.agentMode === null ? null : modeOf(row.agentMode),
      baselineMean,
      currentMean,
      factor: baselineMean / currentMean,
    });
  }
  const byVariant = new Map<
    string,
    {
      protocol: ProtocolFormat | null;
      agentMode: AgentMode | null;
      baselineSum: number;
      currentSum: number;
      tasks: number;
    }
  >();
  for (const row of rows) {
    const key = `${row.protocol ?? ""}\u0000${row.agentMode === null ? "" : modeOf(row.agentMode)}`;
    const accrued = byVariant.get(key) ?? {
      protocol: row.protocol,
      agentMode: row.agentMode,
      baselineSum: 0,
      currentSum: 0,
      tasks: 0,
    };
    accrued.baselineSum += row.baselineMean;
    accrued.currentSum += row.currentMean;
    accrued.tasks += 1;
    byVariant.set(key, accrued);
  }
  const overall: BaselineOverall[] = [...byVariant.values()].map((value) => ({
    protocol: value.protocol,
    agentMode: value.agentMode,
    baselineSum: value.baselineSum,
    currentSum: value.currentSum,
    factor: value.baselineSum / value.currentSum,
    tasks: value.tasks,
  }));
  return { rows, overall };
}

export function ocBaselineSavingsSentence(savings: BaselineSavings): string {
  if (savings.overall.length === 0) {
    return "Savings vs oc baseline: not comparable (no shared task reports a billable cost).";
  }
  const parts = savings.overall.map((entry) => {
    const mode = entry.agentMode === null ? null : modeOf(entry.agentMode);
    const label =
      entry.protocol === null
        ? ""
        : `${entry.protocol}${mode !== null && mode !== DEFAULT_AGENT_MODE ? `/${mode}` : ""} `;
    return `${label}${entry.factor.toFixed(2)}x fewer USD across ${entry.tasks} task${
      entry.tasks === 1 ? "" : "s"
    }`;
  });
  return `Savings vs oc baseline (cache-excluded USD, oc/tc): ${parts.join("; ")}.`;
}

interface FrozenBaseline {
  readonly path: string;
  readonly date: string | null;
  readonly model: string | null;
  readonly reps: number | null;
  /** Hash of the task-spec text the baseline was measured against. */
  readonly specHash: string | null;
  readonly byTaskSide: AggregateRow[];
}

/** Return the baseline's stale spec hash, or null when it is comparable. */
function staleBaselineSpec(baseline: FrozenBaseline): string | null {
  return baseline.specHash === TASK_SPEC_HASH ? null : baseline.specHash;
}

/** Read one fixed baseline report, or null when it is missing/unreadable. */
function loadFrozenBaseline(repoRoot: string, relativePath: string): FrozenBaseline | null {
  const path = join(repoRoot, relativePath);
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
  const provenance = parsed["provenance"];
  const inputs = isRecord(provenance) ? provenance["inputs"] : null;
  const specHash = isRecord(inputs) ? inputs["taskIssue"] : null;
  const label = typeof ocModel === "string" ? ocModel : model;
  return {
    path: relativePath,
    date: typeof date === "string" ? date : null,
    model: typeof label === "string" ? label : null,
    reps: typeof reps === "number" ? reps : null,
    specHash: typeof specHash === "string" ? specHash : null,
    // Historical baseline rows carry the old mode labels (or none); normalize
    // at this read boundary so every downstream report names canonical modes.
    byTaskSide: (rows as AggregateRow[]).map((row) =>
      row.side === "tc" ? { ...row, agentMode: modeOf(row.agentMode) } : row,
    ),
  };
}

function loadOcBaseline(repoRoot: string): FrozenBaseline | null {
  return loadFrozenBaseline(repoRoot, OC_BASELINE_RELATIVE_PATH);
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

/** Use a fence longer than any run of backticks inside the spec. */
function codeFenceFor(text: string): string {
  const longestRun = (text.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

export function writeMarkdownReport(
  mdPath: string,
  report: Report,
  baselineRoot = fileURLToPath(new URL("..", import.meta.url)),
): void {
  // Specs and references always come from the checkout; the baseline root is a
  // test seam so the stale-hash branch can be exercised without moving the
  // real frozen files.
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const { aggregates } = report;
  const protocolFormats =
    report.protocolFormats ?? (report.protocolFormat == null ? [] : [report.protocolFormat]);
  const protocolLine =
    protocolFormats.length > 1
      ? `- protocol-formats: ${protocolFormats.join(", ")} (#119)`
      : `- protocol-format: ${protocolFormats[0] ?? report.protocolFormat ?? "edit-dsl"} (#119)`;
  const agentModes = canonicalModeList(report.agentModes);
  const modeLine =
    agentModes.length > 1 || agentModes[0] !== DEFAULT_AGENT_MODE
      ? `- agent modes: ${agentModes.join(", ")}`
      : null;
  const lines: string[] = [];
  lines.push(`# Benchmark report — ${report.date}`, "");
  lines.push(
    `- mode: ${report.mode}`,
    `- model: ${report.model}`,
    ...(report.ocModel === null || report.ocModel === undefined
      ? []
      : [`- oc model: ${report.ocModel}`]),
    `- effort: ${report.effort ?? "none (default)"}`,
    `- budget: ${formatUsd(report.costBudgetUsd ?? DEFAULT_COST_BUDGET_USD)} cache-excluded USD`,
    protocolLine,
    ...(modeLine === null ? [] : [modeLine]),
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
    const fence = codeFenceFor(TASK_SPECS[task]);
    lines.push(
      "Spec (verbatim, identical for both sides):",
      "",
      fence,
      TASK_SPECS[task],
      fence,
      "",
    );
    lines.push(
      `- fixture: benchmark/fixtures/${task}/`,
      `- reference: ${resolveReferencePath(repoRoot, task)}`,
      "",
    );
  }

  if ((report.warmups ?? []).length > 0) {
    lines.push("## Cache warm-up", "");
    lines.push(
      "Only the cache-stable system prefixes were warmed; task-specific user prompts were not. These calls are excluded from every measured token/cost table.",
      "",
      "| Agent mode | Prefix | Prompt chars | Raw in | Cache read | Cache hit | Duration (s) | Error |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    );
    for (const warmup of report.warmups ?? []) {
      const input = warmup.tokens.input;
      const read = warmup.tokens.cacheRead;
      lines.push(
        `| ${canonicalAgentMode(warmup.agentMode) ?? DEFAULT_AGENT_MODE} | ${warmup.kind} | ${warmup.promptChars} | ${formatTokenCount(
          input,
        )} | ${formatTokenCount(read)} | ${formatCacheHit(
          input !== null && input > 0 && read !== null ? Math.min(1, read / input) : null,
        )} | ${formatSeconds(warmup.durationMs)} | ${warmup.error ?? "none"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## USD accounting", "");
  lines.push(
    "All runs are priced at the official DeepSeek V4.1-Flash **peak** rates, even when",
    "the run happened during an off-peak window; off-peak rates are never used. Rates",
    `were fetched ${PRICING_FETCHED_ON} from ${PRICING_SOURCE_URL} (USD per 1M tokens):`,
    "cache-hit input $0.006; cache-miss input $0.30; output $1.20. The pricing and",
    "bucket normalization live in `src/pricing.ts`.",
    "",
    "Two USD views are reported. **Full cost** prices cache-hit input, cache-miss input,",
    "and output. **Billable cost** (#89) is the cache-excluded, like-for-like view:",
    "cache-miss input + output, with reasoning counted as output and cache-hit input",
    "excluded. Billable cost is the comparison, multiplier, savings, and `--budget-usd`",
    "basis; full cost records actual peak-price spend.",
    "",
    "tc: OpenAI-compatible `usage` from the provider, summed over every chat request",
    "(input/prompt, output/completion, total; cache and reasoning counters are kept per",
    "record). The loop enforces its budget before the termination summary call, so",
    "`billableCost.total` includes that final summary while `billableCost.loop` covers",
    "loop calls only; `billableCost.loop` is the `--budget-usd` basis and",
    "`billableCost.total` is the all-calls headline. The oc side has no loop split",
    "(null).",
    "",
    "oc: usage read from `opencode session export` (`info.tokens`), falling back to",
    "`opencode stats --json`; input/output come from the reported session usage and total",
    "is derived from input + output + reasoning when the export reports none; the export's",
    "own `cost` stays verbatim in `rawUsage`.",
    "",
  );

  lines.push("## Per-task results", "");
  lines.push(
    "| Task | Side | Protocol | Agent mode | Success | Billable in ($) | Cache hit | Billable out ($) | Billable total ($) | Full $ | $/success | Mean dur (s) | Mean steps | Mean turns |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const row of aggregates.byTaskSide) {
    lines.push(
      `| ${row.task ?? "all"} | ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.agentMode ?? "n/a"} | ${row.ok}/${row.runs} | ${formatUsd(
        row.billableCost.in.mean,
      )} | ${formatCacheHit(row.cache.hitRate)} | ${formatUsd(
        row.billableCost.out.mean,
      )} | ${formatUsd(row.billableCost.total.mean)} | ${formatUsd(
        row.cost.mean,
      )} | ${formatUsd(row.costPerSuccess)} | ${formatSeconds(
        row.durationMsMean,
      )} | ${formatSteps(row.stepsMean)} | ${formatSteps(row.turnsMean)} |`,
    );
  }
  lines.push("");

  lines.push("## Overall comparison", "");
  lines.push(
    "| Side | Protocol | Agent mode | Success | Mean billable in ($) | Cache hit | Mean billable out ($) | Mean billable total ($) | Total billable ($) | Mean full $ | Total full $ | $/success | Mean dur (s) | Mean steps | Mean turns |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const row of aggregates.bySide) {
    lines.push(
      `| ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.agentMode ?? "n/a"} | ${row.ok}/${row.runs} | ${formatUsd(
        row.billableCost.in.mean,
      )} | ${formatCacheHit(row.cache.hitRate)} | ${formatUsd(
        row.billableCost.out.mean,
      )} | ${formatUsd(row.billableCost.total.mean)} | ${formatUsd(
        row.billableCost.total.total,
      )} | ${formatUsd(row.cost.mean)} | ${formatUsd(row.cost.total)} | ${formatUsd(
        row.costPerSuccess,
      )} | ${formatSeconds(row.durationMsMean)} | ${formatSteps(row.stepsMean)} | ${formatSteps(
        row.turnsMean,
      )} |`,
    );
  }
  lines.push("");
  lines.push("Per success (usage-run sums divided by successful runs):", "");
  lines.push(
    "| Side | Protocol | Agent mode | Billable total ($) | Full cost ($) | Full $/success |",
    "| --- | --- | --- | ---: | ---: | ---: |",
  );
  for (const row of aggregates.bySide) {
    lines.push(
      `| ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.agentMode ?? "n/a"} | ${formatUsd(
        row.billableCostPerSuccess,
      )} | ${formatUsd(row.cost.total)} | ${formatUsd(row.costPerSuccess)} |`,
    );
  }
  lines.push("");
  lines.push("## Cache hit balance", "");
  lines.push(
    "Cache hit = cacheRead / raw prompt tokens (tc input includes hits; oc input excludes them).",
    "",
    "| Side | Protocol | Agent mode | Cache hit | Cache-read tokens |",
    "| --- | --- | --- | ---: | ---: |",
  );
  for (const row of aggregates.bySide) {
    lines.push(
      `| ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.agentMode ?? "n/a"} | ${formatCacheHit(
        row.cache.hitRate,
      )} | ${formatTokenCount(row.cache.read.mean)} |`,
    );
  }
  lines.push("");
  if (report.cacheWarning !== null && report.cacheWarning !== undefined) {
    lines.push(`> **Cache warning:** ${report.cacheWarning}`, "");
  }
  lines.push(successRateSentence(aggregates.bySide), "");
  lines.push(billableCostMultiplierSentence(aggregates.bySide, aggregates.byTaskSide), "");
  // The oc side is measured once; tc-only reports compare against that fixed
  // baseline instead of re-running it.
  const ranOpencode = aggregates.bySide.some((row) => row.side === "oc");
  const ocBaseline = ranOpencode ? null : loadOcBaseline(baselineRoot);
  if (ocBaseline !== null && staleBaselineSpec(ocBaseline) !== null) {
    lines.push(
      "## Baseline comparison unavailable",
      "",
      "The frozen oc baseline was measured with a different task-spec text and is not USD-comparable to these spec runs. Re-freeze the baseline against `benchmark/specs/` before comparing costs.",
      "",
    );
  } else if (ocBaseline !== null) {
    const savings = savingsVsOcBaseline(aggregates.byTaskSide, ocBaseline.byTaskSide);
    if (savings.rows.length > 0) {
      const baselineModel = ocBaseline.model ?? "oc";
      const baselineReps = ocBaseline.reps === null ? "n/a" : `${ocBaseline.reps} reps`;
      lines.push("## Savings vs oc baseline", "");
      lines.push(
        `Baseline: \`${ocBaseline.path}\` (${baselineModel}, ${baselineReps}, ${
          ocBaseline.date ?? "date n/a"
        }). A factor above 1 means tc uses that many times fewer cache-excluded USD.`,
        "",
      );
      lines.push(
        "| Task | Protocol | Agent mode | oc baseline mean billable $ | tc mean billable $ | Savings (oc/tc) |",
        "| --- | --- | --- | ---: | ---: | ---: |",
      );
      for (const row of savings.rows) {
        lines.push(
          `| ${row.task} | ${row.protocol ?? "n/a"} | ${row.agentMode ?? "n/a"} | ${formatUsd(
            row.baselineMean,
          )} | ${formatUsd(row.currentMean)} | ${row.factor.toFixed(2)}x |`,
        );
      }
      for (const row of savings.overall) {
        lines.push(
          `| **all ${row.tasks} task${row.tasks === 1 ? "" : "s"}** | ${
            row.protocol ?? "n/a"
          } | ${row.agentMode ?? "n/a"} | ${formatUsd(row.baselineSum)} | ${formatUsd(
            row.currentSum,
          )} | **${row.factor.toFixed(2)}x** |`,
        );
      }
      lines.push("", ocBaselineSavingsSentence(savings), "");
    }
  }
  lines.push(
    `*Pricing footnote:* USD costs use the official DeepSeek V4.1-Flash **peak** rates`,
    `(fetched ${PRICING_FETCHED_ON} from ${PRICING_SOURCE_URL}; USD per 1M tokens):`,
    "cache-hit input $0.006; cache-miss input $0.30; output $1.20. Peak rates are used",
    "unconditionally, including runs that happened during off-peak hours; no wall-clock",
    "rate-class blend is applied.",
    "",
  );

  lines.push("## Selector adoption (#101)", "");
  lines.push("Per task and side (payloads that used each selector):", "");
  lines.push(
    "| Task | Side | Protocol | Agent mode | range | matcher | whole-symbol |",
    "| --- | --- | --- | --- | ---: | ---: | ---: |",
  );
  for (const row of aggregates.byTaskSide) {
    lines.push(
      `| ${row.task ?? "all"} | ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.agentMode ?? "n/a"} | ${
        row.selectors.range
      } | ${row.selectors.matcher} | ${row.selectors.wholeSymbol} |`,
    );
  }
  lines.push("");
  lines.push(
    "| Side | Protocol | Agent mode | range | matcher | whole-symbol |",
    "| --- | --- | --- | ---: | ---: | ---: |",
  );
  for (const row of aggregates.bySide) {
    lines.push(
      `| ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.agentMode ?? "n/a"} | ${row.selectors.range} | ${
        row.selectors.matcher
      } | ${row.selectors.wholeSymbol} |`,
    );
  }
  lines.push("");
  lines.push("Resolved cascade stages and matcher kinds (#110):", "");
  lines.push("Per task and side (payloads that resolved at each stage / used each matcher):", "");
  lines.push(
    "| Task | Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const row of aggregates.byTaskSide) {
    lines.push(
      `| ${row.task ?? "all"} | ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.agentMode ?? "n/a"} | ${
        row.stages.wholeSymbol
      } | ${row.stages.match} | ${row.stages.pick} | ${row.matcherKinds.snippet} | ${
        row.matcherKinds.regex
      } |`,
    );
  }
  lines.push("");
  lines.push(
    "| Side | Protocol | Agent mode | whole-symbol | match | pick | snippet | regex |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const row of aggregates.bySide) {
    lines.push(
      `| ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.agentMode ?? "n/a"} | ${row.stages.wholeSymbol} | ${
        row.stages.match
      } | ${row.stages.pick} | ${row.matcherKinds.snippet} | ${row.matcherKinds.regex} |`,
    );
  }
  lines.push("");
  // #111: edit-dsl implicit-create clauses the replies carried.
  lines.push("Implicit creates (#111):", "");
  lines.push(
    "| Task | Side | Protocol | Agent mode | creates |",
    "| --- | --- | --- | --- | ---: |",
  );
  for (const row of aggregates.byTaskSide) {
    lines.push(
      `| ${row.task ?? "all"} | ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.agentMode ?? "n/a"} | ${row.creates} |`,
    );
  }
  lines.push("");
  lines.push("| Side | Protocol | Agent mode | creates |", "| --- | --- | --- | ---: |");
  for (const row of aggregates.bySide) {
    lines.push(
      `| ${row.side ?? "all"} | ${row.protocol ?? "n/a"} | ${row.agentMode ?? "n/a"} | ${row.creates} |`,
    );
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
    "oc `Raw in` excludes them. `Loop billable $` is `billableCost.loop` (tc loop",
    "calls only, the `--budget-usd` basis; n/a for oc), `Billable $` is the",
    "cache-excluded all-calls comparison total, and `Full $` includes cache-hit input.",
    "",
    "| Task | Side | Protocol | Agent mode | Rep | OK | Raw in | Raw out | Raw total | Loop billable $ | Billable $ | Full $ | Steps | Dur (s) |",
    "| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const run of report.runs) {
    const loopCost = run.billableCost?.loop ?? null;
    lines.push(
      `| ${run.task} | ${run.side} | ${run.protocol ?? "n/a"} | ${run.agentMode ?? "n/a"} | ${run.rep} | ${
        run.ok ? "yes" : "no"
      } | ${formatTokenCount(
        run.tokens.input,
      )} | ${formatTokenCount(run.tokens.output)} | ${formatTokenCount(run.tokens.total)} | ${formatUsd(
        loopCost,
      )} | ${formatUsd(run.billableCost?.total ?? null)} | ${formatUsd(
        run.cost,
      )} | ${formatTokenCount(run.steps)} | ${formatSeconds(run.durationMs)} |`,
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
 * Expand the task × side × rep matrix with the tc protocol and loop-mode
 * dimensions (#16). `oc` has no variant: it gets exactly one job per task/rep
 * however many tc variants are selected. The matrix order is canonical; the
 * scheduler groups it by cache-stable prompt prefix before running.
 */
export function buildJobs(
  tasks: readonly TaskName[],
  sides: readonly Side[],
  reps: number,
  protocols: readonly ProtocolFormat[],
  agentModes: readonly AgentMode[] = [DEFAULT_AGENT_MODE],
): BenchmarkJob[] {
  const jobs: BenchmarkJob[] = [];
  for (const task of tasks) {
    for (const side of sides) {
      for (let rep = 1; rep <= reps; rep += 1) {
        if (side === "tc") {
          for (const agentMode of agentModes) {
            for (const protocol of protocols) {
              jobs.push({ task, side, rep, protocol, agentMode });
            }
          }
        } else {
          jobs.push({ task, side, rep, protocol: null, agentMode: null });
        }
      }
    }
  }
  return jobs;
}

interface ScheduledJob {
  readonly index: number;
  readonly job: BenchmarkJob;
}

/**
 * Group jobs by their cache-stable prompt prefix (side + loop mode + protocol).
 * Groups run one at a time so workers do not alternate between different
 * system prompts; first-occurrence order keeps the canonical mode order.
 * Returned indices refer to the original matrix, preserving report order.
 */
export function scheduleJobGroups(jobs: readonly BenchmarkJob[]): ScheduledJob[][] {
  const groups = new Map<string, ScheduledJob[]>();
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    if (job === undefined) {
      continue;
    }
    const key = `${job.side}\u0000${job.agentMode ?? ""}\u0000${job.protocol ?? ""}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
    }
    group.push({ index, job });
  }
  return [...groups.values()];
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
  const tasks: TaskName[] = args.task === null ? [...BENCHMARK_TASKS] : [args.task];
  const sides: Side[] = args.side === "both" ? ["tc", "oc"] : [args.side];
  const reps = args.pilot ? PILOT_REPS : args.reps;
  const protocols = PROTOCOLS;

  const jobs = buildJobs(tasks, sides, reps, protocols, args.agentModes);
  const jobGroups = scheduleJobGroups(jobs);
  const largestGroup = jobGroups.reduce((largest, group) => Math.max(largest, group.length), 0);
  const effectiveConcurrency = Math.min(args.concurrency, largestGroup);

  // The full run on the pilot's date references the pilot report when it has
  // already been written; other days (and missing files) stay null.
  const pilotCandidate = pilotCandidatePath(repoRoot, date, args.pilotJson);

  // #66/#16: pin the measured inputs per variant, so a multi-variant report can
  // be checked against the prompt each result actually measured.
  const provenanceFor = (_protocol: ProtocolFormat, agentMode: AgentMode): RecordedProvenance => ({
    ...currentInputHashes(repoRoot, {
      tasks,
      taskIssues: TASK_SPECS,
      model: args.model,
      agentMode,
      effort: args.effort,
      reps,
      costBudgetUsd: args.costBudgetUsd,
    }),
    computedAt: generatedAt,
  });
  const provenanceByProtocol: Partial<Record<ProtocolFormat, RecordedProvenance>> = {};
  if (args.agentModes.length === 1) {
    for (const protocol of protocols) {
      provenanceByProtocol[protocol] = provenanceFor(protocol, args.agentModes[0] as AgentMode);
    }
  }
  const provenanceByAgentMode: Partial<Record<AgentMode, RecordedProvenance>> = {};
  if (protocols.length === 1) {
    for (const agentMode of args.agentModes) {
      provenanceByAgentMode[agentMode] = provenanceFor(protocols[0] as ProtocolFormat, agentMode);
    }
  }
  const singleProtocol = protocols.length === 1 ? protocols[0] : undefined;
  const singleMode = args.agentModes.length === 1 ? args.agentModes[0] : undefined;
  const scalarProvenance =
    singleProtocol === undefined || singleMode === undefined
      ? null
      : (provenanceByAgentMode[singleMode] ?? provenanceByProtocol[singleProtocol] ?? null);

  const report: Report = {
    generatedAt,
    date,
    mode: args.pilot ? "pilot" : "full",
    tasks,
    sides,
    reps,
    concurrency: effectiveConcurrency,
    model: args.model,
    ocModel: args.ocModel === null || args.ocModel === args.model ? null : args.ocModel,
    effort: args.effort,
    // Scalar for today's single-protocol shape; null when variants are pooled
    // into no row, with the full selection in `protocolFormats` (#16).
    protocolFormat: singleProtocol ?? null,
    protocolFormats: [...protocols],
    agentModes: args.agentModes,
    costBudgetUsd: args.costBudgetUsd,
    bunVersion: Bun.version,
    opencodeVersion: null,
    pilotReference: existsSync(pilotCandidate) ? relative(repoRoot, pilotCandidate) : null,
    infraErrors: [],
    runs: [],
    // Preflight errors write this zeroed aggregate set; the normal path
    // recomputes it from the final runs after the pool.
    aggregates: computeAggregates([], tasks, sides, protocols, args.agentModes),
    // #66: pin the measured inputs from the same tree the runs read, so the
    // record is self-describing.
    provenance: scalarProvenance,
    ...(singleProtocol === undefined ? { provenanceByProtocol } : {}),
    ...(args.agentModes.length > 1 ? { provenanceByAgentMode } : {}),
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

  // Warm only the stable system prefixes; task-specific user prompts stay out
  // of the cache warm-up so the measured runs still exercise cold user turns.
  if (sides.includes("tc")) {
    report.warmups = await warmStablePrefixes({
      model: args.model,
      protocols,
      agentModes: args.agentModes,
    });
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
    costBudgetUsd: args.costBudgetUsd,
    protocols,
    agentModes: args.agentModes,
  };

  // Run one cache-stable prefix group at a time. Workers claim jobs within the
  // group, so one process never alternates between pinned-repair and plan-exec
  // (or between protocols). Completion order only affects interleaved prints;
  // records are placed back in matrix order. A single protocol keeps today's
  // `task side repN` console shape (#16); variants are named only when the
  // matrix measures more than one.
  const showProtocol = protocols.length > 1;
  const showMode = args.agentModes.length > 1;
  const records: (RunRecord | undefined)[] = new Array(jobs.length);
  for (const group of jobGroups) {
    const groupResults = await runPool(
      group,
      Math.min(args.concurrency, group.length),
      async ({ job, index }) => {
        const variant =
          (showProtocol && job.protocol !== null ? ` ${job.protocol}` : "") +
          (job.agentMode !== null && (showMode || modeOf(job.agentMode) !== DEFAULT_AGENT_MODE)
            ? ` ${modeOf(job.agentMode)}`
            : "");
        process.stdout.write(
          `starting ${job.task} ${job.side}${variant} rep${job.rep} (${index + 1}/${jobs.length})\n`,
        );
        const record = await runOnce(job, context);
        printRecord(record, showProtocol, showMode);
        return { index, record };
      },
    );
    for (const result of groupResults) {
      records[result.index] = result.record;
    }
  }

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) {
      throw new Error(`scheduled job ${index + 1} did not produce a result`);
    }
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

  report.aggregates = computeAggregates(report.runs, tasks, sides, protocols, args.agentModes);
  report.cacheWarning = cacheBalanceWarning([
    ...report.aggregates.byTaskSide,
    ...report.aggregates.bySide,
  ]);
  writeReport(jsonPath, report);
  writeMarkdownReport(markdownPathFor(jsonPath), report);
  const ranOpencode = report.aggregates.bySide.some((row) => row.side === "oc");
  if (!ranOpencode) {
    const ocBaseline = loadOcBaseline(repoRoot);
    if (ocBaseline !== null) {
      if (staleBaselineSpec(ocBaseline) !== null) {
        process.stdout.write(
          "baseline: frozen oc baseline uses a different task spec; factors withheld\n",
        );
      } else {
        const savings = savingsVsOcBaseline(report.aggregates.byTaskSide, ocBaseline.byTaskSide);
        if (savings.rows.length > 0) {
          process.stdout.write(`${ocBaselineSavingsSentence(savings)}\n`);
        }
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
