import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runServe, shutdownAck } from "./serve";
import type { ServeDefaults } from "./serve";
import type { ProviderLike } from "./loop";
import type { ChatMessage, ChatResponse, ToolDefinition } from "./openai";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tsserve-"));
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

const ADDRESS = { path: "src/helper.ts", symbol: "answer", kind: "function" };
const LOCATOR = JSON.stringify(ADDRESS);
const LOCATOR_TARGET = { path: ADDRESS.path, name: ADDRESS.symbol, kind: ADDRESS.kind };

function editResponse(matcher: string | null, replacement: string): string {
  const payload: Record<string, string> = { ...ADDRESS };
  if (matcher !== null) {
    payload["matcher"] = matcher;
  }
  payload["replacement"] = replacement;
  return JSON.stringify(payload);
}

const GOOD_EDIT = editResponse("return 1;", "return 2;");
const BAD_EDIT = editResponse("return 1;", 'return "no";');
const RECOVER_EDIT = editResponse('return "no";', "return 2;");

async function* linesOf(items: string[]): AsyncGenerator<string> {
  for (const item of items) {
    yield item;
  }
}

interface Capture {
  out: string[];
  err: string[];
  outSink: (line: string) => void;
  errSink: (line: string) => void;
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, outSink: (line) => out.push(line), errSink: (line) => err.push(line) };
}

function runRequest(fields: Record<string, unknown>): string {
  return JSON.stringify({ issue: "make the failing test pass", ...fields });
}

function defaults(cwd: string): ServeDefaults {
  return { cwd };
}

describe("runServe (#104)", () => {
  test("answers two successive run requests with two result lines", async () => {
    const first = fixtureDir();
    const second = fixtureDir();
    const provider = new ScriptedProvider([LOCATOR, GOOD_EDIT, LOCATOR, GOOD_EDIT]);
    const cap = capture();
    const code = await runServe({
      lines: linesOf([runRequest({ cwd: first }), "", runRequest({ cwd: second })]),
      out: cap.outSink,
      err: cap.errSink,
      provider,
      defaults: defaults(first),
    });
    expect(code).toBe(0);
    expect(cap.out).toHaveLength(2);
    expect(cap.err).toEqual([]);
    const results = cap.out.map((line) => JSON.parse(line));
    expect(results.map((result) => result.verified)).toEqual([true, true]);
    for (const result of results) {
      expect(result.format).toBe("typescript-coder-result@1");
      expect(result.files).toEqual([
        { path: "src/helper.ts", symbol: "answer", kind: "function", outcome: "applied" },
      ]);
    }
    expect(readFileSync(join(first, "src", "helper.ts"), "utf8")).toContain("return 2;");
    expect(readFileSync(join(second, "src", "helper.ts"), "utf8")).toContain("return 2;");
  }, 60000);

  test("honors per-request cwd, targets, tokenBudget, check, and test", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([GOOD_EDIT]);
    const cap = capture();
    const code = await runServe({
      lines: linesOf([
        JSON.stringify({
          issue: "make the failing test pass",
          cwd: dir,
          targets: [ADDRESS],
          tokenBudget: 50000,
          check: "bunx tsc --noEmit",
          test: ["bun", "test"],
          timeout: 60000,
        }),
      ]),
      out: cap.outSink,
      err: cap.errSink,
      provider,
      defaults: defaults(process.cwd()),
    });
    expect(code).toBe(0);
    expect(cap.out).toHaveLength(1);
    const result = JSON.parse(cap.out[0] ?? "");
    expect(result.verified).toBe(true);
    // The per-request `targets` echoes back through the shared result contract.
    expect(result.targets).toEqual([ADDRESS]);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
  }, 60000);

  test("uses the CLI-provided defaults when a request omits a field", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([GOOD_EDIT]);
    const cap = capture();
    await runServe({
      lines: linesOf([runRequest({ cwd: dir })]),
      out: cap.outSink,
      err: cap.errSink,
      provider,
      defaults: { cwd: dir, targets: [LOCATOR_TARGET], multiPayload: false },
    });
    expect(cap.out).toHaveLength(1);
    expect(JSON.parse(cap.out[0] ?? "").targets).toEqual([ADDRESS]);
  }, 60000);

  test("writes a shutdown ack and ends the loop", async () => {
    const provider = new ScriptedProvider([]);
    const cap = capture();
    const code = await runServe({
      lines: linesOf([JSON.stringify({ op: "shutdown" }), runRequest({})]),
      out: cap.outSink,
      err: cap.errSink,
      provider,
      defaults: defaults(process.cwd()),
    });
    expect(code).toBe(0);
    // Only the ack: the following run request is never processed.
    expect(cap.out).toEqual([shutdownAck()]);
    expect(JSON.parse(shutdownAck())).toEqual({
      format: "typescript-coder-serve@1",
      shutdown: true,
    });
  });

  test('accepts the {"shutdown": true} shorthand', async () => {
    const cap = capture();
    await runServe({
      lines: linesOf([JSON.stringify({ shutdown: true })]),
      out: cap.outSink,
      err: cap.errSink,
      provider: new ScriptedProvider([]),
      defaults: defaults(process.cwd()),
    });
    expect(cap.out).toEqual([shutdownAck()]);
  });

  test("returns 0 on EOF with no output", async () => {
    const cap = capture();
    const code = await runServe({
      lines: linesOf([]),
      out: cap.outSink,
      err: cap.errSink,
      provider: new ScriptedProvider([]),
      defaults: defaults(process.cwd()),
    });
    expect(code).toBe(0);
    expect(cap.out).toEqual([]);
    expect(cap.err).toEqual([]);
  });

  test("survives a malformed line and keeps serving the next request", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([LOCATOR, GOOD_EDIT]);
    const cap = capture();
    const code = await runServe({
      lines: linesOf(["this is not json", runRequest({ cwd: dir })]),
      out: cap.outSink,
      err: cap.errSink,
      provider,
      defaults: defaults(dir),
    });
    expect(code).toBe(0);
    expect(cap.out).toHaveLength(2);
    const first = JSON.parse(cap.out[0] ?? "");
    expect(first.format).toBe("typescript-coder-result@1");
    expect(first.status).toBe("failed");
    expect(first.verified).toBe(false);
    expect(first.diagnostics).toContain("malformed JSON");
    const second = JSON.parse(cap.out[1] ?? "");
    expect(second.verified).toBe(true);
  }, 60000);

  test("reports an invalid request as one failed result and keeps serving", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([LOCATOR, GOOD_EDIT]);
    const cap = capture();
    await runServe({
      lines: linesOf([
        JSON.stringify({ issue: "make the test pass", tokenBudget: 0 }),
        runRequest({ cwd: dir }),
      ]),
      out: cap.outSink,
      err: cap.errSink,
      provider,
      defaults: defaults(dir),
    });
    expect(cap.out).toHaveLength(2);
    const first = JSON.parse(cap.out[0] ?? "");
    expect(first.verified).toBe(false);
    expect(first.diagnostics).toContain('"tokenBudget"');
    expect(JSON.parse(cap.out[1] ?? "").verified).toBe(true);
  }, 60000);

  test("survives a failed (verified:false) run and answers the next request", async () => {
    const dir = fixtureDir();
    const explanation = "the symbol cannot satisfy the test without a larger refactor";
    const provider = new ScriptedProvider([
      LOCATOR,
      BAD_EDIT,
      "junk",
      "junk",
      "junk",
      "STOP",
      explanation,
      LOCATOR,
      RECOVER_EDIT,
    ]);
    const cap = capture();
    const code = await runServe({
      lines: linesOf([runRequest({ cwd: dir }), runRequest({ cwd: dir })]),
      out: cap.outSink,
      err: cap.errSink,
      provider,
      defaults: defaults(dir),
    });
    expect(code).toBe(0);
    expect(cap.out).toHaveLength(2);
    const failed = JSON.parse(cap.out[0] ?? "");
    expect(failed.status).toBe("failed");
    expect(failed.verified).toBe(false);
    expect(failed.terminationReason).toBe("edit-exhausted");
    // The recovery request's edit matches `return "no";`, the state the failed
    // run kept on disk (no rollback), so an ok second result proves keep-progress
    // and that the same process answered against it.
    const recovered = JSON.parse(cap.out[1] ?? "");
    expect(recovered.verified).toBe(true);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
    // The failed run's prose went to stderr, not stdout.
    expect(cap.err.join("\n")).toContain(explanation);
    expect(cap.out[0]).not.toContain(explanation);
    // The failure artifact lands under the request's cwd.
    expect(existsSync(join(dir, "failures"))).toBe(true);
  }, 120000);

  test("keeps a failed run's attempted state on disk (no rollback)", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([
      LOCATOR,
      BAD_EDIT,
      "junk",
      "junk",
      "junk",
      "STOP",
      "the symbol cannot satisfy the test",
    ]);
    const cap = capture();
    await runServe({
      lines: linesOf([runRequest({ cwd: dir })]),
      out: cap.outSink,
      err: cap.errSink,
      provider,
      defaults: defaults(dir),
    });
    expect(JSON.parse(cap.out[0] ?? "").verified).toBe(false);
    // A failed-but-gate-passing edit is kept; there is no rollback.
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain('return "no";');
  }, 120000);

  test("rejects an unknown op without crashing", async () => {
    const dir = fixtureDir();
    const provider = new ScriptedProvider([LOCATOR, GOOD_EDIT]);
    const cap = capture();
    await runServe({
      lines: linesOf([JSON.stringify({ op: "pause" }), runRequest({ cwd: dir })]),
      out: cap.outSink,
      err: cap.errSink,
      provider,
      defaults: defaults(dir),
    });
    expect(JSON.parse(cap.out[0] ?? "").diagnostics).toContain("unknown op");
    expect(JSON.parse(cap.out[1] ?? "").verified).toBe(true);
  }, 60000);
});
