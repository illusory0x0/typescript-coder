import { describe, expect, test } from "bun:test";
import type { CascadeResolution, SelectionStage } from "./cascade";
import { resolveCascade } from "./cascade";
import { findMatcherMatches } from "./matcher";
import { END_OF_LINE_COLUMN, parseSelection } from "./selection";
import type { Selection } from "./selection";
import type { IndexEntry } from "./utility";
import { buildIndexTolerant, findDefinition } from "./utility";

const TWICE = ["export function twice(): number {", "  return 1;", "  return 1;", "}", ""].join(
  "\n",
);

const ONCE = ["export function once(): number {", "  return 1;", "}", ""].join("\n");

const TWO_DECLARATIONS = [
  "export const before = 1;",
  "export function twice(): number {",
  "  return 1;",
  "  return 1;",
  "}",
  "",
].join("\n");

function entryFor(source: string, name: string, kind: string): IndexEntry {
  const { index } = buildIndexTolerant([{ path: "a.ts", source }]);
  const entry = findDefinition(index, { path: "a.ts", name, kind });
  if (entry === null) {
    throw new Error(`no symbol ${kind} ${name}`);
  }
  return entry;
}

function firstSelection(text: string): Selection {
  const [selection] = parseSelection(text);
  if (selection === undefined) {
    throw new Error("no selection parsed");
  }
  return selection;
}

function ok(result: CascadeResolution): Extract<CascadeResolution, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected a resolution, got ${result.cause}: ${result.diagnostics}`);
  }
  return result;
}

function failure(result: CascadeResolution): Extract<CascadeResolution, { ok: false }> {
  if (result.ok) {
    throw new Error("expected a failure");
  }
  return result;
}

function nthIndexOf(source: string, needle: string, n: number): number {
  let index = -1;
  for (let count = 0; count <= n; count += 1) {
    index = source.indexOf(needle, index + 1);
  }
  return index;
}

describe("findMatcherMatches", () => {
  test("enumerates every span of the first matching fragment node", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const result = findMatcherMatches(TWICE, entry.node, "return 1;");
    expect(result.kind).toBe("matches");
    if (result.kind !== "matches") {
      return;
    }
    expect(result.spans).toEqual([
      {
        start: nthIndexOf(TWICE, "return 1;", 0),
        end: nthIndexOf(TWICE, "return 1;", 0) + "return 1;".length,
      },
      {
        start: nthIndexOf(TWICE, "return 1;", 1),
        end: nthIndexOf(TWICE, "return 1;", 1) + "return 1;".length,
      },
    ]);
  });

  test("returns no spans for a miss and reports an unparseable fragment", () => {
    const entry = entryFor(ONCE, "once", "function");
    expect(findMatcherMatches(ONCE, entry.node, "return 2;")).toEqual({
      kind: "matches",
      spans: [],
    });
    expect(findMatcherMatches(ONCE, entry.node, "if (").kind).toBe("unparseable");
  });
});

describe("resolveCascade: omitted stages", () => {
  test("no match is a whole-declaration viewer", () => {
    const entry = entryFor(ONCE, "once", "function");
    const result = ok(
      resolveCascade(ONCE, entry, firstSelection("select function once in a.ts\nend")),
    );
    expect(result.stage).toBe<SelectionStage>("whole-symbol");
    expect(result.viewer).toBe(true);
    expect(result.text).toBe("");
    expect(result.start).toBe(entry.node.start);
    expect(result.end).toBe(entry.node.end);
  });

  test("no match with replace rewrites the whole declaration", () => {
    const entry = entryFor(ONCE, "once", "function");
    const selection = firstSelection(
      "select function once in a.ts\nreplace with\nTC_EDIT_BEGIN\nfunction once(): number {\n  return 2;\n}\nTC_EDIT_END\nend",
    );
    const result = ok(resolveCascade(ONCE, entry, selection));
    expect(result.stage).toBe<SelectionStage>("whole-symbol");
    expect(result.viewer).toBe(false);
    expect(result.text).toBe("function once(): number {\n  return 2;\n}");
    expect(result.start).toBe(entry.node.start);
    expect(result.end).toBe(entry.node.end);
  });

  test("a match without replace is a viewer of the matched span", () => {
    const entry = entryFor(ONCE, "once", "function");
    const result = ok(
      resolveCascade(
        ONCE,
        entry,
        firstSelection("select function once in a.ts\nmatch `return 1;`\nend"),
      ),
    );
    expect(result.stage).toBe<SelectionStage>("match");
    expect(result.viewer).toBe(true);
    expect(result.text).toBe("");
    const start = ONCE.indexOf("return 1;");
    expect(result.start).toBe(start);
    expect(result.end).toBe(start + "return 1;".length);
  });

  test("a match with replace rewrites the matched span", () => {
    const entry = entryFor(ONCE, "once", "function");
    const selection = firstSelection(
      "select function once in a.ts\nmatch `return 1;`\nreplace with\nTC_EDIT_BEGIN\n  return 2;\nTC_EDIT_END\nend",
    );
    const result = ok(resolveCascade(ONCE, entry, selection));
    expect(result.stage).toBe<SelectionStage>("match");
    expect(result.viewer).toBe(false);
    expect(result.text).toBe("  return 2;");
    const start = ONCE.indexOf("return 1;");
    expect(result.start).toBe(start);
    expect(result.end).toBe(start + "return 1;".length);
  });
});

describe("resolveCascade: ambiguity and misses", () => {
  test("multiple matches fail loudly, never a silent first match", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const result = failure(
      resolveCascade(
        TWICE,
        entry,
        firstSelection("select function twice in a.ts\nmatch `return 1;`\nend"),
      ),
    );
    expect(result.cause).toBe("matcher-ambiguous");
    expect(result.diagnostics).toContain("matches 2 places");
    expect(result.diagnostics).toContain("candidates:");
    expect(result.diagnostics).toContain("2:3  return 1;");
    expect(result.diagnostics).toContain("3:3  return 1;");
  });

  test("a missing match is matcher-not-found", () => {
    const entry = entryFor(ONCE, "once", "function");
    const result = failure(
      resolveCascade(
        ONCE,
        entry,
        firstSelection("select function once in a.ts\nmatch `return 2;`\nend"),
      ),
    );
    expect(result.cause).toBe("matcher-not-found");
    expect(result.diagnostics).toContain("not found");
  });

  test("an unparseable matcher is matcher-unparseable", () => {
    const entry = entryFor(ONCE, "once", "function");
    const result = failure(
      resolveCascade(
        ONCE,
        entry,
        firstSelection("select function once in a.ts\nmatch `if (`\nend"),
      ),
    );
    expect(result.cause).toBe("matcher-unparseable");
    expect(result.diagnostics).toContain("could not be parsed");
    expect(result.diagnostics).toContain("interface/type member");
    expect(result.diagnostics).toContain("`/regex/`");
    expect(result.diagnostics).toContain("`pick`");
  });

  test("a malformed regex is regex-invalid, not a not-implemented failure", () => {
    const entry = entryFor(ONCE, "once", "function");
    const result = failure(
      resolveCascade(ONCE, entry, firstSelection("select function once in a.ts\nmatch /(/\nend")),
    );
    expect(result.cause).toBe("regex-invalid");
    expect(result.diagnostics).toContain("invalid");
    expect(result.diagnostics).toContain("/regex/");
  });
});

describe("resolveCascade: regex matcher", () => {
  test("a regex hit resolves the matched span", () => {
    const entry = entryFor(ONCE, "once", "function");
    const result = ok(
      resolveCascade(
        ONCE,
        entry,
        firstSelection("select function once in a.ts\nmatch /return 1;/\nend"),
      ),
    );
    expect(result.stage).toBe<SelectionStage>("match");
    expect(result.viewer).toBe(true);
    const start = ONCE.indexOf("return 1;");
    expect(result.start).toBe(start);
    expect(result.end).toBe(start + "return 1;".length);
  });

  test("a regex hit with replace rewrites the matched span", () => {
    const entry = entryFor(ONCE, "once", "function");
    const result = ok(
      resolveCascade(
        ONCE,
        entry,
        firstSelection(
          "select function once in a.ts\nmatch /return 1;/\nreplace with\nTC_EDIT_BEGIN\nreturn 2;\nTC_EDIT_END\nend",
        ),
      ),
    );
    expect(result.stage).toBe<SelectionStage>("match");
    expect(result.text).toBe("return 2;");
  });

  test("a regex miss is matcher-not-found and names the regex form", () => {
    const entry = entryFor(ONCE, "once", "function");
    const result = failure(
      resolveCascade(
        ONCE,
        entry,
        firstSelection("select function once in a.ts\nmatch /return 2;/\nend"),
      ),
    );
    expect(result.cause).toBe("matcher-not-found");
    expect(result.diagnostics).toContain("/regex/");
    expect(result.diagnostics).toContain("matched nothing");
  });

  test("an ambiguous regex is matcher-ambiguous", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const result = failure(
      resolveCascade(
        TWICE,
        entry,
        firstSelection("select function twice in a.ts\nmatch /return 1;/\nend"),
      ),
    );
    expect(result.cause).toBe("matcher-ambiguous");
    expect(result.diagnostics).toContain("/regex/");
    expect(result.diagnostics).toContain("matches 2 places");
    expect(result.diagnostics).toContain("candidates:");
    expect(result.diagnostics).toContain("2:3  return 1;");
    expect(result.diagnostics).toContain("3:3  return 1;");
  });

  test("pick narrows an ambiguous regex to the second occurrence", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const result = ok(
      resolveCascade(
        TWICE,
        entry,
        firstSelection(
          "select function twice in a.ts\nmatch /return 1;/\npick 3\nreplace with\nTC_EDIT_BEGIN\n  return 2;\nTC_EDIT_END\nend",
        ),
      ),
    );
    expect(result.stage).toBe<SelectionStage>("pick");
    const start = nthIndexOf(TWICE, "return 1;", 1);
    expect(result.start).toBe(start);
    expect(result.end).toBe(start + "return 1;".length);
  });

  test("pick that still leaves two regex matches stays ambiguous", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const result = failure(
      resolveCascade(
        TWICE,
        entry,
        firstSelection(
          "select function twice in a.ts\nmatch /return 1;/\npick {2, 3}\nreplace with\nTC_EDIT_BEGIN\n  return 2;\nTC_EDIT_END\nend",
        ),
      ),
    );
    expect(result.cause).toBe("matcher-ambiguous");
    expect(result.diagnostics).toContain("still leave more than one");
  });

  test("a zero-width match is a valid insertion point", () => {
    const entry = entryFor(ONCE, "once", "function");
    const result = ok(
      resolveCascade(
        ONCE,
        entry,
        firstSelection("select function once in a.ts\nmatch /(?=return)/\nend"),
      ),
    );
    expect(result.stage).toBe<SelectionStage>("match");
    const start = ONCE.indexOf("return");
    expect(result.start).toBe(start);
    expect(result.end).toBe(start);
  });

  test("anchors `^` at a line boundary inside the declaration", () => {
    const source = [
      "export function tokenize(input: string): number {",
      "if (input.length === 0) return 0;",
      "  return input.length;",
      "}",
      "",
    ].join("\n");
    const entry = entryFor(source, "tokenize", "function");
    const result = ok(
      resolveCascade(
        source,
        entry,
        firstSelection("select function tokenize in a.ts\nmatch /^if \\(/\nend"),
      ),
    );
    const start = source.indexOf("if (");
    // The match is at the start of an inner line, not at file offset 0.
    expect(start).toBeGreaterThan(0);
    expect(result.start).toBe(start);
    expect(result.end).toBe(start + "if (".length);
  });

  test("`^` does not match mid-line, and the unanchored form exposes the false hit", () => {
    const source = [
      "export function tokenize(input: string): number {",
      "  if (input.length === 0) return 0;",
      "  return input.length;",
      "}",
      "",
    ].join("\n");
    const entry = entryFor(source, "tokenize", "function");
    // The `if (` is indented, so it is not at a line start: `^` must not match.
    const anchored = failure(
      resolveCascade(
        source,
        entry,
        firstSelection("select function tokenize in a.ts\nmatch /^if \\(/\nend"),
      ),
    );
    expect(anchored.cause).toBe("matcher-not-found");
    // Without `^` the same text matches, confirming the miss was anchoring.
    const unanchored = ok(
      resolveCascade(
        source,
        entry,
        firstSelection("select function tokenize in a.ts\nmatch /if \\(/\nend"),
      ),
    );
    expect(unanchored.start).toBe(source.indexOf("if ("));
  });

  test("decodes an escaped slash before matching", () => {
    const slash = [
      "export function ratio(a: number, b: number): number {",
      "  return a/b;",
      "}",
      "",
    ].join("\n");
    const entry = entryFor(slash, "ratio", "function");
    const result = ok(
      resolveCascade(
        slash,
        entry,
        firstSelection("select function ratio in a.ts\nmatch /a\\/b/\nend"),
      ),
    );
    const start = slash.indexOf("a/b");
    expect(result.start).toBe(start);
    expect(result.end).toBe(start + "a/b".length);
  });
});

describe("resolveCascade: pick narrows match", () => {
  test("a point pick selects the match candidate whose span contains the point", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const result = ok(
      resolveCascade(
        TWICE,
        entry,
        firstSelection(
          "select function twice in a.ts\nmatch `return 1;`\npick 3:5\nreplace with\nTC_EDIT_BEGIN\n  return 2;\nTC_EDIT_END\nend",
        ),
      ),
    );
    expect(result.stage).toBe<SelectionStage>("pick");
    const start = nthIndexOf(TWICE, "return 1;", 1);
    expect(result.start).toBe(start);
    expect(result.end).toBe(start + "return 1;".length);
  });

  test("a point outside every candidate selects none", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const result = failure(
      resolveCascade(
        TWICE,
        entry,
        firstSelection(
          "select function twice in a.ts\nmatch `return 1;`\npick 4:1\nreplace with\nTC_EDIT_BEGIN\n  return 2;\nTC_EDIT_END\nend",
        ),
      ),
    );
    expect(result.cause).toBe("matcher-not-found");
  });

  test("a pick range disambiguates two matches to the second occurrence", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const selection = firstSelection(
      "select function twice in a.ts\nmatch `return 1;`\npick 3\nreplace with\nTC_EDIT_BEGIN\n  return 2;\nTC_EDIT_END\nend",
    );
    const result = ok(resolveCascade(TWICE, entry, selection));
    expect(result.stage).toBe<SelectionStage>("pick");
    expect(result.viewer).toBe(false);
    const start = nthIndexOf(TWICE, "return 1;", 1);
    expect(result.start).toBe(start);
    expect(result.end).toBe(start + "return 1;".length);
  });

  test("a pick viewer reports the narrowed span", () => {
    const entry = entryFor(TWICE, "twice", "function");
    // `pick` without `replace` is a syntax error now; this programmatic viewer
    // still exercises the viewer-side pick filter.
    const selection: Selection = {
      ...firstSelection("select function twice in a.ts\nmatch `return 1;`\nend"),
      pick: [{ line: 2, column: 1, endLine: 2, endColumn: END_OF_LINE_COLUMN }],
    };
    const result = ok(resolveCascade(TWICE, entry, selection));
    expect(result.stage).toBe<SelectionStage>("pick");
    expect(result.viewer).toBe(true);
    expect(result.text).toBe("");
    expect(result.start).toBe(TWICE.indexOf("return 1;"));
  });

  test("pick ranges are file-absolute 1-based spans", () => {
    const entry = entryFor(TWO_DECLARATIONS, "twice", "function");
    const line1 = TWO_DECLARATIONS.indexOf("export const before");
    const result = ok(
      resolveCascade(
        TWO_DECLARATIONS,
        entry,
        firstSelection(
          "select function twice in a.ts\nmatch `return 1;`\npick 3\nreplace with\nTC_EDIT_BEGIN\n  return 2;\nTC_EDIT_END\nend",
        ),
      ),
    );
    // Line 3 is the first `return 1;` inside `twice` (lines 2-5).
    expect(result.start).toBe(nthIndexOf(TWO_DECLARATIONS, "return 1;", 0));
    expect(result.start).toBeGreaterThan(line1);
    expect(result.stage).toBe<SelectionStage>("pick");
  });

  test("pick ranges that leave more than one match stay ambiguous", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const result = failure(
      resolveCascade(
        TWICE,
        entry,
        firstSelection(
          "select function twice in a.ts\nmatch `return 1;`\npick {2, 3}\nreplace with\nTC_EDIT_BEGIN\n  return 2;\nTC_EDIT_END\nend",
        ),
      ),
    );
    expect(result.cause).toBe("matcher-ambiguous");
    expect(result.diagnostics).toContain("still leave more than one");
  });

  test("pick ranges that cover no match are matcher-not-found", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const result = failure(
      resolveCascade(
        TWICE,
        entry,
        firstSelection(
          "select function twice in a.ts\nmatch `return 1;`\npick 4\nreplace with\nTC_EDIT_BEGIN\n  return 2;\nTC_EDIT_END\nend",
        ),
      ),
    );
    expect(result.cause).toBe("matcher-not-found");
  });

  test("an out-of-bounds pick range is range-invalid", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const result = failure(
      resolveCascade(
        TWICE,
        entry,
        firstSelection(
          "select function twice in a.ts\nmatch `return 1;`\npick 99\nreplace with\nTC_EDIT_BEGIN\n  return 2;\nTC_EDIT_END\nend",
        ),
      ),
    );
    expect(result.cause).toBe("range-invalid");
    expect(result.diagnostics).toContain("out-of-bounds");
    expect(result.diagnostics).toContain('"pick" range');
  });

  test("an empty pick range is range-invalid", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const result = failure(
      resolveCascade(
        TWICE,
        entry,
        firstSelection(
          "select function twice in a.ts\nmatch `return 1;`\npick 3:5-3:3\nreplace with\nTC_EDIT_BEGIN\n  return 2;\nTC_EDIT_END\nend",
        ),
      ),
    );
    expect(result.cause).toBe("range-invalid");
    expect(result.diagnostics).toContain("empty");
  });

  test("a pick range outside the declaration is range-invalid", () => {
    const entry = entryFor(TWO_DECLARATIONS, "twice", "function");
    const result = failure(
      resolveCascade(
        TWO_DECLARATIONS,
        entry,
        firstSelection(
          "select function twice in a.ts\nmatch `return 1;`\npick 1\nreplace with\nTC_EDIT_BEGIN\n  return 2;\nTC_EDIT_END\nend",
        ),
      ),
    );
    expect(result.cause).toBe("range-invalid");
    expect(result.diagnostics).toContain("outside-declaration");
  });
});

describe("resolveCascade: pick-only editor", () => {
  test("a bare line pick targets the whole line", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const result = ok(
      resolveCascade(
        TWICE,
        entry,
        firstSelection(
          "select function twice in a.ts\npick 2\nreplace with\nTC_EDIT_BEGIN\n  return 2;\nTC_EDIT_END\nend",
        ),
      ),
    );
    expect(result.stage).toBe<SelectionStage>("pick");
    expect(result.viewer).toBe(false);
    const start = TWICE.indexOf("  return 1;");
    expect(result.start).toBe(start);
    expect(result.end).toBe(start + "  return 1;".length);
  });

  test("a bare point pick targets the single character", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const result = ok(
      resolveCascade(
        TWICE,
        entry,
        firstSelection(
          "select function twice in a.ts\npick 2:3\nreplace with\nTC_EDIT_BEGIN\nR\nTC_EDIT_END\nend",
        ),
      ),
    );
    expect(result.stage).toBe<SelectionStage>("pick");
    const start = TWICE.indexOf("  return 1;") + 2;
    expect(result.start).toBe(start);
    expect(result.end).toBe(start + 1);
  });

  test("a bare range pick targets that text range", () => {
    const entry = entryFor(TWICE, "twice", "function");
    const result = ok(
      resolveCascade(
        TWICE,
        entry,
        firstSelection(
          "select function twice in a.ts\npick 2:3-2:8\nreplace with\nTC_EDIT_BEGIN\nyield\nTC_EDIT_END\nend",
        ),
      ),
    );
    expect(result.stage).toBe<SelectionStage>("pick");
    const start = TWICE.indexOf("  return 1;") + 2;
    expect(result.start).toBe(start);
    expect(result.end).toBe(start + "return".length);
  });

  test("the single-span primitive rejects a pick-only multi-range", () => {
    // The edit-dsl layer expands `{a, b}` into one single-range clause per
    // selecter; the primitive itself still resolves exactly one span.
    const entry = entryFor(TWICE, "twice", "function");
    const result = failure(
      resolveCascade(
        TWICE,
        entry,
        firstSelection(
          "select function twice in a.ts\npick {2, 3}\nreplace with\nTC_EDIT_BEGIN\n  return 2;\nTC_EDIT_END\nend",
        ),
      ),
    );
    expect(result.cause).toBe("range-invalid");
    expect(result.diagnostics).toContain("stage: range");
    expect(result.diagnostics).toContain("only one text span");
  });
});

describe("resolveCascade: precedence", () => {
  test("pick without replace is a parse error", () => {
    expect(() => parseSelection("select function twice in a.ts\npick 2\nend")).toThrow(/pick/);
  });
});

describe("resolveCascade: replace guards", () => {
  test("a replacement identical to the matched text is a no-op", () => {
    const entry = entryFor(ONCE, "once", "function");
    const selection = firstSelection(
      "select function once in a.ts\nmatch `return 1;`\nreplace with\nTC_EDIT_BEGIN\nreturn 1;\nTC_EDIT_END\nend",
    );
    const result = failure(resolveCascade(ONCE, entry, selection));
    expect(result.cause).toBe("no-op");
  });

  test("a whole-declaration replacement strips a duplicated leading export", () => {
    const entry = entryFor(ONCE, "once", "function");
    const selection = firstSelection(
      "select function once in a.ts\nreplace with\nTC_EDIT_BEGIN\nexport function once(): number {\n  return 2;\n}\nTC_EDIT_END\nend",
    );
    const result = ok(resolveCascade(ONCE, entry, selection));
    expect(result.text).toBe("function once(): number {\n  return 2;\n}");
  });

  test("a leading comment before export is still a duplicated modifier", () => {
    const entry = entryFor(ONCE, "once", "function");
    const selection = firstSelection(
      "select function once in a.ts\nreplace with\nTC_EDIT_BEGIN\n// note\nexport function once(): number {\n  return 2;\n}\nTC_EDIT_END\nend",
    );
    const result = ok(resolveCascade(ONCE, entry, selection));
    expect(result.text).toBe("// note\nfunction once(): number {\n  return 2;\n}");
    expect(result.text).not.toContain("export function");
  });

  test("a block comment before export is still a duplicated modifier", () => {
    const entry = entryFor(ONCE, "once", "function");
    const selection = firstSelection(
      "select function once in a.ts\nreplace with\nTC_EDIT_BEGIN\n/* note */ export function once(): number {\n  return 2;\n}\nTC_EDIT_END\nend",
    );
    const result = ok(resolveCascade(ONCE, entry, selection));
    expect(result.text).toBe("/* note */ function once(): number {\n  return 2;\n}");
  });

  test("a body-level replacement keeps a leading export verbatim", () => {
    const entry = entryFor(ONCE, "once", "function");
    const selection = firstSelection(
      "select function once in a.ts\nmatch `return 1;`\nreplace with\nTC_EDIT_BEGIN\nexport return 2;\nTC_EDIT_END\nend",
    );
    const result = ok(resolveCascade(ONCE, entry, selection));
    expect(result.text).toBe("export return 2;");
  });

  test("a plain export source keeps an intentional default conversion", () => {
    const entry = entryFor(ONCE, "once", "function");
    const selection = firstSelection(
      "select function once in a.ts\nreplace with\nTC_EDIT_BEGIN\nexport default function once(): number {\n  return 2;\n}\nTC_EDIT_END\nend",
    );
    const result = ok(resolveCascade(ONCE, entry, selection));
    expect(result.text).toBe("default function once(): number {\n  return 2;\n}");
  });
});
