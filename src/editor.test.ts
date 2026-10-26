import { expect, test } from "bun:test";
import { applyEdits } from "./editor";
import type { Edit } from "./editor";

function edit(name: string, kind: string, llmOutput: string, path = "file.ts"): Edit {
  return { locator: { path, name, kind }, llmOutput };
}

test("replaces a top-level function with the llm output", async () => {
  const result = await applyEdits("function make( ):number{return 1}\n", [
    edit("make", "function", "function make(): number {\n  return 42;\n}"),
  ]);
  expect(result).toBe("function make(): number {\n  return 42;\n}\n");
});

test("applies multiple edits bottom-up so spans stay valid", async () => {
  const result = await applyEdits("function a(){return 1}\nfunction b(){return 2}\n", [
    edit(
      "a",
      "function",
      "function a() {\n  const value = 1;\n  const doubled = value * 2;\n  return doubled;\n}",
    ),
    edit("b", "function", "function b() {\n  return 20;\n}"),
  ]);
  expect(result).toBe(
    "function a() {\n  const value = 1;\n  const doubled = value * 2;\n  return doubled;\n}\nfunction b() {\n  return 20;\n}\n",
  );
});

test("replaces a class method and keeps the class header intact", async () => {
  const result = await applyEdits("class C {\n  m( ){return 1}\n}\n", [
    edit("C.m", "method", "m( ){return 42}"),
  ]);
  expect(result).toBe("class C {\n  m() {\n    return 42;\n  }\n}\n");
});

test("replaces a function inside a namespace", async () => {
  const result = await applyEdits("namespace lexer {\n  export function make(){return 1}\n}\n", [
    edit("lexer.make", "function", "function make(){return 42}"),
  ]);
  expect(result).toBe("namespace lexer {\n  export function make() {\n    return 42;\n  }\n}\n");
});

test("replaces a variable declarator", async () => {
  const result = await applyEdits("export const answer = 1\n", [
    edit("answer", "variable", "answer = 42"),
  ]);
  expect(result).toBe("export const answer = 42;\n");
});

test("rejects a locator that does not resolve to a symbol", async () => {
  await expect(
    applyEdits("const x = 1;", [edit("nope", "function", "function nope() {}")]),
  ).rejects.toThrow(/no symbol function nope/);
});

test("rejects a locator whose path does not match the file name", async () => {
  await expect(
    applyEdits("function make() {}\n", [
      edit("make", "function", "function make() {}", "other.ts"),
    ]),
  ).rejects.toThrow(/no symbol function make/);
});

test("returns the source unchanged when there are no edits", async () => {
  const source = "const x=1   ";
  const result = await applyEdits(source, []);
  expect(result).toBe(source);
});

test("rejects overlapping edits", async () => {
  await expect(
    applyEdits("class C { m() {} }", [
      edit("C.m", "method", "m() { return 1; }"),
      edit("C.m", "method", "m() { return 2; }"),
    ]),
  ).rejects.toThrow(/overlapping edits/);
});

test("rejects an overload set instead of replacing its first declaration", async () => {
  await expect(
    applyEdits(
      "function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: unknown) {}\n",
      [edit("f", "function", "function f(value: unknown): void {\n  return;\n}")],
    ),
  ).rejects.toThrow(/resolves to 3 declarations; the harness never picks one silently/);
});

test("rejects when the replacement text cannot be parsed", async () => {
  await expect(
    applyEdits("function old() {}\n", [edit("old", "function", "function broken( {")]),
  ).rejects.toThrow(/oxfmt failed/);
});
