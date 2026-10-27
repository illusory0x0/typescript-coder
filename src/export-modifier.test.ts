import { describe, expect, test } from "bun:test";
import {
  addLeadingExportModifier,
  hasLeadingExportModifier,
  leadingExportModifierSpan,
  stripLeadingExportModifier,
} from "./export-modifier";

describe("leading export modifier", () => {
  test("detects export after whitespace and comments", () => {
    expect(hasLeadingExportModifier("export const x = 1;")).toBe(true);
    expect(hasLeadingExportModifier("\n  export const x = 1;")).toBe(true);
    expect(hasLeadingExportModifier("// note\nexport const x = 1;")).toBe(true);
    expect(hasLeadingExportModifier("/* note */\nexport const x = 1;")).toBe(true);
    expect(hasLeadingExportModifier("/* export */ const x = 1;")).toBe(false);
    expect(hasLeadingExportModifier("// export\nconst x = 1;")).toBe(false);
    expect(hasLeadingExportModifier("exportedFunction();")).toBe(false);
    expect(hasLeadingExportModifier("const x = 1;")).toBe(false);
  });

  test("locates the modifier span without touching leading comments", () => {
    expect(leadingExportModifierSpan("// note\nexport const x = 1;")).toEqual({
      start: 8,
      end: 14,
    });
    expect(leadingExportModifierSpan("export default function f() {}")).toEqual({
      start: 0,
      end: 14,
    });
    expect(leadingExportModifierSpan("export default function f() {}", false)).toEqual({
      start: 0,
      end: 6,
    });
    expect(leadingExportModifierSpan("const x = 1;")).toBeNull();
  });

  test("strips only the leading modifier and keeps comments", () => {
    expect(stripLeadingExportModifier("// note\nexport const x = 1;")).toBe(
      "// note\nconst x = 1;",
    );
    expect(stripLeadingExportModifier("/* note */ export function f() {}")).toBe(
      "/* note */ function f() {}",
    );
    expect(stripLeadingExportModifier("export default function f() {}")).toBe("function f() {}");
    expect(stripLeadingExportModifier("export default function f() {}", false)).toBe(
      "default function f() {}",
    );
    expect(stripLeadingExportModifier("const x = 1;")).toBe("const x = 1;");
  });

  test("adds the modifier after leading comments and is idempotent", () => {
    expect(addLeadingExportModifier("// note\nconst x = 1;")).toBe("// note\nexport const x = 1;");
    expect(addLeadingExportModifier("/* note */ function f() {}")).toBe(
      "/* note */ export function f() {}",
    );
    expect(addLeadingExportModifier("// note\nexport const x = 1;")).toBe(
      "// note\nexport const x = 1;",
    );
  });
});
