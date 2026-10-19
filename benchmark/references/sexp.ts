export type Sexp = string | number | Sexp[];

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function isDelimiter(char: string | undefined): boolean {
  return char === undefined || isWhitespace(char) || char === "(" || char === ")";
}

class SexpParser {
  private position = 0;

  constructor(private readonly text: string) {}

  parse(): Sexp {
    this.skipWhitespace();
    const value = this.parseExpression();
    this.skipWhitespace();
    if (this.position !== this.text.length) {
      throw new SyntaxError(`unexpected trailing input at position ${this.position}`);
    }
    return value;
  }

  private skipWhitespace(): void {
    while (isWhitespace(this.text[this.position])) {
      this.position += 1;
    }
  }

  private parseExpression(): Sexp {
    const char = this.text[this.position];
    if (char === undefined) {
      throw new SyntaxError("unexpected end of input");
    }
    if (char === "(") {
      return this.parseList();
    }
    if (char === ")") {
      throw new SyntaxError(`unexpected ')' at position ${this.position}`);
    }
    return this.parseAtom();
  }

  private parseList(): Sexp[] {
    this.position += 1;
    const items: Sexp[] = [];
    for (;;) {
      this.skipWhitespace();
      const char = this.text[this.position];
      if (char === undefined) {
        throw new SyntaxError("unterminated list");
      }
      if (char === ")") {
        this.position += 1;
        return items;
      }
      items.push(this.parseExpression());
    }
  }

  private parseAtom(): Sexp {
    const start = this.position;
    while (!isDelimiter(this.text[this.position])) {
      this.position += 1;
    }
    const text = this.text.slice(start, this.position);
    if (/^-?\d+(?:\.\d+)?$/.test(text)) {
      return Number(text);
    }
    return text;
  }
}

export function parseSexp(text: string): Sexp {
  return new SexpParser(text).parse();
}

// Canonical printing paired with parseSexp for round-trip tests (#68): atoms
// print verbatim and lists print space-separated in parens, so
// parseSexp(printSexp(value)) deep-equals `value` for any parsed value.
export function printSexp(value: Sexp): string {
  if (Array.isArray(value)) {
    return `(${value.map(printSexp).join(" ")})`;
  }
  return String(value);
}
