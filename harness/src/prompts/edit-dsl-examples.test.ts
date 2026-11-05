import { describe, expect, test } from "bun:test";
import {
  parseMultiEditor,
  parseSelection,
  serializeSelections,
} from "@tc/typescript-editor/selection";
import { EDIT_DSL_EXAMPLE_FORMS } from "./edit-dsl";

const BEGIN = "TC_EDIT_BEGIN";
const END = "TC_EDIT_END";

describe("prompt examples", () => {
  test("every edit-dsl example is a parseable canonical reply", () => {
    for (const form of EDIT_DSL_EXAMPLE_FORMS) {
      if ("raw" in form) {
        expect(() => parseMultiEditor(form.raw)).not.toThrow();
      } else {
        const reply = serializeSelections(form.selections);
        expect(() => parseSelection(reply)).not.toThrow();
      }
    }
  });

  test("every fence marker in the examples is a whole line", () => {
    for (const form of EDIT_DSL_EXAMPLE_FORMS) {
      const reply = "raw" in form ? form.raw : serializeSelections(form.selections);
      const lines = reply.split("\n");
      for (const line of lines) {
        if (!line.includes(BEGIN) && !line.includes(END)) {
          continue;
        }
        expect(line.trim()).toBe(line.includes(BEGIN) ? BEGIN : END);
      }
      for (const [index, line] of lines.entries()) {
        if (line.trim() !== END) {
          continue;
        }
        expect(lines[index + 1]?.trim()).not.toBe("end");
      }
    }
  });
});
