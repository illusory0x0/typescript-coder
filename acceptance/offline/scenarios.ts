// Offline scenarios: scripted providers only. No network access and no API key.
import {
  EDIT_DSL_CONFIRMATION,
  EDIT_DSL_PICK_EDIT,
  EDIT_DSL_RENAME_EDIT,
  EDIT_DSL_RENAME_SELECT,
  EDIT_DSL_VIEWER,
  TEST_ISSUE,
  diagnosticsContains,
  editDslReply,
  explanationEquals,
  fileContains,
  fileEqualsOriginal,
  hasCallCount,
  hasOk,
  hasRecords,
  hasTerminationReason,
  messageContains,
  recordOutcomes,
  selection,
  someRecordDiagnosticsContain,
} from "../support/scenario";
import type { Scenario } from "../support/scenario";
import { cpSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeSelections } from "@tc/typescript-editor/selection";

export const offlineScenarios: Scenario[] = [
  {
    id: "fix-answer",
    title: "failing test becomes green",
    fixture: "fix-answer",
    issue: TEST_ISSUE,
    responses: [EDIT_DSL_VIEWER, EDIT_DSL_PICK_EDIT, EDIT_DSL_CONFIRMATION],
    assertions: [
      hasOk(true),
      hasRecords(4),
      recordOutcomes(["selected", "applied", "ok", "confirmed"]),
      fileContains("src/helper.ts", "return 2;"),
      fileEqualsOriginal("src/helper.test.ts"),
    ],
  },
  {
    id: "plan-exec-fix-answer",
    title: "flat-DSL plan/execute plans one WorkNode and the executor makes the failing test green",
    fixture: "fix-answer",
    agentMode: "plan-exec",
    issue: TEST_ISSUE,
    responses: [
      `plan
goal: Make the failing answer test pass.

node "02-answer" verify test
instruction: Change answer so it returns 2 instead of 1.
hint value answer in src/helper.ts
end`,
      [
        "select answer in src/helper.ts resolve value",
        "replace with",
        "TC_EDIT_BEGIN",
        "export function answer(): number {",
        "  return 2;",
        "}",
        "TC_EDIT_END",
      ].join("\n"),
    ],
    assertions: [
      hasOk(true),
      fileContains("src/helper.ts", "return 2;"),
      fileEqualsOriginal("src/helper.test.ts"),
      hasCallCount(2),
      messageContains(1, "Change answer so it returns 2 instead of 1."),
    ],
  },
  {
    id: "plan-exec-write-fix-answer",
    title: "flat-DSL plan/execute accepts sentinel goal, instruction, and whole-file write fences",
    fixture: "fix-answer",
    agentMode: "plan-exec",
    issue: TEST_ISSUE,
    responses: [
      `plan
goal:
TC_EDIT_BEGIN
Make the failing answer test pass.
TC_EDIT_END

node "02-answer" verify test
instruction:
TC_EDIT_BEGIN
Replace src/helper.ts so answer returns 2.
TC_EDIT_END
hint file src/helper.ts
approach:
TC_EDIT_BEGIN
The file is small; one whole-file write is often cheapest.
TC_EDIT_END
end`,
      [
        "write src/helper.ts with",
        "TC_EDIT_BEGIN",
        "export function answer(): number {",
        "  return 2;",
        "}",
        "TC_EDIT_END",
      ].join("\n"),
    ],
    assertions: [
      hasOk(true),
      fileContains("src/helper.ts", "return 2;"),
      fileEqualsOriginal("src/helper.test.ts"),
      hasCallCount(2),
      messageContains(1, "Replace src/helper.ts so answer returns 2."),
    ],
  },
  {
    id: "edit-dsl-viewer-edit",
    title: "edit-dsl select viewer opens details then an edit lands",
    fixture: "fix-answer",
    issue: TEST_ISSUE,
    responses: [EDIT_DSL_VIEWER, EDIT_DSL_PICK_EDIT, EDIT_DSL_CONFIRMATION],
    assertions: [
      hasOk(true),
      hasRecords(4),
      recordOutcomes(["selected", "applied", "ok", "confirmed"]),
      messageContains(1, "# details"),
      messageContains(1, "1 | export function answer(): number {"),
      messageContains(2, "# modified text"),
      messageContains(2, "2 |   return 2;"),
      fileContains("src/helper.ts", "return 2;"),
      fileEqualsOriginal("src/helper.test.ts"),
    ],
  },
  {
    id: "edit-dsl-rename",
    title: "edit-dsl rename updates a declaration and its references",
    fixture: "edit-dsl-rename",
    issue: TEST_ISSUE,
    responses: [EDIT_DSL_RENAME_SELECT, EDIT_DSL_RENAME_EDIT, EDIT_DSL_CONFIRMATION],
    assertions: [
      hasOk(true),
      hasRecords(4),
      recordOutcomes(["selected", "applied", "ok", "confirmed"]),
      hasCallCount(3),
      messageContains(1, "# details"),
      messageContains(1, "export function answer"),
      messageContains(2, "# modified text"),
      messageContains(2, "function result"),
      fileContains("src/helper.ts", "function result"),
      fileContains("src/helper.ts", "return result();"),
      fileEqualsOriginal("src/helper.test.ts"),
    ],
  },
  {
    id: "keep-progress-retry",
    title: "type-invalid replacement stays on disk and the next iteration builds on it",
    fixture: "keep-progress-retry",
    issue: TEST_ISSUE,
    responses: [
      EDIT_DSL_VIEWER,
      editDslReply("return 1;", 'return "no";'),
      editDslReply('return "no";', "return 2;"),
      EDIT_DSL_CONFIRMATION,
    ],
    assertions: [
      hasOk(true),
      hasRecords(6),
      recordOutcomes(["selected", "applied", "tsc", "applied", "ok", "confirmed"]),
      hasCallCount(4),
      messageContains(2, "not assignable"),
      fileContains("src/helper.ts", "return 2;"),
    ],
  },
  {
    id: "persistent-failure",
    title: "a failed verification plus a repeated rejection fingerprint ends with one summary",
    fixture: "persistent-failure",
    issue: TEST_ISSUE,
    responses: [
      EDIT_DSL_VIEWER,
      editDslReply("return 1;", 'return "no";'),
      // The same rejected reply twice is a repeated no-progress fingerprint.
      "not an edit clause",
      "not an edit clause",
      "The replacement could not satisfy the type checker; the next step is to review the return type.",
    ],
    assertions: [
      hasOk(false),
      hasRecords(5),
      recordOutcomes(["selected", "applied", "tsc", "protocol", "protocol"]),
      hasTerminationReason("edit-exhausted"),
      hasCallCount(5),
      messageContains(4, "The run is over"),
      explanationEquals(
        "The replacement could not satisfy the type checker; the next step is to review the return type.",
      ),
      fileContains("src/helper.ts", 'return "no";'),
      someRecordDiagnosticsContain("not assignable"),
      diagnosticsContains("edit-exhausted"),
    ],
  },
  {
    id: "check-test-propagation",
    title: "test-only failure feeds back diagnostics",
    fixture: "check-test-propagation",
    issue: TEST_ISSUE,
    responses: [
      EDIT_DSL_VIEWER,
      editDslReply("return 1;", "return 3;"),
      editDslReply("return 3;", "return 2;"),
      EDIT_DSL_CONFIRMATION,
    ],
    assertions: [
      hasOk(true),
      hasRecords(6),
      recordOutcomes(["selected", "applied", "tests", "applied", "ok", "confirmed"]),
      hasCallCount(4),
      messageContains(2, "tests failed:"),
      fileContains("src/helper.ts", "return 2;"),
    ],
  },
  {
    id: "self-host",
    title: "agent edits its own sources and the copied suite stays green",
    fixture: null,
    slow: true,
    issue:
      "Rewrite greet to store the greeting in a local variable, keeping its behavior identical.",
    prepare: (dir: string, repoRoot: string) => {
      // Preserve the package layout: the copied suite runs from `harness/src`,
      // so the CLI entry and bin tests keep resolving their own paths.
      cpSync(join(repoRoot, "harness", "src"), join(dir, "harness", "src"), {
        recursive: true,
      });
      // Root `include` targets the top-level harnesses; narrow it to the
      // sources the copy actually carries.
      const rootTsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf8")) as {
        include?: string[];
      };
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({ ...rootTsconfig, include: ["harness/src"] }, null, 2),
      );
      // The copied suite's bin test reads package.json (#80); a minimal copy
      // avoids the workspace paths that do not exist in the scratch tree.
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify(
          {
            name: "acceptance-self-host",
            private: true,
            type: "module",
            bin: { tc: "./harness/src/main.ts" },
          },
          null,
          2,
        ),
      );
      cpSync(join(repoRoot, "bunfig.toml"), join(dir, "bunfig.toml"));
      symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
      writeFileSync(join(dir, ".nested-smoke"), "acceptance self-host copy\n");
    },
    responses: [
      serializeSelections([
        selection({ path: "harness/src/index.ts", symbol: "greet", kind: "function" }, null),
      ]),
      editDslReply(
        "function greet(subject: string): string {\n  return `hello, ${subject}`;\n}",
        "function greet(subject: string): string {\n  const greeting = `hello, ${subject}`;\n  return greeting;\n}",
        { path: "harness/src/index.ts", symbol: "greet", kind: "function" },
      ),
      EDIT_DSL_CONFIRMATION,
    ],
    assertions: [hasOk(true), fileContains("harness/src/index.ts", "const greeting")],
  },
];
