import { expect, test } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCS = Bun.which("scs");

test.skipIf(SCS === null)("committed tsed artifacts match the scs declaration", () => {
  if (SCS === null) {
    return;
  }
  const result = Bun.spawnSync(
    [
      SCS,
      "generate",
      "typescript-editor/scs/tsed.scs",
      "--out",
      "typescript-editor/scs/generated",
      "--targets",
      "ts,runtime,bash,zsh,fish,elvish,pwsh,nu",
      "--check",
    ],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `scs generate --check failed (${result.exitCode ?? "null"}):\n` +
        `${result.stdout.toString()}\n${result.stderr.toString()}`,
    );
  }
  expect(result.exitCode).toBe(0);
});
