import { applyEdits } from "./editor";
import { buildIndex, findDefinition } from "./utility";
import type { IndexEntry, Locator, SourceFile } from "./utility";
import type {
  ClassDeclaration,
  EnumDeclaration,
  EnumMember,
  FunctionDeclaration,
  ImportEqualsDeclaration,
  InterfaceDeclaration,
  MemberName,
  MethodDeclaration,
  MethodSignature,
  NamespaceDeclaration,
  Node,
  ObjectMethod,
  Property,
  PropertySignature,
  TypeAliasDeclaration,
  VariableDeclarator,
} from "./parser";
import type { ToolDefinition } from "./openai";

export interface CommandResult {
  ok: boolean;
  exitCode: number;
  output: string;
}

export interface CheckDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  /** TypeScript error code, e.g. "TS2322", for located diagnostics. */
  code?: string;
}

// Bounds how long the loop's check/test commands may run (not provider
// requests); 120s gives the repo's own full suite real headroom (#45).
const commandTimeoutMs = 120_000;

interface Span {
  start: number;
  end: number;
}

type DeclarationNode = Node & { kind: string };

function spanOf(node: Node | null | undefined): Span | null {
  return node === null || node === undefined ? null : { start: node.start, end: node.end };
}

function memberNameSpan(name: MemberName): Span | null {
  return name.kind === "Identifier" ? spanOf(name) : null;
}

function namespaceNameSpan(node: NamespaceDeclaration, source: string): Span | null {
  const slice = source.slice(node.start, node.end);
  const index = slice.indexOf(node.name);
  if (index < 0) {
    return null;
  }
  const dot = node.name.lastIndexOf(".");
  const last = node.name.slice(dot + 1);
  const start = node.start + index + dot + 1;
  return { start, end: start + last.length };
}

function declarationNameSpan(node: Node, source: string): Span | null {
  const declaration = node as DeclarationNode;
  switch (declaration.kind) {
    case "Identifier":
      return spanOf(declaration);
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return spanOf((declaration as FunctionDeclaration | ClassDeclaration).name);
    case "MethodDeclaration":
    case "MethodSignature":
    case "ObjectMethod":
    case "PropertyDeclaration":
    case "PropertySignature":
      return memberNameSpan(
        (declaration as MethodDeclaration | MethodSignature | ObjectMethod | PropertySignature)
          .name,
      );
    case "Property": {
      const property = declaration as Property;
      if (property.computed) {
        return null;
      }
      switch (property.key.kind) {
        case "Identifier":
        case "StringLiteral":
        case "NumberLiteral":
          return spanOf(property.key);
        default:
          return null;
      }
    }
    case "EnumMember": {
      const name = (declaration as EnumMember).name;
      return name.kind === "Identifier" ? spanOf(name) : null;
    }
    case "InterfaceDeclaration":
      return spanOf((declaration as InterfaceDeclaration).name);
    case "TypeAliasDeclaration":
      return spanOf((declaration as TypeAliasDeclaration).name);
    case "EnumDeclaration":
      return spanOf((declaration as EnumDeclaration).name);
    case "ImportEqualsDeclaration":
      return spanOf((declaration as ImportEqualsDeclaration).name);
    case "VariableDeclarator": {
      const name = (declaration as VariableDeclarator).name;
      return name.kind === "Identifier" ? spanOf(name) : null;
    }
    case "NamespaceDeclaration":
      return namespaceNameSpan(declaration as NamespaceDeclaration, source);
    default:
      return null;
  }
}

export function findDefinitionTool(files: SourceFile[], locator: Locator): IndexEntry | null {
  return findDefinition(buildIndex(files), locator);
}

export async function renameTool(
  source: string,
  locator: Locator,
  newName: string,
  fileName = "file.ts",
): Promise<string> {
  const index = buildIndex([{ path: fileName, source }]);
  const entry = index.lookup(locator)[0];
  if (entry === undefined) {
    throw new Error(`cannot rename ${locator.kind} ${locator.name}`);
  }
  const span = declarationNameSpan(entry.node, source);
  if (span === null) {
    throw new Error(`cannot rename ${locator.kind} ${locator.name}`);
  }
  const text = source.slice(entry.node.start, entry.node.end);
  const start = span.start - entry.node.start;
  const end = span.end - entry.node.start;
  const llmOutput = text.slice(0, start) + newName + text.slice(end);
  return applyEdits(source, [{ locator, llmOutput }], fileName);
}

async function runCommand(
  cwd: string,
  command: string[],
  timeoutMs: number = commandTimeoutMs,
): Promise<CommandResult> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const timer = setTimeout(() => {
    proc.kill();
  }, timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const output = (await stdout) + (await stderr);
  return { ok: exitCode === 0, exitCode, output };
}

export function parseDiagnostics(output: string): CheckDiagnostic[] {
  const diagnostics: CheckDiagnostic[] = [];
  // The file part is greedy so paths containing parentheses, e.g.
  // `src/(a).ts(3,4): error TS...`, bind the location to the trailing group.
  const located = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
  const unlocated = /error TS\d+: (.*)$/;
  for (const line of output.split("\n")) {
    const match = located.exec(line);
    if (match !== null) {
      const [, file = "", lineText = "0", columnText = "0", code = "", message = ""] = match;
      diagnostics.push({
        file,
        line: Number(lineText),
        column: Number(columnText),
        message,
        code,
      });
      continue;
    }
    if (line.includes("error TS")) {
      const message = unlocated.exec(line)?.[1];
      diagnostics.push({ file: "", line: 0, column: 0, message: message ?? line.trim() });
      continue;
    }
    // Indented lines continue the previous diagnostic's wrapped message.
    const previous = diagnostics[diagnostics.length - 1];
    if (previous !== undefined && /^\s+\S/.test(line)) {
      previous.message = `${previous.message} ${line.trim()}`;
    }
  }
  return diagnostics;
}

export async function checkTool(
  cwd: string,
  command: string[] = ["bunx", "tsc", "--noEmit"],
  timeoutMs: number = commandTimeoutMs,
): Promise<CommandResult & { diagnostics: CheckDiagnostic[] }> {
  const result = await runCommand(cwd, command, timeoutMs);
  return { ...result, diagnostics: parseDiagnostics(result.output) };
}

export async function testTool(
  cwd: string,
  command: string[] = ["bun", "test"],
  timeoutMs: number = commandTimeoutMs,
): Promise<CommandResult> {
  return runCommand(cwd, command, timeoutMs);
}

const locatorProperties = {
  path: { type: "string", description: "File path of the symbol." },
  name: { type: "string", description: "Symbol name, e.g. Foo.bar for a class member." },
  kind: { type: "string", description: "Declaration kind, e.g. function, method, class." },
};

export const tools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "find-definition",
      description: "Resolve a symbol locator to its declaration in the project index.",
      parameters: {
        type: "object",
        properties: { ...locatorProperties },
        required: ["path", "name", "kind"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description:
        "Show a compact signature view of a symbol, or expand its declaration up to maxLines.",
      parameters: {
        type: "object",
        properties: {
          ...locatorProperties,
          expand: { type: "boolean", description: "Return the declaration body instead." },
          maxLines: { type: "number", description: "Line budget for expand; default 40." },
        },
        required: ["path", "name", "kind"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename",
      description: "Rename the declaration name of a symbol through the editor and format it.",
      parameters: {
        type: "object",
        properties: {
          ...locatorProperties,
          newName: { type: "string", description: "New declaration name." },
        },
        required: ["path", "name", "kind", "newName"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check",
      description:
        "Run tsc --noEmit in the project directory and return its exit status and parsed diagnostics.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Project directory to type-check." },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "test",
      description: "Run bun test in the project directory and return its exit status and output.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Project directory to test." },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
];
