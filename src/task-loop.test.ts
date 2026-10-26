import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheExcludedTokens, runLoop } from "./loop";
import { runTaskLoop } from "./task-loop";
import { serializePlanDsl } from "./plan-dsl";
import type { Plan, WorkNode } from "./tasks";
import type { ProviderLike } from "./loop";
import type { ChatMessage, ChatOptions, ChatResponse, ToolDefinition } from "./openai";

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
  readonly calls: ChatMessage[][] = [];

  constructor(
    private readonly responses: string[],
    private readonly rawUsage: Record<string, unknown> = {},
  ) {}

  async chat(
    messages: ChatMessage[],
    _tools?: ToolDefinition[],
    _options?: ChatOptions,
  ): Promise<ChatResponse> {
    this.calls.push(structuredClone(messages));
    const content = this.responses.shift();
    if (content === undefined) {
      throw new Error("no scripted response left");
    }
    return {
      content,
      toolCalls: [],
      finishReason: "stop",
      raw: { usage: this.rawUsage },
    };
  }
}

function lastPrompt(provider: ScriptedProvider, index: number): string {
  return provider.calls[index]?.at(-1)?.content ?? "";
}

function promptsStartingWith(provider: ScriptedProvider, prefix: string): string[] {
  return provider.calls
    .map((messages) => messages.at(-1)?.content ?? "")
    .filter((content) => content.startsWith(prefix));
}

/** A minimal project: a failing test and the function it exercises. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "tctask-"));
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
  writeFileSync(join(dir, "src", "extra.ts"), "export const extra = 1;\n");
  writeFileSync(join(dir, "src", "ready.ts"), "export const ready = 1;\n");
  writeFileSync(join(dir, "bunfig.toml"), '[test]\nroot = "./src"\n');
  // Standalone projects have no bun type declarations; the shim keeps
  // `import { test } from "bun:test"` type-checkable under tsc.
  writeFileSync(
    join(dir, "src", "bun-shim.d.ts"),
    [
      'declare module "bun:test" {',
      "  export const test: (name: string, fn: () => void) => void;",
      "  export const expect: (value: unknown) => { toBe: (expected: unknown) => void; toContain: (expected: string) => void };",
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

function nodeId(label: number, slug: string): string {
  return `${String(label).padStart(2, "0")}-${slug}`;
}

function workNode(
  label: number,
  slug: string,
  overrides: Partial<Omit<WorkNode, "id">> = {},
): WorkNode {
  return {
    id: nodeId(label, slug),
    after: [],
    verify: "test",
    instruction: `Carry out node ${slug}.`,
    hints: [{ path: "src/helper.ts", symbol: "answer", kind: "value" }],
    ...overrides,
  };
}

function planOf(nodes: WorkNode[], goal = "Make the failing test pass."): Plan {
  return { id: "01-main", goal, nodes };
}

function planText(nodes: WorkNode[], finish = true, goal?: string): string {
  const wire = serializePlanDsl(planOf(nodes, goal));
  return finish ? `${wire}\nfinish` : wire;
}

function patchText(...lines: string[]): string {
  return ["patch", ...lines].join("\n");
}

function editDsl(replacement: string): string {
  return [
    "select answer in src/helper.ts resolve value",
    "replace with",
    "<<<TC_EDIT_BEGIN>>>",
    replacement,
    "<<<TC_EDIT_END>>>",
    "end",
  ].join("\n");
}

function wholeFileWrite(path: string, source: string): string {
  return [`write ${path} with`, "<<<TC_EDIT_BEGIN>>>", source, "<<<TC_EDIT_END>>>"].join("\n");
}

const GOOD_EDIT = editDsl("export function answer(): number {\n  return 2;\n}");
const BAD_EDIT = editDsl("export function answer(): number {\n  return 3;\n}");
const SETTINGS_EDIT = [
  "select other in src/settings.ts resolve value",
  "replace with",
  "<<<TC_EDIT_BEGIN>>>",
  "export const other = 2;",
  "<<<TC_EDIT_END>>>",
  "end",
].join("\n");
const EXTRA_EDIT = [
  "select extra in src/extra.ts resolve value",
  "replace with",
  "<<<TC_EDIT_BEGIN>>>",
  "export const extra = 2;",
  "<<<TC_EDIT_END>>>",
  "end",
].join("\n");
const READY_EDIT = [
  "select ready in src/ready.ts resolve value",
  "replace with",
  "<<<TC_EDIT_BEGIN>>>",
  "export const ready = 2;",
  "<<<TC_EDIT_END>>>",
  "end",
].join("\n");

function baseOptions(dir: string, provider: ProviderLike) {
  return {
    cwd: dir,
    issue: "make the failing test pass",
    provider,
    agentMode: "plan-exec" as const,
    checkCommand: TSC,
    testCommand: ["bun", "test"],
    tokenBudget: 1_000_000,
  };
}

describe("runLoop dispatch", () => {
  test("agentMode plan-exec routes through the WorkNode driver", async () => {
    const dir = project();
    const provider = new ScriptedProvider([
      planText([workNode(2, "answer")]),
      GOOD_EDIT,
      "approve",
    ]);
    const result = await runLoop({
      ...baseOptions(dir, provider),
      protocolFormat: "edit-dsl",
    });
    expect(result.ok).toBe(true);
    expect(result.nodes?.map((entry) => entry.status)).toEqual(["passed"]);
    // The planning call is the first provider call; the edit-dsl driver would
    // have started from its select-first system prompt instead.
    expect(provider.calls[0]?.[0]?.content).toContain("work-graph planner");
  }, 30000);

  test("the default edit mode is unchanged", async () => {
    const dir = project();
    const provider = new ScriptedProvider([GOOD_EDIT]);
    const result = await runLoop({
      cwd: dir,
      issue: "make the failing test pass",
      provider,
      protocolFormat: "edit-dsl",
      checkCommand: TSC,
      testCommand: ["bun", "test"],
    });
    expect(provider.calls[0]?.[0]?.content).toContain("Edit-action DSL");
    expect(result.nodes).toBeUndefined();
  }, 30000);
});

describe("WorkNode DAG scheduling", () => {
  test("runs independent ready nodes in record order and finishes on a passing test node", async () => {
    const dir = project();
    writeFileSync(join(dir, "src", "settings.ts"), "export const other = 1;\n");
    const settings = workNode(2, "settings", {
      verify: "tsc",
      instruction: "Change other to 2.",
      hints: [{ path: "src/settings.ts", symbol: "other", kind: "value" }],
    });
    const answer = workNode(3, "answer", {
      instruction: "Change answer so the test passes.",
    });
    const provider = new ScriptedProvider([
      planText([settings, answer]),
      SETTINGS_EDIT,
      "approve",
      GOOD_EDIT,
      "approve",
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.nodes?.map((node) => [node.id, node.status])).toEqual([
      [nodeId(2, "settings"), "passed"],
      [nodeId(3, "answer"), "passed"],
    ]);
    const execution = promptsStartingWith(provider, "# Work node");
    expect(execution).toHaveLength(2);
    expect(execution[0]).toContain("src/settings.ts");
    expect(execution[1]).toContain("src/helper.ts");
    expect(readFileSync(join(dir, "src", "settings.ts"), "utf8")).toContain("other = 2");
  }, 30000);

  test("a failed dependency blocks its dependents while independent work still runs", async () => {
    const dir = project();
    const broken = workNode(2, "broken", {
      verify: "tsc",
      instruction: "This node cannot make progress.",
      hints: [{ path: "src/broken.ts", symbol: "", kind: "file" }],
    });
    const answer = workNode(3, "answer", {
      instruction: "Change answer so the test passes.",
    });
    const dependent = workNode(4, "dependent", {
      after: [nodeId(2, "broken")],
      instruction: "Only run after the broken node passes.",
    });
    const patch = patchText(
      `node- "${nodeId(4, "dependent")}"`,
      "end",
      `node- "${nodeId(2, "broken")}"`,
      "end",
      "finish",
    );
    const provider = new ScriptedProvider([
      planText([broken, answer, dependent]),
      "junk",
      "junk",
      GOOD_EDIT,
      "approve",
      patch,
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const blockedPrompt = promptsStartingWith(provider, "# Work graph").find((content) =>
      content.includes("Blocked node(s)"),
    );
    expect(blockedPrompt).toContain(`Blocked node(s): #${nodeId(4, "dependent")}`);
    expect(blockedPrompt).toContain(`Failed dependency node(s): #${nodeId(2, "broken")}`);
    expect(result.nodes?.map((node) => [node.id, node.status])).toEqual([
      [nodeId(3, "answer"), "passed"],
    ]);
    // The blocked dependent never received an execution prompt; the failed
    // node was retried twice before no progress, and answer ran once.
    expect(promptsStartingWith(provider, "# Work node")).toHaveLength(3);
    expect(
      promptsStartingWith(provider, "# Work node").some((content) =>
        content.includes("Only run after the broken node passes."),
      ),
    ).toBe(false);
  }, 30000);
});

describe("executor autonomy", () => {
  test("applies multiple clauses and actions in one atomic reply", async () => {
    const dir = project();
    const node = workNode(2, "answer", {
      instruction: "Change answer and extra in one reply.",
      hints: [
        { path: "src/helper.ts", symbol: "answer", kind: "value" },
        { path: "src/extra.ts", symbol: "extra", kind: "value" },
      ],
    });
    const reply = [GOOD_EDIT, EXTRA_EDIT].join("\n");
    const provider = new ScriptedProvider([planText([node]), reply, "approve"]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const applied = result.records.find((record) => record.outcome === "applied");
    expect(applied?.appliedLocators?.map((locator) => locator.path).sort()).toEqual([
      "src/extra.ts",
      "src/helper.ts",
    ]);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
    expect(readFileSync(join(dir, "src", "extra.ts"), "utf8")).toContain("extra = 2");
  }, 30000);

  test("applies modify, rename, create, and delete in one atomic reply", async () => {
    const dir = project();
    const node = workNode(2, "answer", {
      instruction: "Change answer, rename extra, create a file, and remove ready in one reply.",
      hints: [
        { path: "src/helper.ts", symbol: "answer", kind: "value" },
        { path: "src/extra.ts", symbol: "extra", kind: "value" },
      ],
    });
    const reply = [
      GOOD_EDIT,
      ["select extra in src/extra.ts resolve value", "rename extra to extraRenamed", "end"].join(
        "\n",
      ),
      "create src/created.ts end",
      "delete src/ready.ts end",
    ].join("\n");
    const provider = new ScriptedProvider([planText([node]), reply, "approve"]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
    expect(readFileSync(join(dir, "src", "extra.ts"), "utf8")).toContain("extraRenamed");
    expect(readFileSync(join(dir, "src", "created.ts"), "utf8")).toBe("");
    expect(() => readFileSync(join(dir, "src", "ready.ts"), "utf8")).toThrow();
  }, 30000);

  test("creates an empty file as a real change", async () => {
    const dir = project();
    const create = workNode(2, "create", {
      verify: "tsc",
      instruction: "Create src/created.ts.",
      hints: [{ path: "src/created.ts", symbol: "", kind: "file" }],
    });
    const final = workNode(3, "final", {
      after: [nodeId(2, "create")],
      instruction: "Change answer so the test passes.",
    });
    const provider = new ScriptedProvider([
      planText([create, final]),
      "create src/created.ts end",
      "approve",
      GOOD_EDIT,
      "approve",
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "created.ts"), "utf8")).toBe("");
  }, 30000);

  test("creates a top-level declaration through the kind-aware create statement", async () => {
    const dir = project();
    const create = workNode(2, "json", {
      verify: "tsc",
      instruction: "Create src/json.ts with an exported parseJson function.",
      hints: [{ path: "src/json.ts", symbol: "", kind: "file" }],
    });
    const final = workNode(3, "answer", {
      after: [nodeId(2, "json")],
      instruction: "Change answer so the test passes.",
    });
    const reply = [
      "create function parseJson in src/json.ts with",
      "<<<TC_EDIT_BEGIN>>>",
      "export function parseJson(text: string): string {",
      "  return text;",
      "}",
      "<<<TC_EDIT_END>>>",
      "end",
    ].join("\n");
    const provider = new ScriptedProvider([
      planText([create, final]),
      reply,
      "approve",
      GOOD_EDIT,
      "approve",
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "src", "json.ts"), "utf8")).toContain("function parseJson");
  }, 30000);

  test("creates a class member through the kind-aware create statement", async () => {
    const dir = project();
    writeFileSync(
      join(dir, "src", "parser.ts"),
      "export class Parser {\n  parseValue(): number {\n    return 1;\n  }\n}\n",
    );
    const create = workNode(2, "member", {
      verify: "tsc",
      instruction: "Add a trim method to the Parser class.",
      hints: [{ path: "src/parser.ts", symbol: "Parser", kind: "value" }],
    });
    const final = workNode(3, "answer", {
      after: [nodeId(2, "member")],
      instruction: "Change answer so the test passes.",
    });
    const reply = [
      "create method Parser.trim in src/parser.ts with",
      "<<<TC_EDIT_BEGIN>>>",
      "trim(): string {",
      '  return "";',
      "}",
      "<<<TC_EDIT_END>>>",
      "end",
    ].join("\n");
    const provider = new ScriptedProvider([
      planText([create, final]),
      reply,
      "approve",
      GOOD_EDIT,
      "approve",
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const source = readFileSync(join(dir, "src", "parser.ts"), "utf8");
    expect(source).toContain("trim(): string");
    expect(source.indexOf("trim(): string")).toBeLessThan(source.lastIndexOf("}"));
  }, 30000);

  test("chooses a whole-file write even when the approach hint prefers targeted edits", async () => {
    const dir = project();
    const node = workNode(2, "answer", {
      instruction: "Make the answer test green.",
      approach: "Prefer a targeted edit; the file is small.",
    });
    const write = [
      "write src/helper.ts with",
      "<<<TC_EDIT_BEGIN>>>",
      "export function answer(): number {",
      "  return 2;",
      "}",
      "<<<TC_EDIT_END>>>",
    ].join("\n");
    const provider = new ScriptedProvider([planText([node]), write, "approve"]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const execution = promptsStartingWith(provider, "# Work node")[0] ?? "";
    expect(execution).toContain("Prefer a targeted edit");
    expect(promptsStartingWith(provider, "# Review")[0] ?? "").toContain("--- a/src/helper.ts");
    expect(readFileSync(join(dir, "src", "helper.ts"), "utf8")).toContain("return 2;");
  }, 30000);

  test("an out-of-hint edit is allowed and appears in the review diff", async () => {
    const dir = project();
    const node = workNode(2, "answer", {
      instruction: "Change answer and also update extra to 2.",
      hints: [{ path: "src/helper.ts", symbol: "answer", kind: "value" }],
    });
    const provider = new ScriptedProvider([
      planText([node]),
      [GOOD_EDIT, EXTRA_EDIT].join("\n"),
      "approve",
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const review = promptsStartingWith(provider, "# Review")[0] ?? "";
    expect(review).toContain("# Out-of-hint edits");
    expect(review).toContain("src/extra.ts");
    expect(review).toContain("+++ b/src/extra.ts");
  }, 30000);
});

describe("edit strategy advisory", () => {
  test("a large whole-file rewrite gets an advisory with gate diagnostics on the next turn", async () => {
    const dir = project();
    const padding = Array.from(
      { length: 130 },
      (_, index) => `export const pad${index} = ${index};`,
    );
    const source = [
      "export function largeAnswer(): number {",
      "  return 1;",
      "}",
      ...padding,
      "",
    ].join("\n");
    writeFileSync(join(dir, "src", "large.ts"), source);
    const large = workNode(2, "large", {
      verify: "tsc",
      instruction: "Keep the large module compiling.",
      hints: [{ path: "src/large.ts", symbol: "", kind: "file" }],
    });
    const answer = workNode(3, "answer", {
      after: [nodeId(2, "large")],
      instruction: "Change answer so the test passes.",
    });
    const broken = wholeFileWrite("src/large.ts", source.replace("return 1;", 'return "bad";'));
    const repair = [
      "select largeAnswer in src/large.ts resolve value",
      "replace with",
      "<<<TC_EDIT_BEGIN>>>",
      "export function largeAnswer(): number {",
      "  return 1;",
      "}",
      "<<<TC_EDIT_END>>>",
      "end",
    ].join("\n");
    const provider = new ScriptedProvider([
      planText([large, answer]),
      broken,
      repair,
      "approve",
      GOOD_EDIT,
      "approve",
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const execution = promptsStartingWith(provider, "# Work node");
    expect(execution).toHaveLength(3);
    expect(execution[1]).toContain("# Gate diagnostics");
    expect(execution[1]).toContain("TS2322");
    expect(execution[1]).toContain("# Edit strategy advisory");
    expect(execution[1]).toContain("src/large.ts");
    expect(execution[1]).toContain("existed with 133 lines before the write");
    expect(execution[1]).toContain("120-line heuristic");
    expect(execution[1]).toContain("single-declaration rewrite");
    expect(execution[1]).toContain("This is advice, not a gate");
    // The advisory adds no record and does not change status or the gate result.
    expect(result.records.map((record) => record.outcome)).toEqual([
      "applied",
      "tsc",
      "applied",
      "ok",
      "applied",
      "ok",
    ]);
    expect(result.nodes?.map((entry) => [entry.id, entry.status])).toEqual([
      [nodeId(2, "large"), "passed"],
      [nodeId(3, "answer"), "passed"],
    ]);
  }, 30000);

  test("a new file's first whole-file write gets no advisory", async () => {
    const dir = project();
    const create = workNode(2, "new", {
      verify: "tsc",
      instruction: "Create the new module.",
      hints: [{ path: "src/new.ts", symbol: "", kind: "file" }],
    });
    const answer = workNode(3, "answer", {
      after: [nodeId(2, "new")],
      instruction: "Change answer so the test passes.",
    });
    const broken = wholeFileWrite("src/new.ts", 'export const broken: number = "bad";\n');
    const repair = [
      "select broken in src/new.ts resolve value",
      "replace with",
      "<<<TC_EDIT_BEGIN>>>",
      "export const broken: number = 1;",
      "<<<TC_EDIT_END>>>",
      "end",
    ].join("\n");
    const provider = new ScriptedProvider([
      planText([create, answer]),
      broken,
      repair,
      "approve",
      GOOD_EDIT,
      "approve",
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const execution = promptsStartingWith(provider, "# Work node");
    expect(execution).toHaveLength(3);
    expect(execution[1]).toContain("# Gate diagnostics");
    expect(execution[1]).not.toContain("# Edit strategy advisory");
  }, 30000);

  test("a targeted edit gets no whole-file advisory", async () => {
    const dir = project();
    const node = workNode(2, "answer");
    const provider = new ScriptedProvider([planText([node]), BAD_EDIT, GOOD_EDIT, "approve"]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const execution = promptsStartingWith(provider, "# Work node");
    expect(execution).toHaveLength(2);
    expect(execution[1]).toContain("# Gate diagnostics");
    expect(execution[1]).not.toContain("# Edit strategy advisory");
  }, 30000);

  test("a repeated whole-file write without a targeted edit gets an advisory", async () => {
    const dir = project();
    const node = workNode(2, "answer");
    const first = wholeFileWrite(
      "src/helper.ts",
      "export function answer(): number {\n  return 3;\n}",
    );
    const second = wholeFileWrite(
      "src/helper.ts",
      "export function answer(): number {\n  return 4;\n}",
    );
    const provider = new ScriptedProvider([planText([node]), first, second, GOOD_EDIT, "approve"]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const execution = promptsStartingWith(provider, "# Work node");
    expect(execution).toHaveLength(3);
    expect(execution[1]).not.toContain("# Edit strategy advisory");
    expect(execution[2]).toContain("# Edit strategy advisory");
    expect(execution[2]).toContain("already rewrote it as a whole file");
    expect(execution[2]).toContain("existed with 3 lines before the write and has 3 lines after");
  }, 30000);

  test("a targeted edit resets the whole-file repeat tracking", async () => {
    const dir = project();
    const node = workNode(2, "answer");
    const first = wholeFileWrite(
      "src/helper.ts",
      "export function answer(): number {\n  return 3;\n}",
    );
    const targeted = editDsl("export function answer(): number {\n  return 4;\n}");
    const second = wholeFileWrite(
      "src/helper.ts",
      "export function answer(): number {\n  return 5;\n}",
    );
    const provider = new ScriptedProvider([
      planText([node]),
      first,
      targeted,
      second,
      GOOD_EDIT,
      "approve",
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const execution = promptsStartingWith(provider, "# Work node");
    expect(execution).toHaveLength(4);
    expect(execution[1]).not.toContain("# Edit strategy advisory");
    expect(execution[2]).not.toContain("# Edit strategy advisory");
    expect(execution[3]).not.toContain("# Edit strategy advisory");
  }, 30000);
});

describe("gates and progress", () => {
  test("runs the node gate after each applied reply and retries with its diagnostics", async () => {
    const dir = project();
    const node = workNode(2, "answer");
    const provider = new ScriptedProvider([planText([node]), BAD_EDIT, GOOD_EDIT, "approve"]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.records.map((record) => record.outcome)).toEqual([
      "applied",
      "tests",
      "applied",
      "ok",
    ]);
    const execution = promptsStartingWith(provider, "# Work node");
    expect(execution).toHaveLength(2);
    expect(execution[1]).toContain("# Gate diagnostics");
  }, 30000);

  test("allows repeated read self-checks instead of keeping a one-read cap", async () => {
    const dir = project();
    const node = workNode(2, "answer");
    const read = "read src/helper.ts within 2-2 end";
    const provider = new ScriptedProvider([planText([node]), read, read, GOOD_EDIT, "approve"]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(promptsStartingWith(provider, "# Work node")).toHaveLength(3);
  }, 30000);

  test("stops on a repeated no-progress fingerprint without a fixed attempt cap", async () => {
    const dir = project();
    const node = workNode(2, "answer");
    const provider = new ScriptedProvider([planText([node]), "junk", "junk", "patch"]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("task-exhausted");
    // Two identical rejected replies are enough; the old fixed cap was three.
    expect(promptsStartingWith(provider, "# Work node")).toHaveLength(2);
    expect(result.diagnostics).toContain("unchanged");
  }, 30000);

  test("a review call counts toward the run token budget", async () => {
    const dir = project();
    const node = workNode(2, "answer");
    const rawUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const provider = new ScriptedProvider([planText([node]), GOOD_EDIT, "approve"], rawUsage);
    const result = await runTaskLoop({ ...baseOptions(dir, provider), tokenBudget: 34 });
    expect(result.ok).toBe(false);
    expect(result.terminationReason).toBe("token-budget");
    expect(result.usage?.review.total).toBe(15);
    expect(result.diagnostics).toContain("token budget");
  }, 30000);

  test("a reasoning-bearing reply counts toward the cache-excluded budget", async () => {
    const dir = project();
    const node = workNode(2, "answer");
    const rawUsage = {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 45,
      reasoning_tokens: 30,
      prompt_tokens_details: { cached_tokens: 10 },
    };
    const provider = new ScriptedProvider([planText([node]), GOOD_EDIT, "approve"], rawUsage);
    const result = await runTaskLoop({
      ...baseOptions(dir, provider),
      tokenBudget: 34,
      tokenBudgetBasis: "cache-excluded",
    });
    expect(result.terminationReason).toBe("token-budget");
    expect(result.diagnostics).toContain("cache-excluded");
    expect(result.usage?.planning.reasoning).toBe(30);
    expect(cacheExcludedTokens(result.tokens)).toBe(35);
  }, 30000);
});

describe("planner turns", () => {
  test("accepts more than one planner viewer request before planning", async () => {
    const dir = project();
    const node = workNode(2, "answer");
    const provider = new ScriptedProvider([
      "read src/helper.ts within 1-1 end",
      "select answer in src/helper.ts resolve value\nend",
      planText([node]),
      GOOD_EDIT,
      "approve",
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(lastPrompt(provider, 1)).toContain("# Source view");
    expect(lastPrompt(provider, 2)).toContain("# Source view");
  }, 30000);

  test("rejects a planner viewer that tries to write", async () => {
    const dir = project();
    const node = workNode(2, "answer");
    const provider = new ScriptedProvider([
      "write src/helper.ts with\n<<<TC_EDIT_BEGIN>>>\nexport const bad = 1;\n<<<TC_EDIT_END>>>",
      planText([node]),
      GOOD_EDIT,
      "approve",
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const feedback = lastPrompt(provider, 1);
    expect(feedback).toContain("read-only");
    expect(feedback).toContain("write");
  }, 30000);

  test("a patch may add multiple nodes and finish the graph", async () => {
    const dir = project();
    const answer = workNode(2, "answer", {
      verify: "tsc",
      instruction: "Change answer so the test passes.",
    });
    const patch = patchText(
      `node+ "${nodeId(3, "extra")}" verify tsc`,
      "instruction: Change extra to 2.",
      "hint value extra in src/extra.ts",
      "end",
      `node+ "${nodeId(4, "final")}" after "${nodeId(2, "answer")}" "${nodeId(3, "extra")}" verify test`,
      "instruction: Change ready to 2 and keep the suite green.",
      "hint value ready in src/ready.ts",
      "end",
      "finish",
    );
    const provider = new ScriptedProvider([
      planText([answer], false),
      GOOD_EDIT,
      "approve",
      patch,
      EXTRA_EDIT,
      "approve",
      READY_EDIT,
      "approve",
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    expect(result.nodes?.map((node) => [node.id, node.status])).toEqual([
      [nodeId(2, "answer"), "passed"],
      [nodeId(3, "extra"), "passed"],
      [nodeId(4, "final"), "passed"],
    ]);
    const planning = promptsStartingWith(provider, "# Work graph");
    expect(planning.some((content) => content.includes("no final test node is marked"))).toBe(true);
  }, 30000);

  test("a review patch reopens the current node and it executes again", async () => {
    const dir = project();
    const node = workNode(2, "marker", {
      instruction: "Change answer and extra so the test passes.",
      hints: [
        { path: "src/helper.ts", symbol: "answer", kind: "value" },
        { path: "src/extra.ts", symbol: "extra", kind: "value" },
      ],
    });
    const reopen = patchText(
      `node~ "${nodeId(2, "marker")}"`,
      "instruction: Now change ready to 2 as well.",
      "hint value ready in src/ready.ts",
      "end",
    );
    const provider = new ScriptedProvider([
      planText([node]),
      [GOOD_EDIT, EXTRA_EDIT].join("\n"),
      reopen,
      READY_EDIT,
      "approve",
    ]);
    const result = await runTaskLoop(baseOptions(dir, provider));
    expect(result.ok).toBe(true);
    const execution = promptsStartingWith(provider, "# Work node");
    expect(execution).toHaveLength(2);
    expect(execution[1]).toContain("Now change ready");
    expect(readFileSync(join(dir, "src", "ready.ts"), "utf8")).toContain("ready = 2");
  }, 30000);
});
