import { ParseError, Parser } from "./parser";
import type {
  BindingName,
  BlockStatement,
  ClassDeclaration,
  ClassExpression,
  ClassMember,
  EnumDeclaration,
  ExportDefaultDeclaration,
  Expression,
  FunctionDeclaration,
  ImportDeclaration,
  InterfaceDeclaration,
  MemberName,
  NamespaceDeclaration,
  Node,
  ObjectLiteral,
  Parameter,
  Program,
  Statement,
  Type,
  TypeMember,
  VariableStatement,
} from "./parser";

export type SymbolSpace = "value" | "type" | "namespace";

export type ScopeKind = "global" | "function" | "block" | "namespace" | "class";

export interface Symbol {
  name: string;
  space: SymbolSpace;
  declarations: Node[];
  scope: Scope;
}

export class Scope {
  readonly kind: ScopeKind;
  readonly parent: Scope | null;
  readonly node: Node | null;
  readonly bindings = new Map<string, Symbol[]>();

  constructor(kind: ScopeKind, parent: Scope | null, node: Node | null = null) {
    this.kind = kind;
    this.parent = parent;
    this.node = node;
  }

  add(symbol: Symbol): Symbol {
    const symbols = this.bindings.get(symbol.name);
    if (symbols === undefined) {
      this.bindings.set(symbol.name, [symbol]);
      return symbol;
    }
    const existing = symbols.find((candidate) => candidate.space === symbol.space);
    if (existing === undefined) {
      symbols.push(symbol);
      return symbol;
    }
    existing.declarations.push(...symbol.declarations);
    return existing;
  }

  resolveLocal(name: string, space?: SymbolSpace): Symbol[] {
    const symbols = this.bindings.get(name);
    if (symbols === undefined) {
      return [];
    }
    if (space === undefined) {
      return symbols;
    }
    return symbols.filter((symbol) => symbol.space === space);
  }
}

export function resolve(scope: Scope, name: string, space?: SymbolSpace): Symbol | null {
  let current: Scope | null = scope;
  while (current !== null) {
    const matches = current.resolveLocal(name, space);
    const first = matches[0];
    if (first !== undefined) {
      return first;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Class members are keyed by their source name. Private names arrive from the
 * parser as identifiers whose name keeps the `#` prefix (see Parser's
 * parsePrivateName), so `#x` and a public `x` stay distinct and index locators
 * keep the prefix too (e.g. `A.#x`, `A.#m`). Chosen over excluding private
 * members: it needs no binder special-casing and makes them findable.
 */
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

export class Binder {
  readonly rootScope: Scope;
  readonly scopes: Scope[] = [];

  private readonly scopeByNode = new Map<Node, Scope>();
  private readonly namespaceScopes = new Map<Symbol, Scope>();

  constructor(program: Program) {
    this.rootScope = this.createScope("global", null, program);
    this.bindStatements(program.body, this.rootScope);
  }

  scopeOf(node: Node): Scope | null {
    return this.scopeByNode.get(node) ?? null;
  }

  private createScope(kind: ScopeKind, parent: Scope | null, node: Node): Scope {
    const scope = new Scope(kind, parent, node);
    this.scopes.push(scope);
    this.scopeByNode.set(node, scope);
    return scope;
  }

  private declare(scope: Scope, name: string, space: SymbolSpace, declaration: Node): Symbol {
    return scope.add({ name, space, declarations: [declaration], scope });
  }

  private bindStatements(statements: readonly Statement[], scope: Scope): void {
    for (const statement of statements) {
      this.bindStatement(statement, scope);
    }
  }

  private bindStatement(statement: Statement, scope: Scope): void {
    switch (statement.kind) {
      case "BlockStatement":
        this.bindBlock(statement, scope);
        return;
      case "VariableStatement":
        this.bindVariableStatement(statement, scope);
        return;
      case "FunctionDeclaration":
        this.bindFunction(statement, scope);
        return;
      case "ClassDeclaration":
        this.bindClass(statement, scope);
        return;
      case "InterfaceDeclaration":
        this.declare(scope, statement.name.name, "type", statement);
        return;
      case "TypeAliasDeclaration":
        this.declare(scope, statement.name.name, "type", statement);
        return;
      case "EnumDeclaration":
        this.declare(scope, statement.name.name, "value", statement);
        this.declare(scope, statement.name.name, "type", statement);
        return;
      case "NamespaceDeclaration":
        this.bindNamespace(statement, scope);
        return;
      case "ImportDeclaration":
        this.bindImport(statement, scope);
        return;
      case "ImportEqualsDeclaration":
        this.declare(scope, statement.name.name, "value", statement);
        return;
      case "ExportNamedDeclaration":
        if (statement.declaration !== null) {
          this.bindStatement(statement.declaration, scope);
        }
        return;
      case "ExportDefaultDeclaration":
        this.bindExportDefault(statement, scope);
        return;
      case "IfStatement":
        this.bindStatement(statement.consequent, scope);
        if (statement.alternate !== null) {
          this.bindStatement(statement.alternate, scope);
        }
        return;
      case "WhileStatement":
      case "DoWhileStatement":
        this.bindStatement(statement.body, scope);
        return;
      case "ForStatement": {
        const forScope = this.createScope("block", scope, statement);
        if (statement.init !== null && statement.init.kind === "VariableStatement") {
          this.bindVariableStatement(statement.init, forScope);
        }
        this.bindStatement(statement.body, forScope);
        return;
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const forScope = this.createScope("block", scope, statement);
        if (statement.left.kind === "VariableStatement") {
          this.bindVariableStatement(statement.left, forScope);
        }
        this.bindStatement(statement.body, forScope);
        return;
      }
      case "SwitchStatement": {
        const switchScope = this.createScope("block", scope, statement);
        for (const switchCase of statement.cases) {
          this.bindStatements(switchCase.consequent, switchScope);
        }
        return;
      }
      case "TryStatement":
        this.bindStatement(statement.block, scope);
        if (statement.handler !== null) {
          const catchScope = this.createScope("block", scope, statement.handler);
          if (statement.handler.param !== null) {
            this.declare(
              catchScope,
              statement.handler.param.name,
              "value",
              statement.handler.param,
            );
          }
          this.bindStatement(statement.handler.body, catchScope);
        }
        if (statement.finalizer !== null) {
          this.bindStatement(statement.finalizer, scope);
        }
        return;
      case "LabeledStatement":
        this.bindStatement(statement.body, scope);
        return;
      default:
        return;
    }
  }

  private bindBlock(statement: BlockStatement, scope: Scope): void {
    const blockScope = this.createScope("block", scope, statement);
    this.bindStatements(statement.body, blockScope);
  }

  private bindVariableStatement(statement: VariableStatement, scope: Scope): void {
    const target = statement.declarationKind === "var" ? this.functionOrGlobalScope(scope) : scope;
    for (const declarator of statement.declarations) {
      this.bindBindingName(declarator.name, target, "value", declarator);
      if (declarator.initializer !== null) {
        this.bindExpression(declarator.initializer, scope);
      }
    }
  }

  private functionOrGlobalScope(scope: Scope): Scope {
    let current: Scope | null = scope;
    while (current !== null) {
      if (current.kind === "function" || current.kind === "global") {
        return current;
      }
      current = current.parent;
    }
    return this.rootScope;
  }

  private bindBindingName(
    name: BindingName,
    scope: Scope,
    space: SymbolSpace,
    declaration: Node,
  ): void {
    switch (name.kind) {
      case "Identifier":
        this.declare(scope, name.name, space, declaration);
        return;
      case "ArrayPattern":
        for (const element of name.elements) {
          if (element !== null) {
            this.bindBindingName(element.binding, scope, space, declaration);
          }
        }
        return;
      case "ObjectPattern":
        for (const property of name.properties) {
          this.bindBindingName(property.binding, scope, space, declaration);
        }
        return;
    }
  }

  private bindParameters(parameters: readonly Parameter[], scope: Scope): void {
    for (const parameter of parameters) {
      this.bindBindingName(parameter.name, scope, "value", parameter);
    }
  }

  private bindFunction(declaration: FunctionDeclaration, scope: Scope): void {
    if (declaration.name !== null) {
      this.declare(scope, declaration.name.name, "value", declaration);
    }
    if (declaration.body === null) {
      return;
    }
    const functionScope = this.createScope("function", scope, declaration);
    this.bindParameters(declaration.parameters, functionScope);
    this.bindBlock(declaration.body, functionScope);
  }

  private bindClass(declaration: ClassDeclaration, scope: Scope): void {
    if (declaration.name !== null) {
      this.declare(scope, declaration.name.name, "value", declaration);
      this.declare(scope, declaration.name.name, "type", declaration);
    }
    const classScope = this.createScope("class", scope, declaration);
    if (declaration.name !== null) {
      this.declare(classScope, declaration.name.name, "value", declaration);
      this.declare(classScope, declaration.name.name, "type", declaration);
    }
    this.bindClassMembers(declaration.members, classScope);
  }

  private bindClassMembers(members: readonly ClassMember[], scope: Scope): void {
    for (const member of members) {
      switch (member.kind) {
        case "MethodDeclaration": {
          const name = memberName(member.name);
          if (name !== null) {
            this.declare(scope, name, "value", member);
          }
          if (member.body !== null) {
            const functionScope = this.createScope("function", scope, member);
            this.bindParameters(member.parameters, functionScope);
            this.bindBlock(member.body, functionScope);
          }
          break;
        }
        case "PropertyDeclaration": {
          const name = memberName(member.name);
          if (name !== null) {
            this.declare(scope, name, "value", member);
          }
          if (member.initializer !== null) {
            this.bindExpression(member.initializer, scope);
          }
          break;
        }
        case "ConstructorDeclaration": {
          if (member.body !== null) {
            const functionScope = this.createScope("function", scope, member);
            this.bindParameters(member.parameters, functionScope);
            this.bindBlock(member.body, functionScope);
          }
          break;
        }
        case "StaticBlock": {
          const staticScope = this.createScope("block", scope, member);
          this.bindStatements(member.body.body, staticScope);
          break;
        }
        default:
          break;
      }
    }
  }

  private bindNamespace(declaration: NamespaceDeclaration, scope: Scope): void {
    const segments = declaration.name.split(".");
    let currentScope = scope;
    for (const segment of segments) {
      const symbol = this.declare(currentScope, segment, "namespace", declaration);
      let namespaceScope = this.namespaceScopes.get(symbol);
      if (namespaceScope === undefined) {
        namespaceScope = this.createScope("namespace", currentScope, declaration);
        this.namespaceScopes.set(symbol, namespaceScope);
      }
      this.scopeByNode.set(declaration, namespaceScope);
      currentScope = namespaceScope;
    }
    this.bindStatements(declaration.body, currentScope);
  }

  private bindImport(declaration: ImportDeclaration, scope: Scope): void {
    const defaultSpace: SymbolSpace = declaration.importKind === "type" ? "type" : "value";
    if (declaration.defaultImport !== null) {
      this.declare(scope, declaration.defaultImport.name, defaultSpace, declaration.defaultImport);
    }
    if (declaration.namespaceImport !== null) {
      this.declare(
        scope,
        declaration.namespaceImport.name,
        defaultSpace,
        declaration.namespaceImport,
      );
    }
    for (const specifier of declaration.namedImports) {
      const space: SymbolSpace =
        declaration.importKind === "type" || specifier.typeOnly ? "type" : "value";
      this.declare(scope, specifier.local.name, space, specifier.local);
    }
  }

  private bindExportDefault(declaration: ExportDefaultDeclaration, scope: Scope): void {
    const inner = declaration.declaration;
    if (inner.kind === "FunctionDeclaration") {
      this.bindFunction(inner, scope);
      return;
    }
    if (inner.kind === "ClassDeclaration") {
      this.bindClass(inner, scope);
      return;
    }
    this.bindExpression(inner, scope);
  }

  private bindExpression(expression: Expression, scope: Scope): void {
    switch (expression.kind) {
      case "ArrowFunctionExpression": {
        const functionScope = this.createScope("function", scope, expression);
        this.bindParameters(expression.params, functionScope);
        if (expression.body.kind === "BlockStatement") {
          this.bindBlock(expression.body, functionScope);
        } else {
          this.bindExpression(expression.body, functionScope);
        }
        return;
      }
      case "FunctionExpression": {
        const functionScope = this.createScope("function", scope, expression);
        if (expression.name !== null) {
          this.declare(functionScope, expression.name.name, "value", expression);
        }
        this.bindParameters(expression.parameters, functionScope);
        this.bindBlock(expression.body, functionScope);
        return;
      }
      case "ClassExpression": {
        const classScope = this.createScope("class", scope, expression);
        if (expression.name !== null) {
          this.declare(classScope, expression.name.name, "value", expression);
          this.declare(classScope, expression.name.name, "type", expression);
        }
        this.bindClassMembers(expression.members, classScope);
        return;
      }
      case "ParenthesizedExpression":
        this.bindExpression(expression.expression, scope);
        return;
      default:
        return;
    }
  }
}

export interface Locator {
  path: string;
  name: string;
  kind: string;
}

/**
 * The edit-dsl kinds that address an index entry whose internal declaration
 * kind is `"variable"`. The index keeps `"variable"` for variable declarators,
 * statements, and class fields (JSON addresses and utility tests depend on it),
 * while the selection grammar admits only `const`, `let`, and `var` for them.
 */
const VARIABLE_LOCATOR_KINDS = ["const", "let", "var"] as const;

/** True when a locator kind addresses an entry kind; `""` is the wildcard. */
export function locatorKindMatches(locatorKind: string, entryKind: string): boolean {
  if (locatorKind === "" || locatorKind === entryKind) {
    return true;
  }
  return (
    entryKind === "variable" && (VARIABLE_LOCATOR_KINDS as readonly string[]).includes(locatorKind)
  );
}

/**
 * The grammar-valid `select` kinds for an internal entry kind. A variable
 * entry resolves as `const`, `let`, or `var`; every other kind keeps its label.
 */
export function grammarKindsForEntryKind(entryKind: string): readonly string[] {
  return entryKind === "variable" ? VARIABLE_LOCATOR_KINDS : [entryKind];
}

/**
 * Why an index entry cannot be addressed as a whole declaration even though its
 * name resolves: a variable binding that shares its statement with a sibling
 * declarator, or a destructuring binding whose declarator also contains sibling
 * bindings. `match`/`pick` inside the entry stay available.
 */
export type WholeSymbolRestrictionReason = "multi-declarator" | "destructuring";

export interface WholeSymbolRestriction {
  reason: WholeSymbolRestrictionReason;
  detail: string;
}

export interface IndexEntry {
  locator: Locator;
  symbol: Symbol;
  node: Node;
  /** Present when a whole-symbol edit would rewrite sibling bindings. */
  wholeSymbolRestriction?: WholeSymbolRestriction;
}

export interface SourceFile {
  path: string;
  source: string;
}

export interface SkippedFile {
  path: string;
  message: string;
}

export interface TolerantIndex {
  index: SymbolIndex;
  skipped: SkippedFile[];
}

/**
 * The TypeScript symbol spaces a declaration entry occupies. The binder keeps
 * a class/enum's value and type bindings as two `Symbol`s with the same
 * declaration node, collapsed into one index entry, so the entry's
 * `symbol.space` names only one side. The declaration kind is authoritative.
 */
export function declarationSpaces(entry: IndexEntry): readonly SymbolSpace[] {
  if (!("kind" in entry.node)) {
    return [entry.symbol.space];
  }
  switch ((entry.node as { kind: string }).kind) {
    case "ClassDeclaration":
    case "EnumDeclaration":
      return ["value", "type"];
    case "InterfaceDeclaration":
    case "TypeAliasDeclaration":
      return ["type"];
    case "NamespaceDeclaration":
      return ["namespace"];
    case "FunctionDeclaration":
    case "MethodDeclaration":
    case "ObjectMethod":
    case "VariableDeclarator":
    case "VariableStatement":
    case "PropertyDeclaration":
    case "ImportDeclaration":
    case "ImportEqualsDeclaration":
    case "Identifier":
      return ["value"];
    default:
      return [entry.symbol.space];
  }
}

/** True when `entry` is declared in `space`; a `null` space accepts any space. */
export function entryInSpace(entry: IndexEntry, space: SymbolSpace | null): boolean {
  return space === null || declarationSpaces(entry).includes(space);
}

export class SymbolIndex {
  readonly entries: IndexEntry[];

  constructor(entries: IndexEntry[]) {
    this.entries = entries;
  }

  /**
   * Exact path/name/declaration-kind lookup. An empty `kind` is the edit-dsl
   * protocol's wildcard: any declaration kind at that path and name. A
   * `const`/`let`/`var` locator also matches an internal `"variable"` entry, so
   * the grammar the model is taught addresses variable declarations. An
   * optional `space` filters by TypeScript symbol space (`resolve value|type|
   * namespace`); `null` accepts every space.
   */
  lookup(locator: Locator, space: SymbolSpace | null = null): IndexEntry[] {
    return this.entries.filter(
      (entry) =>
        entry.locator.path === locator.path &&
        entry.locator.name === locator.name &&
        locatorKindMatches(locator.kind, entry.locator.kind) &&
        entryInSpace(entry, space),
    );
  }

  byName(name: string): IndexEntry[] {
    return this.entries.filter((entry) => entry.locator.name === name);
  }
}

/**
 * The declarations of `symbol` that TypeScript rejects as a duplicate (#14), or
 * an empty list when the symbol is single/absent or its declarations are a
 * legal merge. Mirrors the loop's #48 guard (`topLevelDeclarations`): only the
 * kinds that cannot be redeclared at top level are considered — a function with
 * a body, a class, or a type alias. Overload signatures, interfaces, enums and
 * namespaces merge, so they stay unflagged.
 */
export function duplicateDeclarations(symbol: Symbol): Node[] {
  const declarations = symbol.declarations.filter((declaration) => {
    if (!("kind" in declaration)) {
      return false;
    }
    const kind = (declaration as { kind: string }).kind;
    if (kind === "FunctionDeclaration") {
      return (declaration as FunctionDeclaration).body !== null;
    }
    return kind === "ClassDeclaration" || kind === "TypeAliasDeclaration";
  });
  return declarations.length > 1 ? declarations : [];
}

function declarationKind(node: Node): string | null {
  if (!("kind" in node)) {
    return null;
  }
  switch ((node as { kind: string }).kind) {
    case "FunctionDeclaration":
      return "function";
    case "MethodDeclaration":
    case "MethodSignature":
    case "ObjectMethod":
      return "method";
    case "ClassDeclaration":
      return "class";
    case "InterfaceDeclaration":
      return "interface";
    case "TypeAliasDeclaration":
      return "type";
    case "PropertySignature":
    case "Property":
      return "property";
    case "EnumMember":
      return "enum-member";
    case "VariableDeclarator":
    case "VariableStatement":
    case "PropertyDeclaration":
      return "variable";
    case "EnumDeclaration":
      return "enum";
    case "NamespaceDeclaration":
      return "namespace";
    case "ImportDeclaration":
    case "ImportEqualsDeclaration":
    case "Identifier":
      return "variable";
    default:
      return null;
  }
}

function namespaceScopeSymbol(scope: Scope): Symbol | null {
  const node = scope.node;
  const parent = scope.parent;
  if (node === null || parent === null) {
    return null;
  }
  for (const symbols of parent.bindings.values()) {
    for (const symbol of symbols) {
      if (symbol.space === "namespace" && symbol.declarations.includes(node)) {
        return symbol;
      }
    }
  }
  return null;
}

function scopePrefix(scope: Scope, root: Scope, cache: Map<Scope, string | null>): string | null {
  const cached = cache.get(scope);
  if (cached !== undefined) {
    return cached;
  }
  if (scope === root) {
    cache.set(scope, "");
    return "";
  }
  const parent = scope.parent;
  const parentPrefix = parent === null ? null : scopePrefix(parent, root, cache);
  let prefix: string | null = null;
  if (parentPrefix !== null) {
    if (scope.kind === "namespace") {
      const symbol = namespaceScopeSymbol(scope);
      prefix = symbol === null ? null : `${parentPrefix}${symbol.name}.`;
    } else if (scope.kind === "class") {
      const node = scope.node;
      if (node !== null && "kind" in node) {
        const declaration = node as ClassDeclaration | ClassExpression;
        if (
          (declaration.kind === "ClassDeclaration" || declaration.kind === "ClassExpression") &&
          declaration.name !== null
        ) {
          prefix = `${parentPrefix}${declaration.name.name}.`;
        }
      }
    }
  }
  cache.set(scope, prefix);
  return prefix;
}

/**
 * Imported names are aliases of declarations in another module, not editable
 * declarations in this file, so the index excludes them. Otherwise `import`
 * statements surface as misleading `variable` entries that no tool can edit.
 * This only filters index entries: the binder and its scopes still bind imports
 * normally.
 */
function importBindingNodes(program: Program): Set<Node> {
  const nodes = new Set<Node>();
  const collect = (statement: Statement): void => {
    switch (statement.kind) {
      case "ImportDeclaration": {
        if (statement.defaultImport !== null) {
          nodes.add(statement.defaultImport);
        }
        if (statement.namespaceImport !== null) {
          nodes.add(statement.namespaceImport);
        }
        for (const specifier of statement.namedImports) {
          nodes.add(specifier.local);
        }
        return;
      }
      case "ImportEqualsDeclaration":
        nodes.add(statement);
        return;
      case "NamespaceDeclaration":
        for (const inner of statement.body) {
          collect(inner);
        }
        return;
      case "ExportNamedDeclaration":
        if (statement.declaration !== null) {
          collect(statement.declaration);
        }
        return;
      default:
        return;
    }
  };
  for (const statement of program.body) {
    collect(statement);
  }
  return nodes;
}

/**
 * Mark variable bindings that cannot be edited as a whole declaration without
 * touching a sibling binding: a destructuring pattern shares one declarator for
 * every name, and a multi-declarator statement has sibling declarators in the
 * same statement. Per-binding `match`/`pick` edits remain available.
 */
function variableBindingRestrictions(program: Program): Map<Node, WholeSymbolRestriction> {
  const restrictions = new Map<Node, WholeSymbolRestriction>();
  const visitVariable = (statement: VariableStatement): void => {
    const multiple = statement.declarations.length > 1;
    for (const declarator of statement.declarations) {
      if (declarator.name.kind !== "Identifier") {
        restrictions.set(declarator, {
          reason: "destructuring",
          detail:
            "the binding is part of a destructuring pattern whose declarator also contains sibling bindings",
        });
      } else if (multiple) {
        restrictions.set(declarator, {
          reason: "multi-declarator",
          detail: "the binding shares its statement with sibling declarators",
        });
      }
    }
  };
  const visitStatements = (statements: readonly Statement[]): void => {
    for (const statement of statements) {
      visitStatement(statement);
    }
  };
  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "VariableStatement":
        visitVariable(statement);
        return;
      case "BlockStatement":
        visitStatements(statement.body);
        return;
      case "IfStatement":
        visitStatement(statement.consequent);
        if (statement.alternate !== null) {
          visitStatement(statement.alternate);
        }
        return;
      case "WhileStatement":
      case "DoWhileStatement":
        visitStatement(statement.body);
        return;
      case "ForStatement":
        if (statement.init !== null && statement.init.kind === "VariableStatement") {
          visitVariable(statement.init);
        }
        visitStatement(statement.body);
        return;
      case "ForInStatement":
      case "ForOfStatement":
        if (statement.left.kind === "VariableStatement") {
          visitVariable(statement.left);
        }
        visitStatement(statement.body);
        return;
      case "SwitchStatement":
        for (const switchCase of statement.cases) {
          visitStatements(switchCase.consequent);
        }
        return;
      case "TryStatement":
        visitStatement(statement.block);
        if (statement.handler !== null) {
          visitStatement(statement.handler.body);
        }
        if (statement.finalizer !== null) {
          visitStatement(statement.finalizer);
        }
        return;
      case "LabeledStatement":
        visitStatement(statement.body);
        return;
      case "NamespaceDeclaration":
        visitStatements(statement.body);
        return;
      case "ExportNamedDeclaration":
        if (statement.declaration !== null) {
          visitStatement(statement.declaration);
        }
        return;
      case "ExportDefaultDeclaration":
        if (
          statement.declaration.kind === "FunctionDeclaration" ||
          statement.declaration.kind === "ClassDeclaration"
        ) {
          visitStatement(statement.declaration);
        }
        return;
      default:
        return;
    }
  };
  visitStatements(program.body);
  return restrictions;
}

type AddMemberEntry = (node: Node, name: string, kind: string, space: SymbolSpace) => void;

/** The source name of an object-literal property key, or null when computed. */
function propertyKeyName(key: Expression, computed: boolean): string | null {
  if (computed) {
    return null;
  }
  switch (key.kind) {
    case "Identifier":
      return key.name;
    case "StringLiteral":
      return key.value;
    case "NumberLiteral":
      return key.raw;
    default:
      return null;
  }
}

// Unwrap the expression forms that keep an object literal's owner unchanged.
function objectLiteralValue(expression: Expression): ObjectLiteral | null {
  switch (expression.kind) {
    case "ObjectLiteral":
      return expression;
    case "ParenthesizedExpression":
    case "NonNullExpression":
    case "AsExpression":
    case "TypeAssertion":
      return objectLiteralValue(expression.expression);
    default:
      return null;
  }
}

/**
 * Index named members that the binder does not scope: interface/type-literal
 * members, enum members, and object-literal properties/methods owned by a
 * declared variable or class field. Addresses stay dotted and reuse the owner's
 * namespace/class prefix, e.g. `Cell.getValue`, `Color.Red`, `config.timeout`.
 */
function collectNestedMemberEntries(program: Program, add: AddMemberEntry): void {
  const collectTypeMembers = (members: readonly TypeMember[], owner: string): void => {
    for (const member of members) {
      switch (member.kind) {
        case "PropertySignature": {
          const name = memberName(member.name);
          if (name === null) {
            continue;
          }
          const path = `${owner}.${name}`;
          add(member, path, "property", "type");
          if (member.type !== null) {
            collectType(member.type, path);
          }
          break;
        }
        case "MethodSignature": {
          const name = memberName(member.name);
          if (name !== null) {
            add(member, `${owner}.${name}`, "method", "type");
          }
          break;
        }
        default:
          break;
      }
    }
  };
  const collectType = (type: Type, owner: string): void => {
    switch (type.kind) {
      case "TypeLiteral":
        collectTypeMembers(type.members, owner);
        return;
      case "ParenthesizedType":
        collectType(type.type, owner);
        return;
      case "UnionType":
      case "IntersectionType":
        for (const item of type.types) {
          collectType(item, owner);
        }
        return;
      case "ArrayType":
        collectType(type.elementType, owner);
        return;
      case "TupleType":
        for (const element of type.elements) {
          collectType(element.elementType, owner);
        }
        return;
      default:
        return;
    }
  };
  const collectObject = (literal: ObjectLiteral, owner: string): void => {
    for (const item of literal.properties) {
      if (item.kind === "SpreadElement") {
        continue;
      }
      if (item.kind === "ObjectMethod") {
        const name = memberName(item.name);
        if (name !== null) {
          add(item, `${owner}.${name}`, "method", "value");
        }
        continue;
      }
      const name = propertyKeyName(item.key, item.computed);
      if (name === null) {
        continue;
      }
      add(item, `${owner}.${name}`, "property", "value");
      const nested = objectLiteralValue(item.value);
      if (nested !== null) {
        collectObject(nested, `${owner}.${name}`);
      }
    }
  };
  const collectClassObjects = (
    declaration: ClassDeclaration | ClassExpression,
    owner: string,
  ): void => {
    for (const member of declaration.members) {
      if (member.kind !== "PropertyDeclaration" || member.initializer === null) {
        continue;
      }
      const name = memberName(member.name);
      if (name === null) {
        continue;
      }
      const literal = objectLiteralValue(member.initializer);
      if (literal !== null) {
        collectObject(literal, `${owner}.${name}`);
      }
    }
  };
  const collectVariable = (statement: VariableStatement, prefix: string): void => {
    for (const declarator of statement.declarations) {
      if (declarator.name.kind !== "Identifier" || declarator.initializer === null) {
        continue;
      }
      const literal = objectLiteralValue(declarator.initializer);
      if (literal !== null) {
        collectObject(literal, `${prefix}${declarator.name.name}`);
      }
    }
  };
  const visitStatements = (statements: readonly Statement[], prefix: string): void => {
    for (const statement of statements) {
      switch (statement.kind) {
        case "NamespaceDeclaration":
          visitStatements(statement.body, `${prefix}${statement.name}.`);
          break;
        case "ExportNamedDeclaration":
          if (statement.declaration !== null) {
            visitStatements([statement.declaration], prefix);
          }
          break;
        case "ExportDefaultDeclaration": {
          const inner = statement.declaration;
          if (inner.kind === "ClassDeclaration" && inner.name !== null) {
            collectClassObjects(inner, `${prefix}${inner.name.name}`);
          }
          break;
        }
        case "InterfaceDeclaration": {
          const declaration = statement as InterfaceDeclaration;
          collectTypeMembers(declaration.members, `${prefix}${declaration.name.name}`);
          break;
        }
        case "TypeAliasDeclaration":
          collectType(statement.type, `${prefix}${statement.name.name}`);
          break;
        case "EnumDeclaration": {
          const declaration = statement as EnumDeclaration;
          for (const member of declaration.members) {
            const name = memberName(member.name);
            if (name !== null) {
              add(member, `${prefix}${declaration.name.name}.${name}`, "enum-member", "value");
            }
          }
          break;
        }
        case "VariableStatement":
          collectVariable(statement, prefix);
          break;
        case "ClassDeclaration":
          if (statement.name !== null) {
            collectClassObjects(statement, `${prefix}${statement.name.name}`);
          }
          break;
        default:
          break;
      }
    }
  };
  visitStatements(program.body, "");
}

/**
 * The separator-expanded deletion range for a named member (interface/type
 * literal, enum, or object literal). The parser's member span excludes the
 * trailing `,`/`;`, so deleting just the node would leave a dangling separator;
 * remove the following separator, or the preceding one for a final member.
 * Returns null for nodes whose deletion needs no separator handling.
 */
export function memberDeletionRange(
  source: string,
  node: Node,
): { start: number; end: number } | null {
  if (!("kind" in node)) {
    return null;
  }
  const kind = (node as { kind: string }).kind;
  const separators =
    kind === "PropertySignature" || kind === "MethodSignature"
      ? ";,"
      : kind === "EnumMember" || kind === "Property" || kind === "ObjectMethod"
        ? ","
        : "";
  if (separators === "") {
    return null;
  }
  let start = node.start;
  let end = node.end;
  let after = end;
  while (after < source.length && /\s/.test(source[after] ?? "")) {
    after += 1;
  }
  const following = source[after];
  if (following !== undefined && separators.includes(following)) {
    end = after + 1;
  } else {
    let before = start;
    while (before > 0 && /\s/.test(source[before - 1] ?? "")) {
      before -= 1;
    }
    const preceding = source[before - 1];
    if (preceding !== undefined && separators.includes(preceding)) {
      start = before - 1;
    }
  }
  return { start, end };
}

/** The whole-symbol rejection for an entry that would rewrite sibling bindings. */
export function wholeSymbolRestrictionDiagnostics(entry: IndexEntry): string | null {
  const restriction = entry.wholeSymbolRestriction;
  if (restriction === undefined) {
    return null;
  }
  const { kind, name, path } = entry.locator;
  const label = kind === "" ? JSON.stringify(name) : `${kind} ${JSON.stringify(name)}`;
  return [
    "stage: address",
    `cannot edit the whole ${label} in ${path}: ${restriction.detail}; the edit would silently rewrite a sibling binding`,
    "target one binding with `match` or `pick` inside the binding (or a JSON matcher/range), or address a narrower declaration",
  ].join("\n");
}

function indexEntriesForFile(file: SourceFile): IndexEntry[] {
  const entries: IndexEntry[] = [];
  const program = new Parser(file.source).parseProgram();
  const binder = new Binder(program);
  const imported = importBindingNodes(program);
  const restrictions = variableBindingRestrictions(program);
  /** Tracks (name, kind) pairs already emitted per declaration node. */
  const emitted = new Map<Node, Set<string>>();
  const cache = new Map<Scope, string | null>();
  const addEntry = (node: Node, name: string, kind: string, symbol: Symbol): void => {
    const key = `${name}\u0000${kind}`;
    const seen = emitted.get(node);
    if (seen === undefined) {
      emitted.set(node, new Set([key]));
    } else if (seen.has(key)) {
      return;
    } else {
      seen.add(key);
    }
    const restriction = restrictions.get(node);
    const entry: IndexEntry = {
      locator: { path: file.path, name, kind },
      symbol,
      node,
    };
    if (restriction !== undefined) {
      entry.wholeSymbolRestriction = restriction;
    }
    entries.push(entry);
  };
  for (const scope of binder.scopes) {
    const prefix = scopePrefix(scope, binder.rootScope, cache);
    if (prefix === null) {
      continue;
    }
    for (const symbols of scope.bindings.values()) {
      for (const symbol of symbols) {
        // Emit every declaration of the symbol. Overload signatures and merged
        // namespaces/interfaces must stay visible as separate candidates so the
        // resolver rejects an ambiguous address instead of silently editing the
        // first declaration.
        for (const node of symbol.declarations) {
          if (scope.kind === "class" && node === scope.node) {
            continue;
          }
          if (imported.has(node)) {
            continue;
          }
          const kind = declarationKind(node);
          if (kind === null) {
            continue;
          }
          addEntry(node, `${prefix}${symbol.name}`, kind, symbol);
        }
      }
    }
  }
  collectNestedMemberEntries(program, (node, name, kind, space) => {
    addEntry(node, name, kind, {
      name,
      space,
      declarations: [node],
      scope: binder.rootScope,
    });
  });
  return entries;
}

function sortedEntries(entries: IndexEntry[]): IndexEntry[] {
  return entries.sort((left, right) => {
    if (left.locator.path !== right.locator.path) {
      return left.locator.path < right.locator.path ? -1 : 1;
    }
    if (left.node.start !== right.node.start) {
      return left.node.start - right.node.start;
    }
    if (left.node.end !== right.node.end) {
      return left.node.end - right.node.end;
    }
    if (left.locator.name !== right.locator.name) {
      return left.locator.name < right.locator.name ? -1 : 1;
    }
    return left.locator.kind < right.locator.kind
      ? -1
      : left.locator.kind > right.locator.kind
        ? 1
        : 0;
  });
}

export function buildIndex(files: SourceFile[]): SymbolIndex {
  const entries: IndexEntry[] = [];
  for (const file of files) {
    entries.push(...indexEntriesForFile(file));
  }
  return new SymbolIndex(sortedEntries(entries));
}

function parseFailureMessage(error: unknown): string {
  if (error instanceof ParseError) {
    return `${error.message} (line ${error.line}, column ${error.column})`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function buildIndexTolerant(files: SourceFile[]): TolerantIndex {
  const entries: IndexEntry[] = [];
  const skipped: SkippedFile[] = [];
  for (const file of files) {
    try {
      entries.push(...indexEntriesForFile(file));
    } catch (error) {
      skipped.push({ path: file.path, message: parseFailureMessage(error) });
    }
  }
  return { index: new SymbolIndex(sortedEntries(entries)), skipped };
}

export function findDefinition(index: SymbolIndex, locator: Locator): IndexEntry | null {
  const matches = index.lookup(locator);
  return matches[0] ?? null;
}
