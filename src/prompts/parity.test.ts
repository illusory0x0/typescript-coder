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
  buildSelectionContinuationPrompt,
  buildSelectionRetryPrompt,
  buildSystemPrompt,
  buildTargetsEditPrompt,
  buildUserPrompt,
  numberedSourceBlock,
  numberedSourceRange,
} from "../loop";
import { buildIndexTolerant } from "../utility";
import type { SourceFile } from "../utility";

// Golden hashes captured from the pre-split src/loop.ts. They make the Phase 1
// prompt-module extraction a byte-for-byte move: any prompt-text drift fails here.
const GOLDEN: Record<string, string> = {
  systemJson: "cdd21ce09270b89e9ae01ac4bde7417226789419a618155f02ed401e4e82f5c4",
  systemJsonDefault: "cdd21ce09270b89e9ae01ac4bde7417226789419a618155f02ed401e4e82f5c4",
  systemMulti: "32531cd313962aa7bccc84d345683ac74d460fe2edc5b40b4528fa0e7de06b21",
  systemEditDsl: "4cba5cadd61544765740673d692820fe0b99eb5d550959b5e2599a7bfc8bd1f2",
  systemEditDslMulti: "f2cae2592f1f4513ccde79217efa75f17e2a14d4127e846f4a5d786a5fac749b",
  user: "fab917eb505894899f23e5c6389b1b1035c716be21b61eef3b2ef5a6c375c132",
  userEmpty: "b3b61b61b8aca5a1296decc363e1b0a9869dd9e31881fca4f2451a55a45ecba1",
  userBigSpec: "ca77bbabd5b99f9442c3f8e5c96500b84e6a8917e9f8c8add2a33517580fae8e",
  editJson: "bf01281b8050f59041136dc6b56825c5e8aef26d16a5553df3ede4333d82c509",
  editMulti: "8355d1b2c6f6c81b77d3e42da3e1e707b62a8798ee38b803c7db375ffe07d599",
  editDsl: "482527327da7e0f3f2dce926dc708866d643be7a10bc2349264f42a1b3cd4be8",
  targets: "14fa464c2b605fbdb538c5122dc2369e5aa7468c246ec78685b6a5d346f92523",
  createJson: "2366f08c45318acfcf13b56c7830117eb901357770bc2dcf598325ca217b0613",
  createDsl: "06dc605580f289bd366cf51f9dc689f17647ef0ec7f156e6c80fe31bc72aa84e",
  selectionRetry: "139beeaab3b0daa8405e3efd55ecd1970c318dfbb51d68a9fe78ed634cea198b",
  selectionContinuation: "163abbf779c72b2afa8c6900970fd928576d9d4d3bd85c68ac3f710c6c45d63c",
  dslSelectionRetry: "f98647d7bf2e5d118c70757673a6565de04de028d43269d72b9876825697ebac",
  dslSelectionContinuation: "fc34aeea0599554baa0962654afd472845e72228fa3d13001141efe3d25cfa64",
  dslUser: "d6b48e859339843fe48d57fd0de5c561d803985d907da5b369d3f9a4247729b5",
  dslDetails: "ba3c9ddb93b776a7fcf97df6ae45cf65e2ff1ae6047a12c854e220e7a2b2db08",
  dslCreate: "149437b86e816b5959f6ead357035cc74904af63ba68915f1bb56d6f0edc0134",
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

describe("prompt extraction parity", () => {
  test("the moved builders keep the pre-split prompt bytes", () => {
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
      systemJson: buildSystemPrompt(false, "json"),
      systemJsonDefault: buildSystemPrompt(false),
      systemMulti: buildSystemPrompt(true, "json"),
      systemEditDsl: buildSystemPrompt(false, "edit-dsl"),
      systemEditDslMulti: buildSystemPrompt(true, "edit-dsl"),
      user: buildUserPrompt("fix src/a.ts", 'files:\n  - path: "src/a.ts"\n', specFiles),
      userEmpty: buildUserPrompt("fix src/a.ts", "files:\n"),
      userBigSpec: buildUserPrompt("issue", "files:\n", [bigSpec]),
      editJson: buildEditPrompt(addressJson, symbolSource),
      editMulti: buildEditPrompt(addressJson, symbolSource, true),
      editDsl: buildEditPrompt(addressJson, symbolSource, false, "edit-dsl"),
      targets: buildTargetsEditPrompt(addressJson, symbolSource, [
        { path: "src/a.ts", name: "answer", kind: "function" },
        { path: "src/b.ts", name: "b", kind: "const" },
      ]),
      createJson: buildCreatePrompt(addressJson, "src/new.ts"),
      createDsl: buildCreatePrompt(addressJson, "src/new.ts", "edit-dsl"),
      selectionRetry: buildSelectionRetryPrompt(diagnostics),
      selectionContinuation: buildSelectionContinuationPrompt({
        round: 2,
        maxRounds: 32,
        diagnostics,
        failureHistory: "failure history",
        digest: "attempt digest",
      }),
      dslSelectionRetry: buildEditDslSelectionRetryPrompt("fix src/a.ts", indexText, diagnostics),
      dslSelectionContinuation: buildEditDslSelectionContinuationPrompt({
        round: 2,
        maxRounds: 32,
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
