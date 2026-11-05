#!/usr/bin/env bun
import { readFileSync } from "node:fs";
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

function readFileArg(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read ${label} ${JSON.stringify(path)}: ${messageOf(error)}`);
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

function renderFlagRequest(values: TsedArgs): string {
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
    rewriteContent = readFileArg(values.content_file, "content file");
  } else if (values.content_file !== undefined) {
    throw new UsageError("--content-file requires --rewrite <PATH>");
  }

  const mutating =
    values.replace_file !== undefined ||
    values.rename !== undefined ||
    (values.create ?? []).length > 0 ||
    (values.delete ?? []).length > 0 ||
    values.rewrite !== undefined;
  if (mutating && !values.write) {
    throw new UsageError(
      "the requested operation mutates a workspace file; pass --write to apply it",
    );
  }
  if (values.write && !mutating) {
    throw new UsageError(
      "--write requires a mutation (--replace-file, --rename, --create, --delete, or --rewrite)",
    );
  }

  const operations: EditOperation[] = [];
  for (const path of values.read ?? []) {
    operations.push({ op: "read", path });
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
      selection.replace = readFileArg(values.replace_file, "replacement file");
    }
    operations.push(selection);
  }

  const request: EditRequest = { operations };
  return renderEditRequest(request);
}

function buildPayload(values: TsedArgs): string {
  const format = values.protocol_format;
  if (format === "flag") {
    return renderFlagRequest(values);
  }
  rejectNativeFlags(values, format);
  const text = readStdin(format);
  return format === "dsl" ? text : renderEditRequest(parseJsonEditRequest(text));
}

function reportResult(result: EditDslReadResult | EditDslApplyResult, applied: boolean): number {
  const failed = !result.ok || result.readFailures.length > 0;
  if (result.text !== "") {
    const stream = failed ? process.stderr : process.stdout;
    stream.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  }
  if (applied) {
    const apply = result as EditDslApplyResult;
    for (const path of [...apply.changed].sort()) {
      process.stdout.write(`changed: ${path}\n`);
    }
    for (const path of [...apply.created].sort()) {
      process.stdout.write(`created: ${path}\n`);
    }
    for (const path of [...apply.deleted].sort()) {
      process.stdout.write(`deleted: ${path}\n`);
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
    const payload = buildPayload(values);
    const options = { cwd: values.directory ?? process.cwd() };
    if (values.write) {
      const result = await applyEditDsl(payload, options);
      return reportResult(result, true);
    }
    const result = await readEditDsl(payload, options);
    return reportResult(result, false);
  } catch (error) {
    return reportError(error);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}

export { buildPayload, main };
