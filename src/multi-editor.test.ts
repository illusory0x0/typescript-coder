import { describe, expect, test } from "bun:test";
import { applyResolvedRegions, parseCheck } from "./commit";
import { renderReadFailureFeedback, renderReadFeedback, resolveMultiEditor } from "./multi-editor";
import type { MultiEditorDeps } from "./multi-editor";
import { parseMultiEditor } from "./selection";
import { buildIndexTolerant } from "./utility";
import type { Locator, SymbolSpace } from "./utility";

function resolveEntryIn(
  current: string,
  currentPath: string,
  locator: Locator,
  space: SymbolSpace | null,
): ReturnType<MultiEditorDeps["resolveEntry"]> {
  const { index } = buildIndexTolerant([{ path: currentPath, source: current }]);
  const matches = index.lookup(locator, space);
  const entry = matches[0];
  if (matches.length === 1 && entry !== undefined) {
    return { ok: true, entry };
  }
  return {
    ok: false,
    diagnostics: "stage: address\nno unique declaration",
    undeclared: index.byName(locator.name).length === 0,
  };
}

function deps(
  files: Record<string, string>,
  unsafe: ReadonlySet<string> = new Set(),
): MultiEditorDeps {
  return {
    sourceFor: (path) => files[path] ?? "",
    fileExists: (path) => Object.prototype.hasOwnProperty.call(files, path),
    isSafePath: (path) => !unsafe.has(path),
    resolveEntry: resolveEntryIn,
  };
}

function resolve(text: string, files: Record<string, string>, unsafe?: ReadonlySet<string>) {
  return resolveMultiEditor(parseMultiEditor(text), deps(files, unsafe));
}

describe("resolveMultiEditor file commands", () => {
  test("create queues an empty file and rejects an existing path", () => {
    const ok = resolve("create src/new.ts end", {});
    expect(ok.failures).toEqual([]);
    expect(ok.creates).toEqual([{ index: 0, path: "src/new.ts" }]);

    const exists = resolve("create src/a.ts end", { "src/a.ts": "x" });
    expect(exists.creates).toEqual([]);
    expect(exists.failures[0]?.diagnostics).toContain("already exists");
  });

  test("delete queues an existing file and rejects a missing path", () => {
    const ok = resolve("delete src/a.ts end", { "src/a.ts": "x" });
    expect(ok.deletes).toEqual([{ index: 0, path: "src/a.ts" }]);

    const missing = resolve("delete src/a.ts end", {});
    expect(missing.deletes).toEqual([]);
    expect(missing.failures[0]?.diagnostics).toContain("does not exist");
  });

  test("read returns whole-file lines or selected lines without writing", () => {
    const files = { "src/a.ts": "one\ntwo\nthree\n" };
    const whole = resolve("read src/a.ts end", files);
    expect(whole.reads[0]?.lines).toEqual([
      { line: 1, text: "one" },
      { line: 2, text: "two" },
      { line: 3, text: "three" },
    ]);
    expect(whole.regions).toEqual([]);

    const selected = resolve("read src/a.ts within 2 end", files);
    expect(selected.reads[0]?.lines).toEqual([{ line: 2, text: "two" }]);
  });

  test("a huge read result folds to three head and three tail lines", () => {
    const source = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const read = resolve("read src/a.ts end", { "src/a.ts": source });
    const feedback = renderReadFeedback(read.reads);
    expect(feedback).toContain("src/a.ts (whole file, 10 lines; folded):");
    expect(feedback).toContain("1 | line 1");
    expect(feedback).toContain("3 | line 3");
    expect(feedback).toContain("... // content folded, src/a.ts: 4-7L");
    expect(feedback).toContain("(4 of 10 lines hidden)");
    expect(feedback).toContain("expand with read src/a.ts within 4-7 end");
    expect(feedback).toContain("8 | line 8");
    expect(feedback).toContain("10 | line 10");
    expect(feedback).not.toContain("4 | line 4");
  });

  test("a whole-file read folds top-level function bodies into an outline", () => {
    const source = [
      "export function first(): number {",
      "  const a = 1;",
      "  if (a > 0) {",
      "    const b = 2;",
      "    const c = 3;",
      "    return b + c;",
      "  }",
      "  return a;",
      "}",
      "export function second(): number {",
      "  return 2;",
      "}",
    ].join("\n");
    const read = resolve("read src/a.ts end", { "src/a.ts": source });
    const feedback = renderReadFeedback(read.reads);
    expect(feedback).toContain("src/a.ts (whole file, 12 lines; folded):");
    expect(feedback).toContain("1 | export function first(): number {");
    expect(feedback).toContain("... // content folded, src/a.ts: 2-8L");
    expect(feedback).toContain("9 | }");
    expect(feedback).toContain("10 | export function second(): number {");
    expect(feedback).not.toContain("4 |     const b = 2;");
  });

  test("a selected-lines read is the expansion and comes back unfolded", () => {
    const source = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
    const read = resolve("read src/a.ts within 1-20 end", { "src/a.ts": source });
    const feedback = renderReadFeedback(read.reads);
    expect(feedback).toContain("src/a.ts (selected lines, 20 lines):");
    expect(feedback).toContain("1 | line 1");
    expect(feedback).toContain("20 | line 20");
    expect(feedback).not.toContain("content folded");
    expect(feedback).not.toContain("showing 6");
  });

  test("a short read keeps the quiet header shape", () => {
    const read = resolve("read src/a.ts end", { "src/a.ts": "one\ntwo\nthree\n" });
    const feedback = renderReadFeedback(read.reads);
    expect(feedback).toContain("src/a.ts (whole file, 3 lines):");
    expect(feedback).not.toContain("folded");
  });

  test("write with no within replaces the whole file", () => {
    const result = resolve(
      [
        "write src/a.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        "export const a = 2;",
        "<<<TC_EDIT_END>>>",
      ].join("\n"),
      { "src/a.ts": "export const a = 1;\n" },
    );
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]).toMatchObject({
      path: "src/a.ts",
      start: 0,
      end: 20,
      text: "export const a = 2;",
    });
  });

  test("write with within replaces only the selected line", () => {
    const result = resolve(
      [
        "write src/a.ts within 2 with",
        "<<<TC_EDIT_BEGIN>>>",
        "two changed",
        "<<<TC_EDIT_END>>>",
      ].join("\n"),
      { "src/a.ts": "one\ntwo\nthree\n" },
    );
    expect(result.failures).toEqual([]);
    expect(result.regions[0]).toMatchObject({
      start: 4,
      end: 7,
      text: "two changed",
    });
  });

  test("write creates a missing file at offset 0", () => {
    const result = resolve(
      [
        "write src/new.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        "export const a = 1;",
        "<<<TC_EDIT_END>>>",
      ].join("\n"),
      {},
    );
    expect(result.failures).toEqual([]);
    expect(result.regions[0]).toMatchObject({ path: "src/new.ts", start: 0, end: 0 });
  });

  test("rejects unsafe paths", () => {
    const result = resolve("create ../outside.ts end", {}, new Set(["../outside.ts"]));
    expect(result.creates).toEqual([]);
    expect(result.failures[0]?.diagnostics).toContain("outside the editable workspace");
  });

  test("conflicts create/delete with another operation on the same path", () => {
    const createWrite = resolve(
      [
        "create src/a.ts end",
        "write src/a.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        "x",
        "<<<TC_EDIT_END>>>",
      ].join("\n"),
      {},
    );
    expect(createWrite.failures[0]?.diagnostics).toContain("conflicts");
  });

  test("rejects overlapping write ranges", () => {
    const result = resolve(
      [
        "write src/a.ts within {1, 1:2-2:4} with",
        "<<<TC_EDIT_BEGIN>>>",
        "x",
        "<<<TC_EDIT_END>>>",
      ].join("\n"),
      { "src/a.ts": "one\ntwo\nthree\n" },
    );
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.diagnostics).toContain("overlap");
  });

  test("a failed read is feedback and does not discard the reply's write (#25)", () => {
    const result = resolve(
      [
        "write src/a.ts with",
        "<<<TC_EDIT_BEGIN>>>",
        "two",
        "<<<TC_EDIT_END>>>",
        "read src/a.ts within 99 end",
      ].join("\n"),
      { "src/a.ts": "one\n" },
    );
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(1);
    expect(result.reads).toEqual([]);
    expect(result.readFailures).toHaveLength(1);
    expect(result.readFailures[0]?.diagnostics).toContain("stage: range");
    expect(renderReadFailureFeedback(result.readFailures)).toContain("clause 2");
  });

  test("a read-only reply keeps successful reads beside the failed one", () => {
    const result = resolve(
      ["read src/a.ts within 1 end", "read src/a.ts within 99 end"].join("\n"),
      { "src/a.ts": "one\ntwo\n" },
    );
    expect(result.reads).toHaveLength(1);
    expect(result.readFailures).toHaveLength(1);
    expect(result.failures).toEqual([]);
  });
});

const HELPER = [
  "export function answer(): number {",
  "  return 1;",
  "}",
  "",
  "export function other(): number {",
  "  return 2;",
  "}",
  "",
].join("\n");

function replaceClause(name: string, body: string, path = "src/helper.ts"): string {
  return [
    `select function ${name} in ${path}`,
    "match `return 1;`",
    "replace with",
    "<<<TC_EDIT_BEGIN>>>",
    body,
    "<<<TC_EDIT_END>>>",
    "end",
  ].join("\n");
}

function renameClause(name: string, to: string, path = "src/helper.ts"): string {
  return `select function ${name} in ${path}\nrename ${name} to ${to}\nend`;
}

describe("resolveMultiEditor unique resolved targets (#40)", () => {
  test("rename + replace on one declaration is a duplicate", () => {
    const result = resolve(
      [replaceClause("answer", "return 3;"), renameClause("answer", "result")].join("\n\n"),
      { "src/helper.ts": HELPER },
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.index).toBe(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    expect(result.failures[0]?.diagnostics).toContain(
      'clause 1 and clause 2 both select the same function "answer" in "src/helper.ts"',
    );
    // The first clause is queued; the duplicate rename contributes no edits.
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.index).toBe(0);
  });

  test("two renames of one declaration are duplicates", () => {
    const result = resolve(
      [renameClause("answer", "result"), renameClause("answer", "renamed")].join("\n\n"),
      { "src/helper.ts": HELPER },
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.index).toBe(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    expect(result.failures[0]?.diagnostics).toContain(
      'clause 1 and clause 2 both select the same function "answer" in "src/helper.ts"',
    );
    // Only the first rename's edit is queued.
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.index).toBe(0);
    expect(result.regions[0]?.text).toBe("result");
  });

  test("a viewer and a rename on one declaration are duplicates", () => {
    const viewer = "select function answer in src/helper.ts\nmatch `return 1;`\nend";
    const result = resolve([viewer, renameClause("answer", "result")].join("\n\n"), {
      "src/helper.ts": HELPER,
    });
    expect(result.viewers).toHaveLength(1);
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.index).toBe(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    expect(result.failures[0]?.diagnostics).toContain(
      'clause 1 and clause 2 both select the same function "answer" in "src/helper.ts"',
    );
  });

  test("a rename of one declaration and an edit of another are allowed", () => {
    const result = resolve(
      [replaceClause("answer", "return 3;"), renameClause("other", "second")].join("\n\n"),
      { "src/helper.ts": HELPER },
    );
    expect(result.failures).toEqual([]);
    expect(result.regions.map((region) => region.index)).toEqual([0, 1]);
  });

  test("the same symbol renamed in another file is allowed", () => {
    const result = resolve(
      [
        replaceClause("answer", "return 3;", "src/a.ts"),
        renameClause("answer", "result", "src/b.ts"),
      ].join("\n\n"),
      { "src/a.ts": HELPER, "src/b.ts": HELPER },
    );
    expect(result.failures).toEqual([]);
    expect(result.regions.map((region) => region.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("a rename registered before an editor still names both clause numbers", () => {
    const result = resolve(
      [renameClause("answer", "result"), replaceClause("answer", "return 3;")].join("\n\n"),
      { "src/helper.ts": HELPER },
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    expect(result.failures[0]?.diagnostics).toContain(
      'clause 1 and clause 2 both select the same function "answer" in "src/helper.ts"',
    );
    // The editor is claimed first, so the rename (clause 1) is the rejected
    // clause and its edits are not queued.
    expect(result.failures[0]?.index).toBe(0);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.index).toBe(1);
  });
});

function createDeclaration(
  kind: string,
  name: string,
  path: string,
  body: string,
  isStatic = false,
): string {
  return [
    `create ${isStatic ? "static " : ""}${kind} ${name} in ${path} with`,
    "<<<TC_EDIT_BEGIN>>>",
    body,
    "<<<TC_EDIT_END>>>",
    "end",
  ].join("\n");
}

describe("resolveMultiEditor kind-aware create (#50)", () => {
  test("creates every top-level declaration kind at the end of an existing file", () => {
    const cases: Array<[string, string]> = [
      ["function", "export function target(): number {\n  return 1;\n}"],
      ["class", "export class target {}"],
      ["interface", "export interface target {\n  value: number;\n}"],
      ["type", "export type target = number;"],
      ["enum", "export enum target {\n  A = 0,\n}"],
      ["namespace", "export namespace target {\n  export const inner = 1;\n}"],
      ["const", "export const target = 1;"],
      ["let", "export let target = 1;"],
      ["var", "export var target = 1;"],
      ["using", "export using target = resource();"],
    ];
    const source = "export const existing = 1;\n";
    for (const [kind, body] of cases) {
      const result = resolve(createDeclaration(kind, "target", "src/a.ts", body), {
        "src/a.ts": source,
      });
      expect(result.failures).toEqual([]);
      const region = result.regions[0];
      expect(region?.create).toBe(true);
      expect(region?.start).toBe(source.length);
      expect(region?.end).toBe(source.length);
      expect(region?.text).toBe(`\n${body}\n`);
    }
  });

  test("wraps a body-only fence for const/let/var/using only", () => {
    for (const kind of ["const", "let", "var", "using"]) {
      const result = resolve(createDeclaration(kind, "value", "src/a.ts", "compute()"), {
        "src/a.ts": "",
      });
      expect(result.failures).toEqual([]);
      expect(result.regions[0]?.text).toBe(`${kind} value = compute();\n`);
    }
    const classBody = resolve(createDeclaration("class", "value", "src/a.ts", "42"), {
      "src/a.ts": "",
    });
    expect(classBody.regions).toEqual([]);
    expect(classBody.failures[0]?.diagnostics).toContain("does not contain a supported");
  });

  test("rejects a kind, name, or space mismatch without a region", () => {
    const kind = resolve(createDeclaration("function", "target", "src/a.ts", "const target = 1;"), {
      "src/a.ts": "",
    });
    expect(kind.regions).toEqual([]);
    expect(kind.failures[0]?.stage).toBe("address");
    expect(kind.failures[0]?.diagnostics).toContain("EDIT_CREATE_KIND_MISMATCH");
    expect(kind.failures[0]?.diagnostics).toContain('"function"');
    expect(kind.failures[0]?.diagnostics).toContain('create const "target"');
    expect(kind.failures[0]?.diagnostics).toContain("write src/a.ts with");

    const name = resolve(
      createDeclaration("function", "target", "src/a.ts", "function other(): void {}"),
      { "src/a.ts": "" },
    );
    expect(name.regions).toEqual([]);
    expect(name.failures[0]?.diagnostics).toContain("EDIT_CREATE_NAME_MISMATCH");
    expect(name.failures[0]?.diagnostics).toContain('"other"');
    expect(name.failures[0]?.diagnostics).toContain('create function "other"');
    expect(name.failures[0]?.diagnostics).toContain("write src/a.ts with");

    const space = resolve(createDeclaration("type", "target", "src/a.ts", "class target {}"), {
      "src/a.ts": "",
    });
    expect(space.regions).toEqual([]);
    expect(space.failures[0]?.diagnostics).toContain("EDIT_CREATE_KIND_MISMATCH");
    expect(space.failures[0]?.diagnostics).toContain('"type"');
  });

  test("rejects a duplicate top-level declaration and an unsafe path", () => {
    const duplicate = resolve(
      createDeclaration("function", "parse", "src/a.ts", "function parse(): void {}"),
      { "src/a.ts": "function parse(): void {}\n" },
    );
    expect(duplicate.regions).toEqual([]);
    expect(duplicate.failures[0]?.stage).toBe("duplicate");
    expect(duplicate.failures[0]?.diagnostics).toContain("EDIT_CREATE_DUPLICATE");
    expect(duplicate.failures[0]?.diagnostics).toContain('"parse"');

    const unsafe = resolve(
      createDeclaration("function", "parse", "../outside.ts", "function parse(): void {}"),
      {},
      new Set(["../outside.ts"]),
    );
    expect(unsafe.regions).toEqual([]);
    expect(unsafe.failures[0]?.stage).toBe("address");
    expect(unsafe.failures[0]?.diagnostics).toContain("outside the editable workspace");
  });

  test("rejects a malformed fence and a wrong modifier", () => {
    const malformed = resolve(createDeclaration("class", "Target", "src/a.ts", "class Target {"), {
      "src/a.ts": "",
    });
    expect(malformed.regions).toEqual([]);
    expect(malformed.failures[0]?.diagnostics).toContain("EDIT_CREATE_MALFORMED");

    const invalid = resolve(
      createDeclaration("const", "VALUE", "src/a.ts", "abstract const VALUE = 1;"),
      { "src/a.ts": "" },
    );
    expect(invalid.regions).toEqual([]);
    expect(invalid.failures[0]?.diagnostics).toMatch(
      /EDIT_CREATE_MALFORMED|EDIT_CREATE_INVALID_MODIFIER/,
    );
  });

  const CLASS = [
    "export class Parser {",
    "  parseValue(): number {",
    "    return 1;",
    "  }",
    "}",
    "",
  ].join("\n");

  test("creates class methods, properties, accessors, and constructors before the closing brace", () => {
    const cases: Array<[string, string, string, boolean]> = [
      ["method", "Parser.trim", "trim(): string {\n  return '';\n}", false],
      ["property", "Parser.count", "count = 0;", false],
      ["getter", "Parser.value", "get value(): number {\n  return 1;\n}", false],
      ["setter", "Parser.value", "set value(next: number) {}", false],
      ["accessor", "Parser.other", "get other(): number {\n  return 1;\n}", false],
      ["constructor", "Parser", "constructor(readonly value: number) {}", false],
      ["method", "Parser.parse", "static parse(): number {\n  return 1;\n}", true],
      ["property", "Parser.total", "static total = 0;", true],
      ["accessor", "Parser.current", "static get current(): number {\n  return 1;\n}", true],
      ["getter", "Parser.state", "static get state(): number {\n  return 1;\n}", true],
      ["setter", "Parser.state", "static set state(next: number) {}", true],
    ];
    for (const [kind, name, body, isStatic] of cases) {
      const result = resolve(createDeclaration(kind, name, "src/parser.ts", body, isStatic), {
        "src/parser.ts": CLASS,
      });
      expect(result.failures).toEqual([]);
      const region = result.regions[0];
      expect(region?.create).toBe(true);
      expect(region?.start).toBe(
        CLASS.lastIndexOf("}") >= 0 ? CLASS.lastIndexOf("\n}", CLASS.length - 1) + 1 : 0,
      );
      expect(region?.text).toContain(body.split("\n")[0]?.trim() ?? "");
      expect(region?.text.endsWith("\n")).toBe(true);
    }
  });

  test("rejects duplicate members but allows a static/instance pair and a getter/setter pair", () => {
    const duplicate = resolve(
      createDeclaration(
        "method",
        "Parser.parseValue",
        "src/parser.ts",
        "parseValue(): number { return 2; }",
      ),
      { "src/parser.ts": CLASS },
    );
    expect(duplicate.regions).toEqual([]);
    expect(duplicate.failures[0]?.stage).toBe("duplicate");
    expect(duplicate.failures[0]?.diagnostics).toContain("EDIT_CREATE_DUPLICATE_MEMBER");

    const staticPair = resolve(
      createDeclaration(
        "static method",
        "Parser.parseValue",
        "src/parser.ts",
        "static parseValue(): number { return 2; }",
      ),
      { "src/parser.ts": CLASS },
    );
    expect(staticPair.failures).toEqual([]);
    expect(staticPair.regions).toHaveLength(1);

    const accessorPair = resolve(
      createDeclaration("setter", "Parser.value", "src/parser.ts", "set value(next: number) {}"),
      { "src/parser.ts": CLASS },
    );
    expect(accessorPair.failures).toEqual([]);
  });

  test("rejects a static/instance identity conflict", () => {
    const descriptorStatic = resolve(
      createDeclaration(
        "method",
        "Parser.parse",
        "src/parser.ts",
        "parse(): number { return 1; }",
        true,
      ),
      { "src/parser.ts": CLASS },
    );
    expect(descriptorStatic.failures[0]?.diagnostics).toContain("EDIT_CREATE_MODIFIER_MISMATCH");
    expect(descriptorStatic.failures[0]?.diagnostics).toContain("descriptor is static");

    const fenceStatic = resolve(
      createDeclaration(
        "method",
        "Parser.parse",
        "src/parser.ts",
        "static parse(): number { return 1; }",
      ),
      { "src/parser.ts": CLASS },
    );
    expect(fenceStatic.failures[0]?.diagnostics).toContain("EDIT_CREATE_MODIFIER_MISMATCH");
    expect(fenceStatic.failures[0]?.diagnostics).toContain("fence member is static");
  });

  test("rejects a static descriptor for owners and member kinds that cannot carry static", () => {
    const interfaceSource = "export interface Cell {\n  value: number;\n}\n";
    for (const [kind, name, body] of [
      ["method", "Cell.foo", "foo(): void {}"],
      ["property", "Cell.label", "label: string;"],
    ] as const) {
      const result = resolve(createDeclaration(kind, name, "src/types.ts", body, true), {
        "src/types.ts": interfaceSource,
      });
      expect(result.regions).toEqual([]);
      expect(result.failures[0]?.stage).toBe("address");
      expect(result.failures[0]?.diagnostics).toContain("EDIT_CREATE_INVALID_MODIFIER");
      expect(result.failures[0]?.diagnostics).toContain("only valid for class members");
    }

    const enumResult = resolve(
      createDeclaration("enum-member", "Color.Red", "src/color.ts", "Red = 0", true),
      { "src/color.ts": "export enum Color {\n  Blue = 1,\n}\n" },
    );
    expect(enumResult.regions).toEqual([]);
    expect(enumResult.failures[0]?.diagnostics).toContain("EDIT_CREATE_INVALID_MODIFIER");
    expect(enumResult.failures[0]?.diagnostics).toContain("only valid for class members");

    const constructor = resolve(
      createDeclaration("constructor", "Parser", "src/parser.ts", "constructor() {}", true),
      { "src/parser.ts": CLASS },
    );
    expect(constructor.regions).toEqual([]);
    expect(constructor.failures[0]?.diagnostics).toContain("EDIT_CREATE_INVALID_MODIFIER");
    expect(constructor.failures[0]?.diagnostics).toContain("constructor member");
  });

  test("rejects static before a top-level or namespace declaration kind at parse time", () => {
    const parseRejected = (text: string): void => {
      expect(() => parseMultiEditor(text)).toThrow(/static/);
    };
    parseRejected(
      createDeclaration(
        "function",
        "Util.helper",
        "src/util.ts",
        "export function helper(): void {}",
        true,
      ),
    );
    parseRejected(
      createDeclaration("const", "Util.VALUE", "src/util.ts", "export const VALUE = 2;", true),
    );
    parseRejected(
      createDeclaration(
        "function",
        "topLevel",
        "src/a.ts",
        "export function topLevel(): void {}",
        true,
      ),
    );
    parseRejected(
      createDeclaration("const", "topLevel", "src/a.ts", "export const topLevel = 1;", true),
    );
  });

  test("rejects fence modifiers that the member kind cannot carry", () => {
    const interfaceMethod = resolve(
      createDeclaration("method", "Cell.read", "src/types.ts", "readonly read(): number;"),
      { "src/types.ts": "export interface Cell {\n  value: number;\n}\n" },
    );
    expect(interfaceMethod.regions).toEqual([]);
    expect(interfaceMethod.failures[0]?.diagnostics).toContain("EDIT_CREATE_INVALID_MODIFIER");
    expect(interfaceMethod.failures[0]?.diagnostics).toContain("interface method");

    const interfaceProperty = resolve(
      createDeclaration("property", "Cell.label", "src/types.ts", "readonly label: string;"),
      { "src/types.ts": "export interface Cell {\n  value: number;\n}\n" },
    );
    expect(interfaceProperty.failures).toEqual([]);
    expect(interfaceProperty.regions).toHaveLength(1);

    const classMethod = resolve(
      createDeclaration("method", "Parser.trim", "src/parser.ts", "declare trim(): void {}"),
      { "src/parser.ts": CLASS },
    );
    expect(classMethod.regions).toEqual([]);
    expect(classMethod.failures[0]?.diagnostics).toContain("EDIT_CREATE_INVALID_MODIFIER");
    expect(classMethod.failures[0]?.diagnostics).toContain("class method");

    const classProperty = resolve(
      createDeclaration("property", "Parser.count", "src/parser.ts", "async count = 0;"),
      { "src/parser.ts": CLASS },
    );
    expect(classProperty.regions).toEqual([]);
    expect(classProperty.failures[0]?.diagnostics).toContain("EDIT_CREATE_INVALID_MODIFIER");

    const constructor = resolve(
      createDeclaration("constructor", "Parser", "src/parser.ts", "override constructor() {}"),
      { "src/parser.ts": CLASS },
    );
    expect(constructor.regions).toEqual([]);
    expect(constructor.failures[0]?.diagnostics).toContain("EDIT_CREATE_INVALID_MODIFIER");

    const accessor = resolve(
      createDeclaration(
        "accessor",
        "Parser.value",
        "src/parser.ts",
        "declare get value(): number {\n  return 1;\n}",
      ),
      { "src/parser.ts": CLASS },
    );
    expect(accessor.regions).toEqual([]);
    expect(accessor.failures[0]?.diagnostics).toContain("EDIT_CREATE_INVALID_MODIFIER");

    const namespace = resolve(
      createDeclaration(
        "function",
        "Util.helper",
        "src/util.ts",
        "export default function helper(): void {}",
      ),
      { "src/util.ts": "export namespace Util {\n  export const existing = 1;\n}\n" },
    );
    expect(namespace.regions).toEqual([]);
    expect(namespace.failures[0]?.diagnostics).toContain("EDIT_CREATE_INVALID_MODIFIER");
    expect(namespace.failures[0]?.diagnostics).toContain("namespace function");

    const enumModifier = resolve(
      createDeclaration("enum-member", "Color.Red", "src/color.ts", "static Red = 0"),
      { "src/color.ts": "export enum Color {\n  Blue = 1,\n}\n" },
    );
    expect(enumModifier.regions).toEqual([]);
    expect(enumModifier.failures[0]?.diagnostics).toMatch(
      /EDIT_CREATE_MALFORMED|EDIT_CREATE_INVALID_MODIFIER/,
    );

    const namespaceModifier = resolve(
      createDeclaration(
        "function",
        "Util.helper",
        "src/util.ts",
        "static function helper(): void {}",
      ),
      { "src/util.ts": "export namespace Util {\n  export const existing = 1;\n}\n" },
    );
    expect(namespaceModifier.regions).toEqual([]);
    expect(namespaceModifier.failures[0]?.diagnostics).toMatch(
      /EDIT_CREATE_MALFORMED|EDIT_CREATE_INVALID_MODIFIER/,
    );

    const staticConstructorFence = resolve(
      createDeclaration("constructor", "Parser", "src/parser.ts", "static constructor() {}"),
      { "src/parser.ts": CLASS },
    );
    expect(staticConstructorFence.regions).toEqual([]);
    expect(staticConstructorFence.failures[0]?.diagnostics).toContain("EDIT_CREATE_KIND_MISMATCH");
  });

  test("rejects missing, ambiguous, and wrong-kind owners", () => {
    const missing = resolve(
      createDeclaration("method", "Missing.run", "src/a.ts", "run(): void {}"),
      { "src/a.ts": "" },
    );
    expect(missing.failures[0]?.stage).toBe("address");
    expect(missing.failures[0]?.diagnostics).toContain("EDIT_CREATE_OWNER_MISSING");
    expect(missing.failures[0]?.diagnostics).toContain("never creates its owner");

    const ambiguous = resolve(
      createDeclaration("method", "Owner.run", "src/a.ts", "run(): void {}"),
      { "src/a.ts": "class Owner {}\ninterface Owner {\n  value: number;\n}\n" },
    );
    expect(ambiguous.failures[0]?.stage).toBe("address");
    expect(ambiguous.failures[0]?.diagnostics).toContain("EDIT_CREATE_OWNER_AMBIGUOUS");
    expect(ambiguous.failures[0]?.diagnostics).toContain("class at line 1");
    expect(ambiguous.failures[0]?.diagnostics).toContain("interface at line 2");

    const wrongKind = resolve(
      createDeclaration("constructor", "Owner", "src/a.ts", "constructor() {}"),
      { "src/a.ts": "interface Owner {\n  value: number;\n}\n" },
    );
    expect(wrongKind.failures[0]?.stage).toBe("address");
    expect(wrongKind.failures[0]?.diagnostics).toContain("EDIT_CREATE_OWNER_KIND");
  });

  test("creates interface method and property members", () => {
    const source = "export interface Cell {\n  value: number;\n}\n";
    for (const [kind, body] of [
      ["method", "read(): number;"],
      ["property", "label: string;"],
    ] as const) {
      const result = resolve(
        createDeclaration(
          kind,
          kind === "method" ? "Cell.read" : "Cell.label",
          "src/types.ts",
          body,
        ),
        { "src/types.ts": source },
      );
      expect(result.failures).toEqual([]);
      expect(result.regions[0]?.text).toContain(body);
    }
    const unsupported = resolve(
      createDeclaration(
        "getter",
        "Cell.value",
        "src/types.ts",
        "get value(): number { return 1; }",
      ),
      { "src/types.ts": source },
    );
    expect(unsupported.failures[0]?.diagnostics).toContain("EDIT_CREATE_OWNER_KIND");
  });

  test("creates namespace declaration members with a dotted owner", () => {
    const source = "export namespace Util {\n  export const existing = 1;\n}\n";
    for (const [kind, body] of [
      ["function", "export function helper(): number {\n  return 1;\n}"],
      ["const", "export const VALUE = 2;"],
      ["class", "export class Helper {}"],
    ] as const) {
      const name = `Util.${kind === "function" ? "helper" : kind === "const" ? "VALUE" : "Helper"}`;
      const result = resolve(createDeclaration(kind, name, "src/util.ts", body), {
        "src/util.ts": source,
      });
      expect(result.failures).toEqual([]);
      expect(result.regions[0]?.text).toContain(body.split("\n")[0] ?? "");
    }
  });

  test("creates an enum member", () => {
    const source = "export enum Color {\n  Red = 0,\n}\n";
    const result = resolve(
      createDeclaration("enum-member", "Color.Blue", "src/color.ts", "Blue = 1"),
      { "src/color.ts": source },
    );
    expect(result.failures).toEqual([]);
    expect(result.regions[0]?.text).toContain("Blue = 1");

    const duplicate = resolve(
      createDeclaration("enum-member", "Color.Red", "src/color.ts", "Red = 2"),
      { "src/color.ts": source },
    );
    expect(duplicate.failures[0]?.stage).toBe("duplicate");
  });

  test("a dotted create cannot create its owner", () => {
    const result = resolve(
      createDeclaration(
        "function",
        "Ns.helper",
        "src/util.ts",
        "export function helper(): void {}",
      ),
      { "src/util.ts": "" },
    );
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.diagnostics).toContain("EDIT_CREATE_OWNER_MISSING");
  });

  test("multiple creates are separate statements and same-file inserts keep statement order", () => {
    const source = CLASS;
    const text = [
      createDeclaration("method", "Parser.first", "src/parser.ts", "first(): number { return 1; }"),
      createDeclaration(
        "method",
        "Parser.second",
        "src/parser.ts",
        "second(): number { return 2; }",
      ),
      createDeclaration("function", "helper", "src/parser.ts", "export function helper(): void {}"),
    ].join("\n\n");
    const result = resolve(text, { "src/parser.ts": source });
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(3);
    const memberRegions = result.regions.slice(0, 2);
    expect(memberRegions[0]?.start).toBe(memberRegions[1]?.start);
    expect(memberRegions.map((region) => region.index)).toEqual([0, 1]);
    expect(result.regions[2]?.start).toBe(source.length);
  });

  test("repeated creates of one declaration are a duplicate claim", () => {
    const clause = createDeclaration(
      "function",
      "helper",
      "src/a.ts",
      "export function helper(): void {}",
    );
    const result = resolve([clause, clause].join("\n\n"), { "src/a.ts": "" });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    expect(result.failures[0]?.diagnostics).toContain("both create the same top-level function");
  });

  test("an implicit create and an explicit create of one declaration conflict", () => {
    const implicit = [
      "select const VALUE in src/a.ts",
      "replace with",
      "<<<TC_EDIT_BEGIN>>>",
      "const VALUE = 1;",
      "<<<TC_EDIT_END>>>",
      "end",
    ].join("\n");
    const explicit = createDeclaration("const", "VALUE", "src/a.ts", "const VALUE = 2;");
    const result = resolve([implicit, explicit].join("\n\n"), { "src/a.ts": "" });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    expect(result.failures[0]?.diagnostics).toContain("both create the same top-level const");
  });

  test("repeated new members on one owner are a duplicate", () => {
    const clause = createDeclaration("method", "Parser.first", "src/parser.ts", "first(): void {}");
    const result = resolve([clause, clause].join("\n\n"), { "src/parser.ts": CLASS });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("duplicate");
    expect(result.failures[0]?.diagnostics).toContain("same member");
  });

  test("applies multiple same-owner creates in statement order", async () => {
    const source = CLASS;
    const text = [
      createDeclaration("method", "Parser.first", "src/parser.ts", "first(): number { return 1; }"),
      createDeclaration(
        "method",
        "Parser.second",
        "src/parser.ts",
        "second(): number { return 2; }",
      ),
    ].join("\n\n");
    const result = resolve(text, { "src/parser.ts": source });
    expect(result.failures).toEqual([]);
    const writes = await applyResolvedRegions({
      regions: result.regions.map((region) => ({ ...region, replacement: region.text })),
      fileSourceOf: (path) => (path === "src/parser.ts" ? source : ""),
      target: "src/parser.ts",
      prevCheck: parseCheck(source),
      policy: { sameOffsetInserts: "append" },
      noteFailure: () => {
        throw new Error("unexpected apply failure");
      },
      noteOverlap: () => {
        throw new Error("unexpected overlap");
      },
    });
    expect(writes).toHaveLength(1);
    const applied = writes[0]?.source ?? "";
    expect(applied.indexOf("first()")).toBeLessThan(applied.indexOf("second()"));
    expect(applied.indexOf("second()")).toBeLessThan(applied.lastIndexOf("}"));
  });

  test("conflicts a declaration create with a write, delete, or empty-file create", () => {
    const create = createDeclaration(
      "function",
      "helper",
      "src/a.ts",
      "export function helper(): void {}",
    );
    const write = [
      "write src/a.ts with",
      "<<<TC_EDIT_BEGIN>>>",
      "export const a = 1;",
      "<<<TC_EDIT_END>>>",
    ].join("\n");
    const withWrite = resolve([create, write].join("\n\n"), { "src/a.ts": "" });
    expect(withWrite.failures[0]?.diagnostics).toContain("whole-file write");

    const withDelete = resolve([create, "delete src/a.ts end"].join("\n\n"), {
      "src/a.ts": "export const old = 1;\n",
    });
    expect(withDelete.failures[0]?.diagnostics).toContain("delete");

    const withEmptyCreate = resolve([create, "create src/a.ts end"].join("\n\n"), {
      "src/a.ts": "",
    });
    expect(withEmptyCreate.failures[0]?.diagnostics).toContain("empty-file create");
  });
});

describe("module-boundary create (#54)", () => {
  const moduleCreate = (kind: "import" | "export", path: string, body: string): string =>
    [
      `create ${kind} in ${path} with`,
      "<<<TC_EDIT_BEGIN>>>",
      body,
      "<<<TC_EDIT_END>>>",
      "end",
    ].join("\n");

  test("creates an import in a new file and an existing file", () => {
    const fresh = resolve(moduleCreate("import", "src/new.ts", 'import { a } from "./a";'), {});
    expect(fresh.failures).toEqual([]);
    expect(fresh.regions[0]?.start).toBe(0);
    expect(fresh.regions[0]?.text).toBe('import { a } from "./a";\n');

    const source = "export const existing = 1;\n";
    const existing = resolve(moduleCreate("import", "src/a.ts", 'import { a } from "./a";'), {
      "src/a.ts": source,
    });
    expect(existing.failures).toEqual([]);
    expect(existing.regions[0]?.start).toBe(0);
    expect(existing.regions[0]?.text).toBe('import { a } from "./a";\n');
  });

  test("inserts after the shebang, directives, and existing imports", async () => {
    const source = [
      "#!/usr/bin/env bun",
      '"use strict";',
      'import { a } from "./a";',
      "",
      "export const existing = 1;",
      "",
    ].join("\n");
    const result = resolve(
      [
        moduleCreate("import", "src/a.ts", 'import { b } from "./b";'),
        moduleCreate("export", "src/a.ts", 'export { b } from "./b";'),
      ].join("\n\n"),
      { "src/a.ts": source },
    );
    expect(result.failures).toEqual([]);
    const writes = await applyResolvedRegions({
      regions: result.regions.map((region) => ({ ...region, replacement: region.text })),
      fileSourceOf: () => source,
      target: "src/a.ts",
      prevCheck: parseCheck(source),
      policy: { sameOffsetInserts: "append" },
      noteFailure: () => {
        throw new Error("unexpected apply failure");
      },
      noteOverlap: () => {
        throw new Error("unexpected overlap");
      },
    });
    const applied = writes[0]?.source ?? "";
    expect(applied.startsWith("#!/usr/bin/env bun\n")).toBe(true);
    expect(applied.indexOf('"use strict";')).toBeLessThan(applied.indexOf("import { a }"));
    expect(applied.indexOf("import { a }")).toBeLessThan(applied.indexOf("import { b }"));
    expect(applied.indexOf("import { b }")).toBeLessThan(applied.indexOf("export { b }"));
    expect(applied.indexOf("export { b }")).toBeLessThan(applied.indexOf("export const existing"));
  });

  test("accepts named, default, namespace, type-only, side-effect, and export forms", () => {
    const cases: Array<["import" | "export", string]> = [
      ["import", 'import { a, b as c } from "./a";'],
      ["import", 'import def from "./a";'],
      ["import", 'import * as ns from "./a";'],
      ["import", 'import type { T } from "./a";'],
      ["import", 'import "./side-effect";'],
      ["export", 'export { a } from "./a";'],
      ["export", 'export * from "./a";'],
      ["export", 'export * as ns from "./a";'],
      ["export", "export default function boot(): void {}"],
      ["export", "export default 1;"],
      ["export", "export = value;"],
    ];
    for (const [kind, body] of cases) {
      const result = resolve(moduleCreate(kind, "src/a.ts", body), { "src/a.ts": "" });
      expect(result.failures).toEqual([]);
      expect(result.regions[0]?.text).toBe(`${body}\n`);
    }
  });

  test("rejects malformed, multi-statement, and wrong-kind fences", () => {
    const malformed = resolve(moduleCreate("import", "src/a.ts", "import { a"), {
      "src/a.ts": "",
    });
    expect(malformed.regions).toEqual([]);
    expect(malformed.failures[0]?.diagnostics).toContain("EDIT_CREATE_MODULE_MALFORMED");

    const multi = resolve(moduleCreate("import", "src/a.ts", 'import "a";\nimport "b";'), {
      "src/a.ts": "",
    });
    expect(multi.regions).toEqual([]);
    expect(multi.failures[0]?.diagnostics).toContain("2 top-level statements");

    const mismatch = resolve(moduleCreate("export", "src/a.ts", 'import "a";'), {
      "src/a.ts": "",
    });
    expect(mismatch.regions).toEqual([]);
    expect(mismatch.failures[0]?.diagnostics).toContain("EDIT_CREATE_MODULE_KIND_MISMATCH");
  });

  test("rejects duplicate statements, duplicate import bindings, export names, and a second default export", () => {
    const source = [
      'import { a } from "./a";',
      'export { a } from "./a";',
      "export default function boot(): void {}",
      "",
    ].join("\n");
    const sameImport = resolve(moduleCreate("import", "src/a.ts", 'import { a } from "./a";'), {
      "src/a.ts": source,
    });
    expect(sameImport.regions).toEqual([]);
    expect(sameImport.failures[0]?.stage).toBe("duplicate");

    const sameBinding = resolve(moduleCreate("import", "src/a.ts", 'import { a } from "./b";'), {
      "src/a.ts": source,
    });
    expect(sameBinding.regions).toEqual([]);
    expect(sameBinding.failures[0]?.stage).toBe("duplicate");
    expect(sameBinding.failures[0]?.diagnostics).toContain("binding");

    const sameExport = resolve(
      moduleCreate("export", "src/a.ts", 'export { b as a } from "./b";'),
      { "src/a.ts": source },
    );
    expect(sameExport.regions).toEqual([]);
    expect(sameExport.failures[0]?.stage).toBe("duplicate");
    expect(sameExport.failures[0]?.diagnostics).toContain('"a"');

    const secondDefault = resolve(
      moduleCreate("export", "src/a.ts", "export default function other(): void {}"),
      { "src/a.ts": source },
    );
    expect(secondDefault.regions).toEqual([]);
    expect(secondDefault.failures[0]?.diagnostics).toContain("default export");
  });

  test("rejects duplicate module creates in one reply", () => {
    const text = [
      moduleCreate("import", "src/a.ts", 'import { a } from "./a";'),
      moduleCreate("import", "src/a.ts", 'import { a } from "./a";'),
    ].join("\n\n");
    const result = resolve(text, { "src/a.ts": "" });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.diagnostics).toContain("same import statement");
  });

  test("rejects an unsafe path", () => {
    const result = resolve(
      moduleCreate("import", "../outside.ts", 'import "a";'),
      {},
      new Set(["../outside.ts"]),
    );
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain("outside the editable workspace");
  });

  test("conflicts with a file-level select, write, delete, or empty-file create on the same path", () => {
    const source = 'import { a } from "./a";\n';
    const fileSelect = [
      "select file src/a.ts",
      'match `import { a } from "./a";`',
      "replace with",
      "<<<TC_EDIT_BEGIN>>>",
      'import { a } from "./a-v2";',
      "<<<TC_EDIT_END>>>",
      "end",
    ].join("\n");
    const withSelect = resolve(
      [moduleCreate("import", "src/a.ts", 'import { b } from "./b";'), fileSelect].join("\n\n"),
      { "src/a.ts": source },
    );
    expect(withSelect.failures[0]?.diagnostics).toContain("file-level select");

    const write = ["write src/a.ts with", "<<<TC_EDIT_BEGIN>>>", source, "<<<TC_EDIT_END>>>"].join(
      "\n",
    );
    const withWrite = resolve(
      [moduleCreate("import", "src/a.ts", 'import { b } from "./b";'), write].join("\n\n"),
      { "src/a.ts": source },
    );
    expect(withWrite.failures[0]?.diagnostics).toContain("whole-file write");

    const withDelete = resolve(
      [moduleCreate("import", "src/a.ts", 'import { b } from "./b";'), "delete src/a.ts end"].join(
        "\n\n",
      ),
      { "src/a.ts": source },
    );
    expect(withDelete.failures[0]?.diagnostics).toContain("delete");

    const withEmptyCreate = resolve(
      [moduleCreate("import", "src/a.ts", 'import { b } from "./b";'), "create src/a.ts end"].join(
        "\n\n",
      ),
      { "src/a.ts": "" },
    );
    expect(withEmptyCreate.failures[0]?.diagnostics).toContain("empty-file create");
  });

  test("allows a module create and a declaration edit in the same file", () => {
    const source = "export const existing = 1;\n";
    const result = resolve(
      [
        moduleCreate("import", "src/a.ts", 'import { b } from "./b";'),
        [
          "select existing in src/a.ts",
          "replace with",
          "<<<TC_EDIT_BEGIN>>>",
          "export const existing = 2;",
          "<<<TC_EDIT_END>>>",
          "end",
        ].join("\n"),
      ].join("\n\n"),
      { "src/a.ts": source },
    );
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(2);
    expect(result.regions.map((region) => region.path)).toEqual(["src/a.ts", "src/a.ts"]);
  });
});

describe("nested declaration addresses (#52)", () => {
  test("renames an enum member and its same-enum references", () => {
    const source = ["enum Color { Red, Green }", "const value = Color.Red;", ""].join("\n");
    const result = resolve("select Color.Red in src/a.ts\nrename Red to Crimson\nend", {
      "src/a.ts": source,
    });
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(2);
    expect(result.regions.map((region) => region.text)).toEqual(["Crimson", "Crimson"]);
    expect(source.slice(result.regions[0]?.start, result.regions[0]?.end)).toBe("Red");
    expect(source.slice(result.regions[1]?.start, result.regions[1]?.end)).toBe("Red");
  });

  test("renames an interface/type-literal member and its qualified type reference", () => {
    const source = ["interface Cell { value: number }", "type V = Cell.value;", ""].join("\n");
    const result = resolve("select Cell.value in src/a.ts\nrename value to item\nend", {
      "src/a.ts": source,
    });
    expect(result.failures).toEqual([]);
    expect(result.regions).toHaveLength(2);
    expect(result.regions.map((region) => region.text)).toEqual(["item", "item"]);
    expect(source.slice(result.regions[0]?.start, result.regions[0]?.end)).toBe("value");
    expect(source.slice(result.regions[1]?.start, result.regions[1]?.end)).toBe("value");
  });

  test("rejects an object-literal member rename with a clear limitation", () => {
    const source = "const config = { timeout: 1 };\n";
    const result = resolve("select config.timeout in src/a.ts\nrename timeout to delay\nend", {
      "src/a.ts": source,
    });
    expect(result.regions).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain("object-literal");
  });

  test("rejects an unsafe whole-symbol delete of a destructuring binding", () => {
    const result = resolve(
      [
        "select a in src/a.ts",
        "replace with",
        "<<<TC_EDIT_BEGIN>>>",
        "",
        "<<<TC_EDIT_END>>>",
        "end",
      ].join("\n"),
      { "src/a.ts": "const { a, b } = pair;\n" },
    );
    expect(result.regions).toEqual([]);
    expect(result.failures[0]?.stage).toBe("address");
    expect(result.failures[0]?.diagnostics).toContain("destructuring pattern");
  });
});
