// Live scenarios: these call the real model and run only with --live.
import {
  TEST_ISSUE,
  explanationIsNull,
  fileDiffersFromOriginal,
  fileEqualsOriginal,
  hasOk,
} from "../support/scenario";
import type { Scenario } from "../support/scenario";

export const liveScenarios: Scenario[] = [
  {
    id: "live-fix-answer",
    title: "real model makes the failing test pass",
    fixture: "fix-answer",
    issue: TEST_ISSUE,
    responses: [],
    assertions: [
      hasOk(true),
      explanationIsNull(),
      fileDiffersFromOriginal("src/helper.ts"),
      fileEqualsOriginal("src/helper.test.ts"),
    ],
  },
];
