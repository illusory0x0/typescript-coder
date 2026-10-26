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
import { AGENT_MODES, canonicalAgentMode } from "./loop";
import { runMain as runMainBase } from "./main";
import type { MainIo } from "./main";
import type { ProviderLike } from "./loop";
import type { ChatMessage, ChatResponse, ToolDefinition } from "./openai";

const repoRoot = new URL("..", import.meta.url).pathname;
const nestedSmoke = existsSync(join(repoRoot, ".nested-smoke"));
// Parallel-safety audit (#36): file-level `bun test --parallel` is safe, but do
// not add `test.concurrent` here — `tempDirs` is shared by `afterEach` cleanup,
// and the self-host case below copies the tree and spawns a nested Bun process.
const tempDirs: string[] = [];

// The runMain tests script JSON responses; the production default is edit-dsl,
// so select JSON explicitly unless a case overrides it.
function runMain(options: Parameters<typeof runMainBase>[0]) {
  return runMainBase({ protocolFormat: "json", ...options });
}

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
  // The full default option set (#80): text format and no sub-agent overrides.
  const DEFAULTS = {
    help: false,
    model: "deepseek-v4.1-flash",
    agentMode: "pinned-repair" as const,
    multiPayload: false,
    protocolFormat: "edit-dsl" as const,
    targets: null,
    format: "text" as const,
    tokenBudget: null,
    checkCommand: null,
    testCommand: null,
    cwd: null,
    commandTimeoutMs: null,
  };

  test("defaults to no help, the deepseek-v4.1-flash model, and multi-payload off", () => {
    expect(parseArgs([])).toEqual(DEFAULTS);
  });

  test("recognizes --help and -h", () => {
    expect(parseArgs(["--help"])).toEqual({ ...DEFAULTS, help: true });
    expect(parseArgs(["-h"])).toEqual({ ...DEFAULTS, help: true });
  });

  test("reads --model with a separate value", () => {
    expect(parseArgs(["--model", "qwen"])).toEqual({ ...DEFAULTS, model: "qwen" });
  });

  test("reads --model=<id>", () => {
    expect(parseArgs(["--model=qwen"])).toEqual({ ...DEFAULTS, model: "qwen" });
  });

  test("reads --multi-payload and its camelCase alias (#69)", () => {
    expect(parseArgs(["--multi-payload"]).multiPayload).toBe(true);
    expect(parseArgs(["--multiPayload"]).multiPayload).toBe(true);
    expect(parseArgs(["--multi-payload", "--model", "qwen"]).multiPayload).toBe(true);
    expect(parseArgs(["--model", "qwen"]).multiPayload).toBe(false);
  });

  test("reads --protocol-format json|edit-dsl, defaulting to edit-dsl (#119)", () => {
    expect(parseArgs([]).protocolFormat).toBe("edit-dsl");
    expect(parseArgs(["--protocol-format", "edit-dsl"]).protocolFormat).toBe("edit-dsl");
    expect(parseArgs(["--protocol-format=edit-dsl"]).protocolFormat).toBe("edit-dsl");
    expect(parseArgs(["--protocol-format", "json"]).protocolFormat).toBe("json");
    expect(parseArgs(["--protocol-format=json"]).protocolFormat).toBe("json");
    expect(parseArgs(["--protocol-format", "edit-dsl", "--model", "qwen"])).toEqual({
      ...DEFAULTS,
      protocolFormat: "edit-dsl",
      model: "qwen",
    });
  });

  test("normalizes the deprecated `compact` alias to edit-dsl (#15)", () => {
    expect(parseArgs(["--protocol-format", "compact"]).protocolFormat).toBe("edit-dsl");
    expect(parseArgs(["--protocol-format=compact"]).protocolFormat).toBe("edit-dsl");
  });

  test("throws on an unknown --protocol-format value (#119)", () => {
    expect(() => parseArgs(["--protocol-format", "yaml"])).toThrow(
      '--protocol-format must be "json" or "edit-dsl"',
    );
    expect(() => parseArgs(["--protocol-format="])).toThrow("--protocol-format requires a value");
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
      ...DEFAULTS,
      help: true,
      model: "qwen",
    });
  });

  test("reads --format text and json, in both value forms, defaulting to text", () => {
    expect(parseArgs([]).format).toBe("text");
    expect(parseArgs(["--format", "text"]).format).toBe("text");
    expect(parseArgs(["--format=json"]).format).toBe("json");
    expect(parseArgs(["--format", "json"]).format).toBe("json");
  });

  test("throws on an invalid --format value", () => {
    expect(() => parseArgs(["--format", "yaml"])).toThrow("--format must be");
    expect(() => parseArgs(["--format=yaml"])).toThrow("--format must be");
    expect(() => parseArgs(["--format="])).toThrow("--format requires a value");
  });

  test("reads --token-budget as a positive integer in both value forms", () => {
    expect(parseArgs(["--token-budget", "1234"]).tokenBudget).toBe(1234);
    expect(parseArgs(["--token-budget=5000"]).tokenBudget).toBe(5000);
  });

  test("throws on a non-positive or non-numeric --token-budget", () => {
    expect(() => parseArgs(["--token-budget", "0"])).toThrow("positive integer");
    expect(() => parseArgs(["--token-budget", "-5"])).toThrow("positive integer");
    expect(() => parseArgs(["--token-budget", "abc"])).toThrow("positive integer");
    expect(() => parseArgs(["--token-budget="])).toThrow("--token-budget requires a value");
  });

  test("splits --check and --test into argv in both value forms", () => {
    expect(parseArgs(["--check", "bun run typecheck"]).checkCommand).toEqual([
      "bun",
      "run",
      "typecheck",
    ]);
    expect(parseArgs(["--check=bun tsc --noEmit"]).checkCommand).toEqual([
      "bun",
      "tsc",
      "--noEmit",
    ]);
    expect(parseArgs(["--test", "bun test"]).testCommand).toEqual(["bun", "test"]);
    expect(parseArgs(["--test=bun test"]).testCommand).toEqual(["bun", "test"]);
  });

  test("throws on an empty --check or --test value", () => {
    expect(() => parseArgs(["--check", ""])).toThrow("--check requires a value");
    expect(() => parseArgs(["--check="])).toThrow("--check requires a value");
    expect(() => parseArgs(["--test", "   "])).toThrow("--test requires a value");
    expect(() => parseArgs(["--test="])).toThrow("--test requires a value");
  });

  test("reads --cwd in both value forms", () => {
    expect(parseArgs(["--cwd", "./project"]).cwd).toBe("./project");
    expect(parseArgs(["--cwd=/abs/path"]).cwd).toBe("/abs/path");
  });

  test("reads --timeout as a positive integer in both value forms", () => {
    expect(parseArgs(["--timeout", "300000"]).commandTimeoutMs).toBe(300000);
    expect(parseArgs(["--timeout=180000"]).commandTimeoutMs).toBe(180000);
  });

  test("defaults --timeout to null and rejects invalid values", () => {
    expect(parseArgs([]).commandTimeoutMs).toBeNull();
    expect(() => parseArgs(["--timeout", "0"])).toThrow("positive integer");
    expect(() => parseArgs(["--timeout", "-5"])).toThrow("positive integer");
    expect(() => parseArgs(["--timeout", "1.5"])).toThrow("positive integer");
    expect(() => parseArgs(["--timeout", "abc"])).toThrow("positive integer");
    expect(() => parseArgs(["--timeout"])).toThrow("--timeout requires a value");
    expect(() => parseArgs(["--timeout="])).toThrow("--timeout requires a value");
  });

  test("reads --targets from a JSON file in both value forms (#81)", () => {
    const file = join(tempDir(), "targets.json");
    writeFileSync(
      file,
      JSON.stringify({ targets: [{ path: "src/a.ts", symbol: "one", kind: "function" }] }),
    );
    const expected = [{ path: "src/a.ts", name: "one", kind: "function" }];
    expect(parseArgs(["--targets", file]).targets).toEqual(expected);
    expect(parseArgs([`--targets=${file}`]).targets).toEqual(expected);
  });

  test("accepts a top-level --targets array (#81)", () => {
    const file = join(tempDir(), "targets.json");
    writeFileSync(file, JSON.stringify([{ path: "src/a.ts", symbol: "one", kind: "function" }]));
    expect(parseArgs(["--targets", file]).targets).toEqual([
      { path: "src/a.ts", name: "one", kind: "function" },
    ]);
  });

  test("throws on a missing or malformed --targets file (#81)", () => {
    expect(() => parseArgs(["--targets", join(tempDir(), "missing.json")])).toThrow(
      "--targets could not read",
    );
    const badJson = join(tempDir(), "bad.json");
    writeFileSync(badJson, "{ not json");
    expect(() => parseArgs(["--targets", badJson])).toThrow("not valid JSON");
    const badShape = join(tempDir(), "shape.json");
    writeFileSync(badShape, JSON.stringify({ nope: [] }));
    expect(() => parseArgs(["--targets", badShape])).toThrow('"targets" array');
    const badEntry = join(tempDir(), "entry.json");
    writeFileSync(badEntry, JSON.stringify([{ path: "src/a.ts", symbol: "one" }]));
    expect(() => parseArgs(["--targets", badEntry])).toThrow('non-empty string "kind"');
    expect(() => parseArgs(["--targets="])).toThrow("--targets requires a value");
  });

  test("parses the full sub-agent flag set together", () => {
    expect(
      parseArgs([
        "--format",
        "json",
        "--token-budget=2000",
        "--check",
        "bun run typecheck",
        "--test=bun test",
        "--cwd",
        "./work",
        "--timeout",
        "240000",
      ]),
    ).toEqual({
      ...DEFAULTS,
      format: "json",
      tokenBudget: 2000,
      checkCommand: ["bun", "run", "typecheck"],
      testCommand: ["bun", "test"],
      cwd: "./work",
      commandTimeoutMs: 240000,
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

  test("documents the tc bin and the sub-agent flags (#80)", () => {
    const text = helpText();
    expect(text).toContain("tc [");
    expect(text).toContain("--format <text|json>");
    expect(text).toContain("--token-budget <n>");
    expect(text).toContain("--check <cmd>");
    expect(text).toContain("--test <cmd>");
    expect(text).toContain("--cwd <dir>");
    expect(text).toContain("--timeout <ms>");
    expect(text).toContain("--protocol-format <json|edit-dsl>");
    expect(text).toContain("edit protocol (default: edit-dsl)");
    expect(text).toContain("`compact` is a");
    expect(text).toContain("deprecated alias for edit-dsl");
    expect(text).toContain("--targets <file>");
    expect(text).toContain("typescript-coder-result@3");
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

  test("--format json emits one result object on stdout for a verified edit (#80)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([LOCATOR, editResponse("return 1;", "return 2;")]);
    const captured = captureIo();
    const code = await runMain({
      issue: "make the answer test pass",
      cwd: dir,
      provider,
      io: captured.io,
      format: "json",
    });
    expect(code).toBe(0);
    // Exactly one line on stdout, and no prose beside it.
    expect(captured.out).toHaveLength(1);
    expect(captured.err).toEqual([]);
    const parsed = JSON.parse(captured.out[0] ?? "");
    expect(parsed.format).toBe("typescript-coder-result@3");
    expect(parsed.status).toBe("ok");
    expect(parsed.verified).toBe(true);
    expect(parsed.files).toEqual([
      { path: "src/helper.ts", symbol: "answer", kind: "function", outcome: "applied" },
    ]);
    expect(parsed.targets).toEqual([]);
    expect(parsed.records).toBeGreaterThan(0);
    expect(parsed.tokens).toEqual({ input: 0, output: 0, total: 0, cacheRead: 0 });
    expect(parsed.terminationReason).toBeNull();
    expect(parsed.diagnostics).toBeNull();
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
  }, 60000);

  test("--format json reports a failing run on stdout and its prose on stderr (#80)", async () => {
    const dir = fixtureDir();
    const bad = editResponse("return 1;", 'return "no";');
    const explanation = "the symbol cannot satisfy the test without a larger refactor";
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
      format: "json",
    });
    expect(code).toBe(1);
    // stdout carries only the single result object.
    expect(captured.out).toHaveLength(1);
    const parsed = JSON.parse(captured.out[0] ?? "");
    expect(parsed.format).toBe("typescript-coder-result@3");
    expect(parsed.status).toBe("failed");
    expect(parsed.verified).toBe(false);
    expect(parsed.terminationReason).toBe("edit-exhausted");
    expect(parsed.diagnostics).toContain("edit-exhausted");
    // The explanation and the human-readable diagnostics are prose on stderr;
    // stdout is only the one JSON line.
    expect(captured.out[0]).not.toContain(explanation);
    const errText = captured.err.join("\n");
    expect(errText).toContain("not assignable");
    expect(errText).toContain("edit-exhausted");
    expect(errText).toContain(explanation);
    // The failure-artifact line is prose, so it goes to stderr too.
    expect(errText).toContain("failure artifact: ");
    // No JSON leaks onto stderr.
    expect(errText).not.toContain("typescript-coder-result@3");
  }, 60000);

  test("--format json emits a failed result for an empty issue (#80)", async () => {
    const captured = captureIo();
    const code = await runMain({
      issue: "   \n\t ",
      cwd: fixtureDir(),
      provider: new ScriptedProvider([]),
      io: captured.io,
      format: "json",
    });
    expect(code).toBe(1);
    expect(captured.out).toHaveLength(1);
    const parsed = JSON.parse(captured.out[0] ?? "");
    expect(parsed.format).toBe("typescript-coder-result@3");
    expect(parsed.status).toBe("failed");
    expect(parsed.verified).toBe(false);
    expect(parsed.diagnostics).toContain("no issue");
    expect(captured.err.join("\n")).toContain("no issue");
  });

  test("--format json emits a failed result when the provider throws (#80)", async () => {
    const provider: ProviderLike = {
      async chat() {
        throw new Error("gateway unreachable");
      },
    };
    const captured = captureIo();
    const code = await runMain({
      issue: "make the answer test pass",
      cwd: fixtureDir(),
      provider,
      io: captured.io,
      format: "json",
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(captured.out[0] ?? "");
    expect(parsed.status).toBe("failed");
    expect(parsed.verified).toBe(false);
    expect(parsed.diagnostics).toContain("gateway unreachable");
    expect(captured.err.join("\n")).toContain("gateway unreachable");
  }, 60000);
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

  test("declares the tc bin and points it at a shebang-runnable file (#80)", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.bin.tc).toBe("./src/main.ts");
    const target = join(repoRoot, pkg.bin.tc);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8").split("\n")[0]?.startsWith("#!")).toBe(true);
  });
});

describe("--mode", () => {
  test("canonical module values and aliases", () => {
    expect(AGENT_MODES).toEqual(["pinned-repair", "plan-exec"]);
    expect(canonicalAgentMode("pinned-repair")).toBe("pinned-repair");
    expect(canonicalAgentMode("plan-exec")).toBe("plan-exec");
    expect(canonicalAgentMode("edit")).toBe("pinned-repair");
    expect(canonicalAgentMode("both")).toBeNull();
    expect(canonicalAgentMode(undefined)).toBeNull();
  });

  test("defaults to the pinned-repair loop", () => {
    expect(parseArgs([]).agentMode).toBe("pinned-repair");
  });

  test("accepts the canonical modes through --mode and --agent-mode", () => {
    expect(parseArgs(["--mode", "pinned-repair"]).agentMode).toBe("pinned-repair");
    expect(parseArgs(["--mode", "plan-exec"]).agentMode).toBe("plan-exec");
    expect(parseArgs(["--agent-mode=pinned-repair"]).agentMode).toBe("pinned-repair");
    expect(parseArgs(["--agent-mode", "plan-exec"]).agentMode).toBe("plan-exec");
  });

  test("maps the deprecated edit alias to the pinned-repair mode", () => {
    expect(parseArgs(["--mode=edit"]).agentMode).toBe("pinned-repair");
  });

  test("rejects an unknown mode with the canonical choices and alias", () => {
    expect(() => parseArgs(["--mode", "planner"])).toThrow(
      '--mode must be "pinned-repair" or "plan-exec" (alias: edit; got "planner")',
    );
    expect(() => parseArgs(["--mode"])).toThrow("--mode requires a value");
  });

  test("rejects both because one CLI process runs one loop", () => {
    expect(() => parseArgs(["--mode", "both"])).toThrow(
      "only valid for the benchmark's --agent-mode",
    );
    expect(() => parseArgs(["--agent-mode=both"])).toThrow("pinned-repair");
  });

  test("plan-exec refuses explicit targets and the frozen json edit protocol", () => {
    const targets = join(tempDir(), "targets.json");
    writeFileSync(targets, JSON.stringify([{ path: "src/a.ts", symbol: "a", kind: "function" }]));
    expect(() => parseArgs(["--mode", "plan-exec", "--targets", targets])).toThrow(
      "cannot be combined with --mode plan-exec",
    );
    expect(() => parseArgs(["--mode", "plan-exec", "--protocol-format", "json"])).toThrow(
      "cannot be combined with it",
    );
    expect(parseArgs(["--mode", "plan-exec", "--protocol-format", "edit-dsl"]).agentMode).toBe(
      "plan-exec",
    );
    expect(parseArgs(["--mode", "edit", "--targets", targets]).agentMode).toBe("pinned-repair");
  });

  test("help names the canonical mode flag, default, and alias", () => {
    const text = helpText();
    expect(text).toContain("--mode <pinned-repair|plan-exec>");
    expect(text).toContain("(default: pinned-repair)");
    expect(text).toContain("deprecated alias: edit");
  });
});

// Parallel-safety audit (#36): this self-host smoke test spawns a nested Bun
// process, so it must run exactly one copied target test (`src/index.test.ts`),
// never the whole copied suite. Fanning out the suite from a `--parallel`
// worker would multiply workers and subprocesses per worker. `.nested-smoke`
// still marks the copy so any future copied test that consults it skips.
test.skipIf(nestedSmoke)(
  "self-host smoke: the agent edits its own src and the copied target test still passes",
  async () => {
    const dir = tempDir();
    cpSync(join(repoRoot, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(repoRoot, "tsconfig.json"), join(dir, "tsconfig.json"));
    // The copied suite's bin test reads package.json (#80), so copy it too.
    cpSync(join(repoRoot, "package.json"), join(dir, "package.json"));
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
      // Keep the nested verification scoped to the copied target test. The
      // explicit spawn below checks the same file, and `just test` already runs
      // the full suite; fanning out the copied suite here exceeds its command
      // timeout and recursively multiplies the work.
      testCommand: ["bun", "test", "src/index.test.ts"],
    });
    expect(code).toBe(0);
    expect(captured.out.join("\n")).toContain("applied");
    expect(readFileSync(join(dir, "src", "index.ts"), "utf8")).toContain("const greeting");
    // One target test proves the applied self-host edit; see the audit note above.
    const tests = Bun.spawnSync(["bun", "test", "src/index.test.ts"], {
      cwd: dir,
      timeout: 240000,
    });
    expect(tests.exitCode).toBe(0);
  },
  300000,
);
