import { applyEditDsl, readEditDsl } from "./api";
import type { EditDslFailure, EditDslViewer } from "./edit-dsl";
import type { MultiEditorRead } from "./multi-editor";

/** OpenAI-compatible function definition for the editor tool. */
export interface EditorToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Caller-supplied context; the model never provides these values. */
export interface EditorToolOptions {
  /** Workspace root supplied by the caller, never by the model arguments. */
  cwd: string;
  protectedPaths?: readonly string[];
}

/** Structured outcome of one read or apply dispatch. */
export interface EditorToolResult {
  ok: boolean;
  text: string;
  reads: MultiEditorRead[];
  viewers: EditDslViewer[];
  failures: EditDslFailure[];
  readFailures: EditDslFailure[];
  changed: string[];
  created: string[];
  deleted: string[];
}

export const EDITOR_TOOL_NAME = "tsed";

export const editorTool: EditorToolDefinition = {
  type: "function",
  function: {
    name: EDITOR_TOOL_NAME,
    description:
      "Read or apply an edit-dsl reply against the caller's workspace. Read-only unless write is true; the workspace root is supplied by the caller, not by the arguments.",
    parameters: {
      type: "object",
      properties: {
        reply: {
          type: "string",
          description: "The edit-dsl reply text to resolve (and apply when write is true).",
        },
        write: {
          type: "boolean",
          default: false,
          description: "Apply the reply's mutations; omitted or false is read-only.",
        },
      },
      required: ["reply"],
      additionalProperties: false,
    },
  },
};

type ParsedArgs = { ok: true; reply: string; write: boolean } | { ok: false; text: string };
type ResolvedOptions =
  | { ok: true; cwd: string; protectedPaths?: readonly string[] }
  | { ok: false; text: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyResult(text: string): EditorToolResult {
  return {
    ok: false,
    text,
    reads: [],
    viewers: [],
    failures: [],
    readFailures: [],
    changed: [],
    created: [],
    deleted: [],
  };
}

function parseArgs(args: unknown): ParsedArgs {
  let payload = args;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch (error) {
      return { ok: false, text: `invalid JSON arguments: ${messageOf(error)}` };
    }
  }
  if (!isRecord(payload)) {
    return { ok: false, text: "the editor tool arguments must be a JSON object" };
  }
  for (const key of Object.keys(payload)) {
    if (key !== "reply" && key !== "write") {
      return {
        ok: false,
        text: `unknown editor tool argument ${JSON.stringify(key)}; expected only "reply" and "write"`,
      };
    }
  }
  const reply = payload["reply"];
  if (typeof reply !== "string" || reply.trim() === "") {
    return { ok: false, text: 'the editor tool argument "reply" must be a non-empty string' };
  }
  const write = payload["write"];
  if (write !== undefined && typeof write !== "boolean") {
    return { ok: false, text: 'the editor tool argument "write" must be a boolean when present' };
  }
  return { ok: true, reply, write: write === true };
}

function resolveOptions(options: EditorToolOptions): ResolvedOptions {
  if (!isRecord(options)) {
    return { ok: false, text: "the editor tool requires caller-supplied options" };
  }
  const cwd = options.cwd;
  if (typeof cwd !== "string" || cwd.trim() === "") {
    return {
      ok: false,
      text: "the editor tool requires a non-empty workspace root in options.cwd",
    };
  }
  return { ok: true, cwd, protectedPaths: options.protectedPaths };
}

/**
 * Dispatch one OpenAI function call to the edit-dsl API. `args` is either the
 * already-parsed arguments object or the JSON string from a function call.
 * Read-only unless `write` is true; the workspace root comes only from
 * `options`, never from the model-facing arguments.
 */
export async function dispatchEditorTool(
  args: unknown,
  options: EditorToolOptions,
): Promise<EditorToolResult> {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    return emptyResult(parsed.text);
  }
  const resolved = resolveOptions(options);
  if (!resolved.ok) {
    return emptyResult(resolved.text);
  }
  const callOptions = { cwd: resolved.cwd, protectedPaths: resolved.protectedPaths };
  try {
    if (parsed.write) {
      const result = await applyEditDsl(parsed.reply, callOptions);
      return {
        ok: result.ok && result.readFailures.length === 0,
        text: result.text,
        reads: result.reads,
        viewers: result.viewers,
        failures: result.failures,
        readFailures: result.readFailures,
        changed: result.changed,
        created: result.created,
        deleted: result.deleted,
      };
    }
    const result = await readEditDsl(parsed.reply, callOptions);
    return {
      ok: result.ok && result.readFailures.length === 0,
      text: result.text,
      reads: result.reads,
      viewers: result.viewers,
      failures: result.failures,
      readFailures: result.readFailures,
      changed: [],
      created: [],
      deleted: [],
    };
  } catch (error) {
    return emptyResult(`the editor tool failed: ${messageOf(error)}; nothing was written`);
  }
}
