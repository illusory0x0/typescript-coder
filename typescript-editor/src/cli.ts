#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { applyEditDsl, readEditDsl } from "./api";
import type { EditDslApplyResult, EditDslReadResult } from "./api";
import { EditProtocolError, parseJsonEditRequest, renderEditRequest } from "./protocol";
import type { EditOperation, EditRequest } from "./protocol";
import type { ProtocolFormat, TsedArgs } from "../scs/generated/tsed";
import {
  HelpRequested,
  UsageError,
  VersionRequested,
  helpText,
  parse,
  usage,
} from "../scs/generated/tsed.runtime";

const NAME = "tsed";
const VERSION = "0.0.0";

type StdinFormat = Exclude<ProtocolFormat, "flag">;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usageFailure(message: string): number {
  process.stderr.write(`${NAME}: ${message}\n${usage()}\n`);
  return 2;
}

function resolvePayloadPath(path: string, workspaceRoot: string): string {
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

function readFileArg(path: string, label: string, workspaceRoot: string): string {
  const resolved = resolvePayloadPath(path, workspaceRoot);
  try {
    return readFileSync(resolved, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read ${label} ${JSON.stringify(resolved)}: ${messageOf(error)}`);
  }
}

const NATIVE_FLAGS: readonly { flag: string; used: (values: TsedArgs) => boolean }[] = [
  { flag: "--read", used: (values) => (values.read ?? []).length > 0 },
  { flag: "--select", used: (values) => values.select !== undefined },
  { flag: "--in", used: (values) => values.input !== undefined },
  { flag: "--kind", used: (values) => values.kind !== undefined },
  { flag: "--resolve", used: (values) => values.resolve !== undefined },
  { flag: "--match", used: (values) => values.match !== undefined },
  { flag: "--pick", used: (values) => values.pick !== undefined },
  { flag: "--within", used: (values) => values.within !== undefined },
  { flag: "--replace-file", used: (values) => values.replace_file !== undefined },
  { flag: "--rename", used: (values) => values.rename !== undefined },
  { flag: "--create", used: (values) => (values.create ?? []).length > 0 },
  { flag: "--delete", used: (values) => (values.delete ?? []).length > 0 },
  { flag: "--rewrite", used: (values) => values.rewrite !== undefined },
  { flag: "--content-file", used: (values) => values.content_file !== undefined },
];

function rejectNativeFlags(values: TsedArgs, format: StdinFormat): void {
  const used = NATIVE_FLAGS.filter((entry) => entry.used(values)).map((entry) => entry.flag);
  if (used.length > 0) {
    throw new UsageError(
      `${used.join(", ")} cannot be used with --protocol-format ${format}; ` +
        "pass the operations in the stdin payload instead",
    );
  }
}

function readStdin(format: StdinFormat): string {
  if (process.stdin.isTTY === true) {
    throw new UsageError(`--protocol-format ${format} reads its payload from stdin`);
  }
  const text = readFileSync(0, "utf8");
  if (text.trim() === "") {
    throw new UsageError(`--protocol-format ${format} requires a non-empty payload on stdin`);
  }
  return text;
}

function renderFlagRequest(values: TsedArgs, workspaceRoot: string): string {
  if (values.within !== undefined) {
    const mutatingFlags: string[] = [];
    if (values.replace_file !== undefined) {
      mutatingFlags.push("--replace-file");
    }
    if (values.rename !== undefined) {
      mutatingFlags.push("--rename");
    }
    if ((values.create ?? []).length > 0) {
      mutatingFlags.push("--create");
    }
    if ((values.delete ?? []).length > 0) {
      mutatingFlags.push("--delete");
    }
    if (values.rewrite !== undefined) {
      mutatingFlags.push("--rewrite");
    }
    if (mutatingFlags.length > 0) {
      throw new UsageError(
        `--within is viewer-only; it cannot be combined with ${mutatingFlags.join(", ")}`,
      );
    }
    if ((values.read ?? []).length === 0 && values.select === undefined) {
      throw new UsageError("--within requires --read or --select");
    }
  }
  const selectOnly: readonly { flag: string; present: boolean }[] = [
    { flag: "--kind", present: values.kind !== undefined },
    { flag: "--resolve", present: values.resolve !== undefined },
    { flag: "--match", present: values.match !== undefined },
    { flag: "--pick", present: values.pick !== undefined },
    { flag: "--replace-file", present: values.replace_file !== undefined },
    { flag: "--rename", present: values.rename !== undefined },
  ];
  for (const entry of selectOnly) {
    if (entry.present && values.select === undefined) {
      throw new UsageError(`${entry.flag} requires --select`);
    }
  }
  if (values.input !== undefined && values.select === undefined) {
    throw new UsageError("--in requires --select");
  }
  if (values.select !== undefined && values.input === undefined) {
    throw new UsageError("--select requires --in <PATH>");
  }
  if (values.replace_file !== undefined && values.rename !== undefined) {
    throw new UsageError("--replace-file and --rename are mutually exclusive");
  }

  let rewriteContent: string | undefined;
  if (values.rewrite !== undefined) {
    if (values.content_file === undefined) {
      throw new UsageError("--rewrite requires --content-file <FILE>");
    }
    rewriteContent = readFileArg(values.content_file, "content file", workspaceRoot);
  } else if (values.content_file !== undefined) {
    throw new UsageError("--content-file requires --rewrite <PATH>");
  }

  const mutating =
    values.replace_file !== undefined ||
    values.rename !== undefined ||
    (values.create ?? []).length > 0 ||
    (values.delete ?? []).length > 0 ||
    values.rewrite !== undefined;
  if (mutating && !values.write && !values.dry_run) {
    throw new UsageError(
      "the requested operation mutates a workspace file; pass --write to apply it or --dry-run to preview it",
    );
  }
  if ((values.write || values.dry_run) && !mutating) {
    const mode = values.write ? "--write" : "--dry-run";
    throw new UsageError(
      `${mode} requires a mutation (--replace-file, --rename, --create, --delete, or --rewrite)`,
    );
  }

  const operations: EditOperation[] = [];
  for (const path of values.read ?? []) {
    const operation: Extract<EditOperation, { op: "read" }> = { op: "read", path };
    if (values.within !== undefined) {
      operation.within = values.within;
    }
    operations.push(operation);
  }
  for (const path of values.create ?? []) {
    operations.push({ op: "create", path });
  }
  for (const path of values.delete ?? []) {
    operations.push({ op: "delete", path });
  }
  if (values.rewrite !== undefined && rewriteContent !== undefined) {
    operations.push({ op: "rewrite", path: values.rewrite, content: rewriteContent });
  }
  if (values.select !== undefined && values.input !== undefined) {
    const selection: Extract<EditOperation, { op: "select" }> = {
      op: "select",
      symbol: values.select,
      path: values.input,
    };
    if (values.kind !== undefined) {
      selection.kind = values.kind;
    }
    if (values.resolve !== undefined) {
      selection.resolve = values.resolve;
    }
    if (values.within !== undefined) {
      selection.within = values.within;
    }
    if (values.match !== undefined) {
      selection.match = values.match;
    }
    if (values.pick !== undefined) {
      selection.pick = values.pick;
    }
    if (values.rename !== undefined) {
      selection.rename = values.rename;
    }
    if (values.replace_file !== undefined) {
      selection.replace = readFileArg(values.replace_file, "replacement file", workspaceRoot);
    }
    operations.push(selection);
  }

  const request: EditRequest = { operations };
  return renderEditRequest(request);
}

function buildPayload(values: TsedArgs, workspaceRoot: string): string {
  if (values.write && values.dry_run) {
    throw new UsageError("--write and --dry-run are mutually exclusive");
  }
  const format = values.protocol_format;
  if (format === "flag") {
    return renderFlagRequest(values, workspaceRoot);
  }
  rejectNativeFlags(values, format);
  const text = readStdin(format);
  return format === "dsl" ? text : renderEditRequest(parseJsonEditRequest(text));
}

type ReportMode = "read" | "apply" | "preview";

const PLAN_PREFIXES: Readonly<
  Record<Exclude<ReportMode, "read">, { changed: string; created: string; deleted: string }>
> = {
  apply: { changed: "changed", created: "created", deleted: "deleted" },
  preview: { changed: "would change", created: "would create", deleted: "would delete" },
};

function reportResult(result: EditDslReadResult | EditDslApplyResult, mode: ReportMode): number {
  const failed = !result.ok || result.readFailures.length > 0;
  if (result.text !== "") {
    const stream = failed ? process.stderr : process.stdout;
    stream.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  }
  // A preview shows no plan for a failed run; an apply keeps its existing
  // behavior (its plan arrays are empty on a hard failure anyway).
  if (mode !== "read" && (mode === "apply" || !failed)) {
    const prefixes = PLAN_PREFIXES[mode];
    const apply = result as EditDslApplyResult;
    for (const path of [...apply.changed].sort()) {
      process.stdout.write(`${prefixes.changed}: ${path}\n`);
    }
    for (const path of [...apply.created].sort()) {
      process.stdout.write(`${prefixes.created}: ${path}\n`);
    }
    for (const path of [...apply.deleted].sort()) {
      process.stdout.write(`${prefixes.deleted}: ${path}\n`);
    }
  }
  return failed ? 1 : 0;
}

function reportError(error: unknown): number {
  if (error instanceof HelpRequested) {
    process.stdout.write(`${helpText(error.command)}\n`);
    return 0;
  }
  if (error instanceof VersionRequested) {
    process.stdout.write(`${NAME} ${VERSION}\n`);
    return 0;
  }
  if (error instanceof UsageError || error instanceof EditProtocolError) {
    return usageFailure(error.message);
  }
  if (error instanceof Error) {
    return usageFailure(error.message);
  }
  throw error;
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const parsed = parse([...argv]);
    const values = parsed.values as unknown as TsedArgs;
    const cwd = resolve(values.directory ?? process.cwd());
    const payload = buildPayload(values, cwd);
    const options = { cwd, ...(values.dry_run ? { dryRun: true } : {}) };
    if (values.write || values.dry_run) {
      const result = await applyEditDsl(payload, options);
      return reportResult(result, values.dry_run ? "preview" : "apply");
    }
    const result = await readEditDsl(payload, options);
    return reportResult(result, "read");
  } catch (error) {
    return reportError(error);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}

export { buildPayload, main };
