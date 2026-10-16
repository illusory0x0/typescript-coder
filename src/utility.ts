import { Parser } from "./parser";
import type {
  BindingName,
  BlockStatement,
  ClassDeclaration,
  ClassExpression,
  ClassMember,
  ExportDefaultDeclaration,
  Expression,
  FunctionDeclaration,
  ImportDeclaration,
  MemberName,
  NamespaceDeclaration,
  Node,
  Parameter,
  Program,
  Statement,
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

export interface IndexEntry {
  locator: Locator;
  symbol: Symbol;
  node: Node;
}

export interface SourceFile {
  path: string;
  source: string;
}

export class SymbolIndex {
  readonly entries: IndexEntry[];

  constructor(entries: IndexEntry[]) {
    this.entries = entries;
  }

  lookup(locator: Locator): IndexEntry[] {
    return this.entries.filter(
      (entry) =>
        entry.locator.path === locator.path &&
        entry.locator.name === locator.name &&
        entry.locator.kind === locator.kind,
    );
  }

  byName(name: string): IndexEntry[] {
    return this.entries.filter((entry) => entry.locator.name === name);
  }
}

function declarationKind(node: Node): string | null {
  if (!("kind" in node)) {
    return null;
  }
  switch ((node as { kind: string }).kind) {
    case "FunctionDeclaration":
      return "function";
    case "MethodDeclaration":
    case "ObjectMethod":
      return "method";
    case "ClassDeclaration":
      return "class";
    case "InterfaceDeclaration":
      return "interface";
    case "TypeAliasDeclaration":
      return "type";
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

export function buildIndex(files: SourceFile[]): SymbolIndex {
  const entries: IndexEntry[] = [];
  for (const file of files) {
    const program = new Parser(file.source).parseProgram();
    const binder = new Binder(program);
    const cache = new Map<Scope, string | null>();
    for (const scope of binder.scopes) {
      const prefix = scopePrefix(scope, binder.rootScope, cache);
      if (prefix === null) {
        continue;
      }
      for (const symbols of scope.bindings.values()) {
        for (const symbol of symbols) {
          const node = symbol.declarations[0];
          if (node === undefined) {
            continue;
          }
          if (scope.kind === "class" && node === scope.node) {
            continue;
          }
          const kind = declarationKind(node);
          if (kind === null) {
            continue;
          }
          entries.push({
            locator: { path: file.path, name: `${prefix}${symbol.name}`, kind },
            symbol,
            node,
          });
        }
      }
    }
  }
  entries.sort((left, right) => {
    if (left.locator.path !== right.locator.path) {
      return left.locator.path < right.locator.path ? -1 : 1;
    }
    return left.node.start - right.node.start;
  });
  return new SymbolIndex(entries);
}

export function findDefinition(index: SymbolIndex, locator: Locator): IndexEntry | null {
  const matches = index.lookup(locator);
  return matches[0] ?? null;
}
