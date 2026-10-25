/**
 * Reference implementation for the `mini-spreadsheet` benchmark task.
 *
 * The public surface is deliberately tiny (`Workbook` plus three value types),
 * but the implementation is split into the pieces a spreadsheet engine needs:
 * address arithmetic, a tokenizer, a precedence-climbing parser, a memoized
 * evaluator with cycle detection, and the public workbook facade.
 *
 * The file is intentionally dependency-free and side-effect-free: the only state
 * is the per-instance cell map, evaluation cache, and in-progress set.
 */

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export type CellValue = number | string | boolean | null;
export type CellError = "#DIV/0!" | "#VALUE!" | "#REF!" | "#CYCLE!" | "#NAME?" | "#PARSE!";
export type CellResult = CellValue | CellError;

// ---------------------------------------------------------------------------
// Limits and address parsing
// ---------------------------------------------------------------------------

/** Excel-compatible worksheet bounds. Anything outside them is `#REF!`. */
const MAX_COLUMN = 16_384; // XFD
const MAX_ROW = 1_048_576;

const CELL_ADDRESS_PATTERN = /^([A-Za-z]+)([1-9][0-9]*)$/;
const CELL_REFERENCE_PATTERN = /^[A-Za-z]+[0-9]+$/;

interface CellAddress {
  /** Canonical, case-insensitive map key. */
  readonly key: string;
  /** 1-based column number. */
  readonly column: number;
  /** 1-based row number. */
  readonly row: number;
  /** Upper-case column letters as written in A1 notation. */
  readonly columnLetters: string;
}

function cellKey(column: number, row: number): string {
  return `${column}:${row}`;
}

/**
 * Convert a column label to its 1-based index. Returns null for an empty label
 * or one beyond the worksheet's right edge. Labels are case-insensitive.
 */
function columnToIndex(letters: string): number | null {
  let value = 0;
  for (const character of letters.toUpperCase()) {
    const code = character.charCodeAt(0);
    if (code < 65 || code > 90) {
      return null;
    }
    value = value * 26 + (code - 64);
    if (value > MAX_COLUMN) {
      return null;
    }
  }
  return value === 0 ? null : value;
}

/**
 * Parse a strict A1 address (letters plus a row with no leading zero). The same
 * rules apply to `setCell` addresses and to references used inside formulas.
 */
function parseCellAddress(raw: string): CellAddress | null {
  const match = CELL_ADDRESS_PATTERN.exec(raw);
  if (match === null) {
    return null;
  }
  const rawLetters = match[1];
  const rawRow = match[2];
  if (rawLetters === undefined || rawRow === undefined) {
    return null;
  }
  const column = columnToIndex(rawLetters);
  if (column === null) {
    return null;
  }
  const row = Number(rawRow);
  if (!Number.isSafeInteger(row) || row < 1 || row > MAX_ROW) {
    return null;
  }
  return {
    key: cellKey(column, row),
    column,
    row,
    columnLetters: rawLetters.toUpperCase(),
  };
}

function requireCellAddress(raw: string): CellAddress {
  const address = parseCellAddress(raw);
  if (address === null) {
    throw new Error(`invalid cell address: ${raw}`);
  }
  return address;
}

// ---------------------------------------------------------------------------
// Internal values and AST
// ---------------------------------------------------------------------------

/** A blank cell is distinct from `""` and from `0` during evaluation. */
type Value =
  | { readonly kind: "blank" }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "error"; readonly value: CellError };

const BLANK: Value = { kind: "blank" };

function numberValue(value: number): Value {
  return { kind: "number", value };
}

function booleanValue(value: boolean): Value {
  return { kind: "boolean", value };
}

function stringValue(value: string): Value {
  return { kind: "string", value };
}

function errorValue(value: CellError): Value {
  return { kind: "error", value };
}

function isError(value: Value): value is { readonly kind: "error"; readonly value: CellError } {
  return value.kind === "error";
}

type ComparisonOperator = "=" | "<>" | "<" | "<=" | ">" | ">=";
type ArithmeticOperator = "+" | "-" | "*" | "/" | "^";
type BinaryOperator = ArithmeticOperator | "&" | ComparisonOperator;

type Expression =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "cell"; readonly address: string }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "group"; readonly expression: Expression }
  | {
      readonly kind: "unary";
      readonly operator: "+" | "-";
      readonly operand: Expression;
    }
  | {
      readonly kind: "binary";
      readonly operator: BinaryOperator;
      readonly left: Expression;
      readonly right: Expression;
    }
  | {
      readonly kind: "call";
      readonly name: string;
      readonly args: readonly Expression[];
    }
  | {
      readonly kind: "range";
      readonly start: string;
      readonly end: string;
    };

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind =
  | "number"
  | "string"
  | "identifier"
  | "leftParen"
  | "rightParen"
  | "comma"
  | "colon"
  | "plus"
  | "minus"
  | "star"
  | "slash"
  | "caret"
  | "ampersand"
  | "equals"
  | "notEquals"
  | "lessThan"
  | "lessThanOrEqual"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "eof";

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly position: number;
  /** Present for `number` tokens. */
  readonly numberValue?: number;
  /** Present for `string` tokens. */
  readonly stringValue?: string;
}

class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = "FormulaSyntaxError";
  }
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isIdentifierStart(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || character === "_";
}

function isIdentifierPart(character: string): boolean {
  return isIdentifierStart(character) || isDigit(character);
}

class Tokenizer {
  readonly #source: string;
  #index = 0;

  constructor(source: string) {
    this.#source = source;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      this.#skipWhitespace();
      if (this.#index >= this.#source.length) {
        tokens.push({ kind: "eof", text: "", position: this.#index });
        return tokens;
      }
      const position = this.#index;
      const character = this.#source[this.#index];
      if (character === undefined) {
        tokens.push({ kind: "eof", text: "", position });
        return tokens;
      }
      if (character === '"') {
        tokens.push(this.#readString());
        continue;
      }
      if (isDigit(character) || (character === "." && this.#isDigitAt(this.#index + 1))) {
        tokens.push(this.#readNumber());
        continue;
      }
      if (isIdentifierStart(character)) {
        tokens.push(this.#readIdentifier());
        continue;
      }
      switch (character) {
        case "(":
          tokens.push({ kind: "leftParen", text: character, position });
          this.#index += 1;
          continue;
        case ")":
          tokens.push({ kind: "rightParen", text: character, position });
          this.#index += 1;
          continue;
        case ",":
          tokens.push({ kind: "comma", text: character, position });
          this.#index += 1;
          continue;
        case ":":
          tokens.push({ kind: "colon", text: character, position });
          this.#index += 1;
          continue;
        case "+":
          tokens.push({ kind: "plus", text: character, position });
          this.#index += 1;
          continue;
        case "-":
          tokens.push({ kind: "minus", text: character, position });
          this.#index += 1;
          continue;
        case "*":
          tokens.push({ kind: "star", text: character, position });
          this.#index += 1;
          continue;
        case "/":
          tokens.push({ kind: "slash", text: character, position });
          this.#index += 1;
          continue;
        case "^":
          tokens.push({ kind: "caret", text: character, position });
          this.#index += 1;
          continue;
        case "&":
          tokens.push({ kind: "ampersand", text: character, position });
          this.#index += 1;
          continue;
        case "=":
          tokens.push({ kind: "equals", text: character, position });
          this.#index += 1;
          continue;
        case "<": {
          const next = this.#source[this.#index + 1];
          if (next === ">") {
            tokens.push({ kind: "notEquals", text: "<>", position });
            this.#index += 2;
          } else if (next === "=") {
            tokens.push({ kind: "lessThanOrEqual", text: "<=", position });
            this.#index += 2;
          } else {
            tokens.push({ kind: "lessThan", text: "<", position });
            this.#index += 1;
          }
          continue;
        }
        case ">": {
          const next = this.#source[this.#index + 1];
          if (next === "=") {
            tokens.push({ kind: "greaterThanOrEqual", text: ">=", position });
            this.#index += 2;
          } else {
            tokens.push({ kind: "greaterThan", text: ">", position });
            this.#index += 1;
          }
          continue;
        }
        default:
          throw new FormulaSyntaxError(`unexpected character ${character}`, position);
      }
    }
  }

  #skipWhitespace(): void {
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index];
      if (character === undefined || !isWhitespace(character)) {
        return;
      }
      this.#index += 1;
    }
  }

  #isDigitAt(index: number): boolean {
    const character = this.#source[index];
    return character !== undefined && isDigit(character);
  }

  #readString(): Token {
    const position = this.#index;
    this.#index += 1; // opening quote
    let value = "";
    for (;;) {
      const character = this.#source[this.#index];
      if (character === undefined) {
        throw new FormulaSyntaxError("unterminated string literal", position);
      }
      if (character === '"') {
        this.#index += 1;
        return { kind: "string", text: value, position, stringValue: value };
      }
      if (character === "\\") {
        const escaped = this.#source[this.#index + 1];
        if (escaped === undefined) {
          throw new FormulaSyntaxError("unterminated escape sequence", this.#index);
        }
        switch (escaped) {
          case '"':
            value += '"';
            break;
          case "\\":
            value += "\\";
            break;
          case "n":
            value += "\n";
            break;
          case "t":
            value += "\t";
            break;
          default:
            throw new FormulaSyntaxError(`invalid escape sequence \\${escaped}`, this.#index);
        }
        this.#index += 2;
        continue;
      }
      if (character === "\n" || character === "\r") {
        throw new FormulaSyntaxError("newline in string literal", this.#index);
      }
      value += character;
      this.#index += 1;
    }
  }

  #readNumber(): Token {
    const position = this.#index;
    const start = this.#index;
    while (this.#isDigitAt(this.#index)) {
      this.#index += 1;
    }
    if (this.#source[this.#index] === ".") {
      this.#index += 1;
      while (this.#isDigitAt(this.#index)) {
        this.#index += 1;
      }
    }
    const exponent = this.#source[this.#index];
    if (exponent === "e" || exponent === "E") {
      this.#index += 1;
      const sign = this.#source[this.#index];
      if (sign === "+" || sign === "-") {
        this.#index += 1;
      }
      if (!this.#isDigitAt(this.#index)) {
        throw new FormulaSyntaxError("exponent has no digits", position);
      }
      while (this.#isDigitAt(this.#index)) {
        this.#index += 1;
      }
    }
    const text = this.#source.slice(start, this.#index);
    const value = Number(text);
    return { kind: "number", text, position, numberValue: value };
  }

  #readIdentifier(): Token {
    const position = this.#index;
    const start = this.#index;
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index];
      if (character === undefined || !isIdentifierPart(character)) {
        break;
      }
      this.#index += 1;
    }
    const text = this.#source.slice(start, this.#index);
    return { kind: "identifier", text, position };
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  readonly #tokens: readonly Token[];
  #index = 0;

  constructor(tokens: readonly Token[]) {
    this.#tokens = tokens;
  }

  parse(): Expression {
    const expression = this.#parseExpression();
    this.#expect("eof");
    return expression;
  }

  #peek(): Token {
    const token = this.#tokens[this.#index];
    if (token === undefined) {
      // Tokenizer always appends EOF; this is only a defensive fallback.
      return { kind: "eof", text: "", position: 0 };
    }
    return token;
  }

  #advance(): Token {
    const token = this.#peek();
    if (token.kind !== "eof") {
      this.#index += 1;
    }
    return token;
  }

  #expect(kind: TokenKind): Token {
    const token = this.#peek();
    if (token.kind !== kind) {
      throw new FormulaSyntaxError(`expected ${kind}, found ${token.kind}`, token.position);
    }
    return this.#advance();
  }

  #parseExpression(): Expression {
    return this.#parseComparison();
  }

  #parseComparison(): Expression {
    let left = this.#parseConcat();
    for (;;) {
      const token = this.#peek();
      let operator: ComparisonOperator;
      switch (token.kind) {
        case "equals":
          operator = "=";
          break;
        case "notEquals":
          operator = "<>";
          break;
        case "lessThan":
          operator = "<";
          break;
        case "lessThanOrEqual":
          operator = "<=";
          break;
        case "greaterThan":
          operator = ">";
          break;
        case "greaterThanOrEqual":
          operator = ">=";
          break;
        default:
          return left;
      }
      this.#advance();
      const right = this.#parseConcat();
      left = { kind: "binary", operator, left, right };
    }
  }

  #parseConcat(): Expression {
    let left = this.#parseAdditive();
    while (this.#peek().kind === "ampersand") {
      this.#advance();
      const right = this.#parseAdditive();
      left = { kind: "binary", operator: "&", left, right };
    }
    return left;
  }

  #parseAdditive(): Expression {
    let left = this.#parseMultiplicative();
    for (;;) {
      const token = this.#peek();
      if (token.kind !== "plus" && token.kind !== "minus") {
        return left;
      }
      this.#advance();
      const right = this.#parseMultiplicative();
      left = {
        kind: "binary",
        operator: token.kind === "plus" ? "+" : "-",
        left,
        right,
      };
    }
  }

  #parseMultiplicative(): Expression {
    let left = this.#parseUnary();
    for (;;) {
      const token = this.#peek();
      if (token.kind !== "star" && token.kind !== "slash") {
        return left;
      }
      this.#advance();
      const right = this.#parseUnary();
      left = {
        kind: "binary",
        operator: token.kind === "star" ? "*" : "/",
        left,
        right,
      };
    }
  }

  #parseUnary(): Expression {
    const token = this.#peek();
    if (token.kind === "plus" || token.kind === "minus") {
      this.#advance();
      return {
        kind: "unary",
        operator: token.kind === "plus" ? "+" : "-",
        operand: this.#parseUnary(),
      };
    }
    return this.#parsePower();
  }

  #parsePower(): Expression {
    const left = this.#parsePrimary();
    if (this.#peek().kind === "caret") {
      this.#advance();
      // Right-associative, and the right side may itself be unary (`2^-3`).
      const right = this.#parseUnary();
      return { kind: "binary", operator: "^", left, right };
    }
    return left;
  }

  #parsePrimary(): Expression {
    const token = this.#peek();
    switch (token.kind) {
      case "number": {
        this.#advance();
        return { kind: "number", value: token.numberValue ?? Number(token.text) };
      }
      case "string": {
        this.#advance();
        return { kind: "string", value: token.stringValue ?? "" };
      }
      case "identifier":
        return this.#parseIdentifier(token);
      case "leftParen": {
        this.#advance();
        const expression = this.#parseExpression();
        this.#expect("rightParen");
        return { kind: "group", expression };
      }
      default:
        throw new FormulaSyntaxError(`expected a value, found ${token.kind}`, token.position);
    }
  }

  #parseIdentifier(token: Token): Expression {
    this.#advance();
    const upper = token.text.toUpperCase();
    if (this.#peek().kind === "leftParen") {
      return this.#parseCall(upper);
    }
    if (upper === "TRUE") {
      return { kind: "boolean", value: true };
    }
    if (upper === "FALSE") {
      return { kind: "boolean", value: false };
    }
    if (CELL_REFERENCE_PATTERN.test(token.text)) {
      return { kind: "cell", address: token.text };
    }
    return { kind: "name", name: token.text };
  }

  #parseCall(name: string): Expression {
    this.#expect("leftParen");
    const args: Expression[] = [];
    if (this.#peek().kind === "rightParen") {
      this.#advance();
      return { kind: "call", name, args };
    }
    for (;;) {
      args.push(this.#parseArgument());
      const token = this.#peek();
      if (token.kind === "comma") {
        this.#advance();
        continue;
      }
      this.#expect("rightParen");
      return { kind: "call", name, args };
    }
  }

  #parseArgument(): Expression {
    const expression = this.#parseExpression();
    if (this.#peek().kind !== "colon") {
      return expression;
    }
    this.#advance();
    const endpoint = this.#peek();
    if (endpoint.kind !== "identifier" || !CELL_REFERENCE_PATTERN.test(endpoint.text)) {
      throw new FormulaSyntaxError("range endpoint must be a cell reference", endpoint.position);
    }
    this.#advance();
    if (expression.kind !== "cell") {
      throw new FormulaSyntaxError("range start must be a cell reference", endpoint.position);
    }
    return { kind: "range", start: expression.address, end: endpoint.text };
  }
}

/** Parse the text after the leading `=`. Returns null for a syntax error. */
function parseFormula(source: string): Expression | null {
  try {
    const tokenizer = new Tokenizer(source);
    const tokens = tokenizer.tokenize();
    const parser = new Parser(tokens);
    return parser.parse();
  } catch (error) {
    if (error instanceof FormulaSyntaxError) {
      return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Evaluation helpers
// ---------------------------------------------------------------------------

function toPublicValue(value: Value): CellResult {
  switch (value.kind) {
    case "blank":
      return null;
    case "number":
    case "boolean":
    case "string":
      return value.value;
    case "error":
      return value.value;
  }
}

function displayValue(value: CellResult): string {
  if (value === null) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  return String(value);
}

function finiteNumber(value: number): Value {
  return Number.isFinite(value) ? numberValue(value) : errorValue("#VALUE!");
}

function concatText(value: Value): string {
  switch (value.kind) {
    case "blank":
      return "";
    case "number":
      return String(value.value);
    case "boolean":
      return value.value ? "TRUE" : "FALSE";
    case "string":
      return value.value;
    case "error":
      // Callers must reject errors before reaching this helper.
      throw new Error("cannot stringify an error value");
  }
}

function compareOrdered(left: Value, right: Value, operator: "<" | "<=" | ">" | ">="): Value {
  let comparison: number;
  if (left.kind === "number" && right.kind === "number") {
    comparison = left.value === right.value ? 0 : left.value < right.value ? -1 : 1;
  } else if (left.kind === "string" && right.kind === "string") {
    comparison = left.value === right.value ? 0 : left.value < right.value ? -1 : 1;
  } else if (left.kind === "boolean" && right.kind === "boolean") {
    comparison =
      left.value === right.value ? 0 : left.value === false && right.value === true ? -1 : 1;
  } else {
    return errorValue("#VALUE!");
  }
  switch (operator) {
    case "<":
      return booleanValue(comparison < 0);
    case "<=":
      return booleanValue(comparison <= 0);
    case ">":
      return booleanValue(comparison > 0);
    case ">=":
      return booleanValue(comparison >= 0);
  }
}

function compareEquality(left: Value, right: Value, negate: boolean): Value {
  let equal: boolean;
  if (left.kind === "blank" && right.kind === "blank") {
    equal = true;
  } else if (left.kind === "blank" || right.kind === "blank") {
    return errorValue("#VALUE!");
  } else if (left.kind === "number" && right.kind === "number") {
    equal = left.value === right.value;
  } else if (left.kind === "string" && right.kind === "string") {
    equal = left.value === right.value;
  } else if (left.kind === "boolean" && right.kind === "boolean") {
    equal = left.value === right.value;
  } else {
    return errorValue("#VALUE!");
  }
  return booleanValue(negate ? !equal : equal);
}

function applyArithmetic(operator: ArithmeticOperator, left: Value, right: Value): Value {
  if (left.kind !== "number" || right.kind !== "number") {
    return errorValue("#VALUE!");
  }
  const leftNumber = left.value;
  const rightNumber = right.value;
  switch (operator) {
    case "+":
      return finiteNumber(leftNumber + rightNumber);
    case "-":
      return finiteNumber(leftNumber - rightNumber);
    case "*":
      return finiteNumber(leftNumber * rightNumber);
    case "/":
      if (rightNumber === 0) {
        return errorValue("#DIV/0!");
      }
      return finiteNumber(leftNumber / rightNumber);
    case "^":
      if (leftNumber === 0 && rightNumber < 0) {
        return errorValue("#DIV/0!");
      }
      return finiteNumber(Math.pow(leftNumber, rightNumber));
  }
}

/**
 * `ROUND` rounds half away from zero. Scaling happens on the absolute value so
 * negative ties do not depend on `Math.round`'s asymmetric treatment of -0.5.
 */
function roundHalfAwayFromZero(value: number, digits: number): Value {
  const factor = 10 ** digits;
  const scaled = Math.abs(value) * factor;
  if (!Number.isFinite(scaled)) {
    return errorValue("#VALUE!");
  }
  const rounded = Math.round(scaled) / factor;
  const signed = value < 0 ? -rounded : rounded;
  return finiteNumber(Object.is(signed, -0) ? 0 : signed);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface FormulaCell {
  readonly kind: "formula";
  readonly expression: Expression | null;
  readonly column: number;
  readonly row: number;
}

interface LiteralCell {
  readonly kind: "literal";
  readonly value: CellValue;
  readonly column: number;
  readonly row: number;
}

type StoredCell = FormulaCell | LiteralCell;

interface RangeBounds {
  readonly startColumn: number;
  readonly endColumn: number;
  readonly startRow: number;
  readonly endRow: number;
}

function rangeBounds(start: string, end: string): RangeBounds | null {
  const first = parseCellAddress(start);
  const second = parseCellAddress(end);
  if (first === null || second === null) {
    return null;
  }
  return {
    startColumn: Math.min(first.column, second.column),
    endColumn: Math.max(first.column, second.column),
    startRow: Math.min(first.row, second.row),
    endRow: Math.max(first.row, second.row),
  };
}

function literalToValue(value: CellValue): Value {
  if (value === null) {
    return BLANK;
  }
  if (typeof value === "number") {
    return numberValue(value);
  }
  if (typeof value === "boolean") {
    return booleanValue(value);
  }
  return stringValue(value);
}

export class Workbook {
  readonly #cells = new Map<string, StoredCell>();
  readonly #cache = new Map<string, Value>();
  readonly #evaluating = new Set<string>();

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  setCell(address: string, input: string | number | boolean | null): void {
    const parsed = requireCellAddress(address);
    if (input === null) {
      this.#cells.delete(parsed.key);
      this.#invalidate();
      return;
    }
    if (typeof input === "string" && input.startsWith("=")) {
      this.#cells.set(parsed.key, {
        kind: "formula",
        expression: parseFormula(input.slice(1)),
        column: parsed.column,
        row: parsed.row,
      });
    } else {
      this.#cells.set(parsed.key, {
        kind: "literal",
        value: input,
        column: parsed.column,
        row: parsed.row,
      });
    }
    this.#invalidate();
  }

  getValue(address: string): CellResult {
    const parsed = requireCellAddress(address);
    return toPublicValue(this.#evaluateCell(parsed.column, parsed.row));
  }

  getDisplay(address: string): string {
    return displayValue(this.getValue(address));
  }

  recalculate(): void {
    this.#invalidate();
    const formulas: FormulaCell[] = [];
    for (const cell of this.#cells.values()) {
      if (cell.kind === "formula") {
        formulas.push(cell);
      }
    }
    formulas.sort((left, right) => {
      if (left.row !== right.row) {
        return left.row - right.row;
      }
      return left.column - right.column;
    });
    for (const formula of formulas) {
      this.#evaluateCell(formula.column, formula.row);
    }
  }

  // -------------------------------------------------------------------------
  // Cache and cell evaluation
  // -------------------------------------------------------------------------

  #invalidate(): void {
    this.#cache.clear();
    this.#evaluating.clear();
  }

  #evaluateCell(column: number, row: number): Value {
    const key = cellKey(column, row);
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const stored = this.#cells.get(key);
    if (stored === undefined) {
      // Cache blanks too; every mutation clears the whole cache.
      this.#cache.set(key, BLANK);
      return BLANK;
    }
    if (stored.kind === "literal") {
      const value = literalToValue(stored.value);
      this.#cache.set(key, value);
      return value;
    }
    if (this.#evaluating.has(key)) {
      return errorValue("#CYCLE!");
    }
    if (stored.expression === null) {
      const value = errorValue("#PARSE!");
      this.#cache.set(key, value);
      return value;
    }
    this.#evaluating.add(key);
    let value: Value;
    try {
      value = this.#evaluateExpression(stored.expression);
    } finally {
      this.#evaluating.delete(key);
    }
    this.#cache.set(key, value);
    return value;
  }

  #evaluateReference(rawAddress: string): Value {
    const address = parseCellAddress(rawAddress);
    if (address === null) {
      return errorValue("#REF!");
    }
    return this.#evaluateCell(address.column, address.row);
  }

  // -------------------------------------------------------------------------
  // Expression evaluation
  // -------------------------------------------------------------------------

  #evaluateExpression(expression: Expression): Value {
    switch (expression.kind) {
      case "number":
        return finiteNumber(expression.value);
      case "string":
        return stringValue(expression.value);
      case "boolean":
        return booleanValue(expression.value);
      case "cell":
        return this.#evaluateReference(expression.address);
      case "name":
        return errorValue("#NAME?");
      case "group":
        return this.#evaluateExpression(expression.expression);
      case "range":
        // Ranges are only interpreted by functions (and only there are they
        // accepted by the parser).
        return errorValue("#VALUE!");
      case "unary":
        return this.#evaluateUnary(expression.operator, expression.operand);
      case "binary":
        return this.#evaluateBinary(expression.operator, expression.left, expression.right);
      case "call":
        return this.#evaluateCall(expression.name, expression.args);
    }
  }

  #evaluateUnary(operator: "+" | "-", operand: Expression): Value {
    const value = this.#evaluateExpression(operand);
    if (isError(value)) {
      return value;
    }
    if (value.kind !== "number") {
      return errorValue("#VALUE!");
    }
    return operator === "+" ? numberValue(value.value) : finiteNumber(-value.value);
  }

  #evaluateBinary(operator: BinaryOperator, left: Expression, right: Expression): Value {
    const leftValue = this.#evaluateExpression(left);
    if (isError(leftValue)) {
      return leftValue;
    }
    const rightValue = this.#evaluateExpression(right);
    if (isError(rightValue)) {
      return rightValue;
    }

    if (operator === "&") {
      return stringValue(concatText(leftValue) + concatText(rightValue));
    }
    switch (operator) {
      case "=":
        return compareEquality(leftValue, rightValue, false);
      case "<>":
        return compareEquality(leftValue, rightValue, true);
      case "<":
      case "<=":
      case ">":
      case ">=":
        return compareOrdered(leftValue, rightValue, operator);
      case "+":
      case "-":
      case "*":
      case "/":
      case "^":
        return applyArithmetic(operator, leftValue, rightValue);
    }
  }

  // -------------------------------------------------------------------------
  // Functions
  // -------------------------------------------------------------------------

  #evaluateCall(name: string, args: readonly Expression[]): Value {
    const upper = name.toUpperCase();
    switch (upper) {
      case "SUM":
      case "AVERAGE":
      case "MIN":
      case "MAX":
        return this.#evaluateAggregate(upper, args);
      case "COUNT":
        return this.#evaluateCount(args);
      case "IF":
        return this.#evaluateIf(args);
      case "ABS":
        return this.#evaluateAbs(args);
      case "ROUND":
        return this.#evaluateRound(args);
      default:
        return errorValue("#NAME?");
    }
  }

  /**
   * Evaluate a range or scalar argument. Scalar results are visited as one
   * value; ranges are walked row-major so error precedence is deterministic.
   */
  #visitArgumentValues(
    argument: Expression,
    visitor: (value: Value) => CellError | null,
  ): CellError | null {
    if (argument.kind === "range") {
      const bounds = rangeBounds(argument.start, argument.end);
      if (bounds === null) {
        return "#REF!";
      }
      for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
        for (let column = bounds.startColumn; column <= bounds.endColumn; column += 1) {
          const failure = visitor(this.#evaluateCell(column, row));
          if (failure !== null) {
            return failure;
          }
        }
      }
      return null;
    }
    return visitor(this.#evaluateExpression(argument));
  }

  #evaluateAggregate(name: "SUM" | "AVERAGE" | "MIN" | "MAX", args: readonly Expression[]): Value {
    if (args.length === 0) {
      return errorValue("#VALUE!");
    }
    const numbers: number[] = [];
    for (const argument of args) {
      const failure = this.#visitArgumentValues(argument, (value) => {
        if (isError(value)) {
          return value.value;
        }
        if (argument.kind === "range") {
          if (value.kind === "number") {
            numbers.push(value.value);
          }
          // Blanks, strings, and booleans inside ranges are ignored.
          return null;
        }
        switch (value.kind) {
          case "blank":
            return null;
          case "number":
            numbers.push(value.value);
            return null;
          case "string":
          case "boolean":
            return "#VALUE!";
        }
      });
      if (failure !== null) {
        return errorValue(failure);
      }
    }

    switch (name) {
      case "SUM": {
        let total = 0;
        for (const value of numbers) {
          total += value;
        }
        return finiteNumber(total);
      }
      case "AVERAGE": {
        if (numbers.length === 0) {
          return errorValue("#DIV/0!");
        }
        let total = 0;
        for (const value of numbers) {
          total += value;
        }
        return finiteNumber(total / numbers.length);
      }
      case "MIN": {
        if (numbers.length === 0) {
          return errorValue("#VALUE!");
        }
        let minimum = numbers[0];
        if (minimum === undefined) {
          return errorValue("#VALUE!");
        }
        for (const value of numbers) {
          if (value < minimum) {
            minimum = value;
          }
        }
        return finiteNumber(minimum);
      }
      case "MAX": {
        if (numbers.length === 0) {
          return errorValue("#VALUE!");
        }
        let maximum = numbers[0];
        if (maximum === undefined) {
          return errorValue("#VALUE!");
        }
        for (const value of numbers) {
          if (value > maximum) {
            maximum = value;
          }
        }
        return finiteNumber(maximum);
      }
    }
  }

  #evaluateCount(args: readonly Expression[]): Value {
    if (args.length === 0) {
      return errorValue("#VALUE!");
    }
    let count = 0;
    for (const argument of args) {
      const failure = this.#visitArgumentValues(argument, (value) => {
        if (isError(value)) {
          return value.value;
        }
        if (value.kind === "number") {
          count += 1;
        }
        return null;
      });
      if (failure !== null) {
        return errorValue(failure);
      }
    }
    return numberValue(count);
  }

  #evaluateIf(args: readonly Expression[]): Value {
    if (args.length !== 3) {
      return errorValue("#VALUE!");
    }
    const conditionExpression = args[0];
    const thenExpression = args[1];
    const elseExpression = args[2];
    if (
      conditionExpression === undefined ||
      thenExpression === undefined ||
      elseExpression === undefined
    ) {
      return errorValue("#VALUE!");
    }
    const condition = this.#evaluateExpression(conditionExpression);
    if (isError(condition)) {
      return condition;
    }
    if (condition.kind !== "boolean") {
      return errorValue("#VALUE!");
    }
    const selected = condition.value ? thenExpression : elseExpression;
    return this.#evaluateExpression(selected);
  }

  #evaluateAbs(args: readonly Expression[]): Value {
    if (args.length !== 1) {
      return errorValue("#VALUE!");
    }
    const argument = args[0];
    if (argument === undefined) {
      return errorValue("#VALUE!");
    }
    const value = this.#evaluateExpression(argument);
    if (isError(value)) {
      return value;
    }
    if (value.kind !== "number") {
      return errorValue("#VALUE!");
    }
    return finiteNumber(Math.abs(value.value));
  }

  #evaluateRound(args: readonly Expression[]): Value {
    if (args.length !== 2) {
      return errorValue("#VALUE!");
    }
    const numberArgument = args[0];
    const digitsArgument = args[1];
    if (numberArgument === undefined || digitsArgument === undefined) {
      return errorValue("#VALUE!");
    }
    const number = this.#evaluateExpression(numberArgument);
    if (isError(number)) {
      return number;
    }
    const digits = this.#evaluateExpression(digitsArgument);
    if (isError(digits)) {
      return digits;
    }
    if (number.kind !== "number" || digits.kind !== "number") {
      return errorValue("#VALUE!");
    }
    if (!Number.isInteger(digits.value) || digits.value < 0 || digits.value > 8) {
      return errorValue("#VALUE!");
    }
    return roundHalfAwayFromZero(number.value, digits.value);
  }
}
