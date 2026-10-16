import { applyEdits } from "./editor";
import { buildIndex, findDefinition } from "./utility";
import type { IndexEntry, Locator, SourceFile } from "./utility";
import type {
  ClassDeclaration,
  EnumDeclaration,
  FunctionDeclaration,
  ImportEqualsDeclaration,
  InterfaceDeclaration,
  MemberName,
  MethodDeclaration,
  NamespaceDeclaration,
  Node,
  TypeAliasDeclaration,
  VariableDeclarator,
} from "./parser";
import type { ToolDefinition } from "./openai";

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
    case "ObjectMethod":
    case "PropertyDeclaration":
      return memberNameSpan((declaration as MethodDeclaration).name);
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
];
