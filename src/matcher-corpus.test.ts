import { describe, expect, test } from "bun:test";
import { applyResolvedRegions, parseCheck } from "./commit";
import { resolveMultiEditor } from "./multi-editor";
import type { MultiEditorDeps, MultiEditorResolution } from "./multi-editor";
import { resolveCurrentEntry } from "./loop";
import { parseMultiEditor } from "./selection";
import type { Locator, SymbolSpace } from "./utility";

/**
 * The declaration/member/module corpus from #51/#53. Every case uses the real
 * edit-dsl reader, resolver, and commit pipeline (parseMultiEditor +
 * resolveMultiEditor + applyResolvedRegions/parseCheck), with in-memory file
 * deps. A supported form succeeds through one of the three selector paths:
 * structural `match`, `/regex/`, or `pick`; an intentionally unsupported or
 * ambiguous form fails with a clear diagnostic and queues no write.
 *
 * Add a form to FORMS only together with a success or expected-failure case.
 */

const TARGET = "src/a.ts";

const FORMS = [
  "top-level function",
  "top-level const",
  "top-level let",
  "top-level var",
  "top-level class",
  "top-level interface",
  "top-level type alias",
  "top-level enum",
  "top-level namespace",
  "top-level using",
  "class method",
  "class property",
  "class getter",
  "class setter",
  "class constructor",
  "class static block",
  "class computed member",
  "class index signature",
  "class constructor parameter property",
  "class auto-accessor",
  "interface method",
  "interface property",
  "interface call signature",
  "interface construct signature",
  "interface index signature",
  "type-literal method",
  "type-literal property",
  "type-literal call signature",
  "type-literal construct signature",
  "type-literal index signature",
  "namespace member",
  "enum member",
  "object-literal property",
  "object-literal method",
  "object-literal getter",
  "object-literal setter",
  "named default export",
  "anonymous default export",
  "named import",
  "default import",
  "namespace import",
  "type-only import",
  "side-effect import",
  "import = require",
  "named export",
  "star export",
  "re-export",
  "export =",
  "module create import",
  "module create export",
  "overload ambiguity",
  "merged declaration (kind-disambiguated)",
  "merged declaration (ambiguous)",
  "multi-declarator (safe binding)",
  "multi-declarator (whole-symbol rejection)",
  "destructuring (safe binding)",
  "destructuring (whole-symbol rejection)",
  "structural ambiguity",
  "unsupported context",
] as const;

type CorpusForm = (typeof FORMS)[number];

function resolveEntryIn(
  current: string,
  currentPath: string,
  locator: Locator,
  space: SymbolSpace | null,
): ReturnType<MultiEditorDeps["resolveEntry"]> {
  return resolveCurrentEntry(current, currentPath, locator, space);
}

function deps(files: Record<string, string>): MultiEditorDeps {
  return {
    sourceFor: (path) => files[path] ?? "",
    fileExists: (path) => Object.prototype.hasOwnProperty.call(files, path),
    isSafePath: () => true,
    resolveEntry: resolveEntryIn,
  };
}

function resolveReply(reply: string, source: string): MultiEditorResolution {
  return resolveMultiEditor(parseMultiEditor(reply), deps({ [TARGET]: source }));
}

async function applyReply(reply: string, source: string): Promise<string> {
  const result = resolveReply(reply, source);
  if (result.failures.length > 0) {
    throw new Error(
      `unexpected resolution failure:\n${result.failures
        .map((failure) => failure.diagnostics)
        .join("\n")}`,
    );
  }
  expect(result.regions).toHaveLength(1);
  const writes = await applyResolvedRegions({
    regions: result.regions.map((region) => ({ ...region, replacement: region.text })),
    fileSourceOf: (path) => (path === TARGET ? source : ""),
    target: TARGET,
    prevCheck: parseCheck(source),
    policy: { sameOffsetInserts: "append" },
    noteFailure: ({ diagnostics }) => {
      throw new Error(`unexpected apply failure:\n${diagnostics}`);
    },
    noteOverlap: () => {
      throw new Error("unexpected overlapping regions");
    },
  });
  expect(writes).toHaveLength(1);
  const applied = writes[0]?.source ?? "";
  const check = parseCheck(applied);
  if (!check.ok) {
    throw new Error(`applied source does not parse: ${check.failure.message}`);
  }
  return applied;
}

interface FormCase {
  form: CorpusForm;
  name: string;
  source: string;
  reply: string;
  contains: string[];
  notContains?: string[];
}

interface FailureCase {
  form: CorpusForm;
  name: string;
  source: string;
  reply: string;
  contains: string[];
  /** The edit-dsl reader rejects the clause before resolution. */
  parseFailure?: boolean;
}

function clause(
  header: string,
  locator: "match" | "regex",
  matcher: string,
  replacement: string,
): string {
  return [
    header,
    `match ${locator === "regex" ? `/${matcher}/` : `\`${matcher}\``}`,
    "replace with",
    "TC_EDIT_BEGIN",
    replacement,
    "TC_EDIT_END",
    "end",
  ].join("\n");
}

function fileClause(locator: "match" | "regex", matcher: string, replacement: string): string {
  return clause(`select file ${TARGET}`, locator, matcher, replacement);
}

function moduleCreate(kind: "import" | "export", body: string): string {
  return [`create ${kind} in ${TARGET} with`, "TC_EDIT_BEGIN", body, "TC_EDIT_END", "end"].join(
    "\n",
  );
}

function declarationCreate(kind: string, name: string, body: string): string {
  return [
    `create ${kind} ${name} in ${TARGET} with`,
    "TC_EDIT_BEGIN",
    body,
    "TC_EDIT_END",
    "end",
  ].join("\n");
}

const CLASS_SOURCE = [
  "export class Widget {",
  "  count = 0;",
  "  get value(): number {",
  "    return this.count;",
  "  }",
  "  set value(next: number) {",
  "    this.count = next;",
  "  }",
  "  constructor(initial: number) {",
  "    this.count = initial;",
  "  }",
  "  render(): string {",
  '    return "x";',
  "  }",
  "  [symbolKey](): number {",
  "    return 2;",
  "  }",
  "  static {",
  "    this.count = 0;",
  "  }",
  "}",
  "",
].join("\n");

const INTERFACE_SOURCE = [
  "export interface Cell {",
  "  read(): number;",
  "  value: string;",
  "  (input: string): number;",
  "  new (input: string): Cell;",
  "  [key: string]: unknown;",
  "}",
  "",
].join("\n");

const TYPE_LITERAL_SOURCE = [
  "export type Snapshot = {",
  "  read(): number;",
  "  value: string;",
  "};",
  "",
].join("\n");

const TYPE_SIGNATURES_SOURCE = [
  "export type Fn = {",
  "  (x: string): number;",
  "  new (x: string): Fn;",
  "  [key: string]: unknown;",
  "};",
  "",
].join("\n");

const OBJECT_METHOD_SOURCE = [
  "const config = {",
  "  run() {",
  "    return 1;",
  "  },",
  "  get value() {",
  "    return 2;",
  "  },",
  "  set value(v: number) {",
  "    this.seed = v;",
  "  },",
  "};",
  "",
].join("\n");

const CLASS_INDEX_SOURCE = [
  "export class Box {",
  "  [key: string]: unknown;",
  "  constructor(private value: number) {}",
  "}",
  "",
].join("\n");

const SUCCESS_CASES: FormCase[] = [
  {
    form: "top-level function",
    name: "edits a return through a structural statement",
    source: "export function answer(): number {\n  return 1;\n}\n",
    reply: clause("select function answer in src/a.ts", "match", "return 1;", "return 2;"),
    contains: ["return 2;"],
    notContains: ["return 1;"],
  },
  {
    form: "top-level const",
    name: "edits a const initializer",
    source: "export const VALUE = 1;\n",
    reply: clause("select const VALUE in src/a.ts", "match", "1", "2"),
    contains: ["VALUE = 2"],
  },
  {
    form: "top-level let",
    name: "edits a let initializer",
    source: "export let counter = 0;\n",
    reply: clause("select let counter in src/a.ts", "match", "0", "1"),
    contains: ["counter = 1"],
  },
  {
    form: "top-level var",
    name: "edits a var initializer",
    source: 'export var legacy = "old";\n',
    reply: clause("select var legacy in src/a.ts", "match", '"old"', '"new"'),
    contains: ['legacy = "new"'],
  },
  {
    form: "top-level class",
    name: "edits a class body statement",
    source: CLASS_SOURCE,
    reply: clause("select class Widget in src/a.ts", "match", 'return "x";', 'return "y";'),
    contains: ['return "y";'],
  },
  {
    form: "top-level interface",
    name: "edits an interface member through the interface owner",
    source: INTERFACE_SOURCE,
    reply: clause(
      "select interface Cell in src/a.ts",
      "match",
      "read(): number;",
      "read(): string",
    ),
    contains: ["read(): string;"],
  },
  {
    form: "top-level type alias",
    name: "edits a type-literal member through the alias owner",
    source: TYPE_LITERAL_SOURCE,
    reply: clause("select type Snapshot in src/a.ts", "match", "value: string", "value: number"),
    contains: ["value: number"],
    notContains: ["value: string"],
  },
  {
    form: "top-level enum",
    name: "edits an enum initializer through the enum owner with a regex",
    source: "export enum Color {\n  Red = 0,\n  Blue = 1,\n}\n",
    reply: clause("select enum Color in src/a.ts", "regex", "Red = 0", "Red = 2"),
    contains: ["Red = 2"],
    notContains: ["Red = 0"],
  },
  {
    form: "top-level namespace",
    name: "edits a namespace statement through the namespace owner",
    source: "export namespace Util {\n  export const existing = 1;\n}\n",
    reply: clause(
      "select namespace Util in src/a.ts",
      "match",
      "export const existing = 1;",
      "export const existing = 2;",
    ),
    contains: ["export const existing = 2;"],
  },
  {
    form: "top-level using",
    name: "creates a using declaration",
    source: "",
    reply: declarationCreate("using", "resource", "using resource = acquire();"),
    contains: ["using resource = acquire();"],
  },
  {
    form: "top-level using",
    name: "edits a using initializer through its binding with an omitted kind",
    source: "using resource = acquire();\n",
    reply: clause("select resource in src/a.ts", "match", "acquire()", "open()"),
    contains: ["using resource = open();"],
    notContains: ["acquire()"],
  },
  {
    form: "class method",
    name: "edits a method body through its member address",
    source: CLASS_SOURCE,
    reply: clause("select Widget.render in src/a.ts", "match", 'return "x";', 'return "z";'),
    contains: ['return "z";'],
  },
  {
    form: "class property",
    name: "edits a property initializer through its member address",
    source: CLASS_SOURCE,
    reply: clause("select Widget.count in src/a.ts", "match", "0", "1"),
    contains: ["count = 1"],
  },
  {
    form: "class getter",
    name: "edits a getter body through the class owner",
    source: CLASS_SOURCE,
    reply: clause(
      "select class Widget in src/a.ts",
      "match",
      "get value(): number {\n    return this.count;\n  }",
      "get value(): number {\n    return this.count + 1;\n  }",
    ),
    contains: ["return this.count + 1;"],
  },
  {
    form: "class setter",
    name: "edits a setter body through the class owner",
    source: CLASS_SOURCE,
    reply: clause(
      "select class Widget in src/a.ts",
      "match",
      "set value(next: number) {\n    this.count = next;\n  }",
      "set value(next: number) {\n    this.count = next + 1;\n  }",
    ),
    contains: ["this.count = next + 1;"],
  },
  {
    form: "class constructor",
    name: "edits a constructor through the class owner",
    source: CLASS_SOURCE,
    reply: clause(
      "select class Widget in src/a.ts",
      "match",
      "constructor(initial: number) {\n    this.count = initial;\n  }",
      "constructor(initial: number) {\n    this.count = initial + 1;\n  }",
    ),
    contains: ["this.count = initial + 1;"],
  },
  {
    form: "class static block",
    name: "edits a static block through the class owner",
    source: CLASS_SOURCE,
    reply: clause(
      "select class Widget in src/a.ts",
      "match",
      "static {\n    this.count = 0;\n  }",
      "static {\n    this.count = 2;\n  }",
    ),
    contains: ["static {", "this.count = 2;"],
  },
  {
    form: "class computed member",
    name: "edits inside a computed member through the class owner and a regex",
    source: CLASS_SOURCE,
    reply: clause("select class Widget in src/a.ts", "regex", "return 2;", "return 3;"),
    contains: ["return 3;"],
    notContains: ["return 2;"],
  },
  {
    form: "class computed member",
    name: "edits inside a computed member through the class owner and a pick range",
    source: CLASS_SOURCE,
    reply: [
      "select class Widget in src/a.ts",
      "pick 16",
      "replace with",
      "TC_EDIT_BEGIN",
      "    return 4;",
      "TC_EDIT_END",
      "end",
    ].join("\n"),
    contains: ["return 4;"],
    notContains: ["return 2;"],
  },
  {
    form: "class index signature",
    name: "edits a class index signature through the class owner and a regex",
    source: CLASS_INDEX_SOURCE,
    reply: clause(
      "select class Box in src/a.ts",
      "regex",
      "\\[key: string\\]: unknown;",
      "[key: string]: number;",
    ),
    contains: ["[key: string]: number;"],
    notContains: ["[key: string]: unknown;"],
  },
  {
    form: "class constructor parameter property",
    name: "edits a constructor parameter property through the class owner and a regex",
    source: CLASS_INDEX_SOURCE,
    reply: clause(
      "select class Box in src/a.ts",
      "regex",
      "private value: number",
      "private initial: number",
    ),
    contains: ["constructor(private initial: number)"],
    notContains: ["private value: number"],
  },
  {
    form: "interface method",
    name: "edits an interface method signature",
    source: INTERFACE_SOURCE,
    reply: clause(
      "select interface Cell in src/a.ts",
      "match",
      "read(): number;",
      "read(): string",
    ),
    contains: ["read(): string;"],
  },
  {
    form: "interface property",
    name: "edits an interface property through its member address",
    source: INTERFACE_SOURCE,
    reply: clause("select Cell.value in src/a.ts", "match", "string", "number"),
    contains: ["value: number;"],
  },
  {
    form: "interface call signature",
    name: "edits a call signature through the interface owner",
    source: INTERFACE_SOURCE,
    reply: clause(
      "select interface Cell in src/a.ts",
      "match",
      "(input: string): number;",
      "(input: string): string",
    ),
    contains: ["(input: string): string;"],
  },
  {
    form: "interface construct signature",
    name: "edits a construct signature through the interface owner",
    source: INTERFACE_SOURCE,
    reply: clause(
      "select interface Cell in src/a.ts",
      "match",
      "new (input: string): Cell;",
      "new (source: string): Cell",
    ),
    contains: ["new (source: string): Cell;"],
  },
  {
    form: "interface index signature",
    name: "edits an index signature through the interface owner",
    source: INTERFACE_SOURCE,
    reply: clause(
      "select interface Cell in src/a.ts",
      "match",
      "[key: string]: unknown;",
      "[key: string]: number",
    ),
    contains: ["[key: string]: number;"],
  },
  {
    form: "type-literal method",
    name: "edits a type-literal method signature",
    source: TYPE_LITERAL_SOURCE,
    reply: clause("select type Snapshot in src/a.ts", "match", "read(): number;", "read(): string"),
    contains: ["read(): string;"],
  },
  {
    form: "type-literal property",
    name: "edits a type-literal property through its member address",
    source: TYPE_LITERAL_SOURCE,
    reply: clause("select Snapshot.value in src/a.ts", "match", "string", "number"),
    contains: ["value: number"],
  },
  {
    form: "type-literal call signature",
    name: "edits a type-literal call signature through the alias owner",
    source: TYPE_SIGNATURES_SOURCE,
    reply: clause(
      "select type Fn in src/a.ts",
      "match",
      "(x: string): number;",
      "(x: string): string",
    ),
    contains: ["(x: string): string;"],
  },
  {
    form: "type-literal construct signature",
    name: "edits a type-literal construct signature through the alias owner",
    source: TYPE_SIGNATURES_SOURCE,
    reply: clause(
      "select type Fn in src/a.ts",
      "match",
      "new (x: string): Fn;",
      "new (source: string): Fn",
    ),
    contains: ["new (source: string): Fn;"],
  },
  {
    form: "type-literal index signature",
    name: "edits a type-literal index signature through the alias owner",
    source: TYPE_SIGNATURES_SOURCE,
    reply: clause(
      "select type Fn in src/a.ts",
      "match",
      "[key: string]: unknown;",
      "[key: string]: number",
    ),
    contains: ["[key: string]: number;"],
  },
  {
    form: "namespace member",
    name: "edits a namespace function through the dotted address",
    source:
      "export namespace Util {\n  export function helper(): number {\n    return 1;\n  }\n}\n",
    reply: clause("select function Util.helper in src/a.ts", "match", "return 1;", "return 2;"),
    contains: ["return 2;"],
  },
  {
    form: "enum member",
    name: "edits an enum member through the dotted address",
    source: "export enum Color {\n  Red = 0,\n  Blue = 1,\n}\n",
    reply: clause("select Color.Red in src/a.ts", "match", "0", "2"),
    contains: ["Red = 2"],
  },
  {
    form: "object-literal property",
    name: "edits an object-literal property value",
    source: "const config = {\n  timeout: 1000,\n  retries: 3,\n};\n",
    reply: clause("select config.timeout in src/a.ts", "match", "1000", "2000"),
    contains: ["timeout: 2000"],
  },
  {
    form: "object-literal method",
    name: "edits an object-literal method through its member address",
    source: OBJECT_METHOD_SOURCE,
    reply: clause("select config.run in src/a.ts", "match", "return 1;", "return 3;"),
    contains: ["run() {", "return 3;"],
    notContains: ["return 1;"],
  },
  {
    form: "object-literal getter",
    name: "edits an object-literal getter through the object owner",
    source: OBJECT_METHOD_SOURCE,
    reply: clause(
      "select const config in src/a.ts",
      "match",
      "get value() {\n    return 2;\n  }",
      "get value() {\n    return 4;\n  }",
    ),
    contains: ["get value() {", "return 4;"],
    notContains: ["return 2;"],
  },
  {
    form: "object-literal setter",
    name: "edits an object-literal setter through the object owner",
    source: OBJECT_METHOD_SOURCE,
    reply: clause(
      "select const config in src/a.ts",
      "match",
      "set value(v: number) {\n    this.seed = v;\n  }",
      "set value(v: number) {\n    this.seed = v + 1;\n  }",
    ),
    contains: ["set value(v: number) {", "this.seed = v + 1;"],
  },
  {
    form: "named default export",
    name: "addresses a named default export by its declaration name",
    source: "export default function boot(): number {\n  return 1;\n}\n",
    reply: clause("select function boot in src/a.ts", "match", "return 1;", "return 2;"),
    contains: ["return 2;"],
  },
  {
    form: "anonymous default export",
    name: "edits an anonymous default export expression through select file",
    source: "export default {\n  answer: 42,\n};\n",
    reply: fileClause("match", "answer: 42", "answer: 43"),
    contains: ["answer: 43"],
  },
  {
    form: "named import",
    name: "edits a named import specifier through select file and a regex",
    source: 'import { a, b as c } from "./a";\n',
    reply: fileClause("regex", "a, b as c", "a as alpha, b as c"),
    contains: ["import { a as alpha, b as c }"],
  },
  {
    form: "default import",
    name: "edits a default import binding through select file and a regex",
    source: 'import def from "./a";\n',
    reply: fileClause("regex", "def", "defaultImport"),
    contains: ["import defaultImport from"],
  },
  {
    form: "namespace import",
    name: "edits a namespace import binding structurally",
    source: 'import * as ns from "./a";\n',
    reply: fileClause("match", "ns", "space"),
    contains: ["import * as space from"],
  },
  {
    form: "type-only import",
    name: "edits a type-only import specifier structurally",
    source: 'import type { T } from "./a";\n',
    reply: fileClause("match", "T", "T as Model"),
    contains: ["import type { T as Model } from"],
  },
  {
    form: "side-effect import",
    name: "edits a side-effect import statement",
    source: 'import "./side-effect";\n',
    reply: fileClause("match", 'import "./side-effect";', 'import "./side-effect-v2";'),
    contains: ['import "./side-effect-v2";'],
    notContains: ['import "./side-effect";'],
  },
  {
    form: "import = require",
    name: "edits an import-equals statement through select file",
    source: 'import fs = require("fs");\n',
    reply: fileClause("match", 'import fs = require("fs");', 'import nodeFs = require("fs");'),
    contains: ['import nodeFs = require("fs");'],
    notContains: ['import fs = require("fs");'],
  },
  {
    form: "named export",
    name: "edits a named export statement through select file",
    source: "const local = 1;\nexport { local };\n",
    reply: fileClause("match", "export { local };", "export { local as renamed };"),
    contains: ["export { local as renamed };"],
  },
  {
    form: "star export",
    name: "edits a star export statement through select file",
    source: 'export * from "./a";\n',
    reply: fileClause("match", 'export * from "./a";', 'export * as everything from "./a";'),
    contains: ['export * as everything from "./a";'],
  },
  {
    form: "re-export",
    name: "edits a re-export alias through select file and a regex",
    source: 'export { a as b } from "./a";\n',
    reply: fileClause("regex", "a as b", "a as c"),
    contains: ["export { a as c } from"],
  },
  {
    form: "export =",
    name: "edits an export assignment through select file",
    source: "export = value;\n",
    reply: fileClause("match", "export = value;", "export = other;"),
    contains: ["export = other;"],
  },
  {
    form: "module create import",
    name: "creates a type-only import at the module boundary",
    source: "",
    reply: moduleCreate("import", 'import type { T } from "./t";'),
    contains: ['import type { T } from "./t";'],
  },
  {
    form: "module create export",
    name: "creates a star re-export at the module boundary",
    source: "export const existing = 1;\n",
    reply: moduleCreate("export", 'export * as ns from "./a";'),
    contains: ['export * as ns from "./a";', "export const existing = 1;"],
  },
  {
    form: "merged declaration (kind-disambiguated)",
    name: "edits the class half of a class/interface merge with an explicit kind",
    source:
      "export class Owner {\n  count = 0;\n}\nexport interface Owner {\n  value: string;\n}\n",
    reply: clause("select class Owner in src/a.ts", "match", "count = 0", "count = 1"),
    contains: ["count = 1"],
  },
  {
    form: "multi-declarator (safe binding)",
    name: "edits one binding in a multi-declarator statement",
    source: "const first = 1, second = 2;\n",
    reply: clause("select const first in src/a.ts", "match", "1", "3"),
    contains: ["first = 3", "second = 2"],
  },
  {
    form: "destructuring (safe binding)",
    name: "edits one destructured binding with a matcher",
    source: "const { a, b } = pair;\n",
    reply: clause("select const a in src/a.ts", "match", "a", "alpha"),
    contains: ["const { alpha, b } = pair;"],
  },
];

const FAILURE_CASES: FailureCase[] = [
  {
    form: "overload ambiguity",
    name: "rejects an overload set as an ambiguous declaration address",
    source: [
      "export function parse(value: string): string;",
      "export function parse(value: number): number;",
      "export function parse(value: unknown): unknown {",
      "  return value;",
      "}",
      "",
    ].join("\n"),
    reply: clause("select function parse in src/a.ts", "match", "return value;", "return 0;"),
    contains: [
      '"symbol":"parse"',
      "matches 3 declarations",
      "line 1, column 8",
      "line 3, column 8",
    ],
  },
  {
    form: "merged declaration (ambiguous)",
    name: "rejects a merged class/interface name without an explicit kind",
    source:
      "export class Owner {\n  count = 0;\n}\nexport interface Owner {\n  value: string;\n}\n",
    reply: clause("select Owner in src/a.ts", "match", "count = 0", "count = 1"),
    contains: ['"symbol":"Owner"', "matches 2 declarations", 'class "Owner"', 'interface "Owner"'],
  },
  {
    form: "multi-declarator (whole-symbol rejection)",
    name: "rejects a whole-symbol rewrite of one multi-declarator binding",
    source: "const first = 1, second = 2;\n",
    reply: [
      "select const first in src/a.ts",
      "replace with",
      "TC_EDIT_BEGIN",
      "const first = 9;",
      "TC_EDIT_END",
      "end",
    ].join("\n"),
    contains: ["sibling declarators", "sibling binding", "match", "pick"],
  },
  {
    form: "destructuring (whole-symbol rejection)",
    name: "rejects a whole-symbol rewrite of a destructured binding",
    source: "const { a, b } = pair;\n",
    reply: [
      "select const a in src/a.ts",
      "replace with",
      "TC_EDIT_BEGIN",
      "const a = 1;",
      "TC_EDIT_END",
      "end",
    ].join("\n"),
    contains: ["sibling binding", "match", "pick", "destructuring"],
  },
  {
    form: "top-level using",
    name: "rejects the select grammar's explicit using kind and asks for an omitted kind",
    source: "using resource = acquire();\n",
    reply: clause("select using resource in src/a.ts", "match", "acquire()", "open()"),
    contains: ["unknown kind `using`", "omit the declaration kind"],
    parseFailure: true,
  },
  {
    form: "class auto-accessor",
    name: "rejects a structural auto-accessor member because the parser does not model it",
    source: "export class Config {\n  accessor value = 1;\n}\n",
    reply: clause(
      "select class Config in src/a.ts",
      "match",
      "accessor value = 1;",
      "accessor value = 2;",
    ),
    contains: [
      "does not parse in any supported owner context",
      "class member",
      "`/regex/`",
      "`pick`",
    ],
  },
  {
    form: "structural ambiguity",
    name: "reports every structural candidate with line, column, and source line",
    source: "export function twice(): number {\n  return 1;\n  return 1;\n}\n",
    reply: clause("select function twice in src/a.ts", "match", "return 1;", "return 2;"),
    contains: [
      "stage: matcher",
      "matches 2 places",
      "candidates:",
      "2:3  return 1;",
      "3:3  return 1;",
    ],
  },
  {
    form: "unsupported context",
    name: "names the owner contexts and the regex/pick fallbacks for a decorator",
    source: "@sealed\nexport class Widget {\n  method(): void {}\n}\n",
    reply: clause("select class Widget in src/a.ts", "match", "@sealed", "@logged"),
    contains: [
      "stage: matcher",
      "top-level statement",
      "class member",
      "interface/type member",
      "object-literal member",
      "function-body",
      "type expression",
      "standalone decorator",
      "`/regex/`",
      "`pick`",
    ],
  },
];

describe("matcher/declaration corpus (#51/#53)", () => {
  test("every listed form has a success or expected-failure case", () => {
    const covered = new Set<string>([
      ...SUCCESS_CASES.map((entry) => entry.form),
      ...FAILURE_CASES.map((entry) => entry.form),
    ]);
    expect([...FORMS].filter((form) => !covered.has(form))).toEqual([]);
    expect([...covered].filter((form) => !(FORMS as readonly string[]).includes(form))).toEqual([]);
  });

  for (const entry of SUCCESS_CASES) {
    test(`${entry.form}: ${entry.name}`, async () => {
      const applied = await applyReply(entry.reply, entry.source);
      for (const expected of entry.contains) {
        expect(applied).toContain(expected);
      }
      for (const forbidden of entry.notContains ?? []) {
        expect(applied).not.toContain(forbidden);
      }
    });
  }

  for (const entry of FAILURE_CASES) {
    test(`${entry.form}: ${entry.name}`, () => {
      let diagnostics: string;
      if (entry.parseFailure === true) {
        try {
          resolveReply(entry.reply, entry.source);
          diagnostics = "";
        } catch (error) {
          diagnostics = error instanceof Error ? error.message : String(error);
        }
        expect(diagnostics).not.toBe("");
      } else {
        const result = resolveReply(entry.reply, entry.source);
        expect(result.regions).toEqual([]);
        expect(result.creates).toEqual([]);
        expect(result.deletes).toEqual([]);
        expect(result.failures.length).toBeGreaterThan(0);
        diagnostics = result.failures.map((failure) => failure.diagnostics).join("\n");
      }
      for (const expected of entry.contains) {
        expect(diagnostics).toContain(expected);
      }
    });
  }
});
