import { applyResolvedRegions, parseCheck } from "./commit";
import type { CommittableRegion, RegionFailureNote } from "./commit";
import { renderDslIssues } from "./dsl-diagnostics";
import { renderViewerFeedback } from "./edit-dsl";
import type { EditDslFailure, EditDslViewer } from "./edit-dsl";
import { renderReadFailureFeedback, renderReadFeedback, resolveMultiEditor } from "./multi-editor";
import type { MultiEditorRead, MultiEditorResolution } from "./multi-editor";
import { resolveCurrentEntry } from "./resolve-entry";
import { parseMultiEditorDetailed } from "./selection";
import type { EditStatement } from "./selection";
import type { Locator } from "./utility";
import { createWorkspace } from "./workspace";
import { unifiedDiff } from "./unified-diff";
import type { Workspace } from "./workspace";

export interface EditDslOptions {
  /** Workspace root. Must exist and be a directory. */
  cwd: string;
  /** Workspace-relative paths that are always read-only. Defaults to ["human"]. */
  protectedPaths?: readonly string[];
  /** Resolve and validate mutations, but do not write anything. */
  dryRun?: boolean;
  /** Include per-file unified diffs in a dry-run result. Requires `dryRun`. */
  diff?: boolean;
}

export interface EditDslReadResult {
  ok: boolean;
  reads: MultiEditorRead[];
  viewers: EditDslViewer[];
  failures: EditDslFailure[];
  readFailures: EditDslFailure[];
  /** Rendered human/model-facing feedback; empty when there is nothing to show. */
  text: string;
}

export interface EditDslDiff {
  path: string;
  diff: string;
}

export interface EditDslApplyResult extends EditDslReadResult {
  changed: string[];
  created: string[];
  deleted: string[];
  /** Sorted per-file unified diffs; empty unless a dry run requested them. */
  diffs: EditDslDiff[];
}

type ParsedReply = { ok: true; statements: EditStatement[] } | { ok: false; text: string };

interface MutationClause {
  index: number;
  path: string;
  locator: Locator;
  label: string;
}

function parseReply(text: string): ParsedReply {
  const parsed = parseMultiEditorDetailed(text);
  if (!parsed.ok) {
    return { ok: false, text: renderDslIssues(parsed.issues) };
  }
  return { ok: true, statements: parsed.value ?? [] };
}

function syntheticLocator(path: string): Locator {
  return { path, name: "", kind: "" };
}

function protocolFailure(
  index: number,
  path: string,
  locator: Locator,
  detail: string,
): EditDslFailure {
  return {
    index,
    path,
    locator,
    stage: "protocol",
    cause: null,
    diagnostics: `stage: protocol\n${detail}`,
    undeclaredName: null,
  };
}

function commitNoteFailure(note: RegionFailureNote<CommittableRegion>): EditDslFailure {
  return {
    index: note.region.index,
    path: note.path,
    locator: note.region.locator,
    stage: note.stage,
    cause: null,
    diagnostics: note.diagnostics,
    undeclaredName: null,
  };
}

function overlapFailure(
  path: string,
  earlier: CommittableRegion,
  later: CommittableRegion,
): EditDslFailure {
  return protocolFailure(
    later.index,
    path,
    later.locator,
    `clause ${earlier.index + 1} and clause ${later.index + 1} both edit ${JSON.stringify(
      path,
    )} but their regions overlap; the whole reply was rejected and nothing was written`,
  );
}

function mutationClauses(statements: readonly EditStatement[]): MutationClause[] {
  const mutations: MutationClause[] = [];
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (statement === undefined) {
      continue;
    }
    if (statement.type === "editor") {
      const selection = statement.selection;
      const rename = selection.rename;
      if (selection.replacement === null && (rename === undefined || rename === null)) {
        continue;
      }
      mutations.push({
        index,
        path: selection.locator.path,
        locator: selection.locator,
        label:
          rename === undefined || rename === null
            ? "edit"
            : `rename ${rename.from} to ${rename.to}`,
      });
      continue;
    }
    const fs = statement.statement;
    if (fs.op === "read") {
      continue;
    }
    let label: string;
    switch (fs.op) {
      case "create":
        label = "create";
        break;
      case "create-declaration":
      case "create-module":
        label = `create ${fs.kind}`;
        break;
      case "delete":
        label = "delete";
        break;
      case "write":
        label = "write";
        break;
    }
    mutations.push({ index, path: fs.path, locator: syntheticLocator(fs.path), label });
  }
  return mutations;
}

function resolveReply(
  statements: readonly EditStatement[],
  workspace: Workspace,
): MultiEditorResolution {
  return resolveMultiEditor(statements, {
    sourceFor: (path) => workspace.sourceFor(path),
    fileExists: (path) => workspace.fileExists(path),
    pathExists: (path) => workspace.pathExists(path),
    isSafePath: (path) => workspace.isSafePath(path),
    listFiles: () => workspace.listFiles(),
    resolveEntry: (source, path, locator, space) =>
      resolveCurrentEntry(source, path, locator, space),
  });
}

function combineText(
  failures: readonly EditDslFailure[],
  viewers: readonly EditDslViewer[],
  reads: readonly MultiEditorRead[],
  readFailures: readonly EditDslFailure[],
): string {
  const blocks: string[] = [];
  if (failures.length > 0) {
    blocks.push(failures.map((failure) => failure.diagnostics).join("\n\n"));
  }
  if (viewers.length > 0) {
    blocks.push(renderViewerFeedback(viewers));
  }
  if (reads.length > 0) {
    blocks.push(renderReadFeedback(reads));
  }
  if (readFailures.length > 0) {
    blocks.push(renderReadFailureFeedback(readFailures));
  }
  return blocks.join("\n\n");
}

function emptyReadResult(): EditDslReadResult {
  return {
    ok: false,
    reads: [],
    viewers: [],
    failures: [],
    readFailures: [],
    text: "",
  };
}

function emptyApplyResult(): EditDslApplyResult {
  return { ...emptyReadResult(), changed: [], created: [], deleted: [], diffs: [] };
}

function applyFailureResult(
  resolution: MultiEditorResolution,
  failures: readonly EditDslFailure[],
): EditDslApplyResult {
  return {
    ok: false,
    reads: resolution.reads,
    viewers: resolution.viewers,
    failures: [...failures],
    readFailures: resolution.readFailures,
    text: combineText(failures, resolution.viewers, resolution.reads, resolution.readFailures),
    changed: [],
    created: [],
    deleted: [],
    diffs: [],
  };
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function planDiffs(
  writePlan: ReadonlyMap<string, { source: string }>,
  deletePlan: ReadonlySet<string>,
  originals: ReadonlyMap<string, { exists: boolean; source: string }>,
): EditDslDiff[] {
  const paths = [...new Set([...writePlan.keys(), ...deletePlan])].sort(comparePaths);
  return paths.map((path) => {
    const original = originals.get(path);
    const planned = writePlan.get(path);
    const deleting = deletePlan.has(path);
    const diff = unifiedDiff({
      path,
      oldSource: original?.source ?? "",
      newSource: deleting ? "" : (planned?.source ?? ""),
      oldMissing: original?.exists !== true,
      newMissing: deleting,
    });
    return { path, diff };
  });
}

/**
 * Resolve a reply's `read` commands and viewers without mutating the workspace.
 * Editor/create/delete/write/rename clauses are rejected with a `stage:
 * protocol` diagnostic because this mode is read-only.
 */
export async function readEditDsl(
  text: string,
  options: EditDslOptions,
): Promise<EditDslReadResult> {
  const workspace = createWorkspace(options);
  const parsed = parseReply(text);
  if (!parsed.ok) {
    return { ...emptyReadResult(), text: parsed.text };
  }
  const resolution = resolveReply(parsed.statements, workspace);
  const protocolFailures = mutationClauses(parsed.statements).map((mutation) =>
    protocolFailure(
      mutation.index,
      mutation.path,
      mutation.locator,
      `readEditDsl is read-only: clause ${mutation.index + 1} is a ${mutation.label} mutation, so the reply was rejected; use applyEditDsl to change files`,
    ),
  );
  const failures = [...resolution.failures, ...protocolFailures];
  return {
    ok: failures.length === 0,
    reads: resolution.reads,
    viewers: resolution.viewers,
    failures,
    readFailures: resolution.readFailures,
    text: combineText(failures, resolution.viewers, resolution.reads, resolution.readFailures),
  };
}

/**
 * Resolve and apply a reply atomically. A parse failure, any resolution
 * failure, any apply failure, or a no-op discards every write. A failed `read`
 * is feedback and never discards a clean mutation. With `dryRun`, the same
 * pipeline runs but no write/create/delete method is called; the returned
 * `changed`/`created`/`deleted` arrays describe what would happen.
 */
export async function applyEditDsl(
  text: string,
  options: EditDslOptions,
): Promise<EditDslApplyResult> {
  const workspace = createWorkspace(options);
  if (options.diff === true && options.dryRun !== true) {
    const failure = protocolFailure(
      0,
      "",
      syntheticLocator(""),
      "the diff option is preview-only: set dryRun: true with diff; nothing was written",
    );
    return { ...emptyApplyResult(), failures: [failure], text: failure.diagnostics };
  }
  const parsed = parseReply(text);
  if (!parsed.ok) {
    return { ...emptyApplyResult(), text: parsed.text };
  }
  const statements = parsed.statements;
  const resolution = resolveReply(statements, workspace);
  if (resolution.failures.length > 0) {
    return applyFailureResult(resolution, resolution.failures);
  }

  const regions: CommittableRegion[] = resolution.regions.map((region) => ({
    index: region.index,
    path: region.path,
    locator: region.locator,
    start: region.start,
    end: region.end,
    text: region.text,
    replacement: region.text,
    create: region.create,
  }));

  let writes: { path: string; source: string }[] = [];
  if (regions.length > 0) {
    const target = regions[0]?.path;
    if (target === undefined) {
      return applyFailureResult(resolution, [
        protocolFailure(0, "", syntheticLocator(""), "the resolved edit has no target path"),
      ]);
    }
    let targetSource: string;
    try {
      targetSource = workspace.sourceFor(target);
    } catch (error) {
      return applyFailureResult(resolution, [
        protocolFailure(
          0,
          target,
          syntheticLocator(target),
          `cannot read ${JSON.stringify(target)}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ]);
    }
    const applyFailures: EditDslFailure[] = [];
    try {
      const output = await applyResolvedRegions({
        regions,
        fileSourceOf: (path) => workspace.sourceFor(path),
        target,
        prevCheck: parseCheck(targetSource),
        // Multiple create clauses legitimately append at one offset.
        policy: { sameOffsetInserts: "append" },
        noteFailure: (note) => {
          applyFailures.push(commitNoteFailure(note));
        },
        noteOverlap: (path, earlier, later) => {
          applyFailures.push(overlapFailure(path, earlier, later));
        },
      });
      if (applyFailures.length > 0) {
        return applyFailureResult(resolution, applyFailures);
      }
      writes = output;
    } catch (error) {
      return applyFailureResult(resolution, [
        protocolFailure(
          0,
          target,
          syntheticLocator(target),
          `the edit could not be applied: ${error instanceof Error ? error.message : String(error)}; nothing was written`,
        ),
      ]);
    }
  }

  interface WritePlan {
    source: string;
    emptyCreate: boolean;
  }

  const writePlan = new Map<string, WritePlan>();
  for (const write of writes) {
    writePlan.set(write.path, { source: write.source, emptyCreate: false });
  }
  const preflightFailures: EditDslFailure[] = [];
  for (const create of resolution.creates) {
    if (writePlan.has(create.path)) {
      preflightFailures.push(
        protocolFailure(
          create.index,
          create.path,
          syntheticLocator(create.path),
          `create ${JSON.stringify(create.path)} conflicts with another write to the same path; nothing was written`,
        ),
      );
      continue;
    }
    writePlan.set(create.path, { source: "", emptyCreate: true });
  }
  const deletePlan = new Set(resolution.deletes.map((deletion) => deletion.path));
  for (const [path, plan] of writePlan) {
    if (deletePlan.has(path)) {
      preflightFailures.push(
        protocolFailure(
          0,
          path,
          syntheticLocator(path),
          `write ${JSON.stringify(path)} conflicts with a delete of the same path; nothing was written`,
        ),
      );
      continue;
    }
    if (!workspace.isSafePath(path)) {
      preflightFailures.push(
        protocolFailure(
          0,
          path,
          syntheticLocator(path),
          `the path ${JSON.stringify(path)} is outside the editable workspace; nothing was written`,
        ),
      );
      continue;
    }
    if (plan.emptyCreate && workspace.fileExists(path)) {
      preflightFailures.push(
        protocolFailure(
          0,
          path,
          syntheticLocator(path),
          `cannot create ${JSON.stringify(path)}: the file already exists; nothing was written`,
        ),
      );
    }
  }
  for (const path of deletePlan) {
    if (!workspace.isSafePath(path)) {
      preflightFailures.push(
        protocolFailure(
          0,
          path,
          syntheticLocator(path),
          `the path ${JSON.stringify(path)} is outside the editable workspace; nothing was written`,
        ),
      );
      continue;
    }
    if (!workspace.fileExists(path)) {
      preflightFailures.push(
        protocolFailure(
          0,
          path,
          syntheticLocator(path),
          `cannot delete ${JSON.stringify(path)}: the file does not exist; nothing was written`,
        ),
      );
    }
  }
  if (preflightFailures.length > 0) {
    return applyFailureResult(resolution, preflightFailures);
  }

  // Capture every original before the first mutation so a failed write can be
  // rolled back to the pre-reply state.
  const originals = new Map<string, { exists: boolean; source: string }>();
  try {
    for (const path of [...writePlan.keys(), ...deletePlan]) {
      if (originals.has(path)) {
        continue;
      }
      const exists = workspace.fileExists(path);
      originals.set(path, { exists, source: exists ? workspace.sourceFor(path) : "" });
    }
  } catch (error) {
    return applyFailureResult(resolution, [
      protocolFailure(
        0,
        "",
        syntheticLocator(""),
        `cannot snapshot the workspace before writing: ${error instanceof Error ? error.message : String(error)}; nothing was written`,
      ),
    ]);
  }

  const writesToApply = [...writePlan.entries()].sort(([left], [right]) =>
    comparePaths(left, right),
  );
  const deletesToApply = [...deletePlan].sort(comparePaths);

  // The plan is final at this point: preflight passed and `originals` records
  // which paths already existed, so it describes an apply without performing one.
  const changed: string[] = [];
  const created: string[] = [];
  for (const [path, plan] of writePlan) {
    changed.push(path);
    if (plan.emptyCreate || originals.get(path)?.exists === false) {
      created.push(path);
    }
  }
  const deleted = [...deletePlan];
  const result: EditDslApplyResult = {
    ok: true,
    reads: resolution.reads,
    viewers: resolution.viewers,
    failures: [],
    readFailures: resolution.readFailures,
    text: combineText([], resolution.viewers, resolution.reads, resolution.readFailures),
    changed: changed.sort(comparePaths),
    created: created.sort(comparePaths),
    deleted: deleted.sort(comparePaths),
    diffs: [],
  };

  // A dry run stops before any mutation method: the result is the plan above.
  if (options.dryRun === true) {
    if (options.diff === true) {
      result.diffs = planDiffs(writePlan, deletePlan, originals);
    }
    return result;
  }

  const applied: { path: string; kind: "write" | "create" | "delete" }[] = [];
  let inFlight: { path: string; kind: "write" | "create" | "delete" } | null = null;
  try {
    for (const [path, plan] of writesToApply) {
      const change = { path, kind: plan.emptyCreate ? "create" : "write" } as const;
      inFlight = change;
      if (plan.emptyCreate) {
        workspace.createEmptyFile(path);
      } else {
        workspace.writeFile(path, plan.source);
      }
      applied.push(change);
      inFlight = null;
    }
    for (const path of deletesToApply) {
      const change = { path, kind: "delete" } as const;
      inFlight = change;
      workspace.deleteFile(path);
      applied.push(change);
      inFlight = null;
    }
  } catch (error) {
    const rollbackProblems: string[] = [];
    const candidates = [...applied];
    if (inFlight !== null && !candidates.some((change) => change.path === inFlight?.path)) {
      candidates.push(inFlight);
    }
    for (const change of [...candidates].reverse()) {
      const original = originals.get(change.path);
      try {
        if (original?.exists === true) {
          // The in-flight operation may have failed before touching the file
          // (for example, a permission error); only rewrite it when its
          // contents actually differ from the snapshot. This avoids treating
          // an unwritable, unchanged file as a rollback failure.
          let current: string | null = null;
          try {
            current = workspace.fileExists(change.path) ? workspace.sourceFor(change.path) : null;
          } catch {
            current = null;
          }
          if (current !== original.source) {
            workspace.writeFile(change.path, original.source);
          }
        } else if (workspace.fileExists(change.path)) {
          workspace.deleteFile(change.path);
        }
      } catch (rollbackError) {
        rollbackProblems.push(
          `${change.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    const detail = [
      `a filesystem operation failed: ${error instanceof Error ? error.message : String(error)}`,
      rollbackProblems.length === 0
        ? "every change already applied was rolled back; nothing was written"
        : `rollback was incomplete: ${rollbackProblems.join("; ")}`,
    ].join("\n");
    return applyFailureResult(resolution, [
      protocolFailure(0, inFlight?.path ?? "", syntheticLocator(inFlight?.path ?? ""), detail),
    ]);
  }

  return result;
}
