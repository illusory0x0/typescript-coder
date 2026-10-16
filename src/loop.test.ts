import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContextYaml,
  buildDiagnosticsPrompt,
  buildReplacementPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  discoverSourceFiles,
  parseLocatorResponse,
  parseReplacementResponse,
  stripCodeFences,
} from "./loop";
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

    const files = discoverSourceFiles(dir);
    expect(files.map((file) => file.path)).toEqual(["a.ts", "sub/b.ts"]);
    expect(files[0]?.source).toBe("export const a = 1;\n");
    expect(files[1]?.source).toBe("export const b = 2;\n");
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
});

describe("prompt builders", () => {
  test("buildSystemPrompt returns a stable string", () => {
    expect(buildSystemPrompt()).toBe(buildSystemPrompt());
    expect(buildSystemPrompt()).toContain('{ "path": ..., "name": ..., "kind": ... }');
    expect(buildSystemPrompt()).toContain("COMPLETE replacement text");
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

  test("buildReplacementPrompt contains the locator and the symbol source", () => {
    const locatorJson = '{"path":"src/a.ts","name":"make","kind":"function"}';
    const symbolSource = "export function make(): number {\n  return 1;\n}\n";
    const prompt = buildReplacementPrompt(locatorJson, symbolSource);
    expect(prompt).toContain(locatorJson);
    expect(prompt).toContain(symbolSource);
    expect(prompt).toContain("```ts");
  });

  test("buildDiagnosticsPrompt reports the failure and includes diagnostics", () => {
    const diagnostics = "src/a.ts(2,3): error TS2322: Type 'string' is not assignable";
    const prompt = buildDiagnosticsPrompt(diagnostics);
    expect(prompt).toContain("failed verification");
    expect(prompt).toContain(diagnostics);
    expect(prompt).toContain("COMPLETE replacement");
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
