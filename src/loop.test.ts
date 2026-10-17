import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildAppendPrompt,
  buildContextYaml,
  buildReplacementPrompt,
  buildRetryPrompt,
  buildSelectionRetryPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  discoverSourceFiles,
  editedRange,
  failingTestNames,
  formatDiagnostics,
  parseLocatorResponse,
  parseReplacementResponse,
  runLoop,
  selectSpecFiles,
  stripCodeFences,
} from "./loop";
import type { ProviderLike } from "./loop";
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
    expect(buildSystemPrompt()).toContain('{ "path": ..., "name": ..., "kind": ... }');
    expect(buildSystemPrompt()).toContain("COMPLETE replacement text");
  });

  test("buildSystemPrompt describes append/create for a missing symbol", () => {
    expect(buildSystemPrompt()).toContain("may not exist yet");
    expect(buildSystemPrompt()).toContain("appends your complete output");
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

  test("buildReplacementPrompt contains the locator and the symbol source", () => {
    const locatorJson = '{"path":"src/a.ts","name":"make","kind":"function"}';
    const symbolSource = "export function make(): number {\n  return 1;\n}\n";
    const prompt = buildReplacementPrompt(locatorJson, symbolSource);
    expect(prompt).toContain(locatorJson);
    expect(prompt).toContain(symbolSource);
    expect(prompt).toContain("```ts");
  });

  test("buildAppendPrompt asks for the complete declaration and notes the file may be missing", () => {
    const locatorJson = '{"path":"src/new.ts","name":"make","kind":"function"}';
    const prompt = buildAppendPrompt(locatorJson, "src/new.ts");
    expect(prompt).toContain(locatorJson);
    expect(prompt).toContain("src/new.ts");
    expect(prompt).toContain("may not exist yet");
    expect(prompt).toContain("COMPLETE code");
  });

  test("buildRetryPrompt reports the attempt, current source, and diagnostics", () => {
    const locatorJson = '{"path":"src/a.ts","name":"make","kind":"function"}';
    const currentSource = 'export function make(): number {\n  return "nope";\n}';
    const diagnostics = "src/a.ts(2,3): error TS2322: Type 'string' is not assignable";
    const prompt = buildRetryPrompt({
      attemptNumber: 2,
      maxAttempts: 3,
      locatorJson,
      currentSource,
      diagnostics,
    });
    expect(prompt).toContain("Attempt 2 of 3 failed verification.");
    expect(prompt).toContain("1 attempt(s) remain");
    expect(prompt).toContain("minimal corrective changes to the current source");
    expect(prompt).toContain(
      "Output the COMPLETE corrected text for the selected region, with no markdown fences and no explanations.",
    );
    expect(prompt).toContain("```json");
    expect(prompt).toContain(locatorJson);
    expect(prompt).toContain("```ts");
    expect(prompt).toContain(currentSource);
    expect(prompt).toContain(diagnostics);
  });

  test("buildSelectionRetryPrompt asks for a corrected locator without replacement wording", () => {
    const diagnostics = "invalid locator: model did not return a valid locator JSON";
    const prompt = buildSelectionRetryPrompt(diagnostics);
    expect(prompt).toContain("locator was rejected");
    expect(prompt).toContain(diagnostics);
    expect(prompt).toContain("```");
    expect(prompt).toContain("no markdown fences");
    expect(prompt).toContain("corrected locator JSON object");
    expect(prompt.toLowerCase()).not.toContain("replacement");
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

describe("parseLocatorResponse", () => {
  test("parses plain JSON", () => {
    expect(parseLocatorResponse('{"path":"src/a.ts","name":"make","kind":"function"}')).toEqual({
      path: "src/a.ts",
      name: "make",
      kind: "function",
    });
  });

  test("parses fenced JSON", () => {
    const content = '```json\n{"path":"src/a.ts","name":"Widget.render","kind":"method"}\n```';
    expect(parseLocatorResponse(content)).toEqual({
      path: "src/a.ts",
      name: "Widget.render",
      kind: "method",
    });
  });

  test("ignores extra fields", () => {
    const content = '{"path":"a.ts","name":"x","kind":"function","extra":1}';
    expect(parseLocatorResponse(content)).toEqual({ path: "a.ts", name: "x", kind: "function" });
  });

  test("throws on a missing field", () => {
    expect(() => parseLocatorResponse('{"path":"a.ts","name":"x"}')).toThrow(
      "model did not return a valid locator JSON",
    );
  });

  test("throws on a non-string field", () => {
    expect(() => parseLocatorResponse('{"path":1,"name":"x","kind":"function"}')).toThrow(
      "model did not return a valid locator JSON",
    );
  });

  test("throws on invalid JSON", () => {
    expect(() => parseLocatorResponse("not json")).toThrow(
      "model did not return a valid locator JSON",
    );
    expect(() => parseLocatorResponse("null")).toThrow("model did not return a valid locator JSON");
  });
});

describe("parseReplacementResponse", () => {
  test("extracts fenced replacement text", () => {
    expect(parseReplacementResponse("```ts\nfunction make(): number {\n  return 42;\n}\n```")).toBe(
      "function make(): number {\n  return 42;\n}",
    );
  });

  test("returns plain text", () => {
    expect(parseReplacementResponse("  const x = 1;  ")).toBe("const x = 1;");
  });

  test("throws on empty or whitespace-only responses", () => {
    expect(() => parseReplacementResponse("")).toThrow("model did not return replacement text");
    expect(() => parseReplacementResponse("   \n  ")).toThrow(
      "model did not return replacement text",
    );
    expect(() => parseReplacementResponse("```ts\n\n```")).toThrow(
      "model did not return replacement text",
    );
  });
});

const TSC = [
  "bun",
  new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname,
  "--noEmit",
];

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

describe("runLoop", () => {
  test("applies, verifies, and returns a successful text response", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      "```ts\nfunction answer(): number {\n  return 2;\n}\n```",
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
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0]?.diagnostics).toBeNull();
    expect(helperSource(dir)).toContain("return 2;");
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content).toBe(buildSystemPrompt());
    expect(result.messages[3]?.content).toContain("```ts");
    expect(provider.calls.length).toBe(2);
  }, 30000);

  test("includes spec file bodies in the initial user prompt", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      "function answer(): number {\n  return 2;\n}\n",
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
          arguments: '{"path":"src/helper.ts","name":"answer","kind":"function"}',
        },
      },
      "function answer(): number {\n  return 2;\n}\n",
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
    expect(result.attempts.length).toBe(1);
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("sends no tools to the provider", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      "function answer(): number {\n  return 2;\n}\n",
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

  test("retries selection after an invalid locator and records the failure", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      "not json",
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      "function answer(): number {\n  return 2;\n}\n",
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
    expect(result.attempts.length).toBe(2);
    expect(result.attempts[0]?.replacement).toBeNull();
    expect(result.attempts[0]?.diagnostics).toContain("invalid locator");

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
    expect(retryPrompt).toBe(buildSelectionRetryPrompt(result.attempts[0]?.diagnostics ?? ""));
    expect(retryPrompt.toLowerCase()).toContain("locator");
    expect(retryPrompt.toLowerCase()).not.toContain("replacement");
    expect(retryPrompt).toContain("no markdown fences");
    expect(retryPrompt).toContain("invalid locator");
    expect(helperSource(dir)).toContain("return 2;");
  }, 30000);

  test("gives up with an explanation when no locator can be selected", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"../escape.ts","name":"nope","kind":"function"}',
      '{"path":"../escape.ts","name":"nope","kind":"function"}',
      "the symbol does not exist in the project",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      maxRetries: 1,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.locator).toBeNull();
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0]?.diagnostics).toContain("invalid locator");
    expect(result.explanation ?? "").not.toBe("");
    expect(helperSource(dir)).toContain("return 1;");

    expect(provider.calls.length).toBe(2);
    const explainCall = provider.calls[1] ?? [];
    expect(explainCall.map((message) => message.role)).toEqual(["system", "user", "user"]);
    expect(explainCall[explainCall.length - 1]?.content).toContain("Explain");
  }, 30000);

  test("keeps a failing edit on disk and retries with diagnostics", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      'function answer(): number {\n  return "nope";\n}',
      "function answer(): number {\n  return 2;\n}\n",
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
    expect(result.attempts.length).toBe(2);
    expect(result.attempts[0]?.diagnostics).not.toBeNull();
    expect(result.attempts[1]?.diagnostics).toBeNull();
    expect(helperSource(dir)).toContain("return 2;");
    const retryMessages = provider.calls[2] ?? [];
    expect(
      retryMessages.some(
        (message) =>
          typeof message.content === "string" && message.content.includes("failed verification"),
      ),
    ).toBe(true);
  }, 30000);

  test("rebuilds a bounded retry history without echoing the previous replacement", async () => {
    const dir = fixtureDir();
    const locator = '{"path":"src/helper.ts","name":"answer","kind":"function"}';
    const badReplacement = 'function answer(): number { return "nope"; }';
    const provider = new ScriptedProvider([
      locator,
      badReplacement,
      "function answer(): number {\n  return 2;\n}\n",
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
    expect(result.attempts.length).toBe(2);
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
    expect(retryCall.some((message) => message.content === badReplacement)).toBe(false);
    const retryPrompt = retryCall[3]?.content ?? "";
    expect(retryPrompt).toContain("Attempt 2 of 3 failed verification.");
    expect(retryPrompt).toContain("1 attempt(s) remain");
    expect(retryPrompt).toContain("not assignable");
    expect(retryPrompt).toContain("Current source:");
    expect(retryPrompt).toContain('return "nope";');
  }, 30000);

  test("keeps the last attempted state on disk after failed verifications (no rollback)", async () => {
    const failingCommand = ["bun", "-e", "process.exit(1)"];
    const badReplacement = 'function answer(): number {\n  return "nope";\n}';

    const replaceDir = fixtureDir();
    const replaceOriginal = helperSource(replaceDir);
    const replaceResult = await runLoop({
      cwd: replaceDir,
      issue: "make the answer test pass",
      model: "fake",
      provider: new ScriptedProvider([
        '{"path":"src/helper.ts","name":"answer","kind":"function"}',
        badReplacement,
        badReplacement,
        badReplacement,
        "the replacement never verifies",
      ]),
      checkCommand: failingCommand,
      testCommand: failingCommand,
    });
    expect(replaceResult.ok).toBe(false);
    expect(replaceResult.attempts.length).toBe(3);
    expect(helperSource(replaceDir)).toContain('return "nope";');
    expect(helperSource(replaceDir)).not.toBe(replaceOriginal);

    const appendDir = passingFixtureDir();
    const created = join(appendDir, "src", "generated.ts");
    const badAppend = 'export function make(): number {\n  return "nope";\n}';
    const appendResult = await runLoop({
      cwd: appendDir,
      issue: "create a generated module",
      model: "fake",
      provider: new ScriptedProvider([
        '{"path":"src/generated.ts","name":"make","kind":"function"}',
        badAppend,
        badAppend,
        badAppend,
        "the generated module never verifies",
      ]),
      checkCommand: failingCommand,
      testCommand: failingCommand,
    });
    expect(appendResult.ok).toBe(false);
    expect(appendResult.attempts.length).toBe(3);
    expect(existsSync(created)).toBe(true);
    expect(readFileSync(created, "utf8")).toContain('return "nope";');
  }, 30000);

  test("maps a real tsc failure to a replacement line and a tsc-stage label", async () => {
    const dir = fixtureDir();
    const badReplacement = 'function answer(): number {\n  return "no";\n}';
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      badReplacement,
      "the replacement never typechecks",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      maxRetries: 1,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0]?.outcome).toBe("tsc");
    const diagnostics = result.attempts[0]?.diagnostics ?? "";
    expect(diagnostics).toContain("stage: tsc");
    expect(diagnostics).toContain("replacement line 1: TS2322:");
    expect(diagnostics).toContain("not assignable");
    expect(diagnostics).toContain('2 |   return "no";');
    expect(diagnostics).toContain("stage: tests");
    expect(
      result.messages.some(
        (message) =>
          typeof message.content === "string" && message.content.includes("replacement line 1:"),
      ),
    ).toBe(true);
  }, 30000);

  test("lists failing test names for a tests-stage failure", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      "function answer(): number {\n  return 1;\n}",
      "the test never passes",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      maxRetries: 1,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0]?.outcome).toBe("tests");
    const diagnostics = result.attempts[0]?.diagnostics ?? "";
    expect(diagnostics).toContain("stage: tests");
    expect(diagnostics).toContain("failing tests:");
    expect(diagnostics).toContain("  - answer");
    expect(diagnostics).not.toContain("stage: tsc");
    expect(
      result.messages.some(
        (message) =>
          typeof message.content === "string" && message.content.includes("failing tests:"),
      ),
    ).toBe(true);
  }, 30000);

  test("runs the sibling test file first and short-circuits on its failure", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      "function answer(): number {\n  return 2;\n}\n",
      "unused",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      maxRetries: 1,
      checkCommand: ["bun", "-e", "process.exit(0)"],
      testCommand: invocationScript(dir, true),
    });
    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0]?.outcome).toBe("tests");
    expect(result.attempts[0]?.diagnostics).toContain("stage: tests");
    expect(invocationLog(dir)).toEqual(["src/helper.test.ts"]);
  }, 30000);

  test("runs the full suite after the sibling test file passes", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      "function answer(): number {\n  return 2;\n}\n",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: ["bun", "-e", "process.exit(0)"],
      testCommand: invocationScript(dir, false),
    });
    expect(result.ok).toBe(true);
    expect(result.attempts[0]?.outcome).toBe("ok");
    expect(invocationLog(dir)).toEqual(["src/helper.test.ts", "(full)"]);
  }, 30000);

  test("keeps the system prompt stable and rebuilds a bounded retry history", async () => {
    const issue = "make the answer test pass";
    const locatorResponse = '{"path":"src/helper.ts","name":"answer","kind":"function"}';
    const goodReplacement = "function answer(): number {\n  return 2;\n}\n";

    const provider = new ScriptedProvider([locatorResponse, goodReplacement]);
    const first = await runLoop({
      cwd: fixtureDir(),
      issue,
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(first.ok).toBe(true);
    expect(provider.calls.length).toBeGreaterThanOrEqual(2);
    const initial = provider.calls[0] ?? [];
    const replacementCall = provider.calls[1] ?? [];
    expect(replacementCall.slice(0, initial.length)).toEqual(initial);
    expect(initial[0]?.role).toBe("system");
    expect(initial[1]?.content).toContain(issue);
    expect(initial[1]?.content).toContain("```yaml");

    const otherProvider = new ScriptedProvider([locatorResponse, goodReplacement]);
    const other = await runLoop({
      cwd: fixtureDir(),
      issue,
      model: "fake",
      provider: otherProvider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(other.ok).toBe(true);
    expect(otherProvider.calls[0]?.[0]).toEqual(initial[0]);

    const retryProvider = new ScriptedProvider([
      locatorResponse,
      'function answer(): number {\n  return "nope";\n}',
      goodReplacement,
    ]);
    const retry = await runLoop({
      cwd: fixtureDir(),
      issue,
      model: "fake",
      provider: retryProvider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(retry.ok).toBe(true);
    const beforeRetry = retryProvider.calls[1] ?? [];
    const afterRetry = retryProvider.calls[2] ?? [];
    expect(beforeRetry.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(afterRetry).toHaveLength(beforeRetry.length);
    expect(afterRetry.slice(0, 3)).toEqual(beforeRetry.slice(0, 3));
    expect(afterRetry[3]?.content).toContain("failed verification");
  }, 30000);

  test("keeps the attempted state and explains after exhausting retries", async () => {
    const issue = "make the answer test pass";
    const dir = fixtureDir();
    const original = helperSource(dir);
    const badReplacement = 'function answer(): number {\n  return "no";\n}';
    const explanation = "```\nThe symbol cannot satisfy the test without a larger refactor.\n```";
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      badReplacement,
      badReplacement,
      badReplacement,
      explanation,
    ]);
    const result = await runLoop({
      cwd: dir,
      issue,
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(3);
    for (const attempt of result.attempts) {
      expect(attempt.replacement).toBe(badReplacement);
      expect(attempt.diagnostics).toContain("stage: tsc");
      expect(attempt.diagnostics).toContain("not assignable");
    }
    expect(result.attempts[0]?.diagnostics).toContain("replacement line 1: TS2322:");
    expect(result.diagnostics).toContain("not assignable");
    expect(result.diagnostics).toContain("tests failed:");
    expect(result.editedSource).toBeNull();
    expect(result.filePath).toBe("src/helper.ts");
    // No rollback (#30): the last attempted text is what stays on disk.
    const finalSource = helperSource(dir);
    expect(finalSource).toContain('return "no";');
    expect(finalSource).not.toBe(original);
    expect(result.explanation).toBe(
      "The symbol cannot satisfy the test without a larger refactor.",
    );

    expect(provider.calls.length).toBe(5);
    const attemptsCall = provider.calls[3] ?? [];
    expect(attemptsCall.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(attemptsCall[attemptsCall.length - 1]?.content).toContain("failed verification");
    expect(attemptsCall[attemptsCall.length - 1]?.content).toContain("not assignable");
    const explainCall = provider.calls[4] ?? [];
    expect(explainCall).toHaveLength(5);
    expect(explainCall[explainCall.length - 1]?.content).toContain("Explain");
    expect(explainCall.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "user",
    ]);
  }, 30000);

  test("appends the replacement when the locator's symbol is missing", async () => {
    const dir = passingFixtureDir();
    const original = helperSource(dir);
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"greet","kind":"function"}',
      "export   function greet ( name : string ) : string { return `hello ${name}` }",
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
    expect(result.mode).toBe("append");
    expect(result.locator).toEqual({ path: "src/helper.ts", name: "greet", kind: "function" });
    expect(result.filePath).toBe("src/helper.ts");
    expect(result.attempts.length).toBe(1);
    const expected =
      "export function answer(): number {\n  return 2;\n}\n\n" +
      "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n";
    const content = helperSource(dir);
    expect(content).toBe(expected);
    expect(content.startsWith(original)).toBe(true);
    expect(result.editedSource).toBe(content);
    expect(result.messages[3]?.content).toContain("may not exist yet");
    expect(result.messages[3]?.content).toContain('"name":"greet"');
  }, 30000);

  test("creates a missing file and its parent directories in append mode", async () => {
    const dir = passingFixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/nested/greeting.ts","name":"greet","kind":"function"}',
      'export   function greet ( ) : string { return "hi" }',
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
    expect(result.mode).toBe("append");
    expect(result.filePath).toBe("src/nested/greeting.ts");
    const content = readFileSync(join(dir, "src", "nested", "greeting.ts"), "utf8");
    expect(content).toBe('export function greet(): string {\n  return "hi";\n}\n');
    expect(result.editedSource).toBe(content);
  }, 30000);

  test("keeps an appended edit on disk before retrying", async () => {
    const dir = passingFixtureDir();
    const original = helperSource(dir);
    const badReplacement = 'export function greet(): number {\n  return "nope";\n}';
    const goodReplacement = "export function greet(): number {\n  return 7;\n}";
    const scripted = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"greet","kind":"function"}',
      badReplacement,
      goodReplacement,
    ]);
    let beforeRetry = "";
    let chats = 0;
    const provider: ProviderLike = {
      async chat(messages, tools, options) {
        chats += 1;
        if (chats === 3) {
          beforeRetry = helperSource(dir);
        }
        return scripted.chat(messages, tools, options);
      },
    };
    const result = await runLoop({
      cwd: dir,
      issue: "add a greet function to helper.ts",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("append");
    expect(result.attempts.length).toBe(2);
    expect(result.attempts[0]?.diagnostics).not.toBeNull();
    expect(result.attempts[1]?.diagnostics).toBeNull();
    expect(beforeRetry).not.toBe(original);
    expect(beforeRetry).toContain("nope");
    expect(beforeRetry.startsWith(original)).toBe(true);
    const content = helperSource(dir);
    expect(content).not.toContain("nope");
    expect(content).toContain("return 7;");
    expect(content.startsWith(original)).toBe(true);
  }, 30000);

  test("keeps the appended declaration after exhausting retries", async () => {
    const dir = passingFixtureDir();
    const original = helperSource(dir);
    const badReplacement = 'export function greet(): number {\n  return "nope";\n}';
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"greet","kind":"function"}',
      badReplacement,
      badReplacement,
      badReplacement,
      "the appended declaration does not typecheck",
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
    expect(result.mode).toBe("append");
    expect(result.attempts.length).toBe(3);
    expect(result.editedSource).toBeNull();
    const content = helperSource(dir);
    expect(content).not.toBe(original);
    expect(content).toContain("nope");
    expect(content.startsWith(original)).toBe(true);
    expect(result.explanation).toBe("the appended declaration does not typecheck");
  }, 30000);

  test("keeps a created file on verification failure and rewrites it on retry", async () => {
    const dir = passingFixtureDir();
    const created = join(dir, "src", "generated.ts");
    const badReplacement = 'export function make(): number {\n  return "no";\n}';
    const goodReplacement = "export function make(): number {\n  return 1;\n}";
    const scripted = new ScriptedProvider([
      '{"path":"src/generated.ts","name":"make","kind":"function"}',
      badReplacement,
      goodReplacement,
    ]);
    let beforeRetry = "";
    let chats = 0;
    const provider: ProviderLike = {
      async chat(messages, tools, options) {
        chats += 1;
        if (chats === 3) {
          beforeRetry = readFileSync(created, "utf8");
        }
        return scripted.chat(messages, tools, options);
      },
    };
    const result = await runLoop({
      cwd: dir,
      issue: "create a generated module",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("append");
    expect(beforeRetry).toContain('return "no";');
    const content = readFileSync(created, "utf8");
    expect(content).not.toContain('return "no";');
    expect(content).toContain("return 1;");
  }, 30000);

  test("keeps the created file with the attempted text when verification keeps failing", async () => {
    const dir = passingFixtureDir();
    const created = join(dir, "src", "generated.ts");
    const badReplacement = 'export function make(): number {\n  return "no";\n}';
    const provider = new ScriptedProvider([
      '{"path":"src/generated.ts","name":"make","kind":"function"}',
      badReplacement,
      badReplacement,
      badReplacement,
      "the generated module never typechecked",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "create a generated module",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("append");
    expect(result.attempts.length).toBe(3);
    expect(existsSync(created)).toBe(true);
    expect(readFileSync(created, "utf8")).toContain('return "no";');
  }, 30000);

  test("rejects path-escaping locators and writes nothing", async () => {
    const dir = passingFixtureDir();
    const original = helperSource(dir);
    const escapedName = `escape-${basename(dir)}.ts`;
    const escaped = join(dir, "..", escapedName);
    const absolute = join(dir, "..", `escape-absolute-${basename(dir)}.ts`);
    const inside = join(dir, "escape-inside.ts");
    const provider = new ScriptedProvider([
      `{"path":"../${escapedName}","name":"greet","kind":"function"}`,
      `{"path":${JSON.stringify(absolute)},"name":"greet","kind":"function"}`,
      '{"path":"src/../escape-inside.ts","name":"greet","kind":"function"}',
      "cannot write outside the project",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "add a greet function to helper.ts",
      model: "fake",
      provider,
      maxRetries: 3,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.locator).toBeNull();
    expect(result.attempts.length).toBe(3);
    for (const attempt of result.attempts) {
      expect(attempt.diagnostics).toContain("invalid locator");
    }
    expect(existsSync(escaped)).toBe(false);
    expect(existsSync(absolute)).toBe(false);
    expect(existsSync(inside)).toBe(false);
    expect(helperSource(dir)).toBe(original);
  }, 30000);
});

describe("runLoop with unparseable files", () => {
  test("fixes a valid target while reporting the skipped file", async () => {
    const dir = brokenFixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      "function answer(): number {\n  return 2;\n}\n",
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
    expect(result.attempts.length).toBe(1);
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
      '{"path":"src/broken.ts","name":"broken","kind":"function"}',
      "the broken file cannot be selected",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "fix the broken file",
      model: "fake",
      provider,
      maxRetries: 1,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.locator).toBeNull();
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0]?.diagnostics).toContain("invalid locator");
    expect(result.attempts[0]?.diagnostics).toContain("src/broken.ts");
    expect(result.attempts[0]?.diagnostics).toContain("unexpected end of input");
    expect(result.diagnostics).toBe("could not select a symbol");
    expect(readFileSync(brokenPath, "utf8")).toBe(original);
    expect(result.explanation).toBe("the broken file cannot be selected");
    expect(provider.calls.length).toBe(2);
  }, 30000);

  test("keeps append mode for a missing file while another file is skipped", async () => {
    const dir = passingBrokenFixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/greeting.ts","name":"greet","kind":"function"}',
      'export function greet(): string { return "hi" }',
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
    expect(result.mode).toBe("append");
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
    const provider: ProviderLike = {
      async chat() {
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
    expect(result.attempts).toEqual([]);
    expect(result.diagnostics).toBe("provider error: gateway unreachable");
    expect(result.explanation ?? "").toContain("no explanation available");
    expect(helperSource(dir)).toContain("return 1;");
  }, 30000);

  test("keeps an applied edit and fails when a later call throws", async () => {
    const dir = fixtureDir();
    const original = helperSource(dir);
    const scripted = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      'function answer(): number {\n  return "nope";\n}',
    ]);
    let calls = 0;
    const provider: ProviderLike = {
      async chat(messages, tools, options) {
        calls += 1;
        if (calls >= 3) {
          throw new Error("gateway dropped");
        }
        return scripted.chat(messages, tools, options);
      },
    };
    const failingCommand = ["bun", "-e", "process.exit(1)"];
    const { unhandled, value: result } = await watchRejections(() =>
      runLoop({
        cwd: dir,
        issue: "make the answer test pass",
        model: "fake",
        provider,
        checkCommand: failingCommand,
        testCommand: failingCommand,
      }),
    );
    expect(unhandled).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("replace");
    expect(result.locator).toEqual({
      path: "src/helper.ts",
      name: "answer",
      kind: "function",
    });
    expect(result.filePath).toBe("src/helper.ts");
    expect(result.editedSource).toBeNull();
    expect(result.diagnostics).toContain("provider error");
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0]?.replacement).toContain("nope");
    expect(result.attempts[0]?.diagnostics).not.toBeNull();
    expect(result.explanation ?? "").toContain("no explanation available");
    expect(helperSource(dir)).toContain('return "nope";');
    expect(helperSource(dir)).not.toBe(original);
  }, 30000);
});

describe("attempt observability", () => {
  test("records an ok outcome with replacement size and finish reason", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      "function answer(): number {\n  return 2;\n}\n",
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
    expect(result.attempts.length).toBe(1);
    const attempt = result.attempts[0];
    expect(attempt?.outcome).toBe("ok");
    expect(attempt?.diagnosticsHead).toBeNull();
    expect(attempt?.replacement).not.toBeNull();
    expect(attempt?.replacementChars).toBe(attempt?.replacement?.length ?? -1);
    expect(attempt?.replacementChars).toBeGreaterThan(0);
    expect(attempt?.finishReason).toBe("stop");
  }, 30000);

  test("bounds diagnosticsHead and nulls replacement size for selection failures", async () => {
    const dir = fixtureDir();
    const longName = "n".repeat(400);
    const locator = JSON.stringify({ path: "../escape.ts", name: longName, kind: "function" });
    const provider = new ScriptedProvider([locator, locator, locator, "unused"]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBe(3);
    for (const attempt of result.attempts) {
      expect(attempt.outcome).toBe("selection-invalid");
      expect(attempt.replacementChars).toBeNull();
      expect(attempt.diagnosticsHead).not.toBeNull();
      expect(attempt.diagnosticsHead?.length).toBeLessThanOrEqual(200);
    }
  }, 30000);

  test("classifies empty outputs as empty-output", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      "",
      "",
      "",
      "unused",
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
    expect(result.attempts.length).toBe(3);
    for (const attempt of result.attempts) {
      expect(attempt.outcome).toBe("empty-output");
    }
  }, 30000);

  test("classifies syntax errors as format failures", async () => {
    const dir = fixtureDir();
    const bad = "function answer(): number {\n  return 2;\n";
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      bad,
      bad,
      bad,
      "unused",
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
    expect(result.attempts.length).toBe(3);
    for (const attempt of result.attempts) {
      expect(attempt.outcome).toBe("format");
      expect(attempt.diagnostics?.startsWith("stage: format\n")).toBe(true);
    }
    const retryMessages = provider.calls[2] ?? [];
    const lastMessage = retryMessages[retryMessages.length - 1]?.content ?? "";
    expect(lastMessage).toContain("stage: format");
  }, 30000);

  test("classifies tsc failures and test-only failures distinctly", async () => {
    const typeError = 'function answer(): number {\n  return "no";\n}';
    const tscDir = fixtureDir();
    const tscProvider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      typeError,
      typeError,
      typeError,
      "unused",
    ]);
    const tscResult = await runLoop({
      cwd: tscDir,
      issue: "make the answer test pass",
      model: "fake",
      provider: tscProvider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(tscResult.ok).toBe(false);
    expect(tscResult.attempts.length).toBe(3);
    for (const attempt of tscResult.attempts) {
      expect(attempt.outcome).toBe("tsc");
    }

    const wrongValue = "function answer(): number {\n  return 1;\n}";
    const testsDir = fixtureDir();
    const testsProvider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      wrongValue,
      wrongValue,
      wrongValue,
      "unused",
    ]);
    const testsResult = await runLoop({
      cwd: testsDir,
      issue: "make the answer test pass",
      model: "fake",
      provider: testsProvider,
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(testsResult.ok).toBe(false);
    expect(testsResult.attempts.length).toBe(3);
    for (const attempt of testsResult.attempts) {
      expect(attempt.outcome).toBe("tests");
    }
  }, 60000);

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
            content: '{"path":"src/helper.ts","name":"answer","kind":"function"}',
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
          content: "function answer(): number {\n  return 2;\n}",
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
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(["truncated", "ok"]);
    expect(result.attempts[0]?.finishReason).toBe("length");
    expect(result.attempts[0]?.replacement).toBe(truncated);
    expect(result.attempts[0]?.diagnostics).toContain("stage: truncated");
    expect(helperSource(dir)).toContain("return 2;");
    // The truncated partial output is never applied or written.
    expect(beforeRetry).not.toContain("cut off");

    const retryCall = calls[2] ?? [];
    expect(retryCall).toHaveLength(4);
    const retryPrompt = retryCall[3]?.content ?? "";
    expect(retryPrompt).toContain("stage: truncated");
    expect(retryPrompt).toContain("more compact replacement");
    expect(retryPrompt).toContain("Attempt 2 of 3 failed verification.");
  }, 30000);
});

describe("staged reasoning policy", () => {
  const passingCommand = ["bun", "-e", "process.exit(0)"];
  const failingCommand = ["bun", "-e", "process.exit(1)"];

  test("runs both selection attempts at low effort and the first edit at the default", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      "not json",
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      "function answer(): number {\n  return 2;\n}\n",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      checkCommand: passingCommand,
      testCommand: passingCommand,
    });
    expect(result.ok).toBe(true);
    expect(provider.optionCalls).toEqual([
      { reasoningEffort: "low" },
      { reasoningEffort: "low" },
      undefined,
    ]);
  }, 30000);

  test("steps generation retries after a failed verification up to medium", async () => {
    const dir = fixtureDir();
    const badReplacement = 'function answer(): number {\n  return "nope";\n}';
    const provider = new ScriptedProvider([
      '{"path":"src/helper.ts","name":"answer","kind":"function"}',
      badReplacement,
      badReplacement,
      badReplacement,
      "the replacement never typechecks",
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
      { temperature: 0, reasoningEffort: "low" },
      { temperature: 0 },
      { temperature: 0, reasoningEffort: "medium" },
      { temperature: 0, reasoningEffort: "medium" },
      { temperature: 0 },
    ]);
  }, 30000);

  test("keeps the explanation call at the default effort", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      '{"path":"../escape.ts","name":"nope","kind":"function"}',
      "the symbol does not exist in the project",
    ]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the answer test pass",
      model: "fake",
      provider,
      maxRetries: 1,
    });
    expect(result.ok).toBe(false);
    expect(provider.optionCalls).toEqual([{ reasoningEffort: "low" }, undefined]);
  }, 30000);
});
