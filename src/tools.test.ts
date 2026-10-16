import { describe, expect, test } from "bun:test";
import { buildSignatureView, expand } from "./scroll";
import { findDefinitionTool, renameTool, tools } from "./tools";
import type { Locator } from "./utility";

const FILE = "file.ts";

function locator(name: string, kind: string, path = FILE): Locator {
  return { path, name, kind };
}

describe("scroll", () => {
  test("renders a function signature without the body or defaults", () => {
    const source = "function add(a: number, b: number = 2): number {\n  return a + b;\n}\n";
    const view = buildSignatureView(source, locator("add", "function"));
    expect(view).toBe("function add(a: number, b: number): number");
    expect(view).not.toContain("{");
    expect(view).not.toContain("return");
  });

  test("renders type parameters and predicates in a function signature", () => {
    const source = "function id<T extends object>(value: T): T {\n  return value;\n}\n";
    expect(buildSignatureView(source, locator("id", "function"))).toBe(
      "function id<T extends object>(value: T): T",
    );
  });

  test("lists class member signatures, including accessors and constructors", () => {
    const source = [
      "class Point {",
      "  x: number;",
      "  constructor(x: number) {",
      "    this.x = x;",
      "  }",
      "  move(dx: number, dy: number = 0): void {",
      "    this.x += dx;",
      "  }",
      "  get value(): number {",
      "    return this.x;",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(buildSignatureView(source, locator("Point", "class"))).toBe(
      [
        "class Point",
        "  x: number",
        "  constructor(x: number)",
        "  move(dx: number, dy: number): void",
        "  get value(): number",
      ].join("\n"),
    );
  });

  test("lists interface member signatures", () => {
    const source = [
      "interface Shape {",
      "  readonly name: string;",
      "  area(): number;",
      "  [key: string]: number;",
      "}",
      "",
    ].join("\n");
    expect(buildSignatureView(source, locator("Shape", "interface"))).toBe(
      [
        "interface Shape",
        "  readonly name: string",
        "  area(): number",
        "  [key: string]: number",
      ].join("\n"),
    );
  });

  test("collapses a type alias to one truncated line", () => {
    const long = `{ ${Array.from({ length: 20 }, (_, i) => `field${i}: number`).join("; ")} }`;
    const source = `type Big = ${long};\n`;
    const view = buildSignatureView(source, locator("Big", "type"));
    expect(view.startsWith("type Big = ")).toBe(true);
    expect(view.endsWith("...")).toBe(true);
    expect(view.length).toBe("type Big = ".length + 80 + 3);
  });

  test("renders enum members", () => {
    const source = "enum Color { Red, Green, Blue }\n";
    expect(buildSignatureView(source, locator("Color", "enum"))).toBe(
      "enum Color { Red, Green, Blue }",
    );
  });

  test("truncates enums past twelve members", () => {
    const names = Array.from({ length: 14 }, (_, i) => `M${i}`);
    const source = `enum Big { ${names.join(", ")} }\n`;
    expect(buildSignatureView(source, locator("Big", "enum"))).toBe(
      `enum Big { ${names.slice(0, 12).join(", ")}, ... }`,
    );
  });

  test("renders a namespace member count", () => {
    const source = "namespace ns {\n  export const a = 1;\n  export const b = 2;\n}\n";
    expect(buildSignatureView(source, locator("ns", "namespace"))).toBe(
      "namespace ns { 2 members }",
    );
  });

  test("renders a variable declarator type without the initializer", () => {
    const source = "export const answer: number = 42;\n";
    expect(buildSignatureView(source, locator("answer", "variable"))).toBe("answer: number");
  });

  test("throws for an unresolved locator", () => {
    expect(() => buildSignatureView("const x = 1;\n", locator("nope", "function"))).toThrow(
      /no symbol function nope/,
    );
  });

  test("expand returns the full declaration slice", () => {
    const source = "function f(): number {\n  return 1;\n}\n";
    expect(expand(source, locator("f", "function"))).toBe(
      "function f(): number {\n  return 1;\n}",
    );
  });

  test("expand truncates past maxLines and reports the remainder", () => {
    const source = "function big(): number {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n";
    expect(expand(source, locator("big", "function"), { maxLines: 2 })).toBe(
      "function big(): number {\n  const a = 1;\n// ... 3 more lines (use expand with a higher maxLines)",
    );
  });

  test("expand rejects maxLines of zero or less", () => {
    const source = "function f(): number {\n  return 1;\n}\n";
    expect(() => expand(source, locator("f", "function"), { maxLines: 0 })).toThrow(
      /maxLines/,
    );
  });
});

describe("findDefinitionTool", () => {
  test("resolves a fixture function", () => {
    const files = [{ path: FILE, source: "function foo(): void {}\n" }];
    const entry = findDefinitionTool(files, locator("foo", "function"));
    expect(entry).not.toBeNull();
    expect(entry === null ? null : (entry.node as unknown as { kind: string }).kind).toBe(
      "FunctionDeclaration",
    );
  });

  test("returns null for an unknown symbol", () => {
    const files = [{ path: FILE, source: "const x = 1;\n" }];
    expect(findDefinitionTool(files, locator("nope", "function"))).toBeNull();
  });
});

describe("renameTool", () => {
  test("renames a top-level function and formats the result", async () => {
    const source = "function make(a: number): number {\n  return a;\n}\n";
    const result = await renameTool(source, locator("make", "function"), "build");
    expect(result).toContain("function build");
    expect(result).not.toContain("make");
  });

  test("renames a class method and leaves other members intact", async () => {
    const source = [
      "class C {",
      "  m(a: number): number {",
      "    return a;",
      "  }",
      "  keep(): void {}",
      "}",
      "",
    ].join("\n");
    const result = await renameTool(source, locator("C.m", "method"), "n");
    expect(result).toContain("n(a: number): number");
    expect(result).toContain("keep()");
    expect(result).not.toContain("m(a");
  });

  test("renames only the last namespace segment", async () => {
    const source = "namespace A.B {\n  export const x = 1;\n}\n";
    const result = await renameTool(source, locator("A.B", "namespace"), "C");
    expect(result).toContain("namespace A.C");
    expect(result).not.toContain("A.B");
  });

  test("throws for an unresolved locator", async () => {
    await expect(
      renameTool("const x = 1;\n", locator("nope", "function"), "y"),
    ).rejects.toThrow(/cannot rename/);
  });

  test("leaves same-file references untouched in v1", async () => {
    const source = "function foo(): number {\n  return 1;\n}\nfoo();\n";
    const result = await renameTool(source, locator("foo", "function"), "bar");
    expect(result).toContain("function bar");
    expect(result).toContain("foo();");
  });
});

describe("tools", () => {
  test("exposes find-definition, scroll, and rename definitions", () => {
    const byName = new Map(tools.map((tool) => [tool.function.name, tool]));
    expect([...byName.keys()].sort()).toEqual(["find-definition", "rename", "scroll"]);
    for (const tool of tools) {
      expect(tool.type).toBe("function");
      expect(tool.function.description.length).toBeGreaterThan(0);
      const parameters = tool.function.parameters;
      expect(parameters["type"]).toBe("object");
      expect(parameters["required"]).toEqual(
        expect.arrayContaining(["path", "name", "kind"]),
      );
    }
    expect(byName.get("rename")?.function.parameters["required"]).toContain("newName");
  });
});
