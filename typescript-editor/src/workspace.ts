import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";

/**
 * A workspace-backed filesystem view for the edit-dsl API. Every operation is
 * confined to `root` (a resolved real path) and rejects paths that are unsafe
 * to read or write, including symlink escapes through any existing ancestor.
 */
export interface Workspace {
  /** The resolved real path of the workspace root. */
  readonly root: string;
  isSafePath(path: string): boolean;
  fileExists(path: string): boolean;
  sourceFor(path: string): string;
  writeFile(path: string, source: string): void;
  createEmptyFile(path: string): void;
  deleteFile(path: string): void;
}

/** The workspace-relative prefixes that are read-only unless overridden. */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = ["human"];

const NODE_MODULES = "node_modules";

function normalizeProtected(value: string): string | null {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized === "" ? null : normalized;
}

function withinRoot(root: string, target: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(prefix);
}

/**
 * Resolve the deepest existing ancestor of `target` (including `target` itself
 * when it exists as a file, directory, or symlink) and return its real path.
 * Null means the ancestor is a broken symlink or cannot be resolved, which is
 * always treated as unsafe.
 */
function existingAncestorRealpath(target: string): string | null {
  let current = target;
  for (;;) {
    let entry;
    try {
      entry = lstatSync(current, { throwIfNoEntry: false });
    } catch {
      return null;
    }
    if (entry !== undefined) {
      try {
        return realpathSync(current);
      } catch {
        return null;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Create a workspace rooted at `cwd`. Throws when `cwd` is missing, cannot be
 * resolved, or is not a directory.
 */
export function createWorkspace(options: {
  cwd: string;
  protectedPaths?: readonly string[];
}): Workspace {
  const requested = resolve(options.cwd);
  let root: string;
  try {
    root = realpathSync(requested);
  } catch {
    throw new Error(`workspace root does not exist: ${JSON.stringify(options.cwd)}`);
  }
  let stats;
  try {
    stats = statSync(root);
  } catch {
    throw new Error(`workspace root is not accessible: ${JSON.stringify(options.cwd)}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`workspace root is not a directory: ${JSON.stringify(options.cwd)}`);
  }

  const protectedPaths = (options.protectedPaths ?? DEFAULT_PROTECTED_PATHS)
    .map(normalizeProtected)
    .filter((value): value is string => value !== null);

  const rejectReason = (path: string): string | null => {
    if (path === "") {
      return "the path is empty";
    }
    if (isAbsolute(path) || win32.isAbsolute(path)) {
      return "the path is absolute";
    }
    if (path.includes("\\")) {
      return "the path must use `/` separators";
    }
    const segments = path.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      return "the path has an empty, `.` or `..` segment";
    }
    const directories = segments.slice(0, -1);
    if (directories.some((segment) => segment.startsWith("."))) {
      return "the path enters a hidden directory";
    }
    if (segments.some((segment) => segment === NODE_MODULES)) {
      return "the path enters node_modules";
    }
    for (const protectedPath of protectedPaths) {
      if (path === protectedPath || path.startsWith(`${protectedPath}/`)) {
        return `the path is protected (${protectedPath})`;
      }
    }
    return null;
  };

  const targetFor = (path: string): string => join(root, path);

  const isSafePath = (path: string): boolean => {
    if (rejectReason(path) !== null) {
      return false;
    }
    const target = targetFor(path);
    if (!withinRoot(root, target)) {
      return false;
    }
    const real = existingAncestorRealpath(target);
    return real !== null && withinRoot(root, real);
  };

  const assertSafePath = (path: string): string => {
    const reason = rejectReason(path);
    if (reason !== null) {
      throw new Error(`unsafe path ${JSON.stringify(path)}: ${reason}`);
    }
    if (!isSafePath(path)) {
      throw new Error(`unsafe path ${JSON.stringify(path)}: it resolves outside the workspace`);
    }
    return targetFor(path);
  };

  const fileExists = (path: string): boolean => {
    if (!isSafePath(path)) {
      return false;
    }
    try {
      return statSync(targetFor(path), { throwIfNoEntry: false })?.isFile() === true;
    } catch {
      return false;
    }
  };

  const sourceFor = (path: string): string => {
    const target = assertSafePath(path);
    let stats;
    try {
      stats = statSync(target, { throwIfNoEntry: false });
    } catch (error) {
      throw new Error(
        `cannot inspect ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (stats === undefined) {
      return "";
    }
    if (!stats.isFile()) {
      throw new Error(`cannot read ${JSON.stringify(path)}: it is not a regular file`);
    }
    try {
      return readFileSync(target, "utf8");
    } catch (error) {
      throw new Error(
        `cannot read ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const writeFile = (path: string, source: string): void => {
    const target = assertSafePath(path);
    const stats = statSync(target, { throwIfNoEntry: false });
    if (stats !== undefined && !stats.isFile()) {
      throw new Error(`cannot write ${JSON.stringify(path)}: it is not a regular file`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  };

  const createEmptyFile = (path: string): void => {
    const target = assertSafePath(path);
    const stats = statSync(target, { throwIfNoEntry: false });
    if (stats !== undefined) {
      throw new Error(`cannot create ${JSON.stringify(path)}: the path already exists`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "");
  };

  const deleteFile = (path: string): void => {
    const target = assertSafePath(path);
    let stats;
    try {
      stats = statSync(target, { throwIfNoEntry: false });
    } catch (error) {
      throw new Error(
        `cannot inspect ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (stats === undefined) {
      throw new Error(`cannot delete ${JSON.stringify(path)}: the file does not exist`);
    }
    if (!stats.isFile()) {
      throw new Error(`cannot delete ${JSON.stringify(path)}: it is not a regular file`);
    }
    unlinkSync(target);
  };

  return { root, isSafePath, fileExists, sourceFor, writeFile, createEmptyFile, deleteFile };
}
