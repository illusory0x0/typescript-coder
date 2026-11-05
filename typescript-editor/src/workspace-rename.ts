import { posix } from "node:path";
import { Parser } from "./parser";
import type { BindingName, Expression, Program, Statement } from "./parser";
import { sourceLineAt } from "./dsl-diagnostics";
import { resolveLocalRename, scanNamespaceMemberEdits } from "./rename";
import type { RenameEdit, RenameOptions, RenameTarget } from "./rename";
import type { Locator } from "./utility";

/**
 * Workspace callbacks a cross-file rename needs. The target source is passed
 * separately; these callbacks resolve and enumerate the other files.
 */
export interface WorkspaceRenameDeps {
  sourceFor: (path: string) => string;
  fileExists: (path: string) => boolean;
  isSafePath: (path: string) => boolean;
  /** Every workspace TypeScript file, as a workspace-relative `/` path. */
  listFiles: () => readonly string[];
}

/** One file's contribution to a workspace rename. */
export interface WorkspaceRenameFile {
  path: string;
  edits: RenameEdit[];
}

export type WorkspaceRenameResult =
  | { ok: true; target: RenameTarget; files: WorkspaceRenameFile[] }
  | { ok: false; path: string; diagnostics: string };

const MODULE_EXTENSION = /\.(?:ts|tsx|mts|cts)$/;
const JS_EXTENSION = /\.(?:js|jsx|mjs|cjs)$/;
const CANDIDATE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts", ".d.ts"];

function bindingNames(name: BindingName): string[] {
  switch (name.kind) {
    case "Identifier":
      return [name.name];
    case "ArrayPattern":
      return name.elements.flatMap((element) =>
        element === null ? [] : bindingNames(element.binding),
      );
    case "ObjectPattern":
      return name.properties.flatMap((property) => bindingNames(property.binding));
  }
}

/** The names a top-level declaration statement exports directly. */
function declaredNames(statement: Statement): string[] {
  switch (statement.kind) {
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return statement.name === null ? [] : [statement.name.name];
    case "InterfaceDeclaration":
    case "TypeAliasDeclaration":
    case "EnumDeclaration":
      return [statement.name.name];
    case "NamespaceDeclaration": {
      const first = statement.name.split(".")[0];
      return first === undefined ? [] : [first];
    }
    case "VariableStatement":
      return statement.declarations.flatMap((declarator) => bindingNames(declarator.name));
    default:
      return [];
  }
}

function resolveModuleFile(
  importerPath: string,
  specifier: string,
  deps: Pick<WorkspaceRenameDeps, "fileExists" | "isSafePath">,
): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return null;
  }
  const base = posix.normalize(posix.join(posix.dirname(importerPath), specifier));
  if (base === ".." || base.startsWith("../") || posix.isAbsolute(base)) {
    return null;
  }
  const candidates: string[] = [];
  if (MODULE_EXTENSION.test(base)) {
    candidates.push(base);
  } else {
    // TypeScript's NodeNext resolution maps a `./x.js` specifier to `x.ts`,
    // and extensionless specifiers to the usual TS extensions.
    const stem = base.replace(JS_EXTENSION, "");
    for (const extension of CANDIDATE_EXTENSIONS) {
      candidates.push(`${stem}${extension}`);
    }
    candidates.push(`${stem}/index.ts`, `${stem}/index.tsx`);
  }
  for (const candidate of candidates) {
    if (deps.isSafePath(candidate) && deps.fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * The specifier of a direct `require("./relative")` module reference, or null
 * for every other `import =` shape. Type arguments, optional calls, spreads,
 * extra arguments, `as`, and property access are deliberately not followed.
 */
function directRequireSpecifier(moduleReference: Expression): string | null {
  if (moduleReference.kind !== "CallExpression" || moduleReference.optional) {
    return null;
  }
  if (moduleReference.typeArguments !== undefined) {
    return null;
  }
  if (moduleReference.callee.kind !== "Identifier" || moduleReference.callee.name !== "require") {
    return null;
  }
  if (moduleReference.arguments.length !== 1) {
    return null;
  }
  const argument = moduleReference.arguments[0];
  return argument !== undefined && argument.kind === "StringLiteral" ? argument.value : null;
}

/** One workspace rename failure with the offending importer line/column. */
function memberDiagnostic(
  source: string,
  importerPath: string,
  rename: { from: string; to: string },
  offset: number,
  message: string,
): string {
  const location = sourceLineAt(source, offset);
  return (
    `cannot rename \`${rename.from}\` to \`${rename.to}\` in ${importerPath} at ` +
    `${location.line}:${location.column}: ${message}\n` +
    `source: ${location.text.trim()}`
  );
}

interface PublicNameEntry {
  before: string;
  after: string;
}

/**
 * Every public name a module exports, before and after this rename. A local
 * export specifier bound to the renamed binding (`export { helper }`) changes
 * with it; an alias (`export { helper as publicHelper }`) keeps its public name.
 * Re-exports with a source only change when that source resolves to the renamed
 * file and the specifier names the renamed binding. `export *` is out of scope
 * and contributes no entries.
 */
function exportState(
  program: Program,
  from: string,
  to: string,
  declarationLocal: string | null,
  importLocal: string | null,
  isRenamedSource: ((specifier: string) => boolean) | null,
): PublicNameEntry[] {
  const entries: PublicNameEntry[] = [];
  for (const statement of program.body) {
    if (statement.kind !== "ExportNamedDeclaration") {
      continue;
    }
    if (statement.declaration !== null) {
      for (const name of declaredNames(statement.declaration)) {
        entries.push({ before: name, after: name === declarationLocal ? to : name });
      }
      continue;
    }
    for (const specifier of statement.specifiers) {
      const localName =
        specifier.local.kind === "Identifier" ? specifier.local.name : specifier.local.value;
      const exportedName =
        specifier.exported === null
          ? null
          : specifier.exported.kind === "Identifier"
            ? specifier.exported.name
            : specifier.exported.value;
      const before = exportedName ?? localName;
      let localAfter = localName;
      if (statement.source === null) {
        if (
          importLocal !== null &&
          specifier.local.kind === "Identifier" &&
          localName === importLocal
        ) {
          localAfter = to;
        }
      } else {
        const renamedSource = isRenamedSource !== null && isRenamedSource(statement.source.value);
        if (renamedSource && specifier.local.kind === "Identifier" && localName === from) {
          localAfter = to;
        }
      }
      entries.push({ before, after: exportedName ?? localAfter });
    }
  }
  return entries;
}

/**
 * True when this rename would add a second export edge for `to` in the module:
 * another declaration/specifier already exports it, or two affected specifiers
 * would converge on it. A module with no changed public names never collides.
 */
function hasExportCollision(entries: readonly PublicNameEntry[], to: string): boolean {
  let changing = 0;
  let exported = 0;
  for (const entry of entries) {
    if (entry.before !== entry.after) {
      changing += 1;
    }
    if (entry.after === to) {
      exported += 1;
    }
  }
  return changing > 0 && exported > 1;
}

interface ImporterScan {
  edits: RenameEdit[];
  diagnostics: string | null;
}

function scanImporter(
  source: string,
  importerPath: string,
  targetPath: string,
  mapping: ReadonlyMap<string, string>,
  rename: { from: string; to: string },
  deps: WorkspaceRenameDeps,
): ImporterScan {
  let program: Program;
  try {
    program = new Parser(source).parseProgram();
  } catch {
    // An unrelated file that does not parse cannot contribute a resolved edge.
    return { edits: [], diagnostics: null };
  }

  const edits = new Map<string, RenameEdit>();
  const add = (edit: RenameEdit): void => {
    edits.set(`${edit.start}:${edit.end}`, edit);
  };
  const renamedImportLocals = new Set<string>();
  const namespaceLocals = new Set<string>();
  const unsupportedImportEquals: Array<{ local: string; start: number }> = [];
  const sourceMatchesTarget = (specifier: string): boolean =>
    resolveModuleFile(importerPath, specifier, deps) === targetPath;

  for (const statement of program.body) {
    if (statement.kind === "ImportDeclaration") {
      const matchesTarget = sourceMatchesTarget(statement.source.value);
      if (statement.namespaceImport !== null && matchesTarget) {
        namespaceLocals.add(statement.namespaceImport.name);
      }
      if (!matchesTarget) {
        continue;
      }
      for (const specifier of statement.namedImports) {
        const importedName =
          specifier.imported.kind === "Identifier"
            ? specifier.imported.name
            : specifier.imported.value;
        const next = mapping.get(importedName);
        if (next === undefined) {
          continue;
        }
        if (specifier.imported.kind === "StringLiteral") {
          add({ start: specifier.imported.start, end: specifier.imported.end, text: next });
          continue;
        }
        if (
          specifier.local.start === specifier.imported.start &&
          specifier.local.end === specifier.imported.end
        ) {
          // The local binding is the imported name; the local rename below
          // updates this specifier and every use together.
          renamedImportLocals.add(specifier.local.name);
        } else {
          add({ start: specifier.imported.start, end: specifier.imported.end, text: next });
        }
      }
      continue;
    }
    if (statement.kind === "ImportEqualsDeclaration") {
      const specifier = directRequireSpecifier(statement.moduleReference);
      if (specifier === null) {
        // Not a direct `require("./relative")`: it may alias another namespace
        // or a transformed value. Follow it only far enough to fail when it
        // would otherwise leave a renamed member reference stale.
        unsupportedImportEquals.push({ local: statement.name.name, start: statement.start });
      } else if (sourceMatchesTarget(specifier)) {
        namespaceLocals.add(statement.name.name);
      }
      continue;
    }
    if (statement.kind === "ExportNamedDeclaration" && statement.source !== null) {
      if (!sourceMatchesTarget(statement.source.value)) {
        continue;
      }
      for (const specifier of statement.specifiers) {
        const localName =
          specifier.local.kind === "Identifier" ? specifier.local.name : specifier.local.value;
        const next = mapping.get(localName);
        if (next === undefined) {
          continue;
        }
        // Re-exports only change the source-side specifier; an alias stays.
        add({ start: specifier.local.start, end: specifier.local.end, text: next });
      }
    }
  }

  for (const local of renamedImportLocals) {
    const next = mapping.get(local);
    if (next === undefined) {
      continue;
    }
    const renamed = resolveLocalRename(
      source,
      importerPath,
      { path: importerPath, name: local, kind: "import" },
      { from: local, to: next },
    );
    if (!renamed.ok) {
      return {
        edits: [],
        diagnostics: `cannot rename imported binding \`${local}\` in ${importerPath}: ${renamed.diagnostics}`,
      };
    }
    for (const edit of renamed.edits) {
      add(edit);
    }
  }

  const importLocal = renamedImportLocals.has(rename.from) ? rename.from : null;
  const entries = exportState(
    program,
    rename.from,
    rename.to,
    null,
    importLocal,
    sourceMatchesTarget,
  );
  if (hasExportCollision(entries, rename.to)) {
    return {
      edits: [],
      diagnostics:
        `cannot rename \`${rename.from}\` to \`${rename.to}\` in ${importerPath}: collision; ` +
        `the module would export \`${rename.to}\` more than once after updating its import/re-export from ${targetPath}`,
    };
  }

  for (const local of namespaceLocals) {
    const scan = scanNamespaceMemberEdits(program, importerPath, local, rename);
    if (scan.diagnostics !== null) {
      return {
        edits: [],
        diagnostics: `cannot rename \`${rename.from}\` to \`${rename.to}\` in ${importerPath}: ${scan.diagnostics}`,
      };
    }
    const unsupported = scan.unsupported[0];
    if (unsupported !== undefined) {
      return {
        edits: [],
        diagnostics: memberDiagnostic(
          source,
          importerPath,
          rename,
          unsupported.start,
          unsupported.message,
        ),
      };
    }
    for (const edit of scan.edits) {
      add(edit);
    }
  }

  for (const entry of unsupportedImportEquals) {
    const scan = scanNamespaceMemberEdits(program, importerPath, entry.local, rename);
    if (scan.diagnostics !== null) {
      return {
        edits: [],
        diagnostics: `cannot rename \`${rename.from}\` to \`${rename.to}\` in ${importerPath}: ${scan.diagnostics}`,
      };
    }
    const unsupported = scan.unsupported[0];
    const edit = scan.edits[0];
    if (unsupported === undefined && edit === undefined) {
      // No reference to the renamed member through this local; leave the
      // declaration alone.
      continue;
    }
    const declarationLine = sourceLineAt(source, entry.start).text.trim();
    return {
      edits: [],
      diagnostics: memberDiagnostic(
        source,
        importerPath,
        rename,
        unsupported?.start ?? edit?.start ?? entry.start,
        `unsupported \`import =\` declaration for \`${entry.local}\` (${declarationLine}) ` +
          `is not a direct relative \`require(...)\`; refusing to leave ` +
          `\`${entry.local}.${rename.from}\` stale`,
      ),
    };
  }

  return { edits: [...edits.values()], diagnostics: null };
}

/**
 * Resolve a rename against its declaration file and, when the target is a
 * top-level unqualified declaration, against the named import/re-export edges
 * of every workspace file that resolves back to that declaration.
 *
 * Relative module specifiers are resolved through the supplied `fileExists` and
 * `isSafePath` callbacks. Named imports/re-exports, namespace-import member
 * accesses, and direct relative `import = require` member accesses are followed;
 * path aliases, default/dynamic imports, barrel/re-export chains, computed or
 * dynamic member access, destructuring that reads the renamed member, and
 * non-direct `import =` shapes are out of scope and fail rather than silently
 * leaving a stale reference.
 */
export function resolveWorkspaceRename(
  source: string,
  fileName: string,
  locator: Locator,
  rename: { from: string; to: string },
  deps: WorkspaceRenameDeps,
  options: RenameOptions = {},
): WorkspaceRenameResult {
  const local = resolveLocalRename(source, fileName, locator, rename, options);
  if (!local.ok) {
    return { ok: false, path: fileName, diagnostics: local.diagnostics };
  }
  const target = local.target;
  const localOnly = (): WorkspaceRenameResult => ({
    ok: true,
    target,
    files: [{ path: fileName, edits: local.edits }],
  });
  if (rename.from === rename.to || !target.topLevel) {
    return localOnly();
  }

  let program: Program;
  try {
    program = new Parser(source).parseProgram();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, path: fileName, diagnostics: `cannot parse ${fileName}: ${detail}` };
  }

  const entries = exportState(program, rename.from, rename.to, rename.from, rename.from, null);
  const mapping = new Map<string, string>();
  if (entries.some((entry) => entry.before === rename.from && entry.after === rename.to)) {
    mapping.set(rename.from, rename.to);
  }
  if (mapping.size === 0) {
    return localOnly();
  }
  if (hasExportCollision(entries, rename.to)) {
    return {
      ok: false,
      path: fileName,
      diagnostics:
        `cannot rename \`${rename.from}\` to \`${rename.to}\` in ${fileName}: collision; ` +
        `the module already exports \`${rename.to}\` from another declaration or specifier`,
    };
  }

  const files = new Map<string, RenameEdit[]>();
  files.set(fileName, local.edits);
  const paths = [...new Set(deps.listFiles())].sort();
  for (const path of paths) {
    if (path === fileName || files.has(path)) {
      continue;
    }
    if (!deps.isSafePath(path) || !deps.fileExists(path)) {
      continue;
    }
    let importerSource: string;
    try {
      importerSource = deps.sourceFor(path);
    } catch {
      continue;
    }
    const scan = scanImporter(importerSource, path, fileName, mapping, rename, deps);
    if (scan.diagnostics !== null) {
      return { ok: false, path, diagnostics: scan.diagnostics };
    }
    if (scan.edits.length > 0) {
      files.set(path, scan.edits);
    }
  }

  return {
    ok: true,
    target,
    files: [...files].map(([path, edits]) => ({ path, edits })),
  };
}
