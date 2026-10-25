import { Parser } from "./parser";
import type {
  BindingElement,
  BindingName,
  BlockStatement,
  CatchClause,
  ClassDeclaration,
  ClassExpression,
  ClassMember,
  ConditionalType,
  Expression,
  ForInStatement,
  ForOfStatement,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  ImportDeclaration,
  MemberName,
  MethodDeclaration,
  NamespaceDeclaration,
  Node,
  ObjectMethod,
  Parameter,
  Program,
  Property,
  Statement,
  Type,
  TypeMember,
  TypeParameter,
  VariableStatement,
} from "./parser";
import type { Locator, ScopeKind, SymbolSpace } from "./utility";

/** A single source replacement. The caller applies all edits atomically. */
export interface RenameEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * The declaration a successful rename resolved, in the symbol index's address
 * vocabulary. `name` is qualified for a namespace/member binding (`A.B`,
 * `Widget.field`) and plain for an ordinary binding.
 */
export interface RenameTarget {
  path: string;
  name: string;
  kind: string;
}

export type RenameResult =
  | { ok: true; edits: RenameEdit[]; target: RenameTarget }
  | { ok: false; diagnostics: string };

/**
 * Optional disambiguators for a locator that names more than one binding (for
 * example an outer `const x` and an inner `let x`). `position` is a source
 * offset inside the selected declaration; the nearest declaration at or before
 * it wins. `space` restricts the TS symbol space (`value`/`type`/`namespace`).
 */
export interface RenameOptions {
  position?: number;
  space?: SymbolSpace | null;
}

interface Binding {
  name: string;
  /** Fully qualified path for namespace/member targets; null for ordinary locals. */
  path: string | null;
  /** True for member bindings that are addressable only by path, not lexically. */
  qualifiedOnly: boolean;
  spaces: Set<SymbolSpace>;
  kinds: Set<string>;
  declarations: Node[];
  identifiers: Identifier[];
  scopes: Set<LexicalScope>;
}

interface ReferenceBase {
  name: string;
  space: SymbolSpace;
  scope: LexicalScope;
}

interface QualifiedReference {
  /** The lexical base (`A` in `A.B`), or null for a `this.field` reference. */
  base: ReferenceBase | null;
  /** The enclosing class path for `this.field`, or null for a base-driven path. */
  ownerPath: string | null;
  /** The member path after the base/owner, e.g. `B.C` in `A.B.C`. */
  restPath: string;
  /** True when this reference spans the whole member chain, not a prefix. */
  isFullChain: boolean;
}

interface Reference {
  name: string;
  space: SymbolSpace;
  scope: LexicalScope;
  start: number;
  end: number;
  qualified: QualifiedReference | null;
}

class LexicalScope {
  readonly parent: LexicalScope | null;
  readonly kind: ScopeKind;
  readonly bindings = new Map<string, Binding[]>();

  constructor(kind: ScopeKind, parent: LexicalScope | null) {
    this.kind = kind;
    this.parent = parent;
  }

  resolveLocal(name: string, space: SymbolSpace): Binding[] {
    const bindings = this.bindings.get(name);
    if (bindings === undefined) {
      return [];
    }
    return bindings.filter((binding) => binding.spaces.has(space));
  }
}

function resolveBinding(scope: LexicalScope, name: string, space: SymbolSpace): Binding | null {
  let current: LexicalScope | null = scope;
  while (current !== null) {
    const first = current.resolveLocal(name, space)[0];
    if (first !== undefined) {
      return first;
    }
    current = current.parent;
  }
  return null;
}

function functionOrGlobal(scope: LexicalScope): LexicalScope {
  let current: LexicalScope | null = scope;
  while (current !== null) {
    if (current.kind === "function" || current.kind === "global") {
      return current;
    }
    current = current.parent;
  }
  return scope;
}

function firstQualifiedSegment(name: string): string {
  const dot = name.indexOf(".");
  return dot < 0 ? name : name.slice(0, dot);
}

function isIdentifierName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function kindMatches(binding: Binding, kind: string): boolean {
  if (kind === "") {
    return true;
  }
  if (kind === "variable") {
    return binding.kinds.has("variable");
  }
  return binding.kinds.has(kind);
}

interface CaptureCollision {
  scope: LexicalScope;
  space: SymbolSpace;
  referenceStart: number | null;
  path: string | null;
}

/**
 * Builds the lexical model used by rename: every scope and declaration the
 * parser exposes, plus every identifier/type reference with the scope it
 * appears in. References are resolved after the whole file is indexed so a
 * binding declared later in a block still matches earlier references, the way
 * JavaScript/TypeScript scoping works (TDZ is a runtime/checker error, not a
 * different binding).
 */
class RenameModel {
  readonly root = new LexicalScope("global", null);
  readonly bindings: Binding[] = [];
  private readonly references: Reference[] = [];
  private readonly bindingsByPath = new Map<string, Binding[]>();
  private readonly namespaceScopes = new Map<Binding, LexicalScope>();
  private readonly source: string;
  private namespacePath: string[] = [];
  private classPath: string | null = null;

  constructor(program: Program) {
    this.source = program.source;
    this.visitStatements(program.body, this.root);
  }

  private child(kind: ScopeKind, parent: LexicalScope): LexicalScope {
    return new LexicalScope(kind, parent);
  }

  private qualify(name: string): string {
    return [...this.namespacePath, name].join(".");
  }

  private indexPath(binding: Binding): void {
    if (binding.path === null) {
      return;
    }
    const existing = this.bindingsByPath.get(binding.path);
    if (existing === undefined) {
      this.bindingsByPath.set(binding.path, [binding]);
    } else if (!existing.includes(binding)) {
      existing.push(binding);
    }
  }

  private declare(
    scope: LexicalScope,
    name: string,
    spaces: readonly SymbolSpace[],
    kinds: readonly string[],
    declaration: Node,
    identifier: Identifier | null,
    path: string | null = null,
  ): Binding {
    const existing = scope.bindings
      .get(name)
      ?.find((binding) => [...binding.spaces].some((space) => spaces.includes(space)));
    if (existing !== undefined) {
      for (const space of spaces) {
        existing.spaces.add(space);
      }
      for (const kind of kinds) {
        existing.kinds.add(kind);
      }
      existing.scopes.add(scope);
      if (!existing.declarations.includes(declaration)) {
        existing.declarations.push(declaration);
      }
      if (identifier !== null && !hasIdentifier(existing.identifiers, identifier)) {
        existing.identifiers.push(identifier);
      }
      if (path !== null) {
        existing.path = path;
        this.indexPath(existing);
      }
      return existing;
    }
    const binding: Binding = {
      name,
      path,
      qualifiedOnly: false,
      spaces: new Set(spaces),
      kinds: new Set(kinds),
      declarations: [declaration],
      identifiers: identifier === null ? [] : [identifier],
      scopes: new Set([scope]),
    };
    const siblings = scope.bindings.get(name);
    if (siblings === undefined) {
      scope.bindings.set(name, [binding]);
    } else {
      siblings.push(binding);
    }
    this.bindings.push(binding);
    this.indexPath(binding);
    return binding;
  }

  /**
   * Declare a member binding that is addressable by qualified path only. It is
   * deliberately not inserted into the lexical scope: `Widget.field` and
   * `this.field` are structural references, while a bare `field` in source may
   * resolve to an outer local and must not be treated as a class member.
   */
  private declareQualified(
    name: string,
    path: string,
    spaces: readonly SymbolSpace[],
    kinds: readonly string[],
    declaration: Node,
    identifier: Identifier | null,
  ): Binding {
    const existing = this.bindingsByPath
      .get(path)
      ?.find(
        (binding) =>
          [...binding.kinds].some((kind) => kinds.includes(kind)) &&
          [...binding.spaces].some((space) => spaces.includes(space)),
      );
    if (existing !== undefined) {
      for (const space of spaces) {
        existing.spaces.add(space);
      }
      for (const kind of kinds) {
        existing.kinds.add(kind);
      }
      if (!existing.declarations.includes(declaration)) {
        existing.declarations.push(declaration);
      }
      if (identifier !== null && !hasIdentifier(existing.identifiers, identifier)) {
        existing.identifiers.push(identifier);
      }
      return existing;
    }
    const binding: Binding = {
      name,
      path,
      qualifiedOnly: true,
      spaces: new Set(spaces),
      kinds: new Set(kinds),
      declarations: [declaration],
      identifiers: identifier === null ? [] : [identifier],
      scopes: new Set(),
    };
    this.bindings.push(binding);
    this.indexPath(binding);
    return binding;
  }

  /** Attach an existing binding to a nested scope (a class's own name). */
  private attach(scope: LexicalScope, binding: Binding): void {
    const siblings = scope.bindings.get(binding.name);
    if (siblings === undefined) {
      scope.bindings.set(binding.name, [binding]);
    } else if (!siblings.includes(binding)) {
      siblings.push(binding);
    }
    binding.scopes.add(scope);
  }

  private reference(name: string, space: SymbolSpace, scope: LexicalScope, node: Node): void {
    this.references.push({
      name,
      space,
      scope,
      start: node.start,
      end: node.end,
      qualified: null,
    });
  }

  private qualifiedReference(
    name: string,
    space: SymbolSpace,
    scope: LexicalScope,
    start: number,
    end: number,
    qualified: QualifiedReference,
  ): void {
    this.references.push({ name, space, scope, start, end, qualified });
  }

  private resolveQualifiedBase(base: ReferenceBase): Binding | null {
    const direct = resolveBinding(base.scope, base.name, base.space);
    if (direct !== null) {
      return direct;
    }
    return base.space === "namespace" ? null : resolveBinding(base.scope, base.name, "namespace");
  }

  private qualifiedPathOf(reference: Reference): string | null {
    const qualified = reference.qualified;
    if (qualified === null) {
      return null;
    }
    if (qualified.ownerPath !== null) {
      return `${qualified.ownerPath}.${qualified.restPath}`;
    }
    if (qualified.base === null) {
      return null;
    }
    const base = this.resolveQualifiedBase(qualified.base);
    if (base === null || base.path === null) {
      return null;
    }
    return `${base.path}.${qualified.restPath}`;
  }

  private resolveReference(reference: Reference): Binding | null {
    if (reference.qualified === null) {
      return resolveBinding(reference.scope, reference.name, reference.space);
    }
    const path = this.qualifiedPathOf(reference);
    if (path === null) {
      return null;
    }
    return this.bindingsByPath.get(path)?.[0] ?? null;
  }

  /** Resolve every collected reference and return the edits for `targets`. */
  editsFor(targets: ReadonlySet<Binding>, newName: string): RenameEdit[] {
    const edits = new Map<string, RenameEdit>();
    const add = (start: number, end: number): void => {
      edits.set(`${start}:${end}`, { start, end, text: newName });
    };
    for (const target of targets) {
      for (const identifier of target.identifiers) {
        add(identifier.start, identifier.end);
      }
    }
    for (const reference of this.references) {
      const binding = this.resolveReference(reference);
      if (binding === null || !targets.has(binding)) {
        continue;
      }
      // A namespace is a container: `A.B.Z` names Z, not B, so only rename a
      // namespace reference that spans the complete qualified path. Member
      // targets (fields/enum members) may appear as a prefix of a longer chain
      // (`this.field.nested`, `Color.Red.value`) and are renamed there too.
      if (
        binding.kinds.has("namespace") &&
        reference.qualified !== null &&
        !reference.qualified.isFullChain
      ) {
        continue;
      }
      add(reference.start, reference.end);
    }
    return [...edits.values()].sort((left, right) => left.start - right.start);
  }

  /**
   * Find a binding that would capture a renamed reference. The target's own
   * declaration scope(s) are checked first (a plain same-scope collision); then
   * every reference that resolves to the target is walked up to the target's
   * declaration scope, so an intervening shadow also rejects the rename.
   * Qualified member targets also reject a new last segment that already
   * exists at the same qualified parent path.
   */
  captureCollision(target: Binding, newName: string): CaptureCollision | null {
    const check = (scope: LexicalScope, space: SymbolSpace): Binding | undefined =>
      scope.resolveLocal(newName, space).find((binding) => binding !== target);

    if (target.path !== null) {
      const dot = target.path.lastIndexOf(".");
      const newPath = dot < 0 ? newName : `${target.path.slice(0, dot)}.${newName}`;
      const pathCollision = this.bindingsByPath.get(newPath)?.find((binding) => binding !== target);
      if (pathCollision !== undefined) {
        const scope = target.scopes.values().next().value ?? this.root;
        return {
          scope,
          space: pathCollision.spaces.values().next().value ?? "value",
          referenceStart: null,
          path: newPath,
        };
      }
    }

    for (const scope of target.scopes) {
      for (const space of target.spaces) {
        if (check(scope, space) !== undefined) {
          return { scope, space, referenceStart: null, path: null };
        }
      }
    }

    for (const reference of this.references) {
      const binding = this.resolveReference(reference);
      if (binding !== target) {
        continue;
      }
      if (reference.qualified !== null) {
        // Qualified references are structural, not lexical; the parent-path
        // collision check above covers their capture risk.
        continue;
      }
      let current: LexicalScope | null = reference.scope;
      while (current !== null) {
        if (check(current, reference.space) !== undefined) {
          return {
            scope: current,
            space: reference.space,
            referenceStart: reference.start,
            path: null,
          };
        }
        // Stop at the target's declaration scope: bindings above it are
        // shadowed by the target and do not capture the reference.
        if (target.scopes.has(current)) {
          break;
        }
        current = current.parent;
      }
    }
    return null;
  }

  private visitStatements(statements: readonly Statement[], scope: LexicalScope): void {
    for (const statement of statements) {
      this.visitStatement(statement, scope);
    }
  }

  private visitStatement(statement: Statement, scope: LexicalScope): void {
    switch (statement.kind) {
      case "BlockStatement":
        this.visitBlock(statement, scope);
        return;
      case "VariableStatement":
        this.visitVariableStatement(statement, scope);
        return;
      case "FunctionDeclaration":
        this.visitFunctionDeclaration(statement, scope);
        return;
      case "ClassDeclaration":
        this.visitClassDeclaration(statement, scope);
        return;
      case "InterfaceDeclaration": {
        this.declare(
          scope,
          statement.name.name,
          ["type"],
          ["interface"],
          statement,
          statement.name,
        );
        const interfaceScope = this.child("block", scope);
        this.visitTypeParameters(statement.typeParameters, interfaceScope);
        for (const base of statement.extends) {
          this.visitType(base, interfaceScope, "type");
        }
        for (const member of statement.members) {
          this.visitTypeMember(member, interfaceScope);
        }
        return;
      }
      case "TypeAliasDeclaration": {
        this.declare(scope, statement.name.name, ["type"], ["type"], statement, statement.name);
        const aliasScope = this.child("block", scope);
        this.visitTypeParameters(statement.typeParameters, aliasScope);
        this.visitType(statement.type, aliasScope, "type");
        return;
      }
      case "EnumDeclaration": {
        const enumPath = this.qualify(statement.name.name);
        const binding = this.declare(
          scope,
          statement.name.name,
          ["value", "type"],
          ["enum"],
          statement,
          statement.name,
          enumPath,
        );
        const enumScope = this.child("block", scope);
        this.attach(enumScope, binding);
        for (const member of statement.members) {
          if (member.name.kind === "Identifier") {
            this.declare(
              enumScope,
              member.name.name,
              ["value"],
              ["enum-member"],
              member,
              member.name,
              `${enumPath}.${member.name.name}`,
            );
          }
          if (member.initializer !== null) {
            this.visitExpression(member.initializer, enumScope);
          }
        }
        return;
      }
      case "NamespaceDeclaration":
        this.visitNamespace(statement, scope);
        return;
      case "ImportDeclaration":
        this.visitImport(statement, scope);
        return;
      case "ImportEqualsDeclaration": {
        this.declare(scope, statement.name.name, ["value"], ["import"], statement, statement.name);
        this.visitExpression(statement.moduleReference, scope);
        return;
      }
      case "ExportNamedDeclaration":
        if (statement.declaration !== null) {
          this.visitStatement(statement.declaration, scope);
        }
        if (statement.source === null) {
          for (const specifier of statement.specifiers) {
            if (specifier.local.kind === "Identifier") {
              const space: SymbolSpace =
                statement.exportKind === "type" || specifier.typeOnly ? "type" : "value";
              this.reference(specifier.local.name, space, scope, specifier.local);
            }
          }
        }
        return;
      case "ExportDefaultDeclaration": {
        const inner = statement.declaration;
        if (inner.kind === "FunctionDeclaration" || inner.kind === "ClassDeclaration") {
          this.visitStatement(inner, scope);
        } else {
          this.visitExpression(inner, scope);
        }
        return;
      }
      case "ExportAllDeclaration":
        return;
      case "ExportAssignment":
        this.visitExpression(statement.expression, scope);
        return;
      case "ExpressionStatement":
        this.visitExpression(statement.expression, scope);
        return;
      case "ReturnStatement":
      case "ThrowStatement":
        if (statement.argument !== null) {
          this.visitExpression(statement.argument, scope);
        }
        return;
      case "IfStatement":
        this.visitExpression(statement.test, scope);
        this.visitStatement(statement.consequent, scope);
        if (statement.alternate !== null) {
          this.visitStatement(statement.alternate, scope);
        }
        return;
      case "WhileStatement":
        this.visitExpression(statement.test, scope);
        this.visitStatement(statement.body, scope);
        return;
      case "DoWhileStatement":
        this.visitStatement(statement.body, scope);
        this.visitExpression(statement.test, scope);
        return;
      case "ForStatement": {
        const loopScope = this.child("block", scope);
        if (statement.init !== null) {
          if (statement.init.kind === "VariableStatement") {
            this.visitVariableStatement(statement.init, loopScope);
          } else {
            this.visitExpression(statement.init, loopScope);
          }
        }
        if (statement.test !== null) {
          this.visitExpression(statement.test, loopScope);
        }
        if (statement.update !== null) {
          this.visitExpression(statement.update, loopScope);
        }
        this.visitStatement(statement.body, loopScope);
        return;
      }
      case "ForInStatement":
      case "ForOfStatement":
        this.visitForInOf(statement, scope);
        return;
      case "SwitchStatement": {
        this.visitExpression(statement.discriminant, scope);
        const switchScope = this.child("block", scope);
        for (const switchCase of statement.cases) {
          if (switchCase.test !== null) {
            this.visitExpression(switchCase.test, switchScope);
          }
          this.visitStatements(switchCase.consequent, switchScope);
        }
        return;
      }
      case "TryStatement":
        this.visitBlock(statement.block, scope);
        if (statement.handler !== null) {
          this.visitCatch(statement.handler, scope);
        }
        if (statement.finalizer !== null) {
          this.visitBlock(statement.finalizer, scope);
        }
        return;
      case "LabeledStatement":
        this.visitStatement(statement.body, scope);
        return;
      case "EmptyStatement":
      case "BreakStatement":
      case "ContinueStatement":
        return;
    }
  }

  private visitForInOf(statement: ForInStatement | ForOfStatement, scope: LexicalScope): void {
    const loopScope = this.child("block", scope);
    if (statement.left.kind === "VariableStatement") {
      this.visitVariableStatement(statement.left, loopScope);
    } else {
      this.visitExpression(statement.left, loopScope);
    }
    this.visitExpression(statement.right, loopScope);
    this.visitStatement(statement.body, loopScope);
  }

  private visitCatch(handler: CatchClause, scope: LexicalScope): void {
    const catchScope = this.child("block", scope);
    if (handler.param !== null) {
      this.declare(
        catchScope,
        handler.param.name,
        ["value"],
        ["variable", "catch"],
        handler.param,
        handler.param,
      );
    }
    if (handler.paramType !== null) {
      this.visitType(handler.paramType, catchScope, "type");
    }
    this.visitBlock(handler.body, catchScope);
  }

  private namespaceIdentifiers(declaration: NamespaceDeclaration): Identifier[] {
    let offset = declaration.start;
    const identifiers: Identifier[] = [];
    for (const segment of declaration.name.split(".")) {
      const start = this.source.indexOf(segment, offset);
      if (start < 0 || start >= declaration.end) {
        break;
      }
      identifiers.push({
        kind: "Identifier",
        name: segment,
        start,
        end: start + segment.length,
      });
      offset = start + segment.length;
    }
    return identifiers;
  }

  private visitNamespace(declaration: NamespaceDeclaration, scope: LexicalScope): void {
    const segments = declaration.name.split(".");
    const identifiers = this.namespaceIdentifiers(declaration);
    const prefix = [...this.namespacePath];
    let currentScope = scope;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined) {
        break;
      }
      const path = [...prefix, segment].join(".");
      const identifier = identifiers[index] ?? null;
      let binding = currentScope.bindings
        .get(segment)
        ?.find((candidate) => candidate.kinds.has("namespace"));
      if (binding === undefined) {
        binding = this.declare(
          currentScope,
          segment,
          ["namespace", "value"],
          ["namespace"],
          declaration,
          identifier,
          path,
        );
      } else {
        if (!binding.declarations.includes(declaration)) {
          binding.declarations.push(declaration);
        }
        if (identifier !== null && !hasIdentifier(binding.identifiers, identifier)) {
          binding.identifiers.push(identifier);
        }
        binding.path = path;
        this.indexPath(binding);
      }
      let namespaceScope = this.namespaceScopes.get(binding);
      if (namespaceScope === undefined) {
        namespaceScope = this.child("namespace", currentScope);
        this.namespaceScopes.set(binding, namespaceScope);
      }
      currentScope = namespaceScope;
      prefix.push(segment);
    }

    const savedPath = this.namespacePath;
    this.namespacePath = prefix;
    this.visitStatements(declaration.body, currentScope);
    this.namespacePath = savedPath;
  }

  private visitBlock(block: BlockStatement, scope: LexicalScope): void {
    const blockScope = this.child("block", scope);
    this.visitStatements(block.body, blockScope);
  }

  private visitVariableStatement(statement: VariableStatement, scope: LexicalScope): void {
    const target = statement.declarationKind === "var" ? functionOrGlobal(scope) : scope;
    for (const declarator of statement.declarations) {
      this.bindPattern(
        declarator.name,
        target,
        ["value"],
        ["variable", statement.declarationKind],
        declarator,
      );
      this.visitPatternExpressions(declarator.name, scope);
      if (declarator.type !== null) {
        this.visitType(declarator.type, scope, "type");
      }
      if (declarator.initializer !== null) {
        this.visitExpression(declarator.initializer, scope);
      }
    }
  }

  private bindPattern(
    name: BindingName,
    scope: LexicalScope,
    spaces: readonly SymbolSpace[],
    kinds: readonly string[],
    declaration: Node,
  ): void {
    switch (name.kind) {
      case "Identifier":
        this.declare(scope, name.name, spaces, kinds, declaration, name);
        return;
      case "ArrayPattern":
        for (const element of name.elements) {
          if (element !== null) {
            this.bindPattern(element.binding, scope, spaces, kinds, declaration);
          }
        }
        return;
      case "ObjectPattern":
        for (const property of name.properties) {
          this.bindPattern(property.binding, scope, spaces, kinds, declaration);
        }
        return;
    }
  }

  private visitPatternExpressions(name: BindingName, scope: LexicalScope): void {
    switch (name.kind) {
      case "Identifier":
        return;
      case "ArrayPattern":
        for (const element of name.elements) {
          if (element !== null) {
            this.visitBindingElementExpressions(element, scope);
          }
        }
        return;
      case "ObjectPattern":
        for (const property of name.properties) {
          this.visitBindingElementExpressions(property, scope);
        }
        return;
    }
  }

  private visitBindingElementExpressions(element: BindingElement, scope: LexicalScope): void {
    if (element.computed && element.key !== null) {
      this.visitExpression(element.key, scope);
    }
    this.visitPatternExpressions(element.binding, scope);
    if (element.default !== null) {
      this.visitExpression(element.default, scope);
    }
  }

  private visitFunctionDeclaration(declaration: FunctionDeclaration, scope: LexicalScope): void {
    if (declaration.name !== null) {
      this.declare(
        scope,
        declaration.name.name,
        ["value"],
        ["function"],
        declaration,
        declaration.name,
      );
    }
    const functionScope = this.child("function", scope);
    this.visitTypeParameters(declaration.typeParameters, functionScope);
    this.visitParameters(declaration.parameters, functionScope);
    if (declaration.returnType !== null) {
      this.visitReturnType(declaration.returnType, functionScope);
    }
    if (declaration.body !== null) {
      this.visitBlock(declaration.body, functionScope);
    }
  }

  private visitClassDeclaration(declaration: ClassDeclaration, scope: LexicalScope): void {
    let binding: Binding | null = null;
    let classPath: string | null = null;
    if (declaration.name !== null) {
      classPath = this.qualify(declaration.name.name);
      binding = this.declare(
        scope,
        declaration.name.name,
        ["value", "type"],
        ["class"],
        declaration,
        declaration.name,
        classPath,
      );
    }
    const classScope = this.child("class", scope);
    if (binding !== null) {
      this.attach(classScope, binding);
    }
    this.visitTypeParameters(declaration.typeParameters, classScope);
    if (declaration.extends !== null) {
      this.visitExpression(declaration.extends, classScope);
    }
    for (const implemented of declaration.implements) {
      this.visitType(implemented, classScope, "type");
    }
    const savedClassPath = this.classPath;
    this.classPath = classPath;
    this.visitClassMembers(declaration.members, classScope, classPath);
    this.classPath = savedClassPath;
    for (const decorator of declaration.decorators ?? []) {
      this.visitExpression(decorator, scope);
    }
  }

  private visitClassExpression(expression: ClassExpression, scope: LexicalScope): void {
    const classScope = this.child("class", scope);
    let classPath: string | null = null;
    if (expression.name !== null) {
      classPath = this.qualify(expression.name.name);
      this.declare(
        classScope,
        expression.name.name,
        ["value", "type"],
        ["class"],
        expression,
        expression.name,
        classPath,
      );
    }
    this.visitTypeParameters(expression.typeParameters, classScope);
    if (expression.extends !== null) {
      this.visitExpression(expression.extends, classScope);
    }
    for (const implemented of expression.implements) {
      this.visitType(implemented, classScope, "type");
    }
    const savedClassPath = this.classPath;
    this.classPath = classPath;
    this.visitClassMembers(expression.members, classScope, classPath);
    this.classPath = savedClassPath;
    for (const decorator of expression.decorators ?? []) {
      this.visitExpression(decorator, scope);
    }
  }

  private visitClassMembers(
    members: readonly ClassMember[],
    scope: LexicalScope,
    classPath: string | null,
  ): void {
    for (const member of members) {
      switch (member.kind) {
        case "PropertyDeclaration":
          if (member.name.kind === "Identifier" && classPath !== null) {
            this.declareQualified(
              member.name.name,
              `${classPath}.${member.name.name}`,
              ["value"],
              ["variable", "field"],
              member,
              member.name,
            );
          }
          this.visitMemberName(member.name, scope);
          if (member.type !== null) {
            this.visitType(member.type, scope, "type");
          }
          if (member.initializer !== null) {
            this.visitExpression(member.initializer, scope);
          }
          for (const decorator of member.decorators ?? []) {
            this.visitExpression(decorator, scope);
          }
          break;
        case "MethodDeclaration":
          if (member.name.kind === "Identifier" && classPath !== null) {
            this.declareQualified(
              member.name.name,
              `${classPath}.${member.name.name}`,
              ["value"],
              ["method"],
              member,
              null,
            );
          }
          this.visitMemberName(member.name, scope);
          this.visitMethodFunction(member, scope);
          for (const decorator of member.decorators ?? []) {
            this.visitExpression(decorator, scope);
          }
          break;
        case "ConstructorDeclaration": {
          const functionScope = this.child("function", scope);
          this.visitParameters(member.parameters, functionScope);
          if (member.body !== null) {
            this.visitBlock(member.body, functionScope);
          }
          for (const decorator of member.decorators ?? []) {
            this.visitExpression(decorator, scope);
          }
          break;
        }
        case "IndexSignature": {
          const signatureScope = this.child("block", scope);
          this.declare(
            signatureScope,
            member.keyName.name,
            ["value"],
            ["type-parameter"],
            member,
            member.keyName,
          );
          this.visitType(member.keyType, signatureScope, "type");
          if (member.type !== null) {
            this.visitType(member.type, signatureScope, "type");
          }
          break;
        }
        case "StaticBlock":
          this.visitBlock(member.body, scope);
          break;
      }
    }
  }

  private visitMethodFunction(member: MethodDeclaration, scope: LexicalScope): void {
    const functionScope = this.child("function", scope);
    this.visitTypeParameters(member.typeParameters, functionScope);
    this.visitParameters(member.parameters, functionScope);
    if (member.returnType !== null) {
      this.visitReturnType(member.returnType, functionScope);
    }
    if (member.body !== null) {
      this.visitBlock(member.body, functionScope);
    }
  }

  private visitMemberName(name: MemberName, scope: LexicalScope): void {
    if (name.kind === "ComputedPropertyName") {
      this.visitExpression(name.expression, scope);
    }
  }

  private visitParameters(parameters: readonly Parameter[], scope: LexicalScope): void {
    for (const parameter of parameters) {
      this.bindPattern(parameter.name, scope, ["value"], ["parameter"], parameter);
      this.visitPatternExpressions(parameter.name, scope);
      if (parameter.type !== null) {
        this.visitType(parameter.type, scope, "type");
      }
      if (parameter.initializer !== null) {
        this.visitExpression(parameter.initializer, scope);
      }
      for (const decorator of parameter.decorators ?? []) {
        this.visitExpression(decorator, scope);
      }
    }
  }

  private visitImport(declaration: ImportDeclaration, scope: LexicalScope): void {
    const space: SymbolSpace = declaration.importKind === "type" ? "type" : "value";
    if (declaration.defaultImport !== null) {
      this.declare(
        scope,
        declaration.defaultImport.name,
        [space],
        ["import"],
        declaration,
        declaration.defaultImport,
      );
    }
    if (declaration.namespaceImport !== null) {
      this.declare(
        scope,
        declaration.namespaceImport.name,
        [space],
        ["import"],
        declaration,
        declaration.namespaceImport,
      );
    }
    for (const specifier of declaration.namedImports) {
      const specifierSpace: SymbolSpace =
        declaration.importKind === "type" || specifier.typeOnly ? "type" : "value";
      this.declare(
        scope,
        specifier.local.name,
        [specifierSpace],
        ["import"],
        declaration,
        specifier.local,
      );
    }
  }

  private visitTypeParameters(
    parameters: readonly TypeParameter[] | null,
    scope: LexicalScope,
  ): void {
    if (parameters === null) {
      return;
    }
    for (const parameter of parameters) {
      this.declare(
        scope,
        parameter.name.name,
        ["type"],
        ["type-parameter"],
        parameter,
        parameter.name,
      );
      if (parameter.constraint !== null) {
        this.visitType(parameter.constraint, scope, "type");
      }
      if (parameter.default !== null) {
        this.visitType(parameter.default, scope, "type");
      }
    }
  }

  private visitReturnType(
    returnType: NonNullable<FunctionDeclaration["returnType"]>,
    scope: LexicalScope,
  ): void {
    if (returnType.kind === "TypePredicate") {
      // The predicate's parameter name is a string without an identifier span;
      // the type it asserts is still a normal type reference.
      if (returnType.type !== null) {
        this.visitType(returnType.type, scope, "type");
      }
      return;
    }
    this.visitType(returnType, scope, "type");
  }

  private visitExpression(expression: Expression, scope: LexicalScope): void {
    switch (expression.kind) {
      case "Identifier":
        this.reference(expression.name, "value", scope, expression);
        return;
      case "ThisExpression":
      case "SuperExpression":
      case "NumberLiteral":
      case "BigIntLiteral":
      case "StringLiteral":
      case "BooleanLiteral":
      case "NullLiteral":
      case "RegexLiteral":
      case "MetaProperty":
      case "ConstType":
        return;
      case "ParenthesizedExpression":
      case "NonNullExpression":
        this.visitExpression(expression.expression, scope);
        return;
      case "ArrayLiteral":
        for (const element of expression.elements) {
          if (element === null) {
            continue;
          }
          if (element.kind === "SpreadElement") {
            this.visitExpression(element.argument, scope);
          } else {
            this.visitExpression(element, scope);
          }
        }
        return;
      case "ObjectLiteral":
        for (const property of expression.properties) {
          if (property.kind === "SpreadElement") {
            this.visitExpression(property.argument, scope);
          } else if (property.kind === "ObjectMethod") {
            this.visitObjectMethod(property, scope);
          } else if (property.kind === "Property") {
            this.visitProperty(property, scope);
          }
        }
        return;
      case "TemplateLiteral":
        for (const item of expression.expressions) {
          this.visitExpression(item, scope);
        }
        return;
      case "UnaryExpression":
      case "UpdateExpression":
        this.visitExpression(expression.operand, scope);
        return;
      case "BinaryExpression":
      case "LogicalExpression":
      case "AssignmentExpression":
        this.visitExpression(expression.left, scope);
        this.visitExpression(expression.right, scope);
        return;
      case "ConditionalExpression":
        this.visitExpression(expression.test, scope);
        this.visitExpression(expression.consequent, scope);
        this.visitExpression(expression.alternate, scope);
        return;
      case "SequenceExpression":
        for (const item of expression.expressions) {
          this.visitExpression(item, scope);
        }
        return;
      case "MemberExpression":
        this.visitMemberExpression(expression, scope);
        return;
      case "CallExpression":
      case "NewExpression": {
        this.visitExpression(expression.callee, scope);
        for (const argument of expression.arguments) {
          if (argument.kind === "SpreadElement") {
            this.visitExpression(argument.argument, scope);
          } else {
            this.visitExpression(argument, scope);
          }
        }
        for (const typeArgument of expression.typeArguments ?? []) {
          this.visitType(typeArgument, scope, "type");
        }
        return;
      }
      case "TaggedTemplateExpression":
        this.visitExpression(expression.tag, scope);
        this.visitExpression(expression.quasi, scope);
        return;
      case "YieldExpression":
        if (expression.argument !== null) {
          this.visitExpression(expression.argument, scope);
        }
        return;
      case "ImportExpression":
        this.visitExpression(expression.source, scope);
        return;
      case "ExpressionWithTypeArguments":
        this.visitExpression(expression.expression, scope);
        for (const typeArgument of expression.typeArguments) {
          this.visitType(typeArgument, scope, "type");
        }
        return;
      case "AsExpression":
        this.visitExpression(expression.expression, scope);
        if (expression.type.kind !== "ConstType") {
          this.visitType(expression.type, scope, "type");
        }
        return;
      case "TypeAssertion":
        this.visitType(expression.type, scope, "type");
        this.visitExpression(expression.expression, scope);
        return;
      case "ArrowFunctionExpression":
        this.visitArrowFunction(expression, scope);
        return;
      case "FunctionExpression":
        this.visitFunctionExpression(expression, scope);
        return;
      case "ClassExpression":
        this.visitClassExpression(expression, scope);
        return;
    }
  }

  private visitMemberExpression(
    expression: Extract<Expression, { kind: "MemberExpression" }>,
    scope: LexicalScope,
  ): void {
    const properties: Array<{ name: string; node: Identifier }> = [];
    let current: Expression = expression;
    while (
      current.kind === "MemberExpression" &&
      !current.computed &&
      current.property.kind === "Identifier"
    ) {
      properties.unshift({ name: current.property.name, node: current.property });
      current = current.object;
    }

    if (current.kind === "Identifier") {
      this.reference(current.name, "value", scope, current);
      if (properties.length === 0) {
        return;
      }
      const base: ReferenceBase = { name: current.name, space: "value", scope };
      const rest = properties.map((property) => property.name);
      const lastIndex = properties.length - 1;
      for (let index = 0; index < properties.length; index += 1) {
        const property = properties[index];
        if (property === undefined) {
          continue;
        }
        this.qualifiedReference(
          property.name,
          "value",
          scope,
          property.node.start,
          property.node.end,
          {
            base,
            ownerPath: null,
            restPath: rest.slice(0, index + 1).join("."),
            isFullChain: index === lastIndex,
          },
        );
      }
      return;
    }

    if (current.kind === "ThisExpression") {
      if (this.classPath === null || properties.length === 0) {
        return;
      }
      const rest = properties.map((property) => property.name);
      const lastIndex = properties.length - 1;
      for (let index = 0; index < properties.length; index += 1) {
        const property = properties[index];
        if (property === undefined) {
          continue;
        }
        this.qualifiedReference(
          property.name,
          "value",
          scope,
          property.node.start,
          property.node.end,
          {
            base: null,
            ownerPath: this.classPath,
            restPath: rest.slice(0, index + 1).join("."),
            isFullChain: index === lastIndex,
          },
        );
      }
      return;
    }

    // An arbitrary receiver (call result, computed access, etc.) is not
    // type-resolved; walk it for local references but do not guess members.
    this.visitExpression(current, scope);
  }

  private visitProperty(property: Property, scope: LexicalScope): void {
    if (property.computed || property.shorthand) {
      this.visitExpression(property.key, scope);
    }
    this.visitExpression(property.value, scope);
  }

  private visitObjectMethod(method: ObjectMethod, scope: LexicalScope): void {
    this.visitMemberName(method.name, scope);
    const functionScope = this.child("function", scope);
    this.visitTypeParameters(method.typeParameters, functionScope);
    this.visitParameters(method.parameters, functionScope);
    if (method.returnType !== null) {
      this.visitReturnType(method.returnType, functionScope);
    }
    this.visitBlock(method.body, functionScope);
  }

  private visitArrowFunction(
    expression: Extract<Expression, { kind: "ArrowFunctionExpression" }>,
    scope: LexicalScope,
  ): void {
    const functionScope = this.child("function", scope);
    this.visitTypeParameters(expression.typeParameters ?? null, functionScope);
    this.visitParameters(expression.params, functionScope);
    if (expression.body.kind === "BlockStatement") {
      this.visitBlock(expression.body, functionScope);
    } else {
      this.visitExpression(expression.body, functionScope);
    }
  }

  private visitFunctionExpression(expression: FunctionExpression, scope: LexicalScope): void {
    const functionScope = this.child("function", scope);
    if (expression.name !== null) {
      this.declare(
        functionScope,
        expression.name.name,
        ["value"],
        ["function"],
        expression,
        expression.name,
      );
    }
    this.visitTypeParameters(expression.typeParameters, functionScope);
    this.visitParameters(expression.parameters, functionScope);
    if (expression.returnType !== null) {
      this.visitReturnType(expression.returnType, functionScope);
    }
    this.visitBlock(expression.body, functionScope);
  }

  private lastSegmentSpan(node: Node, name: string): { start: number; end: number } {
    const slice = this.source.slice(node.start, node.end);
    const index = slice.indexOf(name);
    const last = name.slice(name.lastIndexOf(".") + 1);
    const relative =
      index < 0 ? Math.max(0, name.length - last.length) : index + name.lastIndexOf(".") + 1;
    const start = node.start + relative;
    return { start, end: start + last.length };
  }

  private visitType(type: Type, scope: LexicalScope, space: SymbolSpace): void {
    switch (type.kind) {
      case "TypeReference": {
        const first = firstQualifiedSegment(type.name);
        if (first.length > 0) {
          this.references.push({
            name: first,
            space,
            scope,
            start: type.start,
            end: type.start + first.length,
            qualified: null,
          });
        }
        if (type.name.includes(".")) {
          const last = type.name.slice(type.name.lastIndexOf(".") + 1);
          const span = this.lastSegmentSpan(type, type.name);
          this.qualifiedReference(last, space, scope, span.start, span.end, {
            base: { name: first, space, scope },
            ownerPath: null,
            restPath: type.name.slice(first.length + 1),
            isFullChain: true,
          });
        }
        for (const argument of type.typeArguments ?? []) {
          this.visitType(argument, scope, "type");
        }
        return;
      }
      case "ParenthesizedType":
        this.visitType(type.type, scope, space);
        return;
      case "UnionType":
      case "IntersectionType":
        for (const item of type.types) {
          this.visitType(item, scope, "type");
        }
        return;
      case "ArrayType":
        this.visitType(type.elementType, scope, "type");
        return;
      case "TupleType":
        for (const element of type.elements) {
          this.visitType(element.elementType, scope, "type");
        }
        return;
      case "IndexedAccessType":
        this.visitType(type.objectType, scope, "type");
        this.visitType(type.indexType, scope, "type");
        return;
      case "TypeOperator": {
        const operatorSpace: SymbolSpace = type.operator === "typeof" ? "value" : "type";
        this.visitType(type.type, scope, operatorSpace);
        return;
      }
      case "TypeLiteral":
        for (const member of type.members) {
          this.visitTypeMember(member, scope);
        }
        return;
      case "FunctionType":
      case "ConstructorType": {
        const functionScope = this.child("block", scope);
        this.visitTypeParameters(type.typeParameters, functionScope);
        this.visitParameters(type.parameters, functionScope);
        this.visitReturnType(type.returnType, functionScope);
        return;
      }
      case "ConditionalType":
        this.visitConditionalType(type, scope);
        return;
      case "InferType":
        if (type.constraint !== null) {
          this.visitType(type.constraint, scope, "type");
        }
        return;
      case "MappedType": {
        const mappedScope = this.child("block", scope);
        this.declare(
          mappedScope,
          type.keyName.name,
          ["type"],
          ["type-parameter"],
          type,
          type.keyName,
        );
        this.visitType(type.constraint, mappedScope, "type");
        if (type.valueType !== null) {
          this.visitType(type.valueType, mappedScope, "type");
        }
        return;
      }
      case "TemplateLiteralType":
        for (const item of type.types) {
          this.visitType(item, scope, "type");
        }
        return;
      case "KeywordType":
      case "ThisType":
      case "LiteralType":
      case "ImportType":
        return;
    }
  }

  private visitConditionalType(type: ConditionalType, scope: LexicalScope): void {
    this.visitType(type.checkType, scope, "type");
    this.visitType(type.extendsType, scope, "type");
    const inferScope = this.child("block", scope);
    for (const name of collectInferNames(type.extendsType)) {
      this.declare(inferScope, name.name, ["type"], ["type-parameter"], name, name);
    }
    this.visitType(type.trueType, inferScope, "type");
    this.visitType(type.falseType, inferScope, "type");
  }

  private visitTypeMember(member: TypeMember, scope: LexicalScope): void {
    switch (member.kind) {
      case "PropertySignature":
        this.visitMemberName(member.name, scope);
        if (member.type !== null) {
          this.visitType(member.type, scope, "type");
        }
        return;
      case "MethodSignature": {
        this.visitMemberName(member.name, scope);
        const functionScope = this.child("block", scope);
        this.visitTypeParameters(member.typeParameters, functionScope);
        this.visitParameters(member.parameters, functionScope);
        if (member.returnType !== null) {
          this.visitReturnType(member.returnType, functionScope);
        }
        return;
      }
      case "IndexSignature": {
        const signatureScope = this.child("block", scope);
        this.declare(
          signatureScope,
          member.keyName.name,
          ["value"],
          ["type-parameter"],
          member,
          member.keyName,
        );
        this.visitType(member.keyType, signatureScope, "type");
        if (member.type !== null) {
          this.visitType(member.type, signatureScope, "type");
        }
        return;
      }
      case "CallSignature":
      case "ConstructSignature": {
        const functionScope = this.child("block", scope);
        this.visitTypeParameters(member.typeParameters, functionScope);
        this.visitParameters(member.parameters, functionScope);
        if (member.returnType !== null) {
          this.visitReturnType(member.returnType, functionScope);
        }
        return;
      }
    }
  }

  findTargets(locator: Locator, options: RenameOptions): Binding[] {
    if (locator.path !== "" && locator.path !== this.fileName) {
      return [];
    }
    const dotted = locator.name.includes(".");
    let candidates = dotted
      ? (this.bindingsByPath.get(locator.name) ?? [])
      : this.bindings.filter(
          (binding) =>
            !binding.qualifiedOnly &&
            binding.name === locator.name &&
            kindMatches(binding, locator.kind),
        );
    if (dotted) {
      candidates = candidates.filter((binding) => kindMatches(binding, locator.kind));
    }
    const space = options.space ?? null;
    if (space !== null) {
      candidates = candidates.filter((binding) => binding.spaces.has(space));
    }
    if (candidates.length > 1 && options.position !== undefined) {
      const position = options.position;
      const containing = candidates.filter((binding) =>
        binding.identifiers.some(
          (identifier) => identifier.start <= position && position <= identifier.end,
        ),
      );
      if (containing.length > 0) {
        candidates = containing;
      } else {
        const before = candidates.filter((binding) =>
          binding.identifiers.some((identifier) => identifier.start <= position),
        );
        if (before.length > 0) {
          const nearest = Math.max(
            ...before.flatMap((binding) =>
              binding.identifiers.map((identifier) => identifier.start),
            ),
          );
          candidates = before.filter((binding) =>
            binding.identifiers.some((identifier) => identifier.start === nearest),
          );
        }
      }
    }
    return candidates;
  }

  fileName = "";

  setFileName(fileName: string): void {
    this.fileName = fileName;
  }
}

function hasIdentifier(identifiers: readonly Identifier[], candidate: Identifier): boolean {
  return identifiers.some(
    (identifier) => identifier.start === candidate.start && identifier.end === candidate.end,
  );
}

function collectInferNames(type: Type): Identifier[] {
  const names: Identifier[] = [];
  const visit = (node: Type): void => {
    switch (node.kind) {
      case "InferType":
        names.push(node.name);
        if (node.constraint !== null) {
          visit(node.constraint);
        }
        return;
      case "TypeReference":
        for (const argument of node.typeArguments ?? []) {
          visit(argument);
        }
        return;
      case "ParenthesizedType":
        visit(node.type);
        return;
      case "UnionType":
      case "IntersectionType":
        for (const item of node.types) {
          visit(item);
        }
        return;
      case "ArrayType":
        visit(node.elementType);
        return;
      case "TupleType":
        for (const element of node.elements) {
          visit(element.elementType);
        }
        return;
      case "IndexedAccessType":
        visit(node.objectType);
        visit(node.indexType);
        return;
      case "TypeOperator":
        visit(node.type);
        return;
      case "TypeLiteral":
        return;
      case "FunctionType":
      case "ConstructorType":
        visit(node.returnType);
        return;
      case "ConditionalType":
        visit(node.checkType);
        visit(node.extendsType);
        visit(node.trueType);
        visit(node.falseType);
        return;
      case "MappedType":
        visit(node.constraint);
        if (node.valueType !== null) {
          visit(node.valueType);
        }
        return;
      case "TemplateLiteralType":
        for (const item of node.types) {
          visit(item);
        }
        return;
      default:
        return;
    }
  };
  visit(type);
  return names;
}

function describeBinding(binding: Binding): string {
  const kind = [...binding.kinds].join("/");
  const identifier = binding.identifiers[0];
  const at = identifier === undefined ? "declaration" : `offset ${identifier.start}`;
  const space = binding.spaces.has("type") ? "type" : "value";
  return `${kind || space} binding at ${at}`;
}

/**
 * The resolved rename target in the symbol index's address vocabulary (#40).
 * `declare` inserts the index-compatible kind first for every bindable form
 * (`variable` before `const`/`let`/`var`, `variable` before `field`), and a
 * namespace/member binding carries its qualified path, so this key matches the
 * entry an editor clause resolves to.
 */
function renameTargetOf(binding: Binding, fileName: string): RenameTarget {
  const kind = binding.kinds.values().next().value;
  return {
    path: fileName,
    name: binding.path ?? binding.name,
    kind: kind ?? "symbol",
  };
}

/**
 * Resolve a same-file local rename to atomic source edits. The declaration and
 * every reference that lexically resolves to the same binding are updated;
 * shadowed bindings and out-of-scope references are left alone.
 *
 * `locator` uses the symbol index's path/name/kind vocabulary. When several
 * bindings share a name (shadowing), pass `options.position` (a source offset
 * inside the selected declaration) and/or the selection's `space`. An
 * unresolvable, ambiguous, or colliding rename returns a diagnostic and no
 * edits.
 */
export function resolveLocalRename(
  source: string,
  fileName: string,
  locator: Locator,
  rename: { from: string; to: string },
  options: RenameOptions = {},
): RenameResult {
  let program: Program;
  try {
    program = new Parser(source).parseProgram();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, diagnostics: `cannot parse ${fileName}: ${detail}` };
  }

  const model = new RenameModel(program);
  model.setFileName(fileName);
  const targets = model.findTargets(locator, options);
  if (targets.length === 0) {
    return {
      ok: false,
      diagnostics: `cannot resolve ${locator.kind || "symbol"} \`${locator.name}\` in ${fileName}`,
    };
  }
  if (targets.length > 1) {
    return {
      ok: false,
      diagnostics:
        `rename target \`${locator.name}\` is ambiguous in ${fileName}: ` +
        targets.map(describeBinding).join(", ") +
        "; select the declaration by position (offset) or symbol space",
    };
  }

  const target = targets[0];
  if (target === undefined) {
    return {
      ok: false,
      diagnostics: `cannot resolve ${locator.kind || "symbol"} \`${locator.name}\` in ${fileName}`,
    };
  }
  if (target.identifiers.length === 0) {
    return {
      ok: false,
      diagnostics: `cannot rename ${locator.kind || "symbol"} \`${locator.name}\`: no local declaration name to edit`,
    };
  }
  if (rename.from !== target.name) {
    return {
      ok: false,
      diagnostics:
        `rename source \`${rename.from}\` does not match selected binding ` +
        `\`${target.name}\` in ${fileName}`,
    };
  }
  if (!isIdentifierName(rename.to)) {
    return {
      ok: false,
      diagnostics: `rename target \`${rename.to}\` is not a valid identifier`,
    };
  }

  const targetSet = new Set<Binding>([target]);
  const collision = model.captureCollision(target, rename.to);
  if (collision !== null) {
    const location =
      collision.path !== null
        ? `at the qualified path \`${collision.path}\``
        : collision.referenceStart === null
          ? `in the same ${collision.scope.kind} scope`
          : `in an intervening ${collision.scope.kind} scope at offset ${collision.referenceStart}, which would capture that reference`;
    return {
      ok: false,
      diagnostics:
        `cannot rename \`${target.name}\` to \`${rename.to}\`: ` +
        `collision with an existing ${collision.space} binding named \`${rename.to}\` ${location}`,
    };
  }

  return {
    ok: true,
    edits: model.editsFor(targetSet, rename.to),
    target: renameTargetOf(target, fileName),
  };
}
