import { describe, expect, test } from "bun:test";
import { parseCsv } from "./csv";

describe("csv-parser rows", () => {
  test("empty input yields no rows", () => {
    expect(parseCsv("")).toEqual([]);
  });

  test("a single row of fields", () => {
    expect(parseCsv("a,b,c")).toEqual([["a", "b", "c"]]);
  });

  test("multiple rows separated by LF", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("rows separated by CRLF", () => {
    expect(parseCsv("a,b\r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("a trailing newline does not add a row", () => {
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
  });

  test("a blank line is a one-empty-field row", () => {
    expect(parseCsv("a\n\nb")).toEqual([["a"], [""], ["b"]]);
  });
});

describe("csv-parser fields", () => {
  test("empty fields are preserved", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
  });

  test("a quoted field may contain commas", () => {
    expect(parseCsv('"a,b",c')).toEqual([["a,b", "c"]]);
  });

  test("doubled quotes inside a quoted field are one quote", () => {
    expect(parseCsv('"a""b",c')).toEqual([['a"b', "c"]]);
  });

  test("a quoted field may contain newlines", () => {
    expect(parseCsv('"a\nb",c')).toEqual([["a\nb", "c"]]);
  });

  test("an empty quoted field is an empty string", () => {
    expect(parseCsv('"",x')).toEqual([["", "x"]]);
  });
});

describe("csv-parser errors", () => {
  test("a character after a closing quote is rejected", () => {
    expect(() => parseCsv('"a"b')).toThrow();
  });
});
