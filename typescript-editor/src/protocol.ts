import { EDIT_FENCE_BEGIN, EDIT_FENCE_END, containsEditFenceEnd } from "./selection";

/**
 * One operation in the native protocol. The CLI builds these from flags, and
 * `--protocol-format json` accepts them literally (a bare array or an object
 * with an `operations` array).
 */
export type EditOperation =
  | { op: "read"; path: string; within?: string }
  | {
      op: "select";
      symbol: string;
      path: string;
      kind?: string;
      resolve?: "value" | "type" | "namespace";
      match?: string;
      pick?: string;
      replace?: string;
      rename?: string;
    }
  | { op: "create"; path: string }
  | { op: "delete"; path: string }
  | { op: "rewrite"; path: string; content: string };

export interface EditRequest {
  operations: EditOperation[];
}

/** A malformed native/JSON operation list. The CLI reports it as a usage error. */
export class EditProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditProtocolError";
  }
}

type OperationKind = EditOperation["op"];
type ResolveSpace = "value" | "type" | "namespace";
type SelectOperation = Extract<EditOperation, { op: "select" }>;

const OPERATION_FIELDS: Record<OperationKind, readonly string[]> = {
  read: ["op", "path", "within"],
  select: ["op", "symbol", "path", "kind", "resolve", "match", "pick", "replace", "rename"],
  create: ["op", "path"],
  delete: ["op", "path"],
  rewrite: ["op", "path", "content"],
};

const REQUIRED_FIELDS: Record<OperationKind, readonly string[]> = {
  read: ["path"],
  select: ["symbol", "path"],
  create: ["path"],
  delete: ["path"],
  rewrite: ["path", "content"],
};

function isOperationKind(value: string): value is OperationKind {
  return Object.hasOwn(OPERATION_FIELDS, value);
}

function isResolveSpace(value: string): value is ResolveSpace {
  return value === "value" || value === "type" || value === "namespace";
}

function reject(message: string): never {
  throw new EditProtocolError(message);
}

/** A workspace-relative path token: one word, never a newline or a space. */
function pathToken(operation: OperationKind, field: string, value: string): void {
  if (value === "" || /\s/.test(value)) {
    reject(`${operation}.${field} must be a non-empty path with no whitespace`);
  }
}

/** A symbol/kind/rename token: one word, no whitespace. */
function wordToken(operation: OperationKind, field: string, value: string): void {
  if (value === "" || /\s/.test(value)) {
    reject(`${operation}.${field} must be a non-empty word with no whitespace`);
  }
}

/** A `pick`/`within` range: it may contain spaces, but never a line break. */
function rangeToken(operation: OperationKind, field: string, value: string): void {
  if (value === "") {
    reject(`${operation}.${field} must be a non-empty range`);
  }
  if (/[\r\n]/.test(value)) {
    reject(`${operation}.${field} must not contain a line break`);
  }
}

function fence(operation: OperationKind, body: string): string {
  if (containsEditFenceEnd(body)) {
    reject(
      `${operation}: the replacement content contains a line that is exactly ${EDIT_FENCE_END}; ` +
        `the sentinel is the only fence close and has no escape form`,
    );
  }
  return `${EDIT_FENCE_BEGIN}\n${body}\n${EDIT_FENCE_END}`;
}

function validateOperation(operation: EditOperation): void {
  switch (operation.op) {
    case "read": {
      pathToken(operation.op, "path", operation.path);
      if (operation.within !== undefined) {
        rangeToken(operation.op, "within", operation.within);
      }
      return;
    }
    case "select": {
      wordToken(operation.op, "symbol", operation.symbol);
      pathToken(operation.op, "path", operation.path);
      if (operation.kind !== undefined) {
        wordToken(operation.op, "kind", operation.kind);
      }
      if (operation.resolve !== undefined && !isResolveSpace(operation.resolve)) {
        reject(`select.resolve must be "value", "type", or "namespace"`);
      }
      if (operation.pick !== undefined) {
        rangeToken(operation.op, "pick", operation.pick);
      }
      if (operation.replace !== undefined && operation.rename !== undefined) {
        reject("select: replace and rename are mutually exclusive");
      }
      if (operation.rename !== undefined) {
        wordToken(operation.op, "rename", operation.rename);
      }
      if (operation.replace !== undefined) {
        fence(operation.op, operation.replace);
      }
      return;
    }
    case "create":
    case "delete": {
      pathToken(operation.op, "path", operation.path);
      return;
    }
    case "rewrite": {
      pathToken(operation.op, "path", operation.path);
      fence(operation.op, operation.content);
      return;
    }
  }
}

/** Escape a snippet the way `selection.ts` serializes a `match` matcher. */
function escapeSnippet(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

function renderOperation(operation: EditOperation): string {
  switch (operation.op) {
    case "read": {
      const within = operation.within === undefined ? "" : ` within ${operation.within}`;
      return `read ${operation.path}${within} end`;
    }
    case "select": {
      const kind = operation.kind === undefined ? "" : `${operation.kind} `;
      let head = `select ${kind}${operation.symbol} in ${operation.path}`;
      if (operation.resolve !== undefined) {
        head += ` resolve ${operation.resolve}`;
      }
      if (operation.match !== undefined) {
        head += ` match \`${escapeSnippet(operation.match)}\``;
      }
      if (operation.pick !== undefined) {
        head += ` pick ${operation.pick}`;
      }
      if (operation.replace !== undefined) {
        return `${head}\nreplace with\n${fence(operation.op, operation.replace)}`;
      }
      if (operation.rename !== undefined) {
        return `${head}\nrename ${operation.symbol} to ${operation.rename}\nend`;
      }
      return `${head}\nend`;
    }
    case "create":
      return `create ${operation.path} end`;
    case "delete":
      return `delete ${operation.path} end`;
    case "rewrite":
      return `write ${operation.path} with\n${fence(operation.op, operation.content)}`;
  }
}

/** Render operations as one edit-dsl reply; operations are one blank line apart. */
export function renderEditRequest(request: EditRequest): string {
  if (request.operations.length === 0) {
    reject("the edit request contains no operations");
  }
  for (const operation of request.operations) {
    validateOperation(operation);
  }
  return request.operations.map(renderOperation).join("\n\n");
}

/** True when the operation writes, creates, deletes, or renames anything. */
export function isMutatingOperation(operation: EditOperation): boolean {
  switch (operation.op) {
    case "read":
      return false;
    case "select":
      return operation.replace !== undefined || operation.rename !== undefined;
    case "create":
    case "delete":
    case "rewrite":
      return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonOperation(raw: unknown, index: number): EditOperation {
  const where = `operation ${index + 1}`;
  if (!isRecord(raw)) {
    reject(`${where} must be a JSON object`);
  }
  const kind = raw["op"];
  if (typeof kind !== "string") {
    reject(`${where} is missing a string "op"`);
  }
  if (!isOperationKind(kind)) {
    reject(
      `${where} has unknown op ${JSON.stringify(kind)}; expected read, select, create, delete, or rewrite`,
    );
  }
  const fields = OPERATION_FIELDS[kind];
  for (const key of Object.keys(raw)) {
    if (!fields.includes(key)) {
      reject(`${where} (${kind}) has unknown field ${JSON.stringify(key)}`);
    }
  }
  for (const key of REQUIRED_FIELDS[kind]) {
    if (!Object.hasOwn(raw, key)) {
      reject(`${where} (${kind}) is missing the required field ${JSON.stringify(key)}`);
    }
  }
  const stringField = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string") {
      reject(`${where} (${kind}) field ${JSON.stringify(key)} must be a string`);
    }
    return value;
  };
  const optionalField = (key: string): string | undefined =>
    Object.hasOwn(raw, key) ? stringField(key) : undefined;

  let operation: EditOperation;
  switch (kind) {
    case "read": {
      const within = optionalField("within");
      operation = { op: "read", path: stringField("path") };
      if (within !== undefined) {
        operation.within = within;
      }
      break;
    }
    case "select": {
      const resolve = optionalField("resolve");
      if (resolve !== undefined && !isResolveSpace(resolve)) {
        reject(`${where} (select) field "resolve" must be "value", "type", or "namespace"`);
      }
      const selection: SelectOperation = {
        op: "select",
        symbol: stringField("symbol"),
        path: stringField("path"),
      };
      const kind = optionalField("kind");
      const match = optionalField("match");
      const pick = optionalField("pick");
      const replace = optionalField("replace");
      const rename = optionalField("rename");
      if (kind !== undefined) {
        selection.kind = kind;
      }
      if (resolve !== undefined) {
        selection.resolve = resolve;
      }
      if (match !== undefined) {
        selection.match = match;
      }
      if (pick !== undefined) {
        selection.pick = pick;
      }
      if (replace !== undefined) {
        selection.replace = replace;
      }
      if (rename !== undefined) {
        selection.rename = rename;
      }
      operation = selection;
      break;
    }
    case "create":
      operation = { op: "create", path: stringField("path") };
      break;
    case "delete":
      operation = { op: "delete", path: stringField("path") };
      break;
    case "rewrite":
      operation = { op: "rewrite", path: stringField("path"), content: stringField("content") };
      break;
  }
  validateOperation(operation);
  return operation;
}

/**
 * Parse a JSON operation list: either a bare array or `{ "operations": [...] }`.
 * Shape errors, unknown fields, and malformed JSON all throw
 * `EditProtocolError`, so the CLI can report one usage error.
 */
export function parseJsonEditRequest(text: string): EditRequest {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    reject(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  let items: unknown;
  if (Array.isArray(payload)) {
    items = payload;
  } else if (isRecord(payload)) {
    for (const key of Object.keys(payload)) {
      if (key !== "operations") {
        reject(`unknown top-level field ${JSON.stringify(key)}; expected only "operations"`);
      }
    }
    if (!Object.hasOwn(payload, "operations")) {
      reject('the JSON object must contain an "operations" array');
    }
    items = payload["operations"];
  } else {
    reject('the JSON payload must be an operation array or an object with an "operations" array');
  }

  if (!Array.isArray(items)) {
    reject('"operations" must be an array');
  }
  if (items.length === 0) {
    reject("the edit request contains no operations");
  }
  return { operations: items.map((item, index) => parseJsonOperation(item, index)) };
}
