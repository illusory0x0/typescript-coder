import { expect, test } from "bun:test";
import { answer } from "./helper";

test("answer", () => {
  expect(answer()).toBe(2);
});
