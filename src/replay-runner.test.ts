import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEditDslDetailsPrompt,
  buildEditDslModifiedPrompt,
  buildEditDslSymbolIndex,
  buildEditDslUserPrompt,
  buildSystemPrompt,
  discoverSourceFiles,
  selectSpecFiles,
} from "./loop";
import { REPLAY_BUNDLE_FORMAT, ReplayRecorder } from "./replay-format";
import { parseReplayBundle, ReplayProvider, runReplay, summarizeReplay } from "./replay-runner";
import { serializeSelections } from "./selection";
import { buildIndexTolerant } from "./utility";
import type { LoopRecord, LoopResult } from "./loop";
import type { ChatMessage } from "./openai";
import type { ReplayBundle, ReplayCall } from "./replay-format";
import type { ReplayRun } from "./replay-runner";

const TSC_BIN = new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname;
const ISSUE = "make the answer test pass";
const LOCATOR = { path: "src/helper.ts", name: "answer", kind: "function" };
const ORIGINAL_HELPER = "export function answer(): number {\n  return 1;\n}\n";
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

// EditDsl is the default protocol, so the recorded prompts are the Goal/index
// user prompt, then the `# details` prompt after the viewer pick. The edit-dsl
// edit reply is serialized by the grammar itself, mirroring what the loop
// teaches and parses.
function editDslRecordedCalls(fixtureDir: string): ReplayCall[] {
  const files = discoverSourceFiles(fixtureDir);
  const indexText = buildEditDslSymbolIndex(buildIndexTolerant(files).index);
  const specFiles = selectSpecFiles(ISSUE, files);
  const systemMessage: ChatMessage = {
    role: "system",
    content: buildSystemPrompt(),
  };
  const userMessage: ChatMessage = {
    role: "user",
    content: buildEditDslUserPrompt(ISSUE, indexText, specFiles),
  };
  const initial: ChatMessage[] = [systemMessage, userMessage];
  const pick = "select answer in src/helper.ts resolve value end";
  const declaration = "export function answer(): number {\n  return 1;\n}";
  const edit = serializeSelections([
    {
      locator: LOCATOR,
      space: null,
      matcher: { kind: "snippet", value: "return 1;" },
      pick: null,
      replacement: "return 2;",
    },
  ]);
  const initialMessages: ChatMessage[] = [
    ...initial,
    { role: "assistant", content: pick },
    {
      role: "user",
      content: buildEditDslDetailsPrompt(ISSUE, indexText, declaration, specFiles, 1),
    },
  ];
  // A verified edit-dsl edit gets one `# modified text` confirmation turn; prose
  // there ends the run. The loop's confirmation prompt carries no spec-files
  // section.
  const modified = "export function answer(): number {\n  return 2;\n}";
  return [
    {
      messages: initial,
      content: pick,
      toolCalls: [],
      finishReason: "stop",
      usage: null,
    },
    {
      messages: initialMessages,
      content: edit,
      toolCalls: [],
      finishReason: "stop",
      usage: null,
    },
    {
      messages: [
        systemMessage,
        userMessage,
        { role: "assistant", content: edit },
        { role: "user", content: buildEditDslModifiedPrompt(ISSUE, indexText, modified, 1) },
      ],
      content: "Great! I resolve this problem!",
      toolCalls: [],
      finishReason: "stop",
      usage: null,
    },
  ];
}

function syntheticBundle(fixture: string, calls: ReplayCall[]): ReplayBundle {
  return {
    format: REPLAY_BUNDLE_FORMAT,
    side: "tc",
    task: "synthetic",
    rep: 1,
    model: "fake",
    issue: ISSUE,
    fixture,
    protocolFormat: "edit-dsl",
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

  test("accepts legacy ts-side bundles and normalizes the side label", () => {
    const legacy = JSON.stringify({ ...syntheticBundle("project", []), side: "ts" });
    const bundle = parseReplayBundle(legacy);
    expect(bundle.side).toBe("tc");
  });

  test("rejects old JSON, compact, missing, and unknown replay protocols", () => {
    const base = syntheticBundle("project", []);
    for (const protocol of ["json", "compact", "yaml", undefined]) {
      const bundle = JSON.stringify({ ...base, protocolFormat: protocol });
      expect(() => parseReplayBundle(bundle)).toThrow("unsupported replay protocol");
    }
    expect(parseReplayBundle(JSON.stringify(base)).protocolFormat).toBe("edit-dsl");
  });

  test("maps legacy agent modes and defaults to canonical pinned-repair (#34)", () => {
    const base = syntheticBundle("project", []);
    // JSON.stringify drops the undefined field, so this is a bundle recorded
    // before the mode field existed.
    expect(parseReplayBundle(JSON.stringify(base)).agentMode).toBe("pinned-repair");
    expect(parseReplayBundle(JSON.stringify({ ...base, agentMode: "edit" })).agentMode).toBe(
      "pinned-repair",
    );
    expect(parseReplayBundle(JSON.stringify({ ...base, agentMode: "plan-exec" })).agentMode).toBe(
      "plan-exec",
    );
    expect(parseReplayBundle(JSON.stringify({ ...base, agentMode: "yaml" })).agentMode).toBe(
      "pinned-repair",
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
      JSON.stringify(syntheticBundle("project", editDslRecordedCalls(fixtureDir))),
    );
    const run = await runReplay({
      bundle,
      bundlePath: "synthetic/in-order.json",
      repoRoot,
      tscBin: TSC_BIN,
      keep: true,
    });
    expect(run.result.ok).toBe(true);
    expect(run.callsConsumed).toBe(3);
    expect(run.callsTotal).toBe(3);
    expect(run.exhaustion).toBeNull();
    expect(run.promptMismatches).toEqual([]);
    expect(run.result.records.map((record) => record.outcome)).toEqual([
      "selected",
      "applied",
      "ok",
      "confirmed",
    ]);
    expect(run.workspace.startsWith(join(repoRoot, "tmp", "replay"))).toBe(true);
    expect(readFileSync(join(run.workspace, "src", "helper.ts"), "utf8")).toContain("return 2;");
    const summary = summarizeReplay(run);
    expect(summary).toContain("result: ok");
    expect(summary).toContain("calls: 3/3");
    expect(summary).toContain("prompt mismatches: none");
    expect(summary).toContain(
      "record 1: kind=exchange outcome=selected exchange=1 diagnostics=none",
    );
    expect(summary).toContain("record 3: kind=verification outcome=ok exchange=- diagnostics=none");
    expect(summary).toContain(
      "record 4: kind=exchange outcome=confirmed exchange=2 diagnostics=none",
    );
  }, 60000);

  test("replays an edit-dsl bundle under its recorded protocol and consumes every call", async () => {
    const { repoRoot, fixtureDir } = fixtureRepo();
    const recorder = new ReplayRecorder();
    for (const call of editDslRecordedCalls(fixtureDir)) {
      recorder.record(call.messages, {
        content: call.content,
        toolCalls: call.toolCalls,
        finishReason: call.finishReason,
        raw: { usage: call.usage },
      });
    }
    const bundlePath = join(repoRoot, "edit-dsl-replay.json");
    writeFileSync(
      bundlePath,
      JSON.stringify(
        recorder.bundle({
          task: "edit-dsl",
          rep: 1,
          model: "fake",
          issue: ISSUE,
          fixture: "project",
        }),
      ),
    );
    const bundle = parseReplayBundle(readFileSync(bundlePath, "utf8"));
    expect(bundle.protocolFormat).toBe("edit-dsl");
    expect(bundle.agentMode).toBe("pinned-repair");
    const run = await runReplay({
      bundle,
      bundlePath,
      repoRoot,
      tscBin: TSC_BIN,
      keep: true,
    });
    expect(run.result.ok).toBe(true);
    expect(run.callsConsumed).toBe(run.callsTotal);
    expect(run.callsConsumed).toBe(3);
    expect(run.exhaustion).toBeNull();
    expect(run.promptMismatches).toEqual([]);
    expect(readFileSync(join(run.workspace, "src", "helper.ts"), "utf8")).toContain("return 2;");
  }, 60000);

  test("reports exhaustion and removes the workspace by default", async () => {
    const { repoRoot, fixtureDir } = fixtureRepo();
    const calls = editDslRecordedCalls(fixtureDir).slice(0, 1);
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
    // The pick consumed the only recorded call before exhaustion.
    expect(summary).toContain(
      "record 1: kind=exchange outcome=selected exchange=1 diagnostics=none",
    );
  }, 60000);
});

describe("summarizeReplay", () => {
  test("includes record outcomes, consumed counts, and prompt mismatches", () => {
    const record: LoopRecord = {
      row: 1,
      iteration: 1,
      kind: "exchange",
      exchange: 1,
      locator: LOCATOR,
      replacement: null,
      diagnostics: "stage: protocol\nexpected a selection object",
      outcome: "protocol",
      diagnosticsHead: "stage: protocol expected a selection object",
      replacementChars: null,
      finishReason: "stop",
      signature: null,
    };
    const result: LoopResult = {
      ok: false,
      locator: null,
      filePath: null,
      editedSource: null,
      records: [record],
      diagnostics: "could not select a symbol",
      explanation: null,
      messages: [],
      terminationReason: "edit-exhausted",
      tokens: { input: 0, output: 0, total: 0, cacheRead: 0, reasoning: 0 },
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
    expect(summary).toContain("termination: edit-exhausted");
    expect(summary).toContain("record 1: kind=exchange outcome=protocol exchange=1");
    expect(summary).toContain("stopped: could not select a symbol");
  });
});
