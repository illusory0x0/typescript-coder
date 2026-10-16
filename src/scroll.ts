import { buildIndex } from "./utility";
import type { IndexEntry, Locator } from "./utility";
import type {
  ClassDeclaration,
  ClassMember,
  ConstructorDeclaration,
  EnumDeclaration,
  FunctionDeclaration,
  IndexSignature,
  InterfaceDeclaration,
  MemberName,
  MethodDeclaration,
  NamespaceDeclaration,
  Node,
  Parameter,
  PropertyDeclaration,
  PropertySignature,
  ReturnTypeNode,
  TypeAliasDeclaration,
  TypeMember,
  TypeParameter,
  VariableDeclarator,
} from "./parser";

const DEFAULT_MAX_LINES = 40;
const TYPE_TEXT_LIMIT = 80;
const ENUM_MEMBER_LIMIT = 12;

type DeclarationNode = Node & { kind: string };

interface SignatureOptions {
  async?: boolean;
  generator?: boolean;
  accessor?: "get" | "set" | null;
  optional?: boolean;
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function textOf(source: string, node: Node): string {
  return compact(source.slice(node.start, node.end));
}

function firstLine(text: string): string {
  return compact(text.split("\n")[0] ?? "");
}

function resolveEntry(source: string, locator: Locator, fileName: string): IndexEntry {
  const index = buildIndex([{ path: fileName, source }]);
  const entry = index.lookup(locator)[0];
  if (entry === undefined) {
    throw new Error(`no symbol ${locator.kind} ${locator.name} in ${fileName}`);
  }
  return entry;
}

function renderTypeParameters(parameters: TypeParameter[] | null, source: string): string {
  if (parameters === null || parameters.length === 0) {
    return "";
  }
  return `<${parameters.map((parameter) => textOf(source, parameter)).join(", ")}>`;
}

function renderParameter(parameter: Parameter, source: string): string {
  const end = parameter.initializer === null ? parameter.end : parameter.initializer.start;
  return compact(source.slice(parameter.start, end)).replace(/\s*=\s*$/, "");
}

function renderParameters(parameters: Parameter[], source: string): string {
  return parameters.map((parameter) => renderParameter(parameter, source)).join(", ");
}

function renderReturnType(returnType: ReturnTypeNode | null, source: string): string {
  return returnType === null ? "" : `: ${textOf(source, returnType)}`;
}

function memberNameText(name: MemberName, source: string): string {
  switch (name.kind) {
    case "Identifier":
      return name.name;
    case "StringLiteral":
    case "NumberLiteral":
      return name.raw;
    case "ComputedPropertyName":
      return textOf(source, name);
  }
}

function signatureLine(
  name: MemberName,
  typeParameters: TypeParameter[] | null,
  parameters: Parameter[],
  returnType: ReturnTypeNode | null,
  source: string,
  options: SignatureOptions = {},
): string {
  const optional = options.optional === true ? "?" : "";
  const head = `${memberNameText(name, source)}${optional}${renderTypeParameters(typeParameters, source)}(${renderParameters(parameters, source)})${renderReturnType(returnType, source)}`;
  if (options.accessor === "get") {
    return `get ${head}`;
  }
  if (options.accessor === "set") {
    return `set ${head}`;
  }
  if (options.generator === true) {
    return `${options.async === true ? "async " : ""}*${head}`;
  }
  return options.async === true ? `async ${head}` : head;
}

function renderFunction(node: FunctionDeclaration, source: string): string {
  const name = node.name === null ? "" : node.name.name;
  const generator = node.generator === true ? "*" : "";
  const prefix = node.async === true ? "async " : "";
  return `${prefix}function${generator} ${name}${renderTypeParameters(node.typeParameters, source)}(${renderParameters(node.parameters, source)})${renderReturnType(node.returnType, source)}`;
}

function renderMethod(node: MethodDeclaration, source: string): string {
  return signatureLine(node.name, node.typeParameters, node.parameters, node.returnType, source, {
    async: node.async === true,
    generator: node.generator === true,
    accessor: node.accessor,
    optional: node.optional,
  });
}

function renderProperty(node: PropertyDeclaration | PropertySignature, source: string): string {
  const readonly = node.readonly ? "readonly " : "";
  const optional = node.optional ? "?" : "";
  const type = node.type === null ? "" : `: ${textOf(source, node.type)}`;
  return `${readonly}${memberNameText(node.name, source)}${optional}${type}`;
}

function renderConstructor(node: ConstructorDeclaration, source: string): string {
  return `constructor(${renderParameters(node.parameters, source)})`;
}

function renderIndexSignature(node: IndexSignature, source: string): string {
  const readonly = node.readonly ? "readonly " : "";
  const type = node.type === null ? "" : `: ${textOf(source, node.type)}`;
  return `${readonly}[${node.keyName.name}: ${textOf(source, node.keyType)}]${type}`;
}

function renderClassMember(member: ClassMember, source: string): string {
  switch (member.kind) {
    case "MethodDeclaration":
      return renderMethod(member, source);
    case "PropertyDeclaration":
      return renderProperty(member, source);
    case "ConstructorDeclaration":
      return renderConstructor(member, source);
    case "IndexSignature":
      return renderIndexSignature(member, source);
    case "StaticBlock":
      return firstLine(source.slice(member.start, member.end));
  }
}

function renderTypeMember(member: TypeMember, source: string): string {
  switch (member.kind) {
    case "PropertySignature":
      return renderProperty(member, source);
    case "MethodSignature":
      return signatureLine(
        member.name,
        member.typeParameters,
        member.parameters,
        member.returnType,
        source,
        { optional: member.optional },
      );
    case "IndexSignature":
      return renderIndexSignature(member, source);
    case "CallSignature":
      return `${renderTypeParameters(member.typeParameters, source)}(${renderParameters(member.parameters, source)})${renderReturnType(member.returnType, source)}`;
    case "ConstructSignature":
      return `new ${renderTypeParameters(member.typeParameters, source)}(${renderParameters(member.parameters, source)})${renderReturnType(member.returnType, source)}`;
  }
}

function renderClass(node: ClassDeclaration, source: string): string {
  const name = node.name === null ? "" : node.name.name;
  const heritage =
    node.extends === null ? "" : ` extends ${textOf(source, node.extends)}`;
  const lines = [
    `class ${name}${renderTypeParameters(node.typeParameters, source)}${heritage}`,
  ];
  for (const member of node.members) {
    lines.push(`  ${renderClassMember(member, source)}`);
  }
  return lines.join("\n");
}

function renderInterface(node: InterfaceDeclaration, source: string): string {
  const lines = [
    `interface ${node.name.name}${renderTypeParameters(node.typeParameters, source)}`,
  ];
  for (const member of node.members) {
    lines.push(`  ${renderTypeMember(member, source)}`);
  }
  return lines.join("\n");
}

function renderTypeAlias(node: TypeAliasDeclaration, source: string): string {
  const text = textOf(source, node.type);
  const shown = text.length > TYPE_TEXT_LIMIT ? `${text.slice(0, TYPE_TEXT_LIMIT)}...` : text;
  return `type ${node.name.name}${renderTypeParameters(node.typeParameters, source)} = ${shown}`;
}

function renderEnum(node: EnumDeclaration): string {
  const names = node.members.map((member) =>
    member.name.kind === "Identifier" ? member.name.name : member.name.raw,
  );
  const shown =
    names.length > ENUM_MEMBER_LIMIT ? [...names.slice(0, ENUM_MEMBER_LIMIT), "..."] : names;
  const body = shown.join(", ");
  const keyword = node.const ? "const enum" : "enum";
  return body === "" ? `${keyword} ${node.name.name} {}` : `${keyword} ${node.name.name} { ${body} }`;
}

function renderNamespace(node: NamespaceDeclaration): string {
  return `namespace ${node.name} { ${node.body.length} members }`;
}

function renderVariable(node: VariableDeclarator, source: string): string {
  if (node.name.kind !== "Identifier") {
    return firstLine(source.slice(node.start, node.end));
  }
  const type = node.type === null ? "" : `: ${textOf(source, node.type)}`;
  return `${node.name.name}${type}`;
}

function renderSignature(entry: IndexEntry, source: string): string {
  const node = entry.node as DeclarationNode;
  switch (node.kind) {
    case "FunctionDeclaration":
      return renderFunction(node as FunctionDeclaration, source);
    case "MethodDeclaration":
      return renderMethod(node as MethodDeclaration, source);
    case "PropertyDeclaration":
      return renderProperty(node as PropertyDeclaration, source);
    case "ClassDeclaration":
      return renderClass(node as ClassDeclaration, source);
    case "InterfaceDeclaration":
      return renderInterface(node as InterfaceDeclaration, source);
    case "TypeAliasDeclaration":
      return renderTypeAlias(node as TypeAliasDeclaration, source);
    case "EnumDeclaration":
      return renderEnum(node as EnumDeclaration);
    case "NamespaceDeclaration":
      return renderNamespace(node as NamespaceDeclaration);
    case "VariableDeclarator":
      return renderVariable(node as VariableDeclarator, source);
    default:
      return firstLine(source.slice(node.start, node.end));
  }
}

export function buildSignatureView(
  source: string,
  locator: Locator,
  fileName = "file.ts",
): string {
  return renderSignature(resolveEntry(source, locator, fileName), source);
}

export function expand(
  source: string,
  locator: Locator,
  options?: { fileName?: string; maxLines?: number },
): string {
  const fileName = options?.fileName ?? "file.ts";
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
  if (maxLines <= 0) {
    throw new Error(`maxLines must be greater than 0, got ${maxLines}`);
  }
  const entry = resolveEntry(source, locator, fileName);
  const text = source.slice(entry.node.start, entry.node.end);
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  const remaining = lines.length - maxLines;
  const head = lines.slice(0, maxLines).join("\n");
  return `${head}\n// ... ${remaining} more lines (use expand with a higher maxLines)`;
}
