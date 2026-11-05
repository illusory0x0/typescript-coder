import { describe, expect, test } from "bun:test";
import { unifiedDiff } from "./unified-diff";

describe("unifiedDiff", () => {
  test("renders a modification with three lines of context", () => {
    const diff = unifiedDiff({
      path: "src/a.ts",
      oldSource: "one\ntwo\nthree\nfour\nfive\n",
      newSource: "one\ntwo\nTHREE\nfour\nfive\n",
    });
    expect(diff).toBe(
      [
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,5 +1,5 @@",
        " one",
        " two",
        "-three",
        "+THREE",
        " four",
        " five",
        "",
      ].join("\n"),
    );
  });

  test("uses /dev/null for a missing side", () => {
    expect(unifiedDiff({ path: "a.ts", oldSource: "", newSource: "one\n", oldMissing: true })).toBe(
      ["--- /dev/null", "+++ b/a.ts", "@@ -0,0 +1 @@", "+one", ""].join("\n"),
    );
    expect(unifiedDiff({ path: "a.ts", oldSource: "one\n", newSource: "", newMissing: true })).toBe(
      ["--- a/a.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-one", ""].join("\n"),
    );
  });

  test("marks one or both sides without a trailing newline", () => {
    const diff = unifiedDiff({ path: "a.ts", oldSource: "one", newSource: "two" });
    expect(diff).toBe(
      [
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1 @@",
        "-one",
        "\\ No newline at end of file",
        "+two",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });

  test("splits separated changes into hunks and returns nothing for equal sources", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const oldSource = `${lines.join("\n")}\n`;
    const changed = [...lines];
    changed[1] = "line two";
    changed[15] = "line sixteen";
    const newSource = `${changed.join("\n")}\n`;

    const diff = unifiedDiff({ path: "a.ts", oldSource, newSource });

    expect(diff.match(/^@@ /gm)).toHaveLength(2);
    expect(unifiedDiff({ path: "a.ts", oldSource, newSource: oldSource })).toBe("");
  });
});
