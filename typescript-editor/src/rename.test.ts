import { describe, expect, test } from "bun:test";
import { resolveLocalRename } from "./rename";
import type { RenameEdit } from "./rename";
import type { Locator } from "./utility";
import { resolveWorkspaceRename } from "./workspace-rename";
import type { WorkspaceRenameDeps, WorkspaceRenameResult } from "./workspace-rename";

function apply(source: string, edits: readonly RenameEdit[]): string {
  let result = source;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function locator(name: string, kind: string): Locator {
  return { path: "a.ts", name, kind };
}

function rename(
  source: string,
  target: Locator,
  from: string,
  to: string,
  position?: number,
): string {
  const result = resolveLocalRename(source, "a.ts", target, { from, to }, { position });
  if (!result.ok) {
    throw new Error(result.diagnostics);
  }
  return apply(source, result.edits);
}

describe("resolveLocalRename", () => {
  test("renames a top-level variable declaration and its references", () => {
    const source = ["const count = 1;", "console.log(count);", "count++;", ""].join("\n");
    expect(rename(source, locator("count", "const"), "count", "total")).toBe(
      ["const total = 1;", "console.log(total);", "total++;", ""].join("\n"),
    );
  });

  test("renames a parameter and only references in that function", () => {
    const source = [
      "const value = 1;",
      "function double(value: number) {",
      "  return value * 2;",
      "}",
      "value;",
      "",
    ].join("\n");
    expect(rename(source, locator("value", "parameter"), "value", "amount")).toBe(
      [
        "const value = 1;",
        "function double(amount: number) {",
        "  return amount * 2;",
        "}",
        "value;",
        "",
      ].join("\n"),
    );
  });

  test("block scopes rename independently from an outer binding", () => {
    const source = ["const x = 1;", "{", "  let x = 2;", "  x;", "}", "x;", ""].join("\n");
    expect(rename(source, locator("x", "const"), "x", "outer")).toBe(
      ["const outer = 1;", "{", "  let x = 2;", "  x;", "}", "outer;", ""].join("\n"),
    );
    expect(rename(source, locator("x", "let"), "x", "inner")).toBe(
      ["const x = 1;", "{", "  let inner = 2;", "  inner;", "}", "x;", ""].join("\n"),
    );
  });

  test("position disambiguates same-kind shadowed bindings", () => {
    const source = ["let x = 1;", "{", "  let x = 2;", "  x;", "}", "x;", ""].join("\n");
    const outer = source.indexOf("x = 1");
    const inner = source.indexOf("x = 2");

    expect(rename(source, locator("x", "let"), "x", "outer", outer)).toBe(
      ["let outer = 1;", "{", "  let x = 2;", "  x;", "}", "outer;", ""].join("\n"),
    );
    expect(rename(source, locator("x", "let"), "x", "inner", inner)).toBe(
      ["let x = 1;", "{", "  let inner = 2;", "  inner;", "}", "x;", ""].join("\n"),
    );

    const ambiguous = resolveLocalRename(source, "a.ts", locator("x", "let"), {
      from: "x",
      to: "renamed",
    });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.diagnostics).toContain("ambiguous");
    }
  });

  test("reports a collision in the same scope and returns no edits", () => {
    const source = ["const total = 1;", "const count = 2;", "count;", ""].join("\n");
    const result = resolveLocalRename(source, "a.ts", locator("count", "const"), {
      from: "count",
      to: "total",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContain("collision");
      expect(result.diagnostics).toContain("total");
      expect(result.diagnostics).not.toContain("edits");
    }
  });

  test("rejects a rename captured by a block-local shadow", () => {
    const source = ["const x = 1;", "{", "  const y = 2;", "  x;", "}", ""].join("\n");
    const result = resolveLocalRename(source, "a.ts", locator("x", "const"), {
      from: "x",
      to: "y",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContain("collision");
      expect(result.diagnostics).toContain("block scope");
      expect(result.diagnostics).toContain("capture");
      expect(result.diagnostics).not.toContain("edits");
    }
  });

  test("rejects a rename captured by a parameter in a closure", () => {
    const source = ["const x = 1;", "function f(y: number) {", "  return x;", "}", ""].join("\n");
    const result = resolveLocalRename(source, "a.ts", locator("x", "const"), {
      from: "x",
      to: "y",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContain("collision");
      expect(result.diagnostics).toContain("function scope");
      expect(result.diagnostics).toContain("capture");
      expect(result.diagnostics).not.toContain("edits");
    }
  });

  test("references in nested closures resolve to the captured binding", () => {
    const source = [
      "function run() {",
      "  const message = 'hi';",
      "  const make = () => () => message;",
      "  return make;",
      "}",
      "",
    ].join("\n");
    expect(rename(source, locator("message", "const"), "message", "greeting")).toBe(
      [
        "function run() {",
        "  const greeting = 'hi';",
        "  const make = () => () => greeting;",
        "  return make;",
        "}",
        "",
      ].join("\n"),
    );
  });

  test("renames function declarations and recursive references", () => {
    const source = [
      "function helper(n: number) {",
      "  return helper(n - 1);",
      "}",
      "helper(3);",
      "",
    ].join("\n");
    expect(rename(source, locator("helper", "function"), "helper", "assist")).toBe(
      ["function assist(n: number) {", "  return assist(n - 1);", "}", "assist(3);", ""].join("\n"),
    );
  });

  test("renames class declarations in and out of the class body", () => {
    const source = [
      "class Widget {",
      "  paint() {",
      "    return new Widget();",
      "  }",
      "}",
      "const widget = new Widget();",
      "",
    ].join("\n");
    expect(rename(source, locator("Widget", "class"), "Widget", "Gadget")).toBe(
      [
        "class Gadget {",
        "  paint() {",
        "    return new Gadget();",
        "  }",
        "}",
        "const widget = new Gadget();",
        "",
      ].join("\n"),
    );
  });

  test("renames interface/type-alias references without touching value bindings", () => {
    const source = [
      "interface Shape { area: number; }",
      "const Shape = 1;",
      "function area(shape: Shape): Shape {",
      "  return shape;",
      "}",
      "type Alias = Shape;",
      "const value: Shape = Shape;",
      "",
    ].join("\n");
    expect(rename(source, locator("Shape", "interface"), "Shape", "Figure")).toBe(
      [
        "interface Figure { area: number; }",
        "const Shape = 1;",
        "function area(shape: Figure): Figure {",
        "  return shape;",
        "}",
        "type Alias = Figure;",
        "const value: Figure = Shape;",
        "",
      ].join("\n"),
    );

    expect(rename(source, locator("Alias", "type"), "Alias", "ShapeAlias")).toBe(
      [
        "interface Shape { area: number; }",
        "const Shape = 1;",
        "function area(shape: Shape): Shape {",
        "  return shape;",
        "}",
        "type ShapeAlias = Shape;",
        "const value: Shape = Shape;",
        "",
      ].join("\n"),
    );
  });

  test("renames destructured binding identifiers", () => {
    const source = [
      "const { first, second: renamed } = source;",
      "first;",
      "renamed;",
      "source;",
      "",
    ].join("\n");
    expect(rename(source, locator("first", "const"), "first", "alpha")).toBe(
      ["const { alpha, second: renamed } = source;", "alpha;", "renamed;", "source;", ""].join(
        "\n",
      ),
    );
    expect(rename(source, locator("renamed", "const"), "renamed", "beta")).toBe(
      ["const { first, second: beta } = source;", "first;", "beta;", "source;", ""].join("\n"),
    );
  });

  test("renames the last segment of a dotted namespace and exact references only", () => {
    const source = [
      "namespace A.B {",
      "  export const value = 1;",
      "}",
      "const alias = A.B;",
      "const nested = A.B.Z;",
      "const other = X.A.B;",
      "",
    ].join("\n");
    expect(rename(source, locator("A.B", "namespace"), "B", "C")).toBe(
      [
        "namespace A.C {",
        "  export const value = 1;",
        "}",
        "const alias = A.C;",
        "const nested = A.B.Z;",
        "const other = X.A.B;",
        "",
      ].join("\n"),
    );
  });

  test("renames a nested namespace declaration and its qualified reference", () => {
    const source = [
      "namespace A {",
      "  export namespace B {",
      "    export const value = 1;",
      "  }",
      "}",
      "const alias = A.B;",
      "",
    ].join("\n");
    expect(rename(source, locator("A.B", "namespace"), "B", "C")).toBe(
      [
        "namespace A {",
        "  export namespace C {",
        "    export const value = 1;",
        "  }",
        "}",
        "const alias = A.C;",
        "",
      ].join("\n"),
    );
  });

  test("rejects a namespace rename colliding at the same qualified path", () => {
    const source = ["namespace A.B {}", "namespace A.C {}", ""].join("\n");
    const result = resolveLocalRename(source, "a.ts", locator("A.B", "namespace"), {
      from: "B",
      to: "C",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContain("collision");
      expect(result.diagnostics).toContain("A.C");
    }
  });

  test("renames enum members without touching same-named members elsewhere", () => {
    const source = [
      "enum Color { Red, Green }",
      "enum Other { Red }",
      "const one = Color.Red;",
      "const two = Color.Green;",
      "const three = Other.Red;",
      "const four = Color.Red.valueOf();",
      "",
    ].join("\n");
    expect(rename(source, locator("Color.Red", ""), "Red", "Crimson")).toBe(
      [
        "enum Color { Crimson, Green }",
        "enum Other { Red }",
        "const one = Color.Crimson;",
        "const two = Color.Green;",
        "const three = Other.Red;",
        "const four = Color.Crimson.valueOf();",
        "",
      ].join("\n"),
    );
  });

  test("rejects an enum member rename colliding at the same enum path", () => {
    const source = ["enum Color { Red, Green }", ""].join("\n");
    const result = resolveLocalRename(source, "a.ts", locator("Color.Red", ""), {
      from: "Red",
      to: "Green",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContain("collision");
      expect(result.diagnostics).toContain("Color.Green");
    }
  });

  test("renames interface/type-literal members and their qualified type references", () => {
    const source = [
      "interface Cell {",
      "  value: number;",
      "  getValue(): number;",
      "}",
      "type Snapshot = {",
      "  value: string;",
      "  nested: { flag: boolean };",
      "};",
      "type A = Cell.value;",
      "type B = Snapshot.value;",
      "type C = Snapshot.nested.flag;",
      "",
    ].join("\n");
    expect(rename(source, locator("Cell.value", ""), "value", "item")).toBe(
      [
        "interface Cell {",
        "  item: number;",
        "  getValue(): number;",
        "}",
        "type Snapshot = {",
        "  value: string;",
        "  nested: { flag: boolean };",
        "};",
        "type A = Cell.item;",
        "type B = Snapshot.value;",
        "type C = Snapshot.nested.flag;",
        "",
      ].join("\n"),
    );
    expect(rename(source, locator("Snapshot.nested.flag", ""), "flag", "enabled")).toBe(
      [
        "interface Cell {",
        "  value: number;",
        "  getValue(): number;",
        "}",
        "type Snapshot = {",
        "  value: string;",
        "  nested: { enabled: boolean };",
        "};",
        "type A = Cell.value;",
        "type B = Snapshot.value;",
        "type C = Snapshot.nested.enabled;",
        "",
      ].join("\n"),
    );
  });

  test("rejects an object-literal member rename with a limitation", () => {
    const source = "const config = { timeout: 1 };\n";
    const result = resolveLocalRename(source, "a.ts", locator("config.timeout", ""), {
      from: "timeout",
      to: "delay",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContain("object-literal");
    }
  });

  test("renames class fields and this.field references only", () => {
    const source = [
      "class Widget {",
      "  field = 1;",
      "  other = 2;",
      "  read() {",
      "    return this.field + this.other;",
      "  }",
      "}",
      "class Other {",
      "  field = 3;",
      "}",
      "const w = new Widget();",
      "const staticField = Widget.field;",
      "const arbitrary = w.field;",
      "",
    ].join("\n");
    expect(rename(source, locator("Widget.field", "variable"), "field", "value")).toBe(
      [
        "class Widget {",
        "  value = 1;",
        "  other = 2;",
        "  read() {",
        "    return this.value + this.other;",
        "  }",
        "}",
        "class Other {",
        "  field = 3;",
        "}",
        "const w = new Widget();",
        "const staticField = Widget.value;",
        "const arbitrary = w.field;",
        "",
      ].join("\n"),
    );
  });

  test("rejects a field rename colliding at the same class path", () => {
    const source = ["class Widget {", "  field = 1;", "  other = 2;", "}", ""].join("\n");
    const result = resolveLocalRename(source, "a.ts", locator("Widget.field", "variable"), {
      from: "field",
      to: "other",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContain("collision");
      expect(result.diagnostics).toContain("Widget.other");
    }
  });

  test("rejects an ambiguous dotted target", () => {
    const source = ["namespace A.B {}", "class A {", "  static B = 1;", "}", ""].join("\n");
    const result = resolveLocalRename(source, "a.ts", locator("A.B", ""), {
      from: "B",
      to: "C",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContain("ambiguous");
    }
  });

  test("an unresolvable dotted target produces a diagnostic and no edits", () => {
    const result = resolveLocalRename(
      "namespace A.B {}",
      "a.ts",
      locator("A.Missing", "namespace"),
      {
        from: "Missing",
        to: "Other",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContain("cannot resolve");
      expect(result.diagnostics).toContain("A.Missing");
    }
  });

  test("an unresolvable target produces a diagnostic and no edits", () => {
    const result = resolveLocalRename("const x = 1;", "a.ts", locator("missing", "const"), {
      from: "missing",
      to: "other",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContain("cannot resolve");
      expect(result.diagnostics).toContain("missing");
    }
  });
});

function workspaceDeps(files: Record<string, string>): WorkspaceRenameDeps {
  return {
    sourceFor: (path) => files[path] ?? "",
    fileExists: (path) => Object.prototype.hasOwnProperty.call(files, path),
    isSafePath: (path) => Object.prototype.hasOwnProperty.call(files, path),
    listFiles: () => Object.keys(files),
  };
}

function workspaceRename(
  files: Record<string, string>,
  path: string,
  name: string,
  kind: string,
  from: string,
  to: string,
  position?: number,
): WorkspaceRenameResult {
  return resolveWorkspaceRename(
    files[path] ?? "",
    path,
    { path, name, kind },
    { from, to },
    workspaceDeps(files),
    { position },
  );
}

function applyWorkspaceRename(
  files: Record<string, string>,
  result: WorkspaceRenameResult,
): Record<string, string> {
  if (!result.ok) {
    throw new Error(result.diagnostics);
  }
  const output = { ...files };
  for (const file of result.files) {
    output[file.path] = apply(output[file.path] ?? "", file.edits);
  }
  return output;
}

describe("resolveWorkspaceRename", () => {
  const TARGET = ["export function helper(): number {", "  return 1;", "}", ""].join("\n");

  test("updates an unaliased named import and every local use", () => {
    const files = {
      "src/a.ts": ['import { helper } from "./b";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.files.map((file) => file.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "./b";', "export const n = helper2();", ""].join("\n"),
    );
    expect(output["src/b.ts"]).toContain("export function helper2");
  });

  test("updates only the imported name of an aliased import", () => {
    const files = {
      "src/a.ts": ['import { helper as h } from "./b";', "export const n = h();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 as h } from "./b";', "export const n = h();", ""].join("\n"),
    );
  });

  test("updates named re-export specifiers and preserves aliases", () => {
    const files = {
      "src/c.ts": [
        'export { helper } from "./b";',
        'export { helper as publicHelper } from "./b";',
        "",
      ].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/c.ts"]).toBe(
      ['export { helper2 } from "./b";', 'export { helper2 as publicHelper } from "./b";', ""].join(
        "\n",
      ),
    );
  });

  test("keeps an aliased public export name and its importers unchanged", () => {
    const files = {
      "src/a.ts": [
        'import { publicHelper } from "./b";',
        "export const n = publicHelper();",
        "",
      ].join("\n"),
      "src/b.ts": [
        "function helper(): number {",
        "  return 1;",
        "}",
        "export { helper as publicHelper };",
        "",
      ].join("\n"),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.files.map((file) => file.path)).toEqual(["src/b.ts"]);
    const output = applyWorkspaceRename(files, result);
    expect(output["src/b.ts"]).toContain("export { helper2 as publicHelper };");
    expect(output["src/a.ts"]).toBe(files["src/a.ts"]);
  });

  test("rejects a target file that already exports the new name", () => {
    const files = {
      "src/other.ts": ["export function other(): number {", "  return 2;", "}", ""].join("\n"),
      "src/b.ts": [
        "export function helper(): number {",
        "  return 1;",
        "}",
        'export { other as helper2 } from "./other";',
        "",
      ].join("\n"),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.path).toBe("src/b.ts");
    expect(result.diagnostics).toContain("collision");
    expect(result.diagnostics).toContain("helper2");
  });

  test("rejects a re-export collision in an importer", () => {
    const files = {
      "src/c.ts": ['export { helper } from "./b";', 'export { helper2 } from "./other";', ""].join(
        "\n",
      ),
      "src/other.ts": ["export function helper2(): number {", "  return 2;", "}", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.path).toBe("src/c.ts");
    expect(result.diagnostics).toContain("collision");
  });

  test("ignores imports whose specifier resolves to another file", () => {
    const files = {
      "src/a.ts": ['import { helper } from "./c";', "export const n = helper();", ""].join("\n"),
      "src/c.ts": TARGET,
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.files.map((file) => file.path)).toEqual(["src/b.ts"]);
  });

  test("does not cross-file a nested same-named binding", () => {
    const source = [
      "function run(): number {",
      "  const helper = 1;",
      "  return helper;",
      "}",
      "export function helper(): number {",
      "  return 2;",
      "}",
      "",
    ].join("\n");
    const files = {
      "src/a.ts": ['import { helper } from "./b";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": source,
    };
    const nested = source.indexOf("const helper = 1") + "const ".length;
    const result = workspaceRename(
      files,
      "src/b.ts",
      "helper",
      "const",
      "helper",
      "amount",
      nested,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.files.map((file) => file.path)).toEqual(["src/b.ts"]);
    const output = applyWorkspaceRename(files, result);
    expect(output["src/b.ts"]).toContain("const amount = 1;");
    expect(output["src/b.ts"]).toContain("export function helper()");
    expect(output["src/a.ts"]).toBe(files["src/a.ts"]);
  });

  test("resolves extensionless and index module specifiers", () => {
    const files = {
      "src/a.ts": ['import { helper } from "./lib";', "export const n = helper();", ""].join("\n"),
      "src/lib/index.ts": TARGET,
    };
    const result = workspaceRename(
      files,
      "src/lib/index.ts",
      "helper",
      "function",
      "helper",
      "helper2",
    );
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toContain('import { helper2 } from "./lib";');
  });

  test("updates only the imported name of a same-name alias", () => {
    const files = {
      "src/a.ts": [
        'import { helper as helper } from "./b";',
        "export const n = helper();",
        "",
      ].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 as helper } from "./b";', "export const n = helper();", ""].join("\n"),
    );
  });

  test("resolves NodeNext .js specifiers to TypeScript sources", () => {
    const files = {
      "src/a.ts": ['import { helper } from "./b.js";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "./b.js";', "export const n = helper2();", ""].join("\n"),
    );
  });

  test("updates string-literal import and re-export names", () => {
    const files = {
      "src/a.ts": [
        'import { "helper" as h } from "./b";',
        "export const n = h();",
        'export { "helper" as publicHelper } from "./b";',
        "",
      ].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      [
        'import { helper2 as h } from "./b";',
        "export const n = h();",
        'export { helper2 as publicHelper } from "./b";',
        "",
      ].join("\n"),
    );
  });

  test("updates namespace-import member calls atomically", () => {
    const files = {
      "src/a.ts": ['import * as ns from "./b";', "export const n = ns.helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.files.map((file) => file.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import * as ns from "./b";', "export const n = ns.helper2();", ""].join("\n"),
    );
    expect(output["src/b.ts"]).toContain("export function helper2");
  });

  test("updates optional-chaining namespace member calls", () => {
    const files = {
      "src/a.ts": ['import * as ns from "./b";', "export const n = ns?.helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import * as ns from "./b";', "export const n = ns?.helper2();", ""].join("\n"),
    );
  });

  test("updates only the renamed member of a nested member expression", () => {
    const files = {
      "src/a.ts": [
        'import * as ns from "./b";',
        "export const a = ns.helper.call(null);",
        "export const b = ns /* keep */ . helper.deep;",
        "export const c = ns.other.helper;",
        "",
      ].join("\n"),
      "src/b.ts": [
        "export const helper = { call: () => 1, deep: 2 };",
        "export const other = {};",
        "",
      ].join("\n"),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "const", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      [
        'import * as ns from "./b";',
        "export const a = ns.helper2.call(null);",
        "export const b = ns /* keep */ . helper2.deep;",
        "export const c = ns.other.helper;",
        "",
      ].join("\n"),
    );
  });

  test("updates an aliased namespace local without renaming the local", () => {
    const files = {
      "src/a.ts": ['import * as lib from "./b";', "export const n = lib.helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import * as lib from "./b";', "export const n = lib.helper2();", ""].join("\n"),
    );
  });

  test("combines namespace and named import updates in one file", () => {
    const files = {
      "src/a.ts": [
        'import * as ns from "./b";',
        'import { helper } from "./b";',
        "export const nested = ns.helper();",
        "export const direct = helper();",
        "",
      ].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      [
        'import * as ns from "./b";',
        'import { helper2 } from "./b";',
        "export const nested = ns.helper2();",
        "export const direct = helper2();",
        "",
      ].join("\n"),
    );
  });

  test("updates a direct import-equals member call", () => {
    const files = {
      "src/a.ts": ['import lib = require("./b");', "export const n = lib.helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import lib = require("./b");', "export const n = lib.helper2();", ""].join("\n"),
    );
  });

  test("updates namespace type references and typeof member references", () => {
    const target = [
      "export function helper(): number {",
      "  return 1;",
      "}",
      "export interface Helper {",
      "  value: number;",
      "}",
      "",
    ].join("\n");
    const files = {
      "src/a.ts": [
        'import * as ns from "./b";',
        "export type T = ns.Helper;",
        "export const n = typeof ns.helper;",
        "",
      ].join("\n"),
      "src/b.ts": target,
    };

    const typeResult = workspaceRename(
      files,
      "src/b.ts",
      "Helper",
      "interface",
      "Helper",
      "Helper2",
    );
    const typeOutput = applyWorkspaceRename(files, typeResult);
    expect(typeOutput["src/a.ts"]).toContain("export type T = ns.Helper2;");
    expect(typeOutput["src/a.ts"]).toContain("export const n = typeof ns.helper;");

    const valueResult = workspaceRename(
      files,
      "src/b.ts",
      "helper",
      "function",
      "helper",
      "helper2",
    );
    const valueOutput = applyWorkspaceRename(files, valueResult);
    expect(valueOutput["src/a.ts"]).toContain("export type T = ns.Helper;");
    expect(valueOutput["src/a.ts"]).toContain("export const n = typeof ns.helper2;");
  });

  test("ignores a shadowing local or parameter of the namespace name", () => {
    const files = {
      "src/a.ts": [
        'import * as ns from "./b";',
        "function inner(ns: { helper(): number }): number {",
        "  return ns.helper();",
        "}",
        "export const n = ns.helper();",
        "",
      ].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      [
        'import * as ns from "./b";',
        "function inner(ns: { helper(): number }): number {",
        "  return ns.helper();",
        "}",
        "export const n = ns.helper2();",
        "",
      ].join("\n"),
    );
  });

  test("renames static string-keyed namespace accesses and preserves the quote", () => {
    for (const [expression, expected] of [
      ['ns["helper"]', 'ns["helper2"]'],
      ["ns['helper']", "ns['helper2']"],
      ['ns?.["helper"]', 'ns?.["helper2"]'],
      ["ns?.['helper']", "ns?.['helper2']"],
    ] as const) {
      const files = {
        "src/a.ts": ['import * as ns from "./b";', `export const n = ${expression};`, ""].join(
          "\n",
        ),
        "src/b.ts": TARGET,
      };
      const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
      expect(result.ok).toBe(true);
      if (!result.ok) {
        continue;
      }
      const output = applyWorkspaceRename(files, result);
      expect(output["src/a.ts"]).toBe(
        ['import * as ns from "./b";', `export const n = ${expected};`, ""].join("\n"),
      );
    }
  });

  test("renames a static string-keyed import-equals access", () => {
    const files = {
      "src/a.ts": ['import lib = require("./b");', "export const n = lib['helper'];", ""].join(
        "\n",
      ),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import lib = require("./b");', "export const n = lib['helper2'];", ""].join("\n"),
    );
  });

  test("leaves a static key naming another property untouched", () => {
    const files = {
      "src/a.ts": [
        'import * as ns from "./b";',
        'export const other = ns["other"];',
        'export const n = ns["helper"];',
        "",
      ].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      [
        'import * as ns from "./b";',
        'export const other = ns["other"];',
        'export const n = ns["helper2"];',
        "",
      ].join("\n"),
    );
  });

  test("fails on a dynamic namespace access instead of leaving it stale", () => {
    for (const expression of [
      "ns[key]",
      'ns["helper" + suffix]',
      "ns[`helper`]",
      'ns["hel\\u0062er"]',
    ]) {
      const files = {
        "src/a.ts": [
          'import * as ns from "./b";',
          'const key = "helper";',
          "const suffix = '';",
          `export const n = ${expression};`,
          "",
        ].join("\n"),
        "src/b.ts": TARGET,
      };
      const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.path).toBe("src/a.ts");
      expect(result.diagnostics).toContain("computed");
      expect(result.diagnostics).toContain("src/a.ts");
      expect(result.diagnostics).toContain("ns[");
      expect(result.diagnostics).toContain("source:");
    }
  });

  test("fails on an unsupported import-equals alias of a namespace", () => {
    const files = {
      "src/a.ts": [
        'import * as ns from "./b";',
        "import lib = ns;",
        "export const n = lib.helper();",
        "",
      ].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.path).toBe("src/a.ts");
    expect(result.diagnostics).toContain("import =");
    expect(result.diagnostics).toContain("lib.helper");
    expect(result.diagnostics).toContain("src/a.ts");
  });

  test("leaves a direct import-equals from another module untouched", () => {
    const files = {
      "src/a.ts": ['import lib = require("./c");', "export const n = lib.helper();", ""].join("\n"),
      "src/b.ts": TARGET,
      "src/c.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.files.map((file) => file.path)).toEqual(["src/b.ts"]);
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(files["src/a.ts"]);
  });

  test("fails on destructuring that reads the renamed namespace member", () => {
    const files = {
      "src/a.ts": [
        'import * as ns from "./b";',
        "const { helper } = ns;",
        "const { other } = ns;",
        "",
      ].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.path).toBe("src/a.ts");
    expect(result.diagnostics).toContain("destructuring");
    expect(result.diagnostics).toContain("src/a.ts");
  });

  test("resolves tsconfig baseUrl paths for named imports", () => {
    const files = {
      "tsconfig.json": [
        "{",
        "  // workspace aliases",
        '  "compilerOptions": {',
        '    "baseUrl": ".",',
        '    "paths": {',
        '      "@/*": ["src/*"],',
        "    },",
        "  },",
        "}",
        "",
      ].join("\n"),
      "src/a.ts": ['import { helper } from "@/b";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.files.map((file) => file.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "@/b";', "export const n = helper2();", ""].join("\n"),
    );
  });

  test("falls back to baseUrl for bare specifiers", () => {
    const files = {
      "tsconfig.json": '{"compilerOptions":{"baseUrl":"src"}}\n',
      "src/a.ts": ['import { helper } from "b";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "b";', "export const n = helper2();", ""].join("\n"),
    );
  });

  test("does not treat bare specifiers as root-relative without baseUrl", () => {
    const files = {
      "tsconfig.json": '{"compilerOptions":{"strict":true}}\n',
      "src/a.ts": ['import { helper } from "src/b";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.files.map((file) => file.path)).toEqual(["src/b.ts"]);
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(files["src/a.ts"]);
  });

  test("resolves aliased namespace and import-equals member accesses", () => {
    const files = {
      "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n',
      "src/a.ts": ['import * as ns from "@/b";', "export const n = ns.helper();", ""].join("\n"),
      "src/c.ts": ['import lib = require("@/b");', "export const m = lib.helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import * as ns from "@/b";', "export const n = ns.helper2();", ""].join("\n"),
    );
    expect(output["src/c.ts"]).toBe(
      ['import lib = require("@/b");', "export const m = lib.helper2();", ""].join("\n"),
    );
  });

  test("resolves tsconfig aliases inside barrels", () => {
    const files = {
      "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n',
      "src/b.ts": TARGET,
      "src/index.ts": 'export * from "@/b";\n',
      "src/a.ts": ['import { helper } from "./index";', "export const n = helper();", ""].join(
        "\n",
      ),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "./index";', "export const n = helper2();", ""].join("\n"),
    );
  });

  test("follows chained export * barrels", () => {
    const files = {
      "src/b.ts": TARGET,
      "src/barrel2.ts": 'export * from "./b";\n',
      "src/barrel1.ts": 'export * from "./barrel2";\n',
      "src/a.ts": ['import { helper } from "./barrel1";', "export const n = helper();", ""].join(
        "\n",
      ),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.files.map((file) => file.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "./barrel1";', "export const n = helper2();", ""].join("\n"),
    );
    expect(output["src/barrel1.ts"]).toBe(files["src/barrel1.ts"]);
    expect(output["src/barrel2.ts"]).toBe(files["src/barrel2.ts"]);
  });

  test("updates namespace members imported through a barrel", () => {
    const files = {
      "src/b.ts": TARGET,
      "src/index.ts": 'export * from "./b";\n',
      "src/a.ts": ['import * as ns from "./index";', "export const n = ns.helper();", ""].join(
        "\n",
      ),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import * as ns from "./index";', "export const n = ns.helper2();", ""].join("\n"),
    );
  });

  test("follows explicit re-export chains", () => {
    const files = {
      "src/b.ts": TARGET,
      "src/index.ts": 'export { helper } from "./b";\n',
      "src/barrel.ts": 'export { helper } from "./index";\n',
      "src/a.ts": ['import { helper } from "./barrel";', "export const n = helper();", ""].join(
        "\n",
      ),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "./barrel";', "export const n = helper2();", ""].join("\n"),
    );
    expect(output["src/index.ts"]).toBe('export { helper2 } from "./b";\n');
    expect(output["src/barrel.ts"]).toBe('export { helper2 } from "./index";\n');
  });

  test("follows a local import and export through a barrel", () => {
    const files = {
      "src/b.ts": TARGET,
      "src/index.ts": ['import { helper } from "./b";', "export { helper };", ""].join("\n"),
      "src/a.ts": ['import { helper } from "./index";', "export const n = helper();", ""].join(
        "\n",
      ),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "./index";', "export const n = helper2();", ""].join("\n"),
    );
    expect(output["src/index.ts"]).toBe(
      ['import { helper2 } from "./b";', "export { helper2 };", ""].join("\n"),
    );
  });

  test("keeps a same-name explicit export alias public", () => {
    const files = {
      "src/b.ts": TARGET,
      "src/index.ts": ['import { helper } from "./b";', "export { helper as helper };", ""].join(
        "\n",
      ),
      "src/a.ts": ['import { helper } from "./index";', "export const n = helper();", ""].join(
        "\n",
      ),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    const output = applyWorkspaceRename(files, result);
    expect(output["src/index.ts"]).toBe(
      ['import { helper2 } from "./b";', "export { helper2 as helper };", ""].join("\n"),
    );
    expect(output["src/a.ts"]).toBe(files["src/a.ts"]);
  });

  test("keeps a same-name import alias and local re-export public", () => {
    const files = {
      "src/b.ts": TARGET,
      "src/index.ts": ['import { helper as helper } from "./b";', "export { helper };", ""].join(
        "\n",
      ),
      "src/a.ts": ['import { helper } from "./index";', "export const n = helper();", ""].join(
        "\n",
      ),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const output = applyWorkspaceRename(files, result);
    expect(output["src/index.ts"]).toBe(
      ['import { helper2 as helper } from "./b";', "export { helper };", ""].join("\n"),
    );
    expect(output["src/a.ts"]).toBe(files["src/a.ts"]);
  });

  test("handles cyclic export * chains without duplicate edits", () => {
    const files = {
      "src/b.ts": TARGET,
      "src/one.ts": 'export * from "./two";\n',
      "src/two.ts": ['export * from "./one";', 'export * from "./b";', ""].join("\n"),
      "src/a.ts": ['import { helper } from "./one";', "export const n = helper();", ""].join("\n"),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const paths = result.files.map((file) => file.path).sort();
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(new Set(paths).size).toBe(paths.length);
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "./one";', "export const n = helper2();", ""].join("\n"),
    );
  });

  test("handles a diamond export * graph without duplicate edits", () => {
    const files = {
      "src/b.ts": TARGET,
      "src/one.ts": ['export * from "./left";', 'export * from "./right";', ""].join("\n"),
      "src/left.ts": 'export * from "./b";\n',
      "src/right.ts": 'export * from "./b";\n',
      "src/a.ts": ['import { helper } from "./one";', "export const n = helper();", ""].join("\n"),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const paths = result.files.map((file) => file.path).sort();
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("fails on an ambiguous tsconfig path alias", () => {
    const files = {
      "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*","lib/*"]}}}\n',
      "src/a.ts": ['import { helper } from "@/b";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
      "lib/b.ts": ["export function helper(): number {", "  return 2;", "}", ""].join("\n"),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.path).toBe("src/a.ts");
    expect(result.diagnostics).toContain("@/b");
    expect(result.diagnostics).toContain("ambiguous");
    expect(result.diagnostics).toContain("lib/b.ts");
    expect(result.diagnostics).toContain("src/b.ts");
  });

  test("fails on an aliased specifier that resolves to no file", () => {
    const files = {
      "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n',
      "src/a.ts": ['import { helper } from "@/missing";', "export const n = helper();", ""].join(
        "\n",
      ),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.path).toBe("src/a.ts");
    expect(result.diagnostics).toContain("@/missing");
    expect(result.diagnostics).toContain("paths");
  });

  test("fails on an unresolved relative barrel edge", () => {
    const files = {
      "src/b.ts": TARGET,
      "src/index.ts": 'export * from "./missing";\n',
      "src/a.ts": ['import { helper } from "./index";', "export const n = helper();", ""].join(
        "\n",
      ),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.path).toBe("src/a.ts");
    expect(result.diagnostics).toContain("./missing");
    expect(result.diagnostics).toContain("src/index.ts");
    expect(result.diagnostics).toContain("does not resolve");
  });

  test("fails when export * sources disagree about the renamed name", () => {
    const files = {
      "src/b.ts": TARGET,
      "src/c.ts": ["export function helper(): number {", "  return 2;", "}", ""].join("\n"),
      "src/index.ts": ['export * from "./b";', 'export * from "./c";', ""].join("\n"),
      "src/a.ts": ['import { helper } from "./index";', "export const n = helper();", ""].join(
        "\n",
      ),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.path).toBe("src/a.ts");
    expect(result.diagnostics).toContain("ambiguous");
    expect(result.diagnostics).toContain("src/index.ts");
    expect(result.diagnostics).toContain("./b");
    expect(result.diagnostics).toContain("./c");
  });

  test("lets an explicit re-export shadow a conflicting export *", () => {
    const files = {
      "src/b.ts": TARGET,
      "src/c.ts": ["export function helper(): number {", "  return 2;", "}", ""].join("\n"),
      "src/index.ts": ['export { helper } from "./c";', 'export * from "./b";', ""].join("\n"),
      "src/a.ts": ['import { helper } from "./index";', "export const n = helper();", ""].join(
        "\n",
      ),
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.files.map((file) => file.path)).toEqual(["src/b.ts"]);
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(files["src/a.ts"]);
  });

  test("inherits tsconfig baseUrl and paths from a local relative parent", () => {
    const files = {
      "tsconfig.json": '{"extends":"./config/tsconfig.base.json"}\n',
      "config/tsconfig.base.json":
        '{"compilerOptions":{"baseUrl":"..","paths":{"@/*":["src/*"]}}}\n',
      "src/a.ts": ['import { helper } from "@/b";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "@/b";', "export const n = helper2();", ""].join("\n"),
    );
  });

  test("follows multi-level local tsconfig extends chains", () => {
    const files = {
      "tsconfig.json": '{"extends":"./config/middle.json"}\n',
      "config/middle.json": '{"extends":"./base.json","compilerOptions":{"strict":true}}\n',
      "config/base.json": '{"compilerOptions":{"baseUrl":"..","paths":{"@/*":["src/*"]}}}\n',
      "src/a.ts": ['import { helper } from "@/b";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "@/b";', "export const n = helper2();", ""].join("\n"),
    );
  });

  test("merges tsconfig extends arrays in order with later parents overriding", () => {
    const files = {
      "tsconfig.json": '{"extends":["./config/first.json","./config/second.json"]}\n',
      "config/first.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["lib/*"]}}}\n',
      "config/second.json": '{"compilerOptions":{"baseUrl":"..","paths":{"@/*":["src/*"]}}}\n',
      "src/a.ts": ['import { helper } from "@/b";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "@/b";', "export const n = helper2();", ""].join("\n"),
    );
  });

  test("resolves inherited tsconfig paths against a child baseUrl override", () => {
    const files = {
      "tsconfig.json": '{"extends":"./config/base.json","compilerOptions":{"baseUrl":"src"}}\n',
      "config/base.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["*"]}}}\n',
      "src/a.ts": ['import { helper } from "@/b";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "@/b";', "export const n = helper2();", ""].join("\n"),
    );
  });

  test("lets a child tsconfig paths object replace inherited paths", () => {
    const files = {
      "tsconfig.json":
        '{"extends":"./config/base.json","compilerOptions":{"paths":{"@/*":["src/*"]}}}\n',
      "config/base.json": '{"compilerOptions":{"baseUrl":"..","paths":{"@/*":["lib/*"]}}}\n',
      "src/a.ts": ['import { helper } from "@/b";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "@/b";', "export const n = helper2();", ""].join("\n"),
    );
  });

  test("handles cyclic local tsconfig extends without hanging", () => {
    const files = {
      "tsconfig.json": '{"extends":"./config/a.json"}\n',
      "config/a.json":
        '{"extends":"./b.json","compilerOptions":{"baseUrl":".","paths":{"@/*":["../src/*"]}}}\n',
      "config/b.json": '{"extends":"./a.json"}\n',
      "src/a.ts": ['import { helper } from "@/b";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "@/b";', "export const n = helper2();", ""].join("\n"),
    );
  });

  test("skips missing and package tsconfig extends entries", () => {
    const files = {
      "tsconfig.json":
        '{"extends":["./config/missing.json","@tsconfig/strictest/tsconfig.json"],"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n',
      "src/a.ts": ['import { helper } from "@/b";', "export const n = helper();", ""].join("\n"),
      "src/c.ts": ['import { helper } from "./b";', "export const m = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "@/b";', "export const n = helper2();", ""].join("\n"),
    );
    expect(output["src/c.ts"]).toBe(
      ['import { helper2 } from "./b";', "export const m = helper2();", ""].join("\n"),
    );
  });

  test("keeps child tsconfig options when a parent config is malformed", () => {
    const files = {
      "tsconfig.json":
        '{"extends":"./config/broken.json","compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n',
      "config/broken.json": '{"compilerOptions":\n',
      "src/a.ts": ['import { helper } from "@/b";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "@/b";', "export const n = helper2();", ""].join("\n"),
    );
  });

  test("accepts JSONC in extended tsconfig files", () => {
    const files = {
      "tsconfig.json": [
        "{",
        "  // the root extends a shared parent",
        '  "extends": ["./config/base.json",],',
        "}",
        "",
      ].join("\n"),
      "config/base.json": [
        "{",
        "  // shared aliases",
        '  "compilerOptions": {',
        '    "baseUrl": "..",',
        '    "paths": {',
        '      "@/*": ["src/*"],',
        "    },",
        "  },",
        "}",
        "",
      ].join("\n"),
      "src/a.ts": ['import { helper } from "@/b";', "export const n = helper();", ""].join("\n"),
      "src/b.ts": TARGET,
    };
    const result = workspaceRename(files, "src/b.ts", "helper", "function", "helper", "helper2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const output = applyWorkspaceRename(files, result);
    expect(output["src/a.ts"]).toBe(
      ['import { helper2 } from "@/b";', "export const n = helper2();", ""].join("\n"),
    );
  });
});
