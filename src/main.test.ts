import { describe, expect, test } from "bun:test";
import { argvRequestsJson, reportUsageError } from "./main";
import { RESULT_FORMAT } from "./result";
import type { MainIo } from "./main";

describe("argvRequestsJson", () => {
  test("true for --format json", () => {
    expect(argvRequestsJson(["--format", "json"])).toBe(true);
  });

  test("true for --format=json", () => {
    expect(argvRequestsJson(["--format=json"])).toBe(true);
  });

  test("false for --format text", () => {
    expect(argvRequestsJson(["--format", "text"])).toBe(false);
  });

  test("false for empty argv", () => {
    expect(argvRequestsJson([])).toBe(false);
  });

  test("false for --format=jsonx", () => {
    expect(argvRequestsJson(["--format=jsonx"])).toBe(false);
  });

  test("true when the JSON request follows another arg", () => {
    expect(argvRequestsJson(["--bogus", "--format", "json"])).toBe(true);
  });
});

function captureIo(): { io: MainIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

describe("reportUsageError", () => {
  test("with a JSON request writes one result to stdout and error + help to stderr", () => {
    const { io, out, err } = captureIo();
    const code = reportUsageError(io, ["--format", "json", "--bogus"], "unknown flag --bogus");
    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!) as Record<string, unknown>;
    expect(parsed.format).toBe(RESULT_FORMAT);
    expect(parsed.status).toBe("failed");
    expect(parsed.verified).toBe(false);
    expect(parsed.diagnostics).toContain("unknown flag --bogus");
    expect(err.some((line) => line.includes("unknown flag --bogus"))).toBe(true);
    expect(err.length).toBeGreaterThan(1);
  });

  test("without a JSON request writes nothing to stdout", () => {
    const { io, out, err } = captureIo();
    const code = reportUsageError(io, ["--format", "text", "--bogus"], "unknown flag --bogus");
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.some((line) => line.includes("unknown flag --bogus"))).toBe(true);
  });
});
