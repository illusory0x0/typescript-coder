export type TokenKind =
  | "identifier"
  | "keyword"
  | "number"
  | "bigint"
  | "string"
  | "regex"
  | "punctuator"
  | "whitespace"
  | "line-comment"
  | "block-comment"
  | "no-substitution-template"
  | "template-head"
  | "template-middle"
  | "template-tail"
  | "eof";

export interface Token {
  kind: TokenKind;
  text: string;
  value: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

export class LexError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = "LexError";
  }
}

export const reservedKeywords: Set<string> = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
]);

export const contextualKeywords: Set<string> = new Set([
  "as",
  "asserts",
  "any",
  "async",
  "await",
  "bigint",
  "boolean",
  "declare",
  "from",
  "get",
  "global",
  "infer",
  "interface",
  "is",
  "keyof",
  "module",
  "namespace",
  "never",
  "number",
  "object",
  "of",
  "override",
  "readonly",
  "require",
  "satisfy",
  "set",
  "string",
  "symbol",
  "type",
  "undefined",
  "unique",
  "unknown",
  "yield",
  "abstract",
  "implements",
]);

interface Escape {
  value: string;
  length: number;
}

const identifierStartPattern = /[\p{ID_Start}]/u;
const identifierContinuePattern = /[\p{ID_Continue}]/u;
const hexDigitsPattern = /^[0-9a-fA-F]+$/;
const fourHexDigitsPattern = /^[0-9a-fA-F]{4}$/;
const twoHexDigitsPattern = /^[0-9a-fA-F]{2}$/;

const simpleStringEscapes: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "`": "`",
};

const punctuators: readonly string[] = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "&&=",
  "||=",
  "??=",
  "<<=",
  ">>=",
  ">>>",
  "?.",
  "??",
  "=>",
  "**",
  "==",
  "!=",
  "<=",
  ">=",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "&&",
  "||",
  "<<",
  ">>",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  ";",
  ",",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "!",
  "~",
  "?",
  ":",
  "=",
  ".",
  "@",
  "#",
];

const regexAllowedPunctuators: ReadonlySet<string> = new Set([
  "(",
  ",",
  "=",
  "==",
  "===",
  "!",
  "!=",
  "!==",
  "&&",
  "||",
  "??",
  "?",
  ":",
  "[",
  "{",
  ";",
  "=>",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "~",
  "<",
  ">",
  "<=",
  ">=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<",
  ">>",
  ">>>",
  "<<=",
  ">>=",
  ">>>=",
  "**",
  "**=",
]);

const regexAllowedKeywords: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "case",
  "throw",
]);

function allowsRegexAfter(token: Token | undefined): boolean {
  if (token === undefined) {
    return true;
  }
  if (token.kind === "punctuator") {
    return regexAllowedPunctuators.has(token.text);
  }
  if (token.kind === "keyword" || token.kind === "identifier") {
    return regexAllowedKeywords.has(token.value);
  }
  if (token.kind === "template-head" || token.kind === "template-middle") {
    return true;
  }
  return false;
}

function isIdentifierStart(text: string): boolean {
  return text === "$" || text === "_" || identifierStartPattern.test(text);
}

function isIdentifierPart(text: string): boolean {
  return text === "$" || identifierContinuePattern.test(text);
}

function isDecimalDigit(text: string | undefined): boolean {
  return text !== undefined && text >= "0" && text <= "9";
}

function isDigitInRadix(text: string | undefined, radix: number): boolean {
  if (text === undefined || text.length !== 1) {
    return false;
  }
  if (radix === 16) {
    return (
      (text >= "0" && text <= "9") || (text >= "a" && text <= "f") || (text >= "A" && text <= "F")
    );
  }
  if (radix === 10) {
    return text >= "0" && text <= "9";
  }
  if (radix === 8) {
    return text >= "0" && text <= "7";
  }
  return text === "0" || text === "1";
}

export class Lexer {
  private position = 0;
  private lineNumber = 1;
  private columnNumber = 1;
  private lastToken: Token | undefined = undefined;

  constructor(private readonly source: string) {}

  next(): Token {
    const token = this.scanToken();
    this.lastToken = token;
    return token;
  }

  rescanRegex(): Token {
    const previous = this.lastToken;
    if (
      previous === undefined ||
      previous.kind !== "punctuator" ||
      (previous.text !== "/" && previous.text !== "/=")
    ) {
      throw new Error("rescanRegex requires a preceding / or /= punctuator");
    }
    this.position = previous.start;
    this.lineNumber = previous.line;
    this.columnNumber = previous.column;
    const token = this.scanRegex();
    this.lastToken = token;
    return token;
  }

  rescanTemplateToken(): Token {
    const previous = this.lastToken;
    if (previous === undefined || previous.kind !== "punctuator" || previous.text !== "}") {
      throw new Error("rescanTemplateToken requires a preceding } punctuator");
    }
    this.position = previous.start;
    this.lineNumber = previous.line;
    this.columnNumber = previous.column;
    const token = this.scanTemplatePart(false);
    this.lastToken = token;
    return token;
  }

  peek(): Token {
    const position = this.position;
    const line = this.lineNumber;
    const column = this.columnNumber;
    const lastToken = this.lastToken;
    const token = this.next();
    this.position = position;
    this.lineNumber = line;
    this.columnNumber = column;
    this.lastToken = lastToken;
    return token;
  }

  private scanToken(): Token {
    const start = this.position;
    const line = this.lineNumber;
    const column = this.columnNumber;
    if (start >= this.source.length) {
      return { kind: "eof", text: "", value: "", start, end: start, line, column };
    }
    const char = this.currentChar();
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      return this.scanWhitespace();
    }
    if (char === "/" && this.source[start + 1] === "/") {
      return this.scanLineComment();
    }
    if (char === "/" && this.source[start + 1] === "*") {
      return this.scanBlockComment();
    }
    if (isIdentifierStart(char) || (char === "\\" && this.source[start + 1] === "u")) {
      return this.scanIdentifier();
    }
    if (char >= "0" && char <= "9") {
      return this.scanNumber();
    }
    if (char === '"' || char === "'") {
      return this.scanString();
    }
    if (char === "`") {
      return this.scanTemplatePart(true);
    }
    for (const punctuator of punctuators) {
      if (this.source.startsWith(punctuator, start)) {
        this.advanceCodeUnits(punctuator.length);
        return {
          kind: "punctuator",
          text: punctuator,
          value: punctuator,
          start,
          end: start + punctuator.length,
          line,
          column,
        };
      }
    }
    throw new LexError(`unexpected character ${JSON.stringify(char)}`, start, line, column);
  }

  private scanWhitespace(): Token {
    const start = this.position;
    const line = this.lineNumber;
    const column = this.columnNumber;
    while (this.position < this.source.length) {
      const char = this.source[this.position];
      if (char !== " " && char !== "\t" && char !== "\r" && char !== "\n") {
        break;
      }
      this.advance();
    }
    const text = this.source.slice(start, this.position);
    return { kind: "whitespace", text, value: text, start, end: this.position, line, column };
  }

  private scanLineComment(): Token {
    const start = this.position;
    const line = this.lineNumber;
    const column = this.columnNumber;
    while (this.position < this.source.length) {
      const char = this.source[this.position];
      if (char === "\n" || char === "\r") {
        break;
      }
      this.advanceCodeUnits(1);
    }
    const text = this.source.slice(start, this.position);
    return { kind: "line-comment", text, value: text, start, end: this.position, line, column };
  }

  private scanBlockComment(): Token {
    const start = this.position;
    const line = this.lineNumber;
    const column = this.columnNumber;
    this.advanceCodeUnits(2);
    while (this.position < this.source.length) {
      if (this.source[this.position] === "*" && this.source[this.position + 1] === "/") {
        this.advanceCodeUnits(2);
        const text = this.source.slice(start, this.position);
        return {
          kind: "block-comment",
          text,
          value: text,
          start,
          end: this.position,
          line,
          column,
        };
      }
      this.advance();
    }
    throw new LexError("unterminated block comment", start, line, column);
  }

  private scanIdentifier(): Token {
    const start = this.position;
    const line = this.lineNumber;
    const column = this.columnNumber;
    let value = "";
    let atStart = true;
    while (this.position < this.source.length) {
      if (this.source[this.position] === "\\") {
        const escape = this.tryReadEscape(this.position);
        if (escape === null) {
          throw new LexError(
            "invalid escape sequence in identifier",
            this.position,
            this.lineNumber,
            this.columnNumber,
          );
        }
        value += escape.value;
        this.advanceCodeUnits(escape.length);
        atStart = false;
        continue;
      }
      const char = this.currentChar();
      if (atStart ? !isIdentifierStart(char) : !isIdentifierPart(char)) {
        break;
      }
      value += char;
      this.position += char.length;
      this.columnNumber += 1;
      atStart = false;
    }
    const text = this.source.slice(start, this.position);
    const kind: TokenKind = reservedKeywords.has(value) ? "keyword" : "identifier";
    return { kind, text, value, start, end: this.position, line, column };
  }

  private tryReadEscape(position: number): Escape | null {
    if (this.source[position] !== "\\" || this.source[position + 1] !== "u") {
      return null;
    }
    const braceStart = position + 2;
    if (this.source[braceStart] === "{") {
      const braceEnd = this.source.indexOf("}", braceStart + 1);
      if (braceEnd === -1) {
        return null;
      }
      const digits = this.source.slice(braceStart + 1, braceEnd);
      if (!hexDigitsPattern.test(digits)) {
        return null;
      }
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff) {
        return null;
      }
      return { value: String.fromCodePoint(codePoint), length: braceEnd + 1 - position };
    }
    const digits = this.source.slice(braceStart, braceStart + 4);
    if (!fourHexDigitsPattern.test(digits)) {
      return null;
    }
    return { value: String.fromCodePoint(Number.parseInt(digits, 16)), length: 6 };
  }

  private scanNumber(): Token {
    const start = this.position;
    const line = this.lineNumber;
    const column = this.columnNumber;
    const invalid = (): LexError => new LexError("invalid number", start, line, column);
    const first = this.source[this.position];
    let isBigInt = false;
    if (first === "0") {
      const prefix = this.source[this.position + 1];
      let radix = 0;
      if (prefix === "x" || prefix === "X") {
        radix = 16;
      } else if (prefix === "o" || prefix === "O") {
        radix = 8;
      } else if (prefix === "b" || prefix === "B") {
        radix = 2;
      }
      if (radix !== 0) {
        this.advanceCodeUnits(2);
        if (this.scanDigits(radix) === 0) {
          throw invalid();
        }
        if (this.source[this.position] === "n") {
          this.advanceCodeUnits(1);
          isBigInt = true;
        }
        this.checkNumberBoundary();
        return this.numberToken(start, line, column, isBigInt);
      }
      if (isDecimalDigit(prefix)) {
        throw invalid();
      }
    }
    this.scanDigits(10);
    let hasFraction = false;
    if (this.source[this.position] === "." && isDecimalDigit(this.source[this.position + 1])) {
      this.advanceCodeUnits(1);
      this.scanDigits(10);
      hasFraction = true;
    }
    let hasExponent = false;
    const exponentChar = this.source[this.position];
    if (exponentChar === "e" || exponentChar === "E") {
      this.advanceCodeUnits(1);
      const sign = this.source[this.position];
      if (sign === "+" || sign === "-") {
        this.advanceCodeUnits(1);
      }
      if (!isDecimalDigit(this.source[this.position])) {
        throw invalid();
      }
      this.scanDigits(10);
      hasExponent = true;
    }
    if (this.source[this.position] === "n") {
      if (hasFraction || hasExponent) {
        throw invalid();
      }
      this.advanceCodeUnits(1);
      isBigInt = true;
    }
    this.checkNumberBoundary();
    return this.numberToken(start, line, column, isBigInt);
  }

  private scanDigits(radix: number): number {
    let count = 0;
    let lastWasDigit = false;
    while (this.position < this.source.length) {
      const char = this.source[this.position];
      if (isDigitInRadix(char, radix)) {
        count += 1;
        lastWasDigit = true;
        this.advanceCodeUnits(1);
        continue;
      }
      if (char === "_") {
        if (!lastWasDigit || !isDigitInRadix(this.source[this.position + 1], radix)) {
          throw new LexError("invalid number", this.position, this.lineNumber, this.columnNumber);
        }
        lastWasDigit = false;
        this.advanceCodeUnits(1);
        continue;
      }
      break;
    }
    return count;
  }

  private checkNumberBoundary(): void {
    const next = this.currentChar();
    if (isIdentifierStart(next) || isDecimalDigit(next)) {
      throw new LexError("invalid number", this.position, this.lineNumber, this.columnNumber);
    }
  }

  private numberToken(start: number, line: number, column: number, isBigInt: boolean): Token {
    const text = this.source.slice(start, this.position);
    return {
      kind: isBigInt ? "bigint" : "number",
      text,
      value: text.replace(/_/g, ""),
      start,
      end: this.position,
      line,
      column,
    };
  }

  private scanString(): Token {
    const start = this.position;
    const line = this.lineNumber;
    const column = this.columnNumber;
    const quote = this.source[start];
    this.advanceCodeUnits(1);
    let value = "";
    while (this.position < this.source.length) {
      const char = this.currentChar();
      if (char === quote) {
        this.advanceCodeUnits(1);
        const text = this.source.slice(start, this.position);
        return { kind: "string", text, value, start, end: this.position, line, column };
      }
      if (char === "\n" || char === "\r") {
        throw new LexError("unterminated string", start, line, column);
      }
      if (char === "\\") {
        const next = this.source[this.position + 1];
        if (next === "\n" || next === "\r") {
          this.advance();
          this.advance();
          continue;
        }
        value += this.scanStringEscape();
        continue;
      }
      value += char;
      this.position += char.length;
      this.columnNumber += 1;
    }
    throw new LexError("unterminated string", start, line, column);
  }

  private scanStringEscape(): string {
    const offset = this.position;
    const line = this.lineNumber;
    const column = this.columnNumber;
    this.advanceCodeUnits(1);
    const char = this.source[this.position];
    if (char === undefined) {
      throw new LexError("unterminated string", offset, line, column);
    }
    const simple = simpleStringEscapes[char];
    if (simple !== undefined) {
      this.advanceCodeUnits(1);
      return simple;
    }
    if (char === "x") {
      const digits = this.source.slice(this.position + 1, this.position + 3);
      if (!twoHexDigitsPattern.test(digits)) {
        throw new LexError("invalid escape sequence", offset, line, column);
      }
      this.advanceCodeUnits(3);
      return String.fromCodePoint(Number.parseInt(digits, 16));
    }
    if (char === "u") {
      if (this.source[this.position + 1] === "{") {
        const braceEnd = this.source.indexOf("}", this.position + 2);
        const digits = braceEnd === -1 ? "" : this.source.slice(this.position + 2, braceEnd);
        if (digits.length < 1 || digits.length > 6 || !hexDigitsPattern.test(digits)) {
          throw new LexError("invalid escape sequence", offset, line, column);
        }
        const codePoint = Number.parseInt(digits, 16);
        if (codePoint > 0x10ffff) {
          throw new LexError("invalid escape sequence", offset, line, column);
        }
        this.advanceCodeUnits(braceEnd + 1 - this.position);
        return String.fromCodePoint(codePoint);
      }
      const digits = this.source.slice(this.position + 1, this.position + 5);
      if (!fourHexDigitsPattern.test(digits)) {
        throw new LexError("invalid escape sequence", offset, line, column);
      }
      this.advanceCodeUnits(5);
      return String.fromCodePoint(Number.parseInt(digits, 16));
    }
    const next = this.currentChar();
    this.position += next.length;
    this.columnNumber += 1;
    return next;
  }

  private scanRegex(): Token {
    const start = this.position;
    const line = this.lineNumber;
    const column = this.columnNumber;
    const unterminated = (): LexError =>
      new LexError("unterminated regular expression", start, line, column);
    this.advanceCodeUnits(1);
    let inClass = false;
    let terminated = false;
    while (this.position < this.source.length) {
      const char = this.currentChar();
      if (char === "\n" || char === "\r") {
        throw unterminated();
      }
      if (char === "\\") {
        const next = this.source[this.position + 1];
        if (next === undefined || next === "\n" || next === "\r") {
          throw unterminated();
        }
        this.advanceCodeUnits(1);
        const escaped = this.currentChar();
        this.position += escaped.length;
        this.columnNumber += 1;
        continue;
      }
      if (inClass) {
        if (char === "]") {
          inClass = false;
        }
      } else if (char === "[") {
        inClass = true;
      } else if (char === "/") {
        this.advanceCodeUnits(1);
        terminated = true;
        break;
      }
      this.position += char.length;
      this.columnNumber += 1;
    }
    if (!terminated) {
      throw unterminated();
    }
    while (this.position < this.source.length) {
      const flag = this.currentChar();
      if (!isIdentifierPart(flag)) {
        break;
      }
      this.position += flag.length;
      this.columnNumber += 1;
    }
    const text = this.source.slice(start, this.position);
    return { kind: "regex", text, value: text, start, end: this.position, line, column };
  }

  private scanTemplatePart(fromBacktick: boolean): Token {
    const start = this.position;
    const line = this.lineNumber;
    const column = this.columnNumber;
    const unterminated = (): LexError =>
      new LexError("unterminated template literal", start, line, column);
    this.advanceCodeUnits(1);
    for (;;) {
      if (this.position >= this.source.length) {
        throw unterminated();
      }
      const char = this.currentChar();
      if (char === "\\") {
        this.advanceCodeUnits(1);
        if (this.position >= this.source.length) {
          throw unterminated();
        }
        this.advanceTemplateUnit();
        continue;
      }
      if (char === "`") {
        this.advanceCodeUnits(1);
        const text = this.source.slice(start, this.position);
        return {
          kind: fromBacktick ? "no-substitution-template" : "template-tail",
          text,
          value: text,
          start,
          end: this.position,
          line,
          column,
        };
      }
      if (char === "$" && this.source[this.position + 1] === "{") {
        this.advanceCodeUnits(2);
        const text = this.source.slice(start, this.position);
        return {
          kind: fromBacktick ? "template-head" : "template-middle",
          text,
          value: text,
          start,
          end: this.position,
          line,
          column,
        };
      }
      this.advanceTemplateUnit();
    }
  }

  private advanceTemplateUnit(): void {
    const char = this.currentChar();
    if (char === "\n" || char === "\r") {
      this.advance();
      return;
    }
    this.position += char.length;
    this.columnNumber += 1;
  }

  private advance(): void {
    const char = this.source[this.position];
    if (char === "\r" && this.source[this.position + 1] === "\n") {
      this.position += 2;
      this.lineNumber += 1;
      this.columnNumber = 1;
      return;
    }
    if (char === "\n") {
      this.position += 1;
      this.lineNumber += 1;
      this.columnNumber = 1;
      return;
    }
    this.position += 1;
    this.columnNumber += 1;
  }

  private advanceCodeUnits(count: number): void {
    this.position += count;
    this.columnNumber += count;
  }

  private currentChar(): string {
    const codePoint = this.source.codePointAt(this.position);
    return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
  }
}

export function tokenize(source: string): Token[] {
  const lexer = new Lexer(source);
  const tokens: Token[] = [];
  let previous: Token | undefined = undefined;
  const templateBraces: number[] = [];
  for (;;) {
    let token = lexer.next();
    if (
      token.kind === "punctuator" &&
      (token.text === "/" || token.text === "/=") &&
      allowsRegexAfter(previous)
    ) {
      token = lexer.rescanRegex();
    }
    if (token.kind === "template-head") {
      templateBraces.push(0);
    } else if (token.kind === "punctuator" && templateBraces.length > 0) {
      const index = templateBraces.length - 1;
      const depth = templateBraces[index] ?? 0;
      if (token.text === "{") {
        templateBraces[index] = depth + 1;
      } else if (token.text === "}") {
        if (depth === 0) {
          const part = lexer.rescanTemplateToken();
          tokens.push(part);
          if (part.kind === "template-tail") {
            templateBraces.pop();
          }
          previous = part;
          continue;
        }
        templateBraces[index] = depth - 1;
      }
    }
    tokens.push(token);
    if (token.kind === "eof") {
      if (templateBraces.length > 0) {
        throw new LexError("unterminated template literal", token.start, token.line, token.column);
      }
      return tokens;
    }
    if (
      token.kind !== "whitespace" &&
      token.kind !== "line-comment" &&
      token.kind !== "block-comment"
    ) {
      previous = token;
    }
  }
}
