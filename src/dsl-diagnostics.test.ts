import { describe, expect, test } from "bun:test";
import {
  DSL_ISSUE_LIMIT,
  positionAtOffset,
  renderDslIssues,
  renderExcerpt,
} from "./dsl-diagnostics";
import type { DslIssue } from "./dsl-diagnostics";

function issue(overrides: Partial<DslIssue> = {}): DslIssue {
  return {
    severity: "error",
    stage: "syntax",
    code: "EDIT_TEST",
    message: "the clause is malformed",
    line: 2,
    column: 3,
    excerpt: "select answer in a.ts\nmatch\nend",
    expected: ["end"],
    found: "match",
    hint: "close the clause",
    recovered: false,
    ...overrides,
  };
}

describe("renderDslIssues", () => {
  test("renders stage, code, position, excerpt, caret, expected, found, hint, and identity", () => {
    const rendered = renderDslIssues([issue({ recordId: "04-change", clauseIndex: 2 })]);
    expect(rendered.startsWith("stage: syntax\n")).toBe(true);
    expect(rendered).toContain("code: EDIT_TEST");
    expect(rendered).toContain("message: the clause is malformed");
    expect(rendered).toContain("at line 2:3");
    expect(rendered).toContain("1 | select answer in a.ts");
    expect(rendered).toContain("2 | match");
    expect(rendered).toContain("  |   ^");
    expect(rendered).toContain("expected: end");
    expect(rendered).toContain("found: match");
    expect(rendered).toContain("hint: close the clause");
    expect(rendered).toContain("record: 04-change");
    expect(rendered).toContain("clause: 2");
  });

  test("marks warnings without blocking", () => {
    const rendered = renderDslIssues([
      issue({ severity: "warning", code: "EDIT_MISSING_END", recovered: true }),
    ]);
    expect(rendered).toContain("severity: warning");
    expect(rendered).toContain("code: EDIT_MISSING_END");
  });

  test("renders errors before warnings without dropping the warning", () => {
    const rendered = renderDslIssues([
      issue({
        severity: "warning",
        code: "EDIT_INLINE_FENCE_OPEN",
        message: "the fence opener shares a line with with",
        recovered: true,
      }),
      issue({ code: "EDIT_MISSING_FIELD", message: "expected a statement" }),
    ]);
    expect(rendered.startsWith("stage: syntax\ncode: EDIT_MISSING_FIELD")).toBe(true);
    expect(rendered).toContain("code: EDIT_INLINE_FENCE_OPEN");
    expect(rendered.indexOf("code: EDIT_MISSING_FIELD")).toBeLessThan(
      rendered.indexOf("code: EDIT_INLINE_FENCE_OPEN"),
    );
  });

  test("keeps errors visible when warnings would exceed the display limit", () => {
    const warnings = Array.from({ length: DSL_ISSUE_LIMIT + 1 }, (_, index) =>
      issue({ severity: "warning", code: `EDIT_WARN_${index}`, recovered: true }),
    );
    const rendered = renderDslIssues([
      ...warnings,
      issue({ code: "EDIT_REAL_ERROR", message: "the blocking problem" }),
    ]);
    expect(rendered).toContain("code: EDIT_REAL_ERROR");
    expect(rendered).toContain("code: EDIT_WARN_0");
    expect(rendered).toContain("… 2 more issue(s)");
  });

  test(`bounds the output to the first ${DSL_ISSUE_LIMIT} issues plus a count`, () => {
    const many = Array.from({ length: DSL_ISSUE_LIMIT + 2 }, (_, index) =>
      issue({ code: `EDIT_${index}`, line: index + 1, excerpt: `line ${index + 1}` }),
    );
    const rendered = renderDslIssues(many);
    expect(rendered).toContain("code: EDIT_0");
    expect(rendered).toContain(`code: EDIT_${DSL_ISSUE_LIMIT - 1}`);
    expect(rendered).not.toContain(`code: EDIT_${DSL_ISSUE_LIMIT}`);
    expect(rendered).toContain("… 2 more issue(s)");
    expect(renderDslIssues(many, { limit: 1 })).toContain("… 9 more issue(s)");
  });
});

describe("excerpt helpers", () => {
  test("computes 1-based line/column from an offset", () => {
    expect(positionAtOffset("a\nbc\nd", 0)).toEqual({ line: 1, column: 1 });
    expect(positionAtOffset("a\nbc\nd", 2)).toEqual({ line: 2, column: 1 });
    expect(positionAtOffset("a\nbc\nd", 4)).toEqual({ line: 2, column: 3 });
    expect(positionAtOffset("a\nbc\nd", 99)).toEqual({ line: 3, column: 2 });
  });

  test("shows a window around a caret far into a long line", () => {
    const long = `${"x".repeat(120)}needle${"y".repeat(120)}`;
    const lines = renderExcerpt(long, 1, 125);
    expect(lines).toHaveLength(2);
    const [text, caret] = lines;
    expect(text).toContain("needle");
    expect(text?.startsWith("1 | …")).toBe(true);
    expect(caret?.trimEnd().endsWith("^")).toBe(true);
  });
});
