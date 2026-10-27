// Provenance pinning for benchmark result records (#66).
//
// A benchmark number is comparable only against numbers measured on the same
// fixture text, model-facing prompt text, loop configuration, and pricing
// table. This module turns each of those measured inputs into a content hash so
// a stale record is detectable mechanically.
//
// Hashing rules:
// - Per-input sha256 hex digests: `model`, `taskIssue` (the frozen task spec text,
//   keyed by task), `fixture` (the fixture's on-disk content, keyed by task and
//   relative path), `systemPrompt` (`buildSystemPrompt()`), `loopConfig`
//   (USD budget/effort/reps), and `pricing` (the peak rate table plus
//   `PRICING_FETCHED_ON`).
// - Text pieces are newline-normalized to `\n`; object pieces are serialized
//   through a stable (recursively key-sorted) JSON encoding.
// - `inputHash` is sha256 over the stable JSON of the per-input digest object.
//
// `computeInputHashes` hashes precomputed pieces (used by `benchmark/run.ts`);
// `currentInputHashes` reads the same pieces from the current tree.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PEAK_RATES_PER_MILLION, PRICING_FETCHED_ON } from "./pricing";
import {
  DEFAULT_COST_BUDGET_USD,
  MAX_STALLED_ROUNDS,
  buildSystemPrompt,
  canonicalAgentMode,
} from "./loop";
import type { AgentMode } from "./loop";
import { buildTaskExecutionSystemPrompt, buildTaskPlanningSystemPrompt } from "./prompts/task";

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
  readonly costBudgetUsd: number;
  readonly maxStalledRounds: number;
  readonly effort: string;
  readonly reps: number;
  /**
   * Pinned-repair termination model. It ends on success, the USD cost budget,
   * a repeated no-progress fingerprint, or a no-progress STOP.
   */
  readonly scheduling?: "cost-budget+no-progress";
  /** Plan-exec loop marker. */
  readonly agentMode?: "plan-exec";
  /** The plan-exec graph protocol. */
  readonly planExec?: "work-dag";
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
  /** Cache-excluded USD budget, or null for `DEFAULT_COST_BUDGET_USD`. */
  readonly costBudgetUsd?: number | null;
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

/** The current peak-price rate table plus its fetch date (see `src/pricing.ts`). */
export function pricingTable(): unknown {
  return {
    fetchedOn: PRICING_FETCHED_ON,
    rates: PEAK_RATES_PER_MILLION,
  };
}

/** Loop budget/effort/reps (#66): the knobs that make a run comparable. */
export function loopConfigHashInput(options: {
  costBudgetUsd?: number | null;
  effort: string | null;
  reps: number;
  agentMode?: AgentMode;
}): LoopConfig {
  const base: LoopConfig = {
    costBudgetUsd: options.costBudgetUsd ?? DEFAULT_COST_BUDGET_USD,
    maxStalledRounds: MAX_STALLED_ROUNDS,
    effort: options.effort ?? "none",
    reps: options.reps,
  };
  return canonicalAgentMode(options.agentMode) === "plan-exec"
    ? {
        ...base,
        agentMode: "plan-exec",
        planExec: "work-dag",
      }
    : { ...base, scheduling: "cost-budget+no-progress" };
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
      costBudgetUsd: options.costBudgetUsd ?? null,
      effort: options.effort,
      reps: options.reps,
      agentMode: options.agentMode,
    }),
    pricing: pricingTable(),
  });
}
