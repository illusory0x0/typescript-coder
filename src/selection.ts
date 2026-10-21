import type { EditPayload, EditRange } from "./loop";
import type { Locator, SymbolSpace } from "./utility";

/**
 * The matcher a compact clause carries: a verbatim source `snippet` or an
 * ECMA-262 `regex` pattern (no flags). `value` is already decoded: a `snippet`
 * has its `\`` and `\\` escapes resolved; a `regex` has `\/` decoded to `/`.
 */
export interface SelectionMatcher {
  kind: "snippet" | "regex";
  value: string;
}

/**
 * One parsed `select … end` clause. It is payload-equivalent to the JSON edit
 * model (`docs/editing-protocol.md`) only while `space` is null; a clause that
 * names a symbol space has no JSON form (see `toEditPayload`).
 * `replacement === null` is a **viewer** (no `replace`); `matcher === null`
 * means no `match`; `pick === null` means no `pick`. A parsed `pick` always has
 * a `replace`: `pick` without a `replace` is a syntax error.
 */
export interface Selection {
  locator: Locator;
  /**
   * The `resolve <value|type|namespace>` disambiguator. `null` means the clause
   * did not name a TypeScript symbol space and accepts any space.
   */
  space: SymbolSpace | null;
  matcher: SelectionMatcher | null;
  pick: EditRange[] | null;
  replacement: string | null;
}

/**
 * Sentinel `endColumn` for a range whose end is the end of its line: a bare
 * `line`, or a `line:col-line` span with no end column (`docs/edit-protocol.md`
 * §3 "Range arithmetic"). Columns are 1-based, so 0 is never a real position.
 */
export const END_OF_LINE_COLUMN = 0;

/** The `kind` keywords the grammar admits (all optional disambiguators). */
const SELECTION_KINDS: ReadonlySet<string> = new Set([
  "function",
  "const",
  "let",
  "var",
  "class",
  "type",
  "interface",
  "enum",
  "namespace",
]);

/** The `resolve` kinds the grammar admits: TypeScript symbol spaces. */
const SELECTION_SPACES: ReadonlySet<string> = new Set(["value", "type", "namespace"]);

/**
 * A malformed compact selection. Carries the loop's `stage:` style diagnostic
 * (`stage: syntax\n…`) and always names the offending field or clause.
 */
export class SelectionSyntaxError extends Error {
  readonly stage: "syntax" = "syntax";
  readonly diagnostics: string;

  constructor(detail: string) {
    const diagnostics = `stage: syntax\n${detail}`;
    super(diagnostics);
    this.name = "SelectionSyntaxError";
    this.diagnostics = diagnostics;
  }
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

function isWordChar(char: string): boolean {
  return (
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") ||
    char === "_" ||
    char === "$"
  );
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

/**
 * Hand-rolled recursive-descent reader for `docs/edit-protocol.md` §2. It
 * tokenizes on demand because the fence body is raw (whitespace is insignificant
 * everywhere else) and because a leading `` ` `` is a snippet or a fence
 * depending on the clause position.
 */
class SelectionReader {
  private readonly text: string;
  private pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  private get length(): number {
    return this.text.length;
  }

  private atEnd(): boolean {
    return this.pos >= this.length;
  }

  private skipWhitespace(): void {
    while (this.pos < this.length && isWhitespace(this.text[this.pos] ?? "")) {
      this.pos += 1;
    }
  }

  private keywordAt(word: string): boolean {
    if (!this.text.startsWith(word, this.pos)) {
      return false;
    }
    const after = this.pos + word.length;
    return after >= this.length || !isWordChar(this.text[after] ?? "");
  }

  private matchKeyword(word: string): boolean {
    this.skipWhitespace();
    if (!this.keywordAt(word)) {
      return false;
    }
    this.pos += word.length;
    return true;
  }

  private expectKeyword(word: string, detail: string): void {
    this.skipWhitespace();
    if (!this.keywordAt(word)) {
      throw new SelectionSyntaxError(detail);
    }
    this.pos += word.length;
  }

  private readToken(detail: string): string {
    this.skipWhitespace();
    const start = this.pos;
    while (this.pos < this.length && !isWhitespace(this.text[this.pos] ?? "")) {
      this.pos += 1;
    }
    if (this.pos === start) {
      throw new SelectionSyntaxError(detail);
    }
    return this.text.slice(start, this.pos);
  }

  parse(): Selection[] {
    const selections: Selection[] = [];
    for (;;) {
      this.skipWhitespace();
      if (this.atEnd()) {
        return selections;
      }
      if (!this.keywordAt("select")) {
        throw new SelectionSyntaxError(
          selections.length === 0
            ? "expected `select` to begin a clause"
            : "unexpected input after `end`; expected `select` or end of reply",
        );
      }
      selections.push(this.parseEditor());
    }
  }

  private parseEditor(): Selection {
    this.expectKeyword("select", "expected `select` to begin a clause");

    // `select [kind] <symbol> in <path> [resolve …]`: read the bare tokens
    // before `in` and disambiguate. One token is the symbol; two are
    // `<kind> <symbol>`.
    const header: string[] = [];
    for (;;) {
      this.skipWhitespace();
      if (this.atEnd()) {
        throw new SelectionSyntaxError("unterminated clause: expected `in <path>` and `end`");
      }
      if (this.keywordAt("in")) {
        break;
      }
      header.push(this.readToken("expected `in <path>` after the symbol in `select`"));
      if (header.length > 2) {
        throw new SelectionSyntaxError(
          "expected `select [kind] <symbol> in <path> [resolve …]`; too many tokens before `in`",
        );
      }
    }
    this.pos += 2; // consume `in`

    const path = this.readToken("expected a file path after `in`");

    let space: SymbolSpace | null = null;
    if (this.matchKeyword("resolve")) {
      space = this.parseSpace();
    }

    let kind = "";
    let name: string;
    if (header.length === 0) {
      throw new SelectionSyntaxError("expected a symbol after `select`");
    }
    if (header.length === 1) {
      name = header[0] ?? "";
    } else {
      const kindToken = header[0] ?? "";
      if (!SELECTION_KINDS.has(kindToken)) {
        throw new SelectionSyntaxError(
          `unknown kind \`${kindToken}\` in \`select\`; expected one of ${[...SELECTION_KINDS].join(", ")}`,
        );
      }
      kind = kindToken;
      name = header[1] ?? "";
    }

    let matcher: SelectionMatcher | null = null;
    if (this.matchKeyword("match")) {
      matcher = this.parseMatcher();
    }

    let pick: EditRange[] | null = null;
    if (this.matchKeyword("pick")) {
      pick = this.parseMultiRange();
    }

    let replacement: string | null = null;
    if (this.matchKeyword("replace")) {
      this.expectKeyword("with", "expected `with` after `replace`");
      replacement = this.parseFence();
    }

    this.expectKeyword("end", "expected `end` to terminate the clause");

    if (pick !== null && replacement === null) {
      throw new SelectionSyntaxError(
        "`pick` requires a `replace`: a `pick` without `replace` is not a viewer; add `replace with <fence>`, or omit `pick` and keep the viewer",
      );
    }

    return { locator: { path, name, kind }, space, matcher, pick, replacement };
  }

  private parseSpace(): SymbolSpace {
    const token = this.readToken("expected `value`, `type`, or `namespace` after `resolve`");
    if (!SELECTION_SPACES.has(token)) {
      throw new SelectionSyntaxError(
        `unknown \`resolve\` kind \`${token}\`; expected one of value, type, namespace`,
      );
    }
    return token as SymbolSpace;
  }

  private parseMatcher(): SelectionMatcher {
    this.skipWhitespace();
    const char = this.text[this.pos];
    if (char === "`") {
      return { kind: "snippet", value: this.parseSnippet() };
    }
    if (char === "/") {
      return { kind: "regex", value: this.parseRegex() };
    }
    throw new SelectionSyntaxError("expected a `snippet` or `/regex/` after `match`");
  }

  private parseSnippet(): string {
    this.pos += 1; // opening backtick
    let value = "";
    for (;;) {
      if (this.atEnd()) {
        throw new SelectionSyntaxError("unclosed `snippet`: expected a closing backtick");
      }
      const char = this.text[this.pos] ?? "";
      if (char === "\\") {
        const next = this.text[this.pos + 1];
        if (next === "`") {
          value += "`";
          this.pos += 2;
          continue;
        }
        if (next === "\\") {
          value += "\\";
          this.pos += 2;
          continue;
        }
        value += "\\";
        this.pos += 1;
        continue;
      }
      this.pos += 1;
      if (char === "`") {
        return value;
      }
      value += char;
    }
  }

  private parseRegex(): string {
    this.pos += 1; // opening slash
    let value = "";
    for (;;) {
      if (this.atEnd()) {
        throw new SelectionSyntaxError("unclosed `/regex/`: expected a closing slash");
      }
      const char = this.text[this.pos] ?? "";
      if (char === "\\") {
        const next = this.text[this.pos + 1];
        if (next === undefined) {
          throw new SelectionSyntaxError("unclosed `/regex/`: expected a closing slash");
        }
        this.pos += 2;
        value += next === "/" ? "/" : `\\${next}`;
        continue;
      }
      this.pos += 1;
      if (char === "/") {
        return value;
      }
      value += char;
    }
  }

  private parseMultiRange(): EditRange[] {
    this.skipWhitespace();
    if (this.text[this.pos] !== "{") {
      return [this.parseRange()];
    }
    this.pos += 1; // `{`
    const ranges: EditRange[] = [];
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] === "}") {
        throw new SelectionSyntaxError("`pick {…}` needs at least one range");
      }
      ranges.push(this.parseRange());
      this.skipWhitespace();
      const char = this.text[this.pos];
      if (char === ",") {
        this.pos += 1;
        continue;
      }
      if (char === "}") {
        this.pos += 1;
        return ranges;
      }
      throw new SelectionSyntaxError("expected `,` or `}` inside `pick {…}`");
    }
  }

  private parseRange(): EditRange {
    const line = this.parseCoordinate("line");
    this.skipWhitespace();
    let column: number | null = null;
    if (this.text[this.pos] === ":") {
      this.pos += 1;
      column = this.parseCoordinate("column");
      this.skipWhitespace();
    }
    if (this.text[this.pos] !== "-") {
      if (column === null) {
        // A bare line is the whole line.
        return { line, column: 1, endLine: line, endColumn: END_OF_LINE_COLUMN };
      }
      // `line:col` is the single character at that position.
      return { line, column, endLine: line, endColumn: column };
    }
    this.pos += 1; // `-`
    const endLine = this.parseCoordinate("line");
    this.skipWhitespace();
    let endColumn = END_OF_LINE_COLUMN;
    if (this.text[this.pos] === ":") {
      this.pos += 1;
      endColumn = this.parseCoordinate("column");
    }
    return { line, column: column ?? 1, endLine, endColumn };
  }

  private parseCoordinate(field: "line" | "column"): number {
    const start = this.pos;
    while (this.pos < this.length && isDigit(this.text[this.pos] ?? "")) {
      this.pos += 1;
    }
    if (this.pos === start) {
      throw new SelectionSyntaxError(`expected a 1-based ${field} in \`pick\``);
    }
    const value = Number(this.text.slice(start, this.pos));
    if (!Number.isInteger(value) || value < 1) {
      throw new SelectionSyntaxError(`\`pick\` ${field} must be a positive (1-based) integer`);
    }
    return value;
  }

  private parseFence(): string {
    this.skipWhitespace();
    let open = 0;
    while (this.text[this.pos] === "`") {
      open += 1;
      this.pos += 1;
    }
    if (open < 6) {
      throw new SelectionSyntaxError(
        "expected a fence opening with at least 6 backticks after `replace with`",
      );
    }
    // The opening run must end its line; the body is raw until a closing line.
    let lineEnd = this.pos;
    while (lineEnd < this.length && (this.text[lineEnd] === " " || this.text[lineEnd] === "\t")) {
      lineEnd += 1;
    }
    if (lineEnd < this.length && this.text[lineEnd] === "\r") {
      lineEnd += 1;
    }
    if (lineEnd >= this.length || this.text[lineEnd] !== "\n") {
      throw new SelectionSyntaxError(
        "malformed fence: the opening backticks must be followed by a newline",
      );
    }
    const bodyStart = lineEnd + 1;
    let lineStart = bodyStart;
    for (;;) {
      let end = this.text.indexOf("\n", lineStart);
      if (end === -1) {
        end = this.length;
      }
      const line = this.text.slice(lineStart, end).replace(/\r$/, "");
      if (isClosingFence(line, open)) {
        let body = this.text.slice(bodyStart, lineStart);
        if (body.endsWith("\r\n")) {
          body = body.slice(0, -2);
        } else if (body.endsWith("\n") || body.endsWith("\r")) {
          body = body.slice(0, -1);
        }
        if (longestBacktickRun(body) >= 3) {
          throw new SelectionSyntaxError("fence body contains a run of 3 or more backticks");
        }
        this.pos = end >= this.length ? this.length : end + 1;
        return body;
      }
      if (end >= this.length) {
        throw new SelectionSyntaxError("unclosed fence: expected a closing backtick run");
      }
      lineStart = end + 1;
    }
  }
}

function isClosingFence(line: string, open: number): boolean {
  const trimmed = line.replace(/[ \t]+$/, "");
  if (trimmed.length !== open) {
    return false;
  }
  for (const char of trimmed) {
    if (char !== "`") {
      return false;
    }
  }
  return true;
}

/**
 * Parse a compact reply (`docs/edit-protocol.md` §2): zero or more `select … end`
 * clauses. Returns one `Selection` per clause (an empty reply returns `[]`). Any malformed
 * input throws a `SelectionSyntaxError` naming the offending field; a partial
 * selection is never returned.
 */
export function parseSelection(text: string): Selection[] {
  return new SelectionReader(text).parse();
}

function escapeSnippet(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

function escapeRegex(value: string): string {
  return value.replace(/\//g, "\\/");
}

function renderMatcher(matcher: SelectionMatcher): string {
  return matcher.kind === "snippet"
    ? `\`${escapeSnippet(matcher.value)}\``
    : `/${escapeRegex(matcher.value)}/`;
}

function renderRange(range: EditRange): string {
  const { line, column, endLine, endColumn } = range;
  if (endColumn === END_OF_LINE_COLUMN) {
    if (endLine === line && column === 1) {
      return `${line}`;
    }
    return column === 1 ? `${line}-${endLine}` : `${line}:${column}-${endLine}`;
  }
  if (endLine === line && endColumn === column) {
    return `${line}:${column}`;
  }
  return column === 1
    ? `${line}-${endLine}:${endColumn}`
    : `${line}:${column}-${endLine}:${endColumn}`;
}

function renderMultiRange(pick: EditRange[]): string {
  if (pick.length === 1) {
    return renderRange(pick[0] as EditRange);
  }
  return `{${pick.map(renderRange).join(", ")}}`;
}

function longestBacktickRun(body: string): number {
  let longest = 0;
  let current = 0;
  for (const char of body) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function renderFence(body: string): string {
  if (longestBacktickRun(body) >= 3) {
    throw new SelectionSyntaxError(
      "cannot serialize a fence body containing a run of 3 or more backticks",
    );
  }
  const ticks = "`".repeat(6);
  return `${ticks}\n${body}\n${ticks}`;
}

/** Render one selection back to the compact grammar (one `select … end` clause). */
export function serializeSelection(selection: Selection): string {
  const { locator } = selection;
  let head =
    locator.kind === ""
      ? `select ${locator.name} in ${locator.path}`
      : `select ${locator.kind} ${locator.name} in ${locator.path}`;
  if (selection.space !== null) {
    head += ` resolve ${selection.space}`;
  }
  const parts = [head];
  if (selection.matcher !== null) {
    parts.push(`match ${renderMatcher(selection.matcher)}`);
  }
  if (selection.pick !== null) {
    parts.push(`pick ${renderMultiRange(selection.pick)}`);
  }
  if (selection.replacement !== null) {
    parts.push("replace with", renderFence(selection.replacement));
  }
  parts.push("end");
  return parts.join("\n");
}

/** Render several clauses, one blank line apart (the §8 multi-clause layout). */
export function serializeSelections(selections: Selection[]): string {
  return selections.map(serializeSelection).join("\n\n");
}

/**
 * The explicit bridge to the shipped JSON payload (`docs/edit-protocol.md` §9).
 * Returns an `EditPayload` only for the subset the payload can express: a
 * `snippet` or no matcher, no `pick` or a single range, and an editor (a
 * `replace`). Regex matchers, a multi-range `pick`, and viewers have no payload
 * form and return `null`.
 */
export function toEditPayload(selection: Selection): EditPayload | null {
  if (selection.replacement === null) {
    return null;
  }
  if (selection.space !== null) {
    return null;
  }
  if (selection.matcher !== null && selection.matcher.kind !== "snippet") {
    return null;
  }
  if (selection.pick !== null && selection.pick.length !== 1) {
    return null;
  }
  return {
    locator: selection.locator,
    matcher: selection.matcher === null ? null : selection.matcher.value,
    range: selection.pick === null ? null : (selection.pick[0] ?? null),
    replacement: selection.replacement,
  };
}
