#!/usr/bin/env bun
/**
 * issue-tracker — deterministic bookkeeping for the `issues/` tracker.
 *
 * Source of truth: every issue file's frontmatter. Derived artifacts:
 *   - issues/todo.yaml          open issues in picking order; wontfix at the bottom
 *   - the ```dot``` block in    issues/readme.md
 *
 * Commands: setup | check | list | add | set (see USAGE at the bottom).
 * The script never renumbers or deletes issues, never commits, and never
 * touches anything outside `issues/`. Machine interface: one JSON object on
 * stdout per invocation; exit code 1 on failure.
 *
 * Owned by the skills bundle: .opencode/skills (a standalone Bun project —
 * see which-skill/SKILL.md, "Shared tooling"). Used by file-issue and
 * resolve-issue.
 * Tests: cd .opencode/skills && bun test
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

// ------------------------------------------------------------------ constants

const STATUSES = ["todo", "in-progress", "review", "done", "wontfix"] as const;
type Status = (typeof STATUSES)[number];
const PRIORITIES = ["high", "medium", "low"] as const;
type Priority = (typeof PRIORITIES)[number];
const RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const FIELDS = [
  "id",
  "title",
  "status",
  "priority",
  "milestone",
  "parent",
  "deps",
  "labels",
  "created",
] as const;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type DirKind = "open" | "done";

interface Issue {
  id: number;
  title: string;
  status: Status;
  priority: Priority;
  milestone: string | null;
  parent: number | null;
  deps: number[];
  labels: string[];
  created: string;
  base: string; // file name, e.g. 0042-edit-protocol-v2.md
  dir: DirKind;
  text: string; // full raw file content
  body: string; // markdown after the frontmatter
}

interface LoadError {
  file: string;
  code: string;
  message: string;
}

interface Loaded {
  issues: Issue[];
  errors: LoadError[];
}

class TrackerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const isActive = (s: Status) => s === "todo" || s === "in-progress" || s === "review";
export const isDecided = (s: Status) => s === "done" || s === "wontfix";

// ------------------------------------------------------------------ fs helpers

const readText = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);

function writeText(p: string, text: string): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, "utf8");
}

const rel = (root: string, p: string): string => relative(root, p);
const issuePath = (root: string, i: { dir: DirKind; base: string }): string =>
  join(root, "issues", i.dir === "done" ? "done" : "", i.base);
const hasIssuesDir = (root: string): boolean => existsSync(join(root, "issues"));

/** Nearest ancestor with `issues/`; a git root without one is the creation
 * point (`setup`); else cwd. Stops at either boundary so nested worktrees do
 * not leak into an outer repo. */
export function findRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, "issues"))) return dir;
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}

// ---------------------------------------------------------------- frontmatter

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function splitFile(text: string): { fm: string; body: string } | null {
  const m = FM_RE.exec(text);
  if (!m || m.index !== 0) return null;
  return { fm: m[1] ?? "", body: text.slice(m[0].length) };
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

type Fields = Omit<Issue, "base" | "dir" | "text" | "body">;

function parseFrontmatter(fmText: string): { fm?: Fields; error?: string } {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(fmText);
  } catch (e) {
    return { error: `invalid YAML: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return { error: "frontmatter is not a mapping" };
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra.length) return { error: `unknown key(s): ${extra.join(", ")}` };
  if (!isInt(o.id) || o.id < 1) return { error: "id must be a positive integer" };
  if (typeof o.title !== "string" || !o.title.trim() || /[\r\n]/.test(o.title))
    return { error: "title must be a non-empty single line" };
  if (typeof o.status !== "string" || !(STATUSES as readonly string[]).includes(o.status))
    return { error: `status must be one of ${STATUSES.join(" | ")}` };
  if (typeof o.priority !== "string" || !(PRIORITIES as readonly string[]).includes(o.priority))
    return { error: `priority must be one of ${PRIORITIES.join(" | ")}` };
  if (o.milestone !== null && (typeof o.milestone !== "string" || o.milestone === ""))
    return { error: "milestone must be a non-empty string or null" };
  if (o.parent !== null && (!isInt(o.parent) || o.parent < 1))
    return { error: "parent must be a positive integer or null" };
  if (!Array.isArray(o.deps) || !o.deps.every((d) => isInt(d) && d > 0))
    return { error: "deps must be a list of ids" };
  if (!Array.isArray(o.labels) || !o.labels.every((l) => typeof l === "string" && LABEL_RE.test(l)))
    return { error: "labels must be a list of [A-Za-z0-9._-] tokens" };
  if (typeof o.created !== "string" || !DATE_RE.test(o.created))
    return { error: "created must be YYYY-MM-DD" };
  return {
    fm: {
      id: o.id,
      title: o.title,
      status: o.status as Status,
      priority: o.priority as Priority,
      milestone: o.milestone as string | null,
      parent: o.parent as number | null,
      deps: o.deps as number[],
      labels: o.labels as string[],
      created: o.created,
    },
  };
}

function loadState(root: string): Loaded {
  const errors: LoadError[] = [];
  const issues: Issue[] = [];
  const dirs: [DirKind, string][] = [
    ["open", join(root, "issues")],
    ["done", join(root, "issues", "done")],
  ];
  for (const [dirKind, dirPath] of dirs) {
    if (!existsSync(dirPath)) continue;
    for (const ent of readdirSync(dirPath, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
      if (dirKind === "open" && (ent.name === "readme.md" || ent.name === "TEMPLATE.md")) continue;
      const file = rel(root, join(dirPath, ent.name));
      const m = /^(\d{4,})-(.+)\.md$/.exec(ent.name);
      if (!m) {
        errors.push({
          file,
          code: "filename",
          message: `file name must be NNNN-slug.md, got ${ent.name}`,
        });
        continue;
      }
      const text = readFileSync(join(dirPath, ent.name), "utf8");
      const split = splitFile(text);
      if (!split) {
        errors.push({ file, code: "frontmatter", message: "missing --- frontmatter block" });
        continue;
      }
      const parsed = parseFrontmatter(split.fm);
      if (parsed.error || !parsed.fm) {
        errors.push({ file, code: "frontmatter", message: parsed.error ?? "invalid frontmatter" });
        continue;
      }
      if (!SLUG_RE.test(m[2] ?? ""))
        errors.push({ file, code: "filename", message: `slug must be kebab-case, got "${m[2]}"` });
      if (parsed.fm.id !== Number(m[1]))
        errors.push({
          file,
          code: "id",
          message: `frontmatter id ${parsed.fm.id} does not match file name`,
        });
      issues.push({ ...parsed.fm, base: ent.name, dir: dirKind, text, body: split.body });
    }
  }
  issues.sort((a, b) => a.id - b.id || a.base.localeCompare(b.base));
  return { issues, errors };
}

function index(state: Loaded): { byId: Map<number, Issue>; children: Map<number, number[]> } {
  const byId = new Map<number, Issue>();
  const children = new Map<number, number[]>();
  for (const i of state.issues) byId.set(i.id, i);
  for (const i of state.issues) {
    if (i.parent === null) continue;
    const list = children.get(i.parent) ?? [];
    list.push(i.id);
    children.set(i.parent, list);
  }
  return { byId, children };
}

// ---------------------------------------------------------------- derived data

interface Derived {
  order: number[];
  eligibleLeaves: number[];
  eligibleUmbrellas: number[];
  sets: { umbrella: number; members: number[] }[];
  blockers: {
    id: number;
    unmetDeps: { id: number; status: Status | "missing" }[];
    undecidedChildren: number[];
  }[];
}

/**
 * Picking order: repeatedly take the highest-priority available leaf (no
 * children, deps resolved); when no leaf is available, the available umbrella
 * (all children decided, deps resolved). A picked item counts as resolved.
 * wontfix is decided but never satisfies a dep, so dependent work stays out of
 * the order until adjudicated.
 */
function computeDerived(state: Loaded): Derived {
  const { byId, children } = index(state);
  const kids = (id: number) => children.get(id) ?? [];
  const picked = new Set<number>();
  const done = new Set(state.issues.filter((i) => i.status === "done").map((i) => i.id));
  const decided = new Set(state.issues.filter((i) => isDecided(i.status)).map((i) => i.id));
  const remaining = new Set(state.issues.filter((i) => isActive(i.status)).map((i) => i.id));
  const depOk = (id: number) => done.has(id) || picked.has(id);
  const byRank = (a: number, b: number) =>
    RANK[byId.get(a)!.priority] - RANK[byId.get(b)!.priority] || a - b;
  const order: number[] = [];
  for (;;) {
    const cands = [...remaining].map((id) => byId.get(id)!);
    const leaf = cands.filter((i) => kids(i.id).length === 0 && i.deps.every(depOk));
    const umb = cands.filter(
      (i) =>
        kids(i.id).length > 0 &&
        kids(i.id).every((c) => decided.has(c) || picked.has(c)) &&
        i.deps.every(depOk),
    );
    const pool = (leaf.length ? leaf : umb).sort((a, b) => byRank(a.id, b.id));
    const pick = pool[0];
    if (!pick) break;
    picked.add(pick.id);
    remaining.delete(pick.id);
    order.push(pick.id);
  }
  const pos = new Map(order.map((id, n) => [id, n]));
  const eligibleLeaves = state.issues
    .filter(
      (i) =>
        i.status === "todo" &&
        kids(i.id).length === 0 &&
        i.deps.every((d) => byId.get(d)?.status === "done"),
    )
    .map((i) => i.id)
    .sort(byRank);
  const eligibleUmbrellas = state.issues
    .filter(
      (i) =>
        i.status === "todo" &&
        kids(i.id).length > 0 &&
        kids(i.id).every((c) => isDecided(byId.get(c)!.status)) &&
        i.deps.every((d) => byId.get(d)?.status === "done"),
    )
    .map((i) => i.id)
    .sort(byRank);
  const descendants = (id: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>([id]);
    const walk = (n: number) => {
      for (const c of kids(n)) {
        if (seen.has(c)) continue;
        seen.add(c);
        out.push(c);
        walk(c);
      }
    };
    walk(id);
    return out;
  };
  const sets = state.issues
    .filter((i) => isActive(i.status) && kids(i.id).length > 0)
    .map((i) => ({
      umbrella: i.id,
      members: descendants(i.id).filter((d) => isActive(byId.get(d)!.status)),
    }))
    .filter((s) => s.members.length > 0)
    .map((s) => ({
      ...s,
      members: [...s.members].sort((a, b) => (pos.get(a) ?? 1e9) - (pos.get(b) ?? 1e9) || a - b),
    }))
    .sort(
      (a, b) =>
        (pos.get(a.members[0] ?? a.umbrella) ?? 1e9) -
          (pos.get(b.members[0] ?? b.umbrella) ?? 1e9) || a.umbrella - b.umbrella,
    );
  const blockers = state.issues
    .filter((i) => isActive(i.status))
    .map((i) => ({
      id: i.id,
      unmetDeps: i.deps
        .filter((d) => byId.get(d)?.status !== "done")
        .map((d) => ({ id: d, status: byId.get(d)?.status ?? ("missing" as const) })),
      undecidedChildren: kids(i.id).filter((c) => !isDecided(byId.get(c)!.status)),
    }))
    .filter((b) => b.unmetDeps.length > 0 || b.undecidedChildren.length > 0);
  return { order, eligibleLeaves, eligibleUmbrellas, sets, blockers };
}

// ---------------------------------------------------------------- rendering

const q = (s: string): string => JSON.stringify(s);
const plain = (s: string): string => (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) ? s : q(s));
const listYaml = <T>(items: T[], render: (x: T) => string): string =>
  `[${items.map(render).join(", ")}]`;
const depsYaml = (deps: number[]): string => listYaml(deps, String);

function fmLines(i: Fields): string[] {
  return [
    `id: ${i.id}`,
    `title: ${q(i.title)}`,
    `status: ${i.status}`,
    `priority: ${i.priority}`,
    `milestone: ${i.milestone === null ? "null" : plain(i.milestone)}`,
    `parent: ${i.parent === null ? "null" : i.parent}`,
    `deps: ${depsYaml(i.deps)}`,
    `labels: ${listYaml(i.labels, plain)}`,
    `created: ${i.created}`,
  ];
}

function renderIssueFile(i: Fields, body: string): string {
  return `---\n${fmLines(i).join("\n")}\n---\n\n${body}`;
}

const TODO_HEADER = [
  "# Open issues in picking order: repeatedly take the highest-priority available",
  "# leaf; once no leaf is available, the highest-priority available umbrella.",
  "# Available = deps done (an umbrella also needs all children done).",
  "# Tie-break by id.",
  "# wontfix entries stay listed (not pickable) at the bottom.",
];

function entryLines(i: Issue): string[] {
  return [
    `- id: ${i.id}`,
    `  title: ${q(i.title)}`,
    `  status: ${i.status}`,
    `  priority: ${i.priority}`,
    `  milestone: ${i.milestone === null ? "null" : plain(i.milestone)}`,
    `  parent: ${i.parent === null ? "null" : i.parent}`,
    `  deps: ${depsYaml(i.deps)}`,
    `  file: ${i.base}`,
  ];
}

/** Entries in canonical order: picking order over open items, then wontfix by id. */
function expectedEntries(state: Loaded, d: Derived): Issue[] {
  const byId = new Map(state.issues.map((i) => [i.id, i]));
  const ordered = d.order.map((id) => byId.get(id)!).filter(Boolean);
  const wontfix = state.issues.filter((i) => i.status === "wontfix").sort((a, b) => a.id - b.id);
  return [...ordered, ...wontfix];
}

function renderTodo(state: Loaded, d: Derived): string {
  const lines: string[] = [...TODO_HEADER];
  const entries = expectedEntries(state, d);
  const open = entries.filter((i) => i.status !== "wontfix");
  const wontfix = entries.filter((i) => i.status === "wontfix");
  if (open.length) lines.push("", ...open.flatMap(entryLines));
  if (wontfix.length)
    lines.push("", "# wontfix entries, kept for the record.", ...wontfix.flatMap(entryLines));
  return lines.join("\n") + "\n";
}

/** The generated ```dot block: nodes for every issue, solid parent edges, dashed dep edges. */
function renderDot(issues: Issue[]): string {
  const sorted = [...issues].sort((a, b) => a.id - b.id);
  const keys = sorted.map((i) => `"${i.id}"`);
  const width = keys.reduce((m, k) => Math.max(m, k.length), 0);
  const lines = [
    "digraph issues {",
    "  rankdir=LR;",
    '  node [shape=box, style=rounded, fontname="Helvetica"];',
  ];
  if (sorted.length) {
    lines.push("");
    sorted.forEach((i, n) =>
      lines.push(`  ${keys[n]!.padEnd(width)} [label=${q(`#${i.id} ${i.title}`)}];`),
    );
  }
  const tree = sorted
    .filter((i) => i.parent !== null)
    .map((i) => [i.parent!, i.id] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([p, c]) => `  "${p}" -> "${c}";`);
  const deps = sorted
    .flatMap((i) => i.deps.map((d) => [d, i.id] as const))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([d, i]) => `  "${d}" -> "${i}" [style=dashed, label="blocks"];`);
  lines.push(
    "",
    "  // tree edges (parent -> child), solid",
    ...tree,
    "",
    "  // dependency edges (blocker -> blocked), dashed",
    ...deps,
    "}",
  );
  return lines.join("\n") + "\n";
}

const README_HEAD =
  "# Issues\n\nIssue tree: structure only. Statuses, priorities, and picking order live in\n[`todo.yaml`](todo.yaml).\n\n";
const DOT_RE = /```dot\r?\n[\s\S]*?\n```/;
const DOT_BODY_RE = /```dot\r?\n([\s\S]*?)\n```/;

function renderReadme(current: string | null, dot: string): string {
  const block = "```dot\n" + dot + "```";
  if (current === null) return README_HEAD + block + "\n";
  if (DOT_RE.test(current)) return current.replace(DOT_RE, block);
  return current.replace(/\s*$/, "") + "\n\n" + block + "\n";
}

function renderDerived(root: string, state: Loaded): { created: string[]; repaired: string[] } {
  const created: string[] = [];
  const repaired: string[] = [];
  const d = computeDerived(state);
  const todoPath = join(root, "issues", "todo.yaml");
  const todo = renderTodo(state, d);
  const curTodo = readText(todoPath);
  if (curTodo === null) {
    writeText(todoPath, todo);
    created.push("issues/todo.yaml");
  } else if (curTodo !== todo) {
    writeText(todoPath, todo);
    repaired.push("issues/todo.yaml");
  }
  const readmePath = join(root, "issues", "readme.md");
  const curReadme = readText(readmePath);
  const nextReadme = renderReadme(curReadme, renderDot(state.issues));
  if (curReadme === null) {
    writeText(readmePath, nextReadme);
    created.push("issues/readme.md");
  } else if (curReadme !== nextReadme) {
    writeText(readmePath, nextReadme);
    repaired.push("issues/readme.md");
  }
  return { created, repaired };
}

// ------------------------------------------------------------------ links

const LINK_RE = /(!?\[[^\]]*\]\()([^)\s]+)(\))/g;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function isRelativeTarget(t: string): boolean {
  return !SCHEME_RE.test(t) && !t.startsWith("#") && !t.startsWith("/") && !t.startsWith("<");
}

function splitTarget(target: string): { path: string; hash: string } {
  const hash = target.indexOf("#");
  return hash >= 0
    ? { path: target.slice(0, hash), hash: target.slice(hash) }
    : { path: target, hash: "" };
}

export function linkTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LINK_RE)) out.push(m[2] ?? "");
  return out;
}

/** Re-express every relative link in `text` from `fromDir` to `toDir`. */
export function rebaseLinks(text: string, fromDir: string, toDir: string): string {
  return text.replace(LINK_RE, (whole, pre: string, target: string, post: string) => {
    if (!isRelativeTarget(target)) return whole;
    const { path, hash } = splitTarget(target);
    if (!path) return whole;
    return pre + relative(toDir, resolve(fromDir, path)) + hash + post;
  });
}

/** Re-point only the links that resolved to `oldAbs`, so they resolve to `newAbs`. */
export function retargetLinks(
  text: string,
  fromDir: string,
  oldAbs: string,
  newAbs: string,
): string {
  return text.replace(LINK_RE, (whole, pre: string, target: string, post: string) => {
    if (!isRelativeTarget(target)) return whole;
    const { path, hash } = splitTarget(target);
    if (!path || resolve(fromDir, path) !== oldAbs) return whole;
    return pre + relative(fromDir, newAbs) + hash + post;
  });
}

// ---------------------------------------------------------------- helpers

function assertHealthy(state: Loaded): void {
  if (state.errors.length) {
    const first = state.errors[0]!;
    throw new TrackerError(
      "invalid",
      `tracker has ${state.errors.length} file problem(s) (first: ${first.file}: ${first.message}); run check`,
    );
  }
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseIdList(v: string | undefined, flag: string): number[] {
  if (v === undefined || v === "" || v === "null") return [];
  const out: number[] = [];
  for (const part of v.split(",").map((s) => s.trim())) {
    if (!/^\d+$/.test(part) || Number(part) < 1)
      throw new TrackerError("flag", `--${flag}: expected comma-separated ids, got "${v}"`);
    const n = Number(part);
    if (out.includes(n)) throw new TrackerError("flag", `--${flag}: duplicate id #${n}`);
    out.push(n);
  }
  return out;
}

function parseOptId(v: string, flag: string): number | null {
  if (v === "" || v === "null") return null;
  if (!/^\d+$/.test(v) || Number(v) < 1)
    throw new TrackerError("flag", `--${flag}: expected an id or null, got "${v}"`);
  return Number(v);
}

function parseLabels(v: string | undefined): string[] {
  if (v === undefined || v === "" || v === "null") return [];
  const out = v.split(",").map((s) => s.trim());
  for (const l of out)
    if (!LABEL_RE.test(l)) throw new TrackerError("flag", `--labels: "${l}" is not a valid label`);
  if (new Set(out).size !== out.length) throw new TrackerError("flag", "--labels: duplicate label");
  return out;
}

function parsePriority(v: string, flag: string): Priority {
  if (!(PRIORITIES as readonly string[]).includes(v))
    throw new TrackerError("flag", `--${flag} must be ${PRIORITIES.join(" | ")}`);
  return v as Priority;
}

function parseMilestone(v: string | undefined): string | null {
  if (v === undefined || v === "" || v === "null") return null;
  const m = v.trim();
  if (!m || /[\r\n]/.test(m))
    throw new TrackerError("flag", "--milestone must be a non-empty single line or null");
  return m;
}

function hasSection(body: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}[ \\t]*$`, "m").test(body);
}

function sectionText(body: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${escaped}[ \\t]*$`, "m").exec(body);
  if (!m) return "";
  let rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  if (next >= 0) rest = rest.slice(0, next);
  return rest;
}

const notesText = (body: string): string => sectionText(body, "## Notes").trim();

function appendNote(body: string, note: string): string {
  let b = body.trimEnd();
  if (!/^## Notes[ \t]*$/m.test(b)) b += "\n\n## Notes";
  return `${b}\n${note}\n`;
}

/** Cycle over the deps graph; returns the cycle path (first id repeated) or null. */
function findDepsCycle(issues: Issue[]): number[] | null {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const color = new Map<number, 0 | 1 | 2>();
  const stack: number[] = [];
  let found: number[] | null = null;
  const dfs = (id: number): boolean => {
    color.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.deps ?? []) {
      if (!byId.has(d)) continue;
      const c = color.get(d) ?? 0;
      if (c === 1) {
        found = [...stack.slice(stack.indexOf(d)), d];
        return true;
      }
      if (c === 0 && dfs(d)) return true;
    }
    stack.pop();
    color.set(id, 2);
    return false;
  };
  for (const i of issues) if ((color.get(i.id) ?? 0) === 0 && dfs(i.id)) break;
  return found;
}

// ------------------------------------------------------------------ commands

function cmdSetup(root: string): Record<string, unknown> {
  mkdirSync(join(root, "issues", "done"), { recursive: true });
  const state = loadState(root);
  assertHealthy(state);
  const { created, repaired } = renderDerived(root, state);
  return { ok: true, created, repaired };
}

interface CheckError {
  code: string;
  message: string;
  id?: number;
  file?: string;
}

function todoDiff(got: string, state: Loaded, d: Derived): string {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(got);
  } catch {
    return "unparseable YAML";
  }
  if (!Array.isArray(parsed)) return "not a YAML list";
  const want = expectedEntries(state, d).map((i) => ({
    id: i.id,
    title: i.title,
    status: i.status,
    priority: i.priority,
    milestone: i.milestone,
    parent: i.parent,
    deps: i.deps,
    file: i.base,
  }));
  for (let n = 0; n < Math.max(parsed.length, want.length); n++) {
    const a = parsed[n] as Record<string, unknown> | undefined;
    const w = want[n];
    if (!w) return `extra entry ${JSON.stringify(a)}`;
    if (!a) return `missing entry #${w.id}`;
    for (const k of [
      "id",
      "title",
      "status",
      "priority",
      "milestone",
      "parent",
      "deps",
      "file",
    ] as const) {
      if (JSON.stringify(a[k] ?? null) !== JSON.stringify(w[k] ?? null))
        return `entry #${w.id} ${k}: expected ${JSON.stringify(w[k] ?? null)}, got ${JSON.stringify(a[k] ?? null)}`;
    }
  }
  return "formatting/comment drift";
}

function cmdCheck(root: string): Record<string, unknown> {
  const errors: CheckError[] = [];
  const warnings: CheckError[] = [];
  if (!hasIssuesDir(root))
    return {
      ok: false,
      errors: [{ code: "layout", message: "issues/ not found; run setup" }],
      warnings,
    };
  const state = loadState(root);
  for (const e of state.errors) errors.push({ code: e.code, message: e.message, file: e.file });
  if (state.errors.length) return { ok: false, errors, warnings };
  const { byId, children } = index(state);

  const seen = new Map<number, Issue>();
  for (const i of state.issues) {
    const prev = seen.get(i.id);
    if (prev)
      errors.push({
        code: "dup-id",
        id: i.id,
        message: `id #${i.id} used by both ${prev.dir}/${prev.base} and ${i.dir}/${i.base}`,
      });
    else seen.set(i.id, i);
  }

  for (const i of state.issues) {
    if (i.parent === i.id)
      errors.push({
        code: "ref",
        id: i.id,
        file: issuePath(root, i),
        message: `#${i.id} is its own parent`,
      });
    else if (i.parent !== null && !byId.has(i.parent))
      errors.push({
        code: "ref",
        id: i.id,
        file: issuePath(root, i),
        message: `parent #${i.parent} does not exist`,
      });
    const dups = i.deps.filter((d, n) => i.deps.indexOf(d) !== n);
    if (dups.length)
      errors.push({
        code: "ref",
        id: i.id,
        file: issuePath(root, i),
        message: `duplicate deps: ${dups.join(", ")}`,
      });
    for (const d of i.deps) {
      if (d === i.id)
        errors.push({
          code: "ref",
          id: i.id,
          file: issuePath(root, i),
          message: `dep #${d} is itself`,
        });
      else if (!byId.has(d))
        errors.push({
          code: "ref",
          id: i.id,
          file: issuePath(root, i),
          message: `dep #${d} does not exist`,
        });
    }
  }

  const parentCycles = new Set<string>();
  for (const i of state.issues) {
    const chain: number[] = [i.id];
    const on = new Set<number>([i.id]);
    let cur: Issue | undefined = i;
    while (cur && cur.parent !== null) {
      const p = byId.get(cur.parent);
      if (!p) break;
      if (on.has(p.id)) {
        const cyc = [...chain.slice(chain.indexOf(p.id)), p.id];
        const key = [...new Set(cyc)].sort((a, b) => a - b).join(",");
        if (!parentCycles.has(key)) {
          parentCycles.add(key);
          errors.push({ code: "cycle", message: `parent cycle: ${cyc.join(" -> ")}` });
        }
        break;
      }
      chain.push(p.id);
      on.add(p.id);
      cur = p;
    }
  }
  const depCycle = findDepsCycle(state.issues);
  if (depCycle) errors.push({ code: "cycle", message: `deps cycle: ${depCycle.join(" -> ")}` });

  for (const i of state.issues) {
    const file = issuePath(root, i);
    if ((i.dir === "done") !== (i.status === "done")) {
      errors.push({
        code: "placement",
        id: i.id,
        file,
        message:
          i.status === "done"
            ? `#${i.id} is done but not under issues/done/`
            : `#${i.id} is ${i.status} but lives under issues/done/`,
      });
    }
    if (i.status === "done") {
      for (const c of children.get(i.id) ?? []) {
        const ch = byId.get(c)!;
        if (isActive(ch.status))
          errors.push({
            code: "umbrella-open",
            id: i.id,
            file,
            message: `#${i.id} is done but child #${c} is ${ch.status}`,
          });
      }
    }
    if (isActive(i.status)) {
      for (const d of i.deps) {
        if (byId.get(d)?.status === "wontfix")
          errors.push({
            code: "wontfix-dep",
            id: i.id,
            file,
            message: `#${i.id} is blocked by wontfix #${d}; adjudicate (re-target or close #${i.id})`,
          });
      }
    }
    for (const t of linkTargets(i.body)) {
      if (!isRelativeTarget(t)) continue;
      const { path } = splitTarget(t);
      if (!path) continue;
      if (!existsSync(resolve(dirname(file), path)))
        errors.push({
          code: "link",
          id: i.id,
          file: rel(root, file),
          message: `broken relative link "${t}"`,
        });
    }
  }

  const d = computeDerived(state);
  const todoPath = join(root, "issues", "todo.yaml");
  const gotTodo = readText(todoPath);
  if (gotTodo === null)
    errors.push({
      code: "todo-mirror",
      file: "issues/todo.yaml",
      message: "issues/todo.yaml missing; run setup",
    });
  else if (gotTodo !== renderTodo(state, d))
    errors.push({
      code: "todo-mirror",
      file: "issues/todo.yaml",
      message: `issues/todo.yaml drift (${todoDiff(gotTodo, state, d)}); run setup`,
    });
  const readmePath = join(root, "issues", "readme.md");
  const gotReadme = readText(readmePath);
  if (gotReadme === null)
    errors.push({
      code: "readme",
      file: "issues/readme.md",
      message: "issues/readme.md missing; run setup",
    });
  else {
    const m = DOT_BODY_RE.exec(gotReadme);
    if (!m)
      errors.push({
        code: "dot-drift",
        file: "issues/readme.md",
        message: "issues/readme.md has no dot block; run setup",
      });
    else if ((m[1] ?? "") + "\n" !== renderDot(state.issues))
      errors.push({
        code: "dot-drift",
        file: "issues/readme.md",
        message: "issues/readme.md dot block drift; run setup",
      });
  }

  for (const i of state.issues) {
    if (i.status === "wontfix" && notesText(i.body) === "")
      warnings.push({
        code: "wontfix-reason",
        id: i.id,
        message: `#${i.id} is wontfix without a Notes reason`,
      });
  }
  return { ok: errors.length === 0, errors, warnings };
}

function cmdList(root: string): Record<string, unknown> {
  if (!hasIssuesDir(root)) throw new TrackerError("layout", "issues/ not found; run setup");
  const state = loadState(root);
  assertHealthy(state);
  const d = computeDerived(state);
  return {
    ok: true,
    issues: state.issues.map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      priority: i.priority,
      milestone: i.milestone,
      parent: i.parent,
      deps: i.deps,
      labels: i.labels,
      file: `issues/${i.dir === "done" ? "done/" : ""}${i.base}`,
    })),
    order: d.order,
    eligibleLeaves: d.eligibleLeaves,
    eligibleUmbrellas: d.eligibleUmbrellas,
    sets: d.sets,
    blockers: d.blockers,
  };
}

interface AddFlags {
  title?: string;
  body?: string;
  parent?: string;
  deps?: string;
  priority?: string;
  milestone?: string;
  labels?: string;
}

async function cmdAdd(root: string, cwd: string, f: AddFlags): Promise<Record<string, unknown>> {
  const title = (f.title ?? "").trim();
  if (!title || /[\r\n]/.test(title))
    throw new TrackerError("add-title", "--title is required and must be a non-empty single line");
  if (f.body === undefined) throw new TrackerError("add-body", "--body <file|-> is required");
  let bodyText: string;
  if (f.body === "-") bodyText = await Bun.stdin.text();
  else if (existsSync(resolve(cwd, f.body))) bodyText = readFileSync(resolve(cwd, f.body), "utf8");
  else throw new TrackerError("add-body", `body file not found: ${f.body}`);
  if (bodyText.trimStart().startsWith("---"))
    throw new TrackerError("add-body", "body must be plain markdown; drop the frontmatter");
  const missing = ["## Context", "## Goal", "## Acceptance criteria", "## Verification"].filter(
    (h) => !hasSection(bodyText, h),
  );
  if (missing.length)
    throw new TrackerError("add-body", `body is missing section(s): ${missing.join(", ")}`);
  if (!/^- \[ \]/m.test(sectionText(bodyText, "## Acceptance criteria")))
    throw new TrackerError("add-body", "Acceptance criteria needs at least one `- [ ]` item");
  const body = bodyText.trim() + "\n";

  const state = loadState(root);
  assertHealthy(state);
  const { byId } = index(state);
  const parent = f.parent === undefined ? null : parseOptId(f.parent, "parent");
  const deps = parseIdList(f.deps, "deps");
  const priority = f.priority === undefined ? "medium" : parsePriority(f.priority, "priority");
  const milestone = parseMilestone(f.milestone);
  const labels = parseLabels(f.labels);
  if (parent !== null) {
    const p = byId.get(parent);
    if (!p) throw new TrackerError("ref", `parent #${parent} does not exist`);
    if (p.status === "done")
      throw new TrackerError("ref", `parent #${parent} is done and cannot take active children`);
  }
  for (const d of deps) {
    const dep = byId.get(d);
    if (!dep) throw new TrackerError("ref", `dep #${d} does not exist`);
    if (dep.status === "wontfix")
      throw new TrackerError("ref", `dep #${d} is wontfix and can never satisfy this issue`);
  }
  const id = state.issues.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  const slug = slugify(title) || "issue";
  const base = `${String(id).padStart(4, "0")}-${slug}.md`;
  const issue: Issue = {
    id,
    title,
    status: "todo",
    priority,
    milestone,
    parent,
    deps,
    labels,
    created: today(),
    base,
    dir: "open",
    text: "",
    body,
  };
  issue.text = renderIssueFile(issue, body);
  writeText(issuePath(root, issue), issue.text);
  state.issues.push(issue);
  const { created, repaired } = renderDerived(root, state);
  return { ok: true, id, file: `issues/${base}`, derived: { created, repaired } };
}

interface SetFlags {
  title?: string;
  status?: string;
  priority?: string;
  milestone?: string;
  parent?: string;
  deps?: string;
  labels?: string;
  reason?: string;
}

function cmdSet(root: string, idText: string, f: SetFlags): Record<string, unknown> {
  if (!/^\d+$/.test(idText))
    throw new TrackerError("usage", "set needs an issue id: set <id> [flags]");
  const id = Number(idText);
  if (!(Object.keys(f) as (keyof SetFlags)[]).some((k) => f[k] !== undefined))
    throw new TrackerError("usage", "set needs at least one field flag");
  const state = loadState(root);
  assertHealthy(state);
  const { byId, children } = index(state);
  const issue = byId.get(id);
  if (!issue) throw new TrackerError("not-found", `issue #${id} not found`);
  const cand: Issue = { ...issue, deps: [...issue.deps], labels: [...issue.labels] };
  const changed: string[] = [];

  if (f.title !== undefined) {
    const t = f.title.trim();
    if (!t || /[\r\n]/.test(t))
      throw new TrackerError("flag", "--title must be a non-empty single line");
    cand.title = t;
    changed.push("title");
  }
  if (f.status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(f.status))
      throw new TrackerError("flag", `--status must be ${STATUSES.join(" | ")}`);
    cand.status = f.status as Status;
    changed.push("status");
  }
  if (f.priority !== undefined) {
    cand.priority = parsePriority(f.priority, "priority");
    changed.push("priority");
  }
  if (f.milestone !== undefined) {
    cand.milestone = parseMilestone(f.milestone);
    changed.push("milestone");
  }
  if (f.parent !== undefined) {
    const p = parseOptId(f.parent, "parent");
    if (p !== null) {
      if (p === id) throw new TrackerError("ref", "parent must not be itself");
      const pi = byId.get(p);
      if (!pi) throw new TrackerError("ref", `parent #${p} does not exist`);
      if (pi.status === "done" && isActive(cand.status))
        throw new TrackerError("ref", `parent #${p} is done and #${id} is active`);
      const on = new Set<number>([id]);
      let cur: Issue | undefined = pi;
      while (cur) {
        if (on.has(cur.id))
          throw new TrackerError(
            "cycle",
            `parent change would create a cycle (#${id} under #${p})`,
          );
        on.add(cur.id);
        cur = cur.parent === null ? undefined : byId.get(cur.parent);
      }
    }
    cand.parent = p;
    changed.push("parent");
  }
  if (f.deps !== undefined) {
    const deps = parseIdList(f.deps, "deps");
    for (const d of deps) {
      if (d === id) throw new TrackerError("ref", "deps must not contain itself");
      const dep = byId.get(d);
      if (!dep) throw new TrackerError("ref", `dep #${d} does not exist`);
      if (isActive(cand.status) && dep.status === "wontfix")
        throw new TrackerError("ref", `dep #${d} is wontfix and can never satisfy this issue`);
    }
    cand.deps = deps;
    changed.push("deps");
    const cyc = findDepsCycle(state.issues.map((i) => (i.id === id ? cand : i)));
    if (cyc)
      throw new TrackerError("cycle", `deps change would create a cycle: ${cyc.join(" -> ")}`);
  }
  if (f.labels !== undefined) {
    cand.labels = parseLabels(f.labels);
    changed.push("labels");
  }
  if (f.reason !== undefined) {
    if (f.status !== "wontfix")
      throw new TrackerError("flag", "--reason is only valid with --status wontfix");
    const r = f.reason.trim();
    if (!r || /[\r\n]/.test(r))
      throw new TrackerError("flag", "--reason must be a non-empty single line");
    changed.push("reason");
  }
  if (f.status === "wontfix" && f.reason === undefined)
    throw new TrackerError("flag", "--status wontfix requires --reason");

  const wasDone = issue.status === "done";
  const willDone = cand.status === "done";
  if (!wasDone && willDone) {
    const openDeps = cand.deps.filter((d) => byId.get(d)?.status !== "done");
    const openKids = (children.get(id) ?? []).filter((c) => isActive(byId.get(c)!.status));
    if (openDeps.length || openKids.length) {
      const parts: string[] = [];
      if (openDeps.length)
        parts.push(
          `deps not done: ${openDeps.map((d) => `#${d} (${byId.get(d)?.status ?? "missing"})`).join(", ")}`,
        );
      if (openKids.length)
        parts.push(
          `undecided children: ${openKids.map((c) => `#${c} (${byId.get(c)!.status})`).join(", ")}`,
        );
      throw new TrackerError("precondition", `cannot mark #${id} done: ${parts.join("; ")}`);
    }
  }

  let body = issue.body;
  if (f.status === "wontfix" && f.reason !== undefined)
    body = appendNote(body, `- Wontfix (${today()}): ${f.reason.trim()}`);
  if (wasDone !== willDone) {
    const oldAbs = issuePath(root, issue);
    const newAbs = join(root, "issues", willDone ? "done" : "", issue.base);
    const newBody = rebaseLinks(body, dirname(oldAbs), dirname(newAbs));
    for (const other of state.issues) {
      if (other.id === id) continue;
      const otherAbs = issuePath(root, other);
      const updated = retargetLinks(other.text, dirname(otherAbs), oldAbs, newAbs);
      if (updated !== other.text) writeText(otherAbs, updated);
    }
    mkdirSync(dirname(newAbs), { recursive: true });
    renameSync(oldAbs, newAbs);
    cand.dir = willDone ? "done" : "open";
    body = newBody;
  }
  cand.body = body;
  cand.text = renderIssueFile(cand, body);
  writeText(issuePath(root, cand), cand.text);
  state.issues[state.issues.findIndex((i) => i.id === id)] = cand;
  const { created, repaired } = renderDerived(root, state);
  return { ok: true, id, changed, derived: { created, repaired } };
}

// ------------------------------------------------------------------ CLI

const ADD_OPTIONS = {
  title: { type: "string" },
  body: { type: "string" },
  parent: { type: "string" },
  deps: { type: "string" },
  priority: { type: "string" },
  milestone: { type: "string" },
  labels: { type: "string" },
} as const;
const SET_OPTIONS = {
  title: { type: "string" },
  status: { type: "string" },
  priority: { type: "string" },
  milestone: { type: "string" },
  parent: { type: "string" },
  deps: { type: "string" },
  labels: { type: "string" },
  reason: { type: "string" },
} as const;

export const USAGE = [
  "usage:",
  "  issue-tracker setup",
  "  issue-tracker check",
  "  issue-tracker list",
  "  issue-tracker add --title <title> --body <file|-> [--parent <id>] [--deps <ids>] [--priority high|medium|low] [--milestone <m>] [--labels <a,b>]",
  "  issue-tracker set <id> [--title <t>] [--status todo|in-progress|review|done|wontfix] [--priority <p>] [--milestone <m|null>] [--parent <id|null>] [--deps <ids|null>] [--labels <a,b|null>] [--reason <text>]",
].join("\n");

function cliParse(
  args: string[],
  options: Record<string, { type: "string" }>,
  allowPositionals: boolean,
) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals });
  } catch (e) {
    throw new TrackerError("usage", e instanceof Error ? e.message : String(e));
  }
}

export async function run(
  argv: string[],
  cwd: string,
): Promise<{ code: number; out: Record<string, unknown> }> {
  try {
    const [cmd, ...rest] = argv;
    const root = findRoot(cwd);
    let out: Record<string, unknown>;
    if (cmd === "setup" || cmd === "check" || cmd === "list") {
      if (rest.length)
        throw new TrackerError("usage", `${cmd} takes no arguments, got: ${rest.join(" ")}`);
      out = cmd === "setup" ? cmdSetup(root) : cmd === "check" ? cmdCheck(root) : cmdList(root);
    } else if (cmd === "add") {
      const parsed = cliParse(rest, ADD_OPTIONS, false);
      out = await cmdAdd(root, cwd, parsed.values as unknown as AddFlags);
    } else if (cmd === "set") {
      const parsed = cliParse(rest, SET_OPTIONS, true);
      if (parsed.positionals.length !== 1)
        throw new TrackerError("usage", "set needs exactly one issue id");
      out = cmdSet(root, parsed.positionals[0]!, parsed.values as unknown as SetFlags);
    } else throw new TrackerError("usage", USAGE);
    return { code: out.ok === false ? 1 : 0, out };
  } catch (e) {
    const err =
      e instanceof TrackerError
        ? { code: e.code, message: e.message }
        : { code: "internal", message: e instanceof Error ? e.message : String(e) };
    return { code: 1, out: { ok: false, error: err } };
  }
}

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
  const { code, out } = await run(argv, cwd);
  process.stdout.write(JSON.stringify(out) + "\n");
  return code;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
