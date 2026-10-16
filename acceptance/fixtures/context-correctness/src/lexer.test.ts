import { expect, test } from "bun:test";
import { lexer } from "./lexer";

test("lexer.make", () => {
  expect(lexer.make()).toBe(10);
});
