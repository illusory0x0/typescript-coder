import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { renderFailureArtifact } from "./failure-artifact";
import {
  buildContextYaml,
  buildContinuationPrompt,
  buildCreatePrompt,
  buildEditPrompt,
  buildRetryPrompt,
  buildSelectionContinuationPrompt,
  buildSelectionRetryPrompt,
  buildSummaryPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  classifyRejection,
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
  MAX_EDIT_EXCHANGES,
  MAX_RUN_ITERATIONS,
  MAX_STALLED_ROUNDS,
  MULTI_PAYLOAD_KEY,
  numberedSourceBlock,
  parseEditResponse,
  parseEditResponseList,
  parseSelectionResponse,
  parseSelfCheckRequest,
  rejectionLead,
  rejectionPolicy,
  renderAttemptDigest,
  renderFailureHistoryNote,
  renderSelfCheckCommand,
  renderSelfCheckRead,
  resolveEditRange,
  runLoop,
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
import { Parser } from "./parser";
import { buildIndexTolerant } from "./utility";
import type { SourceFile } from "./utility";

const tempDirs: string[] = [];

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

  test("returns short diagnostics unchanged", () => {
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
    expect(result).toBe("stage: tsc\nreplacement line 1: boom\n  1 | const a = 1;");
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
  test("buildSystemPrompt returns a stable string", () => {
    expect(buildSystemPrompt()).toBe(buildSystemPrompt());
    expect(buildSystemPrompt()).toContain(
      '{"mode": "modify", "path": ..., "symbol": ..., "kind": ...}',
    );
    expect(buildSystemPrompt()).toContain(
      '{"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}',
    );
    expect(buildSystemPrompt()).toContain('"mode" is "modify" (default), "create", or "delete"');
    expect(buildSystemPrompt()).toContain("At most one matcher or range per response");
    expect(buildSystemPrompt()).toContain('"range" {line, column, endLine, endColumn}');
    expect(buildSystemPrompt()).toContain("No markdown fences and no explanations");
    // The two-step framing is load-bearing: the first live request is the
    // selection, and dropping the framing made the model answer it with an
    // edit-shaped payload (#55 revert).
    expect(buildSystemPrompt()).toContain("First you will be asked to select the target");
    expect(buildSystemPrompt()).toContain("Then you will be asked to edit the selected symbol");
  });

  test("buildSystemPrompt describes create and delete modes", () => {
    expect(buildSystemPrompt()).toContain('A "create" selection asks for the COMPLETE declaration');
    expect(buildSystemPrompt()).toContain('A "delete" selection carries no edit payload');
    expect(buildSystemPrompt()).toContain("The syntax gate discards any edit");
  });

  test("buildUserPrompt contains the issue and a yaml fence", () => {
    const context = buildContextYaml([{ path: "src/a.ts", source: "export const a = 1;\n" }]);
    const prompt = buildUserPrompt("fix the failing test", context);
    expect(prompt).toContain("# Issue");
    expect(prompt).toContain("fix the failing test");
    expect(prompt).toContain("# Project context");
    expect(prompt).toContain("```yaml");
    expect(prompt).toContain(context);
  });

  test("buildUserPrompt appends spec file paths and bodies when given", () => {
    const context = buildContextYaml([{ path: "src/a.test.ts", source: "test();\n" }]);
    const specFiles: SourceFile[] = [
      { path: "src/a.test.ts", source: "expect(answer()).toBe(2);\n" },
    ];
    const prompt = buildUserPrompt("fix the failing test", context, specFiles);
    expect(prompt).toContain("# Project context");
    expect(prompt).toContain("# Spec files");
    expect(prompt).toContain("part of the specification; do not modify them");
    expect(prompt).toContain("## src/a.test.ts");
    expect(prompt).toContain("expect(answer()).toBe(2);");
    expect(prompt).toContain("```ts");
  });

  test("buildUserPrompt omits the spec section when no spec files are given", () => {
    const context = "files:\n";
    expect(buildUserPrompt("fix the failing test", context)).not.toContain("# Spec files");
    expect(buildUserPrompt("fix the failing test", context, [])).toBe(
      buildUserPrompt("fix the failing test", context),
    );
  });

  test("buildUserPrompt truncates an oversized spec file with an explicit marker", () => {
    const source = `${"h".repeat(5000)}${"z".repeat(1000)}${"t".repeat(5000)}`;
    const prompt = buildUserPrompt("issue", "files:\n", [{ path: "src/big.test.ts", source }]);
    expect(prompt).toContain("h".repeat(4000));
    expect(prompt).toContain("t".repeat(4000));
    expect(prompt).not.toContain("z");
    expect(prompt).toContain(`// ... [truncated ${source.length - 8000} characters] ...`);
    const section = prompt.slice(prompt.indexOf("## src/big.test.ts"));
    expect(section.length).toBeLessThan(8300);
  });

  test("buildUserPrompt widens the fence when a spec body contains a fence line", () => {
    const source = 'const marker = "```";\n```ts\nconst x = 1;\n```\n';
    const prompt = buildUserPrompt("issue", "files:\n", [{ path: "src/fence.test.ts", source }]);
    expect(prompt).toContain("````ts");
    expect(prompt).toContain("const x = 1;");
  });

  test("buildEditPrompt contains the pinned address and the symbol source", () => {
    const addressJson = '{"path":"src/a.ts","symbol":"make","kind":"function"}';
    const symbolSource = "export function make(): number {\n  return 1;\n}\n";
    const prompt = buildEditPrompt(addressJson, symbolSource);
    expect(prompt).toContain(
      '{"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}',
    );
    expect(prompt).toContain('Omit "matcher" for a whole-symbol rewrite');
    expect(prompt).toContain("Pinned selection:");
    expect(prompt).toContain(addressJson);
    expect(prompt).toContain("Current source:");
    expect(prompt).toContain("1 | export function make(): number {");
    expect(prompt).toContain("2 |   return 1;");
    expect(prompt).toContain("3 | }");
    expect(prompt).toContain('"range"');
    expect(prompt).toContain("```ts");
  });

  test("buildCreatePrompt asks for the complete declaration and notes the file may be missing", () => {
    const addressJson = '{"path":"src/new.ts","symbol":"make","kind":"function"}';
    const prompt = buildCreatePrompt(addressJson, "src/new.ts");
    expect(prompt).toContain('mode "create"');
    expect(prompt).toContain(addressJson);
    expect(prompt).toContain("src/new.ts");
    expect(prompt).toContain("may not exist yet");
    expect(prompt).toContain("COMPLETE declaration");
    expect(prompt).toContain('omit "matcher"');
  });

  test("buildRetryPrompt reports the exchange, current source, and diagnostics", () => {
    const locatorJson = '{"mode":"modify","path":"src/a.ts","symbol":"make","kind":"function"}';
    const currentSource = 'export function make(): number {\n  return "nope";\n}';
    const diagnostics = "src/a.ts(2,3): error TS2322: Type 'string' is not assignable";
    const prompt = buildRetryPrompt({
      exchangeNumber: 2,
      maxExchanges: 3,
      mode: "modify",
      locatorJson,
      currentSource,
      diagnostics,
      failure: "verification",
      repin: true,
    });
    expect(prompt).toContain("Edit exchange 2 of 3 failed verification.");
    expect(prompt).toContain("1 exchange(s) remain in this iteration");
    expect(prompt).toContain("Make minimal corrective changes to the current source");
    expect(prompt).toContain("one flat JSON object");
    expect(prompt).toContain("omit it for a whole-symbol rewrite");
    expect(prompt).toContain("No markdown fences and no explanations");
    // A repair round may re-pin and tolerates a leading export modifier.
    expect(prompt).toContain(
      "either the pinned selection or a different declaration in the same file",
    );
    expect(prompt).toContain(
      "A leading `export` matching the declaration's existing modifier is accepted",
    );
    expect(prompt).toContain("```json");
    expect(prompt).toContain(locatorJson);
    expect(prompt).toContain("```ts");
    expect(prompt).toContain("1 | export function make(): number {");
    expect(prompt).toContain('2 |   return "nope";');
    expect(prompt).toContain("3 | }");
    expect(prompt).toContain(diagnostics);
  });

  test("buildRetryPrompt describes the create contract and edit-stage failures", () => {
    const locatorJson = '{"mode":"create","path":"src/a.ts","symbol":"make","kind":"function"}';
    const currentSource = "";
    const diagnostics = 'stage: protocol\nmode "create" does not take a "matcher"';
    const prompt = buildRetryPrompt({
      exchangeNumber: 1,
      maxExchanges: 3,
      mode: "create",
      locatorJson,
      currentSource,
      diagnostics,
      failure: "edit",
      repin: false,
    });
    expect(prompt).toContain("Edit exchange 1 of 3 failed.");
    expect(prompt).not.toContain("failed verification");
    expect(prompt).toContain("COMPLETE corrected declaration");
    expect(prompt).toContain("No markdown fences and no explanations");
    expect(prompt).toContain(currentSource);
    expect(prompt).toContain(diagnostics);
  });

  test("buildRetryPrompt replaces the lead with the per-cause correction (#56)", () => {
    const locatorJson = '{"mode":"modify","path":"src/a.ts","symbol":"make","kind":"function"}';
    const currentSource = "export function make(): number {\n  return 1;\n}";
    const diagnostics = "stage: matcher\nthe matcher was not found";
    const prompt = buildRetryPrompt({
      exchangeNumber: 2,
      maxExchanges: 3,
      mode: "modify",
      locatorJson,
      currentSource,
      diagnostics,
      failure: "edit",
      repin: false,
      correction: "Copy the matcher verbatim from the current source.",
    });
    expect(prompt).toContain("Copy the matcher verbatim from the current source.");
    expect(prompt).not.toContain("Make minimal corrective changes to the current source");

    // The no-progress ask (#54) still wins over the correction.
    const stalled = buildRetryPrompt({
      exchangeNumber: 1,
      maxExchanges: 3,
      mode: "modify",
      locatorJson,
      currentSource,
      diagnostics,
      failure: "edit",
      repin: false,
      correction: "Copy the matcher verbatim from the current source.",
      stalled: { failedRounds: 8, round: 2, maxRounds: 32 },
    });
    expect(stalled).toContain("Concretely: change the matcher shape");
    expect(stalled).not.toContain("Copy the matcher verbatim from the current source.");

    // Create mode takes the same override in place of its own default lead.
    const create = buildRetryPrompt({
      exchangeNumber: 2,
      maxExchanges: 3,
      mode: "create",
      locatorJson: '{"mode":"create","path":"src/a.ts","symbol":"make","kind":"function"}',
      currentSource: "",
      diagnostics,
      failure: "edit",
      repin: false,
      correction: "Emit a shorter, more compact replacement.",
    });
    expect(create).toContain("Emit a shorter, more compact replacement.");
    expect(create).not.toContain("Make minimal corrective changes to the complete declaration");
  });

  test("buildSummaryPrompt demands the four labeled sections and includes diagnostics when present", () => {
    const prompt = buildSummaryPrompt(
      "edit-exhausted",
      "stage: protocol\nno JSON object found in the response",
    );
    expect(prompt).toContain(
      "The run is over: the edit budget was exhausted without a valid edit.",
    );
    expect(prompt).toContain("Diagnostics:");
    expect(prompt).toContain("stage: protocol");
    // The wrap-up turn (#58) demands fixed labeled sections, never prose.
    expect(prompt).toContain("- Accomplished:");
    expect(prompt).toContain("- Failed and why:");
    expect(prompt).toContain("- Remaining:");
    expect(prompt).toContain("- Next step:");
    expect(prompt).toContain("Do not output code.");
    // The v1 "one short paragraph" ask is gone.
    expect(prompt).not.toContain("one short paragraph");

    const bare = buildSummaryPrompt("token-budget", null);
    expect(bare).toContain("the token budget was exceeded");
    expect(bare).not.toContain("Diagnostics:");
    expect(bare).toContain("- Accomplished:");
    expect(bare).toContain("- Next step:");

    // Every reason — provider errors included — carries the identical wrap-up
    // block: only the first line names the reason.
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

  test("buildSelectionRetryPrompt asks for a corrected selection without matcher wording", () => {
    const diagnostics = 'stage: address\nno symbol with kind "function" named "answer"';
    const prompt = buildSelectionRetryPrompt(diagnostics);
    expect(prompt).toContain("selection was rejected");
    expect(prompt).toContain(diagnostics);
    expect(prompt).toContain("```");
    expect(prompt).toContain("no markdown fences");
    expect(prompt).toContain("corrected selection JSON object");
    expect(prompt.toLowerCase()).not.toContain("replacement");
    expect(prompt.toLowerCase()).not.toContain("matcher");
  });

  test("the digest is appended after the diagnostics only when passed (#57)", () => {
    const locatorJson = '{"mode":"modify","path":"src/a.ts","symbol":"make","kind":"function"}';
    const diagnostics = "stage: matcher\nthe matcher was not found";
    const input = {
      exchangeNumber: 1,
      maxExchanges: 3,
      mode: "modify" as const,
      locatorJson,
      currentSource: "export function make(): number {\n  return 1;\n}",
      diagnostics,
      failure: "edit" as const,
      repin: false,
    };
    const digest = "Prior attempts (1):\n- #1 matcher-not-found: the matcher was not found";
    const bare = buildRetryPrompt(input);
    expect(bare).not.toContain("Prior attempts");
    const withDigest = buildRetryPrompt({ ...input, digest });
    const diagnosticsAt = withDigest.indexOf("Diagnostics:");
    expect(diagnosticsAt).toBeGreaterThan(-1);
    expect(withDigest.indexOf("Prior attempts")).toBeGreaterThan(diagnosticsAt);
    expect(withDigest).toContain(digest);
    // The continuation builder forwards the digest too.
    const continuation = buildContinuationPrompt({
      round: 1,
      maxRounds: 32,
      mode: "modify",
      locatorJson,
      currentSource: input.currentSource,
      diagnostics,
      repin: false,
      digest,
    });
    expect(continuation).toContain(digest);
    expect(continuation.indexOf("Prior attempts")).toBeGreaterThan(
      continuation.indexOf("Diagnostics:"),
    );
    const selection = buildSelectionContinuationPrompt({
      round: 1,
      maxRounds: 32,
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
      `Ruled out after ${records.length} repeats: matcher-not-found — This attempt MUST omit "matcher" and return the complete declaration in "replacement".`,
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
      'Ruled out after 4 repeats: matcher-not-found — This attempt MUST omit "matcher" and return the complete declaration in "replacement".',
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
      maxExchanges: 3,
      mode: "modify" as const,
      locatorJson: '{"mode":"modify","path":"src/a.ts","symbol":"make","kind":"function"}',
      currentSource: "export function make(): number {\n  return 1;\n}",
      diagnostics: diagnosticsA,
      failure: "verification" as const,
      repin: false,
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
    // The #52 continuation builders forward the note too.
    const continuation = buildContinuationPrompt({
      round: 1,
      maxRounds: 32,
      mode: "modify",
      locatorJson: input.locatorJson,
      currentSource: input.currentSource,
      diagnostics: input.diagnostics,
      repin: false,
      failureHistory: note,
    });
    expect(continuation).toContain(note);
    const selection = buildSelectionContinuationPrompt({
      round: 1,
      maxRounds: 32,
      diagnostics: input.diagnostics,
      failureHistory: note,
    });
    expect(selection).toContain(note);
    expect(
      buildSelectionContinuationPrompt({
        round: 1,
        maxRounds: 32,
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

describe("parseSelectionResponse", () => {
  const expected =
    'expected {"mode":"modify"|"create"|"delete","path": ..., "symbol": ..., "kind": ...}';

  test("parses plain JSON, defaulting to modify", () => {
    expect(parseSelectionResponse('{"path":"src/a.ts","symbol":"make","kind":"function"}')).toEqual(
      {
        mode: "modify",
        locator: { path: "src/a.ts", name: "make", kind: "function" },
      },
    );
  });

  test("parses explicit modes and fenced JSON", () => {
    expect(
      parseSelectionResponse(
        '```json\n{"mode":"create","path":"a.ts","symbol":"x","kind":"class"}\n```',
      ),
    ).toEqual({ mode: "create", locator: { path: "a.ts", name: "x", kind: "class" } });
    expect(
      parseSelectionResponse('{"mode":"delete","path":"a.ts","symbol":"x","kind":"class"}').mode,
    ).toBe("delete");
  });

  test("tolerates prose around the object", () => {
    const content =
      'Here: {"mode":"modify","path":"a.ts","symbol":"x","kind":"function"} hope it helps';
    expect(parseSelectionResponse(content)).toEqual({
      mode: "modify",
      locator: { path: "a.ts", name: "x", kind: "function" },
    });
  });

  test("rejects missing, extra, or wrongly typed fields", () => {
    expect(() => parseSelectionResponse('{"path":"a.ts","symbol":"x"}')).toThrow(
      `"kind" must be a non-empty string`,
    );
    expect(() => parseSelectionResponse('{"path":1,"symbol":"x","kind":"function"}')).toThrow(
      expected,
    );
    expect(() =>
      parseSelectionResponse('{"path":"a.ts","symbol":"x","kind":"function","extra":1}'),
    ).toThrow('unexpected key(s) "extra"');
  });

  test("names the v1 field in the rename hint", () => {
    expect(() => parseSelectionResponse('{"path":"a.ts","name":"x","kind":"function"}')).toThrow(
      'the address field is "symbol" (renamed from "name")',
    );
  });

  test("rejects an unknown mode", () => {
    expect(() =>
      parseSelectionResponse('{"mode":"replace","path":"a.ts","symbol":"x","kind":"function"}'),
    ).toThrow('"mode" must be one of "modify", "create", "delete"');
  });

  test("rejects non-object JSON", () => {
    expect(() => parseSelectionResponse("not json")).toThrow(expected);
    expect(() => parseSelectionResponse("null")).toThrow("got a JSON value that is not an object");
    expect(() => parseSelectionResponse("[]")).toThrow("got a JSON value that is not an object");
  });
});

describe("parseEditResponse", () => {
  test("parses a flat payload with a matcher", () => {
    expect(
      parseEditResponse(
        '{"path":"src/a.ts","symbol":"make","kind":"function","matcher":"return 1;","replacement":"return 2;"}',
      ),
    ).toEqual({
      locator: { path: "src/a.ts", name: "make", kind: "function" },
      matcher: "return 1;",
      range: null,
      replacement: "return 2;",
    });
  });

  test("omits matcher for a whole-symbol rewrite and allows an empty replacement", () => {
    expect(
      parseEditResponse('{"path":"a.ts","symbol":"x","kind":"function","replacement":""}'),
    ).toEqual({
      locator: { path: "a.ts", name: "x", kind: "function" },
      matcher: null,
      range: null,
      replacement: "",
    });
  });

  test("tolerates fences and prose", () => {
    const content =
      'Sure:\n```json\n{"path":"a.ts","symbol":"x","kind":"function","replacement":"y"}\n```\nDone.';
    expect(parseEditResponse(content).replacement).toBe("y");
  });

  test("rejects an empty matcher and a missing replacement", () => {
    expect(() =>
      parseEditResponse(
        '{"path":"a.ts","symbol":"x","kind":"function","matcher":"","replacement":"y"}',
      ),
    ).toThrow('"matcher" must be a non-empty string when present');
    expect(() => parseEditResponse('{"path":"a.ts","symbol":"x","kind":"function"}')).toThrow(
      '"replacement" must be a string',
    );
  });

  test("accepts an optional range selector and defaults it to null", () => {
    expect(
      parseEditResponse(
        '{"path":"a.ts","symbol":"x","kind":"function","range":{"line":2,"column":3,"endLine":2,"endColumn":11},"replacement":"y"}',
      ),
    ).toEqual({
      locator: { path: "a.ts", name: "x", kind: "function" },
      matcher: null,
      range: { line: 2, column: 3, endLine: 2, endColumn: 11 },
      replacement: "y",
    });
  });

  test("rejects a malformed range as a protocol error", () => {
    const badRanges: unknown[] = [
      "nope",
      { line: 1, column: 1, endLine: 1 },
      { line: 0, column: 1, endLine: 1, endColumn: 1 },
      { line: 1, column: 1, endLine: 1, endColumn: 2.5 },
      { line: 1, column: 1, endLine: 1, endColumn: 1, extra: 1 },
    ];
    for (const range of badRanges) {
      const payload = JSON.stringify({
        path: "a.ts",
        symbol: "x",
        kind: "function",
        range,
        replacement: "y",
      });
      expect(() => parseEditResponse(payload)).toThrow(/range/);
    }
  });

  test("keeps both matcher and range when both are sent (range wins at resolution)", () => {
    const parsed = parseEditResponse(
      '{"path":"a.ts","symbol":"x","kind":"function","matcher":"return 1;","range":{"line":1,"column":1,"endLine":1,"endColumn":1},"replacement":"y"}',
    );
    expect(parsed.matcher).toBe("return 1;");
    expect(parsed.range).toEqual({ line: 1, column: 1, endLine: 1, endColumn: 1 });
  });

  test("names the v1 shapes in the hints", () => {
    expect(() =>
      parseEditResponse('{"path":"a.ts","name":"x","kind":"function","replacement":"y"}'),
    ).toThrow('the address field is "symbol" (renamed from "name")');
    expect(() =>
      parseEditResponse(
        '{"path":"a.ts","symbol":"x","kind":"function","replacement":"y","edits":[]}',
      ),
    ).toThrow('v2 carries one flat edit object, not an "edits" array');
  });

  test("rejects non-object JSON", () => {
    expect(() => parseEditResponse("")).toThrow("no JSON object found in the response");
    expect(() => parseEditResponse("[]")).toThrow("got a JSON value that is not an object");
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
    });
  });

  test("defaults a row's payloads and tool calls to zero when absent", () => {
    const stats = exchangeStats([row({ outcome: "applied", kind: "exchange" })]);
    expect(stats.payloads).toBe(0);
    expect(stats.toolCalls).toBe(0);
    expect(stats.applied).toBe(1);
  });
});

describe("parseEditResponseList (#69)", () => {
  test("treats a flat object as a classic single payload", () => {
    const parsed = parseEditResponseList(
      '{"path":"src/a.ts","symbol":"make","kind":"function","replacement":"y"}',
    );
    expect(parsed).toEqual({
      ok: true,
      batch: false,
      payloads: [
        {
          locator: { path: "src/a.ts", name: "make", kind: "function" },
          matcher: null,
          range: null,
          replacement: "y",
        },
      ],
    });
  });

  test("parses a path-independent batch and keeps entry order", () => {
    const parsed = parseEditResponseList(
      JSON.stringify({
        [MULTI_PAYLOAD_KEY]: [
          { path: "src/a.ts", symbol: "make", kind: "function", replacement: "1" },
          {
            path: "src/b.ts",
            symbol: "other",
            kind: "function",
            matcher: "return 1;",
            replacement: "2",
          },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.batch).toBe(true);
    expect(parsed.payloads.map((payload) => payload.locator.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(parsed.payloads[1]?.matcher).toBe("return 1;");
  });

  test("rejects a duplicate file across payloads as multi-duplicate", () => {
    const parsed = parseEditResponseList(
      JSON.stringify({
        [MULTI_PAYLOAD_KEY]: [
          { path: "src/a.ts", symbol: "make", kind: "function", replacement: "1" },
          { path: "src/a.ts", symbol: "other", kind: "function", replacement: "2" },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.cause).toBe("multi-duplicate");
    expect(parsed.diagnostics).toContain("at most one payload per file");
  });

  test("rejects an empty array, a non-array, and unexpected keys as multi-protocol", () => {
    for (const bad of [
      JSON.stringify({ [MULTI_PAYLOAD_KEY]: [] }),
      JSON.stringify({ [MULTI_PAYLOAD_KEY]: "nope" }),
      JSON.stringify({ [MULTI_PAYLOAD_KEY]: [], extra: 1 }),
    ]) {
      const parsed = parseEditResponseList(bad);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) {
        continue;
      }
      expect(parsed.cause).toBe("multi-protocol");
      expect(parsed.diagnostics.startsWith("stage: multi")).toBe(true);
    }
  });

  test("keeps the classic protocol cause when the reply is not JSON at all", () => {
    const parsed = parseEditResponseList("not json");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.cause).toBeNull();
    expect(parsed.diagnostics.startsWith("stage: protocol")).toBe(true);
  });
});

describe("edit range selector (#72)", () => {
  test("numberedSourceBlock prefixes 1-based line numbers", () => {
    expect(numberedSourceBlock("a\nb\n")).toBe("1 | a\n2 | b");
    expect(numberedSourceBlock("")).toBe("");
    const ten = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(numberedSourceBlock(`${ten}\n`)).toContain(" 9 | line 9\n10 | line 10");
  });

  test("resolveEditRange maps 1-based inclusive positions and rejects bad ranges", () => {
    const source = "function f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n";
    const limit = source.length - 1; // one past the final `}` (trailing newline excluded)
    const declaration = { start: 0, end: limit };

    const single = resolveEditRange(
      source,
      { line: 2, column: 3, endLine: 2, endColumn: 14 },
      0,
      limit,
      declaration,
    );
    expect(single.ok).toBe(true);
    if (single.ok) {
      expect(source.slice(single.start, single.end)).toBe("const a = 1;");
    }

    const multi = resolveEditRange(
      source,
      { line: 2, column: 3, endLine: 4, endColumn: 15 },
      0,
      limit,
      declaration,
    );
    expect(multi.ok).toBe(true);
    if (multi.ok) {
      expect(source.slice(multi.start, multi.end)).toBe(
        "const a = 1;\n  const b = 2;\n  return a + b;",
      );
    }

    // The start line does not exist in the shown block.
    expect(
      resolveEditRange(
        source,
        { line: 99, column: 1, endLine: 99, endColumn: 1 },
        0,
        limit,
        declaration,
      ),
    ).toMatchObject({ ok: false, reason: "out-of-bounds" });
    // The end column runs past the line.
    expect(
      resolveEditRange(
        source,
        { line: 2, column: 3, endLine: 2, endColumn: 99 },
        0,
        limit,
        declaration,
      ),
    ).toMatchObject({ ok: false, reason: "out-of-bounds" });
    // End before start (empty span).
    expect(
      resolveEditRange(
        source,
        { line: 3, column: 1, endLine: 2, endColumn: 1 },
        0,
        limit,
        declaration,
      ),
    ).toMatchObject({ ok: false, reason: "empty" });
    // A whole-file coordinate space with the declaration as a sub-span: the
    // range resolves on the file but does not sit inside the declaration.
    const wholeFileDeclaration = { start: 15, end: 29 };
    expect(
      resolveEditRange(
        source,
        { line: 4, column: 3, endLine: 4, endColumn: 15 },
        0,
        source.length,
        wholeFileDeclaration,
      ),
    ).toMatchObject({ ok: false, reason: "outside-declaration" });

    // A block the prompt would elide cannot be addressed by position: its shown
    // line numbers no longer map back to the source.
    const longSource = `${"x".repeat(SPEC_FILE_LIMIT + 100)}\n`;
    expect(
      resolveEditRange(
        longSource,
        { line: 1, column: 1, endLine: 1, endColumn: 1 },
        0,
        longSource.length,
        { start: 0, end: longSource.length },
      ),
    ).toMatchObject({ ok: false, reason: "truncated" });
  });

  test("applies a single-line range against the pinned declaration", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      rangeEditResponse({ line: 2, column: 3, endLine: 2, endColumn: 11 }, "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("applies a multi-line range", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n",
    );
    const provider = new ScriptedProvider([
      selectionResponse(),
      rangeEditResponse({ line: 2, column: 3, endLine: 4, endColumn: 15 }, "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(helperSource(dir)).toContain("return 2;");
    expect(helperSource(dir)).not.toContain("const a");
  }, 30000);

  test("a range takes precedence over a matcher when both are sent", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      JSON.stringify({
        ...ANSWER,
        matcher: "return 999;",
        range: { line: 2, column: 3, endLine: 2, endColumn: 11 },
        replacement: "return 2;",
      }),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("a whole-declaration range keeps the export-range expansion", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      rangeEditResponse(
        { line: 1, column: 1, endLine: 3, endColumn: 1 },
        "export function answer(): number {\n  return 2;\n}",
      ),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    const source = helperSource(dir);
    expect(source).toBe("export function answer(): number {\n  return 2;\n}\n");
    expect(source.match(/export/g)).toHaveLength(1);
  }, 30000);

  test("rejects an out-of-bounds range with range-invalid and recovers", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      rangeEditResponse({ line: 99, column: 1, endLine: 99, endColumn: 1 }, "return 2;"),
      editResponse(null, "export function answer(): number {\n  return 2;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "range",
      "applied",
      "ok",
    ]);
    expect(result.records[1]?.cause).toBe("range-invalid");
    const diagnostics = result.records[1]?.diagnostics ?? "";
    expect(diagnostics).toContain("stage: range");
    expect(diagnostics).toContain("currently spans line 1");
    // The retry carries the range-invalid correction.
    const retryPrompt = provider.calls[2]?.at(-1)?.content ?? "";
    const policy = rejectionPolicy("range-invalid");
    if (policy.action !== "retry" || policy.correction === null) {
      throw new Error("expected a retryable range-invalid policy");
    }
    expect(retryPrompt).toContain(policy.correction);
  }, 30000);

  test("rejects an empty or end-before-start range with range-invalid", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      rangeEditResponse({ line: 3, column: 1, endLine: 2, endColumn: 1 }, "return 2;"),
      editResponse(null, "export function answer(): number {\n  return 2;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "range",
      "applied",
      "ok",
    ]);
    expect(result.records[1]?.cause).toBe("range-invalid");
    expect(result.records[1]?.diagnostics).toContain("empty or ends before it starts");
  }, 30000);

  test("a range cannot address a re-pinned declaration", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  return 1;\n}\n\nexport function other(): number {\n  return 1;\n}\n",
    );
    const otherAddress = { path: "src/helper.ts", symbol: "other", kind: "function" };
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", 'return "nope";'),
      rangeEditResponse(
        { line: 1, column: 1, endLine: 3, endColumn: 1 },
        "function other(): number {\n  return 2;\n}",
        otherAddress,
      ),
      editResponse(null, "export function answer(): number {\n  return 2;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: signatureCheckCommand(dir, [1, 0]),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "range",
      "applied",
      "ok",
    ]);
    expect(result.records[3]?.cause).toBe("range-invalid");
    expect(result.records[3]?.diagnostics).toContain("cannot be used");
    // The refused re-pin left the pin on the declaration the prompt showed.
    expect(result.locator).toEqual({ path: "src/helper.ts", name: "answer", kind: "function" });
    expect(helperSource(dir)).toContain("export function answer(): number {\n  return 2;\n}");
    expect(helperSource(dir)).toContain("export function other(): number {\n  return 1;\n}");
  }, 30000);

  test("a matcher payload without range stays byte-identical", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);
});

describe("self-verification request (#73)", () => {
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

  test("parses the whitelisted kinds and defaults to none", () => {
    expect(parseSelfCheckRequest('{"request":"read"}')).toEqual({ kind: "ok", request: "read" });
    expect(parseSelfCheckRequest('{"request":"check"}')).toEqual({ kind: "ok", request: "check" });
    expect(parseSelfCheckRequest('{"request":"test"}')).toEqual({ kind: "ok", request: "test" });
    // Not request-shaped: the caller falls through to the edit parser.
    expect(
      parseSelfCheckRequest('{"path":"a.ts","symbol":"x","kind":"function","replacement":"y"}'),
    ).toEqual({ kind: "none" });
    expect(parseSelfCheckRequest('{"payloads":[]}')).toEqual({ kind: "none" });
    expect(parseSelfCheckRequest("not json")).toEqual({ kind: "none" });
    expect(parseSelfCheckRequest("[1,2,3]")).toEqual({ kind: "none" });
  });

  test("rejects a malformed or non-whitelisted request as protocol", () => {
    for (const bad of [
      '{"request":"rm -rf /"}',
      '{"request":"bunx tsc --noEmit"}',
      '{"request":42}',
      '{"request":"read","path":"src/a.ts"}',
    ]) {
      const parsed = parseSelfCheckRequest(bad);
      expect(parsed.kind).toBe("error");
      if (parsed.kind === "error") {
        expect(parsed.diagnostics.startsWith("stage: protocol")).toBe(true);
      }
    }
  });

  test("renders a bounded read result with 1-based numbering", () => {
    expect(renderSelfCheckRead("src/a.ts", "a\nb\n")).toBe(
      `Self-check (read): src/a.ts (2 line(s), truncated at ${SPEC_FILE_LIMIT} characters).\n\n1 | a\n2 | b`,
    );
    expect(renderSelfCheckRead("src/a.ts", "")).toBe(
      "Self-check (read): src/a.ts is empty or does not exist.",
    );
    const rendered = renderSelfCheckRead("src/a.ts", `${"x".repeat(SPEC_FILE_LIMIT + 50)}\n`);
    expect(rendered).toContain("[truncated");
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

  test("offers the request only in repair prompts", () => {
    const locatorJson = '{"mode":"modify","path":"src/a.ts","symbol":"make","kind":"function"}';
    const retry = buildRetryPrompt({
      exchangeNumber: 2,
      maxExchanges: 3,
      mode: "modify",
      locatorJson,
      currentSource: "function make() {\n  return 1;\n}",
      diagnostics: "stage: protocol",
      failure: "edit",
      repin: false,
    });
    expect(retry).toContain('{"request":"read"}');
    expect(retry).toContain('{"request":"check"}');
    expect(retry).toContain('{"request":"test"}');
    // The fresh post-pick prompts are the no-repair path and never offer it.
    expect(buildEditPrompt(locatorJson, "function make() {\n  return 1;\n}")).not.toContain(
      '"request"',
    );
    expect(buildCreatePrompt(locatorJson, "src/a.ts")).not.toContain('"request"');
  });

  test("renders the self-check result section only when passed", () => {
    const input = {
      exchangeNumber: 2,
      maxExchanges: 3,
      mode: "modify" as const,
      locatorJson: '{"mode":"modify","path":"src/a.ts","symbol":"make","kind":"function"}',
      currentSource: "function make() {\n  return 1;\n}",
      diagnostics: "stage: protocol",
      failure: "edit" as const,
      repin: false,
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

  test("the #52 continuation keeps its header and the #71 note rides alongside", () => {
    const locatorJson = '{"mode":"modify","path":"src/a.ts","symbol":"make","kind":"function"}';
    const continuation = buildContinuationPrompt({
      round: 1,
      maxRounds: 32,
      mode: "modify",
      locatorJson,
      currentSource: "function make() {\n  return 1;\n}",
      diagnostics: "stage: protocol",
      repin: false,
    });
    expect(continuation).toContain("exhausted its 3-exchange edit budget");
    expect(continuation).toContain('{"request":"read"}');
    const withHistory = buildRetryPrompt({
      exchangeNumber: 2,
      maxExchanges: 3,
      mode: "modify",
      locatorJson,
      currentSource: "function make() {\n  return 1;\n}",
      diagnostics: "stage: protocol",
      failure: "edit",
      repin: false,
      failureHistory:
        "Failure history: the failing set is unchanged across the last 3 verification rounds.",
      selfCheck: "Self-check (check): the check command failed (exit 1).",
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

  test("executes a read request in a repair round and returns it once", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", 'return "nope";'),
      JSON.stringify({ request: "read" }),
      editResponse(null, "export function answer(): number {\n  return 2;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: signatureCheckCommand(dir, [1, 0]),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "self-check",
      "applied",
      "ok",
    ]);
    expect(exchangeStats(result.records).selfChecks).toBe(1);
    const afterRequest = (provider.calls[3] ?? []).at(-1)?.content ?? "";
    expect(afterRequest).toContain("Self-check result:");
    expect(afterRequest).toContain("Self-check (read): src/helper.ts");
    expect(afterRequest).toContain("1 | function answer(): number {");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("executes at most one request per round and refuses a second", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", 'return "nope";'),
      JSON.stringify({ request: "check" }),
      JSON.stringify({ request: "check" }),
      editResponse(null, "export function answer(): number {\n  return 2;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: signatureCheckCommand(dir, [1, 0]),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "self-check",
      "protocol",
      "applied",
      "ok",
    ]);
    expect(exchangeStats(result.records).selfChecks).toBe(1);
    const refused = result.records[4];
    expect(refused?.cause).toBe("protocol");
    expect(refused?.diagnostics).toContain("already used its one self-verification request");
    // The result is shown once (calls[3]); the refusal prompt does not repeat it.
    expect((provider.calls[3] ?? []).at(-1)?.content ?? "").toContain("Self-check result:");
    expect((provider.calls[4] ?? []).at(-1)?.content ?? "").not.toContain("Self-check result:");
    // The check command ran exactly: round-1 verification, the one request,
    // round-2 verification. The refused second request did not run it again.
    expect(readFileSync(join(dir, "check-calls.txt"), "utf8")).toBe("3");
  }, 30000);

  test("refuses a non-whitelisted request without executing it", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", 'return "nope";'),
      JSON.stringify({ request: "bunx tsc --noEmit" }),
      editResponse(null, "export function answer(): number {\n  return 2;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
    const refused = result.records[3];
    expect(refused?.cause).toBe("protocol");
    expect(refused?.diagnostics).toContain('"request" must be one of');
    expect(exchangeStats(result.records).selfChecks).toBe(0);
    // Only the two verifications ran the check command.
    expect(readFileSync(join(dir, "check-calls.txt"), "utf8")).toBe("2");
  }, 30000);

  test("does not recognise a request on the fresh post-pick prompt", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      JSON.stringify({ request: "read" }),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
    expect(result.records[1]?.diagnostics).toContain('unexpected key(s) "request"');
    expect(exchangeStats(result.records).selfChecks).toBe(0);
  }, 30000);

  test("refuses a request at the final exchange of a round", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", 'return "nope";'),
      editResponse("return 999;", "return 2;"),
      editResponse("return 998;", "return 2;"),
      JSON.stringify({ request: "read" }),
      editResponse(null, "export function answer(): number {\n  return 2;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
      "protocol",
      "applied",
      "ok",
    ]);
    const refused = result.records[5];
    expect(refused?.diagnostics).toContain("no exchange left");
    expect(exchangeStats(result.records).selfChecks).toBe(0);
  }, 30000);
});

describe("sharpened repeated no-progress ask (#65)", () => {
  const stalledInput = (over: Partial<StalledAsk> = {}): RetryPromptInput => ({
    exchangeNumber: 1,
    maxExchanges: 3,
    mode: "modify",
    locatorJson: '{"mode":"modify","path":"src/a.ts","symbol":"answer","kind":"function"}',
    currentSource: "export function answer(): number {\n  return 1;\n}",
    diagnostics: "src/a.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    failure: "verification",
    repin: true,
    stalled: { failedRounds: 8, round: 9, maxRounds: 32, ...over },
  });

  test("the first ask keeps the original wording byte-for-byte", () => {
    const prompt = buildRetryPrompt(stalledInput());
    expect(prompt).toContain(
      "No progress: 8 consecutive failed rounds. This is round 9 of 32. Reply exactly `STOP` to end the run now, but only if the failures cannot be resolved; otherwise take a materially different approach rather than another minimal attempt.",
    );
    expect(prompt).not.toContain("repeated ask");
  });

  test("the second ask folds in the unchanged failing set and demands address-or-STOP", () => {
    const prompt = buildRetryPrompt(
      stalledInput({ askNumber: 2, history: { kind: "unchanged", rounds: 6 } }),
    );
    expect(prompt).toContain("No progress: 8 consecutive failed rounds. This is round 9 of 32.");
    expect(prompt).toContain("repeated ask 2");
    expect(prompt).toContain("the failing set is unchanged across the last 6 verification rounds");
    expect(prompt).toContain("directly address that unchanged failing set");
    // STOP keeps its biased-to-continue semantics: only when the set cannot be
    // resolved; the concrete alternatives still ride along.
    expect(prompt).toContain(
      "only if it cannot be resolved, reply exactly `STOP` to end the run now",
    );
    expect(prompt).toContain("Concretely: change the matcher shape");
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

  test("the sharpened ask rides a #52 continuation round", () => {
    const prompt = buildContinuationPrompt({
      round: 8,
      maxRounds: 32,
      mode: "modify",
      locatorJson: '{"mode":"modify","path":"src/a.ts","symbol":"answer","kind":"function"}',
      currentSource: "export function answer(): number {\n  return 1;\n}",
      diagnostics: "stage: protocol",
      repin: true,
      stalled: {
        failedRounds: 16,
        round: 17,
        maxRounds: 32,
        askNumber: 2,
        history: { kind: "unchanged", rounds: 10 },
      },
    });
    expect(prompt).toContain("No progress: 16 consecutive failed rounds. This is round 17 of 32.");
    expect(prompt).toContain("repeated ask 2");
    expect(prompt).toContain("the failing set is unchanged across the last 10 verification rounds");
    // The ask still replaces the continuation's own round-exhausted header.
    expect(prompt).not.toContain("exhausted its 3-exchange edit budget");
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
      model: "fake",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS * 2),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    const firstAsk = provider.calls[9]?.at(-1)?.content ?? "";
    expect(firstAsk).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed rounds.`);
    expect(firstAsk).not.toContain("repeated ask");
    // The second ask arrives four failed rounds later (streak 12, round 13).
    const secondAsk = provider.calls[13]?.at(-1)?.content ?? "";
    expect(secondAsk).toContain(
      `No progress: ${MAX_STALLED_ROUNDS + STALLED_ASK_INTERVAL} consecutive failed rounds.`,
    );
    expect(secondAsk).toContain("This is round 13 of 32.");
    expect(secondAsk).toContain("repeated ask 2");
    expect(secondAsk).toContain("the failing set is unchanged across the last");
    expect(secondAsk).toContain("directly address that unchanged failing set");
    // The #71 note is still carried alongside the sharpened framing.
    expect(secondAsk).toContain("Failure history: the failing set is unchanged");
    // The third ask recurs at the next shortened interval (streak 16, round 17).
    const thirdAsk = provider.calls[17]?.at(-1)?.content ?? "";
    expect(thirdAsk).toContain(`No progress: ${MAX_STALLED_ROUNDS * 2} consecutive failed rounds.`);
    expect(thirdAsk).toContain("This is round 17 of 32.");
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
      model: "fake",
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
    expect(firstAsk).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed rounds.`);
    expect(firstAsk).not.toContain("repeated ask");
    // The second (sharpened) ask fired at streak 12, round 13 — before the
    // budget ended the run around round 15.
    const secondAsk = provider.calls[13]?.at(-1)?.content ?? "";
    expect(secondAsk).toContain("This is round 13 of 32.");
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
      model: "fake",
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
      `edit-exhausted: the model replied STOP after ${MAX_STALLED_ROUNDS * 2} consecutive failed rounds`,
    );
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

  constructor(private readonly responses: ScriptedResponse[]) {}

  async chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    this.calls.push(structuredClone(messages));
    this.toolsArgs.push(tools);
    this.optionCalls.push(options);
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("no scripted response");
    }
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

// A v2 edit payload: one flat object with the pinned address, an optional
// matcher, and the replacement.
function editResponse(
  matcher: string | null,
  replacement: string,
  address: { path: string; symbol: string; kind: string } = ANSWER,
): string {
  const payload: Record<string, string> = { ...address };
  if (matcher !== null) {
    payload["matcher"] = matcher;
  }
  payload["replacement"] = replacement;
  return JSON.stringify(payload);
}

// A v2 create payload: the complete declaration, never a matcher.
function createResponse(
  address: { path: string; symbol: string; kind: string },
  replacement: string,
): string {
  return editResponse(null, replacement, address);
}

// A v2 range payload (#72): the pinned address plus a 1-based inclusive
// `(line,column)` selector instead of a matcher.
function rangeEditResponse(
  range: { line: number; column: number; endLine: number; endColumn: number },
  replacement: string,
  address: { path: string; symbol: string; kind: string } = ANSWER,
): string {
  return JSON.stringify({ ...address, range, replacement });
}

// The canonical pinned selection the loop echoes into retry prompts.
function selectionResponse(
  address: { path: string; symbol: string; kind: string } = ANSWER,
  mode?: "modify" | "create" | "delete",
): string {
  return JSON.stringify(mode === undefined ? { ...address } : { mode, ...address });
}

// A chain of distinct applied edits `return i;` → `return i + 1;`, one per
// round, so a scripted check can fail exactly the first N verifications (#54).
function chainedEdits(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    editResponse(`return ${index + 1};`, `return ${index + 2};`),
  );
}

// One plain `not json` reply, i.e. a `stage: protocol` rejection; a storm is a
// run of them, three per round below the cap (#60).
function protocolRejections(count: number): string[] {
  return Array.from({ length: count }, () => "not json");
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
    this.calls.push(structuredClone(messages));
    const content = this.responses[this.index];
    if (content === undefined) {
      throw new Error("no scripted response");
    }
    const usage = this.usages[this.index] ?? null;
    this.index += 1;
    return { content, toolCalls: [], finishReason: "stop", raw: { usage } };
  }
}

describe("runLoop", () => {
  test("applies, verifies, and returns a successful edit with v2 records", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
      '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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

  test("accepts a locator delivered through a tool call", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      {
        toolCall: {
          name: "select",
          arguments: '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
        },
      },
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("sends no tools to the provider", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(provider.calls.length).toBe(2);
    expect(provider.toolsArgs).toEqual([undefined, undefined]);
  }, 30000);

  test("shares one ≤3 budget between picking and content revision", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      "not json",
      '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    // Two exchanges picked the target, the third wrote the edit: 3 exchanges.
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
      '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
      editResponse("return 1;", "return 2;"),
    ]);
    const issue = "make the answer test pass";
    const result = await runLoop({
      cwd: dir,
      issue,
      model: "fake",
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
    expect(failed?.diagnostics).toContain("stage: protocol");
    expect(failed?.diagnostics).toContain("no JSON object found");

    const files = discoverSourceFiles(dir);
    const initialMessages = provider.calls[0] ?? [];
    expect(initialMessages).toHaveLength(2);
    expect(initialMessages[0]?.role).toBe("system");
    expect(initialMessages[0]?.content).toBe(buildSystemPrompt());
    expect(initialMessages[1]?.role).toBe("user");
    expect(initialMessages[1]?.content).toBe(
      buildUserPrompt(issue, buildContextYaml(files), selectSpecFiles(issue, files)),
    );

    const retryMessages = provider.calls[1] ?? [];
    expect(retryMessages.slice(0, initialMessages.length)).toEqual(initialMessages);
    expect(retryMessages.length - initialMessages.length).toBe(2);
    const tail = retryMessages.slice(initialMessages.length);
    expect(tail[0]).toEqual({ role: "assistant", content: "not json" });
    expect(tail[1]?.role).toBe("user");
    const retryPrompt = tail[1]?.content ?? "";
    expect(retryPrompt).toBe(buildSelectionRetryPrompt(result.records[0]?.diagnostics ?? ""));
    expect(retryPrompt.toLowerCase()).toContain("selection");
    expect(retryPrompt.toLowerCase()).not.toContain("replacement");
    expect(retryPrompt).toContain("no markdown fences");
    expect(retryPrompt).toContain("stage: protocol");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("soft failures consume the round budget and a continuation STOP ends the run", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      "not json",
      '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
      "still not json",
      "STOP",
      "the model could not produce an edit",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "protocol",
      "selected",
      "protocol",
      "stopped",
    ]);
    expect(result.records.map((record) => record.exchange)).toEqual([1, 2, 3, 1]);
    expect(result.records.map((record) => record.iteration)).toEqual([1, 1, 1, 2]);
    expect(result.locator).toEqual({ path: "src/helper.ts", name: "answer", kind: "function" });
    expect(result.filePath).toBe("src/helper.ts");
    expect(result.editedSource).toBeNull();
    expect(result.diagnostics).toContain("edit-exhausted");
    expect(result.diagnostics).toContain("stage: protocol");
    expect(result.diagnostics).toContain("the model replied STOP after 2 rounds");
    // The continuation prompt carries the round framing and the STOP option,
    // never the verification-failure header.
    const continuationPrompt = provider.calls[3]?.at(-1)?.content ?? "";
    expect(continuationPrompt).toContain("Round 1 of 32 exhausted its 3-exchange edit budget");
    expect(continuationPrompt).toContain("Reply STOP to end the run");
    expect(continuationPrompt).not.toContain("failed verification");
    expect(continuationPrompt).toContain("stage: protocol");
    // Exactly one summary call as the final action.
    expect(provider.calls.length).toBe(5);
    const summaryPrompt = provider.calls[4]?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain("The run is over");
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("the model could not produce an edit");
    expect(result.messages.at(-1)?.content).toContain("The run is over");
    expect(helperSource(dir)).toContain("return 1;");
  }, 30000);

  test("continues a round whose successful pick consumed the last exchange", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      "not json",
      "still not json",
      '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
      "STOP",
      "the selection came too late",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "protocol",
      "protocol",
      "selected",
      "stopped",
    ]);
    expect(result.records.map((record) => record.iteration)).toEqual([1, 1, 1, 2]);
    expect(result.diagnostics).toContain("edit-exhausted");
    expect(result.diagnostics).toContain("the model replied STOP after 2 rounds");
    // The continuation prompt is edit-shaped: pinned selection + current source.
    const continuationCall = provider.calls[3] ?? [];
    const continuationPrompt = continuationCall.at(-1)?.content ?? "";
    expect(continuationPrompt).toContain("Round 1 of 32 exhausted its 3-exchange edit budget");
    expect(continuationPrompt).toContain("return a corrected edit");
    expect(continuationPrompt).toContain("Pinned selection:");
    expect(continuationCall.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(continuationCall[2]?.content).toBe(selectionResponse(ANSWER, "modify"));
    expect(provider.calls.length).toBe(5);
    expect(result.explanation).toBe("the selection came too late");
    // Nothing was applied.
    expect(helperSource(dir)).toContain("return 1;");
  }, 30000);

  test("continues an exhausted round with the 32-round framing, then passes", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      "not json",
      "not json",
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "protocol",
      "protocol",
      "applied",
      "ok",
    ]);
    expect(result.records.map((record) => record.iteration)).toEqual([1, 1, 1, 2, 2]);
    expect(result.records.map((record) => record.exchange)).toEqual([1, 2, 3, 1, null]);
    // The first exchange of round 2 is the continuation reply.
    const continuationCall = provider.calls[3] ?? [];
    const continuationPrompt = continuationCall.at(-1)?.content ?? "";
    expect(continuationPrompt).toContain("Round 1 of 32 exhausted its 3-exchange edit budget");
    expect(continuationPrompt).toContain("Reply STOP to end the run, or return a corrected edit");
    expect(continuationPrompt).not.toContain("failed verification");
    expect(continuationPrompt).toContain("Current source:");
    expect(continuationPrompt).toContain("stage: protocol");
    expect(continuationCall.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(continuationCall[2]?.content).toBe(selectionResponse(ANSWER, "modify"));
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("rejects an identical resend at the continuation; a later STOP ends the run", async () => {
    const dir = fixtureDir();
    const rejected = editResponse("return 99;", "return 2;");
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      rejected,
      rejected,
      rejected,
      rejected,
      rejected,
      "  Stop\n",
      "the edits never verify",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "matcher",
      "repeat",
      "repeat",
      "repeat",
      "repeat",
      "stopped",
    ]);
    expect(result.records.map((record) => record.iteration)).toEqual([1, 1, 1, 2, 2, 2, 3]);
    // The first exchange of round 2 is the continuation reply; the identical
    // resend is rejected before any splice.
    const continuationRepeat = result.records[3];
    expect(continuationRepeat?.diagnostics).toContain("stage: repeat");
    expect(continuationRepeat?.diagnostics).toContain("was just rejected (stage: repeat)");
    const continuationPrompt = provider.calls[3]?.at(-1)?.content ?? "";
    expect(continuationPrompt).toContain("Round 1 of 32 exhausted its 3-exchange edit budget");
    expect(continuationPrompt).toContain("Reply STOP to end the run");
    // A case-insensitive STOP on the next continuation ends the run with
    // exactly one summary call.
    expect(provider.calls.length).toBe(8);
    const summaryPrompt = provider.calls[7]?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain("The run is over");
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("the edits never verify");
    expect(result.diagnostics).toContain("the model replied STOP after 3 rounds");
    expect(result.messages.at(-1)?.content).toContain("The run is over");
    // The rejected matcher edit was never written.
    expect(helperSource(dir)).toContain("return 1;");
  }, 30000);

  test("terminates naming the cap when a failing provider reaches 32 rounds", async () => {
    const dir = fixtureDir();
    const rejected = editResponse("return 99;", "return 2;");
    const calls: ChatMessage[][] = [];
    const provider: ProviderLike = {
      async chat(messages) {
        calls.push(structuredClone(messages));
        if (calls.length === 1) {
          return {
            content: selectionResponse(ANSWER, "modify"),
            toolCalls: [],
            finishReason: "stop",
            raw: {},
          };
        }
        if (calls.length === MAX_EDIT_EXCHANGES * MAX_RUN_ITERATIONS + 1) {
          return {
            content: "the cap was reached without a verified edit",
            toolCalls: [],
            finishReason: "stop",
            raw: {},
          };
        }
        return { content: rejected, toolCalls: [], finishReason: "stop", raw: {} };
      },
    };
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.diagnostics).toContain("the 32-round cap was reached without a verified edit");
    // 32 rounds × 3 exchanges, then exactly one summary call.
    expect(calls.length).toBe(MAX_EDIT_EXCHANGES * MAX_RUN_ITERATIONS + 1);
    const summaryPrompt = calls.at(-1)?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain("The run is over");
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("the cap was reached without a verified edit");
    expect(result.records).toHaveLength(MAX_EDIT_EXCHANGES * MAX_RUN_ITERATIONS);
    expect(result.records[0]?.outcome).toBe("selected");
    expect(result.records[1]?.outcome).toBe("matcher");
    expect(result.records[2]?.outcome).toBe("repeat");
    const last = result.records.at(-1);
    expect(last?.iteration).toBe(MAX_RUN_ITERATIONS);
    expect(last?.exchange).toBe(MAX_EDIT_EXCHANGES);
    expect(last?.outcome).toBe("repeat");
    expect(result.records.every((record) => record.kind === "exchange")).toBe(true);
  }, 30000);

  test("the round cap also terminates from the outer loop after a failed final verification", async () => {
    const dir = fixtureDir();
    // Every round applies its chained edit and fails verification, so the 32nd
    // iteration falls through to the outer cap check instead of an in-exchange
    // termination.
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(MAX_RUN_ITERATIONS),
      "the cap was reached with the verification still failing",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: failingCommand,
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.diagnostics).toContain(
      `edit-exhausted: the ${MAX_RUN_ITERATIONS}-round cap was reached without a verified edit`,
    );
    expect(result.records).toHaveLength(MAX_RUN_ITERATIONS * 2 + 1);
    expect(result.records[0]?.outcome).toBe("selected");
    expect(result.records.filter((record) => record.outcome === "applied")).toHaveLength(
      MAX_RUN_ITERATIONS,
    );
    expect(result.records.at(-1)?.outcome).toBe("tsc");
    // 1 selection + 32 content edits, then exactly one summary call.
    expect(provider.calls).toHaveLength(MAX_RUN_ITERATIONS + 2);
    const summaryPrompt = provider.calls.at(-1)?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain(
      "The run is over: the edit budget was exhausted without a valid edit.",
    );
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("the cap was reached with the verification still failing");
    // Keep-progress: the last chained edit stays on disk.
    expect(helperSource(dir)).toContain("return 33;");
  }, 30000);

  test("treats a bare STOP outside a continuation prompt as a protocol failure", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      "STOP",
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
    expect(result.records[1]?.diagnostics?.startsWith("stage: protocol\n")).toBe(true);
    // The STOP is answered with the ordinary exchange retry prompt.
    const retryPrompt = (provider.calls[2] ?? []).at(-1)?.content ?? "";
    expect(retryPrompt).toContain("Edit exchange 3 of 3 failed.");
    expect(retryPrompt).toContain("stage: protocol");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("asks for a decision after 8 consecutive failed rounds and passes when the model continues", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(9),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
    expect(ordinary).toContain("Edit exchange 1 of 3 failed verification.");
    expect(ordinary).not.toContain("consecutive failed rounds");
    // Round 9 (8 failed rounds) opens with the no-progress ask in retry shape.
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(MAX_STALLED_ROUNDS).toBe(8);
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed rounds.`);
    expect(ask).toContain("This is round 9 of 32.");
    expect(ask).toContain("Reply exactly `STOP` to end the run now");
    expect(ask).toContain("only if the failures cannot be resolved");
    expect(ask).toContain("materially different approach rather than another minimal attempt");
    expect(ask).toContain("change the matcher shape");
    expect(ask).toContain("re-pin to a declaration the diagnostics name");
    expect(ask).not.toContain("Edit exchange 1 of 3 failed verification.");
    // The retry shape is kept: pinned selection, current source, diagnostics,
    // JSON output shape.
    expect(ask).toContain("Pinned selection:");
    expect(ask).toContain("Current source:");
    expect(ask).toContain("Diagnostics:");
    expect(ask).toContain(
      'Output ONLY one flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}',
    );
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
      model: "fake",
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
    // The stalled stop names the consecutive failed rounds, distinct from #52's
    // exhausted-round text, and carries the diagnostics shown in the ask.
    expect(stopped?.diagnostics).toContain(
      `edit-exhausted: the model replied STOP after ${MAX_STALLED_ROUNDS} consecutive failed rounds`,
    );
    // Distinct from #52's continuation-round STOP text.
    expect(stopped?.diagnostics).not.toContain("replied STOP after 8 rounds");
    expect(stopped?.diagnostics).toContain("stage: tsc");
    expect(result.diagnostics).toContain(
      `the model replied STOP after ${MAX_STALLED_ROUNDS} consecutive failed rounds`,
    );
    // Exactly one summary call, as the final action.
    expect(provider.calls.length).toBe(11);
    const summaryPrompt = provider.calls[10]?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain("The run is over");
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("the failures could not be resolved");
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed rounds.`);
    // Keep-progress: the last applied edit stays on disk.
    expect(helperSource(dir)).toContain("return 9;");
  }, 30000);

  test("repeats the no-progress ask at 16 consecutive failed rounds with the updated count", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(17),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS * 2),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.records.filter((record) => record.outcome === "tsc")).toHaveLength(16);
    // Round 16 (15 failed rounds) is ordinary; round 17 (16 failed) asks again.
    const ordinary = provider.calls[16]?.at(-1)?.content ?? "";
    expect(ordinary).toContain("Edit exchange 1 of 3 failed verification.");
    expect(ordinary).not.toContain("consecutive failed rounds");
    const ask = provider.calls[17]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS * 2} consecutive failed rounds.`);
    expect(ask).toContain("This is round 17 of 32.");
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
      model: "fake",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS - 1),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    // Round 8 (7 failed rounds) keeps the ordinary verification retry header.
    const round8 = provider.calls[8]?.at(-1)?.content ?? "";
    expect(round8).toContain("Edit exchange 1 of 3 failed verification.");
    for (const call of provider.calls) {
      expect(call.at(-1)?.content ?? "").not.toContain("No progress:");
    }
  }, 30000);

  test("does not carry the ask into a soft-failure retry inside the stalled round", async () => {
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
      model: "fake",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed rounds.`);
    // The soft failure at exchange 1 is answered by the ordinary exchange retry:
    // the ask shapes only the first content prompt of the round.
    const retry = provider.calls[10]?.at(-1)?.content ?? "";
    expect(retry).toContain("Edit exchange 2 of 3 failed.");
    expect(retry).toContain("stage: protocol");
    expect(retry).not.toContain("No progress:");
    expect(result.records.filter((record) => record.outcome === "protocol")).toHaveLength(1);
    expect(helperSource(dir)).toContain("return 10;");
  }, 30000);

  test("does not carry the no-progress ask on a #52 continuation round", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(8),
      "not json",
      "not json",
      "not json",
      editResponse("return 9;", "return 10;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    // Round 9's first exchange carried the ask...
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed rounds.`);
    // ...its exchanges 2-3 soft-failed and exhausted the round, so round 10
    // opens through the #52 continuation prompt, which already offers STOP.
    const continuation = provider.calls[12]?.at(-1)?.content ?? "";
    expect(continuation).toContain("Round 9 of 32 exhausted its 3-exchange edit budget");
    expect(continuation).toContain("Reply STOP to end the run");
    expect(continuation).not.toContain("No progress:");
    expect(result.records.find((record) => record.iteration === 10)?.outcome).toBe("applied");
  }, 30000);

  test("rejects a byte-identical resubmission at the no-progress ask as stage: repeat", async () => {
    const dir = fixtureDir();
    const round8Edit = editResponse("return 8;", "return 9;");
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(7),
      round8Edit,
      round8Edit,
      editResponse("return 9;", "return 10;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed rounds.`);
    // The guard keeps precedence at the ask exchange: the identical resend is
    // rejected before any splice and consumes the first exchange.
    const repeat = result.records.find((record) => record.outcome === "repeat");
    expect(repeat?.iteration).toBe(9);
    expect(repeat?.exchange).toBe(1);
    expect(repeat?.diagnostics).toContain("stage: repeat");
    expect(repeat?.diagnostics).toContain("was already applied");
    expect(helperSource(dir)).toContain("return 10;");
  }, 30000);

  test("counts a rejection-exhausted round toward the no-progress streak (#60)", async () => {
    const dir = fixtureDir();
    // Seven failed verification rounds (streak 7), then one round that rejects
    // all three exchanges: the rejection-only round crosses the threshold, so
    // the streak reads 8 and the next round asks.
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...chainedEdits(7),
      ...protocolRejections(3),
      editResponse("return 8;", "return 9;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: stallingCheckCommand(dir, 7),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.records.filter((record) => record.outcome === "tsc")).toHaveLength(7);
    expect(result.records.filter((record) => record.outcome === "protocol")).toHaveLength(3);
    // Round 8 (7 failed verifications) still opens with the ordinary retry in
    // verification-retry shape...
    const round8 = provider.calls[8]?.at(-1)?.content ?? "";
    expect(round8).toContain("Edit exchange 1 of 3 failed verification.");
    expect(round8).not.toContain("No progress:");
    // ...the rejection-only round 8 advances the same streak, so round 9 asks.
    const ask = provider.calls[11]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed rounds.`);
    expect(ask).toContain("This is round 9 of 32.");
    // The digest mixes both no-progress shapes: 7 verifications + 3 rejections.
    expect(ask).toContain("Prior attempts (10):");
    expect(ask).toContain("- #1 tsc: replacement line 1: TS2322: synthetic 0");
    expect(ask).toContain("- #8 protocol: expected");
    // The ask replaces the round-exhausted header of the #52 continuation.
    expect(ask).not.toContain("exhausted its 3-exchange edit budget");
    expect(helperSource(dir)).toContain("return 9;");
  }, 30000);

  test("fires the no-progress ask in a rejection storm at 8 rejected rounds (#60)", async () => {
    const dir = fixtureDir();
    // Round 1 spends exchange 1 picking; each round then rejects its remaining
    // exchanges: 2 + 7 * 3 = 23 protocol rejections before the round-9 ask.
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...protocolRejections(23),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.filter((record) => record.outcome === "protocol")).toHaveLength(23);
    // The ask fires exactly once, in rejection rounds exactly as in
    // verification-failure cycles.
    const asks = provider.calls.filter((call) =>
      (call.at(-1)?.content ?? "").includes("No progress:"),
    );
    expect(asks).toHaveLength(1);
    const ask = provider.calls[24]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed rounds.`);
    expect(ask).toContain("This is round 9 of 32.");
    expect(ask).toContain("Reply exactly `STOP` to end the run now");
    expect(ask).toContain("only if the failures cannot be resolved");
    expect(ask).toContain("materially different approach rather than another minimal attempt");
    expect(ask).toContain("Concretely: change the matcher shape");
    expect(ask).toContain("re-pin to a declaration the diagnostics name");
    // The digest is carried with the rejection classes and the ruled-out block.
    expect(ask).toContain("Prior attempts (23):");
    expect(ask).toContain("- #23 protocol: expected");
    expect(ask).toContain(
      "Ruled out after 23 repeats: protocol — This attempt MUST reply with exactly one flat JSON object",
    );
    // The retry shape is kept: pinned selection, current source, diagnostics,
    // JSON output shape; the #52 continuation header is replaced.
    expect(ask).toContain("Pinned selection:");
    expect(ask).toContain("Current source:");
    expect(ask).toContain("Diagnostics:");
    expect(ask).toContain(
      'Output ONLY one flat JSON object {"path": ..., "symbol": ..., "kind": ..., "matcher": ..., "replacement": ...}',
    );
    expect(ask).not.toContain("exhausted its 3-exchange edit budget");
    // Continue-through: the ask is an offer, and the edit applies and verifies.
    expect(result.records.at(-2)?.outcome).toBe("applied");
    expect(result.records.at(-1)?.outcome).toBe("ok");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("a recovering rejection cycle continues past the ask and succeeds (#60)", async () => {
    const dir = fixtureDir();
    // Ten rejection-exhausted rounds: the ask fires at round 9, the cycle keeps
    // going, and the model recovers at round 11 (the rep1 storm shape); the
    // counter reaching a milestone is no cap.
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...protocolRejections(29),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.filter((record) => record.outcome === "protocol")).toHaveLength(29);
    const asks = provider.calls.filter((call) =>
      (call.at(-1)?.content ?? "").includes("No progress:"),
    );
    expect(asks).toHaveLength(1);
    expect(provider.calls[24]?.at(-1)?.content ?? "").toContain(
      `No progress: ${MAX_STALLED_ROUNDS} consecutive failed rounds.`,
    );
    // Round 10 (streak 9) opens through an ordinary #52 continuation again.
    const round10 = provider.calls[27]?.at(-1)?.content ?? "";
    expect(round10).toContain("Round 9 of 32 exhausted its 3-exchange edit budget");
    expect(round10).not.toContain("No progress:");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("recurs the no-progress ask in a rejection cycle at 16 with the updated count (#60)", async () => {
    const dir = fixtureDir();
    // Rounds 1-16 reject every exchange: the ask fires at round 9 (streak 8),
    // round 13 (streak 12), and round 17 (streak 16) under the shortened
    // cadence (#65); the round-17 edit then recovers.
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...protocolRejections(2 + 15 * 3),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    const asks = provider.calls.filter((call) =>
      (call.at(-1)?.content ?? "").includes("No progress:"),
    );
    expect(asks).toHaveLength(3);
    const first = provider.calls[24]?.at(-1)?.content ?? "";
    expect(first).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed rounds.`);
    expect(first).not.toContain("repeated ask");
    const second = provider.calls[36]?.at(-1)?.content ?? "";
    expect(second).toContain(
      `No progress: ${MAX_STALLED_ROUNDS + STALLED_ASK_INTERVAL} consecutive failed rounds.`,
    );
    expect(second).toContain("This is round 13 of 32.");
    expect(second).toContain("repeated ask 2");
    const third = provider.calls[48]?.at(-1)?.content ?? "";
    expect(third).toContain(`No progress: ${MAX_STALLED_ROUNDS * 2} consecutive failed rounds.`);
    expect(third).toContain("This is round 17 of 32.");
    expect(third).toContain("repeated ask 3");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("STOP at the rejection-cycle ask ends the run with one summary and the stalled diagnostics (#60)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      ...protocolRejections(23),
      "  stop\n",
      "the rejection storm could not be resolved",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records).toHaveLength(25);
    const stopped = result.records.at(-1);
    expect(stopped?.outcome).toBe("stopped");
    expect(stopped?.iteration).toBe(9);
    expect(stopped?.exchange).toBe(1);
    expect(stopped?.replacement).toBe("  stop\n");
    // The stalled STOP names the consecutive failed rounds, distinct from
    // #52's exhausted-round text, and keeps the ask's chain diagnostics.
    expect(stopped?.diagnostics).toContain(
      `edit-exhausted: the model replied STOP after ${MAX_STALLED_ROUNDS} consecutive failed rounds`,
    );
    expect(stopped?.diagnostics).not.toContain(
      `the model replied STOP after ${MAX_STALLED_ROUNDS} rounds`,
    );
    expect(stopped?.diagnostics).toContain("stage: protocol");
    expect(stopped?.diagnostics).toContain("no JSON object found in the response");
    // Exactly one summary call, as the final action.
    expect(provider.calls).toHaveLength(26);
    const summaryPrompt = provider.calls[25]?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain("The run is over");
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("the rejection storm could not be resolved");
    // The shared termination chain renders the failure artifact too.
    const artifact = renderFailureArtifact({ rootDir: dir, result });
    expect(artifact).toContain("edit-exhausted");
    expect(artifact).toContain(
      `the model replied STOP after ${MAX_STALLED_ROUNDS} consecutive failed rounds`,
    );
  }, 30000);

  test("continuation prompts carry an updated prior-attempts digest (#57)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 90;", "return 2;"),
      editResponse("return 91;", "return 2;"),
      editResponse("return 92;", "return 2;"),
      editResponse("return 93;", "return 2;"),
      editResponse("return 94;", "return 2;"),
      "STOP",
      "the matcher failures could not be resolved",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
      "matcher",
      "matcher",
      "stopped",
    ]);
    // Round 2's continuation prompt lists the two attempts of round 1.
    const round2 = provider.calls[3]?.at(-1)?.content ?? "";
    expect(round2).toContain("Round 1 of 32 exhausted its 3-exchange edit budget");
    expect(round2).toContain("Prior attempts (2):");
    expect(round2).toContain(
      '- #1 matcher-not-found: the matcher was not found inside function "answer" in src/helper.ts (line 1, column 8)',
    );
    expect(round2).toContain("- #2 matcher-not-found:");
    expect(round2).not.toContain("Ruled out after");
    // Round 3 keeps the earlier entries (they are not regenerated), adds the
    // round-2 attempts, and rules the repeated class out.
    const round3 = provider.calls[6]?.at(-1)?.content ?? "";
    expect(round3).toContain("Prior attempts (5):");
    expect(round3).toContain("- #1 matcher-not-found:");
    expect(round3).toContain("- #5 matcher-not-found:");
    expect([...round3.matchAll(/- #(\d+) /g)].map((match) => match[1])).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(round3).toContain(
      'Ruled out after 5 repeats: matcher-not-found — This attempt MUST omit "matcher" and return the complete declaration in "replacement".',
    );
    // The repeated matcher failures never touched the file.
    expect(helperSource(dir)).toContain("return 1;");
  }, 30000);

  test("the continuation digest rules out a class after three repeats (#57)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 80;", "return 2;"),
      editResponse("return 81;", "return 2;"),
      editResponse("return 82;", "return 2;"),
      "not json",
      "not json",
      "STOP",
      "the failures came in classes",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
      "stopped",
    ]);
    const round2 = provider.calls[3]?.at(-1)?.content ?? "";
    expect(round2).toContain("Prior attempts (2):");
    expect(round2).not.toContain("Ruled out after");
    const round3 = provider.calls[6]?.at(-1)?.content ?? "";
    expect(round3).toContain("Prior attempts (5):");
    expect(round3).toContain(
      'Ruled out after 3 repeats: matcher-not-found — This attempt MUST omit "matcher" and return the complete declaration in "replacement".',
    );
    // The protocol attempts are listed but stay below the ruled-out threshold.
    expect(round3).toContain("- #4 protocol:");
    expect(round3).not.toContain("Ruled out after 2 repeats: protocol");
  }, 30000);

  test("the selection continuation carries the digest and its class counts (#57)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      "not json",
      "not json",
      "not json",
      "STOP",
      "the selection never came",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "protocol",
      "protocol",
      "protocol",
      "stopped",
    ]);
    const continuation = provider.calls[3]?.at(-1)?.content ?? "";
    expect(continuation).toContain("Round 1 of 32 exhausted its 3-exchange selection budget");
    expect(continuation).toContain("Prior attempts (3):");
    expect(continuation).toContain("- #1 protocol:");
    expect(continuation).toContain(
      'Ruled out after 3 repeats: protocol — This attempt MUST reply with exactly one flat JSON object carrying "path", "symbol", "kind", "matcher", and "replacement" as the entire response: no prose, no markdown fences, no nesting.',
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
      model: "fake",
      provider,
      checkCommand: stallingCheckCommand(dir, MAX_STALLED_ROUNDS),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    // The ordinary verification retry of round 8 stays digest-free.
    const ordinary = provider.calls[8]?.at(-1)?.content ?? "";
    expect(ordinary).toContain("Edit exchange 1 of 3 failed verification.");
    expect(ordinary).not.toContain("Prior attempts");
    // The round-9 ask carries the whole failing chain.
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed rounds.`);
    expect(ask).toContain(`Prior attempts (${MAX_STALLED_ROUNDS}):`);
    expect(ask).toContain("- #1 tsc: replacement line 1: TS2322: synthetic 0");
    expect(ask).toContain(`- #${MAX_STALLED_ROUNDS} tsc: replacement line 1: TS2322: synthetic 0`);
    expect(ask).toContain(
      `Ruled out after ${MAX_STALLED_ROUNDS} repeats: tsc — change the declaration structure instead of re-editing the same spot`,
    );
    expect(helperSource(dir)).toContain("return 10;");
  }, 30000);

  test("the digest never leaks replacement text and rides only continuation prompts (#57)", async () => {
    const dir = fixtureDir();
    const marker = "NO_LEAK_MARKER_57";
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse(null, `function answer(): number {\n  return 2;) ${marker}\n}`),
      editResponse(null, `function answer(): number {\n  return 3;) ${marker}\n}`),
      "STOP",
      "the edits never parsed",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "gate",
      "gate",
      "stopped",
    ]);
    const continuation = provider.calls[3]?.at(-1)?.content ?? "";
    const digestAt = continuation.indexOf("Prior attempts");
    expect(digestAt).toBeGreaterThan(-1);
    // The prompt before the digest carries the gate code frame with the raw
    // replacement text...
    expect(continuation.slice(0, digestAt)).toContain(marker);
    // ...the digest section keeps only the chosen diagnostics line.
    const digest = continuation.slice(digestAt);
    expect(digest).toContain("Prior attempts (2):");
    expect(digest).toContain(
      "- #1 gate: the edit was discarded because the resulting source does not parse; nothing was written",
    );
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
      model: "fake",
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
    expect(retryPrompt).toContain("Edit exchange 1 of 3 failed verification.");
    expect(retryPrompt).toContain("2 exchange(s) remain in this iteration");
    expect(retryPrompt).toContain("not assignable");
    expect(retryPrompt).toContain("Current source:");
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
      model: "fake",
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
    const contextYaml = buildContextYaml(files);
    const fullPrompt = buildUserPrompt(issue, contextYaml, selectSpecFiles(issue, files));
    expect(fullPrompt).toContain("# Spec files");
    expect(provider.calls[0]?.[1]?.content).toBe(fullPrompt);
    expect(provider.calls[1]?.[1]?.content).toBe(fullPrompt);
    // The tsc-opened round 2 sends the lean variant on every content exchange.
    const leanPrompt = buildUserPrompt(issue, contextYaml, []);
    expect(leanPrompt).not.toContain("# Spec files");
    expect(leanPrompt).toContain("# Issue");
    expect(leanPrompt).toContain("# Project context");
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
      model: "fake",
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
    const fullPrompt = buildUserPrompt(
      issue,
      buildContextYaml(files),
      selectSpecFiles(issue, files),
    );
    expect(provider.calls[1]?.[1]?.content).toBe(fullPrompt);
    expect(provider.calls[2]?.[1]?.content).toBe(fullPrompt);
    expect(provider.calls[2]?.[1]?.content).toContain("# Spec files");
  }, 30000);

  test("keeps a tsc-repair #52 continuation round lean", async () => {
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
      model: "fake",
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
    expect(result.records.map((record) => record.iteration)).toEqual([1, 1, 1, 2, 2, 2, 3, 3]);
    // Every content exchange of the tsc-opened round and of the continuation
    // round that continues its chain is lean.
    const leanPrompt = buildUserPrompt(issue, buildContextYaml(files), []);
    for (const call of [
      provider.calls[2],
      provider.calls[3],
      provider.calls[4],
      provider.calls[5],
    ]) {
      expect(call?.[1]?.content).toBe(leanPrompt);
    }
    expect(provider.calls[5]?.at(-1)?.content).toContain(
      "Round 2 of 32 exhausted its 3-exchange edit budget",
    );
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
      model: "fake",
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
    expect(retryPrompt).toContain("Edit exchange 1 of 3 failed verification.");
    expect(retryPrompt).toContain("2 exchange(s) remain in this iteration");
    expect(retryPrompt).toContain("not assignable");
    expect(retryPrompt).toContain("Current source:");
    expect(retryPrompt).toContain('return "nope";');
  }, 30000);

  test("rejects an edit payload that does not echo the pinned selection", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse("return 1;", "return 2;", {
        path: "src/helper.ts",
        symbol: "other",
        kind: "function",
      }),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "echo",
      "applied",
      "ok",
    ]);
    const failed = result.records[1];
    expect(failed?.diagnostics?.startsWith("stage: echo\n")).toBe(true);
    expect(failed?.diagnostics).toContain("does not match the pinned selection");
    expect(failed?.diagnostics).toContain('pinned: {"path":"src/helper.ts","symbol":"answer"');
    const retryCall = provider.calls[2] ?? [];
    const retryPrompt = retryCall.at(-1)?.content ?? "";
    expect(retryPrompt).toContain("stage: echo");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("verification repair may re-pin to another declaration in the same file", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  return 1;\n}\n\nexport function other(): number {\n  return 1;\n}\n",
    );
    const otherAddress = { path: "src/helper.ts", symbol: "other", kind: "function" };
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", 'return "nope";'),
      editResponse(null, "function other(): number {\n  return 2;\n}", otherAddress),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: signatureCheckCommand(dir, [1, 0]),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("modify");
    // The pin moved to the re-pinned declaration.
    expect(result.locator).toEqual({ path: "src/helper.ts", name: "other", kind: "function" });
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "applied",
      "ok",
    ]);
    expect(result.records[3]?.locator).toEqual({
      path: "src/helper.ts",
      name: "other",
      kind: "function",
    });
    const content = readFileSync(join(dir, "src", "helper.ts"), "utf8");
    expect(content).toContain("export function other(): number {\n  return 2;\n}");
    // The repair prompt shows the modify pin plus the re-pin instruction.
    const repairPrompt = (provider.calls[2] ?? []).at(-1)?.content ?? "";
    expect(repairPrompt).toContain("Edit exchange 1 of 3 failed verification.");
    expect(repairPrompt).toContain('"mode":"modify"');
    expect(repairPrompt).toContain("to re-pin and edit it");
  }, 30000);

  test("a re-pin may not leave the pinned file", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "other.ts"),
      "export function other(): number {\n  return 1;\n}\n",
    );
    const otherAddress = { path: "src/other.ts", symbol: "other", kind: "function" };
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", 'return "nope";'),
      editResponse(null, "function other(): number {\n  return 2;\n}", otherAddress),
      editResponse('return "nope";', "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: signatureCheckCommand(dir, [1, 0]),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "address",
      "applied",
      "ok",
    ]);
    const failed = result.records[3];
    expect(failed?.diagnostics?.startsWith("stage: address\n")).toBe(true);
    expect(failed?.diagnostics).toContain(
      'the payload may re-pin only to another declaration in the pinned file "src/helper.ts"; received path "src/other.ts"',
    );
    // The pin did not move and the other file was not touched.
    expect(failed?.locator).toEqual({ path: "src/helper.ts", name: "answer", kind: "function" });
    expect(result.locator).toEqual({ path: "src/helper.ts", name: "answer", kind: "function" });
    const retryCall = provider.calls[3] ?? [];
    expect(retryCall[2]?.content).toBe(selectionResponse(ANSWER, "modify"));
    expect(readFileSync(join(dir, "src", "other.ts"), "utf8")).toContain("return 1;");
  }, 30000);

  test("a re-pin address must resolve uniquely", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  return 1;\n}\n\nexport class C {\n  m(): number {\n    return 1;\n  }\n}\n\nexport class C {\n  m(): number {\n    return 2;\n  }\n}\n",
    );
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", 'return "nope";'),
      editResponse(null, "function missing(): number {\n  return 1;\n}", {
        path: "src/helper.ts",
        symbol: "missing",
        kind: "function",
      }),
      editResponse(null, "m(): number {\n  return 10;\n}", {
        path: "src/helper.ts",
        symbol: "C.m",
        kind: "method",
      }),
      editResponse('return "nope";', "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: signatureCheckCommand(dir, [1, 0]),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "address",
      "address",
      "applied",
      "ok",
    ]);
    const miss = result.records[3];
    expect(miss?.diagnostics).toContain("stage: address");
    expect(miss?.diagnostics).toContain('the name "missing" is not declared in the indexed source');
    const ambiguous = result.records[4];
    expect(ambiguous?.diagnostics).toContain("stage: address");
    expect(ambiguous?.diagnostics).toContain("matches 2 declarations");
    // Neither failed re-pin moved the pin or wrote anything.
    expect(miss?.locator).toEqual({ path: "src/helper.ts", name: "answer", kind: "function" });
    expect(ambiguous?.locator).toEqual({ path: "src/helper.ts", name: "answer", kind: "function" });
    expect(result.locator).toEqual({ path: "src/helper.ts", name: "answer", kind: "function" });
    const content = readFileSync(join(dir, "src", "helper.ts"), "utf8");
    expect(content).not.toContain("return 10;");
    expect(content).toContain("return 2;");
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
      model: "fake",
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
    expect(retryPrompt).toContain("stage: protocol");
    expect(retryPrompt.indexOf("stage: tsc")).toBeLessThan(retryPrompt.indexOf("stage: protocol"));
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
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    // Exactly one copy of the modifier: the preceding `export ` is kept.
    expect(helperSource(dir)).toBe("export function answer(): number {\n  return 2;\n}\n");
  }, 30000);

  test("finds a matcher that begins with export on an exported declaration", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse(
        "export function answer(): number {\n  return 1;\n}",
        "function answer(): number {\n  return 2;\n}",
      ),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(result.records[1]?.diagnostics).toBeNull();
    expect(helperSource(dir)).toBe("export function answer(): number {\n  return 2;\n}\n");
  }, 30000);

  test("strips a leading export from both the matcher and the whole-declaration replacement", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse(
        "export function answer(): number {\n  return 1;\n}",
        "export function answer(): number {\n  return 2;\n}",
      ),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(result.records[1]?.diagnostics).toBeNull();
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
      model: "fake",
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

  test("accepts whole-declaration matchers with export / export-newline / plain (#50)", async () => {
    const cases = [
      // The literal `export ` shape is already covered above; kept as a guard.
      [
        "export function answer(): number {\n  return 1;\n}",
        "export function answer(): number {\n  return 2;\n}",
      ],
      [
        "export\nfunction answer(): number {\n  return 1;\n}",
        "export\nfunction answer(): number {\n  return 2;\n}",
      ],
      [
        "function answer(): number {\n  return 1;\n}",
        "function answer(): number {\n  return 2;\n}",
      ],
    ] as const;
    for (const [matcher, replacement] of cases) {
      const dir = fixtureDir();
      const provider = new ScriptedProvider([
        selectionResponse(ANSWER, "modify"),
        editResponse(matcher, replacement),
      ]);
      const result = await runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        model: "fake",
        provider,
        checkCommand: TSC,
        testCommand: ["bun", "test"],
      });
      expect(result.ok).toBe(true);
      expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
      expect(result.records[1]?.diagnostics).toBeNull();
      expect(helperSource(dir)).toBe("export function answer(): number {\n  return 2;\n}\n");
    }
  }, 60000);

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
      model: "fake",
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

  test("names a re-pin candidate when the matcher belongs to another declaration", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  return 1;\n}\n\nexport function other(): number {\n  return 7;\n}\n",
    );
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse("return 7;", "return 8;"),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
    const failed = result.records[1];
    expect(failed?.diagnostics).toContain("stage: matcher");
    expect(failed?.diagnostics).toContain(
      'note: the same snippet matches inside function "other" in src/helper.ts — if that is the intended target, return {"path":"src/helper.ts","symbol":"other","kind":"function"} to re-pin',
    );
    const content = helperSource(dir);
    expect(content).toContain("return 2;");
    // The failed edit was never applied to the other declaration.
    expect(content).toContain("return 7;");
  }, 30000);

  test("names a re-pin candidate for an export-newline matcher of another declaration (#50)", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  return 1;\n}\n\nexport function other(): number {\n  return 7;\n}\n",
    );
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse(
        "export\nfunction other(): number {\n  return 7;\n}",
        "function other(): number {\n  return 8;\n}",
      ),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
    expect(result.records[1]?.diagnostics).toContain(
      'note: the same snippet matches inside function "other" in src/helper.ts — if that is the intended target, return {"path":"src/helper.ts","symbol":"other","kind":"function"} to re-pin',
    );
    // The failed edit was never applied to the other declaration.
    expect(helperSource(dir)).toContain("return 7;");
  }, 30000);

  test("repair retries say re-pin while first-round retries say echo", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      "not json",
      editResponse("return 1;", 'return "nope";'),
      "not json",
      editResponse('return "nope";', "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: signatureCheckCommand(dir, [1, 0]),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    // First-round retry (iteration 1, no verification failure): echo wording.
    const firstRoundPrompt = (provider.calls[2] ?? []).at(-1)?.content ?? "";
    expect(firstRoundPrompt).toContain("echo the pinned selection in the address");
    expect(firstRoundPrompt).not.toContain(
      "either the pinned selection or a different declaration",
    );
    // Repair-round retry (iteration 2, opened by failing verification): re-pin wording.
    const repairPrompt = (provider.calls[4] ?? []).at(-1)?.content ?? "";
    expect(repairPrompt).toContain(
      "either the pinned selection or a different declaration in the same file",
    );
    expect(repairPrompt).not.toContain("echo the pinned selection in the address");
    expect(repairPrompt).toContain(
      "A leading `export` matching the declaration's existing modifier is accepted",
    );
  }, 30000);

  test("rejects an identical modify payload after it already applied", async () => {
    const dir = fixtureDir();
    const applied = "function answer(): number {\n  return 2;\n}";
    const corrected = "function answer(): number {\n  return 7;\n}";
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse(null, applied),
      editResponse(null, applied),
      editResponse(null, corrected),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: signatureCheckCommand(dir, [1, 0]),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "repeat",
      "applied",
      "ok",
    ]);
    const repeatRow = result.records[3];
    expect(repeatRow?.kind).toBe("exchange");
    expect(repeatRow?.diagnostics).toContain("stage: repeat");
    expect(repeatRow?.diagnostics).toContain("already applied");
    expect(repeatRow?.diagnostics).toContain("verification still fails");
    expect(repeatRow?.diagnostics).toContain("re-pin to a declaration the diagnostics name");
    // The repeat was never written: only the corrected replacement is on disk.
    expect(helperSource(dir)).toBe("export function answer(): number {\n  return 7;\n}\n");
  }, 30000);

  test("rejects an identical payload after its own rejection, then accepts a changed one", async () => {
    const dir = fixtureDir();
    const rejected = editResponse("return 99;", "return 99;");
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse(null, "function answer(): number {\n  return 2;\n}"),
      rejected,
      rejected,
      editResponse(null, "function answer(): number {\n  return 7;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
      "repeat",
      "applied",
      "ok",
    ]);
    const repeatRow = result.records[4];
    expect(repeatRow?.diagnostics).toContain("stage: repeat");
    expect(repeatRow?.diagnostics).toContain("was just rejected (stage: matcher)");
    expect(repeatRow?.diagnostics).toContain("change the payload");
    expect(helperSource(dir)).toBe("export function answer(): number {\n  return 7;\n}\n");
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
      model: "fake",
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
      model: "fake",
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
      model: "fake",
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
      model: "fake",
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

  test("notes an identical second rejection in the retry prompt", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      editResponse(null, "function answer(): number {\n  return 2;\n}"),
      "not json",
      "not json",
      editResponse(null, "function answer(): number {\n  return 7;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
      "applied",
      "ok",
    ]);
    const note =
      'the previous attempt failed identically; change the shape of the edit (omit "matcher" for a whole-symbol rewrite, adjust the replacement, or re-pin to a different declaration)';
    // The first protocol rejection is shown without the note...
    const firstPrompt = (provider.calls[3] ?? []).at(-1)?.content ?? "";
    expect(firstPrompt).toContain("stage: protocol");
    expect(firstPrompt).not.toContain(note);
    // ...the second, byte-identical one is annotated.
    const secondPrompt = (provider.calls[4] ?? []).at(-1)?.content ?? "";
    expect(secondPrompt).toContain(note);
  }, 30000);

  test("keeps a failing edit on disk and ends edit-exhausted with the verification diagnostics", async () => {
    const dir = fixtureDir();
    const original = helperSource(dir);
    const badEdit = editResponse("return 1;", 'return "nope";');
    const secondBadEdit = editResponse('return "nope";', 'return "nope!";');
    const provider = new ScriptedProvider([
      selectionResponse(ANSWER, "modify"),
      badEdit,
      secondBadEdit,
      "bad",
      "bad",
      "bad",
      "STOP",
      "the replacement never verifies",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
      "protocol",
      "protocol",
      "protocol",
      "stopped",
    ]);
    // No rollback (#30): the last attempted text is what stays on disk.
    const finalSource = helperSource(dir);
    expect(finalSource).toContain('return "nope!";');
    expect(finalSource).not.toBe(original);
    // The summary carries the diagnostics that opened the continued round and
    // the last edit failure.
    expect(result.diagnostics).toContain("edit-exhausted");
    expect(result.diagnostics).toContain("stage: tsc");
    expect(result.diagnostics).toContain("stage: protocol");
    expect(result.diagnostics).toContain("the model replied STOP after 4 rounds");
    expect(provider.calls.length).toBe(8);
    const summaryPrompt = provider.calls[7]?.at(-1)?.content ?? "";
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
      "bad",
      "bad",
      "bad",
      "STOP",
      "the signature stalls",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
    expect(result.records.filter((record) => record.kind === "exchange")).toHaveLength(7);
  }, 30000);

  test("token budget: terminates with exactly one summary call on a pick", async () => {
    const dir = fixtureDir();
    const provider = new UsageProvider(
      ['{"path":"src/helper.ts","symbol":"answer","kind":"function"}', "the budget ran out"],
      [{ total_tokens: 60 }],
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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

  test("token budget: terminates mid-edit without applying the in-flight replacement", async () => {
    const dir = fixtureDir();
    const original = helperSource(dir);
    const provider = new UsageProvider(
      [
        '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
        editResponse("return 1;", 'return "nope";'),
        "the budget ran out",
      ],
      [{ total_tokens: 60 }, { total_tokens: 41 }],
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
      [
        '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
        editResponse("return 1;", "return 2;"),
      ],
      [{ total_tokens: 60 }, { total_tokens: 40 }],
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
      [
        '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
        editResponse("return 1;", 'return "nope";'),
        "summary",
      ],
      [
        { prompt_tokens: 60, completion_tokens: 0 },
        { prompt_tokens: 41, completion_tokens: 0 },
      ],
    );
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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

  test("delete: removes the selected declaration without a provider edit call", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "legacy.ts"),
      "export function legacy(): number {\n  return 7;\n}\n",
    );
    const provider = new ScriptedProvider([
      selectionResponse({ path: "src/legacy.ts", symbol: "legacy", kind: "function" }, "delete"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "remove the unused legacy helper",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("delete");
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "ok"]);
    expect(result.records.map((record) => record.kind)).toEqual(["exchange", "verification"]);
    // Selection is the whole exchange: delete never asks for an edit payload.
    expect(provider.calls).toHaveLength(1);
    const content = readFileSync(join(dir, "src", "legacy.ts"), "utf8");
    expect(content).not.toContain("legacy");
    expect(content.trim()).toBe("");
  }, 30000);

  test("delete: a verification failure terminates with exactly one summary call", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "legacy.ts"),
      "export function legacy(): number {\n  return 7;\n}\n",
    );
    const provider = new ScriptedProvider([
      selectionResponse({ path: "src/legacy.ts", symbol: "legacy", kind: "function" }, "delete"),
      "the deletion broke the project",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "remove the unused legacy helper",
      model: "fake",
      provider,
      checkCommand: failingCommand,
      testCommand: failingCommand,
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("delete-verification-failed");
    expect(result.mode).toBe("delete");
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "tsc"]);
    expect(result.records[1]?.diagnostics).not.toBeNull();
    expect(provider.calls).toHaveLength(2);
    const summaryPrompt = provider.calls[1]?.at(-1)?.content ?? "";
    expect(summaryPrompt).toContain("The run is over: the deletion could not be verified.");
    expectStructuredSummaryPrompt(summaryPrompt);
    expect(result.explanation).toBe("the deletion broke the project");
    // No rollback: the attempted deletion stays on disk.
    const content = readFileSync(join(dir, "src", "legacy.ts"), "utf8");
    expect(content).not.toContain("legacy");
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
      model: "fake",
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

  test("create: appends the replacement when the symbol is missing", async () => {
    const dir = passingFixtureDir();
    const original = helperSource(dir);
    const greetAddress = { path: "src/helper.ts", symbol: "greet", kind: "function" };
    const provider = new ScriptedProvider([
      selectionResponse(greetAddress, "create"),
      createResponse(
        greetAddress,
        "export   function greet ( name : string ) : string { return `hello ${name}` }",
      ),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "add a greet function to helper.ts",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("create");
    expect(result.locator).toEqual({ path: "src/helper.ts", name: "greet", kind: "function" });
    expect(result.filePath).toBe("src/helper.ts");
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    const expected =
      "export function answer(): number {\n  return 2;\n}\n\n" +
      "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n";
    const content = helperSource(dir);
    expect(content).toBe(expected);
    expect(content.startsWith(original)).toBe(true);
    expect(result.editedSource).toBe(content);
    expect(result.messages[3]?.content).toContain("may not exist yet");
    expect(result.messages[3]?.content).toContain('"symbol":"greet"');
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
      model: "fake",
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

  test("create→repair: a failed create whose kept file parses becomes a modify repair", async () => {
    const dir = passingFixtureDir();
    const created = join(dir, "src", "generated.ts");
    const makeAddress = { path: "src/generated.ts", symbol: "make", kind: "function" };
    const badReplacement = 'export function make(): number {\n  return "no";\n}';
    const provider = new ScriptedProvider([
      selectionResponse(makeAddress, "create"),
      createResponse(makeAddress, badReplacement),
      editResponse('return "no";', "return 7;", makeAddress),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "create a generated module",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    // The repair round runs in modify mode against the kept file.
    expect(result.mode).toBe("modify");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "applied",
      "ok",
    ]);
    const content = readFileSync(created, "utf8");
    expect(content).toContain("return 7;");
    expect(content).not.toContain('return "no";');
    // The repair prompt shows the whole kept file plus the diagnostics.
    const repairCall = provider.calls[2] ?? [];
    const repairPrompt = repairCall.at(-1)?.content ?? "";
    expect(repairPrompt).toContain("Edit exchange 1 of 3 failed verification.");
    expect(repairPrompt).toContain("Make minimal corrective changes");
    expect(repairPrompt).toContain("export function make(): number");
    expect(repairPrompt).toContain("not assignable");
    // The pin is relabeled modify in the echoed selection (#48).
    expect(repairPrompt).toContain('"mode":"modify"');
    expect(repairPrompt).not.toContain('"mode":"create"');
  }, 30000);

  test("create→repair: an unparseable kept file is removed and create re-runs", async () => {
    const dir = passingFixtureDir();
    const created = join(dir, "src", "generated.ts");
    const makeAddress = { path: "src/generated.ts", symbol: "make", kind: "function" };
    const badReplacement = 'export function make(): number {\n  return "no";\n}';
    const goodReplacement = "export function make(): number {\n  return 1;\n}";
    const scripted = new ScriptedProvider([
      selectionResponse(makeAddress, "create"),
      createResponse(makeAddress, badReplacement),
      createResponse(makeAddress, goodReplacement),
    ]);
    let keptBeforeRetry: string | null = "unset";
    let calls = 0;
    const provider: ProviderLike = {
      async chat(messages, tools, options) {
        calls += 1;
        if (calls === 3) {
          keptBeforeRetry = existsSync(created) ? readFileSync(created, "utf8") : null;
        }
        return scripted.chat(messages, tools, options);
      },
    };
    const result = await runLoop({
      cwd: dir,
      issue: "create a generated module",
      model: "fake",
      provider,
      checkCommand: corruptOnceCheckCommand(dir, "src/generated.ts"),
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("create");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "tsc",
      "applied",
      "ok",
    ]);
    // The unparseable kept file was removed before the create re-ran.
    expect(keptBeforeRetry).toBeNull();
    const content = readFileSync(created, "utf8");
    expect(content).not.toContain('return "no";');
    expect(content).toContain("return 1;");
    const retryPrompt = scripted.calls[2]?.at(-1)?.content ?? "";
    expect(retryPrompt).toContain("COMPLETE corrected declaration");
    expect(retryPrompt).toContain("Edit exchange 1 of 3 failed verification.");
  }, 30000);

  test("create: rejects a matcher and appends on the retry", async () => {
    const dir = fixtureDir();
    const extra = { path: "src/helper.ts", symbol: "extra", kind: "function" };
    const declaration = "function extra(): number {\n  return 3;\n}";
    const provider = new ScriptedProvider([
      selectionResponse(extra, "create"),
      editResponse("return 1;", declaration, extra),
      createResponse(extra, declaration),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "add an extra helper",
      model: "fake",
      provider,
      checkCommand: passingCommand,
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("create");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "protocol",
      "applied",
      "ok",
    ]);
    expect(result.records[1]?.diagnostics).toContain('mode "create" does not take a "matcher"');
    expect(provider.calls).toHaveLength(3);
    const content = helperSource(dir);
    expect(content.match(/function extra/g)).toHaveLength(1);
  }, 30000);

  test("rejects path-escaping create selections and writes nothing", async () => {
    const dir = passingFixtureDir();
    const original = helperSource(dir);
    const escapedName = `escape-${basename(dir)}.ts`;
    const escaped = join(dir, "..", escapedName);
    const absolute = join(dir, "..", `escape-absolute-${basename(dir)}.ts`);
    const inside = join(dir, "escape-inside.ts");
    const provider = new ScriptedProvider([
      `{"mode":"create","path":"../${escapedName}","symbol":"greet","kind":"function"}`,
      `{"mode":"create","path":${JSON.stringify(absolute)},"symbol":"greet","kind":"function"}`,
      '{"mode":"create","path":"src/../escape-inside.ts","symbol":"greet","kind":"function"}',
      "STOP",
      "cannot write outside the project",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "add a greet function to helper.ts",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "address",
      "address",
      "address",
      "stopped",
    ]);
    for (const record of result.records.slice(0, 3)) {
      expect(record.outcome).toBe("address");
      expect(record.kind).toBe("exchange");
      expect(record.diagnostics).toContain("stage: address");
    }
    // The exhausted selection round continues with a pick-shaped prompt.
    const continuationPrompt = provider.calls[3]?.at(-1)?.content ?? "";
    expect(continuationPrompt).toContain(
      "Round 1 of 32 exhausted its 3-exchange selection budget without a valid pick",
    );
    expect(continuationPrompt).toContain("Reply STOP to end the run");
    expect(existsSync(escaped)).toBe(false);
    expect(existsSync(absolute)).toBe(false);
    expect(existsSync(inside)).toBe(false);
    expect(helperSource(dir)).toBe(original);
  }, 30000);

  test("rejects a kind mismatch naming the kinds the name actually has", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","symbol":"answer","kind":"class"}',
      selectionResponse(ANSWER, "modify"),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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

  test("rejects an address matching two declarations and lists both", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export class C {\n  m(): number {\n    return 1;\n  }\n}\n\nexport class C {\n  m(): number {\n    return 2;\n  }\n}\n",
    );
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","symbol":"C.m","kind":"method"}',
      '{"path":"src/helper.ts","symbol":"C.m","kind":"method"}',
      '{"path":"src/helper.ts","symbol":"C.m","kind":"method"}',
      "STOP",
      "two methods share the address; pick one by its path/symbol/kind",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "address",
      "address",
      "address",
      "stopped",
    ]);
    const failed = result.records[0];
    expect(failed?.diagnostics).toContain("stage: address");
    expect(failed?.diagnostics).toContain("matches 2 declarations");
    expect(failed?.diagnostics).toContain("never picks one silently");
    expect(failed?.diagnostics).toContain("correct the address");
  }, 30000);

  test("retries after a matcher-not-found failure without touching the file", async () => {
    const dir = fixtureDir();
    const original = helperSource(dir);
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
      editResponse("return 99;", "return 2;"),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
    expect(result.records[1]?.diagnostics).toContain(
      'the matcher was not found inside function "answer" in src/helper.ts (line 1, column 8)',
    );
    expect(original).toContain("return 1;");
    expect(helperSource(dir)).toContain("return 2;");

    const retryCall = provider.calls[2] ?? [];
    const retryPrompt = retryCall.at(-1)?.content ?? "";
    expect(retryPrompt).toContain("stage: matcher");
    expect(retryPrompt).toContain("whole-symbol rewrite");
  }, 30000);

  test("reports ambiguous matchers and recovers on the next exchange", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  void 0;\n  void 0;\n  return 1;\n}\n",
    );
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
      editResponse("void 0;", "void 1;"),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
      model: "fake",
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

  test("rejects a whole-symbol no-op with cause no-op before the gate (#59)", async () => {
    const dir = fixtureDir();
    const original = helperSource(dir);
    const noop = editResponse(null, "function answer(): number {\n  return 1;\n}");
    const calls: ChatMessage[][] = [];
    let sourceAtRetry = "";
    const provider: ProviderLike = {
      async chat(messages) {
        calls.push(structuredClone(messages));
        if (calls.length === 1) {
          return { content: selectionResponse(), toolCalls: [], finishReason: "stop", raw: {} };
        }
        if (calls.length === 2) {
          return { content: noop, toolCalls: [], finishReason: "stop", raw: {} };
        }
        if (calls.length === 3) {
          sourceAtRetry = helperSource(dir);
        }
        return {
          content: editResponse("return 1;", "return 2;"),
          toolCalls: [],
          finishReason: "stop",
          raw: {},
        };
      },
    };
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
    expect(result.records.map((record) => record.kind)).toEqual([
      "exchange",
      "exchange",
      "exchange",
      "verification",
    ]);
    const rejected = result.records[1];
    expect(rejected?.cause).toBe("no-op");
    expect(rejected?.diagnostics?.startsWith("stage: no-op\n")).toBe(true);
    expect(rejected?.diagnostics).toContain("the edit does not change the file");
    // The no-op never wrote or verified: the retry still sees the original file.
    expect(sourceAtRetry).toBe(original);
    expect(sourceAtRetry).toContain("return 1;");
    const policy = rejectionPolicy("no-op");
    if (policy.action !== "retry" || policy.correction === null || policy.escalation === null) {
      throw new Error("expected a retryable no-op policy");
    }
    const retryPrompt = calls[2]?.at(-1)?.content ?? "";
    expect(retryPrompt).toContain(policy.correction);
    expect(retryPrompt).not.toContain(policy.escalation);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("rejects a matcher-path no-op with cause no-op (#59)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      editResponse("return 1;", "return 1;"),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
    const rejected = result.records[1];
    expect(rejected?.cause).toBe("no-op");
    expect(rejected?.diagnostics?.startsWith("stage: no-op\n")).toBe(true);
    const policy = rejectionPolicy("no-op");
    if (policy.action !== "retry" || policy.correction === null || policy.escalation === null) {
      throw new Error("expected a retryable no-op policy");
    }
    const retryPrompt = provider.calls[2]?.at(-1)?.content ?? "";
    expect(retryPrompt).toContain(policy.correction);
    expect(retryPrompt).not.toContain(policy.escalation);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("rejects a formatting-normalized run no-op before verification (#59 follow-up)", async () => {
    const dir = fixtureDir();
    writeFileSync(
      join(dir, "src", "helper.ts"),
      "export function answer(): number {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n",
    );
    const original = helperSource(dir);
    // The model copied the run with its source indentation and the replacement
    // equals the matched text: the pre-gate byte check passes (the matched span
    // excludes the leading indent) while oxfmt collapses the doubled indent,
    // so without the format-gate check the apply would change nothing.
    const matcher = "  const a = 1;\n  const b = 2;\n  return a + b;";
    const calls: ChatMessage[][] = [];
    let sourceAtRetry = "";
    const provider: ProviderLike = {
      async chat(messages) {
        calls.push(structuredClone(messages));
        if (calls.length === 1) {
          return { content: selectionResponse(), toolCalls: [], finishReason: "stop", raw: {} };
        }
        if (calls.length === 2) {
          return {
            content: editResponse(matcher, matcher),
            toolCalls: [],
            finishReason: "stop",
            raw: {},
          };
        }
        if (calls.length === 3) {
          sourceAtRetry = helperSource(dir);
        }
        return {
          content: editResponse("return a + b;", "return 2;"),
          toolCalls: [],
          finishReason: "stop",
          raw: {},
        };
      },
    };
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
    const rejected = result.records[1];
    expect(rejected?.cause).toBe("no-op");
    expect(rejected?.diagnostics?.startsWith("stage: no-op\n")).toBe(true);
    expect(rejected?.diagnostics).toContain("the edit does not change the file");
    // The no-op never wrote or verified: the retry still sees the original file
    // and the only verification row belongs to the applied edit.
    expect(sourceAtRetry).toBe(original);
    expect(result.records.filter((record) => record.kind === "verification")).toHaveLength(1);
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
      model: "fake",
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
      model: "fake",
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

  test("rejects plain-text responses as protocol failures and retries with the edit contract", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
      "function answer(): number {\n  return 2;\n}",
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
    expect(result.records[1]?.diagnostics?.startsWith("stage: protocol\n")).toBe(true);
    const retryCall = provider.calls[2] ?? [];
    const retryPrompt = retryCall.at(-1)?.content ?? "";
    expect(retryPrompt).toContain("stage: protocol");
    expect(retryPrompt).toContain('"matcher"');
  }, 30000);

  test("rewrites the whole symbol when the matcher is omitted", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
      editResponse(null, "function answer(): number {\n  return 2;\n}"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(helperSource(dir)).toBe("export function answer(): number {\n  return 2;\n}\n");
  }, 30000);

  test("discards an unparseable edit and leaves the file untouched", async () => {
    const dir = fixtureDir();
    const original = helperSource(dir);
    const gateEdit = editResponse(null, "function answer(): number {\n  return 2;)\n}");
    // A different broken payload: an identical resubmission is `stage: repeat`.
    const secondGateEdit = editResponse(null, "function answer(): number {\n  return 3;)\n}");
    const provider = new ScriptedProvider([
      selectionResponse(),
      gateEdit,
      secondGateEdit,
      "STOP",
      "the edit never parsed",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "gate",
      "gate",
      "stopped",
    ]);
    const failed = result.records[1];
    expect(failed?.diagnostics?.startsWith("stage: gate\n")).toBe(true);
    expect(failed?.diagnostics).toContain("nothing was written");
    expect(failed?.diagnostics).toContain("replacement line 2, column");
    expect(helperSource(dir)).toBe(original);
  }, 30000);

  test("classifies a truncated completion as truncated and asks for a compact retry", async () => {
    const dir = fixtureDir();
    const truncated = 'function answer(): number {\n  return "cut off';
    const calls: ChatMessage[][] = [];
    let beforeRetry = "";
    const provider: ProviderLike = {
      async chat(messages) {
        calls.push(structuredClone(messages));
        if (calls.length === 1) {
          return {
            content: '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
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
          content: editResponse("return 1;", "return 2;"),
          toolCalls: [],
          finishReason: "stop",
          raw: {},
        };
      },
    };
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
    expect(retryPrompt).toContain("Edit exchange 3 of 3 failed.");
  }, 30000);

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
      expect(duplicate.correction).toContain("already declares that symbol");
      expect(duplicate.escalation).toContain("MUST return a replacement that differs");
      // A duplicated-modifier format failure exits instead of retrying.
      expect(rejectionPolicy("format-export-duplication")).toEqual({
        action: "terminate",
        reason: "harness-fault",
      });
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
        model: "fake",
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
        model: "fake",
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
        model: "fake",
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
        model: "fake",
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

    test("a resend carries the repeat lead and escalates on the consecutive one (#65)", async () => {
      const dir = fixtureDir();
      const resend = editResponse("return 1;", "return 2;");
      const provider = new ScriptedProvider([
        selectionResponse(),
        resend,
        resend,
        resend,
        editResponse("return 2;", "return 3;"),
      ]);
      const result = await runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        model: "fake",
        provider,
        // Round 1 applies the resend and fails; round 2 resends it twice
        // (repeat, then repeat again) before a differing edit passes.
        checkCommand: signatureCheckCommand(dir, [1, 0]),
        testCommand: passingCommand,
      });
      expect(result.ok).toBe(true);
      expect(result.records.map((record) => record.outcome)).toEqual([
        "selected",
        "applied",
        "tsc",
        "repeat",
        "repeat",
        "applied",
        "ok",
      ]);
      expect(result.records[3]?.cause).toBe("repeat");
      expect(result.records[4]?.cause).toBe("repeat");
      expect(result.records[3]?.diagnostics).toContain("stage: repeat");
      const policy = rejectionPolicy("repeat");
      if (policy.action !== "retry" || policy.correction === null || policy.escalation === null) {
        throw new Error("expected a retryable repeat policy");
      }
      // The first repeat replaces the default lead with the #65 correction...
      const first = provider.calls[3]?.at(-1)?.content ?? "";
      expect(first).toContain(policy.correction);
      expect(first).not.toContain("Make minimal corrective changes to the current source");
      expect(first).not.toContain(policy.escalation);
      // ...and the second consecutive repeat escalates.
      const second = provider.calls[4]?.at(-1)?.content ?? "";
      expect(second).toContain(policy.escalation);
      expect(second).toContain("stage: repeat");
      expect(result.records.at(-1)?.outcome).toBe("ok");
      expect(helperSource(dir)).toContain("return 3;");
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
        model: "fake",
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
        "The remaining failures still point at replacement line 1: TS2322: synthetic 0.",
      );
      expect(retry).not.toContain(policy.escalation);
      expect(helperSource(dir)).toContain("return 3;");
    }, 30000);

    test("an undeclared re-pin keeps the add path open and escalates (#65)", async () => {
      const dir = fixtureDir();
      const undeclared = { path: "src/helper.ts", symbol: "missing", kind: "function" };
      const provider = new ScriptedProvider([
        selectionResponse(),
        editResponse("return 1;", "return 2;"),
        editResponse(null, "return 2;", undeclared),
        editResponse(null, "return 2;", { ...undeclared, kind: "property" }),
        editResponse("return 2;", "return 3;"),
      ]);
      const result = await runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        model: "fake",
        provider,
        // Round 1 applies and fails; the repair round re-pins twice to a name
        // the file does not declare, then returns a resolvable edit.
        checkCommand: signatureCheckCommand(dir, [1, 0]),
        testCommand: passingCommand,
      });
      expect(result.ok).toBe(true);
      expect(result.records.map((record) => record.outcome)).toEqual([
        "selected",
        "applied",
        "tsc",
        "address",
        "address",
        "applied",
        "ok",
      ]);
      expect(result.records[3]?.cause).toBe("address");
      expect(result.records[4]?.cause).toBe("address");
      const address = rejectionPolicy("address");
      if (
        address.action !== "retry" ||
        address.correction === null ||
        address.escalation === null
      ) {
        throw new Error("expected a retryable address policy");
      }
      // The first undeclared re-pin keeps the add path open instead of the
      // #56 pin-echo wording...
      const first = provider.calls[3]?.at(-1)?.content ?? "";
      expect(first).toContain('The current source declares no symbol named "missing"');
      expect(first).toContain(
        'mode "create" applies only while the run is still choosing a target',
      );
      expect(first).not.toContain(address.correction);
      // ...and the repeated one escalates without closing it.
      const second = provider.calls[4]?.at(-1)?.content ?? "";
      expect(second).toContain("This attempt MUST return an address the current source resolves");
      expect(second).toContain('"missing" is not declared, so re-pinning to it cannot succeed');
      expect(second).toContain(
        'mode "create" applies only while the run is still choosing a target',
      );
      // The guards are unchanged: the edit exchange never created anything.
      expect(helperSource(dir)).toContain("return 3;");
    }, 30000);

    test("a splice-duplicated modifier exits as harness-fault with one summary call (#56)", async () => {
      const dir = fixtureDir();
      const original = helperSource(dir);
      // Valid TypeScript on its own, but `stripLeadingExport` recognizes
      // `export` followed by whitespace, not a comment glued to the keyword,
      // so re-adding the modifier as `export/* keep */function` splices
      // `export export/* keep */` — our parser tolerates it, oxfmt does not.
      // (The `export\n` variant this test used before #50 is now applied by the
      // whitespace-tolerant strip.)
      const duplicated = "export/* keep */function answer(): number {\n  return 2;\n}";
      const provider = new ScriptedProvider([
        selectionResponse(),
        editResponse(null, duplicated),
        "the harness produced the duplicated modifier",
      ]);
      const result = await runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        model: "fake",
        provider,
        checkCommand: TSC,
        testCommand: ["bun", "test"],
      });
      expect(result.ok).toBe(false);
      expect(result.terminationReason).toBe("harness-fault");
      expect(result.records.map((record) => record.outcome)).toEqual(["selected", "format"]);
      expect(result.records[1]?.cause).toBe("format-export-duplication");
      expect(result.records[1]?.diagnostics).toContain("'export' modifier already seen");
      expect(helperSource(dir)).toBe(original);
      // Exactly one summary call follows the rejection: no retry exchange.
      expect(provider.calls).toHaveLength(3);
      const summaryPrompt = provider.calls[2]?.at(-1)?.content ?? "";
      expect(summaryPrompt).toContain(
        "The run is over: the harness produced an invalid edit candidate at the format gate.",
      );
      expect(summaryPrompt).toContain("stage: format");
      expectStructuredSummaryPrompt(summaryPrompt);
      expect(result.explanation).toBe("the harness produced the duplicated modifier");
    }, 30000);
  });

  test("tolerates fences and prose around the edit payload", async () => {
    const dir = fixtureDir();
    const payload = editResponse("return 1;", "return 2;");
    const provider = new ScriptedProvider([
      selectionResponse(),
      `Here is the edit you asked for:\n\`\`\`json\n${payload}\n\`\`\`\n`,
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual(["selected", "applied", "ok"]);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("classifies empty outputs as protocol failures and a continuation STOP ends the run", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      "",
      "",
      "STOP",
      "the model returned nothing",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "protocol",
      "protocol",
      "stopped",
    ]);
  }, 30000);

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
      model: "fake",
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
      model: "fake",
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
      model: "fake",
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
    const locator = JSON.stringify({ path: "../escape.ts", symbol: longName, kind: "function" });
    const longProvider = new ScriptedProvider([locator, locator, locator, "STOP", "unused"]);
    const longResult = await runLoop({
      cwd: longDir,
      issue: "make the answer test pass",
      model: "fake",
      provider: longProvider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(longResult.ok).toBe(false);
    expect(longResult.records).toHaveLength(4);
    for (const record of longResult.records.slice(0, 3)) {
      expect(record.outcome).toBe("address");
      expect(record.replacementChars).toBeNull();
      expect(record.diagnosticsHead).not.toBeNull();
      expect(record.diagnosticsHead?.length).toBeLessThanOrEqual(200);
    }
    const stoppedLong = longResult.records[3];
    expect(stoppedLong?.outcome).toBe("stopped");
    expect(stoppedLong?.diagnosticsHead?.length).toBeLessThanOrEqual(200);
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
      model: "fake",
      provider,
      temperature: 0,
      checkCommand: failingCommand,
      testCommand: failingCommand,
    });
    expect(result.ok).toBe(false);
    expect(provider.optionCalls).toEqual([
      { temperature: 0, reasoningEffort: "none" },
      { temperature: 0, reasoningEffort: "none" },
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
      '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
      "not json",
      "STOP",
      "the symbol does not exist in the project",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      temperature: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(provider.optionCalls).toEqual([
      { temperature: 0, reasoningEffort: "none" },
      { temperature: 0, reasoningEffort: "none" },
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
      '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
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
    const context = provider.calls[0]?.[1]?.content ?? "";
    expect(context).toContain("skipped:");
    expect(context).toContain('"src/broken.ts"');
    expect(context).toContain("unexpected end of input");
    expect(readFileSync(join(dir, "src", "broken.ts"), "utf8")).toBe("function broken( {\n");
  }, 30000);

  test("rejects a skipped file as a target without appending or writing", async () => {
    const dir = brokenFixtureDir();
    const brokenPath = join(dir, "src", "broken.ts");
    const original = readFileSync(brokenPath, "utf8");
    const provider = new ScriptedProvider([
      '{"path":"src/broken.ts","symbol":"broken","kind":"function"}',
      '{"path":"src/broken.ts","symbol":"broken","kind":"function"}',
      '{"path":"src/broken.ts","symbol":"broken","kind":"function"}',
      "STOP",
      "the broken file cannot be selected",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "fix the broken file",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("edit-exhausted");
    expect(result.locator).toBeNull();
    expect(result.records.map((record) => record.outcome)).toEqual([
      "address",
      "address",
      "address",
      "stopped",
    ]);
    expect(result.records[0]?.diagnostics).toContain("stage: address");
    expect(result.records[0]?.diagnostics).toContain("src/broken.ts");
    expect(result.records[0]?.diagnostics).toContain("unexpected end of input");
    expect(result.diagnostics).toContain("edit-exhausted");
    expect(readFileSync(brokenPath, "utf8")).toBe(original);
    expect(result.explanation).toBe("the broken file cannot be selected");
    expect(provider.calls).toHaveLength(5);
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
      model: "fake",
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
        model: "fake",
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
      '{"path":"src/helper.ts","symbol":"answer","kind":"function"}',
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
        model: "fake",
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
      model: "fake",
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
    expect(third).toContain("Edit exchange 1 of 3 failed verification.");
    expect(third).toContain(
      "Failure history: the failing set is unchanged across the last 3 verification rounds.",
    );
    // The #54 ask at round 9 carries the longer-chain count plus the digest.
    const ask = provider.calls[9]?.at(-1)?.content ?? "";
    expect(ask).toContain(`No progress: ${MAX_STALLED_ROUNDS} consecutive failed rounds.`);
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

describe("multi-payload exchanges (#69)", () => {
  test("applies two path-independent payloads atomically and verifies once", async () => {
    const dir = multiFixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse({ path: "src/a.ts", symbol: "one", kind: "function" }),
      batchResponse([
        {
          path: "src/a.ts",
          symbol: "one",
          kind: "function",
          matcher: "return 1;",
          replacement: "return 2;",
        },
        {
          path: "src/b.ts",
          symbol: "two",
          kind: "function",
          matcher: "return 1;",
          replacement: "return 3;",
        },
      ]),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make both declarations satisfy the pair test",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
      multiPayload: true,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "a.ts"), "utf8")).toContain("return 2;");
    expect(readFileSync(join(dir, "src", "b.ts"), "utf8")).toContain("return 3;");
    const applied = result.records.find((record) => record.outcome === "applied");
    expect(applied?.payloads).toBe(2);
    const stats = exchangeStats(result.records);
    expect(stats.payloads).toBe(2);
    expect(stats.applied).toBe(1);
    // The batch ran as one exchange, so it spent one of the shared budget slots.
    expect(applied?.exchange).toBe(2);
  }, 30000);

  test("rejects the whole batch and writes nothing when one payload fails its guard", async () => {
    const dir = multiFixtureDir();
    const before = readFileSync(join(dir, "src", "a.ts"), "utf8");
    const provider = new ScriptedProvider([
      selectionResponse({ path: "src/a.ts", symbol: "one", kind: "function" }),
      batchResponse([
        {
          path: "src/a.ts",
          symbol: "one",
          kind: "function",
          matcher: "return 1;",
          replacement: "return 2;",
        },
        {
          path: "src/b.ts",
          symbol: "two",
          kind: "function",
          matcher: "return 999;",
          replacement: "return 3;",
        },
      ]),
      batchResponse([
        {
          path: "src/a.ts",
          symbol: "one",
          kind: "function",
          matcher: "return 1;",
          replacement: "return 2;",
        },
        {
          path: "src/b.ts",
          symbol: "two",
          kind: "function",
          matcher: "return 1;",
          replacement: "return 3;",
        },
      ]),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make both declarations satisfy the pair test",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
      multiPayload: true,
    });
    expect(result.ok).toBe(true);
    // The failed batch wrote neither file; the retry applied both.
    const rejected = result.records.find(
      (record) => record.outcome !== "applied" && record.kind === "exchange" && record.row === 2,
    );
    expect(rejected?.payloads).toBe(2);
    expect(rejected?.diagnostics).toContain("stage: multi");
    expect(rejected?.diagnostics).toContain("payload 2");
    expect(before).toContain("return 1;");
    expect(readFileSync(join(dir, "src", "a.ts"), "utf8")).toContain("return 2;");
    expect(readFileSync(join(dir, "src", "b.ts"), "utf8")).toContain("return 3;");
    const stats = exchangeStats(result.records);
    expect(stats.rejected).toBe(1);
    expect(stats.applied).toBe(1);
  }, 30000);

  test("rejects a range on a batch payload in an unshown file", async () => {
    const dir = multiFixtureDir();
    const beforeA = readFileSync(join(dir, "src", "a.ts"), "utf8");
    const beforeB = readFileSync(join(dir, "src", "b.ts"), "utf8");
    const provider = new ScriptedProvider([
      selectionResponse({ path: "src/a.ts", symbol: "one", kind: "function" }),
      batchResponse([
        {
          path: "src/a.ts",
          symbol: "one",
          kind: "function",
          matcher: "return 1;",
          replacement: "return 2;",
        },
        {
          path: "src/b.ts",
          symbol: "two",
          kind: "function",
          range: { line: 1, column: 1, endLine: 3, endColumn: 1 },
          replacement: "return 3;",
        },
      ]),
      batchResponse([
        {
          path: "src/a.ts",
          symbol: "one",
          kind: "function",
          matcher: "return 1;",
          replacement: "return 2;",
        },
        {
          path: "src/b.ts",
          symbol: "two",
          kind: "function",
          matcher: "return 1;",
          replacement: "return 3;",
        },
      ]),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make both declarations satisfy the pair test",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
      multiPayload: true,
    });
    expect(result.ok).toBe(true);
    const rejected = result.records.find(
      (record) => record.outcome !== "applied" && record.kind === "exchange" && record.row === 2,
    );
    expect(rejected?.payloads).toBe(2);
    expect(rejected?.diagnostics).toContain("stage: multi");
    expect(rejected?.diagnostics).toContain("payload 2");
    expect(rejected?.diagnostics).toContain("cannot be used");
    // The failed batch wrote neither file; the retry applied both.
    expect(beforeA).toContain("return 1;");
    expect(beforeB).toContain("return 1;");
    expect(readFileSync(join(dir, "src", "a.ts"), "utf8")).toContain("return 2;");
    expect(readFileSync(join(dir, "src", "b.ts"), "utf8")).toContain("return 3;");
  }, 30000);

  test("rejects a batch that targets the same file twice before any splice", async () => {
    const dir = multiFixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse({ path: "src/a.ts", symbol: "one", kind: "function" }),
      batchResponse([
        { path: "src/a.ts", symbol: "one", kind: "function", replacement: "return 2;" },
        { path: "src/a.ts", symbol: "x", kind: "function", replacement: "return 9;" },
      ]),
      batchResponse([
        {
          path: "src/a.ts",
          symbol: "one",
          kind: "function",
          matcher: "return 1;",
          replacement: "return 2;",
        },
        {
          path: "src/b.ts",
          symbol: "two",
          kind: "function",
          matcher: "return 1;",
          replacement: "return 3;",
        },
      ]),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make both declarations satisfy the pair test",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
      multiPayload: true,
    });
    expect(result.ok).toBe(true);
    const duplicate = result.records.find(
      (record) => record.diagnostics?.includes("at most one payload per file") === true,
    );
    expect(duplicate?.cause).toBe("multi-duplicate");
    expect(duplicate?.payloads).toBe(2);
    expect(duplicate?.outcome).toBe("protocol");
  }, 30000);

  test("keeps single-payload behavior when the flag is off", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      selectionResponse(),
      // A batch reply is parsed as a classic payload when the flag is off, so
      // it is a protocol rejection; the next flat reply applies.
      batchResponse([
        {
          path: "src/helper.ts",
          symbol: "answer",
          kind: "function",
          matcher: "return 1;",
          replacement: "return 2;",
        },
      ]),
      editResponse("return 1;", "return 2;"),
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.records[1]?.outcome).toBe("protocol");
    expect(result.records[1]?.payloads).toBe(0);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("offers the batch shape in the system prompt only when enabled", () => {
    expect(buildSystemPrompt()).not.toContain("multi-payload protocol");
    expect(buildSystemPrompt(true)).toContain("multi-payload protocol");
  });
});
