import type { EditPayload, EditRange } from "./loop";
import type { Locator, SymbolSpace } from "./utility";
import { positionAtOffset, renderDslIssues } from "./dsl-diagnostics";
import type { DslIssue, DslParseResult } from "./dsl-diagnostics";

/**
 * The matcher an edit-dsl clause carries: a verbatim source `snippet` or an
 * ECMA-262 `regex` pattern (no flags). `value` is already decoded: a `snippet`
 * has its `\`` and `\\` escapes resolved; a `regex` has `\/` decoded to `/`.
 */
export interface SelectionMatcher {
  kind: "snippet" | "regex";
  value: string;
}

/** The `rename <from> to <to>` renamer clause: a semantic rename, not a rewrite. */
export interface RenameSpec {
  from: string;
  to: string;
}

/**
 * One parsed `select … end` clause. It is payload-equivalent to the JSON edit
 * model (`docs/editing-protocol.md`) only while `space` is null; a clause that
 * names a symbol space has no JSON form (see `toEditPayload`).
 * `replacement === null` is a **viewer** (no `replace`); `matcher === null`
 * means no `match`; `pick === null` means no `pick`. A parsed `pick` always has
 * a `replace`: `pick` without a `replace` is a syntax error. `rename` is the
 * replacer's alternative (`rename <from> to <to>`), absent when the clause has
 * no renamer.
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
  rename?: RenameSpec | null;
}

/** A `create <path> end` file command. */
export interface CreateFileStatement {
  op: "create";
  path: string;
}

/** A `delete <path> end` file command. */
export interface DeleteFileStatement {
  op: "delete";
  path: string;
}

/** A `read <path> [within <selecters>] end` viewer command. */
export interface ReadFileStatement {
  op: "read";
  path: string;
  ranges: EditRange[] | null;
}

/**
 * A `write <path> [within <selecters>] with <sentinel fence>` file command.
 * The sentinel close terminates the statement: a `write` has no trailing
 * `end` (or retired `done`).
 */
export interface WriteFileStatement {
  op: "write";
  path: string;
  ranges: EditRange[] | null;
  replacement: string;
}

export type FileStatement =
  | CreateFileStatement
  | DeleteFileStatement
  | ReadFileStatement
  | WriteFileStatement;

/** One parsed reply statement: a symbol editor or a raw file command. */
export type EditStatement =
  | { type: "editor"; selection: Selection }
  | { type: "fs"; statement: FileStatement };

/**
 * Sentinel `endColumn` for a range whose end is the end of its line: a bare
 * `line`, or a `line:col-line` span with no end column (`docs/edit-protocol.md`
 * §3 "Range arithmetic"). Columns are 1-based, so 0 is never a real position.
 */
export const END_OF_LINE_COLUMN = 0;

/**
 * The one edit-action fence (`docs/edit-protocol.md` §2): raw body text between
 * two sentinel lines. Each marker is a whole line, optionally indented or with
 * trailing whitespace; the body is otherwise raw and only the exact end marker
 * terminates it.
 */
export const EDIT_FENCE_BEGIN = "<<<TC_EDIT_BEGIN>>>";
export const EDIT_FENCE_END = "<<<TC_EDIT_END>>>";

/** True for a legacy 5+ hyphen or 6+ backtick fence line (removed wire form). */
export function isLegacyEditFence(line: string): boolean {
  const trimmed = line.trim();
  return /^-{5,}$/.test(trimmed) || /^`{6,}$/.test(trimmed);
}

/** True when `text` contains an exact end-marker line, which no body may carry. */
export function containsEditFenceEnd(text: string): boolean {
  return text.split(/\r\n?|\n/).some((line) => line.trim() === EDIT_FENCE_END);
}

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
 * A malformed edit-dsl selection. Carries the loop's `stage:` style diagnostic
 * (`stage: syntax\n…`), the structured issues the shared renderer produced, and
 * always names the offending field or clause.
 */
export class SelectionSyntaxError extends Error {
  readonly stage: "syntax" = "syntax";
  readonly diagnostics: string;
  readonly detail: string;
  /** Reader offset where the first failure was detected, or null outside a parse. */
  readonly offset: number | null;
  /** Every issue found before the reply was rejected (bounded by the renderer). */
  readonly issues: readonly DslIssue[];
  readonly truncated: boolean;

  constructor(
    detail: string,
    offset: number | null = null,
    issues: readonly DslIssue[] = [],
    truncated = false,
  ) {
    const diagnostics = issues.length === 0 ? `stage: syntax\n${detail}` : renderDslIssues(issues);
    super(diagnostics);
    this.name = "SelectionSyntaxError";
    this.diagnostics = diagnostics;
    this.detail = detail;
    this.offset = offset;
    this.issues = issues;
    this.truncated = truncated;
  }

  /** Return the same diagnostic with the reader position attached. */
  withOffset(offset: number): SelectionSyntaxError {
    return this.offset === null
      ? new SelectionSyntaxError(this.detail, offset, this.issues, this.truncated)
      : this;
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
  private readonly issues: DslIssue[] = [];
  private truncated = false;
  private clauseIndex = 0;
  /** True after a fence close, so unexpected trailing text can name the cause. */
  private lastFenceClosed = false;

  constructor(text: string, initialIssues: readonly DslIssue[] = []) {
    this.text = text;
    this.issues.push(...initialIssues);
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

  private issue(
    severity: "error" | "warning",
    code: string,
    message: string,
    options: {
      offset?: number;
      expected?: string[];
      found?: string;
      hint?: string;
      clauseIndex?: number;
    } = {},
  ): DslIssue {
    const offset = options.offset ?? this.pos;
    const { line, column } = positionAtOffset(this.text, offset);
    return {
      severity,
      stage: "syntax",
      code,
      message,
      line,
      column,
      excerpt: this.text,
      ...(options.expected === undefined ? {} : { expected: options.expected }),
      ...(options.found === undefined ? {} : { found: options.found }),
      ...(options.hint === undefined ? {} : { hint: options.hint }),
      recovered: severity === "warning",
      ...(options.clauseIndex === undefined && this.clauseIndex === 0
        ? {}
        : { clauseIndex: options.clauseIndex ?? this.clauseIndex }),
    };
  }

  private warn(
    code: string,
    message: string,
    options: {
      offset?: number;
      expected?: string[];
      found?: string;
      hint?: string;
    } = {},
  ): void {
    this.issues.push(this.issue("warning", code, message, options));
  }

  private syntax(
    code: string,
    detail: string,
    options: {
      offset?: number;
      expected?: string[];
      found?: string;
      hint?: string;
    } = {},
  ): never {
    const issue = this.issue("error", code, detail, options);
    throw new SelectionSyntaxError(detail, options.offset ?? this.pos, [issue], this.truncated);
  }

  private expectKeyword(word: string, detail: string): void {
    this.skipWhitespace();
    if (!this.keywordAt(word)) {
      this.syntax("EDIT_MISSING_FIELD", detail, {
        expected: [word],
        found: this.peekToken(),
      });
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
      this.syntax("EDIT_MISSING_FIELD", detail, { found: this.peekToken() });
    }
    return this.text.slice(start, this.pos);
  }

  private peekToken(): string {
    const start = this.pos;
    let end = start;
    while (end < this.length && !isWhitespace(this.text[end] ?? "")) {
      end += 1;
    }
    return end === start ? "<eof>" : this.text.slice(start, end);
  }

  private statementStartAt(): boolean {
    return (
      this.keywordAt("select") ||
      this.keywordAt("create") ||
      this.keywordAt("delete") ||
      this.keywordAt("read") ||
      this.keywordAt("write")
    );
  }

  detailedSelection(): DslParseResult<Selection[]> {
    const result = this.parseDetailed("selection");
    return { ...result, value: (result.value as unknown as Selection[] | undefined) ?? [] };
  }

  detailedMulti(): DslParseResult<EditStatement[]> {
    const result = this.parseDetailed("multi");
    return { ...result, value: (result.value as unknown as EditStatement[] | undefined) ?? [] };
  }

  private parseDetailed(
    mode: "selection" | "multi",
  ): DslParseResult<Selection[] | EditStatement[]> {
    const value: (Selection | EditStatement)[] = [];
    for (;;) {
      this.skipWhitespace();
      if (this.atEnd()) {
        break;
      }
      this.clauseIndex += 1;
      const attempt = this.clauseIndex;
      // `lastFenceClosed` is per-statement parse context; never let a previous
      // statement's fence colour this one's missing-end diagnostics.
      this.lastFenceClosed = false;
      try {
        if (mode === "selection") {
          if (!this.keywordAt("select")) {
            if (this.keywordAt("done")) {
              this.rejectRetiredDone(
                "`done` is no longer an edit-action terminator: a clause ends with `end`",
                "remove `done`; select clauses end with `end`",
              );
            }
            this.syntax(
              "EDIT_MISSING_FIELD",
              value.length === 0
                ? "expected `select` to begin a clause"
                : "unexpected input after `end`; expected `select` or end of reply",
              {
                expected: ["select"],
                found: this.peekToken(),
                hint: "reply with one or more `select … end` clauses",
              },
            );
          }
          value.push(this.parseEditor());
          continue;
        }
        if (this.keywordAt("select")) {
          value.push({ type: "editor", selection: this.parseEditor() });
          continue;
        }
        if (this.keywordAt("create")) {
          value.push({ type: "fs", statement: this.parseCreate() });
          continue;
        }
        if (this.keywordAt("delete")) {
          value.push({ type: "fs", statement: this.parseDelete() });
          continue;
        }
        if (this.keywordAt("read")) {
          value.push({ type: "fs", statement: this.parseRead() });
          continue;
        }
        if (this.keywordAt("write")) {
          value.push({ type: "fs", statement: this.parseWrite() });
          continue;
        }
        if (this.keywordAt("done")) {
          this.rejectRetiredDone(
            "`done` is no longer an edit-action terminator: clauses end with `end`, and a `write` ends at its sentinel close",
            "remove `done`; use `end` for a clause or file command, and no terminator after a `write`",
            ["select", "create", "delete", "read", "write"],
          );
        }
        this.syntax(
          "EDIT_MISSING_FIELD",
          value.length === 0
            ? "expected `select`, `create`, `delete`, `read`, or `write` to begin a statement"
            : "unexpected input after a statement; expected `select`, `create`, `delete`, `read`, or `write`",
          {
            expected: ["select", "create", "delete", "read", "write"],
            found: this.peekToken(),
            hint: "start a new clause or file command",
          },
        );
      } catch (error) {
        if (!(error instanceof SelectionSyntaxError)) {
          throw error;
        }
        for (const issue of error.issues) {
          this.issues.push({
            ...issue,
            clauseIndex: issue.clauseIndex ?? attempt,
          });
        }
        if (error.truncated) {
          this.truncated = true;
          break;
        }
        if (!this.recoverToNextStatement()) {
          break;
        }
      }
    }
    const ok = !this.issues.some((issue) => issue.severity === "error");
    const typed = mode === "selection" ? (value as Selection[]) : (value as EditStatement[]);
    return { ok, value: typed, issues: this.issues, truncated: this.truncated };
  }

  /**
   * Skip a malformed statement to the next top-level clause/command keyword.
   * A sentinel body is skipped whole so a `select` inside a replacement body is
   * never mistaken for a boundary (#33).
   */
  private recoverToNextStatement(): boolean {
    let start = this.text.indexOf("\n", this.pos);
    if (start === -1) {
      this.pos = this.length;
      return false;
    }
    start += 1;
    let inBody = false;
    for (;;) {
      let end = this.text.indexOf("\n", start);
      if (end === -1) {
        end = this.length;
      }
      const line = this.text.slice(start, end).replace(/\r$/, "");
      const trimmed = line.trim();
      if (inBody) {
        if (trimmed === EDIT_FENCE_END) {
          inBody = false;
        }
      } else if (trimmed === EDIT_FENCE_BEGIN) {
        inBody = true;
      } else if (/^(select|create|delete|read|write)\b/.test(trimmed)) {
        this.pos = start;
        return true;
      }
      if (end >= this.length) {
        this.pos = this.length;
        return false;
      }
      start = end + 1;
    }
  }

  /**
   * Reject a retired `done` used as an edit-action terminator. The grammar has
   * no `done`: the diagnostic always points at `end`, or at the sentinel close
   * for a `write`, instead of silently accepting the old form.
   */
  private rejectRetiredDone(detail: string, hint: string, expected: string[] = ["end"]): never {
    this.syntax("EDIT_RETIRED_DONE", detail, { expected, found: "done", hint });
  }

  private parseCreate(): CreateFileStatement {
    this.expectKeyword("create", "expected `create` to begin a file command");
    const path = this.readToken("expected a file path after `create`");
    this.consumeEnd("`create` command");
    return { op: "create", path };
  }

  private parseDelete(): DeleteFileStatement {
    this.expectKeyword("delete", "expected `delete` to begin a file command");
    const path = this.readToken("expected a file path after `delete`");
    this.consumeEnd("`delete` command");
    return { op: "delete", path };
  }

  private parseRead(): ReadFileStatement {
    this.expectKeyword("read", "expected `read` to begin a file command");
    const path = this.readToken("expected a file path after `read`");
    const ranges = this.parseWithin();
    this.consumeEnd("`read` command");
    return { op: "read", path, ranges };
  }

  private parseWrite(): WriteFileStatement {
    this.expectKeyword("write", "expected `write` to begin a file command");
    const path = this.readToken("expected a file path after `write`");
    const ranges = this.parseWithin();
    this.expectKeyword("with", "expected `with` before the fence in a `write` command");
    this.lastFenceClosed = false;
    const replacement = this.parseFence();
    this.skipWhitespace();
    if (!this.atEnd()) {
      if (this.keywordAt("done")) {
        this.rejectRetiredDone(
          `\`done\` is no longer a terminator: a \`write\` ends at its ${EDIT_FENCE_END} close`,
          `remove \`done\`; the sentinel close ${EDIT_FENCE_END} already terminates the write`,
          [EDIT_FENCE_END],
        );
      }
      if (this.keywordAt("end")) {
        this.syntax(
          "EDIT_STRAY_END",
          `a \`write\` ends at its ${EDIT_FENCE_END} close; the trailing \`end\` has no open statement to close`,
          {
            expected: [EDIT_FENCE_END],
            found: "end",
            hint: `remove the trailing \`end\`; the sentinel close ${EDIT_FENCE_END} already terminates the write`,
          },
        );
      }
      if (!this.statementStartAt()) {
        this.syntax(
          "EDIT_EMBEDDED_FENCE_END",
          `the write body contains the literal line ${EDIT_FENCE_END}; a fence body cannot carry the end marker, and no text may follow the close on its line`,
          {
            expected: [EDIT_FENCE_END],
            found: this.peekToken(),
            hint: `close the body with ${EDIT_FENCE_END} on its own line; the sentinel close terminates the write`,
          },
        );
      }
    }
    this.lastFenceClosed = false;
    return { op: "write", path, ranges, replacement };
  }

  private parseWithin(): EditRange[] | null {
    if (!this.matchKeyword("within")) {
      return null;
    }
    return this.parseMultiRange("within");
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
        this.syntax("EDIT_MISSING_FIELD", "unterminated clause: expected `in <path>` and `end`", {
          expected: ["in <path>", "end"],
          found: "<eof>",
          hint: "complete the select header and close the clause with end",
        });
      }
      if (this.keywordAt("in")) {
        break;
      }
      header.push(this.readToken("expected `in <path>` after the symbol in `select`"));
      if (header.length > 2) {
        this.syntax(
          "EDIT_UNKNOWN_FIELD",
          "expected `select [kind] <symbol> in <path> [resolve …]`; too many tokens before `in`",
          {
            expected: ["select [kind] <symbol> in <path>"],
            found: header.at(-1) ?? "<eof>",
            hint: "keep at most a kind and a symbol before `in`",
          },
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
      this.syntax("EDIT_MISSING_FIELD", "expected a symbol after `select`", {
        expected: ["<symbol>"],
        found: this.peekToken(),
      });
    }
    if (header.length === 1) {
      name = header[0] ?? "";
    } else {
      const kindToken = header[0] ?? "";
      if (!SELECTION_KINDS.has(kindToken)) {
        this.syntax(
          "EDIT_UNKNOWN_FIELD",
          `unknown kind \`${kindToken}\` in \`select\`; expected one of ${[...SELECTION_KINDS].join(", ")}`,
          {
            expected: [...SELECTION_KINDS],
            found: kindToken,
            hint: "omit the declaration kind or use one of the listed kinds",
          },
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
    let pickOffset: number | undefined;
    let replacement: string | null = null;
    let rename: RenameSpec | null = null;

    // The grammar places `match` before `replacer | renamer`, so a rename is
    // the alternative branch after the optional match, not a suffix of a
    // replace.
    if (this.matchKeyword("rename")) {
      rename = this.parseRename();
      this.skipWhitespace();
      if (this.keywordAt("pick")) {
        this.syntax(
          "EDIT_RENAME_MIXED",
          "rename cannot be combined with `pick`; use either `rename <from> to <to>` or `pick … replace with …`",
          {
            expected: ["rename <from> to <to>", "pick … replace with …"],
            found: "pick",
            hint: "choose one replacer, not both",
          },
        );
      }
      if (this.keywordAt("replace")) {
        this.syntax(
          "EDIT_RENAME_MIXED",
          "rename cannot be combined with `replace`; use either `rename <from> to <to>` or `pick … replace with …`",
          {
            expected: ["rename <from> to <to>", "pick … replace with …"],
            found: "replace",
            hint: "choose one replacer, not both",
          },
        );
      }
    } else {
      const pickCandidate = this.pos;
      if (this.matchKeyword("pick")) {
        pickOffset = this.text.indexOf("pick", pickCandidate);
        pick = this.parseMultiRange();
      }
      if (this.matchKeyword("replace")) {
        this.expectKeyword("with", "expected `with` after `replace`");
        this.lastFenceClosed = false;
        replacement = this.parseFence();
      }
      this.skipWhitespace();
      if (this.keywordAt("rename")) {
        this.syntax(
          "EDIT_RENAME_MIXED",
          pick !== null
            ? "rename cannot be combined with `pick`; use either `rename <from> to <to>` or `pick … replace with …`"
            : "rename cannot be combined with `replace`; use either `rename <from> to <to>` or `pick … replace with …`",
          {
            expected: ["rename <from> to <to>", "pick … replace with …"],
            found: "rename",
            hint: "choose one replacer, not both",
          },
        );
      }
    }

    this.consumeEnd();

    if (pick !== null && replacement === null) {
      this.syntax(
        "EDIT_PICK_WITHOUT_REPLACE",
        "`pick` requires a `replace`: a `pick` without `replace` is not a viewer; add `replace with <fence>`, or omit `pick` and keep the viewer",
        {
          ...(pickOffset === undefined ? {} : { offset: pickOffset }),
          expected: ["replace with <fence>", "omit pick"],
          found: "pick without replace",
          hint: "add `replace with <fence>` or remove `pick`",
        },
      );
    }

    const selection: Selection = {
      locator: { path, name, kind },
      space,
      matcher,
      pick,
      replacement,
    };
    if (rename !== null) {
      selection.rename = rename;
    }
    return selection;
  }

  /**
   * Consume `end`, or recover a missing one when the statement is complete and
   * the next token is unambiguously a new statement (or the reply ended). A
   * missing `end` before a field or arbitrary text is still a hard error. The
   * retired `done` terminator is rejected rather than consumed.
   */
  private consumeEnd(label = "clause"): void {
    this.skipWhitespace();
    if (this.keywordAt("end")) {
      this.pos += 3;
      this.lastFenceClosed = false;
      return;
    }
    if (this.keywordAt("done")) {
      this.rejectRetiredDone(
        `\`done\` is no longer a terminator: the ${label} ends with \`end\``,
        "replace `done` with `end`",
      );
    }
    if (!this.atEnd() && !this.statementStartAt() && this.lastFenceClosed) {
      this.syntax(
        "EDIT_EMBEDDED_FENCE_END",
        `the replacement body contains the literal line ${EDIT_FENCE_END}; the first exact end-marker line closes the fence and no text may follow it`,
        {
          expected: ["end", EDIT_FENCE_END],
          found: this.peekToken(),
          hint: `remove the embedded ${EDIT_FENCE_END} line or rewrite the body so it does not contain the marker`,
        },
      );
    }
    if (this.atEnd() || this.statementStartAt()) {
      const where = this.atEnd() ? "at the end of the reply" : `before \`${this.peekToken()}\``;
      this.warn(
        "EDIT_MISSING_END",
        `expected \`end\` to terminate the ${label}; recovered ${where}`,
        {
          offset: this.atEnd() ? Math.max(0, this.text.trimEnd().length) : this.pos,
          expected: ["end"],
          found: this.atEnd() ? "<eof>" : this.peekToken(),
          hint: "add `end` on its own line after the statement",
        },
      );
      // The recovered statement ends here, so a fence from an earlier statement
      // must not colour the next statement's diagnostics.
      this.lastFenceClosed = false;
      return;
    }
    this.syntax("EDIT_MISSING_END", `expected \`end\` to terminate the ${label}`, {
      expected: ["end"],
      found: this.peekToken(),
      hint: "add `end` on its own line after the statement",
    });
  }

  private parseRename(): RenameSpec {
    this.skipWhitespace();
    const from = this.readToken("expected an identifier after `rename`");
    this.expectKeyword("to", "expected `to` after the `rename` identifier");
    const to = this.readToken("expected an identifier after `to`");
    return { from, to };
  }

  private parseSpace(): SymbolSpace {
    const token = this.readToken("expected `value`, `type`, or `namespace` after `resolve`");
    if (!SELECTION_SPACES.has(token)) {
      this.syntax(
        "EDIT_UNKNOWN_SPACE",
        `unknown \`resolve\` kind \`${token}\`; expected one of value, type, namespace`,
        {
          offset: Math.max(0, this.pos - token.length),
          expected: ["value", "type", "namespace"],
          found: token,
          hint: "use `resolve value`, `resolve type`, or `resolve namespace`",
        },
      );
    }
    return token as SymbolSpace;
  }

  private parseMatcher(): SelectionMatcher {
    const start = this.pos;
    this.skipWhitespace();
    const char = this.text[this.pos];
    if (char === "`") {
      return { kind: "snippet", value: this.parseSnippet() };
    }
    if (char === "/") {
      return { kind: "regex", value: this.parseRegex() };
    }
    this.syntax("EDIT_MATCHER_MISSING", "expected a `snippet` or `/regex/` after `match`", {
      offset: start,
      expected: ["`snippet`", "/regex/"],
      found: this.atEnd() ? "<eof>" : this.peekToken(),
      hint: "use `match `return 1;`` or omit match to rewrite the whole declaration",
    });
  }

  private parseSnippet(): string {
    this.pos += 1; // opening backtick
    let value = "";
    for (;;) {
      if (this.atEnd()) {
        this.truncated = true;
        this.syntax("EDIT_TRUNCATED", "unclosed `snippet`: expected a closing backtick", {
          expected: ["`"],
          found: "<eof>",
          hint: "close the snippet with a backtick",
        });
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
        this.truncated = true;
        this.syntax("EDIT_TRUNCATED", "unclosed `/regex/`: expected a closing slash", {
          expected: ["/"],
          found: "<eof>",
          hint: "close the regex with a slash",
        });
      }
      const char = this.text[this.pos] ?? "";
      if (char === "\\") {
        const next = this.text[this.pos + 1];
        if (next === undefined) {
          this.truncated = true;
          this.syntax("EDIT_TRUNCATED", "unclosed `/regex/`: expected a closing slash", {
            expected: ["/"],
            found: "<eof>",
            hint: "close the regex with a slash",
          });
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

  private parseMultiRange(label = "pick"): EditRange[] {
    this.skipWhitespace();
    if (this.text[this.pos] !== "{") {
      return [this.parseRange(label)];
    }
    this.pos += 1; // `{`
    const ranges: EditRange[] = [];
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] === "}") {
        this.syntax("EDIT_MISSING_FIELD", `\`${label} {…}\` needs at least one range`, {
          expected: ["<line> or <line>:<column>"],
          found: "}",
          hint: "put at least one range inside the braces",
        });
      }
      ranges.push(this.parseRange(label));
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
      this.syntax("EDIT_MISSING_FIELD", `expected \`,\` or \`}\` inside \`${label} {…}\``, {
        expected: [",", "}"],
        found: char === undefined ? "<eof>" : char,
      });
    }
  }

  private parseRange(label = "pick"): EditRange {
    const line = this.parseCoordinate("line", label);
    this.skipWhitespace();
    let column: number | null = null;
    if (this.text[this.pos] === ":") {
      this.pos += 1;
      column = this.parseCoordinate("column", label);
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
    const endLine = this.parseCoordinate("line", label);
    this.skipWhitespace();
    let endColumn = END_OF_LINE_COLUMN;
    if (this.text[this.pos] === ":") {
      this.pos += 1;
      endColumn = this.parseCoordinate("column", label);
    }
    return { line, column: column ?? 1, endLine, endColumn };
  }

  private parseCoordinate(field: "line" | "column", label = "pick"): number {
    const start = this.pos;
    while (this.pos < this.length && isDigit(this.text[this.pos] ?? "")) {
      this.pos += 1;
    }
    if (this.pos === start) {
      this.syntax("EDIT_MISSING_FIELD", `expected a 1-based ${field} in \`${label}\``, {
        expected: [field],
        found: this.peekToken(),
      });
    }
    const value = Number(this.text.slice(start, this.pos));
    if (!Number.isInteger(value) || value < 1) {
      this.syntax(
        "EDIT_UNKNOWN_FIELD",
        `\`${label}\` ${field} must be a positive (1-based) integer`,
        {
          offset: start,
          expected: ["positive integer"],
          found: String(value),
        },
      );
    }
    return value;
  }

  private parseFence(): string {
    this.skipWhitespace();
    const markerStart = this.pos;
    let lineEnd = this.text.indexOf("\n", markerStart);
    if (lineEnd === -1) {
      lineEnd = this.length;
    }
    const markerLine = this.text.slice(markerStart, lineEnd).replace(/\r$/, "");
    const marker = markerLine.trim();
    const lineStart = this.text.lastIndexOf("\n", Math.max(0, markerStart - 1)) + 1;
    if (this.text.slice(lineStart, markerStart).trim() !== "") {
      this.syntax(
        "EDIT_MALFORMED_FENCE",
        `the fence opener ${EDIT_FENCE_BEGIN} must be on its own line`,
        {
          offset: markerStart,
          expected: [EDIT_FENCE_BEGIN],
          found: marker === "" ? "<eof>" : marker,
          hint: `put ${EDIT_FENCE_BEGIN} on its own line after replace with`,
        },
      );
    }
    if (marker !== EDIT_FENCE_BEGIN) {
      if (isLegacyEditFence(marker)) {
        this.syntax(
          "EDIT_LEGACY_FENCE",
          `legacy fence ${marker} is no longer accepted; edit-action fences use the ${EDIT_FENCE_BEGIN} and ${EDIT_FENCE_END} sentinels only`,
          {
            offset: markerStart,
            expected: [EDIT_FENCE_BEGIN],
            found: marker === "" ? "<eof>" : marker,
            hint: `replace the legacy fence with ${EDIT_FENCE_BEGIN} … ${EDIT_FENCE_END}`,
          },
        );
      }
      this.syntax(
        "EDIT_MISSING_FIELD",
        `expected the fence opener ${EDIT_FENCE_BEGIN} on its own line after \`replace with\``,
        {
          offset: markerStart,
          expected: [EDIT_FENCE_BEGIN],
          found: this.atEnd() || marker === "" ? "<eof>" : marker,
          hint: `open the replacement with ${EDIT_FENCE_BEGIN}`,
        },
      );
    }
    const bodyStart = lineEnd >= this.length ? this.length : lineEnd + 1;
    let bodyLineStart = bodyStart;
    for (;;) {
      let end = this.text.indexOf("\n", bodyLineStart);
      if (end === -1) {
        end = this.length;
      }
      const line = this.text.slice(bodyLineStart, end).replace(/\r$/, "");
      const trimmed = line.trim();
      if (trimmed.startsWith(EDIT_FENCE_END) && trimmed !== EDIT_FENCE_END) {
        this.syntax(
          "EDIT_FENCE_TRAILING_TEXT",
          `the closing sentinel ${EDIT_FENCE_END} must be on its own line; trailing text ${JSON.stringify(trimmed.slice(EDIT_FENCE_END.length).trim())} is not allowed and a body cannot carry ${EDIT_FENCE_END}`,
          {
            offset: bodyLineStart + line.indexOf(EDIT_FENCE_END) + EDIT_FENCE_END.length,
            expected: [EDIT_FENCE_END],
            found: trimmed,
            hint: `put ${EDIT_FENCE_END} on its own line; the sentinel close must be the whole line`,
          },
        );
      }
      if (trimmed === EDIT_FENCE_END) {
        let body = this.text.slice(bodyStart, bodyLineStart);
        if (body.endsWith("\r\n")) {
          body = body.slice(0, -2);
        } else if (body.endsWith("\n") || body.endsWith("\r")) {
          body = body.slice(0, -1);
        }
        this.pos = end >= this.length ? this.length : end + 1;
        this.lastFenceClosed = true;
        return body;
      }
      if (end >= this.length) {
        this.truncated = true;
        this.syntax(
          "EDIT_UNCLOSED_FENCE",
          `unclosed fence: expected the closing sentinel line ${EDIT_FENCE_END}`,
          {
            offset: bodyStart - 1,
            expected: [EDIT_FENCE_END],
            found: "<eof>",
            hint: `close the replacement with ${EDIT_FENCE_END}`,
          },
        );
      }
      bodyLineStart = end + 1;
    }
  }
}

/**
 * Strip one markdown fence that wraps the complete reply. The fence lines are
 * blanked rather than removed so diagnostics keep raw line numbers.
 */
function stripWholeReplyFence(text: string): {
  text: string;
  stripped: boolean;
  warning: DslIssue | null;
} {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let first = 0;
  while (first < lines.length && (lines[first] ?? "").trim() === "") {
    first += 1;
  }
  let last = lines.length - 1;
  while (last >= 0 && (lines[last] ?? "").trim() === "") {
    last -= 1;
  }
  if (first >= last) {
    return { text: lines.join("\n"), stripped: false, warning: null };
  }
  const open = /^(`{3,})(?:\s*[A-Za-z0-9_-]+)?\s*$/.exec((lines[first] ?? "").trim());
  const close = /^(`{3,})\s*$/.exec((lines[last] ?? "").trim());
  if (open === null || close === null || (close[1] ?? "").length < (open[1] ?? "").length) {
    return { text: lines.join("\n"), stripped: false, warning: null };
  }
  const inner = lines.slice(first + 1, last).find((line) => line.trim() !== "");
  if (inner === undefined || !/^(select|create|delete|read|write)\b/.test(inner.trim())) {
    return { text: lines.join("\n"), stripped: false, warning: null };
  }
  lines[first] = "";
  lines[last] = "";
  const strippedText = lines.join("\n");
  return {
    text: strippedText,
    stripped: true,
    warning: {
      severity: "warning",
      stage: "syntax",
      code: "EDIT_WHOLE_REPLY_FENCE",
      message:
        "the reply is wrapped in a markdown fence; stripped the fence and parsed the bare edit DSL",
      line: first + 1,
      column: 1,
      excerpt: strippedText,
      expected: ["bare edit DSL"],
      found: "```",
      recovered: true,
    },
  };
}

function offsetFor(text: string, line: number, column: number): number {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let offset = 0;
  for (let index = 0; index < Math.max(0, line - 1); index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return Math.max(0, Math.min(offset + Math.max(0, column - 1), text.length));
}

function failureFor(
  text: string,
  result: DslParseResult<Selection[] | EditStatement[]>,
): SelectionSyntaxError {
  const first = result.issues.find((issue) => issue.severity === "error");
  return new SelectionSyntaxError(
    first?.message ?? "the edit-dsl reply is malformed",
    first === undefined ? null : offsetFor(text, first.line, first.column),
    result.issues,
    result.truncated,
  );
}

function detailedSelection(text: string): DslParseResult<Selection[]> {
  const stripped = stripWholeReplyFence(text);
  const reader = new SelectionReader(
    stripped.text,
    stripped.warning === null ? [] : [stripped.warning],
  );
  return reader.detailedSelection();
}

function detailedMultiEditor(text: string): DslParseResult<EditStatement[]> {
  const stripped = stripWholeReplyFence(text);
  const reader = new SelectionReader(
    stripped.text,
    stripped.warning === null ? [] : [stripped.warning],
  );
  return reader.detailedMulti();
}

/**
 * Parse an edit-dsl reply (`docs/edit-protocol.md` §2): zero or more `select … end`
 * clauses. Returns one `Selection` per clause (an empty reply returns `[]`). Any malformed
 * input throws a `SelectionSyntaxError` naming the offending field; a partial
 * selection is never returned.
 */
export function parseSelection(text: string): Selection[] {
  const result = detailedSelection(text);
  if (!result.ok) {
    throw failureFor(text, result);
  }
  return result.value ?? [];
}

/** The detailed edit-dsl selection parse; `value` is best-effort when `ok` is false. */
export function parseSelectionDetailed(text: string): DslParseResult<Selection[]> {
  return detailedSelection(text);
}

/** Parse a full `multiEditor` reply: editors and `create`/`delete`/`read`/`write`. */
export function parseMultiEditor(text: string): EditStatement[] {
  const result = detailedMultiEditor(text);
  if (!result.ok) {
    throw failureFor(text, result);
  }
  return result.value ?? [];
}

/** The detailed multiEditor parse; `value` is best-effort when `ok` is false. */
export function parseMultiEditorDetailed(text: string): DslParseResult<EditStatement[]> {
  return detailedMultiEditor(text);
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

function renderFence(body: string): string {
  if (containsEditFenceEnd(body)) {
    throw new SelectionSyntaxError(
      `cannot serialize a replacement body containing the literal line ${EDIT_FENCE_END}; the sentinel is the only close and has no escape form`,
    );
  }
  return `${EDIT_FENCE_BEGIN}\n${body}\n${EDIT_FENCE_END}`;
}

/** Render one selection back to the edit-dsl grammar (one `select … end` clause). */
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
  if (selection.rename !== undefined && selection.rename !== null) {
    parts.push(`rename ${selection.rename.from} to ${selection.rename.to}`);
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

/** Render one raw file command back to the `multiEditor` grammar. */
export function serializeFileStatement(statement: FileStatement): string {
  switch (statement.op) {
    case "create":
      return `create ${statement.path} end`;
    case "delete":
      return `delete ${statement.path} end`;
    case "read": {
      const within =
        statement.ranges === null ? "" : ` within ${renderMultiRange(statement.ranges)}`;
      return `read ${statement.path}${within} end`;
    }
    case "write": {
      const within =
        statement.ranges === null ? "" : ` within ${renderMultiRange(statement.ranges)}`;
      // The sentinel close terminates a `write`; there is no trailing terminator.
      return `write ${statement.path}${within} with\n${renderFence(statement.replacement)}`;
    }
  }
}

/** Render a full `multiEditor` reply, one blank line between statements. */
export function serializeMultiEditor(statements: readonly EditStatement[]): string {
  return statements
    .map((statement) =>
      statement.type === "editor"
        ? serializeSelection(statement.selection)
        : serializeFileStatement(statement.statement),
    )
    .join("\n\n");
}

/**
 * The explicit bridge to the shipped JSON payload (`docs/edit-protocol.md` §9).
 * Returns an `EditPayload` only for the subset the payload can express: a
 * `snippet` or no matcher, no `pick` or a single range, and an editor (a
 * `replace`). Regex matchers, a multi-range `pick`, viewers, and renames have
 * no payload form and return `null`.
 */
export function toEditPayload(selection: Selection): EditPayload | null {
  if (selection.replacement === null) {
    return null;
  }
  if (selection.rename !== undefined && selection.rename !== null) {
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
