import { posix } from "node:path";
import { Parser } from "./parser";
import type {
  BindingName,
  ExportAllDeclaration,
  ExportNamedDeclaration,
  Expression,
  Identifier,
  Program,
  Statement,
  StringLiteral,
} from "./parser";
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
const TS_CONFIG_PATH = "tsconfig.json";

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

function nodeName(node: Identifier | StringLiteral): string {
  return node.kind === "Identifier" ? node.name : node.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip `//` and block comments without touching string contents. */
function stripJsonComments(source: string): string {
  let output = "";
  let index = 0;
  let inString = false;
  while (index < source.length) {
    const character = source[index];
    if (character === undefined) {
      break;
    }
    if (inString) {
      output += character;
      if (character === "\\") {
        const next = source[index + 1];
        if (next !== undefined) {
          output += next;
          index += 2;
          continue;
        }
      } else if (character === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/** Remove trailing commas before `}`/`]` without touching string contents. */
function stripTrailingCommas(source: string): string {
  let output = "";
  let index = 0;
  let inString = false;
  while (index < source.length) {
    const character = source[index];
    if (character === undefined) {
      break;
    }
    if (inString) {
      output += character;
      if (character === "\\") {
        const next = source[index + 1];
        if (next !== undefined) {
          output += next;
          index += 2;
          continue;
        }
      } else if (character === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (lookahead < source.length) {
        const next = source[lookahead];
        if (next === " " || next === "\t" || next === "\n" || next === "\r") {
          lookahead += 1;
          continue;
        }
        break;
      }
      const next = source[lookahead];
      if (next === "}" || next === "]") {
        index += 1;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
}

interface AliasPattern {
  /** Pattern text before `*`; the entire pattern for an exact entry. */
  prefix: string;
  /** Pattern text after `*`, or null for an exact entry. */
  suffix: string | null;
  replacements: readonly string[];
}

interface ModuleConfig {
  /** Workspace-relative `baseUrl`, with `""` meaning the workspace root. */
  baseUrl: string;
  /** Whether the config explicitly supplies `compilerOptions.baseUrl`. */
  hasBaseUrl: boolean;
  paths: readonly AliasPattern[];
}

/** Effective `baseUrl`/`paths` contributed by one config file. */
interface ConfigOptions {
  /** Workspace-relative `baseUrl`, or null when no config declares one. */
  baseUrl: string | null;
  /** A declared `baseUrl` normalized outside the workspace. */
  invalidBaseUrl: boolean;
  /** The last declared `paths` object, or null when none declares one. */
  paths: readonly AliasPattern[] | null;
}

const EMPTY_CONFIG_OPTIONS: ConfigOptions = {
  baseUrl: null,
  invalidBaseUrl: false,
  paths: null,
};

type ModuleResolution =
  | { kind: "resolved"; path: string }
  | { kind: "package" }
  | { kind: "missing"; specifier: string; alias: boolean }
  | { kind: "ambiguous"; specifier: string; candidates: readonly string[] };

/** Normalize a workspace-relative path, rejecting escapes and absolutes. */
function normalizeWorkspacePath(value: string): string | null {
  const normalized = posix.normalize(value.replace(/\\/g, "/"));
  if (posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized === "." ? "" : normalized;
}

/** Resolve a config-file-relative value into a workspace-relative path. */
function resolveConfigRelative(configPath: string, value: string): string | null {
  const normalizedValue = value.replace(/\\/g, "/");
  if (posix.isAbsolute(normalizedValue)) {
    return null;
  }
  const directory = posix.dirname(configPath);
  const joined = directory === "." ? normalizedValue : posix.join(directory, normalizedValue);
  return normalizeWorkspacePath(joined);
}

/**
 * Resolve a local relative `extends` entry to an existing config file. Package
 * names (and other non-relative entries) are not resolved from `node_modules`.
 */
function resolveExtendsPath(
  specifier: string,
  configPath: string,
  deps: Pick<WorkspaceRenameDeps, "fileExists" | "isSafePath">,
): string | null {
  const normalized = specifier.replace(/\\/g, "/");
  if (!normalized.startsWith("./") && !normalized.startsWith("../")) {
    return null;
  }
  const base = resolveConfigRelative(configPath, normalized);
  if (base === null || base === "") {
    return null;
  }
  const candidates = base.endsWith(".json") ? [base] : [base, `${base}.json`];
  for (const candidate of candidates) {
    if (deps.isSafePath(candidate) && deps.fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Merge one config's contribution over its already-merged parents. */
function mergeConfigOptions(base: ConfigOptions, override: ConfigOptions): ConfigOptions {
  const declaresBaseUrl = override.baseUrl !== null || override.invalidBaseUrl;
  return {
    baseUrl: declaresBaseUrl ? override.baseUrl : base.baseUrl,
    invalidBaseUrl: declaresBaseUrl ? override.invalidBaseUrl : base.invalidBaseUrl,
    paths: override.paths ?? base.paths,
  };
}

interface ConfigChain {
  options: ConfigOptions;
  /** The config file itself could not be read or parsed. */
  unreadable: boolean;
}

/**
 * Read one config file plus its local relative `extends` chain. Parents merge in
 * declaration order, later parents win over earlier ones, and the child's own
 * `compilerOptions` wins over every parent. A config already on the current
 * chain contributes nothing, so cycles terminate.
 */
function readConfigChain(
  configPath: string,
  deps: Pick<WorkspaceRenameDeps, "fileExists" | "isSafePath" | "sourceFor">,
  visited: Set<string>,
): ConfigChain {
  if (visited.has(configPath)) {
    return { options: EMPTY_CONFIG_OPTIONS, unreadable: false };
  }
  visited.add(configPath);
  try {
    if (!deps.isSafePath(configPath) || !deps.fileExists(configPath)) {
      return { options: EMPTY_CONFIG_OPTIONS, unreadable: true };
    }
    let parsed: unknown;
    try {
      const raw = deps.sourceFor(configPath).replace(/^\uFEFF/, "");
      parsed = JSON.parse(stripTrailingCommas(stripJsonComments(raw)));
    } catch {
      return { options: EMPTY_CONFIG_OPTIONS, unreadable: true };
    }
    if (!isRecord(parsed)) {
      return { options: EMPTY_CONFIG_OPTIONS, unreadable: true };
    }
    let options = EMPTY_CONFIG_OPTIONS;
    const extendsValue = parsed["extends"];
    const parents =
      typeof extendsValue === "string"
        ? [extendsValue]
        : Array.isArray(extendsValue)
          ? extendsValue.filter((entry): entry is string => typeof entry === "string")
          : [];
    for (const parentSpecifier of parents) {
      const parentPath = resolveExtendsPath(parentSpecifier, configPath, deps);
      if (parentPath === null) {
        continue;
      }
      const parent = readConfigChain(parentPath, deps, visited);
      if (!parent.unreadable) {
        options = mergeConfigOptions(options, parent.options);
      }
    }
    const compilerOptions = parsed["compilerOptions"];
    if (isRecord(compilerOptions)) {
      const own: ConfigOptions = { baseUrl: null, invalidBaseUrl: false, paths: null };
      const baseUrlValue = compilerOptions["baseUrl"];
      if (typeof baseUrlValue === "string") {
        const resolved = resolveConfigRelative(configPath, baseUrlValue);
        if (resolved === null) {
          own.invalidBaseUrl = true;
        } else {
          own.baseUrl = resolved;
        }
      }
      if (Object.prototype.hasOwnProperty.call(compilerOptions, "paths")) {
        own.paths = parseAliasPatterns(compilerOptions["paths"]);
      }
      options = mergeConfigOptions(options, own);
    }
    return { options, unreadable: false };
  } finally {
    visited.delete(configPath);
  }
}

function parseAliasPatterns(value: unknown): AliasPattern[] {
  if (!isRecord(value)) {
    return [];
  }
  const patterns: AliasPattern[] = [];
  for (const [pattern, replacementsValue] of Object.entries(value)) {
    if (pattern === "" || !Array.isArray(replacementsValue)) {
      continue;
    }
    const replacements = replacementsValue.filter(
      (replacement): replacement is string => typeof replacement === "string",
    );
    if (replacements.length === 0) {
      continue;
    }
    const star = pattern.indexOf("*");
    if (star !== -1 && star !== pattern.lastIndexOf("*")) {
      continue;
    }
    patterns.push({
      prefix: star === -1 ? pattern : pattern.slice(0, star),
      suffix: star === -1 ? null : pattern.slice(star + 1),
      replacements,
    });
  }
  return patterns;
}

/**
 * Read the workspace-root `tsconfig.json` `baseUrl`/`paths` mapping, following
 * local relative `extends` chains (string or array). A missing or malformed root
 * config falls back to relative-only resolution; missing/malformed parents and
 * package-name `extends` entries are skipped.
 */
function readModuleConfig(
  deps: Pick<WorkspaceRenameDeps, "fileExists" | "isSafePath" | "sourceFor">,
): ModuleConfig | null {
  try {
    const chain = readConfigChain(TS_CONFIG_PATH, deps, new Set<string>());
    if (chain.unreadable || chain.options.invalidBaseUrl) {
      return null;
    }
    return {
      baseUrl: chain.options.baseUrl ?? "",
      hasBaseUrl: chain.options.baseUrl !== null,
      paths: chain.options.paths ?? [],
    };
  } catch {
    return null;
  }
}

function moduleCandidates(base: string): string[] {
  if (MODULE_EXTENSION.test(base)) {
    return [base];
  }
  // TypeScript's NodeNext resolution maps a `./x.js` specifier to `x.ts`,
  // and extensionless specifiers to the usual TS extensions.
  const stem = base.replace(JS_EXTENSION, "");
  const candidates: string[] = [];
  for (const extension of CANDIDATE_EXTENSIONS) {
    candidates.push(`${stem}${extension}`);
  }
  candidates.push(`${stem}/index.ts`, `${stem}/index.tsx`);
  return candidates;
}

function firstExistingModule(
  base: string,
  deps: Pick<WorkspaceRenameDeps, "fileExists" | "isSafePath">,
): string | null {
  for (const candidate of moduleCandidates(base)) {
    if (deps.isSafePath(candidate) && deps.fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Join a workspace-relative base and a specifier, rejecting escapes. */
function joinWorkspacePath(base: string, specifier: string): string | null {
  const normalizedSpecifier = specifier.replace(/\\/g, "/");
  if (posix.isAbsolute(normalizedSpecifier)) {
    return null;
  }
  const joined = posix.normalize(posix.join(base === "" ? "." : base, normalizedSpecifier));
  if (posix.isAbsolute(joined) || joined === ".." || joined.startsWith("../")) {
    return null;
  }
  return joined === "." ? "" : joined;
}

interface AliasMatch {
  pattern: AliasPattern;
  /** The `*` capture, or null for an exact pattern. */
  capture: string | null;
}

function aliasPatternBeats(candidate: AliasPattern, current: AliasPattern): boolean {
  if (candidate.prefix.length !== current.prefix.length) {
    return candidate.prefix.length > current.prefix.length;
  }
  const candidateSuffix = candidate.suffix?.length ?? 0;
  const currentSuffix = current.suffix?.length ?? 0;
  if (candidateSuffix !== currentSuffix) {
    return candidateSuffix > currentSuffix;
  }
  return candidate.prefix.length + candidateSuffix > current.prefix.length + currentSuffix;
}

function matchAlias(patterns: readonly AliasPattern[], specifier: string): AliasMatch | null {
  for (const pattern of patterns) {
    if (pattern.suffix === null && specifier === pattern.prefix) {
      return { pattern, capture: null };
    }
  }
  let best: AliasMatch | null = null;
  for (const pattern of patterns) {
    const suffix = pattern.suffix;
    if (suffix === null) {
      continue;
    }
    if (!specifier.startsWith(pattern.prefix) || !specifier.endsWith(suffix)) {
      continue;
    }
    if (specifier.length < pattern.prefix.length + suffix.length) {
      continue;
    }
    const capture = specifier.slice(pattern.prefix.length, specifier.length - suffix.length);
    if (best === null || aliasPatternBeats(pattern, best.pattern)) {
      best = { pattern, capture };
    }
  }
  return best;
}

function substituteAlias(replacement: string, capture: string | null): string {
  if (capture === null) {
    return replacement;
  }
  return replacement.split("*").join(capture);
}

class WorkspaceModuleResolver {
  private readonly config: ModuleConfig | null;

  constructor(private readonly deps: WorkspaceRenameDeps) {
    this.config = readModuleConfig(deps);
  }

  resolve(importerPath: string, specifier: string): ModuleResolution {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const base = joinWorkspacePath(posix.dirname(importerPath), specifier);
      const path = base === null ? null : firstExistingModule(base, this.deps);
      if (path !== null) {
        return { kind: "resolved", path };
      }
      return { kind: "missing", specifier, alias: false };
    }
    const config = this.config;
    if (config !== null) {
      const match = matchAlias(config.paths, specifier);
      if (match !== null) {
        const files = new Set<string>();
        for (const replacement of match.pattern.replacements) {
          const substituted = substituteAlias(replacement, match.capture);
          const base = joinWorkspacePath(config.baseUrl, substituted);
          if (base === null) {
            continue;
          }
          const path = firstExistingModule(base, this.deps);
          if (path !== null) {
            files.add(path);
          }
        }
        if (files.size === 1) {
          const path = [...files][0];
          if (path !== undefined) {
            return { kind: "resolved", path };
          }
        }
        if (files.size > 1) {
          return { kind: "ambiguous", specifier, candidates: [...files].sort() };
        }
        return { kind: "missing", specifier, alias: true };
      }
      // TypeScript falls back to `baseUrl` for bare specifiers that no `paths`
      // pattern matched. A miss is still an ordinary package import. Without an
      // explicit `baseUrl`, a bare specifier is never workspace-root relative.
      if (config.hasBaseUrl) {
        const base = joinWorkspacePath(config.baseUrl, specifier);
        if (base !== null) {
          const path = firstExistingModule(base, this.deps);
          if (path !== null) {
            return { kind: "resolved", path };
          }
        }
      }
    }
    return { kind: "package" };
  }
}

/** What a module's public name becomes when the target's export is renamed. */
type ExportOrigin = "target" | "other" | "none" | OriginProblem;

interface OriginProblem {
  kind: "ambiguous" | "unresolved";
  detail: string;
}

interface ExportEdge {
  /** Source specifier, or null for a local export/declaration. */
  specifier: string | null;
  origin: ExportOrigin;
}

interface ParsedModule {
  source: string;
  program: Program;
}

function isOriginProblem(origin: ExportOrigin): origin is OriginProblem {
  return typeof origin === "object";
}

function originProblem(kind: "ambiguous" | "unresolved", detail: string): OriginProblem {
  return { kind, detail };
}

function resolutionDetail(
  modulePath: string,
  specifier: string,
  resolution: ModuleResolution,
): string {
  if (resolution.kind === "ambiguous") {
    return (
      `module ${JSON.stringify(specifier)} in ${modulePath} is ambiguous; ` +
      `it matches ${resolution.candidates.map((candidate) => JSON.stringify(candidate)).join(", ")}`
    );
  }
  if (resolution.kind === "missing") {
    return (
      `module ${JSON.stringify(specifier)} in ${modulePath} ` +
      (resolution.alias
        ? "matches a tsconfig `paths` alias but does not resolve to a workspace file"
        : "does not resolve to a workspace file")
    );
  }
  return `module ${JSON.stringify(specifier)} in ${modulePath} could not be resolved`;
}

function sourceResolutionDetail(
  modulePath: string,
  source: string,
  literal: StringLiteral,
  resolution: ModuleResolution,
): string {
  const location = sourceLineAt(source, literal.start);
  return (
    `${resolutionDetail(modulePath, literal.value, resolution)} ` +
    `(at ${location.line}:${location.column})`
  );
}

function ambiguousExportProblem(
  modulePath: string,
  publicName: string,
  edges: readonly ExportEdge[],
): OriginProblem {
  const sources = [
    ...new Set(
      edges
        .map((edge) => edge.specifier)
        .filter((specifier): specifier is string => specifier !== null)
        .map((specifier) => JSON.stringify(specifier)),
    ),
  ];
  return originProblem(
    "ambiguous",
    `\`${publicName}\` is re-exported ambiguously from ${modulePath} through ` +
      `${sources.length === 0 ? "local exports" : sources.join(", ")}; ` +
      `the sources disagree about whether it is the renamed declaration`,
  );
}

function combineExplicit(
  modulePath: string,
  publicName: string,
  edges: readonly ExportEdge[],
): ExportOrigin {
  let target = false;
  let other = false;
  let unresolved: OriginProblem | null = null;
  let ambiguous: OriginProblem | null = null;
  for (const edge of edges) {
    if (edge.origin === "target") {
      target = true;
    } else if (edge.origin === "other" || edge.origin === "none") {
      other = true;
    } else if (edge.origin.kind === "unresolved") {
      unresolved ??= edge.origin;
    } else {
      ambiguous ??= edge.origin;
    }
  }
  if (unresolved !== null) {
    return unresolved;
  }
  if (ambiguous !== null) {
    return ambiguous;
  }
  if (target && other) {
    return ambiguousExportProblem(modulePath, publicName, edges);
  }
  return target ? "target" : "other";
}

function combineStars(
  modulePath: string,
  publicName: string,
  edges: readonly ExportEdge[],
): ExportOrigin {
  let target = false;
  let other = false;
  let unresolved: OriginProblem | null = null;
  let ambiguous: OriginProblem | null = null;
  for (const edge of edges) {
    if (edge.origin === "target") {
      target = true;
    } else if (edge.origin === "other") {
      other = true;
    } else if (edge.origin === "none") {
      // A cycle re-entry contributes nothing.
    } else if (edge.origin.kind === "unresolved") {
      unresolved ??= edge.origin;
    } else {
      ambiguous ??= edge.origin;
    }
  }
  if (unresolved !== null) {
    return unresolved;
  }
  if (ambiguous !== null) {
    return ambiguous;
  }
  if (target && other) {
    return ambiguousExportProblem(modulePath, publicName, edges);
  }
  if (target) {
    return "target";
  }
  return other ? "other" : "none";
}

class WorkspaceRenameGraph {
  private readonly resolver: WorkspaceModuleResolver;
  private readonly modules = new Map<string, ParsedModule | null>();

  constructor(
    private readonly deps: WorkspaceRenameDeps,
    private readonly targetPath: string,
    private readonly rename: { from: string; to: string },
  ) {
    this.resolver = new WorkspaceModuleResolver(deps);
  }

  resolveModule(importerPath: string, specifier: string): ModuleResolution {
    return this.resolver.resolve(importerPath, specifier);
  }

  targetFile(): string {
    return this.targetPath;
  }

  /** Origin for a source literal in `modulePath`, with a fresh cycle set. */
  originOfSource(
    modulePath: string,
    source: string,
    literal: StringLiteral,
    publicName: string,
  ): ExportOrigin {
    return this.sourceOrigin(modulePath, source, literal, publicName, new Set<string>());
  }

  /** Whether `modulePath` publicly exports `publicName` as the renamed name. */
  origin(modulePath: string, publicName: string): ExportOrigin {
    return this.originInto(modulePath, publicName, new Set<string>());
  }

  private moduleFor(path: string): ParsedModule | null {
    const cached = this.modules.get(path);
    if (cached !== undefined) {
      return cached;
    }
    if (!this.deps.isSafePath(path) || !this.deps.fileExists(path)) {
      this.modules.set(path, null);
      return null;
    }
    try {
      const source = this.deps.sourceFor(path);
      const parsed = { source, program: new Parser(source).parseProgram() };
      this.modules.set(path, parsed);
      return parsed;
    } catch {
      this.modules.set(path, null);
      return null;
    }
  }

  private sourceOrigin(
    modulePath: string,
    source: string,
    literal: StringLiteral,
    publicName: string,
    visited: Set<string>,
  ): ExportOrigin {
    const resolution = this.resolver.resolve(modulePath, literal.value);
    switch (resolution.kind) {
      case "package":
        return "other";
      case "resolved":
        return this.originInto(resolution.path, publicName, visited);
      case "missing":
        return originProblem(
          "unresolved",
          sourceResolutionDetail(modulePath, source, literal, resolution),
        );
      case "ambiguous":
        return originProblem(
          "ambiguous",
          sourceResolutionDetail(modulePath, source, literal, resolution),
        );
    }
  }

  private originInto(modulePath: string, publicName: string, visited: Set<string>): ExportOrigin {
    if (modulePath === this.targetPath) {
      return publicName === this.rename.from ? "target" : "other";
    }
    if (visited.has(modulePath)) {
      return "none";
    }
    visited.add(modulePath);
    try {
      const parsed = this.moduleFor(modulePath);
      if (parsed === null) {
        return originProblem(
          "unresolved",
          `cannot read or parse ${modulePath} while resolving \`${publicName}\``,
        );
      }
      const explicit: ExportEdge[] = [];
      const stars: ExportEdge[] = [];
      for (const statement of parsed.program.body) {
        if (statement.kind === "ExportNamedDeclaration") {
          this.collectNamedExport(
            modulePath,
            parsed.source,
            statement,
            publicName,
            visited,
            explicit,
          );
        } else if (statement.kind === "ExportAllDeclaration") {
          this.collectStarExport(
            modulePath,
            parsed.source,
            statement,
            publicName,
            visited,
            explicit,
            stars,
          );
        }
      }
      if (explicit.length > 0) {
        return combineExplicit(modulePath, publicName, explicit);
      }
      return combineStars(modulePath, publicName, stars);
    } finally {
      visited.delete(modulePath);
    }
  }

  private collectNamedExport(
    modulePath: string,
    source: string,
    statement: ExportNamedDeclaration,
    publicName: string,
    visited: Set<string>,
    out: ExportEdge[],
  ): void {
    if (statement.declaration !== null) {
      if (declaredNames(statement.declaration).includes(publicName)) {
        out.push({ specifier: null, origin: "other" });
      }
      return;
    }
    for (const specifier of statement.specifiers) {
      const localName = nodeName(specifier.local);
      const exportedName = specifier.exported === null ? localName : nodeName(specifier.exported);
      if (exportedName !== publicName) {
        continue;
      }
      // The rename engine preserves an explicit exported name (including a
      // same-spelling alias such as `export { helper as helper }`), so only a
      // shorthand entry changes its public name with the binding.
      const aliased = specifier.exported !== null;
      if (aliased) {
        // The public name is fixed, so renaming the source-side name cannot
        // change it; do not recurse or fail for this public name.
        out.push({ specifier: statement.source?.value ?? null, origin: "other" });
        continue;
      }
      if (statement.source === null) {
        out.push({
          specifier: null,
          origin: this.localExportOrigin(modulePath, source, localName, visited),
        });
      } else {
        out.push({
          specifier: statement.source.value,
          origin: this.sourceOrigin(modulePath, source, statement.source, localName, visited),
        });
      }
    }
  }

  /**
   * A local `export { helper }` follows a same-name named import, which the
   * importer rename rewrites together with the local export specifier. Aliased
   * imports, namespace/default/import-equals locals, and declarations stay
   * fixed.
   */
  private localExportOrigin(
    modulePath: string,
    source: string,
    localName: string,
    visited: Set<string>,
  ): ExportOrigin {
    if (localName !== this.rename.from) {
      return "other";
    }
    const parsed = this.moduleFor(modulePath);
    if (parsed === null) {
      return originProblem(
        "unresolved",
        `cannot read or parse ${modulePath} while resolving local export \`${localName}\``,
      );
    }
    const matches: ExportEdge[] = [];
    for (const statement of parsed.program.body) {
      if (statement.kind !== "ImportDeclaration") {
        continue;
      }
      for (const specifier of statement.namedImports) {
        if (specifier.local.name !== localName) {
          continue;
        }
        // Match scanImporter's span rule: only a truly unaliased named import
        // renames the local binding. `import { helper as helper }` changes the
        // imported name but keeps the local/public name `helper` fixed.
        if (specifier.imported.kind !== "Identifier") {
          continue;
        }
        if (
          specifier.imported.start !== specifier.local.start ||
          specifier.imported.end !== specifier.local.end
        ) {
          continue;
        }
        const importedName = specifier.imported.name;
        if (importedName !== this.rename.from) {
          continue;
        }
        matches.push({
          specifier: statement.source.value,
          origin: this.sourceOrigin(modulePath, source, statement.source, importedName, visited),
        });
      }
    }
    if (matches.length === 0) {
      return "other";
    }
    return combineExplicit(modulePath, localName, matches);
  }

  private collectStarExport(
    modulePath: string,
    source: string,
    statement: ExportAllDeclaration,
    publicName: string,
    visited: Set<string>,
    explicit: ExportEdge[],
    stars: ExportEdge[],
  ): void {
    if (statement.exported !== null) {
      // `export * as ns from "S"` only exports the namespace object under `ns`.
      if (statement.exported.name === publicName) {
        explicit.push({ specifier: statement.source.value, origin: "other" });
      }
      return;
    }
    stars.push({
      specifier: statement.source.value,
      origin: this.sourceOrigin(modulePath, source, statement.source, publicName, visited),
    });
  }
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
 * A re-export with a source only changes when its source-side name resolves to
 * the renamed target through the export-origin graph. `export *` is handled by
 * the origin graph and contributes no collision entries.
 */
function exportState(
  program: Program,
  from: string,
  to: string,
  declarationLocal: string | null,
  importLocal: string | null,
  isRenamedSource: ((specifier: string, localName: string) => boolean) | null,
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
      const localName = nodeName(specifier.local);
      const exportedName = specifier.exported === null ? null : nodeName(specifier.exported);
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
        const renamedSource =
          isRenamedSource !== null && isRenamedSource(statement.source.value, localName);
        if (renamedSource) {
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

function reExportKey(specifier: string, localName: string): string {
  return `${specifier}\u0000${localName}`;
}

function scanImporter(
  source: string,
  importerPath: string,
  mapping: ReadonlyMap<string, string>,
  rename: { from: string; to: string },
  graph: WorkspaceRenameGraph,
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
  const renamedReExports = new Set<string>();
  const unsupportedImportEquals: Array<{ local: string; start: number }> = [];
  const failure = (offset: number, message: string): ImporterScan => ({
    edits: [],
    diagnostics: memberDiagnostic(source, importerPath, rename, offset, message),
  });
  const originFailure = (offset: number, origin: OriginProblem): ImporterScan =>
    failure(offset, origin.detail);

  for (const statement of program.body) {
    if (statement.kind === "ImportDeclaration") {
      if (statement.namespaceImport !== null) {
        const origin = graph.originOfSource(importerPath, source, statement.source, rename.from);
        if (isOriginProblem(origin)) {
          return originFailure(statement.source.start, origin);
        }
        if (origin === "target") {
          namespaceLocals.add(statement.namespaceImport.name);
        }
      }
      for (const specifier of statement.namedImports) {
        const importedName = nodeName(specifier.imported);
        const next = mapping.get(importedName);
        if (next === undefined) {
          continue;
        }
        const origin = graph.originOfSource(importerPath, source, statement.source, importedName);
        if (isOriginProblem(origin)) {
          return originFailure(statement.source.start, origin);
        }
        if (origin !== "target") {
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
      } else {
        const resolution = graph.resolveModule(importerPath, specifier);
        if (resolution.kind === "package") {
          continue;
        }
        if (resolution.kind === "missing" || resolution.kind === "ambiguous") {
          return failure(statement.start, resolutionDetail(importerPath, specifier, resolution));
        }
        const origin = graph.origin(resolution.path, rename.from);
        if (isOriginProblem(origin)) {
          return originFailure(statement.start, origin);
        }
        if (origin === "target") {
          namespaceLocals.add(statement.name.name);
        }
      }
      continue;
    }
    if (statement.kind === "ExportNamedDeclaration" && statement.source !== null) {
      for (const specifier of statement.specifiers) {
        const localName = nodeName(specifier.local);
        const next = mapping.get(localName);
        if (next === undefined) {
          continue;
        }
        const origin = graph.originOfSource(importerPath, source, statement.source, localName);
        if (isOriginProblem(origin)) {
          return originFailure(statement.source.start, origin);
        }
        if (origin !== "target") {
          continue;
        }
        // Re-exports only change the source-side specifier; an alias stays.
        add({ start: specifier.local.start, end: specifier.local.end, text: next });
        renamedReExports.add(reExportKey(statement.source.value, localName));
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
    (specifier, localName) => renamedReExports.has(reExportKey(specifier, localName)),
  );
  if (hasExportCollision(entries, rename.to)) {
    return {
      edits: [],
      diagnostics:
        `cannot rename \`${rename.from}\` to \`${rename.to}\` in ${importerPath}: collision; ` +
        `the module would export \`${rename.to}\` more than once after updating its import/re-export from ${graph.targetFile()}`,
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
 * The workspace-root `tsconfig.json` `baseUrl`/`paths` mapping, including local
 * relative `extends` chains, resolves aliased specifiers as well as relative
 * ones. Named imports/re-exports, `export *` re-export chains,
 * namespace-import member accesses, and direct
 * `import = require` member accesses are followed cycle-safely; an ambiguous
 * alias, an unresolved relative/alias barrel edge, or conflicting star exports
 * fail at `address` rather than silently leaving a stale reference.
 * Default/dynamic imports, computed or dynamic member access, `export * as ns`
 * member propagation, destructuring that reads the renamed member, and
 * non-direct `import =` shapes remain out of scope and fail when they could
 * leave a stale reference.
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

  const graph = new WorkspaceRenameGraph(deps, fileName, rename);
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
    const scan = scanImporter(importerSource, path, mapping, rename, graph);
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
