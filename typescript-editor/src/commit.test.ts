import { describe, expect, test } from "bun:test";
import { applyResolvedRegions, parseCheck } from "./commit";
import type { CommittableRegion, CommitPolicy, RegionFailureNote } from "./commit";

function create(path: string, name: string, text: string): CommittableRegion {
  return {
    index: name === "Alpha" ? 0 : 1,
    path,
    locator: { path, name, kind: "const" },
    start: 0,
    end: 0,
    text,
    replacement: text.trim(),
    create: true,
  };
}

function run(policy?: CommitPolicy) {
  const failures: RegionFailureNote<CommittableRegion>[] = [];
  const overlaps: [string, string][] = [];
  const regions = [
    create("src/new.ts", "Alpha", "const Alpha = 1;\n"),
    create("src/new.ts", "Beta", "const Beta = 2;\n"),
  ];
  return {
    result: applyResolvedRegions({
      regions,
      fileSourceOf: () => "",
      target: "src/new.ts",
      prevCheck: parseCheck(""),
      policy,
      noteFailure: (note) => failures.push(note),
      noteOverlap: (path, earlier, later) =>
        overlaps.push([earlier.locator.name, later.locator.name]),
    }),
    failures,
    overlaps,
  };
}

describe("applyResolvedRegions commit policy", () => {
  test("same-offset inserts overlap by default", async () => {
    const { result, failures, overlaps } = run();
    expect(await result).toEqual([]);
    expect(failures).toEqual([]);
    expect(overlaps).toEqual([["Alpha", "Beta"]]);
  });

  test("same-offset inserts append in clause order under the policy", async () => {
    const { result, failures, overlaps } = run({ sameOffsetInserts: "append" });
    const writes = await result;
    expect(overlaps).toEqual([]);
    expect(failures).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.source).toBe("const Alpha = 1;\nconst Beta = 2;\n");
  });

  test("a zero-width insert on a span boundary is disjoint (#92)", async () => {
    const failures: RegionFailureNote<CommittableRegion>[] = [];
    const overlaps: [string, string][] = [];
    const region = (name: string, start: number, end: number, text: string): CommittableRegion => ({
      index: 0,
      path: "src/a.ts",
      locator: { path: "src/a.ts", name, kind: "const" },
      start,
      end,
      text,
      replacement: text,
      create: false,
    });
    const source = "const value = 1;\n";
    const writes = await applyResolvedRegions({
      regions: [
        region("Value", 0, "const value = 1;".length, "const value = 2;"),
        region("Before", 0, 0, "// before\n"),
      ],
      fileSourceOf: () => source,
      target: "src/a.ts",
      prevCheck: parseCheck(source),
      policy: { sameOffsetInserts: "append" },
      noteFailure: (note) => failures.push(note),
      noteOverlap: (path, earlier, later) =>
        overlaps.push([earlier.locator.name, later.locator.name]),
    });
    expect(overlaps).toEqual([]);
    expect(failures).toEqual([]);
    expect(writes[0]?.source).toBe("// before\nconst value = 2;\n");
  });

  test("overlapping non-zero spans stay rejected (#92)", async () => {
    const failures: RegionFailureNote<CommittableRegion>[] = [];
    const overlaps: [string, string][] = [];
    const region = (name: string, start: number, end: number, text: string): CommittableRegion => ({
      index: 0,
      path: "src/a.ts",
      locator: { path: "src/a.ts", name, kind: "const" },
      start,
      end,
      text,
      replacement: text,
      create: false,
    });
    const source = "const value = 1;\n";
    const writes = await applyResolvedRegions({
      regions: [region("Value", 0, 11, "const value = 2;"), region("Later", 5, 15, "other = 3;")],
      fileSourceOf: () => source,
      target: "src/a.ts",
      prevCheck: parseCheck(source),
      noteFailure: (note) => failures.push(note),
      noteOverlap: (path, earlier, later) =>
        overlaps.push([earlier.locator.name, later.locator.name]),
    });
    expect(overlaps).toEqual([["Value", "Later"]]);
    expect(failures).toEqual([]);
    expect(writes).toEqual([]);
  });
});
