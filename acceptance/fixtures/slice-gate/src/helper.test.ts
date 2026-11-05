import { expect, test } from "bun:test";
import { answer, label } from "./helper";

test("answer", () => {
  expect(answer()).toBe(2);
});

test("label", () => {
  expect(label()).toBe("helper");
});
