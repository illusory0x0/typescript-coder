import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sourceRevision } from "./range";

const CLI = join(import.meta.dir, "cli.ts");
const BEGIN = "TC_EDIT_BEGIN";
const END = "TC_EDIT_END";

const HELPER = [
  "export function helper(): number {",
  "  return 1;",
  "}",
  "",
  "export function answer(): number {",
  "  return 1;",
  "}",
  "",
].join("\n");

const ANSWER_TWO = ["export function answer(): number {", "  return 2;", "}", ""].join("\n");

const AFTER_REPLACE = [
  "export function helper(): number {",
  "  return 1;",
  "}",
  "",
  "export function answer(): number {",
  "  return 2;",
  "}",
  "",
].join("\n");

const ANSWER_THREE = [
  "export function helper(): number {",
  "  return 1;",
  "}",
  "",
  "export function answer(): number {",
  "  return 3;",
  "}",
  "",
].join("\n");

const MUTATION_DSL = [
  "select answer in src/helper.ts",
  "replace with",
  BEGIN,
  "export function answer(): number {",
  "  return 3;",
  "}",
  END,
  "",
].join("\n");

let directories: string[] = [];

function makeWorkspace(files: Record<string, string> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), "tc-tsed-"));
  directories.push(directory);
  const all = { "src/helper.ts": HELPER, ...files };
  for (const [path, source] of Object.entries(all)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return directory;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(cwd: string, args: readonly string[], input?: string): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    input,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories = [];
});

describe("tsed flag protocol", () => {
  test("--help lists the protocol, write, dry-run, and read options", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--protocol-format");
    expect(result.stdout).toContain("--write");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).toContain("--read");
    expect(result.stdout).toContain("--within");
    expect(result.stdout).toContain("--read <PATH>");
    expect(result.stdout).toContain("--select <SYMBOL>");
    expect(result.stdout).toContain("--select-file <PATH>");
    expect(result.stdout).toContain("--in <PATH>");
    expect(result.stdout).toContain("-C, --directory <DIR>");
    expect(result.stdout).toContain("--replace-file <FILE>");
    expect(result.stdout).toContain("--content-file <FILE>");
    expect(result.stderr).toBe("");
  });

  test("--version prints the version", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("tsed 0.0.0\n");
    expect(result.stderr).toBe("");
  });

  test("--read prints numbered lines", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--protocol-format", "flag", "--read", "src/helper.ts"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("src/helper.ts (whole file, 7 lines");
    expect(result.stdout).toContain("1 | export function helper(): number {");
    expect(result.stdout).toContain("5 | export function answer(): number {");
    expect(result.stderr).toBe("");
  });

  test("--read is repeatable", () => {
    const workspace = makeWorkspace({ "src/other.ts": "export const other = true;\n" });
    const result = run(workspace, ["--read", "src/helper.ts", "--read", "src/other.ts"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("src/helper.ts (whole file");
    expect(result.stdout).toContain("src/other.ts (whole file");
    expect(result.stderr).toBe("");
  });

  test("--read --within prints only the selected lines unfolded", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--read", "src/helper.ts", "--within", "2-3"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `src/helper.ts (selected lines, 2 lines; rev ${sourceRevision(HELPER)}):`,
    );
    expect(result.stdout).toContain("2 |   return 1;");
    expect(result.stdout).toContain("3 | }");
    expect(result.stdout).not.toContain("1 | export function helper");
    expect(result.stderr).toBe("");
  });

  test("--select --in prints a viewer", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--select", "answer", "--in", "src/helper.ts"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("select answer in src/helper.ts");
    expect(result.stdout).toContain("src/helper.ts:5:");
    expect(result.stderr).toBe("");
  });

  test("--select prints a rev that --rev accepts, and a stale rev writes nothing", () => {
    const workspace = makeWorkspace({ "patch.txt": ANSWER_TWO });
    const token = sourceRevision(HELPER);
    const viewer = run(workspace, ["--select", "answer", "--in", "src/helper.ts"]);
    expect(viewer.status).toBe(0);
    expect(viewer.stdout).toContain(`select answer in src/helper.ts rev ${token}`);

    const fresh = run(workspace, [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--rev",
      token,
      "--replace-file",
      "patch.txt",
      "--dry-run",
    ]);
    expect(fresh.status).toBe(0);
    expect(fresh.stdout).toContain("would change: src/helper.ts");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);

    const stale = run(workspace, [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--rev",
      "00000000",
      "--replace-file",
      "patch.txt",
      "--dry-run",
    ]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("stage: range");
    expect(stale.stderr).toContain("refresh");
    expect(stale.stdout).not.toContain("would change:");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("a malformed --rev is a usage error", () => {
    const workspace = makeWorkspace({ "patch.txt": ANSWER_TWO });
    const result = run(workspace, [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--rev",
      "XYZ",
      "--replace-file",
      "patch.txt",
      "--dry-run",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("rev");
    expect(result.stderr).toContain("8-character lowercase hex");
  });

  test("--select --in --within prints the viewer slice unfolded", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--within",
      "6-7",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `select answer in src/helper.ts rev ${sourceRevision(HELPER)} within 6-7`,
    );
    expect(result.stdout).toContain("6 |   return 1;");
    expect(result.stdout).toContain("7 | }");
    expect(result.stdout).not.toContain("5 | export function answer");
    expect(result.stderr).toBe("");
  });

  test("--within is rejected with every mutation", () => {
    const workspace = makeWorkspace({
      "src/old.ts": "export const old = true;\n",
      "patch.txt": ANSWER_TWO,
      "content.txt": "export const rewritten = true;\n",
    });
    const cases: { flag: string; args: string[] }[] = [
      {
        flag: "--replace-file",
        args: [
          "--select",
          "answer",
          "--in",
          "src/helper.ts",
          "--within",
          "6-7",
          "--replace-file",
          "patch.txt",
          "--write",
        ],
      },
      {
        flag: "--rename",
        args: [
          "--select",
          "answer",
          "--in",
          "src/helper.ts",
          "--within",
          "6-7",
          "--rename",
          "result",
          "--write",
        ],
      },
      { flag: "--create", args: ["--create", "src/new.ts", "--within", "1-2", "--write"] },
      { flag: "--delete", args: ["--delete", "src/old.ts", "--within", "1-2", "--write"] },
      {
        flag: "--rewrite",
        args: [
          "--rewrite",
          "src/helper.ts",
          "--content-file",
          "content.txt",
          "--within",
          "1-2",
          "--write",
        ],
      },
    ];

    for (const { flag, args } of cases) {
      const result = run(workspace, args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--within is viewer-only");
      expect(result.stderr).toContain(flag);
      expect(result.stderr).toContain("usage:");
    }
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
    expect(existsSync(join(workspace, "src/new.ts"))).toBe(false);
    expect(existsSync(join(workspace, "src/old.ts"))).toBe(true);
  });

  test("--within requires --read or --select", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--within", "2-3"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--within requires --read or --select");
    expect(result.stderr).toContain("usage:");
  });

  test("--within with --match is rejected by the selection parser", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--within",
      "6-7",
      "--match",
      "return 1;",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("EDIT_WITHIN_EDITOR");
    expect(result.stderr).toContain("viewer-only");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("--replace-file --write applies a patch relative to the workspace root", () => {
    const workspace = makeWorkspace({ "patch.txt": ANSWER_TWO });
    const result = run(workspace, [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--replace-file",
      "patch.txt",
      "--write",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("changed: src/helper.ts");
    expect(result.stderr).toBe("");
    expect(read(join(workspace, "src/helper.ts"))).toBe(AFTER_REPLACE);
  });

  test("--rename applies a symbol rename with --write", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--rename",
      "result",
      "--write",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("changed: src/helper.ts");
    expect(read(join(workspace, "src/helper.ts"))).toContain("export function result(): number {");
    expect(read(join(workspace, "src/helper.ts"))).not.toContain("export function answer");
  });

  test("a flag mutation without --write is a usage error and changes nothing", () => {
    const workspace = makeWorkspace({ "patch.txt": ANSWER_TWO });
    const result = run(workspace, [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--replace-file",
      "patch.txt",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("tsed:");
    expect(result.stderr).toContain("--write");
    expect(result.stderr).toContain("usage:");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("--create and --delete apply with --write", () => {
    const workspace = makeWorkspace({ "src/old.ts": "export const old = true;\n" });
    const result = run(workspace, ["--create", "src/new.ts", "--delete", "src/old.ts", "--write"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("created: src/new.ts");
    expect(result.stdout).toContain("deleted: src/old.ts");
    expect(read(join(workspace, "src/new.ts"))).toBe("");
    expect(existsSync(join(workspace, "src/old.ts"))).toBe(false);
  });

  test("--replace-file --dry-run previews a change and writes nothing", () => {
    const workspace = makeWorkspace({ "patch.txt": ANSWER_TWO });
    const result = run(workspace, [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--replace-file",
      "patch.txt",
      "--dry-run",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would change: src/helper.ts");
    expect(result.stdout).not.toContain("changed: src/helper.ts");
    expect(result.stderr).toBe("");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("--create and --delete dry-run previews and changes nothing", () => {
    const workspace = makeWorkspace({ "src/old.ts": "export const old = true;\n" });
    const oldSource = read(join(workspace, "src/old.ts"));
    const result = run(workspace, [
      "--create",
      "src/new.ts",
      "--delete",
      "src/old.ts",
      "--dry-run",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would create: src/new.ts");
    expect(result.stdout).toContain("would delete: src/old.ts");
    expect(result.stdout).not.toContain("created: src/new.ts");
    expect(result.stdout).not.toContain("deleted: src/old.ts");
    expect(existsSync(join(workspace, "src/new.ts"))).toBe(false);
    expect(read(join(workspace, "src/old.ts"))).toBe(oldSource);
  });

  test("non-regular paths fail identically in dry-run and apply", () => {
    const workspace = makeWorkspace({ "content.txt": "export const rewritten = true;\n" });
    for (const path of ["dircreate", "dirdelete", "dirwrite"]) {
      mkdirSync(join(workspace, path));
    }
    const cases: { args: string[]; diagnostic: string }[] = [
      { args: ["--create", "dircreate"], diagnostic: 'cannot create "dircreate"' },
      { args: ["--delete", "dirdelete"], diagnostic: 'cannot delete "dirdelete"' },
      {
        args: ["--rewrite", "dirwrite", "--content-file", "content.txt"],
        diagnostic: 'cannot write "dirwrite"',
      },
    ];

    for (const { args, diagnostic } of cases) {
      const preview = run(workspace, [...args, "--dry-run"]);
      const applied = run(workspace, [...args, "--write"]);
      expect(preview.status).toBe(1);
      expect(applied.status).toBe(1);
      expect(preview.stderr).toBe(applied.stderr);
      expect(preview.stderr).toContain("stage: address");
      expect(preview.stderr).toContain("not a regular file");
      expect(preview.stderr).toContain(diagnostic);
      expect(preview.stderr).not.toContain("does not exist");
      expect(preview.stdout).toBe("");
      expect(applied.stdout).toBe("");
    }
    for (const path of ["dircreate", "dirdelete", "dirwrite"]) {
      expect(existsSync(join(workspace, path))).toBe(true);
    }
  });

  test("--write and --dry-run are mutually exclusive", () => {
    const workspace = makeWorkspace({ "patch.txt": ANSWER_TWO });
    const result = run(workspace, [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--replace-file",
      "patch.txt",
      "--write",
      "--dry-run",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("tsed:");
    expect(result.stderr).toContain("--write and --dry-run are mutually exclusive");
    expect(result.stderr).toContain("usage:");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("--rewrite --content-file applies a whole-file replacement", () => {
    const rewritten = "export const rewritten = true;\n";
    const workspace = makeWorkspace({ "content.txt": rewritten });
    const result = run(workspace, [
      "--rewrite",
      "src/helper.ts",
      "--content-file",
      "content.txt",
      "--write",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("changed: src/helper.ts");
    expect(read(join(workspace, "src/helper.ts"))).toBe(rewritten);
  });

  test("-C selects the workspace for reads and edits", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["-C", "src", "--read", "helper.ts"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("helper.ts (whole file");
  });

  test("payload files resolve from the -C workspace root", () => {
    const parent = makeWorkspace({
      "work/src/helper.ts": HELPER,
      "work/patch.txt": ANSWER_TWO,
      "work/absolute.txt": "export function answer(): number {\n  return 3;\n}\n",
      "work/content.txt": "export const workspaceContent = true;\n",
      "patch.txt": "export const wrongPatch = true;\n",
      "content.txt": "export const wrongContent = true;\n",
    });

    const applied = run(parent, [
      "-C",
      "work",
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--replace-file",
      "patch.txt",
      "--write",
    ]);
    expect(applied.status).toBe(0);
    expect(read(join(parent, "work/src/helper.ts"))).toBe(AFTER_REPLACE);

    const absolute = run(parent, [
      "-C",
      "work",
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--replace-file",
      join(parent, "work/absolute.txt"),
      "--write",
    ]);
    expect(absolute.status).toBe(0);
    expect(read(join(parent, "work/src/helper.ts"))).toBe(ANSWER_THREE);

    const rewritten = run(parent, [
      "-C",
      "work",
      "--rewrite",
      "src/helper.ts",
      "--content-file",
      "content.txt",
      "--write",
    ]);
    expect(rewritten.status).toBe(0);
    expect(read(join(parent, "work/src/helper.ts"))).toBe(
      "export const workspaceContent = true;\n",
    );
  });

  test("a missing payload file reports the resolved workspace path", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--replace-file",
      "missing.txt",
      "--write",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(join(workspace, "missing.txt"));
  });
});

describe("tsed stdin protocols", () => {
  test("dsl reads an edit-dsl reply from stdin", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--protocol-format", "dsl"], "read src/helper.ts end\n");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 | export function helper(): number {");
    expect(result.stderr).toBe("");
  });

  test("dsl mutation without --write fails with stage: protocol", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--protocol-format", "dsl"], MUTATION_DSL);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stage: protocol");
    expect(result.stderr).toContain("read-only");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("dsl mutation with --write applies the change", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--protocol-format", "dsl", "--write"], MUTATION_DSL);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("changed: src/helper.ts");
    expect(read(join(workspace, "src/helper.ts"))).toBe(ANSWER_THREE);
  });

  test("dsl mutation with --dry-run previews and leaves the file unchanged", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--protocol-format", "dsl", "--dry-run"], MUTATION_DSL);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would change: src/helper.ts");
    expect(result.stdout).not.toContain("changed: src/helper.ts");
    expect(result.stdout).not.toContain("--- a/src/helper.ts");
    expect(result.stderr).toBe("");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("dsl --dry-run --diff prints planned paths and a unified diff", () => {
    const workspace = makeWorkspace();
    const result = run(
      workspace,
      ["--protocol-format", "dsl", "--dry-run", "--diff"],
      MUTATION_DSL,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would change: src/helper.ts");
    expect(result.stdout).toContain("\n--- a/src/helper.ts\n+++ b/src/helper.ts\n");
    expect(result.stdout).toContain("@@ -");
    expect(result.stdout).toContain("-  return 1;");
    expect(result.stdout).toContain("+  return 3;");
    expect(result.stderr).toBe("");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("dsl --dry-run applies two disjoint pick clauses to one declaration (#92)", () => {
    const source = [
      "export function two(): number {",
      "  const first = 1;",
      "  return first;",
      "}",
      "",
    ].join("\n");
    const workspace = makeWorkspace({ "src/two.ts": source });
    const reply = [
      "select function two in src/two.ts",
      "pick 2",
      "replace with",
      BEGIN,
      "  const first = 2;",
      END,
      "end",
      "",
      "select function two in src/two.ts",
      "pick 3",
      "replace with",
      BEGIN,
      "  return first + 1;",
      END,
      "end",
      "",
    ].join("\n");
    const result = run(workspace, ["--protocol-format", "dsl", "--dry-run", "--diff"], reply);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would change: src/two.ts");
    expect(result.stdout).toContain("-  const first = 1;");
    expect(result.stdout).toContain("+  const first = 2;");
    expect(result.stdout).toContain("-  return first;");
    expect(result.stdout).toContain("+  return first + 1;");
    expect(result.stderr).toBe("");
    expect(read(join(workspace, "src/two.ts"))).toBe(source);
  });

  test("flag --dry-run --diff prints the diff too", () => {
    const workspace = makeWorkspace({ "patch.txt": ANSWER_TWO });
    const result = run(workspace, [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--replace-file",
      "patch.txt",
      "--dry-run",
      "--diff",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would change: src/helper.ts");
    expect(result.stdout).toContain("--- a/src/helper.ts");
    expect(result.stdout).toContain("@@ -");
    expect(result.stderr).toBe("");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("--diff without --dry-run is a usage error", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--protocol-format", "dsl", "--diff"], MUTATION_DSL);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--diff requires --dry-run");
    expect(result.stderr).toContain("usage:");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("--diff with --write is a usage error", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--protocol-format", "dsl", "--write", "--diff"], MUTATION_DSL);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--diff is preview-only");
    expect(result.stderr).toContain("--write");
    expect(result.stderr).toContain("usage:");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("apply output stays diff-free", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--protocol-format", "dsl", "--write"], MUTATION_DSL);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("changed: src/helper.ts");
    expect(result.stdout).not.toContain("--- a/src/helper.ts");
    expect(result.stdout).not.toContain("@@ -");
    expect(read(join(workspace, "src/helper.ts"))).toBe(ANSWER_THREE);
  });

  test("json mutation with --dry-run previews and leaves the file unchanged", () => {
    const workspace = makeWorkspace();
    const rewritten = "export const answer = 7;\n";
    const result = run(
      workspace,
      ["--protocol-format", "json", "--dry-run"],
      JSON.stringify({
        operations: [{ op: "rewrite", path: "src/helper.ts", content: rewritten }],
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would change: src/helper.ts");
    expect(result.stdout).not.toContain("changed: src/helper.ts");
    expect(result.stderr).toBe("");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("json select accepts rev and rejects a stale token", () => {
    const workspace = makeWorkspace();
    const token = sourceRevision(HELPER);
    const operation = {
      op: "select",
      symbol: "answer",
      path: "src/helper.ts",
      rev: token,
      replace: ANSWER_TWO,
    };
    const fresh = run(
      workspace,
      ["--protocol-format", "json", "--dry-run"],
      JSON.stringify({ operations: [operation] }),
    );
    expect(fresh.status).toBe(0);
    expect(fresh.stdout).toContain("would change: src/helper.ts");

    const stale = run(
      workspace,
      ["--protocol-format", "json", "--dry-run"],
      JSON.stringify({ operations: [{ ...operation, rev: "00000000" }] }),
    );
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("stage: range");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("dsl and json payloads fail identically on non-regular paths", () => {
    const workspace = makeWorkspace();
    for (const path of ["dircreate", "dirdelete", "dirwrite"]) {
      mkdirSync(join(workspace, path));
    }
    const dslReply = [
      "create dircreate end",
      "delete dirdelete end",
      "write dirwrite with",
      BEGIN,
      "export const nope = true;",
      END,
    ].join("\n");
    const jsonPayload = JSON.stringify({
      operations: [
        { op: "create", path: "dircreate" },
        { op: "delete", path: "dirdelete" },
        { op: "rewrite", path: "dirwrite", content: "export const nope = true;\n" },
      ],
    });
    const payloads = [
      { format: "dsl", input: dslReply },
      { format: "json", input: jsonPayload },
    ];

    for (const { format, input } of payloads) {
      const preview = run(workspace, ["--protocol-format", format, "--dry-run"], input);
      const applied = run(workspace, ["--protocol-format", format, "--write"], input);
      expect(preview.status).toBe(1);
      expect(applied.status).toBe(1);
      expect(preview.stderr).toBe(applied.stderr);
      expect(preview.stderr).toContain('cannot create "dircreate"');
      expect(preview.stderr).toContain('cannot delete "dirdelete"');
      expect(preview.stderr).toContain('cannot write "dirwrite"');
      expect(preview.stderr).toContain("not a regular file");
      expect(preview.stderr).not.toContain("does not exist");
      expect(preview.stdout).toBe("");
      expect(applied.stdout).toBe("");
    }
    for (const path of ["dircreate", "dirdelete", "dirwrite"]) {
      expect(existsSync(join(workspace, path))).toBe(true);
    }
  });

  test("a failed dsl dry-run exits 1 and prints no preview", () => {
    const workspace = makeWorkspace();
    const reply = [
      "select helper in src/helper.ts",
      "replace with",
      BEGIN,
      "export function helper(): number {",
      "  return 5;",
      "}",
      END,
      "",
      "select answer in src/helper.ts",
      "pick 99",
      "replace with",
      BEGIN,
      "return 9;",
      END,
      "",
    ].join("\n");
    const result = run(workspace, ["--protocol-format", "dsl", "--dry-run"], reply);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stage: range");
    expect(result.stdout).not.toContain("would change:");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("json reads and rewrites an operation list", () => {
    const workspace = makeWorkspace();
    const readResult = run(
      workspace,
      ["--protocol-format", "json"],
      '{"operations":[{"op":"read","path":"src/helper.ts"}]}\n',
    );
    expect(readResult.status).toBe(0);
    expect(readResult.stdout).toContain("1 | export function helper(): number {");

    const rewritten = "export const answer = 7;\n";
    const writeResult = run(
      workspace,
      ["--protocol-format", "json", "--write"],
      JSON.stringify({
        operations: [{ op: "rewrite", path: "src/helper.ts", content: rewritten }],
      }),
    );
    expect(writeResult.status).toBe(0);
    expect(writeResult.stdout).toContain("changed: src/helper.ts");
    expect(read(join(workspace, "src/helper.ts"))).toBe(rewritten);
  });

  test("malformed JSON is a usage error", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--protocol-format", "json"], "{");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("tsed:");
    expect(result.stderr).toContain("invalid JSON");
    expect(result.stderr).toContain("usage:");
  });

  test("a clean edit plus a failing edit exits 1 and changes nothing", () => {
    const workspace = makeWorkspace();
    const reply = [
      "select helper in src/helper.ts",
      "replace with",
      BEGIN,
      "export function helper(): number {",
      "  return 5;",
      "}",
      END,
      "",
      "select answer in src/helper.ts",
      "pick 99",
      "replace with",
      BEGIN,
      "return 9;",
      END,
      "",
    ].join("\n");
    const result = run(workspace, ["--protocol-format", "dsl", "--write"], reply);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stage: range");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("unknown flags and empty stdin are usage errors", () => {
    const workspace = makeWorkspace();

    const unknown = run(workspace, ["--bogus"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unexpected argument '--bogus'");

    const emptyDsl = run(workspace, ["--protocol-format", "dsl"], "   \n");
    expect(emptyDsl.status).toBe(2);
    expect(emptyDsl.stderr).toContain("non-empty payload");

    const emptyJson = run(workspace, ["--protocol-format", "json"], "");
    expect(emptyJson.status).toBe(2);
    expect(emptyJson.stderr).toContain("non-empty payload");
  });

  test("native operation flags are rejected with a stdin format", () => {
    const workspace = makeWorkspace();
    const result = run(
      workspace,
      ["--protocol-format", "dsl", "--read", "src/helper.ts"],
      "read src/helper.ts end\n",
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--read");
    expect(result.stderr).toContain("--protocol-format dsl");
  });

  test("--within is rejected with a stdin format", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, ["--protocol-format", "json", "--within", "1-2"], "[]");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--within");
    expect(result.stderr).toContain("--protocol-format json");
  });
});

describe("tsed file-level span select (#83)", () => {
  const SPAN_SOURCE = [
    'import { test } from "bun:test";',
    "",
    'test("answer", () => {',
    "  const value = 1;",
    "  if (value === 1) {",
    '    console.log("ok");',
    "  }",
    "});",
    "",
  ].join("\n");

  const HEADER_PATCH = "if (value === 2) {\n";
  const HEADER_THREE = "if (value === 3) {\n";

  test("numbered read output is the default with 1-based file-absolute lines", () => {
    const workspace = makeWorkspace({ "src/span.test.ts": SPAN_SOURCE });
    const result = run(workspace, ["--read", "src/span.test.ts"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 | import { test } from "bun:test";');
    expect(result.stdout).toContain("8 | });");
    expect(result.stdout).toContain("content folded");
    expect(result.stderr).toBe("");
  });

  test("--select-file --match --replace-file dry-run previews and --write applies", () => {
    const workspace = makeWorkspace({
      "src/span.test.ts": SPAN_SOURCE,
      "patch.txt": HEADER_PATCH,
    });
    const args = [
      "--select-file",
      "src/span.test.ts",
      "--match",
      "if (value === 1) {",
      "--replace-file",
      "patch.txt",
    ];

    const preview = run(workspace, [...args, "--dry-run"]);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("would change: src/span.test.ts");
    expect(preview.stderr).toBe("");
    expect(read(join(workspace, "src/span.test.ts"))).toBe(SPAN_SOURCE);

    const applied = run(workspace, [...args, "--write"]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("changed: src/span.test.ts");
    expect(read(join(workspace, "src/span.test.ts"))).toBe(
      SPAN_SOURCE.replace("if (value === 1) {", "if (value === 2) {"),
    );
  });

  test("--select-file --pick --replace-file edits a file-absolute range", () => {
    const workspace = makeWorkspace({
      "src/span.test.ts": SPAN_SOURCE,
      "patch.txt": HEADER_THREE,
    });
    const result = run(workspace, [
      "--select-file",
      "src/span.test.ts",
      "--pick",
      "5:3-5:20",
      "--replace-file",
      "patch.txt",
      "--write",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("changed: src/span.test.ts");
    expect(read(join(workspace, "src/span.test.ts"))).toBe(
      SPAN_SOURCE.replace("if (value === 1) {", "if (value === 3) {"),
    );
  });

  test("JSON select-file dry-run previews a span edit and writes nothing", () => {
    const workspace = makeWorkspace({ "src/span.test.ts": SPAN_SOURCE });
    const result = run(
      workspace,
      ["--protocol-format", "json", "--dry-run"],
      JSON.stringify({
        operations: [
          {
            op: "select-file",
            path: "src/span.test.ts",
            match: "if (value === 1) {",
            replace: "if (value === 2) {",
          },
        ],
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would change: src/span.test.ts");
    expect(result.stderr).toBe("");
    expect(read(join(workspace, "src/span.test.ts"))).toBe(SPAN_SOURCE);
  });

  test("--select-file --rename is a usage error", () => {
    const workspace = makeWorkspace({ "src/span.test.ts": SPAN_SOURCE });
    const result = run(workspace, [
      "--select-file",
      "src/span.test.ts",
      "--rename",
      "value",
      "--dry-run",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--rename cannot be used with --select-file");
    expect(result.stderr).toContain("usage:");
    expect(read(join(workspace, "src/span.test.ts"))).toBe(SPAN_SOURCE);
  });

  test("--select-file --within is a usage error", () => {
    const workspace = makeWorkspace({ "src/span.test.ts": SPAN_SOURCE });
    const result = run(workspace, [
      "--select-file",
      "src/span.test.ts",
      "--within",
      "5",
      "--dry-run",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--within is viewer-only");
    expect(result.stderr).toContain("--select-file");
    expect(result.stderr).toContain("usage:");
  });

  test("--select-file without a replacement reaches resolution and hints at --replace-file", () => {
    const workspace = makeWorkspace({ "src/span.test.ts": SPAN_SOURCE });
    for (const mode of ["--dry-run", "--write"]) {
      const result = run(workspace, [
        "--select-file",
        "src/span.test.ts",
        "--match",
        "if (value === 1) {",
        mode,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("stage: address");
      expect(result.stderr).toContain("requires `replace with <fence>`");
      expect(result.stderr).toContain("--replace-file");
      expect(result.stdout).not.toContain("would change:");
      expect(result.stdout).not.toContain("changed:");
      expect(read(join(workspace, "src/span.test.ts"))).toBe(SPAN_SOURCE);
    }
  });

  test("an invalid replacement fails the parse gate in dry-run and apply", () => {
    const workspace = makeWorkspace({
      "src/span.test.ts": SPAN_SOURCE,
      "broken.txt": "if (\n",
    });
    const args = [
      "--select-file",
      "src/span.test.ts",
      "--match",
      "if (value === 1) {",
      "--replace-file",
      "broken.txt",
    ];
    for (const mode of ["--dry-run", "--write"]) {
      const result = run(workspace, [...args, mode]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("stage:");
      expect(read(join(workspace, "src/span.test.ts"))).toBe(SPAN_SOURCE);
    }
  });

  test("an ambiguous snippet still fails with both candidate locations", () => {
    const source = [
      "function first(): void {",
      '  console.log("ok");',
      "}",
      "function second(): void {",
      '  console.log("ok");',
      "}",
      "",
    ].join("\n");
    const workspace = makeWorkspace({
      "src/span.test.ts": source,
      "patch.txt": '  console.log("done");\n',
    });
    const result = run(workspace, [
      "--select-file",
      "src/span.test.ts",
      "--match",
      'console.log("ok");',
      "--replace-file",
      "patch.txt",
      "--dry-run",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stage: matcher");
    expect(result.stderr).toContain("resolves to 2 spans");
    expect(result.stderr).toContain("src/span.test.ts:2:3");
    expect(result.stderr).toContain("src/span.test.ts:5:3");
    expect(result.stderr).toContain("exactly one unique span");
    expect(read(join(workspace, "src/span.test.ts"))).toBe(source);
  });
});

describe("tsed cross-file rename", () => {
  const IMPORTER = ['import { helper } from "./b";', "export const n = helper();", ""].join("\n");
  const TARGET = "export function helper(): number { return 1; }\n";

  test("--dry-run reports the target and every importer, then --write updates them", () => {
    const workspace = makeWorkspace({ "src/a.ts": IMPORTER, "src/b.ts": TARGET });
    const args = ["--select", "helper", "--in", "src/b.ts", "--rename", "helper2"];

    const preview = run(workspace, [...args, "--dry-run"]);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("would change: src/a.ts");
    expect(preview.stdout).toContain("would change: src/b.ts");
    expect(preview.stderr).toBe("");
    expect(read(join(workspace, "src/a.ts"))).toBe(IMPORTER);
    expect(read(join(workspace, "src/b.ts"))).toBe(TARGET);

    const applied = run(workspace, [...args, "--write"]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("changed: src/a.ts");
    expect(applied.stdout).toContain("changed: src/b.ts");
    expect(applied.stderr).toBe("");
    expect(read(join(workspace, "src/a.ts"))).toBe(
      ['import { helper2 } from "./b";', "export const n = helper2();", ""].join("\n"),
    );
    expect(read(join(workspace, "src/b.ts"))).toContain("export function helper2");
  });

  test("a collision fails with an address diagnostic and writes nothing", () => {
    const target = [
      "export function helper(): number { return 1; }",
      "export function helper2(): number { return 2; }",
      "",
    ].join("\n");
    const workspace = makeWorkspace({ "src/a.ts": IMPORTER, "src/b.ts": target });
    const result = run(workspace, [
      "--select",
      "helper",
      "--in",
      "src/b.ts",
      "--rename",
      "helper2",
      "--dry-run",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stage: address");
    expect(result.stderr).toContain("collision");
    expect(result.stderr).toContain("helper2");
    expect(result.stdout).not.toContain("would change:");
    expect(read(join(workspace, "src/a.ts"))).toBe(IMPORTER);
    expect(read(join(workspace, "src/b.ts"))).toBe(target);
  });

  test("namespace imports update in dry-run and apply", () => {
    const importer = ['import * as ns from "./b";', "export const n = ns.helper();", ""].join("\n");
    const workspace = makeWorkspace({ "src/a.ts": importer, "src/b.ts": TARGET });
    const args = ["--select", "helper", "--in", "src/b.ts", "--rename", "helper2"];

    const preview = run(workspace, [...args, "--dry-run"]);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("would change: src/a.ts");
    expect(preview.stdout).toContain("would change: src/b.ts");
    expect(preview.stderr).toBe("");
    expect(read(join(workspace, "src/a.ts"))).toBe(importer);
    expect(read(join(workspace, "src/b.ts"))).toBe(TARGET);

    const applied = run(workspace, [...args, "--write"]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("changed: src/a.ts");
    expect(applied.stdout).toContain("changed: src/b.ts");
    expect(applied.stderr).toBe("");
    expect(read(join(workspace, "src/a.ts"))).toBe(
      ['import * as ns from "./b";', "export const n = ns.helper2();", ""].join("\n"),
    );
    expect(read(join(workspace, "src/b.ts"))).toContain("export function helper2");
  });

  test("a dynamic namespace access fails with an address diagnostic", () => {
    const importer = [
      'import * as ns from "./b";',
      'const key = "helper";',
      "export const n = ns[key];",
      "",
    ].join("\n");
    const workspace = makeWorkspace({ "src/a.ts": importer, "src/b.ts": TARGET });
    const result = run(workspace, [
      "--select",
      "helper",
      "--in",
      "src/b.ts",
      "--rename",
      "helper2",
      "--dry-run",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stage: address");
    expect(result.stderr).toContain("computed");
    expect(result.stderr).toContain("src/a.ts");
    expect(result.stderr).toContain("ns[key]");
    expect(result.stdout).not.toContain("would change:");
    expect(read(join(workspace, "src/a.ts"))).toBe(importer);
    expect(read(join(workspace, "src/b.ts"))).toBe(TARGET);
  });

  test("static string-keyed namespace accesses rename in dry-run and apply", () => {
    const importer = [
      'import * as ns from "./b";',
      'export const n = ns["helper"];',
      'export const m = ns?.["helper"];',
      "",
    ].join("\n");
    const workspace = makeWorkspace({ "src/a.ts": importer, "src/b.ts": TARGET });
    const args = ["--select", "helper", "--in", "src/b.ts", "--rename", "helper2"];

    const preview = run(workspace, [...args, "--dry-run"]);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("would change: src/a.ts");
    expect(preview.stdout).toContain("would change: src/b.ts");
    expect(preview.stderr).toBe("");
    expect(read(join(workspace, "src/a.ts"))).toBe(importer);

    const applied = run(workspace, [...args, "--write"]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("changed: src/a.ts");
    expect(applied.stderr).toBe("");
    expect(read(join(workspace, "src/a.ts"))).toBe(
      [
        'import * as ns from "./b";',
        'export const n = ns["helper2"];',
        'export const m = ns?.["helper2"];',
        "",
      ].join("\n"),
    );
    expect(read(join(workspace, "src/b.ts"))).toContain("export function helper2");
  });

  test("static object-destructuring keys rename in dry-run and apply", () => {
    const importer = [
      'import * as ns from "./b";',
      "const { helper } = ns;",
      "export const n = helper();",
      "",
    ].join("\n");
    const workspace = makeWorkspace({ "src/a.ts": importer, "src/b.ts": TARGET });
    const args = ["--select", "helper", "--in", "src/b.ts", "--rename", "helper2"];

    const preview = run(workspace, [...args, "--dry-run"]);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("would change: src/a.ts");
    expect(preview.stdout).toContain("would change: src/b.ts");
    expect(preview.stderr).toBe("");
    expect(read(join(workspace, "src/a.ts"))).toBe(importer);

    const applied = run(workspace, [...args, "--write"]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("changed: src/a.ts");
    expect(applied.stderr).toBe("");
    expect(read(join(workspace, "src/a.ts"))).toBe(
      [
        'import * as ns from "./b";',
        "const { helper2: helper } = ns;",
        "export const n = helper();",
        "",
      ].join("\n"),
    );
    expect(read(join(workspace, "src/b.ts"))).toContain("export function helper2");
  });

  test("dynamic object-destructuring keys fail with an address diagnostic", () => {
    const importer = [
      'import * as ns from "./b";',
      'const key = "helper";',
      "const { [key]: local } = ns;",
      "",
    ].join("\n");
    const workspace = makeWorkspace({ "src/a.ts": importer, "src/b.ts": TARGET });
    const result = run(workspace, [
      "--select",
      "helper",
      "--in",
      "src/b.ts",
      "--rename",
      "helper2",
      "--dry-run",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stage: address");
    expect(result.stderr).toContain("destructuring");
    expect(result.stderr).toContain("src/a.ts");
    expect(result.stdout).not.toContain("would change:");
    expect(read(join(workspace, "src/a.ts"))).toBe(importer);
    expect(read(join(workspace, "src/b.ts"))).toBe(TARGET);
  });

  test("resolves tsconfig path aliases in dry-run and apply", () => {
    const importer = ['import { helper } from "@/b";', "export const n = helper();", ""].join("\n");
    const workspace = makeWorkspace({
      "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n',
      "src/a.ts": importer,
      "src/b.ts": TARGET,
    });
    const args = ["--select", "helper", "--in", "src/b.ts", "--rename", "helper2"];

    const preview = run(workspace, [...args, "--dry-run"]);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("would change: src/a.ts");
    expect(preview.stdout).toContain("would change: src/b.ts");
    expect(preview.stderr).toBe("");
    expect(read(join(workspace, "src/a.ts"))).toBe(importer);
    expect(read(join(workspace, "src/b.ts"))).toBe(TARGET);

    const applied = run(workspace, [...args, "--write"]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("changed: src/a.ts");
    expect(applied.stdout).toContain("changed: src/b.ts");
    expect(applied.stderr).toBe("");
    expect(read(join(workspace, "src/a.ts"))).toBe(
      ['import { helper2 } from "@/b";', "export const n = helper2();", ""].join("\n"),
    );
    expect(read(join(workspace, "src/b.ts"))).toContain("export function helper2");
  });

  test("an unresolved path alias fails at address with the specifier", () => {
    const importer = ['import { helper } from "@/missing";', "export const n = helper();", ""].join(
      "\n",
    );
    const workspace = makeWorkspace({
      "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n',
      "src/a.ts": importer,
      "src/b.ts": TARGET,
    });
    const result = run(workspace, [
      "--select",
      "helper",
      "--in",
      "src/b.ts",
      "--rename",
      "helper2",
      "--dry-run",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stage: address");
    expect(result.stderr).toContain("src/a.ts");
    expect(result.stderr).toContain("@/missing");
    expect(result.stderr).toContain("paths");
    expect(result.stdout).not.toContain("would change:");
    expect(read(join(workspace, "src/a.ts"))).toBe(importer);
    expect(read(join(workspace, "src/b.ts"))).toBe(TARGET);
  });

  test("a protected target path is rejected", () => {
    const workspace = makeWorkspace({ "human/b.ts": TARGET });
    const result = run(workspace, [
      "--select",
      "helper",
      "--in",
      "human/b.ts",
      "--rename",
      "helper2",
      "--dry-run",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside the editable workspace");
    expect(read(join(workspace, "human/b.ts"))).toBe(TARGET);
  });
});

describe("tsed match with rename", () => {
  test("native flags reject match with rename", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--match",
      "THIS DOES NOT EXIST",
      "--rename",
      "result",
      "--dry-run",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("match and rename are mutually exclusive");
    expect(result.stdout).toBe("");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("DSL rejects match with rename", () => {
    const workspace = makeWorkspace();
    const reply = [
      "select answer in src/helper.ts",
      "match `THIS DOES NOT EXIST`",
      "rename answer to result",
      "end",
      "",
    ].join("\n");
    const result = run(workspace, ["--protocol-format", "dsl", "--dry-run"], reply);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stage: syntax");
    expect(result.stderr).toContain("rename cannot be combined with `match`");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });
});

describe("tsed --unify and select block (#84)", () => {
  const UNIFY_SOURCE = [
    "export function outer(): number {",
    "  let total = 0;",
    "  if (true) {",
    "    total += 1;",
    "    total += 2;",
    "    total += 3;",
    "    total += 4;",
    "    total += 5;",
    "    total += 6;",
    "  }",
    "  return total;",
    "}",
    "",
  ].join("\n");

  const BLOCK_DSL = [
    "select block outer:2 in src/unify.ts",
    "replace with",
    BEGIN,
    "{",
    "    total += 42;",
    "  }",
    END,
    "end",
    "",
  ].join("\n");

  const AFTER_BLOCK = [
    "export function outer(): number {",
    "  let total = 0;",
    "  if (true) {",
    "    total += 42;",
    "  }",
    "  return total;",
    "}",
    "",
  ].join("\n");

  function unifyWorkspace(files: Record<string, string> = {}): string {
    return makeWorkspace({ "src/unify.ts": UNIFY_SOURCE, ...files });
  }

  test("--unify prints numbered source with block markers and writes nothing", () => {
    const workspace = unifyWorkspace();
    const before = read(join(workspace, "src/unify.ts"));
    const result = run(workspace, ["--unify", "src/unify.ts"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(" 1 | export function outer(): number { // outer:1");
    expect(result.stdout).toContain(" 2 |   let total = 0;");
    expect(result.stdout).toContain(" 3 |   if (true) { // outer:2");
    expect(result.stdout).toContain("10 |   }");
    expect(result.stdout).toContain("12 | }");
    expect(result.stdout).not.toContain(" 2 | export function outer");
    expect(result.stderr).toBe("");
    expect(read(join(workspace, "src/unify.ts"))).toBe(before);
  });

  test("--unify is repeatable and honors --unify-min-lines", () => {
    const workspace = unifyWorkspace({ "src/other.ts": "export const other = 1;\n" });
    const all = run(workspace, [
      "--unify",
      "src/unify.ts",
      "--unify",
      "src/other.ts",
      "--unify-min-lines",
      "9",
    ]);
    expect(all.status).toBe(0);
    expect(all.stdout).toContain("src/unify.ts (unified view");
    expect(all.stdout).toContain("src/other.ts (unified view");
    expect(all.stdout).toContain("// outer:1");
    expect(all.stdout).not.toContain("// outer:2");

    const zero = run(workspace, ["--unify", "src/unify.ts", "--unify-min-lines", "0"]);
    expect(zero.status).toBe(0);
    expect(zero.stdout).toContain("// outer:1");
    expect(zero.stdout).toContain("// outer:2");
  });

  test("a marker after a line comment stays on the opening line", () => {
    const source = [
      "export function f(): number {",
      "  if (true) { // keep this",
      "    let x = 0;",
      "    x += 1;",
      "    x += 2;",
      "    x += 3;",
      "    x += 4;",
      "    x += 5;",
      "  }",
      "  return 0;",
      "}",
      "",
    ].join("\n");
    const workspace = unifyWorkspace({ "src/comment.ts": source });
    const result = run(workspace, ["--unify", "src/comment.ts"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(" 2 |   if (true) { // keep this // f:2");
    expect(read(join(workspace, "src/comment.ts"))).toBe(source);
  });

  test("--unify rejects every mutation, protocol, and operation flag", () => {
    const workspace = unifyWorkspace({ "patch.txt": UNIFY_SOURCE });
    const cases: string[][] = [
      ["--unify", "src/unify.ts", "--write"],
      ["--unify", "src/unify.ts", "--dry-run"],
      ["--unify", "src/unify.ts", "--diff"],
      ["--unify", "src/unify.ts", "--protocol-format", "dsl"],
      ["--unify", "src/unify.ts", "--read", "src/unify.ts"],
      ["--unify", "src/unify.ts", "--select", "outer", "--in", "src/unify.ts"],
      ["--unify", "src/unify.ts", "--match", "outer"],
      ["--unify", "src/unify.ts", "--pick", "1"],
      ["--unify", "src/unify.ts", "--within", "1-2"],
      ["--unify", "src/unify.ts", "--rename", "x"],
      ["--unify", "src/unify.ts", "--create", "src/new.ts"],
      ["--unify", "src/unify.ts", "--delete", "src/unify.ts"],
      ["--unify", "src/unify.ts", "--rewrite", "src/unify.ts"],
      ["--unify", "src/unify.ts", "--content-file", "patch.txt"],
    ];
    for (const args of cases) {
      const result = run(workspace, args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("cannot be used with --unify");
      expect(result.stderr).toContain("usage:");
      expect(read(join(workspace, "src/unify.ts"))).toBe(UNIFY_SOURCE);
    }
    expect(existsSync(join(workspace, "src/new.ts"))).toBe(false);
  });

  test("--unify-min-lines requires --unify and a non-negative integer", () => {
    const workspace = unifyWorkspace();
    const alone = run(workspace, ["--unify-min-lines", "8"]);
    expect(alone.status).toBe(2);
    expect(alone.stderr).toContain("--unify-min-lines requires --unify");

    const negative = run(workspace, ["--unify", "src/unify.ts", "--unify-min-lines=-1"]);
    expect(negative.status).toBe(2);
    expect(negative.stderr).toContain("non-negative integer");

    const fraction = run(workspace, ["--unify", "src/unify.ts", "--unify-min-lines=1.5"]);
    expect(fraction.status).toBe(2);
    expect(fraction.stderr).toContain("non-negative integer");
  });

  test("--unify reports missing, non-file, unsafe, and unparseable paths", () => {
    const workspace = unifyWorkspace({
      "src/broken.ts": "export function broken( {\n",
    });
    mkdirSync(join(workspace, "src/dir"));
    const cases: { args: string[]; fragment: string }[] = [
      { args: ["--unify", "src/missing.ts"], fragment: "does not exist" },
      { args: ["--unify", "src/dir"], fragment: "not a regular file" },
      { args: ["--unify", "../outside.ts"], fragment: "outside the editable workspace" },
      { args: ["--unify", "src/broken.ts"], fragment: "does not parse" },
    ];
    for (const { args, fragment } of cases) {
      const result = run(workspace, args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(fragment);
      expect(result.stdout).toBe("");
    }
  });

  test("dsl dry-run previews a block replacement and writes nothing", () => {
    const workspace = unifyWorkspace();
    const result = run(workspace, ["--protocol-format", "dsl", "--dry-run"], BLOCK_DSL);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would change: src/unify.ts");
    expect(result.stdout).not.toContain("changed: src/unify.ts");
    expect(result.stderr).toBe("");
    expect(read(join(workspace, "src/unify.ts"))).toBe(UNIFY_SOURCE);
  });

  test("dsl apply and dry-run --diff agree on a block replacement", () => {
    const workspace = unifyWorkspace();
    const preview = run(workspace, ["--protocol-format", "dsl", "--dry-run", "--diff"], BLOCK_DSL);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("-    total += 1;");
    expect(preview.stdout).toContain("+    total += 42;");
    expect(read(join(workspace, "src/unify.ts"))).toBe(UNIFY_SOURCE);

    const applied = run(workspace, ["--protocol-format", "dsl", "--write"], BLOCK_DSL);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("changed: src/unify.ts");
    expect(read(join(workspace, "src/unify.ts"))).toBe(AFTER_BLOCK);
  });

  test("dsl block match and pick narrow the applied span", () => {
    const workspace = unifyWorkspace();
    const matchReply = [
      "select block outer:2 in src/unify.ts",
      "match `total += 2;`",
      "replace with",
      BEGIN,
      "total += 22;",
      END,
    ].join("\n");
    const matched = run(workspace, ["--protocol-format", "dsl", "--write"], matchReply);
    expect(matched.status).toBe(0);
    expect(read(join(workspace, "src/unify.ts"))).toContain("    total += 22;");

    const picked = run(
      workspace,
      ["--protocol-format", "dsl", "--dry-run"],
      [
        "select block outer:2 in src/unify.ts",
        "pick 4",
        "replace with",
        BEGIN,
        "    total += 42;",
        END,
      ].join("\n"),
    );
    expect(picked.status).toBe(0);
    expect(picked.stdout).toContain("would change: src/unify.ts");
  });

  test("dsl bad block IDs fail at address and write nothing", () => {
    const workspace = unifyWorkspace();
    const reply = ["select block outer:99 in src/unify.ts", "replace with", BEGIN, "x", END].join(
      "\n",
    );
    const result = run(workspace, ["--protocol-format", "dsl", "--write"], reply);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stage: address");
    expect(result.stderr).toContain("--unify");
    expect(read(join(workspace, "src/unify.ts"))).toBe(UNIFY_SOURCE);
  });

  test("dsl invalid block replacement fails the gate and writes nothing", () => {
    const workspace = unifyWorkspace();
    const reply = ["select block outer:2 in src/unify.ts", "replace with", BEGIN, "{", END].join(
      "\n",
    );
    const result = run(workspace, ["--protocol-format", "dsl", "--write"], reply);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stage: gate");
    expect(read(join(workspace, "src/unify.ts"))).toBe(UNIFY_SOURCE);
  });
});

describe("tsed pick-before/pick-after anchors (#93)", () => {
  const INSERTED = [
    "export function helper(): number {",
    "  return 1;",
    "}",
    "",
    "export function answer(): number {",
    "  return 1;",
    "  return 2;",
    "}",
    "",
  ].join("\n");

  test("--select --pick-after dry-run previews and --write inserts", () => {
    const workspace = makeWorkspace({ "patch.txt": "\n  return 2;" });
    const args = [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--pick-after",
      "return 1;",
      "--replace-file",
      "patch.txt",
    ];

    const preview = run(workspace, [...args, "--dry-run", "--diff"]);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("would change: src/helper.ts");
    expect(preview.stdout).toContain("+  return 2;");
    expect(preview.stderr).toBe("");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);

    const applied = run(workspace, [...args, "--write"]);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("changed: src/helper.ts");
    expect(read(join(workspace, "src/helper.ts"))).toBe(INSERTED);
  });

  test("--select-file --pick-before resolves a unique file-level literal", () => {
    const workspace = makeWorkspace({ "patch.txt": "// answer\n" });
    const result = run(workspace, [
      "--select-file",
      "src/helper.ts",
      "--pick-before",
      "export function answer(): number {",
      "--replace-file",
      "patch.txt",
      "--write",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("changed: src/helper.ts");
    expect(read(join(workspace, "src/helper.ts"))).toBe(
      HELPER.replace("export function answer", "// answer\nexport function answer"),
    );
  });

  test("a JSON pickAfter operation previews an anchor insertion", () => {
    const workspace = makeWorkspace();
    const payload = JSON.stringify({
      operations: [
        {
          op: "select",
          symbol: "answer",
          path: "src/helper.ts",
          pickAfter: "return 1;",
          replace: "\n  return 2;",
        },
      ],
    });
    const result = run(workspace, ["--protocol-format", "json", "--dry-run"], payload);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would change: src/helper.ts");
    expect(result.stderr).toBe("");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("anchor flags are mutually exclusive with pick, match, rename, and each other", () => {
    const workspace = makeWorkspace({ "patch.txt": "x" });
    const cases: { args: string[]; message: string }[] = [
      {
        args: [
          "--select",
          "answer",
          "--in",
          "src/helper.ts",
          "--pick-before",
          "return 1;",
          "--pick-after",
          "return 1;",
          "--replace-file",
          "patch.txt",
          "--dry-run",
        ],
        message: "--pick-before and --pick-after are mutually exclusive",
      },
      {
        args: [
          "--select",
          "answer",
          "--in",
          "src/helper.ts",
          "--pick-before",
          "return 1;",
          "--pick",
          "2",
          "--replace-file",
          "patch.txt",
          "--dry-run",
        ],
        message: "--pick-before and --pick are mutually exclusive",
      },
      {
        args: [
          "--select",
          "answer",
          "--in",
          "src/helper.ts",
          "--pick-after",
          "return 1;",
          "--match",
          "return 1;",
          "--replace-file",
          "patch.txt",
          "--dry-run",
        ],
        message: "--pick-after and --match are mutually exclusive",
      },
      {
        args: [
          "--select",
          "answer",
          "--in",
          "src/helper.ts",
          "--pick-after",
          "return 1;",
          "--rename",
          "value",
          "--dry-run",
        ],
        message: "--pick-after and --rename are mutually exclusive",
      },
    ];
    for (const { args, message } of cases) {
      const result = run(workspace, args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain("usage:");
      expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
    }
  });

  test("an anchor without --replace-file is a usage error", () => {
    const workspace = makeWorkspace();
    const result = run(workspace, [
      "--select",
      "answer",
      "--in",
      "src/helper.ts",
      "--pick-after",
      "return 1;",
      "--dry-run",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--pick-after requires --replace-file");
    expect(result.stderr).toContain("an anchor is an insertion point, not a viewer");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
  });

  test("an invalid anchor insertion fails the parse gate and writes nothing", () => {
    const workspace = makeWorkspace({ "broken.txt": "if (\n" });
    for (const mode of ["--dry-run", "--write"]) {
      const result = run(workspace, [
        "--select",
        "answer",
        "--in",
        "src/helper.ts",
        "--pick-after",
        "return 1;",
        "--replace-file",
        "broken.txt",
        mode,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("stage: gate");
      expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
    }
  });

  test("an empty replacement file is a no-op failure", () => {
    const workspace = makeWorkspace({ "empty.txt": "" });
    for (const mode of ["--dry-run", "--write"]) {
      const result = run(workspace, [
        "--select",
        "answer",
        "--in",
        "src/helper.ts",
        "--pick-after",
        "return 1;",
        "--replace-file",
        "empty.txt",
        mode,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("stage: no-op");
      expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
    }
  });
});
