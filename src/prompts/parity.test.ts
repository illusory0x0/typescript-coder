import { describe, expect, test } from "bun:test";
import {
  buildCreatePrompt,
  buildEditDslCreatePrompt,
  buildEditDslDetailsPrompt,
  buildEditDslModifiedPrompt,
  buildEditDslSelectionContinuationPrompt,
  buildEditDslSelectionRetryPrompt,
  buildEditDslSymbolIndex,
  buildEditDslUserPrompt,
  buildEditPrompt,
  buildSystemPrompt,
  numberedSourceBlock,
  numberedSourceRange,
} from "../loop";
import { buildIndexTolerant } from "../utility";
import type { SourceFile } from "../utility";

// Golden hashes for the current prompt snapshots. They make intentional prompt
// edits visible: a text change must update the matching hash in the same commit.
const GOLDEN: Record<string, string> = {
  systemEditDsl: "a41159c8b6ad3d7a60245df4c9e39f4b8efe64e3e0c6292b31d66997c848d59a",
  editDsl: "79ec85e7f118b6d82881cf3a924257bd8d45ed16b97b2bc26ec74530dd20cb11",
  createDsl: "468a288b2b7f09b3c9973c560543ac86a616656dd6cece2db2dce14d0a10b37e",
  dslSelectionRetry: "f98647d7bf2e5d118c70757673a6565de04de028d43269d72b9876825697ebac",
  dslSelectionContinuation: "e1934ecc1cb71c604d3e89830d12a7c3154fee68e02d03b2ddbe0fd94dedcb9c",
  dslUser: "24d29a2def1aa583bb82d344b101951e11ae8dca877e635c4358e9e449ae9fd2",
  dslDetails: "15999da13942e2021b43f13ed21dd7640797e0cbb7168103174071681e21bfcf",
  dslCreate: "5f40b2669feeca60f25187d3c35cdc661fac61effb6d4b8a996e511f80f2da96",
  dslModified: "9f42714af7262f6a57e68cc94c989ff24b19024fa2c8d9c55c05eecf67ddd019",
  dslIndex: "886b377d739a5cf3dac6e3d7de9a0e6ac1d8c66f7cd52604f60b57c15f12b2b6",
  numberedBlock: "d9faeb4ee96019066acac996f3d09a0fcabb0bbb492e7739afb9539d24382d90",
  numberedRange: "ea7820c14b852d204697cf3236f413ade8725954fdcb212615388be789b34196",
};

function hash(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

describe("prompt snapshots", () => {
  test("the prompt builders keep their reviewed bytes", () => {
    const files: SourceFile[] = [
      {
        path: "src/a.ts",
        source: [
          "export const MAX_TOKENS = 8192;",
          "export function answer(): number {",
          "  return 1;",
          "}",
          "export function clamp(value: number): number {",
          "  return Number.isNaN(value) ? 0 : value;",
          "}",
        ].join("\n"),
      },
      { path: "src/a.test.ts", source: "test('answer', () => {});\n" },
    ];
    const index = buildIndexTolerant(files).index;
    const indexText = buildEditDslSymbolIndex(index);
    const source = files[0]?.source ?? "";
    const symbolSource = "export function answer(): number {\n  return 1;\n}";
    const addressJson = '{"path":"src/a.ts","symbol":"answer","kind":"function"}';
    const diagnostics = "stage: matcher\nthe matcher was not found";
    const specFiles: SourceFile[] = [{ path: "src/spec.test.ts", source: "expect(1).toBe(2);\n" }];
    const bigSpec: SourceFile = { path: "src/big.test.ts", source: "x\n".repeat(5000) };

    const outputs: Record<string, string> = {
      systemEditDsl: buildSystemPrompt(),
      editDsl: buildEditPrompt(addressJson, symbolSource),
      createDsl: buildCreatePrompt(addressJson, "src/new.ts"),
      dslSelectionRetry: buildEditDslSelectionRetryPrompt("fix src/a.ts", indexText, diagnostics),
      dslSelectionContinuation: buildEditDslSelectionContinuationPrompt({
        failedAttempts: 8,
        issue: "fix src/a.ts",
        indexText,
        diagnostics,
        failureHistory: "failure history",
        digest: "attempt digest",
      }),
      dslUser: buildEditDslUserPrompt("fix src/a.ts", indexText, specFiles),
      dslDetails: buildEditDslDetailsPrompt(
        "fix src/a.ts",
        indexText,
        symbolSource,
        specFiles,
        3,
        new Set([4]),
        "duplicate note",
      ),
      dslCreate: buildEditDslCreatePrompt("fix src/a.ts", indexText, "src/new.ts", specFiles),
      dslModified: buildEditDslModifiedPrompt(
        "fix src/a.ts",
        indexText,
        symbolSource,
        3,
        specFiles,
      ),
      dslIndex: indexText,
      numberedBlock: numberedSourceBlock(source),
      numberedRange: numberedSourceRange(
        source,
        source.indexOf("export function answer"),
        source.indexOf("export function clamp"),
      ),
    };

    for (const [name, expected] of Object.entries(GOLDEN)) {
      const value = outputs[name];
      expect(value).toBeDefined();
      expect(hash(value ?? "")).toBe(expected);
    }
  });
});
