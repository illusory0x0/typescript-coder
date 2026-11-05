import { expect, test } from "bun:test";
import { greet, name } from "./index";

test("scaffold is wired", () => {
  expect(name).toBe("typescript-coder");
  expect(greet("world")).toBe("hello, world");
});
