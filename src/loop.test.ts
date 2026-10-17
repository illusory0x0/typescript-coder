import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildAppendPrompt,
  buildContextYaml,
  buildDiagnosticsPrompt,
  buildReplacementPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  discoverSourceFiles,
  parseLocatorResponse,
  parseReplacementResponse,
  runLoop,
  stripCodeFences,
} from "./loop";
import type { ProviderLike } from "./loop";
import type { ChatMessage, ChatResponse, ToolDefinition } from "./openai";
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

const TSC = [
  "bun",
  new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname,
  "--noEmit",
];

type ScriptedResponse = string | { toolCall: { name: string; arguments: string } };

class ScriptedProvider implements ProviderLike {
  readonly calls: ChatMessage[][] = [];

  constructor(private readonly responses: ScriptedResponse[]) {}

  async chat(
    messages: ChatMessage[],
    _tools?: ToolDefinition[],
    _options?: { temperature?: number },
  ): Promise<ChatResponse> {
    this.calls.push(structuredClone(messages));
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

function fixtureDir(): string {
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

function passingFixtureDir(): string {
  const dir = fixtureDir();
  writeFileSync(
    join(dir, "src", "helper.ts"),
    "export function answer(): number {\n  return 2;\n}\n",
  );
  return dir;
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
    const retryMessages = provider.calls[1] ?? [];
    expect(
      retryMessages.some(
        (message) =>
          typeof message.content === "string" && message.content.includes("invalid locator"),
      ),
    ).toBe(true);
    expect(provider.calls[1]?.[0]?.content).toBe(buildSystemPrompt());
    expect(provider.calls[1]?.[1]?.content).toBe(
      buildUserPrompt(issue, buildContextYaml(discoverSourceFiles(dir))),
    );
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
  }, 30000);

  test("rolls back a failing edit and retries with diagnostics", async () => {
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

  test("keeps the prompt prefix append-only and the system prompt stable across runs", async () => {
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
    expect(afterRetry.slice(0, beforeRetry.length)).toEqual(beforeRetry);
    expect(afterRetry.length - beforeRetry.length).toBe(2);
    const tail = afterRetry.slice(beforeRetry.length);
    expect(tail.map((message) => message.role)).toEqual(["assistant", "user"]);
    expect(tail[1]?.content).toContain("failed verification");
  }, 30000);

  test("restores the file and explains after exhausting retries", async () => {
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
      expect(attempt.diagnostics).toContain("src/helper.ts(2,3)");
      expect(attempt.diagnostics).toContain("not assignable");
    }
    expect(result.diagnostics).toContain("src/helper.ts(2,3)");
    expect(result.diagnostics).toContain("not assignable");
    expect(result.diagnostics).toContain("tests failed:");
    expect(result.editedSource).toBeNull();
    expect(result.filePath).toBe("src/helper.ts");
    expect(helperSource(dir)).toBe(original);
    expect(result.explanation).toBe(
      "The symbol cannot satisfy the test without a larger refactor.",
    );

    expect(provider.calls.length).toBe(5);
    const attemptsCall = provider.calls[3] ?? [];
    expect(attemptsCall).toHaveLength(8);
    expect(attemptsCall[attemptsCall.length - 1]?.content).toContain("failed verification");
    expect(attemptsCall[attemptsCall.length - 1]?.content).toContain("src/helper.ts(2,3)");
    expect(attemptsCall[attemptsCall.length - 1]?.content).toContain("not assignable");
    const explainCall = provider.calls[4] ?? [];
    expect(explainCall).toHaveLength(11);
    expect(explainCall[explainCall.length - 1]?.content).toContain("Explain");
    expect(explainCall.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
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

  test("rolls back an appended edit before retrying and restores the original bytes", async () => {
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
    expect(beforeRetry).toBe(original);
    const content = helperSource(dir);
    expect(content).not.toContain("nope");
    expect(content).toContain("return 7;");
    expect(content.startsWith(original)).toBe(true);
  }, 30000);

  test("restores an appended-to file exactly after exhausting retries", async () => {
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
    expect(helperSource(dir)).toBe(original);
    expect(result.explanation).toBe("the appended declaration does not typecheck");
  }, 30000);

  test("deletes a created file on verification failure and recreates it on retry", async () => {
    const dir = passingFixtureDir();
    const created = join(dir, "src", "generated.ts");
    const badReplacement = 'export function make(): number {\n  return "no";\n}';
    const goodReplacement = "export function make(): number {\n  return 1;\n}";
    const scripted = new ScriptedProvider([
      '{"path":"src/generated.ts","name":"make","kind":"function"}',
      badReplacement,
      goodReplacement,
    ]);
    let beforeRetry = true;
    let chats = 0;
    const provider: ProviderLike = {
      async chat(messages, tools, options) {
        chats += 1;
        if (chats === 3) {
          beforeRetry = existsSync(created);
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
    expect(beforeRetry).toBe(false);
    expect(existsSync(created)).toBe(true);
    expect(readFileSync(created, "utf8")).toContain("return 1;");
  }, 30000);

  test("deletes a created file when verification keeps failing", async () => {
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
    expect(existsSync(created)).toBe(false);
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
