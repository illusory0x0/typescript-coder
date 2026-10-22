import { expect, test } from "bun:test";
import { getAnswer } from "./helper";

test("getAnswer", () => {
  expect(getAnswer()).toBe(1);
});
