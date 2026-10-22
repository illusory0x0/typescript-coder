import { describe, expect, test } from "bun:test";
import { resolveLocalRename } from "./rename";
import type { RenameEdit } from "./rename";
import type { Locator } from "./utility";

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
