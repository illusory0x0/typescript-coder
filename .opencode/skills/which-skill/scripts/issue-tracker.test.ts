import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findRoot, run, slugify } from "./issue-tracker";

const projectRoot = resolve(import.meta.dir, "../..");
const baseTmp = join(projectRoot, "tmp", "issue-tracker-tests");
let seq = 0;
const made: string[] = [];

/** Create an isolated fixture repo (always gets a `.git` marker so findRoot stops here). */
function fixture(files: Record<string, string>): string {
  const root = join(baseTmp, `t${process.pid}-${seq++}`);
  made.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  for (const [relPath, text] of Object.entries(files)) {
    const p = join(root, relPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text, "utf8");
  }
  return root;
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => rmSync(baseTmp, { recursive: true, force: true }));

const read = (root: string, relPath: string) => readFileSync(join(root, relPath), "utf8");
const write = (root: string, relPath: string, text: string) => {
  mkdirSync(dirname(join(root, relPath)), { recursive: true });
  writeFileSync(join(root, relPath), text);
};

const BODY = `## Context\n\nBecause.\n\n## Goal\n\nDo the thing.\n\n## Acceptance criteria\n\n- [ ] It works\n\n## Verification\n\nRun \`bun test\`.\n`;

interface IssueOpts {
  id: number;
  title: string;
  status?: string;
  priority?: string;
  milestone?: string;
  parent?: number | null;
  deps?: number[];
  labels?: string[];
  created?: string;
  body?: string;
}

function issueText(o: IssueOpts): string {
  return `---\nid: ${o.id}\ntitle: ${JSON.stringify(o.title)}\nstatus: ${o.status ?? "todo"}\npriority: ${o.priority ?? "medium"}\nmilestone: ${o.milestone ?? "null"}\nparent: ${o.parent ?? "null"}\ndeps: [${(o.deps ?? []).join(", ")}]\nlabels: [${(o.labels ?? []).join(", ")}]\ncreated: ${o.created ?? "2026-10-18"}\n---\n\n${o.body ?? BODY}`;
}

const errors = (out: Record<string, unknown>) =>
  out.errors as { code: string; message: string; id?: number }[];

// ---------------------------------------------------------------- unit

describe("slugify", () => {
  test("kebab-cases titles", () => {
    expect(slugify("Fix the parser!")).toBe("fix-the-parser");
    expect(slugify("Edit protocol v2: composite locator × matcher")).toBe(
      "edit-protocol-v2-composite-locator-matcher",
    );
    expect(slugify("  Many -- dashes  ")).toBe("many-dashes");
  });
  test("non-ascii titles yield an empty slug (caller falls back)", () => {
    expect(slugify("修复解析器")).toBe("");
  });
});

// ---------------------------------------------------------------- setup / check / list

describe("setup / check / list", () => {
  test("setup bootstraps an empty tracker and is idempotent", async () => {
    const root = fixture({});
    const s1 = await run(["setup"], root);
    expect(s1.code).toBe(0);
    expect(s1.out).toMatchObject({
      ok: true,
      created: ["issues/todo.yaml", "issues/readme.md"],
      repaired: [],
    });
    expect(existsSync(join(root, "issues/done"))).toBe(true);
    expect((await run(["check"], root)).out).toMatchObject({ ok: true, errors: [], warnings: [] });
    const s2 = await run(["setup"], root);
    expect(s2.out).toMatchObject({ created: [], repaired: [] });
  });

  test("converges from issue files alone; list exposes the derived selection state", async () => {
    const root = fixture({
      "issues/0001-umbrella.md": issueText({ id: 1, title: "Umbrella", priority: "high" }),
      "issues/0002-first.md": issueText({ id: 2, title: "First", parent: 1, priority: "high" }),
      "issues/0003-second.md": issueText({
        id: 3,
        title: "Second",
        parent: 1,
        priority: "low",
        deps: [2],
      }),
    });
    const s = await run(["setup"], root);
    expect(s.out.ok).toBe(true);
    expect((await run(["check"], root)).out.errors).toEqual([]);
    const todo = read(root, "issues/todo.yaml");
    const ids = todo
      .split("\n")
      .filter((l) => l.startsWith("- id:"))
      .map((l) => l.slice(6));
    expect(ids).toEqual(["2", "3", "1"]);
    const l = await run(["list"], root);
    expect(l.out.order).toEqual([2, 3, 1]);
    expect(l.out.eligibleLeaves).toEqual([2]);
    expect(l.out.eligibleUmbrellas).toEqual([]);
    expect(l.out.sets).toEqual([{ umbrella: 1, members: [2, 3] }]);
    expect(l.out.blockers).toEqual([
      { id: 1, unmetDeps: [], undecidedChildren: [2, 3] },
      { id: 3, unmetDeps: [{ id: 2, status: "todo" }], undecidedChildren: [] },
    ]);
    const issues = l.out.issues as { file: string }[];
    expect(issues.find((i) => i.file.startsWith("issues/done/"))).toBeUndefined();
    expect(issues.length).toBe(3);
  });

  test("wontfix children count as decided for umbrella availability", async () => {
    const root = fixture({
      "issues/0001-umbrella.md": issueText({ id: 1, title: "U", priority: "high" }),
      "issues/0002-child.md": issueText({ id: 2, title: "C", parent: 1, status: "wontfix" }),
    });
    await run(["setup"], root);
    const l = await run(["list"], root);
    expect(l.out.eligibleUmbrellas).toEqual([1]);
    expect(l.out.order).toEqual([1]);
  });

  test("drift in derived files is detected by check and repaired by setup", async () => {
    const root = fixture({ "issues/0001-a.md": issueText({ id: 1, title: "A" }) });
    await run(["setup"], root);
    write(root, "issues/todo.yaml", "[]\n");
    write(root, "issues/readme.md", "# Issues\n\n```dot\ndigraph issues {}\n```\n");
    const bad = await run(["check"], root);
    expect(bad.out.ok).toBe(false);
    const codes = errors(bad.out).map((e) => e.code);
    expect(codes).toContain("todo-mirror");
    expect(codes).toContain("dot-drift");
    const s = await run(["setup"], root);
    expect((s.out.repaired as string[]).sort()).toEqual(["issues/readme.md", "issues/todo.yaml"]);
    expect((await run(["check"], root)).out.ok).toBe(true);
  });

  test("dangling refs are errors", async () => {
    const root = fixture({
      "issues/0001-a.md": issueText({ id: 1, title: "A", deps: [99] }),
      "issues/0002-b.md": issueText({ id: 2, title: "B", parent: 99 }),
    });
    await run(["setup"], root);
    const c = await run(["check"], root);
    expect(c.out.ok).toBe(false);
    const refs = errors(c.out).filter((e) => e.code === "ref");
    expect(refs.length).toBe(2);
  });

  test("parent and deps cycles are errors", async () => {
    const root = fixture({
      "issues/0001-a.md": issueText({ id: 1, title: "A", parent: 2 }),
      "issues/0002-b.md": issueText({ id: 2, title: "B", parent: 1 }),
      "issues/0003-c.md": issueText({ id: 3, title: "C", deps: [4] }),
      "issues/0004-d.md": issueText({ id: 4, title: "D", deps: [3] }),
    });
    await run(["setup"], root);
    const c = await run(["check"], root);
    const cycles = errors(c.out).filter((e) => e.code === "cycle");
    expect(cycles.length).toBe(2);
  });

  test("placement: done must live in issues/done/ and vice versa", async () => {
    const root = fixture({
      "issues/0001-umbrella.md": issueText({ id: 1, title: "U", status: "done" }),
      "issues/0002-child.md": issueText({ id: 2, title: "C", parent: 1 }),
      "issues/done/0003-moved.md": issueText({ id: 3, title: "M", status: "in-progress" }),
    });
    await run(["setup"], root);
    const c = await run(["check"], root);
    const codes = errors(c.out).map((e) => e.code);
    expect(codes).toContain("umbrella-open");
    expect(codes.filter((code) => code === "placement").length).toBe(2);
  });

  test("wontfix deps block active dependents with an adjudication error", async () => {
    const root = fixture({
      "issues/0001-w.md": issueText({
        id: 1,
        title: "W",
        status: "wontfix",
        body: `${BODY}\n## Notes\n\n- Superseded (2026-10-18) by #2.\n`,
      }),
      "issues/0002-x.md": issueText({ id: 2, title: "X", deps: [1] }),
    });
    await run(["setup"], root);
    const c = await run(["check"], root);
    expect(errors(c.out).some((e) => e.code === "wontfix-dep" && e.id === 2)).toBe(true);
    expect((c.out.warnings as unknown[]).length).toBe(0);
  });

  test("wontfix without a Notes reason is a warning, not an error", async () => {
    const root = fixture({
      "issues/0001-w.md": issueText({ id: 1, title: "W", status: "wontfix" }),
    });
    await run(["setup"], root);
    const c = await run(["check"], root);
    expect(c.out.ok).toBe(true);
    expect((c.out.warnings as { code: string }[]).some((w) => w.code === "wontfix-reason")).toBe(
      true,
    );
  });

  test("broken relative links are errors; URLs and anchors are not links", async () => {
    const linkBody = (target: string) =>
      `## Context\n\nSee [x](${target}) and [u](https://example.com) and [a](#frag).\n\n## Goal\n\nG\n\n## Acceptance criteria\n\n- [ ] c\n\n## Verification\n\nv\n`;
    const root = fixture({
      "spec.md": "spec\n",
      "issues/0001-a.md": issueText({ id: 1, title: "A", body: linkBody("../spec.md") }),
      "issues/0002-b.md": issueText({ id: 2, title: "B", body: linkBody("../nope.md") }),
    });
    await run(["setup"], root);
    const c = await run(["check"], root);
    const links = errors(c.out).filter((e) => e.code === "link");
    expect(links.length).toBe(1);
    expect(links[0]!.id).toBe(2);
  });

  test("unknown frontmatter keys are load errors", async () => {
    const root = fixture({
      "issues/0001-a.md": issueText({ id: 1, title: "A" }).replace("created:", "foo: 1\ncreated:"),
    });
    const c = await run(["check"], root);
    expect(errors(c.out)[0]?.code).toBe("frontmatter");
    expect(String((errors(c.out)[0] as { message: string }).message)).toContain("unknown key");
  });

  test("duplicate ids are errors", async () => {
    const root = fixture({
      "issues/0001-a.md": issueText({ id: 1, title: "A" }),
      "issues/done/0001-b.md": issueText({ id: 1, title: "B", status: "done" }),
    });
    await run(["setup"], root);
    const c = await run(["check"], root);
    expect(errors(c.out).some((e) => e.code === "dup-id")).toBe(true);
  });
});

// ---------------------------------------------------------------- add

describe("add", () => {
  test("creates the next id across both dirs and re-derives", async () => {
    const root = fixture({
      "body.md": BODY,
      "issues/0005-old.md": issueText({ id: 5, title: "Old" }),
      "issues/done/0007-gone.md": issueText({ id: 7, title: "Gone", status: "done" }),
    });
    await run(["setup"], root);
    const r = await run(
      ["add", "--title", "Fix the parser", "--body", "body.md", "--priority", "high"],
      root,
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ ok: true, id: 8, file: "issues/0008-fix-the-parser.md" });
    const text = read(root, "issues/0008-fix-the-parser.md");
    expect(text).toContain('title: "Fix the parser"');
    expect(text).toContain("priority: high");
    expect(text).toContain("status: todo");
    expect((await run(["check"], root)).out.ok).toBe(true);
    expect(read(root, "issues/todo.yaml")).toContain("- id: 8");
  });

  test("non-ascii titles fall back to the `issue` slug", async () => {
    const root = fixture({ "body.md": BODY });
    await run(["setup"], root);
    const r = await run(["add", "--title", "修复解析器", "--body", "body.md"], root);
    expect(r.code).toBe(0);
    expect(r.out.file).toBe("issues/0001-issue.md");
  });

  test("reads the body from stdin with `-`", async () => {
    const root = fixture({});
    await run(["setup"], root);
    const proc = Bun.spawn({
      cmd: [
        "bun",
        resolve(import.meta.dir, "issue-tracker.ts"),
        "add",
        "--title",
        "From stdin",
        "--body",
        "-",
      ],
      cwd: root,
      stdin: new Blob([BODY]),
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).json();
    expect(await proc.exited).toBe(0);
    expect(out).toMatchObject({ ok: true, id: 1 });
    expect(existsSync(join(root, "issues/0001-from-stdin.md"))).toBe(true);
  });

  test("rejects invalid bodies and writes nothing", async () => {
    const root = fixture({
      "no-verification.md": BODY.replace("## Verification", "## Stuff"),
      "no-criteria.md": BODY.replace("- [ ] It works", "just prose"),
      "with-frontmatter.md": `---\nid: 9\n---\n\n${BODY}`,
    });
    await run(["setup"], root);
    const cases: [string, string][] = [
      ["no-verification.md", "missing section"],
      ["no-criteria.md", "at least one"],
      ["with-frontmatter.md", "plain markdown"],
    ];
    for (const [file, needle] of cases) {
      const r = await run(["add", "--title", "T", "--body", file], root);
      expect(r.code).toBe(1);
      expect(String((r.out.error as { message: string }).message)).toContain(needle);
    }
    expect(existsSync(join(root, "issues/0001-t.md"))).toBe(false);
  });

  test("rejects dangling parents and deps", async () => {
    const root = fixture({ "body.md": BODY });
    await run(["setup"], root);
    expect(
      (await run(["add", "--title", "T", "--body", "body.md", "--parent", "99"], root)).code,
    ).toBe(1);
    expect(
      (await run(["add", "--title", "T", "--body", "body.md", "--deps", "1,x"], root)).code,
    ).toBe(1);
    expect((await run(["add", "--title", "T", "--body", "missing.md"], root)).code).toBe(1);
  });
});

// ---------------------------------------------------------------- set

describe("set", () => {
  test("updates fields, canonicalizes the frontmatter, re-derives", async () => {
    const root = fixture({
      "issues/0001-a.md": issueText({ id: 1, title: "A", priority: "low" }),
      "issues/0002-b.md": issueText({ id: 2, title: "B", deps: [1] }),
    });
    await run(["setup"], root);
    const r = await run(["set", "2", "--priority", "high", "--title", "B2"], root);
    expect(r.code).toBe(0);
    expect(r.out.changed).toEqual(["title", "priority"]);
    const text = read(root, "issues/0002-b.md");
    expect(text).toContain('title: "B2"');
    expect(text).toContain("priority: high");
    expect((await run(["check"], root)).out.ok).toBe(true);
  });

  test("done moves the file, rebases links in and out, drops the entry", async () => {
    const linkBody = (target: string) =>
      `## Context\n\nSee [spec](${target}).\n\n## Goal\n\nG\n\n## Acceptance criteria\n\n- [ ] c\n\n## Verification\n\nv\n`;
    const root = fixture({
      "spec.md": "spec\n",
      "issues/0001-a.md": issueText({ id: 1, title: "A", body: linkBody("../spec.md") }),
      "issues/0002-b.md": issueText({
        id: 2,
        title: "B",
        body: `## Context\n\nNext is [A](0001-a.md) and [spec](../spec.md).\n\n## Goal\n\nG\n\n## Acceptance criteria\n\n- [ ] c\n\n## Verification\n\nv\n`,
      }),
    });
    await run(["setup"], root);
    const r = await run(["set", "1", "--status", "done"], root);
    expect(r.code).toBe(0);
    expect(r.out.changed).toEqual(["status"]);
    expect(existsSync(join(root, "issues/0001-a.md"))).toBe(false);
    expect(existsSync(join(root, "issues/done/0001-a.md"))).toBe(true);
    expect(read(root, "issues/done/0001-a.md")).toContain("[spec](../../spec.md)");
    expect(read(root, "issues/0002-b.md")).toContain("[A](done/0001-a.md)");
    expect(read(root, "issues/0002-b.md")).toContain("[spec](../spec.md)");
    expect(read(root, "issues/todo.yaml")).not.toContain("- id: 1");
    expect((await run(["check"], root)).out.ok).toBe(true);
  });

  test("done preconditions: deps done, children decided", async () => {
    const root = fixture({
      "issues/0001-a.md": issueText({ id: 1, title: "A" }),
      "issues/0002-b.md": issueText({ id: 2, title: "B", deps: [1] }),
      "issues/0003-u.md": issueText({ id: 3, title: "U" }),
      "issues/0004-k.md": issueText({ id: 4, title: "K", parent: 3 }),
    });
    await run(["setup"], root);
    const dep = await run(["set", "2", "--status", "done"], root);
    expect(dep.code).toBe(1);
    expect(String((dep.out.error as { message: string }).message)).toContain("#1 (todo)");
    const kids = await run(["set", "3", "--status", "done"], root);
    expect(kids.code).toBe(1);
    expect(String((kids.out.error as { message: string }).message)).toContain("undecided children");
    expect(existsSync(join(root, "issues/0002-b.md"))).toBe(true);
    expect(read(root, "issues/0002-b.md")).toContain("status: todo");
  });

  test("wontfix needs a reason and appends it to Notes", async () => {
    const root = fixture({ "issues/0001-w.md": issueText({ id: 1, title: "W" }) });
    await run(["setup"], root);
    expect((await run(["set", "1", "--status", "wontfix"], root)).code).toBe(1);
    expect((await run(["set", "1", "--reason", "because"], root)).code).toBe(1);
    const r = await run(["set", "1", "--status", "wontfix", "--reason", "superseded by v2"], root);
    expect(r.code).toBe(0);
    const text = read(root, "issues/0001-w.md");
    expect(text).toContain("## Notes");
    expect(text).toContain("Wontfix (");
    expect(text).toContain("superseded by v2");
    const c = await run(["check"], root);
    expect(c.out.ok).toBe(true);
    expect(c.out.warnings).toEqual([]);
  });

  test("rejects cycles and bad refs; failed sets leave files untouched", async () => {
    const root = fixture({
      "issues/0001-a.md": issueText({ id: 1, title: "A" }),
      "issues/0002-b.md": issueText({ id: 2, title: "B", parent: 1 }),
    });
    await run(["setup"], root);
    const before = read(root, "issues/0002-b.md");
    const r1 = await run(["set", "2", "--title", "Renamed", "--parent", "99"], root);
    expect(r1.code).toBe(1);
    expect(read(root, "issues/0002-b.md")).toBe(before);
    const r2 = await run(["set", "1", "--parent", "2"], root);
    expect(r2.code).toBe(1);
    expect(String((r2.out.error as { message: string }).message)).toContain("cycle");
    expect((await run(["set", "1", "--deps", "2"], root)).code).toBe(0);
    const r4 = await run(["set", "2", "--deps", "1"], root);
    expect(r4.code).toBe(1);
    expect(String((r4.out.error as { message: string }).message)).toContain("cycle");
  });

  test("in-progress keeps the item in order but out of eligibleLeaves", async () => {
    const root = fixture({
      "issues/0001-a.md": issueText({ id: 1, title: "A", priority: "high" }),
      "issues/0002-b.md": issueText({ id: 2, title: "B", priority: "medium" }),
    });
    await run(["setup"], root);
    await run(["set", "1", "--status", "in-progress"], root);
    const l = await run(["list"], root);
    expect(l.out.order).toEqual([1, 2]);
    expect(l.out.eligibleLeaves).toEqual([2]);
  });

  test("moving back from done re-homes the file", async () => {
    const root = fixture({
      "issues/done/0001-a.md": issueText({ id: 1, title: "A", status: "done" }),
    });
    await run(["setup"], root);
    const r = await run(["set", "1", "--status", "todo"], root);
    expect(r.code).toBe(0);
    expect(existsSync(join(root, "issues/0001-a.md"))).toBe(true);
    expect(existsSync(join(root, "issues/done/0001-a.md"))).toBe(false);
    expect((await run(["check"], root)).out.ok).toBe(true);
  });
});

// ---------------------------------------------------------------- cli

describe("cli", () => {
  test("usage errors: unknown command, no flags, stray arguments", async () => {
    const root = fixture({});
    const r = await run(["bogus"], root);
    expect(r.code).toBe(1);
    expect((r.out.error as { code: string }).code).toBe("usage");
    await run(["setup"], root);
    expect((await run(["set", "1"], root)).code).toBe(1);
    expect((await run(["list", "--json"], root)).code).toBe(1);
    expect((await run(["add", "--title", "T"], root)).code).toBe(1);
  });

  test("findRoot stops at the nearest issues/ or git boundary", () => {
    const root = fixture({ "issues/0001-a.md": issueText({ id: 1, title: "A" }) });
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    expect(findRoot(join(root, "src", "deep"))).toBe(root);
    const bare = fixture({});
    mkdirSync(join(bare, "src"), { recursive: true });
    expect(findRoot(join(bare, "src"))).toBe(bare);
  });

  test("list/fail on a missing tracker points at setup", async () => {
    const root = fixture({});
    const r = await run(["list"], root);
    expect(r.code).toBe(1);
    expect((r.out.error as { message: string }).message).toContain("setup");
  });
});
