import { Lexer } from "./lexer";
import type { Token, TokenKind } from "./lexer";

export interface Node {
  start: number;
  end: number;
}

export interface Identifier extends Node {
  kind: "Identifier";
  name: string;
}

export interface ThisExpression extends Node {
  kind: "ThisExpression";
}

export interface SuperExpression extends Node {
  kind: "SuperExpression";
}

export interface NumberLiteral extends Node {
  kind: "NumberLiteral";
  value: number;
  raw: string;
}

export interface BigIntLiteral extends Node {
  kind: "BigIntLiteral";
  value: string;
  raw: string;
}

export interface StringLiteral extends Node {
  kind: "StringLiteral";
  value: string;
  raw: string;
}

export interface BooleanLiteral extends Node {
  kind: "BooleanLiteral";
  value: boolean;
}

export interface NullLiteral extends Node {
  kind: "NullLiteral";
}

export interface ParenthesizedExpression extends Node {
  kind: "ParenthesizedExpression";
  expression: Expression;
}

export interface SpreadElement extends Node {
  kind: "SpreadElement";
  argument: Expression;
}

export interface ArrayLiteral extends Node {
  kind: "ArrayLiteral";
  elements: Array<Expression | SpreadElement | null>;
}

export interface Property extends Node {
  kind: "Property";
  key: Expression;
  value: Expression;
  shorthand: boolean;
  computed: boolean;
}

export interface ObjectMethod extends Node {
  kind: "ObjectMethod";
  name: MemberName;
  typeParameters: TypeParameter[] | null;
  parameters: Parameter[];
  returnType: ReturnTypeNode | null;
  body: BlockStatement;
  async?: boolean;
  generator?: boolean;
  accessor?: "get" | "set";
}

export type PropertyItem = Property | SpreadElement | ObjectMethod;

export interface ObjectLiteral extends Node {
  kind: "ObjectLiteral";
  properties: PropertyItem[];
}

export interface TemplateLiteral extends Node {
  kind: "TemplateLiteral";
  quasis: string[];
  expressions: Expression[];
}

export interface RegexLiteral extends Node {
  kind: "RegexLiteral";
  pattern: string;
  flags: string;
  raw: string;
}

export interface UnaryExpression extends Node {
  kind: "UnaryExpression";
  operator: string;
  operand: Expression;
  prefix: true;
}

export interface UpdateExpression extends Node {
  kind: "UpdateExpression";
  operator: "++" | "--";
  operand: Expression;
  prefix: boolean;
}

export interface BinaryExpression extends Node {
  kind: "BinaryExpression";
  operator: string;
  left: Expression;
  right: Expression;
}

export interface LogicalExpression extends Node {
  kind: "LogicalExpression";
  operator: "||" | "&&" | "??";
  left: Expression;
  right: Expression;
}

export interface ConditionalExpression extends Node {
  kind: "ConditionalExpression";
  test: Expression;
  consequent: Expression;
  alternate: Expression;
}

export interface AssignmentExpression extends Node {
  kind: "AssignmentExpression";
  operator: string;
  left: Expression;
  right: Expression;
}

export interface SequenceExpression extends Node {
  kind: "SequenceExpression";
  expressions: Expression[];
}

export interface NonNullExpression extends Node {
  kind: "NonNullExpression";
  expression: Expression;
}

export interface MemberExpression extends Node {
  kind: "MemberExpression";
  object: Expression;
  property: Expression;
  computed: boolean;
  optional: boolean;
}

export interface CallExpression extends Node {
  kind: "CallExpression";
  callee: Expression;
  arguments: Array<Expression | SpreadElement>;
  optional: boolean;
  typeArguments?: Type[];
}

export interface NewExpression extends Node {
  kind: "NewExpression";
  callee: Expression;
  arguments: Array<Expression | SpreadElement>;
  typeArguments?: Type[];
}

export interface AsExpression extends Node {
  kind: "AsExpression";
  expression: Expression;
  operator: "as" | "satisfies";
  type: Type | ConstType;
}

export interface ConstType extends Node {
  kind: "ConstType";
}

export interface TypeAssertion extends Node {
  kind: "TypeAssertion";
  type: Type;
  expression: Expression;
}

export interface ArrowFunctionExpression extends Node {
  kind: "ArrowFunctionExpression";
  params: Parameter[];
  body: Expression | BlockStatement;
  typeParameters?: TypeParameter[];
  async?: boolean;
}

export interface FunctionExpression extends Node {
  kind: "FunctionExpression";
  name: Identifier | null;
  typeParameters: TypeParameter[] | null;
  parameters: Parameter[];
  returnType: ReturnTypeNode | null;
  body: BlockStatement;
  async?: boolean;
  generator?: boolean;
}

export interface TaggedTemplateExpression extends Node {
  kind: "TaggedTemplateExpression";
  tag: Expression;
  quasi: TemplateLiteral;
}

export interface YieldExpression extends Node {
  kind: "YieldExpression";
  argument: Expression | null;
  delegate: boolean;
}

export interface ImportExpression extends Node {
  kind: "ImportExpression";
  source: Expression;
}

export interface MetaProperty extends Node {
  kind: "MetaProperty";
  meta: Identifier;
  property: Identifier;
}

export interface ExpressionWithTypeArguments extends Node {
  kind: "ExpressionWithTypeArguments";
  expression: Expression;
  typeArguments: Type[];
}

export type Expression =
  | Identifier
  | ThisExpression
  | SuperExpression
  | NumberLiteral
  | BigIntLiteral
  | StringLiteral
  | BooleanLiteral
  | NullLiteral
  | ParenthesizedExpression
  | ArrayLiteral
  | ObjectLiteral
  | TemplateLiteral
  | RegexLiteral
  | UnaryExpression
  | UpdateExpression
  | BinaryExpression
  | LogicalExpression
  | ConditionalExpression
  | AssignmentExpression
  | SequenceExpression
  | NonNullExpression
  | MemberExpression
  | CallExpression
  | NewExpression
  | TaggedTemplateExpression
  | YieldExpression
  | ImportExpression
  | MetaProperty
  | ExpressionWithTypeArguments
  | AsExpression
  | ConstType
  | TypeAssertion
  | ArrowFunctionExpression
  | FunctionExpression
  | ClassExpression;

export interface TypeNode {
  start: number;
  end: number;
}

export interface KeywordType extends TypeNode {
  kind: "KeywordType";
  name:
    | "any"
    | "unknown"
    | "never"
    | "void"
    | "undefined"
    | "null"
    | "boolean"
    | "number"
    | "string"
    | "bigint"
    | "symbol"
    | "object";
}

export interface ThisType extends TypeNode {
  kind: "ThisType";
}

export interface LiteralType extends TypeNode {
  kind: "LiteralType";
  literal: string | number | boolean | { value: string; raw: string };
}

export interface TypeReference extends TypeNode {
  kind: "TypeReference";
  name: string;
  typeArguments: Type[] | null;
}

export interface ParenthesizedType extends TypeNode {
  kind: "ParenthesizedType";
  type: Type;
}

export interface UnionType extends TypeNode {
  kind: "UnionType";
  types: Type[];
}

export interface IntersectionType extends TypeNode {
  kind: "IntersectionType";
  types: Type[];
}

export interface ArrayType extends TypeNode {
  kind: "ArrayType";
  elementType: Type;
}

export interface TupleElement extends TypeNode {
  kind: "TupleElement";
  elementType: Type;
  optional: boolean;
  rest: boolean;
  name?: Identifier;
}

export interface TupleType extends TypeNode {
  kind: "TupleType";
  elements: TupleElement[];
}

export interface IndexedAccessType extends TypeNode {
  kind: "IndexedAccessType";
  objectType: Type;
  indexType: Type;
}

export interface TypeOperator extends TypeNode {
  kind: "TypeOperator";
  operator: "keyof" | "typeof" | "readonly" | "unique";
  type: Type;
}

export interface BindingElement extends Node {
  kind: "BindingElement";
  key: Expression | null;
  binding: BindingName;
  default: Expression | null;
  rest: boolean;
  computed: boolean;
}

export interface ArrayPattern extends Node {
  kind: "ArrayPattern";
  elements: Array<BindingElement | null>;
}

export interface ObjectPattern extends Node {
  kind: "ObjectPattern";
  properties: BindingElement[];
}

export type BindingName = Identifier | ArrayPattern | ObjectPattern;

export interface Parameter extends Node {
  kind: "Parameter";
  name: BindingName;
  optional: boolean;
  rest: boolean;
  type: Type | null;
  initializer: Expression | null;
  accessibility?: "public" | "private" | "protected";
  readonly?: boolean;
  override?: boolean;
  decorators?: Expression[];
}

export interface TypeParameter extends Node {
  kind: "TypeParameter";
  name: Identifier;
  constraint: Type | null;
  default: Type | null;
  /** True for the TS 5.0 `const` modifier, e.g. `function f<const T>() {}`. */
  const?: boolean;
}

export interface ComputedPropertyName extends Node {
  kind: "ComputedPropertyName";
  expression: Expression;
}

export type MemberName = Identifier | StringLiteral | NumberLiteral | ComputedPropertyName;

export interface PropertySignature extends Node {
  kind: "PropertySignature";
  name: MemberName;
  optional: boolean;
  readonly: boolean;
  type: Type | null;
}

export interface MethodSignature extends Node {
  kind: "MethodSignature";
  name: MemberName;
  optional: boolean;
  typeParameters: TypeParameter[] | null;
  parameters: Parameter[];
  returnType: ReturnTypeNode | null;
}

export interface IndexSignature extends Node {
  kind: "IndexSignature";
  readonly: boolean;
  keyName: Identifier;
  keyType: Type;
  type: Type | null;
  decorators?: Expression[];
}

export interface CallSignature extends Node {
  kind: "CallSignature";
  typeParameters: TypeParameter[] | null;
  parameters: Parameter[];
  returnType: ReturnTypeNode | null;
}

export interface ConstructSignature extends Node {
  kind: "ConstructSignature";
  typeParameters: TypeParameter[] | null;
  parameters: Parameter[];
  returnType: ReturnTypeNode | null;
}

export type TypeMember =
  | PropertySignature
  | MethodSignature
  | IndexSignature
  | CallSignature
  | ConstructSignature;

export interface TypeLiteral extends TypeNode {
  kind: "TypeLiteral";
  members: TypeMember[];
}

export interface TypePredicate extends TypeNode {
  kind: "TypePredicate";
  asserts: boolean;
  parameterName: string;
  type: Type | null;
}

export type ReturnTypeNode = Type | TypePredicate;

export interface FunctionType extends TypeNode {
  kind: "FunctionType";
  typeParameters: TypeParameter[] | null;
  parameters: Parameter[];
  returnType: ReturnTypeNode;
}

export interface ConstructorType extends TypeNode {
  kind: "ConstructorType";
  abstract: boolean;
  typeParameters: TypeParameter[] | null;
  parameters: Parameter[];
  returnType: ReturnTypeNode;
}

export interface ConditionalType extends TypeNode {
  kind: "ConditionalType";
  checkType: Type;
  extendsType: Type;
  trueType: Type;
  falseType: Type;
}

export interface InferType extends TypeNode {
  kind: "InferType";
  name: Identifier;
  constraint: Type | null;
}

export interface MappedType extends TypeNode {
  kind: "MappedType";
  keyName: Identifier;
  constraint: Type;
  readonly: "add" | "remove" | null;
  optional: "add" | "remove" | null;
  valueType: Type | null;
}

export interface TemplateLiteralType extends TypeNode {
  kind: "TemplateLiteralType";
  quasis: string[];
  types: Type[];
}

export interface ImportType extends TypeNode {
  kind: "ImportType";
  argument: string;
  qualifier: string | null;
  typeArguments: Type[] | null;
}

export type Type =
  | KeywordType
  | ThisType
  | LiteralType
  | TypeReference
  | ParenthesizedType
  | UnionType
  | IntersectionType
  | ArrayType
  | TupleElement
  | TupleType
  | IndexedAccessType
  | TypeOperator
  | TypeLiteral
  | FunctionType
  | ConstructorType
  | TypePredicate
  | ConditionalType
  | InferType
  | MappedType
  | TemplateLiteralType
  | ImportType;

export interface Program extends Node {
  kind: "Program";
  body: Statement[];
  source: string;
}

export interface EmptyStatement extends Node {
  kind: "EmptyStatement";
}

export interface ExpressionStatement extends Node {
  kind: "ExpressionStatement";
  expression: Expression;
}

export interface BlockStatement extends Node {
  kind: "BlockStatement";
  body: Statement[];
}

export interface VariableDeclarator extends Node {
  kind: "VariableDeclarator";
  name: BindingName;
  type: Type | null;
  initializer: Expression | null;
}

export interface VariableStatement extends Node {
  kind: "VariableStatement";
  /**
   * `"using"` models ES2024 `using` / `await using` declarations; they are
   * block-scoped like `let`/`const`, so treating them as a declaration kind
   * keeps binding and indexing unchanged.
   */
  declarationKind: "var" | "let" | "const" | "using";
  declarations: VariableDeclarator[];
  declare?: boolean;
  /** True only for `await using` (with declarationKind `"using"`). */
  await?: boolean;
}

export interface FunctionDeclaration extends Node {
  kind: "FunctionDeclaration";
  name: Identifier | null;
  typeParameters: TypeParameter[] | null;
  parameters: Parameter[];
  returnType: ReturnTypeNode | null;
  body: BlockStatement | null;
  async?: boolean;
  generator?: boolean;
  declare?: boolean;
}

export interface ReturnStatement extends Node {
  kind: "ReturnStatement";
  argument: Expression | null;
}

export interface IfStatement extends Node {
  kind: "IfStatement";
  test: Expression;
  consequent: Statement;
  alternate: Statement | null;
}

export interface WhileStatement extends Node {
  kind: "WhileStatement";
  test: Expression;
  body: Statement;
}

export interface DoWhileStatement extends Node {
  kind: "DoWhileStatement";
  body: Statement;
  test: Expression;
}

export interface ForStatement extends Node {
  kind: "ForStatement";
  init: VariableStatement | Expression | null;
  test: Expression | null;
  update: Expression | null;
  body: Statement;
}

export interface ForInStatement extends Node {
  kind: "ForInStatement";
  left: VariableStatement | Expression;
  right: Expression;
  body: Statement;
}

export interface ForOfStatement extends Node {
  kind: "ForOfStatement";
  left: VariableStatement | Expression;
  right: Expression;
  body: Statement;
  await?: boolean;
}

export interface SwitchCase extends Node {
  kind: "SwitchCase";
  test: Expression | null;
  consequent: Statement[];
}

export interface SwitchStatement extends Node {
  kind: "SwitchStatement";
  discriminant: Expression;
  cases: SwitchCase[];
}

export interface CatchClause extends Node {
  kind: "CatchClause";
  param: Identifier | null;
  paramType: Type | null;
  body: BlockStatement;
}

export interface TryStatement extends Node {
  kind: "TryStatement";
  block: BlockStatement;
  handler: CatchClause | null;
  finalizer: BlockStatement | null;
}

export interface ThrowStatement extends Node {
  kind: "ThrowStatement";
  argument: Expression;
}

export interface BreakStatement extends Node {
  kind: "BreakStatement";
  label: Identifier | null;
}

export interface ContinueStatement extends Node {
  kind: "ContinueStatement";
  label: Identifier | null;
}

export interface LabeledStatement extends Node {
  kind: "LabeledStatement";
  label: Identifier;
  body: Statement;
}

export interface InterfaceDeclaration extends Node {
  kind: "InterfaceDeclaration";
  name: Identifier;
  typeParameters: TypeParameter[] | null;
  extends: TypeReference[];
  members: TypeMember[];
  declare?: boolean;
}

export interface TypeAliasDeclaration extends Node {
  kind: "TypeAliasDeclaration";
  name: Identifier;
  typeParameters: TypeParameter[] | null;
  type: Type;
  declare?: boolean;
}

export interface EnumMember extends Node {
  kind: "EnumMember";
  name: Identifier | StringLiteral;
  initializer: Expression | null;
}

export interface EnumDeclaration extends Node {
  kind: "EnumDeclaration";
  name: Identifier;
  const: boolean;
  members: EnumMember[];
  declare?: boolean;
}

export interface PropertyDeclaration extends Node {
  kind: "PropertyDeclaration";
  name: MemberName;
  type: Type | null;
  initializer: Expression | null;
  static: boolean;
  readonly: boolean;
  optional: boolean;
  definite: boolean;
  accessibility: "public" | "private" | "protected" | null;
  abstract: boolean;
  declare: boolean;
  override: boolean;
  decorators?: Expression[];
}

export interface MethodDeclaration extends Node {
  kind: "MethodDeclaration";
  name: MemberName;
  typeParameters: TypeParameter[] | null;
  parameters: Parameter[];
  returnType: ReturnTypeNode | null;
  body: BlockStatement | null;
  static: boolean;
  readonly: boolean;
  optional: boolean;
  accessibility: "public" | "private" | "protected" | null;
  abstract: boolean;
  override: boolean;
  async?: boolean;
  generator?: boolean;
  accessor?: "get" | "set";
  decorators?: Expression[];
}

export interface ConstructorDeclaration extends Node {
  kind: "ConstructorDeclaration";
  parameters: Parameter[];
  body: BlockStatement | null;
  accessibility: "public" | "private" | "protected" | null;
  decorators?: Expression[];
}

export interface StaticBlock extends Node {
  kind: "StaticBlock";
  body: BlockStatement;
}

export type ClassMember =
  | PropertyDeclaration
  | MethodDeclaration
  | ConstructorDeclaration
  | IndexSignature
  | StaticBlock;

export interface ClassDeclaration extends Node {
  kind: "ClassDeclaration";
  name: Identifier | null;
  typeParameters: TypeParameter[] | null;
  extends: Expression | null;
  implements: TypeReference[];
  members: ClassMember[];
  abstract?: boolean;
  declare?: boolean;
  decorators?: Expression[];
}

export interface ClassExpression extends Node {
  kind: "ClassExpression";
  name: Identifier | null;
  typeParameters: TypeParameter[] | null;
  extends: Expression | null;
  implements: TypeReference[];
  members: ClassMember[];
  abstract?: boolean;
  decorators?: Expression[];
}

export interface ImportSpecifier extends Node {
  kind: "ImportSpecifier";
  imported: Identifier | StringLiteral;
  local: Identifier;
  typeOnly: boolean;
}

export interface ImportAttribute extends Node {
  kind: "ImportAttribute";
  key: Identifier | StringLiteral;
  value: StringLiteral;
}

export interface ImportDeclaration extends Node {
  kind: "ImportDeclaration";
  defaultImport: Identifier | null;
  namespaceImport: Identifier | null;
  namedImports: ImportSpecifier[];
  source: StringLiteral;
  importKind: "value" | "type";
  /** Import attributes, e.g. `with { type: "json" }` (TS 5.3). */
  attributes?: ImportAttribute[];
}

export interface ImportEqualsDeclaration extends Node {
  kind: "ImportEqualsDeclaration";
  name: Identifier;
  moduleReference: Expression;
}

export interface NamespaceDeclaration extends Node {
  kind: "NamespaceDeclaration";
  name: string;
  body: Statement[];
  declare?: boolean;
}

export interface ExportSpecifier extends Node {
  kind: "ExportSpecifier";
  local: Identifier | StringLiteral;
  exported: Identifier | StringLiteral | null;
  typeOnly: boolean;
}

export interface ExportNamedDeclaration extends Node {
  kind: "ExportNamedDeclaration";
  declaration: Statement | null;
  specifiers: ExportSpecifier[];
  source: StringLiteral | null;
  exportKind: "value" | "type";
  /** Import attributes on `export ... from "..." with { ... }`. */
  attributes?: ImportAttribute[];
}

export interface ExportDefaultDeclaration extends Node {
  kind: "ExportDefaultDeclaration";
  declaration: Expression | FunctionDeclaration | ClassDeclaration;
}

export interface ExportAllDeclaration extends Node {
  kind: "ExportAllDeclaration";
  source: StringLiteral;
  exported: Identifier | null;
  exportKind: "value" | "type";
  /** Import attributes on `export * from "..." with { ... }`. */
  attributes?: ImportAttribute[];
}

export interface ExportAssignment extends Node {
  kind: "ExportAssignment";
  expression: Expression;
}

export type Statement =
  | EmptyStatement
  | ExpressionStatement
  | BlockStatement
  | VariableStatement
  | FunctionDeclaration
  | ReturnStatement
  | IfStatement
  | WhileStatement
  | DoWhileStatement
  | ForStatement
  | ForInStatement
  | ForOfStatement
  | SwitchStatement
  | TryStatement
  | ThrowStatement
  | BreakStatement
  | ContinueStatement
  | LabeledStatement
  | InterfaceDeclaration
  | TypeAliasDeclaration
  | EnumDeclaration
  | ClassDeclaration
  | ImportDeclaration
  | ImportEqualsDeclaration
  | NamespaceDeclaration
  | ExportNamedDeclaration
  | ExportDefaultDeclaration
  | ExportAllDeclaration
  | ExportAssignment;

export class ParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

interface ClassMemberModifiers {
  accessibility: "public" | "private" | "protected" | null;
  isStatic: boolean;
  isReadonly: boolean;
  isAbstract: boolean;
  isDeclare: boolean;
  isOverride: boolean;
  isAsync: boolean;
  isGenerator: boolean;
  accessor: "get" | "set" | null;
}

const triviaKinds: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "whitespace",
  "line-comment",
  "block-comment",
]);

const assignmentOperators: ReadonlySet<string> = new Set<string>([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "<<=",
  ">>=",
  ">>>=",
  "&=",
  "|=",
  "^=",
  "&&=",
  "||=",
  "??=",
]);

const unaryPunctuatorOperators: ReadonlySet<string> = new Set<string>(["!", "~", "+", "-"]);

const unaryKeywordOperators: ReadonlySet<string> = new Set<string>(["typeof", "void", "delete"]);

const expressionStartPunctuators: ReadonlySet<string> = new Set<string>([
  "(",
  "[",
  "{",
  "/",
  "/=",
  "+",
  "-",
  "!",
  "~",
  "++",
  "--",
]);

const equalityOperators: ReadonlySet<string> = new Set<string>(["==", "!=", "===", "!=="]);

const relationalPunctuatorOperators: ReadonlySet<string> = new Set<string>(["<", ">", "<=", ">="]);

const relationalKeywordOperators: ReadonlySet<string> = new Set<string>(["instanceof", "in"]);

const shiftOperators: ReadonlySet<string> = new Set<string>(["<<", ">>", ">>>"]);

const typeOperatorNames: ReadonlySet<string> = new Set<string>([
  "keyof",
  "typeof",
  "readonly",
  "unique",
]);

const keywordTypeNames: ReadonlySet<string> = new Set<string>([
  "any",
  "unknown",
  "never",
  "void",
  "undefined",
  "null",
  "boolean",
  "number",
  "string",
  "bigint",
  "symbol",
  "object",
]);

const classModifierNames: ReadonlySet<string> = new Set<string>([
  "public",
  "private",
  "protected",
  "static",
  "readonly",
  "abstract",
  "declare",
  "override",
  "async",
  "get",
  "set",
]);

const greaterThanPunctuators: ReadonlySet<string> = new Set<string>([
  ">",
  ">>",
  ">>>",
  ">=",
  ">>=",
  ">>>=",
]);

const additiveOperators: ReadonlySet<string> = new Set<string>(["+", "-"]);

const multiplicativeOperators: ReadonlySet<string> = new Set<string>(["*", "/", "%"]);

export class Parser {
  private readonly source: string;
  private lexer: Lexer;
  private lookahead: Token | undefined = undefined;
  private buffered: Token | undefined = undefined;
  private pending: Token[] = [];
  private readonly history: Token[] = [];
  private readonly rescanned = new Map<number, Token>();
  private cursor = 0;
  private lastConsumedEnd = 0;
  private lastConsumedLine = 0;

  constructor(source: string) {
    this.source = source;
    this.lexer = new Lexer(source);
  }

  parseProgram(): Program {
    const body: Statement[] = [];
    while (this.current().kind !== "eof") {
      body.push(this.parseStatement());
    }
    return {
      kind: "Program",
      body,
      source: this.source,
      start: 0,
      end: this.source.length,
    };
  }

  parseExpression(allowIn = true): Expression {
    const first = this.parseAssignmentExpression(allowIn);
    if (!this.isPunct(",")) {
      return first;
    }
    const expressions: Expression[] = [first];
    let last: Expression = first;
    while (this.matchPunct(",")) {
      last = this.parseAssignmentExpression(allowIn);
      expressions.push(last);
    }
    return { kind: "SequenceExpression", expressions, start: first.start, end: last.end };
  }

  parseAssignmentExpression(allowIn = true): Expression {
    const head = this.current();
    if (head.kind === "identifier" && head.value === "yield") {
      return this.parseYieldExpression();
    }
    if (head.kind === "identifier" && head.value === "async") {
      const next = this.peek();
      if (next.kind === "keyword" && next.value === "function") {
        return this.parseFunctionExpression(true);
      }
    }
    if (head.kind === "identifier" && head.value === "abstract") {
      const next = this.peek();
      if (next.kind === "keyword" && next.value === "class") {
        return this.parseClassExpression(true);
      }
    }
    const arrow = this.tryParseArrowFunction();
    if (arrow !== null) {
      return arrow;
    }
    const left = this.parseConditionalExpression(allowIn);
    const operator = this.matchPunctuator(assignmentOperators);
    if (operator === undefined) {
      return left;
    }
    const right = this.parseAssignmentExpression(allowIn);
    return {
      kind: "AssignmentExpression",
      operator: operator.text,
      left,
      right,
      start: left.start,
      end: right.end,
    };
  }

  private tryParseArrowFunction(): ArrowFunctionExpression | null {
    const token = this.current();
    if (token.kind === "punctuator") {
      if (token.text === "<") {
        return this.tryParseGenericArrow(token.start, false);
      }
      if (token.text === "(") {
        return this.tryParseParenthesizedArrow(token.start, false);
      }
      return null;
    }
    if (token.kind !== "identifier") {
      return null;
    }
    const next = this.peek();
    if (next.kind === "punctuator" && next.text === "=>") {
      return this.parseSingleParameterArrow(token.start, false);
    }
    if (token.value !== "async") {
      return null;
    }
    if (next.kind === "punctuator" && (next.text === "(" || next.text === "<")) {
      const checkpoint = this.save();
      this.advance();
      const arrow =
        next.text === "<"
          ? this.tryParseGenericArrow(token.start, true)
          : this.tryParseParenthesizedArrow(token.start, true);
      if (arrow !== null) {
        return arrow;
      }
      this.restore(checkpoint);
      return null;
    }
    if (next.kind === "identifier") {
      const checkpoint = this.save();
      this.advance();
      const after = this.peek();
      if (after.kind === "punctuator" && after.text === "=>") {
        return this.parseSingleParameterArrow(token.start, true);
      }
      this.restore(checkpoint);
      return null;
    }
    return null;
  }

  private parseSingleParameterArrow(start: number, async: boolean): ArrowFunctionExpression {
    const token = this.advance();
    const name: Identifier = {
      kind: "Identifier",
      name: token.value,
      start: token.start,
      end: token.end,
    };
    const parameter: Parameter = {
      kind: "Parameter",
      name,
      optional: false,
      rest: false,
      type: null,
      initializer: null,
      start: token.start,
      end: token.end,
    };
    return this.finishArrowFunction(start, async, null, [parameter]);
  }

  private tryParseParenthesizedArrow(
    start: number,
    async: boolean,
  ): ArrowFunctionExpression | null {
    const checkpoint = this.save();
    let parameters: Parameter[];
    try {
      parameters = this.parseParameters();
      if (this.matchPunct(":")) {
        this.parseReturnType();
      }
      if (!this.isPunct("=>")) {
        this.restore(checkpoint);
        return null;
      }
    } catch (error) {
      if (!(error instanceof ParseError)) {
        throw error;
      }
      this.restore(checkpoint);
      return null;
    }
    return this.finishArrowFunction(start, async, null, parameters);
  }

  private tryParseGenericArrow(start: number, async: boolean): ArrowFunctionExpression | null {
    const checkpoint = this.save();
    let typeParameters: TypeParameter[] | null;
    let parameters: Parameter[];
    try {
      typeParameters = this.parseTypeParameters();
      if (typeParameters === null) {
        this.restore(checkpoint);
        return null;
      }
      parameters = this.parseParameters();
      if (this.matchPunct(":")) {
        this.parseReturnType();
      }
      if (!this.isPunct("=>")) {
        this.restore(checkpoint);
        return null;
      }
    } catch (error) {
      if (!(error instanceof ParseError)) {
        throw error;
      }
      this.restore(checkpoint);
      return null;
    }
    return this.finishArrowFunction(start, async, typeParameters, parameters);
  }

  private finishArrowFunction(
    start: number,
    async: boolean,
    typeParameters: TypeParameter[] | null,
    parameters: Parameter[],
  ): ArrowFunctionExpression {
    this.expectPunct("=>");
    const body = this.parseArrowBody();
    const arrow: ArrowFunctionExpression = {
      kind: "ArrowFunctionExpression",
      params: parameters,
      body,
      start,
      end: body.end,
    };
    if (typeParameters !== null) {
      arrow.typeParameters = typeParameters;
    }
    if (async) {
      arrow.async = true;
    }
    return arrow;
  }

  private parseArrowBody(): Expression | BlockStatement {
    if (this.isPunct("{")) {
      return this.parseBlockStatement();
    }
    return this.parseAssignmentExpression();
  }

  private parseAnnotationType(): Type {
    this.matchPunct("|");
    return this.parseType();
  }

  parseType(): Type {
    const checkType = this.parseUnionType();
    if (!this.isKeyword("extends")) {
      return checkType;
    }
    this.advance();
    const extendsType = this.parseUnionType();
    this.expectPunct("?");
    const trueType = this.parseType();
    this.expectPunct(":");
    const falseType = this.parseType();
    return {
      kind: "ConditionalType",
      checkType,
      extendsType,
      trueType,
      falseType,
      start: checkType.start,
      end: falseType.end,
    };
  }

  parseParameters(): Parameter[] {
    return this.parseParameterList().parameters;
  }

  parseBindingName(): BindingName {
    const token = this.current();
    if (token.kind === "identifier") {
      this.advance();
      return { kind: "Identifier", name: token.value, start: token.start, end: token.end };
    }
    if (this.isPunct("[")) {
      return this.parseArrayPattern();
    }
    if (this.isPunct("{")) {
      return this.parseObjectPattern();
    }
    throw this.unexpected(token);
  }

  parseTypeParameters(): TypeParameter[] | null {
    if (!this.isPunct("<")) {
      return null;
    }
    this.advance();
    const parameters: TypeParameter[] = [];
    for (;;) {
      let constToken: Token | undefined;
      if (this.isKeyword("const") && this.peek().kind === "identifier") {
        constToken = this.advance();
      }
      const token = this.current();
      if (token.kind !== "identifier") {
        throw this.unexpected(token);
      }
      this.advance();
      const name: Identifier = {
        kind: "Identifier",
        name: token.value,
        start: token.start,
        end: token.end,
      };
      let end = token.end;
      let constraint: Type | null = null;
      if (this.isKeyword("extends")) {
        this.advance();
        constraint = this.parseUnionType();
        end = constraint.end;
      }
      let defaultValue: Type | null = null;
      if (this.matchPunct("=")) {
        defaultValue = this.parseType();
        end = defaultValue.end;
      }
      const parameter: TypeParameter = {
        kind: "TypeParameter",
        name,
        constraint,
        default: defaultValue,
        start: constToken === undefined ? token.start : constToken.start,
        end,
      };
      if (constToken !== undefined) {
        parameter.const = true;
      }
      parameters.push(parameter);
      if (!this.matchPunct(",")) {
        break;
      }
      if (this.isGreaterThanToken()) {
        break;
      }
    }
    this.expectGreaterThan();
    return parameters;
  }

  parseReturnType(): ReturnTypeNode {
    const token = this.current();
    if (token.kind === "identifier" && token.value === "asserts") {
      this.advance();
      const parameter = this.current();
      const isThis = parameter.kind === "keyword" && parameter.value === "this";
      if (parameter.kind !== "identifier" && !isThis) {
        throw this.unexpected(parameter);
      }
      this.advance();
      let type: Type | null = null;
      let end = parameter.end;
      if (this.isIdentifier("is")) {
        this.advance();
        type = this.parseType();
        end = type.end;
      }
      return {
        kind: "TypePredicate",
        asserts: true,
        parameterName: parameter.value,
        type,
        start: token.start,
        end,
      };
    }
    const type = this.parseAnnotationType();
    if (type.kind === "TypeReference" && !type.name.includes(".") && this.isIdentifier("is")) {
      this.advance();
      const predicateType = this.parseType();
      return {
        kind: "TypePredicate",
        asserts: false,
        parameterName: type.name,
        type: predicateType,
        start: type.start,
        end: predicateType.end,
      };
    }
    return type;
  }

  private parseStatement(): Statement {
    const token = this.current();
    if (token.kind === "punctuator") {
      if (token.text === "{") {
        return this.parseBlockStatement();
      }
      if (token.text === ";") {
        const semicolon = this.advance();
        return { kind: "EmptyStatement", start: semicolon.start, end: semicolon.end };
      }
      if (token.text === "@") {
        return this.parseDecoratedClassStatement();
      }
    }
    if (
      (token.kind === "keyword" || token.kind === "identifier") &&
      token.value === "import"
    ) {
      const next = this.peek();
      if (next.kind !== "punctuator" || next.text !== "(") {
        return this.parseImportDeclaration();
      }
    }
    if (token.kind === "keyword") {
      if (token.value === "export") {
        return this.parseExportStatement();
      }
      if (
        token.value === "const" &&
        this.peek().kind === "keyword" &&
        this.peek().value === "enum"
      ) {
        return this.parseEnumDeclaration(true);
      }
      if (token.value === "enum") {
        return this.parseEnumDeclaration(false);
      }
      if (token.value === "class") {
        return this.parseClassDeclaration(false);
      }
      if (token.value === "var" || token.value === "let" || token.value === "const") {
        return this.parseVariableStatement();
      }
      if (token.value === "function") {
        return this.parseFunctionDeclaration(false);
      }
      if (token.value === "return") {
        return this.parseReturnStatement();
      }
      if (token.value === "if") {
        return this.parseIfStatement();
      }
      if (token.value === "while") {
        return this.parseWhileStatement();
      }
      if (token.value === "do") {
        return this.parseDoWhileStatement();
      }
      if (token.value === "for") {
        return this.parseForStatement();
      }
      if (token.value === "switch") {
        return this.parseSwitchStatement();
      }
      if (token.value === "try") {
        return this.parseTryStatement();
      }
      if (token.value === "throw") {
        return this.parseThrowStatement();
      }
      if (token.value === "break") {
        return this.parseBreakStatement();
      }
      if (token.value === "continue") {
        return this.parseContinueStatement();
      }
    }
    if (token.kind === "identifier") {
      if (token.value === "using" && this.isUsingDeclarationStart()) {
        return this.parseUsingDeclaration(false);
      }
      if (token.value === "await" && this.isAwaitUsingDeclarationStart()) {
        return this.parseUsingDeclaration(true);
      }
      if (token.value === "declare") {
        return this.parseDeclareStatement();
      }
      const next = this.peek();
      if (token.value === "abstract" && next.kind === "keyword" && next.value === "class") {
        return this.parseClassDeclaration(true);
      }
      if (token.value === "interface") {
        return this.parseInterfaceDeclaration();
      }
      if (token.value === "type" && next.kind === "identifier") {
        return this.parseTypeAliasDeclaration();
      }
      if (
        token.value === "namespace" &&
        (next.kind === "identifier" ||
          (next.kind === "punctuator" && next.text === "{"))
      ) {
        return this.parseNamespaceDeclaration();
      }
      if (
        token.value === "module" &&
        (next.kind === "identifier" || next.kind === "string")
      ) {
        return this.parseNamespaceDeclaration();
      }
      if (next.kind === "punctuator" && next.text === ":") {
        return this.parseLabeledStatement();
      }
      if (token.value === "async" && next.kind === "keyword" && next.value === "function") {
        return this.parseFunctionDeclaration(true);
      }
    }
    const expression = this.parseExpression();
    this.consumeSemicolon();
    return {
      kind: "ExpressionStatement",
      expression,
      start: expression.start,
      end: this.lastConsumedEnd,
    };
  }

  private parseBlockStatement(): BlockStatement {
    const open = this.expectPunct("{");
    const body: Statement[] = [];
    while (!this.isPunct("}") && this.current().kind !== "eof") {
      body.push(this.parseStatement());
    }
    const close = this.expectPunct("}");
    return { kind: "BlockStatement", body, start: open.start, end: close.end };
  }

  private parseRequiredIdentifier(): Identifier {
    const token = this.current();
    if (token.kind !== "identifier") {
      throw this.unexpected(token);
    }
    this.advance();
    return { kind: "Identifier", name: token.value, start: token.start, end: token.end };
  }

  private parseImportDeclaration(): Statement {
    const keyword = this.expectKeyword("import");
    const first = this.current();
    if (first.kind === "string") {
      this.advance();
      const source: StringLiteral = {
        kind: "StringLiteral",
        value: first.value,
        raw: first.text,
        start: first.start,
        end: first.end,
      };
      const declaration: ImportDeclaration = {
        kind: "ImportDeclaration",
        defaultImport: null,
        namespaceImport: null,
        namedImports: [],
        source,
        importKind: "value",
        start: keyword.start,
        end: this.lastConsumedEnd,
      };
      const attributes = this.parseImportAttributes();
      if (attributes !== undefined) {
        declaration.attributes = attributes;
      }
      this.consumeSemicolon();
      declaration.end = this.lastConsumedEnd;
      return declaration;
    }
    if (
      first.kind === "identifier" &&
      this.peek().kind === "punctuator" &&
      this.peek().text === "="
    ) {
      return this.parseImportEqualsDeclaration(keyword);
    }
    let importKind: "value" | "type" = "value";
    if (this.isIdentifier("type")) {
      const next = this.peek();
      if (
        (next.kind === "identifier" && next.value !== "from") ||
        (next.kind === "punctuator" && (next.text === "{" || next.text === "*"))
      ) {
        importKind = "type";
        this.advance();
      }
    }
    let defaultImport: Identifier | null = null;
    let namespaceImport: Identifier | null = null;
    const namedImports: ImportSpecifier[] = [];
    const token = this.current();
    if (token.kind === "punctuator" && token.text === "*") {
      namespaceImport = this.parseNamespaceImport();
    } else if (token.kind === "punctuator" && token.text === "{") {
      namedImports.push(...this.parseNamedImports(importKind === "value"));
    } else if (token.kind === "identifier" && token.value !== "from") {
      defaultImport = this.parseRequiredIdentifier();
      if (this.matchPunct(",")) {
        if (this.isPunct("*")) {
          namespaceImport = this.parseNamespaceImport();
        } else if (this.isPunct("{")) {
          namedImports.push(...this.parseNamedImports(importKind === "value"));
        } else {
          throw this.unexpected(this.current());
        }
      }
    } else {
      throw this.unexpected(token);
    }
    if (!this.isIdentifier("from")) {
      throw this.errorAt(this.current(), 'expected "from"');
    }
    this.advance();
    const sourceToken = this.current();
    if (sourceToken.kind !== "string") {
      throw this.errorAt(sourceToken, "expected string literal");
    }
    this.advance();
    const source: StringLiteral = {
      kind: "StringLiteral",
      value: sourceToken.value,
      raw: sourceToken.text,
      start: sourceToken.start,
      end: sourceToken.end,
    };
    const declaration: ImportDeclaration = {
      kind: "ImportDeclaration",
      defaultImport,
      namespaceImport,
      namedImports,
      source,
      importKind,
      start: keyword.start,
      end: this.lastConsumedEnd,
    };
    const attributes = this.parseImportAttributes();
    if (attributes !== undefined) {
      declaration.attributes = attributes;
    }
    this.consumeSemicolon();
    declaration.end = this.lastConsumedEnd;
    return declaration;
  }

  /**
   * Parses an optional `with { key: "value", ... }` import-attributes clause
   * (TS 5.3). The deprecated `assert { ... }` spelling is intentionally not
   * supported. `with` tokenizes as a keyword, so compare it as one.
   */
  private parseImportAttributes(): ImportAttribute[] | undefined {
    if (!this.isKeyword("with")) {
      return undefined;
    }
    this.advance();
    this.expectPunct("{");
    const attributes: ImportAttribute[] = [];
    for (;;) {
      if (this.isPunct("}")) {
        break;
      }
      const keyToken = this.current();
      let key: Identifier | StringLiteral;
      if (keyToken.kind === "identifier" || keyToken.kind === "keyword") {
        this.advance();
        key = {
          kind: "Identifier",
          name: keyToken.value,
          start: keyToken.start,
          end: keyToken.end,
        };
      } else if (keyToken.kind === "string") {
        this.advance();
        key = {
          kind: "StringLiteral",
          value: keyToken.value,
          raw: keyToken.text,
          start: keyToken.start,
          end: keyToken.end,
        };
      } else {
        throw this.unexpected(keyToken);
      }
      this.expectPunct(":");
      const value = this.expectStringLiteral();
      attributes.push({
        kind: "ImportAttribute",
        key,
        value,
        start: key.start,
        end: value.end,
      });
      if (!this.matchPunct(",")) {
        break;
      }
    }
    this.expectPunct("}");
    return attributes;
  }

  private parseImportEqualsDeclaration(keyword: Token): ImportEqualsDeclaration {
    const name = this.parseRequiredIdentifier();
    this.expectPunct("=");
    const moduleReference = this.parseAssignmentExpression();
    this.consumeSemicolon();
    return {
      kind: "ImportEqualsDeclaration",
      name,
      moduleReference,
      start: keyword.start,
      end: this.lastConsumedEnd,
    };
  }

  private parseNamespaceImport(): Identifier {
    this.expectPunct("*");
    if (!this.isIdentifier("as")) {
      throw this.errorAt(this.current(), 'expected "as"');
    }
    this.advance();
    return this.parseRequiredIdentifier();
  }

  private parseNamedImports(allowTypeOnly: boolean): ImportSpecifier[] {
    this.expectPunct("{");
    if (this.isPunct("}")) {
      throw this.errorAt(this.current(), "named imports may not be empty");
    }
    const specifiers: ImportSpecifier[] = [];
    for (;;) {
      specifiers.push(this.parseImportSpecifier(allowTypeOnly));
      if (!this.matchPunct(",")) {
        break;
      }
      if (this.isPunct("}")) {
        break;
      }
    }
    this.expectPunct("}");
    return specifiers;
  }

  private parseImportSpecifier(allowTypeOnly: boolean): ImportSpecifier {
    let typeOnly = false;
    if (allowTypeOnly && this.isIdentifier("type")) {
      const next = this.peek();
      if (
        (next.kind === "identifier" && next.value !== "as") ||
        next.kind === "string"
      ) {
        typeOnly = true;
        this.advance();
      }
    }
    const token = this.current();
    let imported: Identifier | StringLiteral;
    if (token.kind === "string") {
      this.advance();
      imported = {
        kind: "StringLiteral",
        value: token.value,
        raw: token.text,
        start: token.start,
        end: token.end,
      };
    } else {
      imported = this.parseRequiredIdentifier();
    }
    let local: Identifier;
    if (this.isIdentifier("as")) {
      this.advance();
      local = this.parseRequiredIdentifier();
    } else if (imported.kind === "StringLiteral") {
      throw this.errorAt(this.current(), 'expected "as"');
    } else {
      local = {
        kind: "Identifier",
        name: imported.name,
        start: imported.start,
        end: imported.end,
      };
    }
    return {
      kind: "ImportSpecifier",
      imported,
      local,
      typeOnly,
      start: imported.start,
      end: local.end,
    };
  }

  private parseNamespaceDeclaration(): NamespaceDeclaration {
    const keyword = this.advance();
    const token = this.current();
    let name: string;
    if (token.kind === "string") {
      this.advance();
      name = token.value;
    } else if (token.kind === "identifier") {
      this.advance();
      name = token.value;
      while (this.isPunct(".")) {
        this.advance();
        const part = this.current();
        if (part.kind !== "identifier") {
          throw this.unexpected(part);
        }
        this.advance();
        name += `.${part.value}`;
      }
    } else {
      throw this.unexpected(token);
    }
    this.expectPunct("{");
    const body: Statement[] = [];
    while (!this.isPunct("}") && this.current().kind !== "eof") {
      body.push(this.parseStatement());
    }
    const close = this.expectPunct("}");
    return { kind: "NamespaceDeclaration", name, body, start: keyword.start, end: close.end };
  }

  private parseVariableStatement(): VariableStatement {
    const declaration = this.parseVariableDeclaration();
    this.consumeSemicolon();
    return { ...declaration, end: this.lastConsumedEnd };
  }

  private parseVariableDeclaration(): VariableStatement {
    const keyword = this.advance();
    const declarationKind = keyword.value as VariableStatement["declarationKind"];
    const declarations = this.parseVariableDeclaratorList();
    const last = declarations[declarations.length - 1];
    return {
      kind: "VariableStatement",
      declarationKind,
      declarations,
      start: keyword.start,
      end: last === undefined ? keyword.end : last.end,
    };
  }

  /**
   * `using` / `await using` declarations are modeled as VariableStatements
   * with declarationKind `"using"`; the binder treats any non-`var` kind as
   * block-scoped, so the names bind in the enclosing block.
   */
  private parseUsingDeclaration(isAwait: boolean): VariableStatement {
    const start = isAwait ? this.advance().start : this.current().start;
    const keyword = this.advance(); // `using`
    const statement: VariableStatement = {
      kind: "VariableStatement",
      declarationKind: "using",
      declarations: this.parseVariableDeclaratorList(),
      start,
      end: keyword.end,
    };
    if (isAwait) {
      statement.await = true;
    }
    this.consumeSemicolon();
    statement.end = this.lastConsumedEnd;
    return statement;
  }

  private parseVariableDeclaratorList(): VariableDeclarator[] {
    const declarations: VariableDeclarator[] = [];
    for (;;) {
      declarations.push(this.parseVariableDeclarator());
      if (!this.matchPunct(",")) {
        break;
      }
    }
    return declarations;
  }

  /** `using` is contextual: only followed by a binding on the same line. */
  private isUsingDeclarationStart(): boolean {
    const next = this.peek();
    return next.line === this.current().line && this.isBindingStartToken(next);
  }

  private isAwaitUsingDeclarationStart(): boolean {
    const current = this.current();
    const using = this.peekAhead(1);
    if (using.kind !== "identifier" || using.value !== "using") {
      return false;
    }
    if (using.line !== current.line) {
      return false;
    }
    const binding = this.peekAhead(2);
    return binding.line === using.line && this.isBindingStartToken(binding);
  }

  /**
   * A `using` declaration only starts with `using <identifier>` or
   * `using { ... }`. Like TypeScript, a `using [` stays an expression
   * (member/index access on a value named `using`), never a declaration.
   */
  private isBindingStartToken(token: Token): boolean {
    if (token.kind === "identifier") {
      return true;
    }
    return token.kind === "punctuator" && token.text === "{";
  }

  private parseVariableDeclarator(): VariableDeclarator {
    const name = this.parseBindingName();
    let end = name.end;
    let type: Type | null = null;
    if (this.matchPunct(":")) {
      type = this.parseAnnotationType();
      end = type.end;
    }
    let initializer: Expression | null = null;
    if (this.matchPunct("=")) {
      initializer = this.parseAssignmentExpression();
      end = initializer.end;
    }
    return { kind: "VariableDeclarator", name, type, initializer, start: name.start, end };
  }

  private parseFunctionDeclaration(async: boolean, allowAnonymous = false): FunctionDeclaration {
    const start = async ? this.advance().start : this.current().start;
    this.expectKeyword("function");
    let generator = false;
    if (this.matchPunct("*")) {
      generator = true;
    }
    const nameToken = this.current();
    let name: Identifier | null = null;
    if (nameToken.kind === "identifier") {
      this.advance();
      name = {
        kind: "Identifier",
        name: nameToken.value,
        start: nameToken.start,
        end: nameToken.end,
      };
    } else if (!allowAnonymous) {
      throw this.unexpected(nameToken);
    }
    const typeParameters = this.parseTypeParameters();
    const parameters = this.parseParameters();
    let returnType: ReturnTypeNode | null = null;
    if (this.matchPunct(":")) {
      returnType = this.parseReturnType();
    }
    let body: BlockStatement | null = null;
    if (this.isPunct("{")) {
      body = this.parseBlockStatement();
    } else {
      this.consumeSemicolon();
    }
    const declaration: FunctionDeclaration = {
      kind: "FunctionDeclaration",
      name,
      typeParameters,
      parameters,
      returnType,
      body,
      start,
      end: this.lastConsumedEnd,
    };
    if (async) {
      declaration.async = true;
    }
    if (generator) {
      declaration.generator = true;
    }
    return declaration;
  }

  private parseFunctionExpression(async: boolean): FunctionExpression {
    const start = async ? this.advance().start : this.current().start;
    this.expectKeyword("function");
    let generator = false;
    if (this.matchPunct("*")) {
      generator = true;
    }
    let name: Identifier | null = null;
    const nameToken = this.current();
    if (nameToken.kind === "identifier") {
      this.advance();
      name = {
        kind: "Identifier",
        name: nameToken.value,
        start: nameToken.start,
        end: nameToken.end,
      };
    }
    const typeParameters = this.parseTypeParameters();
    const parameters = this.parseParameters();
    let returnType: ReturnTypeNode | null = null;
    if (this.matchPunct(":")) {
      returnType = this.parseReturnType();
    }
    const body = this.parseBlockStatement();
    const expression: FunctionExpression = {
      kind: "FunctionExpression",
      name,
      typeParameters,
      parameters,
      returnType,
      body,
      start,
      end: body.end,
    };
    if (async) {
      expression.async = true;
    }
    if (generator) {
      expression.generator = true;
    }
    return expression;
  }

  private parseReturnStatement(): ReturnStatement {
    const keyword = this.expectKeyword("return");
    const token = this.current();
    const terminates =
      token.kind === "eof" ||
      (token.kind === "punctuator" && (token.text === ";" || token.text === "}"));
    let argument: Expression | null = null;
    if (token.line === keyword.line && !terminates) {
      argument = this.parseExpression();
    }
    this.consumeSemicolon();
    return { kind: "ReturnStatement", argument, start: keyword.start, end: this.lastConsumedEnd };
  }

  private parseIfStatement(): IfStatement {
    const keyword = this.expectKeyword("if");
    const test = this.parseParenthesizedTest();
    const consequent = this.parseStatement();
    let alternate: Statement | null = null;
    if (this.isKeyword("else")) {
      this.advance();
      alternate = this.parseStatement();
    }
    return {
      kind: "IfStatement",
      test,
      consequent,
      alternate,
      start: keyword.start,
      end: alternate === null ? consequent.end : alternate.end,
    };
  }

  private parseWhileStatement(): WhileStatement {
    const keyword = this.expectKeyword("while");
    const test = this.parseParenthesizedTest();
    const body = this.parseStatement();
    return { kind: "WhileStatement", test, body, start: keyword.start, end: body.end };
  }

  private parseDoWhileStatement(): DoWhileStatement {
    const keyword = this.expectKeyword("do");
    const body = this.parseStatement();
    this.expectKeyword("while");
    const test = this.parseParenthesizedTest();
    this.consumeSemicolon();
    return {
      kind: "DoWhileStatement",
      body,
      test,
      start: keyword.start,
      end: this.lastConsumedEnd,
    };
  }

  private parseForStatement(): Statement {
    const keyword = this.expectKeyword("for");
    let isAwait = false;
    if (this.isIdentifier("await")) {
      isAwait = true;
      this.advance();
    }
    this.expectPunct("(");
    let init: VariableStatement | Expression | null = null;
    if (!this.isPunct(";")) {
      if (this.isKeyword("var") || this.isKeyword("let") || this.isKeyword("const")) {
        init = this.parseVariableDeclaration();
      } else {
        init = this.parseExpression(false);
      }
      if (this.isKeyword("in") || this.isIdentifier("of")) {
        const isOf = this.isIdentifier("of");
        const operator = this.advance();
        if (isAwait && !isOf) {
          throw this.errorAt(operator, 'expected "of"');
        }
        const right = this.parseExpression();
        this.expectPunct(")");
        const body = this.parseStatement();
        if (isOf) {
          const statement: ForOfStatement = {
            kind: "ForOfStatement",
            left: init,
            right,
            body,
            start: keyword.start,
            end: body.end,
          };
          if (isAwait) {
            statement.await = true;
          }
          return statement;
        }
        return {
          kind: "ForInStatement",
          left: init,
          right,
          body,
          start: keyword.start,
          end: body.end,
        };
      }
      if (isAwait) {
        throw this.errorAt(this.current(), 'expected "of"');
      }
    }
    this.expectPunct(";");
    let test: Expression | null = null;
    if (!this.isPunct(";")) {
      test = this.parseExpression();
    }
    this.expectPunct(";");
    let update: Expression | null = null;
    if (!this.isPunct(")")) {
      update = this.parseExpression();
    }
    this.expectPunct(")");
    const body = this.parseStatement();
    return {
      kind: "ForStatement",
      init,
      test,
      update,
      body,
      start: keyword.start,
      end: body.end,
    };
  }

  private parseSwitchStatement(): SwitchStatement {
    const keyword = this.expectKeyword("switch");
    const discriminant = this.parseParenthesizedTest();
    this.expectPunct("{");
    const cases: SwitchCase[] = [];
    while (!this.isPunct("}") && this.current().kind !== "eof") {
      cases.push(this.parseSwitchCase());
    }
    const close = this.expectPunct("}");
    return {
      kind: "SwitchStatement",
      discriminant,
      cases,
      start: keyword.start,
      end: close.end,
    };
  }

  private parseSwitchCase(): SwitchCase {
    const token = this.current();
    let test: Expression | null = null;
    if (token.kind === "keyword" && token.value === "case") {
      this.advance();
      test = this.parseExpression();
    } else if (token.kind === "keyword" && token.value === "default") {
      this.advance();
    } else {
      throw this.unexpected(token);
    }
    const colon = this.expectPunct(":");
    const consequent: Statement[] = [];
    while (!this.isPunct("}") && this.current().kind !== "eof") {
      const current = this.current();
      if (current.kind === "keyword" && (current.value === "case" || current.value === "default")) {
        break;
      }
      consequent.push(this.parseStatement());
    }
    const last = consequent[consequent.length - 1];
    return {
      kind: "SwitchCase",
      test,
      consequent,
      start: token.start,
      end: last === undefined ? colon.end : last.end,
    };
  }

  private parseTryStatement(): TryStatement {
    const keyword = this.expectKeyword("try");
    const block = this.parseBlockStatement();
    let handler: CatchClause | null = null;
    let finalizer: BlockStatement | null = null;
    if (this.isKeyword("catch")) {
      handler = this.parseCatchClause();
    }
    if (this.isKeyword("finally")) {
      this.advance();
      finalizer = this.parseBlockStatement();
    }
    if (handler === null && finalizer === null) {
      throw this.errorAt(this.current(), "expected catch or finally");
    }
    return {
      kind: "TryStatement",
      block,
      handler,
      finalizer,
      start: keyword.start,
      end: finalizer !== null ? finalizer.end : handler !== null ? handler.end : block.end,
    };
  }

  private parseCatchClause(): CatchClause {
    const keyword = this.expectKeyword("catch");
    let param: Identifier | null = null;
    let paramType: Type | null = null;
    if (this.matchPunct("(")) {
      const token = this.current();
      if (token.kind !== "identifier") {
        throw this.unexpected(token);
      }
      this.advance();
      param = { kind: "Identifier", name: token.value, start: token.start, end: token.end };
      if (this.matchPunct(":")) {
        paramType = this.parseType();
      }
      this.expectPunct(")");
    }
    const body = this.parseBlockStatement();
    return { kind: "CatchClause", param, paramType, body, start: keyword.start, end: body.end };
  }

  private parseThrowStatement(): ThrowStatement {
    const keyword = this.expectKeyword("throw");
    const token = this.current();
    if (token.line > keyword.line) {
      throw this.errorAt(token, "illegal newline after throw");
    }
    const argument = this.parseExpression();
    this.consumeSemicolon();
    return { kind: "ThrowStatement", argument, start: keyword.start, end: this.lastConsumedEnd };
  }

  private parseBreakStatement(): BreakStatement {
    const keyword = this.expectKeyword("break");
    const label = this.parseOptionalLabel(keyword);
    this.consumeSemicolon();
    return { kind: "BreakStatement", label, start: keyword.start, end: this.lastConsumedEnd };
  }

  private parseContinueStatement(): ContinueStatement {
    const keyword = this.expectKeyword("continue");
    const label = this.parseOptionalLabel(keyword);
    this.consumeSemicolon();
    return { kind: "ContinueStatement", label, start: keyword.start, end: this.lastConsumedEnd };
  }

  private parseOptionalLabel(keyword: Token): Identifier | null {
    const token = this.current();
    if (token.kind !== "identifier" || token.line > keyword.line) {
      return null;
    }
    this.advance();
    return { kind: "Identifier", name: token.value, start: token.start, end: token.end };
  }

  private parseLabeledStatement(): LabeledStatement {
    const token = this.advance();
    const label: Identifier = {
      kind: "Identifier",
      name: token.value,
      start: token.start,
      end: token.end,
    };
    this.expectPunct(":");
    const body = this.parseStatement();
    return { kind: "LabeledStatement", label, body, start: token.start, end: body.end };
  }

  private parseExportStatement(): Statement {
    const keyword = this.expectKeyword("export");
    const token = this.current();
    if (token.kind === "punctuator" && token.text === "=") {
      this.advance();
      const expression = this.parseAssignmentExpression();
      this.consumeSemicolon();
      return {
        kind: "ExportAssignment",
        expression,
        start: keyword.start,
        end: this.lastConsumedEnd,
      };
    }
    if (token.kind === "keyword" && token.value === "default") {
      return this.parseExportDefaultDeclaration(keyword);
    }
    if (token.kind === "punctuator" && token.text === "*") {
      return this.parseExportAllDeclaration(keyword, "value");
    }
    if (token.kind === "identifier" && token.value === "type") {
      const next = this.peek();
      if (next.kind === "punctuator" && (next.text === "{" || next.text === "*")) {
        this.advance();
        if (this.isPunct("*")) {
          return this.parseExportAllDeclaration(keyword, "type");
        }
        return this.parseExportNamedSpecifiers(keyword, "type");
      }
    }
    if (token.kind === "punctuator" && token.text === "{") {
      return this.parseExportNamedSpecifiers(keyword, "value");
    }
    const declaration = this.parseStatement();
    return {
      kind: "ExportNamedDeclaration",
      declaration,
      specifiers: [],
      source: null,
      exportKind: "value",
      start: keyword.start,
      end: declaration.end,
    };
  }

  private parseExportDefaultDeclaration(keyword: Token): ExportDefaultDeclaration {
    this.expectKeyword("default");
    const token = this.current();
    if (token.kind === "keyword" && token.value === "function") {
      const declaration = this.parseFunctionDeclaration(false, true);
      return {
        kind: "ExportDefaultDeclaration",
        declaration,
        start: keyword.start,
        end: declaration.end,
      };
    }
    if (token.kind === "keyword" && token.value === "class") {
      const declaration = this.parseClassDeclaration(false, true);
      return {
        kind: "ExportDefaultDeclaration",
        declaration,
        start: keyword.start,
        end: declaration.end,
      };
    }
    if (
      token.kind === "identifier" &&
      token.value === "async" &&
      this.peek().kind === "keyword" &&
      this.peek().value === "function"
    ) {
      const declaration = this.parseFunctionDeclaration(true, true);
      return {
        kind: "ExportDefaultDeclaration",
        declaration,
        start: keyword.start,
        end: declaration.end,
      };
    }
    const declaration = this.parseAssignmentExpression();
    this.consumeSemicolon();
    return {
      kind: "ExportDefaultDeclaration",
      declaration,
      start: keyword.start,
      end: this.lastConsumedEnd,
    };
  }

  private parseExportAllDeclaration(
    keyword: Token,
    exportKind: "value" | "type",
  ): ExportAllDeclaration {
    this.expectPunct("*");
    let exported: Identifier | null = null;
    if (this.isIdentifier("as")) {
      this.advance();
      exported = this.parseRequiredIdentifier();
    }
    if (!this.isIdentifier("from")) {
      throw this.errorAt(this.current(), 'expected "from"');
    }
    this.advance();
    const source = this.expectStringLiteral();
    const declaration: ExportAllDeclaration = {
      kind: "ExportAllDeclaration",
      source,
      exported,
      exportKind,
      start: keyword.start,
      end: this.lastConsumedEnd,
    };
    const attributes = this.parseImportAttributes();
    if (attributes !== undefined) {
      declaration.attributes = attributes;
    }
    this.consumeSemicolon();
    declaration.end = this.lastConsumedEnd;
    return declaration;
  }

  private parseExportNamedSpecifiers(
    keyword: Token,
    exportKind: "value" | "type",
  ): ExportNamedDeclaration {
    this.expectPunct("{");
    const specifiers: ExportSpecifier[] = [];
    for (;;) {
      if (this.isPunct("}")) {
        break;
      }
      specifiers.push(this.parseExportSpecifier(exportKind === "value"));
      if (!this.matchPunct(",")) {
        break;
      }
    }
    this.expectPunct("}");
    let source: StringLiteral | null = null;
    if (this.isIdentifier("from")) {
      this.advance();
      source = this.expectStringLiteral();
    }
    const declaration: ExportNamedDeclaration = {
      kind: "ExportNamedDeclaration",
      declaration: null,
      specifiers,
      source,
      exportKind,
      start: keyword.start,
      end: this.lastConsumedEnd,
    };
    if (source !== null) {
      const attributes = this.parseImportAttributes();
      if (attributes !== undefined) {
        declaration.attributes = attributes;
      }
    }
    this.consumeSemicolon();
    declaration.end = this.lastConsumedEnd;
    return declaration;
  }

  private parseExportSpecifier(allowTypeOnly: boolean): ExportSpecifier {
    let typeOnly = false;
    if (allowTypeOnly && this.isIdentifier("type")) {
      const next = this.peek();
      if ((next.kind === "identifier" && next.value !== "as") || next.kind === "string") {
        typeOnly = true;
        this.advance();
      }
    }
    const token = this.current();
    let local: Identifier | StringLiteral;
    if (token.kind === "string") {
      this.advance();
      local = {
        kind: "StringLiteral",
        value: token.value,
        raw: token.text,
        start: token.start,
        end: token.end,
      };
    } else if (token.kind === "identifier" || token.kind === "keyword") {
      this.advance();
      local = { kind: "Identifier", name: token.value, start: token.start, end: token.end };
    } else {
      throw this.unexpected(token);
    }
    let exported: Identifier | StringLiteral | null = null;
    if (this.isIdentifier("as")) {
      this.advance();
      const target = this.current();
      if (target.kind === "string") {
        this.advance();
        exported = {
          kind: "StringLiteral",
          value: target.value,
          raw: target.text,
          start: target.start,
          end: target.end,
        };
      } else if (target.kind === "identifier" || target.kind === "keyword") {
        this.advance();
        exported = {
          kind: "Identifier",
          name: target.value,
          start: target.start,
          end: target.end,
        };
      } else {
        throw this.unexpected(target);
      }
    } else if (local.kind === "StringLiteral") {
      throw this.errorAt(this.current(), 'expected "as"');
    }
    return {
      kind: "ExportSpecifier",
      local,
      exported,
      typeOnly,
      start: local.start,
      end: exported === null ? local.end : exported.end,
    };
  }

  private expectStringLiteral(): StringLiteral {
    const token = this.current();
    if (token.kind !== "string") {
      throw this.errorAt(token, "expected string literal");
    }
    this.advance();
    return {
      kind: "StringLiteral",
      value: token.value,
      raw: token.text,
      start: token.start,
      end: token.end,
    };
  }

  private parseDeclareStatement(): Statement {
    const keyword = this.advance();
    if (this.isIdentifier("global") && this.isPunctAhead("{")) {
      this.advance();
      this.expectPunct("{");
      const body: Statement[] = [];
      while (!this.isPunct("}") && this.current().kind !== "eof") {
        body.push(this.parseStatement());
      }
      const close = this.expectPunct("}");
      return {
        kind: "NamespaceDeclaration",
        name: "global",
        body,
        declare: true,
        start: keyword.start,
        end: close.end,
      };
    }
    const declaration = this.parseStatement();
    switch (declaration.kind) {
      case "VariableStatement":
      case "FunctionDeclaration":
      case "ClassDeclaration":
      case "InterfaceDeclaration":
      case "TypeAliasDeclaration":
      case "EnumDeclaration":
      case "NamespaceDeclaration":
        declaration.declare = true;
        return declaration;
      default:
        throw this.errorAt(keyword, "declare must precede a declaration");
    }
  }

  private parseDecoratedClassStatement(): Statement {
    const { decorators, start } = this.parseDecorators();
    if (this.isKeyword("export")) {
      this.advance();
      const declaration = this.parseDecoratedClassDeclaration(decorators, start);
      return {
        kind: "ExportNamedDeclaration",
        declaration,
        specifiers: [],
        source: null,
        exportKind: "value",
        start,
        end: declaration.end,
      };
    }
    return this.parseDecoratedClassDeclaration(decorators, start);
  }

  private parseDecoratedClassDeclaration(
    decorators: Expression[],
    start: number,
  ): ClassDeclaration {
    let declaration: ClassDeclaration;
    if (this.isKeyword("class")) {
      declaration = this.parseClassDeclaration(false);
    } else if (
      this.isIdentifier("abstract") &&
      this.peek().kind === "keyword" &&
      this.peek().value === "class"
    ) {
      declaration = this.parseClassDeclaration(true);
    } else {
      throw this.unexpected(this.current());
    }
    declaration.decorators = decorators;
    declaration.start = start;
    return declaration;
  }

  private parseDecorators(): { decorators: Expression[]; start: number } {
    const start = this.current().start;
    const decorators: Expression[] = [];
    while (this.isPunct("@")) {
      this.advance();
      decorators.push(this.parseDecoratorExpression());
    }
    return { decorators, start };
  }

  private parseDecoratorExpression(): Expression {
    const checkpoint = this.save();
    try {
      return this.parseLeftHandSideExpression();
    } catch (error) {
      if (!(error instanceof ParseError)) {
        throw error;
      }
      this.restore(checkpoint);
    }
    return this.parseRestrictedDecoratorExpression();
  }

  private parseRestrictedDecoratorExpression(): Expression {
    let expression = this.parsePrimaryExpression();
    for (;;) {
      if (this.isPunct(".")) {
        this.advance();
        const property = this.parseMemberProperty();
        expression = {
          kind: "MemberExpression",
          object: expression,
          property,
          computed: false,
          optional: false,
          start: expression.start,
          end: property.end,
        };
        continue;
      }
      if (this.isPunct("(")) {
        const args = this.parseArguments();
        expression = {
          kind: "CallExpression",
          callee: expression,
          arguments: args.arguments,
          optional: false,
          start: expression.start,
          end: args.end,
        };
        continue;
      }
      return expression;
    }
  }

  private parseInterfaceDeclaration(): InterfaceDeclaration {
    const keyword = this.advance();
    const nameToken = this.current();
    if (nameToken.kind !== "identifier") {
      throw this.unexpected(nameToken);
    }
    this.advance();
    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.value,
      start: nameToken.start,
      end: nameToken.end,
    };
    const typeParameters = this.parseTypeParameters();
    const extended: TypeReference[] = [];
    if (this.isKeyword("extends")) {
      this.advance();
      for (;;) {
        extended.push(this.parseTypeReference());
        if (!this.matchPunct(",")) {
          break;
        }
      }
    }
    this.expectPunct("{");
    const members = this.parseTypeMemberList("}");
    const close = this.expectPunct("}");
    return {
      kind: "InterfaceDeclaration",
      name,
      typeParameters,
      extends: extended,
      members,
      start: keyword.start,
      end: close.end,
    };
  }

  private parseTypeAliasDeclaration(): TypeAliasDeclaration {
    const keyword = this.advance();
    const nameToken = this.current();
    if (nameToken.kind !== "identifier") {
      throw this.unexpected(nameToken);
    }
    this.advance();
    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.value,
      start: nameToken.start,
      end: nameToken.end,
    };
    const typeParameters = this.parseTypeParameters();
    this.expectPunct("=");
    const type = this.parseAnnotationType();
    this.consumeSemicolon();
    return {
      kind: "TypeAliasDeclaration",
      name,
      typeParameters,
      type,
      start: keyword.start,
      end: this.lastConsumedEnd,
    };
  }

  private parseEnumDeclaration(isConst: boolean): EnumDeclaration {
    const start = isConst ? this.expectKeyword("const").start : this.current().start;
    this.expectKeyword("enum");
    const nameToken = this.current();
    if (nameToken.kind !== "identifier") {
      throw this.unexpected(nameToken);
    }
    this.advance();
    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.value,
      start: nameToken.start,
      end: nameToken.end,
    };
    this.expectPunct("{");
    const members: EnumMember[] = [];
    for (;;) {
      if (this.isPunct("}")) {
        break;
      }
      members.push(this.parseEnumMember());
      if (!this.matchPunct(",")) {
        break;
      }
    }
    this.expectPunct("}");
    this.consumeSemicolon();
    return {
      kind: "EnumDeclaration",
      name,
      const: isConst,
      members,
      start,
      end: this.lastConsumedEnd,
    };
  }

  private parseEnumMember(): EnumMember {
    const token = this.current();
    let name: Identifier | StringLiteral;
    if (token.kind === "identifier") {
      this.advance();
      name = { kind: "Identifier", name: token.value, start: token.start, end: token.end };
    } else if (token.kind === "string") {
      this.advance();
      name = {
        kind: "StringLiteral",
        value: token.value,
        raw: token.text,
        start: token.start,
        end: token.end,
      };
    } else {
      throw this.unexpected(token);
    }
    let initializer: Expression | null = null;
    let end = name.end;
    if (this.matchPunct("=")) {
      initializer = this.parseAssignmentExpression();
      end = initializer.end;
    }
    return { kind: "EnumMember", name, initializer, start: name.start, end };
  }

  private parseClassDeclaration(isAbstract: boolean, allowAnonymous = false): ClassDeclaration {
    const start = isAbstract ? this.advance().start : this.current().start;
    this.expectKeyword("class");
    const nameToken = this.current();
    let name: Identifier | null = null;
    if (nameToken.kind === "identifier") {
      this.advance();
      name = {
        kind: "Identifier",
        name: nameToken.value,
        start: nameToken.start,
        end: nameToken.end,
      };
    } else if (!allowAnonymous) {
      throw this.unexpected(nameToken);
    }
    const typeParameters = this.parseTypeParameters();
    let heritage: Expression | null = null;
    if (this.isKeyword("extends")) {
      this.advance();
      heritage = this.parseHeritageExpression();
    }
    const implemented: TypeReference[] = [];
    if (this.isIdentifier("implements")) {
      this.advance();
      for (;;) {
        implemented.push(this.parseTypeReference());
        if (!this.matchPunct(",")) {
          break;
        }
      }
    }
    this.expectPunct("{");
    const members = this.parseClassMemberList();
    const close = this.expectPunct("}");
    const declaration: ClassDeclaration = {
      kind: "ClassDeclaration",
      name,
      typeParameters,
      extends: heritage,
      implements: implemented,
      members,
      start,
      end: close.end,
    };
    if (isAbstract) {
      declaration.abstract = true;
    }
    return declaration;
  }

  private parseClassExpression(isAbstract: boolean): ClassExpression {
    const start = isAbstract ? this.advance().start : this.current().start;
    this.expectKeyword("class");
    let name: Identifier | null = null;
    const nameToken = this.current();
    if (nameToken.kind === "identifier") {
      this.advance();
      name = {
        kind: "Identifier",
        name: nameToken.value,
        start: nameToken.start,
        end: nameToken.end,
      };
    }
    const typeParameters = this.parseTypeParameters();
    let heritage: Expression | null = null;
    if (this.isKeyword("extends")) {
      this.advance();
      heritage = this.parseHeritageExpression();
    }
    const implemented: TypeReference[] = [];
    if (this.isIdentifier("implements")) {
      this.advance();
      for (;;) {
        implemented.push(this.parseTypeReference());
        if (!this.matchPunct(",")) {
          break;
        }
      }
    }
    this.expectPunct("{");
    const members = this.parseClassMemberList();
    const close = this.expectPunct("}");
    const expression: ClassExpression = {
      kind: "ClassExpression",
      name,
      typeParameters,
      extends: heritage,
      implements: implemented,
      members,
      start,
      end: close.end,
    };
    if (isAbstract) {
      expression.abstract = true;
    }
    return expression;
  }

  private parseHeritageExpression(): Expression {
    const expression = this.parseLeftHandSideExpression();
    if (!this.isPunct("<")) {
      return expression;
    }
    const parsed = this.parseTypeArguments();
    if (parsed === null) {
      return expression;
    }
    return {
      kind: "ExpressionWithTypeArguments",
      expression,
      typeArguments: parsed.types,
      start: expression.start,
      end: parsed.end,
    };
  }

  private parseClassMemberList(): ClassMember[] {
    const members: ClassMember[] = [];
    for (;;) {
      if (this.isPunct("}")) {
        break;
      }
      members.push(this.parseClassMember());
      if (this.isPunct(";")) {
        this.advance();
        continue;
      }
      if (this.isPunct("}")) {
        break;
      }
      if (!this.canStartClassMember()) {
        throw this.unexpected(this.current());
      }
    }
    return members;
  }

  private parseClassMember(): ClassMember {
    let decorators: Expression[] | null = null;
    let start = this.current().start;
    if (this.isPunct("@")) {
      const parsed = this.parseDecorators();
      decorators = parsed.decorators;
      start = parsed.start;
    }
    const modifiers = this.parseClassMemberModifiers();
    const token = this.current();
    let member: ClassMember;
    if (modifiers.isStatic && this.isPunct("{")) {
      const block = this.parseBlockStatement();
      member = { kind: "StaticBlock", body: block, start, end: block.end };
    } else if (
      modifiers.accessor === null &&
      !modifiers.isGenerator &&
      !modifiers.isAsync &&
      !modifiers.isStatic &&
      token.kind === "identifier" &&
      token.value === "constructor" &&
      this.isPunctAhead("(")
    ) {
      member = this.parseConstructorDeclaration(start, modifiers.accessibility);
    } else if (token.kind === "punctuator" && token.text === "[") {
      const indexSignature = this.tryParseIndexSignature(start, modifiers.isReadonly);
      if (indexSignature !== null) {
        member = indexSignature;
      } else {
        const open = this.advance();
        const expression = this.parseExpression();
        const close = this.expectPunct("]");
        const name: ComputedPropertyName = {
          kind: "ComputedPropertyName",
          expression,
          start: open.start,
          end: close.end,
        };
        member = this.parseNamedClassMember(name, start, modifiers);
      }
    } else {
      const name = this.parseMemberName();
      member = this.parseNamedClassMember(name, start, modifiers);
    }
    if (decorators !== null && member.kind !== "StaticBlock") {
      member.decorators = decorators;
    }
    return member;
  }

  private parseClassMemberModifiers(): ClassMemberModifiers {
    let accessibility: "public" | "private" | "protected" | null = null;
    let isStatic = false;
    let isReadonly = false;
    let isAbstract = false;
    let isDeclare = false;
    let isOverride = false;
    let isAsync = false;
    let isGenerator = false;
    let accessor: "get" | "set" | null = null;
    for (;;) {
      const token = this.current();
      if (token.kind === "punctuator") {
        if (token.text === "*" && this.isMemberNameStartToken(this.peek())) {
          isGenerator = true;
          this.advance();
          continue;
        }
        break;
      }
      if (token.kind !== "identifier" && token.kind !== "keyword") {
        break;
      }
      if (!classModifierNames.has(token.value)) {
        break;
      }
      if (
        token.value === "static" &&
        this.peek().kind === "punctuator" &&
        this.peek().text === "{"
      ) {
        isStatic = true;
        this.advance();
        continue;
      }
      if (token.value === "get" || token.value === "set") {
        if (!this.isMemberNameStartToken(this.peek())) {
          break;
        }
      } else if (!this.isMemberStartToken(this.peek())) {
        break;
      }
      if (token.value === "public" || token.value === "private" || token.value === "protected") {
        accessibility = token.value;
      } else if (token.value === "static") {
        isStatic = true;
      } else if (token.value === "readonly") {
        isReadonly = true;
      } else if (token.value === "abstract") {
        isAbstract = true;
      } else if (token.value === "declare") {
        isDeclare = true;
      } else if (token.value === "override") {
        isOverride = true;
      } else if (token.value === "async") {
        isAsync = true;
      } else if (token.value === "get") {
        accessor = "get";
      } else if (token.value === "set") {
        accessor = "set";
      }
      this.advance();
    }
    return {
      accessibility,
      isStatic,
      isReadonly,
      isAbstract,
      isDeclare,
      isOverride,
      isAsync,
      isGenerator,
      accessor,
    };
  }

  private parseNamedClassMember(
    name: MemberName,
    start: number,
    modifiers: ClassMemberModifiers,
  ): ClassMember {
    let optional = false;
    let definite = false;
    let end = name.end;
    if (this.isPunct("?")) {
      end = this.advance().end;
      optional = true;
    }
    if (this.isPunct("!")) {
      end = this.advance().end;
      definite = true;
    }
    if (this.isPunct("(") || this.isPunct("<")) {
      const typeParameters = this.parseTypeParameters();
      const list = this.parseParameterList();
      let returnType: ReturnTypeNode | null = null;
      let methodEnd = list.end;
      if (this.matchPunct(":")) {
        returnType = this.parseReturnType();
        methodEnd = returnType.end;
      }
      let body: BlockStatement | null = null;
      if (this.isPunct("{")) {
        body = this.parseBlockStatement();
        methodEnd = body.end;
      }
      const method: MethodDeclaration = {
        kind: "MethodDeclaration",
        name,
        typeParameters,
        parameters: list.parameters,
        returnType,
        body,
        static: modifiers.isStatic,
        readonly: modifiers.isReadonly,
        optional,
        accessibility: modifiers.accessibility,
        abstract: modifiers.isAbstract,
        override: modifiers.isOverride,
        start,
        end: methodEnd,
      };
      if (modifiers.isAsync) {
        method.async = true;
      }
      if (modifiers.isGenerator) {
        method.generator = true;
      }
      if (modifiers.accessor !== null) {
        method.accessor = modifiers.accessor;
      }
      return method;
    }
    let type: Type | null = null;
    if (this.matchPunct(":")) {
      type = this.parseAnnotationType();
      end = type.end;
    }
    let initializer: Expression | null = null;
    if (this.matchPunct("=")) {
      initializer = this.parseAssignmentExpression();
      end = initializer.end;
    }
    return {
      kind: "PropertyDeclaration",
      name,
      type,
      initializer,
      static: modifiers.isStatic,
      readonly: modifiers.isReadonly,
      optional,
      definite,
      accessibility: modifiers.accessibility,
      abstract: modifiers.isAbstract,
      declare: modifiers.isDeclare,
      override: modifiers.isOverride,
      start,
      end,
    };
  }

  private parseConstructorDeclaration(
    start: number,
    accessibility: "public" | "private" | "protected" | null,
  ): ConstructorDeclaration {
    this.advance();
    const list = this.parseParameterList();
    let body: BlockStatement | null = null;
    let end = list.end;
    if (this.isPunct("{")) {
      body = this.parseBlockStatement();
      end = body.end;
    }
    return {
      kind: "ConstructorDeclaration",
      parameters: list.parameters,
      body,
      accessibility,
      start,
      end,
    };
  }

  private canStartClassMember(): boolean {
    const token = this.current();
    if (
      token.kind === "identifier" ||
      token.kind === "keyword" ||
      token.kind === "string" ||
      token.kind === "number"
    ) {
      return true;
    }
    return (
      token.kind === "punctuator" &&
      (token.text === "[" || token.text === "*" || token.text === "@" || token.text === "#")
    );
  }

  private isMemberStartToken(token: Token): boolean {
    if (this.isMemberNameStartToken(token) || this.isModifierToken(token)) {
      return true;
    }
    return token.kind === "punctuator" && token.text === "*";
  }

  private isMemberNameStartToken(token: Token): boolean {
    if (
      token.kind === "identifier" ||
      token.kind === "keyword" ||
      token.kind === "string" ||
      token.kind === "number"
    ) {
      return true;
    }
    return token.kind === "punctuator" && (token.text === "[" || token.text === "#");
  }

  private isModifierToken(token: Token): boolean {
    if (token.kind !== "identifier" && token.kind !== "keyword") {
      return false;
    }
    return classModifierNames.has(token.value);
  }

  private parseParenthesizedTest(): Expression {
    this.expectPunct("(");
    const test = this.parseExpression();
    this.expectPunct(")");
    return test;
  }

  private consumeSemicolon(): Token | null {
    const token = this.current();
    if (token.kind === "punctuator" && token.text === ";") {
      return this.advance();
    }
    if (
      token.kind === "eof" ||
      (token.kind === "punctuator" && token.text === "}") ||
      token.line > this.lastConsumedLine
    ) {
      return null;
    }
    throw this.errorAt(token, "expected ;");
  }

  private parseUnionType(): Type {
    const first = this.parseIntersectionType();
    let last = first;
    if (!this.isPunct("|")) {
      return first;
    }
    const types: Type[] = [first];
    while (this.matchPunct("|")) {
      last = this.parseIntersectionType();
      types.push(last);
    }
    return { kind: "UnionType", types, start: first.start, end: last.end };
  }

  private parseIntersectionType(): Type {
    const first = this.parsePrefixType();
    let last = first;
    if (!this.isPunct("&")) {
      return first;
    }
    const types: Type[] = [first];
    while (this.matchPunct("&")) {
      last = this.parsePrefixType();
      types.push(last);
    }
    return { kind: "IntersectionType", types, start: first.start, end: last.end };
  }

  private parsePrefixType(): Type {
    const token = this.current();
    if (
      (token.kind === "identifier" || token.kind === "keyword") &&
      typeOperatorNames.has(token.value)
    ) {
      this.advance();
      if (token.value === "typeof") {
        const operand = this.parseTypeQueryOperand();
        return {
          kind: "TypeOperator",
          operator: "typeof",
          type: operand,
          start: token.start,
          end: operand.end,
        };
      }
      const operand = this.parsePrefixType();
      return {
        kind: "TypeOperator",
        operator: token.value as TypeOperator["operator"],
        type: operand,
        start: token.start,
        end: operand.end,
      };
    }
    return this.parsePostfixType(this.parsePrimaryType());
  }

  private parsePrimaryType(): Type {
    const token = this.current();
    if (token.kind === "keyword" && token.value === "new") {
      return this.parseConstructorType();
    }
    if (token.kind === "identifier" || token.kind === "keyword") {
      if (token.kind === "identifier" && token.value === "infer") {
        return this.parseInferType();
      }
      if (token.kind === "keyword" && token.value === "import" && this.isPunctAhead("(")) {
        return this.parseImportType();
      }
      if (
        token.kind === "identifier" &&
        token.value === "abstract" &&
        this.isConstructorTypeStartAfterAbstract()
      ) {
        return this.parseConstructorType();
      }
      if (keywordTypeNames.has(token.value)) {
        this.advance();
        return {
          kind: "KeywordType",
          name: token.value as KeywordType["name"],
          start: token.start,
          end: token.end,
        };
      }
      if (token.kind === "keyword" && token.value === "this") {
        this.advance();
        return { kind: "ThisType", start: token.start, end: token.end };
      }
      if (token.kind === "keyword" && (token.value === "true" || token.value === "false")) {
        this.advance();
        return {
          kind: "LiteralType",
          literal: token.value === "true",
          start: token.start,
          end: token.end,
        };
      }
      if (token.kind === "identifier") {
        return this.parseTypeReference();
      }
    }
    switch (token.kind) {
      case "string":
        this.advance();
        return {
          kind: "LiteralType",
          literal: token.value,
          start: token.start,
          end: token.end,
        };
      case "number":
        this.advance();
        return {
          kind: "LiteralType",
          literal: Number(token.value),
          start: token.start,
          end: token.end,
        };
      case "bigint":
        this.advance();
        return {
          kind: "LiteralType",
          literal: { value: token.value, raw: token.text },
          start: token.start,
          end: token.end,
        };
      case "no-substitution-template":
        this.advance();
        return {
          kind: "TemplateLiteralType",
          quasis: [token.text.slice(1, -1)],
          types: [],
          start: token.start,
          end: token.end,
        };
      case "template-head":
        return this.parseTemplateLiteralType(token);
      case "punctuator":
        if (token.text === "(") {
          return this.parseParenthesizedOrFunctionType();
        }
        if (token.text === "<") {
          return this.parseFunctionType();
        }
        if (token.text === "[") {
          return this.parseTupleType();
        }
        if (token.text === "{") {
          return this.parseTypeLiteral();
        }
        throw this.unexpected(token);
      default:
        throw this.unexpected(token);
    }
  }

  private parseParenthesizedOrFunctionType(): Type {
    if (this.isFunctionTypeStart()) {
      return this.parseFunctionType();
    }
    const open = this.expectPunct("(");
    const inner = this.parseType();
    const close = this.expectPunct(")");
    return { kind: "ParenthesizedType", type: inner, start: open.start, end: close.end };
  }

  private parseFunctionType(): FunctionType {
    const start = this.current().start;
    const typeParameters = this.parseTypeParameters();
    const list = this.parseParameterList();
    this.expectPunct("=>");
    const returnType = this.parseReturnType();
    return {
      kind: "FunctionType",
      typeParameters,
      parameters: list.parameters,
      returnType,
      start,
      end: returnType.end,
    };
  }

  private parseConstructorType(): ConstructorType {
    const token = this.current();
    const start = token.start;
    let abstract = false;
    if (token.kind === "identifier" && token.value === "abstract") {
      abstract = true;
      this.advance();
    }
    this.expectKeyword("new");
    const typeParameters = this.parseTypeParameters();
    const list = this.parseParameterList();
    this.expectPunct("=>");
    const returnType = this.parseReturnType();
    return {
      kind: "ConstructorType",
      abstract,
      typeParameters,
      parameters: list.parameters,
      returnType,
      start,
      end: returnType.end,
    };
  }

  private isFunctionTypeStart(): boolean {
    const next = this.peek();
    if (next.kind === "punctuator") {
      return next.text === ")";
    }
    if (next.kind !== "identifier" && next.kind !== "keyword") {
      return false;
    }
    const after = this.peek2();
    if (after.kind !== "punctuator") {
      return false;
    }
    return after.text === ":" || after.text === "?" || after.text === "," || after.text === "...";
  }

  private isConstructorTypeStartAfterAbstract(): boolean {
    const next = this.peek();
    if (next.kind === "keyword") {
      return next.value === "new";
    }
    return next.kind === "punctuator" && (next.text === "(" || next.text === "<");
  }

  private parsePostfixType(type: Type): Type {
    let result = type;
    for (;;) {
      if (!this.isPunct("[")) {
        return result;
      }
      this.advance();
      if (this.isPunct("]")) {
        const close = this.advance();
        result = {
          kind: "ArrayType",
          elementType: result,
          start: result.start,
          end: close.end,
        };
        continue;
      }
      const indexType = this.parseType();
      const close = this.expectPunct("]");
      result = {
        kind: "IndexedAccessType",
        objectType: result,
        indexType,
        start: result.start,
        end: close.end,
      };
    }
  }

  private parseTypeReference(): TypeReference {
    const name = this.parseQualifiedName();
    const args = this.parseTypeArguments();
    if (args === null) {
      return {
        kind: "TypeReference",
        name: name.name,
        typeArguments: null,
        start: name.start,
        end: name.end,
      };
    }
    return {
      kind: "TypeReference",
      name: name.name,
      typeArguments: args.types,
      start: name.start,
      end: args.end,
    };
  }

  private parseTypeQueryOperand(): TypeReference {
    const name = this.parseQualifiedName();
    return {
      kind: "TypeReference",
      name: name.name,
      typeArguments: null,
      start: name.start,
      end: name.end,
    };
  }

  private parseInferType(): InferType {
    const keyword = this.advance();
    const nameToken = this.current();
    if (nameToken.kind !== "identifier") {
      throw this.unexpected(nameToken);
    }
    this.advance();
    const name: Identifier = {
      kind: "Identifier",
      name: nameToken.value,
      start: nameToken.start,
      end: nameToken.end,
    };
    let end = nameToken.end;
    let constraint: Type | null = null;
    if (this.isKeyword("extends")) {
      this.advance();
      constraint = this.parseUnionType();
      end = constraint.end;
    }
    return { kind: "InferType", name, constraint, start: keyword.start, end };
  }

  private parseImportType(): ImportType {
    const keyword = this.expectKeyword("import");
    this.expectPunct("(");
    const source = this.current();
    if (source.kind !== "string") {
      throw this.unexpected(source);
    }
    this.advance();
    const close = this.expectPunct(")");
    let end = close.end;
    let qualifier: string | null = null;
    if (this.isPunct(".")) {
      this.advance();
      const name = this.parseQualifiedName();
      qualifier = name.name;
      end = name.end;
    }
    const args = this.parseTypeArguments();
    if (args !== null) {
      end = args.end;
    }
    return {
      kind: "ImportType",
      argument: source.value,
      qualifier,
      typeArguments: args === null ? null : args.types,
      start: keyword.start,
      end,
    };
  }

  private parseQualifiedName(): { name: string; start: number; end: number } {
    const first = this.current();
    if (first.kind !== "identifier") {
      throw this.unexpected(first);
    }
    this.advance();
    let name = first.value;
    let end = first.end;
    while (this.isPunct(".")) {
      this.advance();
      const part = this.current();
      if (part.kind !== "identifier" && part.kind !== "keyword") {
        throw this.unexpected(part);
      }
      this.advance();
      name += `.${part.value}`;
      end = part.end;
    }
    return { name, start: first.start, end };
  }

  private parseTypeArguments(): { types: Type[]; end: number } | null {
    if (!this.isPunct("<")) {
      return null;
    }
    this.advance();
    const types: Type[] = [];
    for (;;) {
      types.push(this.parseType());
      if (!this.matchPunct(",")) {
        break;
      }
      if (this.isGreaterThanToken()) {
        break;
      }
    }
    const close = this.expectGreaterThan();
    return { types, end: close.end };
  }

  private tryParseTypeArguments(): Type[] | null {
    if (!this.isPunct("<")) {
      return null;
    }
    const checkpoint = this.save();
    try {
      const parsed = this.parseTypeArguments();
      if (parsed !== null && this.isPunct("(")) {
        return parsed.types;
      }
    } catch (error) {
      if (!(error instanceof ParseError)) {
        throw error;
      }
    }
    this.restore(checkpoint);
    return null;
  }

  private isTupleElementName(): boolean {
    const next = this.peek();
    if (next.kind === "punctuator" && next.text === ":") {
      return true;
    }
    if (next.kind === "punctuator" && next.text === "?") {
      const after = this.peek2();
      return after.kind === "punctuator" && after.text === ":";
    }
    return false;
  }

  private parseTupleType(): TupleType {
    const open = this.expectPunct("[");
    const elements: TupleElement[] = [];
    for (;;) {
      if (this.isPunct("]")) {
        break;
      }
      let rest = false;
      let start = this.current().start;
      if (this.isPunct("...")) {
        start = this.advance().start;
        rest = true;
      }
      let name: Identifier | null = null;
      const nameToken = this.current();
      if (nameToken.kind === "identifier" && this.isTupleElementName()) {
        this.advance();
        name = {
          kind: "Identifier",
          name: nameToken.value,
          start: nameToken.start,
          end: nameToken.end,
        };
      }
      let optional = false;
      if (name !== null && this.isPunct("?")) {
        this.advance();
        optional = true;
      }
      if (name !== null) {
        this.expectPunct(":");
      }
      const elementType = this.parseAnnotationType();
      let end = elementType.end;
      if (this.isPunct("?")) {
        end = this.advance().end;
        optional = true;
      }
      const element: TupleElement = {
        kind: "TupleElement",
        elementType,
        optional,
        rest,
        start,
        end,
      };
      if (name !== null) {
        element.name = name;
      }
      elements.push(element);
      if (!this.matchPunct(",")) {
        break;
      }
    }
    const close = this.expectPunct("]");
    return { kind: "TupleType", elements, start: open.start, end: close.end };
  }

  private parseParameterList(): { parameters: Parameter[]; end: number } {
    this.expectPunct("(");
    const parameters: Parameter[] = [];
    if (!this.isPunct(")")) {
      for (;;) {
        parameters.push(this.parseParameter());
        if (!this.matchPunct(",")) {
          break;
        }
        if (this.isPunct(")")) {
          break;
        }
      }
    }
    const close = this.expectPunct(")");
    return { parameters, end: close.end };
  }

  private parseParameter(): Parameter {
    let decorators: Expression[] | null = null;
    let start = this.current().start;
    if (this.isPunct("@")) {
      const parsed = this.parseDecorators();
      decorators = parsed.decorators;
      start = parsed.start;
    }
    let accessibility: "public" | "private" | "protected" | null = null;
    let readonly = false;
    let override = false;
    for (;;) {
      const modifier = this.current();
      if (modifier.kind !== "identifier") {
        break;
      }
      if (
        modifier.value === "public" ||
        modifier.value === "private" ||
        modifier.value === "protected"
      ) {
        if (!this.parameterModifierFollows()) {
          break;
        }
        accessibility = modifier.value;
        this.advance();
        continue;
      }
      if (modifier.value === "readonly" || modifier.value === "override") {
        if (!this.parameterModifierFollows()) {
          break;
        }
        if (modifier.value === "readonly") {
          readonly = true;
        } else {
          override = true;
        }
        this.advance();
        continue;
      }
      break;
    }
    let rest = false;
    if (this.isPunct("...")) {
      const spread = this.advance();
      if (decorators === null) {
        start = spread.start;
      }
      rest = true;
    }
    const nameToken = this.current();
    let name: BindingName;
    if (nameToken.kind === "keyword" && nameToken.value === "this") {
      this.advance();
      name = { kind: "Identifier", name: "this", start: nameToken.start, end: nameToken.end };
    } else {
      name = this.parseBindingName();
    }
    let end = name.end;
    let optional = false;
    if (this.isPunct("?")) {
      end = this.advance().end;
      optional = true;
    }
    let type: Type | null = null;
    if (this.matchPunct(":")) {
      type = this.parseAnnotationType();
      end = type.end;
    }
    let initializer: Expression | null = null;
    if (this.isPunct("=")) {
      if (rest) {
        throw this.errorAt(this.current(), "rest parameter may not have an initializer");
      }
      this.advance();
      initializer = this.parseAssignmentExpression();
      end = initializer.end;
    }
    const parameter: Parameter = {
      kind: "Parameter",
      name,
      optional,
      rest,
      type,
      initializer,
      start,
      end,
    };
    if (decorators !== null) {
      parameter.decorators = decorators;
    }
    if (accessibility !== null) {
      parameter.accessibility = accessibility;
    }
    if (readonly) {
      parameter.readonly = true;
    }
    if (override) {
      parameter.override = true;
    }
    return parameter;
  }

  private parameterModifierFollows(): boolean {
    const next = this.peek();
    if (next.kind === "identifier") {
      return true;
    }
    return (
      next.kind === "punctuator" && (next.text === "{" || next.text === "[" || next.text === "...")
    );
  }

  private parseArrayPattern(): ArrayPattern {
    const open = this.expectPunct("[");
    const elements: Array<BindingElement | null> = [];
    for (;;) {
      if (this.isPunct("]")) {
        break;
      }
      if (this.isPunct(",")) {
        this.advance();
        elements.push(null);
        continue;
      }
      if (this.isPunct("...")) {
        const spread = this.advance();
        const binding = this.parseBindingName();
        elements.push({
          kind: "BindingElement",
          key: null,
          binding,
          default: null,
          rest: true,
          computed: false,
          start: spread.start,
          end: binding.end,
        });
      } else {
        const binding = this.parseBindingName();
        const defaulted = this.parseBindingDefault(binding.end);
        elements.push({
          kind: "BindingElement",
          key: null,
          binding,
          default: defaulted.value,
          rest: false,
          computed: false,
          start: binding.start,
          end: defaulted.end,
        });
      }
      if (this.isPunct(",")) {
        this.advance();
        continue;
      }
      if (this.isPunct("]")) {
        break;
      }
      throw this.unexpected(this.current());
    }
    const close = this.expectPunct("]");
    return { kind: "ArrayPattern", elements, start: open.start, end: close.end };
  }

  private parseObjectPattern(): ObjectPattern {
    const open = this.expectPunct("{");
    const properties: BindingElement[] = [];
    for (;;) {
      if (this.isPunct("}")) {
        break;
      }
      if (this.isPunct("...")) {
        const spread = this.advance();
        const binding = this.parseBindingName();
        properties.push({
          kind: "BindingElement",
          key: null,
          binding,
          default: null,
          rest: true,
          computed: false,
          start: spread.start,
          end: binding.end,
        });
      } else {
        properties.push(this.parseBindingProperty());
      }
      if (this.isPunct(",")) {
        this.advance();
        continue;
      }
      if (this.isPunct("}")) {
        break;
      }
      throw this.unexpected(this.current());
    }
    const close = this.expectPunct("}");
    return { kind: "ObjectPattern", properties, start: open.start, end: close.end };
  }

  private parseBindingProperty(): BindingElement {
    const token = this.current();
    if (this.isPunct("[")) {
      this.advance();
      const key = this.parseExpression();
      this.expectPunct("]");
      this.expectPunct(":");
      const binding = this.parseBindingName();
      const defaulted = this.parseBindingDefault(binding.end);
      return {
        kind: "BindingElement",
        key,
        binding,
        default: defaulted.value,
        rest: false,
        computed: true,
        start: key.start,
        end: defaulted.end,
      };
    }
    const key = this.parseBindingPropertyKey(token);
    if (this.isPunct(":")) {
      this.advance();
      const binding = this.parseBindingName();
      const defaulted = this.parseBindingDefault(binding.end);
      return {
        kind: "BindingElement",
        key,
        binding,
        default: defaulted.value,
        rest: false,
        computed: false,
        start: key.start,
        end: defaulted.end,
      };
    }
    if (key.kind !== "Identifier") {
      throw this.errorAt(this.current(), 'expected ":"');
    }
    const binding: Identifier = {
      kind: "Identifier",
      name: key.name,
      start: key.start,
      end: key.end,
    };
    const defaulted = this.parseBindingDefault(key.end);
    return {
      kind: "BindingElement",
      key,
      binding,
      default: defaulted.value,
      rest: false,
      computed: false,
      start: key.start,
      end: defaulted.end,
    };
  }

  private parseBindingPropertyKey(token: Token): Expression {
    if (token.kind === "identifier" || token.kind === "keyword") {
      this.advance();
      return { kind: "Identifier", name: token.value, start: token.start, end: token.end };
    }
    if (token.kind === "string") {
      this.advance();
      return {
        kind: "StringLiteral",
        value: token.value,
        raw: token.text,
        start: token.start,
        end: token.end,
      };
    }
    if (token.kind === "number") {
      this.advance();
      return {
        kind: "NumberLiteral",
        value: Number(token.value),
        raw: token.text,
        start: token.start,
        end: token.end,
      };
    }
    throw this.unexpected(token);
  }

  private parseBindingDefault(end: number): { value: Expression | null; end: number } {
    if (!this.matchPunct("=")) {
      return { value: null, end };
    }
    const value = this.parseAssignmentExpression();
    return { value, end: value.end };
  }

  private parseTypeLiteral(): TypeLiteral | MappedType {
    const open = this.expectPunct("{");
    if (this.isMappedTypeStart()) {
      return this.parseMappedType(open);
    }
    const members = this.parseTypeMemberList("}");
    const close = this.expectPunct("}");
    return { kind: "TypeLiteral", members, start: open.start, end: close.end };
  }

  private parseTypeMemberList(terminator: string): TypeMember[] {
    const members: TypeMember[] = [];
    for (;;) {
      if (this.isPunct(terminator)) {
        break;
      }
      members.push(this.parseTypeMember());
      if (this.isPunct(";") || this.isPunct(",")) {
        this.advance();
        continue;
      }
      if (this.isPunct(terminator)) {
        break;
      }
      throw this.unexpected(this.current());
    }
    return members;
  }

  private isMappedTypeStart(): boolean {
    const token = this.current();
    let bracketOffset = 0;
    if (token.kind === "identifier" && token.value === "readonly") {
      bracketOffset = 1;
    } else if (token.kind === "punctuator" && (token.text === "+" || token.text === "-")) {
      const modifier = this.peekAhead(1);
      if (modifier.kind !== "identifier" || modifier.value !== "readonly") {
        return false;
      }
      bracketOffset = 2;
    } else if (!(token.kind === "punctuator" && token.text === "[")) {
      return false;
    }
    const bracket = bracketOffset === 0 ? token : this.peekAhead(bracketOffset);
    if (bracket.kind !== "punctuator" || bracket.text !== "[") {
      return false;
    }
    const key = this.peekAhead(bracketOffset + 1);
    if (key.kind !== "identifier") {
      return false;
    }
    const inToken = this.peekAhead(bracketOffset + 2);
    return inToken.kind === "keyword" && inToken.value === "in";
  }

  private parseMappedType(open: Token): MappedType {
    const leadingReadonly = this.parseReadonlyModifier();
    this.expectPunct("[");
    const keyToken = this.current();
    if (keyToken.kind !== "identifier") {
      throw this.unexpected(keyToken);
    }
    this.advance();
    const keyName: Identifier = {
      kind: "Identifier",
      name: keyToken.value,
      start: keyToken.start,
      end: keyToken.end,
    };
    this.expectKeyword("in");
    const constraint = this.parseType();
    this.expectPunct("]");
    const readonly = leadingReadonly ?? this.parseReadonlyModifier();
    const optional = this.parseOptionalModifier();
    let valueType: Type | null = null;
    if (this.matchPunct(":")) {
      valueType = this.parseType();
    }
    if (this.isPunct(";") || this.isPunct(",")) {
      this.advance();
    }
    const close = this.expectPunct("}");
    return {
      kind: "MappedType",
      keyName,
      constraint,
      readonly,
      optional,
      valueType,
      start: open.start,
      end: close.end,
    };
  }

  private parseReadonlyModifier(): "add" | "remove" | null {
    if (this.isIdentifier("readonly")) {
      this.advance();
      return "add";
    }
    if (this.isPunct("-") && this.isIdentifierAhead("readonly")) {
      this.advance();
      this.advance();
      return "remove";
    }
    if (this.isPunct("+") && this.isIdentifierAhead("readonly")) {
      this.advance();
      this.advance();
      return "add";
    }
    return null;
  }

  private parseOptionalModifier(): "add" | "remove" | null {
    if (this.isPunct("?")) {
      this.advance();
      return "add";
    }
    if (this.isPunct("-") && this.isPunctAhead("?")) {
      this.advance();
      this.advance();
      return "remove";
    }
    if (this.isPunct("+") && this.isPunctAhead("?")) {
      this.advance();
      this.advance();
      return "add";
    }
    return null;
  }

  private parseTypeMember(): TypeMember {
    const first = this.current();
    const start = first.start;
    let readonly = false;
    if (
      first.kind === "identifier" &&
      first.value === "readonly" &&
      this.isReadonlyPrefix()
    ) {
      readonly = true;
      this.advance();
    }
    const token = this.current();
    if (token.kind === "punctuator" && token.text === "(") {
      return this.parseSignatureMember(false, start);
    }
    if (token.kind === "keyword" && token.value === "new" && this.isSignatureStartAfterNew()) {
      this.advance();
      return this.parseSignatureMember(true, start);
    }
    if (token.kind === "punctuator" && token.text === "[") {
      const indexSignature = this.tryParseIndexSignature(start, readonly);
      if (indexSignature !== null) {
        return indexSignature;
      }
      const open = this.advance();
      const expression = this.parseExpression();
      const close = this.expectPunct("]");
      const name: ComputedPropertyName = {
        kind: "ComputedPropertyName",
        expression,
        start: open.start,
        end: close.end,
      };
      return this.parseNamedMember(name, start, readonly);
    }
    const name = this.parseMemberName();
    return this.parseNamedMember(name, start, readonly);
  }

  private tryParseIndexSignature(start: number, readonly: boolean): IndexSignature | null {
    if (!this.isPunct("[")) {
      return null;
    }
    const keyToken = this.peek();
    if (keyToken.kind !== "identifier") {
      return null;
    }
    const colon = this.peek2();
    if (colon.kind !== "punctuator" || colon.text !== ":") {
      return null;
    }
    this.advance();
    this.advance();
    this.advance();
    const keyName: Identifier = {
      kind: "Identifier",
      name: keyToken.value,
      start: keyToken.start,
      end: keyToken.end,
    };
    const keyType = this.parseType();
    this.expectPunct("]");
    this.expectPunct(":");
    const type = this.parseAnnotationType();
    return {
      kind: "IndexSignature",
      readonly,
      keyName,
      keyType,
      type,
      start,
      end: type.end,
    };
  }

  private parseSignatureMember(
    construct: boolean,
    start: number,
  ): CallSignature | ConstructSignature {
    const typeParameters = this.parseTypeParameters();
    const list = this.parseParameterList();
    let returnType: ReturnTypeNode | null = null;
    let end = list.end;
    if (this.matchPunct(":")) {
      returnType = this.parseReturnType();
      end = returnType.end;
    }
    if (construct) {
      return {
        kind: "ConstructSignature",
        typeParameters,
        parameters: list.parameters,
        returnType,
        start,
        end,
      };
    }
    return {
      kind: "CallSignature",
      typeParameters,
      parameters: list.parameters,
      returnType,
      start,
      end,
    };
  }

  private parseNamedMember(name: MemberName, start: number, readonly: boolean): TypeMember {
    let optional = false;
    let end = name.end;
    if (this.isPunct("?")) {
      end = this.advance().end;
      optional = true;
    }
    if (this.isPunct("(") || this.isPunct("<")) {
      const typeParameters = this.parseTypeParameters();
      const list = this.parseParameterList();
      let returnType: ReturnTypeNode | null = null;
      let methodEnd = list.end;
      if (this.matchPunct(":")) {
        returnType = this.parseReturnType();
        methodEnd = returnType.end;
      }
      return {
        kind: "MethodSignature",
        name,
        optional,
        typeParameters,
        parameters: list.parameters,
        returnType,
        start,
        end: methodEnd,
      };
    }
    let type: Type | null = null;
    let propertyEnd = end;
    if (this.matchPunct(":")) {
      type = this.parseAnnotationType();
      propertyEnd = type.end;
    }
    return {
      kind: "PropertySignature",
      name,
      optional,
      readonly,
      type,
      start,
      end: propertyEnd,
    };
  }

  /**
   * Private names (`#x`) are modeled as ordinary Identifiers whose name keeps
   * the leading `#` (e.g. `{ kind: "Identifier", name: "#x" }`). No new node
   * kind is needed: binders, indexers, and renderers already handle
   * identifiers, and `#x` stays distinct from a same-named public `x`.
   */
  private parsePrivateName(): Identifier {
    const hash = this.expectPunct("#");
    const token = this.current();
    if (token.kind !== "identifier") {
      throw this.unexpected(token);
    }
    this.advance();
    return { kind: "Identifier", name: `#${token.value}`, start: hash.start, end: token.end };
  }

  private parseMemberName(): Identifier | StringLiteral | NumberLiteral {
    const token = this.current();
    if (token.kind === "punctuator" && token.text === "#") {
      return this.parsePrivateName();
    }
    if (token.kind === "identifier" || token.kind === "keyword") {
      this.advance();
      return {
        kind: "Identifier",
        name: token.value,
        start: token.start,
        end: token.end,
      };
    }
    if (token.kind === "string") {
      this.advance();
      return {
        kind: "StringLiteral",
        value: token.value,
        raw: token.text,
        start: token.start,
        end: token.end,
      };
    }
    if (token.kind === "number") {
      this.advance();
      return {
        kind: "NumberLiteral",
        value: Number(token.value),
        raw: token.text,
        start: token.start,
        end: token.end,
      };
    }
    throw this.unexpected(token);
  }

  private isReadonlyPrefix(): boolean {
    const next = this.peek();
    if (next.kind !== "punctuator") {
      return true;
    }
    return (
      next.text !== ":" &&
      next.text !== "?" &&
      next.text !== "(" &&
      next.text !== "<" &&
      next.text !== "," &&
      next.text !== ";"
    );
  }

  private isSignatureStartAfterNew(): boolean {
    const next = this.peek();
    return next.kind === "punctuator" && (next.text === "(" || next.text === "<");
  }

  private isKeyword(word: string): boolean {
    const token = this.current();
    return token.kind === "keyword" && token.value === word;
  }

  private isIdentifier(word: string): boolean {
    const token = this.current();
    return token.kind === "identifier" && token.value === word;
  }

  private isGreaterThanToken(): boolean {
    const token = this.current();
    return token.kind === "punctuator" && greaterThanPunctuators.has(token.text);
  }

  private expectGreaterThan(): Token {
    const token = this.current();
    if (token.kind !== "punctuator" || !greaterThanPunctuators.has(token.text)) {
      throw this.errorAt(token, 'expected ">"');
    }
    this.advance();
    const consumed: Token = {
      kind: "punctuator",
      text: ">",
      value: ">",
      start: token.start,
      end: token.start + 1,
      line: token.line,
      column: token.column,
    };
    if (token.text.length > 1) {
      this.adoptToken({
        kind: "punctuator",
        text: token.text.slice(1),
        value: token.text.slice(1),
        start: token.start + 1,
        end: token.end,
        line: token.line,
        column: token.column + 1,
      });
    }
    return consumed;
  }

  private parseConditionalExpression(allowIn = true): Expression {
    const test = this.parseNullishExpression(allowIn);
    if (!this.isPunct("?")) {
      return test;
    }
    this.advance();
    const consequent = this.parseAssignmentExpression(allowIn);
    this.expectPunct(":");
    const alternate = this.parseAssignmentExpression(allowIn);
    return {
      kind: "ConditionalExpression",
      test,
      consequent,
      alternate,
      start: test.start,
      end: alternate.end,
    };
  }

  private parseNullishExpression(allowIn = true): Expression {
    let left = this.parseLogicalOrExpression(allowIn);
    while (this.isPunct("??")) {
      this.advance();
      const right = this.parseLogicalOrExpression(allowIn);
      left = {
        kind: "LogicalExpression",
        operator: "??",
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseLogicalOrExpression(allowIn = true): Expression {
    let left = this.parseLogicalAndExpression(allowIn);
    while (this.isPunct("||")) {
      this.advance();
      const right = this.parseLogicalAndExpression(allowIn);
      left = {
        kind: "LogicalExpression",
        operator: "||",
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseLogicalAndExpression(allowIn = true): Expression {
    let left = this.parseBitwiseOrExpression(allowIn);
    while (this.isPunct("&&")) {
      this.advance();
      const right = this.parseBitwiseOrExpression(allowIn);
      left = {
        kind: "LogicalExpression",
        operator: "&&",
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseBitwiseOrExpression(allowIn = true): Expression {
    let left = this.parseBitwiseXorExpression(allowIn);
    while (this.isPunct("|")) {
      this.advance();
      const right = this.parseBitwiseXorExpression(allowIn);
      left = {
        kind: "BinaryExpression",
        operator: "|",
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseBitwiseXorExpression(allowIn = true): Expression {
    let left = this.parseBitwiseAndExpression(allowIn);
    while (this.isPunct("^")) {
      this.advance();
      const right = this.parseBitwiseAndExpression(allowIn);
      left = {
        kind: "BinaryExpression",
        operator: "^",
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseBitwiseAndExpression(allowIn = true): Expression {
    let left = this.parseEqualityExpression(allowIn);
    while (this.isPunct("&")) {
      this.advance();
      const right = this.parseEqualityExpression(allowIn);
      left = {
        kind: "BinaryExpression",
        operator: "&",
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseEqualityExpression(allowIn = true): Expression {
    let left = this.parseRelationalExpression(allowIn);
    for (;;) {
      const operator = this.matchPunctuator(equalityOperators);
      if (operator === undefined) {
        return left;
      }
      const right = this.parseRelationalExpression(allowIn);
      left = {
        kind: "BinaryExpression",
        operator: operator.text,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
  }

  private parseRelationalExpression(allowIn = true): Expression {
    let left = this.parseShiftExpression();
    for (;;) {
      const token = this.current();
      if (token.kind === "identifier" && (token.value === "as" || token.value === "satisfies")) {
        const operator: "as" | "satisfies" = token.value === "as" ? "as" : "satisfies";
        this.advance();
        let type: Type | ConstType;
        let end: number;
        if (operator === "as" && this.isKeyword("const")) {
          const constToken = this.advance();
          type = { kind: "ConstType", start: constToken.start, end: constToken.end };
          end = constToken.end;
        } else {
          type = this.parseType();
          end = type.end;
        }
        left = { kind: "AsExpression", expression: left, operator, type, start: left.start, end };
        continue;
      }
      const isPunctuatorOperator =
        token.kind === "punctuator" && relationalPunctuatorOperators.has(token.text);
      const isKeywordOperator =
        token.kind === "keyword" &&
        relationalKeywordOperators.has(token.value) &&
        (allowIn || token.value !== "in");
      if (!isPunctuatorOperator && !isKeywordOperator) {
        return left;
      }
      this.advance();
      const right = this.parseShiftExpression();
      left = {
        kind: "BinaryExpression",
        operator: token.text,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
  }

  private parseShiftExpression(): Expression {
    let left = this.parseAdditiveExpression();
    for (;;) {
      const operator = this.matchPunctuator(shiftOperators);
      if (operator === undefined) {
        return left;
      }
      const right = this.parseAdditiveExpression();
      left = {
        kind: "BinaryExpression",
        operator: operator.text,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
  }

  private parseAdditiveExpression(): Expression {
    let left = this.parseMultiplicativeExpression();
    for (;;) {
      const operator = this.matchPunctuator(additiveOperators);
      if (operator === undefined) {
        return left;
      }
      const right = this.parseMultiplicativeExpression();
      left = {
        kind: "BinaryExpression",
        operator: operator.text,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
  }

  private parseMultiplicativeExpression(): Expression {
    let left = this.parseExponentiationExpression();
    for (;;) {
      const operator = this.matchPunctuator(multiplicativeOperators);
      if (operator === undefined) {
        return left;
      }
      const right = this.parseExponentiationExpression();
      left = {
        kind: "BinaryExpression",
        operator: operator.text,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
  }

  private parseExponentiationExpression(): Expression {
    const left = this.parseUnaryExpression();
    if (!this.isPunct("**")) {
      return left;
    }
    this.advance();
    const right = this.parseExponentiationExpression();
    return {
      kind: "BinaryExpression",
      operator: "**",
      left,
      right,
      start: left.start,
      end: right.end,
    };
  }

  private parseUnaryExpression(): Expression {
    const token = this.current();
    if (this.isPunct("<")) {
      const open = this.advance();
      const type = this.parseType();
      this.expectGreaterThan();
      const operand = this.parseUnaryExpression();
      return {
        kind: "TypeAssertion",
        type,
        expression: operand,
        start: open.start,
        end: operand.end,
      };
    }
    if (this.isUnaryOperator(token)) {
      this.advance();
      if (!this.canStartExpression(this.current())) {
        throw this.unexpected(token);
      }
      const operand = this.parseUnaryExpression();
      return {
        kind: "UnaryExpression",
        operator: token.value,
        operand,
        prefix: true,
        start: token.start,
        end: operand.end,
      };
    }
    return this.parseUpdateExpression();
  }

  private isUnaryOperator(token: Token): boolean {
    if (token.kind === "punctuator") {
      return unaryPunctuatorOperators.has(token.text);
    }
    if (token.kind === "keyword") {
      return unaryKeywordOperators.has(token.value);
    }
    return token.kind === "identifier" && token.value === "await";
  }

  private canStartExpression(token: Token): boolean {
    switch (token.kind) {
      case "identifier":
      case "keyword":
      case "number":
      case "bigint":
      case "string":
      case "no-substitution-template":
      case "template-head":
        return true;
      case "punctuator":
        return expressionStartPunctuators.has(token.text);
      default:
        return false;
    }
  }

  private parseUpdateExpression(): Expression {
    const token = this.current();
    if (token.kind === "punctuator" && (token.text === "++" || token.text === "--")) {
      this.advance();
      const operand = this.parseUnaryExpression();
      return {
        kind: "UpdateExpression",
        operator: token.text,
        operand,
        prefix: true,
        start: token.start,
        end: operand.end,
      };
    }
    return this.parsePostfixExpression();
  }

  private parsePostfixExpression(): Expression {
    let expression = this.parseLeftHandSideExpression();
    for (;;) {
      if (this.isPunct("!")) {
        const bang = this.advance();
        expression = {
          kind: "NonNullExpression",
          expression,
          start: expression.start,
          end: bang.end,
        };
        continue;
      }
      const token = this.current();
      if (token.kind === "punctuator" && (token.text === "++" || token.text === "--")) {
        this.advance();
        return {
          kind: "UpdateExpression",
          operator: token.text,
          operand: expression,
          prefix: false,
          start: expression.start,
          end: token.end,
        };
      }
      return expression;
    }
  }

  private parseLeftHandSideExpression(): Expression {
    return this.parseLeftHandSideContinuation(this.parsePrimaryExpression(), true);
  }

  private parseLeftHandSideContinuation(expression: Expression, allowCalls: boolean): Expression {
    let result = expression;
    for (;;) {
      if (this.isPunct("!")) {
        const bang = this.advance();
        result = {
          kind: "NonNullExpression",
          expression: result,
          start: result.start,
          end: bang.end,
        };
        continue;
      }
      if (this.isPunct(".")) {
        this.advance();
        const property = this.parseMemberProperty();
        result = {
          kind: "MemberExpression",
          object: result,
          property,
          computed: false,
          optional: false,
          start: result.start,
          end: property.end,
        };
        continue;
      }
      if (this.isPunct("?.")) {
        this.advance();
        const token = this.current();
        if (token.kind === "identifier" || token.kind === "keyword") {
          this.advance();
          const property: Identifier = {
            kind: "Identifier",
            name: token.value,
            start: token.start,
            end: token.end,
          };
          result = {
            kind: "MemberExpression",
            object: result,
            property,
            computed: false,
            optional: true,
            start: result.start,
            end: token.end,
          };
          continue;
        }
        if (token.kind === "punctuator" && token.text === "#") {
          const property = this.parsePrivateName();
          result = {
            kind: "MemberExpression",
            object: result,
            property,
            computed: false,
            optional: true,
            start: result.start,
            end: property.end,
          };
          continue;
        }
        if (this.isPunct("[")) {
          this.advance();
          const property = this.parseExpression();
          const close = this.expectPunct("]");
          result = {
            kind: "MemberExpression",
            object: result,
            property,
            computed: true,
            optional: true,
            start: result.start,
            end: close.end,
          };
          continue;
        }
        if (allowCalls && this.isPunct("(")) {
          const args = this.parseArguments();
          result = {
            kind: "CallExpression",
            callee: result,
            arguments: args.arguments,
            optional: true,
            start: result.start,
            end: args.end,
          };
          continue;
        }
        throw this.unexpected(token);
      }
      if (this.isPunct("[")) {
        this.advance();
        const property = this.parseExpression();
        const close = this.expectPunct("]");
        result = {
          kind: "MemberExpression",
          object: result,
          property,
          computed: true,
          optional: false,
          start: result.start,
          end: close.end,
        };
        continue;
      }
      if (allowCalls) {
        const typeArguments = this.tryParseTypeArguments();
        if (this.isPunct("(")) {
          const args = this.parseArguments();
          const call: CallExpression = {
            kind: "CallExpression",
            callee: result,
            arguments: args.arguments,
            optional: false,
            start: result.start,
            end: args.end,
          };
          if (typeArguments !== null) {
            call.typeArguments = typeArguments;
          }
          result = call;
          continue;
        }
      }
      const token = this.current();
      if (token.kind === "no-substitution-template" || token.kind === "template-head") {
        const quasi = this.parseTemplateLiteral(token);
        result = {
          kind: "TaggedTemplateExpression",
          tag: result,
          quasi,
          start: result.start,
          end: quasi.end,
        };
        continue;
      }
      return result;
    }
  }

  private parseMemberProperty(): Identifier {
    const token = this.current();
    if (token.kind === "punctuator" && token.text === "#") {
      return this.parsePrivateName();
    }
    if (token.kind !== "identifier" && token.kind !== "keyword") {
      throw this.unexpected(token);
    }
    this.advance();
    return { kind: "Identifier", name: token.value, start: token.start, end: token.end };
  }

  private parseArguments(): { arguments: Array<Expression | SpreadElement>; end: number } {
    this.expectPunct("(");
    const args: Array<Expression | SpreadElement> = [];
    if (this.isPunct(")")) {
      const close = this.expectPunct(")");
      return { arguments: args, end: close.end };
    }
    for (;;) {
      if (this.isPunct("...")) {
        const spread = this.advance();
        const argument = this.parseAssignmentExpression();
        args.push({ kind: "SpreadElement", argument, start: spread.start, end: argument.end });
      } else {
        args.push(this.parseAssignmentExpression());
      }
      if (!this.matchPunct(",")) {
        break;
      }
      if (this.isPunct(")")) {
        break;
      }
    }
    const close = this.expectPunct(")");
    return { arguments: args, end: close.end };
  }

  private parseNewExpression(): Expression {
    const keyword = this.expectKeyword("new");
    const callee = this.parseLeftHandSideContinuation(this.parsePrimaryExpression(), false);
    const typeArguments = this.tryParseTypeArguments();
    if (this.isPunct("(")) {
      const args = this.parseArguments();
      const expression: NewExpression = {
        kind: "NewExpression",
        callee,
        arguments: args.arguments,
        start: keyword.start,
        end: args.end,
      };
      if (typeArguments !== null) {
        expression.typeArguments = typeArguments;
      }
      return expression;
    }
    return { kind: "NewExpression", callee, arguments: [], start: keyword.start, end: callee.end };
  }

  private parseYieldExpression(): Expression {
    const keyword = this.advance();
    let delegate = false;
    if (this.isPunct("*")) {
      this.advance();
      delegate = true;
    }
    if (!this.canStartExpression(this.current())) {
      return {
        kind: "YieldExpression",
        argument: null,
        delegate,
        start: keyword.start,
        end: keyword.end,
      };
    }
    const argument = this.parseAssignmentExpression();
    return {
      kind: "YieldExpression",
      argument,
      delegate,
      start: keyword.start,
      end: argument.end,
    };
  }

  private parsePrimaryExpression(): Expression {
    const token = this.current();
    switch (token.kind) {
      case "identifier":
        this.advance();
        return { kind: "Identifier", name: token.value, start: token.start, end: token.end };
      case "keyword":
        return this.parseKeywordExpression(token);
      case "number":
        this.advance();
        return {
          kind: "NumberLiteral",
          value: Number(token.value),
          raw: token.text,
          start: token.start,
          end: token.end,
        };
      case "bigint":
        this.advance();
        return {
          kind: "BigIntLiteral",
          value: token.value,
          raw: token.text,
          start: token.start,
          end: token.end,
        };
      case "string":
        this.advance();
        return {
          kind: "StringLiteral",
          value: token.value,
          raw: token.text,
          start: token.start,
          end: token.end,
        };
      case "no-substitution-template":
      case "template-head":
        return this.parseTemplateLiteral(token);
      case "punctuator":
        if (token.text === "(") {
          return this.parseParenthesizedExpression();
        }
        if (token.text === "[") {
          return this.parseArrayLiteral();
        }
        if (token.text === "{") {
          return this.parseObjectLiteral();
        }
        if (token.text === "/" || token.text === "/=") {
          return this.parseRegexLiteral();
        }
        throw this.unexpected(token);
      default:
        throw this.unexpected(token);
    }
  }

  private parseKeywordExpression(token: Token): Expression {
    switch (token.value) {
      case "this":
        this.advance();
        return { kind: "ThisExpression", start: token.start, end: token.end };
      case "super":
        this.advance();
        return { kind: "SuperExpression", start: token.start, end: token.end };
      case "true":
      case "false":
        this.advance();
        return {
          kind: "BooleanLiteral",
          value: token.value === "true",
          start: token.start,
          end: token.end,
        };
      case "null":
        this.advance();
        return { kind: "NullLiteral", start: token.start, end: token.end };
      case "function":
        return this.parseFunctionExpression(false);
      case "class":
        return this.parseClassExpression(false);
      case "new":
        return this.parseNewExpression();
      case "import": {
        this.advance();
        if (this.isPunct(".")) {
          this.advance();
          const propertyToken = this.current();
          if (
            (propertyToken.kind !== "identifier" && propertyToken.kind !== "keyword") ||
            propertyToken.value !== "meta"
          ) {
            throw this.unexpected(propertyToken);
          }
          this.advance();
          const meta: Identifier = {
            kind: "Identifier",
            name: "import",
            start: token.start,
            end: token.end,
          };
          const property: Identifier = {
            kind: "Identifier",
            name: propertyToken.value,
            start: propertyToken.start,
            end: propertyToken.end,
          };
          return {
            kind: "MetaProperty",
            meta,
            property,
            start: token.start,
            end: propertyToken.end,
          };
        }
        this.expectPunct("(");
        const source = this.parseExpression();
        const close = this.expectPunct(")");
        return { kind: "ImportExpression", source, start: token.start, end: close.end };
      }
      default:
        throw this.unexpected(token);
    }
  }

  private parseParenthesizedExpression(): ParenthesizedExpression {
    const open = this.expectPunct("(");
    const expression = this.parseExpression();
    const close = this.expectPunct(")");
    return { kind: "ParenthesizedExpression", expression, start: open.start, end: close.end };
  }

  private parseArrayLiteral(): ArrayLiteral {
    const open = this.expectPunct("[");
    const elements: Array<Expression | SpreadElement | null> = [];
    for (;;) {
      if (this.isPunct("]")) {
        break;
      }
      if (this.isPunct(",")) {
        this.advance();
        elements.push(null);
        continue;
      }
      if (this.isPunct("...")) {
        const spread = this.advance();
        const argument = this.parseAssignmentExpression();
        elements.push({ kind: "SpreadElement", argument, start: spread.start, end: argument.end });
      } else {
        elements.push(this.parseAssignmentExpression());
      }
      if (this.isPunct(",")) {
        this.advance();
        continue;
      }
      if (this.isPunct("]")) {
        break;
      }
      throw this.unexpected(this.current());
    }
    const close = this.expectPunct("]");
    return { kind: "ArrayLiteral", elements, start: open.start, end: close.end };
  }

  private parseObjectLiteral(): ObjectLiteral {
    const open = this.expectPunct("{");
    const properties: PropertyItem[] = [];
    for (;;) {
      if (this.isPunct("}")) {
        break;
      }
      if (this.isPunct("...")) {
        const spread = this.advance();
        const argument = this.parseAssignmentExpression();
        properties.push({ kind: "SpreadElement", argument, start: spread.start, end: argument.end });
      } else {
        properties.push(this.parseProperty());
      }
      if (this.isPunct(",")) {
        this.advance();
        continue;
      }
      if (this.isPunct("}")) {
        break;
      }
      throw this.unexpected(this.current());
    }
    const close = this.expectPunct("}");
    return { kind: "ObjectLiteral", properties, start: open.start, end: close.end };
  }

  private parseProperty(): Property | ObjectMethod {
    const start = this.current().start;
    let generator = false;
    let async = false;
    let accessor: "get" | "set" | null = null;
    if (this.isPunct("*")) {
      this.advance();
      generator = true;
    } else {
      const token = this.current();
      if (
        (token.kind === "identifier" || token.kind === "keyword") &&
        (token.value === "get" || token.value === "set") &&
        this.isMemberNameStartToken(this.peek())
      ) {
        this.advance();
        accessor = token.value;
      } else if (
        token.kind === "identifier" &&
        token.value === "async" &&
        this.isMemberStartToken(this.peek())
      ) {
        this.advance();
        async = true;
        if (this.matchPunct("*")) {
          generator = true;
        }
      }
    }
    if (this.isPunct("[")) {
      const open = this.advance();
      const expression = this.parseExpression();
      const close = this.expectPunct("]");
      if (this.isPunct("?") && (this.isPunctAhead("(") || this.isPunctAhead("<"))) {
        throw this.errorAt(this.current(), "object method may not be optional");
      }
      if (this.isPunct("(") || this.isPunct("<")) {
        const name: ComputedPropertyName = {
          kind: "ComputedPropertyName",
          expression,
          start: open.start,
          end: close.end,
        };
        return this.parseObjectMethod(name, start, generator, async, accessor);
      }
      if (generator || async || accessor !== null) {
        throw this.unexpected(this.current());
      }
      const value = this.parsePropertyValue(expression);
      return { ...value, computed: true };
    }
    const token = this.current();
    if (
      token.kind === "identifier" ||
      token.kind === "keyword" ||
      token.kind === "string" ||
      token.kind === "number"
    ) {
      const name = this.parseMemberName();
      if (this.isPunct("?") && (this.isPunctAhead("(") || this.isPunctAhead("<"))) {
        throw this.errorAt(this.current(), "object method may not be optional");
      }
      if (this.isPunct("(") || this.isPunct("<")) {
        return this.parseObjectMethod(name, start, generator, async, accessor);
      }
      if (generator || async || accessor !== null) {
        throw this.unexpected(this.current());
      }
      if (name.kind === "Identifier" && (this.isPunct(",") || this.isPunct("}"))) {
        const value: Identifier = {
          kind: "Identifier",
          name: name.name,
          start: name.start,
          end: name.end,
        };
        return {
          kind: "Property",
          key: name,
          value,
          shorthand: true,
          computed: false,
          start: name.start,
          end: name.end,
        };
      }
      return this.parsePropertyValue(name);
    }
    throw this.unexpected(token);
  }

  private parseObjectMethod(
    name: MemberName,
    start: number,
    generator: boolean,
    async: boolean,
    accessor: "get" | "set" | null,
  ): ObjectMethod {
    const typeParameters = this.parseTypeParameters();
    const parameters = this.parseParameters();
    let returnType: ReturnTypeNode | null = null;
    if (this.matchPunct(":")) {
      returnType = this.parseReturnType();
    }
    const body = this.parseBlockStatement();
    const method: ObjectMethod = {
      kind: "ObjectMethod",
      name,
      typeParameters,
      parameters,
      returnType,
      body,
      start,
      end: body.end,
    };
    if (async) {
      method.async = true;
    }
    if (generator) {
      method.generator = true;
    }
    if (accessor !== null) {
      method.accessor = accessor;
    }
    return method;
  }

  private parsePropertyValue(key: Expression): Property {
    this.expectPunct(":");
    const value = this.parseAssignmentExpression();
    return {
      kind: "Property",
      key,
      value,
      shorthand: false,
      computed: false,
      start: key.start,
      end: value.end,
    };
  }

  private parseTemplateLiteral(head: Token): TemplateLiteral {
    if (head.kind === "no-substitution-template") {
      this.advance();
      return {
        kind: "TemplateLiteral",
        quasis: [head.text.slice(1, -1)],
        expressions: [],
        start: head.start,
        end: head.end,
      };
    }
    this.advance();
    const quasis: string[] = [head.text.slice(1, -2)];
    const expressions: Expression[] = [];
    for (;;) {
      expressions.push(this.parseExpression());
      const close = this.current();
      if (close.kind !== "punctuator" || close.text !== "}") {
        throw this.unexpected(close);
      }
      const part = this.adoptToken(this.rescanTemplatePart(close));
      if (part.kind === "template-middle") {
        quasis.push(part.text.slice(1, -2));
        this.advance();
        continue;
      }
      if (part.kind === "template-tail") {
        quasis.push(part.text.slice(1, -1));
        const literal: TemplateLiteral = {
          kind: "TemplateLiteral",
          quasis,
          expressions,
          start: head.start,
          end: part.end,
        };
        this.advance();
        return literal;
      }
      throw this.unexpected(part);
    }
  }

  private parseTemplateLiteralType(head: Token): TemplateLiteralType {
    this.advance();
    const quasis: string[] = [head.text.slice(1, -2)];
    const types: Type[] = [];
    for (;;) {
      types.push(this.parseType());
      const close = this.current();
      if (close.kind !== "punctuator" || close.text !== "}") {
        throw this.unexpected(close);
      }
      const part = this.adoptToken(this.rescanTemplatePart(close));
      if (part.kind === "template-middle") {
        quasis.push(part.text.slice(1, -2));
        this.advance();
        continue;
      }
      if (part.kind === "template-tail") {
        quasis.push(part.text.slice(1, -1));
        const literal: TemplateLiteralType = {
          kind: "TemplateLiteralType",
          quasis,
          types,
          start: head.start,
          end: part.end,
        };
        this.advance();
        return literal;
      }
      throw this.unexpected(part);
    }
  }

  private parseRegexLiteral(): RegexLiteral {
    const token = this.adoptToken(this.rescanRegexToken());
    this.advance();
    const lastSlash = token.text.lastIndexOf("/");
    return {
      kind: "RegexLiteral",
      pattern: token.text.slice(1, lastSlash),
      flags: token.text.slice(lastSlash + 1),
      raw: token.text,
      start: token.start,
      end: token.end,
    };
  }

  private current(): Token {
    if (this.lookahead === undefined) {
      this.lookahead = this.readNonTrivia();
    }
    return this.lookahead;
  }

  private peek(): Token {
    this.current();
    if (this.buffered === undefined) {
      this.buffered = this.readNonTrivia();
    }
    return this.buffered;
  }

  private peek2(): Token {
    this.peek();
    const token = this.readNonTrivia();
    this.pending.unshift(token);
    return token;
  }

  private peekAhead(offset: number): Token {
    this.current();
    if (this.buffered === undefined) {
      this.buffered = this.readNonTrivia();
    }
    if (offset <= 1) {
      return this.buffered;
    }
    const collected: Token[] = [];
    for (let i = 1; i < offset; i += 1) {
      collected.push(this.readNonTrivia());
    }
    for (let i = collected.length - 1; i >= 0; i -= 1) {
      const token = collected[i];
      if (token !== undefined) {
        this.pending.unshift(token);
      }
    }
    const token = this.pending[offset - 2];
    if (token === undefined) {
      throw new Error("peekAhead out of range");
    }
    return token;
  }

  private isPunctAhead(text: string): boolean {
    const token = this.peek();
    return token.kind === "punctuator" && token.text === text;
  }

  private isIdentifierAhead(word: string): boolean {
    const token = this.peek();
    return token.kind === "identifier" && token.value === word;
  }

  private advance(): Token {
    const token = this.current();
    if (this.buffered === undefined) {
      this.lookahead = undefined;
    } else {
      this.lookahead = this.buffered;
      this.buffered = undefined;
    }
    this.lastConsumedEnd = token.end;
    this.lastConsumedLine = token.line;
    return token;
  }

  private adoptToken(token: Token): Token {
    this.lookahead = token;
    this.buffered = undefined;
    return token;
  }

  private rescanRegexToken(): Token {
    const current = this.current();
    const recorded = this.rescanned.get(current.start);
    if (recorded !== undefined && recorded.kind === "regex") {
      return recorded;
    }
    const token = this.lexer.rescanRegex();
    this.rescanned.set(current.start, token);
    return token;
  }

  private rescanTemplatePart(close: Token): Token {
    const recorded = this.rescanned.get(close.start);
    if (
      recorded !== undefined &&
      (recorded.kind === "template-middle" || recorded.kind === "template-tail")
    ) {
      return recorded;
    }
    const token = this.lexer.rescanTemplateToken();
    this.rescanned.set(close.start, token);
    return token;
  }

  private save(): {
    offset: number;
    line: number;
    column: number;
    lastConsumedEnd: number;
    lastConsumedLine: number;
  } {
    const token = this.current();
    return {
      offset: token.start,
      line: token.line,
      column: token.column,
      lastConsumedEnd: this.lastConsumedEnd,
      lastConsumedLine: this.lastConsumedLine,
    };
  }

  private restore(checkpoint: {
    offset: number;
    line: number;
    column: number;
    lastConsumedEnd: number;
    lastConsumedLine: number;
  }): void {
    this.lookahead = undefined;
    this.buffered = undefined;
    this.pending = [];
    this.lastConsumedEnd = checkpoint.lastConsumedEnd;
    this.lastConsumedLine = checkpoint.lastConsumedLine;
    this.cursor = this.findHistoryIndex(checkpoint.offset);
  }

  private findHistoryIndex(offset: number): number {
    let low = 0;
    let high = this.history.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const token = this.history[middle];
      if (token === undefined || token.end > offset) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    return low;
  }

  private readNonTrivia(): Token {
    const pending = this.pending.shift();
    if (pending !== undefined) {
      return pending;
    }
    if (this.cursor < this.history.length) {
      const token = this.history[this.cursor];
      this.cursor += 1;
      return token as Token;
    }
    for (;;) {
      const token = this.lexer.next();
      if (!triviaKinds.has(token.kind)) {
        this.history.push(token);
        this.cursor = this.history.length;
        return token;
      }
    }
  }

  private matchPunct(text: string): boolean {
    const token = this.current();
    if (token.kind === "punctuator" && token.text === text) {
      this.advance();
      return true;
    }
    return false;
  }

  private matchPunctuator(operators: ReadonlySet<string>): Token | undefined {
    const token = this.current();
    if (token.kind === "punctuator" && operators.has(token.text)) {
      this.advance();
      return token;
    }
    return undefined;
  }

  private isPunct(text: string): boolean {
    const token = this.current();
    return token.kind === "punctuator" && token.text === text;
  }

  private expectPunct(text: string): Token {
    const token = this.current();
    if (token.kind !== "punctuator" || token.text !== text) {
      throw this.errorAt(token, `expected ${JSON.stringify(text)}`);
    }
    this.advance();
    return token;
  }

  private expectKeyword(word: string): Token {
    const token = this.current();
    if (token.kind !== "keyword" || token.value !== word) {
      throw this.errorAt(token, `expected keyword ${JSON.stringify(word)}`);
    }
    this.advance();
    return token;
  }

  private unexpected(token: Token): ParseError {
    const message =
      token.kind === "eof"
        ? "unexpected end of input"
        : `unexpected token ${JSON.stringify(token.text)}`;
    return this.errorAt(token, message);
  }

  private errorAt(token: Token, message: string): ParseError {
    return new ParseError(message, token.start, token.line, token.column);
  }
}
