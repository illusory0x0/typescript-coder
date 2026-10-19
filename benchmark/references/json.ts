export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

class JsonParser {
  private position = 0;

  constructor(private readonly text: string) {}

  parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.position !== this.text.length) {
      throw new SyntaxError(`unexpected trailing input at position ${this.position}`);
    }
    return value;
  }

  private peek(): string | undefined {
    return this.text[this.position];
  }

  private skipWhitespace(): void {
    for (;;) {
      const char = this.peek();
      if (char === undefined || !WHITESPACE.has(char)) {
        return;
      }
      this.position += 1;
    }
  }

  private parseValue(): JsonValue {
    const char = this.peek();
    switch (char) {
      case undefined: {
        throw new SyntaxError("unexpected end of input");
      }
      case "{": {
        return this.parseObject();
      }
      case "[": {
        return this.parseArray();
      }
      case '"': {
        return this.parseString();
      }
      case "t": {
        return this.parseLiteral("true", true);
      }
      case "f": {
        return this.parseLiteral("false", false);
      }
      case "n": {
        return this.parseLiteral("null", null);
      }
      default: {
        if (char === "-" || isDigit(char)) {
          return this.parseNumber();
        }
        throw new SyntaxError(
          `unexpected character ${JSON.stringify(char)} at position ${this.position}`,
        );
      }
    }
  }

  private parseLiteral<T extends JsonValue>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.position)) {
      throw new SyntaxError(`invalid literal at position ${this.position}`);
    }
    this.position += word.length;
    return value;
  }

  private parseNumber(): number {
    const start = this.position;
    if (this.peek() === "-") {
      this.position += 1;
    }
    const first = this.peek();
    if (first === "0") {
      this.position += 1;
    } else if (first !== undefined && first >= "1" && first <= "9") {
      this.position += 1;
      while (isDigit(this.peek())) {
        this.position += 1;
      }
    } else {
      throw new SyntaxError(`invalid number at position ${start}`);
    }
    if (this.peek() === ".") {
      this.position += 1;
      if (!isDigit(this.peek())) {
        throw new SyntaxError(`invalid number at position ${start}`);
      }
      while (isDigit(this.peek())) {
        this.position += 1;
      }
    }
    const exponent = this.peek();
    if (exponent === "e" || exponent === "E") {
      this.position += 1;
      const sign = this.peek();
      if (sign === "+" || sign === "-") {
        this.position += 1;
      }
      if (!isDigit(this.peek())) {
        throw new SyntaxError(`invalid number at position ${start}`);
      }
      while (isDigit(this.peek())) {
        this.position += 1;
      }
    }
    return Number(this.text.slice(start, this.position));
  }

  private parseString(): string {
    this.position += 1;
    let result = "";
    for (;;) {
      const char = this.peek();
      if (char === undefined) {
        throw new SyntaxError("unterminated string");
      }
      this.position += 1;
      if (char === '"') {
        return result;
      }
      if (char !== "\\") {
        result += char;
        continue;
      }
      const escape = this.peek();
      if (escape === undefined) {
        throw new SyntaxError("unterminated escape sequence");
      }
      this.position += 1;
      switch (escape) {
        case '"': {
          result += '"';
          break;
        }
        case "\\": {
          result += "\\";
          break;
        }
        case "/": {
          result += "/";
          break;
        }
        case "b": {
          result += "\b";
          break;
        }
        case "f": {
          result += "\f";
          break;
        }
        case "n": {
          result += "\n";
          break;
        }
        case "r": {
          result += "\r";
          break;
        }
        case "t": {
          result += "\t";
          break;
        }
        case "u": {
          const hex = this.text.slice(this.position, this.position + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new SyntaxError(`invalid unicode escape at position ${this.position}`);
          }
          result += String.fromCharCode(Number.parseInt(hex, 16));
          this.position += 4;
          break;
        }
        default: {
          throw new SyntaxError(`invalid escape sequence at position ${this.position}`);
        }
      }
    }
  }

  private parseArray(): JsonValue[] {
    this.position += 1;
    const items: JsonValue[] = [];
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.position += 1;
      return items;
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.parseValue());
      this.skipWhitespace();
      const char = this.peek();
      if (char === ",") {
        this.position += 1;
        continue;
      }
      if (char === "]") {
        this.position += 1;
        return items;
      }
      throw new SyntaxError(`expected ',' or ']' at position ${this.position}`);
    }
  }

  private parseObject(): { [key: string]: JsonValue } {
    this.position += 1;
    const result: { [key: string]: JsonValue } = {};
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.position += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== '"') {
        throw new SyntaxError(`expected object key at position ${this.position}`);
      }
      const key = this.parseString();
      this.skipWhitespace();
      if (this.peek() !== ":") {
        throw new SyntaxError(`expected ':' at position ${this.position}`);
      }
      this.position += 1;
      this.skipWhitespace();
      result[key] = this.parseValue();
      this.skipWhitespace();
      const char = this.peek();
      if (char === ",") {
        this.position += 1;
        continue;
      }
      if (char === "}") {
        this.position += 1;
        return result;
      }
      throw new SyntaxError(`expected ',' or '}' at position ${this.position}`);
    }
  }
}

export function parseJson(text: string): JsonValue {
  return new JsonParser(text).parse();
}

// Canonical, deterministic printing paired with parseJson for round-trip tests
// (#68). Scalars reuse JSON.stringify's escaping semantics; containers are
// emitted compactly with a stable key order (insertion order), so
// parseJson(printJson(value)) deep-equals `value`.
export function printJson(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(printJson).join(",")}]`;
  }
  const entries = Object.keys(value).map(
    (key) => `${JSON.stringify(key)}:${printJson(value[key]!)}`,
  );
  return `{${entries.join(",")}}`;
}
