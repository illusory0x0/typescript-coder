import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContextYaml,
  buildReplacementPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  discoverSourceFiles,
  selectSpecFiles,
} from "./loop";
import { REPLAY_BUNDLE_FORMAT } from "./replay-format";
import { parseReplayBundle, ReplayProvider, runReplay, summarizeReplay } from "./replay-runner";
import type { LoopAttempt, LoopResult } from "./loop";
import type { ChatMessage } from "./openai";
import type { ReplayBundle, ReplayCall } from "./replay-format";
import type { ReplayRun } from "./replay-runner";

const TSC_BIN = new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname;
const ISSUE = "make the answer test pass";
const LOCATOR = { path: "src/helper.ts", name: "answer", kind: "function" };
const LOCATOR_JSON = JSON.stringify(LOCATOR);
const ORIGINAL_HELPER = "export function answer(): number {\n  return 1;\n}\n";
// The index records the declaration without the `export` modifier, so the
// replacement prompt shows the bare declaration.
const ANSWER_DECLARATION = "function answer(): number {\n  return 1;\n}";
const FIXED_HELPER = "function answer(): number {\n  return 2;\n}\n";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tsreplay-"));
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

function fixtureRepo(): { repoRoot: string; fixtureDir: string } {
  const repoRoot = tempDir();
  const fixtureDir = join(repoRoot, "project");
  mkdirSync(join(fixtureDir, "src"), { recursive: true });
  writeFileSync(
    join(fixtureDir, "tsconfig.json"),
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
  writeFileSync(join(fixtureDir, "src", "helper.ts"), ORIGINAL_HELPER);
  writeFileSync(
    join(fixtureDir, "src", "helper.test.ts"),
    'import { expect, test } from "bun:test";\nimport { answer } from "./helper";\n\ntest("answer", () => {\n  expect(answer()).toBe(2);\n});\n',
  );
  return { repoRoot, fixtureDir };
}

function recordedCalls(fixtureDir: string): ReplayCall[] {
  const files = discoverSourceFiles(fixtureDir);
  const initial: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    {
      role: "user",
      content: buildUserPrompt(ISSUE, buildContextYaml(files), selectSpecFiles(ISSUE, files)),
    },
  ];
  return [
    {
      messages: initial,
      content: LOCATOR_JSON,
      toolCalls: [],
      finishReason: "stop",
      usage: null,
    },
    {
      messages: [
        ...initial,
        { role: "assistant", content: LOCATOR_JSON },
        { role: "user", content: buildReplacementPrompt(LOCATOR_JSON, ANSWER_DECLARATION) },
      ],
      content: FIXED_HELPER,
      toolCalls: [],
      finishReason: "stop",
      usage: null,
    },
  ];
}

function syntheticBundle(fixture: string, calls: ReplayCall[]): ReplayBundle {
  return {
    format: REPLAY_BUNDLE_FORMAT,
    side: "ts",
    task: "synthetic",
    rep: 1,
    model: "fake",
    issue: ISSUE,
    fixture,
    calls,
  };
}

describe("parseReplayBundle", () => {
  test("rejects invalid JSON and unexpected formats with clear errors", () => {
    expect(() => parseReplayBundle("not json")).toThrow("replay bundle is not valid JSON");
    const stale = JSON.stringify({ ...syntheticBundle("project", []), format: "other@9" });
    expect(() => parseReplayBundle(stale)).toThrow('unsupported replay bundle format: "other@9"');
  });

  test("rejects call entries that are not recorded calls", () => {
    const broken = JSON.stringify({
      ...syntheticBundle("project", []),
      calls: [{ content: "x" }],
    });
    expect(() => parseReplayBundle(broken)).toThrow(
      "replay bundle calls must be an array of recorded calls",
    );
  });
});

describe("ReplayProvider", () => {
  test("returns calls in order, flags prompt mismatches, and reports exhaustion", async () => {
    const provider = new ReplayProvider([
      {
        messages: [{ role: "user", content: "stale prompt" }],
        content: "first response",
        toolCalls: [],
        finishReason: "stop",
        usage: { total_tokens: 7 },
      },
    ]);
    const response = await provider.chat([{ role: "user", content: "fresh prompt" }]);
    expect(response).toEqual({
      content: "first response",
      toolCalls: [],
      finishReason: "stop",
      raw: { usage: { total_tokens: 7 } },
    });
    expect(provider.callsConsumed).toBe(1);
    expect(provider.mismatchedCalls).toEqual([1]);
    await expect(provider.chat([])).rejects.toThrow("bundle exhausted after 1 call(s)");
    expect(provider.exhaustion).toBe("bundle exhausted after 1 call(s)");
    expect(provider.callsConsumed).toBe(1);
  });
});

describe("runReplay", () => {
  test("replays in-order calls through the loop and reports the ok attempt", async () => {
    const { repoRoot, fixtureDir } = fixtureRepo();
    const bundle = parseReplayBundle(
      JSON.stringify(syntheticBundle("project", recordedCalls(fixtureDir))),
    );
    const run = await runReplay({
      bundle,
      bundlePath: "synthetic/in-order.json",
      repoRoot,
      tscBin: TSC_BIN,
      keep: true,
    });
    expect(run.result.ok).toBe(true);
    expect(run.callsConsumed).toBe(2);
    expect(run.callsTotal).toBe(2);
    expect(run.exhaustion).toBeNull();
    expect(run.promptMismatches).toEqual([]);
    expect(run.result.attempts.map((attempt) => attempt.outcome)).toEqual(["ok"]);
    expect(run.workspace.startsWith(join(repoRoot, "tmp", "replay"))).toBe(true);
    expect(readFileSync(join(run.workspace, "src", "helper.ts"), "utf8")).toContain("return 2;");
    const summary = summarizeReplay(run);
    expect(summary).toContain("result: ok");
    expect(summary).toContain("calls: 2/2");
    expect(summary).toContain("prompt mismatches: none");
    expect(summary).toContain("attempt 1: outcome=ok diagnostics=none");
  }, 60000);

  test("reports exhaustion and removes the workspace by default", async () => {
    const { repoRoot, fixtureDir } = fixtureRepo();
    const calls = recordedCalls(fixtureDir).slice(0, 1);
    const bundle = parseReplayBundle(JSON.stringify(syntheticBundle("project", calls)));
    const run = await runReplay({
      bundle,
      bundlePath: "synthetic/exhausted.json",
      repoRoot,
      tscBin: TSC_BIN,
    });
    expect(run.result.ok).toBe(false);
    expect(run.callsConsumed).toBe(1);
    expect(run.callsTotal).toBe(1);
    expect(run.exhaustion).toBe("bundle exhausted after 1 call(s)");
    expect(existsSync(run.workspace)).toBe(false);
    const summary = summarizeReplay(run);
    expect(summary).toContain("result: fail");
    expect(summary).toContain("calls: 1/1");
    expect(summary).toContain("exhaustion: bundle exhausted after 1 call(s)");
    expect(summary).toContain("stopped: provider error: bundle exhausted after 1 call(s)");
    expect(summary).toContain("attempts: none");
  }, 60000);
});

describe("summarizeReplay", () => {
  test("includes attempt outcomes, consumed counts, and prompt mismatches", () => {
    const attempt: LoopAttempt = {
      attempt: 1,
      locator: LOCATOR,
      replacement: null,
      diagnostics: "invalid locator: model did not return a valid locator JSON",
      outcome: "selection-invalid",
      diagnosticsHead: "invalid locator: model did not return a valid locator JSON",
      replacementChars: null,
      finishReason: "stop",
    };
    const result: LoopResult = {
      ok: false,
      locator: null,
      filePath: null,
      editedSource: null,
      attempts: [attempt],
      diagnostics: "could not select a symbol",
      explanation: null,
      messages: [],
    };
    const run: ReplayRun = {
      bundle: syntheticBundle("project", []),
      bundlePath: "synthetic/stale.json",
      workspace: "/nonexistent/replay",
      kept: false,
      callsConsumed: 1,
      callsTotal: 2,
      exhaustion: null,
      promptMismatches: [1],
      result,
    };
    const summary = summarizeReplay(run);
    expect(summary).toContain("result: fail");
    expect(summary).toContain("calls: 1/2");
    expect(summary).toContain("prompt mismatches: call 1");
    expect(summary).toContain("attempt 1: outcome=selection-invalid");
    expect(summary).toContain("stopped: could not select a symbol");
  });
});
