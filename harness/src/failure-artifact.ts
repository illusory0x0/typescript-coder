import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoopResult } from "./loop";

export interface FailureArtifactOptions {
  /** Directory that receives the `failures/` subdirectory (the repo root). */
  rootDir: string;
  result: LoopResult;
  /** Optional provenance line, e.g. `benchmark json-parser ts rep2`. */
  context?: string;
  /** Clock override for tests; defaults to now. */
  now?: Date;
}

export interface FailureArchiveOptions {
  /** Directory that holds the `failures/` subdirectory (the repo root). */
  rootDir: string;
  /** Clock override for tests; defaults to now. */
  now?: Date;
}

export interface FailureArchive {
  /** Directory that received the rotated artifacts. */
  archiveDir: string;
  /** Number of artifacts moved out of `failures/`. */
  moved: number;
}

function stampFor(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

// A fence wide enough to wrap content that itself contains backtick fences.
function fenceFor(text: string): string {
  let fence = "```";
  while (text.includes(fence)) {
    fence += "`";
  }
  return fence;
}

function fenced(text: string): string {
  const fence = fenceFor(text);
  return `${fence}\n${text}\n${fence}`;
}

/**
 * Renders the markdown body of one failed run (#43): termination reason,
 * pinned target, staged diagnostics, and the LLM-written summary. Pure so the
 * CLI, the benchmark runner, and tests render identical artifacts.
 */
export function renderFailureArtifact(options: FailureArtifactOptions): string {
  const { result } = options;
  const reason = result.terminationReason ?? "unknown";
  const exchanges = result.records.filter((record) => record.kind === "exchange").length;
  const verifications = result.records.length - exchanges;
  const lines = [
    `# Run failure — ${reason}`,
    "",
    `- finished: ${(options.now ?? new Date()).toISOString()}`,
  ];
  if (options.context !== undefined && options.context !== "") {
    lines.push(`- context: ${options.context}`);
  }
  lines.push(
    `- mode: ${result.mode ?? "none"}`,
    `- file: ${result.filePath ?? "none"}`,
    `- locator: ${result.locator === null ? "none" : JSON.stringify(result.locator)}`,
    `- records: ${result.records.length} (exchanges ${exchanges}, verifications ${verifications})`,
    "",
    "## Diagnostics",
    "",
  );
  lines.push(
    fenced(result.diagnostics === null ? "no diagnostics recorded" : result.diagnostics),
    "",
    "## Summary",
    "",
    result.explanation === null ? "no summary recorded" : result.explanation,
    "",
  );
  return lines.join("\n");
}

/**
 * Writes a failure artifact under `<rootDir>/failures/` (#43) whenever a run
 * ended through the termination matrix. Returns the artifact path, or null
 * when the run has no termination reason (success or a provider error).
 */
export function writeFailureArtifact(options: FailureArtifactOptions): string | null {
  if (options.result.ok || options.result.terminationReason === undefined) {
    return null;
  }
  const dir = join(options.rootDir, "failures");
  mkdirSync(dir, { recursive: true });
  const base = `${stampFor(options.now ?? new Date())}-${options.result.terminationReason}`;
  let path = join(dir, `${base}.md`);
  for (let suffix = 2; existsSync(path); suffix += 1) {
    path = join(dir, `${base}-${suffix}.md`);
  }
  writeFileSync(path, renderFailureArtifact(options));
  return path;
}

/**
 * Rotates every artifact under `<rootDir>/failures/` into
 * `<rootDir>/tmp/failures-archive/<stamp>/` (#51) so a benchmark matrix starts
 * from a clean `failures/` holding only its own round. Uses the same stamp
 * convention as `writeFailureArtifact` so archive directories sort
 * lexicographically; an existing archive directory is suffixed, never merged.
 * Returns null when `failures/` is absent or empty.
 */
export function archiveFailureArtifacts(options: FailureArchiveOptions): FailureArchive | null {
  const sourceDir = join(options.rootDir, "failures");
  if (!existsSync(sourceDir)) {
    return null;
  }
  const names = readdirSync(sourceDir);
  if (names.length === 0) {
    return null;
  }
  const base = join(
    options.rootDir,
    "tmp",
    "failures-archive",
    stampFor(options.now ?? new Date()),
  );
  let archiveDir = base;
  for (let suffix = 2; existsSync(archiveDir); suffix += 1) {
    archiveDir = `${base}-${suffix}`;
  }
  mkdirSync(archiveDir, { recursive: true });
  for (const name of names) {
    renameSync(join(sourceDir, name), join(archiveDir, name));
  }
  return { archiveDir, moved: names.length };
}
