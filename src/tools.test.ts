import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSignatureView, expand } from "./scroll";
import {
  checkTool,
  findDefinitionTool,
  parseDiagnostics,
  renameTool,
  testTool,
  tools,
} from "./tools";
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
    expect(expand(source, locator("f", "function"))).toBe("function f(): number {\n  return 1;\n}");
  });

  test("expand truncates past maxLines and reports the remainder", () => {
    const source = "function big(): number {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n";
    expect(expand(source, locator("big", "function"), { maxLines: 2 })).toBe(
      "function big(): number {\n  const a = 1;\n// ... 3 more lines (use expand with a higher maxLines)",
    );
  });

  test("expand rejects maxLines of zero or less", () => {
    const source = "function f(): number {\n  return 1;\n}\n";
    expect(() => expand(source, locator("f", "function"), { maxLines: 0 })).toThrow(/maxLines/);
  });
});

describe("parseDiagnostics", () => {
  test("parses located and unlocated tsc errors", () => {
    const output = [
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "error TS2688: Cannot find type definition file for 'bun'.",
    ].join("\n");
    expect(parseDiagnostics(output)).toEqual([
      {
        file: "src/a.ts",
        line: 3,
        column: 7,
        message: "Type 'string' is not assignable to type 'number'.",
        code: "TS2322",
      },
      {
        file: "",
        line: 0,
        column: 0,
        message: "Cannot find type definition file for 'bun'.",
      },
    ]);
  });

  test("appends indented continuation lines to the previous message", () => {
    const output = [
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable",
      "  to type 'number'.",
      "error TS2688: Cannot find type definition file",
      "  for 'bun'.",
      "src/b.ts(1,1): error TS2551: Property 'foo' does not exist.",
    ].join("\n");
    expect(parseDiagnostics(output)).toEqual([
      {
        file: "src/a.ts",
        line: 3,
        column: 7,
        message: "Type 'string' is not assignable to type 'number'.",
        code: "TS2322",
      },
      {
        file: "",
        line: 0,
        column: 0,
        message: "Cannot find type definition file for 'bun'.",
      },
      {
        file: "src/b.ts",
        line: 1,
        column: 1,
        message: "Property 'foo' does not exist.",
        code: "TS2551",
      },
    ]);
  });

  test("keeps paths containing parentheses intact", () => {
    const output = [
      "src/feat(1).ts(10,5): error TS2304: Cannot find name 'x'.",
      "src/weird(1,2).ts(5,6): error TS2304: Cannot find name 'y'.",
    ].join("\n");
    expect(parseDiagnostics(output)).toEqual([
      {
        file: "src/feat(1).ts",
        line: 10,
        column: 5,
        message: "Cannot find name 'x'.",
        code: "TS2304",
      },
      {
        file: "src/weird(1,2).ts",
        line: 5,
        column: 6,
        message: "Cannot find name 'y'.",
        code: "TS2304",
      },
    ]);
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
    await expect(renameTool("const x = 1;\n", locator("nope", "function"), "y")).rejects.toThrow(
      /cannot rename/,
    );
  });

  test("leaves same-file references untouched in v1", async () => {
    const source = "function foo(): number {\n  return 1;\n}\nfoo();\n";
    const result = await renameTool(source, locator("foo", "function"), "bar");
    expect(result).toContain("function bar");
    expect(result).toContain("foo();");
  });
});

describe("tools", () => {
  test("exposes find-definition, scroll, rename, check, and test definitions", () => {
    const byName = new Map(tools.map((tool) => [tool.function.name, tool]));
    expect([...byName.keys()].sort()).toEqual([
      "check",
      "find-definition",
      "rename",
      "scroll",
      "test",
    ]);
    for (const tool of tools) {
      expect(tool.type).toBe("function");
      expect(tool.function.description.length).toBeGreaterThan(0);
      expect(tool.function.parameters["type"]).toBe("object");
    }
    for (const name of ["find-definition", "scroll", "rename"]) {
      expect(byName.get(name)?.function.parameters["required"]).toEqual(
        expect.arrayContaining(["path", "name", "kind"]),
      );
    }
    expect(byName.get("rename")?.function.parameters["required"]).toContain("newName");
    expect(byName.get("check")?.function.description).toContain("tsc --noEmit");
    expect(byName.get("test")?.function.description).toContain("bun test");
  });
});

describe("checkTool and testTool", () => {
  const TSC = [
    "bun",
    new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname,
    "--noEmit",
  ];
  const TS_CONFIG =
    '{ "compilerOptions": { "strict": true, "noEmit": true }, "include": ["*.ts"] }\n';
  const dirs: string[] = [];

  function fixture(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "tstools-"));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  async function withDeadline<T>(run: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("command timed out after 30s")), 30000);
    });
    try {
      return await Promise.race([run, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("check reports a clean project as ok", async () => {
    const dir = fixture({ "tsconfig.json": TS_CONFIG, "a.ts": "const x: number = 1;\n" });
    const result = await withDeadline(checkTool(dir, TSC));
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });

  test("check reports a type error with a parsed diagnostic", async () => {
    const dir = fixture({ "tsconfig.json": TS_CONFIG, "a.ts": 'const x: number = "s";\n' });
    const result = await withDeadline(checkTool(dir, TSC));
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    const first = result.diagnostics[0];
    expect(first).toBeDefined();
    expect(first?.file).toContain("a.ts");
    expect(first?.line).toBe(1);
    expect(first?.column).toBeGreaterThanOrEqual(1);
    expect(first?.message).toContain("not assignable");
  });

  test("check collects diagnostics from multiple files", async () => {
    const dir = fixture({
      "tsconfig.json": TS_CONFIG,
      "a.ts": 'const a: number = "x";\n',
      "b.ts": "const b: string = 1;\n",
    });
    const result = await withDeadline(checkTool(dir, TSC));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(2);
    const files = result.diagnostics.map((diagnostic) => diagnostic.file);
    expect(files).toContain("a.ts");
    expect(files).toContain("b.ts");
  });

  test("check parses the exact location of a known error", async () => {
    const dir = fixture({
      "tsconfig.json": TS_CONFIG,
      "a.ts": 'const a: number = 1;\nconst b: string = "x";\nconst c: number = "z";\n',
    });
    const result = await withDeadline(checkTool(dir, TSC));
    expect(result.diagnostics).toEqual([
      {
        file: "a.ts",
        line: 3,
        column: 7,
        message: "Type 'string' is not assignable to type 'number'.",
        code: "TS2322",
      },
    ]);
  });

  test("test reports a passing suite", async () => {
    const dir = fixture({
      "a.test.ts":
        'import { expect, test } from "bun:test";\n\ntest("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n',
    });
    const result = await withDeadline(testTool(dir, ["bun", "test"]));
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("pass");
  });

  test("test reports a failing suite", async () => {
    const dir = fixture({
      "a.test.ts":
        'import { expect, test } from "bun:test";\n\ntest("fails", () => {\n  expect(1).toBe(2);\n});\n',
    });
    const result = await withDeadline(testTool(dir, ["bun", "test"]));
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("fail");
  });

  test("check kills a command that exceeds a short timeout", async () => {
    const dir = fixture({});
    const started = Date.now();
    const result = await withDeadline(checkTool(dir, ["bun", "-e", "await Bun.sleep(5000)"], 50));
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  test("test kills a command that exceeds a short timeout", async () => {
    const dir = fixture({});
    const started = Date.now();
    const result = await withDeadline(testTool(dir, ["bun", "-e", "await Bun.sleep(5000)"], 50));
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  test("test still runs a fast command with the default timeout", async () => {
    const dir = fixture({});
    const result = await withDeadline(testTool(dir, ["bun", "-e", "process.exit(0)"]));
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});
