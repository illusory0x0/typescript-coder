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
  test("defaults to no help, the deepseek-v4.1-flash model, and multi-payload off", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      model: "deepseek-v4.1-flash",
      multiPayload: false,
    });
  });

  test("recognizes --help and -h", () => {
    expect(parseArgs(["--help"])).toEqual({
      help: true,
      model: "deepseek-v4.1-flash",
      multiPayload: false,
    });
    expect(parseArgs(["-h"])).toEqual({
      help: true,
      model: "deepseek-v4.1-flash",
      multiPayload: false,
    });
  });

  test("reads --model with a separate value", () => {
    expect(parseArgs(["--model", "qwen"])).toEqual({
      help: false,
      model: "qwen",
      multiPayload: false,
    });
  });

  test("reads --model=<id>", () => {
    expect(parseArgs(["--model=qwen"])).toEqual({
      help: false,
      model: "qwen",
      multiPayload: false,
    });
  });

  test("reads --multi-payload and its camelCase alias (#69)", () => {
    expect(parseArgs(["--multi-payload"]).multiPayload).toBe(true);
    expect(parseArgs(["--multiPayload"]).multiPayload).toBe(true);
    expect(parseArgs(["--multi-payload", "--model", "qwen"]).multiPayload).toBe(true);
    expect(parseArgs(["--model", "qwen"]).multiPayload).toBe(false);
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
    expect(parseArgs(["--model", "qwen", "--model", "deepseek-v4.1-flash"]).model).toBe(
      "deepseek-v4.1-flash",
    );
    expect(parseArgs(["--model=qwen", "--model=deepseek-v4.1-flash"]).model).toBe(
      "deepseek-v4.1-flash",
    );
    expect(parseArgs(["--help", "--model", "qwen"])).toEqual({
      help: true,
      model: "qwen",
      multiPayload: false,
    });
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

const ADDRESS = { path: "src/helper.ts", symbol: "answer", kind: "function" };
const LOCATOR = JSON.stringify(ADDRESS);

// A v2 edit payload: one flat object with the pinned address, an optional
// matcher, and the replacement.
function editResponse(
  matcher: string | null,
  replacement: string,
  address: { path: string; symbol: string; kind: string } = ADDRESS,
): string {
  const payload: Record<string, string> = { ...address };
  if (matcher !== null) {
    payload["matcher"] = matcher;
  }
  payload["replacement"] = replacement;
  return JSON.stringify(payload);
}

describe("runMain", () => {
  test("applies a verified edit and reports success on stdout", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([LOCATOR, editResponse("return 1;", "return 2;")]);
    const captured = captureIo();
    const code = await runMain({
      issue: "make the answer test pass",
      cwd: dir,
      provider,
      io: captured.io,
    });
    expect(code).toBe(0);
    expect(captured.err).toEqual([]);
    expect(captured.out.join("\n")).toContain("applied");
    expect(captured.out.join("\n")).toContain("src/helper.ts");
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
    // Success writes no failure artifact.
    expect(existsSync(join(dir, "failures"))).toBe(false);
  }, 60000);

  test("surfaces diagnostics on stderr, writes a failure artifact, and prints the explanation last", async () => {
    const dir = fixtureDir();
    const bad = editResponse("return 1;", 'return "no";');
    const explanation = "the symbol cannot satisfy the test without a larger refactor";
    // Iteration 1: a verified-failing edit. Iteration 2: the shared ≤3 budget
    // runs out on protocol failures; the STOP reply ends the run and the
    // summary is the final call.
    const provider = new ScriptedProvider([
      LOCATOR,
      bad,
      "junk",
      "junk",
      "junk",
      "STOP",
      explanation,
    ]);
    const captured = captureIo();
    const code = await runMain({
      issue: "make the answer test pass",
      cwd: dir,
      provider,
      io: captured.io,
    });
    expect(code).toBe(1);
    expect(captured.err.join("\n")).toContain("not assignable");
    expect(captured.err.join("\n")).toContain("edit-exhausted");
    expect(captured.err.join("\n")).not.toContain(explanation);
    expect(captured.out[captured.out.length - 1]).toBe(explanation);
    expect(captured.out.filter((line) => line === explanation)).toHaveLength(1);
    const artifactLine = captured.out.find((line) => line.startsWith("failure artifact: "));
    expect(artifactLine).toBeDefined();
    const artifactPath = artifactLine?.slice("failure artifact: ".length) ?? "";
    expect(artifactPath.startsWith(join(dir, "failures"))).toBe(true);
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = readFileSync(artifactPath, "utf8");
    expect(artifact).toContain("# Run failure — edit-exhausted");
    expect(artifact).toContain("not assignable");
    expect(artifact).toContain(explanation);
    // The artifact line is printed before the explanation.
    expect(captured.out.indexOf(artifactLine ?? "")).toBeLessThan(
      captured.out.indexOf(explanation),
    );
    const finalSource = readFileSync(join(dir, "src", "helper.ts"), "utf8");
    expect(finalSource).toContain('return "no";');
    expect(finalSource).not.toContain("return 1;");
  }, 60000);

  test("rejects an empty issue without calling the provider", async () => {
    const captured = captureIo();
    const provider = new ScriptedProvider([]);
    const code = await runMain({
      issue: "   \n\t ",
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
    const provider = new ScriptedProvider([LOCATOR, editResponse("return 1;", "return 2;")]);
    const captured = captureIo();
    const code = await runMain({
      issue: "make the answer test pass",
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
    const broken = '{"path":"src/broken.ts","symbol":"broken","kind":"function"}';
    const provider = new ScriptedProvider([
      broken,
      broken,
      broken,
      "STOP",
      "the broken file cannot be selected",
    ]);
    const captured = captureIo();
    const code = await runMain({
      issue: "fix the broken file",
      cwd: dir,
      provider,
      io: captured.io,
    });
    expect(code).toBe(1);
    expect(captured.err.join("\n")).toContain("could not be parsed and indexed");
    expect(captured.err.join("\n")).toContain("edit-exhausted");
    expect(captured.out[captured.out.length - 1]).toBe("the broken file cannot be selected");
    expect(readFileSync(join(dir, "src", "broken.ts"), "utf8")).toBe("function broken( {\n");
  }, 60000);

  test("returns 1 with a readable message when the provider throws", async () => {
    const dir = fixtureDir();
    const provider: ProviderLike = {
      async chat() {
        throw new Error("gateway unreachable");
      },
    };
    const captured = captureIo();
    const code = await runMain({
      issue: "make the answer test pass",
      cwd: dir,
      provider,
      io: captured.io,
    });
    expect(code).toBe(1);
    const errText = captured.err.join("\n");
    expect(errText).toContain("provider error");
    expect(errText).toContain("gateway unreachable");
    expect(errText).not.toContain("\n    at ");
    // Provider errors keep their own path: no termination artifact.
    expect(existsSync(join(dir, "failures"))).toBe(false);
  }, 60000);

  test("returns 1 with an error message when the loop itself throws", async () => {
    const captured = captureIo();
    const code = await runMain({
      issue: "make the answer test pass",
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
      '{"path":"src/index.ts","symbol":"greet","kind":"function"}',
      editResponse(
        "function greet(subject: string): string {\n  return `hello, ${subject}`;\n}",
        "function greet(subject: string): string {\n  const greeting = `hello, ${subject}`;\n  return greeting;\n}",
        { path: "src/index.ts", symbol: "greet", kind: "function" },
      ),
    ]);
    const captured = captureIo();
    const code = await runMain({
      issue:
        "Rewrite greet to store the greeting in a local variable, keeping its behavior identical.",
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
