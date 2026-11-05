import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
    expect(result.stdout).toContain("src/helper.ts (selected lines, 2 lines):");
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
    expect(result.stdout).toContain("select answer in src/helper.ts within 6-7");
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
    expect(result.stderr).toBe("");
    expect(read(join(workspace, "src/helper.ts"))).toBe(HELPER);
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
