import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// #68: every USD claim in a benchmark report rests on `judgeWorkspace` (tsc + bun test +
// fixture byte-equality). This golden corpus pins its four verdicts with a
// table, so a judge change that flips one now fails `bun test` at zero API cost.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "benchmark", "fixtures", "json-parser");
const REFERENCE_FILE = join(REPO_ROOT, "benchmark", "references", "json.ts");
const RUN_FILE = join(REPO_ROOT, "benchmark", "run.ts");
// Resolved the way benchmark/check.ts does: the repo's own tsc, invoked via bun.
const TSC_BIN = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
// Parallel-safety audit (#36): this fixed repo-relative workspace is shared
// state. It is safe under `bun test --parallel` because file-level workers run
// this file once and its tests are serial; do not run these cases concurrently
// within the file, since beforeAll/afterAll and the workspace path are global.
const WORKSPACE_ROOT = join(REPO_ROOT, "tmp", "judge-golden");

interface JudgeVerdict {
  readonly fixtureOk: boolean;
  readonly tscOk: boolean;
  readonly testsOk: boolean;
  readonly ok: boolean;
}

type JudgeWorkspace = (
  workspace: string,
  fixtureDir: string,
  tscBin: string,
) => Promise<JudgeVerdict>;

// Import through a computed specifier so `tsc` never pins `../benchmark`: the
// self-host smoke test copies only `src/` and runs `tsc`/`bun test` there, and
// must stay green. When `benchmark/` is absent this suite skips instead of
// failing to resolve.
async function loadJudge(): Promise<JudgeWorkspace | null> {
  if (!existsSync(RUN_FILE)) {
    return null;
  }
  const module = (await import(pathToFileURL(RUN_FILE).href)) as {
    judgeWorkspace: JudgeWorkspace;
  };
  return module.judgeWorkspace;
}

const judgeWorkspace = await loadJudge();
const referenceSource = existsSync(REFERENCE_FILE) ? readFileSync(REFERENCE_FILE, "utf8") : "";
const haveBenchmark = judgeWorkspace !== null && referenceSource !== "";

// Type-checks but is wrong at runtime: `bun test` runs the same json-parser
// fixture tests against JSON.parse and they pass, yet `tsc` rejects the
// deliberate `number` assignment. Isolates the tsc verdict from the test one.
const TYPE_ERROR_CANDIDATE = `export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function parseJson(text: string): JsonValue {
  const wrong: number = "not a number";
  void wrong;
  return JSON.parse(text) as JsonValue;
}
`;

// Type-checks cleanly but returns the wrong value, so the fixture tests fail.
// Isolates the tests verdict from the tsc one.
const TEST_FAILURE_CANDIDATE = `export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function parseJson(_text: string): JsonValue {
  return null;
}
`;

interface GoldenRow {
  readonly name: string;
  readonly candidate: string;
  /** Tamper with a read-only fixture file after the workspace is seeded. */
  readonly mutateFixture?: (workspace: string) => void;
  readonly expected: JudgeVerdict;
}

const GOLDEN_ROWS: readonly GoldenRow[] = [
  {
    name: "reference solution passes every net",
    candidate: referenceSource,
    expected: { fixtureOk: true, tscOk: true, testsOk: true, ok: true },
  },
  {
    name: "type error fails tsc only",
    candidate: TYPE_ERROR_CANDIDATE,
    expected: { fixtureOk: true, tscOk: false, testsOk: true, ok: false },
  },
  {
    name: "wrong runtime value fails tests only",
    candidate: TEST_FAILURE_CANDIDATE,
    expected: { fixtureOk: true, tscOk: true, testsOk: false, ok: false },
  },
  {
    name: "modified read-only fixture fails byte-equality",
    candidate: referenceSource,
    mutateFixture: (workspace) => {
      const testFile = join(workspace, "src", "json.test.ts");
      writeFileSync(testFile, `${readFileSync(testFile, "utf8")}\n// tampered\n`);
    },
    expected: { fixtureOk: false, tscOk: true, testsOk: true, ok: false },
  },
];

describe.skipIf(!haveBenchmark)("judge golden corpus (#68)", () => {
  beforeAll(() => {
    rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE_ROOT, { recursive: true });
  });

  afterAll(() => {
    rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  });

  for (const row of GOLDEN_ROWS) {
    test(row.name, async () => {
      const workspace = join(WORKSPACE_ROOT, row.name.replaceAll(" ", "-"));
      rmSync(workspace, { recursive: true, force: true });
      cpSync(FIXTURE_DIR, workspace, { recursive: true });
      writeFileSync(join(workspace, "src", "json.ts"), row.candidate);
      row.mutateFixture?.(workspace);

      const verdict = await judgeWorkspace!(workspace, FIXTURE_DIR, TSC_BIN);
      expect({
        fixtureOk: verdict.fixtureOk,
        tscOk: verdict.tscOk,
        testsOk: verdict.testsOk,
        ok: verdict.ok,
      }).toEqual(row.expected);

      rmSync(workspace, { recursive: true, force: true });
    });
  }
});
