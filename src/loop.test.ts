import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { renderFailureArtifact } from "./failure-artifact";
import {
  buildContextYaml,
  buildEditDslCreatePrompt,
  buildEditDslDetailsPrompt,
  buildEditDslModifiedPrompt,
  buildEditDslSelectionContinuationPrompt,
  buildEditDslSelectionRetryPrompt,
  buildEditDslSymbolIndex,
  buildEditDslUserPrompt,
  buildCreatePrompt,
  buildEditPrompt,
  buildRetryPrompt,
  buildSummaryPrompt,
  buildSystemPrompt,
  budgetTokensFromResponse,
  cacheExcludedTokens,
  classifyRejection,
  consecutiveLengthFinishes,
  createAttemptDigestState,
  detectFailurePattern,
  DIGEST_MAX_CHARS,
  DIGEST_RULED_OUT_REPEATS,
  discoverSourceFiles,
  editedRange,
  exchangeStats,
  failingTestNames,
  FAILURE_HISTORY_LOOKBACK,
  FAILURE_STATE_LIMIT,
  formatDiagnostics,
  isStalledAskMilestone,
  MAX_STALLED_ROUNDS,
  MAX_CONSECUTIVE_LENGTH,
  loopTokensFromResponse,
  numberedSourceBlock,
  numberedSourceRange,
  parseEditDslSelfCheck,
  rejectionLead,
  rejectionPolicy,
  repairContextShrinkEnabled,
  shrinkRepairSource,
  renderAttemptDigest,
  renderFailureHistoryNote,
  renderSelfCheckCommand,
  resolveEditRange,
  resolveCurrentEntry,
  runLoop as runLoopBase,
  selectSpecFiles,
  SELF_CHECK_OUTPUT_LIMIT,
  SPEC_FILE_LIMIT,
  STALLED_ASK_INTERVAL,
  stalledAskNumber,
  stripCodeFences,
  updateAttemptDigest,
  verificationFingerprint,
} from "./loop";
import type { LoopRecord, ProviderLike, RetryPromptInput, StalledAsk } from "./loop";
import type { ChatMessage, ChatOptions, ChatResponse, ToolDefinition } from "./openai";
import { ChatContextOverflowError, ChatPayloadTooLargeError } from "./openai";
import { Parser } from "./parser";
import {
  buildEditDslCommandPrompt,
  buildEditDslReadPrompt,
  EDIT_DSL_OUTPUT_CONTRACT,
  editDslInstruction,
  renderEditDslExamples,
} from "./prompts/edit-dsl";
import { END_OF_LINE_COLUMN, serializeSelections } from "./selection";
import type { Selection as EditDslSelection } from "./selection";
import { buildIndexTolerant } from "./utility";
import type { SourceFile } from "./utility";

// Parallel-safety audit (#36): this file mutates process.env flags
// (TC_DIAG_DECL_NAMING, TC_MATCHER_RANGE_HINT, TC_REPAIR_CONTEXT_SHRINK) and
// restores each in a finally/afterEach. It is one ~12k-line file, so file-level
// `bun test --parallel` keeps it whole in a worker; do not add `test.concurrent`
// here because those env flags are process-global and tests within a file share
// the process.
const tempDirs: string[] = [];

function runLoop(options: Parameters<typeof runLoopBase>[0]) {
  return runLoopBase(options);
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tsloop-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("discoverSourceFiles", () => {
  test("returns sorted relative .ts paths and skips ignored directories", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.ts"), "export const b = 2;\n");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "x.ts"), "export const x = 3;\n");
    mkdirSync(join(dir, ".hidden"));
    writeFileSync(join(dir, ".hidden", "c.ts"), "export const c = 4;\n");
    writeFileSync(join(dir, "d.txt"), "not typescript\n");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "e.ts"), "export const e = 5;\n");
    mkdirSync(join(dir, "tmp"));
    writeFileSync(join(dir, "tmp", "f.ts"), "export const f = 6;\n");

    const files = discoverSourceFiles(dir);
    expect(files.map((file) => file.path)).toEqual(["a.ts", "sub/b.ts"]);
    expect(files[0]?.source).toBe("export const a = 1;\n");
    expect(files[1]?.source).toBe("export const b = 2;\n");
  });
});

describe("selectSpecFiles", () => {
  const files: SourceFile[] = [
    { path: "src/app.ts", source: "export const app = 1;\n" },
    { path: "src/app.test.ts", source: "test();\n" },
    { path: "src/helper.ts", source: "export const helper = 1;\n" },
  ];

  test("includes discovered test files and issue-mentioned files in path order", () => {
    const issue = "Implement src/helper.ts so that src/app.test.ts passes.";
    expect(selectSpecFiles(issue, files).map((file) => file.path)).toEqual([
      "src/app.test.ts",
      "src/helper.ts",
    ]);
  });

  test("ignores mentioned paths that do not exist", () => {
    const sourceFiles: SourceFile[] = [{ path: "src/app.ts", source: "" }];
    expect(selectSpecFiles("Implement src/missing.ts.", sourceFiles)).toEqual([]);
  });

  test("lists a file that is both a test file and mentioned only once", () => {
    expect(selectSpecFiles("Fix ./src/app.test.ts.", files).map((file) => file.path)).toEqual([
      "src/app.test.ts",
    ]);
  });

  test("normalizes ./ prefixed mentions", () => {
    const sourceFiles: SourceFile[] = [{ path: "src/helper.ts", source: "" }];
    expect(
      selectSpecFiles("Implement ./src/helper.ts.", sourceFiles).map((file) => file.path),
    ).toEqual(["src/helper.ts"]);
  });

  test("sorts selected files by path regardless of input order", () => {
    const reversed: SourceFile[] = [
      { path: "src/z.test.ts", source: "" },
      { path: "src/a.test.ts", source: "" },
    ];
    expect(selectSpecFiles("", reversed).map((file) => file.path)).toEqual([
      "src/a.test.ts",
      "src/z.test.ts",
    ]);
  });
});

describe("buildContextYaml", () => {
  const aSource = `export function make(): number {\n  return 1;\n}\n\nexport class Widget {\n  render(): string {\n    return "x";\n  }\n}\n`;
  const bSource = `export type Name = "a" | "b";\n`;

  test("emits the exact YAML structure for a two-file fixture", () => {
    const files: SourceFile[] = [
      { path: "src/a.ts", source: aSource },
      { path: "src/b.ts", source: bSource },
    ];
    const expected = [
      "files:",
      '  - path: "src/a.ts"',
      "    symbols:",
      '      - name: "make"',
      '        kind: "function"',
      '        signature: "function make(): number"',
      '      - name: "Widget"',
      '        kind: "class"',
      '        signature: "class Widget render(): string"',
      '      - name: "Widget.render"',
      '        kind: "method"',
      '        signature: "render(): string"',
      '  - path: "src/b.ts"',
      "    symbols:",
      '      - name: "Name"',
      '        kind: "type"',
      '        signature: "type Name = \\"a\\" | \\"b\\""',
      "",
    ].join("\n");
    expect(buildContextYaml(files)).toBe(expected);
  });

  test("reuses the provided tolerant index without re-parsing any file", () => {
    const files: SourceFile[] = [
      { path: "src/a.ts", source: aSource },
      { path: "src/b.ts", source: bSource },
    ];
    const build = buildIndexTolerant(files);
    const parse = spyOn(Parser.prototype, "parseProgram");
    try {
      buildContextYaml(files, build);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  test("escapes quotes and backslashes in signatures", () => {
    const files: SourceFile[] = [{ path: "src/paths.ts", source: 'export type Path = "a\\b";\n' }];
    const expected = [
      "files:",
      '  - path: "src/paths.ts"',
      "    symbols:",
      '      - name: "Path"',
      '        kind: "type"',
      '        signature: "type Path = \\"a\\\\b\\""',
      "",
    ].join("\n");
    expect(buildContextYaml(files)).toBe(expected);
  });

  test("emits symbols: [] for a file without symbols", () => {
    const files: SourceFile[] = [{ path: "src/empty.ts", source: "" }];
    expect(buildContextYaml(files)).toBe('files:\n  - path: "src/empty.ts"\n    symbols: []\n');
  });

  test("caps the context at 500 symbols and marks it truncated", () => {
    const declarations = Array.from(
      { length: 501 },
      (_, index) => `function f${index}() { return ${index}; }`,
    );
    const files: SourceFile[] = [{ path: "src/many.ts", source: `${declarations.join("\n")}\n` }];
    const yaml = buildContextYaml(files);
    const signatures = yaml.split("\n").filter((line) => line.includes("signature:"));
    expect(signatures.length).toBe(500);
    expect(yaml).toContain('name: "f499"');
    expect(yaml).not.toContain('name: "f500"');
    expect(yaml.trimEnd().endsWith("truncated: true")).toBe(true);
  });

  test("reports unparseable files in a skipped section", () => {
    const files: SourceFile[] = [
      { path: "src/broken.ts", source: "function broken( {\n" },
      { path: "src/ok.ts", source: "export function fix(): number {\n  return 1;\n}\n" },
    ];
    const expected = [
      "files:",
      '  - path: "src/broken.ts"',
      "    symbols: []",
      '  - path: "src/ok.ts"',
      "    symbols:",
      '      - name: "fix"',
      '        kind: "function"',
      '        signature: "function fix(): number"',
      "skipped:",
      '  - path: "src/broken.ts"',
      '    message: "unexpected end of input (line 2, column 1)"',
      "",
    ].join("\n");
    expect(buildContextYaml(files)).toBe(expected);
  });
});

describe("declaration addresses (#52)", () => {
  test("an overload address is rejected with every candidate named", () => {
    const source =
      "function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: unknown) {}\n";
    const result = resolveCurrentEntry(source, "src/overload.ts", {
      path: "src/overload.ts",
      name: "f",
      kind: "function",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContain("matches 3 declarations");
      expect(result.diagnostics).toContain("the harness never picks one silently");
      expect(result.diagnostics).toContain("(line 1, column 1)");
      expect(result.diagnostics).toContain("(line 2, column 1)");
      expect(result.diagnostics).toContain("(line 3, column 1)");
    }
  });

  test("a class/interface merge is disambiguated by kind, not by first declaration", () => {
    const source = "interface Mixed { value: number }\nclass Mixed { run() {} }\n";
    const path = "src/merge.ts";
    const ambiguous = resolveCurrentEntry(source, path, { path, name: "Mixed", kind: "" });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.diagnostics).toContain("matches 2 declarations");
    }
    const classEntry = resolveCurrentEntry(source, path, { path, name: "Mixed", kind: "class" });
    expect(classEntry.ok).toBe(true);
    if (classEntry.ok) {
      expect(classEntry.entry.locator.kind).toBe("class");
      expect(source.slice(classEntry.entry.node.start, classEntry.entry.node.end)).toContain(
        "class Mixed",
      );
    }
  });

  test("a named default export resolves while an anonymous one stays undeclared", () => {
    const named = "export default function boot(): number {\n  return 1;\n}\n";
    const path = "src/default.ts";
    const resolved = resolveCurrentEntry(named, path, { path, name: "boot", kind: "function" });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.entry.node.start).toBe("export default ".length);
    }
    const anonymous = resolveCurrentEntry("export default function () {}\n", path, {
      path,
      name: "boot",
      kind: "function",
    });
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) {
      expect(anonymous.undeclared).toBe(true);
    }
  });

  test("nested member entries resolve with their own parser spans", () => {
    const source = [
      "interface Cell { getValue(): number }",
      "enum Color { Red }",
      "const config = { timeout: 1 };",
    ].join("\n");
    const path = "src/members.ts";
    for (const [name, kind, expected] of [
      ["Cell.getValue", "method", "getValue(): number"],
      ["Color.Red", "enum-member", "Red"],
      ["config.timeout", "property", "timeout: 1"],
    ] as const) {
      const resolved = resolveCurrentEntry(source, path, { path, name, kind });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(source.slice(resolved.entry.node.start, resolved.entry.node.end)).toBe(expected);
      }
    }
  });

  test("resolveCurrentEntry marks whole-symbols that would rewrite siblings", () => {
    const path = "src/bindings.ts";
    const multi = resolveCurrentEntry("const first = 1, second = 2;\n", path, {
      path,
      name: "first",
      kind: "const",
    });
    expect(multi.ok).toBe(true);
    if (multi.ok) {
      expect(multi.entry.wholeSymbolRestriction?.reason).toBe("multi-declarator");
    }
    const destructured = resolveCurrentEntry("const { a, b } = pair;\n", path, {
      path,
      name: "a",
      kind: "const",
    });
    expect(destructured.ok).toBe(true);
    if (destructured.ok) {
      expect(destructured.entry.wholeSymbolRestriction?.reason).toBe("destructuring");
    }
  });
});

describe("formatDiagnostics", () => {
  test("keeps the head and the tail of oversized diagnostics with a marker", () => {
    const check = {
      ok: false,
      exitCode: 1,
      output: "",
      diagnostics: [
        { file: "src/a.ts", line: 1, column: 1, message: `first error ${"h".repeat(3000)}` },
        { file: "src/b.ts", line: 2, column: 3, message: "middle error" },
      ],
    };
    const testResult = { ok: false, exitCode: 1, output: `${"z".repeat(3000)} last test line` };
    const result = formatDiagnostics({
      check,
      test: testResult,
      targetPath: "src/a.ts",
      baseSource: "const a = 1;\n",
      newSource: "const a = 2;\n",
    });
    expect(result.startsWith("stage: tsc\nreplacement line 1: first error ")).toBe(true);
    expect(result.endsWith("last test line")).toBe(true);
    expect(result).toMatch(/\.\.\. \[\d+ characters truncated\] \.\.\./);
  });

  test("annotates a diagnostic with its enclosing declaration", () => {
    const check = {
      ok: false,
      exitCode: 1,
      output: "",
      diagnostics: [{ file: "src/a.ts", line: 1, column: 1, message: "boom" }],
    };
    const result = formatDiagnostics({
      check,
      test: { ok: true, exitCode: 0, output: "" },
      targetPath: "src/a.ts",
      baseSource: "",
      newSource: "const a = 1;\n",
    });
    expect(result).toBe(
      "stage: tsc\nreplacement line 1: boom — in declaration `a` (const)\n  1 | const a = 1;",
    );
  });

  test("leaves a diagnostic outside every declaration byte-identical", () => {
    const result = formatDiagnostics({
      check: {
        ok: false,
        exitCode: 1,
        output: "",
        diagnostics: [{ file: "src/a.ts", line: 1, column: 1, message: "boom", code: "TS1000" }],
      },
      test: { ok: true, exitCode: 0, output: "" },
      targetPath: "src/a.ts",
      baseSource: "",
      newSource: "foo();\n",
    });
    // No top-level declaration contains line 1, so the line keeps its old shape.
    const line = result.split("\n").find((text) => text.startsWith("replacement line "));
    expect(line).toBe("replacement line 1: TS1000: boom");
  });

  test("names a type alias a diagnostic falls inside", () => {
    const newSource = "type LispValue = Missing;\n";
    const result = formatDiagnostics({
      check: {
        ok: false,
        exitCode: 1,
        output: "",
        diagnostics: [
          {
            file: "src/lisp.ts",
            line: 1,
            column: 18,
            message: "Cannot find name 'Missing'.",
            code: "TS2304",
          },
        ],
      },
      test: { ok: true, exitCode: 0, output: "" },
      targetPath: "src/lisp.ts",
      baseSource: "",
      newSource,
    });
    expect(result).toContain(
      "replacement line 1: TS2304: Cannot find name 'Missing'. — in declaration `LispValue` (type)",
    );
  });

  test("names the declaration an elsewhere diagnostic in another file falls inside", () => {
    const other = "export interface Shape {\n  width: number;\n}\n";
    const result = formatDiagnostics({
      check: {
        ok: false,
        exitCode: 1,
        output: "",
        diagnostics: [
          {
            file: "src/shape.ts",
            line: 2,
            column: 3,
            message: "Property 'width' does not exist on type 'Shape'.",
            code: "TS2339",
          },
        ],
      },
      test: { ok: true, exitCode: 0, output: "" },
      targetPath: "src/other.ts",
      baseSource: "const a = 1;\n",
      newSource: "const a = 2;\n",
      sourceFor: (file) => (file === "src/shape.ts" ? other : null),
    });
    expect(result).toContain("elsewhere in file:");
    expect(result).toContain(
      "src/shape.ts(2,3): error TS2339: Property 'width' does not exist on type 'Shape'. — in declaration `Shape` (interface)",
    );
  });

  test("renders without annotation when a source does not parse", () => {
    const result = formatDiagnostics({
      check: {
        ok: false,
        exitCode: 1,
        output: "",
        diagnostics: [{ file: "src/a.ts", line: 1, column: 1, message: "boom", code: "TS1000" }],
      },
      test: { ok: true, exitCode: 0, output: "" },
      targetPath: "src/a.ts",
      baseSource: "",
      newSource: "const a = ;\n",
    });
    expect(result).toContain("replacement line 1: TS1000: boom\n");
    expect(result).not.toContain("in declaration");
  });

  test("includes the declaration suffix when TC_DIAG_DECL_NAMING is unset (#92)", () => {
    const previous = process.env.TC_DIAG_DECL_NAMING;
    delete process.env.TC_DIAG_DECL_NAMING;
    try {
      const result = formatDiagnostics({
        check: {
          ok: false,
          exitCode: 1,
          output: "",
          diagnostics: [{ file: "src/a.ts", line: 1, column: 1, message: "boom" }],
        },
        test: { ok: true, exitCode: 0, output: "" },
        targetPath: "src/a.ts",
        baseSource: "",
        newSource: "const a = 1;\n",
      });
      expect(result).toBe(
        "stage: tsc\nreplacement line 1: boom — in declaration `a` (const)\n  1 | const a = 1;",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.TC_DIAG_DECL_NAMING;
      } else {
        process.env.TC_DIAG_DECL_NAMING = previous;
      }
    }
  });

  test("omits the declaration suffix and matches the pre-#87 render when TC_DIAG_DECL_NAMING=off (#92)", () => {
    const previous = process.env.TC_DIAG_DECL_NAMING;
    process.env.TC_DIAG_DECL_NAMING = "off";
    try {
      const result = formatDiagnostics({
        check: {
          ok: false,
          exitCode: 1,
          output: "",
          diagnostics: [{ file: "src/a.ts", line: 1, column: 1, message: "boom" }],
        },
        test: { ok: true, exitCode: 0, output: "" },
        targetPath: "src/a.ts",
        baseSource: "",
        newSource: "const a = 1;\n",
      });
      expect(result).not.toContain("in declaration");
      // Byte-identical to the render before #87 appended the suffix.
      expect(result).toBe("stage: tsc\nreplacement line 1: boom\n  1 | const a = 1;");
    } finally {
      if (previous === undefined) {
        delete process.env.TC_DIAG_DECL_NAMING;
      } else {
        process.env.TC_DIAG_DECL_NAMING = previous;
      }
    }
  });

  test("maps an in-range diagnostic to the replacement with a code frame", () => {
    const result = formatDiagnostics({
      check: {
        ok: false,
        exitCode: 1,
        output: "",
        diagnostics: [
          {
            file: "src/helper.ts",
            line: 2,
            column: 10,
            message: "Type 'string' is not assignable to type 'number'.",
            code: "TS2322",
          },
        ],
      },
      test: { ok: true, exitCode: 0, output: "" },
      targetPath: "src/helper.ts",
      baseSource: "export function answer(): number {\n  return 1;\n}\n",
      newSource: 'export function answer(): number {\n  return "no";\n}\n',
    });
    expect(result).toContain("stage: tsc");
    expect(result).toContain(
      "replacement line 1: TS2322: Type 'string' is not assignable to type 'number'.",
    );
    expect(result).toContain('  2 |   return "no";');
    expect(result).not.toContain("elsewhere in file:");
  });

  test("buckets out-of-range, other-file, and unlocated diagnostics as elsewhere", () => {
    const result = formatDiagnostics({
      check: {
        ok: false,
        exitCode: 1,
        output: "",
        diagnostics: [
          { file: "src/a.ts", line: 1, column: 7, message: "Cannot find name 'x'." },
          {
            file: "src/other.ts",
            line: 3,
            column: 1,
            message: "Cannot find name 'y'.",
            code: "TS2304",
          },
          { file: "", line: 0, column: 0, message: "Cannot find type definition file for 'bun'." },
        ],
      },
      test: { ok: true, exitCode: 0, output: "" },
      targetPath: "src/a.ts",
      baseSource: "const a = 1;\nconst b = 2;\n",
      newSource: "const a = 1;\nconst b = 3;\n",
    });
    expect(result).toContain("elsewhere in file:");
    expect(result).toContain("src/a.ts(1,7): Cannot find name 'x'.");
    expect(result).toContain("src/other.ts(3,1): error TS2304: Cannot find name 'y'.");
    expect(result).toContain("Cannot find type definition file for 'bun'.");
    expect(result).not.toContain("replacement line");
  });

  test("maps diagnostics against a range shifted by inserted lines", () => {
    const result = formatDiagnostics({
      check: {
        ok: false,
        exitCode: 1,
        output: "",
        diagnostics: [
          {
            file: "src/helper.ts",
            line: 4,
            column: 10,
            message: "Type 'string' is not assignable to type 'number'.",
            code: "TS2322",
          },
        ],
      },
      test: { ok: true, exitCode: 0, output: "" },
      targetPath: "src/helper.ts",
      baseSource: "export function answer(): number {\n  return 1;\n}\n",
      newSource:
        '// prepend one\n// prepend two\nexport function answer(): number {\n  return "no";\n}\n',
    });
    expect(result).toContain("replacement line 4: TS2322:");
    expect(result).toContain('  4 |   return "no";');
  });

  test("treats an unchanged file as fully elsewhere", () => {
    const source = "export function answer(): number {\n  return 1;\n}\n";
    const result = formatDiagnostics({
      check: {
        ok: false,
        exitCode: 1,
        output: "",
        diagnostics: [
          { file: "src/helper.ts", line: 1, column: 1, message: "boom", code: "TS1000" },
        ],
      },
      test: { ok: true, exitCode: 0, output: "" },
      targetPath: "src/helper.ts",
      baseSource: source,
      newSource: source,
    });
    expect(result).toContain("elsewhere in file:");
    expect(result).toContain("src/helper.ts(1,1): error TS1000: boom");
    expect(result).not.toContain("replacement line");
  });

  test("caps mapped diagnostics and notes the remainder", () => {
    const newSource = `${Array.from(
      { length: 12 },
      (_, index) => `const v${index} = ${index};`,
    ).join("\n")}\n`;
    const diagnostics = Array.from({ length: 12 }, (_, index) => ({
      file: "src/a.ts",
      line: index + 1,
      column: 1,
      message: `problem ${index}`,
      code: "TS1000",
    }));
    const result = formatDiagnostics({
      check: { ok: false, exitCode: 1, output: "", diagnostics },
      test: { ok: true, exitCode: 0, output: "" },
      targetPath: "src/a.ts",
      baseSource: "",
      newSource,
    });
    expect(result.split("\n").filter((line) => line.startsWith("replacement line "))).toHaveLength(
      10,
    );
    expect(result).toContain("... 2 more in the replacement");
  });

  test("falls back to raw check output when no diagnostics parse", () => {
    const result = formatDiagnostics({
      check: {
        ok: false,
        exitCode: 2,
        output: "tsc crashed: unknown option --wat\n",
        diagnostics: [],
      },
      test: { ok: true, exitCode: 0, output: "" },
      targetPath: "src/a.ts",
      baseSource: "const a = 1;\n",
      newSource: "const a = 2;\n",
    });
    expect(result).toContain("stage: tsc");
    expect(result).toContain("tsc crashed: unknown option --wat");
  });

  test("lists failing test names before a bounded raw tail", () => {
    const testOutput = `src/helper.test.ts:\nsome detail\n(fail) answer [1.00ms]\n${"x".repeat(
      3000,
    )}\n 2 fail`;
    const result = formatDiagnostics({
      check: { ok: true, exitCode: 0, output: "", diagnostics: [] },
      test: { ok: false, exitCode: 1, output: testOutput },
      targetPath: "src/helper.ts",
      baseSource: "const a = 1;\n",
      newSource: "const a = 2;\n",
    });
    expect(result).toContain("stage: tests");
    expect(result).toContain("tests failed:");
    expect(result).toContain("failing tests:");
    expect(result).toContain("  - answer");
    expect(result).toContain("earlier characters omitted");
    expect(result.indexOf("failing tests:")).toBeLessThan(result.indexOf("test output:"));
    expect(result.length).toBeLessThan(2200);
  });
});

describe("editedRange", () => {
  test("returns the whole file for a created file", () => {
    expect(editedRange("", "a\nb\n")).toEqual({ start: 1, end: 2 });
  });

  test("returns an empty range for identical sources", () => {
    expect(editedRange("a\nb\n", "a\nb\n")).toEqual({ start: 0, end: 0 });
  });

  test("covers inserted lines above the first change", () => {
    expect(editedRange("a\nb\nc\n", "x\na\nb2\nc\n")).toEqual({ start: 1, end: 3 });
  });
});

describe("failingTestNames", () => {
  // Captured from bun 1.3.13: "(fail) answer [1.00ms]", "(fail) second failing
  // [13.00ms]", and a describe-qualified "(fail) answers > nested failure"
  // without a timing suffix.
  const sample = [
    "src/helper.test.ts:",
    "error: expect(received).toBe(expected)",
    "",
    "Expected: 2",
    "Received: 1",
    "",
    "(fail) answer [1.00ms]",
    "(fail) second failing [13.00ms]",
    "(fail) answers > nested failure",
    "✗ legacy failure",
    "(fail) answer [4.00ms]",
    " 1 pass",
    " 2 fail",
  ].join("\n");

  test("extracts, dedupes, and orders failing test names", () => {
    expect(failingTestNames(sample)).toEqual([
      "answer",
      "second failing",
      "answers > nested failure",
      "legacy failure",
    ]);
  });

  test("caps the list at ten names", () => {
    const output = Array.from({ length: 12 }, (_, index) => `(fail) test ${index} [1.00ms]`).join(
      "\n",
    );
    const names = failingTestNames(output);
    expect(names).toHaveLength(10);
    expect(names.at(-1)).toBe("test 9");
  });

  test("returns an empty list when nothing matches", () => {
    expect(failingTestNames(" 1 pass\n 0 fail\nRan 1 test.")).toEqual([]);
  });
});

describe("prompt builders", () => {
  test("buildSystemPrompt returns a stable edit-dsl prompt", () => {
    expect(buildSystemPrompt()).toBe(buildSystemPrompt());
    expect(buildSystemPrompt()).toContain("This is the Edit-action DSL");
    expect(buildSystemPrompt()).toContain("select <symbol> in <path>");
    expect(buildSystemPrompt()).toContain("check end");
    expect(buildSystemPrompt()).toContain("test end");
    expect(buildSystemPrompt()).not.toContain("flat JSON object");
    expect(buildSystemPrompt()).toContain("First you will be asked to select the target");
    expect(buildSystemPrompt()).toContain("Then you will be asked to edit the selected symbol");
  });

  test("buildEditPrompt contains the pinned address and the symbol source", () => {
    const addressJson = '{"path":"src/a.ts","symbol":"make","kind":"function"}';
    const symbolSource = "export function make(): number {\n  return 1;\n}\n";
    const prompt = buildEditPrompt(addressJson, symbolSource);
    expect(prompt).toContain("A reply is one or more `select … end` clauses");
    expect(prompt).toContain("Pinned selection:");
    expect(prompt).toContain(addressJson);
    expect(prompt).toContain("Current source:");
    expect(prompt).toContain("1 | export function make(): number {");
    expect(prompt).toContain("2 |   return 1;");
    expect(prompt).toContain("3 | }");
    expect(prompt).toContain("```ts");
  });

  test("buildCreatePrompt asks for the complete declaration and notes the file may be missing", () => {
    const addressJson = '{"path":"src/new.ts","symbol":"make","kind":"function"}';
    const prompt = buildCreatePrompt(addressJson, "src/new.ts");
    expect(prompt).toContain('mode "create"');
    expect(prompt).toContain(addressJson);
    expect(prompt).toContain("src/new.ts");
    expect(prompt).toContain("An implicit create remains available");
  });

  const editDslContext = {
    issue: "fix src/a.ts",
    indexText: "select make in src/a.ts",
  };

  test("buildRetryPrompt reports the exchange, details, and diagnostics", () => {
    const currentSource = 'export function make(): number {\n  return "nope";\n}';
    const diagnostics = "src/a.ts(2,3): error TS2322: Type 'string' is not assignable";
    const prompt = buildRetryPrompt({
      exchangeNumber: 2,
      mode: "modify",
      currentSource,
      diagnostics,
      failure: "verification",
      editDslContext,
    });
    expect(prompt).toContain("Edit exchange 2 failed verification.");
    expect(prompt).toContain("Make minimal corrective changes to the current source");
    expect(prompt).toContain("A reply is one or more `select … end` clauses");
    expect(prompt).toContain("# details");
    expect(prompt).toContain("1 | export function make(): number {");
    expect(prompt).toContain('2 |   return "nope";');
    expect(prompt).toContain(diagnostics);
  });

  test("buildRetryPrompt describes the create contract and edit-stage failures", () => {
    const diagnostics = 'stage: protocol\nmode "create" does not take a match';
    const prompt = buildRetryPrompt({
      exchangeNumber: 1,
      mode: "create",
      currentSource: "",
      diagnostics,
      failure: "edit",
      editDslContext,
    });
    expect(prompt).toContain("Edit exchange 1 failed.");
    expect(prompt).not.toContain("failed verification");
    expect(prompt).toContain("complete declaration");
    expect(prompt).toContain(diagnostics);
  });

  test("buildRetryPrompt replaces the lead with the per-cause correction (#56)", () => {
    const currentSource = "export function make(): number {\n  return 1;\n}";
    const diagnostics = "stage: matcher\nthe matcher was not found";
    const prompt = buildRetryPrompt({
      exchangeNumber: 2,
      mode: "modify",
      currentSource,
      diagnostics,
      failure: "edit",
      correction: "Copy the match snippet verbatim from the current source.",
      editDslContext,
    });
    expect(prompt).toContain("Copy the match snippet verbatim from the current source.");
    expect(prompt).not.toContain("Make minimal corrective changes to the current source");

    const stalled = buildRetryPrompt({
      exchangeNumber: 1,
      mode: "modify",
      currentSource,
      diagnostics,
      failure: "edit",
      correction: "Copy the match snippet verbatim from the current source.",
      stalled: { failedAttempts: 8 },
      editDslContext,
    });
    expect(stalled).toContain("Concretely: change the matcher shape");
    expect(stalled).not.toContain("Copy the match snippet verbatim from the current source.");

    const create = buildRetryPrompt({
      exchangeNumber: 2,
      mode: "create",
      currentSource: "",
      diagnostics,
      failure: "edit",
      correction: "Emit a shorter, more compact replacement.",
      editDslContext,
    });
    expect(create).toContain("Emit a shorter, more compact replacement.");
    expect(create).not.toContain("Make minimal corrective changes to the complete declaration");
  });

  test("buildSummaryPrompt demands the four labeled sections and includes diagnostics when present", () => {
    const prompt = buildSummaryPrompt(
      "edit-exhausted",
      "stage: protocol\nno edit clause found in the response",
    );
    expect(prompt).toContain("The run is over: the run ended without a verified edit.");
    expect(prompt).toContain("Diagnostics:");
    expect(prompt).toContain("stage: protocol");
    expect(prompt).toContain("- Accomplished:");
    expect(prompt).toContain("- Failed and why:");
    expect(prompt).toContain("- Remaining:");
    expect(prompt).toContain("- Next step:");
    expect(prompt).toContain("Do not output code.");

    const bare = buildSummaryPrompt("token-budget", null);
    expect(bare).toContain("the token budget was exceeded");
    expect(bare).not.toContain("Diagnostics:");
    expect(bare).toContain("- Accomplished:");
    expect(bare).toContain("- Next step:");

    const wrapUp = buildSummaryPrompt("token-budget", null).split("\n").slice(-7);
    for (const reason of [
      "token-budget",
      "edit-exhausted",
      "delete-verification-failed",
      "prev-broken",
      "harness-fault",
      "provider-error",
    ] as const) {
      expect(buildSummaryPrompt(reason, null).split("\n").slice(-7)).toEqual(wrapUp);
    }
  });

  test("the digest is appended after the diagnostics only when passed (#57)", () => {
    const diagnostics = "stage: matcher\nthe matcher was not found";
    const input = {
      exchangeNumber: 1,
      mode: "modify" as const,
      currentSource: "export function make(): number {\n  return 1;\n}",
      diagnostics,
      failure: "edit" as const,
      editDslContext,
    };
    const digest = "Prior attempts (1):\n- #1 matcher-not-found: the matcher was not found";
    const bare = buildRetryPrompt(input);
    expect(bare).not.toContain("Prior attempts");
    const withDigest = buildRetryPrompt({ ...input, digest });
    const diagnosticsAt = withDigest.indexOf("Diagnostics:");
    expect(diagnosticsAt).toBeGreaterThan(-1);
    expect(withDigest.indexOf("Prior attempts")).toBeGreaterThan(diagnosticsAt);
    expect(withDigest).toContain(digest);
    const selection = buildEditDslSelectionContinuationPrompt({
      failedAttempts: 8,
      issue: "fix src/a.ts",
      indexText: "select make in src/a.ts",
      diagnostics,
      digest,
    });
    expect(selection).toContain(digest);
  });
});

describe("attempt digest (#57)", () => {
  function digestRecord(
    row: number,
    outcome: LoopRecord["outcome"],
    diagnostics: string,
    cause?: LoopRecord["cause"],
  ): LoopRecord {
    return {
      row,
      iteration: row,
      kind: "exchange",
      exchange: 1,
      outcome,
      locator: { path: "src/a.ts", name: "answer", kind: "function" },
      replacement: null,
      diagnostics,
      diagnosticsHead: null,
      replacementChars: null,
      finishReason: "stop",
      signature: null,
      cause,
    };
  }

  function matcherRecord(row: number): LoopRecord {
    return digestRecord(
      row,
      "matcher",
      `stage: matcher\nthe matcher was not found inside function "answer" attempt ${row} with trailing context that makes the line long`,
      "matcher-not-found",
    );
  }

  test("updates incrementally, bounds the text, and keeps eviction accounting", () => {
    const state = createAttemptDigestState();
    const records = Array.from({ length: 30 }, (_, index) => matcherRecord(index + 1));
    updateAttemptDigest(state, records.slice(0, 4));
    const partial = renderAttemptDigest(state);
    expect(partial).toContain("Prior attempts (4):");
    expect(partial).toContain("- #4 matcher-not-found:");
    expect(partial).not.toContain("earlier attempts omitted");
    updateAttemptDigest(state, records);
    const digest = renderAttemptDigest(state);
    expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(digest).toContain("Prior attempts (30):");
    const total = Number(/^Prior attempts \((\d+)\):/.exec(digest)?.[1]);
    const omitted = Number(/- \((\d+) earlier attempts omitted\)/.exec(digest)?.[1]);
    const entries = digest.split("\n").filter((line) => line.startsWith("- #"));
    expect(total).toBe(records.length);
    expect(omitted).toBeGreaterThan(0);
    expect(entries.length + omitted).toBe(total);
    // Details are truncated with an ellipsis and never carry the stage header.
    expect(digest).toContain("…");
    expect(digest).not.toContain("stage: ");
    // Counts and the ruled-out line span every attempt, evicted ones included.
    expect(digest).toContain(
      `Ruled out after ${records.length} repeats: matcher-not-found — This attempt MUST omit \`match\` and return the complete declaration in a \`select … replace with\` clause.`,
    );
    // Rendering again with no new records is stable.
    expect(renderAttemptDigest(state)).toBe(digest);
  });

  test("orders ruled-out lines by descending count and then class name", () => {
    const state = createAttemptDigestState();
    const records: LoopRecord[] = [
      digestRecord(1, "tsc", "stage: tsc\nreplacement line 1: TS2322: first"),
      digestRecord(2, "tsc", "stage: tsc\nreplacement line 1: TS2322: second"),
      digestRecord(3, "tsc", "stage: tsc\nreplacement line 1: TS2322: third"),
      matcherRecord(4),
      matcherRecord(5),
      matcherRecord(6),
      matcherRecord(7),
    ];
    updateAttemptDigest(state, records);
    const digest = renderAttemptDigest(state);
    const ruledOut = digest.split("\n").filter((line) => line.startsWith("Ruled out"));
    expect(ruledOut).toEqual([
      "Ruled out after 4 repeats: matcher-not-found — This attempt MUST omit `match` and return the complete declaration in a `select … replace with` clause.",
      "Ruled out after 3 repeats: tsc — change the declaration structure instead of re-editing the same spot",
    ]);
    expect(DIGEST_RULED_OUT_REPEATS).toBe(3);
  });

  test("rules out the #65 resend classes with their escalation text", () => {
    const state = createAttemptDigestState();
    const repeatRecord = (row: number): LoopRecord =>
      digestRecord(
        row,
        "repeat",
        "stage: repeat\nthis exact edit was just rejected (stage: matcher); resending it verbatim cannot succeed — change the payload",
        "repeat",
      );
    updateAttemptDigest(state, [repeatRecord(1), repeatRecord(2), repeatRecord(3)]);
    const digest = renderAttemptDigest(state);
    // The resend classes now carry an escalation, so their ruled-out line
    // states the resend cannot change the file (#65) instead of the fallback.
    expect(digest).toContain(
      "Ruled out after 3 repeats: repeat — That exact submission has now been rejected repeatedly, and resending it cannot change the file.",
    );
    expect(digest).not.toContain("take a materially different approach instead of repeating");
  });

  test("the protocol ruled-out line re-teaches the edit-dsl form", () => {
    const protocolRecords = [1, 2, 3].map((row) =>
      digestRecord(
        row,
        "protocol",
        "stage: protocol\nthe reply must be one or more `select … end` clauses; a JSON edit payload is not accepted in this mode",
        "protocol",
      ),
    );
    const state = createAttemptDigestState();
    updateAttemptDigest(state, protocolRecords);
    const digest = renderAttemptDigest(state);
    expect(digest).toContain(
      "Ruled out after 3 repeats: protocol — This attempt MUST reply with only `select … end` clauses or file commands",
    );
    expect(digest).not.toContain("exactly one flat JSON object");
  });

  test("prefers the tsc error line over the elsewhere section label", () => {
    const state = createAttemptDigestState();
    updateAttemptDigest(state, [
      digestRecord(
        1,
        "tsc",
        "stage: tsc\nelsewhere in file:\nsrc/x.ts(1,2): error TS2322: Type 'string' is not assignable to type 'number'.",
      ),
    ]);
    const digest = renderAttemptDigest(state);
    expect(digest).toContain("- #1 tsc: src/x.ts(1,2): error TS2322:");
    expect(digest).not.toContain("elsewhere in file:");
  });

  test("selects a safe mapped-diagnostic line and never code-frame source", () => {
    const state = createAttemptDigestState();
    const marker = "DIGEST_FRAME_MARKER";
    updateAttemptDigest(state, [
      digestRecord(
        1,
        "tsc",
        [
          "stage: tsc",
          "replacement line 2: TS2322: Type 'string' is not assignable to type 'number'.",
          "  1 | export function answer(): number {",
          `  2 |   return "${marker}";`,
          "  3 | }",
        ].join("\n"),
      ),
    ]);
    const digest = renderAttemptDigest(state);
    expect(digest).toContain(
      "- #1 tsc: replacement line 2: TS2322: Type 'string' is not assignable",
    );
    expect(digest).not.toContain(marker);
    expect(digest).not.toContain("2 |");
  });

  test("skips the tests section labels and selects the failing test name", () => {
    const state = createAttemptDigestState();
    updateAttemptDigest(state, [
      digestRecord(
        1,
        "tests",
        [
          "stage: tests",
          "tests failed:",
          "failing tests:",
          "  - answers the question",
          "test output:",
          "1 test failed",
        ].join("\n"),
      ),
    ]);
    const digest = renderAttemptDigest(state);
    expect(digest).toContain("- #1 tests: - answers the question");
    expect(digest).not.toContain("tests failed:");
    expect(digest).not.toContain("failing tests:");
    expect(digest).not.toContain("test output:");
  });
});

describe("failure history (#71)", () => {
  const diagnosticsA =
    "stage: tsc\nreplacement line 1: TS2322: Type 'Expr' is not assignable to type 'LispValue'.";
  const diagnosticsB =
    "stage: tsc\nreplacement line 2: TS2345: Argument of type 'LispValue' is not assignable to parameter of type 'Expr'.";

  function verificationRecord(
    row: number,
    outcome: LoopRecord["outcome"],
    diagnostics: string | null,
  ): LoopRecord {
    return {
      row,
      iteration: row,
      kind: "verification",
      exchange: null,
      outcome,
      locator: { path: "src/a.ts", name: "answer", kind: "function" },
      replacement: null,
      diagnostics,
      diagnosticsHead: null,
      replacementChars: null,
      finishReason: "stop",
      signature: null,
    };
  }

  function failedVerifications(diagnostics: readonly string[]): LoopRecord[] {
    return diagnostics.map((text, index) => verificationRecord(index + 1, "tsc", text));
  }

  test("fingerprints normalize error sentences, positions, and order", () => {
    // A sentence that lacks its final period runs on into the next mapped
    // diagnostic (`[^.]*` crosses the newline), so its `replacement line N:`
    // fragment and the following position fragment are stripped too.
    const runOn =
      "replacement line 105: TS2345: Argument of type 'LispValue' is not assignable to parameter of type 'Expr'\n" +
      "replacement line 106: TS2322: Type 'Expr' is not assignable to type 'LispValue'.";
    expect(verificationFingerprint(runOn)).toBe(
      "TS2345: Argument of type 'LispValue' is not assignable to parameter of type 'Expr' replacement line: TS2322: Type 'Expr' is not assignable to type 'LispValue'.",
    );
    // A `(line,column)` position fragment inside the captured sentence is
    // stripped along with the `line N` fragment beside it.
    expect(
      verificationFingerprint(
        "TS2345: Argument of type 'LispValue' is not assignable to parameter of type 'Expr'\nreplacement (12,5) line 106: TS2322: Type 'Expr' is not assignable to type 'LispValue'.",
      ),
    ).toBe(
      "TS2345: Argument of type 'LispValue' is not assignable to parameter of type 'Expr' replacement line: TS2322: Type 'Expr' is not assignable to type 'LispValue'.",
    );
    // Multiple errors are sorted and de-duplicated; input order does not matter.
    const both = `${diagnosticsA}\n${diagnosticsB}`;
    expect(verificationFingerprint(both)).toBe(
      "TS2322: Type 'Expr' is not assignable to type 'LispValue'. | TS2345: Argument of type 'LispValue' is not assignable to parameter of type 'Expr'.",
    );
    expect(verificationFingerprint(`${diagnosticsB}\n${diagnosticsA}`)).toBe(
      verificationFingerprint(both),
    );
    expect(verificationFingerprint(`${diagnosticsA}\n${diagnosticsA}`)).toBe(
      verificationFingerprint(diagnosticsA),
    );
  });

  test("falls back to the digest detail without tsc codes and stays empty when uninformative", () => {
    expect(verificationFingerprint("stage: tests\ntests failed:\n  - answers the question")).toBe(
      "- answers the question",
    );
    expect(verificationFingerprint("")).toBe("");
    expect(verificationFingerprint("   ")).toBe("");
  });

  test("detects an unchanged failing set at exactly three rounds", () => {
    expect(
      detectFailurePattern(failedVerifications([diagnosticsA, diagnosticsA, diagnosticsA])),
    ).toEqual({ kind: "unchanged", rounds: 3 });
    expect(detectFailurePattern(failedVerifications([diagnosticsA, diagnosticsA]))).toBeNull();
  });

  test("detects an alternating failing set at four rounds and deeper", () => {
    const fingerprintA = verificationFingerprint(diagnosticsA);
    const fingerprintB = verificationFingerprint(diagnosticsB);
    expect(
      detectFailurePattern(
        failedVerifications([diagnosticsA, diagnosticsB, diagnosticsA, diagnosticsB]),
      ),
    ).toEqual({ kind: "alternating", rounds: 4, a: fingerprintB, b: fingerprintA });
    expect(
      detectFailurePattern(
        failedVerifications([
          diagnosticsA,
          diagnosticsB,
          diagnosticsA,
          diagnosticsB,
          diagnosticsA,
          diagnosticsB,
        ]),
      ),
    ).toEqual({ kind: "alternating", rounds: 6, a: fingerprintB, b: fingerprintA });
  });

  test("returns null while the failing set still changes", () => {
    expect(
      detectFailurePattern(failedVerifications([diagnosticsA, diagnosticsA, diagnosticsB])),
    ).toBeNull();
    expect(
      detectFailurePattern(failedVerifications([diagnosticsA, diagnosticsB, diagnosticsA])),
    ).toBeNull();
  });

  test("resets the chain at a passed verification", () => {
    const records = [
      ...failedVerifications([diagnosticsA, diagnosticsA, diagnosticsA]),
      verificationRecord(4, "ok", null),
      verificationRecord(5, "tsc", diagnosticsA),
      verificationRecord(6, "tsc", diagnosticsA),
    ];
    expect(detectFailurePattern(records)).toBeNull();
    // Without the reset the same trailing failures are unchanged.
    expect(
      detectFailurePattern(failedVerifications([diagnosticsA, diagnosticsA, diagnosticsA])),
    ).toEqual({ kind: "unchanged", rounds: 3 });
  });

  test("caps the lookback at eight fingerprints", () => {
    expect(FAILURE_HISTORY_LOOKBACK).toBe(8);
    const nine = failedVerifications(Array.from({ length: 9 }, () => diagnosticsA));
    expect(detectFailurePattern(nine)).toEqual({
      kind: "unchanged",
      rounds: FAILURE_HISTORY_LOOKBACK,
    });
    const twelveCycling = failedVerifications(
      Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? diagnosticsA : diagnosticsB)),
    );
    expect(detectFailurePattern(twelveCycling)).toEqual({
      kind: "alternating",
      rounds: FAILURE_HISTORY_LOOKBACK,
      a: verificationFingerprint(diagnosticsB),
      b: verificationFingerprint(diagnosticsA),
    });
  });

  test("empty fingerprints never match each other", () => {
    expect(
      detectFailurePattern([
        verificationRecord(1, "tests", ""),
        verificationRecord(2, "tests", ""),
        verificationRecord(3, "tests", ""),
      ]),
    ).toBeNull();
  });

  test("ignores exchange rows interleaved between verification failures", () => {
    const appliedExchange: LoopRecord = {
      row: 2,
      iteration: 1,
      kind: "exchange",
      exchange: 1,
      outcome: "applied",
      locator: { path: "src/a.ts", name: "answer", kind: "function" },
      replacement: "x",
      diagnostics: null,
      diagnosticsHead: null,
      replacementChars: 1,
      finishReason: "stop",
      signature: null,
    };
    const records = [
      verificationRecord(1, "tsc", diagnosticsA),
      appliedExchange,
      verificationRecord(3, "tsc", diagnosticsA),
      appliedExchange,
      verificationRecord(5, "tsc", diagnosticsA),
    ];
    expect(detectFailurePattern(records)).toEqual({ kind: "unchanged", rounds: 3 });
  });

  test("renders exact notes for both kinds and nothing for null", () => {
    expect(renderFailureHistoryNote(null)).toBe("");
    expect(renderFailureHistoryNote({ kind: "unchanged", rounds: 4 })).toBe(
      "Failure history: the failing set is unchanged across the last 4 verification rounds.",
    );
    expect(
      renderFailureHistoryNote({
        kind: "alternating",
        rounds: 4,
        a: "TS2322: a.",
        b: "TS2345: b.",
      }),
    ).toBe(
      [
        "Failure history: the failing set has cycled between two states across the last 4 verification rounds; local edits have flipped between them instead of converging:",
        "- TS2322: a.",
        "- TS2345: b.",
      ].join("\n"),
    );
  });

  test("clamps the alternating states and the whole note stays bounded", () => {
    const longState = `TS2322: ${"x".repeat(300)}.`;
    const note = renderFailureHistoryNote({
      kind: "alternating",
      rounds: FAILURE_HISTORY_LOOKBACK,
      a: longState,
      b: longState,
    });
    const lines = note.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]?.length).toBe(FAILURE_STATE_LIMIT + 2);
    expect(lines[1]?.endsWith("…")).toBe(true);
    expect(note.length).toBeLessThanOrEqual(400);
  });

  test("renders the note between the diagnostics fence and the digest", () => {
    const input = {
      exchangeNumber: 1,
      mode: "modify" as const,
      currentSource: "export function make(): number {\n  return 1;\n}",
      diagnostics: diagnosticsA,
      failure: "verification" as const,
    };
    const note = renderFailureHistoryNote({ kind: "unchanged", rounds: 3 });
    const digest = "Prior attempts (3):\n- #3 tsc: replacement line 1: TS2322:";
    const bare = buildRetryPrompt(input);
    expect(bare).not.toContain("Failure history:");
    expect(buildRetryPrompt({ ...input, failureHistory: "" })).not.toContain("Failure history:");
    const withNote = buildRetryPrompt({ ...input, failureHistory: note, digest });
    expect(withNote).toContain(`\`\`\`\n\n${note}\n\nPrior attempts`);
    expect(withNote.indexOf("Failure history:")).toBeGreaterThan(withNote.indexOf("Diagnostics:"));
    expect(withNote.indexOf("Prior attempts")).toBeGreaterThan(
      withNote.indexOf("Failure history:"),
    );
    // The selection no-progress ask forwards the note too.
    const selection = buildEditDslSelectionContinuationPrompt({
      failedAttempts: 8,
      issue: "fix src/a.ts",
      indexText: "select answer in src/a.ts",
      diagnostics: input.diagnostics,
      failureHistory: note,
    });
    expect(selection).toContain(note);
    expect(
      buildEditDslSelectionContinuationPrompt({
        failedAttempts: 8,
        issue: "fix src/a.ts",
        indexText: "select answer in src/a.ts",
        diagnostics: input.diagnostics,
      }),
    ).not.toContain("Failure history:");
  });
});

describe("stripCodeFences", () => {
  test("strips a json fence pair", () => {
    expect(stripCodeFences('```json\n{ "path": "a.ts" }\n```')).toBe('{ "path": "a.ts" }');
  });

  test("strips a ts fence pair", () => {
    expect(stripCodeFences("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  test("returns trimmed plain text", () => {
    expect(stripCodeFences("  plain text  ")).toBe("plain text");
  });

  test("keeps fences that are not at both edges", () => {
    const openOnly = "```ts\nconst x = 1;";
    expect(stripCodeFences(openOnly)).toBe(openOnly);
    const withTrailing = "```ts\nconst x = 1;\n```\ntrailing";
    expect(stripCodeFences(withTrailing)).toBe(withTrailing);
    expect(stripCodeFences("a ``` b")).toBe("a ``` b");
  });
});

describe("exchangeStats (#69)", () => {
  const row = (
    over: Partial<LoopRecord> & { outcome: LoopRecord["outcome"]; kind: LoopRecord["kind"] },
  ): LoopRecord => ({
    row: 1,
    iteration: 1,
    exchange: 1,
    locator: { path: "src/a.ts", name: "x", kind: "function" },
    replacement: null,
    diagnostics: null,
    diagnosticsHead: null,
    replacementChars: null,
    finishReason: null,
    signature: null,
    ...over,
  });

  test("counts exchanges by outcome and sums payloads and tool calls", () => {
    const stats = exchangeStats([
      row({ outcome: "selected", kind: "exchange", payloads: 0, toolCalls: 1 }),
      row({ outcome: "applied", kind: "exchange", payloads: 2, toolCalls: 0 }),
      row({ outcome: "gate", kind: "exchange", payloads: 1, toolCalls: 0 }),
      row({ outcome: "stopped", kind: "exchange", payloads: 0, toolCalls: 0 }),
      row({ outcome: "self-check", kind: "exchange", payloads: 0, toolCalls: 0 }),
      row({ outcome: "ok", kind: "verification", exchange: null }),
    ]);
    expect(stats).toEqual({
      turns: 5,
      payloads: 3,
      toolCalls: 1,
      applied: 1,
      rejected: 1,
      selected: 1,
      stopped: 1,
      selfChecks: 1,
      range: 0,
      matcher: 0,
      wholeSymbol: 0,
      stageWholeSymbol: 0,
      stageMatch: 0,
      stagePick: 0,
      snippet: 0,
      regex: 0,
      creates: 0,
    });
  });

  test("treats a confirmed row as neither applied nor rejected", () => {
    const stats = exchangeStats([
      row({ outcome: "confirmed", kind: "exchange", toolCalls: 1 }),
      row({ outcome: "ok", kind: "verification", exchange: null }),
    ]);
    expect(stats.turns).toBe(1);
    expect(stats.applied).toBe(0);
    expect(stats.rejected).toBe(0);
    expect(stats.toolCalls).toBe(1);
  });

  test("defaults a row's payloads and tool calls to zero when absent", () => {
    const stats = exchangeStats([row({ outcome: "applied", kind: "exchange" })]);
    expect(stats.payloads).toBe(0);
    expect(stats.toolCalls).toBe(0);
    expect(stats.applied).toBe(1);
  });

  test("sums selector adoption per payload, including batch entries (#101)", () => {
    const stats = exchangeStats([
      row({ outcome: "applied", kind: "exchange", selectors: ["range"] }),
      row({ outcome: "applied", kind: "exchange", selectors: ["range", "matcher"] }),
      row({ outcome: "applied", kind: "exchange", selectors: ["matcher", "whole-symbol"] }),
      row({ outcome: "selected", kind: "exchange", toolCalls: 1 }),
      row({ outcome: "ok", kind: "verification", exchange: null }),
    ]);
    expect(stats.range).toBe(2);
    expect(stats.matcher).toBe(2);
    expect(stats.wholeSymbol).toBe(1);
  });

  test("sums resolved stages and matcher kinds per payload, including batch entries (#110)", () => {
    const stats = exchangeStats([
      row({ outcome: "applied", kind: "exchange", stages: ["pick"], matcherKinds: [null] }),
      row({
        outcome: "applied",
        kind: "exchange",
        stages: ["match", "whole-symbol"],
        matcherKinds: ["snippet", null],
      }),
      row({
        outcome: "gate",
        kind: "exchange",
        stages: ["match", "pick"],
        matcherKinds: ["snippet", null],
      }),
      row({ outcome: "selected", kind: "exchange", toolCalls: 1 }),
      row({ outcome: "ok", kind: "verification", exchange: null }),
    ]);
    expect(stats.stageWholeSymbol).toBe(1);
    expect(stats.stageMatch).toBe(2);
    expect(stats.stagePick).toBe(2);
    expect(stats.snippet).toBe(2);
    expect(stats.regex).toBe(0);
  });

  test("sums edit-dsl implicit-create clauses per reply (#111)", () => {
    const stats = exchangeStats([
      row({ outcome: "applied", kind: "exchange", creates: 2 }),
      row({ outcome: "duplicate", kind: "exchange", creates: 1 }),
      row({ outcome: "applied", kind: "exchange" }),
      row({ outcome: "ok", kind: "verification", exchange: null }),
    ]);
    expect(stats.creates).toBe(3);
  });
});

describe("self-check and no-progress asks (#73/#65)", () => {
  const verificationRow = (row: number, diagnostics: string): LoopRecord => ({
    row,
    iteration: row,
    kind: "verification",
    exchange: null,
    outcome: "tsc",
    locator: { path: "src/a.ts", name: "x", kind: "function" },
    replacement: null,
    diagnostics,
    diagnosticsHead: null,
    replacementChars: null,
    finishReason: null,
    signature: null,
  });
  const exchangeRow = (row: number, outcome: LoopRecord["outcome"]): LoopRecord => ({
    row,
    iteration: row,
    kind: "exchange",
    exchange: 1,
    outcome,
    locator: { path: "src/a.ts", name: "x", kind: "function" },
    replacement: null,
    diagnostics: null,
    diagnosticsHead: null,
    replacementChars: null,
    finishReason: null,
    signature: null,
  });

  test("parses only standalone edit-dsl check/test control commands", () => {
    expect(parseEditDslSelfCheck("check end")).toEqual({ kind: "ok", request: "check" });
    expect(parseEditDslSelfCheck("  test end  ")).toEqual({ kind: "ok", request: "test" });
    expect(parseEditDslSelfCheck("TEST END")).toEqual({ kind: "ok", request: "test" });
    expect(parseEditDslSelfCheck("select answer in src/a.ts end")).toEqual({ kind: "none" });
    expect(parseEditDslSelfCheck("write src/a.ts with")).toEqual({ kind: "none" });
    for (const bad of [
      "test",
      "test src/a.test.ts end",
      "test end\nselect answer in src/a.ts end",
      "check end because it failed",
    ]) {
      const parsed = parseEditDslSelfCheck(bad);
      expect(parsed.kind).toBe("error");
      if (parsed.kind === "error") {
        expect(parsed.diagnostics).toContain("standalone");
        expect(parsed.diagnostics).toContain("`check end`");
        expect(parsed.diagnostics).toContain("`test end`");
      }
    }
  });

  test("clamps a command result to the output bound", () => {
    expect(
      renderSelfCheckCommand("check", "the check command", {
        ok: true,
        exitCode: 0,
        output: "done\n",
      }),
    ).toBe("Self-check (check): the check command passed (exit 0).\n\n```\ndone\n```");
    expect(
      renderSelfCheckCommand("test", "the test command", { ok: false, exitCode: 1, output: "" }),
    ).toContain("(no output)");
    const big = renderSelfCheckCommand("test", "the test command", {
      ok: false,
      exitCode: 1,
      output: "y".repeat(SELF_CHECK_OUTPUT_LIMIT + 100),
    });
    expect(big).toContain("[truncated 100 characters]");
  });

  test("renders the self-check result section only when passed", () => {
    const input = {
      exchangeNumber: 2,
      mode: "modify" as const,
      currentSource: "function make() {\n  return 1;\n}",
      diagnostics: "stage: protocol",
      failure: "edit" as const,
    };
    expect(buildRetryPrompt(input)).not.toContain("Self-check result:");
    const withResult = buildRetryPrompt({
      ...input,
      selfCheck: "Self-check (read): src/a.ts (1 line(s)).",
    });
    expect(withResult).toContain("Self-check result:");
    expect(withResult).toContain("Self-check (read): src/a.ts");
    expect(withResult.indexOf("Self-check result:")).toBeGreaterThan(
      withResult.indexOf("Diagnostics:"),
    );
  });

  test("the no-progress ask keeps its header and the #71 note rides alongside", () => {
    const editDslContext = { issue: "fix src/a.ts", indexText: "select make in src/a.ts" };
    const continuation = buildRetryPrompt({
      exchangeNumber: 1,
      mode: "modify",
      currentSource: "function make() {\n  return 1;\n}",
      diagnostics: "stage: protocol",
      failure: "edit",
      stalled: { failedAttempts: 8 },
      editDslContext,
    });
    expect(continuation).toContain("No progress: 8 consecutive failed attempts.");
    const withHistory = buildRetryPrompt({
      exchangeNumber: 2,
      mode: "modify",
      currentSource: "function make() {\n  return 1;\n}",
      diagnostics: "stage: protocol",
      failure: "edit",
      failureHistory:
        "Failure history: the failing set is unchanged across the last 3 verification rounds.",
      selfCheck: "Self-check (check): the check command failed (exit 1).",
      editDslContext,
    });
    expect(withHistory).toContain("Failure history:");
    expect(withHistory).toContain("Self-check result:");
    expect(withHistory.indexOf("Self-check result:")).toBeLessThan(
      withHistory.indexOf("Failure history:"),
    );
  });

  test("a self-check exchange row does not break the failure-history walk (#71)", () => {
    const diag = "src/a.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.";
    const records: LoopRecord[] = [
      verificationRow(1, diag),
      exchangeRow(2, "self-check"),
      verificationRow(3, diag),
      exchangeRow(4, "self-check"),
      verificationRow(5, diag),
    ];
    expect(detectFailurePattern(records)).toEqual({ kind: "unchanged", rounds: 3 });
  });

  const stalledInput = (over: Partial<StalledAsk> = {}): RetryPromptInput => ({
    exchangeNumber: 1,
    mode: "modify",
    currentSource: "export function answer(): number {\n  return 1;\n}",
    diagnostics: "src/a.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    failure: "verification",
    stalled: { failedAttempts: 8, ...over },
  });

  test("the first ask keeps the original wording byte-for-byte", () => {
    const prompt = buildRetryPrompt(stalledInput());
    expect(prompt).toContain(
      "No progress: 8 consecutive failed attempts. Reply exactly `STOP` to end the run now, but only if the failures cannot be resolved; otherwise take a materially different approach rather than another minimal attempt.",
    );
    expect(prompt).not.toContain("repeated ask");
  });

  test("the second ask folds in the unchanged failing set and demands address-or-STOP", () => {
    const prompt = buildRetryPrompt(
      stalledInput({ askNumber: 2, history: { kind: "unchanged", rounds: 6 } }),
    );
    expect(prompt).toContain("No progress: 8 consecutive failed attempts.");
    expect(prompt).toContain("repeated ask 2");
    expect(prompt).toContain("the failing set is unchanged across the last 6 verification rounds");
    expect(prompt).toContain("directly address that unchanged failing set");
    // STOP keeps its biased-to-continue semantics: only when the set cannot be
    // resolved.
    expect(prompt).toContain(
      "only if it cannot be resolved, reply exactly `STOP` to end the run now",
    );
    // #75: a non-converging pattern escalates the repeated ask to a decision
    // turn, so the concrete-edit alternatives are dropped from this prompt.
    expect(prompt).toContain("This is a decision turn");
    expect(prompt).not.toContain("Concretely: change the matcher shape");
    // #75: a repeat ask escalates even while the pattern is still changing, so
    // no concrete-edit alternatives ride the prompt.
    const repeatChanging = buildRetryPrompt(stalledInput({ askNumber: 2, history: null }));
    expect(repeatChanging).toContain("the failing set has not converged");
    expect(repeatChanging).toContain("This is a decision turn");
    expect(repeatChanging).not.toContain("Concretely: change the matcher shape");
    // A still-changing set at the FIRST ask is the one case that still keeps the
    // ordinary edit prompt and its concrete alternatives.
    const changing = buildRetryPrompt(stalledInput({ askNumber: 1, history: null }));
    expect(changing).toContain("Concretely: change the matcher shape");
    expect(changing).not.toContain("This is a decision turn");
  });

  test("an alternating or still-changing set is named too", () => {
    const alternating = buildRetryPrompt(
      stalledInput({
        askNumber: 3,
        history: { kind: "alternating", rounds: 5, a: "TS2322", b: "TS2345" },
      }),
    );
    expect(alternating).toContain("repeated ask 3");
    expect(alternating).toContain(
      "cycled between two states across the last 5 verification rounds",
    );
    const changing = buildRetryPrompt(stalledInput({ askNumber: 2, history: null }));
    expect(changing).toContain("repeated ask 2");
    expect(changing).toContain("the failing set has not converged");
  });

  test("the sharpened ask rides a repair retry", () => {
    const prompt = buildRetryPrompt({
      exchangeNumber: 1,
      mode: "modify",
      currentSource: "export function answer(): number {\n  return 1;\n}",
      diagnostics: "stage: protocol",
      failure: "edit",
      stalled: {
        failedAttempts: 16,
        askNumber: 2,
        history: { kind: "unchanged", rounds: 10 },
      },
    });
    expect(prompt).toContain("No progress: 16 consecutive failed attempts.");
    expect(prompt).toContain("repeated ask 2");
    expect(prompt).toContain("the failing set is unchanged across the last 10 verification rounds");
  });

  test("the decision-point cadence shortens after the first ask", () => {
    // First ask at 8, then every MAX_STALLED_ROUNDS / 2 (4): 8, 12, 16, 20, …
    expect(MAX_STALLED_ROUNDS).toBe(8);
    expect(STALLED_ASK_INTERVAL).toBe(4);
    expect([0, 1, 7, 9, 11].filter(isStalledAskMilestone)).toEqual([]);
    expect([8, 12, 16, 20, 24, 28, 32].filter(isStalledAskMilestone)).toEqual([
      8, 12, 16, 20, 24, 28, 32,
    ]);
    expect([8, 12, 16, 20, 24].map(stalledAskNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  test("the repeated ask names the unchanged set and the recovering cycle still succeeds", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(17),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS * 2),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    const firstAsk = provider.calls[9]?.at(-1)?.content ?? "";
    expect(firstAsk).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed attempts.`);
    expect(firstAsk).not.toContain("repeated ask");
    // The second ask arrives four failed rounds later (streak 12, round 13).
    const secondAsk = provider.calls[13]?.at(-1)?.content ?? "";
    expect(secondAsk).toContain(
      `No progress: ${MAX_STALLED_ROUNDS + STALLED_ASK_INTERVAL} consecutive failed attempts.`,
    );
    expect(secondAsk).toContain("repeated ask 2");
    expect(secondAsk).toContain("the failing set is unchanged across the last");
    expect(secondAsk).toContain("directly address that unchanged failing set");
    // The #71 note is still carried alongside the sharpened framing.
    expect(secondAsk).toContain("Failure history: the failing set is unchanged");
    // The third ask recurs at the next shortened interval (streak 16, round 17).
    const thirdAsk = provider.calls[17]?.at(-1)?.content ?? "";
    expect(thirdAsk).toContain(
      `No progress: ${MAX_STALLED_ROUNDS * 2} consecutive failed attempts.`,
    );
    expect(thirdAsk).toContain("repeated ask 3");
    // A decision point, not a cap: the model continues and the run recovers.
    expect(helperSource(dir)).toContain("return 18;");
  }, 30000);

  test("a fast-burning storm reaches the second ask before the budget ends it", async () => {
    const dir = fixtureDir();
    // 8k tokens per call against a 120k budget: the run is terminated around
    // round 15, so a 16-round cadence could never show the second ask.
    const provider = new UsageProvider(
      [selectionResponse(ANSWER, "modify"), ...chainedEdits(30)],
      Array.from({ length: 40 }, () => ({ total_tokens: 8_000 })),
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      tokenBudget: 120_000,
      checkCommand: stallingCheckCommand(dir, 40),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("token-budget");
    const asks = provider.calls.filter((call) =>
      (call.at(-1)?.content ?? "").includes("No progress:"),
    );
    expect(asks).toHaveLength(2);
    const firstAsk = provider.calls[9]?.at(-1)?.content ?? "";
    expect(firstAsk).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed attempts.`);
    expect(firstAsk).not.toContain("repeated ask");
    // The second (sharpened) ask fired at streak 12, round 13 — before the
    // budget ended the run around round 15.
    const secondAsk = provider.calls[13]?.at(-1)?.content ?? "";
    expect(secondAsk).toContain("repeated ask 2");
    expect(secondAsk).toContain("the failing set is unchanged across the last");
  }, 30000);

  test("STOP at the repeated ask still ends the run through the decision chain", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(16),
      "  stop\n",
      "the storm could not be resolved",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS * 2),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    const stopped = result.records.at(-1);
    expect(stopped?.outcome).toBe("stopped");
    expect(stopped?.iteration).toBe(17);
    expect(stopped?.exchange).toBe(1);
    // STOP's meaning is unchanged at the sharpened ask: one summary, stalled text.
    expect(stopped?.diagnostics).toContain(
      `edit-exhausted: the model replied STOP after ${MAX_STALLED_ROUNDS * 2} consecutive failed attempts`,
    );
    expect(provider.calls.at(-1)?.at(-1)?.content ?? "").toContain("The run is over");
  }, 30000);
});

describe("decision-only turn (#75)", () => {
  const stalledInput = (over: Partial<StalledAsk> = {}): RetryPromptInput => ({
    exchangeNumber: 1,
    mode: "modify",
    currentSource: "export function answer(): number {\n  return 1;\n}",
    diagnostics: "src/a.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    failure: "verification",
    editDslContext: { issue: "fix src/a.ts", indexText: "select answer in src/a.ts" },
    stalled: {
      failedAttempts: 8,
      askNumber: 2,
      history: { kind: "unchanged", rounds: 6 },
      ...over,
    },
  });

  test("drops the edit template and offers STOP on a repeated unchanged set", () => {
    const prompt = buildRetryPrompt({
      ...stalledInput(),
      failureHistory: renderFailureHistoryNote({ kind: "unchanged", rounds: 6 }),
    });
    expect(prompt).toContain("repeated ask 2");
    expect(prompt).toContain("This is a decision turn");
    expect(prompt).toContain("Reply exactly `STOP` to end the run now");
    expect(prompt).toContain("Do not send an edit clause on this turn");
    // The edit template is gone entirely.
    expect(prompt).not.toContain("A reply is one or more `select … end` clauses");
    // The failing diagnostics and history are kept.
    expect(prompt).toContain("Diagnostics:");
    expect(prompt).toContain("Failure history: the failing set is unchanged");
  });

  test("edit-dsl decision turn carries Goal, index, and details without the JSON block", () => {
    const prompt = buildRetryPrompt({
      ...stalledInput(),
      editDslContext: {
        issue: "make the answer test pass",
        indexText: "select answer in src/helper.ts resolve value",
        startLine: 4,
      },
      failureHistory: renderFailureHistoryNote({ kind: "unchanged", rounds: 6 }),
    });
    // The decision framing and STOP semantics are unchanged.
    expect(prompt).toContain("No progress: 8 consecutive failed attempts.");
    expect(prompt).toContain("repeated ask 2");
    expect(prompt).toContain("This is a decision turn");
    expect(prompt).toContain("Reply exactly `STOP` to end the run now");
    expect(prompt).toContain("Do not send an edit clause on this turn");
    // The select-first context is present, with numbered declaration details.
    expect(prompt).toContain("# Goal");
    expect(prompt).toContain("make the answer test pass");
    expect(prompt).toContain("# Symbol index");
    expect(prompt).toContain("select answer in src/helper.ts resolve value");
    expect(prompt).toContain("# details");
    expect(prompt).toContain("4 | export function answer(): number {");
    expect(prompt).toContain("Diagnostics:");
    expect(prompt).toContain("Failure history: the failing set is unchanged");
    // No JSON pinned selection or edit template leaks in.
    expect(prompt).not.toContain("```json");
    expect(prompt).not.toContain("A reply is one or more `select … end` clauses");
  });

  test("fires for an alternating set too", () => {
    const prompt = buildRetryPrompt(
      stalledInput({
        askNumber: 3,
        history: { kind: "alternating", rounds: 5, a: "TS2322", b: "TS2345" },
      }),
    );
    expect(prompt).toContain("This is a decision turn");
    expect(prompt).toContain("cycled between two states");
    expect(prompt).not.toContain("A reply is one or more `select … end` clauses");
  });

  test("fires on either signal; only a first ask with a still-changing set stays an edit prompt", () => {
    // First ask with an already non-converging set fires.
    const firstUnchanged = buildRetryPrompt(
      stalledInput({ askNumber: 1, history: { kind: "unchanged", rounds: 6 } }),
    );
    expect(firstUnchanged).toContain("This is a decision turn");
    expect(firstUnchanged).not.toContain("A reply is one or more `select … end` clauses");
    // A repeat ask fires even while the pattern is still changing.
    const repeatChanging = buildRetryPrompt(stalledInput({ askNumber: 2, history: null }));
    expect(repeatChanging).toContain("This is a decision turn");
    expect(repeatChanging).not.toContain("A reply is one or more `select … end` clauses");
    // A later repeat ask fires regardless of pattern.
    const laterChanging = buildRetryPrompt(stalledInput({ askNumber: 3, history: null }));
    expect(laterChanging).toContain("This is a decision turn");
    expect(laterChanging).not.toContain("A reply is one or more `select … end` clauses");
    // Only a first ask with a still-changing set keeps the normal edit prompt.
    const firstChanging = buildRetryPrompt(stalledInput({ askNumber: 1, history: null }));
    expect(firstChanging).not.toContain("This is a decision turn");
    expect(firstChanging).toContain("A reply is one or more `select … end` clauses");
    expect(firstChanging).toContain("# details");
  });

  test("rides a repair retry", () => {
    const prompt = buildRetryPrompt({
      exchangeNumber: 1,
      mode: "modify",
      currentSource: "export function answer(): number {\n  return 1;\n}",
      diagnostics: "stage: protocol",
      failure: "edit",
      stalled: {
        failedAttempts: 16,
        askNumber: 2,
        history: { kind: "unchanged", rounds: 10 },
      },
    });
    expect(prompt).toContain("This is a decision turn");
    expect(prompt).not.toContain("A reply is one or more `select … end` clauses");
  });

  test("renders a stated re-approach alongside the normal edit template", () => {
    const approach = "Replace the whole declaration instead of patching the return type.";
    const prompt = buildRetryPrompt({
      exchangeNumber: 2,
      mode: "modify",
      currentSource: "export function answer(): number {\n  return 1;\n}",
      diagnostics: "stage: protocol",
      failure: "edit",
      approach,
    });
    expect(prompt).toContain("Approach to apply:");
    expect(prompt).toContain(approach);
    expect(prompt).toContain("A reply is one or more `select … end` clauses");
    // An empty approach renders nothing.
    expect(buildRetryPrompt({ ...stalledInput({ askNumber: 1 }), approach: "" })).not.toContain(
      "Approach to apply:",
    );
  });

  test("a non-edit decision reply is carried, not applied, and the run can recover", async () => {
    const dir = fixtureDir();
    const approach = "Restructure answer to compute 2 directly instead of returning a literal.";
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(12),
      approach,
      editResponse("return 13;", "return 14;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: stallingCheckCommand(dir, 12),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    // Round 13 opens with the decision turn, not the edit template.
    const decision = provider.calls[13]?.at(-1)?.content ?? "";
    expect(decision).toContain("This is a decision turn");
    expect(decision).not.toContain("A reply is one or more `select … end` clauses");
    // The stated approach rides the following exchange's edit prompt.
    const followup = provider.calls[14]?.at(-1)?.content ?? "";
    expect(followup).toContain("Approach to apply:");
    expect(followup).toContain(approach);
    expect(followup).toContain("A reply is one or more `select … end` clauses");
    // The decision reply is not an applied edit: only exchange 2 of round 13 is.
    const round13 = result.records.filter(
      (record) => record.iteration === 13 && record.kind === "exchange",
    );
    expect(round13).toHaveLength(1);
    expect(round13[0]?.exchange).toBe(2);
    expect(round13[0]?.outcome).toBe("applied");
    expect(helperSource(dir)).toContain("return 14;");
  }, 30000);

  test("a valid edit on the decision turn is still applied through the unchanged guards", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(12),
      editResponse("return 13;", "return 14;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: stallingCheckCommand(dir, 12),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    const decision = provider.calls[13]?.at(-1)?.content ?? "";
    expect(decision).toContain("This is a decision turn");
    // The real attempt landed on the opening exchange, not a later retry.
    const applied = result.records.find(
      (record) => record.iteration === 13 && record.outcome === "applied",
    );
    expect(applied?.exchange).toBe(1);
    expect(helperSource(dir)).toContain("return 14;");
  }, 30000);

  test("STOP on the decision turn ends the run through the existing stop path", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(12),
      "  stop\n",
      "the unchanged failing set could not be resolved",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: stallingCheckCommand(dir, 12),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    const stopped = result.records.at(-1);
    expect(stopped?.outcome).toBe("stopped");
    expect(stopped?.iteration).toBe(13);
    expect(stopped?.exchange).toBe(1);
    expect(stopped?.diagnostics).toContain(
      `edit-exhausted: the model replied STOP after 12 consecutive failed attempts`,
    );
    // The decision prompt fired, not the edit template.
    const decision = provider.calls[13]?.at(-1)?.content ?? "";
    expect(decision).toContain("This is a decision turn");
    expect(provider.calls.at(-1)?.at(-1)?.content ?? "").toContain("The run is over");
  }, 30000);
});

const TSC = [
  "bun",
  new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname,
  "--noEmit",
];

const ANSWER = { path: "src/helper.ts", symbol: "answer", kind: "function" };

type ScriptedResponse = string | { toolCall: { name: string; arguments: string } };

class ScriptedProvider implements ProviderLike {
  readonly calls: ChatMessage[][] = [];
  readonly toolsArgs: (ToolDefinition[] | undefined)[] = [];
  readonly optionCalls: (ChatOptions | undefined)[] = [];

  constructor(
    private readonly responses: ScriptedResponse[],
    private readonly onCall?: (callIndex: number) => void,
  ) {}

  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("no scripted response");
    }
    this.calls.push(structuredClone(messages));
    this.toolsArgs.push(tools);
    this.optionCalls.push(options);
    this.onCall?.(this.calls.length - 1);
    if (typeof response === "string") {
      return { content: response, toolCalls: [], finishReason: "stop", raw: {} };
    }
    return {
      content: null,
      toolCalls: [{ id: "t1", type: "function", function: response.toolCall }],
      finishReason: "tool_calls",
      raw: {},
    };
  }
}

// An edit-dsl clause: the pinned address, an optional snippet matcher newly
// added to the clause, and the replacement.
function editResponse(
  matcher: string | null,
  replacement: string,
  address: { path: string; symbol: string; kind: string } = ANSWER,
): string {
  return serializeSelections([
    {
      locator: { path: address.path, name: address.symbol, kind: address.kind },
      space: null,
      matcher: matcher === null ? null : { kind: "snippet", value: matcher },
      pick: null,
      replacement,
    },
  ]);
}

// A create clause: the complete declaration, never a matcher.
function createResponse(
  address: { path: string; symbol: string; kind: string },
  replacement: string,
): string {
  return editResponse(null, replacement, address);
}

// A pick clause: the pinned address plus a 1-based inclusive range instead of a
// matcher.
function rangeEditResponse(
  range: { line: number; column: number; endLine: number; endColumn: number },
  replacement: string,
  address: { path: string; symbol: string; kind: string } = ANSWER,
): string {
  return serializeSelections([
    {
      locator: { path: address.path, name: address.symbol, kind: address.kind },
      space: null,
      matcher: null,
      pick: [range],
      replacement,
    },
  ]);
}

// The canonical pinned selection viewer. A delete pin is a first-turn editor
// with an empty body, because edit-dsl has no separate delete payload.
function selectionResponse(
  address: { path: string; symbol: string; kind: string } = ANSWER,
  mode?: "modify" | "create" | "delete",
): string {
  return serializeSelections([
    {
      locator: { path: address.path, name: address.symbol, kind: address.kind },
      space: null,
      matcher: null,
      pick: null,
      replacement: mode === "delete" ? "" : null,
    },
  ]);
}

// A chain of distinct applied edits `return i;` → `return i + 1;`, one per
// round, so a scripted check can fail exactly the first N verifications (#54).
function chainedEdits(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    editResponse(`return ${index + 1};`, `return ${index + 2};`),
  );
}

// A storm of distinct `stage: protocol` rejections. Distinct text keeps the
// repeated no-progress fingerprint from preempting the intended cadence (#57).
function protocolRejections(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `not json ${index}`);
}

function fixtureDir(extraExclude: string[] = []): string {
  const dir = tempDir();
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "ESNext",
          moduleResolution: "bundler",
          types: [],
        },
        include: ["src"],
        exclude: ["src/**/*.test.ts", ...extraExclude],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(dir, "src", "helper.ts"),
    "export function answer(): number {\n  return 1;\n}\n",
  );
  writeFileSync(
    join(dir, "src", "helper.test.ts"),
    'import { expect, test } from "bun:test";\nimport { answer } from "./helper";\n\ntest("answer", () => {\n  expect(answer()).toBe(2);\n});\n',
  );
  return dir;
}

function helperSource(dir: string): string {
  return readFileSync(join(dir, "src", "helper.ts"), "utf8");
}

function passingFixtureDir(extraExclude: string[] = []): string {
  const dir = fixtureDir(extraExclude);
  writeFileSync(
    join(dir, "src", "helper.ts"),
    "export function answer(): number {\n  return 2;\n}\n",
  );
  return dir;
}

function brokenFixtureDir(): string {
  const dir = fixtureDir(["src/broken.ts"]);
  writeFileSync(join(dir, "src", "broken.ts"), "function broken( {\n");
  return dir;
}

function passingBrokenFixtureDir(): string {
  const dir = passingFixtureDir(["src/broken.ts"]);
  writeFileSync(join(dir, "src", "broken.ts"), "function broken( {\n");
  return dir;
}

// A bun -e script used as the test command: the loop appends the targeted
// sibling path to its argv, so the script can log and branch on it.
function invocationScript(dir: string, failOnTargeted: boolean): string[] {
  const logPath = join(dir, "invocations.log");
  const script = [
    'const { appendFileSync } = require("node:fs");',
    `const args = process.argv.slice(1);`,
    `appendFileSync(${JSON.stringify(logPath)}, (args.length === 0 ? "(full)" : args.join(" ")) + "\\n");`,
    'const targeted = args.some((arg) => arg.endsWith("helper.test.ts"));',
    failOnTargeted ? "process.exit(targeted ? 1 : 0);" : "process.exit(0);",
  ].join("\n");
  return ["bun", "-e", script];
}

function invocationLog(dir: string): string[] {
  const path = join(dir, "invocations.log");
  if (!existsSync(path)) {
    return [];
  }
  const text = readFileSync(path, "utf8").trim();
  return text === "" ? [] : text.split("\n");
}

const passingCommand = ["bun", "-e", "process.exit(0)"];
const failingCommand = ["bun", "-e", "process.exit(1)"];

// The #58 wrap-up contract: every termination path's final summary call demands
// the same four labeled lines plus the no-code instruction.
function expectStructuredSummaryPrompt(prompt: string): void {
  expect(prompt).toContain("- Accomplished:");
  expect(prompt).toContain("- Failed and why:");
  expect(prompt).toContain("- Remaining:");
  expect(prompt).toContain("- Next step:");
  expect(prompt).toContain("Do not output code.");
}

// A fake check command: call i prints signatures[i] synthetic tsc diagnostics
// (clamped to the last entry) and exits 1 while the count is positive.
function signatureCheckCommand(dir: string, signatures: number[]): string[] {
  const counterPath = join(dir, "check-calls.txt");
  const script = [
    'const { existsSync, readFileSync, writeFileSync } = require("node:fs");',
    `const counterPath = ${JSON.stringify(counterPath)};`,
    `const signatures = ${JSON.stringify(signatures)};`,
    'const index = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;',
    "writeFileSync(counterPath, String(index + 1));",
    "const count = signatures[Math.min(index, signatures.length - 1)] ?? 0;",
    "for (let i = 0; i < count; i += 1) {",
    "  console.log(`src/helper.ts(${i + 2},3): error TS2322: synthetic ${i}`);",
    "}",
    "process.exit(count > 0 ? 1 : 0);",
  ].join("\n");
  return ["bun", "-e", script];
}

// A check command that fails `failures` verifications with one synthetic
// diagnostic each and passes afterwards (#54 stalled-round tests).
function stallingCheckCommand(dir: string, failures: number): string[] {
  return signatureCheckCommand(dir, [...Array<number>(failures).fill(1), 0]);
}

// A check command that corrupts the create target on its first invocation (the
// window between a create write and the next iteration) and passes afterwards.
function corruptOnceCheckCommand(dir: string, targetPath: string): string[] {
  const marker = join(dir, "corrupt-once.marker");
  const script = [
    'const { existsSync, writeFileSync } = require("node:fs");',
    `const marker = ${JSON.stringify(marker)};`,
    `const target = ${JSON.stringify(join(dir, targetPath))};`,
    `if (!existsSync(marker)) { writeFileSync(marker, "1"); writeFileSync(target, "function broken( {\\n"); process.exit(1); }`,
    "process.exit(0);",
  ].join("\n");
  return ["bun", "-e", script];
}

// Provider with a per-call usage payload; null counts as unreported.
class UsageProvider implements ProviderLike {
  readonly calls: ChatMessage[][] = [];
  private index = 0;

  constructor(
    private readonly responses: string[],
    private readonly usages: readonly unknown[],
  ) {}

  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    const content = this.responses[this.index];
    if (content === undefined) {
      throw new Error("no scripted response");
    }
    this.calls.push(structuredClone(messages));
    const usage = this.usages[this.index] ?? null;
    this.index += 1;
    return { content, toolCalls: [], finishReason: "stop", raw: { usage } };
  }
}

describe("runLoop", () => {
  test("applies, verifies, and returns a successful edit with v2 records", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.locator).toEqual({
      path: "src/helper.ts",
      name: "answer",
      kind: "function",
    });
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(result.records.map((record) => record.kind)).toEqual([
      "exchange",
      "exchange",
      "verification",
    ]);
    expect(result.records[0]?.iteration).toBe(1);
    expect(result.records[0]?.exchange).toBe(1);
    expect(result.records[1]?.exchange).toBe(2);
    expect(result.records[2]?.exchange).toBeNull();
    expect(result.records[1]?.replacement).toBe("return 2;");
    expect(result.records[2]?.replacement).toBe("return 2;");
    expect(result.records[2]?.diagnostics).toBeNull();
    expect(result.terminationReason).toBeUndefined();
    expect(helperSource(dir)).toContain("return 2;");
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content).toBe(buildSystemPrompt());
    expect(result.messages[3]?.content).toContain("```ts");
    expect(provider.calls.length).toBe(2);
  }, 30000);

  test("includes spec file bodies in the initial user prompt", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const initial = provider.calls[0]?.[1]?.content ?? "";
    expect(initial).toContain("# Spec files");
    expect(initial).toContain("## src/helper.test.ts");
    expect(initial).toContain("expect(answer()).toBe(2);");
  }, 30000);

  test("sends no tools to the provider", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(provider.calls.length).toBe(2);
    expect(provider.toolsArgs).toEqual([undefined, undefined]);
  }, 30000);

  test("picking and content revision share one unbounded exchange sequence", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      "not json",
      selectionResponse(),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    // One rejected selection, one successful pick, and the edit: no budget cut.
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "protocol",
      "selected",
      "applied",
      "ok",
    ]);
    expect(result.records.map((record) => record.exchange)).toEqual([1, 2, 3, null]);
    expect(provider.calls.length).toBe(3);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("retries selection after an invalid locator and records the failure", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      "not json",
      selectionResponse(),
      editResponse("return 1;", "return 2;"),
    ]);
    const issue = "make the answer test pass";
    const result = await runLoop({
      cwd: dir,
      issue,
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const failed = result.records[0];
    expect(failed?.outcome).toBe("protocol");
    expect(failed?.kind).toBe("exchange");
    expect(failed?.exchange).toBe(1);
    expect(failed?.replacement).toBeNull();
    expect(failed?.diagnostics).toContain("stage: syntax");

    const files = discoverSourceFiles(dir);
    const initialMessages = provider.calls[0] ?? [];
    expect(initialMessages).toHaveLength(2);
    expect(initialMessages[0]?.role).toBe("system");
    expect(initialMessages[0]?.content).toBe(buildSystemPrompt());
    expect(initialMessages[1]?.role).toBe("user");
    expect(initialMessages[1]?.content).toBe(
      buildEditDslUserPrompt(
        issue,
        buildEditDslSymbolIndex(buildIndexTolerant(files).index),
        selectSpecFiles(issue, files),
      ),
    );

    const retryMessages = provider.calls[1] ?? [];
    expect(retryMessages.slice(0, initialMessages.length)).toEqual(initialMessages);
    expect(retryMessages.length - initialMessages.length).toBe(2);
    const tail = retryMessages.slice(initialMessages.length);
    expect(tail[0]).toEqual({ role: "assistant", content: "not json" });
    expect(tail[1]?.role).toBe("user");
    const retryPrompt = tail[1]?.content ?? "";
    expect(retryPrompt).toBe(
      buildEditDslSelectionRetryPrompt(
        issue,
        buildEditDslSymbolIndex(buildIndexTolerant(files).index),
        result.records[0]?.diagnostics ?? "",
      ),
    );
    expect(retryPrompt).toContain("stage: syntax");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("soft failures retry past three exchanges; the no-progress ask offers STOP", async () => {
    const dir = fixtureDir();
    // Distinct replies so the repeated-fingerprint stop does not fire first.
    const rejections = Array.from(
      { length: MAX_STALLED_ROUNDS },
      (_, index) => `not json ${index}`,
    );
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...rejections,
      "  Stop\n",
      "the model could not produce an edit",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    // Eight rejected content exchanges in one round: no 3-exchange cut, and the
    // next prompt is the no-progress ask.
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      ...Array<"protocol">(MAX_STALLED_ROUNDS).fill("protocol"),
      "stopped",
    ]);
    expect(result.records.filter((record) => record.outcome === "protocol")).toHaveLength(
      MAX_STALLED_ROUNDS,
    );
    expect(result.records.every((record) => record.iteration === 1)).toBe(true);
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed attempts.`);
    expect(ask).toContain("Reply exactly `STOP` to end the run now");
    expect(ask).not.toContain("failed verification");
    expect(result.diagnostics).toContain(
      `the model replied STOP after ${MAX_STALLED_ROUNDS} consecutive failed attempts`,
    );
    // Selection + 8 rejections + the ask (answered STOP) + one summary call.
    expect(provider.calls.length).toBe(11);
    const summaryPrompt = provider.calls[10]?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain("The run is over");
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("the model could not produce an edit");
    expect(result.messages.at(-1)?.content).toContain("The run is over");
    expect(helperSource(dir)).toContain("return 1;");
  }, 30000);

  test("a successful pick after several rejections opens the edit in the same round", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      "not json",
      "still not json",
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "protocol",
      "protocol",
      "selected",
      "applied",
      "ok",
    ]);
    // No round boundary: every exchange belongs to the first round.
    expect(result.records.map((record) => record.iteration)).toEqual([1, 1, 1, 1, 1]);
    expect(result.records.map((record) => record.exchange)).toEqual([1, 2, 3, 4, null]);
    // The post-pick prompt is the fresh edit prompt, not an exhausted-round
    // continuation.
    const contentPrompt = provider.calls[3]?.at(-1)?.content ?? "";
    expect(contentPrompt).toContain("A reply is one or more `select … end` clauses");
    expect(contentPrompt).not.toContain("No progress:");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("a run is not cut at 32 rounds; a later verification passes", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(34),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: stallingCheckCommand(dir, 33),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    const applied = result.records.filter((record) => record.outcome === "applied");
    expect(applied).toHaveLength(34);
    expect(result.records.filter((record) => record.outcome === "tsc")).toHaveLength(33);
    expect(result.records.at(-1)?.outcome).toBe("ok");
    // A round past the old 32-round cap was applied, so no fixed cut exists.
    expect(applied.some((record) => (record.iteration ?? 0) > 32)).toBe(true);
    // One selection + 34 content edits; success needs no summary call.
    expect(provider.calls).toHaveLength(35);
    // Keep-progress: the final edit stays on disk.
    expect(helperSource(dir)).toContain("return 35;");
  }, 60000);

  test("the token budget stops a long failing content loop", async () => {
    const dir = fixtureDir();
    const provider = new UsageProvider(
      [selectionResponse(ANSWER, "modify"), ...chainedEdits(2), "the budget ran out"],
      [{ total_tokens: 40 }, { total_tokens: 40 }, { total_tokens: 40 }, { total_tokens: 1 }],
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      tokenBudget: 100,
      checkCommand: failingCommand,
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("token-budget");
    expect(result.diagnostics).toContain(
      "token-budget: accumulated 120 tokens exceeded the 100 token budget",
    );
    // Selection (40) + one applied content edit (80) fit; the second content
    // response crosses the budget before it can be applied.
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "tsc"]);
    // Selection + two content calls + exactly one summary call.
    expect(provider.calls).toHaveLength(4);
    const summaryPrompt = provider.calls[3]?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain("The run is over");
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("the budget ran out");
  }, 30000);

  test("treats a bare STOP outside a no-progress ask as a protocol failure", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      "STOP",
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "protocol",
      "applied",
      "ok",
    ]);
    expect(result.records[1]?.diagnostics?.startsWith("stage: syntax\n")).toBe(true);
    // The STOP is answered with the ordinary exchange retry prompt.
    const retryPrompt = (provider.calls[2] ?? []).at(-1)?.content ?? "";
    expect(retryPrompt).toContain("Edit exchange 3 failed.");
    expect(retryPrompt).toContain("stage: syntax");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("asks for a decision after 8 consecutive failed attempts and passes when the model continues", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(9),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.records.filter((record) => record.outcome === "tsc")).toHaveLength(8);
    expect(result.records.at(-2)?.outcome).toBe("applied");
    expect(result.records.at(-1)?.outcome).toBe("ok");
    // Round 8 (7 failed rounds) still opens with the ordinary verification retry.
    const ordinary = provider.calls[8]?.at(-1)?.content ?? "";
    expect(ordinary).toContain("Edit exchange 1 failed verification.");
    expect(ordinary).not.toContain("consecutive failed attempts");
    // Round 9 (8 failed rounds) opens with the no-progress ask; because the #71
    // pattern is already unchanged, the first ask is a decision-only turn.
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(MAX_STALLED_ROUNDS).toBe(8);
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed attempts.`);
    expect(ask).toContain("Reply exactly `STOP` to end the run now");
    expect(ask).toContain("This is a decision turn");
    expect(ask).toContain("Do not send an edit clause on this turn");
    // The failing diagnostics and history are kept; the edit template is gone.
    expect(ask).toContain("Diagnostics:");
    expect(ask).toContain("Failure history: the failing set is unchanged");
    expect(ask).not.toContain("A reply is one or more `select … end` clauses");
    expect(ask).not.toContain("Edit exchange 1 failed verification.");
    // A valid edit reply on the decision turn is still a real attempt and
    // continues through the unchanged guards.
    expect(helperSource(dir)).toContain("return 10;");
  }, 30000);

  test("STOP at the no-progress ask ends the run with one summary and the stalled diagnostics", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(8),
      "  stop\n",
      "the failures could not be resolved",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    const stopped = result.records.at(-1);
    expect(stopped?.outcome).toBe("stopped");
    expect(stopped?.iteration).toBe(9);
    expect(stopped?.exchange).toBe(1);
    expect(stopped?.replacement).toBe("  stop\n");
    // The stalled stop names the consecutive failed attempts, distinct from #52's
    // exhausted-round text, and carries the diagnostics shown in the ask.
    expect(stopped?.diagnostics).toContain(
      `edit-exhausted: the model replied STOP after ${MAX_STALLED_ROUNDS} consecutive failed attempts`,
    );
    // Distinct from #52's continuation-round STOP text.
    expect(stopped?.diagnostics).not.toContain("replied STOP after 8 rounds");
    expect(stopped?.diagnostics).toContain("stage: tsc");
    expect(result.diagnostics).toContain(
      `the model replied STOP after ${MAX_STALLED_ROUNDS} consecutive failed attempts`,
    );
    // Exactly one summary call, as the final action.
    expect(provider.calls.length).toBe(11);
    const summaryPrompt = provider.calls[10]?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain("The run is over");
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("the failures could not be resolved");
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed attempts.`);
    // Keep-progress: the last applied edit stays on disk.
    expect(helperSource(dir)).toContain("return 9;");
  }, 30000);

  test("repeats the no-progress ask at 16 consecutive failed attempts with the updated count", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(17),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS * 2),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.records.filter((record) => record.outcome === "tsc")).toHaveLength(16);
    // Round 16 (15 failed rounds) is ordinary; round 17 (16 failed) asks again.
    const ordinary = provider.calls[16]?.at(-1)?.content ?? "";
    expect(ordinary).toContain("Edit exchange 1 failed verification.");
    expect(ordinary).not.toContain("consecutive failed attempts");
    const ask = provider.calls[17]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS * 2} consecutive failed attempts.`);
    expect(helperSource(dir)).toContain("return 18;");
  }, 30000);

  test("does not ask below MAX_STALLED_ROUNDS even after repeated failed verifications", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(8),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS - 1),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    // Round 8 (7 failed rounds) keeps the ordinary verification retry header.
    const round8 = provider.calls[8]?.at(-1)?.content ?? "";
    expect(round8).toContain("Edit exchange 1 failed verification.");
    for (const call of provider.calls) {
      expect(call.at(-1)?.content ?? "").not.toContain("No progress:");
    }
  }, 30000);

  test("carries a non-edit reply at the stalled decision turn as the approach, then retries normally", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(8),
      "not json",
      editResponse("return 9;", "return 10;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed attempts.`);
    expect(ask).toContain("This is a decision turn");
    // The non-edit reply is the stated re-approach, not a protocol failure; the
    // ask shapes only the first content prompt of the round, so the soft-failure
    // retry is an ordinary exchange retry carrying the approach.
    const retry = provider.calls[10]?.at(-1)?.content ?? "";
    expect(retry).toContain("Edit exchange 2 failed verification.");
    expect(retry).toContain("Approach to apply:");
    expect(retry).toContain("not json");
    expect(retry).not.toContain("No progress:");
    expect(result.records.filter((record) => record.outcome === "protocol")).toHaveLength(0);
    expect(helperSource(dir)).toContain("return 10;");
  }, 30000);

  test("a rejected exchange counts toward the same no-progress streak (#60)", async () => {
    const dir = fixtureDir();
    // Seven failed verifications (streak 7), then one rejected exchange (streak
    // 8): the next prompt is the decision-only ask, even inside the round.
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(7),
      ...protocolRejections(1),
      // The decision turn's non-edit reply is the stated re-approach, not a
      // protocol failure, so it does not advance the streak.
      "not json",
      editResponse("return 8;", "return 9;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: stallingCheckCommand(dir, 7),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.records.filter((record) => record.outcome === "tsc")).toHaveLength(7);
    // The first rejection is recorded; the decision reply is not.
    expect(result.records.filter((record) => record.outcome === "protocol")).toHaveLength(1);
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed attempts.`);
    expect(ask).toContain("This is a decision turn");
    // The digest mixes both no-progress shapes: 7 verifications + 1 rejection.
    expect(ask).toContain("Prior attempts (8):");
    expect(ask).toContain(
      "tsc: replacement line 1: TS2322: synthetic 0 — in declaration `answer` (function)",
    );
    expect(ask).toContain("- #8 protocol: code: EDIT_MISSING_FIELD");
    expect(helperSource(dir)).toContain("return 9;");
  }, 30000);

  test("fires the no-progress ask after 8 rejected exchanges (#60)", async () => {
    const dir = fixtureDir();
    // Eight distinct rejections reach the first milestone; the ask is an offer,
    // and the next edit applies and verifies.
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...protocolRejections(MAX_STALLED_ROUNDS),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.filter((record) => record.outcome === "protocol")).toHaveLength(
      MAX_STALLED_ROUNDS,
    );
    // The ask fires exactly once, in rejection cycles exactly as in
    // verification-failure cycles.
    const asks = provider.calls.filter((call) =>
      (call.at(-1)?.content ?? "").includes("No progress:"),
    );
    expect(asks).toHaveLength(1);
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed attempts.`);
    expect(ask).toContain("Reply exactly `STOP` to end the run now");
    expect(ask).toContain("only if the failures cannot be resolved");
    expect(ask).toContain("materially different approach rather than another minimal attempt");
    // The digest is carried with the rejection classes and the ruled-out block.
    expect(ask).toContain(`Prior attempts (${MAX_STALLED_ROUNDS}):`);
    expect(ask).toContain(`- #${MAX_STALLED_ROUNDS} protocol: code: EDIT_MISSING_FIELD`);
    expect(ask).toContain(
      `Ruled out after ${MAX_STALLED_ROUNDS} repeats: protocol — This attempt MUST reply with only \`select … end\` clauses`,
    );
    // The retry shape is kept: pinned selection, current source, diagnostics,
    // JSON output shape, and no fixed-budget wording.
    expect(ask).toContain("# details");
    expect(ask).toContain("Diagnostics:");
    expect(ask).toContain("A reply is one or more `select … end` clauses");
    // Continue-through: the ask is an offer, and the edit applies and verifies.
    expect(result.records.at(-2)?.outcome).toBe("applied");
    expect(result.records.at(-1)?.outcome).toBe("ok");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("STOP at the rejection-cycle ask ends the run with one summary and the stalled diagnostics (#60)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...protocolRejections(MAX_STALLED_ROUNDS),
      "  stop\n",
      "the rejection storm could not be resolved",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records).toHaveLength(MAX_STALLED_ROUNDS + 2);
    const stopped = result.records.at(-1);
    expect(stopped?.outcome).toBe("stopped");
    expect(stopped?.iteration).toBe(1);
    expect(stopped?.exchange).toBe(MAX_STALLED_ROUNDS + 2);
    expect(stopped?.replacement).toBe("  stop\n");
    // The stalled STOP names the consecutive failed attempts and keeps the
    // ask's chain diagnostics.
    expect(stopped?.diagnostics).toContain(
      `edit-exhausted: the model replied STOP after ${MAX_STALLED_ROUNDS} consecutive failed attempts`,
    );
    expect(stopped?.diagnostics).toContain("stage: syntax");
    // Exactly one summary call, as the final action.
    expect(provider.calls).toHaveLength(MAX_STALLED_ROUNDS + 3);
    const summaryPrompt = provider.calls[MAX_STALLED_ROUNDS + 2]?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain("The run is over");
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("the rejection storm could not be resolved");
    // The shared termination chain renders the failure artifact too.
    const artifact = renderFailureArtifact({ rootDir: dir, result });
    expect(artifact).toContain("edit-exhausted");
    expect(artifact).toContain(
      `the model replied STOP after ${MAX_STALLED_ROUNDS} consecutive failed attempts`,
    );
  }, 30000);

  test("the no-progress ask carries an updated prior-attempts digest (#57)", async () => {
    const dir = fixtureDir();
    const attempts = Array.from({ length: MAX_STALLED_ROUNDS }, (_, index) =>
      editResponse(`return ${90 + index};`, "return 2;"),
    );
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...attempts,
      "STOP",
      "the matcher failures could not be resolved",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      ...Array<"matcher">(MAX_STALLED_ROUNDS).fill("matcher"),
      "stopped",
    ]);
    // The ordinary retry before the milestone carries no digest.
    const ordinary = provider.calls[8]?.at(-1)?.content ?? "";
    expect(ordinary).not.toContain("Prior attempts");
    // The ask carries the whole failing chain, numbered from the first attempt.
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed attempts.`);
    expect(ask).toContain(`Prior attempts (${MAX_STALLED_ROUNDS}):`);
    expect(ask).toContain("- #1 matcher-not-found: clause 1 of 1");
    expect(ask).toContain(`- #${MAX_STALLED_ROUNDS} matcher-not-found:`);
    expect(ask).toContain(
      `Ruled out after ${MAX_STALLED_ROUNDS} repeats: matcher-not-found — This attempt MUST omit \`match\` and return the complete declaration in a \`select … replace with\` clause.`,
    );
    // The repeated matcher failures never touched the file.
    expect(helperSource(dir)).toContain("return 1;");
  }, 30000);

  test("the no-progress digest rules out a class after three repeats (#57)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 80;", "return 2;"),
      editResponse("return 81;", "return 2;"),
      editResponse("return 82;", "return 2;"),
      ...Array.from({ length: 5 }, (_, index) => `not json ${index}`),
      "STOP",
      "the failures came in classes",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "matcher",
      "matcher",
      "matcher",
      "protocol",
      "protocol",
      "protocol",
      "protocol",
      "protocol",
      "stopped",
    ]);
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`Prior attempts (${MAX_STALLED_ROUNDS}):`);
    expect(ask).toContain(
      "Ruled out after 3 repeats: matcher-not-found — This attempt MUST omit `match` and return the complete declaration in a `select … replace with` clause.",
    );
    expect(ask).toContain("Ruled out after 5 repeats: protocol —");
    expect(ask).toContain("- #4 protocol:");
  }, 30000);

  test("the selection no-progress ask carries the digest and its class counts (#57)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      ...Array.from({ length: MAX_STALLED_ROUNDS }, (_, index) => `not json ${index}`),
      "STOP",
      "the selection never came",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records.map((record) => record.outcome)).toEqual([
      ...Array<"protocol">(MAX_STALLED_ROUNDS).fill("protocol"),
      "stopped",
    ]);
    const ask = provider.calls[8]?.at(-1)?.content ?? "";
    expect(ask).toContain(
      `No progress: ${MAX_STALLED_ROUNDS} consecutive failed selection attempts; no fixed selection budget applies.`,
    );
    expect(ask).toContain(`Prior attempts (${MAX_STALLED_ROUNDS}):`);
    expect(ask).toContain("- #1 protocol:");
    expect(ask).toContain(
      `Ruled out after ${MAX_STALLED_ROUNDS} repeats: protocol — This attempt MUST reply with only \`select … end\` clauses or file commands`,
    );
  }, 30000);

  test("the no-progress ask carries the digest and ordinary retries do not (#57)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(9),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    // The ordinary verification retry of round 8 stays digest-free.
    const ordinary = provider.calls[8]?.at(-1)?.content ?? "";
    expect(ordinary).toContain("Edit exchange 1 failed verification.");
    expect(ordinary).not.toContain("Prior attempts");
    // The round-9 ask carries the whole failing chain.
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed attempts.`);
    expect(ask).toContain(`Prior attempts (${MAX_STALLED_ROUNDS}):`);
    expect(ask).toContain(
      "- #1 tsc: replacement line 1: TS2322: synthetic 0 — in declaration `answer` (function)",
    );
    expect(ask).toContain(
      `- #${MAX_STALLED_ROUNDS} tsc: replacement line 1: TS2322: synthetic 0 — in declaration \`answer\` (function)`,
    );
    expect(ask).toContain(
      `Ruled out after ${MAX_STALLED_ROUNDS} repeats: tsc — change the declaration structure instead of re-editing the same spot`,
    );
    expect(helperSource(dir)).toContain("return 10;");
  }, 30000);

  test("the digest never leaks replacement text and rides only no-progress asks (#57)", async () => {
    const dir = fixtureDir();
    const marker = "NO_LEAK_MARKER_57";
    const gateReplies = Array.from({ length: MAX_STALLED_ROUNDS }, (_, index) =>
      editResponse(null, `function answer(): number {\n  return ${index + 2};) ${marker}\n}`),
    );
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...gateReplies,
      "STOP",
      "the edits never parsed",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      ...Array<"gate">(MAX_STALLED_ROUNDS).fill("gate"),
      "stopped",
    ]);
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    const digestAt = ask.indexOf("Prior attempts");
    expect(digestAt).toBeGreaterThan(-1);
    // The prompt before the digest carries the gate code frame with the raw
    // replacement text...
    expect(ask.slice(0, digestAt)).toContain(marker);
    // ...the digest section keeps only the chosen diagnostics line.
    const digest = ask.slice(digestAt);
    expect(digest).toContain(`Prior attempts (${MAX_STALLED_ROUNDS}):`);
    expect(digest).toContain("- #1 gate: clause 1 of 1");
    expect(digest).not.toContain(marker);
    expect(digest).not.toContain("stage: ");
    // Ordinary retries carry no digest at all.
    expect(provider.calls[1]?.at(-1)?.content ?? "").not.toContain("Prior attempts");
    expect(provider.calls[2]?.at(-1)?.content ?? "").not.toContain("Prior attempts");
    // Every captured digest section is marker-free.
    for (const call of provider.calls) {
      const content = call.at(-1)?.content ?? "";
      const at = content.indexOf("Prior attempts");
      if (at >= 0) {
        expect(content.slice(at)).not.toContain(marker);
      }
    }
  }, 30000);

  test("fixes the pinned target for the run and revises content only", async () => {
    const dir = fixtureDir();
    const badEdit = editResponse("return 1;", 'return "nope";');
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      badEdit,
      editResponse('return "nope";', "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "applied",
      "ok",
    ]);
    expect(result.records.map((record) => record.iteration)).toEqual([1, 1, 1, 2, 2]);
    expect(result.records.map((record) => record.exchange)).toEqual([1, 2, null, 1, null]);
    expect(result.records[1]?.diagnostics).toBeNull();
    expect(result.records[2]?.diagnostics).toContain("not assignable");
    expect(helperSource(dir)).toContain("return 2;");
    // The second iteration does not re-pick: content-only with a fresh budget.
    const retryCall = provider.calls[2] ?? [];
    expect(retryCall.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(retryCall[2]?.content).toBe(selectionResponse(ANSWER, "modify"));
    const retryPrompt = retryCall[3]?.content ?? "";
    expect(retryPrompt).toContain("Edit exchange 1 failed verification.");

    expect(retryPrompt).toContain("not assignable");
    expect(retryPrompt).toContain("# details");
  }, 30000);

  test("omits the spec-file section from a tsc-stage repair round", async () => {
    const dir = fixtureDir();
    const issue = "make the answer test pass";
    const files = discoverSourceFiles(dir);
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", "return 3;"),
      "not json",
      editResponse("return 3;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue,
      provider,
      checkCommand: signatureCheckCommand(dir, [1, 0]),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "protocol",
      "applied",
      "ok",
    ]);
    // Round 1 predates any verification failure: both of its prompts carry the
    // spec-file section.
    const indexText = buildEditDslSymbolIndex(buildIndexTolerant(files).index);
    const fullPrompt = buildEditDslUserPrompt(issue, indexText, selectSpecFiles(issue, files));
    expect(fullPrompt).toContain("# Spec files");
    expect(provider.calls[0]?.[1]?.content).toBe(fullPrompt);
    expect(provider.calls[1]?.[1]?.content).toBe(fullPrompt);
    // The tsc-opened round 2 sends the lean variant on every content exchange.
    const leanPrompt = buildEditDslUserPrompt(issue, indexText, []);
    expect(leanPrompt).not.toContain("# Spec files");
    expect(leanPrompt).toContain("# Goal");
    expect(leanPrompt).toContain("# Symbol index");
    expect(provider.calls[2]?.[1]?.content).toBe(leanPrompt);
    expect(provider.calls[3]?.[1]?.content).toBe(leanPrompt);
  }, 30000);

  test("keeps the spec-file section in a tests-stage repair round", async () => {
    const dir = fixtureDir();
    const issue = "make the answer test pass";
    const files = discoverSourceFiles(dir);
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", "return 3;"),
      editResponse("return 3;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue,
      provider,
      checkCommand: passingCommand,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tests",
      "applied",
      "ok",
    ]);
    const fullPrompt = buildEditDslUserPrompt(
      issue,
      buildEditDslSymbolIndex(buildIndexTolerant(files).index),
      selectSpecFiles(issue, files),
    );
    expect(provider.calls[1]?.[1]?.content).toBe(fullPrompt);
    expect(provider.calls[2]?.[1]?.content).toBe(fullPrompt);
    expect(provider.calls[2]?.[1]?.content).toContain("# Spec files");
  }, 30000);

  test("keeps a tsc-repair retry lean", async () => {
    const dir = fixtureDir();
    const issue = "make the answer test pass";
    const files = discoverSourceFiles(dir);
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", "return 3;"),
      "not json",
      "still not json",
      "nope",
      editResponse("return 3;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue,
      provider,
      checkCommand: signatureCheckCommand(dir, [1, 0]),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "protocol",
      "protocol",
      "protocol",
      "applied",
      "ok",
    ]);
    // #57 has no round continuation: every retry of the tsc-opened chain stays
    // in iteration 2.
    expect(result.records.map((record) => record.iteration)).toEqual([1, 1, 1, 2, 2, 2, 2, 2]);
    // Every content exchange of the tsc-opened chain is lean.
    const leanPrompt = buildEditDslUserPrompt(
      issue,
      buildEditDslSymbolIndex(buildIndexTolerant(files).index),
      [],
    );
    for (const call of [
      provider.calls[2],
      provider.calls[3],
      provider.calls[4],
      provider.calls[5],
    ]) {
      expect(call?.[1]?.content).toBe(leanPrompt);
    }
    expect(provider.calls[5]?.at(-1)?.content).toContain("Edit exchange 4 failed.");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("rebuilds a bounded retry history without echoing the previous replacement", async () => {
    const dir = fixtureDir();
    const locator = selectionResponse(ANSWER, "modify");
    const badEdit = editResponse("return 1;", 'return "nope";');
    const provider = new ScriptedProvider([
      locator,
      badEdit,
      editResponse('return "nope";', "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const retryCall = provider.calls[2] ?? [];
    expect(retryCall).toHaveLength(4);
    expect(retryCall.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(retryCall[2]).toEqual({ role: "assistant", content: locator });
    // The previous assistant replacement is not re-echoed as a message; the raw
    // response text only reappears as reformatted current source in the prompt.
    expect(retryCall.some((message) => message.content === badEdit)).toBe(false);
    const retryPrompt = retryCall[3]?.content ?? "";
    expect(retryPrompt).toContain("Edit exchange 1 failed verification.");

    expect(retryPrompt).toContain("not assignable");
    expect(retryPrompt).toContain("# details");
    expect(retryPrompt).toContain('return "nope";');
  }, 30000);

  test("a repair retry keeps the opening verification diagnostics", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", 'return "nope";'),
      "not json",
      editResponse('return "nope";', "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: signatureCheckCommand(dir, [1, 0]),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "protocol",
      "applied",
      "ok",
    ]);
    // The retry after the soft failure still shows the verification failure
    // that opened the repair iteration.
    const retryPrompt = (provider.calls[3] ?? []).at(-1)?.content ?? "";
    expect(retryPrompt).toContain("stage: tsc");
    expect(retryPrompt).toContain("synthetic 0");
    expect(retryPrompt).toContain("stage: syntax");
    expect(retryPrompt.indexOf("stage: tsc")).toBeLessThan(retryPrompt.indexOf("stage: syntax"));
  }, 30000);

  test("applies a whole-symbol replacement that begins with export without duplicating it", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse(null, "export function answer(): number {\n  return 2;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    // Exactly one copy of the modifier: the preceding `export ` is kept.
    expect(helperSource(dir)).toBe("export function answer(): number {\n  return 2;\n}\n");
  }, 30000);

  test("strips a leading export with any whitespace on a whole-symbol rewrite (#50)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse(null, "export\nfunction answer(): number {\n  return 2;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    // Exactly one copy of the modifier: `export\n` was stripped, the preceding
    // `export ` is kept.
    expect(helperSource(dir)).toBe("export function answer(): number {\n  return 2;\n}\n");
  }, 30000);

  test("a body-level match does not get the leading-export tolerance (#50)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", "export\nfunction answer(): number {\n  return 2;\n}"),
      editResponse(null, "function answer(): number {\n  return 2;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "applied",
      "ok",
    ]);
    // The body-level replacement kept its `export` (the tolerance applies only
    // when the match covers the whole declaration), so tsc saw a modifier
    // inside the body; the whole-symbol rewrite then repaired it.
    expect(result.records[2]?.diagnostics).toContain("Modifiers cannot appear here");
    expect(helperSource(dir)).toBe("export function answer(): number {\n  return 2;\n}\n");
  }, 30000);

  test("rejects an edit that adds a duplicate top-level type", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      'export function answer(): number {\n  return 1;\n}\n\nexport type AnswerKind = "one";\n',
    );
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse(
        null,
        'function answer(): number {\n  return 2;\n}\n\nexport type AnswerKind = "one";',
      ),
      editResponse(null, "function answer(): number {\n  return 2;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "duplicate",
      "applied",
      "ok",
    ]);
    expect(result.records[1]?.diagnostics).toContain(
      'stage: duplicate\nthe edit was discarded: it would add a second top-level type "AnswerKind" (src/helper.ts already declares it at line 5); replace the existing declaration instead of adding another copy',
    );
    // The duplicate was never written: one type alias remains.
    const content = helperSource(dir);
    expect(content.match(/type AnswerKind/g)).toHaveLength(1);
    expect(content).toContain("return 2;");
  }, 30000);

  test("allows new top-level declarations and matcher-range edits without duplicates", async () => {
    const newDir = fixtureDir();
    const newProvider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse(
        null,
        'function answer(): number {\n  return 2;\n}\n\nexport type Fresh = "new";',
      ),
    ]);
    const newResult = await runLoop({
      cwd: newDir,
      issue: "make the answer test pass",
      provider: newProvider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(newResult.ok).toBe(true);
    expect(helperSource(newDir)).toContain('export type Fresh = "new";');

    const rangeDir = fixtureDir();
    const rangeProvider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", "return 2;"),
    ]);
    const rangeResult = await runLoop({
      cwd: rangeDir,
      issue: "make the answer test pass",
      provider: rangeProvider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(rangeResult.ok).toBe(true);
    expect(helperSource(rangeDir)).toContain("return 2;");
  }, 60000);

  test("rejects a create append that duplicates an existing top-level name", async () => {
    const dir = passingFixtureDir();
    const fresh = { path: "src/helper.ts", symbol: "fresh", kind: "function" };
    const provider = new ScriptedProvider([
      selectionResponse(fresh, "create"),
      createResponse(
        fresh,
        "export function fresh(): number {\n  return 1;\n}\n\nexport function answer(): number {\n  return 3;\n}",
      ),
      createResponse(fresh, "export function fresh(): number {\n  return 3;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "add a fresh function",
      provider,
      checkCommand: passingCommand,
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("create");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "duplicate",
      "applied",
      "ok",
    ]);
    expect(result.records[1]?.diagnostics).toContain(
      'stage: duplicate\nthe edit was discarded: it would add a second top-level function "answer" (src/helper.ts already declares it at line 1); replace the existing declaration instead of adding another copy',
    );
    const content = helperSource(dir);
    expect(content.match(/function answer/g)).toHaveLength(1);
    expect(content.match(/function fresh/g)).toHaveLength(1);
  }, 30000);

  test("keeps a failing edit on disk and ends edit-exhausted with the verification diagnostics", async () => {
    const dir = fixtureDir();
    const original = helperSource(dir);
    const badEdit = editResponse("return 1;", 'return "nope";');
    const secondBadEdit = editResponse('return "nope";', 'return "nope!";');
    const badProtocol = Array.from({ length: 6 }, (_, index) => `bad ${index}`);
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      badEdit,
      secondBadEdit,
      ...badProtocol,
      "STOP",
      "the replacement never verifies",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: failingCommand,
      testCommand: failingCommand,
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "applied",
      "tsc",
      ...Array<"protocol">(6).fill("protocol"),
      "stopped",
    ]);
    // No rollback (#30): the last attempted text is what stays on disk.
    const finalSource = helperSource(dir);
    expect(finalSource).toContain('return "nope!";');
    expect(finalSource).not.toBe(original);
    // The summary carries the diagnostics that opened the repair chain and the
    // last edit failure.
    expect(result.diagnostics).toContain("edit-exhausted");
    expect(result.diagnostics).toContain("stage: tsc");
    expect(result.diagnostics).toContain("stage: syntax");
    expect(result.diagnostics).toContain(
      `the model replied STOP after ${MAX_STALLED_ROUNDS} consecutive failed attempts`,
    );
    expect(provider.calls.length).toBe(11);
    const summaryPrompt = provider.calls[10]?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain("The run is over");
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("the replacement never verifies");
  }, 30000);

  test("observes verification signatures across continued rounds", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", 'return "nope";'),
      editResponse('return "nope";', 'return "nope!";'),
      ...Array.from({ length: 6 }, (_, index) => `bad ${index}`),
      "STOP",
      "the signature stalls",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: signatureCheckCommand(dir, [3, 2]),
      testCommand: failingCommand,
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    const verificationRows = result.records.filter((record) => record.kind === "verification");
    expect(verificationRows.map((record) => record.outcome)).toEqual(["tsc", "tsc"]);
    // Signatures are an observation only: the model's STOP ends the run.
    expect(verificationRows.map((record) => record.signature)).toEqual([3, 2]);
    expect(result.records.filter((record) => record.kind === "exchange")).toHaveLength(10);
  }, 30000);

  test("token budget: cache-excluded basis ignores cached prompt tokens", () => {
    const response: ChatResponse = {
      content: null,
      toolCalls: [],
      finishReason: "stop",
      raw: {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      },
    };
    expect(budgetTokensFromResponse(response)).toBe(120);
    expect(budgetTokensFromResponse(response, "cache-excluded")).toBe(40);
    expect(budgetTokensFromResponse(response, "raw")).toBe(120);
    expect(loopTokensFromResponse(response)).toEqual({
      input: 100,
      output: 20,
      total: 120,
      cacheRead: 80,
      reasoning: 0,
    });
    expect(cacheExcludedTokens(loopTokensFromResponse(response))).toBe(40);
  });

  test("token budget: cache-excluded basis adds reasoning; raw keeps the reported total", () => {
    const nested: ChatResponse = {
      content: null,
      toolCalls: [],
      finishReason: "stop",
      raw: {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 80 },
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      },
    };
    // (100 - 80) + 20 + 30 = 70; the raw safety cap keeps the reported total.
    expect(budgetTokensFromResponse(nested, "cache-excluded")).toBe(70);
    expect(budgetTokensFromResponse(nested, "raw")).toBe(150);
    expect(loopTokensFromResponse(nested)).toEqual({
      input: 100,
      output: 20,
      total: 150,
      cacheRead: 80,
      reasoning: 30,
    });

    const topLevel: ChatResponse = {
      content: null,
      toolCalls: [],
      finishReason: "stop",
      raw: {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 80 },
          reasoning_tokens: 30,
        },
      },
    };
    expect(budgetTokensFromResponse(topLevel, "cache-excluded")).toBe(70);
    expect(loopTokensFromResponse(topLevel).reasoning).toBe(30);

    const unknown: ChatResponse = {
      content: null,
      toolCalls: [],
      finishReason: "stop",
      raw: { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    };
    expect(loopTokensFromResponse(unknown).reasoning).toBe(0);
    expect(budgetTokensFromResponse(unknown, "cache-excluded")).toBe(15);
  });

  test("token budget: terminates with exactly one summary call on a pick", async () => {
    const dir = fixtureDir();
    const provider = new UsageProvider(
      [selectionResponse(), "the budget ran out"],
      [{ total_tokens: 60 }],
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      tokenBudget: 50,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("token-budget");
    expect(result.locator).toBeNull();
    expect(result.filePath).toBeNull();
    expect(result.mode).toBeUndefined();
    expect(result.records).toEqual([]);
    expect(result.editedSource).toBeNull();
    expect(result.diagnostics).toBe(
      "token-budget: accumulated 60 tokens exceeded the 50 token budget",
    );
    expect(provider.calls).toHaveLength(2);
    const summaryPrompt = provider.calls[1]?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain("The run is over");
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("the budget ran out");
    expect(helperSource(dir)).toContain("return 1;");
  }, 30000);

  test("token budget: the termination summary stays out of result.tokens", async () => {
    const dir = fixtureDir();
    const provider = new UsageProvider(
      [selectionResponse(), "the budget ran out"],
      [
        {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 80 },
          completion_tokens_details: { reasoning_tokens: 30 },
        },
        // The summary call's usage must not be folded into the loop tally.
        { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
      ],
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      tokenBudget: 50,
      tokenBudgetBasis: "cache-excluded",
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("token-budget");
    expect(result.diagnostics).toBe(
      "token-budget: accumulated 70 cache-excluded tokens exceeded the 50 token budget",
    );
    // Exactly one summary call after the over-budget response.
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.at(-1)?.content).toContain("The run is over");
    // Loop calls only: the over-budget response's buckets and reasoning, none
    // of the summary's 1000 prompt + 100 completion tokens.
    expect(result.tokens).toEqual({
      input: 100,
      output: 20,
      total: 150,
      cacheRead: 80,
      reasoning: 30,
    });
    expect(cacheExcludedTokens(result.tokens)).toBe(70);
  }, 30000);

  test("token budget: terminates mid-edit without applying the in-flight replacement", async () => {
    const dir = fixtureDir();
    const original = helperSource(dir);
    const provider = new UsageProvider(
      [selectionResponse(), editResponse("return 1;", 'return "nope";'), "the budget ran out"],
      [{ total_tokens: 60 }, { total_tokens: 41 }],
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      tokenBudget: 100,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("token-budget");
    expect(result.diagnostics).toBe(
      "token-budget: accumulated 101 tokens exceeded the 100 token budget",
    );
    expect(result.mode).toBe("modify");
    expect(result.locator).toEqual({ path: "src/helper.ts", name: "answer", kind: "function" });
    expect(result.filePath).toBe("src/helper.ts");
    expect(result.editedSource).toBeNull();
    expect(result.records.map((record) => record.outcome)).toEqual(["selected"]);
    // The in-flight replacement is not applied; the summary is the third call.
    expect(provider.calls).toHaveLength(3);
    const summaryPrompt = provider.calls[2]?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain("The run is over");
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("the budget ran out");
    expect(helperSource(dir)).toBe(original);
  }, 30000);

  test("token budget: runs through when usage lands exactly on the budget", async () => {
    const dir = fixtureDir();
    const provider = new UsageProvider(
      [selectionResponse(), editResponse("return 1;", "return 2;")],
      [{ total_tokens: 60 }, { total_tokens: 40 }],
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      tokenBudget: 100,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.terminationReason).toBeUndefined();
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(helperSource(dir)).toContain("return 2;");
    // No summary call on success.
    expect(provider.calls).toHaveLength(2);
  }, 30000);

  test("token budget: sums prompt and completion tokens when no total is reported", async () => {
    const dir = fixtureDir();
    const provider = new UsageProvider(
      [selectionResponse(), editResponse("return 1;", 'return "nope";'), "summary"],
      [
        { prompt_tokens: 60, completion_tokens: 0 },
        { prompt_tokens: 41, completion_tokens: 0 },
      ],
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      tokenBudget: 100,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("token-budget");
    expect(result.diagnostics).toBe(
      "token-budget: accumulated 101 tokens exceeded the 100 token budget",
    );
    expect(provider.calls).toHaveLength(3);
  }, 30000);

  test("prev-broken: terminates when the file stops parsing before an edit", async () => {
    const dir = fixtureDir();
    let calls = 0;
    const provider: ProviderLike = {
      async chat() {
        calls += 1;
        if (calls === 1) {
          return { content: selectionResponse(), toolCalls: [], finishReason: "stop", raw: {} };
        }
        if (calls === 2) {
          // External modification between selection and the edit call.
          writeFileSync(join(dir, "src", "helper.ts"), "function broken( {\n");
          return {
            content: editResponse("return 1;", "return 2;"),
            toolCalls: [],
            finishReason: "stop",
            raw: {},
          };
        }
        return {
          content: "the file was changed outside the harness",
          toolCalls: [],
          finishReason: "stop",
          raw: {},
        };
      },
    };
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("prev-broken");
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "prev-broken"]);
    expect(result.diagnostics).toContain("stage: prev-broken");
    expect(result.diagnostics).toContain("does not parse");
    // Exactly one summary call as the final action.
    expect(calls).toBe(3);
    expect(result.explanation).toBe("the file was changed outside the harness");
    const summaryPrompt = result.messages.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain(
      "The run is over: the current source of the target no longer parses.",
    );
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(summaryPrompt).toContain("no longer parses");
  }, 30000);

  test("create: creates a missing file and its parent directories", async () => {
    const dir = passingFixtureDir();
    const greetAddress = { path: "src/nested/greeting.ts", symbol: "greet", kind: "function" };
    const provider = new ScriptedProvider([
      selectionResponse(greetAddress, "create"),
      createResponse(greetAddress, 'export   function greet ( ) : string { return "hi" }'),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "create a greeting module",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("create");
    expect(result.filePath).toBe("src/nested/greeting.ts");
    const content = readFileSync(join(dir, "src", "nested", "greeting.ts"), "utf8");
    expect(content).toBe('export function greet(): string {\n  return "hi";\n}\n');
    expect(result.editedSource).toBe(content);
  }, 30000);

  test("rejects a kind mismatch naming the kinds the name actually has", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse({ path: "src/helper.ts", symbol: "answer", kind: "class" }),
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "address",
      "selected",
      "applied",
      "ok",
    ]);
    const failed = result.records[0];
    expect(failed?.diagnostics).toContain("stage: address");
    expect(failed?.diagnostics).toContain(
      'in "src/helper.ts" the name exists as "function"; change "kind" to match',
    );
    expect(result.locator).toEqual({ path: "src/helper.ts", name: "answer", kind: "function" });
  }, 30000);

  test("reports ambiguous matchers and recovers on the next exchange", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  void 0;\n  void 0;\n  return 1;\n}\n",
    );
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse("void 0;", "void 1;"),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "matcher",
      "applied",
      "ok",
    ]);
    expect(result.records[1]?.diagnostics).toContain("stage: matcher");
    expect(result.records[1]?.diagnostics).toContain("matches 2 places");
    expect(result.records[1]?.diagnostics).toContain("extend it with more surrounding context");
    const content = helperSource(dir);
    expect(content).toContain("void 0;\n  void 0;");
    expect(content).toContain("return 2;");
  }, 30000);

  test("applies a three-statement matcher run as a real edit (#59)", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n",
    );
    const matcher = ["const a = 1;", "  const b = 2;", "  return a + b;"].join("\n");
    const replacement = ["const a = 1;", "  const b = 2;", "  return 2;"].join("\n");
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse(matcher, replacement),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(result.records[1]?.replacement).toBe(replacement);
    expect(helperSource(dir)).toContain("return 2;");
    expect(helperSource(dir)).not.toContain("return a + b;");
  }, 30000);

  test("rejects a formatting-normalized no-op on an unformatted source (#59 follow-up)", async () => {
    const dir = fixtureDir();
    // Deliberately non-canonical indentation on disk: the byte-exact fast path
    // cannot fire, so the baseline is formatted and compared.
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n    return 1;\n}\n",
    );
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse("    return 1;", "    return 1;"),
      editResponse("    return 1;", "    return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "no-op",
      "applied",
      "ok",
    ]);
    expect(result.records[1]?.cause).toBe("no-op");
    // The no-op left the unformatted source on disk; the real edit formats it.
    expect(helperSource(dir)).toBe("export function answer(): number {\n  return 2;\n}\n");
  }, 30000);

  test("applies a run with copied indentation when the replacement adds a statement (#59 follow-up)", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n",
    );
    const matcher = "  const a = 1;\n  const b = 2;\n  return a + b;";
    const replacement = "  const a = 1;\n  const b = 2;\n  const c = a + b;\n  return c - 1;";
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse(matcher, replacement),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(helperSource(dir)).toContain("const c = a + b;");
    expect(helperSource(dir)).not.toContain("return a + b;");
    expect(helperSource(dir)).toContain("return c - 1;");
  }, 30000);

  test("rewrites the whole symbol when the matcher is omitted", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse(null, "function answer(): number {\n  return 2;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(helperSource(dir)).toBe("export function answer(): number {\n  return 2;\n}\n");
  }, 30000);

  test("classifies a truncated completion as truncated and asks for an edit-dsl retry", async () => {
    const dir = fixtureDir();
    const truncated = 'function answer(): number {\n  return "cut off';
    const calls: ChatMessage[][] = [];
    let beforeRetry = "";
    const provider: ProviderLike = {
      async chat(messages) {
        calls.push(structuredClone(messages));
        if (calls.length === 1) {
          return {
            content: selectionResponse(),
            toolCalls: [],
            finishReason: "stop",
            raw: {},
          };
        }
        if (calls.length === 2) {
          return { content: truncated, toolCalls: [], finishReason: "length", raw: {} };
        }
        if (calls.length === 3) {
          beforeRetry = helperSource(dir);
        }
        return {
          content:
            calls.length >= 4
              ? "Great! I resolve this problem!"
              : editResponse("return 1;", "return 2;"),
          toolCalls: [],
          finishReason: "stop",
          raw: {},
        };
      },
    };
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "truncated",
      "applied",
      "ok",
      "confirmed",
    ]);
    expect(result.records[1]?.finishReason).toBe("length");
    expect(result.records[1]?.replacement).toBe(truncated);
    expect(result.records[1]?.diagnostics).toContain("stage: truncated");
    expect(helperSource(dir)).toContain("return 2;");
    // The truncated partial output is never applied or written.
    expect(beforeRetry).not.toContain("cut off");

    const retryCall = calls[2] ?? [];
    expect(retryCall).toHaveLength(4);
    const retryPrompt = retryCall[3]?.content ?? "";
    expect(retryPrompt).toContain("stage: truncated");
    expect(retryPrompt).toContain("shorter, more compact replacement");
    expect(retryPrompt).toContain("Edit exchange 3 failed.");
  }, 30000);

  describe("output-limit strike cap (#98)", () => {
    const lengthRow = (row: number, finishReason: string | null): LoopRecord => ({
      row,
      iteration: 1,
      kind: "exchange",
      exchange: row,
      outcome: finishReason === "length" ? "truncated" : "applied",
      locator: { path: "src/helper.ts", name: "answer", kind: "function" },
      replacement: null,
      diagnostics: null,
      diagnosticsHead: null,
      replacementChars: null,
      finishReason,
      signature: null,
    });

    test("consecutiveLengthFinishes counts the trailing length run and resets", () => {
      expect(consecutiveLengthFinishes([])).toBe(0);
      expect(consecutiveLengthFinishes([lengthRow(1, "stop")])).toBe(0);
      expect(
        consecutiveLengthFinishes([
          lengthRow(1, "length"),
          lengthRow(2, "length"),
          lengthRow(3, "stop"),
        ]),
      ).toBe(0);
      expect(
        consecutiveLengthFinishes([
          lengthRow(1, "stop"),
          lengthRow(2, "length"),
          lengthRow(3, "length"),
        ]),
      ).toBe(2);
      expect(
        consecutiveLengthFinishes([
          lengthRow(1, "length"),
          lengthRow(2, "length"),
          lengthRow(3, "length"),
        ]),
      ).toBe(MAX_CONSECUTIVE_LENGTH);
    });

    test("three consecutive length finishes terminate through the summary path", async () => {
      const dir = fixtureDir();
      const calls: ChatMessage[][] = [];
      const provider: ProviderLike = {
        async chat(messages) {
          calls.push(structuredClone(messages));
          if (calls.length === 1) {
            return { content: selectionResponse(), toolCalls: [], finishReason: "stop", raw: {} };
          }
          if (calls.length <= 4) {
            return {
              content: 'function answer(): number {\n  return "cut off',
              toolCalls: [],
              finishReason: "length",
              raw: {},
            };
          }
          return {
            content: "the completions kept hitting the output limit",
            toolCalls: [],
            finishReason: "stop",
            raw: {},
          };
        },
      };
      const result = await runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        provider,
        checkCommand: TSC,
        testCommand: ["bun", "test"],
      });
      expect(result.ok).toBe(false);
      expect(result.terminationReason).toBe("output-limit");
      expect(result.records.map((record) => record.outcome)).toEqual([
        "selected",
        "truncated",
        "truncated",
        "truncated",
      ]);
      expect(result.records.filter((record) => record.outcome === "truncated")).toHaveLength(
        MAX_CONSECUTIVE_LENGTH,
      );
      expect(result.records.at(-1)?.finishReason).toBe("length");
      expect(result.explanation).toBe("the completions kept hitting the output limit");
      const summaryPrompt = calls.at(-1)?.at(-1)?.content ?? "";
      expect(summaryPrompt).toContain("output limit three times in a row");
      expectStructuredSummaryPrompt(summaryPrompt);
      // The partial truncated output is never applied or written.
      expect(helperSource(dir)).not.toContain("cut off");
    }, 30000);

    test("two consecutive length finishes do not trigger the three-strike", async () => {
      const dir = fixtureDir();
      let calls = 0;
      const provider: ProviderLike = {
        async chat() {
          calls += 1;
          if (calls === 1) {
            return { content: selectionResponse(), toolCalls: [], finishReason: "stop", raw: {} };
          }
          if (calls === 2 || calls === 3) {
            return {
              content: 'function answer(): number {\n  return "cut off',
              toolCalls: [],
              finishReason: "length",
              raw: {},
            };
          }
          return {
            content:
              calls > 4 ? "Great! I resolve this problem!" : editResponse("return 1;", "return 2;"),
            toolCalls: [],
            finishReason: "stop",
            raw: {},
          };
        },
      };
      const result = await runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        provider,
        checkCommand: TSC,
        testCommand: ["bun", "test"],
      });
      expect(result.ok).toBe(true);
      expect(result.terminationReason).toBeUndefined();
      expect(result.records.filter((record) => record.outcome === "truncated")).toHaveLength(2);
      expect(helperSource(dir)).toContain("return 2;");
    }, 30000);
  });

  describe("rejection causes and per-cause policy (#56)", () => {
    test("classifyRejection routes every structured stage to its cause", () => {
      expect(classifyRejection({ stage: "protocol" })).toBe("protocol");
      expect(classifyRejection({ stage: "echo" })).toBe("echo");
      expect(classifyRejection({ stage: "address" })).toBe("address");
      expect(classifyRejection({ stage: "no-op" })).toBe("no-op");
      expect(classifyRejection({ stage: "repeat" })).toBe("repeat");
      expect(classifyRejection({ stage: "duplicate" })).toBe("duplicate");
      expect(classifyRejection({ stage: "gate" })).toBe("gate");
      expect(classifyRejection({ stage: "truncated" })).toBe("truncated");
      expect(classifyRejection({ stage: "matcher", matcherCause: "matcher-unparseable" })).toBe(
        "matcher-unparseable",
      );
      expect(classifyRejection({ stage: "matcher", matcherCause: "matcher-not-found" })).toBe(
        "matcher-not-found",
      );
      expect(classifyRejection({ stage: "matcher", matcherCause: "matcher-ambiguous" })).toBe(
        "matcher-ambiguous",
      );
      // Only the duplicate-modifier signature is a harness fault; any other
      // formatter error stays a model-fault format retry.
      expect(
        classifyRejection({
          stage: "format",
          formatMessage: "oxfmt failed: 'export' modifier already seen.",
        }),
      ).toBe("format-export-duplication");
      expect(
        classifyRejection({ stage: "format", formatMessage: "oxfmt failed: unexpected token." }),
      ).toBe("format");
    });

    test("rejectionPolicy retries model faults and terminates on harness faults", () => {
      const retryable = [
        "protocol",
        "echo",
        "address",
        "matcher-unparseable",
        "matcher-not-found",
        "matcher-ambiguous",
        "no-op",
        "repeat", // #65: the resend classes stop the default lead.
        "duplicate", // #65
        "gate",
        "format",
        "truncated",
      ] as const;
      for (const cause of retryable) {
        const policy = rejectionPolicy(cause);
        expect(policy.action).toBe("retry");
        if (policy.action === "retry") {
          expect(policy.correction).not.toBeNull();
          expect(policy.escalation).not.toBeNull();
        }
      }
      // #65: a resend cannot change the file; the correction says so and the
      // escalation forces the next attempt to differ.
      const repeat = rejectionPolicy("repeat");
      if (repeat.action !== "retry") {
        throw new Error("expected a retryable repeat policy");
      }
      expect(repeat.correction).toContain("already reflects its outcome");
      expect(repeat.escalation).toContain("MUST differ from the previous attempts");
      const duplicate = rejectionPolicy("duplicate");
      if (duplicate.action !== "retry") {
        throw new Error("expected a retryable duplicate policy");
      }
      // #41: the lead covers both a duplicate top-level declaration and two
      // clauses addressing one resolved declaration.
      expect(duplicate.correction).toContain("second top-level copy");
      expect(duplicate.correction).toContain("two clauses target the same resolved declaration");
      expect(duplicate.correction).toContain("Address one declaration once per reply");
      expect(duplicate.correction).toContain("split its edits across exchanges");
      expect(duplicate.escalation).toContain("MUST return a replacement that differs");
      expect(duplicate.escalation).toContain("more than one clause");
      // A duplicated-modifier format failure exits instead of retrying.
      expect(rejectionPolicy("format-export-duplication")).toEqual({
        action: "terminate",
        reason: "harness-fault",
      });
    });

    test("a protocol rejection re-teaches the edit-dsl reply form", () => {
      const policy = rejectionPolicy("protocol");
      if (policy.action !== "retry") {
        throw new Error("expected a retryable protocol policy");
      }
      expect(policy.correction).toContain("`select … end`");
      expect(policy.correction).toContain("different resolved declaration");
      expect(policy.correction).toContain("split its edits across exchanges");
      expect(policy.correction).not.toContain("flat JSON object");
      expect(policy.escalation).toContain("`select … end`");
      expect(policy.escalation).not.toContain("flat JSON object");
      expect(rejectionLead("protocol", 1)).toBe(policy.correction);
      expect(rejectionLead("protocol", 2)).toBe(policy.escalation);
    });

    test("rejectionLead escalates by streak and adds the #65 context", () => {
      const repeat = rejectionPolicy("repeat");
      if (repeat.action !== "retry") {
        throw new Error("expected a retryable repeat policy");
      }
      // The first repeat carries the correction; the consecutive one escalates.
      expect(rejectionLead("repeat", 1)).toBe(repeat.correction);
      expect(rejectionLead("repeat", 2)).toBe(repeat.escalation);
      // The duplicate class uses its own wording, not the repeat text.
      expect(rejectionLead("duplicate", 1)).not.toContain("already reflects its outcome");
      // The no-op lead names the already-present effect; with the round's
      // verification diagnostics it points at the pending failures.
      const noop = rejectionLead("no-op", 1);
      expect(noop).toContain("already in the file");
      expect(noop).not.toContain("remaining failures still point at");
      const pending =
        "stage: tsc\nelsewhere in file:\nsrc/helper.ts(2,3): error TS2322: synthetic 0";
      const pointed = rejectionLead("no-op", 1, { pendingDiagnostics: pending });
      expect(pointed).toContain("already in the file");
      expect(pointed).toContain(
        "The remaining failures still point at src/helper.ts(2,3): error TS2322: synthetic 0.",
      );
      // The escalation keeps the pointer.
      const escalated = rejectionLead("no-op", 2, { pendingDiagnostics: pending });
      expect(escalated).toContain("MUST stop re-proposing that change");
      expect(escalated).toContain("src/helper.ts(2,3)");
      // An undeclared address name keeps the add path open at both levels...
      const undeclared = rejectionLead("address", 1, { undeclaredName: "car" });
      expect(undeclared).toContain('The current source declares no symbol named "car"');
      expect(undeclared).toContain(
        'mode "create" applies only while the run is still choosing a target',
      );
      const undeclaredEscalated = rejectionLead("address", 2, { undeclaredName: "car" });
      expect(undeclaredEscalated).toContain("MUST return an address the current source resolves");
      expect(undeclaredEscalated).toContain('"car" is not declared');
      // ...while a resolvable address keeps the #56 wording.
      const address = rejectionPolicy("address");
      if (address.action !== "retry") {
        throw new Error("expected a retryable address policy");
      }
      expect(rejectionLead("address", 1)).toBe(address.correction);
      expect(rejectionLead("address", 2)).toBe(address.escalation);
      // A terminate verdict never yields a lead.
      expect(rejectionLead("format-export-duplication", 1)).toBeNull();
    });

    test("a repeated edit-dsl address failure offers a concrete fallback (#24)", () => {
      const live = { path: "src/lisp.ts", name: "MAXIMUM" };
      const policy = rejectionPolicy("address");
      if (policy.action !== "retry") {
        throw new Error("expected a retryable address policy");
      }
      // Count 1 keeps the generic address wording unchanged.
      expect(
        rejectionLead("address", 1, {
          addressFailures: 1,
          address: live,
        }),
      ).toBe(policy.correction);
      const fallback = rejectionLead("address", 2, {
        addressFailures: 2,
        address: live,
      });
      expect(fallback).toContain("select MAXIMUM in src/lisp.ts");
      expect(fallback).toContain("omit the kind");
      expect(fallback).toContain("write src/lisp.ts with");
      expect(fallback).toContain("<<<TC_EDIT_BEGIN>>>");
      expect(fallback).toContain("<<<TC_EDIT_END>>>");
      // An undeclared name keeps its create/add-path wording.
      const undeclared = rejectionLead("address", 2, {
        addressFailures: 2,
        address: live,
        undeclaredName: "car",
      });
      expect(undeclared).toContain('"car" is not declared');
      expect(undeclared).not.toContain("write src/lisp.ts with");
    });

    test("matcher-not-found retries with the base class correction (#56)", async () => {
      const dir = fixtureDir();
      const provider = new ScriptedProvider([
        selectionResponse(),
        editResponse("return 99;", "return 2;"),
        editResponse("return 1;", "return 2;"),
      ]);
      const result = await runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        provider,
        checkCommand: TSC,
        testCommand: ["bun", "test"],
      });
      expect(result.ok).toBe(true);
      expect(result.records.map((record) => record.outcome)).toEqual([
        "selected",
        "matcher",
        "applied",
        "ok",
      ]);
      expect(result.records[1]?.cause).toBe("matcher-not-found");
      const policy = rejectionPolicy("matcher-not-found");
      if (policy.action !== "retry" || policy.correction === null || policy.escalation === null) {
        throw new Error("expected a retryable matcher-not-found policy");
      }
      const retryPrompt = provider.calls[2]?.at(-1)?.content ?? "";
      expect(retryPrompt).toContain(policy.correction);
      expect(retryPrompt).not.toContain(policy.escalation);
    }, 30000);

    test("a repeated cause escalates to the fallback instruction (#56)", async () => {
      const dir = fixtureDir();
      // Iteration 1 applies an edit that fails the synthetic check; the repair
      // iteration then gets a fresh 1..3 content-exchange budget (no pick).
      const provider = new ScriptedProvider([
        selectionResponse(),
        editResponse("return 1;", "return 2;"),
        editResponse("return 98;", "return 3;"),
        editResponse("return 99;", "return 3;"),
        editResponse("return 2;", "return 3;"),
      ]);
      const result = await runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        provider,
        checkCommand: signatureCheckCommand(dir, [1, 0]),
        testCommand: passingCommand,
      });
      expect(result.ok).toBe(true);
      expect(result.records.map((record) => record.outcome)).toEqual([
        "selected",
        "applied",
        "tsc",
        "matcher",
        "matcher",
        "applied",
        "ok",
      ]);
      expect(result.records[3]?.cause).toBe("matcher-not-found");
      expect(result.records[4]?.cause).toBe("matcher-not-found");
      const policy = rejectionPolicy("matcher-not-found");
      if (policy.action !== "retry" || policy.correction === null || policy.escalation === null) {
        throw new Error("expected a retryable matcher-not-found policy");
      }
      // Repair exchange 2 carries the base correction; the repeated class
      // escalates the exchange-3 prompt to the whole-symbol fallback.
      expect(provider.calls[3]?.at(-1)?.content).toContain(policy.correction);
      expect(provider.calls[4]?.at(-1)?.content).toContain(policy.escalation);
    }, 30000);

    test("records the splice sub-cause for ambiguous and unparseable matchers (#56)", async () => {
      const dir = fixtureDir();
      writeFileSync(
        join(dir, "src", "helper.ts"),
        "export function answer(): number {\n  void 0;\n  void 0;\n  return 1;\n}\n",
      );
      const provider = new ScriptedProvider([
        selectionResponse(),
        editResponse("return 1;", "return 2;"),
        editResponse("void 0;", "void 1;"),
        editResponse("return 2;)", "return 3;"),
        editResponse("return 2;", "return 3;"),
      ]);
      const result = await runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        provider,
        checkCommand: signatureCheckCommand(dir, [1, 0]),
        testCommand: passingCommand,
      });
      expect(result.ok).toBe(true);
      expect(result.records.map((record) => record.outcome)).toEqual([
        "selected",
        "applied",
        "tsc",
        "matcher",
        "matcher",
        "applied",
        "ok",
      ]);
      expect(result.records[3]?.cause).toBe("matcher-ambiguous");
      expect(result.records[4]?.cause).toBe("matcher-unparseable");
      // A different cause resets the streak: the retry keeps the base correction.
      const policy = rejectionPolicy("matcher-unparseable");
      if (policy.action !== "retry" || policy.correction === null || policy.escalation === null) {
        throw new Error("expected a retryable matcher-unparseable policy");
      }
      const retryPrompt = provider.calls[4]?.at(-1)?.content ?? "";
      expect(retryPrompt).toContain(policy.correction);
      expect(retryPrompt).not.toContain(policy.escalation);
    }, 30000);

    test("an applied edit resets the cause streak (#56)", async () => {
      const dir = fixtureDir();
      const provider = new ScriptedProvider([
        selectionResponse(),
        editResponse("return 1;", "return 2;"),
        editResponse("return 91;", "return 3;"),
        editResponse("return 92;", "return 3;"),
        editResponse("return 2;", "return 3;"),
        editResponse("return 93;", "return 4;"),
        editResponse("return 3;", "return 4;"),
      ]);
      const result = await runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        provider,
        // Iteration 1 applies but fails; iteration 2 rejects twice then applies
        // and fails again; iteration 3 rejects once then applies and passes.
        checkCommand: signatureCheckCommand(dir, [1, 1, 0]),
        testCommand: passingCommand,
      });
      expect(result.ok).toBe(true);
      expect(result.records.map((record) => record.outcome)).toEqual([
        "selected",
        "applied",
        "tsc",
        "matcher",
        "matcher",
        "applied",
        "tsc",
        "matcher",
        "applied",
        "ok",
      ]);
      const policy = rejectionPolicy("matcher-not-found");
      if (policy.action !== "retry" || policy.correction === null || policy.escalation === null) {
        throw new Error("expected a retryable matcher-not-found policy");
      }
      // The repair exchange-3 prompt (after rejection 2) escalated...
      expect(provider.calls[4]?.at(-1)?.content).toContain(policy.escalation);
      // ...then the applied edit cleared the streak, so iteration 3's retry
      // after the post-reset rejection starts over at the base correction.
      const afterReset = provider.calls[6]?.at(-1)?.content ?? "";
      expect(afterReset).toContain(policy.correction);
      expect(afterReset).not.toContain(policy.escalation);
    }, 30000);

    test("a no-op lead points at the pending failures in a repair round (#65)", async () => {
      const dir = fixtureDir();
      // Round 1 applies the whole-symbol rewrite and fails verification; the
      // repair round then re-proposes the matched text unchanged (no-op), and
      // the pointed lead directs the next edit at the tsc failure.
      const provider = new ScriptedProvider([
        selectionResponse(),
        editResponse(null, "function answer(): number {\n  return 2;\n}"),
        editResponse("return 2;", "return 2;"),
        editResponse("return 2;", "return 3;"),
      ]);
      const result = await runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        provider,
        checkCommand: signatureCheckCommand(dir, [1, 0]),
        testCommand: passingCommand,
      });
      expect(result.ok).toBe(true);
      expect(result.records.map((record) => record.outcome)).toEqual([
        "selected",
        "applied",
        "tsc",
        "no-op",
        "applied",
        "ok",
      ]);
      expect(result.records[3]?.cause).toBe("no-op");
      const policy = rejectionPolicy("no-op");
      if (policy.action !== "retry" || policy.correction === null || policy.escalation === null) {
        throw new Error("expected a retryable no-op policy");
      }
      const retry = provider.calls[3]?.at(-1)?.content ?? "";
      expect(retry).toContain(policy.correction);
      // The round's opening verification diagnostics name where the remaining
      // failures still are (the mapped replacement line); the escalation
      // framing is not used yet.
      expect(retry).toContain(
        "The remaining failures still point at replacement line 1: TS2322: synthetic 0 — in declaration `answer` (function).",
      );
      expect(retry).not.toContain(policy.escalation);
      expect(helperSource(dir)).toContain("return 3;");
    }, 30000);
  });

  test("runs the sibling test file first and short-circuits on its failure", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse("return 1;", "return 2;"),
      "",
      "",
      "",
      "STOP",
      "the tests never pass",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: passingCommand,
      testCommand: invocationScript(dir, true),
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records[1]?.outcome).toBe("applied");
    expect(result.records[2]?.outcome).toBe("tests");
    expect(result.records[2]?.diagnostics).toContain("stage: tests");
    expect(invocationLog(dir)).toEqual(["src/helper.test.ts"]);
  }, 30000);

  test("runs the full suite after the sibling test file passes", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: passingCommand,
      testCommand: invocationScript(dir, false),
    });
    expect(result.ok).toBe(true);
    expect(result.records[2]?.outcome).toBe("ok");
    expect(invocationLog(dir)).toEqual(["src/helper.test.ts", "(full)"]);
  }, 30000);

  test("records replacement size, finish reason, and bounded diagnostics heads", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const applied = result.records[1];
    expect(applied?.outcome).toBe("applied");
    expect(applied?.replacement).toBe("return 2;");
    expect(applied?.replacementChars).toBe(applied?.replacement?.length ?? -1);
    expect(applied?.diagnosticsHead).toBeNull();
    expect(applied?.finishReason).toBe("stop");
    expect(applied?.signature).toBeNull();
    const verification = result.records[2];
    expect(verification?.outcome).toBe("ok");
    expect(verification?.signature).toBeNull();

    const longDir = fixtureDir();
    const longName = "n".repeat(400);
    const locator = selectionResponse({
      path: "../escape.ts",
      symbol: longName,
      kind: "function",
    });
    const longProvider = new ScriptedProvider([locator, locator, locator, "STOP", "unused"]);
    const longResult = await runLoop({
      cwd: longDir,
      issue: "make the answer test pass",
      provider: longProvider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(longResult.ok).toBe(false);
    // The second identical locator is the repeated no-progress fingerprint.
    const rejected = longResult.records.filter((record) => record.outcome === "address");
    expect(rejected.length).toBeGreaterThanOrEqual(2);
    for (const record of rejected) {
      expect(record.replacementChars).toBeNull();
      expect(record.diagnosticsHead).not.toBeNull();
      expect(record.diagnosticsHead?.length).toBeLessThanOrEqual(200);
    }
    expect(longResult.diagnostics).toContain("no progress");
  }, 30000);

  test("runs every Edit-loop exchange at none", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", 'return "nope";'),
      editResponse('return "nope";', 'return "nope!";'),
      "bad",
      "bad",
      "bad",
      "STOP",
      "the budget is done",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      temperature: 0,
      checkCommand: failingCommand,
      testCommand: failingCommand,
    });
    expect(result.ok).toBe(false);
    // Selection, two applied edits, the repeated "bad" fingerprint stop, then
    // the summary call at the default effort.
    expect(provider.optionCalls).toEqual([
      { temperature: 0, reasoningEffort: "none" },
      { temperature: 0, reasoningEffort: "none" },
      { temperature: 0, reasoningEffort: "none" },
      { temperature: 0, reasoningEffort: "none" },
      { temperature: 0, reasoningEffort: "none" },
      { temperature: 0 },
    ]);
  }, 30000);

  test("effortOverride forces one effort on every exchange", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      temperature: 0,
      effortOverride: "max",
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(provider.optionCalls).toEqual([
      { temperature: 0, reasoningEffort: "max" },
      { temperature: 0, reasoningEffort: "max" },
    ]);
  }, 30000);

  test("keeps the summary call at the default effort", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      "not json",
      "not json",
      "the symbol does not exist in the project",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      temperature: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    // Selection, two identical "not json" replies (fingerprint stop), then the
    // summary call at the default effort.
    expect(provider.optionCalls).toEqual([
      { temperature: 0, reasoningEffort: "none" },
      { temperature: 0, reasoningEffort: "none" },
      { temperature: 0 },
    ]);
    expect(result.explanation).toBe("the symbol does not exist in the project");
  }, 30000);
});

describe("runLoop with unparseable files", () => {
  test("fixes a valid target while reporting the skipped file", async () => {
    const dir = brokenFixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.locator).toEqual({
      path: "src/helper.ts",
      name: "answer",
      kind: "function",
    });
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(helperSource(dir)).toContain("return 2;");
    expect(result.skipped).toEqual([
      { path: "src/broken.ts", message: "unexpected end of input (line 2, column 1)" },
    ]);
    expect(readFileSync(join(dir, "src", "broken.ts"), "utf8")).toBe("function broken( {\n");
  }, 30000);

  test("rejects a skipped file as a target without appending or writing", async () => {
    const dir = brokenFixtureDir();
    const brokenPath = join(dir, "src", "broken.ts");
    const original = readFileSync(brokenPath, "utf8");
    const skippedReply = selectionResponse({
      path: "src/broken.ts",
      symbol: "broken",
      kind: "function",
    });
    const provider = new ScriptedProvider([
      skippedReply,
      // The identical rejected selection repeats the no-progress fingerprint.
      skippedReply,
      "the broken file cannot be selected",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "fix the broken file",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("prev-broken");
    expect(result.locator).toEqual({ path: "src/broken.ts", name: "broken", kind: "function" });
    expect(readFileSync(brokenPath, "utf8")).toBe(original);
    expect(result.explanation).toBe("the broken file cannot be selected");
  }, 30000);

  test("keeps create mode for a missing file while another file is skipped", async () => {
    const dir = passingBrokenFixtureDir();
    const greetAddress = { path: "src/greeting.ts", symbol: "greet", kind: "function" };
    const provider = new ScriptedProvider([
      selectionResponse(greetAddress, "create"),
      createResponse(greetAddress, 'export function greet(): string { return "hi" }'),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "add a greeting module",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("create");
    expect(result.filePath).toBe("src/greeting.ts");
    expect(result.skipped?.map((file) => file.path)).toEqual(["src/broken.ts"]);
    const content = readFileSync(join(dir, "src", "greeting.ts"), "utf8");
    expect(content).toBe('export function greet(): string {\n  return "hi";\n}\n');
  }, 30000);
});

describe("runLoop provider failures", () => {
  async function watchRejections<T>(
    operation: () => Promise<T>,
  ): Promise<{ unhandled: unknown[]; value: T }> {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const value = await operation();
      await Bun.sleep(10);
      return { unhandled, value };
    } finally {
      process.off("unhandledRejection", listener);
    }
  }

  test("returns a failed result when the selection call throws", async () => {
    const dir = fixtureDir();
    const attempted: ChatMessage[][] = [];
    const provider: ProviderLike = {
      async chat(messages) {
        attempted.push(structuredClone(messages));
        throw new Error("gateway unreachable");
      },
    };
    const { unhandled, value: result } = await watchRejections(() =>
      runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        provider,
        checkCommand: TSC,
        testCommand: ["bun", "test"],
      }),
    );
    expect(unhandled).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.locator).toBeNull();
    expect(result.filePath).toBeNull();
    expect(result.editedSource).toBeNull();
    expect(result.records).toEqual([]);
    // Provider errors keep their own path: no termination reason.
    expect(result.terminationReason).toBeUndefined();
    expect(result.diagnostics).toBe("provider error: gateway unreachable");
    // The provider error still takes exactly one summary attempt; the reply
    // falls back to a readable string stored verbatim.
    expect(attempted).toHaveLength(2);
    const summaryPrompt = attempted.at(-1)?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain("The run is over: the provider call failed.");
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("no explanation available: gateway unreachable");
    expect(helperSource(dir)).toContain("return 1;");
  }, 30000);

  test("keeps an applied edit and fails when a later call throws", async () => {
    const dir = fixtureDir();
    const original = helperSource(dir);
    const scripted = new ScriptedProvider([
      selectionResponse(),
      editResponse("return 1;", 'return "nope";'),
    ]);
    let calls = 0;
    const attempted: ChatMessage[][] = [];
    const provider: ProviderLike = {
      async chat(messages, tools, options) {
        calls += 1;
        attempted.push(structuredClone(messages));
        if (calls >= 3) {
          throw new Error("gateway dropped");
        }
        return scripted.chat(messages, tools, options);
      },
    };
    const failing = ["bun", "-e", "process.exit(1)"];
    const { unhandled, value: result } = await watchRejections(() =>
      runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        provider,
        checkCommand: failing,
        testCommand: failing,
      }),
    );
    expect(unhandled).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBeUndefined();
    expect(result.mode).toBe("modify");
    expect(result.locator).toEqual({
      path: "src/helper.ts",
      name: "answer",
      kind: "function",
    });
    expect(result.filePath).toBe("src/helper.ts");
    expect(result.editedSource).toBeNull();
    expect(result.diagnostics).toContain("provider error");
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "tsc"]);
    expect(result.records[1]?.replacement).toContain("nope");
    expect(result.records[2]?.diagnostics).not.toBeNull();
    // One failed summary attempt, then the readable fallback string verbatim.
    const summaryAttempts = attempted.filter((messages) =>
      (messages.at(-1)?.content ?? "").includes("The run is over"),
    );
    expect(summaryAttempts).toHaveLength(1);
    expect(summaryAttempts[0]?.at(-1)?.content ?? "").toContain(
      "The run is over: the provider call failed.",
    );
    expectStructuredSummaryPrompt(summaryAttempts[0]?.at(-1)?.content ?? "");
    expect(result.explanation).toBe("no explanation available: gateway dropped");
    expect(helperSource(dir)).toContain('return "nope";');
    expect(helperSource(dir)).not.toBe(original);
  }, 30000);

  test("labels a context-overflow edit failure in diagnostics (#97)", async () => {
    const dir = fixtureDir();
    const scripted = new ScriptedProvider([selectionResponse(ANSWER, "modify")]);
    let calls = 0;
    const provider: ProviderLike = {
      async chat(messages, tools, options) {
        calls += 1;
        if (calls >= 2) {
          throw new ChatContextOverflowError(
            "chat request failed: 400 maximum context length is 8192 tokens",
          );
        }
        return scripted.chat(messages, tools, options);
      },
    };
    const { unhandled, value: result } = await watchRejections(() =>
      runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        provider,
        checkCommand: TSC,
        testCommand: ["bun", "test"],
      }),
    );
    expect(unhandled).toEqual([]);
    expect(result.ok).toBe(false);
    // Terminates through the defined summary path, not a termination reason.
    expect(result.terminationReason).toBeUndefined();
    expect(result.mode).toBe("modify");
    expect(result.records.map((record) => record.outcome)).toEqual(["selected"]);
    expect(result.diagnostics).toContain("provider context-overflow:");
    expect(result.explanation).toBe(
      "no explanation available: chat request failed: 400 maximum context length is 8192 tokens",
    );
    expect(helperSource(dir)).toContain("return 1;");
  }, 30000);

  test("labels a payload-too-large edit failure in diagnostics (#97)", async () => {
    const dir = fixtureDir();
    const scripted = new ScriptedProvider([selectionResponse(ANSWER, "modify")]);
    let calls = 0;
    const provider: ProviderLike = {
      async chat(messages, tools, options) {
        calls += 1;
        if (calls >= 2) {
          throw new ChatPayloadTooLargeError("chat request failed: 413 request entity too large");
        }
        return scripted.chat(messages, tools, options);
      },
    };
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContain("provider payload-too-large:");
    expect(helperSource(dir)).toContain("return 1;");
  }, 30000);
});

describe("failure history wiring (#71)", () => {
  test("ordinary retries and the no-progress ask carry the unchanged-set note", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(MAX_STALLED_ROUNDS + 1),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    // Rounds 2 and 3 see one and two identical failures: no note yet.
    expect(provider.calls[2]?.at(-1)?.content ?? "").not.toContain("Failure history:");
    expect(provider.calls[3]?.at(-1)?.content ?? "").not.toContain("Failure history:");
    // Round 4 (three identical failures) is an ordinary retry and carries it.
    const third = provider.calls[4]?.at(-1)?.content ?? "";
    expect(third).toContain("Edit exchange 1 failed verification.");
    expect(third).toContain(
      "Failure history: the failing set is unchanged across the last 3 verification rounds.",
    );
    // The #54 ask at round 9 carries the longer-chain count plus the digest.
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed attempts.`);
    const note =
      "Failure history: the failing set is unchanged across the last 8 verification rounds.";
    expect(ask).toContain(note);
    expect(ask).toContain("Prior attempts (");
    expect(ask.indexOf(note)).toBeLessThan(ask.indexOf("Prior attempts ("));
    // The ask was answered with an edit, not STOP: the run converged.
    expect(helperSource(dir)).toContain("return 10;");
  }, 30000);
});

// #69: a two-file fixture whose single test needs both declarations changed, so
// one batched exchange can satisfy it while a partial apply cannot pass.
function multiFixtureDir(): string {
  const dir = tempDir();
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "ESNext",
          moduleResolution: "bundler",
          types: [],
        },
        include: ["src"],
        exclude: ["src/**/*.test.ts"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "src", "a.ts"), "export function one(): number {\n  return 1;\n}\n");
  writeFileSync(join(dir, "src", "b.ts"), "export function two(): number {\n  return 1;\n}\n");
  writeFileSync(
    join(dir, "src", "pair.test.ts"),
    'import { expect, test } from "bun:test";\nimport { one } from "./a";\nimport { two } from "./b";\n\ntest("pair", () => {\n  expect(one()).toBe(2);\n  expect(two()).toBe(3);\n});\n',
  );
  return dir;
}

// #78: a one-file fixture with two declarations whose single test needs both
// changed, so same-file multi-region batching can satisfy it while a partial
// apply cannot pass.
function sameFileFixtureDir(): string {
  const dir = tempDir();
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: "ESNext",
          moduleResolution: "bundler",
          types: [],
        },
        include: ["src"],
        exclude: ["src/**/*.test.ts"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(dir, "src", "pair.ts"),
    "export function one(): number {\n  return 1;\n}\nexport function two(): number {\n  return 1;\n}\n",
  );
  writeFileSync(
    join(dir, "src", "pair.test.ts"),
    'import { expect, test } from "bun:test";\nimport { one, two } from "./pair";\n\ntest("pair", () => {\n  expect(one()).toBe(2);\n  expect(two()).toBe(3);\n});\n',
  );
  return dir;
}

function pairSource(dir: string): string {
  return readFileSync(join(dir, "src", "pair.ts"), "utf8");
}

function batchResponse(
  entries: {
    path: string;
    symbol: string;
    kind: string;
    matcher?: string;
    range?: { line: number; column: number; endLine: number; endColumn: number };
    replacement: string;
  }[],
): string {
  return JSON.stringify({
    payloads: entries.map((entry) => ({
      path: entry.path,
      symbol: entry.symbol,
      kind: entry.kind,
      ...(entry.matcher === undefined ? {} : { matcher: entry.matcher }),
      ...(entry.range === undefined ? {} : { range: entry.range }),
      replacement: entry.replacement,
    })),
  });
}

describe("edit-dsl protocol (#111/#119)", () => {
  const TICK = "\u0060";

  function editDslReply(...selections: EditDslSelection[]): string {
    return serializeSelections(selections);
  }

  function answerEditor(
    replacement: string | null,
    matcher: EditDslSelection["matcher"],
    pick: EditDslSelection["pick"] = null,
  ): EditDslSelection {
    return {
      locator: { path: "src/helper.ts", name: "answer", kind: "function" },
      space: null,
      matcher,
      pick,
      replacement,
    };
  }

  // The select-first turn: one viewer clause naming the target. The harness
  // answers with `# details`; the next reply is the edit/create clause.
  function editDslSelect(
    name: string,
    path: string,
    space: EditDslSelection["space"] = null,
    kind = "",
  ): string {
    return editDslReply({
      locator: { path, name, kind },
      space,
      matcher: null,
      pick: null,
      replacement: null,
    });
  }

  function createEditor(
    path: string,
    symbol: string,
    kind: string,
    body: string,
    space: EditDslSelection["space"] = null,
  ): EditDslSelection {
    return {
      locator: { path, name: symbol, kind },
      space,
      matcher: null,
      pick: null,
      replacement: body,
    };
  }

  test("runLoop defaults to the edit-dsl select-first protocol", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoopBase({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const system = provider.calls[0]?.[0]?.content ?? "";
    expect(system).toContain("Reply with ONLY one `select <symbol> in <path>");
    expect(system).not.toContain(
      "First you will be asked to select the target. Reply with ONLY a JSON object",
    );
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  function loggingCommand(logPath: string, label: string): string[] {
    const script = [
      'const { appendFileSync } = require("node:fs");',
      `appendFileSync(${JSON.stringify(logPath)}, "${label}\\n");`,
      "process.exit(0);",
    ].join("\n");
    return ["bun", "-e", script];
  }

  test("a standalone test self-check runs before the edit and writes nothing", async () => {
    const dir = fixtureDir();
    const logPath = join(dir, "self-check-calls.log");
    let sourceAtNextPrompt = "";
    const provider = new ScriptedProvider(
      [
        editDslSelect("answer", "src/helper.ts", "value"),
        "test end",
        editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      ],
      (callIndex) => {
        if (callIndex === 2) {
          sourceAtNextPrompt = helperSource(dir);
        }
      },
    );
    const result = await runLoopBase({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: loggingCommand(logPath, "test"),
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toContain("self-check");
    expect(exchangeStats(result.records).selfChecks).toBe(1);
    const selfCheck = result.records.find((record) => record.outcome === "self-check");
    expect(selfCheck?.diagnostics).toContain("Self-check (test): the test command passed");
    expect(sourceAtNextPrompt).toBe("export function answer(): number {\n  return 1;\n}\n");
    const afterControl = (provider.calls[2] ?? []).at(-1)?.content ?? "";
    expect(afterControl).toContain("Self-check result:");
    expect(afterControl).toContain("Self-check (test): the test command passed");
    // One self-check plus the edit verification's targeted + full suite runs.
    expect(readFileSync(logPath, "utf8")).toBe("test\ntest\ntest\n");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("a standalone check self-check runs the configured check command", async () => {
    const dir = fixtureDir();
    const logPath = join(dir, "self-check-calls.log");
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      "check end",
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoopBase({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: loggingCommand(logPath, "check"),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    const selfCheck = result.records.find((record) => record.outcome === "self-check");
    expect(selfCheck?.diagnostics).toContain("Self-check (check): the check command passed");
    expect((provider.calls[2] ?? []).at(-1)?.content ?? "").toContain(
      "Self-check (check): the check command passed",
    );
    // One self-check plus the edit verification's check.
    expect(readFileSync(logPath, "utf8")).toBe("check\ncheck\n");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("test self-checks have no fixed count and repeat is surfaced as no progress", async () => {
    const dir = fixtureDir();
    const logPath = join(dir, "self-check-calls.log");
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      "test end",
      "test end",
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoopBase({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: loggingCommand(logPath, "test"),
    });
    expect(result.ok).toBe(true);
    expect(exchangeStats(result.records).selfChecks).toBe(2);
    expect(result.records.some((record) => record.diagnostics?.includes("already used"))).toBe(
      false,
    );
    const afterSecondControl = (provider.calls[3] ?? []).at(-1)?.content ?? "";
    expect(afterSecondControl).toContain("No progress: the same test command");
    // Two self-checks plus the edit verification's targeted + full suite runs.
    expect(readFileSync(logPath, "utf8")).toBe("test\ntest\ntest\ntest\n");
  }, 30000);

  test("a malformed self-check is rejected without running a command", async () => {
    const dir = fixtureDir();
    const logPath = join(dir, "self-check-calls.log");
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      "test src/helper.test.ts end",
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoopBase({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: loggingCommand(logPath, "test"),
    });
    expect(result.ok).toBe(true);
    const rejected = result.records.find(
      (record) => record.outcome === "protocol" && record.diagnostics?.includes("standalone"),
    );
    expect(rejected).toBeDefined();
    expect(result.records.some((record) => record.outcome === "self-check")).toBe(false);
    // No self-check ran; the edit verification's targeted + full suite did.
    expect(readFileSync(logPath, "utf8")).toBe("test\ntest\n");
    const retryPrompt = (provider.calls[2] ?? []).at(-1)?.content ?? "";
    expect(retryPrompt).toContain("self-check commands are standalone");
  }, 30000);

  test("a repeated kind-mismatch address loop recovers through the fallback (#24)", async () => {
    const dir = passingFixtureDir();
    writeFileSync(join(dir, "src", "lisp.ts"), "export const MAX_TOKENS = 10;\n");
    writeFileSync(
      join(dir, "src", "lisp.test.ts"),
      'import { expect, test } from "bun:test";\nimport { MAX_TOKENS } from "./lisp";\n\ntest("max tokens", () => {\n  expect(MAX_TOKENS).toBe(20);\n});\n',
    );
    const provider = new ScriptedProvider([
      // Two distinct wrong-kind re-pins of a `const`: neither `function` nor
      // `interface` can match the internal `variable` entry, so both are
      // address failures without being an identical reply.
      editDslSelect("MAX_TOKENS", "src/lisp.ts", null, "function"),
      editDslSelect("MAX_TOKENS", "src/lisp.ts", null, "interface"),
      // Recover through the offered bare select (kind omitted).
      editDslSelect("MAX_TOKENS", "src/lisp.ts"),
      editDslReply({
        locator: { path: "src/lisp.ts", name: "MAX_TOKENS", kind: "const" },
        space: null,
        matcher: { kind: "snippet", value: "10" },
        pick: null,
        replacement: "20",
      }),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoopBase({
      cwd: dir,
      issue: "make the max-tokens test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.terminationReason).not.toBe("token-budget");
    expect(readFileSync(join(dir, "src", "lisp.ts"), "utf8")).toContain(
      "export const MAX_TOKENS = 20;",
    );
    // The retry after the second address failure names both concrete escapes.
    const fallbackPrompt = provider.calls.find((call) =>
      call.some(
        (message) =>
          message.content?.includes("select MAX_TOKENS in src/lisp.ts") === true &&
          message.content.includes("write src/lisp.ts with") &&
          message.content.includes("omit the kind"),
      ),
    );
    expect(fallbackPrompt).toBeDefined();
  }, 30000);

  test("runLoop renames a declaration and its references without a tool call", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      [
        "export function answer(): number {",
        "  return 1;",
        "}",
        "",
        "export function getAnswer(): number {",
        "  return answer();",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "src", "helper.test.ts"),
      'import { expect, test } from "bun:test";\nimport { getAnswer } from "./helper";\n\ntest("getAnswer", () => {\n  expect(getAnswer()).toBe(1);\n});\n',
    );
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply({
        locator: { path: "src/helper.ts", name: "answer", kind: "function" },
        space: "value",
        matcher: null,
        pick: null,
        replacement: null,
        rename: { from: "answer", to: "result" },
      }),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoopBase({
      cwd: dir,
      issue: "rename answer to result",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const helper = helperSource(dir);
    expect(helper).toContain("function result");
    expect(helper).toContain("return result();");
    expect(provider.calls).toHaveLength(3);
    expect(provider.toolsArgs.every((tools) => tools === undefined)).toBe(true);
    expect(result.records.every((record) => record.toolCalls === 0)).toBe(true);
  }, 30000);

  test("a first-turn rename pins the path and applies without a second edit call", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      [
        "export function answer(): number {",
        "  return 1;",
        "}",
        "",
        "export function getAnswer(): number {",
        "  return answer();",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "src", "helper.test.ts"),
      'import { expect, test } from "bun:test";\nimport { getAnswer } from "./helper";\n\ntest("getAnswer", () => {\n  expect(getAnswer()).toBe(1);\n});\n',
    );
    const provider = new ScriptedProvider([
      editDslReply({
        locator: { path: "src/helper.ts", name: "answer", kind: "function" },
        space: "value",
        matcher: null,
        pick: null,
        replacement: null,
        rename: { from: "answer", to: "result" },
      }),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoopBase({
      cwd: dir,
      issue: "rename answer to result",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(helperSource(dir)).toContain("function result");
    expect(helperSource(dir)).toContain("return result();");
    expect(provider.calls).toHaveLength(2);
  }, 30000);

  test("edit-dsl retries past three rejected exchanges in one round", async () => {
    const dir = fixtureDir();
    const repeatedMisses = Array.from({ length: MAX_STALLED_ROUNDS }, (_, index) =>
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: `return ${900 + index};` })),
    );
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      ...repeatedMisses,
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoopBase({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    // Eight matcher rejections in one round: no 3-exchange cut.
    expect(result.records.filter((record) => record.outcome === "matcher")).toHaveLength(
      MAX_STALLED_ROUNDS,
    );
    const applied = result.records.find((record) => record.outcome === "applied");
    expect(applied?.iteration).toBe(1);
    expect(applied?.exchange).toBe(MAX_STALLED_ROUNDS + 2);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("a mixed rename/write reply applies both when the rename succeeds", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      [
        "export function answer(): number {",
        "  return 1;",
        "}",
        "",
        "export function getAnswer(): number {",
        "  return answer();",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "src", "helper.test.ts"),
      'import { expect, test } from "bun:test";\nimport { getAnswer } from "./helper";\n\ntest("getAnswer", () => {\n  expect(getAnswer()).toBe(1);\n});\n',
    );
    const otherPath = join(dir, "src", "other.ts");
    writeFileSync(otherPath, "export const untouched = 0;\n");
    const mixedReply = [
      editDslReply({
        locator: { path: "src/helper.ts", name: "answer", kind: "function" },
        space: null,
        matcher: null,
        pick: null,
        replacement: null,
        rename: { from: "answer", to: "result" },
      }),
      [
        "write src/other.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        "export const touched = 1;",
        "<<<TC_EDIT_END>>>",
      ].join("\n"),
    ].join("\n\n");
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      mixedReply,
      "Great! I resolve this problem!",
    ]);
    const result = await runLoopBase({
      cwd: dir,
      issue: "rename answer to result and update other.ts",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const helper = helperSource(dir);
    expect(helper).toContain("function result");
    expect(helper).toContain("return result();");
    expect(readFileSync(otherPath, "utf8")).toContain("export const touched = 1;");
  }, 30000);

  test("a mixed rename/write reply is atomic when the rename collides", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      [
        "export function answer(): number {",
        "  return 1;",
        "}",
        "",
        "export function result(): number {",
        "  return 3;",
        "}",
        "",
      ].join("\n"),
    );
    const otherPath = join(dir, "src", "other.ts");
    const originalOther = "export const untouched = 0;\n";
    writeFileSync(otherPath, originalOther);
    const collisionReply = [
      editDslReply({
        locator: { path: "src/helper.ts", name: "answer", kind: "function" },
        space: null,
        matcher: null,
        pick: null,
        replacement: null,
        rename: { from: "answer", to: "result" },
      }),
      [
        "write src/other.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        "export const touched = 1;",
        "<<<TC_EDIT_END>>>",
      ].join("\n"),
    ].join("\n\n");
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      collisionReply,
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoopBase({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(otherPath, "utf8")).toBe(originalOther);
    expect(helperSource(dir)).toContain("return 2;");
    expect(
      result.records.some((record) => record.diagnostics?.includes("collision") === true),
    ).toBe(true);
  }, 30000);

  test("a duplicate top-level declaration is rejected with both candidates named", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      [
        "export function answer(): number {",
        "  return 1;",
        "}",
        "",
        "export function answer(): number {",
        "  return 2;",
        "}",
        "",
      ].join("\n"),
    );
    const address = { path: "src/helper.ts", name: "answer", kind: "function" };
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      [
        "write src/helper.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        "export function answer(): number {",
        "  return 2;",
        "}",
        "<<<TC_EDIT_END>>>",
      ].join("\n"),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoopBase({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    // The ambiguous select names every candidate instead of editing the first.
    const retry = provider.calls[1]?.at(-1)?.content ?? "";
    expect(retry).toContain("matches 2 declarations");
    expect(retry).toContain("the harness never picks one silently");
    expect(retry).toContain("(line 1, column 8)");
    expect(retry).toContain("(line 5, column 8)");
    const finalSource = helperSource(dir);
    expect(finalSource).not.toContain("return 1;");
    expect(finalSource).toContain("return 2;");
    expect(finalSource.match(/function answer/g)).toHaveLength(1);
  }, 30000);

  test("the edit-dsl symbol index is select lines with one-space resolve hints", () => {
    const files: SourceFile[] = [
      {
        path: "src/a.ts",
        source: [
          "export class Widget {}",
          "export enum Color { Red }",
          "export interface Shape { side: number }",
          "export type Alias = number;",
          "export namespace Space {}",
          "export function answer(): number {",
          "  return 1;",
          "}",
          "",
        ].join("\n"),
      },
    ];
    const index = buildIndexTolerant(files).index;
    const text = buildEditDslSymbolIndex(index);
    // A class/enum occupies both spaces, so no resolve hint is emitted.
    expect(text).toContain("select Widget in src/a.ts");
    expect(text).not.toContain("select Widget in src/a.ts resolve");
    expect(text).toContain("select Color in src/a.ts");
    expect(text).toContain("select Shape in src/a.ts resolve type");
    expect(text).toContain("select Alias in src/a.ts resolve type");
    expect(text).toContain("select Space in src/a.ts resolve namespace");
    expect(text).toContain("select answer in src/a.ts resolve value");
    expect(text).not.toContain("signature");
    expect(text).not.toContain("files:");
  });

  test("the edit-dsl symbol index omits test files", () => {
    const files: SourceFile[] = [
      {
        path: "src/a.ts",
        source: "export function answer(): number {\n  return 1;\n}\n",
      },
      {
        path: "src/a.test.ts",
        source: "export function parse(text: string): number {\n  return Number(text);\n}\n",
      },
    ];
    const text = buildEditDslSymbolIndex(buildIndexTolerant(files).index);
    expect(text).toContain("select answer in src/a.ts resolve value");
    expect(text).not.toContain("src/a.test.ts");

    // A from-scratch fixture whose only file is its test has no suggested
    // anchor; the model creates src/impl.ts from the Goal instead.
    const onlyTest = buildIndexTolerant([
      {
        path: "src/lisp.test.ts",
        source: "export function evaluate(program: string): number {\n  return 1;\n}\n",
      },
    ]).index;
    expect(buildEditDslSymbolIndex(onlyTest)).toBe("");
  });

  test("the edit-dsl symbol index is capped with a plain truncation note", () => {
    const declarations = Array.from(
      { length: 501 },
      (_, index) => `export const name${index} = ${index};`,
    ).join("\n");
    const index = buildIndexTolerant([{ path: "src/many.ts", source: declarations }]).index;
    const text = buildEditDslSymbolIndex(index);
    expect(text.split("\n")).toHaveLength(501);
    expect(text).toContain("# symbol index truncated at 500 entries");
    expect(text).toContain("select name499 in src/many.ts resolve value");
    expect(text).not.toContain("select name500 in src/many.ts");
  });

  test("the edit-dsl user and details prompts carry Goal, index, and file-absolute lines", () => {
    const indexText = "select answer in src/helper.ts resolve value";
    const user = buildEditDslUserPrompt("make the answer test pass", indexText);
    expect(user).toContain(
      ["# Goal", "", "make the answer test pass", "", "# Symbol index", "", indexText].join("\n"),
    );
    expect(user).toContain("Reply with exactly one `select … end` clause");
    expect(user).toContain("select answer in src/a.ts resolve value");
    const source = [
      "const before = 1;",
      "",
      "export function answer(): number {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    const start = source.indexOf("export function answer");
    const end = source.indexOf("\n", source.indexOf("}")) + 1;
    expect(numberedSourceRange(source, start, end)).toBe(
      ["3 | export function answer(): number {", "4 |   return 1;", "5 | }"].join("\n"),
    );
    const symbolSource = source.slice(start, end);
    const details = buildEditDslDetailsPrompt(
      "make the answer test pass",
      indexText,
      symbolSource,
      [],
      3,
    );
    expect(details).toContain("# details");
    expect(details).toContain("3 | export function answer(): number {");
    expect(details).toContain("4 |   return 1;");
    expect(details).not.toContain("1 | export function answer");
    expect(details).toContain("A reply is one or more `select … end` clauses");
  });

  test("the edit-dsl details prompt marks matched lines only when given marks", () => {
    const indexText = "select answer in src/helper.ts resolve value";
    const source = ["export function answer(): number {", "  return 1;", "}"].join("\n");
    const bare = buildEditDslDetailsPrompt("make the answer test pass", indexText, source, [], 1);
    expect(bare).not.toMatch(/^⁉️/m);
    expect(bare).toContain("1 | export function answer(): number {");
    expect(bare).toContain("2 |   return 1;");
    const marked = buildEditDslDetailsPrompt(
      "make the answer test pass",
      indexText,
      source,
      [],
      1,
      new Set([2]),
    );
    expect(marked).toContain("⁉️  2 |   return 1;");
    expect(marked).toContain("    1 | export function answer(): number {");
    expect(marked).not.toContain("⁉️  1 |");
    // The declaration is rendered once and the select head/index is unchanged.
    expect(marked.match(/export function answer/g)).toHaveLength(1);
    expect(marked).toContain(indexText);
  });

  test("the edit-dsl create prompt names the target file and the create instruction", () => {
    const prompt = buildEditDslCreatePrompt(
      "add an extra declaration",
      "select extra in src/extra.ts",
      "src/extra.ts",
    );
    expect(prompt).toContain("# Goal");
    expect(prompt).toContain("# Symbol index");
    expect(prompt).toContain("Target file:");
    expect(prompt).toContain("src/extra.ts");
    expect(prompt).toContain('The pinned selection uses mode "create"');
  });

  test("the edit-dsl modified prompt is concise and file-absolute", () => {
    const prompt = buildEditDslModifiedPrompt(
      "make the answer test pass",
      "select answer in src/helper.ts resolve value",
      "export function answer(): number {\n  return 2;\n}",
      7,
    );
    expect(prompt).toContain("# modified text");
    expect(prompt).toContain("7 | export function answer(): number {");
    expect(prompt).toContain("8 |   return 2;");
    expect(prompt).toContain("Reply `Great! I resolve this problem!`");
    expect(prompt).not.toContain("Examples:");
  });

  test("edit-dsl details and modified prompts fold huge source blocks", () => {
    const source = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const details = buildEditDslDetailsPrompt("fold it", "select huge in src/a.ts", source, [], 1);
    const modified = buildEditDslModifiedPrompt("fold it", "select huge in src/a.ts", source, 1);
    const command = buildEditDslCommandPrompt(
      "fold it",
      "select huge in src/a.ts",
      "src/a.ts",
      source,
    );
    for (const prompt of [details, modified, command]) {
      expect(prompt).toContain("1 | line 1");
      expect(prompt).toContain("3 | line 3");
      expect(prompt).toMatch(/content folded, (src\/a\.ts|<path>): 4-7L/);
      expect(prompt).toContain("8 | line 8");
      expect(prompt).toContain("10 | line 10");
      expect(prompt).not.toContain("4 | line 4");
    }
  });

  test("an edit-dsl retry context folds huge current source", () => {
    const source = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const prompt = buildRetryPrompt({
      exchangeNumber: 2,
      mode: "modify",
      currentSource: source,
      diagnostics: "stage: tests",
      failure: "verification",
      editDslContext: {
        issue: "fold it",
        indexText: "select huge in src/a.ts",
        startLine: 1,
      },
    });
    expect(prompt).toContain("1 | line 1");
    expect(prompt).toContain("3 | line 3");
    expect(prompt).toContain("... // content folded, <path>: 4-7L");
    expect(prompt).toContain("8 | line 8");
    expect(prompt).toContain("10 | line 10");
    expect(prompt).not.toContain("4 | line 4");
  });

  test("edit-dsl prompts teach the fold marker, its expansion, and the write fallback (#25)", () => {
    const source = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const indexText = "select huge in src/a.ts";
    const marker = "... // content folded, src/a.ts: 4-7L";
    const retryInput: RetryPromptInput = {
      exchangeNumber: 2,
      mode: "modify",
      currentSource: source,
      diagnostics: "stage: tests",
      failure: "verification",
      editDslContext: { issue: "fold it", indexText, startLine: 1 },
    };
    const system = buildSystemPrompt();
    const read = buildEditDslReadPrompt("fold it", indexText, `Read results:\n${marker}`);
    const details = buildEditDslDetailsPrompt("fold it", indexText, source, [], 1);
    const command = buildEditDslCommandPrompt("fold it", indexText, "src/a.ts", source);
    const retry = buildRetryPrompt(retryInput);
    const instruction = editDslInstruction();
    const examples = renderEditDslExamples();

    // The role names the expert and the motivation explains why the protocol.
    expect(system.startsWith("You are a TypeScript expert using the Edit-action DSL")).toBe(true);
    expect(system).toContain("This is the Edit-action DSL.");
    expect(system).toContain("a bare `select <symbol> in <path> end` is a viewer");
    expect(system).toContain("`create [static] <kind> <name> in <path> with <fence> end`");
    expect(system).toContain("select file <path>");
    expect(system).toContain("create import|export in <path>");
    expect(system).toContain("a dotted create never creates its owner");
    expect(system).toContain("Edits are small and addressable");
    expect(system).toContain("Editing clauses in one reply apply atomically");
    expect(system).not.toContain("Tools: `select … end` with no `replace` is a viewer");

    // The one detailed fold explanation lives in the system prompt.
    expect(system).toContain(
      "... // content folded, <path>: N-ML (H of T lines hidden); expand with read <path> within N-M end",
    );
    expect(system).toContain("whole-file `read` is folded the same way");
    expect(system).toContain("returns the selected lines unfolded");
    expect(system).toContain("write <path> with <fence>");
    expect(system).toContain("When a repair spans several declarations");

    // Every edit-phase and read prompt teaches the expansion and its caveat.
    for (const prompt of [read, details, command, retry]) {
      expect(prompt).toContain("read <path> within <start>-<end> end");
      expect(prompt).toContain("whole-file `read` is folded the same way");
      expect(prompt).toContain("write <path> with <fence>");
    }
    for (const prompt of [read, command]) {
      expect(prompt).toContain("returns those lines unfolded");
    }
    expect(details).toContain("selected lines come back unfolded");
    expect(retry).toContain("selected lines come back unfolded");
    // The read prompt surfaces the concrete folded result and the real path.
    expect(read).toContain(marker);
    expect(command).toContain("expand with read src/a.ts within 4-7 end");

    // The instruction carries the ordered workflow and its triggers.
    expect(instruction).toContain("a block that shows `... // content folded ...` is large");
    expect(instruction).toContain(
      "Expand the hidden range with `read <path> within <start>-<end> end`",
    );
    expect(instruction).toContain("never repeat the same whole-file `read`");
    expect(instruction).toContain(
      "when a repair spans several declarations, or repeated localized edits keep introducing new tsc/test errors",
    );
    expect(instruction).toContain("switch to a whole-file `write <path> with <fence>`");
    expect(instruction).toContain("No listed micro-operation fits");
    expect(instruction).toContain("explore autonomously");
    expect(instruction).toContain("do not burn exchanges repeating a read you already made");
    expect(instruction).toContain("Imports and exports have no declaration address");
    expect(instruction).toContain("select file <path>");
    expect(instruction).toContain("create import in <path>");

    // The examples pair each trigger with the concrete command form.
    expect(examples).toContain("Folded view");
    expect(examples).toContain("(332 of 338 lines hidden)");
    expect(examples).toContain("read src/lisp.ts within 4-335 end");
    expect(examples).toContain("Whole-file repair");
    expect(examples).toContain("write src/lisp.ts with");
    expect(examples).toContain("Kind-aware create");
    expect(examples).toContain("create method Parser.parseValue in src/parser.ts with");
    expect(examples).toContain("File-level select");
    expect(examples).toContain("select file src/parser.ts");
    expect(examples).toContain("Module-boundary create");
    expect(examples).toContain("create import in src/parser.ts with");
    expect(instruction).toContain("read src/lisp.ts within 4-335 end");
  });

  test("the edit-dsl system prompt states the pinned output contract and soft scaffold advice (#56)", () => {
    const system = buildSystemPrompt();

    for (const prompt of [system]) {
      expect(prompt).toContain(EDIT_DSL_OUTPUT_CONTRACT);
      expect(prompt).toContain("No tools are available on this turn");
      expect(prompt).toContain(
        "`read`, `select`, `write`, `create`, `delete`, `check`, and `test` are literal edit-dsl text commands, not function calls",
      );
      expect(prompt).toContain("standalone `check end` runs the task's check command");
      expect(prompt).toContain("`test end` runs its test command");
      expect(prompt).toContain("A self-check reply must contain exactly one of those commands");
      expect(prompt).toContain("Never emit `<|...|>`, `<｜...｜>`");
      expect(prompt).toContain(
        "is plain text: it is not a Markdown code fence and not a tool-call boundary",
      );
      expect(prompt).toContain("no prose preamble, no Markdown fence around the reply, no JSON");

      // Scaffold advice is advisory, not a cap: a large write stays valid.
      expect(prompt).toContain(
        "one whole-file `write` scaffold of the public types, signatures, and stub bodies is often cheapest",
      );
      expect(prompt).toContain(
        "dozens of separate initial `create` clauses usually cost more and are easier to break",
      );
      expect(prompt).toContain(
        "A large `write` remains valid: this is advice, not a size or clause-count cap",
      );

      // Pinned repair gets no plan-exec node/DAG or test-checkpoint language.
      expect(prompt).not.toContain("WorkNode");
      expect(prompt).not.toContain("final test node");
      expect(prompt).not.toContain("early verify checkpoint");
    }

    // The contract is the only system prompt.
    expect(buildSystemPrompt()).toContain(EDIT_DSL_OUTPUT_CONTRACT);
  });

  test("an edit-dsl retry prompt uses Goal, index, and details without the JSON block", () => {
    const prompt = buildRetryPrompt({
      exchangeNumber: 2,
      mode: "modify",
      currentSource: "function answer(): number {\n  return 1;\n}",
      diagnostics: "stage: matcher\nthe matcher was not found",
      failure: "edit",
      editDslContext: {
        issue: "make the answer test pass",
        indexText: "select answer in src/helper.ts resolve value",
        startLine: 4,
      },
    });
    expect(prompt).toContain("# Goal");
    expect(prompt).toContain("make the answer test pass");
    expect(prompt).toContain("# Symbol index");
    expect(prompt).toContain("select answer in src/helper.ts resolve value");
    expect(prompt).toContain("# details");
    expect(prompt).toContain("4 | function answer(): number {");
    expect(prompt).toContain("A reply is one or more `select … end` clauses");
    expect(prompt).not.toContain("```json");
    expect(prompt).not.toContain("Each line below is prefixed");
    expect(prompt).not.toContain("Optionally locate the span");
    // The removed JSON self-check reply is not taught on an edit-dsl turn.
    expect(prompt).not.toContain('{"request":"read"}');
  });

  test("edit-dsl selection retry and no-progress ask use the select-first shape", () => {
    const retry = buildEditDslSelectionRetryPrompt(
      "make the answer test pass",
      "select answer in src/helper.ts resolve value",
      "stage: address\nthe address matches 2 declarations",
    );
    expect(retry).toContain("# Goal");
    expect(retry).toContain("# Symbol index");
    expect(retry).toContain("The previous selection was rejected.");
    expect(retry).toContain("Reply with ONLY one `select … end` clause");
    expect(retry).not.toContain("Output ONLY a corrected selection JSON object");
    expect(retry).not.toContain('{"request":"read"}');

    const continuation = buildEditDslSelectionContinuationPrompt({
      failedAttempts: 8,
      issue: "make the answer test pass",
      indexText: "select answer in src/helper.ts resolve value",
      diagnostics: "stage: protocol\nthe reply must be one clause",
      failureHistory: "failure history",
      digest: "attempt digest",
    });
    expect(continuation).toContain("No progress: 8 consecutive failed selection attempts");
    expect(continuation).toContain(
      "Reply STOP to end the run, or return one `select … end` clause",
    );
    expect(continuation).toContain("# Goal");
    expect(continuation).toContain("# Symbol index");
    expect(continuation).toContain("failure history");
    expect(continuation).toContain("attempt digest");
    expect(continuation).not.toContain("corrected selection JSON object");
  });

  test("with the edit-dsl format the fresh edit and retry prompts teach all four canonical forms", () => {
    const edit = buildEditPrompt(
      '{"path":"src/a.ts","symbol":"make","kind":"function"}',
      "const x = 1;\n",
    );
    expect(edit).toContain("A reply is one or more `select … end` clauses");
    expect(edit).toContain(
      "A clause with neither `replace` nor `rename` is a viewer that writes nothing unless it contains `pick`; `pick` requires `replace`",
    );
    expect(edit).toContain("every clause in one reply must resolve to a different declaration");
    // The four forms are rendered from the grammar's own serializer.
    expect(edit).toContain("select function f in src/x.ts resolve value");
    expect(edit).toContain("select const MAX_TOKENS in src/x.ts");
    expect(edit).toContain("pick 2");
    expect(edit).toContain(`match ${TICK}return 1;${TICK}`);
    expect(edit).toContain("<<<TC_EDIT_BEGIN>>>\nreturn 2;\n<<<TC_EDIT_END>>>");
    expect(edit).toContain("select function clamp in src/x.ts");
    const retry = buildRetryPrompt({
      exchangeNumber: 2,
      mode: "modify",
      currentSource: "const x = 1;\n",
      diagnostics: "boom",
      failure: "verification",
    });
    expect(retry).toContain("A reply is one or more `select … end` clauses");
    expect(retry).toContain("select function f in src/x.ts");
    expect(retry).not.toContain(
      'Output ONLY one flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}',
    );
  });

  test("under edit-dsl a select viewer pins and the next edit applies", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(provider.calls).toHaveLength(3);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "ok",
      "confirmed",
    ]);
    const details = provider.calls[1]?.at(-1)?.content ?? "";
    expect(details).toContain("# details");
    expect(details).toContain("1 | export function answer(): number {");
    // A bare select viewer marks nothing in the details block.
    expect(details).not.toMatch(/^⁉️/m);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("under edit-dsl a top-level const resolves and edits with its keyword", async () => {
    const dir = passingFixtureDir();
    writeFileSync(join(dir, "src", "constants.ts"), "export const MAX_TOKENS = 1;\n");
    const provider = new ScriptedProvider([
      editDslSelect("MAX_TOKENS", "src/constants.ts", "value", "const"),
      editDslReply({
        locator: { path: "src/constants.ts", name: "MAX_TOKENS", kind: "const" },
        space: "value",
        matcher: { kind: "snippet", value: "1" },
        pick: null,
        replacement: "2",
      }),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "raise the token budget",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "ok",
      "confirmed",
    ]);
    expect(result.locator).toEqual({
      path: "src/constants.ts",
      name: "MAX_TOKENS",
      kind: "const",
    });
    expect(readFileSync(join(dir, "src", "constants.ts"), "utf8")).toContain(
      "export const MAX_TOKENS = 2;",
    );
  }, 30000);

  test("under edit-dsl a variable kind mismatch suggests only grammar kinds", async () => {
    const dir = passingFixtureDir();
    writeFileSync(join(dir, "src", "constants.ts"), "export const MAX_TOKENS = 1;\n");
    const provider = new ScriptedProvider([
      editDslSelect("MAX_TOKENS", "src/constants.ts", "value", "function"),
      editDslSelect("MAX_TOKENS", "src/constants.ts", "value", "const"),
      editDslReply({
        locator: { path: "src/constants.ts", name: "MAX_TOKENS", kind: "const" },
        space: "value",
        matcher: { kind: "snippet", value: "1" },
        pick: null,
        replacement: "2",
      }),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "raise the token budget",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const failed = result.records[0];
    expect(failed?.outcome).toBe("address");
    const diagnostics = failed?.diagnostics ?? "";
    expect(diagnostics).toContain(
      'in "src/constants.ts" the name exists as "const", "let", "var"; change "kind" to one of those, or omit "kind" for a bare select',
    );
    expect(diagnostics).not.toContain('"variable"');
    expect(diagnostics).not.toContain(": variable ");
    expect(readFileSync(join(dir, "src", "constants.ts"), "utf8")).toContain(
      "export const MAX_TOKENS = 2;",
    );
  }, 30000);

  test("under edit-dsl a first-turn match viewer marks the matched line in # details", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslReply({
        locator: { path: "src/helper.ts", name: "answer", kind: "function" },
        space: "value",
        matcher: { kind: "snippet", value: "return 1;" },
        pick: null,
        replacement: null,
      }),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const details = provider.calls[1]?.at(-1)?.content ?? "";
    expect(details).toContain("# details");
    expect(details).toContain("⁉️  2 |   return 1;");
    expect(details).not.toContain("⁉️  1 |");
    expect(details).not.toContain("⁉️  3 |");
    // The declaration renders once with file-absolute numbering.
    expect(details.match(/export function answer/g)).toHaveLength(1);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("under edit-dsl a missing symbol select pins create and the next clause creates", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("extra", "src/extra.ts"),
      editDslReply(
        createEditor(
          "src/extra.ts",
          "extra",
          "function",
          "export function extra(): number {\n  return 1;\n}",
        ),
      ),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "add an extra declaration",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(provider.calls).toHaveLength(4);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tests",
      "applied",
      "ok",
      "confirmed",
    ]);
    const createPrompt = provider.calls[1]?.at(-1)?.content ?? "";
    expect(createPrompt).toContain("# Symbol index");
    expect(createPrompt).toContain("Target file:");
    expect(createPrompt).toContain("src/extra.ts");
    expect(readFileSync(join(dir, "src", "extra.ts"), "utf8")).toContain("export function extra");
  }, 30000);

  test("under edit-dsl a first-turn kind-aware create statement creates a declaration", async () => {
    const dir = passingFixtureDir();
    const reply = [
      "create function extra in src/extra.ts with",
      "<<<TC_EDIT_BEGIN>>>",
      "export function extra(): number {",
      "  return 1;",
      "}",
      "<<<TC_EDIT_END>>>",
      "end",
    ].join("\n");
    const provider = new ScriptedProvider([reply, "Great! I resolve this problem!"]);
    const result = await runLoop({
      cwd: dir,
      issue: "add an extra declaration",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "extra.ts"), "utf8")).toContain("export function extra");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "ok",
      "confirmed",
    ]);
  }, 30000);

  test("under edit-dsl a first-turn kind-aware create adds a class member", async () => {
    const dir = passingFixtureDir();
    writeFileSync(
      join(dir, "src", "parser.ts"),
      "export class Parser {\n  parseValue(): number {\n    return 1;\n  }\n}\n",
    );
    const reply = [
      "create method Parser.trim in src/parser.ts with",
      "<<<TC_EDIT_BEGIN>>>",
      "trim(): string {",
      '  return "";',
      "}",
      "<<<TC_EDIT_END>>>",
      "end",
    ].join("\n");
    const provider = new ScriptedProvider([reply, "Great! I resolve this problem!"]);
    const result = await runLoop({
      cwd: dir,
      issue: "add a method",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const source = readFileSync(join(dir, "src", "parser.ts"), "utf8");
    expect(source).toContain("trim(): string");
    expect(source.indexOf("trim(): string")).toBeLessThan(source.lastIndexOf("}"));
  }, 30000);

  test("under edit-dsl a file-level select edits an import statement", async () => {
    const dir = passingFixtureDir();
    writeFileSync(join(dir, "src", "base.ts"), "export const BASE = 2;\n");
    writeFileSync(join(dir, "src", "base2.ts"), "export const BASE = 2;\n");
    writeFileSync(
      join(dir, "src", "helper.ts"),
      'import { BASE } from "./base";\nexport function answer(): number {\n  return BASE;\n}\n',
    );
    const reply = editDslReply({
      locator: { path: "src/helper.ts", name: "", kind: "file" },
      space: null,
      matcher: { kind: "snippet", value: 'import { BASE } from "./base";' },
      pick: null,
      replacement: 'import { BASE } from "./base2";',
    });
    const provider = new ScriptedProvider([reply, "Great! I resolve this problem!"]);
    const result = await runLoop({
      cwd: dir,
      issue: "switch the import source",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(provider.calls).toHaveLength(2);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "ok",
      "confirmed",
    ]);
    expect(helperSource(dir)).toContain('from "./base2"');
    const applied = result.records.find((record) => record.outcome === "applied");
    expect(applied?.stages).toEqual(["match"]);
    expect(applied?.matcherKinds).toEqual(["snippet"]);
  }, 30000);

  test("under edit-dsl module creates add imports to a new and an existing file", async () => {
    const dir = passingFixtureDir();
    writeFileSync(join(dir, "src", "base.ts"), "export const BASE = 2;\n");
    const reply = [
      "create import in src/helper.ts with",
      "<<<TC_EDIT_BEGIN>>>",
      'import { BASE } from "./base";',
      "<<<TC_EDIT_END>>>",
      "end",
      "",
      "create import in src/new.ts with",
      "<<<TC_EDIT_BEGIN>>>",
      'import { BASE as NEW_BASE } from "./base";',
      "<<<TC_EDIT_END>>>",
      "end",
    ].join("\n");
    const provider = new ScriptedProvider([reply, "Great! I resolve this problem!"]);
    const result = await runLoop({
      cwd: dir,
      issue: "add module imports",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(helperSource(dir).startsWith('import { BASE } from "./base";\n')).toBe(true);
    expect(readFileSync(join(dir, "src", "new.ts"), "utf8")).toBe(
      'import { BASE as NEW_BASE } from "./base";\n',
    );
    const applied = result.records.find((record) => record.outcome === "applied");
    expect(applied?.creates).toBe(2);
  }, 30000);

  test("under edit-dsl a file-level select applies without a second provider call", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(provider.calls).toHaveLength(2);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "ok",
      "confirmed",
    ]);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("under edit-dsl a verified edit sends # modified text and a Great reply confirms", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(provider.calls).toHaveLength(3);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "ok",
      "confirmed",
    ]);
    const modified = provider.calls[2]?.at(-1)?.content ?? "";
    expect(modified).toContain("# modified text");
    expect(modified).toContain("2 |   return 2;");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("under edit-dsl a confirmation editor continues without a duplicate provider call", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      editDslReply(
        answerEditor(
          "export function answer(): number {\n  const value = 2;\n  return value;\n}",
          null,
        ),
      ),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    // select, first edit, confirmation editor, final confirmation: the
    // prefetched editor is never a provider call of its own.
    expect(provider.calls).toHaveLength(4);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "ok",
      "confirmed",
      "applied",
      "ok",
      "confirmed",
    ]);
    expect(provider.calls[2]?.at(-1)?.content).toContain("# modified text");
    expect(provider.calls[3]?.at(-1)?.content).toContain("# modified text");
    expect(helperSource(dir)).toContain("const value = 2;");
  }, 30000);

  test("under edit-dsl a confirmation editor continues in the same round", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      // Exchange 2: a matcher miss, rejected without ending the round.
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 9;" })),
      // Exchange 3: the verified edit, consuming the round's last exchange.
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      // The confirmation editor is prefetched on that last exchange (#8).
      editDslReply(
        answerEditor(
          "export function answer(): number {\n  const value = 2;\n  return value;\n}",
          null,
        ),
      ),
      // The second edit's own confirmation turn.
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    // select, rejected edit, verified edit, confirmation editor, final
    // confirmation: the prefetched editor is never a provider call of its own.
    expect(provider.calls).toHaveLength(5);
    expect(
      provider.calls.filter((call) => call.at(-1)?.content?.includes("# modified text")),
    ).toHaveLength(2);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "matcher",
      "applied",
      "ok",
      "confirmed",
      "applied",
      "ok",
      "confirmed",
    ]);
    // #57 removed the fixed exchange boundary, so the carried edit is simply
    // the next exchange of the same round; the record order keeps the
    // confirmed row before it.
    const carried = result.records[5];
    expect(carried?.iteration).toBe(1);
    expect(carried?.exchange).toBe(4);
    expect(helperSource(dir)).toContain("const value = 2;");
  }, 30000);

  test("under edit-dsl a prose confirmation ends the verified run", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      "Done.",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(provider.calls).toHaveLength(3);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "ok",
      "confirmed",
    ]);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("under edit-dsl a malformed confirmation ends the verified run", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      "select {",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(provider.calls).toHaveLength(3);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "ok",
      "confirmed",
    ]);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("under edit-dsl an edit rejection retry uses Goal, index, and details", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 9;" })),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "matcher",
      "applied",
      "ok",
      "confirmed",
    ]);
    const retry = provider.calls[2]?.at(-1)?.content ?? "";
    expect(retry).toContain("# Goal");
    expect(retry).toContain("# Symbol index");
    expect(retry).toContain("# details");
    expect(retry).toContain("A reply is one or more `select … end` clauses");
    expect(retry).not.toContain("```json");
  }, 30000);

  test("under edit-dsl a rejected selection retry asks for one select clause", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "dual.ts"),
      "export interface Dual {}\nexport const Dual = 1;\n",
    );
    const provider = new ScriptedProvider([
      editDslSelect("Dual", "src/dual.ts"),
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const retry = provider.calls[1]?.at(-1)?.content ?? "";
    expect(retry).toContain("# Goal");
    expect(retry).toContain("# Symbol index");
    expect(retry).toContain("The previous selection was rejected.");
    expect(retry).toContain("Reply with ONLY one `select … end` clause");
    expect(retry).not.toContain("Output ONLY a corrected selection JSON object");
  }, 30000);

  test("under edit-dsl a `match` + `replace` reply applies end-to-end", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(helperSource(dir)).toContain("return 2;");
    const applied = result.records.find((record) => record.outcome === "applied");
    expect(applied?.payloads).toBe(1);
    expect(applied?.stages).toEqual(["match"]);
    expect(applied?.matcherKinds).toEqual(["snippet"]);
    expect(applied?.selectors).toEqual(["matcher"]);
  }, 30000);

  test("under edit-dsl a fenced reply applies end-to-end", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      `${TICK}${TICK}${TICK}\n${editDslReply(
        answerEditor("return 2;", { kind: "snippet", value: "return 1;" }),
      )}\n${TICK}${TICK}${TICK}`,
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(helperSource(dir)).toContain("return 2;");
    const applied = result.records.find((record) => record.outcome === "applied");
    expect(applied?.payloads).toBe(1);
    expect(applied?.stages).toEqual(["match"]);
    expect(applied?.matcherKinds).toEqual(["snippet"]);
    expect(applied?.selectors).toEqual(["matcher"]);
  }, 30000);

  test("under edit-dsl a bare declaration replace records the whole-symbol stage", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply(answerEditor("export function answer(): number {\n  return 2;\n}", null)),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(helperSource(dir)).toContain("return 2;");
    const applied = result.records.find((record) => record.outcome === "applied");
    expect(applied?.stages).toEqual(["whole-symbol"]);
    expect(applied?.matcherKinds).toEqual([null]);
    expect(applied?.selectors).toEqual(["whole-symbol"]);
  }, 30000);

  test("under edit-dsl a `match` + `pick` reply records the pick stage", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply(
        answerEditor("return 2;", { kind: "snippet", value: "return 1;" }, [
          { line: 2, column: 3, endLine: 2, endColumn: 11 },
        ]),
      ),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(helperSource(dir)).toContain("return 2;");
    const applied = result.records.find((record) => record.outcome === "applied");
    expect(applied?.stages).toEqual(["pick"]);
    expect(applied?.matcherKinds).toEqual(["snippet"]);
    expect(applied?.selectors).toEqual(["range"]);
  }, 30000);

  test("under edit-dsl a viewer writes nothing and feeds its candidates into the next prompt", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      // A viewer of a matched span: no `replace`, so it locates and writes nothing.
      editDslReply(answerEditor(null, { kind: "snippet", value: "return 1;" })),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const viewer = result.records.find((record) => record.outcome === "viewer");
    expect(viewer).toBeDefined();
    expect(viewer?.replacement).toBeNull();
    // The viewer's occurrences ride into the following edit prompt.
    const nextPrompt = provider.calls[2]?.at(-1)?.content ?? "";
    expect(nextPrompt).toContain("Located occurrences (viewer clauses write nothing):");
    expect(nextPrompt).toContain("src/helper.ts:2:3");
    // The subsequent JSON edit still applies on the same run.
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("under edit-dsl a no-kind resolve value viewer addresses the function", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      // No declaration kind, explicit value space: the path + name + space
      // resolve the exported function exactly once.
      "select answer in src/helper.ts resolve value\nend",
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const viewer = result.records.find((record) => record.outcome === "viewer");
    expect(viewer).toBeDefined();
    expect(viewer?.diagnostics).toContain("Located occurrences");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("under edit-dsl a no-kind name in two spaces is an ambiguous address", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "dual.ts"),
      "export interface Dual {}\nexport const Dual = 1;\n",
    );
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply({
        locator: { path: "src/dual.ts", name: "Dual", kind: "" },
        space: null,
        matcher: null,
        pick: null,
        replacement: "42",
      }),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const rejected = result.records.find(
      (record) => record.kind === "exchange" && record.outcome === "address",
    );
    expect(rejected).toBeDefined();
    expect(rejected?.diagnostics).toContain("matches 2 declarations");
    expect(rejected?.diagnostics).toContain("never picks one silently");
    expect(readFileSync(join(dir, "src", "dual.ts"), "utf8")).not.toContain("42");
  }, 30000);

  test("under edit-dsl a malformed regex is classified as regex-invalid at the matcher stage", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply(answerEditor("return 2;", { kind: "regex", value: "(" })),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const rejected = result.records.find((record) => record.outcome === "matcher");
    expect(rejected?.cause).toBe("regex-invalid");
    expect(rejected?.diagnostics).toContain("stage: edit-dsl");
  }, 30000);

  test("a syntax rejection names the failing line, column, and excerpt (#25)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      ["select answer in src/helper.ts", "match `return 1;`", "nonsense"].join("\n"),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const rejected = result.records.find(
      (record) => record.outcome === "protocol" && record.diagnostics?.includes("at line") === true,
    );
    expect(rejected?.diagnostics).toContain("expected `end`");
    expect(rejected?.diagnostics).toContain("^");
  }, 30000);

  // An edit-dsl clause over a `pair.ts` declaration, for the multi-clause atomic
  // application tests below.
  function pairEditor(
    symbol: string,
    replacement: string,
    matcher: EditDslSelection["matcher"],
  ): EditDslSelection {
    return {
      locator: { path: "src/pair.ts", name: symbol, kind: "function" },
      space: null,
      matcher,
      pick: null,
      replacement,
    };
  }

  test("an edit-dsl multi-clause reply applies the valid clause, ignores one no-op clause, and warns", async () => {
    const dir = sameFileFixtureDir();
    const original = pairSource(dir);
    let afterInert = "";
    const provider = new ScriptedProvider(
      [
        editDslSelect("one", "src/pair.ts"),
        editDslReply(
          // Clause 1 applies `one`'s fix.
          pairEditor("one", "return 2;", { kind: "snippet", value: "return 1;" }),
          // Clause 2 changes nothing: its replacement equals the matched source.
          pairEditor("two", "return 1;", { kind: "snippet", value: "return 1;" }),
        ),
        // `one` already applied; only the remaining real edit is resent.
        editDslReply(pairEditor("two", "return 3;", { kind: "snippet", value: "return 1;" })),
        "Great! I resolve this problem!",
      ],
      (callIndex) => {
        if (callIndex === 2) {
          afterInert = pairSource(dir);
        }
      },
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make both declarations satisfy the pair test",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    // The valid clause applied; the inert clause did not block the reply.
    expect(afterInert).not.toBe(original);
    expect(afterInert).toContain("return 2;");
    expect(afterInert).toContain("return 1;");
    const source = pairSource(dir);
    expect(source).toContain("return 2;");
    expect(source).toContain("return 3;");
    expect(source).not.toContain("return 1;");
    expect(result.warnings).toEqual([
      "ignored 1 inert edit-dsl clause whose replacement was identical to the selected text; do not resend it",
    ]);
    const applied = result.records.find(
      (record) => record.kind === "exchange" && record.outcome === "applied",
    );
    expect(applied?.payloads).toBe(2);
    // The ignored clause is not part of the applied telemetry.
    expect(applied?.stages).toEqual(["match"]);
    expect(applied?.selectors).toEqual(["matcher"]);
    expect(applied?.matcherKinds).toEqual(["snippet"]);
    expect(result.records.some((record) => record.outcome === "no-op")).toBe(false);
  }, 30000);

  test("an edit-dsl reply whose clauses are all inert is still a no-op rejection", async () => {
    const dir = sameFileFixtureDir();
    const original = pairSource(dir);
    let afterRejection = "";
    const provider = new ScriptedProvider(
      [
        editDslSelect("one", "src/pair.ts"),
        editDslReply(
          pairEditor("one", "return 1;", { kind: "snippet", value: "return 1;" }),
          pairEditor("two", "return 1;", { kind: "snippet", value: "return 1;" }),
        ),
        editDslReply(
          pairEditor("one", "return 2;", { kind: "snippet", value: "return 1;" }),
          pairEditor("two", "return 3;", { kind: "snippet", value: "return 1;" }),
        ),
        "Great! I resolve this problem!",
      ],
      (callIndex) => {
        if (callIndex === 2) {
          afterRejection = pairSource(dir);
        }
      },
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make both declarations satisfy the pair test",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    // All clauses were inert, so nothing was written and the retry saw the original.
    expect(afterRejection).toBe(original);
    const rejected = result.records.find(
      (record) => record.kind === "exchange" && record.outcome === "no-op",
    );
    expect(rejected).toBeDefined();
    expect(rejected?.diagnostics).toContain("clause 1 of 2");
    expect(rejected?.diagnostics).toContain("clause 2 of 2");
    expect(rejected?.diagnostics).toContain("stage: no-op");
    expect(rejected?.diagnostics).toContain("the whole edit-dsl reply is discarded");
    expect(result.warnings).toBeUndefined();
    const source = pairSource(dir);
    expect(source).toContain("return 2;");
    expect(source).toContain("return 3;");
  }, 30000);

  test("a no-op clause does not salvage a reply with a non-no-op failure", async () => {
    const dir = sameFileFixtureDir();
    const original = pairSource(dir);
    let afterRejection = "";
    const provider = new ScriptedProvider(
      [
        editDslSelect("one", "src/pair.ts"),
        editDslReply(
          // Clause 1 fails its matcher, which stays whole-reply atomic.
          pairEditor("one", "return 2;", { kind: "snippet", value: "return 999;" }),
          // Clause 2 is inert and must not make clause 1 apply.
          pairEditor("two", "return 1;", { kind: "snippet", value: "return 1;" }),
        ),
        editDslReply(
          pairEditor("one", "return 2;", { kind: "snippet", value: "return 1;" }),
          pairEditor("two", "return 3;", { kind: "snippet", value: "return 1;" }),
        ),
        "Great! I resolve this problem!",
      ],
      (callIndex) => {
        if (callIndex === 2) {
          afterRejection = pairSource(dir);
        }
      },
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make both declarations satisfy the pair test",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(afterRejection).toBe(original);
    const rejected = result.records.find(
      (record) => record.kind === "exchange" && record.outcome === "matcher",
    );
    expect(rejected).toBeDefined();
    expect(rejected?.diagnostics).toContain("clause 1 of 2");
    expect(rejected?.diagnostics).toContain("clause 2 of 2");
    expect(rejected?.diagnostics).toContain("stage: no-op");
    expect(rejected?.diagnostics).toContain("the whole edit-dsl reply is discarded");
    expect(result.warnings).toBeUndefined();
    const source = pairSource(dir);
    expect(source).toContain("return 2;");
    expect(source).toContain("return 3;");
  }, 30000);

  test("a failed read does not discard the same reply's edits (#25)", async () => {
    const dir = sameFileFixtureDir();
    const original = pairSource(dir);
    const provider = new ScriptedProvider([
      editDslSelect("one", "src/pair.ts"),
      [
        editDslReply(
          pairEditor("one", "return 2;", { kind: "snippet", value: "return 1;" }),
          pairEditor("two", "return 3;", { kind: "snippet", value: "return 1;" }),
        ),
        "read src/pair.ts within 99 end",
      ].join("\n\n"),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make both declarations satisfy the pair test",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(pairSource(dir)).not.toBe(original);
    expect(pairSource(dir)).toContain("return 2;");
    expect(pairSource(dir)).toContain("return 3;");
    expect(result.records.some((record) => record.outcome === "range")).toBe(false);
  }, 30000);

  test("a reply that only issues an invalid read is still a rejected read (#25)", async () => {
    const dir = sameFileFixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("one", "src/pair.ts"),
      "read src/pair.ts within 99 end",
      editDslReply(
        pairEditor("one", "return 2;", { kind: "snippet", value: "return 1;" }),
        pairEditor("two", "return 3;", { kind: "snippet", value: "return 1;" }),
      ),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make both declarations satisfy the pair test",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const rejected = result.records.find((record) => record.outcome === "range");
    expect(rejected?.diagnostics).toContain("Read failed");
  }, 30000);

  test("two edit-dsl clauses on one declaration are duplicates and the retry splits them", async () => {
    const dir = sameFileFixtureDir();
    const original = pairSource(dir);
    let afterFailure = "";
    const provider = new ScriptedProvider(
      [
        editDslSelect("one", "src/pair.ts"),
        editDslReply(
          // Both clauses address `one`, whatever span each one matches: the
          // second resolved target is a duplicate, so neither can apply.
          pairEditor("one", "return 2;", { kind: "snippet", value: "return 1;" }),
          pairEditor("one", "return 9;", { kind: "snippet", value: "return 1;" }),
        ),
        editDslReply(
          pairEditor("one", "return 2;", { kind: "snippet", value: "return 1;" }),
          pairEditor("two", "return 3;", { kind: "snippet", value: "return 1;" }),
        ),
        "Great! I resolve this problem!",
      ],
      (callIndex) => {
        if (callIndex === 2) {
          afterFailure = pairSource(dir);
        }
      },
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make both declarations satisfy the pair test",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(afterFailure).toBe(original);
    const source = pairSource(dir);
    expect(source).toContain("return 2;");
    expect(source).toContain("return 3;");
    expect(source).not.toContain("return 9;");
    const rejected = result.records.find(
      (record) => record.kind === "exchange" && record.outcome === "duplicate",
    );
    expect(rejected).toBeDefined();
    expect(rejected?.diagnostics).toContain("stage: duplicate");
    expect(rejected?.diagnostics).toContain(
      'clause 1 and clause 2 both select the same function "one" in "src/pair.ts"',
    );
    expect(rejected?.diagnostics).toContain("the whole edit-dsl reply is discarded");
    expect(rejected?.diagnostics).toContain("nothing is written");
  }, 30000);

  test("a four-clause draft-plus-correction reply cannot create the same declarations twice (#13)", async () => {
    const dir = fixtureDir();
    const originalHelper = helperSource(dir);
    const parseBody =
      "export function parseJson(text: string): JsonValue {\n  return text as JsonValue;\n}";
    let jsonAfterFailure: string | null = "unread";
    let helperAfterFailure = "";
    const provider = new ScriptedProvider(
      [
        editDslSelect("JsonValue", "src/json.ts"),
        editDslReply(
          // The #11 shape: two creates, then the same two fences again asking
          // for the other locator kind. Every fence creates the same
          // declaration, so clauses 3 and 4 conflict with 1 and 2.
          createEditor(
            "src/json.ts",
            "JsonValue",
            "const",
            "export type JsonValue = string | number;",
          ),
          createEditor("src/json.ts", "parseJson", "function", parseBody),
          createEditor(
            "src/json.ts",
            "JsonValue",
            "type",
            "export type JsonValue = string | number;",
            "type",
          ),
          createEditor("src/json.ts", "parseJson", "function", parseBody, "value"),
        ),
        editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
        "Great! I resolve this problem!",
      ],
      (callIndex) => {
        if (callIndex === 2) {
          const jsonPath = join(dir, "src", "json.ts");
          jsonAfterFailure = existsSync(jsonPath) ? readFileSync(jsonPath, "utf8") : null;
          helperAfterFailure = helperSource(dir);
        }
      },
    );
    const result = await runLoop({
      cwd: dir,
      issue: "add the JSON declaration",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    // The whole reply was discarded: no file, no helper change.
    expect(jsonAfterFailure).toBeNull();
    expect(helperAfterFailure).toBe(originalHelper);
    const rejected = result.records.find(
      (record) => record.kind === "exchange" && record.outcome === "duplicate",
    );
    expect(rejected).toBeDefined();
    expect(rejected?.diagnostics).toContain("stage: duplicate");
    expect(rejected?.diagnostics).toContain(
      'clause 1 and clause 3 both create the same top-level type "JsonValue"',
    );
    expect(rejected?.diagnostics).toContain(
      'clause 2 and clause 4 both create the same top-level function "parseJson"',
    );
    expect(rejected?.diagnostics).toContain("the whole edit-dsl reply is discarded");
    expect(rejected?.diagnostics).toContain("nothing is written");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("two same-offset zero-width creates append in clause order (#13)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("Alpha", "src/new.ts"),
      editDslReply(
        // Both creates append at the empty file's offset 0..0; the append
        // policy keeps clause order instead of discarding the reply.
        createEditor(
          "src/new.ts",
          "Alpha",
          "function",
          "export function Alpha(): number {\n  return 1;\n}",
        ),
        createEditor(
          "src/new.ts",
          "Beta",
          "function",
          "export function Beta(): number {\n  return 2;\n}",
        ),
      ),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "add the Alpha declaration",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const created = readFileSync(join(dir, "src", "new.ts"), "utf8");
    expect(created.indexOf("export function Alpha")).toBeLessThan(
      created.indexOf("export function Beta"),
    );
    expect(result.records.some((record) => record.cause === "multi-duplicate")).toBe(false);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("a multi-file edit-dsl reply is all-or-none across files", async () => {
    const dir = multiFixtureDir();
    const originalA = readFileSync(join(dir, "src", "a.ts"), "utf8");
    const originalB = readFileSync(join(dir, "src", "b.ts"), "utf8");
    let afterFailure = "";
    const provider = new ScriptedProvider(
      [
        editDslSelect("one", "src/a.ts"),
        editDslReply(
          // The `a.ts` clause would pass on its own; `b.ts` fails its matcher,
          // so the apply phase must discard `a.ts`'s returned write too.
          {
            locator: { path: "src/a.ts", name: "one", kind: "function" },
            space: null,
            matcher: { kind: "snippet", value: "return 1;" },
            pick: null,
            replacement: "return 2;",
          },
          {
            locator: { path: "src/b.ts", name: "two", kind: "function" },
            space: null,
            matcher: { kind: "snippet", value: "return 999;" },
            pick: null,
            replacement: "return 3;",
          },
        ),
        editDslReply(
          {
            locator: { path: "src/a.ts", name: "one", kind: "function" },
            space: null,
            matcher: { kind: "snippet", value: "return 1;" },
            pick: null,
            replacement: "return 2;",
          },
          {
            locator: { path: "src/b.ts", name: "two", kind: "function" },
            space: null,
            matcher: { kind: "snippet", value: "return 1;" },
            pick: null,
            replacement: "return 3;",
          },
        ),
        "Great! I resolve this problem!",
      ],
      (callIndex) => {
        if (callIndex === 2) {
          afterFailure = `${readFileSync(join(dir, "src", "a.ts"), "utf8")}\n${readFileSync(join(dir, "src", "b.ts"), "utf8")}`;
        }
      },
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make both declarations satisfy the pair test",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(afterFailure).toBe(`${originalA}\n${originalB}`);
    expect(readFileSync(join(dir, "src", "a.ts"), "utf8")).toContain("return 2;");
    expect(readFileSync(join(dir, "src", "b.ts"), "utf8")).toContain("return 3;");
    const rejected = result.records.find(
      (record) => record.kind === "exchange" && record.outcome === "matcher",
    );
    expect(rejected?.diagnostics).toContain("clause 2 of 2");
    expect(rejected?.diagnostics).toContain("the whole edit-dsl reply is discarded");
    expect(rejected?.diagnostics).not.toContain("already applied (do not resend):");
    expect(result.warnings).toBeUndefined();
  }, 30000);

  test("a multi-file edit-dsl reply applies the valid file and ignores an inert no-op file", async () => {
    const dir = multiFixtureDir();
    const originalB = readFileSync(join(dir, "src", "b.ts"), "utf8");
    let afterInert = "";
    const provider = new ScriptedProvider(
      [
        editDslSelect("one", "src/a.ts"),
        editDslReply(
          {
            locator: { path: "src/a.ts", name: "one", kind: "function" },
            space: null,
            matcher: { kind: "snippet", value: "return 1;" },
            pick: null,
            replacement: "return 2;",
          },
          {
            locator: { path: "src/b.ts", name: "two", kind: "function" },
            space: null,
            matcher: { kind: "snippet", value: "return 1;" },
            pick: null,
            replacement: "return 1;",
          },
        ),
        // `a.ts` already applied; only the remaining real edit is resent.
        editDslReply({
          locator: { path: "src/b.ts", name: "two", kind: "function" },
          space: null,
          matcher: { kind: "snippet", value: "return 1;" },
          pick: null,
          replacement: "return 3;",
        }),
        "Great! I resolve this problem!",
      ],
      (callIndex) => {
        if (callIndex === 2) {
          afterInert = readFileSync(join(dir, "src", "b.ts"), "utf8");
        }
      },
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make both declarations satisfy the pair test",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    // The inert `b.ts` clause did not discard the applied `a.ts` write.
    expect(afterInert).toBe(originalB);
    expect(readFileSync(join(dir, "src", "a.ts"), "utf8")).toContain("return 2;");
    expect(readFileSync(join(dir, "src", "b.ts"), "utf8")).toContain("return 3;");
    expect(result.warnings).toEqual([
      "ignored 1 inert edit-dsl clause whose replacement was identical to the selected text; do not resend it",
    ]);
    expect(result.records.some((record) => record.outcome === "no-op")).toBe(false);
    const applied = result.records.find(
      (record) => record.kind === "exchange" && record.outcome === "applied",
    );
    expect(applied?.payloads).toBe(2);
    expect(applied?.stages).toEqual(["match"]);
  }, 30000);

  test("a mixed viewer+editor reply on one declaration is a duplicate and carries viewer feedback", async () => {
    const dir = fixtureDir();
    const original = helperSource(dir);
    let afterFailure = "";
    const provider = new ScriptedProvider(
      [
        editDslSelect("answer", "src/helper.ts", "value"),
        editDslReply(
          answerEditor(null, { kind: "snippet", value: "return 1;" }),
          answerEditor("return 2;", { kind: "snippet", value: "return 9;" }),
        ),
        editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
        "Great! I resolve this problem!",
      ],
      (callIndex) => {
        if (callIndex === 2) {
          afterFailure = helperSource(dir);
        }
      },
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(afterFailure).toBe(original);
    expect(helperSource(dir)).toContain("return 2;");
    const rejected = result.records.find(
      (record) => record.kind === "exchange" && record.outcome === "duplicate",
    );
    expect(rejected?.diagnostics).toContain("stage: duplicate");
    expect(rejected?.diagnostics).toContain(
      'clause 1 and clause 2 both select the same function "answer" in "src/helper.ts"',
    );
    expect(rejected?.diagnostics).toContain("the whole edit-dsl reply is discarded");
    expect(rejected?.diagnostics).toContain("Located occurrences");
  }, 30000);

  test("with the edit-dsl format the create prompts teach the edit-dsl create form", () => {
    const addressJson = '{"path":"src/new.ts","symbol":"make","kind":"function"}';
    const create = buildCreatePrompt(addressJson, "src/new.ts");
    expect(create).toContain("A reply is one or more `select … end` clauses");
    expect(create).toContain("does not take `match` or `pick`");
    expect(create).toContain("An implicit create remains available");
    expect(create).toContain("create [static] <kind> <name> in <path>");
    expect(create).toContain("a dotted create never creates its owner");
    expect(create).toContain("select function f in src/x.ts");
    expect(create).not.toContain("Output ONE flat JSON object");
    const retry = buildRetryPrompt({
      exchangeNumber: 2,
      mode: "create",
      currentSource: "",
      diagnostics: "boom",
      failure: "verification",
    });
    expect(retry).toContain("does not take `match` or `pick`");
    expect(retry).toContain("select function f in src/x.ts");
    expect(retry).not.toContain(
      'Output ONLY one flat JSON object {"path": ..., "symbol": ..., "kind": ..., "replacement": ...}',
    );
  });

  test("a first-turn write command pins the file and verifies", async () => {
    const dir = fixtureDir();
    const body = "export function answer(): number {\n  return 2;\n}";
    const provider = new ScriptedProvider([
      ["write src/helper.ts with", "<<<TC_EDIT_BEGIN>>>", body, "<<<TC_EDIT_END>>>"].join("\n"),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.filePath).toBe("src/helper.ts");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("a first-turn read command returns details before the next write", async () => {
    const dir = fixtureDir();
    const body = "export function answer(): number {\n  return 2;\n}";
    const provider = new ScriptedProvider([
      "read src/helper.ts end",
      ["write src/helper.ts with", "<<<TC_EDIT_BEGIN>>>", body, "<<<TC_EDIT_END>>>"].join("\n"),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(helperSource(dir)).toContain("return 2;");
    const readCall = provider.calls.find((call) =>
      call.some((message) => message.content?.includes("Read results") === true),
    );
    expect(readCall).toBeDefined();
  }, 30000);

  test("a content-turn write command replaces the pinned file", async () => {
    const dir = fixtureDir();
    const body = "export function answer(): number {\n  return 2;\n}";
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      ["write src/helper.ts with", "<<<TC_EDIT_BEGIN>>>", body, "<<<TC_EDIT_END>>>"].join("\n"),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("a reply can create one file and write another atomically", async () => {
    const dir = fixtureDir();
    const body = "export function answer(): number {\n  return 2;\n}";
    const provider = new ScriptedProvider([
      [
        "create src/new.ts end",
        "write src/helper.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        body,
        "<<<TC_EDIT_END>>>",
      ].join("\n"),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, "src", "new.ts"))).toBe(true);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("a delete command removes the file before the next write", async () => {
    const dir = fixtureDir();
    writeFileSync(join(dir, "src", "extra.ts"), "export const extra = 1;\n");
    const body = "export function answer(): number {\n  return 2;\n}";
    const provider = new ScriptedProvider([
      "delete src/extra.ts end",
      ["write src/helper.ts with", "<<<TC_EDIT_BEGIN>>>", body, "<<<TC_EDIT_END>>>"].join("\n"),
      "Great! I resolve this problem!",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, "src", "extra.ts"))).toBe(false);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("under edit-dsl an undeclared whole-declaration clause creates the file", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("extra", "src/extra.ts"),
      editDslReply(
        createEditor(
          "src/extra.ts",
          "extra",
          "function",
          "export function extra(): number {\n  return 1;\n}",
        ),
      ),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "add an extra declaration",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    // The create appended to a file that did not exist, creating src/extra.ts.
    const created = readFileSync(join(dir, "src", "extra.ts"), "utf8");
    expect(created).toContain("export function extra");
    expect(created).toContain("return 1;");
    expect(helperSource(dir)).toContain("return 2;");
    const applied = result.records.find((record) => record.outcome === "applied");
    // The create resolves at the whole-symbol stage with no matcher, and the
    // #110 instrumentation counts it as a create clause.
    expect(applied?.stages).toEqual(["whole-symbol"]);
    expect(applied?.matcherKinds).toEqual([null]);
    expect(applied?.creates).toBe(1);
  }, 30000);

  test("under edit-dsl a pick-only multi-range applies every picked range", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  if (Date.now() > 0) return 1;\n  return 1;\n}\n",
    );
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      editDslReply(
        answerEditor("  return 2;", null, [
          { line: 2, column: 1, endLine: 2, endColumn: END_OF_LINE_COLUMN },
          { line: 3, column: 1, endLine: 3, endColumn: END_OF_LINE_COLUMN },
        ]),
      ),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const source = helperSource(dir);
    expect(source).not.toContain("return 1;");
    expect(source.match(/return 2;/g)).toHaveLength(2);
    const applied = result.records.find((record) => record.outcome === "applied");
    expect(applied?.stages).toEqual(["pick", "pick"]);
    expect(applied?.creates).toBe(0);
  }, 30000);

  test("under edit-dsl a missing symbol with a match still creates (match is ignored)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("extra", "src/extra.ts"),
      editDslReply({
        ...createEditor(
          "src/extra.ts",
          "extra",
          "function",
          "export function extra(): number {\n  return 1;\n}",
        ),
        matcher: { kind: "snippet", value: "return 1;" },
      }),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "add an extra declaration",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "extra.ts"), "utf8")).toContain("export function extra");
    expect(helperSource(dir)).toContain("return 2;");
    const applied = result.records.find((record) => record.outcome === "applied");
    expect(applied?.creates).toBe(1);
  }, 30000);

  test("under edit-dsl a resolve type create appends a type alias", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("Extra", "src/types.ts"),
      editDslReply(createEditor("src/types.ts", "Extra", "type", "{ n: number }", "type")),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "add an extra type",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "types.ts"), "utf8")).toBe(
      "type Extra = { n: number };\n",
    );
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("under edit-dsl a no-kind undeclared clause still creates", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("extra", "src/extra.ts"),
      editDslReply(
        // No `kind`: `select extra in src/extra.ts` must still create.
        createEditor(
          "src/extra.ts",
          "extra",
          "",
          "export function extra(): number {\n  return 1;\n}",
        ),
      ),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "add an extra declaration",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "extra.ts"), "utf8")).toContain("export function extra");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("under edit-dsl a resolve space miss creates in the requested space", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "type"),
      editDslReply(
        // `answer` is a value-space function; `resolve type` is a space miss,
        // so the body is wrapped as a type alias in the requested space.
        createEditor("src/helper.ts", "answer", "function", "42", "type"),
      ),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(helperSource(dir)).toContain("type answer = 42;");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("under edit-dsl a no-resolve body creates a let binding in a new parent directory", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("extra", "src/deep/new.ts"),
      editDslReply(createEditor("src/deep/new.ts", "extra", "", "42")),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "add an extra declaration",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const created = readFileSync(join(dir, "src", "deep", "new.ts"), "utf8");
    expect(created).toBe("let extra = 42;\n");
  }, 30000);

  test("under edit-dsl a create that duplicates an existing declaration is rejected", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("missing", "src/helper.ts"),
      editDslReply(
        createEditor(
          "src/helper.ts",
          "missing",
          "function",
          "export function missing(): number {\n  return 1;\n}\nexport function answer(): number {\n  return 2;\n}",
        ),
      ),
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const rejected = result.records.find(
      (record) => record.kind === "exchange" && record.outcome === "duplicate",
    );
    expect(rejected).toBeDefined();
    expect(rejected?.diagnostics).toContain("stage: duplicate");
    expect(rejected?.diagnostics).toContain("answer");
  }, 30000);

  test("under edit-dsl a failing create reply creates no file and the retry resends both", async () => {
    const dir = fixtureDir();
    const originalHelper = helperSource(dir);
    let extraAfterFailure: string | null = null;
    let helperAfterFailure = "";
    const provider = new ScriptedProvider(
      [
        editDslSelect("extra", "src/extra.ts"),
        editDslReply(
          // Clause 1 would create a new file; clause 2 is a kind miss on an
          // existing value-space name, so the whole reply must be discarded.
          createEditor(
            "src/extra.ts",
            "extra",
            "function",
            "export function extra(): number {\n  return 1;\n}",
          ),
          {
            locator: { path: "src/helper.ts", name: "answer", kind: "const" },
            space: null,
            matcher: { kind: "snippet", value: "return 1;" },
            pick: null,
            replacement: "return 5;",
          },
        ),
        editDslReply(
          createEditor(
            "src/extra.ts",
            "extra",
            "function",
            "export function extra(): number {\n  return 1;\n}",
          ),
          answerEditor("return 2;", { kind: "snippet", value: "return 1;" }),
        ),
        "Great! I resolve this problem!",
      ],
      (callIndex) => {
        if (callIndex === 2) {
          extraAfterFailure = existsSync(join(dir, "src", "extra.ts"))
            ? readFileSync(join(dir, "src", "extra.ts"), "utf8")
            : null;
          helperAfterFailure = helperSource(dir);
        }
      },
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    // The first reply wrote nothing: no create, no helper change.
    expect(extraAfterFailure).toBeNull();
    expect(helperAfterFailure).toBe(originalHelper);
    expect(readFileSync(join(dir, "src", "extra.ts"), "utf8")).toContain("export function extra");
    expect(helperSource(dir)).toContain("return 2;");
    const rejected = result.records.find(
      (record) => record.kind === "exchange" && record.outcome === "address",
    );
    expect(rejected).toBeDefined();
    expect(rejected?.diagnostics).toContain("clause 2 of 2");
    expect(rejected?.diagnostics).toContain("the whole edit-dsl reply is discarded");
    expect(rejected?.diagnostics).not.toContain("created (do not resend):");
  }, 30000);

  test("under edit-dsl the system prompt teaches select … end and drops the JSON edit rule", () => {
    const prompt = buildSystemPrompt();
    // The edit-dsl edit rule and its create/delete semantics replace the JSON rule.
    expect(prompt).toContain("`select <symbol> in <path> [ resolve <value|type|namespace> ]");
    expect(prompt).toContain("open the body with `<<<TC_EDIT_BEGIN>>>`");
    expect(prompt).toContain("close it with `<<<TC_EDIT_END>>>`");
    expect(prompt).toContain(
      "a clause with neither `replace` nor `rename` is a viewer that locates and writes nothing unless it contains `pick`; `pick` requires `replace`",
    );
    expect(prompt).toContain("[ [ pick <range> ] replace with <fence> | rename <old> to <new> ]");
    expect(prompt).toContain("`rename <old> to <new>` renames the selected declaration");
    expect(prompt).toContain("renders the numbered declaration with `⁉️` on the matched lines");
    expect(prompt).not.toContain("select [kind]");
    expect(prompt).toContain(
      "A bare `select … replace with … end` with no `match` rewrites the whole declaration",
    );
    expect(prompt).toContain("an empty body deletes it");
    expect(prompt).toContain("no JSON edit payload");
    expect(prompt).toContain("naming it in the clause's own `select`");
    // #41: one declaration may be addressed at most once per reply, whatever
    // spans its clauses name.
    expect(prompt).toContain(
      "every clause in one reply must resolve to a different declaration `(path, symbol, kind)`",
    );
    expect(prompt).toContain("target one declaration at most once per reply");
    expect(prompt).toContain("split edits to one declaration across exchanges");
    // The pick turn is edit-dsl too: a select viewer leads to `# details`.
    expect(prompt).toContain(
      "First you will be asked to select the target or act on files directly. Reply with ONLY one `select <symbol> in <path>",
    );
    expect(prompt).toContain("`# details`");
    expect(prompt).not.toContain('{"mode": "modify", "path": ..., "symbol": ..., "kind": ...}');
    // The JSON edit rule and create/delete paragraphs are gone.
    expect(prompt).not.toContain(
      "Then you will be asked to edit the selected symbol. Reply with ONLY one flat JSON object",
    );
    expect(prompt).not.toContain(
      'A "create" selection asks for the COMPLETE declaration in "replacement"',
    );
    expect(prompt).not.toContain('{"payloads": [{"path": ...');
  });

  test("under edit-dsl the edit prompt carries the expanded few-shot examples", () => {
    const edit = buildEditPrompt(
      '{"path":"src/a.ts","symbol":"make","kind":"function"}',
      "const x = 1;\n",
    );
    expect(edit).toContain("A reply is one or more `select … end` clauses");
    // The four pre-#117 forms remain.
    expect(edit).toContain("select function f in src/x.ts resolve value");
    expect(edit).toContain("select const MAX_TOKENS in src/x.ts");
    expect(edit).toContain("pick 2");
    expect(edit).toContain(`match ${TICK}return 1;${TICK}`);
    expect(edit).toContain("<<<TC_EDIT_BEGIN>>>\nreturn 2;\n<<<TC_EDIT_END>>>");
    expect(edit).toContain("select function clamp in src/x.ts");
    // #117 adds the create and the viewer-then-editor forms, labelled apart.
    expect(edit).toContain("5. Create:");
    expect(edit).toContain("select function make in src/new.ts");
    expect(edit).toContain("6. Viewer then editor:");
    // #41: the viewer and editor clauses target different declarations, so the
    // example never teaches the duplicate-address rejection.
    const viewerThenEditor = edit.slice(
      edit.indexOf("6. Viewer then editor:"),
      edit.indexOf("7. Folded view:"),
    );
    expect(viewerThenEditor).toContain("select function parse in src/x.ts");
    expect(viewerThenEditor).toContain("select function format in src/x.ts");
    expect(viewerThenEditor).toContain("match `return null;`");
    expect(viewerThenEditor).toContain("<<<TC_EDIT_BEGIN>>>\nreturn undefined;\n<<<TC_EDIT_END>>>");
    expect(viewerThenEditor).toContain("end");
    expect(viewerThenEditor.match(/select function parse in src\/x\.ts/g)).toHaveLength(1);
    // The four base forms, create, and viewer-then-editor remain; the extra
    // per-action examples live in the on-demand format help instead.
    expect(edit).not.toContain("9. Rename:");
    expect(edit).not.toContain("10. Delete:");
    // The examples are bare blocks, not wrapped in one outer markdown fence.
    expect(edit).not.toContain("```````");
    expect(edit).toContain("End of examples.");
    // #41: no legacy edit fences, and the write form stops at the sentinel.
    expect(edit).not.toMatch(/^-{5,}$/m);
    expect(edit).not.toMatch(/^`{6,}$/m);
    const writeExample = edit.slice(
      edit.indexOf("8. Whole-file repair:"),
      edit.indexOf("9. Kind-aware create:"),
    );
    expect(writeExample.trimEnd().endsWith("<<<TC_EDIT_END>>>")).toBe(true);
    expect(writeExample).not.toMatch(/\b(done|end)\b/);
  });

  test("under edit-dsl a JSON edit payload is a protocol rejection and an edit-dsl reply is accepted", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      // A structurally valid JSON edit payload: edit-dsl rejects it outright.
      JSON.stringify({
        path: "src/helper.ts",
        symbol: "answer",
        kind: "function",
        matcher: "return 1;",
        replacement: "return 2;",
      }),
      // The required edit-dsl form lands on the next exchange.
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(helperSource(dir)).toContain("return 2;");
    // The system prompt the run sent teaches the edit-dsl form (call-site wiring).
    const system = provider.calls[0]?.[0]?.content ?? "";
    expect(system).toContain("select <symbol> in <path>");
    expect(system).not.toContain(
      "Then you will be asked to edit the selected symbol. Reply with ONLY one flat JSON object",
    );
    // The JSON payload is the rejected protocol exchange; the edit-dsl reply applies.
    const rejected = result.records.find((record) => record.outcome === "protocol");
    expect(rejected?.diagnostics).toContain("stage: protocol");
    expect(rejected?.diagnostics).toContain("select … end");
    expect(rejected?.diagnostics).toContain("JSON edit payload is not accepted");
    const applied = result.records.find((record) => record.outcome === "applied");
    expect(applied?.stages).toEqual(["match"]);
  }, 30000);

  test("under edit-dsl a malformed reply is a protocol rejection (no JSON fallback)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      "not a clause and not JSON",
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const rejected = result.records.find((record) => record.outcome === "protocol");
    expect(rejected?.diagnostics).toContain("stage: syntax");
    expect(rejected?.diagnostics).toContain("expected `select`");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("under edit-dsl a mid-clause missing `end` reports the syntax error, not JSON", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      editDslSelect("answer", "src/helper.ts", "value"),
      "select answer in src/helper.ts resolve value\nnonsense",
      editDslReply(answerEditor("return 2;", { kind: "snippet", value: "return 1;" })),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const rejected = result.records.find((record) => record.outcome === "protocol");
    expect(rejected?.diagnostics).toContain("stage: syntax");
    expect(rejected?.diagnostics).toContain("expected `end`");
    expect(rejected?.diagnostics).not.toContain("JSON edit payload");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);
});

// A parseable file large enough (> SPEC_FILE_LIMIT / 2) that mixes a type alias,
// an interface, many filler functions, and the two value declarations a
// diagnostic could name.
function shrinkFixtureSource(): string {
  const parts = [
    "export type LispValue = number | string | LispValue[] | null;",
    "export interface Env {\n  vars: string[];\n}",
  ];
  for (let i = 0; i < 120; i += 1) {
    parts.push(`export function filler${i}(x: number): number {\n  return x + ${i};\n}`);
  }
  parts.push("export function isClosure(v: LispValue): boolean {\n  return Array.isArray(v);\n}");
  parts.push("export function other(): number {\n  return 0;\n}");
  parts.push("export const LAST = 1;");
  return `${parts.join("\n\n")}\n`;
}

describe("repair-context shrink", () => {
  const FLAG = "TC_REPAIR_CONTEXT_SHRINK";
  const previous = process.env[FLAG];
  afterEach(() => {
    if (previous === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = previous;
    }
  });

  function setFlag(value: string | undefined): void {
    if (value === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = value;
    }
  }

  const PATH = "src/lisp.ts";
  const source = shrinkFixtureSource();
  const diagnostics =
    "src/lisp.ts(520,3): error TS2322: Type 'string' is not assignable to type 'number' " +
    "— in declaration `isClosure` (function)\n" +
    "src/lisp.ts(523,3): error TS2322: Type 'string' is not assignable to type 'number' " +
    "— in declaration `other` (function)";

  test("the toggle defaults off and only on/1/true enable it", () => {
    for (const off of [undefined, "", "  ", "off", "0", "no", "false", "ONN"]) {
      setFlag(off);
      expect(repairContextShrinkEnabled()).toBe(false);
    }
    for (const on of ["on", "1", "true", "  ON ", "\tTrue\n"]) {
      setFlag(on);
      expect(repairContextShrinkEnabled()).toBe(true);
    }
  });

  test("keeps the pinned, diagnostic-named, and type-level declarations and omits the rest", () => {
    const shrunk = shrinkRepairSource(
      PATH,
      source,
      { path: PATH, name: "isClosure", kind: "function" },
      diagnostics,
    );
    expect(shrunk).not.toBeNull();
    const view = shrunk ?? "";
    // Pinned and diagnostic-named value declarations are kept.
    expect(view).toContain("function isClosure");
    expect(view).toContain("return Array.isArray(v);");
    expect(view).toContain("function other");
    // Every type-level declaration is kept even though the diagnostics never name it.
    expect(view).toContain("type LispValue = number | string");
    expect(view).toContain("interface Env");
    // The omitted declarations are named in the marker and their bodies are gone.
    expect(view).toContain("[omitted:");
    expect(view).toContain("filler0");
    expect(view).toContain("filler119");
    expect(view).not.toContain("return x + 50;");
    expect(view).not.toContain("export const LAST = 1;");
    // Not every gap carries a name (e.g. the blank line between two type decls).
    expect(view).toContain("[1 lines omitted]");
  });

  test("prefixes each kept declaration with its original 1-based file line number", () => {
    const shrunk = shrinkRepairSource(
      PATH,
      source,
      { path: PATH, name: "isClosure", kind: "function" },
      diagnostics,
    );
    expect(shrunk).not.toBeNull();
    const view = shrunk ?? "";
    // The pinned declaration's rendered first line must carry its real file line.
    const realLine = source.slice(0, source.indexOf("function isClosure")).split("\n").length;
    const rendered = view.split("\n").find((line) => line.includes("function isClosure")) ?? "";
    const extracted = Number(rendered.slice(0, rendered.indexOf(" | ")).trim());
    expect(extracted).toBe(realLine);
  });

  test("falls back to the whole file when the source does not parse or is small", () => {
    const locator = { path: PATH, name: "isClosure", kind: "function" };
    expect(shrinkRepairSource(PATH, "const x = 1;\n", locator, diagnostics)).toBeNull();
    // Over the size floor but unparseable.
    const broken = `export function broken( { ${"x".repeat(SPEC_FILE_LIMIT)}`;
    expect(shrinkRepairSource(PATH, broken, locator, diagnostics)).toBeNull();
  });

  test("still returns a view when the pin does not resolve but names and types exist", () => {
    const shrunk = shrinkRepairSource(
      PATH,
      source,
      { path: PATH, name: "doesNotExist", kind: "function" },
      diagnostics,
    );
    expect(shrunk).not.toBeNull();
    const view = shrunk ?? "";
    expect(view).toContain("function isClosure");
    expect(view).toContain("type LispValue");
    // The unresolved pin is not invented.
    expect(view).not.toContain("doesNotExist");
    // With no pin, no named declaration, and no type-level declaration, the
    // partial view would hide everything, so the whole file stands.
    const bare = `export const only = 1;\n${"// pad\n".repeat(SPEC_FILE_LIMIT / 4)}`;
    expect(
      shrinkRepairSource(PATH, bare, { path: PATH, name: "nope", kind: "function" }, "boom"),
    ).toBeNull();
  });

  test("with the toggle on a supplied pre-rendered block replaces the source and fixes the note", () => {
    const preRendered =
      " 12 | function isClosure(v: LispValue): boolean {\n// … [omitted: filler0] …";
    const prompt = buildRetryPrompt({
      exchangeNumber: 1,
      mode: "modify",
      currentSource: source,
      preRenderedSource: preRendered,
      diagnostics,
      failure: "verification",
    });
    expect(prompt).toContain(preRendered);
    // The whole-file bodies are not re-sent alongside the partial view.
    expect(prompt).not.toContain("return x + 50;");
  });

  test("buildRetryPrompt forwards the pre-rendered block", () => {
    const preRendered = "  1 | type LispValue = number;";
    const prompt = buildRetryPrompt({
      exchangeNumber: 1,
      mode: "modify",
      currentSource: source,
      preRenderedSource: preRendered,
      diagnostics,
      failure: "edit",
    });
    expect(prompt).toContain(preRendered);
    expect(prompt).not.toContain("return x + 50;");
  });

  test("a create→repair run shrinks the repair prompt only when the toggle is on", async () => {
    const makeAddress = { path: "src/generated.ts", symbol: "make", kind: "function" };
    const badReplacement = 'export function make(): number {\n  return "no";\n}';
    const runOnce = async (setting: string | undefined): Promise<string> => {
      setFlag(setting);
      const dir = passingFixtureDir();
      const large: string[] = ["export type LispValue = number | string | LispValue[] | null;"];
      for (let i = 0; i < 120; i += 1) {
        large.push(`export function filler${i}(x: number): number {\n  return x + ${i};\n}`);
      }
      writeFileSync(join(dir, "src", "generated.ts"), `${large.join("\n\n")}\n`);
      const provider = new ScriptedProvider([
        selectionResponse(makeAddress, "create"),
        createResponse(makeAddress, badReplacement),
        editResponse('return "no";', "return 7;", makeAddress),
      ]);
      const result = await runLoop({
        cwd: dir,
        issue: "create a generated module",
        provider,
        checkCommand: TSC,
        testCommand: ["bun", "test"],
      });
      expect(result.ok).toBe(true);
      return provider.calls[2]?.at(-1)?.content ?? "";
    };

    const off = await runOnce(undefined);
    // Off: the kept file reaches the prompt (folded, but the pin is present).
    expect(off).toContain("function make");
    expect(off).not.toContain("[omitted:");

    const on = await runOnce("on");
    // On: the partial view drops the fillers and marks the omission.
    expect(on).toContain("[omitted:");
    expect(on).toContain("type LispValue = number | string");
    expect(on).toContain("function make");
    expect(on).not.toContain("return x + 119;");
  }, 60000);
});
