import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  archiveFailureArtifacts,
  renderFailureArtifact,
  writeFailureArtifact,
} from "./failure-artifact";
import type { LoopRecord, LoopResult } from "./loop";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tsartifact-"));
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

const LOCATOR = { path: "src/helper.ts", name: "answer", kind: "function" };

type RecordOverrides = Partial<Omit<LoopRecord, "outcome">> & { outcome: LoopRecord["outcome"] };

function recordOf(overrides: RecordOverrides): LoopRecord {
  return {
    row: 1,
    iteration: 1,
    kind: "exchange",
    exchange: 1,
    locator: LOCATOR,
    replacement: null,
    diagnostics: null,
    diagnosticsHead: null,
    replacementChars: null,
    finishReason: "stop",
    payloads: 0,
    toolCalls: 0,
    signature: null,
    ...overrides,
  };
}

function failedResult(overrides: Partial<LoopResult> = {}): LoopResult {
  const records: LoopRecord[] = [
    recordOf({ row: 1, outcome: "selected" }),
    recordOf({
      row: 2,
      kind: "verification",
      exchange: null,
      outcome: "tsc",
      diagnostics: "stage: tsc\nsrc/helper.ts(2,3): error TS2322: Type 'string' is not assignable",
      diagnosticsHead:
        "stage: tsc src/helper.ts(2,3): error TS2322: Type 'string' is not assignable",
      signature: 1,
    }),
  ];
  return {
    ok: false,
    mode: "modify",
    locator: LOCATOR,
    filePath: "src/helper.ts",
    editedSource: null,
    records,
    diagnostics:
      "edit-exhausted: the 3-exchange Edit budget was exhausted without a valid edit\n\n" +
      "stage: tsc\nsrc/helper.ts(2,3): error TS2322: Type 'string' is not assignable",
    explanation: "the symbol cannot satisfy the test",
    messages: [],
    terminationReason: "edit-exhausted",
    ...overrides,
  };
}

describe("renderFailureArtifact", () => {
  test("renders the termination reason, target, record counts, diagnostics, and summary", () => {
    const artifact = renderFailureArtifact({
      rootDir: "/unused",
      result: failedResult(),
      context: "benchmark json-parser ts rep2",
      now: new Date("2026-01-02T03:04:05.678Z"),
    });
    expect(artifact).toContain("# Run failure — edit-exhausted");
    expect(artifact).toContain("- finished: 2026-01-02T03:04:05.678Z");
    expect(artifact).toContain("- context: benchmark json-parser ts rep2");
    expect(artifact).toContain("- mode: modify");
    expect(artifact).toContain("- file: src/helper.ts");
    expect(artifact).toContain(
      '- locator: {"path":"src/helper.ts","name":"answer","kind":"function"}',
    );
    expect(artifact).toContain("- records: 2 (exchanges 1, verifications 1)");
    expect(artifact).toContain("## Diagnostics");
    expect(artifact).toContain("not assignable");
    expect(artifact).toContain("## Summary");
    expect(artifact).toContain("the symbol cannot satisfy the test");
  });

  test("renders a multiline four-section summary verbatim without reflowing", () => {
    const explanation = [
      "- Accomplished: applied the chained edit and kept the file formatting.",
      "- Failed and why: the type checker still rejects the return type, so verification never passed.",
      "- Remaining: fix the return type of answer.",
      "- Next step: re-pin to the type declaration and rewrite it whole-symbol.",
    ].join("\n");
    const artifact = renderFailureArtifact({
      rootDir: "/unused",
      result: failedResult({ explanation }),
      now: new Date("2026-01-02T03:04:05.678Z"),
    });
    expect(artifact).toContain("## Summary");
    for (const line of explanation.split("\n")) {
      expect(artifact).toContain(line);
    }
    // Verbatim: the four labeled lines appear as one contiguous block.
    expect(artifact).toContain(`${explanation}\n`);
  });

  test("omits the context line and names missing values", () => {
    const artifact = renderFailureArtifact({
      rootDir: "/unused",
      result: failedResult({
        locator: null,
        filePath: null,
        mode: undefined,
        diagnostics: null,
        explanation: null,
        records: [],
      }),
      now: new Date("2026-01-02T03:04:05.678Z"),
    });
    expect(artifact).not.toContain("- context:");
    expect(artifact).toContain("- mode: none");
    expect(artifact).toContain("- file: none");
    expect(artifact).toContain("- locator: none");
    expect(artifact).toContain("- records: 0 (exchanges 0, verifications 0)");
    expect(artifact).toContain("no diagnostics recorded");
    expect(artifact).toContain("no summary recorded");
  });

  test("widens the fence around diagnostics that contain backtick fences", () => {
    const artifact = renderFailureArtifact({
      rootDir: "/unused",
      result: failedResult({
        diagnostics: "stage: protocol\n```json\nnot json\n```",
      }),
      now: new Date("2026-01-02T03:04:05.678Z"),
    });
    expect(artifact).toContain("````\nstage: protocol\n```json\nnot json\n```\n````");
  });
});

describe("writeFailureArtifact", () => {
  const now = new Date("2026-01-02T03:04:05.678Z");
  const expectedName = "2026-01-02T03-04-05-678Z-edit-exhausted.md";

  test("writes the artifact under failures/ and returns the path", () => {
    const dir = tempDir();
    const path = writeFailureArtifact({ rootDir: dir, result: failedResult(), now });
    expect(path).toBe(join(dir, "failures", expectedName));
    expect(path).not.toBeNull();
    const artifact = readFileSync(path ?? "", "utf8");
    expect(artifact).toContain("# Run failure — edit-exhausted");
  });

  test("suffixes collisions instead of overwriting", () => {
    const dir = tempDir();
    const first = writeFailureArtifact({ rootDir: dir, result: failedResult(), now });
    const second = writeFailureArtifact({ rootDir: dir, result: failedResult(), now });
    expect(first).toBe(join(dir, "failures", expectedName));
    expect(second).toBe(join(dir, "failures", "2026-01-02T03-04-05-678Z-edit-exhausted-2.md"));
    expect(existsSync(first ?? "")).toBe(true);
    expect(existsSync(second ?? "")).toBe(true);
  });

  test("returns null for success and provider errors and writes nothing", () => {
    const dir = tempDir();
    const ok = writeFailureArtifact({
      rootDir: dir,
      result: failedResult({
        ok: true,
        diagnostics: null,
        explanation: null,
        terminationReason: undefined,
      }),
      now,
    });
    expect(ok).toBeNull();
    const providerError = writeFailureArtifact({
      rootDir: dir,
      result: failedResult({
        terminationReason: undefined,
        diagnostics: "provider error: gateway unreachable",
        explanation: "no explanation available",
      }),
      now,
    });
    expect(providerError).toBeNull();
    expect(existsSync(join(dir, "failures"))).toBe(false);
  });
});

describe("archiveFailureArtifacts", () => {
  const now = new Date("2026-01-02T03:04:05.678Z");
  const stamp = "2026-01-02T03-04-05-678Z";
  const artifactName = `${stamp}-edit-exhausted.md`;

  test("moves every file, empties the source, and returns the destination with the count", () => {
    const dir = tempDir();
    const written = writeFailureArtifact({ rootDir: dir, result: failedResult(), now });
    writeFileSync(join(dir, "failures", "zz-smoke-marker.md"), "marker\n");

    const archived = archiveFailureArtifacts({ rootDir: dir, now });

    expect(archived).toEqual({
      archiveDir: join(dir, "tmp", "failures-archive", stamp),
      moved: 2,
    });
    expect(readdirSync(join(dir, "failures"))).toEqual([]);
    const destination = join(dir, "tmp", "failures-archive", stamp);
    expect(readFileSync(join(destination, artifactName), "utf8")).toContain(
      "# Run failure — edit-exhausted",
    );
    expect(readFileSync(join(destination, "zz-smoke-marker.md"), "utf8")).toBe("marker\n");
    expect(written).toBe(join(dir, "failures", artifactName));
  });

  test("is a no-op when failures/ is missing and when it is empty", () => {
    const missing = tempDir();
    expect(archiveFailureArtifacts({ rootDir: missing, now })).toBeNull();
    expect(existsSync(join(missing, "tmp"))).toBe(false);

    const empty = tempDir();
    mkdirSync(join(empty, "failures"));
    expect(archiveFailureArtifacts({ rootDir: empty, now })).toBeNull();
    expect(existsSync(join(empty, "tmp"))).toBe(false);
  });

  test("stamps the archive directory like writeFailureArtifact stamps names", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "failures"));
    writeFileSync(join(dir, "failures", "a.md"), "a");

    const archived = archiveFailureArtifacts({ rootDir: dir });

    expect(archived).not.toBeNull();
    expect(basename(archived?.archiveDir ?? "")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
    );
  });

  test("suffixes an existing archive directory instead of merging into it", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "failures"));
    writeFileSync(join(dir, "failures", "a.md"), "first");
    const first = archiveFailureArtifacts({ rootDir: dir, now });
    writeFileSync(join(dir, "failures", "a.md"), "second");
    const second = archiveFailureArtifacts({ rootDir: dir, now });

    expect(first?.archiveDir).toBe(join(dir, "tmp", "failures-archive", stamp));
    expect(second?.archiveDir).toBe(join(dir, "tmp", "failures-archive", `${stamp}-2`));
    expect(first?.moved).toBe(1);
    expect(second?.moved).toBe(1);
    expect(readFileSync(join(first?.archiveDir ?? "", "a.md"), "utf8")).toBe("first");
    expect(readFileSync(join(second?.archiveDir ?? "", "a.md"), "utf8")).toBe("second");
  });
});
