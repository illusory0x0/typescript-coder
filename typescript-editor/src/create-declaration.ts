/**
 * Kind-aware `create` resolution (#50).
 *
 * A `create [static] <kind> <name> in <path> with <fence>` statement adds
 * exactly one named top-level declaration or one member of an existing
 * class/interface/namespace/enum. The descriptor is authoritative: the fence
 * must declare that name and kind, may only carry modifiers valid for the
 * descriptor and owner, and a dotted address never creates its owner.
 */
import { Parser } from "./parser";
import type {
  ClassDeclaration,
  Expression,
  EnumDeclaration,
  InterfaceDeclaration,
  MemberName,
  NamespaceDeclaration,
  Node,
  Program,
  Statement,
  TypeMember,
} from "./parser";
import type {
  CreateDeclarationStatement,
  DeclarationCreateKind,
  MemberCreateKind,
} from "./selection";
import { EDIT_FENCE_BEGIN, EDIT_FENCE_END, STATIC_CREATE_KINDS } from "./selection";
import type { SymbolSpace } from "./utility";

/** Owner kinds a dotted member create can address. */
const OWNER_KINDS: ReadonlySet<string> = new Set(["class", "interface", "namespace", "enum"]);

interface ScannedDeclaration {
  /** The full dotted name, including enclosing namespace segments. */
  name: string;
  kind: string;
  node: Node;
}

/** A resolved create: one zero-width insertion and the identity it adds. */
export interface CreateDeclarationResolution {
  ok: true;
  path: string;
  start: number;
  end: number;
  text: string;
  /** The declaration/member identity the fence actually adds. */
  declaration: { name: string; kind: string };
  /**
   * A per-owner duplicate key for member creates (`path`, owner, static,
   * member name, get/set identity). Null for a top-level declaration.
   */
  memberKey: string | null;
}

export interface CreateDeclarationFailure {
  ok: false;
  stage: "address" | "duplicate";
  diagnostics: string;
}

type Result = CreateDeclarationResolution | CreateDeclarationFailure;

const TOP_LEVEL_SPACES: Readonly<Record<DeclarationCreateKind, readonly SymbolSpace[]>> = {
  function: ["value"],
  class: ["value", "type"],
  interface: ["type"],
  type: ["type"],
  enum: ["value", "type"],
  namespace: ["namespace"],
  const: ["value"],
  let: ["value"],
  var: ["value"],
  using: ["value"],
};

const VARIABLE_KINDS: ReadonlySet<string> = new Set(["const", "let", "var", "using"]);

/**
 * Every named declaration in a file, with namespace qualification. This is a
 * small AST scan rather than the symbol index because the index collapses a
 * class/interface merge into the first declaration node; an ambiguous member
 * owner must name every merged declaration.
 */
function scanSource(source: string): ScannedDeclaration[] {
  const parsed = parseProgram(source);
  if (!parsed.ok) {
    return [];
  }
  const declarations: ScannedDeclaration[] = [];
  collectDeclarations(parsed.program.body, "", declarations);
  return declarations;
}

function collectDeclarations(
  statements: readonly Statement[],
  prefix: string,
  declarations: ScannedDeclaration[],
): void {
  for (const statement of statements) {
    const unwrapped = unwrapDeclaration(statement);
    const node = unwrapped?.node;
    if (node === undefined) {
      continue;
    }
    switch (node.kind) {
      case "FunctionDeclaration":
        if (node.name !== null) {
          declarations.push({ name: `${prefix}${node.name.name}`, kind: "function", node });
        }
        break;
      case "ClassDeclaration":
        if (node.name !== null) {
          declarations.push({ name: `${prefix}${node.name.name}`, kind: "class", node });
        }
        break;
      case "InterfaceDeclaration":
        declarations.push({ name: `${prefix}${node.name.name}`, kind: "interface", node });
        break;
      case "TypeAliasDeclaration":
        declarations.push({ name: `${prefix}${node.name.name}`, kind: "type", node });
        break;
      case "EnumDeclaration":
        declarations.push({ name: `${prefix}${node.name.name}`, kind: "enum", node });
        break;
      case "NamespaceDeclaration": {
        const name = `${prefix}${node.name}`;
        declarations.push({ name, kind: "namespace", node });
        collectDeclarations(node.body, `${name}.`, declarations);
        break;
      }
      case "VariableStatement":
        for (const declarator of node.declarations) {
          const name = bindingName(declarator.name);
          if (name !== null) {
            declarations.push({ name: `${prefix}${name}`, kind: node.declarationKind, node });
          }
        }
        break;
      default:
        break;
    }
  }
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PRIVATE_IDENTIFIER = /^#[A-Za-z_$][A-Za-z0-9_$]*$/;

function describe(statement: CreateDeclarationStatement): string {
  const staticText = statement.static ? "static " : "";
  return `${staticText}${statement.kind} ${JSON.stringify(statement.name)} in ${JSON.stringify(statement.path)}`;
}

/** The whole-file alternative for a mixed declaration list or kind change. */
function writeRemediation(path: string): string {
  return `for a mixed declaration list or a whole-file change, use \`write ${path} with ${EDIT_FENCE_BEGIN} … ${EDIT_FENCE_END}\``;
}

/** A concrete create target for the fence's actual kind, plus the write escape. */
function createKindRemediation(
  statement: CreateDeclarationStatement,
  actualKind: string,
  actualName: string | null,
): string {
  const name = actualName === null ? statement.name : actualName;
  return `use \`create ${actualKind} ${JSON.stringify(name)} in ${statement.path} with <fence>\` when that kind is intended, or make the fence declare the descriptor's ${statement.kind}; ${writeRemediation(statement.path)}`;
}

function failure(
  statement: CreateDeclarationStatement,
  stage: "address" | "duplicate",
  code: string,
  detail: string,
  hint: string,
): CreateDeclarationFailure {
  return {
    ok: false,
    stage,
    diagnostics: [
      `stage: ${stage}`,
      `code: ${code}`,
      `cannot create ${describe(statement)}: ${detail}`,
      `hint: ${hint}`,
    ].join("\n"),
  };
}

function parseProgram(
  source: string,
): { ok: true; program: Program } | { ok: false; message: string } {
  try {
    return { ok: true, program: new Parser(source).parseProgram() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function memberName(name: MemberName): string | null {
  switch (name.kind) {
    case "Identifier":
      return name.name;
    case "StringLiteral":
      return name.value;
    case "NumberLiteral":
      return name.raw;
    case "ComputedPropertyName":
      return null;
  }
}

function bindingName(node: Node): string | null {
  const candidate = node as Node & { kind?: string; name?: string };
  return candidate.kind === "Identifier" && typeof candidate.name === "string"
    ? candidate.name
    : null;
}

interface Unwrapped {
  node: Statement | Expression;
  exported: boolean;
  defaulted: boolean;
}

function unwrapDeclaration(statement: Statement): Unwrapped | null {
  switch (statement.kind) {
    case "ExportNamedDeclaration":
      return statement.declaration === null
        ? null
        : { node: statement.declaration, exported: true, defaulted: false };
    case "ExportDefaultDeclaration":
      return { node: statement.declaration, exported: true, defaulted: true };
    default:
      return { node: statement, exported: false, defaulted: false };
  }
}

interface DeclarationInfo {
  node: Node;
  kind: string;
  name: string | null;
  exported: boolean;
  defaulted: boolean;
  spaces: readonly SymbolSpace[];
  modifiers: ReadonlySet<string>;
}

function declarationInfo(unwrapped: Unwrapped): DeclarationInfo | null {
  const node = unwrapped.node;
  switch (node.kind) {
    case "FunctionDeclaration": {
      const modifiers = new Set<string>();
      if (node.async === true) {
        modifiers.add("async");
      }
      if (node.generator === true) {
        modifiers.add("generator");
      }
      if (node.declare === true) {
        modifiers.add("declare");
      }
      return {
        node,
        kind: "function",
        name: node.name?.name ?? null,
        exported: unwrapped.exported,
        defaulted: unwrapped.defaulted,
        spaces: ["value"],
        modifiers,
      };
    }
    case "ClassDeclaration": {
      const modifiers = new Set<string>();
      if (node.abstract === true) {
        modifiers.add("abstract");
      }
      if (node.declare === true) {
        modifiers.add("declare");
      }
      return {
        node,
        kind: "class",
        name: node.name?.name ?? null,
        exported: unwrapped.exported,
        defaulted: unwrapped.defaulted,
        spaces: ["value", "type"],
        modifiers,
      };
    }
    case "InterfaceDeclaration": {
      const modifiers = new Set<string>();
      if (node.declare === true) {
        modifiers.add("declare");
      }
      return {
        node,
        kind: "interface",
        name: node.name.name,
        exported: unwrapped.exported,
        defaulted: unwrapped.defaulted,
        spaces: ["type"],
        modifiers,
      };
    }
    case "TypeAliasDeclaration": {
      const modifiers = new Set<string>();
      if (node.declare === true) {
        modifiers.add("declare");
      }
      return {
        node,
        kind: "type",
        name: node.name.name,
        exported: unwrapped.exported,
        defaulted: unwrapped.defaulted,
        spaces: ["type"],
        modifiers,
      };
    }
    case "EnumDeclaration": {
      const modifiers = new Set<string>();
      if (node.declare === true) {
        modifiers.add("declare");
      }
      return {
        node,
        kind: "enum",
        name: node.name.name,
        exported: unwrapped.exported,
        defaulted: unwrapped.defaulted,
        spaces: ["value", "type"],
        modifiers,
      };
    }
    case "NamespaceDeclaration": {
      const modifiers = new Set<string>();
      if (node.declare === true) {
        modifiers.add("declare");
      }
      return {
        node,
        kind: "namespace",
        name: node.name,
        exported: unwrapped.exported,
        defaulted: unwrapped.defaulted,
        spaces: ["namespace"],
        modifiers,
      };
    }
    case "VariableStatement": {
      if (node.declarations.length !== 1) {
        return {
          node,
          kind: node.declarationKind,
          name: null,
          exported: unwrapped.exported,
          defaulted: unwrapped.defaulted,
          spaces: ["value"],
          modifiers: new Set<string>(),
        };
      }
      const declarator = node.declarations[0];
      const name = declarator === undefined ? null : bindingName(declarator.name);
      const modifiers = new Set<string>();
      if (node.declare === true) {
        modifiers.add("declare");
      }
      return {
        node,
        kind: node.declarationKind,
        name,
        exported: unwrapped.exported,
        defaulted: unwrapped.defaulted,
        spaces: ["value"],
        modifiers,
      };
    }
    default:
      return null;
  }
}

function allowedTopLevelModifiers(kind: DeclarationCreateKind): ReadonlySet<string> {
  switch (kind) {
    case "function":
      return new Set(["export", "default", "declare", "async", "generator"]);
    case "class":
      return new Set(["export", "default", "declare", "abstract"]);
    case "interface":
      return new Set(["export", "default", "declare"]);
    case "type":
    case "enum":
    case "namespace":
      return new Set(["export", "declare"]);
    case "const":
    case "let":
    case "var":
      return new Set(["export", "declare"]);
    case "using":
      return new Set(["export"]);
  }
}

function modifierProblems(
  info: DeclarationInfo,
  kind: DeclarationCreateKind,
  namespaceMember: boolean,
): string[] {
  const found = new Set(info.modifiers);
  if (info.exported) {
    found.add("export");
  }
  if (info.defaulted) {
    found.add("default");
  }
  const allowed = new Set(allowedTopLevelModifiers(kind));
  if (namespaceMember) {
    // A namespace member cannot be a default export.
    allowed.delete("default");
  }
  return [...found].filter((modifier) => !allowed.has(modifier));
}

function spaceList(spaces: readonly SymbolSpace[]): string {
  return spaces.map((space) => JSON.stringify(space)).join(", ");
}

/**
 * The leading modifier keywords in a fence member. Some modifiers are parsed
 * into the AST (`static`, `readonly`, access, `override`, `async`), but others
 * are consumed and dropped by the parser (`declare` on a method, `override` on
 * a constructor). Checking the raw member text catches those instead of
 * silently accepting an invalid fence.
 */
const MEMBER_MODIFIER_WORDS: ReadonlySet<string> = new Set([
  "export",
  "default",
  "declare",
  "abstract",
  "static",
  "readonly",
  "public",
  "private",
  "protected",
  "override",
  "async",
]);

function leadingModifiers(source: string): string[] {
  const modifiers: string[] = [];
  let rest = source.trimStart();
  for (;;) {
    if (rest.startsWith("*")) {
      modifiers.push("generator");
      rest = rest.slice(1).trimStart();
      continue;
    }
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+/.exec(rest);
    if (match === null) {
      break;
    }
    const word = match[1] ?? "";
    if (!MEMBER_MODIFIER_WORDS.has(word)) {
      break;
    }
    const next = rest.slice(match[0].length).trimStart();
    // `readonly (): void` and `static = 1` name members after a modifier word;
    // these punctuation-led forms are names, not modifiers.
    if (/^[(<:?!=;,)]/.test(next)) {
      break;
    }
    modifiers.push(word);
    rest = rest.slice(match[0].length);
  }
  return modifiers;
}

function declarationShapeMismatch(
  statement: CreateDeclarationStatement,
  info: DeclarationInfo,
  namespaceMember: boolean,
): CreateDeclarationFailure | null {
  if (info.name !== statement.name) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_NAME_MISMATCH",
      `the fence declares ${JSON.stringify(info.name ?? "<anonymous>")}, not ${JSON.stringify(statement.name)}`,
      createKindRemediation(statement, info.kind, info.name),
    );
  }
  if (info.kind !== statement.kind) {
    const expected = TOP_LEVEL_SPACES[statement.kind as DeclarationCreateKind];
    return failure(
      statement,
      "address",
      "EDIT_CREATE_KIND_MISMATCH",
      `the fence declares a ${JSON.stringify(info.kind)} (${spaceList(info.spaces)} space), but the descriptor asks for a ${JSON.stringify(statement.kind)}${
        expected === undefined ? "" : ` (${spaceList(expected)} space)`
      }`,
      namespaceMember
        ? `a namespace member create uses the declaration kind it inserts; change the descriptor or the fence; ${writeRemediation(statement.path)}`
        : createKindRemediation(statement, info.kind, statement.name),
    );
  }
  if (info.spaces.length === 0) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_SPACE_MISMATCH",
      "the fence declaration occupies no symbol space",
      "declare a named TypeScript declaration",
    );
  }
  const expected = TOP_LEVEL_SPACES[statement.kind as DeclarationCreateKind];
  if (expected !== undefined && !expected.some((space) => info.spaces.includes(space))) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_SPACE_MISMATCH",
      `the fence declaration occupies the ${spaceList(info.spaces)} space, not the ${spaceList(expected)} space the descriptor requires`,
      "use a declaration kind that occupies the descriptor's symbol space",
    );
  }
  const invalid = modifierProblems(info, statement.kind as DeclarationCreateKind, namespaceMember);
  if (invalid.length > 0) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_INVALID_MODIFIER",
      `the fence carries modifier${invalid.length === 1 ? "" : "s"} ${invalid.map((modifier) => JSON.stringify(modifier)).join(", ")}, which ${invalid.length === 1 ? "is" : "are"} not valid on ${namespaceMember ? "a namespace member" : "a top-level"} ${statement.kind}`,
      "remove the modifier from the fence, or choose the matching member/declaration kind",
    );
  }
  if (
    (info.kind === "const" || info.kind === "let" || info.kind === "var") &&
    info.modifiers.has("declare")
  ) {
    const variable = info.node as Node & { declarations?: readonly { initializer: Node | null }[] };
    if ((variable.declarations ?? []).some((declarator) => declarator.initializer !== null)) {
      return failure(
        statement,
        "address",
        "EDIT_CREATE_INVALID_MODIFIER",
        `a declared ${info.kind} binding cannot have an initializer`,
        "remove `declare` or the initializer",
      );
    }
  }
  return null;
}

function wrapVariableBody(
  statement: CreateDeclarationStatement,
  body: string,
): { text: string; program: Program } | CreateDeclarationFailure {
  const wrapped = `${statement.kind} ${statement.name} = ${body};`;
  const parsed = parseProgram(wrapped);
  if (!parsed.ok) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_MALFORMED",
      `the fence does not parse as ${statement.kind} ${statement.name}: ${parsed.message}`,
      `send the complete declaration or an initializer the \`${statement.kind}\` wrapper can accept`,
    );
  }
  return { text: wrapped, program: parsed.program };
}

function resolveTopLevel(
  statement: CreateDeclarationStatement,
  body: string,
  source: string,
): Result {
  if (!IDENTIFIER.test(statement.name)) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_INVALID_NAME",
      `${JSON.stringify(statement.name)} is not a valid top-level TypeScript identifier`,
      "use a bare identifier for a top-level create",
    );
  }
  if (statement.static) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_INVALID_MODIFIER",
      "a top-level declaration cannot be static",
      "drop `static`; it is only valid before a class member kind",
    );
  }

  const existing = scanSource(source).filter((declaration) => declaration.name === statement.name);
  if (existing.length > 0) {
    const candidates = existing
      .map((declaration) => `${declaration.kind} at line ${lineOf(source, declaration.node.start)}`)
      .join(", ");
    return failure(
      statement,
      "duplicate",
      "EDIT_CREATE_DUPLICATE",
      `${statement.path} already declares ${JSON.stringify(statement.name)} (${candidates}); create only adds a new name`,
      `select the existing declaration and replace it, or choose a new name`,
    );
  }

  let program: Program;
  let text = body;
  const parsed = parseProgram(body);
  if (!parsed.ok) {
    if (!VARIABLE_KINDS.has(statement.kind)) {
      return failure(
        statement,
        "address",
        "EDIT_CREATE_MALFORMED",
        `the fence does not parse as a ${statement.kind}: ${parsed.message}`,
        `send exactly one complete ${statement.kind} declaration`,
      );
    }
    const wrapped = wrapVariableBody(statement, body);
    if ("ok" in wrapped) {
      return wrapped;
    }
    program = wrapped.program;
    text = wrapped.text;
  } else {
    program = parsed.program;
    if (program.body.length === 0) {
      if (!VARIABLE_KINDS.has(statement.kind)) {
        return failure(
          statement,
          "address",
          "EDIT_CREATE_MALFORMED",
          "the fence is empty",
          `send exactly one complete ${statement.kind} declaration`,
        );
      }
      const wrapped = wrapVariableBody(statement, body);
      if ("ok" in wrapped) {
        return wrapped;
      }
      program = wrapped.program;
      text = wrapped.text;
    } else if (program.body.length > 1) {
      return failure(
        statement,
        "address",
        "EDIT_CREATE_MALFORMED",
        `the fence contains ${program.body.length} top-level statements; an explicit create adds exactly one declaration`,
        `send exactly one ${statement.kind} declaration; ${writeRemediation(statement.path)}`,
      );
    } else {
      const firstStatement = program.body[0];
      const unwrapped = firstStatement === undefined ? null : unwrapDeclaration(firstStatement);
      const info = unwrapped === null ? null : declarationInfo(unwrapped);
      if (info === null) {
        if (!VARIABLE_KINDS.has(statement.kind)) {
          return failure(
            statement,
            "address",
            "EDIT_CREATE_MALFORMED",
            `the fence does not contain a supported top-level declaration`,
            `send exactly one complete ${statement.kind} declaration`,
          );
        }
        const wrapped = wrapVariableBody(statement, body);
        if ("ok" in wrapped) {
          return wrapped;
        }
        program = wrapped.program;
        text = wrapped.text;
      }
    }
  }

  const firstStatement = program.body[0];
  const unwrapped = firstStatement === undefined ? null : unwrapDeclaration(firstStatement);
  const info = unwrapped === null ? null : declarationInfo(unwrapped);
  if (info === null) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_MALFORMED",
      "the fence does not declare a single named top-level declaration",
      `send exactly one complete ${statement.kind} declaration`,
    );
  }
  const mismatch = declarationShapeMismatch(statement, info, false);
  if (mismatch !== null) {
    return mismatch;
  }
  return {
    ok: true,
    path: statement.path,
    start: source.length,
    end: source.length,
    text: (source.trim() === "" ? "" : "\n") + text + "\n",
    declaration: { name: statement.name, kind: info.kind },
    memberKey: null,
  };
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, Math.max(0, Math.min(offset, source.length))).split("\n").length;
}

interface OwnerAddress {
  owner: string;
  member: string | null;
  namespaceDeclaration: boolean;
  memberKind: MemberCreateKind | null;
}

function splitAddress(
  statement: CreateDeclarationStatement,
): OwnerAddress | CreateDeclarationFailure {
  const isMemberKind = !Object.hasOwn(TOP_LEVEL_SPACES, statement.kind);
  if (isMemberKind) {
    const memberKind = statement.kind as MemberCreateKind;
    if (memberKind === "constructor") {
      if (!isDottedName(statement.name)) {
        return failure(
          statement,
          "address",
          "EDIT_CREATE_INVALID_NAME",
          "a constructor descriptor names its owner, which must be a class",
          "use `create constructor Owner in <path> with <fence>`",
        );
      }
      return { owner: statement.name, member: null, namespaceDeclaration: false, memberKind };
    }
    if (!statement.name.includes(".")) {
      return failure(
        statement,
        "address",
        "EDIT_CREATE_INVALID_NAME",
        `a ${memberKind} create needs a dotted \`Owner.name\` target`,
        `use \`create ${statement.kind} Owner.name in <path> with <fence>\``,
      );
    }
    const split = splitDotted(statement.name);
    if (split === null) {
      return failure(
        statement,
        "address",
        "EDIT_CREATE_INVALID_NAME",
        `${JSON.stringify(statement.name)} is not a dotted TypeScript identifier`,
        "use `Owner.name` with identifier segments",
      );
    }
    return { owner: split.owner, member: split.member, namespaceDeclaration: false, memberKind };
  }
  if (statement.name.includes(".")) {
    const split = splitDotted(statement.name);
    if (split === null) {
      return failure(
        statement,
        "address",
        "EDIT_CREATE_INVALID_NAME",
        `${JSON.stringify(statement.name)} is not a dotted TypeScript identifier`,
        "use `Owner.name` with identifier segments",
      );
    }
    return {
      owner: split.owner,
      member: split.member,
      namespaceDeclaration: true,
      memberKind: null,
    };
  }
  return failure(
    statement,
    "address",
    "EDIT_CREATE_INTERNAL",
    "a non-dotted top-level create reached member resolution",
    "report this harness bug",
  );
}

function isDottedName(name: string): boolean {
  return name.split(".").every((segment) => IDENTIFIER.test(segment));
}

function splitDotted(name: string): { owner: string; member: string } | null {
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) {
    return null;
  }
  const owner = name.slice(0, index);
  const member = name.slice(index + 1);
  if (!isDottedName(owner)) {
    return null;
  }
  if (!IDENTIFIER.test(member) && !PRIVATE_IDENTIFIER.test(member)) {
    return null;
  }
  return { owner, member };
}

function ownerCandidates(source: string, owner: string): ScannedDeclaration[] {
  return scanSource(source).filter((declaration) => declaration.name === owner);
}

function ownerLabel(entry: ScannedDeclaration, source: string): string {
  return `${entry.kind} at line ${lineOf(source, entry.node.start)}`;
}

function resolveOwner(
  statement: CreateDeclarationStatement,
  address: OwnerAddress,
  source: string,
): { ok: true; declaration: ScannedDeclaration } | CreateDeclarationFailure {
  const entries = ownerCandidates(source, address.owner);
  if (entries.length === 0) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_OWNER_MISSING",
      `the owner ${JSON.stringify(address.owner)} is not declared in ${statement.path}; a dotted create never creates its owner`,
      `create the top-level owner first with a separate create clause, or fix the owner name`,
    );
  }
  if (entries.length > 1) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_OWNER_AMBIGUOUS",
      `the owner ${JSON.stringify(address.owner)} resolves to ${entries.length} declarations (${entries
        .map((entry) => ownerLabel(entry, source))
        .join(", ")}); a member owner must be exactly one declaration`,
      `use a unique owner; merged declarations cannot receive a targeted member create`,
    );
  }
  const entry = entries[0];
  if (entry === undefined) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_OWNER_MISSING",
      `the owner ${JSON.stringify(address.owner)} is not declared in ${statement.path}`,
      "fix the owner name",
    );
  }
  if (!OWNER_KINDS.has(entry.kind)) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_OWNER_KIND",
      `the owner ${JSON.stringify(address.owner)} is a ${entry.kind}; a member owner must be a class, interface, namespace, or enum`,
      "choose an existing class/interface/namespace/enum owner, or create the declaration at top level first",
    );
  }

  const ownerKind = entry.kind;
  const memberKind = address.memberKind;
  const allowed = address.namespaceDeclaration
    ? ownerKind === "namespace"
    : memberKind === "enum-member"
      ? ownerKind === "enum"
      : memberKind === "constructor" ||
          memberKind === "getter" ||
          memberKind === "setter" ||
          memberKind === "accessor"
        ? ownerKind === "class"
        : ownerKind === "class" || ownerKind === "interface";
  if (!allowed) {
    const expected = address.namespaceDeclaration
      ? "namespace"
      : memberKind === "enum-member"
        ? "enum"
        : memberKind === "constructor" ||
            memberKind === "getter" ||
            memberKind === "setter" ||
            memberKind === "accessor"
          ? "class"
          : "class or interface";
    return failure(
      statement,
      "address",
      "EDIT_CREATE_OWNER_KIND",
      `the owner ${JSON.stringify(address.owner)} is a ${ownerKind}; this member create needs a ${expected} owner`,
      `choose an existing ${expected}, or create the declaration at top level first`,
    );
  }
  return { ok: true, declaration: entry };
}

interface ExistingMember {
  name: string;
  static: boolean;
  identity: "get" | "set" | "member";
  kind: string;
}

function classMembers(owner: ClassDeclaration): ExistingMember[] {
  const members: ExistingMember[] = [];
  for (const member of owner.members) {
    switch (member.kind) {
      case "MethodDeclaration": {
        const name = memberName(member.name);
        if (name !== null) {
          members.push({
            name,
            static: member.static,
            identity:
              member.accessor === "get" ? "get" : member.accessor === "set" ? "set" : "member",
            kind:
              member.accessor === "get"
                ? "getter"
                : member.accessor === "set"
                  ? "setter"
                  : "method",
          });
        }
        break;
      }
      case "PropertyDeclaration": {
        const name = memberName(member.name);
        if (name !== null) {
          members.push({ name, static: member.static, identity: "member", kind: "property" });
        }
        break;
      }
      case "ConstructorDeclaration":
        members.push({
          name: "constructor",
          static: false,
          identity: "member",
          kind: "constructor",
        });
        break;
      default:
        break;
    }
  }
  return members;
}

function interfaceMembers(owner: InterfaceDeclaration): ExistingMember[] {
  const members: ExistingMember[] = [];
  for (const member of owner.members) {
    const name = typeMemberName(member);
    if (name !== null) {
      members.push({
        name,
        static: false,
        identity: "member",
        kind: member.kind === "MethodSignature" ? "method" : "property",
      });
    }
  }
  return members;
}

function typeMemberName(member: TypeMember): string | null {
  switch (member.kind) {
    case "MethodSignature":
    case "PropertySignature":
      return memberName(member.name);
    default:
      return null;
  }
}

function enumMembers(owner: EnumDeclaration): ExistingMember[] {
  return owner.members.map((member) => ({
    name: member.name.kind === "Identifier" ? member.name.name : member.name.value,
    static: false,
    identity: "member" as const,
    kind: "enum-member",
  }));
}

function namespaceMembers(owner: NamespaceDeclaration): ExistingMember[] {
  const members: ExistingMember[] = [];
  for (const statement of owner.body) {
    const unwrapped = unwrapDeclaration(statement);
    const info = unwrapped === null ? null : declarationInfo(unwrapped);
    if (info !== null && info.name !== null) {
      members.push({ name: info.name, static: false, identity: "member", kind: info.kind });
    }
  }
  return members;
}

function duplicateMember(
  statement: CreateDeclarationStatement,
  existing: readonly ExistingMember[],
  newMember: ExistingMember,
): ExistingMember | null {
  for (const member of existing) {
    if (member.name !== newMember.name || member.static !== newMember.static) {
      continue;
    }
    // A getter/setter pair is the one legal same-name instance identity.
    const accessorPair =
      (member.identity === "get" && newMember.identity === "set") ||
      (member.identity === "set" && newMember.identity === "get");
    if (accessorPair) {
      continue;
    }
    return member;
  }
  return null;
}

function memberKindLabel(identity: "get" | "set" | "member", kind: string): string {
  return identity === "get" ? "getter" : identity === "set" ? "setter" : kind;
}

function classMemberInfo(member: ClassDeclaration["members"][number]): {
  kind: MemberCreateKind;
  name: string | null;
  static: boolean;
  identity: "get" | "set" | "member";
} | null {
  switch (member.kind) {
    case "MethodDeclaration":
      return {
        kind:
          member.accessor === "get" ? "getter" : member.accessor === "set" ? "setter" : "method",
        name: memberName(member.name),
        static: member.static,
        identity: member.accessor === "get" ? "get" : member.accessor === "set" ? "set" : "member",
      };
    case "PropertyDeclaration":
      return {
        kind: "property",
        name: memberName(member.name),
        static: member.static,
        identity: "member",
      };
    case "ConstructorDeclaration":
      return { kind: "constructor", name: "constructor", static: false, identity: "member" };
    default:
      return null;
  }
}

function modifierNamesForClassMember(member: ClassDeclaration["members"][number]): string[] {
  const modifiers: string[] = [];
  switch (member.kind) {
    case "MethodDeclaration":
      if (member.static) {
        modifiers.push("static");
      }
      if (member.accessibility !== null) {
        modifiers.push(member.accessibility);
      }
      if (member.abstract) {
        modifiers.push("abstract");
      }
      if (member.override) {
        modifiers.push("override");
      }
      if (member.readonly) {
        modifiers.push("readonly");
      }
      if (member.async === true) {
        modifiers.push("async");
      }
      if (member.generator === true) {
        modifiers.push("generator");
      }
      break;
    case "PropertyDeclaration":
      if (member.static) {
        modifiers.push("static");
      }
      if (member.accessibility !== null) {
        modifiers.push(member.accessibility);
      }
      if (member.abstract) {
        modifiers.push("abstract");
      }
      if (member.override) {
        modifiers.push("override");
      }
      if (member.readonly) {
        modifiers.push("readonly");
      }
      if (member.declare) {
        modifiers.push("declare");
      }
      break;
    case "ConstructorDeclaration":
      if (member.accessibility !== null) {
        modifiers.push(member.accessibility);
      }
      break;
    default:
      break;
  }
  return modifiers;
}

function allowedClassMemberModifiers(kind: MemberCreateKind): ReadonlySet<string> {
  switch (kind) {
    case "method":
      return new Set([
        "static",
        "public",
        "private",
        "protected",
        "abstract",
        "override",
        "async",
        "generator",
      ]);
    case "property":
      return new Set([
        "static",
        "public",
        "private",
        "protected",
        "abstract",
        "override",
        "readonly",
        "declare",
      ]);
    case "getter":
    case "setter":
    case "accessor":
      return new Set(["static", "public", "private", "protected", "abstract", "override"]);
    case "constructor":
      return new Set(["public", "private", "protected"]);
    default:
      return new Set();
  }
}

function validateClassMember(
  statement: CreateDeclarationStatement,
  owner: ClassDeclaration,
  member: ClassDeclaration["members"][number],
  address: OwnerAddress,
): { ok: true; member: ExistingMember; text: string } | CreateDeclarationFailure {
  const info = classMemberInfo(member);
  if (info === null) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_KIND_MISMATCH",
      "the fence does not contain a supported class member",
      "send one method, property, getter, setter, or constructor",
    );
  }
  const descriptorKind = address.memberKind;
  if (descriptorKind === null) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_KIND_MISMATCH",
      "a class member create is missing its member kind",
      "use `create method Owner.name …`",
    );
  }
  const kindMatches =
    descriptorKind === info.kind ||
    (descriptorKind === "accessor" && (info.kind === "getter" || info.kind === "setter"));
  if (!kindMatches) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_KIND_MISMATCH",
      `the fence declares a ${info.kind}, but the descriptor asks for a ${descriptorKind}`,
      "change the descriptor kind or make the fence declare the requested member",
    );
  }
  if (descriptorKind !== "constructor" && info.name !== address.member) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_NAME_MISMATCH",
      `the fence declares ${JSON.stringify(info.name ?? "<computed>")}, not ${JSON.stringify(address.member)}`,
      `make the fence declare exactly one ${descriptorKind} named ${JSON.stringify(address.member)}`,
    );
  }
  if (info.kind === "constructor" && owner.name === null) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_OWNER_KIND",
      "the class owner is anonymous",
      "use an existing named class",
    );
  }
  if (statement.static !== info.static) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_MODIFIER_MISMATCH",
      statement.static
        ? "the descriptor is static, but the fence member is an instance member"
        : "the descriptor is an instance member, but the fence member is static",
      statement.static
        ? `add \`static\` to the fence member, or drop it from the descriptor`
        : `remove \`static\` from the fence member, or use \`create static ${descriptorKind} …\``,
    );
  }
  const modifiers = [
    ...new Set([
      ...modifierNamesForClassMember(member),
      ...leadingModifiers(statement.replacement),
    ]),
  ];
  const allowed = allowedClassMemberModifiers(info.kind);
  const invalid = modifiers.filter((modifier) => !allowed.has(modifier));
  if (invalid.length > 0) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_INVALID_MODIFIER",
      `the fence carries modifier${invalid.length === 1 ? "" : "s"} ${invalid
        .map((modifier) => JSON.stringify(modifier))
        .join(", ")}, not valid on a class ${info.kind}`,
      "remove the modifier or choose the matching member kind",
    );
  }
  if (modifiers.includes("abstract") && owner.abstract !== true) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_INVALID_MODIFIER",
      "the fence member is abstract, but the owner class is not abstract",
      "make the owner class abstract in a separate edit, or drop `abstract`",
    );
  }
  const existing = classMembers(owner);
  const newMember: ExistingMember = {
    name: info.kind === "constructor" ? "constructor" : (info.name ?? ""),
    static: info.static,
    identity: info.identity,
    kind: info.kind,
  };
  const duplicate = duplicateMember(statement, existing, newMember);
  if (duplicate !== null) {
    return failure(
      statement,
      "duplicate",
      "EDIT_CREATE_DUPLICATE_MEMBER",
      `the owner ${JSON.stringify(address.owner)} already has a ${memberKindLabel(
        duplicate.identity,
        duplicate.kind,
      )} named ${JSON.stringify(duplicate.name)}${duplicate.static ? " (static)" : ""}`,
      "create a new name, or edit the existing member instead",
    );
  }
  return { ok: true, member: newMember, text: statement.replacement.trim() };
}

function validateInterfaceMember(
  statement: CreateDeclarationStatement,
  owner: InterfaceDeclaration,
  member: TypeMember,
  address: OwnerAddress,
): { ok: true; member: ExistingMember; text: string } | CreateDeclarationFailure {
  const kind =
    member.kind === "MethodSignature"
      ? "method"
      : member.kind === "PropertySignature"
        ? "property"
        : null;
  const name = typeMemberName(member);
  if (kind === null) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_KIND_MISMATCH",
      "the fence does not contain a supported interface member",
      "send one interface method or property; interface accessors are not supported",
    );
  }
  if (address.memberKind !== kind) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_KIND_MISMATCH",
      `the fence declares an interface ${kind}, but the descriptor asks for a ${address.memberKind}`,
      "interface create supports only `method` and `property`",
    );
  }
  if (name !== address.member) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_NAME_MISMATCH",
      `the fence declares ${JSON.stringify(name ?? "<computed>")}, not ${JSON.stringify(address.member)}`,
      `make the fence declare exactly one interface ${kind} named ${JSON.stringify(address.member)}`,
    );
  }
  const allowedModifiers: ReadonlySet<string> =
    kind === "property" ? new Set(["readonly"]) : new Set<string>();
  const invalidModifiers = leadingModifiers(statement.replacement).filter(
    (modifier) => !allowedModifiers.has(modifier),
  );
  if (invalidModifiers.length > 0) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_INVALID_MODIFIER",
      `the fence carries modifier${invalidModifiers.length === 1 ? "" : "s"} ${invalidModifiers
        .map((modifier) => JSON.stringify(modifier))
        .join(", ")}, not valid on an interface ${kind}`,
      kind === "method"
        ? "remove the modifier; interface methods carry no leading modifier"
        : "only `readonly` is valid on an interface property",
    );
  }
  const existing = interfaceMembers(owner);
  const newMember: ExistingMember = {
    name: name ?? "",
    static: false,
    identity: "member",
    kind,
  };
  const duplicate = duplicateMember(statement, existing, newMember);
  if (duplicate !== null) {
    return failure(
      statement,
      "duplicate",
      "EDIT_CREATE_DUPLICATE_MEMBER",
      `the interface ${JSON.stringify(address.owner)} already has a ${duplicate.kind} named ${JSON.stringify(duplicate.name)}`,
      "create a new name, or edit the existing member instead",
    );
  }
  return { ok: true, member: newMember, text: statement.replacement.trim() };
}

function validateEnumMember(
  statement: CreateDeclarationStatement,
  owner: EnumDeclaration,
  member: EnumDeclaration["members"][number],
  address: OwnerAddress,
): { ok: true; member: ExistingMember; text: string } | CreateDeclarationFailure {
  const name = member.name.kind === "Identifier" ? member.name.name : member.name.value;
  if (name !== address.member) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_NAME_MISMATCH",
      `the fence declares enum member ${JSON.stringify(name)}, not ${JSON.stringify(address.member)}`,
      `make the fence declare exactly one enum member named ${JSON.stringify(address.member)}`,
    );
  }
  const invalidModifiers = leadingModifiers(statement.replacement);
  if (invalidModifiers.length > 0) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_INVALID_MODIFIER",
      `the fence carries modifier${invalidModifiers.length === 1 ? "" : "s"} ${invalidModifiers
        .map((modifier) => JSON.stringify(modifier))
        .join(", ")}, not valid on an enum member`,
      "send only the enum member name, with an optional initializer",
    );
  }
  const existing = enumMembers(owner);
  const newMember: ExistingMember = {
    name,
    static: false,
    identity: "member",
    kind: "enum-member",
  };
  const duplicate = duplicateMember(statement, existing, newMember);
  if (duplicate !== null) {
    return failure(
      statement,
      "duplicate",
      "EDIT_CREATE_DUPLICATE_MEMBER",
      `the enum ${JSON.stringify(address.owner)} already has a member named ${JSON.stringify(name)}`,
      "create a new name, or edit the existing member instead",
    );
  }
  return { ok: true, member: newMember, text: statement.replacement.trim() };
}

function validateNamespaceMember(
  statement: CreateDeclarationStatement,
  owner: NamespaceDeclaration,
  body: Statement,
  address: OwnerAddress,
): { ok: true; member: ExistingMember; text: string } | CreateDeclarationFailure {
  const unwrapped = unwrapDeclaration(body);
  const info = unwrapped === null ? null : declarationInfo(unwrapped);
  if (info === null) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_KIND_MISMATCH",
      "the fence does not contain a supported namespace declaration",
      "send one function, class, interface, type, enum, namespace, const, let, var, or using declaration",
    );
  }
  const expected = statement.kind as DeclarationCreateKind;
  const allowedLeading = new Set(allowedTopLevelModifiers(expected));
  // A namespace member cannot be a default export.
  allowedLeading.delete("default");
  const invalidLeading = leadingModifiers(statement.replacement).filter(
    (modifier) => !allowedLeading.has(modifier),
  );
  if (invalidLeading.length > 0) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_INVALID_MODIFIER",
      `the fence carries modifier${invalidLeading.length === 1 ? "" : "s"} ${invalidLeading
        .map((modifier) => JSON.stringify(modifier))
        .join(", ")}, not valid on a namespace ${expected}`,
      "remove the modifier from the fence",
    );
  }
  if (info.name !== address.member) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_NAME_MISMATCH",
      `the fence declares ${JSON.stringify(info.name ?? "<anonymous>")}, not ${JSON.stringify(address.member)}`,
      `make the fence declare exactly one ${expected} named ${JSON.stringify(address.member)}`,
    );
  }
  if (info.kind !== expected) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_KIND_MISMATCH",
      `the fence declares a ${info.kind}, but the descriptor asks for a ${expected} namespace member`,
      "change the descriptor kind or make the fence declare the requested kind",
    );
  }
  const invalid = modifierProblems(info, expected, true);
  if (invalid.length > 0) {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_INVALID_MODIFIER",
      `the fence carries modifier${invalid.length === 1 ? "" : "s"} ${invalid
        .map((modifier) => JSON.stringify(modifier))
        .join(", ")}, not valid on a namespace member`,
      "remove the modifier from the fence",
    );
  }
  const existing = namespaceMembers(owner);
  const newMember: ExistingMember = {
    name: address.member ?? "",
    static: false,
    identity: "member",
    kind: info.kind,
  };
  const duplicate = duplicateMember(statement, existing, newMember);
  if (duplicate !== null) {
    return failure(
      statement,
      "duplicate",
      "EDIT_CREATE_DUPLICATE_MEMBER",
      `the namespace ${JSON.stringify(address.owner)} already declares ${JSON.stringify(duplicate.name)} (${duplicate.kind})`,
      "create a new name, or edit the existing declaration instead",
    );
  }
  return { ok: true, member: newMember, text: statement.replacement.trim() };
}

function indentBlock(text: string, indent: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let minimum = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    const match = /^[ \t]*/.exec(line);
    const width = match === null ? 0 : match[0].length;
    minimum = Math.min(minimum, width);
  }
  const strip = Number.isFinite(minimum) ? minimum : 0;
  return lines
    .map((line) =>
      line.trim() === "" ? "" : `${indent}${line.slice(Math.min(strip, line.length))}`,
    )
    .join("\n");
}

function insertionForOwner(
  source: string,
  owner: Node,
  body: string,
): { start: number; text: string } | CreateDeclarationFailure {
  const close = source.lastIndexOf("}", Math.max(0, owner.end - 1));
  if (close < owner.start) {
    return {
      ok: false,
      stage: "address",
      diagnostics: [
        "stage: address",
        "code: EDIT_CREATE_MALFORMED",
        "cannot insert a member: the owner has no body closing brace",
        "hint: create the member in a class/interface/namespace/enum with a body",
      ].join("\n"),
    };
  }
  const lineStart = source.lastIndexOf("\n", Math.max(0, close - 1)) + 1;
  const linePrefix = source.slice(lineStart, close);
  const lineIndent = /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "";
  if (linePrefix.trim() === "") {
    const memberIndent = `${linePrefix}  `;
    return { start: lineStart, text: `${indentBlock(body, memberIndent)}\n` };
  }
  // The closing brace shares a line with other code: open a new line first.
  const memberIndent = `${lineIndent}  `;
  return {
    start: close,
    text: `\n${indentBlock(body, memberIndent)}\n${lineIndent}`,
  };
}

function resolveMember(
  statement: CreateDeclarationStatement,
  body: string,
  source: string,
): Result {
  const address = splitAddress(statement);
  if ("ok" in address) {
    return address;
  }
  const owner = resolveOwner(statement, address, source);
  if (!owner.ok) {
    return owner;
  }
  const ownerKind = owner.declaration.kind;
  if (statement.static) {
    if (ownerKind !== "class") {
      return failure(
        statement,
        "address",
        "EDIT_CREATE_INVALID_MODIFIER",
        `\`static\` is only valid for class members, but the owner ${JSON.stringify(address.owner)} is a ${ownerKind}`,
        "drop `static`, or target an existing class member",
      );
    }
    if (address.memberKind === null || !STATIC_CREATE_KINDS.has(address.memberKind)) {
      return failure(
        statement,
        "address",
        "EDIT_CREATE_INVALID_MODIFIER",
        `\`static\` is not valid on a ${address.memberKind ?? statement.kind} member`,
        "drop `static`, or use a class method/property/getter/setter/accessor",
      );
    }
  }
  const ownerSimpleName =
    ownerKind === "namespace"
      ? ((owner.declaration.node as NamespaceDeclaration).name.split(".").at(-1) ?? "Owner")
      : ((owner.declaration.node as ClassDeclaration | InterfaceDeclaration | EnumDeclaration).name
          ?.name ?? "Owner");

  let synthetic: string;
  let member: ExistingMember;
  let text: string;
  switch (ownerKind) {
    case "class": {
      synthetic = `class ${ownerSimpleName} {\n${body}\n}`;
      const parsed = parseProgram(synthetic);
      if (!parsed.ok) {
        return failure(
          statement,
          "address",
          "EDIT_CREATE_MALFORMED",
          `the fence does not parse as a class member: ${parsed.message}`,
          "send exactly one complete class member",
        );
      }
      const declaration = parsed.program.body[0];
      if (declaration?.kind !== "ClassDeclaration" || declaration.members.length !== 1) {
        return failure(
          statement,
          "address",
          "EDIT_CREATE_MALFORMED",
          "the fence must contain exactly one class member",
          "send exactly one method, property, getter, setter, or constructor",
        );
      }
      const only = declaration.members[0];
      if (only === undefined) {
        return failure(
          statement,
          "address",
          "EDIT_CREATE_MALFORMED",
          "the fence contains no class member",
          "send exactly one complete class member",
        );
      }
      const validated = validateClassMember(
        statement,
        owner.declaration.node as ClassDeclaration,
        only,
        address,
      );
      if (!validated.ok) {
        return validated;
      }
      member = validated.member;
      text = validated.text;
      break;
    }
    case "interface": {
      synthetic = `interface ${ownerSimpleName} {\n${body}\n}`;
      const parsed = parseProgram(synthetic);
      if (!parsed.ok) {
        return failure(
          statement,
          "address",
          "EDIT_CREATE_MALFORMED",
          `the fence does not parse as an interface member: ${parsed.message}`,
          "send exactly one interface method or property",
        );
      }
      const declaration = parsed.program.body[0];
      if (declaration?.kind !== "InterfaceDeclaration" || declaration.members.length !== 1) {
        return failure(
          statement,
          "address",
          "EDIT_CREATE_MALFORMED",
          "the fence must contain exactly one interface member",
          "send exactly one interface method or property",
        );
      }
      const only = declaration.members[0];
      if (only === undefined) {
        return failure(
          statement,
          "address",
          "EDIT_CREATE_MALFORMED",
          "the fence contains no interface member",
          "send exactly one interface method or property",
        );
      }
      const validated = validateInterfaceMember(
        statement,
        owner.declaration.node as InterfaceDeclaration,
        only,
        address,
      );
      if (!validated.ok) {
        return validated;
      }
      member = validated.member;
      text = validated.text;
      break;
    }
    case "enum": {
      synthetic = `enum ${ownerSimpleName} {\n${body}\n}`;
      const parsed = parseProgram(synthetic);
      if (!parsed.ok) {
        return failure(
          statement,
          "address",
          "EDIT_CREATE_MALFORMED",
          `the fence does not parse as an enum member: ${parsed.message}`,
          "send exactly one enum member name, with an optional initializer",
        );
      }
      const declaration = parsed.program.body[0];
      if (declaration?.kind !== "EnumDeclaration" || declaration.members.length !== 1) {
        return failure(
          statement,
          "address",
          "EDIT_CREATE_MALFORMED",
          "the fence must contain exactly one enum member",
          "send exactly one enum member name, with an optional initializer",
        );
      }
      const only = declaration.members[0];
      if (only === undefined) {
        return failure(
          statement,
          "address",
          "EDIT_CREATE_MALFORMED",
          "the fence contains no enum member",
          "send exactly one enum member name, with an optional initializer",
        );
      }
      const validated = validateEnumMember(
        statement,
        owner.declaration.node as EnumDeclaration,
        only,
        address,
      );
      if (!validated.ok) {
        return validated;
      }
      member = validated.member;
      text = validated.text;
      break;
    }
    case "namespace": {
      synthetic = `namespace ${ownerSimpleName} {\n${body}\n}`;
      const parsed = parseProgram(synthetic);
      if (!parsed.ok) {
        return failure(
          statement,
          "address",
          "EDIT_CREATE_MALFORMED",
          `the fence does not parse as a namespace declaration: ${parsed.message}`,
          "send exactly one complete declaration",
        );
      }
      const declaration = parsed.program.body[0];
      if (declaration?.kind !== "NamespaceDeclaration" || declaration.body.length !== 1) {
        return failure(
          statement,
          "address",
          "EDIT_CREATE_MALFORMED",
          "the fence must contain exactly one namespace declaration",
          "send exactly one complete declaration",
        );
      }
      const only = declaration.body[0];
      if (only === undefined) {
        return failure(
          statement,
          "address",
          "EDIT_CREATE_MALFORMED",
          "the fence contains no namespace declaration",
          "send exactly one complete declaration",
        );
      }
      const validated = validateNamespaceMember(
        statement,
        owner.declaration.node as NamespaceDeclaration,
        only,
        address,
      );
      if (!validated.ok) {
        return validated;
      }
      member = validated.member;
      text = validated.text;
      break;
    }
    default:
      return failure(
        statement,
        "address",
        "EDIT_CREATE_OWNER_KIND",
        `the owner ${JSON.stringify(address.owner)} is not a class, interface, namespace, or enum`,
        "choose an existing class, interface, namespace, or enum owner",
      );
  }

  const insertion = insertionForOwner(source, owner.declaration.node, text);
  if ("ok" in insertion) {
    return insertion;
  }
  const fullName = address.memberKind === "constructor" ? address.owner : statement.name;
  const identity = member.identity === "member" ? member.kind : member.identity;
  return {
    ok: true,
    path: statement.path,
    start: insertion.start,
    end: insertion.start,
    text: insertion.text,
    declaration: { name: fullName, kind: identity },
    memberKey: `${statement.path}\u0000${address.owner}\u0000${member.static ? "static" : "instance"}\u0000${member.name}\u0000${member.identity}`,
  };
}

/**
 * Resolve one explicit create against the file's current source. The returned
 * region is a zero-width insertion; the caller owns path safety, target
 * uniqueness claims, and atomic application.
 */
export function resolveCreateDeclaration(
  statement: CreateDeclarationStatement,
  source: string,
): Result {
  const body = statement.replacement.trim();
  if (body === "") {
    return failure(
      statement,
      "address",
      "EDIT_CREATE_MALFORMED",
      "the create fence is empty",
      "send the declaration or member text between the sentinel fences",
    );
  }
  const isMemberKind = !Object.hasOwn(TOP_LEVEL_SPACES, statement.kind);
  if (!isMemberKind && !statement.name.includes(".")) {
    return resolveTopLevel(statement, body, source);
  }
  return resolveMember(statement, body, source);
}
