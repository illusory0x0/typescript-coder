import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helpText, parseArgs } from "./cli";
import { runMain } from "./main";
import type { MainIo } from "./main";
import type { ProviderLike } from "./loop";
import type { ChatMessage, ChatResponse, ToolDefinition } from "./openai";

const repoRoot = new URL("..", import.meta.url).pathname;
const nestedSmoke = existsSync(join(repoRoot, ".nested-smoke"));
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tsmain-"));
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

describe("parseArgs", () => {
  test("defaults to no help and the deepseek-v4.1-flash model", () => {
    expect(parseArgs([])).toEqual({ help: false, model: "deepseek-v4.1-flash" });
  });

  test("recognizes --help and -h", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true, model: "deepseek-v4.1-flash" });
    expect(parseArgs(["-h"])).toEqual({ help: true, model: "deepseek-v4.1-flash" });
  });

  test("reads --model with a separate value", () => {
    expect(parseArgs(["--model", "qwen"])).toEqual({ help: false, model: "qwen" });
  });

  test("reads --model=<id>", () => {
    expect(parseArgs(["--model=qwen"])).toEqual({ help: false, model: "qwen" });
  });

  test("throws when --model has no value", () => {
    expect(() => parseArgs(["--model"])).toThrow("--model requires a value");
    expect(() => parseArgs(["--model="])).toThrow("--model requires a value");
  });

  test("throws on unknown arguments", () => {
    expect(() => parseArgs(["--verbose"])).toThrow("unknown argument: --verbose");
    expect(() => parseArgs(["issue.txt"])).toThrow("unknown argument: issue.txt");
  });

  test("keeps the last --model", () => {
    expect(parseArgs(["--model", "qwen", "--model", "deepseek-v4.1-flash"]).model).toBe("deepseek-v4.1-flash");
    expect(parseArgs(["--model=qwen", "--model=deepseek-v4.1-flash"]).model).toBe("deepseek-v4.1-flash");
    expect(parseArgs(["--help", "--model", "qwen"])).toEqual({ help: true, model: "qwen" });
  });
});

describe("helpText", () => {
  test("mentions the tool, stdin, the model flag, and the environment variables", () => {
    const text = helpText();
    expect(text).toContain("typescript-coder");
    expect(text).toContain("stdin");
    expect(text).toContain("--model");
    expect(text).toContain("OPENAI_API_KEY");
    expect(text).toContain("OPENAI_BASE_URL");
  });
});

type ScriptedResponse = string | { toolCall: { name: string; arguments: string } };

class ScriptedProvider implements ProviderLike {
  constructor(private readonly responses: ScriptedResponse[]) {}

  async chat(
    _messages: ChatMessage[],
    _tools?: ToolDefinition[],
    _options?: { temperature?: number },
  ): Promise<ChatResponse> {
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

function fixtureDir(include: string[] = ["src"]): string {
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
        include,
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

function captureIo(): { io: MainIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

const LOCATOR = '{"path":"src/helper.ts","name":"answer","kind":"function"}';

describe("runMain", () => {
  test("applies a verified edit and reports success on stdout", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      LOCATOR,
      "function answer(): number {\n  return 2;\n}\n",
    ]);
    const captured = captureIo();
    const code = await runMain({
      issue: "make the answer test pass",
      model: "fake",
      cwd: dir,
      provider,
      io: captured.io,
    });
    expect(code).toBe(0);
    expect(captured.err).toEqual([]);
    expect(captured.out.join("\n")).toContain("applied");
    expect(captured.out.join("\n")).toContain("src/helper.ts");
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
  }, 60000);

  test("surfaces diagnostics on stderr and the explanation last on stdout", async () => {
    const dir = fixtureDir();
    const bad = 'function answer(): number {\n  return "no";\n}';
    const explanation = "the symbol cannot satisfy the test without a larger refactor";
    const provider = new ScriptedProvider([LOCATOR, bad, bad, bad, explanation]);
    const captured = captureIo();
    const code = await runMain({
      issue: "make the answer test pass",
      model: "fake",
      cwd: dir,
      provider,
      io: captured.io,
    });
    expect(code).toBe(1);
    expect(captured.err.join("\n")).toContain("not assignable");
    expect(captured.err.join("\n")).not.toContain(explanation);
    expect(captured.out[captured.out.length - 1]).toBe(explanation);
    expect(captured.out.filter((line) => line === explanation)).toHaveLength(1);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 1;");
  }, 60000);

  test("rejects an empty issue without calling the provider", async () => {
    const captured = captureIo();
    const provider = new ScriptedProvider([]);
    const code = await runMain({
      issue: "   \n\t ",
      model: "fake",
      cwd: fixtureDir(),
      provider,
      io: captured.io,
    });
    expect(code).toBe(1);
    expect(captured.err.join("\n")).toContain("no issue");
  });

  test("tolerates an unparseable file elsewhere in the project", async () => {
    const dir = fixtureDir(["src/helper.ts"]);
    writeFileSync(join(dir, "src", "broken.ts"), "function broken( {\n");
    const provider = new ScriptedProvider([
      LOCATOR,
      "function answer(): number {\n  return 2;\n}\n",
    ]);
    const captured = captureIo();
    const code = await runMain({
      issue: "make the answer test pass",
      model: "fake",
      cwd: dir,
      provider,
      io: captured.io,
    });
    expect(code).toBe(0);
    expect(captured.out.join("\n")).toContain("applied");
    expect(captured.out.join("\n")).toContain("src/helper.ts");
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
    expect(readFileSync(join(dir, "src", "broken.ts"), "utf8")).toBe("function broken( {\n");
  }, 60000);

  test("fails cleanly when the intended target is unparseable", async () => {
    const dir = fixtureDir(["src/helper.ts"]);
    writeFileSync(join(dir, "src", "broken.ts"), "function broken( {\n");
    const provider = new ScriptedProvider([
      '{"path":"src/broken.ts","name":"broken","kind":"function"}',
      "the broken file cannot be selected",
    ]);
    const captured = captureIo();
    const code = await runMain({
      issue: "fix the broken file",
      model: "fake",
      cwd: dir,
      provider,
      io: captured.io,
      maxRetries: 1,
    });
    expect(code).toBe(1);
    expect(captured.err.join("\n")).toContain("could not select a symbol");
    expect(readFileSync(join(dir, "src", "broken.ts"), "utf8")).toBe("function broken( {\n");
  }, 60000);

  test("returns 1 with a readable message when the provider throws", async () => {
    const provider: ProviderLike = {
      async chat() {
        throw new Error("gateway unreachable");
      },
    };
    const captured = captureIo();
    const code = await runMain({
      issue: "make the answer test pass",
      model: "fake",
      cwd: fixtureDir(),
      provider,
      io: captured.io,
    });
    expect(code).toBe(1);
    const errText = captured.err.join("\n");
    expect(errText).toContain("provider error");
    expect(errText).toContain("gateway unreachable");
    expect(errText).not.toContain("\n    at ");
  }, 60000);

  test("returns 1 with an error message when the loop itself throws", async () => {
    const captured = captureIo();
    const code = await runMain({
      issue: "make the answer test pass",
      model: "fake",
      cwd: join(tempDir(), "missing"),
      provider: new ScriptedProvider([]),
      io: captured.io,
    });
    expect(code).toBe(1);
    const errText = captured.err.join("\n");
    expect(errText).toContain("error:");
    expect(errText).not.toContain("\n    at ");
  });
});

function spawnHelp(script: string): { code: number | null; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", "run", script, "--help"], {
    cwd: repoRoot,
    stdin: "ignore",
    timeout: 30000,
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("cli entry points", () => {
  test("bun run src/cli.ts --help prints help and exits 0", () => {
    const result = spawnHelp("src/cli.ts");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("typescript-coder");
    expect(result.stdout).toContain("--model");
  });

  test("bun run src/main.ts --help prints help and exits 0 before reading stdin", () => {
    const result = spawnHelp("src/main.ts");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("typescript-coder");
    expect(result.stdout).toContain("--model");
  });
});

test.skipIf(nestedSmoke)(
  "self-host smoke: the agent edits its own src and the copied test suite still passes",
  async () => {
    const dir = tempDir();
    cpSync(join(repoRoot, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(repoRoot, "tsconfig.json"), join(dir, "tsconfig.json"));
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
    writeFileSync(join(dir, ".nested-smoke"), "this copy runs under the self-host smoke test\n");
    const provider = new ScriptedProvider([
      '{"path":"src/index.ts","name":"greet","kind":"function"}',
      "function greet(subject: string): string {\n  const greeting = `hello, ${subject}`;\n  return greeting;\n}\n",
    ]);
    const captured = captureIo();
    const code = await runMain({
      issue:
        "Rewrite greet to store the greeting in a local variable, keeping its behavior identical.",
      model: "fake",
      cwd: dir,
      provider,
      io: captured.io,
    });
    expect(code).toBe(0);
    expect(captured.out.join("\n")).toContain("applied");
    expect(readFileSync(join(dir, "src", "index.ts"), "utf8")).toContain("const greeting");
    const tests = Bun.spawnSync(["bun", "test"], { cwd: dir, timeout: 240000 });
    expect(tests.exitCode).toBe(0);
  },
  300000,
);
