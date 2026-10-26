import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argvRequestsJson, reportUsageError, runMain } from "./main";
import { RESULT_FORMAT } from "./result";
import type { MainIo } from "./main";
import type { ProviderLike } from "./loop";
import type { ChatMessage, ChatOptions, ChatResponse, ToolDefinition } from "./openai";

describe("argvRequestsJson", () => {
  test("true for --format json", () => {
    expect(argvRequestsJson(["--format", "json"])).toBe(true);
  });

  test("true for --format=json", () => {
    expect(argvRequestsJson(["--format=json"])).toBe(true);
  });

  test("false for --format text", () => {
    expect(argvRequestsJson(["--format", "text"])).toBe(false);
  });

  test("false for empty argv", () => {
    expect(argvRequestsJson([])).toBe(false);
  });

  test("false for --format=jsonx", () => {
    expect(argvRequestsJson(["--format=jsonx"])).toBe(false);
  });

  test("true when the JSON request follows another arg", () => {
    expect(argvRequestsJson(["--bogus", "--format", "json"])).toBe(true);
  });
});

function captureIo(): { io: MainIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

describe("reportUsageError", () => {
  test("with a JSON request writes one result to stdout and error + help to stderr", () => {
    const { io, out, err } = captureIo();
    const code = reportUsageError(io, ["--format", "json", "--bogus"], "unknown flag --bogus");
    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!) as Record<string, unknown>;
    expect(parsed.format).toBe(RESULT_FORMAT);
    expect(parsed.status).toBe("failed");
    expect(parsed.verified).toBe(false);
    expect(parsed.diagnostics).toContain("unknown flag --bogus");
    expect(err.some((line) => line.includes("unknown flag --bogus"))).toBe(true);
    expect(err.length).toBeGreaterThan(1);
  });

  test("without a JSON request writes nothing to stdout", () => {
    const { io, out, err } = captureIo();
    const code = reportUsageError(io, ["--format", "text", "--bogus"], "unknown flag --bogus");
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.some((line) => line.includes("unknown flag --bogus"))).toBe(true);
  });
});

const TSC = [
  "bun",
  new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname,
  "--noEmit",
];

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

class ScriptedProvider implements ProviderLike {
  constructor(private readonly responses: string[]) {}

  async chat(
    _messages: ChatMessage[],
    _tools?: ToolDefinition[],
    _options?: ChatOptions,
  ): Promise<ChatResponse> {
    const content = this.responses.shift();
    if (content === undefined) {
      throw new Error("no scripted response left");
    }
    return { content, toolCalls: [], finishReason: "stop", raw: {} };
  }
}

function planExecProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "tcmain-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", strict: true, noEmit: true },
      include: ["src"],
    }),
  );
  writeFileSync(
    join(dir, "src", "helper.ts"),
    "export function answer(): number {\n  return 1;\n}\n",
  );
  writeFileSync(join(dir, "bunfig.toml"), '[test]\nroot = "./src"\n');
  writeFileSync(
    join(dir, "src", "bun-shim.d.ts"),
    [
      'declare module "bun:test" {',
      "  export const test: (name: string, fn: () => void) => void;",
      "  export const expect: (value: unknown) => { toBe: (expected: unknown) => void };",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "src", "helper.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      'import { answer } from "./helper";',
      'test("answer", () => {',
      "  expect(answer()).toBe(2);",
      "});",
      "",
    ].join("\n"),
  );
  return dir;
}

function planExecResponses(): string[] {
  return [
    [
      'plan "01-main"',
      "goal: Make the failing answer test pass.",
      "",
      'node "02-answer" verify test',
      "instruction: Change answer so it returns 2.",
      "hint value answer in src/helper.ts",
      "end",
      "",
      "finish",
    ].join("\n"),
    [
      "select answer in src/helper.ts resolve value",
      "replace with",
      "<<<TC_EDIT_BEGIN>>>",
      "export function answer(): number {",
      "  return 2;",
      "}",
      "<<<TC_EDIT_END>>>",
      "end",
    ].join("\n"),
    "approve",
  ];
}

describe("plan-exec text and JSON output", () => {
  test("text output names the work-node summary and applied files", async () => {
    const dir = planExecProject();
    const { io, out, err } = captureIo();
    const code = await runMain({
      issue: "make the failing test pass",
      cwd: dir,
      provider: new ScriptedProvider(planExecResponses()),
      io,
      agentMode: "plan-exec",
      protocolFormat: "edit-dsl",
      checkCommand: TSC,
      testCommand: ["bun", "test"],
      tokenBudget: 1_000_000,
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toContain("1/1 work node(s) passed");
    expect(out[0]).toContain("applied 1 file(s)");
  }, 60000);

  test("--format json carries @3 WorkNode summaries", async () => {
    const dir = planExecProject();
    const { io, out } = captureIo();
    const code = await runMain({
      issue: "make the failing test pass",
      cwd: dir,
      provider: new ScriptedProvider(planExecResponses()),
      io,
      format: "json",
      agentMode: "plan-exec",
      protocolFormat: "edit-dsl",
      checkCommand: TSC,
      testCommand: ["bun", "test"],
      tokenBudget: 1_000_000,
    });
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0] ?? "") as {
      format: string;
      nodes?: { id: string; verify: string; status: string }[];
    };
    expect(parsed.format).toBe("typescript-coder-result@3");
    expect(parsed.nodes).toEqual([{ id: "02-answer", verify: "test", status: "passed" }]);
  }, 60000);
});
