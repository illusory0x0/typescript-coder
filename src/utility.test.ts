import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { Parser } from "./parser";
import type {
  BlockStatement,
  ClassDeclaration,
  ExportDefaultDeclaration,
  FunctionDeclaration,
  InterfaceDeclaration,
  NamespaceDeclaration,
  Node,
  Program,
  Statement,
} from "./parser";
import {
  Binder,
  buildIndex,
  buildIndexTolerant,
  declarationSpaces,
  findDefinition,
  resolve,
} from "./utility";
import type { Scope, SourceFile, Symbol, SymbolIndex, SymbolSpace } from "./utility";

function bind(source: string): { program: Program; binder: Binder } {
  const program = new Parser(source).parseProgram();
  return { program, binder: new Binder(program) };
}

function resolveIn(scope: Scope, name: string, space?: SymbolSpace): Symbol | null {
  return resolve(scope, name, space);
}

function statementAt(program: Program, index: number): Statement {
  const statement = program.body[index];
  if (statement === undefined) {
    throw new Error(`missing statement at index ${index}`);
  }
  return statement;
}

function declarationKind(node: Node | undefined): string | undefined {
  if (node === undefined || !("kind" in node)) {
    return undefined;
  }
  return (node as { kind: string }).kind;
}

function requireScope(binder: Binder, node: Node): Scope {
  const scope = binder.scopeOf(node);
  if (scope === null) {
    throw new Error("expected a scope for the given node");
  }
  return scope;
}

test("resolves a global const and returns null for unknown names", () => {
  const { binder } = bind("const x = 1;");
  const symbol = resolveIn(binder.rootScope, "x", "value");
  expect(symbol).not.toBeNull();
  expect(symbol?.name).toBe("x");
  expect(symbol?.space).toBe("value");
  expect(declarationKind(symbol?.declarations[0])).toBe("VariableDeclarator");
  expect(resolveIn(binder.rootScope, "missing")).toBeNull();
});

test("an inner block shadows an outer const", () => {
  const source = "const x = 1; { const x = 2; }";
  const { program, binder } = bind(source);
  const block = statementAt(program, 1) as BlockStatement;
  const blockScope = requireScope(binder, block);
  const outer = resolveIn(binder.rootScope, "x", "value");
  const inner = resolveIn(blockScope, "x", "value");
  expect(outer).not.toBeNull();
  expect(inner).not.toBeNull();
  expect(inner).not.toBe(outer);
  expect(inner?.declarations).toHaveLength(1);
  expect(outer?.declarations[0]?.start).toBe(source.indexOf("const x = 1") + "const ".length);
  expect(inner?.declarations[0]?.start).toBe(source.indexOf("const x = 2") + "const ".length);
});

test("let in a block is not visible in the global scope", () => {
  const { binder } = bind("{ let y = 1; }");
  expect(resolveIn(binder.rootScope, "y", "value")).toBeNull();
});

test("using names bind as value symbols in the enclosing block", () => {
  const { program, binder } = bind("{ using r = resource(); }");
  const block = statementAt(program, 0) as BlockStatement;
  const blockScope = requireScope(binder, block);
  const symbol = resolveIn(blockScope, "r", "value");
  expect(symbol).not.toBeNull();
  expect(resolveIn(binder.rootScope, "r", "value")).toBeNull();
});

test("await using names bind as value symbols in the enclosing block", () => {
  const { program, binder } = bind("async function f() { await using r = resource(); }");
  const declaration = statementAt(program, 0) as FunctionDeclaration;
  const functionScope = requireScope(binder, declaration);
  expect(resolveIn(functionScope, "r", "value")).toBeNull();
  const body = declaration.body;
  if (body === null) {
    throw new Error("expected a function body");
  }
  const bodyScope = requireScope(binder, body);
  expect(resolveIn(bodyScope, "r", "value")).not.toBeNull();
});

test("var binds to the nearest function scope", () => {
  const { program, binder } = bind("function f() { { var v = 1; } }");
  const declaration = statementAt(program, 0) as FunctionDeclaration;
  const functionScope = requireScope(binder, declaration);
  expect(functionScope.kind).toBe("function");
  expect(resolveIn(functionScope, "v", "value")).not.toBeNull();
  expect(resolveIn(binder.rootScope, "v", "value")).toBeNull();
});

test("parameters bind in the function scope only", () => {
  const { program, binder } = bind("function f(p: T) { p; }");
  const declaration = statementAt(program, 0) as FunctionDeclaration;
  const functionScope = requireScope(binder, declaration);
  expect(resolveIn(functionScope, "p", "value")).not.toBeNull();
  expect(resolveIn(binder.rootScope, "p", "value")).toBeNull();
});

test("object binding pattern parameters bind every element", () => {
  const { program, binder } = bind("function f({a, b}: T) {}");
  const declaration = statementAt(program, 0) as FunctionDeclaration;
  const functionScope = requireScope(binder, declaration);
  expect(resolveIn(functionScope, "a", "value")).not.toBeNull();
  expect(resolveIn(functionScope, "b", "value")).not.toBeNull();
});

test("value and type spaces are distinct for the same name", () => {
  const { program, binder } = bind("interface X { a: T } const X = 1;");
  const iface = statementAt(program, 0) as InterfaceDeclaration;
  const value = resolveIn(binder.rootScope, "X", "value");
  const type = resolveIn(binder.rootScope, "X", "type");
  expect(value).not.toBeNull();
  expect(declarationKind(value?.declarations[0])).toBe("VariableDeclarator");
  expect(type).not.toBeNull();
  expect(type?.declarations[0]).toBe(iface);
  expect(type?.declarations[0]).not.toBe(value?.declarations[0]);
  expect(resolveIn(binder.rootScope, "X")).not.toBeNull();
});

test("a type alias contributes only a type symbol", () => {
  const { binder } = bind("type T = number;");
  expect(resolveIn(binder.rootScope, "T", "type")).not.toBeNull();
  expect(resolveIn(binder.rootScope, "T", "value")).toBeNull();
});

test("an enum contributes value and type symbols", () => {
  const { binder } = bind("enum E { A }");
  expect(resolveIn(binder.rootScope, "E", "value")).not.toBeNull();
  expect(resolveIn(binder.rootScope, "E", "type")).not.toBeNull();
});

test("imports bind value symbols and type-only imports bind type symbols", () => {
  const { binder } = bind(
    'import { a } from "m"; import type { B } from "m"; import D, * as ns from "m";',
  );
  expect(resolveIn(binder.rootScope, "a", "value")).not.toBeNull();
  expect(resolveIn(binder.rootScope, "a", "type")).toBeNull();
  expect(resolveIn(binder.rootScope, "D", "value")).not.toBeNull();
  expect(resolveIn(binder.rootScope, "ns", "value")).not.toBeNull();
  expect(resolveIn(binder.rootScope, "B", "type")).not.toBeNull();
  expect(resolveIn(binder.rootScope, "B", "value")).toBeNull();
});

test("a class binds a value symbol and its members live in the class scope", () => {
  const { program, binder } = bind("class C { m() {} }");
  const declaration = statementAt(program, 0) as ClassDeclaration;
  const classScope = requireScope(binder, declaration);
  expect(classScope.kind).toBe("class");
  expect(resolveIn(binder.rootScope, "C", "value")).not.toBeNull();
  expect(resolveIn(classScope, "m", "value")).not.toBeNull();
});

test("overload signatures merge into a single symbol", () => {
  const { binder } = bind(
    "function f(a: string): void; function f(a: number): void; function f(a: unknown) {}",
  );
  const symbol = resolveIn(binder.rootScope, "f", "value");
  expect(symbol).not.toBeNull();
  expect(symbol?.declarations).toHaveLength(3);
  for (const declaration of symbol?.declarations ?? []) {
    expect(declarationKind(declaration)).toBe("FunctionDeclaration");
  }
});

test("a namespace binds a namespace symbol and its body scope holds members", () => {
  const { program, binder } = bind("namespace N { const x = 1; }");
  const declaration = statementAt(program, 0) as NamespaceDeclaration;
  const namespaceScope = requireScope(binder, declaration);
  expect(namespaceScope.kind).toBe("namespace");
  expect(resolveIn(binder.rootScope, "N", "namespace")).not.toBeNull();
  expect(resolveIn(binder.rootScope, "N", "value")).toBeNull();
  expect(resolveIn(namespaceScope, "x", "value")).not.toBeNull();
});

test("exported declarations are bound like plain declarations", () => {
  const { program, binder } = bind("export const a = 1; export default class C {}");
  expect(resolveIn(binder.rootScope, "a", "value")).not.toBeNull();
  const declaration = statementAt(program, 1) as ExportDefaultDeclaration;
  expect(declaration.declaration.kind).toBe("ClassDeclaration");
  expect(resolveIn(binder.rootScope, "C", "value")).not.toBeNull();
  expect(resolveIn(binder.rootScope, "C", "type")).not.toBeNull();
});

test("an anonymous default export binds nothing", () => {
  const { binder } = bind("export default function () {}");
  expect(binder.rootScope.bindings.size).toBe(0);
});

test("an arrow function initializer creates a function scope with its parameters", () => {
  const { program, binder } = bind("const f = (p: T) => { const inner = p; };");
  const declaration = statementAt(program, 0);
  expect(declaration.kind).toBe("VariableStatement");
  const arrowScope = binder.scopes.find((scope) => scope.kind === "function");
  expect(arrowScope).toBeDefined();
  if (arrowScope === undefined || arrowScope.node === null) {
    throw new Error("expected an arrow function scope");
  }
  const functionScope = requireScope(binder, arrowScope.node);
  expect(resolveIn(functionScope, "p", "value")).not.toBeNull();
  expect(resolveIn(binder.rootScope, "p", "value")).toBeNull();
});

test("dotted namespace declarations nest scopes and index entries", () => {
  const path = "src/a.ts";
  const source = "namespace A.B.C { const x = 1; }";
  const { program, binder } = bind(source);
  const declaration = statementAt(program, 0) as NamespaceDeclaration;
  const scopeC = requireScope(binder, declaration);
  expect(scopeC.kind).toBe("namespace");
  expect(scopeC.parent?.kind).toBe("namespace");
  expect(resolveIn(binder.rootScope, "A", "namespace")).not.toBeNull();
  expect(resolveIn(binder.rootScope, "A.B", "namespace")).toBeNull();
  expect(resolveIn(scopeC, "x", "value")).not.toBeNull();
  const index = buildIndex([{ path, source }]);
  expect(index.lookup({ path, name: "A", kind: "namespace" })).toHaveLength(1);
  expect(index.lookup({ path, name: "A.B", kind: "namespace" })).toHaveLength(1);
  expect(index.lookup({ path, name: "A.B.C", kind: "namespace" })).toHaveLength(1);
  expect(index.lookup({ path, name: "A.B.C.x", kind: "variable" })).toHaveLength(1);
});

test("namespace declarations merge into one symbol and one scope", () => {
  const path = "src/merge.ts";
  const source = "namespace N { const a = 1; } namespace N { const b = 2; }";
  const { program, binder } = bind(source);
  const first = statementAt(program, 0) as NamespaceDeclaration;
  const second = statementAt(program, 1) as NamespaceDeclaration;
  const firstScope = requireScope(binder, first);
  const secondScope = requireScope(binder, second);
  expect(secondScope).toBe(firstScope);
  const symbol = resolveIn(binder.rootScope, "N", "namespace");
  expect(symbol?.declarations).toHaveLength(2);
  expect(resolveIn(firstScope, "a", "value")).not.toBeNull();
  expect(resolveIn(firstScope, "b", "value")).not.toBeNull();
  const index = buildIndex([{ path, source }]);
  const entries = index.lookup({ path, name: "N", kind: "namespace" });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.symbol.declarations).toHaveLength(2);
});

test("class members index with dotted member paths", () => {
  const path = "src/class.ts";
  const source = "class C { m() {} x = 1; }";
  const index = buildIndex([{ path, source }]);
  expect(index.lookup({ path, name: "C.m", kind: "method" })).toHaveLength(1);
  expect(index.lookup({ path, name: "C.x", kind: "variable" })).toHaveLength(1);
  expect(index.byName("C.C")).toHaveLength(0);
  const nestedPath = "src/nested.ts";
  const nestedSource = "namespace N { class K { m() {} } }";
  const nested = buildIndex([{ path: nestedPath, source: nestedSource }]);
  expect(nested.lookup({ path: nestedPath, name: "N.K.m", kind: "method" })).toHaveLength(1);
  expect(nested.lookup({ path: nestedPath, name: "N.K", kind: "class" }).length).toBeGreaterThan(0);
});

test("private class members index with their # prefix and stay distinct from public members", () => {
  const path = "src/private.ts";
  const source = "class A { #x = 1; #m() {} x = 2; }";
  const index = buildIndex([{ path, source }]);
  const field = index.lookup({ path, name: "A.#x", kind: "variable" });
  const method = index.lookup({ path, name: "A.#m", kind: "method" });
  expect(field).toHaveLength(1);
  expect(method).toHaveLength(1);
  expect(declarationKind(field[0]?.node)).toBe("PropertyDeclaration");
  expect(declarationKind(method[0]?.node)).toBe("MethodDeclaration");
  expect(index.lookup({ path, name: "A.x", kind: "variable" })).toHaveLength(1);
  expect(index.byName("x")).toHaveLength(0);
  expect(field[0]?.locator.name).toBe("A.#x");
});

test("buildIndex accepts modern syntax that used to throw", () => {
  const path = "src/modern.ts";
  const source = [
    "class A { #x = 1; }",
    "function f<const T>(x: T) { return x; }",
    "using x = resource();",
    'import data from "./d.json" with { type: "json" };',
  ].join("\n");
  const index = buildIndex([{ path, source }]);
  expect(index.lookup({ path, name: "A.#x", kind: "variable" })).toHaveLength(1);
  expect(index.lookup({ path, name: "f", kind: "function" })).toHaveLength(1);
  expect(index.lookup({ path, name: "x", kind: "variable" })).toHaveLength(1);
  // Imported names are aliases of declarations elsewhere and stay out of the index.
  expect(index.lookup({ path, name: "data", kind: "variable" })).toHaveLength(0);
});

test("class and enum declarations produce a single index entry each", () => {
  const path = "src/duplicates.ts";
  const source = "class Widget {}\nenum Color { Red }";
  const index = buildIndex([{ path, source }]);
  expect(index.lookup({ path, name: "Widget", kind: "class" })).toHaveLength(1);
  expect(index.lookup({ path, name: "Color", kind: "enum" })).toHaveLength(1);
});

test("an empty lookup kind is a path-and-name wildcard", () => {
  const path = "src/wildcard.ts";
  const source = "export function answer(): number {\n  return 1;\n}\n";
  const index = buildIndex([{ path, source }]);
  expect(index.lookup({ path, name: "answer", kind: "" })).toHaveLength(1);
  expect(index.lookup({ path, name: "missing", kind: "" })).toHaveLength(0);
});

test("lookup filters declarations by TypeScript symbol space", () => {
  const path = "src/spaces.ts";
  const source = [
    "export class Widget {}",
    "export enum Color { Red }",
    "export interface Shape {}",
    "export type Alias = number;",
    "export namespace Space {}",
    "export function work(): number {",
    "  return 1;",
    "}",
    "export const constant = 1;",
    "export let mutable = 2;",
  ].join("\n");
  const index = buildIndex([{ path, source }]);
  const spacesOf = (name: string): string[] => {
    const entry = index.lookup({ path, name, kind: "" })[0];
    if (entry === undefined) {
      throw new Error(`missing entry for ${name}`);
    }
    return [...declarationSpaces(entry)].sort();
  };
  expect(spacesOf("Widget")).toEqual(["type", "value"]);
  expect(spacesOf("Color")).toEqual(["type", "value"]);
  expect(spacesOf("Shape")).toEqual(["type"]);
  expect(spacesOf("Alias")).toEqual(["type"]);
  expect(spacesOf("Space")).toEqual(["namespace"]);
  expect(spacesOf("work")).toEqual(["value"]);
  expect(spacesOf("constant")).toEqual(["value"]);
  expect(spacesOf("mutable")).toEqual(["value"]);

  expect(index.lookup({ path, name: "Widget", kind: "" }, "value")).toHaveLength(1);
  expect(index.lookup({ path, name: "Widget", kind: "" }, "type")).toHaveLength(1);
  expect(index.lookup({ path, name: "Widget", kind: "" }, "namespace")).toHaveLength(0);
  expect(index.lookup({ path, name: "Shape", kind: "" }, "value")).toHaveLength(0);
  expect(index.lookup({ path, name: "Shape", kind: "" }, "type")).toHaveLength(1);
  expect(index.lookup({ path, name: "Space", kind: "" }, "namespace")).toHaveLength(1);
  expect(index.lookup({ path, name: "Space", kind: "" }, "value")).toHaveLength(0);
  expect(index.lookup({ path, name: "work", kind: "" }, "value")).toHaveLength(1);
  expect(index.lookup({ path, name: "work", kind: "" }, "type")).toHaveLength(0);
});

test("imported names are excluded from the index while real declarations remain", () => {
  const path = "src/imports.ts";
  const source = [
    'import D, { named } from "m";',
    'import type { T } from "m";',
    'import * as ns from "m";',
    'import E = require("m");',
    "export const keep = 1;",
    "namespace Inner {",
    '  import N = require("m");',
    "  export const nested = 2;",
    "}",
  ].join("\n");
  const index = buildIndex([{ path, source }]);
  for (const name of ["D", "named", "T", "ns", "E"]) {
    expect(index.byName(name)).toHaveLength(0);
  }
  // Namespace-nested import aliases are excluded too; real nested declarations stay.
  expect(index.lookup({ path, name: "Inner.N", kind: "variable" })).toHaveLength(0);
  expect(index.lookup({ path, name: "Inner.nested", kind: "variable" })).toHaveLength(1);
  expect(index.lookup({ path, name: "keep", kind: "variable" })).toHaveLength(1);
});

test("overload sets index as a single entry", () => {
  const path = "src/overload.ts";
  const source =
    "function f(a: string): void; function f(a: number): void; function f(a: unknown) {}";
  const index = buildIndex([{ path, source }]);
  const entries = index.lookup({ path, name: "f", kind: "function" });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.symbol.declarations).toHaveLength(3);
  expect(entries[0]?.node).toBe(entries[0]?.symbol.declarations[0]);
});

test("index kinds disambiguate declarations and lookup is exact", () => {
  const path = "src/kinds.ts";
  const source = "interface X {}\nconst X = 1;\ntype T = X;\nenum E { A }";
  const index = buildIndex([{ path, source }]);
  const iface = index.lookup({ path, name: "X", kind: "interface" });
  expect(iface).toHaveLength(1);
  expect(declarationKind(iface[0]?.node)).toBe("InterfaceDeclaration");
  const variable = index.lookup({ path, name: "X", kind: "variable" });
  expect(variable).toHaveLength(1);
  expect(declarationKind(variable[0]?.node)).toBe("VariableDeclarator");
  const alias = index.lookup({ path, name: "T", kind: "type" });
  expect(alias).toHaveLength(1);
  expect(declarationKind(alias[0]?.node)).toBe("TypeAliasDeclaration");
  const enums = index.lookup({ path, name: "E", kind: "enum" });
  expect(enums.length).toBeGreaterThan(0);
  for (const entry of enums) {
    expect(entry.locator.kind).toBe("enum");
  }
  expect(index.lookup({ path: "src/other.ts", name: "X", kind: "interface" })).toHaveLength(0);
  expect(index.lookup({ path, name: "X", kind: "enum" })).toHaveLength(0);
});

describe("buildIndexTolerant", () => {
  test("indexes valid files and reports unparseable ones with path and message", () => {
    const files: SourceFile[] = [
      { path: "src/broken.ts", source: "function broken( {\n" },
      { path: "src/ok.ts", source: "export function fix(): number {\n  return 1;\n}\n" },
    ];
    const { index, skipped } = buildIndexTolerant(files);
    expect(index.lookup({ path: "src/ok.ts", name: "fix", kind: "function" })).toHaveLength(1);
    expect(index.lookup({ path: "src/broken.ts", name: "broken", kind: "function" })).toHaveLength(
      0,
    );
    expect(skipped).toEqual([
      { path: "src/broken.ts", message: "unexpected end of input (line 2, column 1)" },
    ]);
  });

  test("keeps strict buildIndex throwing on the same input", () => {
    const files: SourceFile[] = [
      { path: "src/broken.ts", source: "function broken( {\n" },
      { path: "src/ok.ts", source: "export const ok = 1;\n" },
    ];
    expect(() => buildIndex(files)).toThrow("unexpected end of input");
  });

  test("skips every unparseable file and keeps the valid entries sorted", () => {
    const files: SourceFile[] = [
      { path: "src/a.ts", source: "export const a = 1;\n" },
      { path: "src/b.ts", source: ")" },
      { path: "src/c.ts", source: "export const c = 3;\n" },
    ];
    const { index, skipped } = buildIndexTolerant(files);
    expect(skipped.map((file) => file.path)).toEqual(["src/b.ts"]);
    expect(index.entries.map((entry) => entry.locator.path)).toEqual(["src/a.ts", "src/c.ts"]);
  });
});

test("byName spans files and lookup filters by path", () => {
  const files: SourceFile[] = [
    { path: "src/a.ts", source: "const shared = 1;" },
    { path: "src/b.ts", source: "const shared = 2;" },
  ];
  const index = buildIndex(files);
  expect(index.byName("shared")).toHaveLength(2);
  const first = index.lookup({ path: "src/a.ts", name: "shared", kind: "variable" });
  const second = index.lookup({ path: "src/b.ts", name: "shared", kind: "variable" });
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
  expect(first[0]?.locator.path).toBe("src/a.ts");
  expect(second[0]?.locator.path).toBe("src/b.ts");
  expect(first[0]?.node).not.toBe(second[0]?.node);
});

test("findDefinition returns the first exact match and null otherwise", () => {
  const path = "src/def.ts";
  const source = "function make(a: string): number { return a.length; }";
  const index = buildIndex([{ path, source }]);
  expect(findDefinition(index, { path, name: "make", kind: "function" })).not.toBeNull();
  expect(findDefinition(index, { path, name: "make", kind: "variable" })).toBeNull();
  expect(
    findDefinition(index, { path: "src/missing.ts", name: "make", kind: "function" }),
  ).toBeNull();
  const entry = findDefinition(index, { path, name: "make", kind: "function" });
  const node = entry?.node;
  expect(node).toBeDefined();
  if (node === undefined) {
    throw new Error("expected a definition node");
  }
  expect(source.slice(node.start, node.end).startsWith("function make")).toBe(true);
});

test("indexes a lexer-style namespace function by dotted locator", () => {
  const path = "src/lexer.ts";
  const source = [
    "namespace lexer {",
    "  export function make(source: string): number {",
    "    return source.length;",
    "  }",
    "}",
  ].join("\n");
  const index = buildIndex([{ path, source }]);
  const entry = findDefinition(index, { path, name: "lexer.make", kind: "function" });
  expect(entry).not.toBeNull();
  expect(entry?.locator).toEqual({ path, name: "lexer.make", kind: "function" });
});

describe("integration against the real repository sources", () => {
  const dir = new URL(".", import.meta.url);
  const files = readdirSync(dir, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string")
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
  const sources: SourceFile[] = files.map((file) => ({
    path: `src/${file}`,
    source: readFileSync(new URL(file, dir), "utf8"),
  }));
  const lexerSource = sources.find((file) => file.path === "src/lexer.ts")?.source ?? "";
  let cachedIndex: SymbolIndex | null = null;

  function repositoryIndex(): SymbolIndex {
    if (cachedIndex === null) {
      cachedIndex = buildIndex(sources);
    }
    return cachedIndex;
  }

  test("builds an index over the repository sources and produces entries", () => {
    expect(sources.length).toBeGreaterThan(0);
    const index = repositoryIndex();
    expect(index.entries.length).toBeGreaterThan(0);
  });

  test("finds tokenize in src/lexer.ts with its declaration span", () => {
    const entry = findDefinition(repositoryIndex(), {
      path: "src/lexer.ts",
      name: "tokenize",
      kind: "function",
    });
    expect(entry).not.toBeNull();
    const node = entry?.node;
    expect(node).toBeDefined();
    if (node === undefined) {
      throw new Error("expected a tokenize definition node");
    }
    expect(lexerSource.slice(node.start, node.end).startsWith("function tokenize")).toBe(true);
  });

  test("finds the Lexer.next method in src/lexer.ts", () => {
    expect(
      findDefinition(repositoryIndex(), {
        path: "src/lexer.ts",
        name: "Lexer.next",
        kind: "method",
      }),
    ).not.toBeNull();
  });

  test("finds the reservedKeywords variable in src/lexer.ts", () => {
    expect(
      findDefinition(repositoryIndex(), {
        path: "src/lexer.ts",
        name: "reservedKeywords",
        kind: "variable",
      }),
    ).not.toBeNull();
  });

  test("finds the Parser.parseProgram method in src/parser.ts", () => {
    expect(
      findDefinition(repositoryIndex(), {
        path: "src/parser.ts",
        name: "Parser.parseProgram",
        kind: "method",
      }),
    ).not.toBeNull();
  });

  test("returns null for a symbol that does not exist", () => {
    expect(
      findDefinition(repositoryIndex(), {
        path: "src/lexer.ts",
        name: "noSuchSymbol",
        kind: "function",
      }),
    ).toBeNull();
  });
});
